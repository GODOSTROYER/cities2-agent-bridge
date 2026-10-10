using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Text.RegularExpressions;
using Game.Buildings;
using Game.City;
using Game.Common;
using Game.Net;
using Game.Prefabs;
using Game.Simulation;
using Game.Tools;
using Game.Zones;
using Newtonsoft.Json.Linq;
using Unity.Collections;
using Unity.Entities;
using Unity.Mathematics;
using Colossal.Mathematics;

namespace CitiesIIAgentBridge
{
    // Phase 2 planning queries: the occupancy raster, site search, corridors, service coverage
    // and traffic are computed here from live ECS data in milliseconds, replacing the
    // PowerShell raster built from many paged get_city_map calls. Read-only; they pause the
    // game like every other analysis command so entity ids stay valid for the caller.
    public sealed partial class Mod
    {
        private static readonly Regex PolluterName = new Regex("Industrial|PowerPlant|Coal|Gas|Landfill|Incinerat|Sewage|Oil|Ore", RegexOptions.Compiled);

        private sealed class OwnedLand
        {
            public readonly List<double[]> Boxes = new List<double[]>(); // x0,z0,x1,z1
            public bool Contains(double x, double z) => Boxes.Any(b => x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3]);
        }

        private static OwnedLand OwnedTiles(EntityManager em)
        {
            var owned = new OwnedLand();
            using (var q = em.CreateEntityQuery(ComponentType.ReadOnly<Game.Areas.MapTile>()))
            using (var es = q.ToEntityArray(Allocator.Temp))
                foreach (var e in es)
                {
                    if (em.HasComponent<Native>(e) || !em.HasBuffer<Game.Areas.Node>(e)) continue;
                    var nodes = em.GetBuffer<Game.Areas.Node>(e, true); if (nodes.Length == 0) continue;
                    double x0 = double.MaxValue, z0 = double.MaxValue, x1 = double.MinValue, z1 = double.MinValue;
                    foreach (var n in nodes) { x0 = Math.Min(x0, n.m_Position.x); x1 = Math.Max(x1, n.m_Position.x); z0 = Math.Min(z0, n.m_Position.z); z1 = Math.Max(z1, n.m_Position.z); }
                    owned.Boxes.Add(new[] { x0, z0, x1, z1 });
                }
            return owned;
        }

        private struct EdgeInfo { public Entity Entity; public string Prefab; public Bezier4x3 Curve; public float HalfWidth; public bool Highway; }

        private static List<EdgeInfo> RoadEdges(World w)
        {
            var em = w.EntityManager; var ps = w.GetExistingSystemManaged<PrefabSystem>(); var rows = new List<EdgeInfo>();
            using (var q = em.CreateEntityQuery(new EntityQueryDesc { All = new[] { ComponentType.ReadOnly<Game.Net.Edge>(), ComponentType.ReadOnly<Curve>(), ComponentType.ReadOnly<Road>() }, None = new[] { ComponentType.ReadOnly<Temp>(), ComponentType.ReadOnly<Deleted>() } }))
            using (var es = q.ToEntityArray(Allocator.Temp))
                foreach (var e in es)
                {
                    var pe = em.GetComponentData<PrefabRef>(e).m_Prefab; string name = ps.GetPrefabName(pe) ?? "";
                    float half = em.HasComponent<NetGeometryData>(pe) ? em.GetComponentData<NetGeometryData>(pe).m_DefaultWidth * 0.5f : 8;
                    rows.Add(new EdgeInfo { Entity = e, Prefab = name, Curve = em.GetComponentData<Curve>(e).m_Bezier, HalfWidth = half, Highway = name.IndexOf("Highway", StringComparison.OrdinalIgnoreCase) >= 0 });
                }
            return rows;
        }

        private static float3 BezierAt(Bezier4x3 c, float t)
        {
            float u = 1 - t; return u * u * u * c.a + 3 * u * u * t * c.b + 3 * u * t * t * c.c + t * t * t * c.d;
        }

