using System;
using System.IO;
using System.Linq;
using Colossal.Logging;
using Colossal.Serialization.Entities;
using Game;
using Game.City;
using Game.Modding;
using Game.Prefabs;
using Game.Rendering;
using Game.SceneFlow;
using Game.Simulation;
using Game.Tools;
using Newtonsoft.Json.Linq;
using Unity.Collections;
using Unity.Entities;
using Unity.Mathematics;
using UnityEngine;

namespace CitiesIIAgentBridge
{
    // Main-thread mailbox with native construction-tool subclasses; no Harmony patches.
    public sealed partial class Mod : IMod
    {
        private ILog log;
        private Mailbox mailbox;
        private BridgeSettings settings;
        private Func<bool> updater;
        private string citySession;
        private DateTime nextTick, nextPublish, busyUntil;
        private bool disposed;
        private bool faulted;
        private bool mailboxContended;
        private const string ModVersion = "0.5.1-local";

        public void OnLoad(UpdateSystem updateSystem)
        {
            // IMod instances may be allocated without running constructors/field initializers.
            log = LogManager.GetLogger("CitiesIIAgentBridge").SetShowsErrorsInUI(false);
            citySession = Guid.NewGuid().ToString("N");
            settings = new BridgeSettings(this);
            settings.RegisterInOptionsUI();
            Colossal.IO.AssetDatabase.AssetDatabase.global.LoadSettings("CitiesIIAgentBridge", settings, new BridgeSettings(this));
            if (!settings.KeepControlsAcrossLoads) settings.AllowControl = false;
            GameManager.instance.localizationManager.AddSource("en-US", new LocaleEN(settings));
            string root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CitiesIIAgentBridge");
            mailbox = new Mailbox(root, Dispatch, () => citySession);
            updater = Tick;
            ConstructionAccess.Allowed = () => !disposed && settings.AllowControl && !File.Exists(Path.Combine(mailbox.Root, "STOP"));
            updateSystem.UpdateAt<BridgeRoadTool>(SystemUpdatePhase.ToolUpdate);
            updateSystem.UpdateAt<BridgeZoneTool>(SystemUpdatePhase.ToolUpdate);
            updateSystem.UpdateAt<BridgeDistrictTool>(SystemUpdatePhase.ToolUpdate);
            updateSystem.UpdateAt<BridgeObjectTool>(SystemUpdatePhase.ToolUpdate);
            updateSystem.UpdateAt<BridgeBulldozeTool>(SystemUpdatePhase.ToolUpdate);
            updateSystem.UpdateAt<BridgeRouteTool>(SystemUpdatePhase.ToolUpdate);
            GameManager.instance.onGamePreload += OnPreload;
            GameManager.instance.RegisterUpdater(updater);
            try { mailbox.Publish(new JObject { ["status"] = "starting", ["modVersion"] = ModVersion }); }
            catch (IOException e) when (Mailbox.IsSharingViolation(e)) { MailboxContention(e); }
            log.Info("Bridge loaded; mailbox: " + root);
        }

        private void OnPreload(Purpose purpose, GameMode mode)
        {
            FinishSimulation("city_changed", false);
            neighborhoodPlan = null; districtAtlas = null;
            if (ConstructionAccess.Active != null) ConstructionAccess.Finish(ConstructionAccess.Active,"interrupted","city_changed");
            tileOperation = null; pendingTiles = null;
            if (batch != null && (string)batch["status"] == "running") { batch["status"] = "interrupted"; batch["error"] = "city_changed"; }
            citySession = Guid.NewGuid().ToString("N");
            // Changing saves invalidates pending control permission as well as entity IDs,
            // unless the owner explicitly opted to keep controls on across loads.
            if (!settings.KeepControlsAcrossLoads) settings.AllowControl = false;
        }

        public void OnDispose()
        {
            FinishSimulation("mod_disposed");
            disposed = true;
            if (GameManager.instance != null)
            {
                if (updater != null) GameManager.instance.UnregisterUpdater(updater);
                GameManager.instance.onGamePreload -= OnPreload;
            }
            settings?.UnregisterInOptionsUI();
            try { mailbox?.Publish(new JObject { ["status"] = "stopped", ["modVersion"] = ModVersion }); }
            catch (Exception e) { log?.Warn(e.Message); }
            log?.Info("Bridge disposed");
        }

