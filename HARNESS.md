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
   |  mailbox client (mcp\src\bridge.ts)    |
   |  mutations also run play.ps1 or        |
   |  upgrade.ps1 as child processes        v
   |                                  lib\BridgeClient.psm1   (Invoke-Bridge, paging, batching, occupancy raster, rolling saves)
   |                                        |
   |                                        v
   |                                  bridge.ps1 <command> -ArgsJson {...}     writes  requests\<id>.json
   |                                        |                                  reads   responses\<id>.json
   v                                        v
 %LOCALAPPDATA%\CitiesIIAgentBridge\  (requests\  responses\  session.json  STOP latch  events.jsonl)
   ^
   |  Mod.Tick every 250 ms (game main thread) -> Mailbox.Pump -> Dispatch(command)
   v
 CitiesIIAgentBridge.dll (in game)  ->  ECS systems, tools, UI state, game settings
```

- **Two entry paths.** The cs2 MCP server (section 4b) writes requests to the mailbox itself through `mcp\src\bridge.ts`; its mutating tools also run `play.ps1` or `upgrade.ps1` as child processes. Both use the same protocol and files.

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
| `play.ps1` | agent front end | Verbs: `look`, `ui`, `fix`, `sites`, `grid`, `buy`, `grow`, `zone`, `run`, `link`, `place`, `save`, `prefab`, `raw`, `help`. Terse output; `raw` strips noisy fields unless `-Full`. `grow` picks the zone by demand (res, resmed, com, ind, off (office); needs demand >= 20 and an unlocked prefab; `-Zone` overrides; reads unemployment from `get_snapshot`) and steps the grid down 3x2 -> 2x2 -> 2x1 -> 1x1 when land is short. |
| `autoplay.ps1` | growth loop | Per cycle: wait for the road tool to clear, `grow -BuyTiles` if residential/commercial demand >= 50 and cash > floor + 150k, `services.ps1` every 3rd cycle, `run` for 120 s, budget autopilot. Stops on `STOPPED` from `run`, or on a milestone with `-UntilMilestone`. Ends with `save`. |
| `grid.ps1` | road grid builder | World-aligned grid (110 m blocks, max 62 roads). Adds four 64 m outward stubs (`-NoStubs` disables). Connector from the nearest existing road node, up to 400 m, validated with `plan_neighborhood`. Native pre-flight of each road (`build_road previewOnly`) when capability `roadPreview` exists; rejected stubs are dropped, a lost connector is rebuilt from another candidate. Executes with `execute_neighborhood` (before/after saves), then zones and checks connectivity by graph search. `-PlanOnly` changes nothing. `-AllowDemolition` may remove one house to open a street. Connector fallback drops stale edge ids (`stale_point_entity`) and retries with native snapping. |
| `zone-fill.ps1` | zoning | Zones only `Visible`, unzoned cells, one block-attached rectangle per block. Blocked duplicate cells are skipped. Verifies with a re-read of cells, not operation claims. `-WhatIf` is read-only. |
| `run-session.ps1` | bounded simulation | Chains `simulate_step` (max 50 s each, speed <= 4) to `-TotalSeconds`. Logs to `journals\run-session.jsonl`. Shortage triage: continues while only `_shortfall` issues exist and the count is not rising for 3 steps. `-ResolveTutorials` clears tutorial, milestone and signature popups (max 10). Stops paused, with a reason, on anything else. |
| `services.ps1` | basic services | Detects police, fire, clinic, school and landfill by prefab regex, targets population-based need, and places via `play.ps1 place` near the homes or industry that lack coverage. Needs cash >= 300k. Counts only; not real coverage. |
| `upgrade.ps1` | unattended restart | Saves and waits for `complete`; `quit_game` (refused unless the named save is < 5 min old); waits up to 3 min for exit, never kills; optional `-Build` runs package and tests; installs with hash check; starts `Cities2.exe -continuelastsave`; calls `load_save` from the main menu (newest `CitiesIIAgentBridge-autosave-*`); waits up to 600 s for the city. |
| `lib\BridgeClient.psm1` | client library | `Invoke-Bridge` (throws on `ok:false`), `Get-BridgePaged` (follows `nextOffset`), `Wait-BridgeOperation`, `Wait-BridgeBatch`, `Invoke-BridgeSteps` (chunks to 15000 bytes and 64 steps; resumes past proven no-op zoning errors only), `Invoke-BridgeRoad` (on rejection, inspects the blocker and retries perpendicular offsets), `Get-BridgeRoadGraph` / `Find-BridgeNearestNode` / `Test-BridgeNodesConnected` (local connectivity), `Resolve-BridgePrefab` (name to index, cached per city session in `journals\prefab-cache.json`), `Get-BridgeOccupancy` plus the `Test-Occupancy*` functions (4 m raster from real lot rectangles and road chords), `Clear-BridgeRollingSaves` (keeps newest; never touches `keep-*` or the owner's own saves; recycles to the Recycle Bin). |
| `grid.ps1` header | builder contract | Documents the plan-then-execute order and the `-PlanOnly` guarantee. Read it before changing the grid flow. |
| `bridge.ps1` | raw client | Single-command client: `bridge.ps1 <command> -ArgsJson '{...}'`; also `stop`. Reads responses with shared delete access and retries on sharing violations. Journals events when `journals\active.json` exists. |
| `journal.ps1`, `advance.ps1`, `export-*.ps1`, `view-map.html` | optional | Visible progress journal, bounded advance helper, map and atlas exports. Not needed to play. |

Selected helpers used by `play.ps1`:
- `Find-Sites` ranks empty, owned, dry, flat land (9 terrain samples per candidate; reject water or > 25 m relief) by link length, clear link, and land-use distances (pollution, industry, jobs, homes, highway).
- `Invoke-BuyTiles` buys adjacent unowned tiles that score best on dryness, relief and distance to the city.
- `link` builds a Medium Road corridor from an existing road that crosses no lot, checked by the game's own preview. `-Demolish N` may clear up to N residential, commercial, industrial or office lots.
- `place` uses `find_building_sites`; for lots of 64 cells or more it slides along nearby road edges on the occupancy raster instead.

## 4. Mod extensions (0.5.1-local)

Commands added by this fork (upstream commands are documented in COMMANDS.md).

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

## 4b. MCP server (cs2)

Typed tool layer for agents. Code in `mcp\`: `src\server.ts` (tools), `src\bridge.ts` (mailbox client).

- **Setup.** Node >= 22.18 (native TypeScript type stripping, no build step). `cd mcp; npm install` (`@modelcontextprotocol/sdk` 1.32.1, `zod` 3). Registered in `.mcp.json` at the repo root (`command` node, `args` `mcp/src/server.ts`). `CS2_MAILBOX` overrides the mailbox folder.
- **Protocol** (copies `bridge.ps1`): session.json heartbeat <= 10 s and status `ready`; request written as `.tmp` then renamed; response polled every 50 ms and deleted after reading; 15000-byte client limit (mod 16384); culture-safe manual ISO parse; never resends a mutation after a timeout.
- **Tools (18).**

| tool | args | does | pauses |
|---|---|---|---|
| `snapshot` | none | cached city state (section 4) | no |
| `events` | since, limit, types | tail of events.jsonl | no |
| `ui` | none | speed, blocker, popups, tool, chirps | no |
| `fix_popup` | none | dismisses milestone, signature and tutorial popups | yes |
| `run` | seconds (1-1800), speed (1, 2, 4), cashFloor | bounded simulate loop; passes popups; one summary line | yes, ends paused |
| `build_grid` | x, z, cols, rows, zone, plan | `play.ps1 grid` | yes |
| `grow` | zone, cols, rows, plan, buyTiles | `play.ps1 grow` | yes |
| `link` | x, z, road, max, plan | `play.ps1 link` | yes |
| `zone` | x, z, radius, zone | `play.ps1 zone` (free) | yes |
| `place_service` | prefab, x, z, radius, maxCost, plan | places an exact building prefab; plan shows costs | yes |
| `prefabs` | filter, kind, limit, costs | prefab search with construction and upkeep | yes |
| `set_tax` | area, rate | tax rate for R, C, I or O | yes |
| `set_service_budget` | service, budget (50-150) | budget by exact or unique partial name | yes |
| `services` | none | name, budget, buildings (array length), workers, workplaces | yes |
| `buy_tile` | n (1-3), max, plan | buys tiles within a cost cap | yes |
| `save` | none | `play.ps1 save` | yes |
| `restart` | build, noInstall | `upgrade.ps1`: save, quit, relaunch, load newest autosave | yes |
| `query` | command (read-only allow-list), args, maxChars | raw read | yes |

- **Pausing rules.** `snapshot`, `events` and `ui` never pause and are safe during `run`. Mutating tools and `query` refuse with `run_in_progress` while `run` is active. `services` and `prefabs` do not check, so do not call them during a run.
- **Cost and upkeep.** Mutating tools return `cost` (money before minus after). `monthlyUpkeep` comes from prefab costs and is set only by `place_service`; `build_grid`, `grow`, `link` and `buy_tile` return `null` and note that road and tile upkeep show in snapshot expense after the next budget period. `zone` and `set_tax` cost 0.
- **Tests** (run from `mcp\`):
  - `node test/smoke.ts`: offline; tool list and events.
  - `node test/live.ts concurrency 90`: live; `run` while polling `snapshot`.
  - `node test/live.ts call <tool> '<json>'`: one live tool call.

## 5. Typical agent loop

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

## 8. Known gaps / needs improvement

- **Public transport.** The bridge has no transit-line or stop commands. Needed around 2k population (CITYPLAN).
- **Traffic-aware routing.** Edges expose raw traffic counters; the harness does not read or use them.
- **Wind direction for industry.** Industry is placed by distance only; wind is not modelled.
- **District and policy management.** `create_district` / `edit_district` exist; policies are not exposed. Naming can report an EntityCommandBuffer error after success (RELEASE-NOTES.md).
- **Service coverage model.** `services.ps1` counts buildings against population; it does not measure real coverage.
- **Upgrade buildings.** Extensions and wings are ignored (`Upgrade|Extension|Wing` filter in services.ps1); no command places them.
- **Road hierarchy upgrades.** `upgrade_network` exists but nothing triggers it when a road is congested.
- **Water and power capacity planning.** The harness checks headroom only (capacity against last production, electricity import or export). It does not forecast or plan plants before growth.
- **Medium and high density rezoning of existing blocks.** Not designed (FAILURES open issues); autoplay only zones empty land.
- **Editor tutorials.** Out of scope; the bridge requires a loaded city.
- **Signature-building placement.** Popups are read and dismissed; placing signature buildings is not supported.
- **Budget tuning per service.** Only taxes are adjusted; `set_service_budget` is unused by the harness.
- **Terrain- and water-aware large site search.** Large-lot placement uses the occupancy raster, not terrain.
- **Occupancy raster in PowerShell.** Slow on big maps; a mod-side query would be faster.
- **Milestone reward and unlock reading.** Milestone state is read for blockers only; unlock lists are not used for planning.
- **Landfill01 placement.** Large footprint rejected at geometric candidate sites (FAILURES #17, still open in part).

## 9. Feature roadmap (proposed)

- **P1 Transit.** Mod `create_transit_line` / `add_stop` using the game's TransportLine tool systems. Harness `transit` verb that runs bus lines along arterials at about 2k population.
- **P1 Capacity planning.** Read water and power capacity and projected demand; have `grow` build a plant first when headroom is short, instead of only reporting it.
- **P1 Mod-side occupancy.** Move the lot and road raster into a mod query (`get_free_lots` by footprint). Speeds `grow`, `place` and `link`, and is the likely fix for the Landfill01 open issue.
- **P1 Service coverage.** Read the game's service coverage per building, not counts. `services.ps1` then places where coverage is missing.
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
