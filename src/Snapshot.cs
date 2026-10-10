using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using Game.Buildings;
using Game.City;
using Game.Prefabs;
using Game.SceneFlow;
using Game.Simulation;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Unity.Entities;
using Unity.Jobs;

namespace CitiesIIAgentBridge
{
    // Live view for agents without pausing the game. The snapshot is rebuilt on the game's
    // main thread (from Tick) every ~256 simulation frames, or every 5 s while paused, and
    // get_snapshot only returns that cache, so it is safe to call during simulate_step.
    // Every probe is isolated: a missing or renamed member becomes an entry in errors[].
    // Changes between consecutive snapshots are appended to <mailbox>\events.jsonl.
    public sealed partial class Mod
    {
        private const uint SnapshotFrames = 256;
        private const long EventFileLimit = 1 << 20;
        private JObject snapshot;
        private uint snapshotFrame;
        private DateTime snapshotUtc;
        private string snapshotCity, snapshotTickError, eventError;
        private int snapshotBuilds;
        private bool cityWasLoaded;
        private long eventSeq;
        // No field initializers: the game may allocate IMod without running them (see OnLoad).
        private HashSet<Entity> firesSeen;
        private Dictionary<string, uint> lastEventFrame;

        private static bool CityReady()
        {
            var manager = GameManager.instance;
            var world = World.DefaultGameObjectInjectionWorld;
            return manager != null && !manager.isGameLoading && manager.gameMode == Game.GameMode.Game && world != null && world.IsCreated;
        }

        // Main thread, every Tick (250 ms). Never throws: a fault here must not turn controls off.
        private void SnapshotTick()
        {
            try
            {
                if (disposed) return;
                if (!CityReady())
                {
                    if (cityWasLoaded)
                    {
                        cityWasLoaded = false;
                        EmitEvent("city_unloaded", snapshotFrame, new JObject { ["city"] = (string)snapshot?["city"]?["name"] });
                    }
                    snapshot = null; snapshotCity = null;
                    return;
                }
                uint frame = World.DefaultGameObjectInjectionWorld.GetExistingSystemManaged<SimulationSystem>()?.frameIndex ?? 0;
                bool due = snapshot == null || snapshotCity != citySession || frame < snapshotFrame
                    || frame - snapshotFrame >= SnapshotFrames || (DateTime.UtcNow - snapshotUtc).TotalSeconds >= 2;
                if (due) { RefreshSnapshot(); AutoResolvePopups(frame); }
                snapshotTickError = null;
            }
            catch (Exception e) { snapshotTickError = e.GetBaseException().Message; }
        }

        private JObject GetSnapshot()
        {
            if (!CityReady())
                return new JObject
                {
                    ["city"] = null, ["gameMode"] = GameManager.instance?.gameMode.ToString(),
                    ["loading"] = GameManager.instance?.isGameLoading, ["errors"] = new JArray("no_loaded_city")
                };
            if (snapshot == null || snapshotCity != citySession) RefreshSnapshot();
            var result = (JObject)snapshot.DeepClone();
            try
            {
                var sim = World.DefaultGameObjectInjectionWorld.GetExistingSystemManaged<SimulationSystem>();
                result["ageFrames"] = sim.frameIndex >= snapshotFrame ? sim.frameIndex - snapshotFrame : 0;
                result["liveFrame"] = sim.frameIndex; result["liveSpeed"] = sim.selectedSpeed;
            }
            catch (Exception e) { AddError(result, "live: " + e.GetBaseException().Message); }
            result["ageSec"] = Math.Round((DateTime.UtcNow - snapshotUtc).TotalSeconds, 1);
            if (snapshotTickError != null) AddError(result, "tick: " + snapshotTickError);
            if (eventError != null) AddError(result, "events: " + eventError);
            return result;
        }

        private static void AddError(JObject target, string error)
        {
            if (!(target["errors"] is JArray errors)) target["errors"] = errors = new JArray();
            errors.Add(error);
        }

        private static JObject Top(IEnumerable<KeyValuePair<string, long>> values, int count)
        {
            var result = new JObject();
            foreach (var pair in values.Where(v => v.Value != 0).OrderByDescending(v => Math.Abs(v.Value)).Take(count)) result[pair.Key] = pair.Value;
            return result;
        }

