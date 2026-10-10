// Daemon for the rule loop: calls the `autoplay_cycle` MCP tool of the running session every
// cycle through the session's file queue (test/session.ts), so no model is in the loop at all.
//   node src/pilot-run.ts [cycleSeconds=60]     stops when journals/pilot/STOP exists
// The loop never launches, quits or kills the game; after 5 failed cycles it stops and says so
// in journals/progress.md.
import { promises as fs, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const repo = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), '..');
const queue = join(repo, 'journals', 'mcp-session'); const dir = join(repo, 'journals', 'pilot'); mkdirSync(dir, { recursive: true });
const cycleMs = Math.max(20, Number(process.argv[2] ?? 60)) * 1000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const alive = async () => { try { return Date.now() - (await fs.stat(join(queue, 'alive'))).mtimeMs < 5000; } catch { return false; } };
const startedOf = async () => { try { return await fs.readFile(join(queue, 'started'), 'utf8'); } catch { return ''; } };

async function tool(name: string, args: Record<string, any> = {}, timeoutMs = 1_200_000): Promise<string> {
  if (!(await alive())) throw new Error('mcp_session_not_running');
  const session = await startedOf(); const id = randomUUID();
  await fs.writeFile(join(queue, 'in', id + '.tmp'), JSON.stringify({ id, tool: name, args })); await fs.rename(join(queue, 'in', id + '.tmp'), join(queue, 'in', id + '.json'));
  const out = join(queue, 'out', id + '.json'); const t0 = Date.now(); let checked = 0;
  while (!existsSync(out)) {
    await sleep(50); if (Date.now() - t0 > timeoutMs) throw new Error(`tool_timeout:${name}`);
    if (Date.now() - checked > 5000) { checked = Date.now(); if (!(await alive())) throw new Error('mcp_session_died'); if ((await startedOf()) !== session) throw new Error('mcp_session_restarted'); }
  }
  const res = JSON.parse(await fs.readFile(out, 'utf8')); await fs.unlink(out).catch(() => {});
  if (res.isError) throw new Error(String(res.text).slice(0, 300));
  return String(res.text);
}

let failures = 0;
await fs.unlink(join(dir, 'STOP')).catch(() => {});
console.log('pilot daemon running, cycle', cycleMs / 1000, 's');
while (!existsSync(join(dir, 'STOP'))) {
  const started = Date.now();
  try { const line = await tool('autoplay_cycle', {}); failures = 0; await fs.writeFile(join(dir, 'last-line.txt'), `${new Date().toISOString().slice(11, 19)} ${line}\n`); }
  catch (e: any) {
    failures++; const message = String(e?.message ?? e);
    await fs.appendFile(join(dir, 'log.jsonl'), JSON.stringify({ utc: new Date().toISOString(), error: message, failures }) + '\n').catch(() => {});
    await fs.writeFile(join(dir, 'status.json'), JSON.stringify({ utc: new Date().toISOString(), error: message, failures, attention: [`pilot error x${failures}: ${message}`] })).catch(() => {});
    if (failures >= 5) { await fs.writeFile(join(repo, 'journals', 'progress.md'), `# Progress ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC\n- ATTENTION: the rule loop stopped after 5 failed cycles: ${message}\n`).catch(() => {}); break; }
  }
  await sleep(Math.max(1000, cycleMs - (Date.now() - started)));
}
console.log('pilot daemon stopped');
