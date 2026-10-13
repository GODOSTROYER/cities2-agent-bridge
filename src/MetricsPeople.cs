using System;
using System.Collections.Generic;
using Game.Buildings;
using Game.Common;
using Game.Prefabs;
using Game.Simulation;
using Game.Tools;
using Newtonsoft.Json.Linq;
using Unity.Collections;
using Unity.Entities;

namespace CitiesIIAgentBridge
{
    // People figures in one read-only pass: zoned building levels by kind, leveling progress,
    // household wealth classes, homelessness and abandonment. Every section is isolated by Probe
    // (UiState.cs) so a game update yields an entry in "errors" instead of failing the command.
    public sealed partial class Mod
    {
        // Wealth is read from every 4th household (about a quarter of the city's households).
        private const int PeopleHouseholdStride = 4;
        private static readonly string[] PeopleKinds = { "resLow", "resMedium", "resHigh", "mixed", "commercial", "industrial", "office" };
        private static readonly string[] PeopleWealth = { "wretched", "poor", "modest", "comfortable", "wealthy" };

        // Zone kind index into PeopleKinds, or -1 when the zone is not one of the growable kinds.
        // Mixed and the density classes are told apart by the zone prefab's name (the game has no
        // mixed flag on ZoneData; the names are the ones the city tooling already uses, e.g.
        // "NA Residential Mixed", "NA Residential Medium Row", "NA Residential High").
        private static int PeopleKind(ZoneData zone, string name)
        {
            name = name ?? "";
            if (zone.m_AreaType == Game.Zones.AreaType.Residential) return name.Contains("Mixed") ? 3 : name.Contains("High") ? 2 : name.Contains("Medium") ? 1 : 0;
            if (zone.m_AreaType == Game.Zones.AreaType.Commercial) return 4;
            if (zone.m_AreaType == Game.Zones.AreaType.Industrial) return zone.IsOffice() ? 6 : 5;
            return -1;
        }

