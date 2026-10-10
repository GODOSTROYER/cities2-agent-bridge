using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using Game.Buildings;
using Game.Common;
using Game.Net;
using Game.Prefabs;
using Game.Tools;
using Game.Zones;
using Newtonsoft.Json.Linq;
using Unity.Collections;
using Unity.Entities;
using Unity.Mathematics;

namespace CitiesIIAgentBridge
{
    // One-request building blocks for the MCP server's native build path (no PowerShell,
    // no cell dumps over the mailbox): grid planning, zoning a whole area as one internal
    // batch, road connectivity and the service-building inventory.
    public sealed partial class Mod
    {
        private static double SegmentDistance(double px, double pz, float3 a, float3 b)
        {
            double dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz;
            double t = len2 > 0 ? Math.Max(0, Math.Min(1, ((px - a.x) * dx + (pz - a.z) * dz) / len2)) : 0;
            return SiteSearch.Dist(px, pz, a.x + t * dx, a.z + t * dz);
        }

        // plan_grid {x,z,cols,rows,blockWidth?,blockDepth?,road?,maxConnector?}: the road list for a
        // world-aligned grid (roads already lying on existing streets dropped), what blocks it, and
        // lot-free connector candidates. Read-only and non-pausing.
        private JObject PlanGrid(JObject args)
        {
            var w = RequireCity(); var em = w.EntityManager; var clock = Stopwatch.StartNew();
            double x0 = RequiredFloat(args, "x"), z0 = RequiredFloat(args, "z");
            int cols = RequiredInt(args, "cols"), rows = RequiredInt(args, "rows");
            if (cols < 1 || rows < 1 || cols > 8 || rows > 8) throw new ArgumentException("cols_and_rows_must_be_1_to_8");
            double bw = args["blockWidth"] == null ? 110 : RequiredFloat(args, "blockWidth"), bd = args["blockDepth"] == null ? 110 : RequiredFloat(args, "blockDepth");
            double maxConnector = args["maxConnector"] == null ? 400 : RequiredFloat(args, "maxConnector");
            string roadName = (string)args["road"] ?? "Small Road";
            var road = PrefabByName(w, roadName); if (road == Entity.Null) throw new ArgumentException("road_prefab_not_found: " + roadName);
            if (IsPrefabLocked(em, road)) throw new ArgumentException("road_prefab_locked: " + roadName);
            double x1 = x0 + cols * bw, z1 = z0 + rows * bd;
            var edges = RoadEdges(w); var owned = OwnedTiles(em);
            var occ = BuildOccupancy(w, owned, edges, x0 - maxConnector - 50, z0 - maxConnector - 50, x1 + maxConnector + 50, z1 + maxConnector + 50, out int lots);
            bool OnRoad(double px, double pz) => edges.Any(e => SegmentDistance(px, pz, e.Curve.a, e.Curve.d) <= 8);
            var roads = new JArray(); int shared = 0;
            void Add(double ax, double az, double bx, double bz)
            {
                if (OnRoad(ax, az) && OnRoad(bx, bz) && OnRoad((ax + bx) / 2, (az + bz) / 2)) { shared++; return; }
                roads.Add(new JArray(Math.Round(ax, 1), Math.Round(az, 1), Math.Round(bx, 1), Math.Round(bz, 1)));
            }
            for (int i = 0; i <= cols; i++) for (int j = 0; j < rows; j++) Add(x0 + i * bw, z0 + j * bd, x0 + i * bw, z0 + (j + 1) * bd);
            for (int j = 0; j <= rows; j++) for (int i = 0; i < cols; i++) Add(x0 + i * bw, z0 + j * bd, x0 + (i + 1) * bw, z0 + j * bd);
            // What sits inside the grid: lot cells or unowned land make it unbuildable.
            int lotCells = 0, outside = 0;
            for (int j = occ.J(z0 - 6); j <= occ.J(z1 + 6); j++) for (int i = occ.I(x0 - 6); i <= occ.I(x1 + 6); i++)
            {
                if (!occ.InBounds(i, j)) { outside++; continue; }
                byte v = occ[i, j]; if (v == OccupancyGrid.Lot) lotCells++; else if (v == OccupancyGrid.Outside) outside++;
            }
            var result = new JObject
            {
                ["road"] = new JObject { ["name"] = roadName, ["prefabIndex"] = road.Index, ["prefabVersion"] = road.Version },
                ["bounds"] = new JArray(x0, z0, x1, z1), ["roads"] = roads, ["shared"] = shared,
                ["blocked"] = lotCells > 0 || outside > 0, ["lotCells"] = lotCells, ["outsideCells"] = outside
            };
            if (shared == 0)
            {
                var gc = GridConnectors(new JObject { ["x0"] = x0, ["z0"] = z0, ["x1"] = x1, ["z1"] = z1, ["maxLength"] = maxConnector, ["top"] = 8 });
                result["connectors"] = gc["links"];
            }
            else result["connectors"] = new JArray(); // joins existing streets directly
            result["ms"] = Math.Round(clock.Elapsed.TotalMilliseconds);
            return result;
        }

