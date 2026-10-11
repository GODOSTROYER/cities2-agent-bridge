// LIVE helper (read only): time lost on every edge of a corridor (the network path through a list of points).
//   node test/corridor.ts '<json: [[x,z],...]>' [label]
// Prints one row per edge (road type, length, vehicles, flow %, share of the city's time lost) and the corridor total,
// and appends the total to journals/corridor-history.jsonl so a change can be compared before and after.
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { callOk } from '../src/bridge.ts';
const pts: [number, number][] = JSON.parse(process.argv[2]); const label = process.argv[3] ?? '';
const near = async (q: [number, number]) => ((await callOk('get_network', { x: q[0], z: q[1], radius: 45, limit: 80 }, 20)).nodes ?? []).filter((n: any) => (n.edges ?? []).length > 0).sort((u: any, v: any) => Math.hypot(u.position.x - q[0], u.position.z - q[1]) - Math.hypot(v.position.x - q[0], v.position.z - q[1]))[0];
const ids: number[] = [];
for (let i = 0; i < pts.length - 1; i++) { const s = await near(pts[i]), t = await near(pts[i + 1]); if (!s || !t) { console.log('no road node near point', i, 'or', i + 1); process.exit(0); } const p = await callOk('trace_network', { fromIndex: s.index, fromVersion: s.version, toIndex: t.index, toVersion: t.version }, 20); if (!p.connected) { console.log('points', i, i + 1, 'not connected'); process.exit(0); } for (const e of p.edges ?? []) if (!ids.includes(e.index)) ids.push(e.index); }
const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length, cz = pts.reduce((a, p) => a + p[1], 0) / pts.length; const r = Math.max(...pts.map(p => Math.hypot(p[0] - cx, p[1] - cz))) + 150;
const hot = await callOk('traffic_hotspots', { top: 400, by: 'delay', x: cx, z: cz, radius: r, minLength: 0 }, 40); const by = new Map<number, any>((hot.hotspots ?? hot.edges ?? []).map((h: any) => [h.index, h]));
let total = 0, veh = 0, len = 0, wsum = 0; const rows: string[] = [];
for (const id of ids) { const h = by.get(id); if (!h) { rows.push(`${String(id).padEnd(9)} (no traffic data)`); continue; } total += Number(h.delayPct ?? 0); veh = Math.max(veh, Number(h.volume ?? 0)); len += Number(h.length ?? 0); wsum += Number(h.flowPct ?? h.flow ?? 0) * Number(h.length ?? 0); rows.push(`${String(id).padEnd(9)} ${String(h.prefab ?? '').padEnd(26)} (${Math.round(h.x)},${Math.round(h.z)})`.padEnd(56) + ` len ${String(Math.round(h.length)).padStart(4)}  vehicles ${String(Math.round(h.volume ?? 0)).padStart(4)}  flow ${String(Math.round(h.flowPct ?? h.flow ?? 0)).padStart(3)}%  time lost ${Number(h.delayPct ?? 0).toFixed(2)}%`); }
console.log(rows.join('\n'));
const out = { utc: new Date().toISOString(), label, edges: ids.length, metres: Math.round(len), timeLostPct: Number(total.toFixed(2)), meanFlowPct: len ? Math.round(wsum / len) : null, cityFlowByVolume: hot.flowByVolumePct };
console.log(JSON.stringify(out));
appendFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'journals', 'corridor-history.jsonl'), JSON.stringify({ ...out, points: pts }) + '\n');
