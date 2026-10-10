// LIVE runner for the rule loop (pilot.ts). Talks to the running MCP session through its file
// queue (test/session.ts), so the agent can still issue its own tool calls next to it.
//   node src/pilot-run.ts [cycleSeconds=60]     stops when journals/pilot/STOP exists
// Writes journals/progress.md (short block, every 15 minutes and at each milestone),
// journals/pilot/log.jsonl (every action and result) and journals/pilot/status.json.
import { promises as fs, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { decide, learn, progressBlock } from './pilot.ts';
import type { PilotMemo } from './pilot.ts';

const repo = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), '..');
const queue = join(repo, 'journals', 'mcp-session'); const dir = join(repo, 'journals', 'pilot'); mkdirSync(dir, { recursive: true });
const cycleMs = Math.max(20, Number(process.argv[2] ?? 60)) * 1000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const alive = async () => { try { return Date.now() - (await fs.stat(join(queue, 'alive'))).mtimeMs < 5000; } catch { return false; } };

async function tool(name: string, args: Record<string, any> = {}, timeoutMs = 900_000): Promise<Record<string, any>> {
  if (!(await alive())) throw new Error('mcp_session_not_running');
  const startedOf = async () => { try { return await fs.readFile(join(queue, 'started'), 'utf8'); } catch { return ''; } };
  const session = await startedOf(); const id = randomUUID();
  await fs.writeFile(join(queue, 'in', id + '.tmp'), JSON.stringify({ id, tool: name, args })); await fs.rename(join(queue, 'in', id + '.tmp'), join(queue, 'in', id + '.json'));
  const out = join(queue, 'out', id + '.json'); const t0 = Date.now();
  while (!existsSync(out)) { await sleep(50); if (Date.now() - t0 > timeoutMs) throw new Error(`tool_timeout:${name}`); if ((Date.now() - t0) % 5000 < 60) { if (!(await alive())) throw new Error('mcp_session_died'); if ((await startedOf()) !== session) throw new Error('mcp_session_restarted'); } }
  const res = JSON.parse(await fs.readFile(out, 'utf8')); await fs.unlink(out).catch(() => {});
  let body: Record<string, any>; try { body = JSON.parse(res.text); } catch { body = { text: String(res.text).slice(0, 300) }; }
  if (res.isError && body.error === undefined) body.error = String(res.text).slice(0, 300);
  return body;
}
const log = (row: Record<string, any>) => fs.appendFile(join(dir, 'log.jsonl'), JSON.stringify({ utc: new Date().toISOString(), ...row }) + '\n').catch(() => {});

const memo: PilotMemo = { last: {}, backoff: {} };
try { Object.assign(memo, JSON.parse(await fs.readFile(join(dir, 'memo.json'), 'utf8'))); } catch { /* first run */ }
memo.last.save = memo.last.save ?? Date.now(); // the launch already loaded a fresh save
const did: string[] = []; let lastProgress = 0; let failures = 0; let attention: string[] = []; const sticky: string[] = []; // things only the agent can resolve
await fs.unlink(join(dir, 'STOP')).catch(() => {});
console.log('pilot running, cycle', cycleMs / 1000, 's');

while (!existsSync(join(dir, 'STOP'))) {
  const started = Date.now();
  try {
    // Keep the simulation running at speed 4 nearly all the time.
    const run = await tool('run_status', {}, 30_000);
    if (!run.background || Number(run.remainingSec ?? 0) < 900) await tool('run', { seconds: 7200, speed: 4, background: true }, 30_000);
    const snap = await tool('snapshot', {}, 60_000);
    if (snap.error || !snap.city) throw new Error(`snapshot_failed:${snap.error ?? 'no city'}`);
    failures = 0;
    try { snap.devTree = await tool('dev_tree', {}, 30_000); } catch { /* optional */ }
    const now = Date.now(); const plan = decide(snap, memo, now); attention = [...plan.attention, ...sticky.slice(-4)];
    const milestone = Number(snap.milestone?.achieved ?? NaN); const reached = memo.milestone !== undefined && milestone > memo.milestone;
    for (const a of plan.actions) {
      if (existsSync(join(dir, 'STOP'))) break;
      let result: Record<string, any>;
      try { result = await tool(a.tool, a.args); } catch (e: any) { result = { ok: false, error: String(e?.message ?? e) }; }
      const note = learn(memo, a, result, Date.now());
      if (note) did.push(`${new Date().toISOString().slice(11, 16)} ${note}`);
      await log({ tool: a.tool, args: a.args, why: a.why, ok: result.ok, reason: result.reason ?? result.error, note, cost: result.cost, ...(result.at ? { at: result.at } : {}), ...(result.missing ? { missing: result.missing } : {}), ...(result.site ? { site: { x: result.site.x, z: result.site.z } } : {}) });
      if (result.reason === 'not_utility_connected' || result.reason === 'previous_district_unserved') sticky.push(`${a.tool}: ${result.reason} at ${JSON.stringify(result.at ?? result.districts ?? '?')} (roads built, NOT zoned)`);
    }
    if (Number.isFinite(milestone)) { if (reached) did.push(`${new Date().toISOString().slice(11, 16)} MILESTONE ${milestone}`); memo.milestone = milestone; }
    while (did.length > 40) did.shift();
    await fs.writeFile(join(dir, 'memo.json'), JSON.stringify(memo));
    const status = { utc: new Date().toISOString(), pop: snap.city.pop, cash: snap.city.money, net: snap.city.net, milestone, xp: `${snap.milestone?.xp}/${snap.milestone?.nextXp}`, unemp: snap.jobs?.unemp, happy: snap.happy, attention, last: did.slice(-3) };
    await fs.writeFile(join(dir, 'status.json'), JSON.stringify(status));
    if (reached || Date.now() - lastProgress > 15 * 60_000) {
      lastProgress = Date.now();
      const next = [plan.actions.find(a => a.key === 'grow') ? 'keep growing by demand' : Number(snap.jobs?.unemp ?? 0) >= 10 ? 'no job zone has demand and unemployment is 10%+: housing is held' : 'waiting for demand or cash', 'services, traffic and taxes by the rules'];
      await fs.writeFile(join(repo, 'journals', 'progress.md'), progressBlock(snap, did, next, attention, new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC'));
    }
  } catch (e: any) {
    failures++; const message = String(e?.message ?? e);
    await log({ error: message, failures });
    await fs.writeFile(join(dir, 'status.json'), JSON.stringify({ utc: new Date().toISOString(), error: message, failures, attention: [`pilot error x${failures}: ${message}`] })).catch(() => {});
    // A dead game or session is not something rules may fix (never relaunch or kill from here).
    if (failures >= 5) { await fs.writeFile(join(repo, 'journals', 'progress.md'), `# Progress ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC\n- ATTENTION: the rule loop stopped after 5 failed cycles: ${message}\n`).catch(() => {}); break; }
  }
  await sleep(Math.max(1000, cycleMs - (Date.now() - started)));
}
console.log('pilot stopped');
