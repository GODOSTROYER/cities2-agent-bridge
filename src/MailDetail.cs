using System;
using System.Collections.Generic;
using System.Linq;
using Game.Buildings;
using Game.Common;
using Game.Prefabs;
using Game.Simulation;
using Newtonsoft.Json.Linq;
using Unity.Collections;
using Unity.Entities;

namespace CitiesIIAgentBridge
{
    // Mail as the game holds it: per-building MailProducer totals (the same sum Headroom uses for
    // "waiting"), the post configuration limits, and every post office / sorting facility with its
    // stored mail against capacity. Read-only, main thread, never throws: each section has its own probe.
    // Units: mail is raw item counts (MailProducer fields are UInt16, Resources amounts are Int32);
    // capacities are raw Int32 values from the prefab data; vans and trucks are vehicle counts.
    public sealed partial class Mod
    {
        // Nearest-rank percentile of an ascending array (0 for an empty array).
        private static double MailNearestRank(int[] sorted, double p)
        {
            if (sorted.Length == 0) return 0;
            int idx = (int)Math.Ceiling(p * sorted.Length) - 1;
            if (idx < 0) idx = 0;
            if (idx >= sorted.Length) idx = sorted.Length - 1;
            return sorted[idx];
        }

        // Spread of per-building mail totals with counts against the game's thresholds.
        private static JObject MailSpread(List<int> values, int tolerance, int negligible)
        {
            var a = values.ToArray(); Array.Sort(a);
            long sum = 0; foreach (var v in a) sum += v;
            return new JObject
            {
                ["count"] = a.Length,
                ["min"] = a.Length == 0 ? 0 : a[0],
                ["median"] = MailNearestRank(a, 0.5),
                ["p90"] = MailNearestRank(a, 0.9),
                ["p99"] = MailNearestRank(a, 0.99),
                ["max"] = a.Length == 0 ? 0 : a[a.Length - 1],
                ["mean"] = a.Length == 0 ? 0 : Math.Round((double)sum / a.Length, 1),
                ["above5"] = a.Count(v => v > 5),
                ["above50"] = a.Count(v => v > 50),
                ["aboveTolerance"] = a.Count(v => v > tolerance),
                ["aboveNegligibleMail"] = a.Count(v => v > negligible),
            };
        }

