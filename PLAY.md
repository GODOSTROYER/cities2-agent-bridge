# Playing with play.ps1 (agent quickstart)

Read this instead of COMMANDS.md; LEARNINGS.md has the why.

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
| `grow [-Cols -Rows -Plan]` | pick zone by demand, find site, build grid | 1 line + grid lines |
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
