// LIVE helper (read only): what lies behind a single-access edge. node test/cut.ts <x> <z>   (the edge's midpoint from the design audit)
import { readAuditEdges } from '../src/design-live.ts';
import { roadClass } from '../src/design.ts';
const [cx, cz] = process.argv.slice(2).map(Number);
const es = (await readAuditEdges()).filter(e => ['small', 'medium', 'large', 'highway'].includes(roadClass(e.prefab)));
const cut = es.map(e => ({ e, d: Math.hypot((e.a.x + e.d.x) / 2 - cx, (e.a.z + e.d.z) / 2 - cz) })).sort((p, q) => p.d - q.d)[0].e;
console.log('cut edge', cut.index, cut.prefab, `(${Math.round(cut.a.x)},${Math.round(cut.a.z)})->(${Math.round(cut.d.x)},${Math.round(cut.d.z)})`);
const adj = new Map<number, { b: number; e: any }[]>();
for (const e of es) { if (e === cut) continue; for (const [a, b] of [[e.startNode, e.endNode], [e.endNode, e.startNode]]) { if (!adj.has(a)) adj.set(a, []); adj.get(a)!.push({ b, e }); } }
for (const start of [cut.startNode, cut.endNode]) {
  const seen = new Set([start]), q = [start], done = new Set<number>(); let len = 0, hw = 0, minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
  while (q.length) { const v = q.pop()!; for (const { b, e } of adj.get(v) ?? []) { if (!done.has(e.index)) { done.add(e.index); if (roadClass(e.prefab) === 'highway') hw++; else len += e.length; for (const p of [e.a, e.d]) { minx = Math.min(minx, p.x); maxx = Math.max(maxx, p.x); minz = Math.min(minz, p.z); maxz = Math.max(maxz, p.z); } } if (!seen.has(b)) { seen.add(b); q.push(b); } } }
  console.log(`side from node ${start}: ${Math.round(len)} m of streets, ${hw} highway edges, x ${Math.round(minx)}..${Math.round(maxx)}, z ${Math.round(minz)}..${Math.round(maxz)}${seen.has(start === cut.startNode ? cut.endNode : cut.startNode) ? ' (reaches the other end: not a cut)' : ''}`);
}
