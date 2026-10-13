// LIVE helper: zone a rectangle with one zone type (the mod's zone_rectangle; cells must lie on blocks along roads).
//   node test/zonerect.ts <zoneKey> <x0> <z0> <x1> <z1> [build]
// zoneKey is a key of ZONES in src/city.ts (res, resmed, resmid, reshigh, mixed, com, comhigh, off, offhigh, ind ...);
// run with no arguments to list the keys. Without "build" it only prints what would be zoned.
// The rectangle may be at most 480 m corner to corner (the mod refuses 500 m and more): zone a block at a time.
// Keep the box inside the block: it zones every free cell in the box, so a box that reaches a waterfront strip zones it too.
import { call, callOk, waitOperation } from '../src/bridge.ts';
import { prefab, ZONES } from '../src/city.ts';
const key = process.argv[2]; const nums = process.argv.slice(3, 7).map(Number); const build = process.argv[7] === 'build';
if (!key || nums.length < 4 || nums.some(n => !Number.isFinite(n))) { console.log('usage: node test/zonerect.ts <zoneKey> <x0> <z0> <x1> <z1> [build]\nkeys: ' + Object.entries(ZONES).map(([k, v]) => `${k}=${v}`).join(', ')); process.exit(0); }
const [x0, z0, x1, z1] = [Math.min(nums[0], nums[2]), Math.min(nums[1], nums[3]), Math.max(nums[0], nums[2]), Math.max(nums[1], nums[3])];
if (Math.hypot(x1 - x0, z1 - z0) > 480) { console.log('refused: rectangle larger than 480 m corner to corner; zone a block at a time'); process.exit(0); }
const zoneName = ZONES[key] ?? key; // a key of ZONES, or a full zone prefab name in quotes (for example "EU Commercial High")
const zone = await prefab(zoneName, 'zone');
if (!zone.found || zone.locked) { console.log(`refused: zone ${zoneName} not found or locked`); process.exit(0); }
console.log(`${build ? 'zoning' : 'would zone'} ${zoneName} in ${x0},${z0} to ${x1},${z1} (${Math.round(x1 - x0)} x ${Math.round(z1 - z0)} m)`);
if (!build) { console.log('not built (add "build" to run)'); process.exit(0); }
const args = { prefabIndex: zone.index, prefabVersion: zone.version, start: { x: x0, z: z0 }, end: { x: x1, z: z1 } };
for (let t = 0; t < 10; t++) {
  const o = await call('zone_rectangle', args, 15);
  if (!o.ok) { const e = JSON.stringify(o.error); if (/busy|finish_or_cancel|batch_in_progress/.test(e)) { await new Promise(r => setTimeout(r, 3000)); continue; } console.log('REFUSED', e.slice(0, 300)); process.exit(0); }
  const d = await waitOperation(o.result.id, 60); console.log(JSON.stringify(d).slice(0, 400)); break;
}
