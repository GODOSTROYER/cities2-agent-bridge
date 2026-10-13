# Using Cities II Agent Bridge effectively (field notes)

Field-tested notes from live sessions with bridge **0.5.0-community** on CS2 **1.6.2f1** (Windows, PowerShell 7.6, en-IN locale).
Read this before AGENTS.md and COMMANDS.md. Those files say what the bridge allows. This file covers how it behaves in practice and which harness tools to use.

> This folder is a **git-tracked working copy** of the release package. `bridge.ps1` is patched (see "Harness bugs fixed"), so `verify-package.ps1` reports a mismatch here by design. Install only from the pristine, SHA-256-verified release ZIP. Use this copy to drive the game. `git log` shows every change made to it.

Agents: start with PLAY.md and `play.ps1` (token-efficient). This file explains why things work the way they do.

## Quick start (city loaded, paused, "Allow local bridge controls" ticked)

```powershell
.\play.ps1 look
.\play.ps1 save before-agent-session
.\play.ps1 grow -Plan                # dry run first
.\play.ps1 grow
.\play.ps1 run -Seconds 600          # bounded simulation, stops paused on abnormal events
.\play.ps1 save after-agent-session
```

`lib\BridgeClient.psm1` is still available for custom scripting (`Invoke-Bridge`, `Wait-BridgeOperation`).

## Harness tools

| Tool | Purpose |
|---|---|
| `play.ps1` | Agent front end. Verbs: `look`, `ui`, `fix`, `sites`, `grid`, `grow`, `zone`, `run`, `save`, `prefab`, `raw`. Each prints a few lines. `raw` strips components, curves and similar noise (about 78% smaller). |
| `PLAY.md` | Agent quickstart for `play.ps1`: preconditions, core loop, verbs, token rules. |
| `lib/BridgeClient.psm1` | `Invoke-Bridge` throws on `ok:false` and returns `.result`. `Get-BridgePaged` follows `nextOffset` and returns the array whatever it is named. `Wait-BridgeOperation` and `Wait-BridgeBatch` poll until done. `Invoke-BridgeSteps` splits steps into batches under 16 KB and 64 steps, and continues past proven no-op zoning steps. `Invoke-BridgeRoad` inspects the blocker on rejection and optionally retries at perpendicular offsets. `Get-BridgeRoadGraph`, `Find-BridgeNearestNode` and `Test-BridgeNodesConnected` check connectivity locally. `ConvertTo-BridgeLean` strips noisy fields. `Resolve-BridgePrefab` resolves a name to an index, cached per city session in `journals/prefab-cache.json`; it throws if the prefab is locked or not placeable. |
| `grid.ps1` | Builds a world-aligned road grid, adds a validated connector to existing roads and plans it with `plan_neighborhood`. It executes with automatic before/after saves, zones the blocks with `zone-fill.ps1` and verifies connectivity. `-PlanOnly` is read-only. |
| `zone-fill.ps1` | Zones every **Visible** unzoned cell in an area with one block-attached rectangle per block. It reports verified before/after counts from live cell state. `-WhatIf` is read-only. |
| `run-session.ps1` | Chains bounded `simulate_step` intervals (max 50 s each) up to `-TotalSeconds`. It logs to `journals/run-session.jsonl`, triages utility shortages and exits paused on abnormal stops. |

## How the bridge actually behaves

