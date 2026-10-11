// One full rule-driven cycle (Phase 3), shared by the `autoplay_cycle` MCP tool and the daemon
// (pilot-run.ts). It keeps the background run alive, reads the snapshot, runs the self-check,
// executes the decided tool calls, and writes the checkpoint files:
//   journals/progress.md        short block every 15 minutes and at each milestone (+ agent notes)
//   journals/pilot/status.json  one line of state after every cycle
//   journals/pilot/log.jsonl    every action with its result
//   journals/pilot/state.json   memo, recent actions, sticky attention (shared between callers)
// Returns one line, so a caller spends well under 500 tokens per cycle.
import { promises as fs, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { decide, learn, progressBlock, selfCheck } from './pilot.ts';
import { buildReport } from './report.ts';
import { evaluate, effectsTable, effectsLines, undoCandidates, stopRepeating } from './effects.ts';
import { netFloor, upkeepBudget, waitingFor } from './budget.ts';
import { loadQueue, saveQueue, queueLine, queueDoing, queueAttention, stalled, nextCodeItem, applyCodeResult, queueMarkdown, feedDesignQueue } from './queue.ts';
import { districtCount, districtLine, districtAttention } from './district.ts';
import type { DistrictCount } from './district.ts';
import type { PilotMemo } from './pilot.ts';

export type ToolFn = (name: string, args?: Record<string, any>) => Promise<Record<string, any>>;
interface State { memo: PilotMemo; did: string[]; sticky: string[]; lastProgress: number; cycles: number; review?: { t: number; allowance: number; spent: number }; stopRepeating?: string[]; track?: { t: number; cash: number; net: number }[]; reportValues?: Record<string, number>; reportStatus?: Record<string, string>; reportSince?: string; changes?: string[]; queueLine?: string; stalledSince?: number; design?: { total: number; counts: Record<string, number>; line: string } }

const hhmm = () => new Date().toISOString().slice(11, 16);
const short = (n: number) => Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : Math.abs(n) >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n);

