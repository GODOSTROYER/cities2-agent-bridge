using System;
using CitiesIIAgentBridge;
using Newtonsoft.Json.Linq;

internal static class SimulationArgumentsTests
{
    internal static int Run()
    {
        int passed=0;
        void Check(bool value,string label){if(!value)throw new Exception("FAIL: "+label);++passed;Console.WriteLine("PASS: "+label);}
        void Bad(string key,JToken value){try{SimulationArguments.Normalize(new JObject{[key]=value});}catch(ArgumentException){Check(true,"reject malformed "+key);return;}throw new Exception("Accepted malformed "+key);}
        var defaults=SimulationArguments.Normalize(new JObject());
        Check((int)defaults["frames"]==4096 && (double)defaults["wallSeconds"]==30 && (bool)defaults["stopOnNewShortage"],"bounded defaults preserve shortage guard");
        foreach(var pair in new[]{("frames",(JToken)0),("frames",(JToken)262145),("frames",(JToken)1.5),("frames",(JToken)"42"),("wallSeconds",(JToken)0),("wallSeconds",(JToken)61),("wallSeconds",(JToken)double.NaN),("wallSeconds",(JToken)double.PositiveInfinity),("stallSeconds",(JToken)31),("stallSeconds",(JToken)0),("speed",(JToken)3),("speed",(JToken)"4"),("cashFloor",(JToken)0.5),("cashFloor",(JToken)"0"),("cashFloor",(JToken)double.NaN),("populationChange",(JToken)0),("populationChange",(JToken)((long)int.MaxValue+1))})Bad(pair.Item1,pair.Item2);
        foreach(string flag in new[]{"acknowledgeNoProgress","stopOnDemandChange","stopOnNewShortage","stopOnConstructionComplete"})
            foreach(JToken v in new JToken[]{new JValue("false"),new JValue(1),JValue.CreateNull(),new JObject()})Bad(flag,v);
        var input=new JObject{["frames"]=262144,["wallSeconds"]=60,["stallSeconds"]=60,["cashFloor"]=long.MaxValue,["populationChange"]=int.MaxValue};
        var copy=SimulationArguments.Normalize(input);Check((long)copy["cashFloor"]==long.MaxValue && input["speed"]==null,"normalized values preserve integer precision without modifying caller arguments");
        string id=Guid.NewGuid().ToString("N");Check(SimulationArguments.OperationId(new JObject{["id"]=id})==id,"scoped cancellation accepts canonical operation IDs");
        foreach(var args in new[]{new JObject(),new JObject{["id"]=""},new JObject{["id"]="other-client"},new JObject{["id"]=1}})
        {bool rejected=false;try{SimulationArguments.OperationId(args);}catch(ArgumentException){rejected=true;}Check(rejected,"unscoped or malformed cancellation ID rejected");}
        return passed;
    }
}