        // Raster of lots, roads and unowned land over the given bounds (4 m cells).
        private static OccupancyGrid BuildOccupancy(World w, OwnedLand owned, List<EdgeInfo> edges, double x0, double z0, double x1, double z1, out int lots)
        {
            var em = w.EntityManager; var occ = new OccupancyGrid(x0, z0, x1, z1, 4); lots = 0;
            for (int j = 0; j < occ.H; j++) for (int i = 0; i < occ.W; i++) if (!owned.Contains(occ.X(i), occ.Z(j))) occ[i, j] = OccupancyGrid.Outside;
            foreach (var e in NativeBuild.Buildings(em))
            {
                if (!em.HasComponent<Game.Objects.Transform>(e) || !em.HasComponent<PrefabRef>(e) || em.HasComponent<PrefabData>(e)) continue;
                var pe = em.GetComponentData<PrefabRef>(e).m_Prefab; if (!em.HasComponent<BuildingData>(pe)) continue;
                var t = em.GetComponentData<Game.Objects.Transform>(e); var half = (float2)em.GetComponentData<BuildingData>(pe).m_LotSize * 4;
                if (t.m_Position.x + 200 < x0 || t.m_Position.x - 200 > x1 || t.m_Position.z + 200 < z0 || t.m_Position.z - 200 > z1) continue;
                var xs = new double[4]; var zs = new double[4]; int k = 0;
                foreach (var p in new[] { new float3(-half.x, 0, -half.y), new float3(half.x, 0, -half.y), new float3(half.x, 0, half.y), new float3(-half.x, 0, half.y) })
                { var c = t.m_Position + math.mul(t.m_Rotation, p); xs[k] = c.x; zs[k] = c.z; k++; }
                occ.FillPolygon(xs, zs, OccupancyGrid.Lot); ++lots;
            }
            foreach (var edge in edges)
            {
                float3 prev = edge.Curve.a;
                for (int s = 1; s <= 8; s++) { var cur = BezierAt(edge.Curve, s / 8f); occ.FillSegment(prev.x, prev.z, cur.x, cur.z, edge.HalfWidth, OccupancyGrid.Road); prev = cur; }
            }
            return occ;
        }

        private static double MinDistance(List<float2> set, double x, double z)
        {
            double best = double.MaxValue; foreach (var p in set) { double d = math.distance(p, new float2((float)x, (float)z)); if (d < best) best = d; }
            return best == double.MaxValue ? 99999 : best;
        }

