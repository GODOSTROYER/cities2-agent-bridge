// LIVE helper: controlled test of what moves the game's Traffic Flow figure on quiet local streets.
// The game's per-edge figure is average speed / min(car top speed, lane speed limit); the city figure is the plain
// mean over road edges. This applies one change to every second quiet Small Road edge in a box (treatment) and
// leaves the others alone (control), records the flow of both before, and reports both later.
//   node test/flowtest.ts start '<json: {name, x0, x1, z0, z1, change: "Alley" | "Small Road Oneway" | "Gravel Road" | ..., maxVolume?: 12}>'
//   node test/flowtest.ts report            (every test: treatment and control, before and now)
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { call, callOk, waitOperation } from '../src/bridge.ts';
import { prefab } from '../src/city.ts';
const file = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'journals', 'flow-tests.jsonl');
const flowOf = (e: any) => { const d: number[] = e.trafficDistanceRaw ?? [], u: number[] = e.trafficDurationRaw ?? []; const f = [0, 1, 2, 3].map(i => { const dist = d[i] + d[i + 4], dur = u[i] + u[i + 4]; return dur > 0 ? Math.max(0, Math.min(1, dist / dur)) : NaN; }).filter(x => Number.isFinite(x)); return { flow: f.length ? f.reduce((a, b) => a + b, 0) / f.length : NaN, vol: d.reduce((a, b) => a + b, 0) / 4 }; };
const edgesIn = async (a: any) => { const cx = (a.x0 + a.x1) / 2, cz = (a.z0 + a.z1) / 2, r = Math.hypot(a.x1 - a.x0, a.z1 - a.z0) / 2 + 20; const out: any[] = []; for (const e of (await callOk('get_network_edges', { x: cx, z: cz, radius: r }, 40)).edges ?? []) { const c = e.curve; const mx = (c[0].x + c[3].x) / 2, mz = (c[0].z + c[3].z) / 2; if (mx < a.x0 || mx > a.x1 || mz < a.z0 || mz > a.z1) continue; out.push({ ...e, mx, mz, ...flowOf(e) }); } return out; };
const mean = (v: number[]) => v.length ? Math.round(1000 * v.reduce((x, y) => x + y, 0) / v.length) / 10 : null;
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
if (process.argv[2] === 'start') {
  const a = JSON.parse(process.argv[3]); const p = await prefab(a.change, 'network'); if (!p.found) { console.log('prefab not found', a.change); process.exit(0); }
  const quiet = (await edgesIn(a)).filter(e => e.prefab === 'Small Road' && Number.isFinite(e.flow) && e.vol <= (a.maxVolume ?? 12) && e.length >= 70).sort((u, v) => u.mx - v.mx || u.mz - v.mz);
  const treat: any[] = [], control: any[] = []; quiet.forEach((e, i) => (i % 2 === 0 ? treat : control).push(e)); const done: any[] = [], refused: string[] = [];
  for (const e of treat) { let d: any = null; for (let t = 0; t < 6; t++) { const o = await call('upgrade_network', { index: e.index, version: e.version, prefabIndex: p.index, prefabVersion: p.version, maxCost: 60000 }, 15); if (!o.ok) { d = { status: 'refused', error: JSON.stringify(o.error) }; if (/busy|finish_or_cancel|batch/.test(d.error)) { await wait(3000); continue; } break; } d = await waitOperation(o.result.id, 60); break; } if (d?.status === 'complete') done.push(e); else refused.push(String([...new Set((d?.placementErrors ?? []).flatMap((x: any) => x.reasons ?? []))][0] ?? d?.error).slice(0, 40)); }
  const row = { utc: new Date().toISOString(), name: a.name, change: a.change, box: [a.x0, a.x1, a.z0, a.z1], treatment: done.map(e => ({ x: Math.round(e.mx), z: Math.round(e.mz), len: Math.round(e.length), flow: e.flow, vol: e.vol })), control: control.map(e => ({ x: Math.round(e.mx), z: Math.round(e.mz), len: Math.round(e.length), flow: e.flow, vol: e.vol })) };
  appendFileSync(file, JSON.stringify(row) + '\n'); console.log(JSON.stringify({ name: a.name, change: a.change, treated: done.length, refused, control: control.length, flowBefore: { treatment: mean(done.map(e => e.flow)), control: mean(control.map(e => e.flow)) } }));
} else {
  const tests = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  for (const t of tests) { const now = await edgesIn({ x0: t.box[0], x1: t.box[1], z0: t.box[2], z1: t.box[3] }); const at = (p: any) => now.filter(e => Number.isFinite(e.flow)).sort((u, v) => Math.hypot(u.mx - p.x, u.mz - p.z) - Math.hypot(v.mx - p.x, v.mz - p.z))[0]; const tn = t.treatment.map(at).filter((e: any) => e), cn = t.control.map(at).filter((e: any) => e);
    console.log(`${t.name} (${t.change}, started ${t.utc.slice(11, 16)} UTC): treatment ${t.treatment.length} edges ${mean(t.treatment.map((e: any) => e.flow))}% -> ${mean(tn.map((e: any) => e.flow))}% (now ${[...new Set(tn.map((e: any) => e.prefab))].join('/')}); control ${t.control.length} edges ${mean(t.control.map((e: any) => e.flow))}% -> ${mean(cn.map((e: any) => e.flow))}%`); }
}
