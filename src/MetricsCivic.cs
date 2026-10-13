using System;
using System.Collections.Generic;
using System.Linq;
using Game.Buildings;
using Game.Citizens;
using Game.Common;
using Game.Prefabs;
using Game.Simulation;
using Game.Tools;
using Newtonsoft.Json.Linq;
using Unity.Collections;
using Unity.Entities;

namespace CitiesIIAgentBridge
{
    // Civic services as the game holds them: welfare offices, administration (city hall), disaster
    // response (emergency shelters, disaster control, early warning, fire helicopters) and the active
    // weather and flood events. Read-only, main thread, never throws: each section has its own probe.
    public sealed partial class Mod
    {
        // Service entity of a building (ServiceObjectData.m_Service on its prefab or an upgrade).
        private static Entity CivicServiceOf(EntityManager em, Entity building)
        {
            foreach (var pe in PrefabAndUpgrades(em, building))
                if (em.HasComponent<ServiceObjectData>(pe)) { var s = em.GetComponentData<ServiceObjectData>(pe).m_Service; if (s != Entity.Null) return s; }
            return Entity.Null;
        }

        // Efficiency of a group: average of the product of each Efficiency multiplier (as Headroom
        // computes it), buildings under 100%, every penalty by factor, and the main factor (lowest multiplier).
        private static JObject CivicEfficiency(EntityManager em, List<Entity> group, Dictionary<string, int> penalties, Dictionary<string, int> main)
        {
            int n = 0, below = 0; double sum = 0;
            foreach (var e in group)
            {
                if (!em.HasBuffer<Efficiency>(e)) continue;
                n++; double eff = 1; float lowest = float.MaxValue; string lowFactor = null;
                foreach (var f in em.GetBuffer<Efficiency>(e, true))
                {
                    eff *= Math.Max(0f, f.m_Efficiency);
                    if (f.m_Efficiency < 0.99f) { string k = f.m_Factor.ToString(); penalties[k] = penalties.TryGetValue(k, out var c) ? c + 1 : 1; }
                    if (f.m_Efficiency < lowest) { lowest = f.m_Efficiency; lowFactor = f.m_Factor.ToString(); }
                }
                sum += eff;
                if (lowest < 0.99f) { below++; main[lowFactor] = main.TryGetValue(lowFactor, out var m) ? m + 1 : 1; }
            }
            return new JObject { ["buildings"] = group.Count, ["withEfficiency"] = n, ["avgPct"] = n == 0 ? 0 : Math.Round(100 * sum / n), ["below100"] = below };
        }

        private static JObject CivicCounts(Dictionary<string, int> counts)
        {
            var o = new JObject();
            foreach (var kv in counts.OrderByDescending(kv => kv.Value).ThenBy(kv => kv.Key, StringComparer.Ordinal).Take(6)) o[kv.Key] = kv.Value;
            return o;
        }

