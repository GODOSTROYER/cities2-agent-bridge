// LIVE: exercises the Phase 2 queries through the MCP server and prints compact results.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const client = new Client({ name: 'cs2-phase2-test', version: '0.1.0' });
await client.connect(new StdioClientTransport({ command: 'node', args: ['src/server.ts'], cwd: here }));
const call = async (name: string, args: any = {}) => { const t0 = Date.now(); const r: any = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 }); const text = r.content.map((c: any) => c.text).join(''); return { ms: Date.now() - t0, err: !!r.isError, text }; };
const show = (label: string, r: any, max = 700) => console.log(`${label} [${r.ms} ms${r.err ? ' ERROR' : ''}] ${r.text.slice(0, max)}`);
const which = process.argv.slice(2);
const all = which.length === 0;
if (all || which.includes('lots')) show('free_lots 220x220 res', await call('free_lots', { width: 220, depth: 220, count: 3, zone: 'res' }));
if (all || which.includes('cov')) for (const s of ['Healthcare', 'FireRescue', 'Police', 'Education']) show(`coverage ${s}`, await call('coverage_gaps', { service: s, top: 2 }), 400);
if (all || which.includes('traffic')) show('traffic', await call('traffic_hotspots', { top: 4 }), 600);
if (all || which.includes('corridor')) show('corridor', await call('corridor', { fromX: -655, fromZ: -1078, toX: 300, toZ: -600 }), 500);
if (all || which.includes('project')) show('project', await call('project', { actions: [{ prefab: 'WindTurbine02', count: 2 }, { zone: 'res', cells: 500 }, { zone: 'ind', cells: 300 }] }), 900);
await client.close();
