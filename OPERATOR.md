# Operator playbook (Haiku) - Cities: Skylines II harness

You watch a city that a code loop is already playing. You do NOT play by hand unless the loop is down.
Work directory for every command: C:\Users\user\Documents\CitiesIIAgentBridge-harness\mcp

## The loop (already running)
- A daemon calls the MCP tool `autoplay_cycle` once a minute. One cycle = snapshot, self-check, needs (ruins, services, traffic, taxes), growth by the demand bars, development points, save every 30 min, checkpoint to journals/progress.md.
- Watch it with:  `cat ../journals/pilot/last-line.txt`   (one line: pop, cash, net, milestone, XP, what it did, ATTENTION items)
- If the time at the start of that line is more than 5 minutes old the daemon is down. Check `node test/send.ts run_status '{}' 200`. If that answers, run one cycle yourself with `node test/send.ts autoplay_cycle '{}' 600`, sleep 60 s, repeat. If it does NOT answer, escalate (do not relaunch anything).

## Your routine (repeat until told otherwise)
1. `sleep 240` then read last-line.txt. Nothing else if there is no ATTENTION and cash is above 1,000,000.
2. Every 15 minutes read `../journals/progress.md` (it is short).

## Standing rules (the tools enforce them; never work around a refusal)
- Utilities (power, water, sewage) and network warnings (loose cable, pipe, road) are immediate.
- Happiness factor worse than -3 = priority, worse than -5 = very high. Tax is exempt.
- Follow the demand bars: whatever bar is high gets zoned. Never hold housing because of unemployment.
- Keep 1,000,000 cash in reserve. Taxes are pinned (homes 15%, business 10-11%): never call set_tax.
- Site rules: homes away from noise, pollution and downwind of plants. Never lay a ground cable or pipe across water; never cross a highway at grade.
- Never kill, quit or relaunch the game. Never touch saves named test or Olympia.

## What you may do yourself for an ATTENTION item
- "network: ... Powerline Not Connected at [type,x,z]": `node test/send.ts build_line '{"kind":"power_low","fromX":X,"fromZ":Z,"toX":X2,"toZ":Z2,"plan":true}' 400` to the nearest road (get one with `node test/edges.ts X Z 60`), then without plan. If it answers crosses_water or partial, escalate.
- "factor Crime/Healthcare/... worse than -5": `node test/send.ts fix_services '{"maxPlacements":3}' 600` once, then wait two cycles.
- "ruins": `node test/send.ts clear_ruins '{}' 300`.
- Anything else: escalate.

## Escalate (stop and return your summary) when
- a tool answers partial or failed twice for the same thing; a need is still raised after two actions
- "power/water/sewage: connect district at (x,z)" (an unserved district), "no free site ... build an arterial", "not_utility_connected"
- anything about water damage, flooding, a crash, a hang, the daemon down and run_status silent
- cash under 1,000,000, or net income negative
- a rule conflict: an instruction contradicts the demand bars, vacancies, icons or happiness factors
- a new milestone (the agent decides unlocks and where the next districts go)

## Your summary (at most 15 lines)
time span, pop/cash/net/milestone/XP at start and end, what the loop did (from progress.md), each ATTENTION item and what you did, why you stopped.
