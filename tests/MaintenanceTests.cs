using System;
using System.IO;
using CitiesIIAgentBridge;
internal static class MaintenanceTests
{
    internal static int Run()
    {
        int checks=0;
        void Check(bool ok,string label){if(!ok)throw new Exception("FAIL: "+label);++checks;Console.WriteLine("PASS: "+label);}
        var sharing=new IOException("injected sharing",unchecked((int)0x80070020));
        foreach(string broken in new[]{"publish","pump"})
        {
            int stop=0,simulation=0,maintenance=0,dispatch=0,warning=0;
            for(int i=0;i<3;i++)
            {
                bool healthy=BridgeTick.Run(()=>++stop,()=>++simulation,
                    ()=>{if(broken=="publish")throw sharing;},()=>{if(broken=="pump")throw sharing;},
                    ()=>++dispatch,e=>++warning,()=>++maintenance);
                Check(!healthy,"transport failure is reported");
            }
            Check(stop==3 && simulation==3 && maintenance==3 && dispatch==0 && warning==3,
                broken+" contention does not defer maintenance or permit new batch work");
            BridgeTick.Run(()=>++stop,()=>++simulation,()=>{},()=>{},()=>++dispatch,e=>++warning,()=>++maintenance);
            Check(dispatch==1 && maintenance==4,"new work resumes only after transport recovers");
        }
        foreach(string stage in new[]{"maintenance","publish","pump"})
        {
            int maintained=0,dispatched=0;bool propagated=false;
            var disk=new IOException("disk full",unchecked((int)0x80070070));
            try { BridgeTick.Run(()=>{},()=>{},()=>{if(stage=="publish")throw disk;},()=>{if(stage=="pump")throw disk;},()=>++dispatched,e=>{},()=>{++maintained;if(stage=="maintenance")throw sharing;}); }
            catch(IOException){propagated=true;}
            Check(propagated && maintained==1 && dispatched==0,stage+" genuine faults are not swallowed or allowed to dispatch");
        }
        return checks;
    }
}
