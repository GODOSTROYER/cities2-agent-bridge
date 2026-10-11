// Offline checks: the urban design audit (defect kinds), the plan check, the report line and the fix ordering.
import { audit, auditLine, worstDefects, checkRoadPlan, roadClass } from '../src/design.ts';
import type { AuditEdge, Defect } from '../src/design.ts';
let failed = 0; const check = (ok: boolean, label: string) => { console.log((ok ? 'PASS: ' : 'FAIL: ') + label); if (!ok) failed++; };
type V = [number, number, number];
const e = (index: number, prefab: string, s: number, a: V, t: number, d: V, extra: Partial<AuditEdge> = {}): AuditEdge =>
  ({ index, prefab, startNode: s, endNode: t, a: { x: a[0], y: a[1], z: a[2] }, d: { x: d[0], y: d[1], z: d[2] }, length: Math.hypot(a[0] - d[0], a[1] - d[1], a[2] - d[2]), ...extra });
const n = (edges: AuditEdge[], kind: string, half?: number) => audit({ edges, mapHalfSize: half }).counts[kind] ?? 0;
const S = 'Small Road', M = 'Medium Road', L = 'Large Road', H = 'Highway Oneway - 2 lanes', R = 'Double Train Track';

check(roadClass(S) === 'small' && roadClass(M) === 'medium' && roadClass(L) === 'large' && roadClass(H) === 'highway' && roadClass(R) === 'rail' && roadClass('Small Road Bridge') === 'small', 'roadClass maps small/medium/large/highway/rail and bridge variants');
check(roadClass('Pedestrian Path') === 'other' && roadClass('Tram Track') === 'other' && roadClass('Power Line') === 'other', 'paths, tram tracks and cables are class other');

// edge cases
const empty = audit({ edges: [] });
check(empty.total === 0 && empty.defects.length === 0 && Object.keys(empty.counts).length === 0, 'empty input gives no defects');
check(audit({ edges: [e(1, 'Pedestrian Path', 1, [0, 0, 0], 2, [100, 0, 0]), e(2, 'Tram Track', 3, [0, 0, 0], 4, [100, 0, 50])] }).total === 0, 'edges of class other are ignored by every check');
check(audit({ edges: [e(1, S, 1, [0, 0, 0], 2, [0, 0, 0]), e(2, S, 2, [0, 0, 0], 3, [0, 5, 0])] }).defects.every(d => d.kind !== 'steep_ramp'), 'a zero-length edge does not divide by zero or count as a ramp');

// 1. dead end / stub
const spur = [e(1, S, 1, [0, 0, 0], 2, [200, 0, 0])];
check(n(spur, 'dead_end') === 2, 'a 200 m road with two free ends has two dead ends');
check(n([e(1, S, 1, [0, 0, 0], 2, [40, 0, 0])], 'stub') === 2 && n([e(1, S, 1, [0, 0, 0], 2, [40, 0, 0])], 'dead_end') === 0, 'a 40 m single edge makes stubs, not dead ends');
const tri = [e(1, S, 1, [0, 0, 0], 2, [100, 0, 0]), e(2, S, 2, [100, 0, 0], 3, [100, 0, 100]), e(3, S, 3, [100, 0, 100], 1, [0, 0, 0])];
check(n(tri, 'dead_end') === 0 && n(tri, 'stub') === 0, 'a closed loop has no dead ends');
check(n([e(1, S, 1, [0, 0, 0], 2, [7150, 0, 0])], 'dead_end') === 1, 'a dead end at the map edge is an outside connection, not a defect (the other end still is)');
check(n([e(1, H, 1, [0, 0, 0], 2, [7150, 0, 0])], 'dead_end') === 0, 'a highway dead end is never a dead_end defect');
check(n([e(1, S, 1, [0, 0, 0], 2, [7108, 0, 0])], 'dead_end') === 1 && n([e(1, S, 1, [0, 0, 0], 2, [7107, 0, 0])], 'dead_end') === 2, 'the map-edge band starts exactly at mapHalfSize - 60');
check(n([e(1, S, 1, [0, 0, 0], 2, [7000, 0, 7110])], 'dead_end') === 1, 'the z coordinate counts for the map edge too');
check(n([e(1, S, 1, [0, 0, 0], 2, [200, 0, 0]), e(2, H, 2, [200, 0, 0], 3, [400, 0, 0])], 'dead_end') === 1, 'a city road ending at a highway node is not a dead end');

