import { callOk } from '../src/bridge.ts';
const [x, z, radius] = process.argv.slice(2).map(Number);
const r: any = await callOk('get_network_edges', { x, z, radius }, 30);
for (const e of r.edges ?? []) { if (/voltage|Pipe|Cable|Pedestrian|Path/i.test(e.prefab)) continue; const c = e.curve; const a = c[0], b = c[3]; console.log(e.index, e.prefab.replace(' Road',''), `(${a.x.toFixed(0)},${a.y.toFixed(0)},${a.z.toFixed(0)})->(${b.x.toFixed(0)},${b.y.toFixed(0)},${b.z.toFixed(0)})`); }