        // mail_stats { x?, z?, radius? }: post configuration, per-building mail spread (optionally
        // inside a circle on the x/z plane), the ten worst buildings, and every post facility.
        private JObject MailStats(JObject args)
        {
            var w = RequireCity(); var em = w.EntityManager; var ps = w.GetExistingSystemManaged<PrefabSystem>();
            var errors = new JArray();
            var configObj = new JObject(); var buildingsObj = new JObject(); var worstArr = new JArray(); var facilitiesArr = new JArray();
            var result = new JObject
            {
                ["config"] = configObj,
                ["units"] = "mail: raw item counts (MailProducer UInt16 per building, Resources amounts Int32); capacities: raw prefab Int32; vans/trucks: vehicle counts; positions: world x/z in metres; mailTotal = m_SendingMail + m_ReceivingMail, as Headroom sums it",
                ["buildings"] = buildingsObj,
                ["worst"] = worstArr,
                ["facilities"] = facilitiesArr,
                ["errors"] = errors,
            };

            double? rx = (double?)args["x"], rz = (double?)args["z"], rr = (double?)args["radius"];
            bool circle = rx.HasValue && rz.HasValue && rr.HasValue && rr.Value >= 0;
            if (circle) configObj["filter"] = new JObject { ["x"] = rx.Value, ["z"] = rz.Value, ["radius"] = rr.Value };
            bool Inside(Game.Objects.Transform t) => !circle || ((t.m_Position.x - rx.Value) * (t.m_Position.x - rx.Value) + (t.m_Position.z - rz.Value) * (t.m_Position.z - rz.Value) <= rr.Value * rr.Value);

            // 1. Config: real field names of the singletons. Units are the game's own (mail items, metres, ratios).
            int tolerance = 50, negligible = 50; bool toleranceFound = false, negligibleFound = false;
            Probe(errors, "config", () =>
            {
                using (var q = em.CreateEntityQuery(ComponentType.ReadOnly<PostConfigurationData>()))
                    if (!q.IsEmptyIgnoreFilter)
                    {
                        var c = q.GetSingleton<PostConfigurationData>();
                        configObj["PostConfigurationData"] = new JObject
                        {
                            ["m_MaxMailAccumulation"] = c.m_MaxMailAccumulation,
                            ["m_MailAccumulationTolerance"] = c.m_MailAccumulationTolerance,
                            ["m_OutgoingMailPercentage"] = c.m_OutgoingMailPercentage,
                        };
                        tolerance = Math.Max(1, c.m_MailAccumulationTolerance); toleranceFound = true;
                    }
            });
            Probe(errors, "happiness", () =>
            {
                using (var q = em.CreateEntityQuery(ComponentType.ReadOnly<CitizenHappinessParameterData>()))
                    if (!q.IsEmptyIgnoreFilter)
                    {
                        var h = q.GetSingleton<CitizenHappinessParameterData>();
                        configObj["CitizenHappinessParameterData"] = new JObject { ["m_MailMultiplier"] = h.m_MailMultiplier, ["m_NegligibleMail"] = h.m_NegligibleMail };
                        negligible = Math.Max(0, h.m_NegligibleMail); negligibleFound = true;
                    }
            });
            Probe(errors, "efficiency", () =>
            {
                using (var q = em.CreateEntityQuery(ComponentType.ReadOnly<BuildingEfficiencyParameterData>()))
                    if (!q.IsEmptyIgnoreFilter)
                    {
                        var b = q.GetSingleton<BuildingEfficiencyParameterData>();
                        configObj["BuildingEfficiencyParameterData"] = new JObject { ["m_NegligibleMail"] = b.m_NegligibleMail, ["m_MailEfficiencyPenalty"] = b.m_MailEfficiencyPenalty };
                        if (!negligibleFound) negligible = Math.Max(0, b.m_NegligibleMail);
                    }
            });
            configObj["thresholdsUsed"] = new JObject
            {
                ["aboveTolerance"] = tolerance,
                ["aboveToleranceFromGame"] = toleranceFound,
                ["aboveNegligibleMail"] = negligible,
                ["aboveNegligibleMailFromGame"] = negligibleFound,
                ["note"] = "No separate notification-icon field was found; m_MailAccumulationTolerance is the level Headroom treats as waiting (icon / penalty level).",
            };

            // 2. Buildings: every MailProducer (same population Headroom reads), optional circle.
            var recs = new List<(Entity e, double x, double z, int mail, bool residential)>();
            Probe(errors, "buildings", () =>
            {
                foreach (var e in NativeBuild.Buildings(em))
                {
                    if (em.HasComponent<PrefabData>(e) || !em.HasComponent<MailProducer>(e) || !em.HasComponent<Game.Objects.Transform>(e)) continue;
                    var t = em.GetComponentData<Game.Objects.Transform>(e);
                    if (!Inside(t)) continue;
                    var mp = em.GetComponentData<MailProducer>(e);
                    // Residential = carries a HouseholdCitizen buffer (households live there); everything else is "other".
                    recs.Add((e, t.m_Position.x, t.m_Position.z, mp.m_SendingMail + mp.m_ReceivingMail, em.HasBuffer<Game.Citizens.HouseholdCitizen>(e)));
                }
            });
            Probe(errors, "statistics", () =>
            {
                var all = recs.Select(r => r.mail).ToList();
                var res = recs.Where(r => r.residential).Select(r => r.mail).ToList();
                var other = recs.Where(r => !r.residential).Select(r => r.mail).ToList();
                buildingsObj["count"] = recs.Count;
                buildingsObj["mail"] = MailSpread(all, tolerance, negligible);
                buildingsObj["residential"] = MailSpread(res, tolerance, negligible);
                buildingsObj["other"] = MailSpread(other, tolerance, negligible);
                buildingsObj["sumMail"] = (long)all.Sum(v => (long)v);
            });

            // 3. Worst: the ten buildings with the most mail.
            Probe(errors, "worst", () =>
            {
                foreach (var r in recs.OrderByDescending(r => r.mail).ThenBy(r => r.x).ThenBy(r => r.z).Take(10))
                {
                    string prefab = "?";
                    if (em.HasComponent<PrefabRef>(r.e)) prefab = ps.GetPrefabName(em.GetComponentData<PrefabRef>(r.e).m_Prefab) ?? "?";
                    worstArr.Add(new JObject { ["x"] = Math.Round(r.x, 1), ["z"] = Math.Round(r.z, 1), ["mail"] = r.mail, ["prefab"] = prefab, ["residential"] = r.residential });
                }
            });

            // 4. Facilities: every post office and sorting facility (PostFacility component), stored mail
            // from its Resources buffer against capacity from the prefab (summed over installed upgrades,
            // as Headroom does), and vans / trucks owned against those out on the road (not ParkedCar).
            Probe(errors, "facilities", () =>
            {
                foreach (var e in NativeBuild.Buildings(em))
                {
                    if (em.HasComponent<PrefabData>(e) || !em.HasComponent<Game.Buildings.PostFacility>(e) || !em.HasComponent<Game.Objects.Transform>(e)) continue;
                    var t = em.GetComponentData<Game.Objects.Transform>(e);
                    if (!Inside(t)) continue;
                    string prefab = "?"; int mailCap = 0, vanCap = 0, truckCap = 0, sortingRate = 0;
                    if (em.HasComponent<PrefabRef>(e)) prefab = ps.GetPrefabName(em.GetComponentData<PrefabRef>(e).m_Prefab) ?? "?";
                    foreach (var pe in PrefabAndUpgrades(em, e))
                        if (em.HasComponent<Game.Prefabs.PostFacilityData>(pe))
                        {
                            var d = em.GetComponentData<Game.Prefabs.PostFacilityData>(pe);
                            mailCap += d.m_MailCapacity; vanCap += d.m_PostVanCapacity; truckCap += d.m_PostTruckCapacity; sortingRate += d.m_SortingRate;
                        }
                    int unsorted = 0, local = 0, outgoing = 0;
                    if (em.HasBuffer<Game.Economy.Resources>(e))
                        foreach (var r in em.GetBuffer<Game.Economy.Resources>(e, true))
                        {
                            if (r.m_Resource == Game.Economy.Resource.UnsortedMail) unsorted += r.m_Amount;
                            else if (r.m_Resource == Game.Economy.Resource.LocalMail) local += r.m_Amount;
                            else if (r.m_Resource == Game.Economy.Resource.OutgoingMail) outgoing += r.m_Amount;
                        }
                    var pf = em.GetComponentData<Game.Buildings.PostFacility>(e);
                    var f = new JObject
                    {
                        ["prefab"] = prefab,
                        ["kind"] = sortingRate > 0 ? "sorting" : "post_office",
                        ["x"] = Math.Round(t.m_Position.x, 1), ["z"] = Math.Round(t.m_Position.z, 1),
                        ["storedMail"] = new JObject { ["total"] = unsorted + local + outgoing, ["unsorted"] = unsorted, ["local"] = local, ["outgoing"] = outgoing },
                        ["mailCapacity"] = mailCap,
                        ["sortingRate"] = sortingRate,
                        ["processingFactor"] = pf.m_ProcessingFactor,
                    };
                    // Vehicles: owned (OwnedVehicle buffer) against out on the road (no ParkedCar).
                    if (em.HasBuffer<Game.Vehicles.OwnedVehicle>(e))
                    {
                        int vansOwned = 0, vansOut = 0, trucksOwned = 0, trucksOut = 0;
                        foreach (var ov in em.GetBuffer<Game.Vehicles.OwnedVehicle>(e, true))
                        {
                            var v = ov.m_Vehicle;
                            if (v == Entity.Null || !em.Exists(v)) continue;
                            bool parked = em.HasComponent<Game.Vehicles.ParkedCar>(v);
                            if (em.HasComponent<Game.Vehicles.PostVan>(v)) { vansOwned++; if (!parked) vansOut++; }
                            else if (em.HasComponent<Game.Vehicles.DeliveryTruck>(v)) { trucksOwned++; if (!parked) trucksOut++; }
                        }
                        f["vans"] = new JObject { ["owned"] = vansOwned, ["out"] = vansOut, ["capacity"] = vanCap };
                        f["trucks"] = new JObject { ["owned"] = trucksOwned, ["out"] = trucksOut, ["capacity"] = truckCap };
                    }
                    else
                    {
                        f["vans"] = new JObject { ["capacity"] = vanCap, ["note"] = "no OwnedVehicle buffer" };
                        f["trucks"] = new JObject { ["capacity"] = truckCap, ["note"] = "no OwnedVehicle buffer" };
                    }
                    facilitiesArr.Add(f);
                }
            });

            return result;
        }
    }
}
