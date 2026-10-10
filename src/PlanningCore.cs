using System;
using System.Collections.Generic;
using System.Linq;

namespace CitiesIIAgentBridge
{
    // Pure planning geometry (no Unity/game types) so it can be unit-tested offline.
    // World units are metres on the x/z plane. Raster values: 0 free, 1 building lot,
    // 2 road, 3 outside owned land.
    internal sealed class OccupancyGrid
    {
        // Highway is a barrier (FAILURES #70, #83): a surface road may cross ordinary roads, never a
        // highway carriageway or ramp. Crossing one takes an explicit tunnel or bridge.
        public const byte Free = 0, Lot = 1, Road = 2, Outside = 3, Highway = 4;
        public readonly double MinX, MinZ, Cell;
        public readonly int W, H;
        public readonly byte[] Grid;

        public OccupancyGrid(double minX, double minZ, double maxX, double maxZ, double cell = 4)
        {
            if (cell <= 0 || maxX <= minX || maxZ <= minZ) throw new ArgumentException("invalid_grid_bounds");
            MinX = minX; MinZ = minZ; Cell = cell;
            W = (int)Math.Ceiling((maxX - minX) / cell); H = (int)Math.Ceiling((maxZ - minZ) / cell);
            if ((long)W * H > 16_000_000) throw new ArgumentException("grid_too_large");
            Grid = new byte[W * H];
        }

        public bool InBounds(int i, int j) => i >= 0 && j >= 0 && i < W && j < H;
        public byte this[int i, int j] { get => Grid[j * W + i]; set => Grid[j * W + i] = value; }
        public int I(double x) => (int)Math.Floor((x - MinX) / Cell);
        public int J(double z) => (int)Math.Floor((z - MinZ) / Cell);
        public double X(int i) => MinX + (i + 0.5) * Cell;
        public double Z(int j) => MinZ + (j + 0.5) * Cell;
        public byte At(double x, double z) { int i = I(x), j = J(z); return InBounds(i, j) ? this[i, j] : Outside; }

        // Marks cells whose centre lies inside the polygon (even-odd rule); keeps the max value.
        public void FillPolygon(IList<double> xs, IList<double> zs, byte value)
        {
            int n = xs.Count; if (n < 3) return;
            int i0 = Math.Max(0, I(xs.Min())), i1 = Math.Min(W - 1, I(xs.Max()));
            int j0 = Math.Max(0, J(zs.Min())), j1 = Math.Min(H - 1, J(zs.Max()));
            for (int j = j0; j <= j1; j++)
            {
                double pz = Z(j);
                for (int i = i0; i <= i1; i++)
                {
                    double px = X(i); bool inside = false;
                    for (int a = 0, b = n - 1; a < n; b = a++)
                        if ((zs[a] > pz) != (zs[b] > pz) && px < (xs[b] - xs[a]) * (pz - zs[a]) / (zs[b] - zs[a]) + xs[a]) inside = !inside;
                    if (inside && this[i, j] < value) this[i, j] = value;
                }
            }
        }

        // Marks a strip of +-halfWidth around a segment; keeps the max value. Roads (2) overwrite
        // lot fronts (1) on purpose, like the PowerShell raster did: a link must be able to leave a
        // road between lots whose rectangles reach the road edge.
        public void FillSegment(double ax, double az, double bx, double bz, double halfWidth, byte value)
        {
            double len = Math.Sqrt((bx - ax) * (bx - ax) + (bz - az) * (bz - az));
            int steps = Math.Max(1, (int)(len / (Cell / 2))); int r = (int)Math.Ceiling(halfWidth / Cell);
            for (int s = 0; s <= steps; s++)
            {
                int ci = I(ax + (bx - ax) * s / steps), cj = J(az + (bz - az) * s / steps);
                for (int i = ci - r; i <= ci + r; i++) for (int j = cj - r; j <= cj + r; j++)
                    if (InBounds(i, j) && this[i, j] < value) this[i, j] = value;
            }
        }

