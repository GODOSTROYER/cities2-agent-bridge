using System;
using System.Collections.Generic;
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

        // get_policies {}: every city and district policy of the game (name, scope, slider range) and what is active on the city.
        private JObject GetPolicies(JObject args)
        {
            var w = RequireCity(); var em = w.EntityManager; var ps = w.GetExistingSystemManaged<PrefabSystem>(); var rows = new JArray();
            var city = w.GetExistingSystemManaged<Game.Simulation.CitySystem>().City; var active = new Dictionary<Entity, float>();
            if (city != Entity.Null && em.HasBuffer<Game.Policies.Policy>(city)) foreach (var pol in em.GetBuffer<Game.Policies.Policy>(city, true)) if ((pol.m_Flags & Game.Policies.PolicyFlags.Active) != 0) active[pol.m_Policy] = pol.m_Adjustment;
            using (var q = em.CreateEntityQuery(ComponentType.ReadOnly<PrefabData>(), ComponentType.ReadOnly<PolicyData>()))
            using (var es = q.ToEntityArray(Allocator.Temp)) foreach (var pe in es)
            {
                bool cityScope = em.HasComponent<CityOptionData>(pe) || em.HasBuffer<CityModifierData>(pe), districtScope = em.HasComponent<DistrictOptionData>(pe) || em.HasBuffer<DistrictModifierData>(pe);
                if (!cityScope && !districtScope) continue;
                var row = new JObject { ["name"] = ps.GetPrefabName(pe), ["scope"] = cityScope ? "city" : "district" };
                if (em.HasComponent<PolicySliderData>(pe)) { var sl = em.GetComponentData<PolicySliderData>(pe); row["slider"] = new JObject { ["min"] = sl.m_Range.min, ["max"] = sl.m_Range.max, ["default"] = sl.m_Default, ["step"] = sl.m_Step }; }
                if (cityScope) { row["active"] = active.ContainsKey(pe); if (active.ContainsKey(pe)) row["value"] = active[pe]; }
                rows.Add(row);
            }
            return new JObject { ["policies"] = rows };
        }

        // set_policy {name, active, value?, scope?: "city" (default) | "district", index?, version? (the district)}: the game's own policy call.
        private JObject SetPolicyCommand(JObject args)
        {
            var w = RequireCity(); RequireControl(); var em = w.EntityManager; var ps = w.GetExistingSystemManaged<PrefabSystem>();
            string name = (string)args["name"]; if (string.IsNullOrEmpty(name)) throw new ArgumentException("name_required");
            Entity policy = Entity.Null;
            using (var q = em.CreateEntityQuery(ComponentType.ReadOnly<PrefabData>(), ComponentType.ReadOnly<PolicyData>()))
            using (var es = q.ToEntityArray(Allocator.Temp)) foreach (var pe in es) if (string.Equals(ps.GetPrefabName(pe), name, StringComparison.OrdinalIgnoreCase)) policy = pe;
            if (policy == Entity.Null) throw new ArgumentException("policy_not_found");
            bool district = string.Equals((string)args["scope"], "district", StringComparison.OrdinalIgnoreCase); Entity target;
            if (district)
            {
                target = Mod.CheckedEntity(RequiredInt(args, "index"), RequiredInt(args, "version"));
                if (!em.Exists(target) || !em.HasComponent<Game.Areas.District>(target)) throw new ArgumentException("not_a_district");
                if (!em.HasComponent<DistrictOptionData>(policy) && !em.HasBuffer<DistrictModifierData>(policy)) throw new ArgumentException("not_a_district_policy");
            }
            else
            {
                target = w.GetExistingSystemManaged<Game.Simulation.CitySystem>().City;
                if (!em.HasComponent<CityOptionData>(policy) && !em.HasBuffer<CityModifierData>(policy)) throw new ArgumentException("not_a_city_policy");
            }
            float value = args["value"] == null ? (em.HasComponent<PolicySliderData>(policy) ? em.GetComponentData<PolicySliderData>(policy).m_Default : 0f) : RequiredFloat(args, "value");
            var ui = w.GetExistingSystemManaged<Game.UI.InGame.PoliciesUISystem>();
            var set = typeof(Game.UI.InGame.PoliciesUISystem).GetMethod("SetPolicy", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance, null, new[] { typeof(Entity), typeof(Entity), typeof(bool), typeof(float) }, null);
            if (ui == null || set == null) throw new MissingMethodException("PoliciesUISystem.SetPolicy");
            bool on = (bool?)args["active"] != false; set.Invoke(ui, new object[] { target, policy, on, value });
            return new JObject { ["ok"] = true, ["name"] = ps.GetPrefabName(policy), ["scope"] = district ? "district" : "city", ["active"] = on, ["value"] = value };
        }

        // tile_prices {}: READ ONLY. What every map tile costs by the game's own formula (MapTilePurchaseSystem.UpdateStatus):
        // a tile's base price = sum over its map features of amount x baseline modifier x 10 x feature cost x the tile prefab's cost factor;
        // a selection costs the sum of base prices, sorted from dearest to cheapest, each times (tiles owned + its place in that order);
        // upkeep = sum of the base prices of the owned tiles that are not start tiles x the game's curve at the number owned.
        // Nothing is selected and nothing is bought: the selection tool and the construction slot are not touched.
        private JObject TilePrices(JObject args)
        {
            var w = RequireCity(); var em = w.EntityManager; var purchase = w.GetExistingSystemManaged<MapTilePurchaseSystem>();
            const BindingFlags any = BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
            var modifiers = (double[])typeof(MapTilePurchaseSystem).GetField("kMapFeatureBaselineModifiers", any).GetValue(null);
            Func<int, double> baseline = i => i >= 0 && i < modifiers.Length ? modifiers[i] : 1.0;
            Func<int, float> curve = n => (float)typeof(MapTilePurchaseSystem).GetMethod("GetMapTileUpkeepCostMultiplier", any).Invoke(purchase, new object[] { n });
            var tileSystem = w.GetExistingSystemManaged<Game.Areas.MapTileSystem>();
            var startList = (NativeList<Entity>)typeof(Game.Areas.MapTileSystem).GetMethod("GetStartTiles", any).Invoke(tileSystem, null);
            var start = new HashSet<Entity>(); for (int i = 0; i < startList.Length; i++) start.Add(startList[i]);
            var rows = new JArray(); var unownedBase = new List<double>(); double ownedBase = 0, allBase = 0; int owned = 0, total = 0, unpriced = 0;
            using (var q = em.CreateEntityQuery(ComponentType.ReadOnly<Game.Areas.MapTile>()))
            using (var es = q.ToEntityArray(Allocator.Temp)) foreach (var e in es)
            {
                total++; bool mine = !em.HasComponent<Native>(e), isStart = start.Contains(e); if (mine) owned++;
                double x = 0, z = 0; int n = 0; if (em.HasBuffer<Game.Areas.Node>(e)) foreach (var node in em.GetBuffer<Game.Areas.Node>(e, true)) { x += node.m_Position.x; z += node.m_Position.z; n++; }
                double price = 0; var amounts = new JArray(); bool priced = false;
                if (em.HasBuffer<Game.Areas.MapFeatureElement>(e) && em.HasComponent<PrefabRef>(e))
                {
                    var features = em.GetBuffer<Game.Areas.MapFeatureElement>(e, true); var prefab = em.GetComponentData<PrefabRef>(e).m_Prefab;
                    if (em.HasComponent<TilePurchaseCostFactor>(prefab) && em.HasBuffer<MapFeatureData>(prefab))
                    {
                        float factor = em.GetComponentData<TilePurchaseCostFactor>(prefab).m_Amount; var costs = em.GetBuffer<MapFeatureData>(prefab, true); priced = true;
                        for (int i = 0; i < features.Length; i++) { double amount = features[i].m_Amount; amounts.Add(Math.Round(amount)); if (i < costs.Length) price += (float)(amount * baseline(i) * 10.0 * costs[i].m_Cost * factor); }
                    }
                }
                if (!priced) unpriced++;
                if (!isStart) { allBase += price; if (mine) ownedBase += price; }
                if (!mine) unownedBase.Add(price);
                rows.Add(new JObject { ["x"] = n > 0 ? Math.Round(x / n) : 0, ["z"] = n > 0 ? Math.Round(z / n) : 0, ["owned"] = mine, ["start"] = isStart, ["base"] = Math.Round(price, 1), ["features"] = amounts });
            }
            // The game's own order: dearest tile first, each multiplied by the number of tiles owned at that point.
            unownedBase.Sort(); double all = 0; for (int k = 0; k < unownedBase.Count; k++) all += unownedBase[unownedBase.Count - 1 - k] * (owned + k);
            int available = purchase.GetAvailableTiles(); double permitted = 0; for (int k = 0; k < Math.Min(available, unownedBase.Count); k++) permitted += unownedBase[k] * (owned + Math.Min(available, unownedBase.Count) - 1 - k);
            int milestoneTilesUnlocked = 0, milestoneTilesLocked = 0, milestonesLocked = 0;
            using (var q = em.CreateEntityQuery(ComponentType.ReadOnly<MilestoneData>()))
            using (var es = q.ToEntityArray(Allocator.Temp)) foreach (var e in es)
            {
                int t = em.GetComponentData<MilestoneData>(e).m_MapTiles;
                if (em.HasComponent<Locked>(e) && em.IsComponentEnabled<Locked>(e)) { milestoneTilesLocked += t; milestonesLocked++; } else milestoneTilesUnlocked += t;
            }
            var config = w.GetExistingSystemManaged<CityConfigurationSystem>();
            var costRow = new JArray(); if (rows.Count > 0) { var anyTile = em.CreateEntityQuery(ComponentType.ReadOnly<Game.Areas.MapTile>()); using (var es = anyTile.ToEntityArray(Allocator.Temp)) { var prefab = em.GetComponentData<PrefabRef>(es[0]).m_Prefab; if (em.HasBuffer<MapFeatureData>(prefab)) foreach (var c in em.GetBuffer<MapFeatureData>(prefab, true)) costRow.Add(c.m_Cost); costRow.Add(em.HasComponent<TilePurchaseCostFactor>(prefab) ? em.GetComponentData<TilePurchaseCostFactor>(prefab).m_Amount : -1f); } anyTile.Dispose(); }
            var curveRow = new JObject(); foreach (int c in new[] { 9, 10, 20, 30, owned, 50, 100, 150, 200, 300, 400, total }) curveRow[c.ToString()] = Math.Round(curve(c), 5);
            return new JObject {
                ["tilesOnMap"] = total, ["owned"] = owned, ["unowned"] = total - owned, ["startTiles"] = start.Count, ["unpriced"] = unpriced,
                ["availablePurchases"] = available, ["milestoneTilesUnlocked"] = milestoneTilesUnlocked, ["milestoneTilesLocked"] = milestoneTilesLocked, ["milestonesLocked"] = milestonesLocked,
                ["allTilesUnlockedOption"] = config.unlockMapTiles,
                ["priceAllUnowned"] = Math.Round(all), ["pricePermittedCheapest"] = Math.Round(permitted),
                ["sumBaseUnowned"] = Math.Round(unownedBase.Sum(), 1), ["sumBaseOwnedNotStart"] = Math.Round(ownedBase, 1), ["sumBaseAllNotStart"] = Math.Round(allBase, 1),
                ["upkeepNowGame"] = (int)typeof(MapTilePurchaseSystem).GetMethod("CalculateOwnedTilesUpkeep", any).Invoke(purchase, null),
                ["upkeepNowFormula"] = Math.Round(ownedBase * curve(owned)), ["upkeepAllOwned"] = Math.Round(allBase * curve(total)),
                ["upkeepEnabled"] = (bool)typeof(MapTilePurchaseSystem).GetMethod("GetMapTileUpkeepEnabled", any).Invoke(purchase, null),
                ["upkeepCurve"] = curveRow, ["featureCostsThenFactor"] = costRow, ["baselineModifiers"] = new JArray(modifiers),
                ["tiles"] = rows };
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
