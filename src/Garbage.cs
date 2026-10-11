using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Game.Buildings;
using Game.Common;
using Game.Economy;
using Game.Prefabs;
using Game.Simulation;
using Game.Tools;
using Newtonsoft.Json.Linq;
using Unity.Collections;
using Unity.Entities;

namespace CitiesIIAgentBridge
{
    // The garbage system as the game runs it (FAILURES #114, #115): what the city produces, what each
    // facility really does (a full landfill accepts nothing), and what every facility type and
    // extension offers. Raw numbers only; the design rules live in the MCP layer.
    public sealed partial class Mod
    {
        private static JObject GarbageData(EntityManager em, Entity prefab)
        {
            var row = new JObject();
            if (em.HasComponent<GarbageFacilityData>(prefab))
            {
                var d = em.GetComponentData<GarbageFacilityData>(prefab);
                row["capacity"] = d.m_GarbageCapacity; row["trucks"] = d.m_VehicleCapacity; row["transferTrucks"] = d.m_TransportCapacity; row["processing"] = d.m_ProcessingSpeed;
                row["industrialOnly"] = d.m_IndustrialWasteOnly; row["longTermStorage"] = d.m_LongTermStorage;
            }
            if (em.HasComponent<PollutionData>(prefab)) { var p = em.GetComponentData<PollutionData>(prefab); row["air"] = Math.Round(p.m_AirPollution); row["ground"] = Math.Round(p.m_GroundPollution); row["noise"] = Math.Round(p.m_NoisePollution); }
            return row;
        }

        // garbage_system {}: production, the game's limits, every facility with its live state, and the catalog.
        private JObject GarbageSystem(JObject args)
        {
            var w = RequireCity(); var em = w.EntityManager; var ps = w.GetExistingSystemManaged<PrefabSystem>(); var o = new JObject();
            var acc = w.GetExistingSystemManaged<GarbageAccumulationSystem>(); if (acc != null) o["production"] = acc.garbageAccumulation;
            using (var q = em.CreateEntityQuery(ComponentType.ReadOnly<GarbageParameterData>())) if (!q.IsEmptyIgnoreFilter)
            {
                var g = q.GetSingleton<GarbageParameterData>();
                o["limits"] = new JObject { ["collect"] = g.m_CollectionGarbageLimit, ["request"] = g.m_RequestGarbageLimit, ["warning"] = g.m_WarningGarbageLimit, ["max"] = g.m_MaxGarbageAccumulation, ["happinessBaseline"] = g.m_HappinessEffectBaseline, ["happinessStep"] = g.m_HappinessEffectStep };
            }
            var rows = new JArray(); long live = 0, nominal = 0, stored = 0; int trucks = 0;
            foreach (var e in NativeBuild.Buildings(em))
            {
                if (!em.HasComponent<Game.Buildings.GarbageFacility>(e) || !em.HasComponent<PrefabRef>(e) || em.HasComponent<PrefabData>(e)) continue;
                var f = em.GetComponentData<Game.Buildings.GarbageFacility>(e); var pos = em.GetComponentData<Game.Objects.Transform>(e).m_Position;
                long cap = 0, speed = 0; int veh = 0; var ups = new JArray();
                foreach (var pe in PrefabAndUpgrades(em, e)) if (em.HasComponent<GarbageFacilityData>(pe)) { var d = em.GetComponentData<GarbageFacilityData>(pe); cap += d.m_GarbageCapacity; speed += d.m_ProcessingSpeed; veh += d.m_VehicleCapacity; }
                if (em.HasBuffer<InstalledUpgrade>(e)) foreach (var u in em.GetBuffer<InstalledUpgrade>(e, true)) if (u.m_Upgrade != Entity.Null && em.Exists(u.m_Upgrade) && em.HasComponent<PrefabRef>(u.m_Upgrade)) ups.Add(ps.GetPrefabName(em.GetComponentData<PrefabRef>(u.m_Upgrade).m_Prefab));
                long have = 0; if (em.HasBuffer<Resources>(e)) foreach (var r in em.GetBuffer<Resources>(e, true)) if (r.m_Resource == Resource.Garbage) have += r.m_Amount;
                double eff = 1; if (em.HasBuffer<Efficiency>(e)) foreach (var x in em.GetBuffer<Efficiency>(e, true)) eff *= Math.Max(0f, x.m_Efficiency);
                var options = new JArray(); if (em.HasBuffer<Game.Policies.Policy>(e)) foreach (var p in em.GetBuffer<Game.Policies.Policy>(e, true)) if ((p.m_Flags & Game.Policies.PolicyFlags.Active) != 0) options.Add(ps.GetPrefabName(p.m_Policy));
                int out_ = 0; if (em.HasBuffer<Game.Vehicles.OwnedVehicle>(e)) out_ = em.GetBuffer<Game.Vehicles.OwnedVehicle>(e, true).Length;
                live += f.m_ProcessingRate; nominal += speed; stored += have; trucks += veh;
                var row = NativeBuild.Id(e); row["prefab"] = ps.GetPrefabName(em.GetComponentData<PrefabRef>(e).m_Prefab); row["x"] = Math.Round(pos.x); row["z"] = Math.Round(pos.z);
                row["flags"] = f.m_Flags.ToString(); row["full"] = (f.m_Flags & GarbageFacilityFlags.HasAvailableSpace) == 0; row["trucksFree"] = (f.m_Flags & GarbageFacilityFlags.HasAvailableGarbageTrucks) != 0;
                row["processingLive"] = f.m_ProcessingRate; row["processing"] = speed; row["stored"] = have; row["capacity"] = cap; row["trucks"] = veh; row["vehiclesOwned"] = out_; row["efficiencyPct"] = Math.Round(eff * 100);
                row["upgrades"] = ups; row["options"] = options; rows.Add(row);
            }
            o["facilities"] = rows; o["totals"] = new JObject { ["processingLive"] = live, ["processing"] = nominal, ["stored"] = stored, ["trucks"] = trucks };
            var catalog = new JArray();
            using (var q = em.CreateEntityQuery(ComponentType.ReadOnly<PrefabData>(), ComponentType.ReadOnly<GarbageFacilityData>()))
            using (var es = q.ToEntityArray(Allocator.Temp)) foreach (var pe in es)
            {
                var row = GarbageData(em, pe); row["name"] = ps.GetPrefabName(pe); row["index"] = pe.Index; row["version"] = pe.Version; row["locked"] = IsPrefabLocked(em, pe); row["extension"] = em.HasComponent<ServiceUpgradeData>(pe);
                var costs = PrefabCosts(em, pe); row["construction"] = costs["construction"]; row["monthlyUpkeep"] = costs["monthlyUpkeep"] ?? costs["consumptionUpkeep"];
                if (em.HasBuffer<ServiceUpgradeBuilding>(pe)) row["extends"] = new JArray(em.GetBuffer<ServiceUpgradeBuilding>(pe, true).ToNativeArray(Allocator.Temp).Select(b => ps.GetPrefabName(b.m_Building)));
                catalog.Add(row);
            }
            o["catalog"] = catalog; o["note"] = "production and processing are in the game's garbage units per month (as the Garbage infoview); a facility that is full accepts nothing and its trucks do not go out.";
            return o;
        }

