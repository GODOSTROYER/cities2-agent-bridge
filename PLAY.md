# Playing with play.ps1 (agent quickstart)

Read this instead of COMMANDS.md; LEARNINGS.md has the why.

## Preferred: MCP tools
Use the `cs2` MCP server (HARNESS.md section 4b). Its tools replace most verbs below. Preconditions below still apply.

MCP loop:
1. `run {background: true, seconds}` once. The simulation keeps running while you plan.
2. Plan with non-pausing reads while it runs (`free_lots`, `roadside_lots`, `corridor`, `coverage_gaps`, `project`, `prefabs`, `services`).
3. `snapshot {brief: true}` each decision.
4. If any `needs.<service>.action` is `build`, `fix_services` first.
5. Then `grow` or `build_grid`. Each pauses only for itself; the run resumes.
6. `run_status` for sim share; `timings` for overhead.

Core loop:
1. `snapshot`: money, net, population, demand, jobs, utilities, shortages, ui, `needs`. Non-pausing.
2. If any `needs.<service>.action` is `build`, run `fix_services` (or `place_service` for one exact building) before growth. Escalated needs are orders, not noise.
3. `project` the proposed actions before spending: construction, monthly upkeep, income and net per period. Read `demandWhy` and `jobs.vacantByEdu` before zoning. Judge power by `util.power` use vs production and import, not plant load.
4. `save` and wait for `complete`.
5. Act, plan first: `grow`, `build_grid`, `link`, `buy_tile`, `place_service` with `plan: true`. Check `prefabs` costs and `monthlyUpkeep` before building, then repeat without `plan`.
6. `run` (`seconds`, `speed`, `cashFloor`). A foreground run ends paused; `background: true` keeps it running.
7. `events` (`since` = last `utc`) or `snapshot`. Save again.

Rules:
- During a foreground `run`, `snapshot`, `events`, `ui`, `run_status`, `timings` and the non-pausing reads (`services`, `prefabs`, `free_lots`, `roadside_lots`, `corridor`, `coverage_gaps`, `traffic_hotspots`, `project`) are safe. Mutations, `fix_popup`, `query` and `quit` refuse with `run_in_progress`. With `background: true`, a mutation pauses only for itself and the run resumes.
- After a `timeout` error, do not resend the mutation. Read `snapshot` first.
- `monthlyUpkeep` is set only by `place_service`. Road and tile upkeep show in `snapshot` expense after the next budget period. `project` leaves them out too.

- Use the quit tool (save + clean quit) instead of leaving the game idle during long offline work.

Run from the harness folder: `.\play.ps1 <verb> [options]` (PowerShell 7).

## Preconditions
- City loaded, game paused.
- Owner ticked Options > Cities II Agent Bridge > Allow local bridge controls. It resets on every city load.
- Never close, launch, install or kill the game without owner permission. The bridge has no quit command.

## Core loop
1. `play.ps1 look`
2. `play.ps1 save before-x`
3. Act: `grow`, `grid -X x -Z z`, or `zone -X x -Z z`. Add `-Plan` first when unsure.
4. `play.ps1 run -Seconds 300`
5. `play.ps1 look`
6. `play.ps1 save after-x`. Leave the game paused.

## Verbs

| verb | what | typical output |
|---|---|---|
| `look` | city, demand, budget, utilities, problems, top expenses, ui | ~7 lines |
| `ui` | speed, pause blocker, screen, dialogs | 1 line |
| `fix` | clears safe pause blockers (tutorial, milestone) | 1 line per fix, then ui |
| `sites [-Cols 3 -Rows 2 -N 3]` | free dry flat owned land near roads | 0-3 lines |
| `grid -X x -Z z [-Cols -Rows -Zone res\|com\|ind\|resmed -Plan]` | road grid, zone, connect | ~5-10 lines |
| `grow [-Cols -Rows -Plan -Zone res\|resmed\|com\|ind\|off]` | pick zone by demand, find site, build grid | 1 line + grid lines |
| `zone -X x -Z z [-R 300 -Zone res]` | zone all zonable cells in radius | 1 line |
| `run [-Seconds 600 -Speed 4 -Floor 150000]` | bounded simulation, auto-fixes tutorials | 1 summary line + triage lines |
| `save [label]` | checkpoint, waits for `complete` | 1 line |
| `prefab <name> [kind]` | name to index | 1 line |
| `raw <command> [json] [-Full]` | bridge call, noisy fields stripped | JSON, size varies; last resort |

## Reading look output
- Demand line: R/C/I/O. 100 = strong demand. `grow` skips anything under 20.
- utilities line: `IMPORTING power` means build power plants. Water and sewage % of capacity near 100% means build plants.
- problems line: `*_shortfall` = supply shortage (often transient on new buildings). Any other issue = connection problem; fix the roads.
- ui line: `PAUSED BY <x> (play fix)` means run `play.ps1 fix`. If it stays paused or has no `(play fix)` tag, ask the owner.

## Token rules
- Read through `play.ps1` or `raw`. Never call `bridge.ps1` directly for reads.
- Any read pauses the game, including `look` and `raw`. Never query while `run` is active; wait for it to exit.
- Prefer `grow` or `grid` over hand-placing roads.
- Use `-Plan` first when unsure.
- One `look` per decision, not per action.
- Add `-Full` to `raw` only when the lean output lacks what you need.

## Safety
- Never replay a mutation after a timeout. Run `look` and inspect state first.
- Batches do not roll back. A failure stops the batch and earlier steps stay applied.
- STOP latch: run `bridge.ps1 stop` to halt bridge actions. Do not clear the latch without owner permission.
- Before any mutation, `save` and wait for `complete`.
- End with the city paused and saved.
- Before asking the owner to exit, reload or install anything: `play.ps1 save` and wait for `complete`.
- GPU/driver trouble or a hang: save, quit, report; do not keep relaunching.
