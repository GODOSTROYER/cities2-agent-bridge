// LIVE helper: one raw place_building / relocate_building preview or build with full error detail.
//   node test/place.ts '<json: {prefab, x, z, rotation, moveIndex?, moveVersion?}>' [build]
import { callOk, call, waitOperation } from '../src/bridge.ts';
import { prefab } from '../src/city.ts';
const a = JSON.parse(process.argv[2]); const build = process.argv[3] === 'build';
const p = await prefab(a.prefab, 'building');
const args: any = { prefabIndex: p.index, prefabVersion: p.version, position: { x: a.x, z: a.z }, rotation: a.rotation ?? 0, maxCost: 200000, ...(a.moveIndex ? { moveIndex: a.moveIndex, moveVersion: a.moveVersion } : {}), ...(build ? {} : { previewOnly: true }) };
const op = await call(a.moveIndex ? 'relocate_building' : 'place_building', args, 15);
if (!op.ok) { console.log('REFUSED', JSON.stringify(op.error)); process.exit(0); }
const done = await waitOperation(op.result.id, 60);
console.log(JSON.stringify({ status: done.status, error: done.error, cost: done.previewCost, at: done.snappedPosition, errors: (done.placementErrors ?? []).slice(0, 6) }).slice(0, 1500));