// 2. double junction
const dj = (len: number) => [e(1, S, 1, [0, 0, 0], 2, [len, 0, 0]), e(2, S, 1, [0, 0, 0], 3, [-100, 0, 100]), e(3, S, 1, [0, 0, 0], 4, [-100, 0, -100]), e(4, S, 2, [len, 0, 0], 5, [len + 100, 0, 100]), e(5, S, 2, [len, 0, 0], 6, [len + 100, 0, -100])];
check(n(dj(20), 'double_junction') === 1, 'two 3-way nodes 20 m apart are a double junction');
check(n(dj(40), 'double_junction') === 0, 'two 3-way nodes 40 m apart are not');
check(n(dj(20).slice(0, 4), 'double_junction') === 0, 'a 3-way next to a plain bend is not');

// 3. width change
const wc = (c1: string, c2: string, to: V = [200, 0, 0]) => [e(1, c1, 1, [0, 0, 0], 2, [100, 0, 0]), e(2, c2, 2, [100, 0, 0], 3, to)];
check(n(wc(S, L), 'width_change') === 1 && /small.*large/.test(audit({ edges: wc(S, L) }).defects.find(d => d.kind === 'width_change')!.detail), 'small road continuing straight as large road is a width change, detail names both classes');
check(n(wc(M, M), 'width_change') === 0, 'the same class straight on is fine');
check(n(wc(S, L, [100, 0, 100]), 'width_change') === 0, 'a 90 degree bend between classes is not a width change');
check(n(wc(S, L, [200, 0, 50]), 'width_change') === 1 && n(wc(S, L, [200, 0, 90]), 'width_change') === 0, 'the straight test is 35 degrees of deviation');
const tj = (w: string, ea: string) => [e(1, w, 1, [0, 0, 0], 2, [100, 0, 0]), e(2, ea, 2, [100, 0, 0], 3, [200, 0, 0]), e(3, S, 2, [100, 0, 0], 4, [100, 0, 100])];
check(n(tj(M, L), 'width_change') === 1, 'at a T junction the opposite medium and large arms are a width change');
check(n(tj(S, M), 'width_change') === 0 && n(tj(L, L), 'width_change') === 0, 'at a T junction small/medium or equal opposite arms are left alone');

// 4. steep ramp
check(n([e(1, M, 1, [0, 0, 0], 2, [100, 12, 0])], 'steep_ramp') === 1 && /11\.9%/.test(audit({ edges: [e(1, M, 1, [0, 0, 0], 2, [100, 12, 0])] }).defects.find(d => d.kind === 'steep_ramp')!.detail), 'a 12% ramp on a medium road is flagged with one decimal');
check(n([e(1, S, 1, [0, 0, 0], 2, [100, 10, 0])], 'steep_ramp') === 0 && n([e(1, S, 1, [0, 0, 0], 2, [100, 14, 0])], 'steep_ramp') === 1, 'a local street on a hill is a ramp only above 12% (97 hill streets were flagged at 8%)');
check(n([e(1, S, 1, [0, 0, 0], 2, [100, 5, 0])], 'steep_ramp') === 0, 'a 5% slope is fine');
check(n([e(1, S, 1, [0, 0, 0], 2, [10, 2, 0])], 'steep_ramp') === 0, 'an edge under 20 m is not judged for slope');
check(n([e(1, H, 1, [0, 0, 0], 2, [100, 12, 0])], 'steep_ramp') === 1, 'highway edges count for steep ramps');

// 5. level crossing / highway at grade
const roadX = e(1, S, 1, [-50, 0, 0], 2, [50, 0, 0]);
check(n([roadX, e(2, R, 3, [0, 1, -50], 4, [0, 1, 50])], 'level_crossing') === 1, 'a road crossing a railway at the same height is a level crossing');
check(n([roadX, e(2, R, 3, [0, 10, -50], 4, [0, 10, 50])], 'level_crossing') === 0, 'a railway 10 m above the road is grade separated');
check(n([roadX, e(2, R, 2, [50, 0, 0], 3, [50, 0, 100])], 'level_crossing') === 1, 'a node shared by a road and a track is a level crossing (the game splits both edges at the crossing)');
check(n([e(1, S, 1, [-50, 0, 0], 2, [50, 10, 0]), e(2, R, 3, [0, 5, -50], 4, [0, 5, 50])], 'level_crossing') === 1 && n([e(1, S, 1, [-50, 0, 0], 2, [50, 10, 0]), e(2, R, 3, [0, 20, -50], 4, [0, 20, 50])], 'level_crossing') === 0, 'heights are interpolated at the crossing point');
check(n([roadX, e(2, H, 3, [0, 0, -50], 4, [0, 0, 50])], 'highway_at_grade') === 1 && n([roadX, e(2, H, 3, [0, 0, -50], 4, [0, 0, 50])], 'level_crossing') === 0, 'a road crossing a highway at grade is highway_at_grade');
check(n([roadX, e(2, H, 1, [-50, 0, 0], 3, [-50, 0, 100])], 'highway_at_grade') === 0, 'a highway ramp joining at a node is not a defect');
check(n([roadX, e(2, H, 3, [0, 8, -50], 4, [0, 8, 50])], 'highway_at_grade') === 0, 'a highway on a bridge is not a defect');

