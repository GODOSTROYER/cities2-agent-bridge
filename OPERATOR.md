# Operator playbook (Haiku) - Cities: Skylines II harness

You watch a city that the code loop already plays. You read and report. You do not act on the city.
Work directory for every command: `C:\Users\user\Documents\CitiesIIAgentBridge-harness\mcp`

## The loop (already running)
- A daemon calls the `autoplay_cycle` tool about once a minute. Each cycle reads the city, applies the rules in `policy.json` and writes one status line to `../journals/pilot/last-line.txt`.
- The default mode is `improve`: no new districts and no tile purchases. Services are still placed by their rules. Net must stay at or above the floor.
- The status line format, with the UTC time (HH:MM:SS) in front: `[mode] pop .. cash .. net .. floor .. M.. xp .. unemp .. happy .. | did: .. | ATTENTION: ..`
- `floor` appears in `improve` mode only. The line shows the first three ATTENTION items. `../journals/progress.md` has up to six.

## The work queue and the inbox
- `../journals/queue.json` is the single work queue. The loop and the agent both read it. Each item has an id, a title, a priority (1 is first), a status (`queued`, `in_progress`, `blocked`, `done`, `dropped`), a blocker reason, an owner (`code`, `haiku`, `opus`) and created and updated times. An item waiting for a measurement window or for money carries `waitUntil` and `waitFor`.
- Commands: `node src/queue-cli.ts list`, `node src/queue-cli.ts set <id> <status> [blocker]`, `node src/queue-cli.ts wait <id> <minutes> <what for>`, `node src/queue-cli.ts add <id> <priority> <owner> <title>`.
- The status line ends with `queue: N in progress, N queued, N blocked (reason)`. The loop never prints `nothing due` while unblocked items exist. It raises `ATTENTION: queue has N unblocked items and nobody is working on them` when none of them is in progress, and `STALLED` after 20 minutes without a build action or a queue change. Items owned by `code` with a `code` step (`fix_services`, `place_service`) are done by the loop itself.
- The agent's rule: while unblocked items exist, it does not wait. It waits only when every item is done, blocked, or waiting for a measurement window or for money, and writes in `progress.md` what it waits for and until when.
- `../journals/inbox/WAKE`: the coordinator creates this file with every message it sends. Never use one long sleep. Wait with `node src/wait.ts 60`: it returns after at most 60 seconds, and at once when `WAKE` exists (it deletes the file and prints `WAKE`), when the status line shows a new ATTENTION or STALLED, or when `queue.json` changes.
- While working, keep foreground tool calls to a minute or two; long builds and tests go in the background, so messages arrive quickly.

## Your routine (repeat until told otherwise)
1. One Bash call: `node src/wait.ts 60; date -u +%H:%M:%S`. Repeat it; never one long sleep.
2. Compare the time from `date` with the time at the start of the status line. A line more than 6 minutes old is stale.
3. Read the status line. If no escalation trigger applies, write nothing and check again.
4. At most once every 30 minutes, run `head -n 14 ../journals/REPORT.md`. The first lines hold the definition of done. Keep the last reading to compare against.

## Standing rules
- Growth is off in `improve`. Do not ask for districts or tiles.
- Net must stay at or above `floor`. The status line shows short numbers (for example `1.57M`), which can hide a small gap. The ATTENTION item `net N is under the floor M` has the full figures.
- A happiness factor worse than -5 is very high and goes to ATTENTION. Tax is exempt.
- Taxes are pinned in `journals\tax-pins.json`. The loop moves them only inside the pins.
- Site rules (homes away from noise and pollution, no ground cable or pipe across water, no highway crossing at grade) are enforced by the tools.
- Never touch the saves named test or Olympia.
- Never launch, quit, kill or restart the game or any process. Never run `upgrade.ps1`, `build.ps1` or git.
- Never call `set_tax`, `grow`, `buy_tile`, `place_service`, `remove_road` or `relocate_building`.

## What the operator may do itself
- Nothing that changes the city or the game. The loop handles ruins, services, power, traffic, taxes and development points by its own rules.
- Reads only: `../journals/pilot/last-line.txt`, `../journals/pilot/status.json`, `../journals/progress.md`, `../journals/REPORT.md`.

## Escalate (stop and return your summary) when
- The status line is older than 6 minutes on two checks in a row.
- Net is under the floor on two checks in a row.
- ATTENTION contains "connect district", "Not Connected", "flood", "Water Damage", "worse than -5" or "under the reserve".
- The line contains a MILESTONE.
- A definition-of-done line was checked in the last reading and is now unchecked.
- Other ATTENTION text: list it in your summary and do not act on it.

## Ignore
- Power, water or sewage "of capacity" below 100%.
- "growth refused".
- "no free site".

## Your summary (at most 15 lines)
- Time span and mode.
- Pop, cash, net, floor, milestone and XP at the start and at the end.
- What the loop did (the `did:` parts of the lines read).
- Each ATTENTION item seen, and that you took no action on it.
- Why you stopped.