        // people {}: a compact summary of the people side of the city. Read-only, main thread.
        private JObject PeopleMetrics()
        {
            var clock = System.Diagnostics.Stopwatch.StartNew();
            var w = RequireCity(); var em = w.EntityManager; var errors = new JArray(); var o = new JObject();
            int kinds = PeopleKinds.Length;

            // One pass over the buildings: level histogram per kind, condition sums, abandonment and
            // construction counts. Under-construction buildings are counted but not levelled.
            var byLevel = new long[kinds, 6]; var condSum = new double[kinds]; var condN = new long[kinds];
            long buildings = 0, abandoned = 0, condemned = 0, construction = 0; bool read = false;
            Probe(errors, "buildings", () =>
            {
                var prefabs = w.GetExistingSystemManaged<PrefabSystem>();
                var kindOf = new Dictionary<Entity, int>();
                foreach (var e in NativeBuild.Buildings(em))
                {
                    // Same filter as Snapshot.cs: real buildings only, no prefab or native entities.
                    if (!em.HasComponent<Game.Objects.Transform>(e) || em.HasComponent<PrefabData>(e) || em.HasComponent<Game.Common.Native>(e)) continue;
                    buildings++;
                    if (em.HasComponent<Abandoned>(e)) abandoned++;
                    if (em.HasComponent<Condemned>(e)) condemned++;
                    if (em.HasComponent<Game.Objects.UnderConstruction>(e)) { construction++; continue; }
                    if (!em.HasComponent<PrefabRef>(e)) continue;
                    var prefab = em.GetComponentData<PrefabRef>(e).m_Prefab;
                    if (!em.HasComponent<SpawnableBuildingData>(prefab)) continue;
                    var spawn = em.GetComponentData<SpawnableBuildingData>(prefab);
                    if (spawn.m_ZonePrefab == Entity.Null || !em.HasComponent<ZoneData>(spawn.m_ZonePrefab)) continue;
                    if (!kindOf.TryGetValue(spawn.m_ZonePrefab, out int k))
                    {
                        k = PeopleKind(em.GetComponentData<ZoneData>(spawn.m_ZonePrefab), prefabs.GetPrefabName(spawn.m_ZonePrefab));
                        kindOf[spawn.m_ZonePrefab] = k;
                    }
                    if (k < 0 || spawn.m_Level < 1 || spawn.m_Level > 5) continue;
                    byLevel[k, spawn.m_Level]++;
                    // BuildingCondition.m_Condition: the game's per-building condition value.
                    if (em.HasComponent<BuildingCondition>(e)) { condSum[k] += em.GetComponentData<BuildingCondition>(e).m_Condition; condN[k]++; }
                }
                read = true;
            });

            // Levels by zone kind: counts per level 1..5, average level, share at level 5 (the top level).
            Probe(errors, "levels", () =>
            {
                if (!read) return;
                var rows = new JObject();
                for (int k = 0; k < kinds; k++)
                {
                    long n = 0, sum = 0;
                    for (int l = 1; l <= 5; l++) { n += byLevel[k, l]; sum += byLevel[k, l] * l; }
                    rows[PeopleKinds[k]] = new JObject
                    {
                        ["n"] = n,
                        ["byLevel"] = new JArray(byLevel[k, 1], byLevel[k, 2], byLevel[k, 3], byLevel[k, 4], byLevel[k, 5]),
                        ["avgLevel"] = n == 0 ? 0 : Math.Round((double)sum / n, 2),
                        ["maxLevelPct"] = n == 0 ? 0 : Math.Round(100.0 * byLevel[k, 5] / n, 1)
                    };
                }
                o["levels"] = rows;
            });

            // Leveling progress: the condition value per kind. No flag or gate that says why a building
            // cannot level up was found by reflection, so that part is reported as not exposed.
            Probe(errors, "levelingBlockers", () =>
            {
                if (!read) return;
                var avg = new JObject();
                for (int k = 0; k < kinds; k++) avg[PeopleKinds[k]] = condN[k] == 0 ? 0 : Math.Round(condSum[k] / condN[k], 1);
                o["levelingBlockers"] = new JObject
                {
                    ["conditionAvg"] = avg,
                    ["notExposed"] = true,
                    ["note"] = "BuildingCondition.m_Condition averages only; the game exposes no level-up blocker flag or land-value gate"
                };
            });

            // Wealth classes of households (the Wealth infoview's own key and money helpers), sampled.
            Probe(errors, "wealth", () =>
            {
                CitizenHappinessParameterData happiness;
                using (var hq = em.CreateEntityQuery(ComponentType.ReadOnly<CitizenHappinessParameterData>()))
                {
                    if (hq.IsEmptyIgnoreFilter) throw new InvalidOperationException("citizen_happiness_parameters_missing");
                    happiness = hq.GetSingleton<CitizenHappinessParameterData>();
                }
                var classes = new long[5]; long sampled = 0, money = 0;
                using (var q = em.CreateEntityQuery(new EntityQueryDesc
                {
                    All = new[] { ComponentType.ReadOnly<Game.Citizens.Household>() },
                    None = new[] { ComponentType.ReadOnly<Deleted>(), ComponentType.ReadOnly<Temp>(), ComponentType.ReadOnly<Game.Citizens.TouristHousehold>(), ComponentType.ReadOnly<Game.Citizens.CommuterHousehold>() }
                }))
                using (var es = q.ToEntityArray(Allocator.Temp))
                    for (int i = 0; i < es.Length; i += PeopleHouseholdStride)
                    {
                        var household = es[i];
                        if (!em.HasBuffer<Game.Economy.Resources>(household)) continue;
                        int key = (int)Game.UI.InGame.CitizenUIUtils.GetHouseholdWealth(em, household, happiness);
                        if (key >= 0 && key < classes.Length) classes[key]++;
                        money += Game.UI.InGame.CitizenUIUtils.GetHouseholdMoney(em, household);
                        sampled++;
                    }
                var shares = new JObject(); double poorest = 0;
                for (int c = 0; c < classes.Length; c++)
                {
                    double share = sampled == 0 ? 0 : Math.Round(100.0 * classes[c] / sampled, 1);
                    shares[PeopleWealth[c]] = share; if (c == 0) poorest = share;
                }
                o["wealth"] = new JObject
                {
                    ["sampled"] = sampled,
                    ["everyNth"] = PeopleHouseholdStride,
                    ["classSharePct"] = shares,
                    ["poorestSharePct"] = poorest,
                    ["avgMoney"] = sampled == 0 ? 0 : Math.Round((double)money / sampled)
                };
            });

            // Homelessness: the game's own counters (the same source as the snapshot's jobs.homeless).
            Probe(errors, "homeless", () =>
            {
                var h = w.GetExistingSystemManaged<CountHouseholdDataSystem>();
                o["homeless"] = new JObject { ["households"] = h.HomelessHouseholdCount, ["citizens"] = h.HomelessCitizenCount };
            });

            // Abandoned, condemned and under-construction buildings, counted in the building pass.
            Probe(errors, "abandoned", () =>
            {
                if (!read) return;
                o["abandoned"] = new JObject { ["abandoned"] = abandoned, ["condemned"] = condemned, ["underConstruction"] = construction, ["buildings"] = buildings };
            });

            o["ms"] = Math.Round(clock.Elapsed.TotalMilliseconds, 1);
            o["errors"] = errors; o["citySession"] = citySession;
            return o;
        }
    }
}
