// LIVE helper: builds a two-way transport line from a list of station points on roads.
// At each station it places a stop on each side of the road (left side of travel for each direction: this map
// drives on the left), then draws one closed line: out along the stations, back in reverse order.
//   node test/line.ts '<json: {stations:[[x,z],...], stop?:"NA_BusStop01", linePrefab?:179, oneWay?:false, radius?:60}>' [build]
// Without "build" it only previews the stops. Every stop and the line itself are previewed by the game first.
import { call, callOk, waitOperation } from '../src/bridge.ts';
import { prefab } from '../src/city.ts';
const a = JSON.parse(process.argv[2]); const build = process.argv[3] === 'build';
const sp = await prefab(a.stop ?? 'NA_BusStop01', 'all'); const S: [number, number][] = a.stations; const R = a.radius ?? 60;
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const op = async (command: string, args: any) => { for (let t = 0; t < 10; t++) { const o = await call(command, args, 15); if (!o.ok) { const e = JSON.stringify(o.error); if (/busy|finish_or_cancel|batch_in_progress/.test(e)) { await wait(3000); continue; } return { status: 'refused', error: e }; } const d = await waitOperation(o.result.id, 90); if (d.status === 'complete' || !/busy|finish_or_cancel/.test(String(d.error))) return d; await wait(3000); } return { status: 'failed', error: 'busy' }; };
const nearestEdge = async (x: number, z: number) => { const edges = (await callOk('get_network_edges', { x, z, radius: R }, 30)).edges ?? []; let best: any = null, bd = 1e9; for (const e of edges) { if (!/Road/.test(e.prefab) || /Highway/.test(e.prefab)) continue; const s = e.curve[0], t = e.curve[e.curve.length - 1]; if (Math.abs(s.y - t.y) > 6 && Math.hypot(t.x - s.x, t.z - s.z) < 130) continue; const dx = t.x - s.x, dz = t.z - s.z, L2 = dx * dx + dz * dz; const k = Math.max(0.15, Math.min(0.85, ((x - s.x) * dx + (z - s.z) * dz) / (L2 || 1))); const px = s.x + dx * k, pz = s.z + dz * k; const d = Math.hypot(x - px, z - pz); if (d < bd) { bd = d; best = { e, k, px, pz, dx: dx / Math.sqrt(L2 || 1), dz: dz / Math.sqrt(L2 || 1) }; } } return best; };
const placeStop = async (x: number, z: number, edge: any) => op('place_building', { prefabIndex: sp.index, prefabVersion: sp.version, object: true, netSide: true, position: { x, z, index: edge.e.index, version: edge.e.version, curvePosition: edge.k }, rotation: 0, maxCost: 50000, maxSnapDistance: 80, ...(build ? {} : { previewOnly: true }) });
const out: any[] = [], back: any[] = []; const notes: string[] = [];
for (let i = 0; i < S.length; i++) {
  const [x, z] = S[i]; const edge = await nearestEdge(x, z); if (!edge) { notes.push(`station ${i + 1} (${x},${z}): no road within ${R} m`); continue; }
  // travel direction at this station (towards the next one), projected on the road
  const nx = (S[Math.min(S.length - 1, i + 1)][0] - S[Math.max(0, i - 1)][0]), nz = (S[Math.min(S.length - 1, i + 1)][1] - S[Math.max(0, i - 1)][1]);
  const sign = nx * edge.dx + nz * edge.dz >= 0 ? 1 : -1; const dx = edge.dx * sign, dz = edge.dz * sign; const lx = -dz, lz = dx; // left of travel
  for (const dir of a.oneWay ? [1] : [1, -1]) {
    const px = edge.px + lx * 12 * dir + dx * 14 * dir, pz = edge.pz + lz * 12 * dir + dz * 14 * dir; const d: any = await placeStop(px, pz, edge);
    const id = (d.createdObjects ?? d.createdBuildings ?? [])[0];
    if (d.status !== 'complete' || (build && !id)) { notes.push(`station ${i + 1} ${dir > 0 ? 'out' : 'back'}: ${d.error ?? 'no stop'} ${[...new Set((d.placementErrors ?? []).flatMap((e: any) => e.reasons ?? []))].join(',')}`); continue; }
    (dir > 0 ? out : back).push(build ? { ...id, x: Math.round(d.snappedPosition?.x ?? px), z: Math.round(d.snappedPosition?.z ?? pz) } : { x: Math.round(d.snappedPosition?.x ?? px), z: Math.round(d.snappedPosition?.z ?? pz) });
  }
}
console.log(JSON.stringify({ stopsOut: out.length, stopsBack: back.length, notes }));
if (!build) process.exit(0);
const order = [...out, ...back.reverse()].map(s => ({ index: s.index, version: s.version })); if (order.length < 2) { console.log('not enough stops for a line'); process.exit(0); }
const pv: any = await op('create_line', { prefabIndex: a.linePrefab ?? 179, prefabVersion: 1, stops: order, closed: true, previewOnly: true });
if (pv.status !== 'complete') { console.log('LINE PREVIEW FAILED', JSON.stringify({ error: pv.error, preview: pv.preview, errors: (pv.placementErrors ?? []).slice(0, 3) }).slice(0, 500)); process.exit(0); }
const d: any = await op('create_line', { prefabIndex: a.linePrefab ?? 179, prefabVersion: 1, stops: order, closed: true });
console.log(JSON.stringify({ line: d.status, error: d.error, created: d.createdLines, stops: order.length }));
