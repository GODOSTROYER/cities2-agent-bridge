// LIVE helper: road edges near a point with native traffic flow (non-pausing reads only where possible).
import { callOk } from '../src/bridge.ts';
const [x, z, r] = process.argv.slice(2).map(Number);
const hot = new Map<number, number>(((await callOk('traffic_hotspots', { top: 30, minLength: 5 }, 15)).hotspots ?? []).map((h: any) => [h.index, h.flowPct]));
const d = await callOk('get_network_edges', { x, z, radius: r }, 30);
for (const e of d.edges ?? []) { const a = e.curve[0], b = e.curve[e.curve.length - 1]; console.log(e.index, e.version, String(e.prefab).padEnd(26), `(${Math.round(a.x)},${Math.round(a.z)})->(${Math.round(b.x)},${Math.round(b.z)})`, hot.has(e.index) ? `flow ${hot.get(e.index)}%` : ''); }
