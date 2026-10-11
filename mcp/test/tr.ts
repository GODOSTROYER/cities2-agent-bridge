// LIVE helper (read-only): every road edge near a point with traffic volume and flow, busiest first.
//   node test/tr.ts <x> <z> <radius> [minVolumePct]
import { callOk } from '../src/bridge.ts';
const [x, z, r, minVol = 0] = process.argv.slice(2).map(Number);
const t = await callOk('traffic_hotspots', { top: 5000, minLength: 0 }, 30);
const by = new Map<number, any>((t.hotspots ?? []).map((h: any) => [h.index, h]));
const d = await callOk('get_network_edges', { x, z, radius: r }, 30);
const rows = (d.edges ?? []).map((e: any) => ({ e, h: by.get(e.index) })).filter((q: any) => q.h && Number(q.h.volumePct ?? 0) >= minVol).sort((a: any, b: any) => Number(b.h.volumePct) - Number(a.h.volumePct));
for (const { e, h } of rows) { const a = e.curve[0], b = e.curve[e.curve.length - 1]; console.log(String(e.index).padEnd(7), String(e.prefab).padEnd(26), `(${Math.round(a.x)},${Math.round(a.z)})->(${Math.round(b.x)},${Math.round(b.z)})`.padEnd(28), `vol ${String(h.volumePct).padStart(3)}% flow ${String(h.flowPct).padStart(3)}% len ${h.length} arms ${h.arms} ${h.class}`); }
console.log('cityFlow', t.cityFlow, 'edges with data', rows.length, 'of', (d.edges ?? []).length);
