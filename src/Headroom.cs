using System;
using System.Collections.Generic;
using System.Diagnostics;
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
    // Capacity against use for every service (owner policy: services stay ahead of need;
    // FAILURES #96). Raw numbers only; the thresholds and the projection live in the MCP layer
    // (headroom.ts) where they are unit-tested.
    public sealed partial class Mod
    {
        // Prefab data of a building plus its installed upgrades (extensions add capacity).
        private static IEnumerable<Entity> PrefabAndUpgrades(EntityManager em, Entity building)
        {
            if (em.HasComponent<PrefabRef>(building)) yield return em.GetComponentData<PrefabRef>(building).m_Prefab;
            if (!em.HasBuffer<InstalledUpgrade>(building)) yield break;
            var upgrades = em.GetBuffer<InstalledUpgrade>(building, true);
            for (int i = 0; i < upgrades.Length; i++)
            {
                var u = upgrades[i].m_Upgrade;
                if (u != Entity.Null && em.Exists(u) && em.HasComponent<PrefabRef>(u)) yield return em.GetComponentData<PrefabRef>(u).m_Prefab;
            }
        }

        private JObject metricsCache; private uint metricsFrame;

        // get_metrics {refresh?}: every slow-moving city figure in ONE pass, cached for 3,000
        // simulation frames (these change over game hours, not ticks): service capacities and
        // people, citywide traffic flow with the five worst segments, the icon clusters, and the
        // names of the game's infoviews. perfMs is the cost of the last collection.
        private JObject GetMetrics(JObject args)
        {
            var w = RequireCity(); uint frame = w.GetExistingSystemManaged<SimulationSystem>()?.frameIndex ?? 0;
            if (metricsCache == null || (bool?)args["refresh"] == true || frame < metricsFrame || frame - metricsFrame > 3000)
            {
                var clock = Stopwatch.StartNew(); var em = w.EntityManager; var ps = w.GetExistingSystemManaged<PrefabSystem>();
                var m = new JObject { ["headroom"] = ServiceHeadroom(new JObject()) };
                try { var t = TrafficHotspots(new JObject { ["top"] = 5, ["minLength"] = 40 }); m["traffic"] = new JObject { ["cityFlow"] = t["cityFlow"], ["cityVolume"] = t["cityVolume"], ["meanFlowPct"] = t["meanFlowPct"], ["worst"] = t["hotspots"] }; } catch (Exception e) { m["trafficError"] = e.GetBaseException().Message; }
                try { m["iconClusters"] = Notifications(new JObject { ["top"] = 1 })["clusters"]; } catch (Exception e) { m["iconError"] = e.GetBaseException().Message; }
                try { m["outcomes"] = ServiceOutcomes(w); } catch (Exception e) { m["outcomeError"] = e.GetBaseException().Message; }
                var views = new List<string>();
                using (var q = em.CreateEntityQuery(ComponentType.ReadOnly<PrefabData>(), ComponentType.ReadOnly<InfoviewData>()))
                using (var es = q.ToEntityArray(Allocator.Temp))
                    foreach (var e in es) views.Add(ps.GetPrefabName(e) ?? "?");
                views.Sort(StringComparer.Ordinal); m["infoviews"] = new JArray(views);
                m["perfMs"] = Math.Round(clock.Elapsed.TotalMilliseconds, 1); m["frame"] = frame; m["citySession"] = citySession;
                metricsCache = m; metricsFrame = frame;
            }
            var result = (JObject)metricsCache.DeepClone(); result["ageFrames"] = frame - metricsFrame; return result;
        }

        // Outcome measures (FAILURES #99): what citizens actually get, read from the same
        // components the infoviews colour by. One pass over buildings, lanes, edges and companies.
        private JObject ServiceOutcomes(World w)
        {
            var em = w.EntityManager; var o = new JObject();
            // "Waiting" is judged against the game's own tolerances (the levels at which it starts
            // to penalise happiness or shows the icon), not against guessed numbers: mail reads in
            // the tens of thousands per building even when the service is fine (FAILURES #105).
            int mailLimit = 50, garbageLimit = 1000; float crimeLimit = 15000;
            using (var q = em.CreateEntityQuery(ComponentType.ReadOnly<PostConfigurationData>())) if (!q.IsEmptyIgnoreFilter) mailLimit = Math.Max(1, q.GetSingleton<PostConfigurationData>().m_MailAccumulationTolerance);
            using (var q = em.CreateEntityQuery(ComponentType.ReadOnly<GarbageParameterData>())) if (!q.IsEmptyIgnoreFilter) garbageLimit = Math.Max(1, q.GetSingleton<GarbageParameterData>().m_WarningGarbageLimit);
            using (var q = em.CreateEntityQuery(ComponentType.ReadOnly<PoliceConfigurationData>())) if (!q.IsEmptyIgnoreFilter) crimeLimit = Math.Max(1, q.GetSingleton<PoliceConfigurationData>().m_CrimeAccumulationTolerance);
            o["limits"] = new JObject { ["mail"] = mailLimit, ["garbage"] = garbageLimit, ["crime"] = Math.Round(crimeLimit) };
            long mail = 0, garbage = 0; int mailBuildings = 0, mailWaiting = 0, garbageBuildings = 0, garbagePiling = 0; double crimeSum = 0; int crimeBuildings = 0, crimeHigh = 0;
            var mailWhere = new List<(double x, double z)>(); var garbageWhere = new List<(double x, double z)>();
            foreach (var e in NativeBuild.Buildings(em))
            {
                if (em.HasComponent<PrefabData>(e) || !em.HasComponent<Game.Objects.Transform>(e)) continue;
                var pos = em.GetComponentData<Game.Objects.Transform>(e).m_Position;
                if (em.HasComponent<MailProducer>(e)) { var mp = em.GetComponentData<MailProducer>(e); int total = mp.m_SendingMail + mp.m_ReceivingMail; mail += total; mailBuildings++; if (total > mailLimit) { mailWaiting++; mailWhere.Add((pos.x, pos.z)); } }
                if (em.HasComponent<GarbageProducer>(e)) { int g = em.GetComponentData<GarbageProducer>(e).m_Garbage; garbage += g; garbageBuildings++; if (g > garbageLimit) { garbagePiling++; garbageWhere.Add((pos.x, pos.z)); } }
                if (em.HasComponent<CrimeProducer>(e)) { float c = em.GetComponentData<CrimeProducer>(e).m_Crime; crimeSum += c; crimeBuildings++; if (c > crimeLimit) crimeHigh++; }
            }
            JArray Worst(List<(double x, double z)> pts) => new JArray(PointClusters.Densest(pts, 400, 3).Select(c => new JArray(Math.Round(c.x), Math.Round(c.z), c.n)));
            o["post"] = new JObject { ["avgMail"] = mailBuildings == 0 ? 0 : Math.Round((double)mail / mailBuildings, 1), ["buildingsWaiting"] = mailWaiting, ["sharePct"] = mailBuildings == 0 ? 0 : Math.Round(100.0 * mailWaiting / mailBuildings, 1), ["worst"] = Worst(mailWhere) };
            o["garbage"] = new JObject { ["avg"] = garbageBuildings == 0 ? 0 : Math.Round((double)garbage / garbageBuildings), ["buildingsPiling"] = garbagePiling, ["sharePct"] = garbageBuildings == 0 ? 0 : Math.Round(100.0 * garbagePiling / garbageBuildings, 1), ["worst"] = Worst(garbageWhere) };
            o["crime"] = new JObject { ["avg"] = crimeBuildings == 0 ? 0 : Math.Round(crimeSum / crimeBuildings), ["highSharePct"] = crimeBuildings == 0 ? 0 : Math.Round(100.0 * crimeHigh / crimeBuildings, 1) };
            // Parking: garages (vehicles against capacity) and kerbside lanes with no free space left.
            int garageCars = 0, garageCap = 0, lanes = 0, lanesFull = 0;
            using (var q = em.CreateEntityQuery(new EntityQueryDesc { All = new[] { ComponentType.ReadOnly<Game.Net.GarageLane>() }, None = new[] { ComponentType.ReadOnly<Deleted>(), ComponentType.ReadOnly<Temp>() } }))
            using (var gs = q.ToComponentDataArray<Game.Net.GarageLane>(Allocator.Temp))
                foreach (var g in gs) { garageCars += g.m_VehicleCount; garageCap += g.m_VehicleCapacity; }
            using (var q = em.CreateEntityQuery(new EntityQueryDesc { All = new[] { ComponentType.ReadOnly<Game.Net.ParkingLane>() }, None = new[] { ComponentType.ReadOnly<Deleted>(), ComponentType.ReadOnly<Temp>() } }))
            using (var ps = q.ToComponentDataArray<Game.Net.ParkingLane>(Allocator.Temp))
                foreach (var l in ps) { if ((l.m_Flags & (Game.Net.ParkingLaneFlags.VirtualLane | Game.Net.ParkingLaneFlags.ParkingDisabled)) != 0) continue; lanes++; if (l.m_FreeSpace < 5f) lanesFull++; }
            int parked = 0; using (var q = em.CreateEntityQuery(new EntityQueryDesc { All = new[] { ComponentType.ReadOnly<Game.Vehicles.ParkedCar>() }, None = new[] { ComponentType.ReadOnly<Deleted>(), ComponentType.ReadOnly<Temp>() } })) parked = q.CalculateEntityCount();
            o["parking"] = new JObject { ["parkedCars"] = parked, ["kerbLanes"] = lanes, ["kerbLanesFullPct"] = lanes == 0 ? 0 : Math.Round(100.0 * lanesFull / lanes, 1), ["garageCars"] = garageCars, ["garageCapacity"] = garageCap };
            // Land value and road wear from the road edges.
            double land = 0, wear = 0; int landN = 0, wearN = 0, worn = 0;
            using (var q = em.CreateEntityQuery(new EntityQueryDesc { All = new[] { ComponentType.ReadOnly<Game.Net.Edge>(), ComponentType.ReadOnly<Game.Net.Road>() }, None = new[] { ComponentType.ReadOnly<Deleted>(), ComponentType.ReadOnly<Temp>() } }))
            using (var es = q.ToEntityArray(Allocator.Temp))
                foreach (var e in es)
                {
                    if (em.HasComponent<Game.Net.LandValue>(e)) { land += em.GetComponentData<Game.Net.LandValue>(e).m_LandValue; landN++; }
                    if (em.HasComponent<Game.Net.NetCondition>(e)) { var c = em.GetComponentData<Game.Net.NetCondition>(e).m_Wear; float x = Math.Max(c.x, c.y); wear += x; wearN++; if (x >= 5f) worn++; }
                }
            o["landValue"] = new JObject { ["avg"] = landN == 0 ? 0 : Math.Round(land / landN, 1) };
            o["roads"] = new JObject { ["avgWear"] = wearN == 0 ? 0 : Math.Round(wear / wearN, 2), ["wornSharePct"] = wearN == 0 ? 0 : Math.Round(100.0 * worn / wearN, 1) };
            // Company profitability (0-255 in the game, 127 = break even).
            double prof = 0; int profN = 0, losing = 0;
            using (var q = em.CreateEntityQuery(new EntityQueryDesc { All = new[] { ComponentType.ReadOnly<Game.Companies.Profitability>() }, None = new[] { ComponentType.ReadOnly<Deleted>(), ComponentType.ReadOnly<Temp>() } }))
            using (var ps = q.ToComponentDataArray<Game.Companies.Profitability>(Allocator.Temp))
                foreach (var p in ps) { prof += p.m_Profitability; profN++; if (p.m_Profitability < 100) losing++; }
            o["profitability"] = new JObject { ["avg"] = profN == 0 ? 0 : Math.Round(prof / profN), ["companies"] = profN, ["losingSharePct"] = profN == 0 ? 0 : Math.Round(100.0 * losing / profN, 1) };
            using (var q = em.CreateEntityQuery(ComponentType.ReadOnly<Game.City.Tourism>()))
                if (!q.IsEmptyIgnoreFilter) { var t = q.GetSingleton<Game.City.Tourism>(); o["tourism"] = new JObject { ["tourists"] = t.m_CurrentTourists, ["attractiveness"] = t.m_Attractiveness }; }
            return o;
        }

        private JObject ServiceHeadroom(JObject args)
        {
            var w = RequireCity(); var em = w.EntityManager; var clock = Stopwatch.StartNew();
            int[] schoolCap = new int[5], schoolStudents = new int[5], schools = new int[5];
            int patientCap = 0, patients = 0, ambulances = 0, clinics = 0;
            int bodyStorage = 0, bodiesStored = 0, hearses = 0, deathcare = 0;
            long garbageCap = 0; int garbageTrucks = 0, garbageSites = 0, garbageSpeed = 0;
            int fireEngines = 0, fireHouses = 0, patrolCars = 0, jail = 0, policeStations = 0;
            int postVans = 0, mailCap = 0, postOffices = 0, telecom = 0; double telecomCap = 0;
            foreach (var e in NativeBuild.Buildings(em))
            {
                if (em.HasComponent<PrefabData>(e) || em.HasComponent<Game.Objects.UnderConstruction>(e)) continue;
                bool school = false, hospital = false, death = false, garbage = false, fire = false, police = false, post = false, tele = false; int level = 0;
                foreach (var pe in PrefabAndUpgrades(em, e))
                {
                    if (em.HasComponent<SchoolData>(pe)) { var d = em.GetComponentData<SchoolData>(pe); level = Math.Max(level, Math.Min(4, (int)d.m_EducationLevel)); schoolCap[Math.Min(4, (int)d.m_EducationLevel)] += d.m_StudentCapacity; school = true; }
                    if (em.HasComponent<HospitalData>(pe)) { var d = em.GetComponentData<HospitalData>(pe); patientCap += d.m_PatientCapacity; ambulances += d.m_AmbulanceCapacity; hospital = true; }
                    if (em.HasComponent<DeathcareFacilityData>(pe)) { var d = em.GetComponentData<DeathcareFacilityData>(pe); bodyStorage += d.m_StorageCapacity; hearses += d.m_HearseCapacity; death = true; }
                    if (em.HasComponent<GarbageFacilityData>(pe)) { var d = em.GetComponentData<GarbageFacilityData>(pe); garbageCap += d.m_GarbageCapacity; garbageTrucks += d.m_VehicleCapacity; garbageSpeed += d.m_ProcessingSpeed; garbage = true; }
                    if (em.HasComponent<FireStationData>(pe)) { fireEngines += em.GetComponentData<FireStationData>(pe).m_FireEngineCapacity; fire = true; }
                    if (em.HasComponent<PoliceStationData>(pe)) { var d = em.GetComponentData<PoliceStationData>(pe); patrolCars += d.m_PatrolCarCapacity; jail += d.m_JailCapacity; police = true; }
                    if (em.HasComponent<PostFacilityData>(pe)) { var d = em.GetComponentData<PostFacilityData>(pe); postVans += d.m_PostVanCapacity; mailCap += d.m_MailCapacity; post = true; }
                    if (em.HasComponent<TelecomFacilityData>(pe)) { telecomCap += em.GetComponentData<TelecomFacilityData>(pe).m_NetworkCapacity; tele = true; }
                }
                if (school) { schools[level]++; if (em.HasBuffer<Game.Buildings.Student>(e)) schoolStudents[level] += em.GetBuffer<Game.Buildings.Student>(e, true).Length; }
                if (hospital) { clinics++; if (em.HasBuffer<Patient>(e)) patients += em.GetBuffer<Patient>(e, true).Length; }
                if (death) { deathcare++; if (em.HasComponent<Game.Buildings.DeathcareFacility>(e)) bodiesStored += em.GetComponentData<Game.Buildings.DeathcareFacility>(e).m_LongTermStoredCount; if (em.HasBuffer<Patient>(e)) bodiesStored += em.GetBuffer<Patient>(e, true).Length; }
                if (garbage) garbageSites++; if (fire) fireHouses++; if (police) policeStations++; if (post) postOffices++; if (tele) telecom++;
            }
            // People by age (residents only), for the eligible counts of each school level.
            int children = 0, teens = 0, adults = 0, elderly = 0;
            using (var q = em.CreateEntityQuery(new EntityQueryDesc { All = new[] { ComponentType.ReadOnly<Citizen>(), ComponentType.ReadOnly<HouseholdMember>() }, None = new[] { ComponentType.ReadOnly<Deleted>(), ComponentType.ReadOnly<Temp>() } }))
            using (var cs = q.ToComponentDataArray<Citizen>(Allocator.Temp))
                foreach (var c in cs)
                {
                    if ((c.m_State & (CitizenFlags.Tourist | CitizenFlags.Commuter)) != 0) continue;
                    switch (c.GetAge()) { case CitizenAge.Child: children++; break; case CitizenAge.Teen: teens++; break; case CitizenAge.Adult: adults++; break; default: elderly++; break; }
                }
            JObject Level(int i) => new JObject { ["students"] = schoolStudents[i], ["capacity"] = schoolCap[i], ["schools"] = schools[i] };
            return new JObject
            {
                ["people"] = new JObject { ["children"] = children, ["teens"] = teens, ["adults"] = adults, ["elderly"] = elderly },
                ["education"] = new JObject { ["elementary"] = Level(1), ["high"] = Level(2), ["college"] = Level(3), ["university"] = Level(4) },
                ["health"] = new JObject { ["patients"] = patients, ["capacity"] = patientCap, ["ambulances"] = ambulances, ["buildings"] = clinics },
                ["deathcare"] = new JObject { ["stored"] = bodiesStored, ["capacity"] = bodyStorage, ["hearses"] = hearses, ["buildings"] = deathcare },
                ["garbage"] = new JObject { ["capacity"] = garbageCap, ["trucks"] = garbageTrucks, ["processing"] = garbageSpeed, ["buildings"] = garbageSites },
                ["fire"] = new JObject { ["engines"] = fireEngines, ["buildings"] = fireHouses },
                ["police"] = new JObject { ["cars"] = patrolCars, ["jail"] = jail, ["buildings"] = policeStations },
                ["post"] = new JObject { ["vans"] = postVans, ["mailCapacity"] = mailCap, ["buildings"] = postOffices },
                ["telecom"] = new JObject { ["capacity"] = Math.Round(telecomCap), ["buildings"] = telecom },
                ["ms"] = Math.Round(clock.Elapsed.TotalMilliseconds), ["citySession"] = citySession
            };
        }
    }
}