// 6. sharp angle
check(n([e(1, S, 1, [0, 0, 0], 2, [100, 0, 0]), e(2, S, 1, [0, 0, 0], 3, [100, 0, 20]), e(3, S, 1, [0, 0, 0], 4, [-100, 0, 0])], 'sharp_angle') === 1, 'two roads leaving a junction 11 degrees apart are a sharp angle');
check(n([e(1, S, 1, [0, 0, 0], 2, [100, 0, 0]), e(2, S, 1, [0, 0, 0], 3, [0, 0, 100]), e(3, S, 1, [0, 0, 0], 4, [-100, 0, 0])], 'sharp_angle') === 0, 'a clean T has no sharp angle');
check(n([e(1, S, 1, [0, 0, 0], 2, [100, 0, 0]), e(2, S, 1, [0, 0, 0], 3, [100, 0, 20])], 'sharp_angle') === 0, 'sharp angle needs a junction of 3+ roads');

// 7. single access
const ring = (ox: number, oz: number, side: number, first: number, nodeBase: number): AuditEdge[] => {
  const p: V[] = [[ox, 0, oz], [ox + side, 0, oz], [ox + side, 0, oz + side], [ox, 0, oz + side]];
  return p.map((q, i) => e(first + i, S, nodeBase + i, q, nodeBase + (i + 1) % 4, p[(i + 1) % 4]));
};
const main = ring(0, 0, 600, 1, 1);
const district = (side: number, ox = 1000) => [...main, ...ring(ox, 0, side, 10, 11), e(20, S, 2, [600, 0, 0], 11, [ox, 0, 0])];
const sa = audit({ edges: district(250) }).defects.filter(d => d.kind === 'single_access');
check(sa.length === 1 && sa[0].x === 800 && sa[0].z === 0 && /1000 m/.test(sa[0].detail) && sa[0].edges[0] === 20, 'a 1000 m district behind one connector is single access, reported at the connector midpoint: ' + JSON.stringify(sa));
check(n(district(150), 'single_access') === 0, 'a 600 m district behind one connector is below the 800 m threshold');
check(n(district(250, 7120), 'single_access') === 0, 'a district that holds a map-edge node already has a way out');
check(n([...main, ...ring(1000, 0, 250, 10, 11), e(20, S, 2, [600, 0, 0], 11, [1000, 0, 0]), e(21, S, 3, [600, 0, 600], 13, [1250, 0, 250])], 'single_access') === 0, 'two connections to the district remove the single access');
check(n([...main, e(20, S, 2, [600, 0, 0], 11, [1500, 0, 0])], 'single_access') === 0, 'a long spur is a dead end (rule 1), not single access');

// 8. no trees
const tree = (p: string, len: number, trees?: boolean) => [e(1, p, 1, [0, 0, 0], 2, [len, 0, 0], { trees })];
check(n(tree(M, 100, false), 'no_trees') === 1 && n(tree(L, 100, false), 'no_trees') === 1, 'a medium or large road of 100 m with trees false is a defect');
check(n(tree(M, 100, undefined), 'no_trees') === 0 && n(tree(M, 100, true), 'no_trees') === 0, 'unknown or present trees are never a defect');
check(n(tree(S, 100, false), 'no_trees') === 0 && n(tree(M, 70, false), 'no_trees') === 0, 'small roads and roads under 80 m are exempt');

// counts and total
const mixed = audit({ edges: [e(1, S, 1, [0, 0, 0], 2, [40, 0, 0])] });
check(mixed.total === 2 && mixed.counts.stub === 2 && mixed.defects.every(d => Number.isInteger(d.x) && Number.isInteger(d.z)), 'total and counts add up and coordinates are integers');

// auditLine / worstDefects
check(auditLine({ dead_end: 9, stub: 4, double_junction: 6 }) === 'urban design defects 19: dead_end 9, double_junction 6, stub 4', 'auditLine lists kinds by descending count: ' + auditLine({ dead_end: 9, stub: 4, double_junction: 6 }));
check(auditLine({ dead_end: 9, stub: 4, double_junction: 6 }, { dead_end: 20, stub: 3 }) === 'urban design defects 19 (was 23): dead_end 9, double_junction 6, stub 4', 'auditLine shows (was N) when prev is given');
check(auditLine({}) === 'urban design defects 0' && auditLine({}, { stub: 2 }) === 'urban design defects 0 (was 2)', 'auditLine handles an empty count');
const dd = (kind: string, x = 0): Defect => ({ kind, x, z: 0, detail: '', edges: [] });
const w = worstDefects([dd('dead_end', 1), dd('level_crossing', 2), dd('no_trees', 3), dd('single_access', 4), dd('stub', 5), dd('level_crossing', 6)], 4);
check(w.map(d => d.kind + d.x).join() === 'level_crossing2,level_crossing6,single_access4,stub5', 'worstDefects orders by fixed priority and keeps input order on ties: ' + w.map(d => d.kind + d.x).join());
check(worstDefects(['no_trees', 'sharp_angle', 'dead_end', 'double_junction', 'width_change', 'steep_ramp', 'highway_at_grade'].map(k => dd(k)), 7).map(d => d.kind).join() === 'highway_at_grade,steep_ramp,width_change,double_junction,dead_end,sharp_angle,no_trees', 'the full priority order holds');
check(worstDefects([], 3).length === 0 && worstDefects([dd('stub')], 0).length === 0, 'worstDefects copes with empty input and n = 0');

