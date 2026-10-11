// Phase 3: the routine loop as rules. decide() is PURE: from one snapshot and a small memo it
// returns the tool calls for this cycle, in order, each with the reason. The cycle runner
// (pilot-cycle.ts) executes them through the MCP tools, so every guard of the tools (popups,
// reserve, site rules, utility and water checks, owner tax pins) still applies.
// Strategy stays with the agent: what the rules cannot do is listed under `attention`.
//
// Growth is DEMAND-DRIVEN (FAILURES #91): the demand bars decide what is zoned. No single
// indicator may hold a zone type back. Unemployment is first diagnosed (no jobs, or an education
// mismatch with vacancies open) and only shifts the ORDER when jobs are truly missing.
import { blockingNeeds, RESERVE } from './budget.ts';
import { plannedPeople } from './headroom.ts';

export interface PilotAction { tool: string; args: Record<string, any>; why: string; key: string }
export interface PilotPlan { actions: PilotAction[]; attention: string[]; diagnosis?: string }
export interface PilotMemo {
  last: Record<string, number>; backoff: Record<string, number>; wantTile?: boolean; milestone?: number; turn?: number; lockedZones?: string[];
  zoned?: Record<string, number>;            // kind (housing | com | off | ind) -> time of the last successful district
  starved?: Record<string, number>;          // kind -> cycles in a row with demand 60+ and nothing zoned
  lastGrowReason?: string;                   // why the last growth step was refused
  table?: Record<string, any>; coverage?: Record<string, number>; blocked?: Record<string, string>; // last headroom table, coverage gaps and why a placement failed
  servicesLine?: string; utilityAlerts?: string[]; // last headroom table (one line) and utilities past the target
  needTrend?: Record<string, { count: number; rises: number }>; // need -> icon/people count and rises in a row while "watch"
}

const MIN = 60_000;
const due = (memo: PilotMemo, key: string, now: number, everyMin: number) => now - (memo.last[key] ?? 0) >= everyMin * MIN && now >= (memo.backoff[key] ?? 0);
const HOUSING = ['reshigh', 'resmed', 'mixed', 'resmid', 'res'];
export const kindOf = (zone: string): string => HOUSING.includes(zone) ? 'housing' : zone;

// Why is unemployment high? "no_jobs": few vacancies for the people out of work. "mismatch":
// vacancies are open (workplaces are short of employees) but the unemployed do not fit them -
// an education problem that more housing does not make worse and zoning must not be gated on.
export function diagnoseJobs(jobs: Record<string, any> | undefined, penalties?: Record<string, any>): { state: 'ok' | 'no_jobs' | 'mismatch'; unemployed: number; vacant: number; shortStaffed: number } {
  const unemp = Number(jobs?.unemp ?? 0); const eligible = Number(jobs?.eligible ?? 0), workers = Number(jobs?.workers ?? 0);
  const unemployed = eligible > 0 ? Math.max(0, eligible - workers) : 0;
  const vacant = Number(jobs?.vacant ?? (jobs?.vacantByEdu ?? []).reduce((a: number, b: number) => a + Number(b ?? 0), 0));
  const shortStaffed = Number(penalties?.byFactor?.NotEnoughEmployees ?? 0);
  if (unemp < 10) return { state: 'ok', unemployed, vacant, shortStaffed };
  // Open vacancies for at least half of the unemployed, or workplaces reporting too few employees.
  const mismatch = (unemployed > 0 ? vacant >= unemployed * 0.5 : vacant >= 200) || shortStaffed >= 3;
  return { state: mismatch ? 'mismatch' : 'no_jobs', unemployed, vacant, shortStaffed };
}

