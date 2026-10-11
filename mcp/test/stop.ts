// LIVE helper: preview/place a transport stop on the side of the road edge nearest to a point.
//   node test/stop.ts '<json: {prefab:"NA_BusStop01", x, z, rotation?}>' [build]
import { call, callOk, waitOperation } from '../src/bridge.ts';
import { prefab } from '../src/city.ts';
const a = JSON.parse(process.argv[2]); const build = process.argv[3] === 'build';
const p = await prefab(a.prefab ?? 'NA_BusStop01', 'all'); if (!p.found) { console.log('NOT FOUND', JSON.stringify(p.similar ?? [])); process.exit(0); }
const edges = (await callOk('get_network_edges', { x: a.x, z: a.z, radius: a.radius ?? 40 }, 30)).edges ?? [];
let best: any = null, bd = 1e9;
for (const e of edges) { if (!/Road/.test(e.prefab) || /Highway/.test(e.prefab)) continue; const s = e.curve[0], t = e.curve[e.curve.length - 1]; const dx = t.x - s.x, dz = t.z - s.z, L2 = dx * dx + dz * dz; const k = Math.max(0, Math.min(1, ((a.x - s.x) * dx + (a.z - s.z) * dz) / (L2 || 1))); const px = s.x + dx * k, pz = s.z + dz * k; const d = Math.hypot(a.x - px, a.z - pz); if (d < bd) { bd = d; best = { e, k, px, pz }; } }
if (!best) { console.log('no road edge near the point'); process.exit(0); }
const wait = (ms: number) => new Promise(r => setTimeout(r, ms)); let d: any = null;
for (let t = 0; t < 8; t++) {
  const o = await call('place_building', { prefabIndex: p.index, prefabVersion: p.version, object: true, netSide: true, position: { x: a.x, z: a.z, index: best.e.index, version: best.e.version, curvePosition: best.k }, rotation: a.rotation ?? 0, maxCost: 50000, maxSnapDistance: 60, ...(build ? {} : { previewOnly: true }) }, 15);
  if (!o.ok) { d = { status: 'refused', error: JSON.stringify(o.error) }; if (/busy|finish_or_cancel/.test(d.error)) { await wait(3000); continue; } break; }
  d = await waitOperation(o.result.id, 60); if (d.status === 'complete' || !/busy|finish_or_cancel/.test(String(d.error))) break; await wait(3000);
}
console.log(JSON.stringify({ edge: best.e.index, road: best.e.prefab, status: d.status, error: d.error, cost: d.previewCost, at: d.snappedPosition, created: d.createdObjects ?? d.createdBuildings, reasons: [...new Set((d.placementErrors ?? []).flatMap((e: any) => e.reasons ?? []))] }).slice(0, 700));