        // find_free_lots {width, depth, count?, zone?, x?, z?, radius?, step?, margin?, maxLink?}
        private JObject FindFreeLots(JObject args)
        {
            var w = RequireCity(); var em = w.EntityManager; var clock = Stopwatch.StartNew();
            double width = RequiredFloat(args, "width"), depth = RequiredFloat(args, "depth");
            if (width < 16 || depth < 16 || width > 1500 || depth > 1500) throw new ArgumentException("width_and_depth_must_be_16_to_1500");
            int count = Math.Max(1, Math.Min(20, (int?)args["count"] ?? 5));
            double step = args["step"] == null ? 40 : Math.Max(8, RequiredFloat(args, "step"));
            double margin = args["margin"] == null ? 8 : RequiredFloat(args, "margin");
            double maxLink = args["maxLink"] == null ? 400 : RequiredFloat(args, "maxLink");
            string zone = (string)args["zone"] ?? "res";
            var owned = OwnedTiles(em); if (owned.Boxes.Count == 0) throw new InvalidOperationException("no_owned_tiles");
            double x0 = owned.Boxes.Min(b => b[0]), z0 = owned.Boxes.Min(b => b[1]), x1 = owned.Boxes.Max(b => b[2]), z1 = owned.Boxes.Max(b => b[3]);
            if (args["x"] != null && args["radius"] != null)
            {
                double cx = RequiredFloat(args, "x"), cz = RequiredFloat(args, "z"), r = RequiredFloat(args, "radius");
                x0 = Math.Max(x0, cx - r); x1 = Math.Min(x1, cx + r); z0 = Math.Max(z0, cz - r); z1 = Math.Min(z1, cz + r);
                if (x1 <= x0 || z1 <= z0) throw new ArgumentException("search_area_outside_owned_land");
            }
            var edges = RoadEdges(w);
            var occ = BuildOccupancy(w, owned, edges, x0 - 450, z0 - 450, x1 + 450, z1 + 450, out int lots);
            var roads = new List<RoadPoint>();
            foreach (var e in edges.Where(e => !e.Highway))
                foreach (float t in new[] { 0f, 0.25f, 0.5f, 0.75f, 1f }) { var p = BezierAt(e.Curve, t); roads.Add(new RoadPoint { X = p.x, Z = p.z, T = t, Index = e.Entity.Index, Version = e.Entity.Version }); }
            var rasterMs = clock.Elapsed.TotalMilliseconds;
            // Wide pool: terrain/water rejects many of the closest candidates (17 of 20 were wet once).
            var sites = SiteSearch.Find(occ, x0, z0, x1, z1, width, depth, step, margin, roads, maxLink, 120);
            var finalists = sites.Take(Math.Max(count * 10, 80)).ToList();
            // Land use: pollution sources, jobs, homes and highways for scoring (same weights as play.ps1 Find-Sites).
            var ps = w.GetExistingSystemManaged<PrefabSystem>(); var polluters = new List<float2>(); var jobs = new List<float2>(); var homes = new List<float2>();
            foreach (var e in NativeBuild.Buildings(em))
            {
                if (!em.HasComponent<Game.Objects.Transform>(e) || !em.HasComponent<PrefabRef>(e) || em.HasComponent<PrefabData>(e)) continue;
                var p = em.GetComponentData<Game.Objects.Transform>(e).m_Position.xz; string name = ps.GetPrefabName(em.GetComponentData<PrefabRef>(e).m_Prefab) ?? "";
                if (em.HasComponent<ResidentialProperty>(e)) homes.Add(p);
                if (em.HasComponent<CommercialProperty>(e) || em.HasComponent<IndustrialProperty>(e) || em.HasComponent<OfficeProperty>(e)) jobs.Add(p);
                if (em.HasComponent<IndustrialProperty>(e) || PolluterName.IsMatch(name)) polluters.Add(p);
            }
            var highway = edges.Where(e => e.Highway).SelectMany(e => new[] { e.Curve.a.xz, e.Curve.d.xz }).ToList();
            var terrain = w.GetExistingSystemManaged<TerrainSystem>().GetHeightData();
            var water = w.GetExistingSystemManaged<WaterSystem>().GetSurfaceData(out var waterReady); waterReady.Complete();
            var air = w.GetExistingSystemManaged<AirPollutionSystem>().GetMap(true, out var airReady); airReady.Complete();
            var ground = w.GetExistingSystemManaged<GroundPollutionSystem>().GetMap(true, out var groundReady); groundReady.Complete();
            var noise = w.GetExistingSystemManaged<NoisePollutionSystem>().GetMap(true, out var noiseReady); noiseReady.Complete();
            bool waterOk = water.isCreated && water.hasDepths && water.resolution.x > 1;
            var rows = new List<JObject>(); int rejectedWet = 0, rejectedRelief = 0;
            foreach (var s in finalists)
            {
                double lo = double.MaxValue, hi = double.MinValue, pol = 0; int wet = 0;
                foreach (double fx in new[] { 0, 0.5, 1 }) foreach (double fz in new[] { 0, 0.5, 1 })
                {
                    var pos = new float3((float)(s.X + fx * width), 0, (float)(s.Z + fz * depth));
                    pos.y = TerrainUtils.SampleHeight(ref terrain, pos); lo = Math.Min(lo, pos.y); hi = Math.Max(hi, pos.y);
                    if (waterOk) { var sp = WaterUtils.ToSurfaceSpace(ref water, pos); if (sp.x >= 0 && sp.z >= 0 && sp.x < water.resolution.x && sp.z < water.resolution.z && WaterUtils.SampleDepth(ref water, pos) > 0.1f) wet++; }
                    pol = Math.Max(pol, Math.Max(AirPollutionSystem.GetPollution(pos, air).m_Pollution, Math.Max(GroundPollutionSystem.GetPollution(pos, ground).m_Pollution, NoisePollutionSystem.GetPollution(pos, noise).m_Pollution)));
                }
                double relief = hi - lo; if (wet > 0) { rejectedWet++; continue; } if (relief > 25) { rejectedRelief++; continue; }
                double cx = s.X + width / 2, cz = s.Z + depth / 2;
                double dInd = MinDistance(polluters, cx, cz), dJob = MinDistance(jobs, cx, cz), dHome = MinDistance(homes, cx, cz), dHwy = MinDistance(highway, cx, cz);
                double score = -s.Link / 10 - (s.ClearLink.HasValue ? 0 : 50);
                if (zone == "res" || zone == "resmed") score += -pol / 2 + Math.Min(dInd, 600) / 20 - (dHwy < 150 ? 25 : 0) - (dJob > 1200 ? (dJob - 1200) / 40 : 0);
                else if (zone == "com" || zone == "off") score += -(dHome > 500 ? (dHome - 500) / 20 : 0) - pol / 10;
                else if (zone == "ind") score += Math.Min(dHome, 600) / 15 - (dHwy > 400 ? (dHwy - 400) / 20 : 0);
                var row = new JObject
                {
                    ["x"] = Math.Round(s.X), ["z"] = Math.Round(s.Z), ["link"] = s.Link, ["clearLink"] = s.ClearLink, ["relief"] = Math.Round(relief, 1),
                    ["pollution"] = Math.Round(pol), ["toIndustry"] = Math.Round(dInd), ["toJobs"] = Math.Round(dJob), ["toHomes"] = Math.Round(dHome), ["toHighway"] = Math.Round(dHwy), ["score"] = Math.Round(score, 1)
                };
                if (s.HasLink) row["connector"] = new JObject { ["from"] = new JObject { ["x"] = Math.Round(s.From.X, 1), ["z"] = Math.Round(s.From.Z, 1), ["index"] = s.From.Index, ["version"] = s.From.Version, ["curvePosition"] = s.From.T }, ["to"] = new JObject { ["x"] = Math.Round(s.ToX, 1), ["z"] = Math.Round(s.ToZ, 1) } };
                rows.Add(row);
            }
            return new JObject
            {
                ["sites"] = new JArray(rows.OrderByDescending(r => (double)r["score"]).Take(count)), ["width"] = width, ["depth"] = depth,
                ["candidates"] = sites.Count, ["rejected"] = new JObject { ["wet"] = rejectedWet, ["relief"] = rejectedRelief }, ["lots"] = lots, ["roads"] = edges.Count, ["rasterMs"] = Math.Round(rasterMs), ["ms"] = Math.Round(clock.Elapsed.TotalMilliseconds),
                ["citySession"] = citySession, ["note"] = "x,z = min corner; geometric + terrain screen only; validate roads with plan/preview before building."
            };
        }