// Which zone to grow now. Every zone type with demand 20+ is a candidate; the strongest demand
// wins, a type zoned in the last 6 minutes yields to the others, and housing densities take turns.
// Only a real jobs shortage (diagnosis no_jobs) moves job zones ahead of housing.
export function growthZone(demand: Record<string, any> | undefined, jobsState: 'ok' | 'no_jobs' | 'mismatch' = 'ok', memo: PilotMemo = { last: {}, backoff: {} }, now = 0): { zone: string; demand: number; kind: string } | null {
  const d = demand ?? {}; const v = (k: string) => Number(d[k] ?? 0); const locked = memo.lockedZones ?? [];
  const homes = [{ zone: 'reshigh', demand: v('rH') }, { zone: 'resmed', demand: v('rM') }, { zone: 'mixed', demand: v('rM') }, { zone: 'resmid', demand: v('rM') }, { zone: 'res', demand: v('rL') }].filter(z => z.demand >= 20 && !locked.includes(z.zone));
  const home = homes.length ? homes[(memo.turn ?? 0) % homes.length] : null;
  const cands = [...(home ? [{ ...home, kind: 'housing' }] : []), ...[{ zone: 'com', demand: v('c') }, { zone: 'off', demand: v('o') }, { zone: 'ind', demand: v('i') }].filter(z => z.demand >= 20 && !locked.includes(z.zone)).map(z => ({ ...z, kind: z.zone }))];
  if (!cands.length) return null;
  const score = (c: { demand: number; kind: string }) => c.demand - (now - (memo.zoned?.[c.kind] ?? 0) < 6 * MIN ? 30 : 0) + (jobsState === 'no_jobs' && c.kind !== 'housing' ? 50 : 0) - (jobsState === 'no_jobs' && c.kind === 'housing' ? 30 : 0);
  return cands.sort((a, b) => score(b) - score(a))[0];
}

// Every bar that is high gets a district in the SAME cycle (FAILURES #94: the loop sat on three
// maxed housing bars and millions in cash, building one small district in rotation). All zone
// types with demand 60+ are returned, strongest first, housing in each density whose own bar is
// high (the medium bar alternates row, medium and mixed); when nothing reaches 60 the single best
// candidate with demand 20+ is returned.
export function growthSet(demand: Record<string, any> | undefined, jobsState: 'ok' | 'no_jobs' | 'mismatch' = 'ok', memo: PilotMemo = { last: {}, backoff: {} }, now = 0, max = 4): { zone: string; demand: number; kind: string }[] {
  const d = demand ?? {}; const v = (k: string) => Number(d[k] ?? 0); const locked = memo.lockedZones ?? [];
  const medium = ['resmed', 'resmid', 'mixed'].filter(z => !locked.includes(z)); const med = medium.length ? medium[(memo.turn ?? 0) % medium.length] : null;
  const all = [{ zone: 'reshigh', demand: v('rH'), kind: 'housing' }, ...(med ? [{ zone: med, demand: v('rM'), kind: 'housing' }] : []), { zone: 'res', demand: v('rL'), kind: 'housing' },
    { zone: 'com', demand: v('c'), kind: 'com' }, { zone: 'off', demand: v('o'), kind: 'off' }, { zone: 'ind', demand: v('i'), kind: 'ind' }].filter(z => z.demand >= 50 && !locked.includes(z.zone));
  const rank = (z: { demand: number; kind: string }) => z.demand + (jobsState === 'no_jobs' && z.kind !== 'housing' ? 50 : 0);
  if (all.length) return all.sort((a, b) => rank(b) - rank(a)).slice(0, max);
  const one = growthZone(demand, jobsState, memo, now); return one ? [one] : [];
}

// What to buy with development points, in the order that unblocks growth: education (college for
// the college-level vacancies), transport (bus lines), roads (wider roads, highways), then the
// services whose needs escalate most (health, deathcare, garbage, fire, police), then anything.
export const WISH: RegExp[] = [/college/i, /universit/i, /bus/i, /road|highway|roundabout|bridge/i, /hospital|health|clinic/i, /cremat|death/i, /recycl|incinerat|garbage/i, /fire/i, /police/i, /park|transport|train|tram|subway|taxi/i, /telecom|server|post|welfare/i, /./];
export function wishedNode(nodes: Record<string, any>[], points: number): Record<string, any> | null {
  // Parking nodes cost many points and unblock nothing: only when nothing else is left.
  const fits = nodes.filter(n => n.canBuy && Number(n.cost ?? 0) <= points); const useful = fits.filter(n => !/parking/i.test(String(n.name)));
  const open = useful.length ? useful : fits;
  for (const rx of WISH) { const hit = open.filter(n => rx.test(String(n.name)) || rx.test(String(n.service ?? ''))).sort((a, b) => Number(a.cost) - Number(b.cost))[0]; if (hit) return hit; }
  return null;
}

