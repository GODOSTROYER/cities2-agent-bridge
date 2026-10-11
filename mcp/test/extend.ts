// LIVE helper: preview/install an extension (service upgrade) on a building.
// An internal extension shares its owner's place AND rotation: pass rotation = the owner's yaw in degrees.
//   node test/extend.ts '<json: {prefab, owner:{index,version}, x, z, rotation?}>' [build]
import { call, waitOperation } from '../src/bridge.ts';
import { prefab } from '../src/city.ts';
const a = JSON.parse(process.argv[2]); const build = process.argv[3] === 'build';
const p = await prefab(a.prefab, 'all'); if (!p.found) { console.log('NOT FOUND', JSON.stringify(p.similar ?? []).slice(0, 300)); process.exit(0); }
const op = await call('place_building', { prefabIndex: p.index, prefabVersion: p.version, position: { x: a.x, z: a.z }, rotation: a.rotation ?? 0, maxCost: a.maxCost ?? 400000, upgradeOf: a.owner, maxSnapDistance: 128, ...(build ? {} : { previewOnly: true }) }, 15);
if (!op.ok) { console.log('REFUSED', JSON.stringify(op.error).slice(0, 300)); process.exit(0); }
const done = await waitOperation(op.result.id, 60);
console.log(JSON.stringify({ status: done.status, error: done.error, cost: done.previewCost, at: done.snappedPosition, installed: done.installedUpgrades, reasons: [...new Set((done.placementErrors ?? []).flatMap((e: any) => e.reasons ?? []))] }).slice(0, 600));