### Connection
- `bridge.ps1` needs a heartbeat newer than 10 s in `%LOCALAPPDATA%\CitiesIIAgentBridge\session.json`. If `session.json` looks fresh but the client says "stale", suspect date parsing (fixed here).
- Requests over **16384 bytes** are rejected with `request_too_large` and **nothing is applied**. The response file says so, but the client used to print it in a way that was easy to miss.
- Every response is `{ok, result | error}`. Always check `ok`. For async work, `status: queued` only means accepted: poll `get_operation` or `get_batch`.
- JSON piped into Python on Windows: use `python -X utf8` (or node). Windows Python reads piped stdin as cp1252 and mangles correct UTF-8. Check the raw bytes before blaming the producer (FAILURES #35).

### Reading the city
- Paginated arrays are named per command: `prefabs`, `buildings`, `cells`, `edges`, `facilities`. Use `Get-BridgePaged` rather than assuming `items`.
- `get_build_prefabs` reported about 49k prefabs with `kind=all`. Query per kind (`network`, `zone`, `service`, `building`). Filter on `!locked -and bridgePlacementSupported`.
- Useful prefab names: `Small Road`, `Medium Road`, `Small Water Pipe`, `Small Sewage Pipe`, `Low-voltage Line`, zones `NA Residential Low`, `NA Commercial Low`, `EU *`, `Industrial Manufacturing`. **Indexes are per install/session; always resolve by name.**
- `get_tiles` gives the buildable area (purchased tile polygons). A fresh city owned 9 tiles, about ±935 m around the origin.
- `sample_terrain` with a grid of points is a cheap way to find flat, dry land. Check `waterDepth > 0.1`. Height is in `position.y`; there is no `height` field.
- `trace_network` needs **live node** IDs. Edges are deleted and renumbered when a road attaches mid-edge, so an old edge ID gives `endpoints_must_be_live_network_nodes`. Use `Get-BridgeRoadGraph` and a local search instead.
- `diagnose_connections` lists buildings with problems. Issues ending in `_shortfall` are supply shortages (usually transient for new buildings). Anything else is a real connection problem.

### Utilities
- **CS2 roads carry water, sewage and low-voltage power.** "Basic utilities" for new streets means enough plant capacity, not pipes. Check `get_water_facilities` (`capacityRaw` against `lastProductionRaw`) and `get_city_management` (electricity export means a surplus) before building plants.
- Right after loading, many buildings show a shortfall of 1 unit. That is a load transient, not a capacity problem.

### Roads
- `build_road` attaches to an existing edge when `start` has `index`, `version` and `curvePosition` (0 to 1). Otherwise native snapping joins endpoints at or near existing nodes. Crossing roads split each other automatically.
- `game_rejected_placement` lists `placementErrors`. Entries whose prefab differs from your road are blockers; run `inspect_entity` on them. Example: `PowerLinePylon47m01`. Fix by shifting the road (roads may pass under power lines, not through pylons).
- Actual cost is about **₡4 per metre** for Small Road (₡896 per 220 m). Use `maxCost` of about ₡8k per road. `maxCost` must be at least 1 at execution, although `plan_neighborhood` accepts 0.
- The city's single highway ramp is the traffic bottleneck: edge flow is 1-5% around it (`traffic_hotspots`).
- A normal road can join a highway mainline at grade. The game splits the highway edge into a node there. The second highway connection at (-1303,-100) is such a junction; watch it.

### Zoning: the main time sink
- Each road side creates **zone blocks** of up to 8 × 6 cells (8 m). Where blocks from perpendicular roads overlap, the game keeps one and flags the other's cells `Blocked`. **Blocked cells can never be zoned**, and `zone_rectangle` on them returns `no_zone_cells_in_rectangle`. That is a correct no-op, not a failure.
- About 25% of the cells around a grid are `Blocked` duplicates. Count only `Visible` cells when measuring coverage.
- Use a **block-attached start** (`start.index/version` = the block) so the rectangle follows the block's axes. Otherwise the camera orientation decides, which is unpredictable.
- A rectangle can spill into neighbouring overlapping blocks, so the per-step "changedCells" can exceed the block's size. Verify by re-reading cells; don't sum the operation results.
- Zoning costs nothing and never consumes `maxCost`.
- Direct zoning (`zone_area`) writes the cells and tags their blocks `Updated` in one frame. The tool path (`tool: true`) costs about 10 frames per block.

### Batches and neighbourhood plans
- `batch_execute` is sequential and **stops at the first failure**, with no rollback. One harmless `no_zone_cells_in_rectangle` used to abort 50 good steps. `Invoke-BridgeSteps` resumes past that specific proven no-op only.
- `plan_neighborhood` is **read-only and fast**. Use it as a validator: it checks spending bounds against `maxTotalCost`, treasury and reserve, and overlap with existing buildings (`existing_building_overlap`). Plans expire after 5 minutes. `execute_neighborhood` adds `before-neighborhood` and `after-neighborhood` saves automatically, for a maximum of 62 of your own steps.
- **Do not use `plan_neighborhood`'s built-in `grid` option.** Its roads are not attached to the network, and its zones are raw world rectangles inset 12 m with no block attachment (camera-dependent). `grid.ps1` generates explicit roads and zones afterwards with `zone-fill.ps1`.
- Connectors: diagonal links into an already-built area usually hit houses. Prefer a straight extension of a dead end to the nearest point on the new grid's perimeter. `grid.ps1` tries candidates by distance until a plan validates.

### Simulation
- A game tool operation (road, zone rectangle) costs about 10 frames. Merge operations: one road per grid line, not per block side (FAILURES #49).
- `simulate_step` allows at most 60 s of wall time. Chain steps; overhead is about 1 s per step. Speed 4 is the maximum and gives about 11.7k frames per 50 s.
- Stop reasons: `wall_deadline` and `frame_limit` are normal. `cash_floor`, `new_utility_shortage`, `population_changed`, `demand_changed`, `simulation_stalled`, `game_paused`, `control_stopped` and `city_changed` need a look.
- A background run stops with `lastStop` `cash_floor` when the floor is above cash. Check the floor against cash before starting.
- To stop a run safely: kill the client loop first so no new step starts, then `cancel_simulation_step`. It returns `paused:true`; confirm with `get_city_state` (`selectedSpeed` 0).
- Growth follows **zoned capacity**. With residential demand at 100, population went 127 → 201 → 281 → 316 and then flattened (+1, +3 per 50 s) once the zoned lots filled. When `delta.population` stalls while demand is high, zone more land; don't just simulate longer.
- `analysisPausesGame: true`: **any** read command (even `get_build_prefabs`) pauses the game, ending the active step with `game_paused`. Never query while `run-session.ps1` is running; wait for it to finish.

### Service budgets
- The budget slider scales wages, not just prefab upkeep. Health & Deathcare cost about 2,800 per budget point (65 -> 100 = +97k); Fire & Rescue about 260 per point. Real running cost of a service building was about 2.7x its prefab `monthlyUpkeep`.
- Change one budget at a time and read `ServiceUpkeep` before and after (FAILURES #47).

### Transit (2026-10-10)
- Building a bus depot unlocks the bus stop prefabs but not the Bus Line prefab. A line stays locked after the depot (FAILURES #69). Read `transit_status` before spending on transit.

## Pauses, popups and UI (mod 0.5.1-local)
- CS2's `TimeUISystem` forces speed 0 every frame while the window lacks focus (`m_HasFocus`) or any UI panel subscribes to the simulation-paused barrier (tutorial cards, milestone popup, menus). Symptom: `simulate_step` ends after under 1 s with reason `game_paused`.
- `get_ui_state` does not auto-pause. It returns:
  - `selectedSpeed`, `hasFocus`, `pausedBarrierObservers`, `screen`/`menuActive`, `activePanel`
  - `tutorial` {`enabled`, `activeTutorial`, `activeTutorialPhase`}, `milestone.pending`, `dialogs` (error dialogs)
  - `activeTool`, `infoview`, `chirps` (newest N; arg `chirps`, 0-10, default 3)
  - `likelyBlocker`: `error_dialog` | `menu_screen` | `milestone_popup` | `tutorial_phase` | `unknown_ui_panel` | `window_not_focused` | `paused_by_player_or_bridge` | `none`
  - `resolvableByBridge`, `errors[]` (each probe is isolated; a renamed game member shows up here instead of failing the command)
- `resolve_pause_blocker` actions: `complete_tutorial_phase` (requires `expectedPhase`) and `dismiss_milestone` (requires `expectedMilestone`). Error dialogs and menus are reported, never dismissed.
- `play.ps1 fix` loops these up to 10 times. `run-session.ps1 -ResolveTutorials` (used by `play.ps1 run`) does it automatically.
- Field case: completing the commercial-zone tutorial step via bridge zoning queued the next tutorial card (Industrial Zones 1/4), which paused the game. Turning tutorials off in game options avoids it entirely.
- Settings: `Keep bridge controls enabled across city loads` (owner opt-in, default off, persisted in `ModsSettings/CitiesIIAgentBridge`). When off, "Allow local bridge controls" resets on every city load as before. The STOP latch still wins.
- Tutorial intro cards are service requests: CemeteryTutorialIntro = deathcare, FireTutorialIntro = fire. The game waits on the card. AutoResolve clears it while controls are on, but the need stays until a service is built (FAILURES #37, #38).

## Live view (mod 0.5.1-local + MCP)

- `get_snapshot` is non-pausing: the mod rebuilds it every ~256 frames (every 5 s while paused), so reading it during `run` is safe. Every other read pauses the game (see above).
- Judge power by use vs production and import/export, not plant load. Plants run flat out because surplus is exported; Round Rock used 19-39% of production (FAILURES #33).
- Read `demandWhy` before zoning or changing taxes. Taxes C13/I15 gave native factor Taxes -240 (C) and -450 (I) (FAILURES #34).
- Frame rate: ~130 frames/s at speed 4 after a fresh launch, versus ~228/s in earlier sessions. The old `run-session.ps1` showed the same drop, so it is the environment, not the snapshot (~2 ms per build).
- `events` `seq` restarts with each game process. Across restarts, filter with `since` as a UTC timestamp, not a seq number.
- Coverage is not capacity. Native coverage showed every home covered by a fire house (range 5000), yet three fires burned in about 70 minutes with one fire house. Watch fire events and `needs`, not coverage alone (FAILURES #39).
- Tax per occupied cell (monthly, from the `project` query on the live city): industry ~80, commercial ~110-150, office ~52-57, residential ~12-20. Compare zones with these before zoning.

## Happiness factors, icons and taxes (2026-10-10)
- **Owner thresholds** (`ServiceSignals.FactorPriority`; `mcp\src\happiness.ts`): a factor worse than -5 is `very_high` (act now, every cycle until it improves); worse than -3 is `priority` (act this cycle, ahead of growth); -3 or better is `normal`.
- **Tax factor is exempt.** Report it (flag below -5); never lower rates or add buildings because of it. Owner pins (`journals\tax-pins.json`, as ranges): Residential 15, Industrial/Commercial/Office 10-11.
- **Factors seen moving after an action:**
  - Entertainment -4 -> 0 after six small parks (35k).
  - Telecom -2 -> 0 after one radio mast (25k).
  - Healthcare -1.4 -> 0 after the health budget went to 100%.
  - Crime -7.5 -> -4.7 after two more police stations and the budget at 100%. It took about 20 minutes to show, so judge only after the settle window.
- **Tax floor and job-zone demand** (FAILURES #61). At R15 C13 I15 O13 the native Taxes factor is -450 (industry), -240 (commercial), -60 (office). Unemployment went 12% -> 31% and job-zone demand fell to 0 while housing kept adding workers. Read `demandWhy` and unemployment with every tax decision.
- **Tax at 10%.** At business tax 10% the Taxes term drops out of commercial and office demand (it was -80 at 11%, -240 at 13%; industry -450 at 15%).
- **Verdicts seen live.** Traffic went to `investigate` after two widenings without improvement, then -3.2 -> -2.6 after the second highway connection.
- **Icon types seen on the map:** Noise Pollution, Air Pollution, Traffic Bottleneck Notification, Garbage Notification, Burned Down, Hearse Notification, MissingUneducatedWorkers, No Customers, Powerline Not Connected. Burned-down ruins: `clear_ruins`. Jams: `fix_traffic`.

## Harness bugs fixed in this copy (see `git log`)
1. **Culture-dependent heartbeat parse.** PS7 `ConvertFrom-Json` turns `heartbeatUtc` into a `DateTime`. `[DateTimeOffset]::Parse()` then re-parsed its string form in the user's culture (en-IN read 10/09 as 10 Sep), so every command failed with "heartbeat stale". Fixed by using the DateTime directly and parsing strings with InvariantCulture.
2. **Indented request JSON.** Indentation roughly doubled request size and pushed valid batches past 16 KB. Requests are now compact, with a client-side size check that refuses before sending.
3. **PowerShell argument gotcha (caller side).** `myfunc -880 -120` passes the strings "-880" and "-120", and the bridge answers `number_required: x`. Type parameters as `[double]` or pass hashtables.
4. **`$args` is reserved in PowerShell.** Don't use it as a variable name in scripts.
5. **`Get-BridgePaged` comma-wrapped its array.** `@(...)` then counted 1. It now emits items.
6. **`play.ps1 grow -Plan` lost the `-Plan` flag** when re-invoking itself and built a real grid. `grow` now calls the grid function directly. Lesson: test dry-run flags by reading the result before trusting them.

## Safety rules that still apply
- Get the owner's permission before installing, closing or launching the game. The bridge has no quit command; never force-kill the game.
- Save a checkpoint and wait for `complete` before major changes. Never replay a mutation after a timeout; inspect state first.
- Never clear the STOP latch without fresh permission. The "Allow local bridge controls" checkbox resets on every city load.
- Leave the city paused and saved at the end.
- GPU/driver trouble or a hang (FAILURES #43): save, quit, report; do not keep relaunching. The trigger is not established.

## Player notes (Haiku)
- 2026-10-13 00:50 UTC: place_service (site finder) cannot see cleared lots; it returns no_roadside_site even where a park fits. Use placeany with the exact point: `node test/placeany.ts '{"prefab":"TennisCourt01","x":-340,"z":-1210,"rotation":0}'` (dry run, then `build`); the game snaps it to the nearest road and block.ts shows `road <edge>`. OverlapExisting at a point means a home's footprint reaches it; remove the nearest home (demolish.ts) and retry.
- 2026-10-13: zone.ts has no clear option; dezone.ts build clears zoning on cleared cells (it may need two runs).
- 2026-10-13: linepolicy.ts does not read the slider back; re-read the line list after 15 minutes to confirm a VehicleInterval change.
- 2026-10-13 01:06 UTC: demolished homes on residential-zoned lots regrow within minutes (corner (-215,-302) and (-215,-322)); dezone.ts refuses while they stand. For a clear lot, de-zone first (dezone.ts dry run, then build), then demolish, then place.
- 2026-10-13 01:12 UTC: de-zone only clears empty cells; a home still standing on the lot stops it (refused with reasons). Regrown homes need a second removal before the zone clear; placeany still overlaps when zoned cells remain. Bus depot extra garage is refused everywhere in this city (overlap or ExceedsCityLimits).
- 2026-10-13 02:50 UTC: buy_tile default cost cap is 300000; pass "max":400000 for District tiles (exact:true works with the sheet's centres). build_line kind "Medium Road Divided" snaps ends to nodes; a piece that ends mid-edge reports a loose end at the midpoint only.
- 2026-10-13: K6-style junction got traffic lights automatically; remove with roadopt.ts (Traffic Lights, remove:true). Roundabouts LargeRoundabout01, MediumRoundabout01, SmallRoundabout01 all refused on a crescent node with OverlapExisting and NoRoadAccess.
- 2026-10-13: zone tool is radius-only; there is no rectangle zoning helper, so block zoning needs a new tool before District 3 zoning.
- Line overloads were depot limits: two new bus depots (South Bank, east) fixed two bus lines within minutes (#14 596 to 8, #10 482 to 66).
- 2026-10-13 02:30 UTC: a road extension from a node can be refused OverlapExisting with no building listed by block.ts/get_buildings (trees planted earlier on the same street are the suspect); check the trees before assuming a lot.
- 2026-10-13 03:00 UTC: subway stations unlock once a subway yard exists (SubwayYard01 built). placeany snaps SubwayStation01 by up to 28 m from the requested point; track built to the requested point leaves loose "Track Not Connected" ends. Build the track to the station's snapped point, not the sheet's point. A 20 m bridging piece is refused OverlapExisting by the station footprint.

## Subway: how the first line was built (coordinator, 13 October 2026)
- **Unlock:** buying the Subway node opens only the yard. Placing a `SubwayYard01` unlocks every station type, the track types and the Subway Line (prefab 181), as the rail yard did for trains.
- **Sizes:** `SubwayYard01` has a lot of 44 x 20 cells (about 350 x 160 m) and needs a road on its long side; `SolarPowerStation01` is 36 x 69 cells. Read `m_LotSize` with `get_prefab_details` before looking for a site. The site finder and `placeany` both report only OverlapExisting when the free area is too small.
- **Stations own their platform track.** A `SubwayStation01` comes with a 200 m piece of Double Subway Track about 20 m under the ground, running under the building, not under the street. New track must end on the two end nodes of that piece. `get_network_edges` hides building-owned track unless `includeOwned: true` is passed; with it each edge carries `ownerPrefab`.
- **Each station has two stops** (`Integrated Subway Stop - Middle`, kind `subway`), one per direction; `transit_lines` lists them with their positions. A line is created with `create_line` (prefabIndex 181) through the six stops in travel order, closed; preview first, and apply only with `segmentsWithoutPath` 0.
- **Track:** `node test/road.ts` with `"road":"Double Subway Track"`, `startElevation` and `endElevation` relative to the ground (-20 meets the platform level; -30 where -20 overlaps something). Straight pieces of 250 m or less. Bends need `"mode":"curve"` with one `control` point and a radius of about 100 m or more: a turn squeezed into less is refused with TightCurve, and two straight pieces meeting at a sharp angle build but leave "Track Not Connected" icons.
- **Approach a station in line with its platform.** To enter an east-west platform from the south, swing out past its end and come back along its axis (three curves of about 100 m radius worked at Hawthorne Central).
- **Yard outlets:** the yard's `Twoway Subway Track` ends on its west side at (x of the lot edge) accept new track; the `Double Subway Track` end inside the lot refuses with NoTrainAccess and NoCarAccess. Start from the outlet node (`start.index` and `start.version` of the node) and go down gently (0 to -14 over about 150 m). Track cannot leave owned tiles.
- **Check:** after each stretch the loop's status line must show no "Track Not Connected"; a line shows vehicles within two minutes if the yard is joined.
- **Depots limit lines.** A bus depot holds 25 buses and a tram depot 10 trams. When a line has hundreds waiting and its vehicle count does not rise at the highest interval setting, add a depot (two new bus depots took two lines from 596 and 482 waiting to 8 and 66 within minutes). The line interval slider is not read back; judge by `vehicles` and `waiting`.
- 2026-10-13 03:12 UTC: zonerect re-passes report no_zoning_change_observed on blocks already zoned as far as the game allows. zone_area_count "zonable" counts visible unzoned cells, including those blocked by service and park lots, so a block can read 200 zonable and still be fully zoned. Judge a block by whether a repeat pass changes anything, and by the buildings growing. zonerect now zones directly; one pass is enough, box up to 900 m corner to corner.
- **River tunnel (13 October 2026):** elevations are relative to the terrain, and under water the terrain is the river bed. Compute each point's elevation as (target absolute height minus sampled ground height) from `sample_terrain`. A tunnel 9 m under the deepest bed was refused InWater; 17 m under it (absolute 430 under a 447 bed) was accepted. Slopes of 10 to 12% between pieces were accepted for subway track.
- **Tunnels and buildings:** subway track at -20 is refused OverlapExisting where homes stand on its line (a platform end with houses directly beyond it cannot be extended without clearing them or starting deeper); at -30 it passed under buildings elsewhere. Choose station sites whose platform ends point along a street or open land.
- **Two agents, one build tool:** when the coordinator and the player build at the same time, calls fail with `finish_or_cancel_current_tool_first`; retry after a few seconds (the helpers do).

### OverlapExisting: read the blockers before blaming the tunnel (13 Oct)
A refused road preview lists the objects in the way in `placementErrors` (entries with a `position`). `node test/road.ts` now prints them as `blockers`. Look each one up with `get_buildings {x,z,radius}`. In South Bank the boulevard was thought to be blocked by the subway track at -20; the real blocker was a BusDepot01 (lot 144 x 72 m) across the axis. Surface roads cross a -20 subway tunnel without trouble.
- Player notes (Haiku), 2026-10-13 06:35 UTC: when a road preview is refused OverlapExisting, read the `blockers` list from test/road.ts (index, x, z) and look the object up with get_buildings {x,z,radius:60} before diagnosing. The South Bank boulevard was blocked by a bus depot, not the subway track.

### Overpass over the highway: what works (13 Oct, District 5 links)
- Build in three pieces with `node test/road.ts`: ramp (`startElevation` 0, `endElevation` 8-10), one span of 70 m or less at constant height, ramp down. Elevations are relative to the ground. 8-10 m clears the highway.
- A span longer than about 72 m gets a pier in the middle; a pier on a carriageway is refused as OverlapExisting, and the `blockers` it lists are the preview's own piers (their index changes on every preview, and `get_buildings` finds nothing there). Put the piece joints 25 m or more from each carriageway centre line.
- The existing highway edges keep their ids when the deck is right (no at-grade junction was made): check with `get_network_edges`.
- A wider road on an old Small Road line can overlap the lot of a building fronting it; shift the line a few metres away or start with a short Small Road piece.
- `node test/buildings.ts <x> <z> <radius>` lists buildings (id, prefab, position) near a point.
- Player notes (Haiku), 2026-10-13 07:10 UTC: an elevated highway link's deck end is not a ground node. A ground piece built from it with build_line reports partial loose_end at the deck point; road.ts with startElevation 0 refuses no_valid_road_preview. Check the deck's own height (node read) before extending a ground road from it.
- **Elevated roads and bridges carry no power, water or sewage.** A district reached only over decks has none: lay `build_line` `power_low` and `pipe` (Combined Small Pipe) from a ground road on one side to a ground road on the other, under the obstacle (done under the west highway for District 5). Plan this with the trunk links, before services.
- Player notes (Haiku), 2026-10-13 08:10 UTC: bridges and elevated roads carry no power or water; lay build_line power_low and pipe under the obstacle. Park placement next to a crescent needs a road edge within the footprint: a park 50 m off the road reads road 0 even when placeany previews clean.
- **"No electricity" on a new service building: check its road front first.** `utility_check {x,z,radius}` gives linked/unserved and `nodeDistance`; a distance near 100 m means the building is not on a road. District 5's clinic, post office and fire house were placed by `placeany` at sheet coordinates 60-100 m from any road and read 0 power and water although the network was linked. On empty land place services with `place_service` (it finds a road front); a planner's sheet must give service sites as "on road X near (x,z)", not free coordinates.
- **Post "mail waiting in 96% of buildings" is not a shortage on its own (13 Oct).** The share counts buildings with more than 5 units of mail, which is nearly all of them. Measured: average mail flat over 10 minutes, Mail factor +7.5, no mail icons, vans 10-15% busy, 18 post offices and 2 sorting facilities. The report now grades the share in full only with a game signal (negative Mail factor or mail icons). Not yet known: the game's real complaint threshold; the bridge exposes no per-building mail.