        // corridor {from{x,z}, to{x,z}, halfWidth?}: lot-free road route on owned land.
        private JObject FindCorridor(JObject args)
        {
            var w = RequireCity(); var clock = Stopwatch.StartNew();
            var from = args["from"] as JObject ?? throw new ArgumentException("from_required"); var to = args["to"] as JObject ?? throw new ArgumentException("to_required");
            double ax = RequiredFloat(from, "x"), az = RequiredFloat(from, "z"), bx = RequiredFloat(to, "x"), bz = RequiredFloat(to, "z");
            double half = args["halfWidth"] == null ? 8 : RequiredFloat(args, "halfWidth");
            if (SiteSearch.Dist(ax, az, bx, bz) > 4000) throw new ArgumentException("corridor_longer_than_4000_m");
            var owned = OwnedTiles(w.EntityManager); var edges = RoadEdges(w);
            var occ = BuildOccupancy(w, owned, edges, Math.Min(ax, bx) - 300, Math.Min(az, bz) - 300, Math.Max(ax, bx) + 300, Math.Max(az, bz) + 300, out _);
            bool straight = occ.SegmentFree(ax, az, bx, bz, half);
            var route = straight ? new List<double[]> { new[] { ax, az }, new[] { bx, bz } } : CorridorSearch.Route(occ, ax, az, bx, bz, half);
            var result = new JObject { ["straight"] = straight, ["found"] = route != null, ["ms"] = Math.Round(clock.Elapsed.TotalMilliseconds) };
            if (route != null)
            {
                result["waypoints"] = new JArray(route.Select(p => new JObject { ["x"] = Math.Round(p[0], 1), ["z"] = Math.Round(p[1], 1) }));
                result["length"] = Math.Round(CorridorSearch.Length(route)); result["segments"] = route.Count - 1;
            }
            result["note"] = "Avoids building lots and unowned land; may cross roads (intersections). Build each segment with build_road previewOnly first.";
            return result;
        }