        private static JObject WorstFactors(JObject factors, int count)
        {
            var result = new JObject();
            foreach (var p in factors.Properties().Where(p => p.Value.Type == JTokenType.Integer && (int)p.Value < 0).OrderBy(p => (int)p.Value).Take(count))
                result[p.Name] = p.Value;
            return result;
        }

        private static int Pct(long used, long capacity) => capacity > 0 ? (int)Math.Round(100.0 * used / capacity) : (used > 0 ? 999 : 0);

        // Probe plus wall-clock cost; probes over 2 ms are reported in perfMs.
        private static void Timed(JArray errors, JObject perf, string name, Action probe)
        {
            var clock = System.Diagnostics.Stopwatch.StartNew();
            Probe(errors, name, probe);
            double ms = clock.Elapsed.TotalMilliseconds;
            if (ms >= 2) perf[name] = Math.Round(ms, 1);
        }

        private void RefreshSnapshot()
        {
            var w = RequireCity(); var em = w.EntityManager; var errors = new JArray();
            if (firesSeen == null) firesSeen = new HashSet<Entity>();
            if (lastEventFrame == null) lastEventFrame = new Dictionary<string, uint>();
            var sim = w.GetExistingSystemManaged<SimulationSystem>();
            var prev = snapshotCity == citySession ? snapshot : null;
            bool slow = prev == null || snapshotBuilds % 8 == 0;
            var perf = new JObject(); var total = System.Diagnostics.Stopwatch.StartNew();
            var s = new JObject { ["v"] = 1, ["frame"] = sim.frameIndex, ["speed"] = sim.selectedSpeed, ["utc"] = DateTime.UtcNow.ToString("O") };
            var city = new JObject(); s["city"] = city;
            Timed(errors, perf, "city", () =>
            {
                var cs = w.GetExistingSystemManaged<CitySystem>();
                city["name"] = w.GetExistingSystemManaged<CityConfigurationSystem>()?.cityName;
                city["money"] = cs.moneyAmount;
                if (em.HasComponent<Population>(cs.City))
                {
                    var p = em.GetComponentData<Population>(cs.City);
                    city["pop"] = p.m_Population; city["moveIn"] = p.m_PopulationWithMoveIn - p.m_Population;
                    s["happy"] = p.m_AverageHappiness; s["health"] = p.m_AverageHealth;
                }
            });
            Timed(errors, perf, "budget", () =>
            {
                var b = w.GetExistingSystemManaged<CityServiceBudgetSystem>();
                city["net"] = b.GetBalance();
                var income = new List<KeyValuePair<string, long>>(); var expense = new List<KeyValuePair<string, long>>();
                foreach (IncomeSource src in Enum.GetValues(typeof(IncomeSource))) if (src != IncomeSource.Count) income.Add(new KeyValuePair<string, long>(src.ToString(), b.GetIncome(src)));
                foreach (ExpenseSource src in Enum.GetValues(typeof(ExpenseSource))) if (src != ExpenseSource.Count) expense.Add(new KeyValuePair<string, long>(src.ToString(), b.GetExpense(src)));
                s["income"] = Top(income, 4); s["expense"] = Top(expense, 3);
            });
            Timed(errors, perf, "tax", () =>
            {
                var t = w.GetExistingSystemManaged<TaxSystem>();
                s["tax"] = new JObject { ["R"] = t.GetTaxRate(TaxAreaType.Residential), ["C"] = t.GetTaxRate(TaxAreaType.Commercial), ["I"] = t.GetTaxRate(TaxAreaType.Industrial), ["O"] = t.GetTaxRate(TaxAreaType.Office) };
            });
            Timed(errors, perf, "demand", () =>
            {
                var r = w.GetExistingSystemManaged<ResidentialDemandSystem>().buildingDemand;
                var ind = w.GetExistingSystemManaged<IndustrialDemandSystem>();
                s["demand"] = new JObject { ["rL"] = r.x, ["rM"] = r.y, ["rH"] = r.z, ["c"] = w.GetExistingSystemManaged<CommercialDemandSystem>().buildingDemand, ["i"] = ind.industrialBuildingDemand, ["o"] = ind.officeBuildingDemand };
            });
            Timed(errors, perf, "jobs", () =>
            {
                var h = w.GetExistingSystemManaged<CountHouseholdDataSystem>();
                var wp = w.GetExistingSystemManaged<CountWorkplacesSystem>();
                var total = RawFields(wp.GetTotalWorkplaces()).Properties().Select(p => p.Value).Where(v => v.Type == JTokenType.Integer).Select(v => (long)v).ToArray();
                var free = RawFields(wp.GetFreeWorkplaces()).Properties().Select(p => p.Value).Where(v => v.Type == JTokenType.Integer).Select(v => (long)v).ToArray();
                s["jobs"] = new JObject
                {
                    ["unemp"] = Math.Round((double)h.UnemploymentRate, 1), ["homeless"] = h.HomelessCitizenCount,
                    ["workers"] = h.CityWorkerCount, ["eligible"] = h.WorkableCitizenCount,
                    ["jobs"] = total.Sum(), ["vacant"] = free.Sum(), ["vacantByEdu"] = new JArray(free),
                    ["eduCitizens"] = new JArray(h.UneducatedCount, h.PoorlyEducatedCount, h.EducatedCount, h.WellEducatedCount, h.HighlyEducatedCount)
                };
            });
            if (slow)
            {
                Timed(errors, perf, "happinessFactors", () =>
                {
                    // Every happiness factor with a visible effect, worst first (the game's own panel).
                    var all = new JObject();
                    foreach (var p in HappinessFactors(w).Properties()
                        .Where(p => p.Value is JObject f && (bool?)f["locked"] != true && (int?)f["samples"] > 0 && Math.Abs((double)f["effect"]) >= 0.5)
                        .OrderBy(p => (double)p.Value["effect"]))
                        all[p.Name] = Math.Round((double)p.Value["effect"], 1);
                    s["happiness"] = all;
                    // Priority tags per the owner rule: < -5 very_high, < -3 priority.
                    var tags = new JObject { ["very_high"] = new JArray(), ["priority"] = new JArray() };
                    foreach (var p in all.Properties())
                    {
                        if (p.Name == "Tax") continue; // exempt: reported, never prioritised
                        string tag = ServiceSignals.FactorPriority((double)p.Value);
                        if (tag != "normal") ((JArray)tags[tag]).Add(p.Name);
                    }
                    s["happinessPriority"] = tags;
                });
                Timed(errors, perf, "demandFactors", () =>
                {
                    JobHandle ready; var ind = w.GetExistingSystemManaged<IndustrialDemandSystem>();
                    s["demandWhy"] = new JObject
                    {
                        ["rL"] = WorstFactors(Factors(w.GetExistingSystemManaged<ResidentialDemandSystem>().GetLowDensityDemandFactors(out ready), ready), 2),
                        ["c"] = WorstFactors(Factors(w.GetExistingSystemManaged<CommercialDemandSystem>().GetDemandFactors(out ready), ready), 2),
                        ["i"] = WorstFactors(Factors(ind.GetIndustrialDemandFactors(out ready), ready), 2),
                        ["o"] = WorstFactors(Factors(ind.GetOfficeDemandFactors(out ready), ready), 2)
                    };
                });
            }
            else
            {
                if (prev?["happiness"] != null) s["happiness"] = prev["happiness"].DeepClone();
                if (prev?["happinessPriority"] != null) s["happinessPriority"] = prev["happinessPriority"].DeepClone();
                if (prev?["demandWhy"] != null) s["demandWhy"] = prev["demandWhy"].DeepClone();
            }
            var util = new JObject(); s["util"] = util;
            Timed(errors, perf, "power", () =>
            {
                var e = w.GetExistingSystemManaged<ElectricityStatisticsSystem>();
                var trade = w.GetExistingSystemManaged<ElectricityTradeSystem>();
                util["power"] = new JObject { ["prod"] = e.production, ["use"] = e.consumption, ["met"] = e.fulfilledConsumption, ["pct"] = Pct(e.consumption, e.production), ["import"] = trade?.import ?? 0, ["export"] = trade?.export ?? 0 };
            });
            Timed(errors, perf, "water", () =>
            {
                var e = w.GetExistingSystemManaged<WaterStatisticsSystem>();
                util["water"] = new JObject { ["cap"] = e.freshCapacity, ["use"] = e.freshConsumption, ["pct"] = Pct(e.freshConsumption, e.freshCapacity) };
                util["sewage"] = new JObject { ["cap"] = e.sewageCapacity, ["use"] = e.sewageConsumption, ["pct"] = Pct(e.sewageConsumption, e.sewageCapacity) };
            });
            var fires = new HashSet<Entity>(); var firePlaces = new Dictionary<Entity, JObject>(); Dictionary<string, List<Unity.Mathematics.float2>> shortagePoints = null;
            Timed(errors, perf, "buildings", () =>
            {
                var shortages = new SortedDictionary<string, int>(); var penalties = new SortedDictionary<string, int>(); shortagePoints = new Dictionary<string, List<Unity.Mathematics.float2>>();
                int buildings = 0, abandoned = 0, condemned = 0, construction = 0, penalised = 0; long powerCapacity = 0;
                var prefabs = w.GetExistingSystemManaged<PrefabSystem>();
                foreach (var e in NativeBuild.Buildings(em))
                {
                    if (!em.HasComponent<Game.Objects.Transform>(e) || em.HasComponent<PrefabData>(e) || em.HasComponent<Game.Common.Native>(e)) continue;
                    ++buildings;
                    if (em.HasComponent<Abandoned>(e)) ++abandoned;
                    if (em.HasComponent<Condemned>(e)) ++condemned;
                    if (em.HasComponent<Game.Objects.UnderConstruction>(e)) ++construction;
                    if (em.HasComponent<Game.Events.OnFire>(e))
                    {
                        fires.Add(e);
                        var pos = em.GetComponentData<Game.Objects.Transform>(e).m_Position;
                        firePlaces[e] = new JObject { ["prefab"] = em.HasComponent<PrefabRef>(e) ? prefabs.GetPrefabName(em.GetComponentData<PrefabRef>(e).m_Prefab) : null, ["x"] = Math.Round(pos.x), ["z"] = Math.Round(pos.z) };
                    }
                    if (em.HasComponent<ElectricityProducer>(e)) powerCapacity += em.GetComponentData<ElectricityProducer>(e).m_Capacity;
                    foreach (var row in Shortages(em, e))
                    {
                        string type = (string)row["type"]; shortages[type] = shortages.TryGetValue(type, out var n) ? n + 1 : 1;
                        if (!shortagePoints.TryGetValue(type, out var where)) shortagePoints[type] = where = new List<Unity.Mathematics.float2>();
                        where.Add(em.GetComponentData<Game.Objects.Transform>(e).m_Position.xz);
                    }
                    if (!em.HasBuffer<Efficiency>(e) || !em.HasComponent<PrefabRef>(e) || !em.HasComponent<ServiceObjectData>(em.GetComponentData<PrefabRef>(e).m_Prefab)) continue;
                    bool hit = false;
                    foreach (var f in em.GetBuffer<Efficiency>(e, true))
                        if (f.m_Efficiency < 0.99f) { string k = f.m_Factor.ToString(); penalties[k] = penalties.TryGetValue(k, out var n) ? n + 1 : 1; hit = true; }
                    if (hit) ++penalised;
                }
                s["shortages"] = JObject.FromObject(shortages);
                s["servicePenalties"] = new JObject { ["buildings"] = penalised, ["byFactor"] = JObject.FromObject(penalties) };
                s["buildings"] = new JObject { ["total"] = buildings, ["building"] = construction, ["abandoned"] = abandoned, ["condemned"] = condemned, ["onFire"] = fires.Count };
                if (util["power"] is JObject power) power["plantCap"] = powerCapacity;
            });
            JArray recentChirps = null; string activePhase = null;
            Timed(errors, perf, "ui", () =>
            {
                var ui = UiState(new JObject { ["chirps"] = 10 });
                recentChirps = ui["chirps"] as JArray; activePhase = (string)ui["tutorial"]?["activeTutorialPhase"];
                var u = new JObject { ["blocker"] = ui["likelyBlocker"], ["fixable"] = ui["resolvableByBridge"] };
                var phase = ui["tutorial"]?["activeTutorialPhase"];
                if (phase != null && phase.Type != JTokenType.Null) u["tutorial"] = phase;
                var pending = ui["milestone"]?["pending"];
                if (pending != null && pending.Type != JTokenType.Null) u["milestonePopup"] = pending;
                if (ui["signatures"]?["pending"] is JArray sig && sig.Count > 0) u["signatures"] = new JArray(sig.Select(x => x["name"]));
                if (ui["dialogs"] is JArray dialogs && dialogs.Count > 0) u["dialog"] = dialogs[0]["title"];
                string tool = (string)ui["activeTool"];
                if (tool != null && tool != "DefaultToolSystem") u["tool"] = tool;
                if (ui["hasFocus"] != null) u["focus"] = ui["hasFocus"];
                s["ui"] = u;
                if (ui["milestone"] is JObject m)
                {
                    var ms = new JObject { ["achieved"] = m["achieved"], ["xp"] = m["xp"], ["nextXp"] = m["nextXp"] };
                    if (m["blockedBy"] != null) ms["blockedBy"] = m["blockedBy"];
                    s["milestone"] = ms;
                }
                if (ui["chirps"] is JArray chirps)
                    s["chirps"] = new JArray(chirps.Take(2).Select(c => { string t = (string)c["text"] ?? ""; return (JToken)(t.Length > 90 ? t.Substring(0, 90) + "\u2026" : t); }));
                if (ui["errors"] is JArray uiErrors) foreach (var x in uiErrors.Take(3)) errors.Add("ui." + (string)x);
            });
            Timed(errors, perf, "needs", () => s["needs"] = ServiceNeeds(w, recentChirps, activePhase, s["happiness"] as JObject));
            Timed(errors, perf, "utilityNeeds", () => ApplyUtilityNeeds(w, s, shortagePoints));
            Timed(errors, perf, "icons", () => SnapshotIcons(w, s, sim.frameIndex, prev != null));
            if (errors.Count > 0) s["errors"] = errors;
            perf["total"] = Math.Round(total.Elapsed.TotalMilliseconds, 1);
            if (total.Elapsed.TotalMilliseconds >= 10) s["perfMs"] = perf; // only when the build is slow
            s["bytes"] = 0;
            s["bytes"] = Encoding.UTF8.GetByteCount(s.ToString(Formatting.None));

            DetectEvents(prev, s, fires, firePlaces);
            firesSeen = fires;
            snapshot = s; snapshotFrame = sim.frameIndex; snapshotUtc = DateTime.UtcNow; snapshotCity = citySession; snapshotBuilds++;
        }

