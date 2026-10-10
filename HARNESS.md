# Cities II Agent Harness: how it works

## 1. What this is

- An agent harness plus mod extensions that let an AI agent play Cities: Skylines II through a local file mailbox.
- Built on [FTPAiYT/cities2-agent-bridge-ndc](https://github.com/FTPAiYT/cities2-agent-bridge-ndc); the bridge DLL and base commands come from upstream.
- Windows only, PowerShell 7. No network listener: everything goes through `%LOCALAPPDATA%\CitiesIIAgentBridge`.
- Mod version reported by this fork: `0.5.1-local` (upstream release is 0.5.0).

## 2. Architecture

```
 Agent (LLM with MCP client or shell)
   |                                        |
   |  cs2 MCP server (mcp\src\server.ts)    |  play.ps1 / autoplay.ps1 / grid.ps1 / services.ps1 / run-session.ps1 / upgrade.ps1
   |  city logic (city.ts, services.ts)     |  (manual debugging; MCP runs
   |  mailbox client (mcp\src\bridge.ts)    |   save, restart, quit here)
   |  calls the mod directly                v
   |                                  lib\BridgeClient.psm1   (Invoke-Bridge, paging, batching, occupancy raster, rolling saves)
   |                                        |
   |                                        v
   |                                  bridge.ps1 <command> -ArgsJson {...}     writes  requests\<id>.json
   |                                        |                                  reads   responses\<id>.json
   v                                        v
 %LOCALAPPDATA%\CitiesIIAgentBridge\  (requests\  responses\  session.json  STOP latch  events.jsonl)
   ^
   |  Mod.Tick adaptive: ~15 ms busy, 100 ms idle (game main thread) -> Mailbox.Pump -> Dispatch(command)
   v
 CitiesIIAgentBridge.dll (in game)  ->  ECS systems, tools, UI state, game settings
```

- **Two entry paths.** The cs2 MCP server (section 4b) calls the mod directly through `mcp\src\bridge.ts`, with the city logic in `city.ts` and `services.ts`. Only `save`, `restart` and `quit` still run `play.ps1` or `upgrade.ps1` as child processes; `build_grid` and `grow` do so only with `legacy: true` (timing comparison). `buy_tile` is native (`tile_options`, price preview). Both paths use the same protocol and files.

- **Request/response.** The client writes one compact JSON request and waits for a response with the same id. Every response is `{ok, result | error}`; always check `ok`.
- **Async work.** Construction, batches and simulation return `status: queued`. Poll `get_operation`, `get_batch` or `get_simulation_step`. `queued` only means accepted.
- **Heartbeat.** The mod rewrites `session.json` with `heartbeatUtc`. The client refuses to send if the heartbeat is more than 10 s old or the status is not `ready`.
- **16 KB limit.** The mod rejects any request file over 16384 bytes with `request_too_large`, applying nothing. The client keeps requests under 15000 bytes and refuses to send bigger ones.
- **Analysis pauses the game.** With controls on, every non-status command pauses the city first (`analysisPausesGame`). With controls off, the game must already be at speed 0 or the command fails with `pause_game_before_analysis_or_enable_bridge_controls`. Status polls (`ping`, `get_capabilities`, `get_snapshot`, `get_operation`, `get_batch`, `get_simulation_step`, `get_pause_state`, `get_ui_state`, `resolve_pause_blocker`, `load_save`, `quit_game`) do not pause.
- **Controls.** Mutations need the in-game checkbox "Allow local bridge controls" (`RequireControl`). It resets off on every city load unless `KeepControlsAcrossLoads` is on.
- **STOP latch.** `bridge.ps1 stop` writes a `STOP` file. While it exists the mod refuses control and clears the checkbox. Do not remove it without the owner's permission.

## 3. Components

| file | role | key behaviours |
|---|---|---|
| `play.ps1` | manual front end (MCP calls it only for `legacy: true` and `save`, `restart`, `quit`) | Verbs: `look`, `ui`, `fix`, `sites`, `grid`, `buy`, `grow`, `zone`, `run`, `link`, `place`, `save`, `prefab`, `raw`, `help`. Terse output; `raw` strips noisy fields unless `-Full`. `grow` picks the zone by demand (res, resmed, com, ind, off (office); needs demand >= 20 and an unlocked prefab; `-Zone` overrides; reads unemployment from `get_snapshot`) and steps the grid down 3x2 -> 2x2 -> 2x1 -> 1x1 when land is short. `Find-Sites` calls the mod's `find_free_lots` (PowerShell raster only on mods without it); `place` calls `find_roadside_lots`, then `find_building_sites` if that finds nothing. Grow plan takes ~20 s instead of minutes. |
| `autoplay.ps1` | growth loop | Per cycle: wait for the road tool to clear, `grow -BuyTiles` if residential/commercial demand >= 50 and cash > floor + 150k, `services.ps1` every 3rd cycle, `run` for 120 s, budget autopilot. Stops on `STOPPED` from `run`, or on a milestone with `-UntilMilestone`. Ends with `save`. |
| `grid.ps1` | road grid builder | World-aligned grid (110 m blocks, max 62 roads). Adds four 64 m outward stubs (`-NoStubs` disables). Connector from the nearest existing road node, up to 400 m, found by the mod's `grid_connectors` (PowerShell raster fallback on older mods) and validated with `plan_neighborhood`. Native pre-flight of each road (`build_road previewOnly`) when capability `roadPreview` exists; rejected stubs are dropped, a lost connector is rebuilt from another candidate. Executes with `execute_neighborhood` (before/after saves), then zones and checks connectivity by graph search. `-PlanOnly` changes nothing. `-AllowDemolition` may remove one house to open a street. Connector fallback drops stale edge ids (`stale_point_entity`) and retries with native snapping. |
| `zone-fill.ps1` | zoning | Zones only `Visible`, unzoned cells, one block-attached rectangle per block. Blocked duplicate cells are skipped. Verifies with a re-read of cells, not operation claims. `-WhatIf` is read-only. |
| `run-session.ps1` | bounded simulation | Chains `simulate_step` (max 50 s each, speed <= 4) to `-TotalSeconds`. Logs to `journals\run-session.jsonl`. Shortage triage: continues while only `_shortfall` issues exist and the count is not rising for 3 steps. `-ResolveTutorials` clears tutorial, milestone and signature popups (max 10). Stops paused, with a reason, on anything else. |
| `services.ps1` | basic services | Escalated needs first: snapshot `needs` with action `build` (chirps, tutorial cards, notification icons, dead or sick citizens) are built ahead of growth, overriding the cash floor and upkeep discipline, with a 10-minute cooldown per service (`journals\services-escalation.json`). Then per service (prefab regex) it reads the mod's `coverage_gaps` where a rule has a coverage category, plus utility capacity, and places via `play.ps1 place`. Cash floor `-MinCash` 250000: below it only power, water, sewage and escalated needs are built. `-MaxPlacements` and `-Plan` are available. |
| `upgrade.ps1` | unattended restart | Saves and waits for `complete`; `quit_game` (refused unless the named save is < 5 min old); waits up to 3 min for exit, never kills; optional `-Build` runs package and tests; installs with hash check. `-QuitOnly` saves and quits without installing or launching. Starts `Cities2.exe -continuelastsave`. Calls `load_save` from the main menu (newest `CitiesIIAgentBridge-autosave-*`); waits up to 600 s for the city, then prints the display mode reported by the mod. |
| `lib\BridgeClient.psm1` | client library | `Invoke-Bridge` (throws on `ok:false`), `Get-BridgePaged` (follows `nextOffset`), `Wait-BridgeOperation`, `Wait-BridgeBatch`, `Invoke-BridgeSteps` (chunks to 15000 bytes and 64 steps; resumes past proven no-op zoning errors only), `Invoke-BridgeRoad` (on rejection, inspects the blocker and retries perpendicular offsets), `Get-BridgeRoadGraph` / `Find-BridgeNearestNode` / `Test-BridgeNodesConnected` (local connectivity), `Resolve-BridgePrefab` (name to index, cached per city session in `journals\prefab-cache.json`), `Get-BridgeOccupancy` plus the `Test-Occupancy*` functions (4 m raster from real lot rectangles and road chords), `Clear-BridgeRollingSaves` (keeps newest; never touches `keep-*` or the owner's own saves; recycles to the Recycle Bin). |
| `grid.ps1` header | builder contract | Documents the plan-then-execute order and the `-PlanOnly` guarantee. Read it before changing the grid flow. |
| `bridge.ps1` | raw client | Single-command client: `bridge.ps1 <command> -ArgsJson '{...}'`; also `stop`. Reads responses with shared delete access and retries on sharing violations. Journals events when `journals\active.json` exists. |
| `gen-commands.mjs` | generator | Writes `commands.json` and the `bridge.ps1` ValidateSet (line 2) from the `switch (command)` in `DispatchCore` (src/Mod.cs), 75 commands. `--check` prints differences and exits 1 if either file is stale. A harness test checks it. |
| `journal.ps1`, `advance.ps1`, `export-*.ps1`, `view-map.html` | optional | Visible progress journal, bounded advance helper, map and atlas exports. Not needed to play. |

Selected helpers used by `play.ps1`:
- `Find-Sites` ranks empty, owned, dry, flat land (9 terrain samples per candidate; reject water or > 25 m relief) by link length, clear link, and land-use distances (pollution, industry, jobs, homes, highway).
- `Invoke-BuyTiles` buys adjacent unowned tiles that score best on dryness, relief and distance to the city.
- `link` builds a Medium Road corridor from an existing road that crosses no lot, checked by the game's own preview. `-Demolish N` may clear up to N residential, commercial, industrial or office lots.
- `place` uses `find_building_sites`; for lots of 64 cells or more it slides along nearby road edges on the occupancy raster instead.

## 4. Mod extensions (0.5.1-local)

Commands added by this fork (upstream commands are documented in COMMANDS.md).

- **Adaptive tick** (`Mod.Tick`). About every 15 ms while busy (a request was served in the last 3 s, or an operation, batch or save is in flight), 100 ms idle. The heartbeat is still written every 250 ms. Capability `adaptiveTickMs: 15`.
- **Compact responses.** Batch option `compact: true` returns only failed step results, so polls stay small (`Workflow.cs`).
- **Non-pausing reads** (`Mod.NonPausingReads`): `multi`, `find_free_lots`, `grid_connectors`, `find_roadside_lots`, `corridor`, `coverage_gaps`, `traffic_hotspots`, `project`, `plan_grid`, `connected`, `service_buildings`, `zone_area_count`, `get_city_state`, `get_city_management`, `get_services`, `get_prefab_details`, `get_build_prefabs`, `get_tiles`, `sample_terrain`. The status commands (`get_snapshot`, `get_ui_state`, `get_operation`, `get_batch`) are also non-pausing.
- **`multi`** `{commands:[{command, args}]}`: 1-16 non-pausing reads in one mailbox round trip. Any other command is refused (`multi_allows_non_pausing_reads_only`).
- **`plan_grid`** `{x, z, cols, rows, road}`: read-only grid plan with bounds. `build_grid` reads it first.
- **`zone_area`** `{x0, z0, x1, z1, zone, margin?}`: zones every Visible unzoned cell in one frame by writing the cells directly and tagging their blocks `Updated` (`FastBuild.cs`). `tool: true` uses the per-block tool path instead (~10 frames per block).
- **`zone_area_count`**: the same scan with nothing changed.
- **`connected`** `{a: {x, z}, b: {x, z}}`: local reachability of two road nodes (returns `connected`, `reachable`, node distances).
- **`service_buildings`**: placed service buildings (non-pausing).
- **Batch options** `compact` and `continueOnBenign`: with `continueOnBenign`, a `no_zone_cells_in_rectangle` step is counted as `noop` and does not stop the batch (`Workflow.cs`).

Added 2026-10-10 (mod side):
- **`notifications`** `{type?, top?}` (`src/Notifications.cs`, non-pausing): on-map icon counts by type, each with the action it asks for; positions and owners for one type. The owner is walked up from the lane to the road or building. Icons outside owned tiles are ignored. `notification` events fire when a type appears or grows.
- **Snapshot `icons`, `jams`, `happiness`, `happinessPriority`.** `icons` counts notification icons; `jams` lists traffic bottleneck icons; `happiness` holds the factor values; `happinessPriority` holds the tag per factor.
- **Needs carry `factor` and `priority`.** `factor` is the happiness factor value. `priority` uses the owner thresholds in `ServiceSignals.cs` (`FactorPriority`): worse than -5 `very_high`, worse than -3 `priority`, otherwise `normal`. The Tax factor is exempt.
- **Non-pausing reads** added to `NonPausingReads`: `home_clusters`, `crime_map`, `tile_options`, `notifications`.
- **`purchase_tiles` `previewOnly`**: returns the price and upkeep without buying.
- **`zone_area` `replace`**: zones over existing zoning when set (`FastBuild.cs`).
- **Dispatch rollback** (`Mod.cs`): a command that throws after claiming the operation slot finishes as `setup_failed` and the default tool is restored (FAILURES #56).
- **`CheckedEntity`** (`Mod.CheckedEntity`): every caller-supplied entity id is range-checked before EntityManager (FAILURES #57).
- **Snap masks** (`Construction.cs`): the bridge road tool initialises `m_SnapOnMask` and `m_SnapOffMask` from `GetAvailableSnapMask` before `SnapControlPoints` (FAILURES #55).
- **`cancel_simulation_step`** takes the operation `id`. If an id is sent, the mod refuses it unless it matches the running step (`SimulationControl.cs`). An id-less cancel is not checked. The MCP client always sends the id (FAILURES #54).
- **`get_network`** pages with `total` and `nextOffset`; no silent cap (FAILURES #58).
- **`transit_status`** `{type?}` (default Bus; `src/Transit.cs`; non-pausing; also reachable through `query`): passenger line, stop and depot prefabs of the type with lock state and costs, what is placed (depots, stops, lines), and `ready` and `next` flags. A Bus Line stays locked after a depot is built (FAILURES #69).

- **`get_ui_state`** (args: `chirps` 0-10, default 3). Returns `selectedSpeed`, `hasFocus`, `pausedBarrierObservers`, `screen`, `menuActive`, `activePanel`, `tutorial` {`enabled`, `activeTutorial`, `activeTutorialPhase`, `phaseKind`, `phaseText`, `introUnfinished`}, `milestone` {`pending`, `pendingReward`, `pendingText`, `achieved`, `xp`, `nextXp`, `xpToNext`, `blockedBy`}, `signatures.pending[]` {`name`, `text`}, `dialogs`, `activeTool`, `infoview`, `chirps`, `likelyBlocker`, `resolvableByBridge`, `errors[]`. Each probe is isolated, so a renamed game member shows in `errors` instead of failing the call. `likelyBlocker` is one of: `error_dialog`, `menu_screen`, `milestone_popup`, `signature_popup`, `tutorial_phase`, `unknown_ui_panel`, `window_not_focused`, `paused_by_player_or_bridge`, `none`. `milestone.blockedBy = tutorial_intro` means milestones are held.
- **`get_pause_state`.** The pause-only subset of the same probes (speed, focus, barrier observers, tutorial, `likelyBlocker`).
- **`resolve_pause_blocker`** (`action` plus a guard):
  - `complete_tutorial_phase` requires `expectedPhase`.
  - `dismiss_milestone` requires `expectedMilestone`.
  - `dismiss_signature` requires `expectedSignature`.
  - `complete_tutorial_intro` releases milestones; fails if the intro is already complete.
  - Error dialogs and menus are reported and never dismissed. A guard mismatch fails with `*_changed`.
- **`build_road` with `previewOnly: true`.** Runs the game's own placement check without applying. Result has `previewCost` and, on rejection, `placementErrors[].reasons` (game `ToolErrorData` names, such as `SteepSlope`, `InWater`, `ExceedsCityLimits`). Gated by capabilities `roadPreview` and `placementErrorReasons`.
- **`quit_game`.** At the main menu: quits with no save needed. In a city: requires `afterSave` = name of a `.cok` written in the last 5 min; otherwise refuses. Calls the game's quit; never kills the process.
- **`load_save`.** Main menu only (`load_save_only_from_main_menu`). Loads an exact `name`, or the newest save whose name starts with `prefix` (default `CitiesIIAgentBridge-autosave-`). Needed because CS2's Continue and `-continuelastsave` do not pick up bridge saves.
- **`KeepControlsAcrossLoads` setting** (`ModsSettings/CitiesIIAgentBridge`, default off). When on, "Allow local bridge controls" survives city loads and game restarts. Any local program that can write the mailbox can then change the city. The STOP latch still wins.
- **`get_capabilities`** flags relevant here: `roadPreview`, `placementErrorReasons`, `analysisPausesGame: true`, `construction: native_preview_and_apply`, `controlEnabled`, `snapshot`, `events`, `prefabCosts`.
- **`get_snapshot`** (no args; non-pausing, in the `statusOnly` list of `Mod.Dispatch`). Rebuilt on the game main thread from `Tick` every ~256 simulation frames, or every 5 s while paused. The command returns the cache plus `ageFrames`, `ageSec`, `liveFrame`, `liveSpeed`. About 1.5-1.7 KB; build cost about 2 ms (`perfMs`). Fields:
  - `v`, `frame`, `speed`, `utc`, `happy`, `health`; `city` {`name`, `money`, `pop`, `moveIn`, `net`}; `income` / `expense` (top 5 sources each); `tax` {R, C, I, O}.
  - `demand` {rL, rM, rH, c, i, o}; `demandWhy` (2 most negative native demand factors for rL, c, i, o); `worstHappy` (3 worst happiness factors).
  - `jobs` {unemp %, homeless, workers, eligible, jobs, vacant, vacantByEdu[5], eduCitizens[5]}.
  - `util` {power {prod, use, met, pct, import, export, plantCap}, water {cap, use, pct}, sewage {cap, use, pct}}.
  - `shortages` (persistent, by type); `servicePenalties` {buildings, byFactor}; `buildings` {total, building, abandoned, condemned, onFire}.
  - `ui` {blocker, fixable, tutorial?, milestonePopup?, signatures?, dialog?, tool?, focus}; `milestone` {achieved, xp, nextXp, blockedBy?}; `chirps` (3, 90 chars each).
  - `bytes`, `perfMs`, `errors[]`. A failed probe lands in `errors[]` instead of throwing.
- **`events.jsonl`** under `%LOCALAPPDATA%\CitiesIIAgentBridge`, rotated to `events.1.jsonl` at 1 MB. One compact line `{seq, type, frame, utc, data}`. Types:
  - `city_loaded`, `city_unloaded`, `milestone`, `milestone_popup`, `tutorial`, `signature`.
  - `ui_blocker` (error_dialog, menu_screen, unknown_ui_panel).
  - `net_negative` / `net_positive` (throttled 2048 frames); `utility_high` (> 90%) / `utility_ok` (< 85%).
  - `shortage` (new type); `fire` (new burning building, with prefab, x, z); `abandoned` / `condemned` (count rising, throttled 4096 frames).
  - `seq` restarts with each game process, so filter by `utc` (the `since` argument of the MCP `events` tool).
- **`get_prefab_details` costs.** `costs` {`construction`, `monthlyUpkeep` (ServiceUpkeepData money), `consumptionUpkeep` (ConsumptionData `m_Upkeep`), `netUpkeep` for networks}.

- **Phase 2 queries** (all computed in C#; each pauses the game like other analysis commands). Measured: `find_free_lots` 120-480 ms, `grid_connectors` 59 ms for 1,245 links, `corridor` 28-78 ms, `coverage_gaps` 1-15 ms, `traffic_hotspots` 5 ms, `project` under 10 ms.
  - `find_free_lots` {width, depth, count?, zone?, x?, z?, radius?, step?, margin?, maxLink?}: owned, dry, flat (relief <= 25 m) rectangles ranked by link to a lot-free road and by land use. Returns `sites[]` (x, z = min corner, link, clearLink, relief, pollution, distances, score, connector) and rejected counts.
  - `grid_connectors` {x0, z0, x1, z1, maxLength?, top?, halfWidth?}: shortest lot-free links from existing non-highway roads to points around a grid's perimeter. Returns `links[]` (from edge index, version, t; to; d).
  - `find_roadside_lots` {prefab | width+depth, x, z, radius?, count?}: rotated lot positions beside a road, clear of lots, roads and unowned land. Returns `candidates[]` (position, rotation, roadEdge) to pass to `place_building`.
  - `corridor` {from{x,z}, to{x,z}, halfWidth?}: lot-free route on owned land, straight when possible, otherwise waypoints (up to 4 km). Returns `straight`, `found`, `waypoints`, `length`, `segments`.
  - `coverage_gaps` {service, threshold?, cell?, top?}: native service coverage at each home's road position. Returns the uncovered share, percentiles, `gapClusters` (densest first) and existing `facilities`. Services: Healthcare, FireRescue, Police, Park, PostService, Education, EmergencyShelter, Welfare.
  - `traffic_hotspots` {top?, minLength?}: road edges with the lowest native traffic flow (flowPct 100 = free flow), plus mean and city flow.
  - `project` {actions: [{prefab, count?} | {zone, cells}]}: construction, monthly upkeep, zone income when built and projected net per period, using the live tax per occupied cell. Roads and tile upkeep are not included.
- **Snapshot `needs`** (per service: deathcare, health, fire, school, ...): `chirps` (among the 10 newest), `tutorial` (a card asks for it), `icons`, `iconRise` (streak of rising icon counts, max 3), `dead`, `sick`, `score` ("n/3") and `action`. Score = chirps + 1 for a tutorial card + icon-rise streak (max 3) + 1 for any dead or sick citizen (2 at 10 or more) + 1 for 10 or more standing notification icons (`ServiceSignals.NeedScore`, FAILURES #45). Score >= 3 gives `action` `build`; `services.ps1` builds those first. The MCP planner (`services.ts`) also escalates on >= 10 icons or >= 20 dead/sick without chirps. `iconsTop` lists the most common notification icons. `factor` and `priority` (see section 4, added 2026-10-10) tie the need to its happiness factor. Sources: `src/ServiceNeeds.cs`, `src/ServiceSignals.cs`.
- **AutoResolve** (`src/AutoResolve.cs`): while bridge controls are on, tutorial, milestone and signature popups, and intro-held milestones, are resolved on the main thread from a fresh UI read. Events `auto_resolved` and `auto_resolve_failed` (the first 3 failures are logged; retries slow to every 30 s after that). Error dialogs and menus are never resolved.
- **`session.json` `display`**: Unity's `Screen.fullScreenMode` and resolution at each heartbeat (`ExclusiveFullScreen`, `FullScreenWindow`, `MaximizedWindow` or `Windowed`). `upgrade.ps1` reads it after a launch.

## 4b. MCP server (cs2)

Typed tool layer for agents. Code in `mcp\`: `src\server.ts` (tools), `src\bridge.ts` (mailbox client).

- **Setup.** Node >= 22.18 (native TypeScript type stripping, no build step). `cd mcp; npm install` (`@modelcontextprotocol/sdk` 1.32.1, `zod` 3). Registered in `.mcp.json` at the repo root (`command` node, `args` `mcp/src/server.ts`). `CS2_MAILBOX` overrides the mailbox folder.
- **Protocol** (copies `bridge.ps1`): session.json heartbeat <= 10 s and status `ready`; request written as `.tmp` then renamed; response polled every 12 ms (`POLL_MS`) and deleted after reading; 15000-byte client limit (mod 16384); culture-safe manual ISO parse; never resends a mutation after a timeout.
- **Tools (36): 33 in `server.ts`, plus `timings` (`timing.ts`), `happiness` (`happiness.ts`) and `tax_autopilot` (`taxes.ts`).** Every tool except `snapshot`, `events`, `ui`, `fix_popup`, `run`, `run_status`, `timings`, `happiness`, `notifications` and `quit` first clears popups (`ensureClear`); `tax_autopilot` does not yet (open issue in FAILURES.md).

| tool | args | does | pauses |
|---|---|---|---|
| `snapshot` | brief? | cached city state (section 4); `brief: true` returns only the decision fields (~1/3 of the tokens) | no |
| `events` | since (cursor `session:seq` or ISO UTC), limit (1-200), types | page of events.jsonl after the cursor; `hasMore`; `gap` when the sequence jumps | no |
| `ui` | none | speed, blocker, popups, tool, chirps | no |
| `fix_popup` | none | dismisses milestone, signature and tutorial popups | yes |
| `run` | seconds (1-1800), speed (1, 2, 4), cashFloor, background, stopOnNewShortage (background only) | bounded simulate loop; one summary line. `background: true` returns at once and keeps simulating for `seconds` while you plan (`seconds: 0` stops it); `cashFloor` stops the run when cash falls below it; `stopOnNewShortage` stops after three steps in a row end on a new utility shortage | yes; foreground ends paused |
| `run_status` | none | background state, remainingSec, lastStop, mutating, simSharePct (sim seconds / wall seconds), bridgeCalls, avgCallMs | no |
| `timings` | since? | per-tool calls, avg, p50, max, slowest; from `journals/mcp-timings.jsonl` (`CS2_TIMINGS` overrides the path) | no |
| `build_grid` | x, z, cols, rows, zone, plan, legacy | `city.ts`: `plan_grid`, one road per grid line, direct zoning, connector check. `legacy: true` runs `play.ps1 grid` (timing comparison only) | yes |
| `grow` | zone, cols, rows, plan, buyTiles, legacy | picks zone and site with `find_free_lots`, then builds as `build_grid`; `legacy` as above | yes |
| `link` | x, z, road, max, plan | `grid_connectors`, then one road build | yes |
| `zone` | x, z, radius, zone | `zone_area` (direct cell write); `tool: true` fallback (free) | yes |
| `place_service` | prefab, x, z, radius, maxCost, plan | places an exact building prefab (`find_roadside_lots` for large lots); maxCost defaults to max(150000, 1.2 x construction); plan shows costs | yes |
| `prefabs` | filter, kind, limit, costs | prefab search with construction and upkeep (`get_build_prefabs`, `get_prefab_details`) | no |
| `set_tax` | area, rate, ownerSaid | tax rate for R, C, I or O; refused outside the owner pin unless `ownerSaid=true` | yes |
| `tax_autopilot` | apply (optional) | reads rates (live `get_city_management`), demand, unemployment; with `apply=true` takes one step inside the owner pins; returns rates, tax income, net, cash and the Tax factor | only with `apply=true` |
| `set_service_budget` | service, budget (50-150) | budget by exact or unique partial name | yes |
| `services` | none | name, budget, buildings (array length), workers, workplaces | no |
| `fix_services` | maxPlacements (1-4), plan | `services.ts` planner: builds escalated needs, coverage gaps and utility capacity before growth; large lots via the roadside finder | yes |
| `buy_tile` | n (1-3), max (default 300000), x, z, plan | native: `tile_options` picks dry, flat adjacent tiles nearest the city or to x,z; price and upkeep previewed before buying | yes |
| `save` | none | `play.ps1 save` (PowerShell) | yes |
| `restart` | build, noInstall | `upgrade.ps1` (PowerShell): save, quit, relaunch, load newest autosave | yes |
| `upgrade_road` | index, version, road, maxCost | replaces one road edge (index/version from traffic_hotspots) with another road prefab via `upgrade_network`; returns cost and placement reasons | yes |
| `quit` | none | verified rolling save, then clean quit (`upgrade.ps1 -QuitOnly`); never force-kills | yes |
| `query` | command (read-only allow-list), args, fields (dot paths, max 20), offset, limit, maxChars | raw read; always valid JSON (projected, paged, or a shape summary) | yes |
| `free_lots` | width, depth, count, zone, x, z, radius, step, margin, maxLink | `find_free_lots` (section 4) | no |
| `roadside_lots` | prefab, x, z, radius, count | `find_roadside_lots` | no |
| `corridor` | fromX, fromZ, toX, toZ, halfWidth | `corridor` | no |
| `coverage_gaps` | service (enum), threshold, cell, top | `coverage_gaps` | no |
| `traffic_hotspots` | top, minLength | `traffic_hotspots` | no |
| `project` | actions: [{prefab, count} or {zone, cells}] | `project`: cost, upkeep and net per period before building | no |
| `happiness` | none | factors worst first with the owner's tags, the mapped fix, the trend since the first record, actions taken and a verdict (see below) | no |
| `notifications` | type?, top (1-100) | on-map icon counts by type with the action each asks for; positions and owners for one type | no |
| `clear_ruins` | max (1-30), plan | bulldozes burned-down or collapsed buildings from their icons so the lots rebuild; `plan` lists them; logs the action | yes |
| `fix_traffic` | max (1-8), flowBelow (1-90), plan | acts on traffic jam icons (`fixJams`) and widens the most congested Small Roads to Medium Road from native flow; reports hotspots it cannot fix (ramps, roads already Medium); logs the action | yes |
| `build_arterial` | fromX, fromZ, toX, toZ, road (default Medium Road), plan | road from a point on the network to a target along the lot-free corridor; every segment previewed by the game first | yes |
| `add_connections` | x0, z0, x1, z1, count (1-4, default 2), road (default Small Road), plan | extra lot-free links from other sides of a grid rectangle to the network, previewed by the game first; for a block whose single connector is the bottleneck | yes |

- **Pausing rules.** `snapshot`, `events`, `ui`, `run_status`, `timings`, `happiness`, `notifications` and the non-pausing reads (`services`, `prefabs`, `free_lots`, `roadside_lots`, `corridor`, `coverage_gaps`, `traffic_hotspots`, `project`) never pause and are safe during `run`. Tools that call `assertIdle` (all mutations, plus `fix_popup`, `query` and `quit`) refuse with `run_in_progress` during a foreground `run`. With `run {background: true}` mutations are allowed: `mutate()` holds the simulation loop, and the game pauses only for that call.

- **GoalLock** (`mcp\src\bridge.ts`). One exclusive lock per goal (preview, build, zone, verify, background step). FIFO mutex; release is idempotent; re-entrant through AsyncLocalStorage, so a nested `mutate()` in the same chain runs directly. `mutate()` and `runPwsh()` take it. The background loop takes it per step and is preempted (cancel by id) when a goal waits (`goalLock.waiting`). Replaces the old mutation counter (FAILURES #50, #53).
- **Events cursor** (`pageEvents`, `bridge.ts`). The cursor is `session:seq`, because `seq` restarts with each game process. `hasMore` says another page exists; `gap` reports a jump in the sequence. `since` also accepts an ISO UTC timestamp.
- **Query projection** (`project.ts` `fit`). `fields` keeps dot paths, `offset` and `limit` page an array, and an oversized result becomes a shape summary. The output is never cut mid-JSON (FAILURES #58).
- **Happiness history and action log.** `journals\happiness-history.jsonl` gets one record per check: `{utc, frame, pop, happy, f:{factor: value}}`, for factors below 0. `journals\actions.jsonl` gets `{utc, need, tool, detail}` for each recorded action (`recordAction`). `happiness` joins them by need.
- **Verdicts** (`happiness.ts`), per factor below 0. The tag comes from the owner thresholds; a verdict reads the actions for that factor's need.
  - `act_now`: very_high (worse than -5), no action inside the settle window.
  - `act`: priority (worse than -3), no action inside the settle window.
  - `watch`: normal (-3 to 0).
  - `waiting`: an action for this factor's need is inside the settle window.
  - `improving`: two or more actions and the factor is at least 0.5 better than at the first action.
  - `investigate`: two or more actions and the factor has not risen by 0.5. Stop adding the same building; diagnose with `crime_map`, `home_clusters` or `coverage_gaps` (through `query`, outside a foreground run).
  - `report_only`: the Tax factor, exempt by owner decision.
  - `no_fix_known`: the factor has no mapped need.
- **Tax pins.** `journals\tax-pins.json` holds one pin per tax area: a fixed number, or `{min, max, start}` as a range. Current pins (owner, 2026-10-10): Residential 15 (fixed); Industrial 10-11 (start 10); Commercial 10-11 (start 11); Office 10-11 (start 11). `tax_autopilot` (`mcp\src\taxes.ts`, `decideTax` is pure) never leaves a range, moves one point per step, does nothing for an unpinned area, and waits 10 minutes after a change to an area before adjusting it again (a pin restore is not delayed). The Tax happiness factor is exempt and only reported. `set_tax` refuses a rate outside a pin unless `ownerSaid=true`, which is for owner direction only.

### Performance (2026-10-10)
- Full grid cycle: 64 s (PowerShell path) -> 33 s (first native path) -> 17 s -> 6.6 s. At 6.6 s: sites 1.1 s, plan 0.2 s, preview 2.7 s, build 2.4 s, zone 0.08 s, verify 0.05 s.
- Snapshot round trip 50-80 ms; fix_services plan 380-550 ms; place_service 1.2-3.8 s; grow plan 4.9-6.9 s (was 30.7 s on the PowerShell path, 20 s before that).
- Remaining cost is the game's own road preview and build (about 0.35 s per road; frame-bound, ~10 frames per tool operation). Count operations and round trips, not lines of code (FAILURES #49). Every result carries wall-clock `ms` and `phases`; `timings` summarises them.
- **Cost and upkeep.** City-logic tools (`build_grid`, `grow`, `link`, `place_service`, `fix_traffic`, `build_arterial`, `add_connections`) return `cost` and `costSource`: `quoted` (the game's own previewCost or batch spend, `city.ts` `quotedCost`) or `cash_delta` as a labelled fallback. Still a money delta: `upgrade_road`, the `legacy: true` paths, and `set_tax` (always 0, no `costSource`). `monthlyUpkeep` comes from prefab costs and is set only by `place_service`; `build_grid`, `grow`, `link`, `buy_tile` and `upgrade_road` return `null`, and road and tile upkeep show in snapshot expense after the next budget period. `zone` and `set_tax` cost 0. Use `project` before building to see construction, upkeep and net per period.
- **Tests** (run from `mcp\`):
  - `node test/smoke.ts`: offline; tool list and events.
  - `node test/popups.ts`: offline; `fixPopups` survives a phase change between its read and its resolve (temp mailbox, fake mod, no game calls).
  - `node test/phase2.ts [name ...]`: live; the Phase 2 queries through the MCP server, with timings.
  - `node test/live.ts concurrency 90`: live; `run` while polling `snapshot`.
  - `node test/live.ts call <tool> '<json>'`: one live tool call.

## 5. Typical agent loop

The MCP loop is in PLAY.md. The script loop below is for manual debugging.

1. `play.ps1 look`: city, demand, utilities, problems, budget, UI. One look per decision.
2. `play.ps1 save before-x`: rolling save; waits for `complete`.
3. Act:
   - `grow -Plan`, then `grow`: picks zone and site, builds grid, zones, connects.
   - Or `grid`, `zone`, `link` (arterial), `buy` (tiles), `place <prefab>`, `save`.
   - Add `-Plan` when unsure.
4. `play.ps1 run -Seconds 300`: bounded simulation; clears tutorial and milestone popups; stops paused on abnormal reasons.
5. `play.ps1 look`, then `play.ps1 save after-x`. Leave the city paused.

`autoplay.ps1` automates this loop: demand-driven growth (residential low, medium, commercial, industrial), tile purchase when land is full, services every 3rd cycle, budget autopilot (raise R/C tax by 1 after two negative-net cycles, up to 15; lower by 1, not below 10, when net > 20k and residential demand is low), popup pass-through, and stops on `STOPPED` or a reached milestone.

## 6. Safety model

- **Never force-kill the game.** `upgrade.ps1` waits up to 3 min for a clean exit and stops if it does not happen. The bridge has no kill command.
- GPU/driver trouble or a hang: save, quit, report. (FAILURES #43)
- **Save before quit or change.** `quit_game` in a city requires a save < 5 min old. `execute_neighborhood` writes before/after saves. `play.ps1 save` waits for `complete`. The owner is asked to exit only after a saved checkpoint.
- **Rolling saves.** Bridge saves are recycled to the Recycle Bin, keeping the newest. `keep-*` (`save -Keep`) and all non-bridge saves are never touched.
- **Native pre-flight.** The game's validator (`previewOnly`) checks roads before the plan is trusted; a geometric plan alone is not enough.
- **Demolition is opt-in and narrow.** Only with `-AllowDemolition`, `grow -Demolish`, or `link -Demolish N`. The link finder only clears ordinary residential, commercial, industrial and office lots. The mod refuses unexpected building deletion (`would_demolish_existing_building`) for ordinary placements.
- **STOP latch.** `bridge.ps1 stop` blocks all control and clears the checkbox. Clear it only with fresh owner permission.
- **No mutation replay.** After a timeout or uncertain result, read state (`look`, `get_operation`, `get_batch`) and do not resend the mutation.
- **Batches do not roll back.** `batch_execute` stops at the first failure; earlier steps stay applied. Harmless `no_zone_cells_in_rectangle` is the one proven no-op that the client resumes past.
- **Owner's saves untouched.** The rolling-save cleanup matches only `CitiesIIAgentBridge-*.cok` and never removes `keep-*`.
- **Tutorials.** Turning tutorials off in game options avoids the most common pause source.

## 7. What has been improved (session history)

Derived from `git log` (26 commits) and FAILURES.md (numbers in brackets).

- Fixed "heartbeat stale" on every command: culture-dependent date parsing [1].
- Requests compacted and size-checked before sending; no more silent `request_too_large` [2].
- Zoning stops aborting batches: only Visible unzoned cells are targeted; Blocked duplicates are skipped [3].
- Road rejections name the blocker (power pylon) and retry at perpendicular offsets; game validator reasons exposed [4, 19].
- Pause causes made visible and resolvable: tutorial cards, milestones, signature popups [7, 24, 25].
- Milestones blocked by the unfinished tutorial intro are detected and released [24].
- Site choice uses real lot geometry, land-use scoring and a grid with stubs and connectors; tile buying when land runs out [14, 17, 18].
- Speed: a 35-minute `grow` stall fixed by screening geometric plans only, with a 4-minute budget [21].
- Rolling saves and recycling; permanent saves only with `-Keep` [16].
- Unattended upgrade: `quit_game`, `load_save`, installer no longer leaves duplicate DLLs under Mods, and the owner-exit safety rule [20, 26, 27].
- Growth considers medium-density and commercial demand, not only low residential [autoplay, commit cc744a3].
- Caller-side bugs fixed: negative-number argument binding, `$args` reuse, `-Plan` lost on re-invocation, `Get-BridgePaged` array wrapping, reserved and one-letter helper names, reused typed variables [5, 6, 9, 10, 11, 12, 22].
- Operator rules encoded: no queries during a run [8]; never kill a running player's tool session [23].
- Live view and typed tools (2026-10-10): `get_snapshot` and `events.jsonl` in the mod; cs2 MCP server with 18 tools; prefab costs; office zoning fixed; power judged by use vs production; demand factors read before zoning; connector fallback no longer aborts zoning [30-36].
- Phase 2 and popups (2026-10-10): Phase 2 queries in the mod; popups resolved on the main thread [37]; service needs escalate ahead of growth, read from the game rather than population counts [38, 39]; `complete_tutorial_intro` also skips the active tutorial list when the intro flag stays set [40]; budget bounds from real costs [41]; `place_service` cap from the prefab's construction cost [42]; launch-safety restrictions withdrawn by owner decision [43]; planner passability fixed for road starts [44].

## 8. Known gaps / needs improvement

- **Public transport.** `transit_status` reads the state (FAILURES #69); depots go through `place_service`, but there are no line or stop commands yet (plan: REDESIGN.md, Transit). Needed around 2k population (CITYPLAN).
- **Traffic-aware routing.** Edges expose raw traffic counters; `fix_traffic` uses native flow to pick upgrades. Route choice (`link`, `grid`, `build_arterial`, `grid_connectors`) does not weigh traffic.
- **Wind direction for industry.** Industry is placed by distance only; wind is not modelled.
- **District and policy management.** `create_district` / `edit_district` exist; policies are not exposed. Naming can report an EntityCommandBuffer error after success (RELEASE-NOTES.md).
- **Service capacity and response time.** DONE for coverage: fire and service placement use the mod's native `coverage_gaps` where a rule has a coverage category, and escalated `needs` (FAILURES #38, #39). Capacity and response time are still not modelled (FAILURES #39).
- **Upgrade buildings.** Extensions and wings are ignored (`Upgrade|Extension|Wing` filter in services.ps1); no command places them.
- **Road hierarchy upgrades.** `upgrade_road` exists, and `fix_traffic` now widens the most congested Small Roads to Medium Road from native flow. Ramps and roads already Medium are reported, not fixed.
- **Water and power capacity planning.** DONE for signals: snapshot `util` (power, water and sewage capacity against use, plus electricity import or export) is read. Open: the harness does not forecast demand or plan plants before growth.
- **Medium and high density rezoning of existing blocks.** Not designed (FAILURES open issues); autoplay only zones empty land.
- **Editor tutorials.** Out of scope; the bridge requires a loaded city.
- **Signature-building placement.** Popups are read and dismissed; placing signature buildings is not supported.
- **Budget tuning per service.** Only taxes are adjusted; `set_service_budget` is unused by the harness.
- **Terrain- and water-aware large site search.** Large-lot placement uses the occupancy raster, not terrain.
- **Occupancy raster in PowerShell.** DONE: mod-side `find_free_lots`, `find_roadside_lots` and `grid_connectors` replace the raster on current mods; the PowerShell raster remains as a fallback for older mods.
- **Milestone reward and unlock reading.** Milestone state is read for blockers only; unlock lists are not used for planning.
- **Landfill01 placement.** Large footprint rejected at geometric candidate sites (FAILURES #17, still open in part).

## 9. Feature roadmap (proposed)

- **P1 Transit.** Mod `create_transit_line` / `add_stop` using the game's TransportLine tool systems. Harness `transit` verb that runs bus lines along arterials at about 2k population.
- **P1 Capacity planning.** Signals are read (section 8, DONE). Still open: read water and power capacity and projected demand; have `grow` build a plant first when headroom is short, instead of only reporting it.
- **P1 Mod-side occupancy.** DONE: `find_free_lots`, `find_roadside_lots` and `grid_connectors` run in the mod (section 4).
- **P1 Service coverage.** DONE: `coverage_gaps` reads the game's native coverage at each home; `services.ps1` places where coverage is missing (section 4).
- **P2 Densify.** Mod support for medium/high rezoning of existing empty or new blocks only; harness `densify` verb along arterials once unlocked.
- **P2 Traffic-aware links.** Expose edge traffic counters in `get_network_edges`; `link` and `grid` prefer low-traffic corridors and trigger `upgrade_network` on congested roads.
- **P2 Wind-aware industry.** Read wind direction from the game's wind data; add a downwind penalty to the industry score in `Find-Sites`.
- **P2 Unlock-aware planning.** Read milestone rewards and locked-prefab state so `grow` and `place` know what is unlocked before choosing.
- **P3 Budget per service.** Use `set_service_budget` in the autopilot after taxes are at their cap.
- **P3 Upgrade buildings.** Mod command to place extensions and wings adjacent to existing buildings; `services.ps1` uses it when a service is full.
- **P3 Policies.** Expose district policies in the mod; harness sets them per district.
- **P3 Signature buildings.** Place unlocked signature prefabs at a checked site after the popup is dismissed.
- **P3 Terrain-aware large sites.** Add `sample_terrain` checks to the large-lot branch of `place`.
- **P3 Editor tutorials.** Only if the bridge gains a non-city mode; out of scope now.

## 10. Docs map

- **PLAY.md**: agent quickstart for `play.ps1`: preconditions, core loop, verbs, token and safety rules.
- **LEARNINGS.md**: field notes on how the bridge behaves: connection, utilities, roads, zoning, batches, simulation, pauses.
- **FAILURES.md**: failure catalogue (symptom, cause, fix, prevention) and open issues.
- **CITYPLAN.md**: Round Rock city plan, site scoring rules, what is built and next. Agents read it before building.
- **COMMANDS.md**: full bridge command reference (upstream commands plus additions).
- **INSTALL.md**: owner-facing install and first-connection steps.
- **HARNESS.md**: this file; architecture and components, mod extensions, safety model, history, gaps and roadmap.
