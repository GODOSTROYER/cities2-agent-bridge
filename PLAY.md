# Playing with play.ps1 (agent quickstart)

Read this instead of COMMANDS.md; LEARNINGS.md has the why.

## Preferred: MCP tools
Use the `cs2` MCP server (HARNESS.md section 4b). Its tools replace most verbs below. Preconditions below still apply.

Start once: `run {background: true, seconds}`. The simulation keeps running while you plan.

Play cycle (every decision):
1. `snapshot {brief: true}`: money, net, demand, jobs, utilities, `needs` (with `factor` and `priority`), `happinessPriority`, `icons`, `jams`. Non-pausing.
2. `happiness`: factors worst first, each with a verdict (act_now, act, watch, waiting, improving, investigate, report_only). Non-pausing.
3. `notifications`: on-map icons by type. Every cycle.
4. Act in this order:
   - very_high first: `act_now` factors and `needs` with action `build` (`fix_services`, or `place_service` for one exact building). Ruins: `clear_ruins`. Jams: `fix_traffic`.
   - Then priority: `act` factors, this cycle, ahead of growth.
   - Then growth: `grow`, `build_grid`, `link`, `buy_tile`, `build_arterial`. Use `project` first and `plan: true` where offered.
5. Never add a third building for a factor that two actions did not move. Verdict `investigate` means stop: find the cause with `crime_map`, `home_clusters` or `coverage_gaps` (through `query`, outside a foreground run).
6. Tax: call `tax_autopilot` each cycle (see Tax policy) and report the rates, tax income, net, cash and the Tax factor.
7. `run {seconds, speed, cashFloor}`. A foreground run ends paused. Then `events` (`since` = last cursor) and `snapshot`. Save again.

Tax policy (owner's rule, `journals\tax-pins.json`, HARNESS.md "Tax pins"):
- Revenue-first, inside the owner's ranges: Residential 15; Industrial, Commercial and Office 10-11.
- Each cycle call `tax_autopilot` (apply=false reads; apply=true takes one step). It keeps a rate inside its range, lowers a zone when its demand is under 20, raises one when demand is 60+ and unemployment is under 10%, and waits 10 minutes after a change to an area.
- Rates outside a range are owner direction only (`set_tax` with `ownerSaid=true`). Never change them on your own initiative.
- The Tax factor is exempt from the priority rules (verdict `report_only`). Report it, flag it below -5, and never lower rates or add buildings because of it.
- Report demandWhy, unemployment, rates and tax income next to every tax decision.
- Housing only when unemployment is under ~10%; jobs first otherwise (FAILURES #61, #64, #68).

Rules:
- During a foreground `run`, `snapshot`, `events`, `ui`, `run_status`, `timings`, `happiness`, `notifications` and the non-pausing reads (`services`, `prefabs`, `free_lots`, `roadside_lots`, `corridor`, `coverage_gaps`, `traffic_hotspots`, `project`) are safe. Mutations, `fix_popup`, `query` and `quit` refuse with `run_in_progress`. With `background: true`, a mutation pauses only for itself and the run resumes.
- After a `timeout` error, do not resend the mutation. Read `snapshot` first.
- `cost` is the game's quoted figure with `costSource` `quoted` for city-logic tools; `cash_delta` is a labelled fallback. `upgrade_road`, the `legacy` paths and `set_tax` are still money deltas or zero (FAILURES #66).
- `tax_autopilot` with `apply=true` is not refused during a foreground run yet (FAILURES open issues): call it between runs only.
- `monthlyUpkeep` is set only by `place_service`. Road and tile upkeep show in `snapshot` expense after the next budget period. `project` leaves them out too.
- Use the quit tool (save + clean quit) instead of leaving the game idle during long offline work.

Run from the harness folder: `.\play.ps1 <verb> [options]` (PowerShell 7).

## Preconditions
- City loaded, game paused.
- Owner ticked Options > Cities II Agent Bridge > Allow local bridge controls. It resets on every city load.
- Never close, launch, install or kill the game without owner permission. The bridge has no quit command.

## Core loop (script verbs)
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