        // grid_connectors {x0,z0,x1,z1, maxLength?, top?, halfWidth?}: shortest lot-free links from
        // existing (non-highway) roads to points around a planned grid's perimeter.
        private JObject GridConnectors(JObject args)
        {
            var w = RequireCity(); var clock = Stopwatch.StartNew();
            double x0 = RequiredFloat(args, "x0"), z0 = RequiredFloat(args, "z0"), x1 = RequiredFloat(args, "x1"), z1 = RequiredFloat(args, "z1");
            double maxLength = args["maxLength"] == null ? 400 : RequiredFloat(args, "maxLength"), half = args["halfWidth"] == null ? 6 : RequiredFloat(args, "halfWidth");
            int top = Math.Max(1, Math.Min(40, (int?)args["top"] ?? 12));
            if (x1 <= x0 || z1 <= z0 || x1 - x0 > 2000 || z1 - z0 > 2000) throw new ArgumentException("invalid_grid_rectangle");
            var owned = OwnedTiles(w.EntityManager); var edges = RoadEdges(w);
            var occ = BuildOccupancy(w, owned, edges, x0 - maxLength - 50, z0 - maxLength - 50, x1 + maxLength + 50, z1 + maxLength + 50, out int lots);
            var targets = new List<double[]>(); double sx = (x1 - x0) / Math.Max(1, Math.Round((x1 - x0) / 55)), sz = (z1 - z0) / Math.Max(1, Math.Round((z1 - z0) / 55));
            for (double gx = x0; gx <= x1 + 0.1; gx += sx) { targets.Add(new[] { gx, z0 }); targets.Add(new[] { gx, z1 }); }
            for (double gz = z0 + sz; gz < z1 - 0.1; gz += sz) { targets.Add(new[] { x0, gz }); targets.Add(new[] { x1, gz }); }
            var found = new List<(double d, JObject row)>(); int tested = 0;
            foreach (var e in edges.Where(e => !e.Highway))
                foreach (float t in new[] { 0f, 0.1f, 0.3f, 0.5f, 0.7f, 0.9f, 1f })
                {
                    var p = BezierAt(e.Curve, t);
                    // Skip road points inside the grid itself (shared edges are handled by the caller).
                    if (p.x > x0 + 4 && p.x < x1 - 4 && p.z > z0 + 4 && p.z < z1 - 4) continue;
                    foreach (var g in targets)
                    {
                        double d = SiteSearch.Dist(p.x, p.z, g[0], g[1]); if (d < 8 || d > maxLength) continue;
                        tested++; if (!occ.SegmentFree(p.x, p.z, g[0], g[1], half)) continue;
                        found.Add((d, new JObject { ["from"] = new JObject { ["x"] = Math.Round(p.x, 1), ["z"] = Math.Round(p.z, 1), ["index"] = e.Entity.Index, ["version"] = e.Entity.Version, ["t"] = t, ["endpoint"] = t == 0f || t == 1f }, ["to"] = new JObject { ["x"] = g[0], ["z"] = g[1] }, ["d"] = Math.Round(d, 1) }));
                    }
                }
            return new JObject { ["links"] = new JArray(found.OrderBy(f => f.d).Take(top).Select(f => f.row)), ["tested"] = tested, ["lots"] = lots, ["ms"] = Math.Round(clock.Elapsed.TotalMilliseconds) };
        }

        private static Entity PrefabByName(World w, string name)
        {
            var em = w.EntityManager; var ps = w.GetExistingSystemManaged<PrefabSystem>();
            using (var q = em.CreateEntityQuery(ComponentType.ReadOnly<PrefabData>()))
            using (var es = q.ToEntityArray(Allocator.Temp)) foreach (var e in es) if (ps.GetPrefabName(e) == name) return e;
            return Entity.Null;
        }

