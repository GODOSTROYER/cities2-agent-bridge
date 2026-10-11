using System;
using System.Collections.Generic;
using System.Reflection;
using Game;
using Game.Common;
using Game.Prefabs;
using Game.Routes;
using Game.Tools;
using Newtonsoft.Json.Linq;
using Unity.Collections;
using Unity.Entities;
using Unity.Jobs;
using Unity.Mathematics;

namespace CitiesIIAgentBridge
{
    // Draws a transport line through an ordered list of existing stops with the game's own route tool
    // (FAILURES #69, REDESIGN "Public transport tools"). Same pattern as BridgeRoadTool: the tool's
    // input-driven update is replaced by explicit control points, the game's snap, definition and
    // apply steps run unchanged, and the result is read back from the route entities.
    public class BridgeRouteTool : RouteToolSystem
    {
        public override string toolID => "CitiesIIAgentRoute";
        private string operation; private int stage, frames; private DateTime deadline;
        private Entity[] stops; private bool closed, previewOnly; private HashSet<Entity> before; private Entity linePrefab;

        private HashSet<Entity> Routes()
        {
            var set = new HashSet<Entity>();
            using (var q = EntityManager.CreateEntityQuery(new EntityQueryDesc { All = new[] { ComponentType.ReadOnly<Route>(), ComponentType.ReadOnly<TransportLine>() }, None = new[] { ComponentType.ReadOnly<Temp>(), ComponentType.ReadOnly<Deleted>() } }))
            using (var es = q.ToEntityArray(Allocator.Temp)) foreach (var e in es) set.Add(e);
            return set;
        }

