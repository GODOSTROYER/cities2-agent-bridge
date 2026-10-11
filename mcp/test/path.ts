// LIVE helper: builds a road along a list of points in pieces of at most `step` metres, each piece
// previewed by the game first and chained to the node the previous piece ended on. Stops at the first refusal.
//   node test/path.ts '<json: {road, points:[[x,z],...], step?:200, startNode?:{index,version}, endNode?:{index,version}}>' [build]
import { callOk, call, waitOperation } from '../src/bridge.ts';
import { prefab } from '../src/city.ts';
const a = JSON.parse(process.argv[2]); const build = process.argv[3] === 'build'; const step = Number(a.step ?? 200);
const p = await prefab(a.road ?? 'Medium Road', 'network');
const pts: { x: number; z: number }[] = [];
for (let i = 0; i < a.points.length - 1; i++) {
  const [x0, z0] = a.points[i], [x1, z1] = a.points[i + 1]; const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / step));
  for (let k = i === 0 ? 0 : 1; k <= n; k++) pts.push({ x: x0 + (x1 - x0) * k / n, z: z0 + (z1 - z0) * k / n });
}
const nodeAt = async (q: { x: number; z: number }) => { const d = await callOk('get_network', { x: q.x, z: q.z, radius: 6, limit: 5 }, 30); const n = (d.nodes ?? [])[0]; return n ? { index: n.index, version: n.version } : null; };
let from: any = { ...pts[0], ...(a.startNode ?? (await nodeAt(pts[0])) ?? {}) }; let total = 0;
for (let i = 1; i < pts.length; i++) {
  const last = i === pts.length - 1; const to: any = { ...pts[i], ...(last ? (a.endNode ?? (await nodeAt(pts[i])) ?? {}) : {}) };
  const run = async (previewOnly: boolean) => { const op = await call('build_road', { prefabIndex: p.index, prefabVersion: p.version, start: from, end: to, maxCost: 100000, ...(previewOnly ? { previewOnly: true } : {}) }, 15); if (!op.ok) return { status: 'refused', error: op.error }; return await waitOperation(op.result.id, 60); };
  const pre = await run(true); const reasons = [...new Set((pre.placementErrors ?? []).flatMap((e: any) => e.reasons ?? []))];
  if (pre.status !== 'complete') { console.log(JSON.stringify({ piece: i, from, to, status: pre.status, error: pre.error, reasons })); process.exit(0); }
  if (!build) { total += Number(pre.previewCost ?? 0); console.log(`piece ${i} (${Math.round(from.x)},${Math.round(from.z)})->(${Math.round(to.x)},${Math.round(to.z)}) ok ${pre.previewCost}`); from = { ...pts[i] }; continue; }
  let done: any = null; for (let t = 0; t < 4; t++) { done = await run(false); if (done.status === 'complete' || !/busy/.test(String(done.error))) break; await new Promise(r => setTimeout(r, 2500)); }
  if (done.status !== 'complete') { console.log(JSON.stringify({ piece: i, status: done.status, error: done.error })); process.exit(0); }
  total += Number(done.previewCost ?? 0); const n = await nodeAt(pts[i]); from = { ...pts[i], ...(n ?? {}) };
  console.log(`piece ${i} built to (${Math.round(pts[i].x)},${Math.round(pts[i].z)}) node ${n?.index ?? '?'} cost ${done.previewCost}`);
}
console.log('total', total, build ? 'built' : 'preview (pieces previewed from free points, not chained)');
