// LIVE helper: builds a chain of road legs (ramps, tunnels, bridges) after previewing EVERY leg first.
// Each leg: {to:[x,z], control?:[x,z], e0?:number, e1?:number}; elevations are relative to the ground (negative = tunnel).
//   node test/legs.ts '<json: {road, from:[x,z], fromNode?:{index,version}, toNode?:{index,version}, legs:[...]}>' [build]
import { callOk, call, waitOperation } from '../src/bridge.ts';
import { prefab } from '../src/city.ts';
const a = JSON.parse(process.argv[2]); const build = process.argv[3] === 'build';
const p = await prefab(a.road, 'network'); const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const nodeAt = async (x: number, z: number) => { const d = await callOk('get_network', { x, z, radius: 7, limit: 5 }, 30); const n = (d.nodes ?? [])[0]; return n ? { index: n.index, version: n.version } : {}; };
const run = async (start: any, end: any, leg: any, previewOnly: boolean) => {
  const args: any = { prefabIndex: p.index, prefabVersion: p.version, start, end, maxCost: 100000, ...(leg.e0 !== undefined ? { startElevation: leg.e0 } : {}), ...(leg.e1 !== undefined ? { endElevation: leg.e1 } : {}), ...(leg.control ? { control: { x: leg.control[0], z: leg.control[1] }, mode: 'curve' } : {}), ...(previewOnly ? { previewOnly: true } : {}) };
  for (let t = 0; t < 8; t++) { const o = await call('build_road', args, 15); if (!o.ok) { const e = JSON.stringify(o.error); if (/busy|finish_or_cancel/.test(e)) { await wait(3000); continue; } return { status: 'refused', error: e }; } const d = await waitOperation(o.result.id, 60); if (d.status === 'complete' || !/busy|finish_or_cancel/.test(String(d.error))) return d; await wait(3000); }
  return { status: 'failed', error: 'busy' };
};
const pts = [a.from, ...a.legs.map((l: any) => l.to)];
// 1. every leg previewed (free points except the real end nodes)
for (let i = 0; i < a.legs.length; i++) {
  const s: any = { x: pts[i][0], z: pts[i][1], ...(i === 0 ? (a.fromNode ?? await nodeAt(pts[0][0], pts[0][1])) : {}) }, e: any = { x: pts[i + 1][0], z: pts[i + 1][1], ...(i === a.legs.length - 1 ? (a.toNode ?? await nodeAt(pts[i + 1][0], pts[i + 1][1])) : {}) };
  const d: any = await run(s, e, a.legs[i], true); const reasons = [...new Set((d.placementErrors ?? []).flatMap((q: any) => q.reasons ?? []))];
  console.log(`preview leg ${i + 1} (${pts[i]})->(${pts[i + 1]}) ${d.status} ${d.previewCost ?? ''} ${d.error ?? ''} ${reasons.join(',')}`);
  if (d.status !== 'complete') { console.log('STOP: a leg failed its preview; nothing was built'); process.exit(0); }
}
if (!build) process.exit(0);
// 2. build, chaining each leg to the node the previous one ended on
let total = 0;
for (let i = 0; i < a.legs.length; i++) {
  const s: any = { x: pts[i][0], z: pts[i][1], ...(i === 0 ? (a.fromNode ?? await nodeAt(pts[0][0], pts[0][1])) : await nodeAt(pts[i][0], pts[i][1])) }, e: any = { x: pts[i + 1][0], z: pts[i + 1][1], ...(i === a.legs.length - 1 ? (a.toNode ?? await nodeAt(pts[i + 1][0], pts[i + 1][1])) : {}) };
  const d: any = await run(s, e, a.legs[i], false); const reasons = [...new Set((d.placementErrors ?? []).flatMap((q: any) => q.reasons ?? []))];
  console.log(`built leg ${i + 1}: ${d.status} ${d.previewCost ?? ''} ${d.error ?? ''} ${reasons.join(',')}`);
  if (d.status !== 'complete') { console.log('STOP: built legs so far remain; fix or remove them'); process.exit(0); }
  total += Number(d.previewCost ?? 0); await wait(800);
}
console.log('total', total);
