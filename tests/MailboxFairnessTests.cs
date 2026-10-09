using System;
using System.IO;
using System.Linq;
using CitiesIIAgentBridge;
using Newtonsoft.Json.Linq;

internal static class MailboxFairnessTests
{
    private static int passed;
    private static void Check(bool value, string label)
    { if (!value) throw new Exception("FAIL: " + label); ++passed; Console.WriteLine("PASS: " + label); }
    private static JObject Request(Mailbox b) => new JObject {
        ["protocol"] = 1, ["id"] = Guid.NewGuid().ToString("N"), ["session"] = b.Session,
        ["citySession"] = "city", ["command"] = "ping", ["expiresUtc"] = DateTime.UtcNow.AddSeconds(50).ToString("O"), ["args"] = new JObject()
    };
    private static string Put(Mailbox b, JObject r)
    { string p = Path.Combine(b.Requests, (string)r["id"] + ".json"); Mailbox.AtomicWrite(p, r); return p; }
    private static void Pump(Mailbox b) { try { b.Pump(); } catch (IOException e) when (Mailbox.IsSharingViolation(e)) { } }
    public static void Main()
    {
        string root = Path.Combine(Path.GetTempPath(), "bridge-fairness-" + Guid.NewGuid().ToString("N"));
        try
        {
            int calls = 0; double now = 0;
            using (var b = new Mailbox(Path.Combine(root, "fair"), (c,a) => { ++calls; return new JObject(); }, () => "city", () => now))
            {
                for (int i = 0; i < 130; i++) File.WriteAllText(Path.Combine(b.Requests, "invalid-" + i + ".json"), "{}");
                var r = Request(b); Put(b,r);
                b.Pump();
                Check(Directory.GetFiles(Path.Combine(b.Root,"quarantine")).Length <= Mailbox.ScanLimit, "malformed scan is bounded");
                for (int i=0;i<10;i++) b.Pump();
                Check(calls == 1, "130 malformed names cannot starve one valid request");
                Check(Directory.GetFiles(Path.Combine(b.Root,"quarantine")).Length == 130, "malformed names are quarantined, not silently forgotten");
                string response = Path.Combine(b.Responses,(string)r["id"]+".json");
                File.Delete(response); Put(b,r); for(int i=0;i<3;i++)b.Pump();
                var duplicate = JObject.Parse(File.ReadAllText(response));
                Check(calls == 1 && (string)duplicate["error"] == "request_already_processed" && (bool)duplicate["retryAllowed"] == false, "response cleanup cannot replay a mutation within the horizon");
                now = Mailbox.ReplayHorizonSeconds + 1;
                File.Delete(response); Put(b,r); for(int i=0;i<3;i++)b.Pump();
                Check(calls == 2, "documented tombstone horizon expires without unbounded history");
                for(int i=0;i<10;i++)Put(b,Request(b));
                int before = calls; b.Pump();
                Check(calls-before <= Mailbox.DispatchLimit, "a tick dispatches at most four requests");
                for(int i=0;i<6;i++)b.Pump();
                Check(calls-before == 10, "bounded scan eventually processes every queued request");
                var bad = Request(b); bad["args"] = new JArray(); Put(b,bad); b.Pump();
                Check(!(bool)JObject.Parse(File.ReadAllText(Path.Combine(b.Responses,(string)bad["id"]+".json")))["ok"], "malformed arguments do not become an empty command");
                var big = Request(b); big["args"] = new JObject { ["text"] = new string('x',17000) }; Put(b,big); b.Pump();
                Check((string)JObject.Parse(File.ReadAllText(Path.Combine(b.Responses,(string)big["id"]+".json")))["error"] == "request_too_large", "request byte size is bounded during reading");
            }
            calls = 0;
            using (var b = new Mailbox(Path.Combine(root,"orphan"),(c,a)=>{++calls;return new JObject { ["proof"]="original" };},()=>"city"))
            {
                var r=Request(b); string request=Put(b,r), response=Path.Combine(b.Responses,(string)r["id"]+".json");
                Directory.CreateDirectory(response);
                try { b.Pump(); } catch(IOException) { } catch(UnauthorizedAccessException) { }
                File.Delete(request); Directory.Delete(response); b.Pump();
                Check(calls==1 && (string)JObject.Parse(File.ReadAllText(response))["result"]["proof"]=="original", "undelivered result is recovered even after its request disappears");
            }
            if (OperatingSystem.IsWindows())
            {
                calls=0;
                using(var b=new Mailbox(Path.Combine(root,"locks"),(c,a)=>{++calls;return new JObject();},()=>"city"))
                {
                    var locked=Enumerable.Range(0,4).Select(_=>Put(b,Request(b))).ToArray();
                    var handles=locked.Select(p=>new FileStream(p,FileMode.Open,FileAccess.ReadWrite,FileShare.None)).ToArray();
                    try { Put(b,Request(b)); for(int i=0;i<3;i++)Pump(b); Check(calls==1,"four locked requests do not starve a readable request"); }
                    finally { foreach(var h in handles)h.Dispose(); }
                    for(int i=0;i<5;i++)b.Pump(); Check(calls==5,"deferred locked requests resume exactly once");
                }
            }
            else Console.WriteLine("SKIP: Windows-exclusive file sharing");
            Mailbox context=null; string seen=null;
            using(context=new Mailbox(Path.Combine(root,"context"),(c,a)=>{seen=context.CurrentRequestId;throw new Exception("injected");},()=>"city"))
            { var r=Request(context); Put(context,r);context.Pump();Check(seen==(string)r["id"] && context.CurrentRequestId==null,"request context is visible only during dispatch and clears on failure"); }
            Console.WriteLine($"{passed} mailbox reliability checks passed.");
            Console.WriteLine($"{MaintenanceTests.Run()} maintenance routing checks passed.");
            Console.WriteLine($"{OperationRegistryTests.Run()} operation identity/outcome checks passed.");
            Console.WriteLine($"{SimulationArgumentsTests.Run()} simulation argument checks passed.");
        }
        finally { if(Directory.Exists(root))Directory.Delete(root,true); }
    }
}