export async function runCycle(tool: ToolFn, repo: string): Promise<{ line: string; attention: string[]; milestone: number; reached: boolean }> {
  const dir = join(repo, 'journals', 'pilot'); mkdirSync(dir, { recursive: true });
  let st: State = { memo: { last: { save: Date.now() }, backoff: {} }, did: [], sticky: [], lastProgress: 0, cycles: 0 };
  try { st = { ...st, ...JSON.parse(await fs.readFile(join(dir, 'state.json'), 'utf8')) }; } catch { /* first cycle */ }
  const log = (row: Record<string, any>) => fs.appendFile(join(dir, 'log.jsonl'), JSON.stringify({ utc: new Date().toISOString(), ...row }) + '\n').catch(() => {});

  // Keep the simulation running at speed 4 nearly all the time.
  const run = await tool('run_status', {});
  if (!run.background || Number(run.remainingSec ?? 0) < 900) await tool('run', { seconds: 7200, speed: 4, background: true });
  const snap = await tool('snapshot', {});
  if (snap.error || !snap.city) throw new Error(`snapshot_failed:${snap.error ?? 'no city'}`);
  try { snap.devTree = await tool('dev_tree', {}); } catch { /* optional */ }
  try { const hot = await tool('traffic_hotspots', { top: 1 }); snap.cityFlow = Number(hot.cityFlow ?? NaN); snap.flowByVolume = Number(hot.flowByVolumePct ?? NaN); } catch { /* optional */ }

  // Policy: the owner's goals as data (policy.json at the repository root; journals/pilot/mode.json
  // still overrides the mode for a quick switch). Bank mode ends by itself at its cash target.
  let policy: Record<string, any> = {};
  try { policy = JSON.parse(await fs.readFile(join(repo, 'policy.json'), 'utf8')); } catch { /* defaults */ }
  try { const mode = JSON.parse(await fs.readFile(join(dir, 'mode.json'), 'utf8')); policy = { ...policy, ...mode }; } catch { /* no override */ }
  if (policy.mode === 'bank' && Number(snap.city.money) >= Number(policy.bankTarget ?? policy.target ?? 5_000_000)) { policy.mode = 'grow'; await fs.unlink(join(dir, 'mode.json')).catch(() => {}); st.did.push(`${hhmm()} BANK TARGET reached: growth resumes`); }
  snap.pilotMode = policy.mode; snap.policy = policy; snap.stopRepeating = st.stopRepeating ?? [];
  // Net floor: fixed by the owner (policy.json). One review (15 minutes) may add at most half of
  // the margin measured at its start as new real upkeep; the next review measures again.
  snap.netFloor = netFloor(policy);
  const reviewMs = Number(policy.reviewMinutes ?? 15) * 60000;
  if (!st.review || Date.now() - st.review.t >= reviewMs) st.review = { t: Date.now(), allowance: upkeepBudget(Number(snap.city.net), snap.netFloor, Number(policy.upkeepShareOfMarginPerReview ?? 0.5)), spent: 0 };
  snap.upkeepAllowance = Math.max(0, st.review.allowance - st.review.spent);
  const now = Date.now(); const { memo } = st;
  const stuck = selfCheck(snap, memo, now);
  for (const line of stuck) await log({ event: 'self_check', line });
  const plan = decide(snap, memo, now, Number(policy.cashReserve ?? 1_000_000));
  const milestone = Number(snap.milestone?.achieved ?? NaN); const reached = memo.milestone !== undefined && milestone > memo.milestone;
  const done: string[] = [];
  for (const a of plan.actions) {
    let result: Record<string, any>;
    try { result = await tool(a.tool, a.args); } catch (e: any) { result = { ok: false, error: String(e?.message ?? e) }; }
    // No free site: buy land and build in the SAME cycle (FAILURES #94).
    if (a.key === 'grow' && result.reason === 'no_free_site' && snap.pilotMode !== 'bank') {
      let tile: Record<string, any>; try { tile = await tool('buy_tile', { n: 2, max: 900000 }); } catch (e: any) { tile = { ok: false, error: String(e?.message ?? e) }; }
      await log({ tool: 'buy_tile', why: `no free site for ${a.args.zone}`, ok: tile.ok, reason: tile.reason ?? tile.error, cost: tile.cost });
      if (tile.ok) { st.did.push(`${hhmm()} bought tiles for ${tile.cost}`); done.push(`bought tiles for ${tile.cost}`); try { result = await tool(a.tool, a.args); } catch (e: any) { result = { ok: false, error: String(e?.message ?? e) }; } }
      if (!result.ok && result.reason === 'no_free_site') st.sticky.push(`${hhmm()} no free site for ${a.args.zone} even after buying land: the owned tiles have no road nearby or fail the site rules - build an arterial into them (agent)`);
    }
    if (st.review) st.review.spent += Number(result.addedUpkeep ?? 0) || (result.ok && a.tool !== 'fix_services' ? Number(result.monthlyUpkeep ?? 0) * Number(policy.upkeepRealFactor ?? 2.7) : 0);
    const note = learn(memo, a, result, Date.now());
    if (note) { st.did.push(`${hhmm()} ${note}`); done.push(note); }
    await log({ tool: a.tool, args: a.args, why: a.why, ok: result.ok, reason: result.reason ?? result.error, note, cost: result.cost, ...(result.at ? { at: result.at } : {}), ...(result.missing ? { missing: result.missing } : {}), ...(result.site ? { site: { x: result.site.x, z: result.site.z } } : {}) });
    // Things only the agent can resolve stay raised until it clears them (journals/pilot/state.json).
    if (result.reason === 'not_utility_connected' || result.reason === 'previous_district_unserved' || result.reason === 'loose_end' || result.reason === 'crosses_water')
      st.sticky.push(`${hhmm()} ${a.tool}: ${result.reason} at ${JSON.stringify(result.at ?? result.districts ?? result.dangling ?? '?')}`);
  }
  if (Number.isFinite(milestone)) { if (reached) st.did.push(`${hhmm()} MILESTONE ${milestone}`); memo.milestone = milestone; }
  while (st.did.length > 40) st.did.shift(); while (st.sticky.length > 6) st.sticky.shift();
  const attention = [...plan.attention, ...stuck, ...st.sticky]; st.cycles++;

  // Work queue (journals/queue.json): every owner-approved item. The loop does the items code can do
  // (one step per cycle), wakes the agent when unblocked items have nobody on them, and raises STALLED
  // after 20 minutes without a build action or a queue change.
  const q = await loadQueue(repo); const qNow = Date.now();
  const codeItem = snap.pilotMode === 'bank' ? undefined : nextCodeItem(q.items, qNow);
  if (codeItem) {
    let result: Record<string, any>;
    const guard = codeItem.code!.tool === 'fix_services' ? { netFloor: snap.netFloor, reserve: Number(policy.cashReserve ?? 0), upkeepFactor: Number(policy.upkeepRealFactor ?? 2.7), upkeepAllowance: snap.upkeepAllowance } : {};
    try { result = await tool(codeItem.code!.tool, { ...guard, ...codeItem.code!.args }); } catch (e: any) { result = { ok: false, error: String(e?.message ?? e) }; }
    if (st.review) st.review.spent += Number(result.addedUpkeep ?? 0) || (result.ok ? Number(result.monthlyUpkeep ?? 0) * Number(policy.upkeepRealFactor ?? 2.7) : 0);
    const note = applyCodeResult(codeItem, result, new Date().toISOString()); st.did.push(`${hhmm()} ${note}`); done.push(note);
    await log({ tool: codeItem.code!.tool, args: codeItem.code!.args, why: `queue ${codeItem.id}`, ok: result.ok, reason: result.reason ?? result.error, cost: result.cost });
    await saveQueue(repo, q.items);
  }
  let lastAction = 0; try { const tail = (await fs.readFile(join(repo, 'journals', 'actions.jsonl'), 'utf8')).trimEnd().split('\n').pop() ?? ''; lastAction = Date.parse(JSON.parse(tail).utc) || 0; } catch { /* none yet */ }
  if (done.some(n => n.startsWith('built ') || n.startsWith('bought') || n.startsWith('queue '))) lastAction = qNow;
  const stallLine = stalled(q.items, Math.max(lastAction, q.mtime), qNow);
  if (stallLine && !st.stalledSince) { st.stalledSince = qNow; await log({ event: 'stalled', line: stallLine }); } else if (!stallLine) st.stalledSince = undefined;
  const queueNote = queueAttention(q.items, qNow); if (queueNote) attention.push(queueNote);
  const qLine = queueLine(q.items, qNow); const queueChanged = (qLine + (stallLine ? ' STALLED' : '')) !== (st.queueLine ?? ''); st.queueLine = qLine + (stallLine ? ' STALLED' : '');

  const status = { utc: new Date().toISOString(), mode: snap.pilotMode, netFloor: snap.netFloor, flow: snap.cityFlow, pop: snap.city.pop, cash: snap.city.money, net: snap.city.net, milestone, xp: `${snap.milestone?.xp}/${snap.milestone?.nextXp}`, unemp: snap.jobs?.unemp, happy: snap.happy, demand: snap.demand, attention, last: st.did.slice(-3) };
  await fs.writeFile(join(dir, 'status.json'), JSON.stringify(status));
  // Checkpoint every 15 minutes, at each milestone and after each district or tile.
  if (reached || queueChanged || Date.now() - st.lastProgress > 15 * 60_000 || done.some(n => n.startsWith('built ') || n.startsWith('bought'))) {
    st.lastProgress = Date.now();
    const grows = plan.actions.find(a => a.key === 'grow');
    const next = [grows ? `grow ${grows.args.zone} by demand` : 'no zone has demand 20+ (or growth is backing off)', 'services, traffic, taxes and development points by the rules'];
    // Regular review (FAILURES #99): the ranked report of every system, from code, zero tokens.
    // Only CHANGES of status and blocked items are surfaced (progress.md, the status line).
    try {
      let outcomes: Record<string, any> | undefined; let vehicles: Record<string, any> | undefined; let garbageState: Record<string, any> | undefined; try { const gm = await tool('query', { command: 'get_metrics', args: {}, fields: ['outcomes', 'headroom.vehicles', 'headroom.garbage', 'perfMs'], maxChars: 6000 }); outcomes = gm.outcomes; vehicles = gm.headroom?.vehicles; garbageState = gm.headroom?.garbage; } catch { /* older mod */ }
      // Verify and learn: every recorded action is judged against the metric history.
      const jsonl = async (file: string) => { try { return (await fs.readFile(join(repo, 'journals', file), 'utf8')).split('\n').filter(Boolean).slice(-600).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
      let worked: string[] = [], undo: string[] = [];
      try { const ev = evaluate(await jsonl('actions.jsonl'), await jsonl('metrics-history.jsonl'), Date.now()); worked = effectsLines(effectsTable(ev), 8); st.stopRepeating = stopRepeating(ev, 'fix_services'); if (st.stopRepeating.length) worked.push(`STOPPED as ineffective, diagnose again: fix_services for ${st.stopRepeating.join(', ')}`); undo = undoCandidates(ev).slice(0, 4).map(u => `${u.why}: ${u.details.slice(0, 4).join(', ')}`); } catch { /* history not ready */ }
      let sewageExport: any; try { const oc = await tool('query', { command: 'outside_connections', args: {}, fields: ['pipes', 'sewage'], maxChars: 800 }); const sb = await tool('query', { command: 'service_buildings', args: {}, maxChars: 20000 }); const local = ((sb.services ?? sb.result?.services ?? []) as any[]).filter(r => /SewageOutlet|WastewaterTreatment/.test(String(r[0]))).length; let fee: number | undefined; try { fee = Number((await tool('query', { command: 'get_city_management', args: {}, fields: ['budget.expenseBySourceRaw.ExportSewage'], maxChars: 400 })).budget?.expenseBySourceRaw?.ExportSewage); } catch { /* optional */ } if (Number(oc.pipes) > 0) sewageExport = { pipes: Number(oc.pipes), use: Number(oc.sewage?.use ?? 0), fulfilled: Number(oc.sewage?.fulfilled ?? 0), local, fee }; } catch { /* older mod */ }
      // Urban design audit: defects of the road network, into the report and (worst kinds) into the work queue.
      let design: any; try { design = await tool('design_audit', { top: 12 }); if (design?.ok) { st.design = { total: design.total, counts: design.counts, line: design.line }; const changed = feedDesignQueue(q.items, design.counts, design.worst ?? [], new Date().toISOString()); if (changed) await saveQueue(repo, q.items); } } catch (e: any) { await log({ event: 'design_audit_failed', error: String(e?.message ?? e) }); }
      const rep = buildReport({ snap, outcomes, design: design?.ok ? design : undefined, vehicles, garbage: garbageState, sewageExport, worked, undo, reserve: Number(policy.cashReserve ?? 0), netFloor: snap.netFloor, mode: snap.pilotMode, table: memo.table, coverage: memo.coverage, blocked: memo.blocked, did: st.did, diagnosis: plan.diagnosis, when: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC', prev: st.reportValues });
      const before = st.reportStatus ?? {}; const order = ['good', 'ok', 'unknown', 'bad', 'critical'];
      st.changes = rep.rows.filter(r => before[r.system] && before[r.system] !== r.status && r.status !== 'unknown').map(r => `${r.system}: ${before[r.system]} -> ${r.status}${order.indexOf(r.status) > order.indexOf(before[r.system]) ? ' (WORSE)' : ''}`);
      st.reportValues = rep.values; st.reportStatus = Object.fromEntries(rep.rows.map(r => [r.system, r.status]));
      if (!st.reportSince) st.reportSince = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
      await fs.writeFile(join(repo, 'journals', 'REPORT.md'), rep.markdown);
      await fs.appendFile(join(repo, 'journals', 'metrics-history.jsonl'), JSON.stringify({ utc: new Date().toISOString(), pop: snap.city.pop, flow: snap.cityFlow, flowByVolume: snap.flowByVolume, unemp: snap.jobs?.unemp, edu: snap.jobs?.eduCitizens, vacant: snap.jobs?.vacantByEdu, values: rep.values, status: st.reportStatus }) + '\n');
      for (const c of st.changes.filter(c => c.endsWith('(WORSE)'))) await log({ event: 'status_change', line: c });
    } catch (e: any) { await log({ event: 'report_failed', error: String(e?.message ?? e) }); }
    let notes = ''; try { notes = (await fs.readFile(join(dir, 'notes.md'), 'utf8')).split('\n').slice(0, 30).join('\n'); } catch { /* none */ }
    let top = ''; try { top = (await fs.readFile(join(dir, 'top.md'), 'utf8')).trim() + '\n'; } catch { /* none */ }
    // District watch: icons inside each watched rectangle against its first count (policy.json watchDistricts).
    let districts = '';
    try {
      const file = join(repo, 'journals', 'district-history.jsonl'); let hist: DistrictCount[] = [];
      try { hist = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { /* first count */ }
      for (const d of (policy.watchDistricts ?? []) as any[]) {
        const n = await tool('query', { command: 'notifications', args: { x0: d.x0, x1: d.x1, z0: d.z0, z1: d.z1, top: 1 }, fields: ['counts'], maxChars: 1500 });
        const mine = hist.filter(h => h.name === d.name); const now = districtCount(d.name, n.counts ?? {}, new Date().toISOString());
        districts += districtLine(now, mine[0], mine[mine.length - 1]) + '\n'; await fs.appendFile(file, JSON.stringify(now) + '\n');
        const alarm = districtAttention([...mine, now], Date.now()); if (alarm) st.sticky.push(`${hhmm()} ${alarm}`);
      }
    } catch (e: any) { await log({ event: 'district_watch_failed', error: String(e?.message ?? e) }); }
    await fs.writeFile(join(repo, 'journals', 'progress.md'), top + (stallLine ? `- ${stallLine}\n` : '') + districts + (st.design ? `- DESIGN AUDIT: ${st.design.line}\n` : '') + queueMarkdown(q.items, qNow) + progressBlock(snap, st.did, next, attention, new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC', plan.diagnosis, memo.servicesLine) + `- REPORT.md (every system ranked worst first) is live since ${st.reportSince ?? 'now'}; status changes this review: ${(st.changes ?? []).join('; ') || 'none'}\n` + (notes ? notes + '\n' : ''));
  }
  await fs.writeFile(join(dir, 'state.json'), JSON.stringify(st));
  st.track = [...(st.track ?? []), { t: Date.now(), cash: Number(snap.city.money), net: Number(snap.city.net) }].slice(-15);
  // Purchases the agent has queued (journals/pilot/planned.json: [{name, realUpkeep}]): the line says what the loop waits for.
  let planned: { name: string; realUpkeep: number }[] = []; try { planned = JSON.parse(await fs.readFile(join(dir, 'planned.json'), 'utf8')); } catch { /* none */ }
  const plannedUpkeep = planned.reduce((a, b) => a + Number(b.realUpkeep ?? 0), 0);
  let waiting = snap.pilotMode === 'improve' ? waitingFor(st.track, Number(policy.cashReserve ?? 0), Number(snap.netFloor ?? 0), plannedUpkeep > 0 ? plannedUpkeep : undefined) : '';
  if (waiting && plannedUpkeep > 0) waiting = waiting.replace('for new upkeep', `for ${planned.map(q => q.name).join(' + ')}`);
  const floorNote = snap.pilotMode === 'improve' ? ` (floor ${short(Number(snap.netFloor))}, spendable ${short(Number(snap.city.net) - Number(snap.netFloor))}) reserve ${short(Number(policy.cashReserve ?? 0))} (spendable ${short(Number(snap.city.money) - Number(policy.cashReserve ?? 0))})` : '';
  const line = `[${snap.pilotMode ?? 'grow'}] pop ${short(Number(snap.city.pop))} cash ${short(Number(snap.city.money))} net ${short(Number(snap.city.net))}${floorNote} M${milestone} xp ${snap.milestone?.xp}/${snap.milestone?.nextXp} unemp ${snap.jobs?.unemp}% happy ${snap.happy} | did: ${done.join('; ') || queueDoing(q.items, qNow) || 'nothing due'}${qLine ? ' | ' + qLine : ''}${stallLine ? ' | ' + stallLine : ''}${waiting ? ' | ' + waiting : ''}${reached ? ' | MILESTONE ' + milestone : ''}${attention.length ? ' | ATTENTION: ' + attention.slice(0, 3).join(' / ') : ''}`;
  await fs.writeFile(join(dir, 'state.json'), JSON.stringify(st));
  return { line, attention, milestone, reached };
}
