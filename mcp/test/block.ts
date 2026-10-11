// LIVE helper (read only): what stands in a box: every building that is not a zoned one (services, parks, signature
// buildings) with its rotation, the count of zoned buildings by kind, and the road edges with type and ends.
//   node test/block.ts <x0> <x1> <z0> <z1> [roads]
import { callOk } from '../src/bridge.ts';
const [x0, x1, z0, z1] = process.argv.slice(2, 6).map(Number); const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, r = Math.hypot(x1 - x0, z1 - z0) / 2 + 10;
const inBox = (x: number, z: number) => x >= x0 && x <= x1 && z >= z0 && z <= z1; const zoned: Record<string, number> = {};
for (let offset = 0; ; ) { const p = await callOk('get_buildings', { x: cx, z: cz, radius: r, limit: 2000, offset, fields: ['index', 'version', 'prefab', 'position', 'rotation', 'roadEdge'] }, 60); const rows = p.buildings ?? [];
  for (const o of rows) { if (!inBox(o.position.x, o.position.z)) continue; const m = /(Residential|Commercial|Office|Industrial|Mixed)[A-Za-z]*/.exec(o.prefab); if (m) { zoned[m[0]] = (zoned[m[0]] ?? 0) + 1; continue; } console.log('B', o.index, o.version, o.prefab, Math.round(o.position.x), Math.round(o.position.z), 'road', o.roadEdge?.index ?? '-'); }
  if (!p.truncated || p.nextOffset == null) break; offset = p.nextOffset; }
console.log('zoned:', JSON.stringify(zoned));
if (process.argv[6] === 'roads') for (const o of (await callOk('get_network_edges', { x: cx, z: cz, radius: Math.min(r, 990) }, 40)).edges ?? []) { const c = o.curve, a = c[0], b = c[c.length - 1]; if (!inBox((a.x + b.x) / 2, (a.z + b.z) / 2) || /Pipe|Power|Cable|Sewage|Water|Pathway/.test(o.prefab)) continue; console.log('E', o.index, o.version, o.prefab, `(${Math.round(a.x)},${Math.round(a.z)})->(${Math.round(b.x)},${Math.round(b.z)})`, 'len', Math.round(o.length), 'y', Math.round(a.y), Math.round(b.y), 'n', o.start?.index ?? '', o.end?.index ?? ''); }
