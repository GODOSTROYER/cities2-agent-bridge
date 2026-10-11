# Harness redesign: live play through an MCP server

Status: Phases 1 and 2 implemented and verified live (2026-10-10); harness overhead work and the fork-audit fixes B1-B16 landed; Phase 3 (strategist/operator) not started.

## Why
The script harness (play.ps1, autoplay.ps1 and friends) works but is the wrong architecture for live play. Evidence is in FAILURES.md (69 entries):
- **The agent is blind while the game runs.** Every bridge read except a few status calls runs `PauseAnalysis()` (Mod.cs Dispatch). So the agent either watches or plays, and problems (24% unemployment, a -₡113k/period budget) surfaced late.
- **Decisions are hard-coded thresholds in scripts**, so the agent patches rules instead of reasoning about the city.
- **It's slow.** Spatial work happens in PowerShell: the occupancy raster, site search and connector search take 1–4 minutes per cycle.
- **It's brittle.** Scripts call scripts and parse each other's text output.
- **No economic model.** Nothing shows an action's monthly upkeep before it is taken.

## Target architecture
```
Claude (strategist, fresh sessions)  ──MCP tools──▶  cs2 MCP server (Node/TS or Python)
Haiku (operator, routine events)     ──MCP tools──▶        │  mailbox files (existing protocol)
                                                            ▼
                                     CitiesIIAgentBridge mod (C#, game main thread)
                                       ├─ snapshot (non-pausing, cached each N frames)
                                       ├─ events.jsonl (pushed: milestone, popup, fire,
                                       │   shortage, deficit, abandonment, blackout)
                                       ├─ spatial queries in C# (free lots, coverage gaps,
                                       │   corridors) — milliseconds, not minutes
                                       └─ existing safe actions (native preview, reasons,
                                           save/quit/load guards, popups)
```

## Phase 1 (do this first): see live, act through typed tools
1. **Mod: `get_snapshot`, non-pausing.**
   - Built on the main thread every ~256 frames into a cached `JObject`. The command returns the cache without pausing. Add it to the `statusOnly` list in `Mod.Dispatch`.
   - Target under 2 KB. Contents:
     - City: name, population (+ moving in), money, net per period, income and expense top 5.
     - Taxes, and demand for R low/med/high, C, I, O.
     - Unemployment, homeless, workers vs jobs.
     - Happiness, health, and the 3 worst happiness factors.
     - Utilities: power, water and sewage production vs capacity.
     - Persistent shortage counts by type; service buildings with efficiency penalties, grouped.
     - Milestone (achieved, xp, nextXp, blockedBy).
     - The UI blocker (reuse `UiState`); the 3 newest chirps.
     - Simulation speed and frame.
   - Reuse code from Diagnostics.cs, UiState.cs and CityCommands.cs. Never throw on a missing field; put the error in `errors[]`.
2. **Mod: `events.jsonl`** under the mailbox root, appended on the main thread with a type, frame, utc and a short payload. Cover:
   - milestone reached or popup shown
   - tutorial card
   - signature popup
   - net per period turns negative or positive
   - power, water or sewage above 90%
   - new persistent shortage type
   - fire (building with an OnFire component)
   - abandoned or condemned building counts rising
   - city loaded or unloaded

   Rotate at 1 MB.
3. **The `cs2` MCP server** in a new `mcp/` folder, using TypeScript with `@modelcontextprotocol/sdk`, or Python with the `mcp` package; pick one and keep it small. It speaks the existing mailbox protocol (copy the logic of `bridge.ps1`: session.json heartbeat, request/response files, 16 KB limit, compact JSON, the culture-safe date fix). Tools:
   - `snapshot()`: the new non-pausing command.
   - `events(since?)`: tail of events.jsonl.
   - `ui()` / `fix_popup()`: wrap get_ui_state / resolve_pause_blocker.
   - `run(seconds)`: bounded simulate_step loop like run-session.ps1, returning a one-line summary. Tutorial and milestone pass-through stays on.
   - `build_grid({x,z,cols,rows,zone})` and `grow({zone?})`: for Phase 1 these may shell out to the existing `play.ps1` verbs. Return their summary lines.
   - `place_service({type})`, `set_tax`, `set_service_budget`, `buy_tile`, `save()`, `restart()` (calls upgrade.ps1).
   - Every mutating tool returns `cost` and, where known, `monthlyUpkeep` (from prefab `rawData` ServiceUpkeepData / ConsumptionData `m_Upkeep`), so the agent sees running cost before committing.
   - Register it for this project in `.mcp.json` at the harness root and document it in HARNESS.md.
