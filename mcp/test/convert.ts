// LIVE helper: converts built zone lots in a box to another zone (industry beside homes -> offices).
// Lists by default; with "build" bulldozes the matching buildings and rezones the freed cells.
//   node test/convert.ts '<json: {x1,z1,x2,z2, match:"Industrial", zone:"off"}>' [build]
import { callOk, call, waitOperation } from '../src/bridge.ts';
const a = JSON.parse(process.argv[2]); const build = process.argv[3] === 'build';
const cx = (a.x1 + a.x2) / 2, cz = (a.z1 + a.z2) / 2, r = Math.hypot(a.x2 - a.x1, a.z2 - a.z1) / 2 + 10;
const all = (await callOk('get_buildings', { x: cx, z: cz, radius: r, limit: 600 }, 30)).buildings ?? [];
const rx = new RegExp(a.match ?? 'Industrial');
const hit = all.filter((b: any) => rx.test(b.prefab) && b.position.x >= Math.min(a.x1, a.x2) && b.position.x <= Math.max(a.x1, a.x2) && b.position.z >= Math.min(a.z1, a.z2) && b.position.z <= Math.max(a.z1, a.z2));
console.log('matching buildings', hit.length);
if (!build) { for (const b of hit) console.log(b.prefab, Math.round(b.position.x), Math.round(b.position.z)); process.exit(0); }
const wait = (ms: number) => new Promise(res => setTimeout(res, ms)); let gone = 0; const failed: string[] = [];
for (const b of hit) {
  let d: any = null;
  for (let t = 0; t < 8; t++) { const o = await call('demolish', { index: b.index, version: b.version }, 15); if (!o.ok) { d = { status: 'refused', error: JSON.stringify(o.error) }; if (/busy|finish_or_cancel/.test(d.error)) { await wait(3000); continue; } break; } d = await waitOperation(o.result.id, 60); if (d.status === 'complete' || !/busy|finish_or_cancel/.test(String(d.error))) break; await wait(3000); }
  if (d?.status === 'complete') gone++; else failed.push(`${b.prefab}@${Math.round(b.position.x)},${Math.round(b.position.z)}: ${d?.error}`);
}
console.log(JSON.stringify({ demolished: gone, failed }));