        // Any non-free cell (or the edge of the raster) inside the rectangle plus margin blocks it.
        public bool RectFree(double x0, double z0, double x1, double z1, double margin = 8)
        {
            int i0 = I(x0 - margin), i1 = I(x1 + margin), j0 = J(z0 - margin), j1 = J(z1 + margin);
            if (i0 < 0 || j0 < 0 || i1 >= W || j1 >= H) return false;
            for (int j = j0; j <= j1; j++) for (int i = i0; i <= i1; i++) if (Grid[j * W + i] != Free) return false;
            return true;
        }

        // Rotated lot test (Unity Y rotation, local +Z = lot front): any non-free cell blocks.
        // frontRoadOk: depth (m) at the lot front where road cells do not block, because the
        // frontage road's strip is rasterised a cell or two wider than the road itself.
        public bool BoxFree(double cx, double cz, double halfW, double halfD, double rotationDeg, double frontRoadOk = 0)
        {
            double r = rotationDeg * Math.PI / 180, cos = Math.Cos(r), sin = Math.Sin(r), step = Cell / 2;
            for (double u = -halfW; u <= halfW + 1e-6; u += step)
                for (double v = -halfD; v <= halfD + 1e-6; v += step)
                {
                    int i = I(cx + u * cos + v * sin), j = J(cz - u * sin + v * cos);
                    if (!InBounds(i, j)) return false;
                    byte cell = this[i, j]; if (cell == Free) continue;
                    if (cell == Road && v > halfD - frontRoadOk) continue;
                    return false;
                }
            return true;
        }

        // A link road may start on a road and cross roads; lots and unowned land block it.
        public bool SegmentFree(double ax, double az, double bx, double bz, double halfWidth = 6)
        {
            double len = Math.Sqrt((bx - ax) * (bx - ax) + (bz - az) * (bz - az));
            int steps = Math.Max(1, (int)(len / (Cell / 2))); int r = (int)Math.Ceiling(halfWidth / Cell);
            for (int s = 0; s <= steps; s++)
            {
                int ci = I(ax + (bx - ax) * s / steps), cj = J(az + (bz - az) * s / steps);
                for (int i = ci - r; i <= ci + r; i++) for (int j = cj - r; j <= cj + r; j++)
                {
                    if (!InBounds(i, j)) return false;
                    byte v = this[i, j]; if (v == Lot || v == Outside || v == Highway) return false;
                }
            }
            return true;
        }
    }

    internal struct RoadPoint { public double X, Z, T; public int Index, Version; }

    internal sealed class SiteCandidate
    {
        public double X, Z, W, D, Link; public double? ClearLink;
        public RoadPoint From; public double ToX, ToZ; public bool HasLink;
    }

    internal static class SiteSearch
    {
        // Free rectangles of w x d metres on a step grid inside [x0,x1]x[z0,z1], each with the
        // shortest road link (8..maxLink m) and, for the closest `keep`, a link that crosses no lot.
        public static List<SiteCandidate> Find(OccupancyGrid occ, double x0, double z0, double x1, double z1,
            double w, double d, double step, double margin, IList<RoadPoint> roads, double maxLink, int keep = 30)
        {
            var found = new List<SiteCandidate>();
            for (double x = x0; x + w <= x1; x += step)
                for (double z = z0; z + d <= z1; z += step)
                {
                    if (!occ.RectFree(x, z, x + w, z + d, margin)) continue;
                    double best = double.MaxValue;
                    foreach (var p in roads)
                    {
                        double dist = Dist(p.X, p.Z, Clamp(p.X, x, x + w), Clamp(p.Z, z, z + d));
                        if (dist >= 8 && dist <= maxLink && dist < best) best = dist;
                    }
                    if (best < double.MaxValue) found.Add(new SiteCandidate { X = x, Z = z, W = w, D = d, Link = Math.Round(best) });
                }
            var ranked = found.OrderBy(s => s.Link).Take(keep).ToList();
            foreach (var s in ranked)
            {
                foreach (var p in roads.Select(p => (p, tx: Clamp(p.X, s.X, s.X + w), tz: Clamp(p.Z, s.Z, s.Z + d)))
                    .Select(q => (q.p, q.tx, q.tz, dist: Dist(q.p.X, q.p.Z, q.tx, q.tz)))
                    .Where(q => q.dist >= 8 && q.dist <= maxLink).OrderBy(q => q.dist).Take(12))
                {
                    if (!occ.SegmentFree(p.p.X, p.p.Z, p.tx, p.tz, 6)) continue;
                    s.ClearLink = Math.Round(p.dist); s.From = p.p; s.ToX = p.tx; s.ToZ = p.tz; s.HasLink = true; break;
                }
            }
            return ranked.OrderBy(s => s.ClearLink.HasValue ? 0 : 1).ThenBy(s => s.Link).ToList();
        }

