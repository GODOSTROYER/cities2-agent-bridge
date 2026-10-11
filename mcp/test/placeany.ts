// LIVE helper: preview/build any placeable prefab (roundabout objects, intersection stamps) at a point.
//   node test/placeany.ts '<json: {prefab, x, z, rotation?}>' [build]
import { call, waitOperation } from '../src/bridge.ts';
import { prefab } from '../src/city.ts';
const a = JSON.parse(process.argv[2]); const build = process.argv[3] === 'build';
const p = await prefab(a.prefab, 'all'); if (!p.found) { console.log('NOT FOUND', JSON.stringify(p.similar ?? []).slice(0, 300)); process.exit(0); }
const op = await call('place_building', { prefabIndex: p.index, prefabVersion: p.version, position: { x: a.x, z: a.z }, rotation: a.rotation ?? 0, maxCost: 100000, object: true, ...(a.index ? { position: { x: a.x, z: a.z, index: a.index, version: a.version } } : {}), ...(build ? {} : { previewOnly: true }) }, 15);
if (!op.ok) { console.log('REFUSED', JSON.stringify(op.error).slice(0, 300)); process.exit(0); }
const done = await waitOperation(op.result.id, 60);
console.log(JSON.stringify({ status: done.status, error: done.error, cost: done.previewCost, at: done.snappedPosition, reasons: [...new Set((done.placementErrors ?? []).flatMap((e: any) => e.reasons ?? []))] }).slice(0, 500));
