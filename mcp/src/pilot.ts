// Phase 3: the routine loop as rules. decide() is PURE: from one snapshot and the times of the
// last actions it returns the tool calls for this cycle, in order, each with the reason. The
// runner (pilot-run.ts) executes them through the MCP session, so every guard of the tools
// (popups, reserve, site rules, utility and water checks, owner tax pins) still applies.
// Strategy stays with the agent: what the rules cannot do is listed under `attention`.
import { blockingNeeds, RESERVE } from './budget.ts';

export interface PilotAction { tool: string; args: Record<string, any>; why: string; key: string }
export interface PilotPlan { actions: PilotAction[]; attention: string[] }
export interface PilotMemo { last: Record<string, number>; backoff: Record<string, number>; wantTile?: boolean; milestone?: number }

const MIN = 60_000;
const due = (memo: PilotMemo, key: string, now: number, everyMin: number) => now - (memo.last[key] ?? 0) >= everyMin * MIN && now >= (memo.backoff[key] ?? 0);
const JOBS = ['com', 'off', 'ind'];

// Which zone to grow, by the standing rules: jobs first; housing only under 10% unemployment.
export function growthZone(demand: Record<string, any> | undefined, unemployment: number): { zone: string; demand: number } | null {
  const d = demand ?? {}; const v = (k: string) => Number(d[k] ?? 0);
  const jobs = [{ zone: 'com', demand: v('c') }, { zone: 'off', demand: v('o') }, { zone: 'ind', demand: v('i') }].filter(z => z.demand >= 20).sort((a, b) => b.demand - a.demand);
  if (unemployment >= 10) return jobs[0] ?? null;
  const homes = [{ zone: 'resmed', demand: v('rM') }, { zone: 'res', demand: v('rL') }].filter(z => z.demand >= 20).sort((a, b) => b.demand - a.demand);
  // Under 10%: the strongest demand wins; a job zone at 60+ goes before housing so jobs keep pace.
  if (jobs[0] && (jobs[0].demand >= 60 || !homes[0])) return jobs[0];
  return homes[0] ?? jobs[0] ?? null;
}

export function decide(snap: Record<string, any>, memo: PilotMemo, now: number, reserve = RESERVE): PilotPlan {
  const actions: PilotAction[] = []; const attention: string[] = [];
  const cash = Number(snap.city?.money ?? 0); const unemp = Number(snap.jobs?.unemp ?? 0); const needs = snap.needs ?? {};
  const push = (key: string, tool: string, args: Record<string, any>, why: string) => actions.push({ key, tool, args, why });

  // 1. Utilities and loose network ends are immediate, and they need a decision about WHERE to
  //    connect: the rules cannot make it, so they stop growth and raise it.
  const blockers = blockingNeeds(needs);
  for (const b of blockers) attention.push(`${b.need}: ${b.say ?? 'connect'}${b.at ? ' at ' + JSON.stringify(b.at) : ''}`);
  for (const k of ['power', 'water', 'sewage']) if (needs[k]?.action === 'confirm') attention.push(`${k}: ${needs[k].unserved} buildings short (first snapshot, confirming)`);
  const blocker = String(snap.ui?.blocker ?? 'none');
  if (!['none', 'paused_by_player_or_bridge', 'tutorial_phase', 'milestone_popup', 'signature_popup'].includes(blocker)) attention.push(`ui blocker ${blocker}`);
  for (const p of snap.happinessPriority?.very_high ?? []) attention.push(`factor ${p} is worse than -5 (very high)`);

  // 2. Services by escalation (the planner itself applies scores, coverage and the reserve).
  if ((Number(needs.ruins?.icons ?? 0) > 0 || Number(snap.buildings?.abandoned ?? 0) > 20) && due(memo, 'ruins', now, 5)) push('ruins', 'clear_ruins', {}, 'ruin icons on the map');
  if (due(memo, 'services', now, 4)) push('services', 'fix_services', { maxPlacements: 2 }, 'escalated service needs and coverage gaps');
  const pressing = [...(snap.happinessPriority?.priority ?? []), ...(snap.happinessPriority?.very_high ?? [])];
  if ((pressing.includes('TrafficPenalty') || needs.traffic?.action === 'build') && due(memo, 'traffic', now, 8)) push('traffic', 'fix_traffic', { max: 3 }, `traffic ${needs.traffic?.score ?? ''} factor ${snap.happiness?.TrafficPenalty ?? '?'}`);
  if (due(memo, 'tax', now, 10)) push('tax', 'tax_autopilot', { apply: true }, 'owner pins: one step inside the ranges');

  // 3. Growth: never past a broken utility; jobs first; housing only under 10% unemployment;
  //    the reserve rule is enforced by grow / buy_tile themselves.
  if (!blockers.length) {
    if (memo.wantTile && due(memo, 'tile', now, 6)) push('tile', 'buy_tile', { n: 1 }, 'no free site left for the last growth step');
    const pick = growthZone(snap.demand, unemp);
    if (pick && due(memo, 'grow', now, 2)) {
      const big = cash >= reserve + 300_000;
      push('grow', 'grow', { zone: pick.zone, cols: big ? 4 : 3, rows: big ? 3 : 2 }, `${pick.zone} demand ${pick.demand}, unemployment ${unemp}%`);
    }
  }

  // 4. Housekeeping.
  const milestone = Number(snap.milestone?.achieved ?? NaN);
  if (Number.isFinite(milestone) && memo.milestone !== undefined && milestone > memo.milestone) push('save', 'save', {}, `milestone ${milestone} reached`);
  else if (due(memo, 'save', now, 30)) push('save', 'save', {}, 'rolling save every 30 minutes');
  return { actions, attention };
}

