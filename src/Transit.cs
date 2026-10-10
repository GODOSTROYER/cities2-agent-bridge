using System;
using System.Linq;
using Game.Common;
using Game.Prefabs;
using Game.Tools;
using Newtonsoft.Json.Linq;
using Unity.Collections;
using Unity.Entities;

namespace CitiesIIAgentBridge
{
    // First step toward public transport: what the city can build and what it already has.
    // A line needs (1) an unlocked passenger TransportLinePrefab of that type, (2) stop
    // objects whose prefab carries TransportStopData of the same type, placed on road edges,
    // and (3) a depot building of that type. Creating the line itself goes through the game's
    // RouteToolSystem (control points = stop entities), which is not implemented yet.
    public sealed partial class Mod
    {
        private JObject TransitStatus(JObject args)
        {
            var w = RequireCity(); var em = w.EntityManager; var ps = w.GetExistingSystemManaged<PrefabSystem>();
            string wanted = (string)args["type"] ?? "Bus";
            if (!Enum.TryParse<TransportType>(wanted, true, out var type)) throw new ArgumentException("unknown_transport_type: " + string.Join(",", Enum.GetNames(typeof(TransportType))));
            var lines = new JArray(); var stops = new JArray(); var depots = new JArray();
            using (var q = em.CreateEntityQuery(ComponentType.ReadOnly<PrefabData>(), ComponentType.ReadOnly<TransportLineData>()))
            using (var es = q.ToEntityArray(Allocator.Temp))
                foreach (var e in es)
                {
                    var d = em.GetComponentData<TransportLineData>(e); if (d.m_TransportType != type) continue;
                    lines.Add(new JObject { ["name"] = ps.GetPrefabName(e), ["index"] = e.Index, ["version"] = e.Version, ["locked"] = IsPrefabLocked(em, e), ["passenger"] = d.m_PassengerTransport, ["cargo"] = d.m_CargoTransport });
                }
            using (var q = em.CreateEntityQuery(ComponentType.ReadOnly<PrefabData>(), ComponentType.ReadOnly<TransportStopData>()))
            using (var es = q.ToEntityArray(Allocator.Temp))
                foreach (var e in es)
                {
                    var d = em.GetComponentData<TransportStopData>(e); if (d.m_TransportType != type) continue;
                    if (stops.Count < 20) stops.Add(new JObject { ["name"] = ps.GetPrefabName(e), ["index"] = e.Index, ["version"] = e.Version, ["locked"] = IsPrefabLocked(em, e), ["passenger"] = d.m_PassengerTransport });
                }
            using (var q = em.CreateEntityQuery(ComponentType.ReadOnly<PrefabData>(), ComponentType.ReadOnly<TransportDepotData>()))
            using (var es = q.ToEntityArray(Allocator.Temp))
                foreach (var e in es)
                {
                    var d = em.GetComponentData<TransportDepotData>(e); if (d.m_TransportType != type) continue;
                    depots.Add(new JObject { ["name"] = ps.GetPrefabName(e), ["locked"] = IsPrefabLocked(em, e), ["vehicles"] = d.m_VehicleCapacity, ["costs"] = PrefabCosts(em, e) });
                }
            // What exists in the city.
            var placedDepots = new JArray(); int placedStops = 0; var routes = new JArray();
            foreach (var e in NativeBuild.Buildings(em))
            {
                if (!em.HasComponent<PrefabRef>(e) || !em.HasComponent<Game.Objects.Transform>(e) || em.HasComponent<PrefabData>(e)) continue;
                var pe = em.GetComponentData<PrefabRef>(e).m_Prefab;
                if (!em.HasComponent<TransportDepotData>(pe) || em.GetComponentData<TransportDepotData>(pe).m_TransportType != type) continue;
                var p = em.GetComponentData<Game.Objects.Transform>(e).m_Position;
                placedDepots.Add(new JObject { ["prefab"] = ps.GetPrefabName(pe), ["x"] = Math.Round(p.x), ["z"] = Math.Round(p.z) });
            }
            using (var q = em.CreateEntityQuery(new EntityQueryDesc { All = new[] { ComponentType.ReadOnly<Game.Routes.TransportStop>(), ComponentType.ReadOnly<PrefabRef>() }, None = new[] { ComponentType.ReadOnly<Temp>(), ComponentType.ReadOnly<Deleted>(), ComponentType.ReadOnly<PrefabData>() } }))
            using (var es = q.ToEntityArray(Allocator.Temp))
                foreach (var e in es)
                {
                    var pe = em.GetComponentData<PrefabRef>(e).m_Prefab;
                    if (em.HasComponent<TransportStopData>(pe) && em.GetComponentData<TransportStopData>(pe).m_TransportType == type) placedStops++;
                }
            using (var q = em.CreateEntityQuery(new EntityQueryDesc { All = new[] { ComponentType.ReadOnly<Game.Routes.Route>(), ComponentType.ReadOnly<Game.Routes.TransportLine>(), ComponentType.ReadOnly<PrefabRef>() }, None = new[] { ComponentType.ReadOnly<Temp>(), ComponentType.ReadOnly<Deleted>() } }))
            using (var es = q.ToEntityArray(Allocator.Temp))
                foreach (var e in es)
                {
                    var pe = em.GetComponentData<PrefabRef>(e).m_Prefab;
                    if (!em.HasComponent<TransportLineData>(pe) || em.GetComponentData<TransportLineData>(pe).m_TransportType != type) continue;
                    routes.Add(new JObject { ["index"] = e.Index, ["version"] = e.Version, ["prefab"] = ps.GetPrefabName(pe), ["waypoints"] = em.HasBuffer<Game.Routes.RouteWaypoint>(e) ? em.GetBuffer<Game.Routes.RouteWaypoint>(e, true).Length : 0 });
                }
            bool lineReady = lines.Any(l => (bool)l["locked"] == false && (bool)l["passenger"]);
            bool stopReady = stops.Any(s => (bool)s["locked"] == false);
            bool depotReady = depots.Any(d => (bool)d["locked"] == false);
            return new JObject
            {
                ["type"] = type.ToString(), ["linePrefabs"] = lines, ["stopPrefabs"] = stops, ["depotPrefabs"] = depots,
                ["city"] = new JObject { ["depots"] = placedDepots, ["stops"] = placedStops, ["lines"] = routes },
                ["ready"] = new JObject { ["linePrefabUnlocked"] = lineReady, ["stopPrefabUnlocked"] = stopReady, ["depotPrefabUnlocked"] = depotReady, ["depotBuilt"] = placedDepots.Count > 0 },
                ["next"] = !lineReady ? "bus lines are locked (milestone)" : placedDepots.Count == 0 ? "build a depot (place_service with a depot prefab)" : placedStops < 2 ? "place at least two stops on road edges (not implemented in the bridge yet)" : "create the line through the route tool (not implemented in the bridge yet)"
            };
        }
    }
}
