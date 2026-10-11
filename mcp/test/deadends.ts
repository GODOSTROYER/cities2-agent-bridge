// LIVE helper (read only): every dead end and stub of the design audit with what to do about it:
// the buildings that front the dead-end edge (none = the stub can simply be removed) and the nearest
// existing node it could be joined to with a straight street that crosses no road, highway or railway.
//   node test/deadends.ts [max=130]
import { callOk } from '../src/bridge.ts';
import { readAuditEdges } from '../src/design-live.ts';
import { audit, roadClass } from '../src/design.ts';
const max = Number(process.argv[2] ?? 130);
const all = await readAuditEdges(); const roads = all.filter(e => ['small', 'medium', 'large', 'highway'].includes(roadClass(e.prefab)));
const pos = new Map<number, { x: number; z: number }>(); const deg = new Map<number, number>();
for (const e of roads) { pos.set(e.startNode, e.a); pos.set(e.endNode, e.d); deg.set(e.startNode, (deg.get(e.startNode) ?? 0) + 1); deg.set(e.endNode, (deg.get(e.endNode) ?? 0) + 1); }
const cross = (p: any, q: any, r: any, s: any) => { const d = (q.x - p.x) * (s.z - r.z) - (q.z - p.z) * (s.x - r.x); if (Math.abs(d) < 1e-9) return false; const t = ((r.x - p.x) * (s.z - r.z) - (r.z - p.z) * (s.x - r.x)) / d, u = ((r.x - p.x) * (q.z - p.z) - (r.z - p.z) * (q.x - p.x)) / d; return t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98; };
const defects = audit({ edges: all }).defects.filter(d => d.kind === 'dead_end' || d.kind === 'stub');
for (const d of defects) {
  const e = roads.find(r => r.index === d.edges[0]); if (!e) continue; const endIsStart = (deg.get(e.startNode) ?? 0) === 1; const end = endIsStart ? e.a : e.d, other = endIsStart ? e.d : e.a; const endNode = endIsStart ? e.startNode : e.endNode;
  const b = (await callOk('get_buildings', { x: (e.a.x + e.d.x) / 2, z: (e.a.z + e.d.z) / 2, radius: e.length / 2 + 45, limit: 200, fields: ['prefab', 'roadEdge'] }, 30)).buildings ?? []; const fronting = b.filter((o: any) => o.roadEdge?.index === e.index);
  // straight continuation first: the node nearest to the line of the dead-end street beyond its end
  const ux = (end.x - other.x) / (e.length || 1), uz = (end.z - other.z) / (e.length || 1); let best: any = null;
  for (const [n, p] of pos) { if (n === endNode || n === (endIsStart ? e.endNode : e.startNode)) continue; const L = Math.hypot(p.x - end.x, p.z - end.z); if (L > max || L < 12) continue; const along = (p.x - end.x) * ux + (p.z - end.z) * uz; if (along < L * 0.5) continue; if (all.some(r => roadClass(r.prefab) !== 'other' && r.index !== e.index && cross(end, p, r.a, r.d))) continue; const off = Math.sqrt(Math.max(0, L * L - along * along)); const score = L + off * 3; if (!best || score < best.score) best = { score, L: Math.round(L), off: Math.round(off), to: [Math.round(p.x), Math.round(p.z)], arms: deg.get(n) }; }
  console.log(`${d.kind.padEnd(8)} end (${Math.round(end.x)},${Math.round(end.z)}) ${e.prefab}, ${Math.round(e.length)} m, edge ${e.index}; buildings on it: ${fronting.length}${fronting.length ? ' (' + [...new Set(fronting.map((o: any) => String(o.prefab).replace(/_L\d.*/, '')))].slice(0, 3).join(', ') + ')' : ' -> can be removed'}; ${best ? `join: ${best.L} m to (${best.to}) [${best.arms} arms], ${best.off} m off the line` : 'no node ahead within ' + max + ' m'}`);
}
