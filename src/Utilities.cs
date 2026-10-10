using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using Game.Buildings;
using Game.Common;
using Game.Net;
using Game.Prefabs;
using Game.Simulation;
using Game.Tools;
using Newtonsoft.Json.Linq;
using Unity.Collections;
using Unity.Entities;
using Unity.Mathematics;

namespace CitiesIIAgentBridge
{
    // Utility connection checks (FAILURES #71-#75). A district can be joined to the city by road
    // and still have no power, water or sewage: only edges that carry the utility count (most
    // roads do, highways and bare pipes/cables differ). The graph of those edges tells a
    // CONNECTION problem (the district is not in the city's main utility network) from a
    // CAPACITY problem (it is, but the city produces too little).
    public sealed partial class Mod
    {
        private Dictionary<string, int> shortageStreak;

        private sealed class UtilityGraph
        {
            public Dictionary<Entity, int> Component = new Dictionary<Entity, int>();
            public Dictionary<Entity, float2> Position = new Dictionary<Entity, float2>();
            public Dictionary<int, int> Size = new Dictionary<int, int>();
            public int Main = -1;

            public Entity Nearest(float2 p, double radius, out double distance)
            {
                Entity best = Entity.Null; distance = double.MaxValue;
                foreach (var kv in Position) { double d = math.distance(kv.Value, p); if (d < distance) { distance = d; best = kv.Key; } }
                if (distance > radius) best = Entity.Null;
                return best;
            }
        }