        private bool Tick()
        {
            if (disposed) return true; // MainThreadDispatcher removes a callback returning true.
            var tickNow = DateTime.UtcNow;
            if (tickNow < nextTick) return false;
            // Adaptive tick (harness latency): every ~15 ms while a request was just served or an
            // operation/batch/save is in flight, so batch steps and replies do not wait a 250 ms
            // tick each; 100 ms when idle. The heartbeat file is still written every 250 ms only.
            bool busy = tickNow < busyUntil || ConstructionAccess.Active != null || (string)batch?["status"] == "running" || saveTask != null;
            nextTick = tickNow.AddMilliseconds(busy ? 15 : 100);
            try
            {
                bool communicated = BridgeTick.Run(
                    () => { if (File.Exists(Path.Combine(mailbox.Root, "STOP"))) settings.AllowControl = false; },
                    SimulationTick,
                    () => { if (tickNow < nextPublish) return; nextPublish = tickNow.AddMilliseconds(250); mailbox.Publish(new JObject
                {
                    ["status"] = "ready", ["modVersion"] = ModVersion,
                    ["gameVersion"] = Application.version,
                    ["gameMode"] = GameManager.instance.gameMode.ToString(),
                    ["loading"] = GameManager.instance.isGameLoading,
                    ["controlEnabled"] = settings.AllowControl,
                    ["display"] = Screen.fullScreenMode + " " + Screen.width + "x" + Screen.height,
                    ["pid"] = System.Diagnostics.Process.GetCurrentProcess().Id
                }); },
                    () => { if (mailbox.Pump() > 0) busyUntil = DateTime.UtcNow.AddSeconds(3); }, WorkflowTick, MailboxContention);
                if (communicated && mailboxContended)
                {
                    log.Info("Mailbox access recovered; control permission was not changed by recovery.");
                    mailboxContended = false;
                }
                faulted = false;
            }
            catch (Exception e)
            {
                settings.AllowControl = false;
                FinishSimulation("bridge_fault");
                if (!faulted) log.Error(e);
                faulted = true;
            }
            SnapshotTick(); // isolated: never throws, never touches control permission
            return false;
        }

        private void MailboxContention(IOException error)
        {
            if (!mailboxContended)
                log.Warn("Temporary mailbox file lock; retrying on subsequent ticks. " + error.Message);
            mailboxContended = true;
        }

        private World RequireCity()
        {
            var manager = GameManager.instance;
            var world = World.DefaultGameObjectInjectionWorld;
            if (manager.isGameLoading || manager.gameMode != GameMode.Game || world == null || !world.IsCreated)
                throw new InvalidOperationException("no_loaded_city");
            return world;
        }

        private void RequireControl()
        {
            if (!settings.AllowControl || File.Exists(Path.Combine(mailbox.Root, "STOP")))
                throw new InvalidOperationException("control_disabled: enable it in Options > Cities II Agent Bridge");
        }

        private static readonly string[] NonPausingReads = { "multi", "find_free_lots", "grid_connectors", "find_roadside_lots", "corridor", "coverage_gaps", "traffic_hotspots", "project", "plan_grid", "connected", "utility_check", "dev_tree", "service_headroom", "get_metrics", "network_ends", "pollution_sources", "garbage_system", "junction_info", "building_upgrades", "outside_connections", "get_fees", "transit_lines", "service_buildings", "home_clusters", "crime_map", "notifications", "transit_status", "tile_options", "zone_area_count", "get_city_state", "get_city_management", "get_services", "get_prefab_details", "get_build_prefabs", "get_tiles", "sample_terrain" };

        // multi {commands:[{command,args}]}: up to 16 non-pausing reads in one mailbox round trip.
        private JObject Multi(JObject args)
        {
            var list = args["commands"] as JArray; if (list == null || list.Count < 1 || list.Count > 16) throw new ArgumentException("multi_requires_1_to_16_commands");
            var results = new JArray();
            foreach (var item in list)
            {
                string name = (string)item["command"]; var row = new JObject { ["command"] = name };
                try
                {
                    if (name == "multi" || (Array.IndexOf(NonPausingReads, name) < 0 && name != "get_snapshot" && name != "get_ui_state" && name != "get_operation" && name != "get_batch")) throw new ArgumentException("multi_allows_non_pausing_reads_only");
                    row["result"] = Dispatch(name, item["args"] as JObject ?? new JObject()); row["ok"] = true;
                }
                catch (Exception e) { row["ok"] = false; row["error"] = e.GetType().Name + ": " + e.Message; }
                results.Add(row);
            }
            return new JObject { ["results"] = results };
        }

