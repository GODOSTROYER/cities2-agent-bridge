# Using Cities II Agent Bridge effectively (field notes)

Field-tested notes from live sessions with bridge **0.5.0-community** on CS2 **1.6.2f1** (Windows, PowerShell 7.6, en-IN locale).
Read this before AGENTS.md and COMMANDS.md. Those files say what the bridge allows. This file covers how it behaves in practice and which harness tools to use.

> This folder is a **git-tracked working copy** of the release package. `bridge.ps1` is patched (see "Harness bugs fixed"), so `verify-package.ps1` reports a mismatch here by design. Install only from the pristine, SHA-256-verified release ZIP. Use this copy to drive the game. `git log` shows every change made to it.

## Quick start (city loaded, paused, "Allow local bridge controls" ticked)

```powershell
$h = "$env:USERPROFILE\Documents\CitiesIIAgentBridge-harness"
Import-Module "$h\lib\BridgeClient.psm1" -Force
Invoke-Bridge ping
Invoke-Bridge get_capabilities                 # controlEnabled must be true
$op = Invoke-Bridge save_checkpoint @{ label = 'before-agent-session' }
Wait-BridgeOperation $op.id                    # 'queued' is NOT saved; wait for 'complete'

# Build a connected, zoned neighbourhood in one validated call (dry run first):
& "$h\grid.ps1" -X -880 -Z -460 -Columns 3 -Rows 1 -PlanOnly
& "$h\grid.ps1" -X -880 -Z -460 -Columns 3 -Rows 1

# Simulate 10 minutes in bounded steps; stops (paused) on anything abnormal:
& "$h\run-session.ps1" -TotalSeconds 600 -Speed 4 -CashFloor 150000

$op = Invoke-Bridge save_checkpoint @{ label = 'after-agent-session' }; Wait-BridgeOperation $op.id
```

## Harness tools

| Tool | Purpose |
|---|---|
| `lib/BridgeClient.psm1` | `Invoke-Bridge` throws on `ok:false` and returns `.result`. `Get-BridgePaged` follows `nextOffset` and returns the array whatever it is named. `Wait-BridgeOperation` and `Wait-BridgeBatch` poll until done. `Invoke-BridgeSteps` splits steps into batches under 16 KB and 64 steps, and continues past proven no-op zoning steps. `Invoke-BridgeRoad` inspects the blocker on rejection and optionally retries at perpendicular offsets. `Get-BridgeRoadGraph`, `Find-BridgeNearestNode` and `Test-BridgeNodesConnected` check connectivity locally. |
| `grid.ps1` | Builds a world-aligned road grid, adds a validated connector to existing roads and plans it with `plan_neighborhood`. It executes with automatic before/after saves, zones the blocks with `zone-fill.ps1` and verifies connectivity. `-PlanOnly` is read-only. |
| `zone-fill.ps1` | Zones every **Visible** unzoned cell in an area with one block-attached rectangle per block. It reports verified before/after counts from live cell state. `-WhatIf` is read-only. |
| `run-session.ps1` | Chains bounded `simulate_step` intervals (max 50 s each) up to `-TotalSeconds`. It logs to `journals/run-session.jsonl`, triages utility shortages and exits paused on abnormal stops. |

## How the bridge actually behaves

### Connection
- `bridge.ps1` needs a heartbeat newer than 10 s in `%LOCALAPPDATA%\CitiesIIAgentBridge\session.json`. If `session.json` looks fresh but the client says "stale", suspect date parsing (fixed here).
- Requests over **16384 bytes** are rejected with `request_too_large` and **nothing is applied**. The response file says so, but the client used to print it in a way that was easy to miss.
- Every response is `{ok, result | error}`. Always check `ok`. For async work, `status: queued` only means accepted: poll `get_operation` or `get_batch`.

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

