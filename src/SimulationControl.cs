using System;
using System.Diagnostics;
using System.Linq;
using Unity.Entities;
using Game.Simulation;
using Newtonsoft.Json.Linq;

namespace CitiesIIAgentBridge
{
    public sealed partial class Mod
    {
        private SimulationWindow simulationWindow;
        private Stopwatch simulationClock;
        private string simulationOperation, simulationCity;
        private JObject simulationBefore, simulationOptions;
        private int stagnantSteps;
        private double nextSimulationSample;

        private bool SimulationRunning => simulationWindow != null;
        private void PauseAnalysis()
        {
            var w = RequireCity(); RequireControl();
            if (SimulationRunning) FinishSimulation("analysis_requested");
            w.GetExistingSystemManaged<SimulationSystem>().selectedSpeed = 0;
        }
        private JObject BeginSimulation(JObject args)
        {
            args = SimulationArguments.Normalize(args);
            var w = RequireCity(); RequireControl();
            if (SimulationRunning || ConstructionAccess.Active != null || (string)batch?["status"] == "running")
                throw new InvalidOperationException("finish_current_operation_before_simulating");
            if (stagnantSteps >= 3 && (bool?)args["acknowledgeNoProgress"] != true)
                throw new InvalidOperationException("reassess_required_after_three_stagnant_steps");
            int frames = (int)args["frames"];
            double wall = (double)args["wallSeconds"], stall = (double)args["stallSeconds"];
            float speed = (float)args["speed"];
            var sim = w.GetExistingSystemManaged<SimulationSystem>();
            var window = new SimulationWindow(sim.frameIndex,(ulong)frames,wall,stall);
            sim.selectedSpeed = 0;
            simulationBefore = Observation(); simulationOptions = (JObject)args.DeepClone();
            simulationOperation = ConstructionAccess.Begin("simulation_step"); simulationCity = citySession;
            simulationWindow = window; simulationClock = Stopwatch.StartNew(); nextSimulationSample = 0;
            if ((bool?)args["acknowledgeNoProgress"] == true) stagnantSteps = 0;
            var result = ConstructionAccess.Results[simulationOperation];
            result["status"] = "running"; result["before"] = simulationBefore;
            result["bounds"] = new JObject { ["frames"] = frames, ["wallSeconds"] = wall, ["stallSeconds"] = stall };
            ConstructionAccess.Submitted(simulationOperation);
            sim.selectedSpeed = speed;
            return ConstructionAccess.Status(simulationOperation);
        }
        private void SimulationTick()
        {
            if (!SimulationRunning) return;
            try
            {
                if (simulationCity != citySession) { FinishSimulation("city_changed", false); return; }
                var sim = RequireCity().GetExistingSystemManaged<SimulationSystem>();
                double elapsed = simulationClock.Elapsed.TotalSeconds;
                string reason = simulationWindow.Check(sim.frameIndex,elapsed,ConstructionAccess.Allowed?.Invoke() == true,true,sim.selectedSpeed == 0,null);
                if (reason == null && elapsed >= nextSimulationSample)
                {
                    nextSimulationSample = elapsed + 1;
                    var now = Observation();
                    if (simulationOptions["cashFloor"] != null && (long)now["city"]["money"] < (long)simulationOptions["cashFloor"]) reason = "cash_floor";
                    else if (simulationOptions["populationChange"] != null && Math.Abs((int)now["city"]["population"]-(int)simulationBefore["city"]["population"]) >= (int)simulationOptions["populationChange"]) reason = "population_changed";
                    else if ((bool?)simulationOptions["stopOnDemandChange"] == true && !JToken.DeepEquals(now["demand"],simulationBefore["demand"])) reason = "demand_changed";
                    else if ((bool?)simulationOptions["stopOnNewShortage"] != false && now["shortageEntities"].Values<string>().Except(simulationBefore["shortageEntities"].Values<string>()).Any()) reason = "new_utility_shortage";
                    else if ((bool?)simulationOptions["stopOnConstructionComplete"] == true && ((JArray)simulationBefore["constructionEntities"]).Any(item=> {
                        var e=new Entity{Index=(int)item["index"],Version=(int)item["version"]};var em=RequireCity().EntityManager;
                        return em.Exists(e)&&em.HasComponent<Game.Buildings.Building>(e)&&!em.HasComponent<Game.Common.Deleted>(e)&&!em.HasComponent<Game.Objects.UnderConstruction>(e);
                    })) reason = "construction_completed";
                    ConstructionAccess.Results[simulationOperation]["latest"] = now;
                }
                if (reason != null) FinishSimulation(reason);
            }
            catch (Exception e) { FinishSimulation("observation_failed: " + e.GetBaseException().Message); }
        }
        private JObject SimulationStatus(JObject args)
        {
            string id = SimulationArguments.OperationId(args);
            var result = ConstructionAccess.Status(id);
            if ((string)result["kind"] != "simulation_step") throw new ArgumentException("simulation_step_not_found");
            return result;
        }
        private JObject EndSimulation(JObject args)
        {
            RequireCity(); RequireControl();
            var original = SimulationStatus(args); // Validate ID and origin before touching simulation.
            string id = (string)original["id"];
            bool ownsActive = SimulationRunning && simulationOperation == id && simulationCity == citySession;
            if (ownsActive) FinishSimulation("cancelled");
            var result = ConstructionAccess.Status(id);
            result["cancelledActiveOperation"] = ownsActive;
            // A completed A must never pause/cancel a newer B, or a manual interval.
            return result;
        }
        private void FinishSimulation(string reason, bool pause = true)
        {
            if (!SimulationRunning) return;
            var id = simulationOperation; var result = ConstructionAccess.Results[id];
            try
            {
                if (pause && simulationCity == citySession)
                {
                    var sim = RequireCity().GetExistingSystemManaged<SimulationSystem>(); sim.selectedSpeed = 0;
                    result["paused"] = true;
                    result["advancedFrames"] = sim.frameIndex >= simulationWindow.StartFrame ? (ulong)sim.frameIndex-simulationWindow.StartFrame : 0;
                    var after = Observation(); result["after"] = after;
                    var delta = new JObject();
                    foreach (var key in new[] { "population", "money", "xp", "averageHappiness", "averageHealth" })
                        if (after["city"][key] != null && simulationBefore["city"][key] != null) delta[key] = (double)after["city"][key] - (double)simulationBefore["city"][key];
                    result["delta"] = delta;
                    bool changed = ((double?)delta["population"]??0) != 0 || ((double?)delta["xp"]??0) != 0 || !JToken.DeepEquals(after["demand"],simulationBefore["demand"]) || !JToken.DeepEquals(after["underConstruction"],simulationBefore["underConstruction"]);
                    stagnantSteps = changed ? 0 : stagnantSteps + 1;
                    ConstructionAccess.Verified(id, "paused_simulation_and_observation_readback");
                }
            }
            catch (Exception e) { result["snapshotError"] = e.GetBaseException().Message; }
            finally
            {
                result["reason"] = reason; result["elapsedSeconds"] = simulationClock.Elapsed.TotalSeconds;
                result["stagnantSteps"] = stagnantSteps; result["reassessmentRequired"] = stagnantSteps >= 3;
                simulationWindow = null; simulationClock.Stop();
                ConstructionAccess.Finish(id, reason == "city_changed" || reason == "control_stopped" ? "interrupted" : "complete");
            }
        }
    }
}