        // kind: "power" (edges with Game.Net.ElectricityConnection), "water" (WaterPipeConnection:
        // fresh water and sewage share the pipe edges), "road" (every road edge).
        private static UtilityGraph BuildUtilityGraph(EntityManager em, string kind)
        {
            var all = new List<ComponentType> { ComponentType.ReadOnly<Game.Net.Edge>(), ComponentType.ReadOnly<Game.Net.Curve>() };
            if (kind == "power") all.Add(ComponentType.ReadOnly<Game.Net.ElectricityConnection>());
            else if (kind == "water") all.Add(ComponentType.ReadOnly<Game.Net.WaterPipeConnection>());
            else all.Add(ComponentType.ReadOnly<Game.Net.Road>());
            var g = new UtilityGraph(); var parent = new Dictionary<Entity, Entity>();
            Entity Find(Entity x) { while (!parent[x].Equals(x)) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
            using (var q = em.CreateEntityQuery(new EntityQueryDesc { All = all.ToArray(), None = new[] { ComponentType.ReadOnly<Temp>(), ComponentType.ReadOnly<Deleted>() } }))
            using (var es = q.ToEntityArray(Allocator.Temp))
                foreach (var e in es)
                {
                    var edge = em.GetComponentData<Game.Net.Edge>(e); var curve = em.GetComponentData<Game.Net.Curve>(e).m_Bezier;
                    if (!parent.ContainsKey(edge.m_Start)) parent[edge.m_Start] = edge.m_Start;
                    if (!parent.ContainsKey(edge.m_End)) parent[edge.m_End] = edge.m_End;
                    g.Position[edge.m_Start] = curve.a.xz; g.Position[edge.m_End] = curve.d.xz;
                    var a = Find(edge.m_Start); var b = Find(edge.m_End); if (!a.Equals(b)) parent[a] = b;
                }
            var ids = new Dictionary<Entity, int>();
            foreach (var n in parent.Keys.ToList())
            {
                var root = Find(n); if (!ids.TryGetValue(root, out int id)) ids[root] = id = ids.Count;
                g.Component[n] = id; g.Size[id] = g.Size.TryGetValue(id, out int c) ? c + 1 : 1;
            }
            if (g.Size.Count > 0) g.Main = g.Size.OrderByDescending(p => p.Value).First().Key;
            return g;
        }

        private static JObject LinkOf(UtilityGraph g, float2 p, double radius)
        {
            var n = g.Nearest(p, radius, out double d);
            if (n == Entity.Null) return new JObject { ["linked"] = false, ["reason"] = g.Position.Count == 0 ? "no_network" : "no_node_within_radius", ["nearest"] = d == double.MaxValue ? null : (JToken)Math.Round(d) };
            int c = g.Component[n];
            return new JObject { ["linked"] = c == g.Main, ["nodes"] = g.Size[c], ["mainNodes"] = g.Main >= 0 ? g.Size[g.Main] : 0, ["nodeDistance"] = Math.Round(d) };
        }

        // utility_check {x, z, radius?}: is the place joined to the city's main power, water and
        // road networks, and do the buildings inside the radius actually receive the utilities?
        private JObject UtilityCheck(JObject args)
        {
            var w = RequireCity(); var em = w.EntityManager; var clock = Stopwatch.StartNew();
            var p = new float2(RequiredFloat(args, "x"), RequiredFloat(args, "z")); double radius = args["radius"] == null ? 200 : RequiredFloat(args, "radius");
            var power = LinkOf(BuildUtilityGraph(em, "power"), p, radius); var water = LinkOf(BuildUtilityGraph(em, "water"), p, radius); var road = LinkOf(BuildUtilityGraph(em, "road"), p, radius);
            int total = 0, noPower = 0, noWater = 0, noSewage = 0;
            foreach (var e in NativeBuild.Buildings(em))
            {
                if (!em.HasComponent<Game.Objects.Transform>(e) || em.HasComponent<PrefabData>(e)) continue;
                if (math.distance(em.GetComponentData<Game.Objects.Transform>(e).m_Position.xz, p) > radius) continue;
                total++;
                foreach (var row in Shortages(em, e)) { string t = (string)row["type"]; if (t == "electricity") noPower++; else if (t == "water") noWater++; else if (t == "sewage") noSewage++; }
            }
            bool linked = (bool)power["linked"] && (bool)water["linked"] && (bool)road["linked"]; int unserved = Math.Max(noPower, Math.Max(noWater, noSewage));
            return new JObject
            {
                ["verdict"] = UtilitySignals.Verdict(linked, total, unserved), ["power"] = power, ["water"] = water, ["road"] = road,
                ["buildings"] = new JObject { ["total"] = total, ["electricity"] = noPower, ["water"] = noWater, ["sewage"] = noSewage },
                ["ms"] = Math.Round(clock.Elapsed.TotalMilliseconds), ["citySession"] = citySession
            };
        }

        // network_ends {x, z, radius?}: every road, cable and pipe end near the point, with how
        // many edges meet there. A cable or pipe end where only one edge arrives is loose; a
        // road end like that is a dead end, and "island" marks a road that is not part of the
        // city's main road network at all.
        private JObject NetworkEnds(JObject args)
        {
            var w = RequireCity(); var em = w.EntityManager; var ps = w.GetExistingSystemManaged<PrefabSystem>(); var clock = Stopwatch.StartNew();
            var p = new float2(RequiredFloat(args, "x"), RequiredFloat(args, "z")); double radius = args["radius"] == null ? 30 : RequiredFloat(args, "radius");
            var roads = BuildUtilityGraph(em, "road"); var ends = new JArray(); var seen = new HashSet<Entity>(); int loose = 0;
            using (var q = em.CreateEntityQuery(new EntityQueryDesc { All = new[] { ComponentType.ReadOnly<Game.Net.Edge>(), ComponentType.ReadOnly<Game.Net.Curve>(), ComponentType.ReadOnly<PrefabRef>() }, None = new[] { ComponentType.ReadOnly<Temp>(), ComponentType.ReadOnly<Deleted>() } }))
            using (var es = q.ToEntityArray(Allocator.Temp))
                foreach (var e in es)
                {
                    var edge = em.GetComponentData<Game.Net.Edge>(e); var curve = em.GetComponentData<Game.Net.Curve>(e).m_Bezier;
                    bool road = em.HasComponent<Game.Net.Road>(e), power = em.HasComponent<Game.Net.ElectricityConnection>(e), pipe = em.HasComponent<Game.Net.WaterPipeConnection>(e);
                    if (!road && !power && !pipe) continue;
                    foreach (var end in new[] { (node: edge.m_Start, at: curve.a.xz), (node: edge.m_End, at: curve.d.xz) })
                    {
                        double d = math.distance(end.at, p); if (d > radius || !seen.Add(end.node)) continue;
                        int degree = em.HasBuffer<Game.Net.ConnectedEdge>(end.node) ? em.GetBuffer<Game.Net.ConnectedEdge>(end.node, true).Length : 0;
                        bool island = road && roads.Component.TryGetValue(end.node, out int c) && c != roads.Main;
                        bool isLoose = UtilitySignals.LooseEnd(road, degree, island); if (isLoose) loose++;
                        ends.Add(new JObject { ["kind"] = road ? "road" : power ? "power" : "pipe", ["prefab"] = ps.GetPrefabName(em.GetComponentData<PrefabRef>(e).m_Prefab), ["x"] = Math.Round(end.at.x), ["z"] = Math.Round(end.at.y), ["edges"] = degree, ["island"] = island, ["loose"] = isLoose, ["distance"] = Math.Round(d), ["node"] = NativeBuild.Id(end.node) });
                    }
                }
            return new JObject { ["ends"] = new JArray(ends.OrderBy(x => (double)x["distance"]).Take(12)), ["loose"] = loose, ["ms"] = Math.Round(clock.Elapsed.TotalMilliseconds), ["citySession"] = citySession };
        }

        // Snapshot part (rules A and B): a utility shortage is never "watch". From the second
        // snapshot in a row it is a very-high-priority need scored by the number of buildings
        // affected, with the cause (connection or capacity) and the place to connect.
        private void ApplyUtilityNeeds(World w, JObject s, Dictionary<string, List<float2>> points)
        {
            if (shortageStreak == null) shortageStreak = new Dictionary<string, int>();
            var needs = s["needs"] as JObject; if (needs == null) s["needs"] = needs = new JObject();
            var em = w.EntityManager; UtilityGraph powerGraph = null, waterGraph = null;
            foreach (string type in new[] { "electricity", "water", "sewage" })
            {
                int n = points != null && points.TryGetValue(type, out var list) ? list.Count : 0;
                int streak = n > 0 ? (shortageStreak.TryGetValue(type, out int before) ? before + 1 : 1) : 0;
                shortageStreak[type] = streak; if (n == 0) continue;
                string key = type == "electricity" ? "power" : type;
                var centre = PointClusters.Densest(points[type].Select(q => ((double)q.x, (double)q.y)), 400, 1)[0];
                UtilityGraph graph = key == "power" ? (powerGraph ?? (powerGraph = BuildUtilityGraph(em, "power"))) : (waterGraph ?? (waterGraph = BuildUtilityGraph(em, "water")));
                bool linked = (bool)LinkOf(graph, new float2((float)centre.x, (float)centre.z), 150)["linked"];
                double usePct = (double?)s["util"]?[key]?["pct"] ?? 0;
                var d = UtilitySignals.Need(n, streak, usePct, linked);
                var need = needs[key] as JObject; if (need == null) needs[key] = need = new JObject();
                need["unserved"] = n; need["cause"] = d.cause; need["at"] = new JArray(Math.Round(centre.x), Math.Round(centre.z)); need["inCluster"] = centre.n;
                need["score"] = d.score + "/" + ServiceSignals.Threshold; need["action"] = d.action; need["priority"] = "very_high";
                need["say"] = UtilitySignals.Say(key, d.cause, n, Math.Round(centre.x), Math.Round(centre.z));
            }
        }

        // Land use for the site rules (rule D): homes, air and noise sources, and the wind.
        private sealed class LandUse
        {
            public List<float2> Homes = new List<float2>(), Air = new List<float2>(), Noise = new List<float2>();
            public List<float2> Turbines = new List<float2>(), Large = new List<float2>();
            public List<float2> AirWind = new List<float2>();
            public NativeArray<Game.Simulation.Wind> WindMap;
            public float2 WindAt(float2 p) => WindMap.IsCreated ? WindSystem.GetWind(new float3(p.x, 0, p.y), WindMap).m_Wind : float2.zero;
            public bool DownwindOfAir(double x, double z)
            {
                for (int i = 0; i < Air.Count; i++) if (SiteRules.Downwind(Air[i].x, Air[i].y, AirWind[i].x, AirWind[i].y, x, z)) return true;
                return false;
            }
            public int HomesDownwind(double x, double z)
            {
                var wind = WindAt(new float2((float)x, (float)z)); int n = 0;
                foreach (var h in Homes) if (SiteRules.Downwind(x, z, wind.x, wind.y, h.x, h.y, SiteRules.PlumeLength + 200)) n++;
                return n;
            }
        }

        // (-1, -1) when the prefab carries no PollutionData.
        private static (double air, double noise) PrefabPollution(EntityManager em, Entity prefab)
        {
            if (prefab == Entity.Null || !em.HasComponent<PollutionData>(prefab)) return (-1, -1);
            var d = em.GetComponentData<PollutionData>(prefab); return (d.m_AirPollution, d.m_NoisePollution);
        }

        private static LandUse ReadLandUse(World w)
        {
            var em = w.EntityManager; var ps = w.GetExistingSystemManaged<PrefabSystem>(); var land = new LandUse();
            var wind = w.GetExistingSystemManaged<WindSystem>();
            if (wind != null) { land.WindMap = wind.GetMap(true, out var ready); ready.Complete(); }
            foreach (var e in NativeBuild.Buildings(em))
            {
                if (!em.HasComponent<Game.Objects.Transform>(e) || !em.HasComponent<PrefabRef>(e) || em.HasComponent<PrefabData>(e)) continue;
                var p = em.GetComponentData<Game.Objects.Transform>(e).m_Position.xz; var pe = em.GetComponentData<PrefabRef>(e).m_Prefab; string name = ps.GetPrefabName(pe) ?? "";
                if (em.HasComponent<ResidentialProperty>(e)) { land.Homes.Add(p); continue; }
                bool zoned = em.HasComponent<CommercialProperty>(e) || em.HasComponent<IndustrialProperty>(e) || em.HasComponent<OfficeProperty>(e);
                if (SiteRules.IsTurbine(name)) land.Turbines.Add(p);
                else if (!zoned && em.HasComponent<BuildingData>(pe)) { var lot = em.GetComponentData<BuildingData>(pe).m_LotSize; if (lot.x * lot.y >= 100) land.Large.Add(p); }
                var pol = PrefabPollution(em, pe);
                if (SiteRules.IsAirSource(name, em.HasComponent<IndustrialProperty>(e), pol.air)) { land.Air.Add(p); land.AirWind.Add(land.WindAt(p)); }
                if (!zoned && SiteRules.IsNoiseSource(name, pol.noise)) land.Noise.Add(p);
            }
            return land;
        }

        // pollution_sources {top?}: the buildings that pollute (prefab air, noise and ground
        // values), the wind at each, and how many homes sit in its plume or within its noise.
        private JObject PollutionSources(JObject args)
        {
            var w = RequireCity(); var em = w.EntityManager; var ps = w.GetExistingSystemManaged<PrefabSystem>(); var clock = Stopwatch.StartNew();
            int top = Math.Max(1, Math.Min(60, (int?)args["top"] ?? 20)); var land = ReadLandUse(w); var rows = new List<JObject>();
            var groups = new Dictionary<string, (int n, double x, double z)>();
            foreach (var e in NativeBuild.Buildings(em))
            {
                if (!em.HasComponent<Game.Objects.Transform>(e) || !em.HasComponent<PrefabRef>(e) || em.HasComponent<PrefabData>(e) || em.HasComponent<ResidentialProperty>(e)) continue;
                var pe = em.GetComponentData<PrefabRef>(e).m_Prefab; string name = ps.GetPrefabName(pe) ?? ""; var p = em.GetComponentData<Game.Objects.Transform>(e).m_Position.xz;
                bool industrial = em.HasComponent<IndustrialProperty>(e); var pp = PrefabPollution(em, pe); bool zonedHere = industrial || em.HasComponent<CommercialProperty>(e) || em.HasComponent<OfficeProperty>(e);
                bool air = SiteRules.IsAirSource(name, industrial, pp.air), noise = !zonedHere && SiteRules.IsNoiseSource(name, pp.noise);
                if (!air && !noise) continue;
                if (industrial) { groups.TryGetValue("industry", out var g); groups["industry"] = (g.n + 1, g.x + p.x, g.z + p.y); continue; }
                var wind = land.WindAt(p); var row = new JObject { ["prefab"] = name, ["id"] = NativeBuild.Id(e), ["x"] = Math.Round(p.x), ["z"] = Math.Round(p.y), ["wind"] = new JArray(Math.Round(wind.x, 2), Math.Round(wind.y, 2)) };
                if (em.HasComponent<PollutionData>(pe)) { var d = em.GetComponentData<PollutionData>(pe); row["air"] = Math.Round(d.m_AirPollution); row["noise"] = Math.Round(d.m_NoisePollution); row["ground"] = Math.Round(d.m_GroundPollution); }
                int inPlume = 0, inNoise = 0;
                foreach (var h in land.Homes)
                {
                    if (air && SiteRules.Downwind(p.x, p.y, wind.x, wind.y, h.x, h.y, SiteRules.PlumeLength + 200)) inPlume++;
                    if (noise && math.distance(h, p) < SiteRules.NoiseSourceClear) inNoise++;
                }
                row["homesDownwind"] = inPlume; row["homesInNoise"] = inNoise; rows.Add(row);
            }
            var result = new JObject { ["sources"] = new JArray(rows.OrderByDescending(r => (int)r["homesDownwind"] + (int)r["homesInNoise"]).Take(top)), ["count"] = rows.Count, ["homes"] = land.Homes.Count };
            if (groups.TryGetValue("industry", out var ind) && ind.n > 0)
            {
                var c = new float2((float)(ind.x / ind.n), (float)(ind.z / ind.n)); var wind = land.WindAt(c);
                result["industry"] = new JObject { ["buildings"] = ind.n, ["x"] = Math.Round(c.x), ["z"] = Math.Round(c.y), ["wind"] = new JArray(Math.Round(wind.x, 2), Math.Round(wind.y, 2)), ["homesDownwind"] = land.Homes.Count(h => SiteRules.Downwind(c.x, c.y, wind.x, wind.y, h.x, h.y, SiteRules.PlumeLength + 200)) };
            }
            result["rule"] = "wind is the (x,z) direction the air moves; homes within " + SiteRules.PlumeLength + " m inside that cone get the plume; homes within " + SiteRules.NoiseSourceClear + " m of a noise source get noise";
            result["ms"] = Math.Round(clock.Elapsed.TotalMilliseconds); result["citySession"] = citySession;
            return result;
        }
    }
}
