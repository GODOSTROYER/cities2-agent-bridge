// LIVE helper: every highway edge with its traffic flow, bucketed on a 300 m grid (diagnosis of highway congestion).
import { callOk } from '../src/bridge.ts';
const hot = new Map<number, number>(((await callOk('traffic_hotspots', { top: 30, minLength: 5 }, 15)).hotspots ?? []).map((h: any) => [h.index, h.flowPct]));
const all: any[] = []; for (const [x, z] of [[-1200, -1800], [-1200, 0], [-1200, 1500], [300, -1800], [300, 0], [300, 1500], [1500, 0]]) { const d = await callOk('get_network_edges', { x, z, radius: 1500 }, 60); for (const e of d.edges ?? []) if (/Highway/.test(String(e.prefab))) all.push(e); }
const seen = new Set<number>(); const cells = new Map<string, { n: number; lanes: Set<string>; jam: number[] }>();
for (const e of all) { if (seen.has(e.index)) continue; seen.add(e.index); const a = e.curve[0], b = e.curve[e.curve.length - 1]; const k = `${Math.round((a.x + b.x) / 600) * 300},${Math.round((a.z + b.z) / 600) * 300}`; const c = cells.get(k) ?? { n: 0, lanes: new Set<string>(), jam: [] }; c.n++; c.lanes.add(String(e.prefab).replace('Highway Oneway - ', '')); if (hot.has(e.index)) c.jam.push(hot.get(e.index)!); cells.set(k, c); }
console.log('highway edges', seen.size);
for (const [k, c] of [...cells.entries()].sort()) console.log(k.padEnd(12), String(c.n).padStart(3), [...c.lanes].join('/'), c.jam.length ? 'JAM flow% ' + c.jam.join(',') : '');
