// LIVE helper: one raw build_road call (preview by default). Usage:
//   node test/road.ts '<json args without prefab>' [build]
// args: { road?: 'Small Road', start:{x,z,index?,version?,curvePosition?}, end:{...}, elevation?, control?, mode? }
import { callOk, call, waitOperation } from '../src/bridge.ts';
import { prefab } from '../src/city.ts';
const a = JSON.parse(process.argv[2]); const build = process.argv[3] === 'build';
const p = await prefab(a.road ?? 'Small Road', 'network');
const args: any = { prefabIndex: p.index, prefabVersion: p.version, start: a.start, end: a.end, maxCost: 60000, ...(a.elevation !== undefined ? { elevation: a.elevation } : {}), ...(a.startElevation !== undefined ? { startElevation: a.startElevation } : {}), ...(a.endElevation !== undefined ? { endElevation: a.endElevation } : {}), ...(a.control ? { control: a.control, mode: 'curve' } : {}), ...(build ? {} : { previewOnly: true }) };
const op = await call('build_road', args, 15);
if (!op.ok) { console.log('REFUSED', op.error); process.exit(0); }
const done = await waitOperation(op.result.id, 60);
console.log(JSON.stringify({ status: done.status, error: done.error, cost: done.previewCost, reasons: [...new Set((done.placementErrors ?? []).flatMap((e: any) => e.reasons ?? []))], created: (done.createdRoads ?? []).length, blockers: (done.placementErrors ?? []).filter((e: any) => e.position).map((e: any) => ({ index: e.index, x: Math.round(e.position.x), z: Math.round(e.position.z) })) }));
// blockers = the objects in the way (look them up with get_buildings {x,z,radius}); an OverlapExisting is usually a building, not an underground track.