        public void Begin(RoutePrefab line, Entity[] stopEntities, bool close, bool preview)
        {
            operation = ConstructionAccess.Begin("line"); stops = stopEntities; closed = close; previewOnly = preview; stage = frames = 0;
            deadline = DateTime.UtcNow.AddSeconds(40); before = Routes(); linePrefab = World.GetExistingSystemManaged<PrefabSystem>().GetEntity(line);
            if (!TrySetPrefab(line)) { ConstructionAccess.Finish(operation, "failed", "route_tool_refused_prefab"); operation = null; return; }
            World.GetExistingSystemManaged<ToolSystem>().activeTool = this;
        }
        protected override void OnStopRunning()
        {
            if (operation != null) { ConstructionAccess.Finish(operation, "interrupted", "active_tool_changed"); operation = null; }
            base.OnStopRunning();
        }
        private void SetState(string name)
        {
            var f = typeof(RouteToolSystem).GetField("m_State", BindingFlags.Instance | BindingFlags.NonPublic);
            f.SetValue(this, Enum.Parse(f.FieldType, name));
        }
        protected override JobHandle OnUpdate(JobHandle deps)
        {
            if (operation == null) return deps;
            try
            {
                deps.Complete();
                if (ConstructionAccess.Allowed?.Invoke() != true || DateTime.UtcNow > deadline) throw new InvalidOperationException("stopped_or_timed_out");
                if (stage == 0)
                {
                    SetState("Create");
                    var points = GetControlPoints(out var ready); ready.Complete(); points.Clear();
                    var list = new List<Entity>(stops); if (closed && stops.Length > 1) list.Add(stops[0]);
                    foreach (var s in list)
                    {
                        var pos = EntityManager.GetComponentData<Game.Objects.Transform>(s).m_Position;
                        points.Add(new ControlPoint { m_OriginalEntity = s, m_Position = pos, m_HitPosition = pos, m_SnapPriority = new float2(1f, 1f), m_Rotation = quaternion.identity, m_ElementIndex = new int2(-1, -1) });
                    }
                    applyMode = ApplyMode.Clear;
                    deps = (JobHandle)ConstructionAccess.Call(typeof(RouteToolSystem), this, "SnapControlPoints", deps, Entity.Null);
                    deps = (JobHandle)ConstructionAccess.Call(typeof(RouteToolSystem), this, "UpdateDefinitions", deps, Entity.Null);
                    ConstructionAccess.Results[operation]["status"] = "validating"; stage = 1; frames = 0; return deps;
                }
                if (stage == 1)
                {
                    applyMode = ApplyMode.None; if (++frames < 6) return deps;
                    var errors = ConstructionAccess.Errors(EntityManager);
                    if (errors.Count > 0) { ConstructionAccess.Results[operation]["placementErrors"] = errors; throw new InvalidOperationException("game_rejected_line"); }
                    bool pathDone = true; try { pathDone = (bool)ConstructionAccess.Call(typeof(RouteToolSystem), this, "GetPathfindCompleted"); } catch (MissingMethodException) { }
                    if (!pathDone && frames < 300) return deps;
                    // What the preview holds: the temp route with its waypoints.
                    int tempRoutes = 0, tempWaypoints = 0;
                    using (var q = EntityManager.CreateEntityQuery(ComponentType.ReadOnly<Temp>(), ComponentType.ReadOnly<Route>()))
                    using (var es = q.ToEntityArray(Allocator.Temp)) foreach (var e in es) { tempRoutes++; if (EntityManager.HasBuffer<RouteWaypoint>(e)) tempWaypoints = Math.Max(tempWaypoints, EntityManager.GetBuffer<RouteWaypoint>(e, true).Length); }
                    ConstructionAccess.Results[operation]["preview"] = new JObject { ["tempRoutes"] = tempRoutes, ["waypoints"] = tempWaypoints, ["pathfindCompleted"] = pathDone, ["allowApply"] = GetAllowApply() };
                    if (tempRoutes == 0 || tempWaypoints < Math.Min(2, stops.Length)) throw new InvalidOperationException("no_route_preview");
                    if (previewOnly) { ConstructionAccess.Results[operation]["previewOnly"] = true; Finish("complete"); return deps; }
                    if (!GetAllowApply()) { if (frames < 300) return deps; throw new InvalidOperationException("route_preview_not_applicable"); }
                    applyMode = ApplyMode.Apply; stage = 2; frames = 0; ConstructionAccess.Results[operation]["status"] = "applying"; return deps;
                }
                applyMode = ApplyMode.Clear; if (++frames < 6) return deps;
                var created = new JArray();
                foreach (var e in Routes())
                {
                    if (before.Contains(e)) continue; var row = NativeBuild.Id(e);
                    row["waypoints"] = EntityManager.HasBuffer<RouteWaypoint>(e) ? EntityManager.GetBuffer<RouteWaypoint>(e, true).Length : 0;
                    row["segments"] = EntityManager.HasBuffer<RouteSegment>(e) ? EntityManager.GetBuffer<RouteSegment>(e, true).Length : 0;
                    if (EntityManager.HasComponent<RouteNumber>(e)) row["number"] = EntityManager.GetComponentData<RouteNumber>(e).m_Number;
                    created.Add(row);
                }
                ConstructionAccess.Results[operation]["createdLines"] = created;
                if (created.Count == 0) throw new InvalidOperationException("line_not_observed");
                Finish("complete");
            }
            catch (Exception e) { Finish("failed", e.Message); }
            return deps;
        }
        private void Finish(string status, string error = null)
        {
            applyMode = ApplyMode.Clear; try { SetState("Default"); } catch { }
            ConstructionAccess.Finish(operation, status, error); operation = null;
            World.GetExistingSystemManaged<ToolSystem>().activeTool = World.GetExistingSystemManaged<DefaultToolSystem>();
        }
    }

    public sealed partial class Mod
    {
        // create_line {prefabIndex, prefabVersion, stops:[{index,version}...], closed?, previewOnly?}: a transport
        // line through existing stops, in order. The line prefab comes from transit_status.
        private JObject CreateLine(JObject args)
        {
            var w = RequireCity(); RequireControl(); CheckBuildTool(w); var em = w.EntityManager;
            var prefab = BuildPrefab<RoutePrefab>(w, args);
            if (!(args["stops"] is JArray list) || list.Count < 2 || list.Count > 40) throw new ArgumentException("stops_must_list_2_to_40_stop_entities");
            var stops = new Entity[list.Count];
            for (int i = 0; i < list.Count; i++)
            {
                var e = Mod.CheckedEntity((int)list[i]["index"], (int)list[i]["version"]);
                if (!em.Exists(e) || !em.HasComponent<Game.Routes.TransportStop>(e) || !em.HasComponent<Game.Objects.Transform>(e)) throw new ArgumentException("not_a_transport_stop: " + i);
                stops[i] = e;
            }
            w.GetExistingSystemManaged<BridgeRouteTool>().Begin(prefab, stops, (bool?)args["closed"] != false, (bool?)args["previewOnly"] == true);
            return ConstructionAccess.Status(ConstructionAccess.Active);
        }

