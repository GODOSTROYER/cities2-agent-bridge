using System;
using System.Collections.Generic;
using System.Linq;
using CitiesIIAgentBridge;

// Offline tests for src/PlanningCore.cs (pure C#, no game types).
// Known-bug checks print "KNOWN BUG" instead of throwing so the suite stays green while the defect stays visible.
internal static class PlanningTests
{
    internal static int Run()
    {
        int count = 0;
        void Check(bool ok, string label) { if (!ok) throw new Exception("FAIL: " + label); ++count; Console.WriteLine("PASS: " + label); }
        void KnownBug(bool ok, string label) { Console.WriteLine((ok ? "XPASS (known bug appears fixed): " : "KNOWN BUG: ") + label); }

        // ---- OccupancyGrid: construction and fills ----
        var empty = new OccupancyGrid(0, 0, 100, 100, 4);
        Check(empty.W == 25 && empty.H == 25 && empty.Grid.Length == 625, "grid 0..100 at cell 4 is 25x25");
        bool degenerate = false; try { new OccupancyGrid(10, 0, 10, 100, 4); } catch (ArgumentException) { degenerate = true; }
        Check(degenerate, "zero-width grid bounds rejected");

        var square = new double[] { 40, 60, 60, 40 };
        var squareZ = new double[] { 40, 40, 60, 60 };
        var axis = new OccupancyGrid(0, 0, 100, 100, 4);
        axis.FillPolygon(square, squareZ, OccupancyGrid.Lot);
        Check(axis.At(50, 50) == OccupancyGrid.Lot, "axis-aligned square marks centre cell as Lot");
        Check(axis.At(10, 10) == OccupancyGrid.Free, "axis-aligned square leaves distant cell Free");

        // Diamond centred on (50,50) with half-diagonal 15 m: inside iff |dx|+|dz| <= 15.
        var diamond = new OccupancyGrid(0, 0, 100, 100, 4);
        diamond.FillPolygon(new double[] { 50, 65, 50, 35 }, new double[] { 35, 50, 65, 50 }, OccupancyGrid.Lot);
        Check(diamond.At(50, 50) == OccupancyGrid.Lot, "45-degree square marks centre cell as Lot");
        Check(diamond.At(46, 46) == OccupancyGrid.Lot && diamond.At(50, 38) == OccupancyGrid.Lot, "45-degree square marks interior cells");
        Check(diamond.At(34, 34) == OccupancyGrid.Free && diamond.At(50, 34) == OccupancyGrid.Free && diamond.At(66, 66) == OccupancyGrid.Free,
            "45-degree square leaves bounding-box corners and outside cells Free");

        // FillSegment: a 12 m wide strip along z=50 (cells with centres z 42..58 are marked).
        var strip = new OccupancyGrid(0, 0, 100, 100, 4);
        strip.FillSegment(0, 50, 100, 50, 6, OccupancyGrid.Road);
        Check(strip.At(10, 50) == OccupancyGrid.Road && strip.At(90, 50) == OccupancyGrid.Road && strip.At(50, 46) == OccupancyGrid.Road,
            "segment marks cells along its line");
        Check(strip.At(50, 30) == OccupancyGrid.Free && strip.At(50, 70) == OccupancyGrid.Free,
            "segment does not mark cells far from its line");

        // Max rule: a value only ever increases (Free 0 < Lot 1 < Road 2 < Outside 3).
        var roadAfterLot = new OccupancyGrid(0, 0, 100, 100, 4);
        roadAfterLot.FillPolygon(square, squareZ, OccupancyGrid.Lot);
        roadAfterLot.FillSegment(0, 50, 100, 50, 6, OccupancyGrid.Road);
        Check(roadAfterLot.At(50, 50) == OccupancyGrid.Road, "max rule: Road (2) painted over Lot (1) replaces it");
        var lotAfterRoad = new OccupancyGrid(0, 0, 100, 100, 4);
        lotAfterRoad.FillSegment(0, 50, 100, 50, 6, OccupancyGrid.Road);
        lotAfterRoad.FillPolygon(square, squareZ, OccupancyGrid.Lot);
        Check(lotAfterRoad.At(50, 50) == OccupancyGrid.Road, "max rule: Lot (1) painted over Road (2) does not downgrade it");

        // ---- OccupancyGrid: RectFree ----
        var lots = new OccupancyGrid(0, 0, 100, 100, 4);
        lots.FillPolygon(square, squareZ, OccupancyGrid.Lot);
        Check(empty.RectFree(20, 20, 30, 30, 8), "RectFree true on empty area");
        Check(!lots.RectFree(40, 40, 60, 60, 0), "RectFree false when a lot is inside the rectangle");
        Check(lots.RectFree(20, 20, 30, 30, 8), "RectFree true when lot is outside the 8 m margin");
        Check(!lots.RectFree(20, 20, 30, 30, 12), "RectFree false when a lot is within the margin");
        Check(!empty.RectFree(0, 40, 20, 60, 8), "RectFree false when margin reaches the raster edge");

        // ---- OccupancyGrid: SegmentFree ----
        Check(!lots.SegmentFree(10, 50, 90, 50, 6), "SegmentFree false through a Lot");
        var roadOnly = new OccupancyGrid(0, 0, 100, 100, 4);
        roadOnly.FillSegment(0, 50, 100, 50, 6, OccupancyGrid.Road);
        Check(roadOnly.SegmentFree(10, 50, 90, 50, 6), "SegmentFree true across a Road strip");
        var outside = new OccupancyGrid(0, 0, 100, 100, 4);
        outside.FillPolygon(new double[] { 80, 100, 100, 80 }, new double[] { 0, 0, 100, 100 }, OccupancyGrid.Outside);
        Check(outside.At(95, 50) == OccupancyGrid.Outside, "outside polygon marks Outside cells");
        Check(!outside.SegmentFree(50, 50, 90, 50, 6), "SegmentFree false into an Outside cell");

        // ---- SiteSearch.Find ----
        // 400 m square, road along z=10 with a point every 20 m. Site rectangles 100x100, margin 8.
        var city = new OccupancyGrid(0, 0, 400, 400, 4);
        city.FillSegment(0, 10, 400, 10, 6, OccupancyGrid.Road);
        var roads = new List<RoadPoint>();
        for (int k = 0; k <= 20; k++) roads.Add(new RoadPoint { X = k * 20, Z = 10, T = k / 20.0, Index = k, Version = 1 });

        var sites = SiteSearch.Find(city, 0, 0, 400, 400, 100, 100, 20, 8, roads, 400);
        Check(sites.Count > 0, "site search returns candidates beside the road");
        var best = sites[0];
        Check(best.ClearLink != null, "best site has a clear link");
        Check(best.Link >= 8, "best site link is at least 8 m");
        Check(best.Z >= 16 || best.Z + best.D <= 4, "best site rectangle does not overlap the road strip");
        Check(best.Link == 30 && best.X == 20 && best.Z == 40, "best site is the nearest free rectangle at 30 m from the road");

        var walled = new OccupancyGrid(0, 0, 400, 400, 4);
        walled.FillSegment(0, 10, 400, 10, 6, OccupancyGrid.Road);
        walled.FillPolygon(new double[] { 20, 380, 380, 20 }, new double[] { 21, 21, 29, 29 }, OccupancyGrid.Lot);
        var walledSites = SiteSearch.Find(walled, 0, 0, 400, 400, 100, 100, 20, 8, roads, 400);
        var blockedSite = walledSites.FirstOrDefault(s => s.X == 20 && s.Z == 40);
        Check(blockedSite != null && blockedSite.ClearLink == null, "lot between road and site removes that site's clear link");

        Check(SiteSearch.Find(city, 0, 0, 400, 400, 100, 100, 20, 8, roads, 5).Count == 0, "maxLink below the 8 m minimum yields no sites");

        // ---- CorridorSearch.Route ----
        var open = new OccupancyGrid(0, 0, 400, 400, 4);
        var straight = CorridorSearch.Route(open, 50, 150, 350, 150, 4);
        Check(straight != null && straight.Count == 2, "empty grid route is start and end only");
        Check(straight != null && Math.Abs(CorridorSearch.Length(straight) - 300) <= 3, "empty grid route length matches straight distance within 1%");

        var wall = new OccupancyGrid(0, 0, 400, 400, 4);
        wall.FillSegment(200, 0, 200, 300, 4, OccupancyGrid.Lot);
        var detour = CorridorSearch.Route(wall, 50, 150, 350, 150, 4);
        Check(detour != null, "route detours around a wall that leaves a gap");
        if (detour != null)
        {
            bool allFree = true;
            for (int k = 1; k < detour.Count; k++)
                allFree &= wall.SegmentFree(detour[k - 1][0], detour[k - 1][1], detour[k][0], detour[k][1], 4);
            Check(allFree, "every detour segment is SegmentFree at halfWidth 4");
            Check(CorridorSearch.Length(detour) > 300, "detour is longer than the straight line");
        }

        var fullWall = new OccupancyGrid(0, 0, 400, 400, 4);
        fullWall.FillSegment(200, 0, 200, 400, 4, OccupancyGrid.Lot);
        Check(CorridorSearch.Route(fullWall, 50, 150, 350, 150, 4) == null, "full-height wall yields no route");

        // Start and goal in the same 8 m search cell: the route should still start at the requested start.
        var tiny = CorridorSearch.Route(open, 50, 150, 52, 150, 4);
        Check(tiny != null && tiny.Count == 2 && tiny[0][0] == 50, "start and goal in one search cell return [start, goal] (returns only [goal])");

        // ---- PointClusters ----
        var pts = new List<(double x, double z)>
        {
            (1, 1), (2, 2), (3, 3), (4, 4), (5, 5),     // cell (0,0): 5 points, centroid (3,3)
            (25, 25), (26, 26), (27, 27),               // cell (2,2): 3 points, centroid (26,26)
            (-5, 40)                                    // cell (-1,4): 1 point
        };
        var top = PointClusters.Densest(pts, 10, 2);
        Check(top.Count == 2, "Densest returns at most the requested number of cells");
        Check(top[0].n == 5 && top[1].n == 3, "Densest orders cells by point count, descending");
        Check(Math.Abs(top[0].x - 3) < 1e-9 && Math.Abs(top[0].z - 3) < 1e-9, "Densest reports the centroid of its cell");
        Check(PointClusters.Densest(pts, 10, 10).Count == 3, "Densest returns every occupied cell when top exceeds the cell count");

        var sorted = new List<double> { 1, 2, 3, 4, 5 };
        Check(PointClusters.Percentile(sorted, 0) == 1, "percentile 0 is the minimum");
        Check(PointClusters.Percentile(sorted, 0.5) == 3, "percentile 0.5 is the median");
        Check(PointClusters.Percentile(sorted, 1) == 5, "percentile 1 is the maximum");
        Check(PointClusters.Percentile(sorted, 2) == 5, "percentile above 1 clamps to the maximum");
        Check(PointClusters.Percentile(new List<double>(), 0.5) == 0, "percentile of an empty list is 0");

        // Rule D: site rules.
        Check(SiteRules.Downwind(0, 0, 1, 0, 400, 0), "a point 400 m straight downwind is in the plume");
        Check(!SiteRules.Downwind(0, 0, 1, 0, -400, 0), "a point upwind is not in the plume");
        Check(!SiteRules.Downwind(0, 0, 1, 0, 0, 400), "a point across the wind is not in the plume");
        Check(!SiteRules.Downwind(0, 0, 1, 0, 900, 0), "beyond the plume length is clear");
        Check(SiteRules.Downwind(0, 0, 1, 0, -30, 20), "right next to the source counts whatever the wind");
        Check(!SiteRules.Downwind(0, 0, 0, 0, 400, 0), "no wind, no plume beyond the source itself");
        Check(SiteRules.Downwind(-734, 808, 0.4, 0.9, -512, 1317), "the live case: homes north-north-east of the coal plant are in its plume");
        Check(SiteRules.ResidentialReject(0, 0, 8383, 900, false) == "noise", "homes are refused on the noise the turbines made on Pearl Street (8,383)");
        Check(SiteRules.ResidentialReject(0, 0, 200, 120, false) == "near_noise_source", "homes are refused within 250 m of a noise source even before the noise map shows it");
        Check(SiteRules.ResidentialReject(5247, 0, 200, 900, false) == "air", "homes are refused in polluted air (5,247 showed the icon)");
        Check(SiteRules.ResidentialReject(0, 7084, 200, 900, false) == "ground", "homes are refused on polluted ground");
        Check(SiteRules.ResidentialReject(0, 0, 200, 900, true) == "downwind", "homes are refused downwind of a plant or industry");
        Check(SiteRules.ResidentialReject(700, 10, 700, 900, false) == null, "an ordinary clean street is accepted");
        Check(SiteRules.IsNoiseSource("WindTurbine01") && !SiteRules.IsAirSource("WindTurbine01", false), "a wind turbine is a noise source, not an air source");
        Check(SiteRules.IsAirSource("SmallCoalPowerPlant01", false) && SiteRules.IsNoiseSource("SmallCoalPowerPlant01"), "a coal plant is both");
        Check(SiteRules.IsAirSource("IndustrialManufacturing_x", true) && !SiteRules.IsAirSource("ElementarySchool01", false), "industry pollutes the air, a school does not");
        Check(!SiteRules.IsAirSource("NA_CommercialGasStation01_L2_4x6", false, 0) && !SiteRules.IsAirSource("NA_CommercialGasStation01_L2_4x6", false), "a petrol station is not an air source (prefab data 0; the name 'Gas' no longer matches)");
        Check(SiteRules.IsAirSource("SewageOutlet01", false, 5000) && SiteRules.IsNoiseSource("WindTurbine01", 20000) && !SiteRules.IsNoiseSource("NA_CommercialGasStation01", 240), "prefab pollution data decides when known: 5,000 or more is a source");
        Check(!SiteRules.IsNoiseSource("HighSchool01", 5000) && SiteRules.IsNoiseSource("SmallCoalPowerPlant01", 30000), "a moderately noisy service building (school) is not kept away from homes; the bar for noise is 15,000");
        Check(SiteRules.PolluterReject(120, 0, false) == "near_homes", "a noisy building is refused within 300 m of homes");
        Check(SiteRules.PolluterReject(500, 14, true) == "homes_downwind", "an air polluter is refused with homes in its plume");
        Check(SiteRules.PolluterReject(500, 14, false) == null && SiteRules.PolluterReject(500, 0, true) == null, "clear sites are accepted");

        Check(SiteRules.TurbineReject(false, 142, 9999) == "turbine_clearance", "the live case: a coal plant 142 m from a turbine is refused by the game, so the finder refuses it");
        Check(SiteRules.TurbineReject(false, 250, 9999) == null, "a building 250 m from the nearest turbine is fine");
        Check(SiteRules.TurbineReject(true, 119, 9999) == null && SiteRules.TurbineReject(true, 60, 9999) == "turbine_clearance", "turbines 119 m apart worked live; 60 m is refused");
        Check(SiteRules.TurbineReject(true, 9999, 90) == "turbine_clearance", "a turbine 90 m from a large building is refused (live: beside the coal plant)");
        Check(SiteRules.IsTurbine("WindTurbine01") && !SiteRules.IsTurbine("SmallCoalPowerPlant01") && !SiteRules.IsTurbine(null), "turbines are recognised by prefab name");

        var hw = new OccupancyGrid(0, 0, 400, 400, 4);
        hw.FillSegment(200, 0, 200, 400, 10, OccupancyGrid.Highway);
        hw.FillSegment(0, 300, 190, 300, 6, OccupancyGrid.Road);
        Check(!hw.SegmentFree(100, 100, 300, 100), "a link road may not cross a highway carriageway at grade");
        Check(hw.SegmentFree(20, 100, 20, 350), "a link road may still cross an ordinary road");
        Check(hw.SegmentFree(20, 100, 150, 100), "a link road on one side of the highway is free");

        Check(TrafficRules.FailureClass(80, 0.9, 200, false, 4) == "ok", "a busy road that flows is not a failure");
        Check(TrafficRules.FailureClass(2, 0.6, 30, false, 4) == "junction_spacing", "the live case: a 30 m segment between two junctions at 2% flow is a spacing failure");
        Check(TrafficRules.FailureClass(1, 0.8, 112, false, 4) == "junction_capacity", "the north junction: four arms, high volume, 1% flow is junction capacity");
        Check(TrafficRules.FailureClass(10, 0.7, 300, false, 2) == "link_capacity", "high volume on a long two-arm link is link capacity");
        Check(TrafficRules.FailureClass(5, 0.05, 150, false, 3) == "local_friction", "low volume with low flow is local friction, not a capacity failure");
        Check(TrafficRules.Delay(1000, 50) == 1000 && TrafficRules.Delay(1000, 100) == 0 && TrafficRules.Delay(100, 10) < TrafficRules.Delay(5000, 50), "delay: a busy corridor at half speed costs more than a quiet street at a tenth");
        Check(TrafficRules.FailureClass(2, 0.3, 140, true, 2) == "queue_from_the_street_it_feeds" && TrafficRules.FailureClass(2, 0.8, 140, true, 2) == "ramp_or_merge_capacity", "highway segments: a ramp queue comes from the street it feeds unless the ramp itself is at capacity");
        Check(TrafficRules.FixFor("junction_capacity").StartsWith("roundabout") && TrafficRules.FixFor("ok") == "none", "each class names its fix; widening is not among them");

        return count;
    }
}