        // Caller-supplied entity ids are range-checked before any EntityManager access.
        internal static Entity CheckedEntity(int index, int version)
        {
            // This Entities version exposes no capacity; reject negative and absurd ids so that a bad
            // caller value can never index outside the entity store. Exists() then validates the rest.
            if (index < 0 || version < 0 || index >= 100000000) throw new ArgumentException("entity_id_out_of_range");
            return new Entity { Index = index, Version = version };
        }

        private static bool IsBridgeTool(ToolBaseSystem tool) => tool is BridgeRoadTool || tool is BridgeZoneTool || tool is BridgeObjectTool || tool is BridgeRouteTool || tool is BridgeBulldozeTool || tool is BridgeDistrictTool;

        // A command that claimed the operation slot or installed a bridge tool and then threw must
        // not leave later builds stuck on construction_busy (FAILURES #22, #23): roll both back.
        private JObject Dispatch(string command, JObject args)
        {
            string activeBefore = ConstructionAccess.Active;
            try { return DispatchCore(command, args); }
            catch (Exception e)
            {
                string claimed = ConstructionAccess.Active;
                if (claimed != null && claimed != activeBefore)
                {
                    try { ConstructionAccess.Finish(claimed, "failed", "setup_failed: " + e.GetBaseException().Message); } catch { }
                    try
                    {
                        var w = World.DefaultGameObjectInjectionWorld; var tools = w?.GetExistingSystemManaged<ToolSystem>();
                        if (tools != null && IsBridgeTool(tools.activeTool)) tools.activeTool = w.GetExistingSystemManaged<DefaultToolSystem>();
                    }
                    catch { }
                    if (tileOperation == claimed) { tileOperation = null; pendingTiles = null; }
                    if (simulationOperation == claimed) simulationWindow = null;
                }
                throw;
            }
        }