// PURE self-check (FAILURES #92), run every cycle BEFORE deciding. It updates the memo and
// returns the lines to raise: a zone type whose demand has been 60+ for 5 cycles with nothing
// zoned for it, and a need that sits at "watch" while its count rises 3 cycles in a row.
export function selfCheck(snap: Record<string, any>, memo: PilotMemo, now: number): string[] {
  const out: string[] = []; const d = snap.demand ?? {};
  const demandOf: Record<string, number> = { housing: Math.max(Number(d.rL ?? 0), Number(d.rM ?? 0), Number(d.rH ?? 0)), com: Number(d.c ?? 0), off: Number(d.o ?? 0), ind: Number(d.i ?? 0) };
  memo.starved = memo.starved ?? {};
  for (const [kind, value] of Object.entries(demandOf)) {
    const recently = now - (memo.zoned?.[kind] ?? 0) < 10 * MIN;
    memo.starved[kind] = value >= 60 && !recently ? (memo.starved[kind] ?? 0) + 1 : 0;
    if (memo.starved[kind] >= 5) out.push(`${kind} demand ${value} for ${memo.starved[kind]} cycles and nothing zoned: ${memo.lastGrowReason ?? 'no growth step was planned'}`);
  }
  memo.needTrend = memo.needTrend ?? {};
  for (const [k, n] of Object.entries(snap.needs ?? {}) as [string, any][]) {
    const count = Number(n.icons ?? 0) + Number(n.dead ?? 0) + Number(n.sick ?? 0) + Number(n.unserved ?? 0);
    const t = memo.needTrend[k] ?? { count, rises: 0 };
    t.rises = n.action === 'watch' && count > t.count ? t.rises + 1 : n.action === 'watch' && count === t.count ? t.rises : 0; t.count = count; memo.needTrend[k] = t;
    if (t.rises >= 3) out.push(`${k} is still "watch" (${n.score}) while its count rose ${t.rises} cycles in a row to ${count}`);
  }
  for (const k of Object.keys(memo.needTrend)) if (!(snap.needs ?? {})[k]) delete memo.needTrend[k];
  return out;
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
  if (cash < reserve) attention.push(`cash ${cash} is under the reserve ${reserve}`);
  for (const u of memo.utilityAlerts ?? []) attention.push(u);

  // 2. Services by escalation (the planner itself applies scores, coverage and the reserve).
  if ((Number(needs.ruins?.icons ?? 0) > 0 || Number(snap.buildings?.abandoned ?? 0) > 20) && due(memo, 'ruins', now, 5)) push('ruins', 'clear_ruins', {}, 'ruin icons on the map');
  // Headroom rule: every cycle that grows also sizes the services for the people about to arrive.
  const servicesAt = actions.length;
  const pressing = [...(snap.happinessPriority?.priority ?? []), ...(snap.happinessPriority?.very_high ?? [])];
  const flow = Number(snap.cityFlow ?? NaN); // citywide traffic flow, target above 75%
  if ((pressing.includes('TrafficPenalty') || needs.traffic?.action === 'build' || (Number.isFinite(flow) && flow < 75)) && due(memo, 'traffic', now, 6)) push('traffic', 'fix_traffic', { max: 4 }, `traffic ${needs.traffic?.score ?? ''} factor ${snap.happiness?.TrafficPenalty ?? '?'} flow ${Number.isFinite(flow) ? flow + '%' : '?'}`);
  if (due(memo, 'tax', now, 10)) push('tax', 'tax_autopilot', { apply: true }, 'owner pins: one step inside the ranges');

  // 3. Growth follows the demand bars. Only a broken utility stops it; the reserve rule is
  //    enforced by grow / buy_tile themselves.
  const jobs = diagnoseJobs(snap.jobs, snap.servicePenalties);
  const diagnosis = `unemployment ${unemp}%: ${jobs.state} (${jobs.unemployed} out of work, ${jobs.vacant} vacancies, ${jobs.shortStaffed} services short of staff)`;
  if (!blockers.length) {
    if (memo.wantTile && due(memo, 'tile', now, 3)) push('tile', 'buy_tile', { n: 1, max: 600000 }, 'no free site left for the last growth step');
    if (due(memo, 'grow', now, 1.5)) {
      const big = cash >= reserve + 300_000;
      for (const pick of growthSet(snap.demand, jobs.state, memo, now, cash >= reserve + 600_000 ? 4 : 2))
        push('grow', 'grow', { zone: pick.zone, cols: big ? 4 : 3, rows: big ? 3 : 2 }, `${pick.zone} demand ${pick.demand}; ${diagnosis}`);
    }
  }

  // 2b. Services ahead of need (headroom): every 3 minutes, and in every cycle that zones housing,
  //     sized for the residents the planned districts will bring.
  const planned = actions.filter(a => a.key === 'grow').map(a => ({ zone: String(a.args.zone), cols: Number(a.args.cols), rows: Number(a.args.rows) }));
  const people = plannedPeople(planned);
  if (due(memo, 'services', now, 3) || people > 0)
    actions.splice(servicesAt, 0, { key: 'services', tool: 'fix_services', args: { maxPlacements: 4, ...(people > 0 ? { projectPeople: people } : {}) }, why: `services ahead of need${people ? ` (+${people} people planned)` : ''}` });

  // 3b. Development points: buy the next node on the wish list (what unblocks growth first).
  const tree = snap.devTree;
  if (tree && Number(tree.points ?? 0) > 0 && due(memo, 'unlock', now, 1)) {
    const want = wishedNode(tree.nodes ?? [], Number(tree.points));
    if (want) push('unlock', 'dev_tree', { unlock: want.name }, `development points ${tree.points}: ${want.name} (${want.service}) costs ${want.cost}`);
  }

  // 4. Housekeeping.
  const milestone = Number(snap.milestone?.achieved ?? NaN);
  if (Number.isFinite(milestone) && memo.milestone !== undefined && milestone > memo.milestone) push('save', 'save', {}, `milestone ${milestone} reached`);
  else if (due(memo, 'save', now, 30)) push('save', 'save', {}, 'rolling save every 30 minutes');
  return { actions, attention, diagnosis };
}