        // civic_metrics {}: welfare, administration, disaster response and efficiency of those buildings.
        private JObject CivicMetrics()
        {
            var w = RequireCity(); var em = w.EntityManager; var ps = w.GetExistingSystemManaged<PrefabSystem>();
            var errors = new JArray();
            var welfareObj = new JObject(); var adminObj = new JObject(); var disasterObj = new JObject(); var effObj = new JObject();
            var result = new JObject { ["welfare"] = welfareObj, ["administration"] = adminObj, ["disaster"] = disasterObj, ["efficiency"] = effObj, ["errors"] = errors };

            var all = new HashSet<Entity>();
            Probe(errors, "buildings", () => all = NativeBuild.Buildings(em));
            // Live buildings of one kind: excludes prefabs, buildings under construction, and entities
            // that NativeBuild.Buildings already drops (Temp, Deleted).
            List<Entity> Civic(Func<Entity, bool> kind)
            {
                var list = new List<Entity>();
                foreach (var e in all)
                    if (!em.HasComponent<PrefabData>(e) && !em.HasComponent<Game.Objects.UnderConstruction>(e) && kind(e)) list.Add(e);
                return list;
            }
            var welfare = new List<Entity>(); var admin = new List<Entity>(); var shelters = new List<Entity>(); var control = new List<Entity>();
            var helicopterStations = new List<Entity>(); var warnings = new List<Entity>();
            Probe(errors, "classify", () =>
            {
                welfare = Civic(e => em.HasComponent<Game.Buildings.WelfareOffice>(e));
                admin = Civic(e => em.HasComponent<Game.Buildings.AdminBuilding>(e));
                shelters = Civic(e => em.HasComponent<Game.Buildings.EmergencyShelter>(e));
                control = Civic(e => em.HasComponent<Game.Buildings.DisasterFacility>(e));
                warnings = Civic(e => em.HasComponent<Game.Buildings.EarlyDisasterWarningSystem>(e));
                helicopterStations = Civic(e => em.HasComponent<Game.Buildings.FireStation>(e));
            });
            // Budget of every service behind a group of buildings, once per service.
            var budgetSystem = w.GetExistingSystemManaged<CityServiceBudgetSystem>();
            int CivicBudget(List<Entity> group)
            {
                var services = new HashSet<Entity>(); int total = 0;
                foreach (var e in group) { var s = CivicServiceOf(em, e); if (s != Entity.Null && em.Exists(s)) services.Add(s); }
                if (budgetSystem != null) foreach (var s in services) total += budgetSystem.GetServiceBudget(s);
                return total;
            }

            // 1. Welfare: offices, positions, service usage, service budget; citizens and the city subsidy line.
            Probe(errors, "welfare", () =>
            {
                var positions = new JArray(); double usage = 0; int usageN = 0;
                foreach (var e in welfare)
                {
                    if (positions.Count < 12 && em.HasComponent<Game.Objects.Transform>(e)) { var p = em.GetComponentData<Game.Objects.Transform>(e).m_Position; positions.Add(new JArray(Math.Round(p.x), Math.Round(p.z))); }
                    if (em.HasComponent<ServiceUsage>(e)) { usage += em.GetComponentData<ServiceUsage>(e).m_Usage; usageN++; }
                }
                welfareObj["buildings"] = welfare.Count; welfareObj["positions"] = positions;
                welfareObj["usageAvgPct"] = usageN == 0 ? 0 : Math.Round(100 * usage / usageN);
                welfareObj["serviceBudget"] = CivicBudget(welfare);
            });
            Probe(errors, "welfareCitizens", () =>
            {
                var h = w.GetExistingSystemManaged<CountHouseholdDataSystem>();
                if (h != null && !h.IsCountDataNotReady()) { welfareObj["unemploymentRate"] = Math.Round((double)h.UnemploymentRate, 2); welfareObj["homelessCitizens"] = h.HomelessCitizenCount; }
                if (budgetSystem != null) welfareObj["cityGovernmentSubsidyIncome"] = (long)budgetSystem.GetIncome(Game.City.IncomeSource.GovernmentSubsidy);
            });

            // 2. Administration: city hall buildings, their service budget.
            Probe(errors, "administration", () =>
            {
                adminObj["buildings"] = admin.Count; adminObj["serviceBudget"] = CivicBudget(admin);
            });

            // 3. Disaster response: shelters (capacity, occupants, free space), disaster control, early
            // warning, fire helicopters (no separate depot type exists; helicopters are fire station capacity).
            Probe(errors, "shelters", () =>
            {
                int capacity = 0, vehicles = 0, occupants = 0, withSpace = 0, withVehicles = 0;
                foreach (var e in shelters)
                {
                    foreach (var pe in PrefabAndUpgrades(em, e))
                        if (em.HasComponent<EmergencyShelterData>(pe)) { var d = em.GetComponentData<EmergencyShelterData>(pe); capacity += d.m_ShelterCapacity; vehicles += d.m_VehicleCapacity; }
                    if (em.HasBuffer<Game.Buildings.Occupant>(e)) occupants += em.GetBuffer<Game.Buildings.Occupant>(e, true).Length;
                    var flags = em.GetComponentData<Game.Buildings.EmergencyShelter>(e).m_Flags;
                    if ((flags & Game.Buildings.EmergencyShelterFlags.HasShelterSpace) != 0) withSpace++;
                    if ((flags & Game.Buildings.EmergencyShelterFlags.HasAvailableVehicles) != 0) withVehicles++;
                }
                disasterObj["shelters"] = new JObject { ["buildings"] = shelters.Count, ["capacity"] = capacity, ["occupants"] = occupants, ["vehicleCapacity"] = vehicles, ["withSpace"] = withSpace, ["withVehicles"] = withVehicles, ["serviceBudget"] = CivicBudget(shelters) };
            });
            Probe(errors, "control", () =>
            {
                disasterObj["disasterControl"] = control.Count; disasterObj["earlyWarning"] = warnings.Count;
            });
            Probe(errors, "helicopters", () =>
            {
                int capacity = 0, disasterResponse = 0, available = 0;
                foreach (var e in helicopterStations)
                {
                    foreach (var pe in PrefabAndUpgrades(em, e))
                        if (em.HasComponent<FireStationData>(pe)) { var d = em.GetComponentData<FireStationData>(pe); capacity += d.m_FireHelicopterCapacity; disasterResponse += d.m_DisasterResponseCapacity; }
                    if ((em.GetComponentData<Game.Buildings.FireStation>(e).m_Flags & Game.Buildings.FireStationFlags.HasAvailableFireHelicopters) != 0) available++;
                }
                disasterObj["helicopters"] = new JObject { ["stations"] = helicopterStations.Count, ["capacity"] = capacity, ["available"] = available, ["disasterResponseCapacity"] = disasterResponse };
            });
            Probe(errors, "events", () =>
            {
                var weather = new Dictionary<string, int>(); int floods = 0;
                using (var q = em.CreateEntityQuery(new EntityQueryDesc { All = new[] { ComponentType.ReadOnly<Game.Events.WeatherPhenomenon>() }, None = new[] { ComponentType.ReadOnly<Deleted>(), ComponentType.ReadOnly<Temp>() } }))
                using (var es = q.ToEntityArray(Allocator.Temp))
                    foreach (var e in es)
                    {
                        string name = em.HasComponent<PrefabRef>(e) ? (ps.GetPrefabName(em.GetComponentData<PrefabRef>(e).m_Prefab) ?? "?") : "?";
                        weather[name] = weather.TryGetValue(name, out var c) ? c + 1 : 1;
                    }
                using (var q = em.CreateEntityQuery(new EntityQueryDesc { All = new[] { ComponentType.ReadOnly<Game.Events.Flood>() }, None = new[] { ComponentType.ReadOnly<Deleted>(), ComponentType.ReadOnly<Temp>() } }))
                    floods = q.CalculateEntityCount();
                int weatherTotal = weather.Values.Sum();
                disasterObj["events"] = new JObject { ["active"] = weatherTotal + floods, ["weather"] = CivicCounts(weather), ["floods"] = floods };
            });

            // 4. Efficiency of the buildings above, by group and across all of them.
            Probe(errors, "efficiency", () =>
            {
                var penalties = new Dictionary<string, int>(); var main = new Dictionary<string, int>();
                effObj["welfare"] = CivicEfficiency(em, welfare, penalties, main);
                effObj["administration"] = CivicEfficiency(em, admin, penalties, main);
                effObj["shelters"] = CivicEfficiency(em, shelters, penalties, main);
                effObj["disasterControl"] = CivicEfficiency(em, control, penalties, main);
                effObj["penalties"] = CivicCounts(penalties);
                effObj["mainFactor"] = CivicCounts(main);
            });
            return result;
        }
    }
}