        // zone_area {x0,z0,x1,z1,margin?,zone}: zones every Visible unzoned cell in the rectangle with
        // one block-attached rectangle per block, as one internal batch (poll get_batch).
        // zone_area_count: the same scan without changing anything.
        private JObject ZoneArea(JObject args, bool countOnly)
        {
            var w = RequireCity(); var em = w.EntityManager; var clock = Stopwatch.StartNew();
            double margin = args["margin"] == null ? 40 : RequiredFloat(args, "margin");
            double x0 = RequiredFloat(args, "x0") - margin, z0 = RequiredFloat(args, "z0") - margin, x1 = RequiredFloat(args, "x1") + margin, z1 = RequiredFloat(args, "z1") + margin;
            Entity zone = Entity.Null; string zoneName = (string)args["zone"];
            if (!countOnly)
            {
                RequireControl();
                zone = PrefabByName(w, zoneName ?? throw new ArgumentException("zone_required"));
                if (zone == Entity.Null || !em.HasComponent<ZoneData>(zone)) throw new ArgumentException("zone_prefab_not_found: " + zoneName);
                if (IsPrefabLocked(em, zone)) throw new ArgumentException("zone_prefab_locked: " + zoneName);
            }
            var steps = new JArray(); int zonable = 0, zoned = 0, blocks = 0;
            using (var q = em.CreateEntityQuery(new EntityQueryDesc { All = new[] { ComponentType.ReadOnly<Block>(), ComponentType.ReadOnly<Cell>() }, None = new[] { ComponentType.ReadOnly<Temp>(), ComponentType.ReadOnly<Deleted>() } }))
            using (var es = q.ToEntityArray(Allocator.Temp))
                foreach (var e in es)
                {
                    var block = em.GetComponentData<Block>(e);
                    if (block.m_Position.x < x0 - 100 || block.m_Position.x > x1 + 100 || block.m_Position.z < z0 - 100 || block.m_Position.z > z1 + 100) continue;
                    var cells = em.GetBuffer<Cell>(e, true); int minX = int.MaxValue, minY = int.MaxValue, maxX = -1, maxY = -1;
                    for (int y = 0; y < block.m_Size.y; y++) for (int x = 0; x < block.m_Size.x; x++)
                    {
                        var p = ZoneUtils.GetCellPosition(block, new int2(x, y));
                        if (p.x < x0 || p.x > x1 || p.z < z0 || p.z > z1) continue;
                        var cell = cells[y * block.m_Size.x + x];
                        if (cell.m_Zone.m_Index != 0) { zoned++; continue; }
                        if ((cell.m_State & CellFlags.Visible) == 0) continue;
                        zonable++; minX = Math.Min(minX, x); minY = Math.Min(minY, y); maxX = Math.Max(maxX, x); maxY = Math.Max(maxY, y);
                    }
                    if (maxX < 0) continue;
                    blocks++; if (countOnly) continue;
                    var a = ZoneUtils.GetCellPosition(block, new int2(minX, minY)); var b = ZoneUtils.GetCellPosition(block, new int2(maxX, maxY));
                    steps.Add(new JObject
                    {
                        ["command"] = "zone_rectangle",
                        ["args"] = new JObject
                        {
                            ["prefabIndex"] = zone.Index, ["prefabVersion"] = zone.Version,
                            ["start"] = new JObject { ["x"] = a.x, ["z"] = a.z, ["index"] = e.Index, ["version"] = e.Version },
                            ["end"] = new JObject { ["x"] = b.x, ["z"] = b.z }
                        }
                    });
                }
            var result = new JObject { ["zonable"] = zonable, ["zonedCells"] = zoned, ["blocks"] = blocks, ["ms"] = Math.Round(clock.Elapsed.TotalMilliseconds) };
            if (countOnly || steps.Count == 0) return result;
            var started = StartBatch(new JObject { ["steps"] = steps, ["internal"] = true, ["compact"] = true, ["continueOnBenign"] = true });
            result["batch"] = started["id"]; result["steps"] = steps.Count;
            return result;
        }

