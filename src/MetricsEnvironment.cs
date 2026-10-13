using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using Game.Buildings;
using Game.Common;
using Game.Prefabs;
using Game.Simulation;
using Game.Tools;
using Newtonsoft.Json.Linq;
using Unity.Collections;
using Unity.Entities;
using Unity.Mathematics;

namespace CitiesIIAgentBridge
{
    // Environment figures for the city in one read-only pass: how polluted the homes are (air, ground,
    // noise), polluted water at the pumps, telecom coverage over homes, bicycle infrastructure and the
    // extractor areas. Every section is isolated by Probe so a failure lands in "errors" instead of
    // throwing. Positions and values are raw; the thresholds come from the game's own pollution UI levels.
    public sealed partial class Mod
    {
        private JObject EnvironmentMetrics()
        {
            var result = new JObject(); var errors = new JArray(); var clock = Stopwatch.StartNew();
            World w;
            try { w = RequireCity(); }
            catch (Exception e) { return new JObject { ["error"] = e.GetBaseException().Message }; }
            var em = w.EntityManager;

            // The game's pollution UI levels (UIPollutionThresholds on the UI configuration prefab).
            // Index: 0 air, 1 ground, 2 noise. The High level is the one reported as harmful; -1 = not read.
            var levels = new[] { -1, -1, -1 };
            Probe(errors, "thresholds", () =>
            {
                var ps = w.GetExistingSystemManaged<PrefabSystem>();
                using (var q = em.CreateEntityQuery(ComponentType.ReadOnly<PrefabData>()))
                using (var es = q.ToEntityArray(Allocator.Temp))
                    foreach (var e in es)
                    {
                        if (!ps.TryGetPrefab(e, out UIPollutionConfigurationPrefab cfg)) continue;
                        levels = new[] { cfg.m_AirPollution.m_High, cfg.m_GroundPollution.m_High, cfg.m_NoisePollution.m_High };
                        return;
                    }
            });

            // Homes: residential buildings (temporary and deleted entities are already excluded by
            // NativeBuild), skipping buildings still under construction.
            var homes = new List<float3>();
            Probe(errors, "homes", () =>
            {
                foreach (var e in NativeBuild.Buildings(em))
                {
                    if (em.HasComponent<PrefabData>(e) || !em.HasComponent<Game.Objects.Transform>(e) || !em.HasComponent<ResidentialProperty>(e)) continue;
                    if (em.HasComponent<Game.Objects.UnderConstruction>(e)) continue;
                    homes.Add(em.GetComponentData<Game.Objects.Transform>(e).m_Position);
                }
            });
            result["homes"] = homes.Count;

            // Pollution maps, read with the same pattern as CityCommands and Planning: GetMap, then
            // complete the job before sampling. The maps are owned by the systems; they are not disposed.
            NativeArray<AirPollution> airMap = default; NativeArray<GroundPollution> groundMap = default; NativeArray<NoisePollution> noiseMap = default;
            Probe(errors, "pollutionMaps", () =>
            {
                airMap = w.GetExistingSystemManaged<AirPollutionSystem>().GetMap(true, out var airReady); airReady.Complete();
                groundMap = w.GetExistingSystemManaged<GroundPollutionSystem>().GetMap(true, out var groundReady); groundReady.Complete();
                noiseMap = w.GetExistingSystemManaged<NoisePollutionSystem>().GetMap(true, out var noiseReady); noiseReady.Complete();
            });

            var air = new JObject(); var ground = new JObject(); var noise = new JObject();
            result["air"] = air; result["ground"] = ground; result["noise"] = noise;
            Probe(errors, "air", () =>
            {
                var values = new List<double>(homes.Count);
                foreach (var p in homes) values.Add(AirPollutionSystem.GetPollution(p, airMap).m_Pollution);
                EnvironmentHomeStats(air, homes, values, levels[0]);
            });
            Probe(errors, "ground", () =>
            {
                var values = new List<double>(homes.Count);
                foreach (var p in homes) values.Add(GroundPollutionSystem.GetPollution(p, groundMap).m_Pollution);
                EnvironmentHomeStats(ground, homes, values, levels[1]);
            });
            Probe(errors, "noise", () =>
            {
                var values = new List<double>(homes.Count);
                foreach (var p in homes) values.Add(NoisePollutionSystem.GetPollution(p, noiseMap).m_Pollution);
                EnvironmentHomeStats(noise, homes, values, levels[2]);
            });

            // Water: the pumping stations' own pollution value, and the water surface pollution sampled at
            // each pump's position. The river as a whole is not swept (only the pump positions are read).
            var water = new JObject(); result["water"] = water;
            Probe(errors, "water", () =>
            {
                var surface = w.GetExistingSystemManaged<WaterSystem>().GetSurfaceData(out var waterReady); waterReady.Complete();
                bool surfaceOk = surface.isCreated && surface.hasDepths && surface.resolution.x >= 2 && surface.resolution.z >= 2
                    && surface.depths.Length >= (long)surface.resolution.x * surface.resolution.z;
                int pumps = 0; double maxIntake = 0, maxSurface = 0; var rows = new JArray();
                foreach (var e in NativeBuild.Buildings(em))
                {
                    if (em.HasComponent<PrefabData>(e) || !em.HasComponent<Game.Buildings.WaterPumpingStation>(e) || !em.HasComponent<Game.Objects.Transform>(e)) continue;
                    pumps++;
                    var pos = em.GetComponentData<Game.Objects.Transform>(e).m_Position;
                    double intake = em.GetComponentData<Game.Buildings.WaterPumpingStation>(e).m_Pollution;
                    maxIntake = Math.Max(maxIntake, intake);
                    double surfaceValue = -1;
                    if (surfaceOk)
                    {
                        var sp = WaterUtils.ToSurfaceSpace(ref surface, pos);
                        if (sp.x >= 0 && sp.z >= 0 && sp.x < surface.resolution.x && sp.z < surface.resolution.z)
                        {
                            surfaceValue = WaterUtils.SamplePolluted(ref surface, pos);
                            maxSurface = Math.Max(maxSurface, surfaceValue);
                        }
                    }
                    if (rows.Count < 12) rows.Add(new JArray(Math.Round(pos.x), Math.Round(pos.z), Math.Round(intake, 1), Math.Round(surfaceValue, 3)));
                }
                water["pumps"] = pumps; water["maxIntake"] = Math.Round(maxIntake, 1); water["maxSurfaceAtPumps"] = Math.Round(maxSurface, 3);
                water["surfaceAvailable"] = surfaceOk; water["units"] = "native pollution value; not a percentage";
                water["intakesListed"] = rows.Count; water["intakes"] = rows; // [x, z, intakePollution, surfacePollution (-1 = not sampled)]
                water["riverSwept"] = false;
            });

            // Telecom: facilities (position, network capacity and range from the prefab and its upgrades),
            // and the game's telecom coverage map sampled at each home.
            var telecom = new JObject(); result["telecom"] = telecom;
            Probe(errors, "telecomFacilities", () =>
            {
                int count = 0; double capacity = 0; var rows = new JArray();
                foreach (var e in NativeBuild.Buildings(em))
                {
                    if (em.HasComponent<PrefabData>(e) || !em.HasComponent<Game.Buildings.TelecomFacility>(e) || !em.HasComponent<Game.Objects.Transform>(e)) continue;
                    count++; float netCap = 0, range = 0; bool any = false;
                    foreach (var pe in PrefabAndUpgrades(em, e))
                    {
                        if (!em.HasComponent<TelecomFacilityData>(pe)) continue;
                        var d = em.GetComponentData<TelecomFacilityData>(pe); netCap += d.m_NetworkCapacity; range = Math.Max(range, d.m_Range); any = true;
                    }
                    capacity += netCap;
                    if (rows.Count < 15)
                    {
                        var pos = em.GetComponentData<Game.Objects.Transform>(e).m_Position;
                        rows.Add(new JArray(Math.Round(pos.x), Math.Round(pos.z), any ? Math.Round(netCap) : (double?)null, any ? Math.Round(range) : (double?)null));
                    }
                }
                telecom["facilities"] = count; telecom["networkCapacity"] = Math.Round(capacity); telecom["facilityList"] = rows; // [x, z, networkCapacity, range]
            });
            Probe(errors, "telecomCoverage", () =>
            {
                var coverageSystem = w.GetExistingSystemManaged<TelecomCoverageSystem>();
                var coverage = coverageSystem.GetData(true, out var coverageReady); coverageReady.Complete();
                var quality = new List<double>(homes.Count);
                foreach (var p in homes) quality.Add(TelecomCoverage.SampleNetworkQuality(coverage, p));
                var sorted = new List<double>(quality); sorted.Sort();
                int zero = quality.Count(q => q <= 0);
                telecom["homes"] = quality.Count;
                telecom["qualityP10"] = Math.Round(PointClusters.Percentile(sorted, 0.1), 3);
                telecom["qualityP50"] = Math.Round(PointClusters.Percentile(sorted, 0.5), 3);
                telecom["qualityP90"] = Math.Round(PointClusters.Percentile(sorted, 0.9), 3);
                telecom["zeroQualitySharePct"] = quality.Count == 0 ? 0 : Math.Round(100.0 * zero / quality.Count, 1);
                telecom["poorLevelConfirmed"] = false; // no poor-coverage threshold is read; the share is of homes at quality 0
            });

            // Bicycles: road edges (Game.Net.Edge with sub-lanes) whose pedestrian lane allows bicycles
            // (PedestrianLaneFlags.AllowBicycle). An edge with a car lane is a road with bicycle access;
            // an edge without one is a bicycle path. This is a flag read, not a verified bike-lane marking.
            var bicycles = new JObject(); result["bicycles"] = bicycles;
            Probe(errors, "bicycleEdges", () =>
            {
                double roadMetres = 0, pathMetres = 0; int edges = 0;
                using (var q = em.CreateEntityQuery(new EntityQueryDesc
                {
                    All = new[] { ComponentType.ReadOnly<Game.Net.Edge>(), ComponentType.ReadOnly<Game.Net.Curve>(), ComponentType.ReadOnly<Game.Net.SubLane>() },
                    None = new[] { ComponentType.ReadOnly<Deleted>(), ComponentType.ReadOnly<Temp>() }
                }))
                using (var es = q.ToEntityArray(Allocator.Temp))
                    foreach (var e in es)
                    {
                        var lanes = em.GetBuffer<Game.Net.SubLane>(e, true);
                        bool allowsBicycle = false, carLane = false;
                        for (int i = 0; i < lanes.Length; i++)
                        {
                            var lane = lanes[i].m_SubLane;
                            if (lane == Entity.Null || !em.Exists(lane)) continue;
                            if (em.HasComponent<Game.Net.PedestrianLane>(lane) && (em.GetComponentData<Game.Net.PedestrianLane>(lane).m_Flags & Game.Net.PedestrianLaneFlags.AllowBicycle) != 0) allowsBicycle = true;
                            if (em.HasComponent<Game.Net.CarLane>(lane)) carLane = true;
                        }
                        if (!allowsBicycle) continue;
                        edges++;
                        double length = em.GetComponentData<Game.Net.Curve>(e).m_Length;
                        if (carLane) roadMetres += length; else pathMetres += length;
                    }
                bicycles["edges"] = edges; bicycles["roadWithBicycleAccessMetres"] = Math.Round(roadMetres); bicycles["bicyclePathMetres"] = Math.Round(pathMetres);
                bicycles["laneFlagSource"] = "PedestrianLaneFlags.AllowBicycle on sub-lanes";
            });
            Probe(errors, "bicycleParking", () =>
            {
                int facilities = 0, spaces = 0;
                foreach (var e in NativeBuild.Buildings(em))
                    if (!em.HasComponent<PrefabData>(e) && em.HasComponent<Game.Buildings.BicycleParkingFacility>(e)) facilities++;
                using (var q = em.CreateEntityQuery(new EntityQueryDesc { All = new[] { ComponentType.ReadOnly<Game.Routes.BicycleParking>() }, None = new[] { ComponentType.ReadOnly<Deleted>(), ComponentType.ReadOnly<Temp>() } }))
                    spaces = q.CalculateEntityCount();
                bicycles["parkingBuildings"] = facilities; bicycles["parkingEntities"] = spaces; bicycles["parkingCapacityNotExposed"] = true;
            });
            Probe(errors, "bicycleCount", () =>
            {
                using (var q = em.CreateEntityQuery(new EntityQueryDesc { All = new[] { ComponentType.ReadOnly<Game.Vehicles.Bicycle>() }, None = new[] { ComponentType.ReadOnly<Deleted>(), ComponentType.ReadOnly<Temp>() } }))
                    bicycles["bicyclesPresent"] = q.CalculateEntityCount();
                bicycles["movingNotExposed"] = true; // the Bicycle component has no speed or state fields to tell moving from parked
            });

            // Extractor areas (farms, forestry, ore, oil, fishing): counts by resource, and how many still
            // hold their natural resource (Game.Areas.Extractor.m_ResourceAmount above zero).
            var extractors = new JObject(); result["extractors"] = extractors;
            Probe(errors, "extractors", () =>
            {
                var byResource = new SortedDictionary<string, (int n, int withResource)>(StringComparer.Ordinal);
                using (var q = em.CreateEntityQuery(new EntityQueryDesc { All = new[] { ComponentType.ReadOnly<Game.Areas.Extractor>(), ComponentType.ReadOnly<PrefabRef>() }, None = new[] { ComponentType.ReadOnly<Deleted>(), ComponentType.ReadOnly<Temp>() } }))
                using (var es = q.ToEntityArray(Allocator.Temp))
                    foreach (var e in es)
                    {
                        var prefab = em.GetComponentData<PrefabRef>(e).m_Prefab;
                        string key = em.HasComponent<ExtractorAreaData>(prefab) ? em.GetComponentData<ExtractorAreaData>(prefab).m_MapFeature.ToString() : "unknown";
                        bool left = em.GetComponentData<Game.Areas.Extractor>(e).m_ResourceAmount > 0;
                        byResource.TryGetValue(key, out var t); byResource[key] = (t.n + 1, t.withResource + (left ? 1 : 0));
                    }
                var byName = new JObject();
                foreach (var kv in byResource) byName[kv.Key] = new JObject { ["areas"] = kv.Value.n, ["withResourceLeft"] = kv.Value.withResource };
                extractors["byResource"] = byName;
                int facilities = 0;
                foreach (var e in NativeBuild.Buildings(em))
                    if (!em.HasComponent<PrefabData>(e) && em.HasComponent<Game.Buildings.ExtractorFacility>(e)) facilities++;
                extractors["facilityBuildings"] = facilities;
            });

            result["perfMs"] = Math.Round(clock.Elapsed.TotalMilliseconds, 1);
            if (errors.Count > 0) result["errors"] = errors;
            return result;
        }

