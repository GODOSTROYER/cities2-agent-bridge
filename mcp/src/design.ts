// Urban design audit of the road network: lists design defects (dead ends, stubs, double junctions, lane/width drops, steep ramps,
// at-grade crossings of rail or highway, sharp angles, single-access districts, untreed arterials) so the rule loop can report
// count and trend and feed fixes to the work queue; checkRoadPlan rejects a road plan that would create such a defect.
// Pure functions over plain data: no I/O, no bridge access.
export interface P3 { x: number; y: number; z: number }
export interface AuditEdge {
  index: number; prefab: string; length: number; startNode: number; endNode: number;
  a: P3; d: P3;                             // a = start node position, d = end node position
  trees?: boolean;                          // true when the road has the Trees or Grass option; undefined = unknown
}
export interface AuditInput { edges: AuditEdge[]; mapHalfSize?: number }
export interface Defect { kind: string; x: number; z: number; detail: string; edges: number[] }
export interface RoadPlan { prefab: string; from: P3; to: P3; fromNode?: number; toNode?: number }
export type RoadClass = 'small' | 'medium' | 'large' | 'highway' | 'rail' | 'other';

export const ROAD_WIDTH = { small: 16, medium: 24, large: 32 };
export const PRIORITY = ['level_crossing', 'highway_at_grade', 'single_access', 'steep_ramp', 'width_change', 'double_junction', 'stub', 'dead_end', 'sharp_angle', 'no_trees'];

export function roadClass(prefab: string): RoadClass {
  if (prefab.includes('Highway')) return 'highway';
  if (prefab.includes('Train Track') || prefab.includes('Rail')) return 'rail';
  if (prefab.includes('Small Road')) return 'small';
  if (prefab.includes('Medium Road')) return 'medium';
  if (prefab.includes('Large Road')) return 'large';
  return 'other';
}
const isCity = (c: RoadClass) => c === 'small' || c === 'medium' || c === 'large';
const isRoad = (c: RoadClass) => isCity(c) || c === 'highway';

interface Arm { e: AuditEdge; cls: RoadClass; dx: number; dz: number }
const angleDeg = (a: { dx: number; dz: number }, b: { dx: number; dz: number }) => {   // 0..180, NaN when an arm has no length
  const la = Math.hypot(a.dx, a.dz), lb = Math.hypot(b.dx, b.dz); if (la < 1e-9 || lb < 1e-9) return NaN;
  return Math.acos(Math.max(-1, Math.min(1, (a.dx * b.dx + a.dz * b.dz) / (la * lb)))) * 180 / Math.PI;
};
const slope = (a: P3, d: P3, len: number) => (len > 0 ? Math.abs(a.y - d.y) / len : 0);
/** Proper crossing of segments a1-d1 and a2-d2 in the xz plane (not at an end): the point and both heights there, or null. */
function crossing(a1: P3, d1: P3, a2: P3, d2: P3): { x: number; z: number; y1: number; y2: number } | null {
  const rx = d1.x - a1.x, rz = d1.z - a1.z, sx = d2.x - a2.x, sz = d2.z - a2.z, den = rx * sz - rz * sx; if (Math.abs(den) < 1e-9) return null;
  const qx = a2.x - a1.x, qz = a2.z - a1.z, t = (qx * sz - qz * sx) / den, u = (qx * rz - qz * rx) / den, eps = 1e-9;
  if (t <= eps || t >= 1 - eps || u <= eps || u >= 1 - eps) return null;
  return { x: a1.x + t * rx, z: a1.z + t * rz, y1: a1.y + t * (d1.y - a1.y), y2: a2.y + u * (d2.y - a2.y) };
}
/** Distance in the xz plane from point p to segment a-d. */
function distSeg(p: P3, a: P3, d: P3): number {
  const vx = d.x - a.x, vz = d.z - a.z, l2 = vx * vx + vz * vz; const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.z - a.z) * vz) / l2));
  return Math.hypot(p.x - (a.x + t * vx), p.z - (a.z + t * vz));
}