        private JObject DispatchCore(string command, JObject args)
        {
            // These status polls must not terminate an active bounded simulation step.
            bool statusOnly = command == "ping" || command == "get_capabilities" || command == "get_operation" || command == "get_batch" || command == "get_simulation_step" || command == "get_pause_state" || command == "resolve_pause_blocker" || command == "get_ui_state" || command == "get_snapshot" || command == "load_save" || command == "quit_game"
                // Planning reads run inside one main-thread tick, so they are consistent without
                // pausing: the simulation keeps running while the agent plans.
                || Array.IndexOf(NonPausingReads, command) >= 0;
            if(!statusOnly && command != "simulate_step" && command != "cancel_simulation_step" && command != "set_simulation_speed" && command != "set_camera")
            {
                if(settings.AllowControl) PauseAnalysis();
                else if(RequireCity().GetExistingSystemManaged<SimulationSystem>().selectedSpeed != 0)
                    throw new InvalidOperationException("pause_game_before_analysis_or_enable_bridge_controls");
            }
            if(!dispatchingBatch && (string)batch?["status"] == "running" && (Array.IndexOf(batchCommands,command)>=0 || command=="preview_building" || command=="plan_neighborhood" || command=="execute_neighborhood"))
                throw new InvalidOperationException("batch_in_progress_wait_or_cancel_batch");
            switch (command)
            {
                case "ping": return new JObject { ["pong"] = true, ["modVersion"] = ModVersion };
                case "get_capabilities": return new JObject
                {
                    ["read"] = new JArray("ping", "get_capabilities", "get_snapshot", "get_city_state", "get_camera", "get_selected", "inspect_entity", "get_water_facilities"),
                    ["control"] = new JArray("create_district","edit_district","set_service_districts","set_building_option","set_service_fee","set_parking_fee","set_policy","create_line","remove_line","route_policy","set_camera", "set_simulation_speed", "build_road", "build_network", "upgrade_network", "road_option", "zone_rectangle", "clear_zoning", "place_building", "relocate_building", "demolish", "purchase_tiles", "set_tax", "set_service_budget", "save_checkpoint", "batch_execute"),
                    ["constructionQueries"] = new JArray("get_build_prefabs", "get_prefab_details", "get_network", "get_network_edges", "trace_network", "get_zone_cells", "get_operation", "get_batch", "get_city_management", "get_services", "sample_terrain", "get_tiles", "get_buildings", "diagnose_connections"),
                    ["buildVersion"] = ModVersion, ["liveValidation"] = "community_binary_requires_live_validation",
                    ["visibility"] = new JObject {
                        ["districtAtlas"] = true, ["districtServiceAssignments"] = true,
                        ["districtBoundaryEditing"] = true,
                        ["buildingPagination"] = true, ["assetPagination"] = true,
                        ["terrainNaturalResources"] = true, ["terrainGroundwater"] = true,
                        ["terrainWaterSource"] = "full_precision_surface",
                        ["assetKinds"] = new JArray("building","network","zone","service","tree","prop","surface","other"),
                        ["trafficLaneRules"] = false, ["buildingUseFullMetrics"] = false,
                        ["roadBuilderConfiguration"] = false,
                        ["dateMeaning"] = "Raw simulation DateTime; not the displayed game calendar"
                    },
                    ["relevantAssemblies"] = new JArray(AppDomain.CurrentDomain.GetAssemblies()
                        .Where(a => new[] { "Traffic", "BuildingUse", "RoadBuilder", "FindIt", "PlopTheGrowables", "CityPlanningDraft", "CitiesIIAgentBridge" }.Contains(a.GetName().Name))
                        .Select(a => new JObject { ["name"] = a.GetName().Name, ["version"] = a.GetName().Version.ToString(), ["status"] = "assembly_loaded_not_health_verified" })),
                    ["planning"] = new JArray("find_free_lots","corridor","grid_connectors","find_roadside_lots","coverage_gaps","traffic_hotspots","project","get_district_atlas","get_city_map","get_city_diagnostics","find_building_sites","preview_building","plan_neighborhood","execute_neighborhood","get_neighborhood_plan"),
                    ["simulation"] = new JArray("pause_for_analysis","simulate_step","get_simulation_step","cancel_simulation_step","cancel_batch","get_pause_state","get_ui_state","resolve_pause_blocker","quit_game","load_save"),
                    ["analysisPausesGame"] = true, ["snapshot"] = "non_pausing_cached_256_frames", ["events"] = "events.jsonl", ["prefabCosts"] = true, ["autoResolvePopups"] = true, ["nonPausingReads"] = new JArray(NonPausingReads), ["adaptiveTickMs"] = 15, ["roadPreview"] = true, ["placementErrorReasons"] = true,
                    ["construction"] = "native_preview_and_apply", ["controlEnabled"] = settings.AllowControl
                };
                case "get_snapshot": return GetSnapshot();
                case "find_free_lots": return FindFreeLots(args);
                case "corridor": return FindCorridor(args);
                case "grid_connectors": return GridConnectors(args);
                case "find_roadside_lots": return FindRoadsideLots(args);
                case "multi": return Multi(args);
                case "plan_grid": return PlanGrid(args);
                case "zone_area": return ZoneArea(args, false);
                case "zone_area_count": return ZoneArea(args, true);
                case "connected": return RoadsConnected(args);
                case "utility_check": return UtilityCheck(args);
                case "dev_tree": return DevTree(args);
                case "service_headroom": return ServiceHeadroom(args);
                case "get_metrics": return GetMetrics(args);
                case "purchase_dev_node": return PurchaseDevNode(args);
                case "network_ends": return NetworkEnds(args);
                case "pollution_sources": return PollutionSources(args);
                case "garbage_system": return GarbageSystem(args);
                case "building_upgrades": return BuildingUpgrades(args);
                case "outside_connections": return OutsideConnections(args);
                case "get_fees": return GetFees(args);
                case "create_line": return CreateLine(args);
                case "transit_lines": return TransitLines(args);
                case "remove_line": return RemoveLine(args);
                case "route_policy": return SetRoutePolicy(args);
                case "set_service_fee": return SetServiceFee(args);
                case "set_parking_fee": return SetParkingFee(args);
                case "get_policies": return GetPolicies(args);
                case "set_policy": return SetPolicyCommand(args);
                case "set_building_option": return SetBuildingOption(args);
                case "service_buildings": return ServiceBuildings();
                case "tile_options": return TileOptions(args);
                case "home_clusters": return HomeClusters(args);
                case "crime_map": return CrimeMap(args);
                case "notifications": return Notifications(args);
                case "transit_status": return TransitStatus(args);
                case "coverage_gaps": return CoverageGaps(args);
                case "traffic_hotspots": return TrafficHotspots(args);
                case "project": return Project(args);
                case "get_city_state": return CityState();
                case "get_pause_state": return PauseState();
                case "get_ui_state": return UiState(args);
                case "quit_game": return QuitGameAfterSave(args);
                case "load_save": return LoadSave(args);
                case "resolve_pause_blocker": return ResolvePauseBlocker(args);
                case "get_city_diagnostics": return Diagnostics(args);
                case "get_city_map": return CityMap(args);
                case "get_district_atlas": return DistrictAtlasPage(args);
                case "create_district": return DrawDistrict(args, false);
                case "edit_district": return DrawDistrict(args, true);
                case "set_service_districts": return SetServiceDistricts(args);
                case "find_building_sites": return FindBuildingSites(args);
                case "preview_building": args["previewOnly"]=true; return PlaceBuilding(args);
                case "plan_neighborhood": return PlanNeighborhood(args);
                case "execute_neighborhood": return ExecuteNeighborhood(args);
                case "get_neighborhood_plan": return NeighborhoodStatus(args);
                case "cancel_batch": return CancelBatch();
                case "pause_for_analysis": PauseAnalysis(); return Diagnostics(args);
                case "simulate_step": return BeginSimulation(args);
                case "cancel_simulation_step": return EndSimulation(args);
                case "get_simulation_step":
                    if(simulationOperation == null || (string)args["id"] != simulationOperation) throw new ArgumentException("simulation_step_not_found");
                    return ConstructionAccess.Status(simulationOperation);
                case "get_camera": RequireCity(); return CameraState();
                case "get_selected":
                {
                    World world = RequireCity();
                    var tools = world.GetExistingSystemManaged<ToolSystem>();
                    if (tools == null || tools.selected == Entity.Null) return new JObject { ["selected"] = null };
                    return new JObject { ["selected"] = Inspect(world, tools.selected) };
                }
                case "inspect_entity":
                {
                    var entity = Mod.CheckedEntity(RequiredInt(args, "index"), RequiredInt(args, "version"));
                    return Inspect(RequireCity(), entity);
                }
                case "get_water_facilities": return WaterFacilities();
                case "get_build_prefabs": return BuildPrefabs(args);
                case "get_prefab_details": return PrefabDetails(args);
                case "get_network": return Network(args);
                case "get_network_edges": return NetworkEdges(args);
                case "trace_network": return NetworkPath(args);
                case "upgrade_network": return UpgradeNetwork(args);
                case "road_option": return RoadOption(args);
                case "junction_info": return JunctionInfo(args);
                case "purchase_tiles": return PurchaseTiles(args);
                case "get_zone_cells": return ZoneCells(args);
                case "build_road": RequireControl(); return StartRoad(args);
                case "build_network": RequireControl(); return StartRoad(args);
                case "place_building": return PlaceBuilding(args);
                case "relocate_building": if (args["moveIndex"] == null) throw new ArgumentException("moveIndex_required"); return PlaceBuilding(args);
                case "demolish": return Demolish(args);
                case "get_city_management": return CityManagement();
                case "get_services": return Services(args);
                case "set_tax": return SetTax(args);
                case "set_service_budget": return SetServiceBudget(args);
                case "sample_terrain": return Terrain(args);
                case "get_tiles": return Tiles();
                case "get_buildings": return Buildings(args);
                case "diagnose_connections": args["problemsOnly"] = true; return Buildings(args);
                case "save_checkpoint": return SaveCheckpoint(args);
                case "batch_execute": return StartBatch(args);
                case "get_batch": return BatchStatus(args);
                case "zone_rectangle": RequireControl(); return StartZone(args);
                case "clear_zoning": RequireControl(); args["dezone"] = true; return StartZone(args);
                case "get_operation": return ConstructionAccess.Status((string)args["id"]);
                case "set_camera": return SetCamera(args);
                case "set_simulation_speed":
                {
                    World world = RequireCity();
                    RequireControl();
                    float speed = RequiredFloat(args, "speed");
                    if (speed != 0 && speed != 1 && speed != 2 && speed != 4)
                        throw new ArgumentException("speed must be 0, 1, 2, or 4");
                    var simulation = world.GetExistingSystemManaged<SimulationSystem>();
                    if (simulation == null) throw new InvalidOperationException("simulation_unavailable");
                    if(SimulationRunning) FinishSimulation("speed_changed");
                    if(speed!=0 && (ConstructionAccess.Active!=null || (string)batch?["status"]=="running")) throw new InvalidOperationException("finish_construction_before_resuming");
                    float previous = simulation.selectedSpeed;
                    simulation.selectedSpeed = speed;
                    return new JObject { ["previousSpeed"] = previous, ["selectedSpeed"] = simulation.selectedSpeed };
                }
                default: throw new ArgumentException("unknown_command");
            }
        }