        public static double Clamp(double v, double lo, double hi) => v < lo ? lo : v > hi ? hi : v;
        public static double Dist(double ax, double az, double bx, double bz) => Math.Sqrt((ax - bx) * (ax - bx) + (az - bz) * (az - bz));
    }

    internal static class CorridorSearch
    {
        // A* over the raster at `stride` cells; lots and unowned land (dilated by halfWidth) block,
        // roads are passable. Returns line-of-sight simplified waypoints, or null when no path.
        public static List<double[]> Route(OccupancyGrid occ, double ax, double az, double bx, double bz, double halfWidth, int stride = 2, int maxExpanded = 400000)
        {
            int W = (occ.W + stride - 1) / stride, H = (occ.H + stride - 1) / stride; double cell = occ.Cell * stride;
            int r = (int)Math.Ceiling(halfWidth / occ.Cell);
            bool Blocked(int ci, int cj)
            {
                int i0 = ci * stride, j0 = cj * stride;
                // Existing road cells stay passable: the route may run along or across roads
                // even where lot fronts sit within halfWidth of them.
                for (int i = i0; i < i0 + stride; i++) for (int j = j0; j < j0 + stride; j++)
                    if (occ.InBounds(i, j) && occ[i, j] == OccupancyGrid.Road) return false;
                for (int i = i0 - r; i < i0 + stride + r; i++) for (int j = j0 - r; j < j0 + stride + r; j++)
                {
                    if (!occ.InBounds(i, j)) return true;
                    byte v = occ[i, j]; if (v == OccupancyGrid.Lot || v == OccupancyGrid.Outside || v == OccupancyGrid.Highway) return true;
                }
                return false;
            }
            int si = (int)((ax - occ.MinX) / cell), sj = (int)((az - occ.MinZ) / cell), ti = (int)((bx - occ.MinX) / cell), tj = (int)((bz - occ.MinZ) / cell);
            if (si < 0 || sj < 0 || ti < 0 || tj < 0 || si >= W || ti >= W || sj >= H || tj >= H) return null;
            if (si == ti && sj == tj) return new List<double[]> { new[] { ax, az }, new[] { bx, bz } };
            var g = new Dictionary<int, double>(); var parent = new Dictionary<int, int>(); var closed = new HashSet<int>();
            var open = new SortedSet<(double f, int id)>();
            int start = sj * W + si, goal = tj * W + ti; g[start] = 0; open.Add((H0(si, sj), start));
            double H0(int i, int j) => Math.Sqrt((i - ti) * (i - ti) + (j - tj) * (j - tj));
            int expanded = 0;
            while (open.Count > 0 && expanded++ < maxExpanded)
            {
                var cur = open.Min; open.Remove(cur); int id = cur.id;
                if (id == goal) break;
                if (!closed.Add(id)) continue;
                int ci = id % W, cj = id / W;
                for (int di = -1; di <= 1; di++) for (int dj = -1; dj <= 1; dj++)
                {
                    if (di == 0 && dj == 0) continue;
                    int ni = ci + di, nj = cj + dj; if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
                    int nid = nj * W + ni; if (closed.Contains(nid)) continue;
                    bool endpoint = nid == goal || nid == start;
                    if (!endpoint && Blocked(ni, nj)) continue;
                    double ng = g[id] + ((di != 0 && dj != 0) ? 1.41421356 : 1);
                    if (g.TryGetValue(nid, out var old) && old <= ng) continue;
                    if (g.ContainsKey(nid)) open.Remove((old + H0(ni, nj), nid));
                    g[nid] = ng; parent[nid] = id; open.Add((ng + H0(ni, nj), nid));
                }
            }
            if (!parent.ContainsKey(goal) && goal != start) return null;
            var path = new List<double[]>();
            for (int id = goal; ; id = parent[id])
            {
                path.Add(new[] { occ.MinX + (id % W + 0.5) * cell, occ.MinZ + (id / W + 0.5) * cell });
                if (id == start) break;
            }
            path.Reverse(); path[0] = new[] { ax, az }; path[path.Count - 1] = new[] { bx, bz };
            // String pulling: keep only waypoints needed for line of sight.
            // Line of sight uses the same passability as the search (roads passable, lots dilated).
            bool LineClear(double[] p, double[] q)
            {
                double len = SiteSearch.Dist(p[0], p[1], q[0], q[1]); int n = Math.Max(1, (int)(len / (occ.Cell / 2)));
                for (int k2 = 0; k2 <= n; k2++)
                {
                    int ci = (int)((p[0] + (q[0] - p[0]) * k2 / n - occ.MinX) / cell), cj = (int)((p[1] + (q[1] - p[1]) * k2 / n - occ.MinZ) / cell);
                    int id = cj * W + ci; if (id == start || id == goal) continue;
                    if (ci < 0 || cj < 0 || ci >= W || cj >= H || Blocked(ci, cj)) return false;
                }
                return true;
            }
            var simple = new List<double[]> { path[0] }; int k = 0;
            while (k < path.Count - 1)
            {
                int far = k + 1;
                for (int m = path.Count - 1; m > k + 1; m--)
                    if (LineClear(path[k], path[m])) { far = m; break; }
                simple.Add(path[far]); k = far;
            }
            return simple;
        }

