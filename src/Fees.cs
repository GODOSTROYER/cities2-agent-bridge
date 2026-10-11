using System;
using System.Linq;
using System.Reflection;
using Game.Buildings;
using Game.City;
using Game.Common;
using Game.Prefabs;
using Game.Simulation;
using Game.Tools;
using Newtonsoft.Json.Linq;
using Unity.Collections;
using Unity.Entities;

namespace CitiesIIAgentBridge
{
    // Fees as the game holds them: the city's service fees with the game's own estimate of income and
    // of the happiness effect, and every parking building with its places, use and fee. Raw numbers
    // only; the tuning rules live in the MCP layer (fees.ts) where they are unit-tested.
    public sealed partial class Mod
    {
        private static Entity PaidParkingPolicy(EntityManager em)
        {
            using (var q = em.CreateEntityQuery(ComponentType.ReadOnly<PrefabData>(), ComponentType.ReadOnly<BuildingOptionData>()))
            using (var es = q.ToEntityArray(Allocator.Temp)) foreach (var p in es) if (BuildingUtils.HasOption(em.GetComponentData<BuildingOptionData>(p), BuildingOption.PaidParking)) return p;
            return Entity.Null;
        }

        // get_fees {}: service fees and parking sites.
        private JObject GetFees(JObject args)
        {
            var w = RequireCity(); var em = w.EntityManager; var ps = w.GetExistingSystemManaged<PrefabSystem>(); var o = new JObject();
            var fees = w.GetExistingSystemManaged<ServiceFeeSystem>(); var city = w.GetExistingSystemManaged<CitySystem>().City; var rows = new JArray();
            if (city != Entity.Null && em.HasBuffer<ServiceFee>(city))
            {
                var buffer = em.GetBuffer<ServiceFee>(city, true);
                for (int i = 0; i < (int)PlayerResource.Count; i++)
                {
                    var res = (PlayerResource)i; if (!ServiceFeeSystem.TryGetFee(res, buffer, out float fee)) continue;
                    var row = new JObject { ["name"] = res.ToString(), ["fee"] = Math.Round(fee, 3) };
                    try { row["incomeEstimate"] = fees.GetServiceFeeIncomeEstimate(res, fee); } catch { }
                    rows.Add(row);
                }
            }
            o["service"] = rows;
            using (var q = em.CreateEntityQuery(ComponentType.ReadOnly<ServiceFeeParameterData>())) if (!q.IsEmptyIgnoreFilter)
            {
                var p = q.GetSingleton<ServiceFeeParameterData>();
                JObject F(FeeParameters f) => new JObject { ["default"] = f.m_Default, ["max"] = f.m_Max, ["adjustable"] = f.m_Adjustable };
                o["bounds"] = new JObject { ["Electricity"] = F(p.m_ElectricityFee), ["Healthcare"] = F(p.m_HealthcareFee), ["BasicEducation"] = F(p.m_BasicEducationFee), ["SecondaryEducation"] = F(p.m_SecondaryEducationFee), ["HigherEducation"] = F(p.m_HigherEducationFee), ["Garbage"] = F(p.m_GarbageFee), ["Water"] = F(p.m_WaterFee), ["FireResponse"] = F(p.m_FireResponseFee), ["Police"] = F(p.m_PoliceFee) };
            }
            var policy = PaidParkingPolicy(em); var sites = new JArray();
            if (policy != Entity.Null && em.HasComponent<PolicySliderData>(policy)) { var s = em.GetComponentData<PolicySliderData>(policy); o["parkingFeeRange"] = new JObject { ["min"] = s.m_Range.min, ["max"] = s.m_Range.max, ["default"] = s.m_Default, ["step"] = s.m_Step }; }
            foreach (var e in NativeBuild.Buildings(em))
            {
                if (!em.HasComponent<Game.Buildings.ParkingFacility>(e) || em.HasComponent<PrefabData>(e)) continue;
                var pos = em.GetComponentData<Game.Objects.Transform>(e).m_Position; int cap = 0, used = 0, lanes = 0, lanesFull = 0; float feeNow = 0; bool paid = false;
                // The places of a hall or lot are lanes of its own sub-nets and sub-objects, not of the building itself
                // (capacity read 0 for every hall): walk the building, its sub-nets and its sub-objects.
                void Walk(Entity owner, int depth)
                {
                    if (depth > 4 || !em.Exists(owner)) return;
                    if (em.HasBuffer<Game.Net.SubLane>(owner)) foreach (var sl in em.GetBuffer<Game.Net.SubLane>(owner, true))
                    {
                        var lane = sl.m_SubLane;
                        if (em.HasComponent<Game.Net.GarageLane>(lane)) { var g = em.GetComponentData<Game.Net.GarageLane>(lane); cap += g.m_VehicleCapacity; used += g.m_VehicleCount; }
                        else if (em.HasComponent<Game.Net.ParkingLane>(lane))
                        {
                            var l = em.GetComponentData<Game.Net.ParkingLane>(lane); if ((l.m_Flags & (Game.Net.ParkingLaneFlags.VirtualLane | Game.Net.ParkingLaneFlags.ParkingDisabled)) != 0) continue;
                            lanes++; if (l.m_FreeSpace < 5f) lanesFull++;
                            // Slots of an open-air lane: its length over the slot interval of the lane prefab; parked cars are its lane objects.
                            float len = em.HasComponent<Game.Net.Curve>(lane) ? em.GetComponentData<Game.Net.Curve>(lane).m_Length : 0f; float interval = 0f;
                            if (em.HasComponent<PrefabRef>(lane)) { var lp = em.GetComponentData<PrefabRef>(lane).m_Prefab; if (em.HasComponent<ParkingLaneData>(lp)) { var d = em.GetComponentData<ParkingLaneData>(lp); interval = d.m_SlotInterval > 0.1f ? d.m_SlotInterval : Math.Max(d.m_SlotSize.x, d.m_SlotSize.y); } }
                            if (interval > 0.5f && len > 0) cap += (int)Math.Floor(len / interval + 0.01f);
                            if (em.HasBuffer<Game.Net.LaneObject>(lane)) foreach (var lo in em.GetBuffer<Game.Net.LaneObject>(lane, true)) if (em.HasComponent<Game.Vehicles.ParkedCar>(lo.m_LaneObject)) used++;
                        }
                    }
                    if (em.HasBuffer<Game.Net.SubNet>(owner)) foreach (var sn in em.GetBuffer<Game.Net.SubNet>(owner, true)) Walk(sn.m_SubNet, depth + 1);
                    if (em.HasBuffer<Game.Objects.SubObject>(owner)) foreach (var so in em.GetBuffer<Game.Objects.SubObject>(owner, true)) Walk(so.m_SubObject, depth + 1);
                }
                Walk(e, 0);
                if (em.HasBuffer<Game.Policies.Policy>(e)) foreach (var p in em.GetBuffer<Game.Policies.Policy>(e, true)) if (p.m_Policy == policy && (p.m_Flags & Game.Policies.PolicyFlags.Active) != 0) { paid = true; feeNow = p.m_Adjustment; }
                var row = NativeBuild.Id(e); row["prefab"] = ps.GetPrefabName(em.GetComponentData<PrefabRef>(e).m_Prefab); row["x"] = Math.Round(pos.x); row["z"] = Math.Round(pos.z);
                row["capacity"] = cap; row["parked"] = used; row["lanes"] = lanes; row["lanesFull"] = lanesFull; row["paid"] = paid; row["fee"] = Math.Round(feeNow, 2); sites.Add(row);
            }
            o["parking"] = sites;
            return o;
        }

