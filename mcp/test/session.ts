// LIVE helper: one long-lived MCP client + server, driven through a file queue so that a
// shell can issue many tool calls against the same server (background run, timings).
//   node test/session.ts            start (runs until journals/mcp-session/in/STOP appears)
//   node test/send.ts <tool> [json] one call; prints "[ms, chars] result"
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { promises as fs, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(here, '..', 'journals', 'mcp-session'); const inDir = join(root, 'in'); const outDir = join(root, 'out');
mkdirSync(inDir, { recursive: true }); mkdirSync(outDir, { recursive: true });
for (const f of await fs.readdir(inDir)) await fs.unlink(join(inDir, f));
const client = new Client({ name: 'cs2-session', version: '0.1.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ['src/server.ts'], cwd: here, stderr: 'ignore' }));
console.log('session ready');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
while (!existsSync(join(inDir, 'STOP'))) {
  for (const f of (await fs.readdir(inDir)).filter(f => f.endsWith('.json')).sort()) {
    let req: any; try { req = JSON.parse(await fs.readFile(join(inDir, f), 'utf8')); } catch { continue; }
    await fs.unlink(join(inDir, f)).catch(() => {});
    const t0 = Date.now();
    void client.callTool({ name: req.tool, arguments: req.args ?? {} }, undefined, { timeout: 3_600_000 })
      .then((r: any) => ({ isError: !!r.isError, text: (r.content ?? []).map((c: any) => c.text).join('\n') }), (e: any) => ({ isError: true, text: String(e?.message ?? e) }))
      .then(async (res) => {
        const ms = Date.now() - t0;
        await fs.appendFile(join(root, 'log.jsonl'), JSON.stringify({ utc: new Date().toISOString(), tool: req.tool, ms, chars: res.text.length, error: res.isError }) + '\n');
        await fs.writeFile(join(outDir, req.id + '.tmp'), JSON.stringify({ ms, ...res })); await fs.rename(join(outDir, req.id + '.tmp'), join(outDir, req.id + '.json'));
      });
  }
  await sleep(40);
}
await fs.unlink(join(inDir, 'STOP')).catch(() => {});
await client.close(); console.log('session closed');