        // find_roadside_lots {prefab | width+depth, x, z, radius?, count?}: rotated lot positions
        // facing a road, clear of lots, roads and unowned land; pass them to place_building as candidates.
        private JObject FindRoadsideLots(JObject args)
        {
            var w = RequireCity(); var em = w.EntityManager; var clock = Stopwatch.StartNew();
            double hw, hd; string prefab = (string)args["prefab"];
            if (prefab != null)
            {
                var pe = PrefabByName(w, prefab); if (pe == Entity.Null || !em.HasComponent<BuildingData>(pe)) throw new ArgumentException("building_prefab_not_found: " + prefab);
                var lot = em.GetComponentData<BuildingData>(pe).m_LotSize; hw = lot.x * 4; hd = lot.y * 4;
            }
            else { hw = RequiredFloat(args, "width") / 2; hd = RequiredFloat(args, "depth") / 2; }
            double x = RequiredFloat(args, "x"), z = RequiredFloat(args, "z"), radius = args["radius"] == null ? 400 : RequiredFloat(args, "radius");
            int count = Math.Max(1, Math.Min(16, (int?)args["count"] ?? 16));
            if (radius < 16 || radius > 2000) throw new ArgumentException("radius_must_be_16_to_2000");
            var owned = OwnedTiles(em); var edges = RoadEdges(w);
            double pad = radius + hw + hd + 120;
            var occ = BuildOccupancy(w, owned, edges, x - pad, z - pad, x + pad, z + pad, out int lots);
            var found = new List<(double d, JObject row)>();
            foreach (var e in edges.Where(e => !e.Highway))
            {
                var a = e.Curve.a; var b = e.Curve.d; double len = math.distance(a.xz, b.xz);
                if (len < 2 * hw || math.distance(BezierAt(e.Curve, 0.5f).xz, new float2((float)x, (float)z)) > radius + len) continue;
                double tx = (b.x - a.x) / len, tz = (b.z - a.z) / len;
                for (double sAlong = hw + 4; sAlong <= len - hw - 4; sAlong += 8)
                    foreach (int side in new[] { -1, 1 })
                    {
                        double ox = -tz * side, oz = tx * side;
                        double cx = a.x + tx * sAlong + ox * (e.HalfWidth + 1 + hd), cz = a.z + tz * sAlong + oz * (e.HalfWidth + 1 + hd);
                        double d = SiteSearch.Dist(cx, cz, x, z); if (d > radius) continue;
                        double rot = Math.Atan2(-ox, -oz) * 180 / Math.PI;
                        if (!occ.BoxFree(cx, cz, hw, hd, rot)) continue;
                        found.Add((d, new JObject { ["position"] = new JObject { ["x"] = Math.Round(cx, 1), ["z"] = Math.Round(cz, 1) }, ["rotation"] = Math.Round(rot, 2), ["roadEdge"] = NativeBuild.Id(e.Entity) }));
                    }
            }
            return new JObject { ["candidates"] = new JArray(found.OrderBy(f => f.d).Take(count).Select(f => f.row)), ["found"] = found.Count, ["halfSize"] = new JArray(hw, hd), ["lots"] = lots, ["ms"] = Math.Round(clock.Elapsed.TotalMilliseconds) };
        }

        private static readonly string[] CoverageNames = Enum.GetNames(typeof(CoverageService));

        // coverage_gaps {service, threshold?, cell?, top?}: homes whose road edge has low native coverage.
        private JObject CoverageGaps(JObject args)
        {
            var w = RequireCity(); var em = w.EntityManager; var clock = Stopwatch.StartNew();
            string name = (string)args["service"] ?? throw new ArgumentException("service_required: " + string.Join(",", CoverageNames.Where(n => n != "Count")));
            if (!Enum.TryParse<CoverageService>(name, true, out var service) || service == CoverageService.Count) throw new ArgumentException("unknown_service: " + string.Join(",", CoverageNames.Where(n => n != "Count")));
            double threshold = args["threshold"] == null ? 0.05 : RequiredFloat(args, "threshold");
            double cell = args["cell"] == null ? 250 : Math.Max(50, RequiredFloat(args, "cell"));
            int top = Math.Max(1, Math.Min(10, (int?)args["top"] ?? 5)); int idx = (int)service;
            var values = new List<double>(); var gaps = new List<(double x, double z)>(); int noRoad = 0;
            foreach (var e in NativeBuild.Buildings(em))
            {
                if (!em.HasComponent<ResidentialProperty>(e) || !em.HasComponent<Game.Objects.Transform>(e)) continue;
                var b = em.GetComponentData<Building>(e); var pos = em.GetComponentData<Game.Objects.Transform>(e).m_Position;
                if (b.m_RoadEdge == Entity.Null || !em.HasBuffer<Game.Net.ServiceCoverage>(b.m_RoadEdge)) { noRoad++; continue; }
                var buffer = em.GetBuffer<Game.Net.ServiceCoverage>(b.m_RoadEdge, true); if (buffer.Length <= idx) { noRoad++; continue; }
                var c = buffer[idx].m_Coverage; double v = math.lerp(c.x, c.y, b.m_CurvePosition);
                values.Add(v); if (v < threshold) gaps.Add((pos.x, pos.z));
            }
            var ps = w.GetExistingSystemManaged<PrefabSystem>(); var facilities = new JArray();
            foreach (var e in NativeBuild.Buildings(em))
            {
                if (!em.HasComponent<PrefabRef>(e) || !em.HasComponent<Game.Objects.Transform>(e) || em.HasComponent<PrefabData>(e)) continue;
                var pe = em.GetComponentData<PrefabRef>(e).m_Prefab; if (!em.HasComponent<CoverageData>(pe) || em.GetComponentData<CoverageData>(pe).m_Service != service) continue;
                var p = em.GetComponentData<Game.Objects.Transform>(e).m_Position;
                if (facilities.Count < 12) facilities.Add(new JObject { ["prefab"] = ps.GetPrefabName(pe), ["x"] = Math.Round(p.x), ["z"] = Math.Round(p.z), ["range"] = em.GetComponentData<CoverageData>(pe).m_Range });
            }
            values.Sort();
            return new JObject
            {
                ["service"] = service.ToString(), ["homes"] = values.Count, ["noRoadData"] = noRoad, ["threshold"] = threshold,
                ["uncovered"] = gaps.Count, ["uncoveredPct"] = values.Count == 0 ? 0 : Math.Round(100.0 * gaps.Count / values.Count, 1),
                ["coverage"] = new JObject { ["p10"] = Math.Round(PointClusters.Percentile(values, 0.1), 3), ["p50"] = Math.Round(PointClusters.Percentile(values, 0.5), 3), ["p90"] = Math.Round(PointClusters.Percentile(values, 0.9), 3) },
                ["gapClusters"] = new JArray(PointClusters.Densest(gaps, cell, top).Select(g => new JObject { ["x"] = Math.Round(g.x), ["z"] = Math.Round(g.z), ["homes"] = g.n })),
                ["facilities"] = facilities, ["ms"] = Math.Round(clock.Elapsed.TotalMilliseconds),
                ["note"] = "Native per-edge coverage (Game.Net.ServiceCoverage) at each home's road position; place new facilities at the densest gap cluster."
            };
        }

