// LIVE helper (read-only): where vehicle time is lost. Edges ranked by delay (or volume / flow), citywide or in an area.
//   node test/tr.ts [by=delay|volume|flow] [top=30] [x z radius]
import { callOk } from '../src/bridge.ts';
const [by = 'delay', top = '30', x, z, r] = process.argv.slice(2);
const t = await callOk('traffic_hotspots', { top: Number(top), minLength: 0, by, ...(x !== undefined ? { x: Number(x), z: Number(z), radius: Number(r ?? 500) } : {}) }, 30);
for (const h of t.hotspots ?? []) console.log(String(h.index).padEnd(8), String(h.prefab).padEnd(26), `(${h.x},${h.z})`.padEnd(16), `delay ${String(h.delayPct).padStart(5)}%  vol ${String(h.volumePct).padStart(3)}%  flow ${String(h.flowPct).padStart(3)}%  len ${String(h.length).padStart(4)}  arms ${h.arms}  ${h.class}`);
console.log('cityFlow', t.cityFlow, 'flowByVolume', t.flowByVolumePct, 'edges', t.edges, 'noData', t.noData, JSON.stringify(t.classes));