        // Stats for one pollution value per home: average, percentiles, and the three worst clusters of
        // homes on a 250 m grid. The cluster level is the game's High UI level when it is read; otherwise
        // the 90th percentile, and the result says so (levelConfirmed false).
        private static void EnvironmentHomeStats(JObject o, List<float3> homes, List<double> values, int harmful)
        {
            o["homes"] = values.Count;
            if (values.Count == 0) return;
            var sorted = new List<double>(values); sorted.Sort();
            o["avg"] = Math.Round(values.Average(), 1);
            o["p50"] = Math.Round(PointClusters.Percentile(sorted, 0.5), 1);
            o["p90"] = Math.Round(PointClusters.Percentile(sorted, 0.9), 1);
            o["max"] = Math.Round(sorted[sorted.Count - 1], 1);
            bool confirmed = harmful > 0;
            double cut = confirmed ? harmful : PointClusters.Percentile(sorted, 0.9);
            var bad = new List<(double x, double z)>();
            for (int i = 0; i < values.Count; i++) if (values[i] > cut) bad.Add(((double)homes[i].x, (double)homes[i].z));
            o["levelConfirmed"] = confirmed;
            o["harmfulLevel"] = confirmed ? (JToken)harmful : JValue.CreateNull();
            if (confirmed) o["harmfulSharePct"] = Math.Round(100.0 * bad.Count / values.Count, 1);
            o["worst"] = new JArray(PointClusters.Densest(bad, 250, 3).Select(c => new JArray(Math.Round(c.x), Math.Round(c.z), c.n)));
        }
    }
}