4. **Verify live.** The game is closed at the start of Phase 1.
   - Build and install with `upgrade.ps1 -Build`. It launches the game and the bridge loads the newest autosave unattended.
   - Call `snapshot` while a `run` is in progress and confirm the simulation keeps advancing (frame increases, no `game_paused` stop).
   - Confirm events appear.
   - Then play a few cycles purely through MCP tools and record cost per decision in tokens.
5. **Keep everything working.** play.ps1 and autoplay.ps1 stay usable until Phase 3. Run `tests/HarnessTests.ps1` and `tests/PackageTests.ps1` (they must pass), log any failure in FAILURES.md (root cause, fix, prevention), commit with the attribution trailer, and push to `agent-harness` (never main, never force).

## Phase 1 results (2026-10-10, live)
- `snapshot` during `run(90)`: 18 calls, speed stayed 4, frame 3,217,356 -> 3,228,684; run ended `done` (no `game_paused`).
- Events seen: `city_loaded`, `fire` (NA_ResidentialLow01_L2_3x6 at -263,-1103), `condemned`, `net_positive` (net -1,875 -> +26,379).
- Frame rate ~130 frames/s at speed 4 after a fresh launch, for both the MCP run and the old `run-session.ps1` (earlier sessions ~228/s). Environmental: the snapshot costs ~2 ms per build.
- Round Rock before: pop 1,427; money 275,810; net -62,235/period; unemployment 18.1%; taxes R15 C13 I15 O10; power use 19% of production.
- Decisions:
  - C tax 13 -> 10, I 15 -> 11 (native demand factor Taxes -240 for commercial, -450 for industrial).
  - Office 2x1 grid (4,064; 537 cells); unemployment fell to 6.3% in 5 min (jobs 606 -> 931).
  - Bought tile 59644 (25,356; map tile upkeep rose ~11k/period).
  - Medium-density residential 2x2 (5,568; 1,105 cells).
  - Industrial 2x1 at the tile's south edge, 250 m from homes (5,184; 588 cells).
- After: pop 2,295; money 212,357; net +80,528/period; unemployment 14.2%; xp 10,609 / 13,600 for milestone 5; power 39% of production.
- Tokens per decision: ~1-2k for snapshot, one action and the run summary.

## Phase 2: spatial and economic intelligence in the mod
- `find_free_lots(width, depth, near, maxLink, avoid=[industry|highway|water])`: occupancy in C# using the game's own zone, lot and network data. It replaces Get-BridgeOccupancy, Find-Sites and the connector search.
- `coverage_gaps(service)`: from the game's service coverage data, not distance guesses.
- `corridor(from, to)` for arterials.
- `traffic_hotspots(top)` from edge traffic counters.
- Upkeep and income projection per proposed action.

## Phase 2 results (2026-10-10, live)
- Timings in the mod: `free_lots` 120-480 ms, `coverage_gaps` 1-15 ms, `traffic_hotspots` 5 ms, `grid_connectors` 59 ms for 1,245 links, `corridor` 28-78 ms, `project` under 10 ms.
- Grow plan: 20 s end to end (was minutes).
- Extras beyond the spec: `grid_connectors`, `find_roadside_lots`, service-need escalation (snapshot `needs`, services.ps1), popup auto-resolve (`src/AutoResolve.cs`).
- City progress (Round Rock): pop 1,427 -> 3,319; net -62k -> +128k per period; unemployment 18% -> 7.9%; milestone 5 reached.