// PURE. What a tool result means for the next cycles: mark the action done, back off after a
// refusal so the same failing call is not repeated every cycle, and ask for land when none is free.
export function learn(memo: PilotMemo, action: PilotAction, result: Record<string, any>, now: number): string {
  memo.last[action.key] = now; const reason = String(result?.reason ?? result?.error ?? '');
  if (action.key === 'grow') {
    memo.turn = (memo.turn ?? 0) + 1; const kind = kindOf(String(action.args.zone));
    if (/locked|unknown_zone|zone_prefab/i.test(reason)) { memo.lockedZones = [...new Set([...(memo.lockedZones ?? []), String(action.args.zone)])]; return `zone ${action.args.zone} is locked: skipped from now on`; }
    // A district much smaller than asked for means land is running out: buy ahead.
    const got = Number(result?.site?.cols ?? 0) * Number(result?.site?.rows ?? 0), asked = Number(action.args.cols ?? 0) * Number(action.args.rows ?? 0);
    if (result?.ok && memo.blocked) delete memo.blocked.grow;
    if (result?.ok) { memo.wantTile = got > 0 && got * 2 < asked; memo.zoned = { ...(memo.zoned ?? {}), [kind]: now }; delete memo.lastGrowReason; return `built ${action.args.zone} ${result.site?.cols ?? action.args.cols}x${result.site?.rows ?? action.args.rows} for ${result.cost ?? '?'}`; }
    memo.lastGrowReason = `${action.args.zone}: ${reason || 'unknown'}`; memo.blocked = { ...(memo.blocked ?? {}), grow: memo.lastGrowReason };
    // The cycle runner already bought land and retried (pilot-cycle.ts). Still no site means the
    // land has no road or fails the site rules: buying more does not help (FAILURES #98) - wait for the agent.
    if (reason === 'no_free_site') { memo.wantTile = false; memo.backoff.grow = now + 10 * MIN; memo.backoff.tile = now + 30 * MIN; return 'no free site even after buying land: needs an arterial (agent)'; }
    if (reason === 'below_reserve' || reason === 'not_enough_money') { memo.backoff.grow = now + 6 * MIN; return `growth waits: ${reason}`; }
    memo.backoff.grow = now + 3 * MIN; return `growth refused: ${reason || 'unknown'}`;
  }
  if (action.key === 'tile') {
    if (result?.ok) { memo.wantTile = false; delete memo.backoff.grow; return `bought a tile for ${result.cost}`; }
    memo.backoff.tile = now + 10 * MIN; memo.lastGrowReason = `no free site and no tile: ${reason}`; return `tile not bought: ${reason}`;
  }
  if (action.key === 'unlock') { if (!result?.ok) memo.backoff.unlock = now + 10 * MIN; return result?.ok ? `unlocked ${result.name} (${result.cost} points)` : `unlock refused: ${reason}`; }
  if (action.key === 'services') { memo.servicesLine = result?.services ?? memo.servicesLine; memo.utilityAlerts = result?.utilityAlerts ?? []; if (result?.table) { memo.table = result.table; memo.coverage = result.coverage ?? {}; memo.blocked = { ...(memo.blocked ?? {}), ...(result.blocked ?? {}) }; for (const p of result?.placed ?? []) delete memo.blocked[String(p.t)]; } const placed = (result?.placed ?? []).map((p: any) => p.prefab); return placed.length ? `services placed ${placed.join(', ')}` : ''; }
  if (action.key === 'traffic') { const n = (result?.jamIcons?.upgraded ?? result?.upgraded ?? []).filter((u: any) => u.status === 'complete').length; return n ? `widened ${n} roads` : ''; }
  if (action.key === 'tax') return result?.applied ? `tax ${result.area} ${result.from}->${result.to}` : '';
  if (action.key === 'ruins') return result?.cleared ? `cleared ${result.cleared} ruins` : '';
  if (action.key === 'save') return result?.exit === 0 ? 'saved' : `save exit ${result?.exit}`;
  return '';
}

