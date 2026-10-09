using System;
using CitiesIIAgentBridge;
using Newtonsoft.Json.Linq;

internal static class OperationRegistryTests
{
    internal static int Run()
    {
        int passed=0;
        void Check(bool value,string label) { if(!value)throw new Exception("FAIL: "+label);++passed;Console.WriteLine("PASS: "+label); }
        void Reject(Action action,string error) { try { action(); } catch(InvalidOperationException e) { Check(e.Message==error,error);return; }throw new Exception("Expected "+error); }
        string session="bridge-a",city="city-a",request="request-a";
        var registry=new OperationRegistry();registry.Configure(()=>session,()=>city,()=>request);
        string a=registry.Begin("road");var origin=registry.Status(a);
        Check((string)origin["session"]==session && (string)origin["citySession"]==city && (string)origin["requestId"]==request,"operation captures its complete origin");
        origin["kind"]="changed";Check((string)registry.Status(a)["kind"]=="road","status is a deep copy");
        Reject(()=>registry.Begin("road"),"construction_busy");
        registry.Submitted(a);Check(registry.Status(a)["applied"].Type==JTokenType.Null,"application request is not proof of effect");
        registry.Finish(a,"failed","verification_failed");
        Check((string)registry.Status(a)["outcome"]=="uncertain" && (bool)registry.Status(a)["retryAllowed"]==false,"post-submit failure prohibits blind replay");
        registry.Finish(a,"complete");Check((string)registry.Status(a)["status"]=="failed","late completion cannot rewrite terminal state");
        string unverified=registry.Begin("road");registry.Submitted(unverified);registry.Finish(unverified,"complete");
        Check((string)registry.Status(unverified)["status"]=="failed" && (string)registry.Status(unverified)["outcome"]=="uncertain","unverified submission cannot be marked complete");
        string b=registry.Begin("district");registry.Submitted(b);registry.Verified(b,"polygon_readback");registry.Finish(b,"failed","naming_failed");
        Check((string)registry.Status(b)["outcome"]=="partial" && (bool)registry.Status(b)["applied"],"verified geometry survives later naming failure");
        string c=registry.Begin("building");registry.Finish(c,"failed","placement_rejected");
        Check((string)registry.Status(c)["outcome"]=="not_submitted" && (bool)registry.Status(c)["retryAllowed"],"pre-apply rejection remains distinct");
        string d=registry.Begin("road");registry.Submitted(d);registry.Verified(d,"readback");registry.Finish(d,"complete");
        Check((string)registry.Status(d)["outcome"]=="verified","verified completion is explicit");
        city="city-b";Reject(()=>registry.Status(a),"stale_operation_city_session");
        session="bridge-b";Reject(()=>registry.Status(a),"stale_operation_session");
        string e=registry.Begin("road");registry.Finish(a,"interrupted","late_stop");
        Check(registry.Active==e,"old callback cannot release a newer operation");
        registry.Finish(e,"interrupted");Reject(()=>registry.Submitted(e),"operation_not_active");
        request="request-b";string f=registry.Begin("simulation_step");
        Check((string)registry.Status(f)["requestId"]==request,"new operation carries the new originating request");
        registry.Configure(()=>"bridge-c",()=>"city-c",()=>"request-c");
        Check(registry.Active==null && (string)registry.Results[f]["status"]=="interrupted","reconfiguration interrupts rather than inheriting active operations");
        var bounded=new OperationRegistry();bounded.Configure(()=>"s",()=>"c",()=>"r");
        for(int i=0;i<OperationRegistry.HistoryLimit+10;i++){var id=bounded.Begin("preview");bounded.Finish(id,"complete");}
        Check(bounded.Results.Count==OperationRegistry.HistoryLimit,"completed history is bounded");
        var unresolved=new OperationRegistry();unresolved.Configure(()=>"s",()=>"c",()=>"r");
        for(int i=0;i<OperationRegistry.HistoryLimit;i++){var id=unresolved.Begin("road");unresolved.Submitted(id);unresolved.Finish(id,"failed");}
        Reject(()=>unresolved.Begin("road"),"unresolved_operation_history_full");
        Check(unresolved.Results.Count==OperationRegistry.HistoryLimit,"unresolved effects are not silently evicted");
        return passed;
    }
}
