# Harness redesign: live play through an MCP server

Status: Phase 1 complete (2026-10-10, verified live). Phase 2 in progress.

## Why
The script harness (play.ps1, autoplay.ps1 and friends) works but is the wrong architecture for live play. Evidence is in FAILURES.md (36 entries):
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

## Phase 3: strategist and operator
- The strategist (Claude, fresh session) reads `snapshot` + `CITYPLAN.md` every few game months and issues a small plan of typed actions.
- The operator (Haiku) handles events: popups, power at 90%, deficits, fires. It escalates anything unusual.
- Retire autoplay.ps1's hard-coded rules; keep play.ps1 for manual debugging.

## Constraints (unchanged)
- Never force-kill the game. Save (verified) before quit; load only at the main menu; the owner's `test` and `Olympia` saves are untouched.
- Demolition is opt-in and limited to ordinary growables.
- Build only into `rebuilt/` or `artifacts/releases/`. DLL backups never go under Mods (FAILURES #26).
- Token efficiency: compact outputs, event-driven wake-ups, fresh sessions.
