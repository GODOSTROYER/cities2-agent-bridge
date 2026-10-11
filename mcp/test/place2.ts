// LIVE helper: raw place_building preview/build with a chosen budget cap.
//   node test/place2.ts '<json: {prefab, x, z, rotation, maxCost?}>' [build]
import { call, waitOperation } from '../src/bridge.ts';
import { prefab } from '../src/city.ts';
const a = JSON.parse(process.argv[2]); const build = process.argv[3] === 'build';
const p = await prefab(a.prefab, 'building');
const op = await call('place_building', { prefabIndex: p.index, prefabVersion: p.version, position: { x: a.x, z: a.z }, rotation: a.rotation ?? 0, maxCost: a.maxCost ?? 1000000, ...(build ? {} : { previewOnly: true }) }, 15);
if (!op.ok) { console.log('REFUSED', JSON.stringify(op.error)); process.exit(0); }
const done = await waitOperation(op.result.id, 60);
console.log(JSON.stringify({ status: done.status, error: done.error, cost: done.previewCost, at: done.snappedPosition, rot: done.snappedRotation, errors: (done.placementErrors ?? []).slice(0, 6) }).slice(0, 1500));