## Harness overhead (2026-10-10)
- Full grid cycle: 64 s (PowerShell) -> 33 s (first native) -> 17 s -> 6.6 s.
- Removed: 250 ms mod tick (now ~15 ms while busy); one road per block side, 17 roads (now one per grid line, 7 operations); one zone rectangle per block, 46 blocks = 19 s (now direct cell zoning, one frame); ~100 mailbox round trips at 200-350 ms (now single `multi` and planning queries, 12 ms polling).
- At 6.6 s: sites 1.1 s, plan 0.2 s, preview 2.7 s, build 2.4 s, zone 0.08 s, verify 0.05 s.
- Left: road preview and build are frame-bound (~10 frames per tool operation, ~0.35 s per road). Tile purchase and save still shell out to PowerShell. The project should calibrate upkeep with the observed ~2.7x factor (FAILURES #47).

## Happiness-driven services and icons (2026-10-10)
What exists now:
- **Happiness factors** are read in the snapshot (`happiness`, `happinessPriority`, `worstHappy`). Owner thresholds: worse than -5 very_high (act now), worse than -3 priority (act this cycle), Tax exempt (report only).
- **Needs** (`ServiceSignals.NeedScore`) carry the factor value and its priority. A need with score >= 3 gets action `build` and is built ahead of growth.
- **`happiness` tool** (`mcp\src\happiness.ts`) gives the verdicts (act_now, act, watch, waiting, improving, investigate, report_only, no_fix_known) from `journals\happiness-history.jsonl` and `journals\actions.jsonl`. A factor that two actions did not move gets `investigate`.
- **Notification icons** are read by the mod (`notifications`, snapshot `icons` and `jams`). Icons are acted on by `clear_ruins` (burned-down or collapsed buildings) and `fix_traffic` (jams and congested Small Roads).
- **`build_arterial`** routes a Medium Road along the lot-free corridor, with each segment previewed by the game.
- Live evidence: `clear_ruins` bulldozed 4 burned-down buildings in 2.3 s (FAILURES #60). Factor movements are in LEARNINGS.md.

## Phase 3: strategist and operator
- The strategist (Claude, fresh session) reads `snapshot` + `CITYPLAN.md` every few game months and issues a small plan of typed actions.
- The operator (Haiku) handles events: popups, power at 90%, deficits, fires. It escalates anything unusual.
- Retire autoplay.ps1's hard-coded rules; keep play.ps1 for manual debugging.

## Transit (next step)
Status: `transit_status` (`src/Transit.cs`) reads what the city can build: the line, stop and depot prefabs with lock state, placed depots and stops, and existing lines. A depot can be placed with `place_service`. The line itself is not yet created (FAILURES #69).

Plan, from reflection on the game assembly (not yet verified in code):
1. A line is a `Game.Routes.Route` + `TransportLine` entity, made by `Game.Tools.RouteToolSystem` (kToolID "Route Tool").
2. The tool only emits definitions (`CreationDefinition`, `ColorDefinition`, a `WaypointDefinition` buffer). `GenerateWaypointsSystem`, `GenerateRoutesSystem` and `ApplyRoutesSystem` turn those into entities.
3. Control points come from `GetControlPoints(out JobHandle)`. Each must have `m_OriginalEntity` = a stop entity whose prefab has `TransportStopData` of the line's TransportType (checked by `SnapJob.ValidateStop`).
4. Drive the private `SnapControlPoints(JobHandle, Entity)`, `UpdateDefinitions(JobHandle, Entity)` and `Apply(JobHandle, bool)` by reflection, the way `BridgeRoadTool` drives `NetToolSystem` (`src/Construction.cs`, via `ConstructionAccess`; snap masks per FAILURES #55).
5. Success = a new non-Temp entity with `Route` + `TransportLine`, then `Route.m_Flags` Complete after pathfinding.
6. The tool does not check money or the Locked tag itself, so the bridge must check both before it starts a line.
7. Stops are objects placed on road edges (`ObjectToolSystem`). A depot (`TransportDepotData` of that type) must exist first.
## What is left
- Highway junction at (-800, 17): the single ramp is the traffic bottleneck; wider prefabs are locked.
- Local jams inside dense blocks whose only connector is the bottleneck: `add_connections` found no accepted link for the block at -55,-245 (FAILURES open issues).
- Second highway connection at (-1303,-100): an at-grade junction on the mainline; watch it.
- Transit lines: see Transit (next step) above (P1 in HARNESS.md section 9).
- `upgrade_road` and the `legacy` paths still return a money delta as `cost`, with no `costSource`.
- `tax_autopilot` with `apply=true` is not guarded by `run_in_progress` or popup clearing.
- `commands.json` descriptions: 75 of 75 are empty (`undocumented: true`).
- Phase 3 (strategist and operator), not started.

## Constraints (unchanged)
- Never force-kill the game. Save (verified) before quit; load only at the main menu; the owner's `test` and `Olympia` saves are untouched.
- Demolition is opt-in and limited to ordinary growables.
- Build only into `rebuilt/` or `artifacts/releases/`. DLL backups never go under Mods (FAILURES #26).
- Token efficiency: compact outputs, event-driven wake-ups, fresh sessions.

## Phase 4: city manager

**Problem.** Until now the owner spotted each issue (cemetery, unpowered district, housing hold, post, parking, highway) and a rule was patched in. The harness must notice, diagnose, fix and verify every system by itself, and get better over time, at near-zero token cost.

**Shape.** One loop, five layers, all in code (`mcp/src`), driven by one policy file. A model is called only when the code cannot decide.

| layer | what it does | where | state today |
|---|---|---|---|
| Policy | Owner goals and hard constraints as data: mode (grow / bank / improve), targets per system, net floor, reserve, tax pins, "never" list. A change of mind is an edit to `policy.json` | `policy.json`, read every cycle by `pilot-cycle.ts` | live (mode, floor, reserve); targets still partly constants |
| Sense | For every system three views plus trend: capacity (headroom), coverage, outcome. One cached pass in the mod, the game's own values | mod `get_metrics` (`service_headroom`, outcomes, traffic, icon clusters, infoview names), snapshot; `metrics-history.jsonl` | live for 27 systems; unknown: transit, bicycles, disaster control, administration, outside connections, wealth, level, extractors, water pollution |
| Diagnose | For a bad row, name the cause class: capacity, coverage, access/traffic, staffing, budget, siting/pollution, locked, knock-on. Cross-system links rank root causes first (traffic -> fire, police, ambulance, garbage, post; pollution and garbage -> health; education -> jobs) | `diagnose.ts` (pure) | to build (increment 2) |
| Plan | Candidate actions per cause with predicted effect, one-off cost, monthly upkeep, risk. Filter by constraints (net floor by upkeep projection, reserve, site rules, never-list), choose by benefit per upkeep, zero-upkeep fixes first, native preview before commit | `pilot.ts` `decide`, `budget.ts` (`spendVerdict`, `floorVerdict`), tools | live as fixed rules; candidate ranking to build (increment 3) |
| Act, verify, learn | Every action records expected effect and a check-back time. Moved -> effective; not moved -> ineffective, undone when it costs upkeep, next hypothesis. Effects table per action type and context feeds planning. Mistakes become guards | `happiness.ts` verdicts, `actions.jsonl`; `effects.jsonl` | verdicts live for happiness factors; effects table and undo to build (increment 3) |

**Cadence (event-driven).** Fast tick every cycle (60 s): critical only - utilities, network warnings, fires, cash, net floor. Review every checkpoint (15 min, about a game day): full metrics, ranked `REPORT.md`, act on the top items. Strategic review at each milestone or hourly: Opus reads `REPORT.md` and the trends, records decisions in `CITYPLAN.md`. Events wake the review early: a status change for the worse, a new icon cluster, net under the floor.

**Escalation ladder (cost).** 1. Code rules: zero tokens. 2. Haiku operator: ambiguous cases from a compact case file (`journals/pilot/last-line.txt`, `REPORT.md`), about 8k tokens per look. 3. Opus: strategy, new failure classes, mod internals. 4. Owner: only a real trade-off, as one question with options. Every escalation that recurs is turned into a code rule and a test.

**Self-audit (every review, in `REPORT.md`).** The definition-of-done checklist (factors at 0 or better except Tax, every system good, flow 75%+, no icons, net at or above the floor); stuck items (a need unresolved for N reviews, demand unmet, an action that keeps failing); unread systems; rules that contradict the game's signals ("Rule conflicts" in progress.md).

**Choices and trade-offs.**
- Rules in code, not a model in the loop: a cycle costs nothing and is testable; the cost is that every new failure class needs one Opus session to encode. Accepted: each of the 107 logged failures became a rule or a guard.
- Score on the WORSE of capacity, coverage and outcome, and take thresholds from the game's own configuration (mail tolerance, garbage warning limit, crime tolerance, station flags). Planning norms and guessed thresholds misled three times (#99, #105, #107).
- Policy as presets, not free-form: modes are small sets of switches (expansion on/off, floor on/off, reserve) so a mode change cannot leave the loop in an untested combination. Each mode has tests.
- Net floor by projection with a measured factor (listed upkeep x 2.7) rather than waiting for the budget to show it: slower growth of services, but revenue cannot be spent twice.
- Spatial tools return worst clusters with positions, never maps (tokens), and every builder previews natively.

**Order of work (most valuable first).**
1. Policy file, improve mode, net floor, definition of done - DONE 2026-10-11.
2. Diagnosis layer with cross-system links; `REPORT.md` shows the cause and ranks root causes first.
3. Verify-and-learn: effects table per action type, automatic undo of ineffective upkeep, guards from mistakes.
4. Traffic and transit tools: volume-against-flow analysis with failure class, junction choice by class, transit planner (bus lines are locked in this city: reader first).
5. Remaining readers (nothing unknown), scenario tests replayed from saved snapshots, daemon watchdog.

**Robustness.** Full suites after every mod edit (C#, HarnessTests, MCP); scenario fixtures (district without power, post failing with capacity fine, maxed demand with an education mismatch, net under the floor); the daemon stops and says so after five failed cycles and never launches or kills the game; no hard gate on a single indicator (audit in FAILURES #91).