        private JObject CityState()
        {
            World world = RequireCity();
            var city = world.GetExistingSystemManaged<CitySystem>();
            var config = world.GetExistingSystemManaged<CityConfigurationSystem>();
            var simulation = world.GetExistingSystemManaged<SimulationSystem>();
            var time = world.GetExistingSystemManaged<TimeSystem>();
            if (city == null || city.City == Entity.Null || !world.EntityManager.Exists(city.City))
                throw new InvalidOperationException("city_entity_unavailable");
            var em = world.EntityManager;
            JObject result = new JObject
            {
                ["cityName"] = config?.cityName, ["money"] = city.moneyAmount,
                ["xp"] = city.XP, ["simulationFrame"] = simulation?.frameIndex,
                ["selectedSpeed"] = simulation?.selectedSpeed,
                ["date"] = time?.GetCurrentDateTime().ToString("O"),
                ["dateMeaning"] = "Raw simulation DateTime; displayed game calendar may differ",
                ["controlEnabled"] = settings.AllowControl, ["citySession"] = citySession
            };
            if (em.HasComponent<Population>(city.City))
            {
                var population = em.GetComponentData<Population>(city.City);
                result["population"] = population.m_Population;
                result["populationWithMoveIn"] = population.m_PopulationWithMoveIn;
                result["averageHappiness"] = population.m_AverageHappiness;
                result["averageHealth"] = population.m_AverageHealth;
            }
            return result;
        }