// PURE. What a tool result means for the next cycles: mark the action done, back off after a
// refusal so the same failing call is not repeated every cycle, and ask for land when none is free.
export function learn(memo: PilotMemo, action: PilotAction, result: Record<string, any>, now: number): string {
  memo.last[action.key] = now; const reason = String(result?.reason ?? result?.error ?? '');
  if (action.key === 'grow') {
    if (result?.ok) { memo.wantTile = false; return `built ${action.args.zone} ${result.site?.cols ?? action.args.cols}x${result.site?.rows ?? action.args.rows} for ${result.cost ?? '?'}`; }
    if (reason === 'no_free_site') { memo.wantTile = true; memo.backoff.grow = now + 3 * MIN; return 'no free site: will buy a tile'; }
    if (reason === 'below_reserve' || reason === 'not_enough_money') { memo.backoff.grow = now + 6 * MIN; return `growth waits: ${reason}`; }
    memo.backoff.grow = now + 4 * MIN; return `growth refused: ${reason || 'unknown'}`;
  }
  if (action.key === 'tile') {
    if (result?.ok) { memo.wantTile = false; delete memo.backoff.grow; return `bought a tile for ${result.cost}`; }
    memo.backoff.tile = now + 10 * MIN; return `tile not bought: ${reason}`;
  }
  if (action.key === 'services') { const placed = (result?.placed ?? []).map((p: any) => p.prefab); return placed.length ? `services placed ${placed.join(', ')}` : ''; }
  if (action.key === 'traffic') { const n = (result?.jamIcons?.upgraded ?? result?.upgraded ?? []).filter((u: any) => u.status === 'complete').length; return n ? `widened ${n} roads` : ''; }
  if (action.key === 'tax') return result?.applied ? `tax ${result.area} ${result.from}->${result.to}` : '';
  if (action.key === 'ruins') return result?.cleared ? `cleared ${result.cleared} ruins` : '';
  if (action.key === 'save') return result?.exit === 0 ? 'saved' : `save exit ${result?.exit}`;
  return '';
}

// PURE. The short block the coordinator reads (journals/progress.md), under 25 lines.
export function progressBlock(snap: Record<string, any>, did: string[], next: string[], attention: string[], when: string): string {
  const f = Object.entries(snap.happiness ?? {}).filter(([k, v]) => Number(v) < -3).map(([k, v]) => `${k} ${v}${k === 'Tax' ? ' (exempt)' : ''}`).join(', ') || 'none';
  const icons = Object.entries(snap.icons ?? {}).map(([k, v]) => `${k.replace(/ Notification$/, '')} ${v}`).join(', ') || 'none';
  const lines = [
    `# Progress ${when}`,
    `- pop ${snap.city?.pop}, cash ${snap.city?.money}, net ${snap.city?.net}, milestone ${snap.milestone?.achieved} (XP ${snap.milestone?.xp}/${snap.milestone?.nextXp})`,
    `- unemployment ${snap.jobs?.unemp}%, vacancies by education ${JSON.stringify(snap.jobs?.vacantByEdu ?? [])}, demand ${JSON.stringify(snap.demand ?? {})}`,
    `- happiness ${snap.happy}, factors worse than -3: ${f}`,
    `- icons: ${icons}`,
    `- shortages: ${JSON.stringify(snap.shortages ?? {})}`,
    `- did: ${did.slice(-8).join('; ') || 'nothing yet'}`,
    `- next: ${next.join('; ') || 'keep the loop running'}`,
    ...(attention.length ? [`- ATTENTION: ${[...new Set(attention)].slice(0, 6).join(' | ')}`] : []),
  ];
  return lines.join('\n') + '\n';
}
