// LIVE helper (read-only): highway edges near points with direction and flow ratio per direction bucket.
//   node test/hw.ts "x,z,r" "x,z,r" ...
import { callOk } from '../src/bridge.ts';
for (const a of process.argv.slice(2)) {
  const [x, z, r] = a.split(',').map(Number); const d = await callOk('get_network_edges', { x, z, radius: r }, 30);
  for (const e of d.edges ?? []) { if (!e.trafficDistanceRaw?.length) continue; const s = e.curve[0], t = e.curve[e.curve.length - 1]; const di = e.trafficDistanceRaw, du = e.trafficDurationRaw; const f = (i: number) => du[i] > 0 ? (di[i] / du[i]).toFixed(2) : '-';
    console.log(String(e.index).padEnd(8), String(e.prefab).padEnd(25), `(${Math.round(s.x)},${Math.round(s.z)})->(${Math.round(t.x)},${Math.round(t.z)})`.padEnd(30), 'len', String(Math.round(e.length)).padStart(4), 'dist', di.slice(0, 4).map((v: number) => Math.round(v)).join('/'), 'ratio', [0, 1, 2, 3].map(f).join('/')); }
}
