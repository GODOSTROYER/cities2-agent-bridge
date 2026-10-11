using System;
using System.Collections.Generic;
using System.Diagnostics;
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
