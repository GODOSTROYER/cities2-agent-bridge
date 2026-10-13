using System;
using System.Collections.Generic;
using Game.Common;
using Game.Prefabs;
using Game.Routes;
using Game.Tools;
using Newtonsoft.Json.Linq;
using Unity.Collections;
using Unity.Entities;

namespace CitiesIIAgentBridge
{
    // One transport line stop by stop: order, position, the stop entity, the metres to the next stop and the
    // passengers waiting for this line. Read-only, main thread.
    public sealed partial class Mod
    {
        // line_stops {index, version?}: version omitted = the live line with that index (route + transport line).
        private JObject LineStops(JObject args)
        {
            var w = RequireCity(); var em = w.EntityManager; var ps = w.GetExistingSystemManaged<PrefabSystem>();
            Entity line;
            if (args["version"] != null) line = Mod.CheckedEntity(RequiredInt(args, "index"), RequiredInt(args, "version"));
            else
            {
                int index = RequiredInt(args, "index"); line = Entity.Null;
                using (var q = em.CreateEntityQuery(new EntityQueryDesc { All = new[] { ComponentType.ReadOnly<Route>(), ComponentType.ReadOnly<TransportLine>() }, None = new[] { ComponentType.ReadOnly<Temp>(), ComponentType.ReadOnly<Deleted>() } }))
                using (var es = q.ToEntityArray(Allocator.Temp)) foreach (var e in es) if (e.Index == index) { line = e; break; }
                if (line == Entity.Null) throw new ArgumentException("transit_line_not_found");
            }
            if (!em.Exists(line) || !em.HasComponent<Route>(line) || !em.HasComponent<TransportLine>(line) || em.HasComponent<Temp>(line) || em.HasComponent<Deleted>(line))
                throw new ArgumentException("not_a_transport_line");

            // Waypoints and segments in route order.
            var wpEntities = new List<Entity>(); var segEntities = new List<Entity>();
            if (em.HasBuffer<RouteWaypoint>(line)) foreach (var rw in em.GetBuffer<RouteWaypoint>(line, true)) wpEntities.Add(rw.m_Waypoint);
            if (em.HasBuffer<RouteSegment>(line)) foreach (var rs in em.GetBuffer<RouteSegment>(line, true)) segEntities.Add(rs.m_Segment);
            int vehicles = em.HasBuffer<RouteVehicle>(line) ? em.GetBuffer<RouteVehicle>(line, true).Length : 0;

            // Metres of one segment (the game's path length); null when the game has no usable path for it.
            double? SegmentMetres(int i)
            {
                if (i < 0 || i >= segEntities.Count) return null;
                var s = segEntities[i];
                if (s == Entity.Null || !em.Exists(s) || !em.HasComponent<Game.Pathfind.PathInformation>(s)) return null;
                var pi = em.GetComponentData<Game.Pathfind.PathInformation>(s);
                bool bad = pi.m_Distance <= 0 || (pi.m_State & (Game.Pathfind.PathFlags.Pending | Game.Pathfind.PathFlags.Failed)) != 0;
                return bad ? (double?)null : Math.Round((double)pi.m_Distance);
            }

            // A waypoint is a stop when its Connected target is a transport stop.
            var stopWaypoint = new List<int>(); var stopEntity = new List<Entity>();
            for (int i = 0; i < wpEntities.Count; i++)
            {
                var wp = wpEntities[i]; if (wp == Entity.Null || !em.Exists(wp) || !em.HasComponent<Game.Routes.Connected>(wp)) continue;
                var target = em.GetComponentData<Game.Routes.Connected>(wp).m_Connected;
                if (target == Entity.Null || !em.Exists(target) || !em.HasComponent<Game.Routes.TransportStop>(target)) continue;
                stopWaypoint.Add(i); stopEntity.Add(target);
            }

            var stops = new JArray(); int busiestOrder = -1; double busiestX = 0, busiestZ = 0; int busiestWaiting = -1;
            bool anyLineScope = false, anyStopScope = false; int sumWaiting = 0;
            for (int k = 0; k < stopWaypoint.Count; k++)
            {
                int wi = stopWaypoint[k]; var wpe = wpEntities[wi]; var stop = stopEntity[k];

                // Distance to the next stop: the segments from this waypoint up to the next stop's waypoint.
                // The last stop of an open line has none; a closed line's last stop uses the segment that wraps round.
                double? distance;
                if (k + 1 < stopWaypoint.Count)
                {
                    int next = stopWaypoint[k + 1]; double? total = 0;
                    for (int j = wi; j < next; j++) { var m = SegmentMetres(j); if (m == null) { total = null; break; } total += m; }
                    distance = total;
                }
                else distance = SegmentMetres(wi);

                // Waiting: the waypoint's own count when the game keeps one (per line), else the stop's total.
                int? waiting = null; string scope = null;
                if (em.HasComponent<WaitingPassengers>(wpe)) { waiting = em.GetComponentData<WaitingPassengers>(wpe).m_Count; scope = "line"; anyLineScope = true; }
                else if (em.HasComponent<WaitingPassengers>(stop)) { waiting = em.GetComponentData<WaitingPassengers>(stop).m_Count; scope = "stop"; anyStopScope = true; }
                if (waiting != null) sumWaiting += waiting.Value;

                // Position: the waypoint's route position, else the stop's transform.
                float x = 0, z = 0; bool placed = false;
                if (em.HasComponent<Game.Routes.Position>(wpe)) { var p = em.GetComponentData<Game.Routes.Position>(wpe).m_Position; x = p.x; z = p.z; placed = true; }
                else if (em.HasComponent<Game.Objects.Transform>(stop)) { var p = em.GetComponentData<Game.Objects.Transform>(stop).m_Position; x = p.x; z = p.z; placed = true; }

                var row = new JObject { ["order"] = k };
                if (placed) { row["x"] = Math.Round(x, 1); row["z"] = Math.Round(z, 1); }
                else { row["x"] = JValue.CreateNull(); row["z"] = JValue.CreateNull(); }
                row["stopEntity"] = NativeBuild.Id(stop);
                row["stopPrefab"] = em.HasComponent<PrefabRef>(stop) ? (JToken)new JValue(ps.GetPrefabName(em.GetComponentData<PrefabRef>(stop).m_Prefab)) : JValue.CreateNull();
                row["waiting"] = waiting.HasValue ? (JToken)new JValue(waiting.Value) : JValue.CreateNull();
                row["waitingScope"] = scope == null ? (JToken)JValue.CreateNull() : new JValue(scope);
                row["distanceToNext"] = distance.HasValue ? (JToken)new JValue(distance.Value) : JValue.CreateNull();
                stops.Add(row);

                if (waiting.HasValue && waiting.Value > busiestWaiting)
                {
                    busiestWaiting = waiting.Value; busiestOrder = k; busiestX = placed ? Math.Round(x, 1) : 0; busiestZ = placed ? Math.Round(z, 1) : 0;
                }
            }

            string waitingScope = anyLineScope && anyStopScope ? "mixed" : anyLineScope ? "line" : anyStopScope ? "stop" : "none";
            JToken busiest = JValue.CreateNull();
            if (busiestOrder >= 0) busiest = new JObject { ["order"] = busiestOrder, ["x"] = busiestX, ["z"] = busiestZ, ["waiting"] = busiestWaiting };

            var number = em.HasComponent<RouteNumber>(line) ? (JToken)new JValue(em.GetComponentData<RouteNumber>(line).m_Number) : JValue.CreateNull();
            var prefab = em.HasComponent<PrefabRef>(line) ? (JToken)new JValue(ps.GetPrefabName(em.GetComponentData<PrefabRef>(line).m_Prefab)) : JValue.CreateNull();
            return new JObject
            {
                ["index"] = line.Index, ["number"] = number, ["prefab"] = prefab, ["vehicles"] = vehicles,
                ["waiting"] = sumWaiting, ["waitingScope"] = waitingScope, ["stops"] = stops, ["busiest"] = busiest,
            };
        }
    }
}