export function audit(input: AuditInput): { defects: Defect[]; counts: Record<string, number>; total: number } {
  const half = input.mapHalfSize ?? 7168, defects: Defect[] = [];
  const add = (kind: string, x: number, z: number, detail: string, edges: number[]) => defects.push({ kind, x: Math.round(x), z: Math.round(z), detail, edges });
  const atMapEdge = (p: P3) => Math.abs(p.x) >= half - 60 || Math.abs(p.z) >= half - 60;
  const roads = input.edges.filter(e => isRoad(roadClass(e.prefab))), rails = input.edges.filter(e => roadClass(e.prefab) === 'rail');
  const nodes = new Map<number, { pos: P3; arms: Arm[] }>();
  const arm = (n: number, pos: P3, other: P3, e: AuditEdge) => {
    let v = nodes.get(n); if (!v) nodes.set(n, v = { pos, arms: [] }); v.arms.push({ e, cls: roadClass(e.prefab), dx: other.x - pos.x, dz: other.z - pos.z });
  };
  for (const e of roads) { arm(e.startNode, e.a, e.d, e); arm(e.endNode, e.d, e.a, e); }
  const deg = (n: number) => nodes.get(n)?.arms.length ?? 0, mid = (e: AuditEdge) => ({ x: (e.a.x + e.d.x) / 2, z: (e.a.z + e.d.z) / 2 });

  for (const [id, n] of nodes) {
    const city = n.arms.filter(a => isCity(a.cls)), hw = n.arms.length - city.length;
    // 1. dead ends and stubs
    if (city.length === 1 && hw === 0 && !atMapEdge(n.pos)) {
      const e = city[0].e; add(e.length < 60 ? 'stub' : 'dead_end', n.pos.x, n.pos.z, `${city[0].cls} road ends after ${Math.round(e.length)} m`, [e.index]);
    }
    // 3. width change
    if (n.arms.length === 2 && city.length === 2 && city[0].cls !== city[1].cls) {
      const ang = angleDeg(city[0], city[1]);
      if (180 - ang < 35) add('width_change', n.pos.x, n.pos.z, `${city[0].cls} road continues as ${city[1].cls} road`, city.map(a => a.e.index));
    } else if (n.arms.length >= 3) {
      let best = { dev: 1e9, i: 0, j: 0 };
      for (let i = 0; i < n.arms.length; i++) for (let j = i + 1; j < n.arms.length; j++) { const dev = 180 - angleDeg(n.arms[i], n.arms[j]); if (dev < best.dev) best = { dev, i, j }; }
      const p = n.arms[best.i], q = n.arms[best.j];
      if (best.dev < 20 && isCity(p.cls) && isCity(q.cls) && p.cls !== q.cls && (p.cls === 'large' || q.cls === 'large'))
        add('width_change', n.pos.x, n.pos.z, `${p.cls} road continues as ${q.cls} road through a junction`, [p.e.index, q.e.index]);
      // 6. sharp angle between two city arms
      let sharp = 999, se: number[] = [];
      for (let i = 0; i < city.length; i++) for (let j = i + 1; j < city.length; j++) { const a = angleDeg(city[i], city[j]); if (a < sharp) { sharp = a; se = [city[i].e.index, city[j].e.index]; } }
      if (sharp < 35) add('sharp_angle', n.pos.x, n.pos.z, `two roads meet at ${sharp.toFixed(0)} degrees`, se);
    }
    void id;
  }
  for (const e of roads) {
    const c = roadClass(e.prefab), m = mid(e);
    // 2. double junction
    if (isCity(c) && e.length < 30 && e.startNode !== e.endNode && deg(e.startNode) >= 3 && deg(e.endNode) >= 3) add('double_junction', m.x, m.z, `two junctions ${Math.round(e.length)} m apart`, [e.index]);
    // 4. steep ramp
    if (e.length >= 20 && slope(e.a, e.d, e.length) > (c === 'small' ? 0.12 : 0.08)) add('steep_ramp', m.x, m.z, `${(slope(e.a, e.d, e.length) * 100).toFixed(1)}% slope over ${Math.round(e.length)} m`, [e.index]);
    // 8. no trees
    if ((c === 'medium' || c === 'large') && e.length >= 80 && e.trees === false) add('no_trees', m.x, m.z, `${c} road without trees, ${Math.round(e.length)} m`, [e.index]);
  }
  // 5. at-grade crossings. In the game a level crossing is a node shared by the road and the track.
  const railNodes = new Set<number>(); for (const r of rails) { railNodes.add(r.startNode); railNodes.add(r.endNode); }
  for (const [id, n] of nodes) { const city = n.arms.filter(a => isCity(a.cls)); if (city.length && railNodes.has(id)) add('level_crossing', n.pos.x, n.pos.z, `${city[0].e.prefab} crosses the railway at grade`, city.map(a => a.e.index)); }
  const shares = (p: AuditEdge, q: AuditEdge) => p.startNode === q.startNode || p.startNode === q.endNode || p.endNode === q.startNode || p.endNode === q.endNode;
  for (const r of roads) {
    if (!isCity(roadClass(r.prefab))) continue;
    for (const o of roads.filter(x => roadClass(x.prefab) === 'highway').concat(rails)) {
      if (shares(r, o)) continue; const x = crossing(r.a, r.d, o.a, o.d); if (!x || Math.abs(x.y1 - x.y2) > 4) continue;
      const hwy = roadClass(o.prefab) === 'highway'; add(hwy ? 'highway_at_grade' : 'level_crossing', x.x, x.z, `${r.prefab} crosses ${o.prefab} at grade`, [r.index, o.index]);
    }
  }
  // 7. single access: bridges of the road graph (iterative Tarjan) that cut off a big district without a map-edge node
  const adj = new Map<number, { to: number; ei: number }[]>(), w = new Map<number, number>(), cnt = new Map<number, number>();
  roads.forEach((e, ei) => {
    if (e.startNode === e.endNode) return;
    for (const [a, b] of [[e.startNode, e.endNode], [e.endNode, e.startNode]]) { (adj.get(a) ?? adj.set(a, []).get(a)!).push({ to: b, ei }); if (isCity(roadClass(e.prefab))) w.set(a, (w.get(a) ?? 0) + e.length / 2); }
  });
  // A node on a highway counts as a way out: the highways off owned land are not read, so a part of the city
  // that reaches a highway is never "cut off" (two halves joined by one street and the highway were reported as 31 km cut off).
  for (const [id, n] of nodes) cnt.set(id, atMapEdge(n.pos) || n.arms.some(a => a.cls === 'highway') ? 1 : 0);
  const tin = new Map<number, number>(), low = new Map<number, number>(), tout = new Map<number, number>(); let timer = 0;
  const bridges: { ei: number; w: number; c: number; root: number; v: number }[] = [], total = new Map<number, { w: number; c: number }>();
  for (const root of adj.keys()) {
    if (tin.has(root)) continue; tin.set(root, timer); low.set(root, timer++);
    const st: { v: number; pe: number; i: number }[] = [{ v: root, pe: -1, i: 0 }];
    while (st.length) {
      const f = st[st.length - 1], list = adj.get(f.v)!;
      if (f.i < list.length) {
        const { to, ei } = list[f.i++]; if (ei === f.pe) continue;
        if (tin.has(to)) low.set(f.v, Math.min(low.get(f.v)!, tin.get(to)!)); else { tin.set(to, timer); low.set(to, timer++); st.push({ v: to, pe: ei, i: 0 }); }
      } else {
        st.pop(); tout.set(f.v, timer - 1); const p = st[st.length - 1]; if (!p) continue;
        if (low.get(f.v)! > tin.get(p.v)!) bridges.push({ ei: f.pe, w: w.get(f.v) ?? 0, c: cnt.get(f.v) ?? 0, root, v: f.v });
        low.set(p.v, Math.min(low.get(p.v)!, low.get(f.v)!)); w.set(p.v, (w.get(p.v) ?? 0) + (w.get(f.v) ?? 0)); cnt.set(p.v, (cnt.get(p.v) ?? 0) + (cnt.get(f.v) ?? 0));
      }
    }
    total.set(root, { w: w.get(root) ?? 0, c: cnt.get(root) ?? 0 });
  }
  const cuts: { e: AuditEdge; len: number; v: number; sub: boolean }[] = [];
  for (const b of bridges) {
    const e = roads[b.ei], h = isCity(roadClass(e.prefab)) ? e.length / 2 : 0, t = total.get(b.root)!;
    if (deg(e.startNode) <= 1 || deg(e.endNode) <= 1) continue;
    const aLen = b.w - h, bLen = t.w - b.w - h, small = aLen <= bLen ? { len: aLen, c: b.c } : { len: bLen, c: t.c - b.c };
    if (small.len >= 800 && small.c === 0) cuts.push({ e, len: small.len, v: b.v, sub: aLen <= bLen });
  }
  // One access road is a chain of cut edges: report the outermost one only (the largest cut-off part).
  cuts.sort((p, q) => q.len - p.len); const kept: typeof cuts = [];
  for (const c of cuts) { if (c.sub && kept.some(k => k.sub && tin.get(k.v)! <= tin.get(c.v)! && tin.get(c.v)! <= (tout.get(k.v) ?? -1))) continue; kept.push(c); const m = mid(c.e); add('single_access', m.x, m.z, `${Math.round(c.len)} m of road cut off by this edge`, [c.e.index]); }
  const counts: Record<string, number> = {}; for (const d of defects) counts[d.kind] = (counts[d.kind] ?? 0) + 1;
  return { defects, counts, total: defects.length };
}