        // traffic_hotspots {top?, minLength?}: road edges with the lowest native traffic flow speed.
        private JObject TrafficHotspots(JObject args)
        {
            var w = RequireCity(); var em = w.EntityManager; var clock = Stopwatch.StartNew();
            int top = Math.Max(1, Math.Min(30, (int?)args["top"] ?? 10)); double minLength = args["minLength"] == null ? 20 : RequiredFloat(args, "minLength");
            var rows = new List<JObject>(); double sum = 0; int n = 0;
            foreach (var edge in RoadEdges(w))
            {
                var road = em.GetComponentData<Road>(edge.Entity); var speed = NetUtils.GetTrafficFlowSpeed(road);
                double flow = (speed.x + speed.y + speed.z + speed.w) / 4; double length = em.GetComponentData<Curve>(edge.Entity).m_Length;
                sum += flow; n++;
                if (length < minLength) continue;
                var mid = BezierAt(edge.Curve, 0.5f);
                rows.Add(new JObject { ["index"] = edge.Entity.Index, ["version"] = edge.Entity.Version, ["prefab"] = edge.Prefab, ["x"] = Math.Round(mid.x), ["z"] = Math.Round(mid.z), ["length"] = Math.Round(length), ["flowPct"] = Math.Round(flow * 100) });
            }
            var tf = w.GetExistingSystemManaged<TrafficFlowSystem>();
            var result = new JObject
            {
                ["edges"] = n, ["meanFlowPct"] = n == 0 ? 0 : Math.Round(100 * sum / n),
                ["hotspots"] = new JArray(rows.OrderBy(r => (double)r["flowPct"]).ThenByDescending(r => (double)r["length"]).Take(top)),
                ["ms"] = Math.Round(clock.Elapsed.TotalMilliseconds), ["note"] = "flowPct = native traffic flow speed (100 = free flow); low values on arterials suggest upgrade_network or a parallel corridor."
            };
            Probe(new JArray(), "cityTraffic", () => { result["cityFlow"] = tf.cityAverageTrafficFlow; result["cityVolume"] = tf.cityAverageTrafficVolume; });
            return result;
        }