        // Compares two consecutive snapshots of the same city and appends what changed.
        private void DetectEvents(JObject prev, JObject now, HashSet<Entity> fires, Dictionary<Entity, JObject> firePlaces)
        {
            uint frame = (uint?)now["frame"] ?? 0;
            if (prev == null)
            {
                cityWasLoaded = true; lastEventFrame.Clear();
                EmitEvent("city_loaded", frame, new JObject { ["city"] = now["city"]?["name"], ["pop"] = now["city"]?["pop"], ["money"] = now["city"]?["money"] });
                return;
            }
            int? I(JToken t) => t == null || t.Type == JTokenType.Null ? (int?)null : (int)t;
            long? L(JToken t) => t == null || t.Type == JTokenType.Null ? (long?)null : (long)t;
            string S(JToken t) => t == null || t.Type == JTokenType.Null ? null : (string)t;

            int? achieved = I(now["milestone"]?["achieved"]), wasAchieved = I(prev["milestone"]?["achieved"]);
            if (achieved != null && wasAchieved != null && achieved > wasAchieved) EmitEvent("milestone", frame, new JObject { ["achieved"] = achieved, ["xp"] = now["milestone"]?["xp"] });
            string popup = S(now["ui"]?["milestonePopup"]);
            if (popup != null && popup != S(prev["ui"]?["milestonePopup"])) EmitEvent("milestone_popup", frame, new JObject { ["name"] = popup });
            string tutorial = S(now["ui"]?["tutorial"]);
            if (tutorial != null && tutorial != S(prev["ui"]?["tutorial"])) EmitEvent("tutorial", frame, new JObject { ["phase"] = tutorial });
            string signature = S(now["ui"]?["signatures"]?[0]);
            if (signature != null && signature != S(prev["ui"]?["signatures"]?[0])) EmitEvent("signature", frame, new JObject { ["names"] = now["ui"]["signatures"].DeepClone() });
            string blocker = S(now["ui"]?["blocker"]);
            if ((blocker == "error_dialog" || blocker == "menu_screen" || blocker == "unknown_ui_panel") && blocker != S(prev["ui"]?["blocker"]))
                EmitEvent("ui_blocker", frame, new JObject { ["blocker"] = blocker, ["dialog"] = now["ui"]?["dialog"] });

            long? net = L(now["city"]?["net"]), wasNet = L(prev["city"]?["net"]);
            if (net != null && wasNet != null && (net < 0) != (wasNet < 0) && Throttle("net", frame, 2048))
                EmitEvent(net < 0 ? "net_negative" : "net_positive", frame, new JObject { ["net"] = net, ["was"] = wasNet });

            foreach (var type in new[] { "power", "water", "sewage" })
            {
                int? pct = I(now["util"]?[type]?["pct"]), was = I(prev["util"]?[type]?["pct"]);
                if (pct == null || was == null) continue;
                if (pct > 90 && was <= 90) EmitEvent("utility_high", frame, new JObject { ["type"] = type, ["pct"] = pct });
                else if (pct < 85 && was >= 85 && Throttle("util_ok_" + type, frame, 2048)) EmitEvent("utility_ok", frame, new JObject { ["type"] = type, ["pct"] = pct });
            }
            if (now["shortages"] is JObject shortages)
                foreach (var p in shortages.Properties())
                    if (prev["shortages"]?[p.Name] == null) EmitEvent("shortage", frame, new JObject { ["type"] = p.Name, ["buildings"] = p.Value });

            var newFires = fires.Where(f => !firesSeen.Contains(f)).ToList();
            if (newFires.Count > 0)
            {
                var first = firePlaces[newFires[0]];
                EmitEvent("fire", frame, new JObject { ["new"] = newFires.Count, ["burning"] = fires.Count, ["prefab"] = first["prefab"], ["x"] = first["x"], ["z"] = first["z"] });
            }
            foreach (var kind in new[] { "abandoned", "condemned" })
            {
                int? count = I(now["buildings"]?[kind]), was = I(prev["buildings"]?[kind]);
                if (count != null && was != null && count > was && Throttle(kind, frame, 4096)) EmitEvent(kind, frame, new JObject { ["count"] = count, ["was"] = was });
            }
        }

        private bool Throttle(string key, uint frame, uint frames)
        {
            if (lastEventFrame.TryGetValue(key, out var last) && frame >= last && frame - last < frames) return false;
            lastEventFrame[key] = frame;
            return true;
        }

        // One compact JSON line per event; the file is rotated to events.1.jsonl at 1 MB.
        private void EmitEvent(string type, uint frame, JObject data)
        {
            try
            {
                string path = Path.Combine(mailbox.Root, "events.jsonl");
                var info = new FileInfo(path);
                if (info.Exists && info.Length > EventFileLimit)
                {
                    string old = Path.Combine(mailbox.Root, "events.1.jsonl");
                    if (File.Exists(old)) File.Delete(old);
                    File.Move(path, old);
                }
                var line = new JObject { ["s"] = mailbox.Session.Substring(0, 8), ["seq"] = ++eventSeq, ["type"] = type, ["frame"] = frame, ["utc"] = DateTime.UtcNow.ToString("O"), ["data"] = data };
                Mailbox.RetrySharingViolation(() => File.AppendAllText(path, line.ToString(Formatting.None) + "\n", new UTF8Encoding(false)));
            }
            catch (Exception e) { eventError = e.GetBaseException().Message; }
        }
    }
}