/** "urban design defects 47 (was 52): dead_end 9, stub 4, ..." (kinds by descending count; prev = earlier counts or earlier total). */
export function auditLine(counts: Record<string, number>, prev?: Record<string, number> | number): string {
  const sum = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);
  const kinds = Object.entries(counts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const was = prev === undefined ? '' : ` (was ${typeof prev === 'number' ? prev : sum(prev)})`;
  return `urban design defects ${sum(counts)}${was}` + (kinds.length ? ': ' + kinds.map(([k, n]) => `${k} ${n}`).join(', ') : '');
}

/** The n defects to fix first: fixed kind priority, ties in input order. */
export function worstDefects(defects: Defect[], n: number): Defect[] {
  const rank = (d: Defect) => { const i = PRIORITY.indexOf(d.kind); return i < 0 ? PRIORITY.length : i; };
  return defects.map((d, i) => ({ d, i })).sort((a, b) => rank(a.d) - rank(b.d) || a.i - b.i).slice(0, Math.max(0, n)).map(x => x.d);
}

/** Would this straight piece create a defect? Reasons: steep_ramp, creates_dead_end, level_crossing, highway_at_grade, width_change, creates_double_junction. */
export function checkRoadPlan(plan: RoadPlan, input: AuditInput): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [], pc = roadClass(plan.prefab), half = input.mapHalfSize ?? 7168;
  if (pc === 'other') return { ok: true, reasons };
  const edges = input.edges, roads = edges.filter(e => isRoad(roadClass(e.prefab))), len = Math.hypot(plan.to.x - plan.from.x, plan.to.y - plan.from.y, plan.to.z - plan.from.z);
  if ((isCity(pc) || pc === 'highway') && slope(plan.from, plan.to, len) > 0.08) reasons.push('steep_ramp');
  const ends = [{ p: plan.from, o: plan.to, n: plan.fromNode }, { p: plan.to, o: plan.from, n: plan.toNode }];
  const nodeArms = (n: number) => roads.filter(e => e.startNode === n || e.endNode === n).map(e => ({ e, cls: roadClass(e.prefab), ...(e.startNode === n ? { dx: e.d.x - e.a.x, dz: e.d.z - e.a.z } : { dx: e.a.x - e.d.x, dz: e.a.z - e.d.z }) }));
  const nodePos = (n: number) => { const e = roads.find(x => x.startNode === n || x.endNode === n); return e ? (e.startNode === n ? e.a : e.d) : undefined; };
  if (isCity(pc) || pc === 'highway') {
    for (const end of ends) {
      if (end.n === undefined) {
        const onEdge = roads.filter(e => distSeg(end.p, e.a, e.d) <= 12);
        if (!onEdge.length && !(Math.abs(end.p.x) >= half - 60 || Math.abs(end.p.z) >= half - 60)) reasons.push('creates_dead_end');
        for (const e of onEdge.filter(x => isCity(roadClass(x.prefab)))) for (const n of [e.startNode, e.endNode]) {
          const np = nodePos(n); if (np && nodeArms(n).length >= 3 && Math.hypot(np.x - end.p.x, np.z - end.p.z) < 30) reasons.push('creates_double_junction');
        }
      } else if (isCity(pc)) {
        const arms = nodeArms(end.n);
        if (arms.length === 1 && isCity(arms[0].cls) && arms[0].cls !== pc && 180 - angleDeg(arms[0], { dx: end.o.x - end.p.x, dz: end.o.z - end.p.z }) < 35) reasons.push('width_change');
      }
    }
  }
  if (isCity(pc) || pc === 'highway' || pc === 'rail') {
    for (const e of edges) {
      const c = roadClass(e.prefab), joined = [plan.fromNode, plan.toNode].some(n => n !== undefined && (e.startNode === n || e.endNode === n));
      if (joined || !(isCity(pc) ? c === 'rail' || c === 'highway' : isCity(c))) continue;
      const x = crossing(plan.from, plan.to, e.a, e.d); if (!x || Math.abs(x.y1 - x.y2) > 4) continue;
      reasons.push((isCity(pc) ? c : pc) === 'highway' ? 'highway_at_grade' : 'level_crossing');
    }
  }
  const uniq = [...new Set(reasons)]; return { ok: uniq.length === 0, reasons: uniq };
}