        // project {actions:[{prefab,count?} | {zone,cells}]}: construction, upkeep and income deltas vs current net.
        private JObject Project(JObject args)
        {
            var w = RequireCity(); var em = w.EntityManager; var ps = w.GetExistingSystemManaged<PrefabSystem>();
            var actions = args["actions"] as JArray ?? throw new ArgumentException("actions_required");
            var budget = w.GetExistingSystemManaged<CityServiceBudgetSystem>();
            long net = budget.GetBalance(), money = w.GetExistingSystemManaged<CitySystem>().moneyAmount;
            // Average monthly tax per occupied zone cell, by zone kind, from the live city.
            var cells = new Dictionary<string, int> { ["res"] = 0, ["com"] = 0, ["ind"] = 0, ["off"] = 0 };
            var zoneKind = new Dictionary<int, string>();
            using (var q = em.CreateEntityQuery(ComponentType.ReadOnly<ZoneData>(), ComponentType.ReadOnly<PrefabData>()))
            using (var es = q.ToEntityArray(Allocator.Temp))
                foreach (var e in es)
                {
                    var z = em.GetComponentData<ZoneData>(e);
                    string kind = z.m_AreaType == AreaType.Residential ? "res" : z.m_AreaType == AreaType.Commercial ? "com" : z.m_AreaType == AreaType.Industrial ? (z.IsOffice() ? "off" : "ind") : null;
                    if (kind != null) zoneKind[z.m_ZoneType.m_Index] = kind;
                }
            using (var q = em.CreateEntityQuery(new EntityQueryDesc { All = new[] { ComponentType.ReadOnly<Block>(), ComponentType.ReadOnly<Cell>() }, None = new[] { ComponentType.ReadOnly<Temp>(), ComponentType.ReadOnly<Deleted>() } }))
            using (var es = q.ToEntityArray(Allocator.Temp))
                foreach (var e in es)
                    foreach (var c in em.GetBuffer<Cell>(e, true))
                        if ((c.m_State & CellFlags.Occupied) != 0 && zoneKind.TryGetValue(c.m_Zone.m_Index, out var k)) cells[k]++;
            var tax = new Dictionary<string, long> { ["res"] = budget.GetIncome(IncomeSource.TaxResidential), ["com"] = budget.GetIncome(IncomeSource.TaxCommercial), ["ind"] = budget.GetIncome(IncomeSource.TaxIndustrial), ["off"] = budget.GetIncome(IncomeSource.TaxOffice) };
            var perCell = new JObject(); foreach (var k in cells.Keys) perCell[k] = cells[k] == 0 ? 0 : Math.Round((double)tax[k] / cells[k], 1);
            long construction = 0, upkeep = 0; double income = 0; var rows = new JArray();
            foreach (JObject a in actions.Take(20))
            {
                if (a["prefab"] != null)
                {
                    string name = (string)a["prefab"]; int count = Math.Max(1, (int?)a["count"] ?? 1); Entity pe = Entity.Null;
                    using (var q = em.CreateEntityQuery(ComponentType.ReadOnly<PrefabData>()))
                    using (var es = q.ToEntityArray(Allocator.Temp)) foreach (var e in es) if (ps.GetPrefabName(e) == name) { pe = e; break; }
                    if (pe == Entity.Null) { rows.Add(new JObject { ["prefab"] = name, ["error"] = "prefab_not_found" }); continue; }
                    var costs = PrefabCosts(em, pe); long c = ((long?)costs["construction"] ?? 0) * count; long u = ((long?)costs["monthlyUpkeep"] ?? (long?)costs["consumptionUpkeep"] ?? 0) * count;
                    construction += c; upkeep += u; rows.Add(new JObject { ["prefab"] = name, ["count"] = count, ["construction"] = c, ["monthlyUpkeep"] = u });
                }
                else if (a["zone"] != null)
                {
                    string k = (string)a["zone"] == "resmed" ? "res" : (string)a["zone"]; int n = (int?)a["cells"] ?? 0;
                    if (!perCell.ContainsKey(k)) { rows.Add(new JObject { ["zone"] = k, ["error"] = "zone_must_be_res_resmed_com_ind_off" }); continue; }
                    double m = (double)perCell[k] * n * ((string)a["zone"] == "resmed" ? 2 : 1); income += m;
                    rows.Add(new JObject { ["zone"] = (string)a["zone"], ["cells"] = n, ["monthlyIncomeWhenBuilt"] = Math.Round(m) });
                }
            }
            return new JObject
            {
                ["now"] = new JObject { ["net"] = net, ["money"] = money }, ["actions"] = rows, ["construction"] = construction, ["monthlyUpkeep"] = upkeep,
                ["monthlyIncomeWhenBuilt"] = Math.Round(income), ["projectedNet"] = Math.Round(net - upkeep + income), ["moneyAfterBuild"] = money - construction,
                ["taxPerOccupiedCell"] = perCell, ["occupiedCells"] = JObject.FromObject(cells),
                ["basis"] = "Zone income = current tax per occupied cell of that kind (medium residential x2) once the cells fill; upkeep from prefab ServiceUpkeepData/ConsumptionData; roads and tile upkeep not included."
            };
        }
    }
}