        public static double Length(IList<double[]> pts)
        {
            double sum = 0; for (int i = 1; i < pts.Count; i++) sum += SiteSearch.Dist(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
            return sum;
        }
    }

    internal static class PointClusters
    {
        // Buckets points into square cells and returns the densest cells with their centroid.
        public static List<(double x, double z, int n)> Densest(IEnumerable<(double x, double z)> points, double cell, int top)
        {
            return points.GroupBy(p => ((long)Math.Floor(p.x / cell), (long)Math.Floor(p.z / cell)))
                .Select(g => (x: g.Average(p => p.x), z: g.Average(p => p.z), n: g.Count()))
                .OrderByDescending(c => c.n).Take(top).ToList();
        }

        public static double Percentile(IList<double> sorted, double p)
        {
            if (sorted.Count == 0) return 0;
            int idx = (int)Math.Round(p * (sorted.Count - 1)); return sorted[Math.Max(0, Math.Min(sorted.Count - 1, idx))];
        }
    }

    // Pure site rules (rule D): where homes must not go and where polluters must not go.
    // Thresholds come from the live city: homes showed the noise icon from a noise-map value of
    // about 6,000 and the air-pollution icon from about 5,200; clean streets read under 1,000.
    internal static class SiteRules
    {
        public const double NoiseMax = 4000, AirMax = 3000, GroundMax = 3000;
        public const double NoiseSourceClear = 250, PlumeLength = 700, PlumeCos = 0.82, PolluterHomeClear = 300;
        private static readonly System.Text.RegularExpressions.Regex AirName = new System.Text.RegularExpressions.Regex("PowerPlant|Coal|Gas|Landfill|Incinerat|Sewage|Oil|Ore|Industrial", System.Text.RegularExpressions.RegexOptions.Compiled);
        private static readonly System.Text.RegularExpressions.Regex NoiseName = new System.Text.RegularExpressions.Regex("WindTurbine|PowerPlant|Incinerat|Landfill|Airport|Harbor|TrainDepot|CargoTrain|TrainYard", System.Text.RegularExpressions.RegexOptions.Compiled);

