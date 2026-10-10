// LIVE check against a running game (city loaded, bridge controls on). Not run by CI.
//   node test/live.ts concurrency [seconds]   run(seconds) while polling snapshot every 5 s
//   node test/live.ts call <tool> [json]      one tool call, prints the text result
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const client = new Client({ name: 'cs2-live-test', version: '0.1.0' });
await client.connect(new StdioClientTransport({ command: 'node', args: ['src/server.ts'], cwd: here }));
const text = (r: any) => (r.content ?? []).map((c: any) => c.text).join('\n');
const callTool = async (name: string, args: any = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 3_600_000 });
const [mode, a1, a2] = process.argv.slice(2);
try {
  if (mode === 'concurrency') {
    const seconds = Number(a1 ?? 60);
    const pending = callTool('run', { seconds });
    let done = false; pending.finally(() => { done = true; });
    const samples: string[] = [];
    await new Promise(r => setTimeout(r, 3000));
    while (!done) {
      const s = JSON.parse(text(await callTool('snapshot')));
      samples.push(`t=${new Date().toISOString().slice(11, 19)} frame=${s.liveFrame} speed=${s.liveSpeed} snapFrame=${s.frame} age=${s.ageFrames}f pop=${s.city?.pop} bytes=${s.bytes}`);
      console.log(samples.at(-1));
      await new Promise(r => setTimeout(r, 5000));
    }
    console.log('RUN:', text(await pending));
  } else if (mode === 'brief') {
    const d = JSON.parse(text(await callTool('snapshot')));
    const j = d.jobs ?? {};
    console.log(JSON.stringify({ city: d.city, happy: d.happy, health: d.health, demand: d.demand, unemp: j.unemp, workers: `${j.workers}/${j.eligible}`, vacantByEdu: j.vacantByEdu, why: d.demandWhy, worst: d.worstHappy, power: d.util?.power?.pct, water: d.util?.water?.pct, sewage: d.util?.sewage?.pct, short: d.shortages, pen: d.servicePenalties?.byFactor, bld: d.buildings, ms: d.milestone, ui: d.ui?.blocker, exp: d.expense, inc: d.income }));
  } else if (mode === 'call') {
    const r = await callTool(a1, a2 ? JSON.parse(a2) : {});
    console.log((r.isError ? 'ERROR ' : '') + text(r));
  } else console.log('usage: concurrency [seconds] | brief | call <tool> [json]');
} finally { await client.close(); }