        // set_service_fee {resource, fee}: one of the city's service fees (the game clamps to its own range).
        private JObject SetServiceFee(JObject args)
        {
            var w = RequireCity(); RequireControl(); var em = w.EntityManager;
            if (!Enum.TryParse((string)args["resource"], true, out PlayerResource res) || res == PlayerResource.Count) throw new ArgumentException("unknown_fee_resource");
            float fee = RequiredFloat(args, "fee"); if (fee < 0 || float.IsNaN(fee)) throw new ArgumentException("fee_must_be_zero_or_more");
            var city = w.GetExistingSystemManaged<CitySystem>().City; var buffer = em.GetBuffer<ServiceFee>(city);
            if (!ServiceFeeSystem.TryGetFee(res, buffer, out float before)) throw new InvalidOperationException("fee_not_set_in_this_city");
            ServiceFeeSystem.SetFee(res, buffer, fee);
            ServiceFeeSystem.TryGetFee(res, em.GetBuffer<ServiceFee>(city, true), out float after);
            return new JObject { ["ok"] = true, ["resource"] = res.ToString(), ["before"] = before, ["after"] = after };
        }

        // set_parking_fee {index, version, fee}: paid parking on one parking building (0 = free).
        private JObject SetParkingFee(JObject args)
        {
            var w = RequireCity(); RequireControl(); var em = w.EntityManager;
            var e = Mod.CheckedEntity(RequiredInt(args, "index"), RequiredInt(args, "version")); float fee = RequiredFloat(args, "fee");
            if (!em.Exists(e) || !em.HasComponent<Game.Buildings.ParkingFacility>(e)) throw new ArgumentException("not_a_parking_building");
            var policy = PaidParkingPolicy(em); if (policy == Entity.Null) throw new InvalidOperationException("paid_parking_policy_not_found");
            var ui = w.GetExistingSystemManaged<Game.UI.InGame.PoliciesUISystem>();
            var set = typeof(Game.UI.InGame.PoliciesUISystem).GetMethod("SetPolicy", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance, null, new[] { typeof(Entity), typeof(Entity), typeof(bool), typeof(float) }, null);
            if (ui == null || set == null) throw new MissingMethodException("PoliciesUISystem.SetPolicy");
            set.Invoke(ui, new object[] { e, policy, fee > 0, fee });
            return new JObject { ["ok"] = true, ["fee"] = fee, ["paid"] = fee > 0 };
        }
    }
}