        // The prefab's own PollutionData decides when it is known (live values: coal plant 30,000
        // air and noise, wind turbine 20,000 noise, sewage outlet 5,000 each, petrol station 0):
        // 5,000 or more is a source. Names are only the fallback for a prefab without data, and
        // "Gas" must not catch petrol stations.
        public const double SourceMin = 5000;
        public static bool IsAirSource(string prefab, bool industrial, double air = -1)
            => industrial || (air >= 0 ? air >= SourceMin : prefab != null && AirName.IsMatch(prefab) && prefab.IndexOf("WindTurbine", StringComparison.Ordinal) < 0 && prefab.IndexOf("GasStation", StringComparison.Ordinal) < 0);
        // Noise: only the loud ones (turbine 20,000, coal plant 30,000). A school or a fire house is
        // noisy too but belongs among homes, so the bar is 15,000, not 5,000.
        public const double NoiseSourceMin = 15000;
        public static bool IsNoiseSource(string prefab, double noise = -1) => noise >= 0 ? noise >= NoiseSourceMin : prefab != null && NoiseName.IsMatch(prefab);

        // True when the target lies in the plume the wind (wx, wz) blows from the source: within
        // `length` metres and inside a cone of about 35 degrees either side of the wind.
        public static bool Downwind(double sx, double sz, double wx, double wz, double tx, double tz, double length = PlumeLength)
        {
            double dx = tx - sx, dz = tz - sz, d = Math.Sqrt(dx * dx + dz * dz), wl = Math.Sqrt(wx * wx + wz * wz);
            if (d > length) return false;
            if (d < 60) return true;
            if (wl < 1e-4) return false;
            return (dx * wx + dz * wz) / (d * wl) >= PlumeCos;
        }

        // Why a residential site is refused, or null when it is acceptable.
        public static string ResidentialReject(double air, double ground, double noise, double toNoiseSource, bool downwindOfAirSource)
        {
            if (noise >= NoiseMax) return "noise";
            if (toNoiseSource < NoiseSourceClear) return "near_noise_source";
            if (air >= AirMax) return "air";
            if (ground >= GroundMax) return "ground";
            if (downwindOfAirSource) return "downwind";
            return null;
        }

        // A wind turbine claims far more room than its 24 m lot: the game refused a coal plant
        // whose lot edge was about 60 m from a turbine, and a turbine 90 m from the plant
        // (FAILURES #81). Centre-to-centre clearance used by the roadside finder.
        public const double TurbineClear = 190, TurbineToTurbine = 110;
        public static bool IsTurbine(string prefab) => prefab != null && prefab.IndexOf("WindTurbine", StringComparison.Ordinal) >= 0;
        public static string TurbineReject(bool placingTurbine, double toTurbine, double toLargeBuilding)
        {
            if (placingTurbine) return toTurbine < TurbineToTurbine ? "turbine_clearance" : toLargeBuilding < TurbineClear ? "turbine_clearance" : null;
            return toTurbine < TurbineClear ? "turbine_clearance" : null;
        }

        // Why a polluting or noisy building is refused at a site, or null.
        public static string PolluterReject(double toHomes, int homesDownwind, bool airSource)
        {
            if (toHomes < PolluterHomeClear) return "near_homes";
            if (airSource && homesDownwind > 0) return "homes_downwind";
            return null;
        }
    }
}
