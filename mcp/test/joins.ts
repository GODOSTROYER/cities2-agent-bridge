// LIVE helper (read only): for a single-access pocket (the cut edge's midpoint from the design audit) proposes
// the short streets that would give it a second way out: pairs of existing nodes, one inside the pocket and one
// outside, at most <max> metres apart, whose straight line crosses no road, highway or railway.
//   node test/joins.ts <x> <z> [max=130]
// Ranked by length, with a bonus for lines that continue the street grid (nearly due north-south or east-west).
import { readAuditEdges } from '../src/design-live.ts';
import { roadClass } from '../src/design.ts';
const [cx, cz] = process.argv.slice(2).map(Number); const max = Number(process.argv[4] ?? 130);
const all = await readAuditEdges(); const es = all.filter(e => ['small', 'medium', 'large', 'highway'].includes(roadClass(e.prefab)));
const cut = es.map(e => ({ e, d: Math.hypot((e.a.x + e.d.x) / 2 - cx, (e.a.z + e.d.z) / 2 - cz) })).sort((p, q) => p.d - q.d)[0].e;
const adj = new Map<number, number[]>(); const pos = new Map<number, { x: number; z: number }>(); const deg = new Map<number, number>();
for (const e of es) { pos.set(e.startNode, e.a); pos.set(e.endNode, e.d); deg.set(e.startNode, (deg.get(e.startNode) ?? 0) + 1); deg.set(e.endNode, (deg.get(e.endNode) ?? 0) + 1); if (e === cut) continue; for (const [a, b] of [[e.startNode, e.endNode], [e.endNode, e.startNode]]) { if (!adj.has(a)) adj.set(a, []); adj.get(a)!.push(b); } }
const side = (s: number) => { const seen = new Set([s]), q = [s]; while (q.length) { const v = q.pop()!; for (const b of adj.get(v) ?? []) if (!seen.has(b)) { seen.add(b); q.push(b); } } return seen; };
const A = side(cut.startNode), B = side(cut.endNode); if (A.has(cut.endNode)) { console.log('not a cut edge any more'); process.exit(0); }
const inside = A.size <= B.size ? A : B, outside = A.size <= B.size ? B : A;
const cross = (p: any, q: any, r: any, s: any) => { const d = (q.x - p.x) * (s.z - r.z) - (q.z - p.z) * (s.x - r.x); if (Math.abs(d) < 1e-9) return false; const t = ((r.x - p.x) * (s.z - r.z) - (r.z - p.z) * (s.x - r.x)) / d, u = ((r.x - p.x) * (q.z - p.z) - (r.z - p.z) * (q.x - p.x)) / d; return t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98; };
const out: any[] = [];
for (const i of inside) for (const o of outside) {
  const p = pos.get(i)!, q = pos.get(o)!; const L = Math.hypot(p.x - q.x, p.z - q.z); if (L > max || L < 20) continue;
  if (all.some(e => roadClass(e.prefab) !== 'other' && cross(p, q, e.a, e.d))) continue;
  const skew = Math.min(Math.abs(p.x - q.x), Math.abs(p.z - q.z)); out.push({ L: Math.round(L), skew: Math.round(skew), from: [Math.round(p.x), Math.round(p.z)], to: [Math.round(q.x), Math.round(q.z)], arms: [deg.get(i), deg.get(o)], score: L + skew * 3 });
}
out.sort((a, b) => a.score - b.score);
console.log(`cut edge ${cut.index} (${Math.round(cut.a.x)},${Math.round(cut.a.z)})->(${Math.round(cut.d.x)},${Math.round(cut.d.z)}); pocket nodes ${inside.size}; candidates ${out.length}`);
for (const c of out.slice(0, 8)) console.log(`${c.L} m, off-grid ${c.skew} m: pocket (${c.from}) [${c.arms[0]} arms] -> outside (${c.to}) [${c.arms[1]} arms]`);