        private static CameraController Camera()
        {
            if (!CameraController.TryGet(out var camera) || camera == null)
                throw new InvalidOperationException("camera_unavailable");
            return camera;
        }

        private static JObject CameraState()
        {
            var camera = Camera();
            return new JObject
            {
                ["pivot"] = Vector(camera.pivot), ["position"] = Vector(camera.position),
                ["angle"] = new JArray(camera.angle.x, camera.angle.y), ["zoom"] = camera.zoom
            };
        }

        private JObject SetCamera(JObject args)
        {
            RequireCity();
            RequireControl();
            var camera = Camera();
            var before = CameraState();
            // Validate all supplied values before changing anything.
            Vector3 pivot = camera.pivot;
            if (args["pivot"] is JObject p)
            {
                pivot = new Vector3(RequiredFloat(p, "x"), RequiredFloat(p, "y"), RequiredFloat(p, "z"));
                if (Math.Abs(pivot.x) > 15000 || Math.Abs(pivot.z) > 15000 || pivot.y < -1000 || pivot.y > 5000)
                    throw new ArgumentException("pivot_out_of_bounds");
            }
            float zoom = args["zoom"] == null ? camera.zoom : RequiredFloat(args, "zoom");
            var range = camera.zoomRange;
            if (zoom < range.min || zoom > range.max) throw new ArgumentException("zoom_out_of_range");
            camera.pivot = pivot;
            camera.zoom = zoom;
            return new JObject { ["before"] = before, ["after"] = CameraState(), ["note"] = "Controller target updated; rendering may interpolate on subsequent frames." };
        }

