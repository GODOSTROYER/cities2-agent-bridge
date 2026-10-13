// LIVE helper (read only): the N worst road corridors for traffic, ranked by vehicles x delay.
//   node test/worstedges.ts [N=10] [minVehicles=5]
// Per road edge it reads what flowstats.ts reads (get_network_edges over the purchased tiles): flow = flowstats'
// ratio of distance to duration per time bucket, vehicles = flowstats' volume, delay = 1 - flow, score = vehicles x delay
// (flowstats does not length-normalise, so this does not either). Edges in the top 3N are chained into corridors
// (same prefab, sharing a node that is still a free end of the chain). Hints come only from the edge data:
// short (< 60 m between two junctions), lanedrop (the one other edge at a 2-way node is a narrower class),
// deg5+ (a node with 5 or more edges in the fetched data), bridge/ramp (grade > 6%). No signal hint: the edge data has no signals.
import { callOk } from '../src/bridge.ts';

const N = Math.max(1, Number(process.argv[2] ?? 10)), minVeh = Number(process.argv[3] ?? 5);
const t0 = Date.now();
const tiles = ((await callOk('get_tiles', {}, 30)).tiles ?? []).filter((t: any) => t.purchased);
const roads = new Map<number, any>(), all = new Map<number, any>();
for (const t of tiles) {
  const xs = t.polygon.map((p: any) => p.x), zs = t.polygon.map((p: any) => p.z);
  const r = await callOk('get_network_edges', { x: (Math.min(...xs) + Math.max(...xs)) / 2, z: (Math.min(...zs) + Math.max(...zs)) / 2, radius: 470 }, 40);
  for (const e of r.edges ?? []) { if (!all.has(e.index)) all.set(e.index, e); if (!roads.has(e.index) && e.trafficDistanceRaw && e.trafficDurationRaw) roads.set(e.index, e); }
}

const cls = (p: string) => /Highway/.test(p) ? 'highway' : /Large/.test(p) ? 'large' : /Medium/.test(p) ? 'medium' : /Small/.test(p) ? 'small' : 'other';
const rank: Record<string, number> = { highway: 4, large: 3, medium: 2, small: 1, other: 0 };
const nodeKey = (n: any) => `${n.index}:${n.version}`;
const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const pct = (x: number) => Number.isFinite(x) ? Math.round(x * 100) : null;

// Degree of every node over all fetched network edges (roads and paths), as the game's arm count.
const nodeEdges = new Map<string, number[]>();
for (const e of all.values()) for (const n of [e.startNode, e.endNode]) { const k = nodeKey(n); if (!nodeEdges.has(k)) nodeEdges.set(k, []); nodeEdges.get(k)!.push(e.index); }
const deg = (k: string) => nodeEdges.get(k)?.length ?? 0;

// flowstats' per-edge flow and vehicles, one row per road edge with a flow value.
const rows = [...roads.values()].map((e: any) => {
  const d: number[] = e.trafficDistanceRaw, u: number[] = e.trafficDurationRaw;
  const f = [0, 1, 2, 3].map(i => { const dist = d[i] + d[i + 4], dur = u[i] + u[i + 4]; return dur > 0 ? Math.max(0, Math.min(1, dist / dur)) : NaN; }).filter(x => Number.isFinite(x));
  const flow = f.length ? mean(f) : NaN; const vol = d.reduce((a, b) => a + b, 0) / 4;
  const a = e.curve[0], dd = e.curve[3], sk = nodeKey(e.startNode), ek = nodeKey(e.endNode);
  const score = vol * (1 - flow);
  return { index: e.index, prefab: String(e.prefab), cls: cls(String(e.prefab)), len: Number(e.length), flow, vol, score, a, d: dd, sk, ek };
}).filter(r => Number.isFinite(r.flow));

const hintsFor = (r: any): string[] => {
  const h: string[] = []; const ds = deg(r.sk), de = deg(r.ek);
  if (r.len < 60 && ds >= 3 && de >= 3) h.push('short');
  for (const [k, other] of [[r.sk, ds], [r.ek, de]] as const) {
    if (other !== 2) continue;
    const o = (nodeEdges.get(k) ?? []).find(i => i !== r.index); const oe = o !== undefined ? roads.get(o) : undefined;
    if (oe && cls(String(oe.prefab)) !== 'other' && rank[cls(String(oe.prefab))] < rank[r.cls]) { h.push('lanedrop'); break; }
  }
  if (Math.max(ds, de) >= 5) h.push('deg5+');
  if (r.len > 0 && Math.abs(r.a.y - r.d.y) / r.len > 0.06) h.push('bridge/ramp');
  return [...new Set(h)];
};

// Top 3N candidate edges (score order), chained into corridors: an edge joins a corridor of the same prefab when it
// shares a node that is still a free end of that corridor and its other node is new to it (no T-junction merges).
const pool = rows.filter(r => r.vol >= minVeh).sort((x, y) => y.score - x.score).slice(0, 3 * N);
type Cor = { prefab: string; edges: any[]; count: Map<string, number>; pos: Map<string, any> };
const cors: Cor[] = [];
for (const r of pool) {
  const c = cors.find(c => c.prefab === r.prefab && [r.sk, r.ek].some(k => c.count.get(k) === 1) && !([r.sk, r.ek].every(k => c.count.has(k))));
  const target = c ?? (cors.push({ prefab: r.prefab, edges: [], count: new Map(), pos: new Map() }), cors[cors.length - 1]);
  target.edges.push(r); for (const k of [r.sk, r.ek]) target.count.set(k, (target.count.get(k) ?? 0) + 1);
  target.pos.set(r.sk, r.a); target.pos.set(r.ek, r.d);
}
const lines = cors.map(c => {
  const ends = [...c.count].filter(([, v]) => v === 1).map(([k]) => k);
  const from = c.pos.get(ends[0]) ?? c.edges[0].a, to = c.pos.get(ends[ends.length - 1]) ?? c.edges[0].d;
  const len = c.edges.reduce((s, e) => s + e.len, 0), score = c.edges.reduce((s, e) => s + e.score, 0);
  const veh = mean(c.edges.map(e => e.vol)), flow = c.edges.reduce((s, e) => s + e.flow * e.len, 0) / Math.max(1, len);
  const hints = [...new Set(c.edges.flatMap(hintsFor))];
  return { score, text: `${c.prefab} | (${Math.round(from.x)},${Math.round(from.z)}) -> (${Math.round(to.x)},${Math.round(to.z)}) | ${Math.round(len)} m, ${c.edges.length} edge${c.edges.length > 1 ? 's' : ''} | vehicles ${Math.round(veh)} | flow ${pct(flow)}% | ${hints.join(', ') || 'no hint'}` };
}).sort((a, b) => b.score - a.score).slice(0, N);

const plain = mean(rows.map(r => r.flow)); const weighted = rows.reduce((a, r) => a + r.flow * r.vol, 0) / rows.reduce((a, r) => a + r.vol, 0);
console.log(`worst corridors (score = vehicles x (1 - flow), top ${N}; ${pool.length} candidate edges with >= ${minVeh} vehicles of ${rows.length} road edges; ${Math.round((Date.now() - t0) / 1000)} s)`);
lines.forEach((l, i) => console.log(`${String(i + 1).padStart(2)}. score ${Math.round(l.score)} | ${l.text}`));
console.log(`summary: plain flow ${pct(plain)}%, weighted by vehicles ${pct(weighted)}% (flowstats figures over ${rows.length} edges)`);
