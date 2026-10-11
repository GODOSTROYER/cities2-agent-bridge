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
import type { PilotMemo } from './pilot.ts';

export type ToolFn = (name: string, args?: Record<string, any>) => Promise<Record<string, any>>;
interface State { memo: PilotMemo; did: string[]; sticky: string[]; lastProgress: number; cycles: number; reportValues?: Record<string, number>; reportStatus?: Record<string, string>; reportSince?: string; changes?: string[] }

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
  try { const hot = await tool('traffic_hotspots', { top: 1 }); snap.cityFlow = Number(hot.cityFlow ?? NaN); } catch { /* optional */ }

  // Bank mode ends by itself when the cash target is reached (journals/pilot/mode.json).
  try {
    const mode = JSON.parse(await fs.readFile(join(dir, 'mode.json'), 'utf8')); snap.pilotMode = mode.mode;
    if (mode.mode === 'bank' && Number(snap.city.money) >= Number(mode.target ?? 5_000_000)) { await fs.unlink(join(dir, 'mode.json')); snap.pilotMode = undefined; st.did.push(`${hhmm()} BANK TARGET ${mode.target} reached: growth resumes`); }
  } catch { /* normal mode */ }
  const now = Date.now(); const { memo } = st;
  const stuck = selfCheck(snap, memo, now);
  for (const line of stuck) await log({ event: 'self_check', line });
  const plan = decide(snap, memo, now);
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

  const status = { utc: new Date().toISOString(), flow: snap.cityFlow, pop: snap.city.pop, cash: snap.city.money, net: snap.city.net, milestone, xp: `${snap.milestone?.xp}/${snap.milestone?.nextXp}`, unemp: snap.jobs?.unemp, happy: snap.happy, demand: snap.demand, attention, last: st.did.slice(-3) };
  await fs.writeFile(join(dir, 'status.json'), JSON.stringify(status));
  // Checkpoint every 15 minutes, at each milestone and after each district or tile.
  if (reached || Date.now() - st.lastProgress > 15 * 60_000 || done.some(n => n.startsWith('built ') || n.startsWith('bought'))) {
    st.lastProgress = Date.now();
    const grows = plan.actions.find(a => a.key === 'grow');
    const next = [grows ? `grow ${grows.args.zone} by demand` : 'no zone has demand 20+ (or growth is backing off)', 'services, traffic, taxes and development points by the rules'];
    // Regular review (FAILURES #99): the ranked report of every system, from code, zero tokens.
    // Only CHANGES of status and blocked items are surfaced (progress.md, the status line).
    try {
      let outcomes: Record<string, any> | undefined; try { outcomes = (await tool('query', { command: 'get_metrics', args: {}, fields: ['outcomes', 'perfMs'], maxChars: 6000 })).outcomes; } catch { /* older mod */ }
      const rep = buildReport({ snap, outcomes, table: memo.table, coverage: memo.coverage, blocked: memo.blocked, did: st.did, diagnosis: plan.diagnosis, when: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC', prev: st.reportValues });
      const before = st.reportStatus ?? {}; const order = ['good', 'ok', 'unknown', 'bad', 'critical'];
      st.changes = rep.rows.filter(r => before[r.system] && before[r.system] !== r.status && r.status !== 'unknown').map(r => `${r.system}: ${before[r.system]} -> ${r.status}${order.indexOf(r.status) > order.indexOf(before[r.system]) ? ' (WORSE)' : ''}`);
      st.reportValues = rep.values; st.reportStatus = Object.fromEntries(rep.rows.map(r => [r.system, r.status]));
      if (!st.reportSince) st.reportSince = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
      await fs.writeFile(join(repo, 'journals', 'REPORT.md'), rep.markdown);
      await fs.appendFile(join(repo, 'journals', 'metrics-history.jsonl'), JSON.stringify({ utc: new Date().toISOString(), pop: snap.city.pop, flow: snap.cityFlow, unemp: snap.jobs?.unemp, edu: snap.jobs?.eduCitizens, vacant: snap.jobs?.vacantByEdu, values: rep.values, status: st.reportStatus }) + '\n');
      for (const c of st.changes.filter(c => c.endsWith('(WORSE)'))) await log({ event: 'status_change', line: c });
    } catch (e: any) { await log({ event: 'report_failed', error: String(e?.message ?? e) }); }
    let notes = ''; try { notes = (await fs.readFile(join(dir, 'notes.md'), 'utf8')).split('\n').slice(0, 14).join('\n'); } catch { /* none */ }
    await fs.writeFile(join(repo, 'journals', 'progress.md'), progressBlock(snap, st.did, next, attention, new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC', plan.diagnosis, memo.servicesLine) + `- REPORT.md (every system ranked worst first) is live since ${st.reportSince ?? 'now'}; status changes this review: ${(st.changes ?? []).join('; ') || 'none'}\n` + (notes ? notes + '\n' : ''));
  }
  await fs.writeFile(join(dir, 'state.json'), JSON.stringify(st));
  const line = `pop ${short(Number(snap.city.pop))} cash ${short(Number(snap.city.money))} net ${short(Number(snap.city.net))} M${milestone} xp ${snap.milestone?.xp}/${snap.milestone?.nextXp} unemp ${snap.jobs?.unemp}% happy ${snap.happy} | did: ${done.join('; ') || 'nothing due'}${reached ? ' | MILESTONE ' + milestone : ''}${attention.length ? ' | ATTENTION: ' + attention.slice(0, 3).join(' / ') : ''}`;
  return { line, attention, milestone, reached };
}
