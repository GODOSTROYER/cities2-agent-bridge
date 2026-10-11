// LIVE helper (read only): compact list of the buildings and road edges around a point.
//   node test/area.ts <x> <z> <radius>
import { callOk } from '../src/bridge.ts';
const [x, z, radius] = process.argv.slice(2).map(Number);
const b = (await callOk('get_buildings', { x, z, radius, limit: 200, fields: ['index', 'version', 'prefab', 'position', 'roadEdge'] }, 30)).buildings ?? [];
for (const o of b) console.log('B', o.index, o.version, o.prefab, Math.round(o.position.x), Math.round(o.position.z), 'road', o.roadEdge?.index ?? '-');
const e = (await callOk('get_network_edges', { x, z, radius }, 30)).edges ?? [];
for (const o of e) { const c = o.curve; console.log('E', o.index, o.version, o.prefab, `(${Math.round(c[0].x)},${Math.round(c[0].z)})->(${Math.round(c[c.length - 1].x)},${Math.round(c[c.length - 1].z)})`, 'y', Math.round(c[0].y), Math.round(c[c.length - 1].y)); }