        // set_building_option {index, version, option: Empty | Inactive, active}: the building options
        // of the info panel (empty a landfill into other facilities, switch a building off).
        private JObject SetBuildingOption(JObject args)
        {
            var w = RequireCity(); var em = w.EntityManager; var ps = w.GetExistingSystemManaged<PrefabSystem>();
            var e = Mod.CheckedEntity(RequiredInt(args, "index"), RequiredInt(args, "version"));
            if (!em.Exists(e) || !em.HasComponent<Game.Buildings.Building>(e) || !em.HasBuffer<Game.Policies.Policy>(e)) throw new ArgumentException("not_a_building_with_options");
            if (!Enum.TryParse((string)args["option"], true, out BuildingOption option)) throw new ArgumentException("option_must_be_Empty_or_Inactive_or_PaidParking");
            bool active = (bool?)args["active"] ?? true; Entity policy = Entity.Null;
            using (var q = em.CreateEntityQuery(ComponentType.ReadOnly<PrefabData>(), ComponentType.ReadOnly<BuildingOptionData>()))
            using (var es = q.ToEntityArray(Allocator.Temp)) foreach (var p in es) if (BuildingUtils.HasOption(em.GetComponentData<BuildingOptionData>(p), option)) { policy = p; break; }
            if (policy == Entity.Null) throw new InvalidOperationException("option_policy_not_found");
            var ui = w.GetExistingSystemManaged<Game.UI.InGame.PoliciesUISystem>();
            var set = typeof(Game.UI.InGame.PoliciesUISystem).GetMethod("SetPolicy", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance, null, new[] { typeof(Entity), typeof(Entity), typeof(bool), typeof(float) }, null);
            if (ui == null || set == null) throw new MissingMethodException("PoliciesUISystem.SetPolicy");
            set.Invoke(ui, new object[] { e, policy, active, 0f });
            return new JObject { ["ok"] = true, ["option"] = option.ToString(), ["active"] = active, ["policy"] = ps.GetPrefabName(policy), ["note"] = "applied by the game at the end of the frame; read garbage_system options to confirm" };
        }
    }
}