// checkRoadPlan
const net = { edges: [e(1, S, 1, [0, 0, 0], 2, [200, 0, 0]), e(2, S, 3, [200, 0, 200], 4, [400, 0, 200]), e(3, S, 5, [400, 0, 0], 6, [400, 0, 200])] };
const p = (prefab: string, from: V, to: V, fromNode?: number, toNode?: number) => ({ prefab, from: { x: from[0], y: from[1], z: from[2] }, to: { x: to[0], y: to[1], z: to[2] }, fromNode, toNode });
const ok1 = checkRoadPlan(p(S, [200, 0, 0], [200, 0, 200], 2, 3), net);
check(ok1.ok && ok1.reasons.length === 0, 'a flat same-class piece joining two nodes is ok');
check(checkRoadPlan(p(S, [200, 0, 0], [400, 30, 0], 2, 5), net).reasons.includes('steep_ramp') && !checkRoadPlan(p(S, [200, 0, 0], [400, 5, 0], 2, 5), net).reasons.includes('steep_ramp'), 'plan slope over 8% is steep_ramp, 2.5% is not');
const dead = checkRoadPlan(p(S, [200, 0, 200], [1000, 0, 1000], 3), net);
check(!dead.ok && dead.reasons.includes('creates_dead_end'), 'a free end in the open is creates_dead_end');
check(checkRoadPlan(p(S, [200, 0, 200], [100, 0, 8], 3), net).ok, 'a free end landing within 12 m of an existing road edge is ok');
check(!checkRoadPlan(p(S, [200, 0, 200], [7150, 0, 0], 3), net).reasons.includes('creates_dead_end'), 'a free end at the map edge is no dead end');
const wcp = checkRoadPlan(p(L, [200, 0, 0], [400, 0, 0], 2, 5), net);
check(!wcp.ok && wcp.reasons.length === 1 && wcp.reasons[0] === 'width_change', 'joining a node with one small road straight on with a large road is width_change');
check(checkRoadPlan(p(L, [200, 0, 0], [200, 0, -200], 2), net).reasons.includes('width_change') === false, 'a 90 degree turn onto another class is not width_change');
const rail = { edges: [e(1, R, 7, [100, 0, -50], 8, [100, 0, 50])] }, railUp = { edges: [e(1, R, 7, [100, 10, -50], 8, [100, 10, 50])] };
check(checkRoadPlan(p(S, [0, 0, 0], [200, 0, 0], 90, 91), rail).reasons.join() === 'level_crossing', 'a plan crossing a railway at grade is level_crossing');
check(checkRoadPlan(p(S, [0, 0, 0], [200, 0, 0], 90, 91), railUp).ok, 'a plan passing under a railway 10 m up is ok');
const hwy = { edges: [e(1, H, 7, [100, 0, -50], 8, [100, 0, 50])] };
check(checkRoadPlan(p(S, [0, 0, 0], [200, 0, 0], 90, 91), hwy).reasons.join() === 'highway_at_grade', 'a plan crossing a highway at grade is highway_at_grade');
check(checkRoadPlan(p(S, [100, 0, -50], [200, 0, -50], 7, 91), hwy).ok, 'a plan joining the highway at its node is not at grade');
const tnet = { edges: [e(1, S, 10, [0, 0, 0], 11, [-100, 0, 0]), e(2, S, 10, [0, 0, 0], 12, [100, 0, 0]), e(3, S, 10, [0, 0, 0], 13, [0, 0, 100])] };
check(checkRoadPlan(p(S, [20, 0, 300], [20, 0, 3], 99), tnet).reasons.join() === 'creates_double_junction', 'a new T 20 m from a 3-way node is creates_double_junction');
check(checkRoadPlan(p(S, [60, 0, 300], [60, 0, 3], 99), tnet).ok, 'a new T 60 m from a 3-way node is ok');
check(checkRoadPlan(p('Pedestrian Path', [0, 0, 0], [500, 90, 0]), net).ok, 'a plan of class other is not judged');

console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`); process.exit(failed ? 1 : 0);
