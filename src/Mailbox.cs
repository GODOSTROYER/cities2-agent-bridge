using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace CitiesIIAgentBridge
{
    // Local, single-threaded mailbox. No listening socket or arbitrary commands.
    public sealed class Mailbox : IDisposable
    {
        public const int Protocol = 1;
        internal const int ScanLimit = 64;
        internal const int DispatchLimit = 4;
        internal const int PendingLimit = 64;
        internal const int RecentLimit = 4096;
        internal const double ReplayHorizonSeconds = 120;
        public readonly string Session = Guid.NewGuid().ToString("N");
        public readonly string Root;
        public readonly string Requests;
        public readonly string Responses;
        public string CurrentRequestId { get; private set; }
        private readonly Func<string, JObject, JObject> dispatch;
        private readonly Func<string> citySession;
        private readonly Func<double> clock;
        private readonly Dictionary<string, JObject> pendingResponses = new Dictionary<string, JObject>();
        private readonly Dictionary<string, double> recent = new Dictionary<string, double>();
        private IEnumerator<string> scan;
        private string pendingCursor;
        private bool disposed;

        public Mailbox(string root, Func<string, JObject, JObject> dispatch, Func<string> citySession)
            : this(root, dispatch, citySession, () => (double)Stopwatch.GetTimestamp() / Stopwatch.Frequency) { }

        internal Mailbox(string root, Func<string, JObject, JObject> dispatch, Func<string> citySession, Func<double> clock)
        {
            Root = root;
            Requests = Path.Combine(root, "requests");
            Responses = Path.Combine(root, "responses");
            this.dispatch = dispatch ?? throw new ArgumentNullException(nameof(dispatch));
            this.citySession = citySession ?? throw new ArgumentNullException(nameof(citySession));
            this.clock = clock ?? throw new ArgumentNullException(nameof(clock));
            Directory.CreateDirectory(Requests);
            Directory.CreateDirectory(Responses);
        }

        public void Publish(JObject state)
        {
            if (disposed) throw new ObjectDisposedException(nameof(Mailbox));
            state["protocol"] = Protocol;
            state["session"] = Session;
            state["citySession"] = citySession();
            state["heartbeatUtc"] = DateTime.UtcNow.ToString("O");
            AtomicWrite(Path.Combine(Root, "session.json"), state);
        }

        public int Pump()
        {
            if (disposed) throw new ObjectDisposedException(nameof(Mailbox));
            int count = 0, inspected = 0;
            IOException contention = null;
            double now = clock();
            foreach (var id in recent.Where(p => p.Value <= now).Select(p => p.Key).ToArray()) recent.Remove(id);
            // Results survive even if a client removes its request before delivery.
            // Bound both memory and work; never evict an undelivered mutation result.
            var waiting = pendingResponses.OrderBy(p => p.Key, StringComparer.Ordinal).ToArray();
            int start = Array.FindIndex(waiting, p => pendingCursor == null || StringComparer.Ordinal.Compare(p.Key, pendingCursor) > 0);
            if (start < 0) start = 0;
            for (int i = 0; i < Math.Min(DispatchLimit, waiting.Length); ++i)
            {
                var pair = waiting[(start + i) % waiting.Length];
                pendingCursor = pair.Key;
                TryDeliver(pair.Key, pair.Value, ref contention);
            }
            try
            {
                if (scan == null) scan = Directory.EnumerateFiles(Requests, "*.json").GetEnumerator();
                while (inspected < ScanLimit && count < DispatchLimit && pendingResponses.Count < PendingLimit)
                {
                    if (!scan.MoveNext()) { scan.Dispose(); scan = null; break; }
                    ++inspected;
                    string path = scan.Current;
                    string id = Path.GetFileNameWithoutExtension(path);
                    try
                    {
                        if (!Guid.TryParseExact(id, "N", out _))
                        {
                            string quarantine = Path.Combine(Root, "quarantine");
                            Directory.CreateDirectory(quarantine);
                            File.Move(path, Path.Combine(quarantine, Guid.NewGuid().ToString("N") + ".invalid"));
                            continue;
                        }
                        if (pendingResponses.ContainsKey(id)) continue;
                        string responsePath = Path.Combine(Responses, id + ".json");
                        if (File.Exists(responsePath)) { File.Delete(path); continue; }
                        var response = Envelope(id);
                        if (recent.ContainsKey(id))
                        {
                            // A tombstone, not a new attempt. The original outcome must be reconciled.
                            response["ok"] = false;
                            response["error"] = "request_already_processed";
                            response["outcomeUnknown"] = true;
                            response["retryAllowed"] = false;
                        }
                        else
                        {
                            if (recent.Count >= RecentLimit) break; // Backpressure, not unsafe eviction.
                            string text;
                            try { text = ReadRequest(path); }
                            catch (IOException e) when (IsSharingViolation(e)) { continue; }
                            // A locked input is not a failed dispatch or an output fault.
                            try
                            {
                                JObject request;
                                using (var reader = new JsonTextReader(new StringReader(text)))
                                {
                                    reader.DateParseHandling = DateParseHandling.None;
                                    reader.MaxDepth = 32;
                                    request = JObject.Load(reader);
                                    if (reader.Read()) throw new ArgumentException("trailing_request_content");
                                }
                                if ((string)request["id"] != id) throw new InvalidOperationException("id_mismatch");
                                if (request["protocol"]?.Type != JTokenType.Integer || (int?)request["protocol"] != Protocol) throw new InvalidOperationException("protocol_mismatch");
                                if ((string)request["session"] != Session) throw new InvalidOperationException("stale_session");
                                var expiry = DateTimeOffset.Parse((string)request["expiresUtc"] ?? "", System.Globalization.CultureInfo.InvariantCulture);
                                var utc = DateTimeOffset.UtcNow;
                                if (expiry <= utc || expiry > utc.AddSeconds(60)) throw new InvalidOperationException("request_expired_or_invalid_deadline");
                                string command = (string)request["command"];
                                if (command != "ping" && command != "get_city_state" && command != "get_capabilities" && (string)request["citySession"] != citySession())
                                    throw new InvalidOperationException("stale_city_session");
                                var args = request["args"] == null ? new JObject() : request["args"] as JObject;
                                if (args == null) throw new ArgumentException("args_must_be_object");
                                CurrentRequestId = id;
                                try { response["result"] = dispatch(command, args); }
                                finally { CurrentRequestId = null; }
                                response["ok"] = true;
                            }
                            catch (Exception e) { response["ok"] = false; response["error"] = e.GetType().Name + ": " + e.Message; }
                            recent[id] = clock() + ReplayHorizonSeconds;
                            ++count;
                        }
                        pendingResponses[id] = response;
                        TryDeliver(id, response, ref contention);
                    }
                    catch (FileNotFoundException) { /* Client removed an unprocessed request. */ }
                    catch (IOException e) when (IsSharingViolation(e)) { contention = e; }
                    catch (InvalidDataException e)
                    {
                        var response = Envelope(id);
                        response["ok"] = false; response["error"] = e.Message;
                        pendingResponses[id] = response;
                        TryDeliver(id, response, ref contention);
                        ++count;
                    }
                }
            }
            catch { scan?.Dispose(); scan = null; throw; }
            // One locked entry must not starve other files. Still report transport trouble
            // so callers do not start new batch work on a contended tick.
            if (contention != null) throw contention;
            return count;
        }

        private JObject Envelope(string id) => new JObject {
            ["protocol"] = Protocol, ["id"] = id, ["session"] = Session,
            ["citySession"] = citySession(), ["utc"] = DateTime.UtcNow.ToString("O")
        };

        private void TryDeliver(string id, JObject response, ref IOException contention)
        {
            try
            {
                AtomicWrite(Path.Combine(Responses, id + ".json"), response);
                pendingResponses.Remove(id);
                File.Delete(Path.Combine(Requests, id + ".json"));
            }
            catch (IOException e) when (IsSharingViolation(e)) { contention = e; }
        }

        private static string ReadRequest(string path)
        {
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                const int maximum = 16384;
                var bytes = new byte[maximum + 1];
                int length = 0, read;
                while (length < bytes.Length && (read = stream.Read(bytes, length, bytes.Length - length)) > 0) length += read;
                if (length > maximum) throw new InvalidDataException("request_too_large");
                int start = length >= 3 && bytes[0] == 0xef && bytes[1] == 0xbb && bytes[2] == 0xbf ? 3 : 0;
                try { return new UTF8Encoding(false, true).GetString(bytes, start, length - start); }
                catch (DecoderFallbackException e) { throw new InvalidDataException("invalid_request_utf8", e); }
            }
        }

        public void Dispose() { if (disposed) return; disposed = true; scan?.Dispose(); scan = null; }

        public static void AtomicWrite(string path, JObject value)
        {
            string temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                File.WriteAllText(temp, value.ToString(Formatting.Indented), new UTF8Encoding(false));
                RetrySharingViolation(() => {
                    if (File.Exists(path)) File.Replace(temp, path, null);
                    else File.Move(temp, path);
                });
            }
            finally { if (File.Exists(temp)) File.Delete(temp); }
        }
        internal static bool IsSharingViolation(IOException error)
        {
            int code = error.HResult & 0xffff;
            return code == 32 || code == 33;
        }
        internal static void RetrySharingViolation(Action action)
        {
            for (int attempt = 0; ; ++attempt)
            {
                try { action(); return; }
                catch (IOException e) when (IsSharingViolation(e) && attempt < 3) { Thread.Sleep(10); }
            }
        }
        internal static string ReadSharedText(string path)
        {
            using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var reader = new StreamReader(stream, Encoding.UTF8, true)) return reader.ReadToEnd();
        }
    }
}