// PURE. The short block the coordinator reads (journals/progress.md), under 25 lines.
export function progressBlock(snap: Record<string, any>, did: string[], next: string[], attention: string[], when: string, diagnosis?: string, services?: string): string {
  const f = Object.entries(snap.happiness ?? {}).filter(([k, v]) => Number(v) < -3).map(([k, v]) => `${k} ${v}${k === 'Tax' ? ' (exempt)' : ''}`).join(', ') || 'none';
  const icons = Object.entries(snap.icons ?? {}).map(([k, v]) => `${k.replace(/ Notification$/, '')} ${v}`).join(', ') || 'none';
  const lines = [
    `# Progress ${when}`,
    `- pop ${snap.city?.pop}, cash ${snap.city?.money}, net ${snap.city?.net}, milestone ${snap.milestone?.achieved} (XP ${snap.milestone?.xp}/${snap.milestone?.nextXp})`,
    `- unemployment ${snap.jobs?.unemp}%, vacancies by education ${JSON.stringify(snap.jobs?.vacantByEdu ?? [])}, demand ${JSON.stringify(snap.demand ?? {})}`,
    ...(diagnosis ? [`- jobs: ${diagnosis}`] : []),
    `- scorecard: traffic flow ${snap.cityFlow ?? '?'}% (target 75+), happiness ${snap.happy}, health ${snap.health ?? '?'}, power ${snap.util?.power?.pct ?? '?'}% water ${snap.util?.water?.pct ?? '?'}% sewage ${snap.util?.sewage?.pct ?? '?'}%`,
    `- happiness ${snap.happy}, factors worse than -3: ${f}`,
    `- icons: ${icons}`,
    `- shortages: ${JSON.stringify(snap.shortages ?? {})}`,
    ...(services ? [`- services (use % of capacity -> with planned growth): ${services}`] : []),
    `- education levels of citizens ${JSON.stringify(snap.jobs?.eduCitizens ?? [])}`,
    `- did: ${did.slice(-8).join('; ') || 'nothing yet'}`,
    `- next: ${next.join('; ') || 'keep the loop running'}`,
    ...(attention.length ? [`- ATTENTION: ${[...new Set(attention)].slice(0, 6).join(' | ')}`] : []),
  ];
  return lines.join('\n') + '\n';
}