        // connected {a{x,z}, b{x,z}}: are the road nodes nearest to the two points joined by roads?
        private JObject RoadsConnected(JObject args)
        {
            var w = RequireCity(); var em = w.EntityManager; var clock = Stopwatch.StartNew();
            var pa = args["a"] as JObject ?? throw new ArgumentException("a_required"); var pb = args["b"] as JObject ?? throw new ArgumentException("b_required");
            var a = new float2(RequiredFloat(pa, "x"), RequiredFloat(pa, "z")); var b = new float2(RequiredFloat(pb, "x"), RequiredFloat(pb, "z"));
            var graph = new Dictionary<Entity, List<Entity>>(); var position = new Dictionary<Entity, float2>();
            foreach (var edge in RoadEdges(w))
            {
                var e = em.GetComponentData<Game.Net.Edge>(edge.Entity);
                if (!graph.TryGetValue(e.m_Start, out var l1)) graph[e.m_Start] = l1 = new List<Entity>();
                if (!graph.TryGetValue(e.m_End, out var l2)) graph[e.m_End] = l2 = new List<Entity>();
                l1.Add(e.m_End); l2.Add(e.m_Start);
                position[e.m_Start] = edge.Curve.a.xz; position[e.m_End] = edge.Curve.d.xz;
            }
            if (position.Count == 0) return new JObject { ["connected"] = false, ["reason"] = "no_roads" };
            Entity Nearest(float2 p, out float d) { Entity best = Entity.Null; d = float.MaxValue; foreach (var kv in position) { float x = math.distance(kv.Value, p); if (x < d) { d = x; best = kv.Key; } } return best; }
            var na = Nearest(a, out float da); var nb = Nearest(b, out float db);
            var seen = new HashSet<Entity> { na }; var queue = new Queue<Entity>(); queue.Enqueue(na); bool found = na == nb;
            while (queue.Count > 0 && !found)
            {
                var n = queue.Dequeue();
                foreach (var m in graph[n]) { if (!seen.Add(m)) continue; if (m == nb) { found = true; break; } queue.Enqueue(m); }
            }
            return new JObject { ["connected"] = found, ["nodeDistanceA"] = Math.Round(da, 1), ["nodeDistanceB"] = Math.Round(db, 1), ["reachable"] = seen.Count, ["ms"] = Math.Round(clock.Elapsed.TotalMilliseconds) };
        }

        // service_buildings: placed service buildings (prefab, position) plus home/industry centroids,
        // for the native services planner.
        private JObject ServiceBuildings()
        {
            var w = RequireCity(); var em = w.EntityManager; var ps = w.GetExistingSystemManaged<PrefabSystem>();
            var rows = new JArray(); double hx = 0, hz = 0, ix = 0, iz = 0; int homes = 0, industry = 0;
            foreach (var e in NativeBuild.Buildings(em))
            {
                if (!em.HasComponent<Game.Objects.Transform>(e) || !em.HasComponent<PrefabRef>(e) || em.HasComponent<PrefabData>(e)) continue;
                var p = em.GetComponentData<Game.Objects.Transform>(e).m_Position; var pe = em.GetComponentData<PrefabRef>(e).m_Prefab;
                if (em.HasComponent<ResidentialProperty>(e)) { homes++; hx += p.x; hz += p.z; }
                if (em.HasComponent<IndustrialProperty>(e)) { industry++; ix += p.x; iz += p.z; }
                if (em.HasComponent<ServiceObjectData>(pe) && rows.Count < 300) rows.Add(new JArray(ps.GetPrefabName(pe), Math.Round(p.x), Math.Round(p.z)));
            }
            return new JObject
            {
                ["services"] = rows,
                ["homes"] = new JObject { ["n"] = homes, ["x"] = homes == 0 ? 0 : Math.Round(hx / homes), ["z"] = homes == 0 ? 0 : Math.Round(hz / homes) },
                ["industry"] = new JObject { ["n"] = industry, ["x"] = industry == 0 ? 0 : Math.Round(ix / industry), ["z"] = industry == 0 ? 0 : Math.Round(iz / industry) }
            };
        }
    }
}
