// LIVE helper: applies a road option to every road edge on the network path through a list of points
// (tram tracks on a trunk, bike lanes, trees, sound barriers). Each edge is previewed by the game's replace tool.
//   node test/option-path.ts '<json: {option:"Double Tram Track", points:[[x,z],...], remove?:false}>' [build]
import { call, callOk, waitOperation } from '../src/bridge.ts';
import { prefab } from '../src/city.ts';
const a = JSON.parse(process.argv[2]); const build = process.argv[3] === 'build';
const p = await prefab(a.option, 'network'); if (!p.found) { console.log('NOT FOUND', a.option); process.exit(0); }
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const near = async (q: [number, number]) => { const n = (await callOk('get_network', { x: q[0], z: q[1], radius: 70, limit: 80 }, 20)).nodes ?? []; return n.filter((x: any) => (x.edges ?? []).length > 0).sort((u: any, v: any) => Math.hypot(u.position.x - q[0], u.position.z - q[1]) - Math.hypot(v.position.x - q[0], v.position.z - q[1]))[0]; };
const edges: any[] = []; const seen = new Set<number>();
for (let i = 0; i < a.points.length - 1; i++) {
  const s = await near(a.points[i]), t = await near(a.points[i + 1]); if (!s || !t) { console.log('no road node near point', i, 'or', i + 1); process.exit(0); }
  const path = await callOk('trace_network', { fromIndex: s.index, fromVersion: s.version, toIndex: t.index, toVersion: t.version }, 20);
  if (!path.connected) { console.log('points', i, 'and', i + 1, 'are not connected'); process.exit(0); }
  for (const e of path.edges ?? []) if (!seen.has(e.index)) { seen.add(e.index); edges.push(e); }
}
let done = 0, cost = 0; const refused: Record<string, number> = {}; const bad: any[] = [];
for (const e of edges) {
  let d: any = null;
  for (let t = 0; t < 8; t++) { const o = await call('road_option', { index: e.index, version: e.version, prefabIndex: p.index, prefabVersion: p.version, remove: a.remove === true, maxCost: 100000, ...(build ? {} : { previewOnly: true }) }, 15); if (!o.ok) { d = { status: 'refused', error: JSON.stringify(o.error) }; if (/busy|finish_or_cancel|batch_in_progress/.test(d.error)) { await wait(3000); continue; } break; } d = await waitOperation(o.result.id, 60); if (d.status === 'complete' || !/busy|finish_or_cancel/.test(String(d.error))) break; await wait(3000); }
  if (d.status === 'complete') { done++; cost += Number(d.previewCost ?? 0); } else { const k = String([...new Set((d.placementErrors ?? []).flatMap((x: any) => x.reasons ?? []))][0] ?? d.error).slice(0, 60); refused[k] = (refused[k] ?? 0) + 1; bad.push(e); }
}
console.log(JSON.stringify({ option: a.option, edges: edges.length, [build ? 'applied' : 'possible']: done, cost, refused }));
if (bad.length) console.log('refused edges:', JSON.stringify(bad.slice(0, 8)).slice(0, 900));