        private JObject WaterFacilities()
        {
            World world = RequireCity();
            var em = world.EntityManager;
            using (var query = em.CreateEntityQuery(new EntityQueryDesc
            {
                Any = new[] { ComponentType.ReadOnly<Game.Buildings.WaterPumpingStation>(), ComponentType.ReadOnly<Game.Buildings.SewageOutlet>() },
                None = new[] { ComponentType.ReadOnly<Game.Common.Deleted>(), ComponentType.ReadOnly<Game.Tools.Temp>() }
            }))
            using (var entities = query.ToEntityArray(Allocator.Temp))
            {
                var items = new JArray();
                for (int i = 0; i < entities.Length && i < 128; ++i) items.Add(Inspect(world, entities[i]));
                return new JObject { ["total"] = entities.Length, ["truncated"] = entities.Length > 128, ["facilities"] = items };
            }
        }

        private static JObject Inspect(World world, Entity entity)
        {
            var em = world.EntityManager;
            if (entity == Entity.Null || !em.Exists(entity)) throw new InvalidOperationException("entity_not_found_or_stale");
            JObject result = new JObject { ["index"] = entity.Index, ["version"] = entity.Version };
            var prefabs = world.GetExistingSystemManaged<PrefabSystem>();
            if (prefabs != null && em.HasComponent<PrefabRef>(entity))
            {
                var prefab = em.GetComponentData<PrefabRef>(entity);
                result["prefab"] = prefabs.GetPrefabName(prefab.m_Prefab);
            }
            if (em.HasComponent<Game.Objects.Transform>(entity))
            {
                var transform = em.GetComponentData<Game.Objects.Transform>(entity);
                result["position"] = Vector(transform.m_Position);
                result["rotationQuaternion"] = new JArray(transform.m_Rotation.value.x, transform.m_Rotation.value.y, transform.m_Rotation.value.z, transform.m_Rotation.value.w);
            }
            if (em.HasComponent<Game.Net.Node>(entity)) result["position"] = Vector(em.GetComponentData<Game.Net.Node>(entity).m_Position);
            using (var types = em.GetComponentTypes(entity, Allocator.Temp))
                result["components"] = new JArray(types.Select(t => t.GetManagedType().FullName));
            if (em.HasComponent<Game.Buildings.WaterConsumer>(entity))
            {
                var w = em.GetComponentData<Game.Buildings.WaterConsumer>(entity);
                result["waterConsumer"] = new JObject
                {
                    ["wantedConsumption"] = w.m_WantedConsumption, ["fulfilledFresh"] = w.m_FulfilledFresh,
                    ["fulfilledSewage"] = w.m_FulfilledSewage, ["pollution"] = w.m_Pollution, ["flags"] = w.m_Flags.ToString()
                };
            }
            if (em.HasComponent<Game.Buildings.WaterPumpingStation>(entity))
            {
                var w = em.GetComponentData<Game.Buildings.WaterPumpingStation>(entity);
                result["waterProducer"] = new JObject { ["capacityRaw"] = w.m_Capacity, ["lastProductionRaw"] = w.m_LastProduction, ["pollution"] = w.m_Pollution };
            }
            if (em.HasComponent<Game.Buildings.SewageOutlet>(entity))
            {
                var w = em.GetComponentData<Game.Buildings.SewageOutlet>(entity);
                result["sewageOutlet"] = new JObject { ["capacityRaw"] = w.m_Capacity, ["lastProcessedRaw"] = w.m_LastProcessed, ["lastPurifiedRaw"] = w.m_LastPurified };
            }
            return result;
        }

        private static JObject Vector(Vector3 value) => new JObject { ["x"] = value.x, ["y"] = value.y, ["z"] = value.z };
        private static JObject Vector(float3 value) => new JObject { ["x"] = value.x, ["y"] = value.y, ["z"] = value.z };
        private static int RequiredInt(JObject value, string key)
        {
            if (value[key]?.Type != JTokenType.Integer) throw new ArgumentException("integer_required: " + key);
            return (int)value[key];
        }
        private static float RequiredFloat(JObject value, string key)
        {
            if (value[key]?.Type != JTokenType.Float && value[key]?.Type != JTokenType.Integer)
                throw new ArgumentException("number_required: " + key);
            float number = (float)value[key];
            if (float.IsNaN(number) || float.IsInfinity(number)) throw new ArgumentException("finite_number_required: " + key);
            return number;
        }
    }
}