### Zoning: the main time sink
- Each road side creates **zone blocks** of up to 8 × 6 cells (8 m). Where blocks from perpendicular roads overlap, the game keeps one and flags the other's cells `Blocked`. **Blocked cells can never be zoned**, and `zone_rectangle` on them returns `no_zone_cells_in_rectangle`. That is a correct no-op, not a failure.
- About 25% of the cells around a grid are `Blocked` duplicates. Count only `Visible` cells when measuring coverage.
- Use a **block-attached start** (`start.index/version` = the block) so the rectangle follows the block's axes. Otherwise the camera orientation decides, which is unpredictable.
- A rectangle can spill into neighbouring overlapping blocks, so the per-step "changedCells" can exceed the block's size. Verify by re-reading cells; don't sum the operation results.
- Zoning costs nothing and never consumes `maxCost`.

### Batches and neighbourhood plans
- `batch_execute` is sequential and **stops at the first failure**, with no rollback. One harmless `no_zone_cells_in_rectangle` used to abort 50 good steps. `Invoke-BridgeSteps` resumes past that specific proven no-op only.
- `plan_neighborhood` is **read-only and fast**. Use it as a validator: it checks spending bounds against `maxTotalCost`, treasury and reserve, and overlap with existing buildings (`existing_building_overlap`). Plans expire after 5 minutes. `execute_neighborhood` adds `before-neighborhood` and `after-neighborhood` saves automatically, for a maximum of 62 of your own steps.
- **Do not use `plan_neighborhood`'s built-in `grid` option.** Its roads are not attached to the network, and its zones are raw world rectangles inset 12 m with no block attachment (camera-dependent). `grid.ps1` generates explicit roads and zones afterwards with `zone-fill.ps1`.
- Connectors: diagonal links into an already-built area usually hit houses. Prefer a straight extension of a dead end to the nearest point on the new grid's perimeter. `grid.ps1` tries candidates by distance until a plan validates.

### Simulation
- `simulate_step` allows at most 60 s of wall time. Chain steps; overhead is about 1 s per step. Speed 4 is the maximum and gives about 11.7k frames per 50 s.
- Stop reasons: `wall_deadline` and `frame_limit` are normal. `cash_floor`, `new_utility_shortage`, `population_changed`, `demand_changed`, `simulation_stalled`, `game_paused`, `control_stopped` and `city_changed` need a look.
- To stop a run safely: kill the client loop first so no new step starts, then `cancel_simulation_step`. It returns `paused:true`; confirm with `get_city_state` (`selectedSpeed` 0).
- Growth follows **zoned capacity**. With residential demand at 100, population went 127 → 201 → 281 → 316 and then flattened (+1, +3 per 50 s) once the zoned lots filled. When `delta.population` stalls while demand is high, zone more land; don't just simulate longer.
- `analysisPausesGame: true`: **any** read command (even `get_build_prefabs`) pauses the game, ending the active step with `game_paused`. Never query while `run-session.ps1` is running; wait for it to finish.

## Harness bugs fixed in this copy (see `git log`)
1. **Culture-dependent heartbeat parse.** PS7 `ConvertFrom-Json` turns `heartbeatUtc` into a `DateTime`. `[DateTimeOffset]::Parse()` then re-parsed its string form in the user's culture (en-IN read 10/09 as 10 Sep), so every command failed with "heartbeat stale". Fixed by using the DateTime directly and parsing strings with InvariantCulture.
2. **Indented request JSON.** Indentation roughly doubled request size and pushed valid batches past 16 KB. Requests are now compact, with a client-side size check that refuses before sending.
3. **PowerShell argument gotcha (caller side).** `myfunc -880 -120` passes the strings "-880" and "-120", and the bridge answers `number_required: x`. Type parameters as `[double]` or pass hashtables.
4. **`$args` is reserved in PowerShell.** Don't use it as a variable name in scripts.

## Safety rules that still apply
- Get the owner's permission before installing, closing or launching the game. The bridge has no quit command; never force-kill the game.
- Save a checkpoint and wait for `complete` before major changes. Never replay a mutation after a timeout; inspect state first.
- Never clear the STOP latch without fresh permission. The "Allow local bridge controls" checkbox resets on every city load.
- Leave the city paused and saved at the end.