        // transit_lines {}: every line with stops, vehicles and waiting passengers; and every stop.
        private JObject TransitLines(JObject args)
        {
            var w = RequireCity(); var em = w.EntityManager; var ps = w.GetExistingSystemManaged<PrefabSystem>(); var lines = new JArray(); var stops = new JArray();
            using (var q = em.CreateEntityQuery(new EntityQueryDesc { All = new[] { ComponentType.ReadOnly<Route>(), ComponentType.ReadOnly<TransportLine>() }, None = new[] { ComponentType.ReadOnly<Temp>(), ComponentType.ReadOnly<Deleted>() } }))
            using (var es = q.ToEntityArray(Allocator.Temp)) foreach (var e in es)
            {
                var t = em.GetComponentData<TransportLine>(e); var row = NativeBuild.Id(e); row["prefab"] = ps.GetPrefabName(em.GetComponentData<PrefabRef>(e).m_Prefab);
                if (em.HasComponent<RouteNumber>(e)) row["number"] = em.GetComponentData<RouteNumber>(e).m_Number;
                row["ticketPrice"] = t.m_TicketPrice; row["vehicleInterval"] = Math.Round(t.m_VehicleInterval, 1); row["flags"] = t.m_Flags.ToString();
                row["vehicles"] = em.HasBuffer<RouteVehicle>(e) ? em.GetBuffer<RouteVehicle>(e, true).Length : 0;
                int waiting = 0, n = 0, badPaths = 0;
                if (em.HasBuffer<RouteWaypoint>(e)) foreach (var wp in em.GetBuffer<RouteWaypoint>(e, true)) { n++; if (em.HasComponent<WaitingPassengers>(wp.m_Waypoint)) waiting += em.GetComponentData<WaitingPassengers>(wp.m_Waypoint).m_Count; }
                if (em.HasBuffer<RouteSegment>(e)) foreach (var sg in em.GetBuffer<RouteSegment>(e, true)) if (em.HasComponent<Game.Pathfind.PathInformation>(sg.m_Segment)) { var pi = em.GetComponentData<Game.Pathfind.PathInformation>(sg.m_Segment); if (pi.m_Distance <= 0 || (pi.m_State & (Game.Pathfind.PathFlags.Pending | Game.Pathfind.PathFlags.Failed)) != 0) badPaths++; }
                row["waypoints"] = n; row["waiting"] = waiting; row["segmentsWithoutPath"] = badPaths; lines.Add(row);
            }
            using (var q = em.CreateEntityQuery(new EntityQueryDesc { All = new[] { ComponentType.ReadOnly<Game.Routes.TransportStop>(), ComponentType.ReadOnly<PrefabRef>(), ComponentType.ReadOnly<Game.Objects.Transform>() }, None = new[] { ComponentType.ReadOnly<Temp>(), ComponentType.ReadOnly<Deleted>(), ComponentType.ReadOnly<Game.Objects.OutsideConnection>() } }))
            using (var es = q.ToEntityArray(Allocator.Temp)) foreach (var e in es)
            {
                var p = em.GetComponentData<Game.Objects.Transform>(e).m_Position; var row = NativeBuild.Id(e); row["prefab"] = ps.GetPrefabName(em.GetComponentData<PrefabRef>(e).m_Prefab); row["x"] = Math.Round(p.x); row["z"] = Math.Round(p.z);
                row["kind"] = em.HasComponent<BusStop>(e) ? "bus" : em.HasComponent<TramStop>(e) ? "tram" : em.HasComponent<TrainStop>(e) ? "train" : em.HasComponent<SubwayStop>(e) ? "subway" : "other";
                row["lines"] = em.HasBuffer<ConnectedRoute>(e) ? em.GetBuffer<ConnectedRoute>(e, true).Length : 0;
                if (em.HasComponent<WaitingPassengers>(e)) row["waiting"] = em.GetComponentData<WaitingPassengers>(e).m_Count;
                stops.Add(row);
            }
            return new JObject { ["lines"] = lines, ["stops"] = stops };
        }
    }
}
