// LIVE helper: scan a rectangle for positions where a shoreline building (water pump) can be placed; builds up to N and reports road state.
//   node test/shore.ts <prefab> <x0> <z0> <x1> <z1> <step> <rotation> <count>
import { call, callOk, waitOperation } from '../src/bridge.ts';
import { prefab } from '../src/city.ts';
const [name, x0, z0, x1, z1, step, rot, count] = [process.argv[2], ...process.argv.slice(3).map(Number)] as [string, number, number, number, number, number, number, number];
const p = await prefab(name, 'building'); const built: any[] = []; let tried = 0;
for (let z = z0; z <= z1 && built.length < count; z += step) for (let x = x0; x <= x1 && built.length < count; x += step) {
  if (built.some(b => Math.hypot(b.x - x, b.z - z) < 40)) continue;
  const args = { prefabIndex: p.index, prefabVersion: p.version, position: { x, z }, rotation: rot, maxCost: 100000 };
  const pv = await call('place_building', { ...args, previewOnly: true }, 15); tried++;
  if (!pv.ok) continue; const d = await waitOperation(pv.result.id, 30); if (d.status !== 'complete') continue;
  const op = await call('place_building', args, 15); if (!op.ok) continue; const done = await waitOperation(op.result.id, 60);
  if (done.status === 'complete') built.push({ x: Math.round(done.snappedPosition?.x ?? x), z: Math.round(done.snappedPosition?.z ?? z) });
}
console.log(JSON.stringify({ tried, built }));
