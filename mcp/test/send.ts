// node test/send.ts <tool> [json-args] [maxChars]   (needs test/session.ts running)
import { promises as fs, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
const root = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), '..', 'journals', 'mcp-session');
const [tool, json, max] = process.argv.slice(2);
if (tool === 'STOP') { await fs.writeFile(join(root, 'in', 'STOP'), ''); process.exit(0); }
// Fail fast when no session is running (a dead session used to hang the caller and idle the game).
const alive = async () => { try { return Date.now() - (await fs.stat(join(root, 'alive'))).mtimeMs < 5000; } catch { return false; } };
if (!(await alive())) { console.log('[ERROR] no MCP session running: start `node test/session.ts` (check journals/mcp-session/session.out)'); process.exit(2); }
const id = randomUUID();
await fs.writeFile(join(root, 'in', id + '.tmp'), JSON.stringify({ id, tool, args: json ? JSON.parse(json) : {} })); await fs.rename(join(root, 'in', id + '.tmp'), join(root, 'in', id + '.json'));
const out = join(root, 'out', id + '.json');
let waited = 0;
while (!existsSync(out)) { await new Promise(r => setTimeout(r, 30)); if ((waited += 30) % 3000 < 30 && !(await alive())) { console.log('[ERROR] MCP session died while waiting'); process.exit(2); } }
const res = JSON.parse(await fs.readFile(out, 'utf8')); await fs.unlink(out).catch(() => {});
const limit = Number(max ?? 1500);
console.log(`[${res.ms} ms, ${res.text.length} chars${res.isError ? ', ERROR' : ''}] ${res.text.length > limit ? res.text.slice(0, limit) + ' …' : res.text}`);
