// LIVE helper: removes zoning from a small rectangle, so cleared lots do not regrow buildings.
//   node test/dezone.ts <x0> <z0> <x1> <z1> [build] [force]
// Dry run by default (nothing is built): prints the zone cells in the box (total, zoned, by zone code), the
// zone_area_count reading, the zoned buildings standing in the box and what would be cleared.
// build: runs clear_zoning (the mod's zone tool in dezone mode, same arguments as zone_rectangle: a zone prefab,
// start and end points; the diagonal must be under 500 m) and waits for the operation, then prints the cell counts after.
// Refused: any side over 200 m; any zoned building inside the box unless the 6th argument "force" is given.
import { call, callOk, waitOperation } from '../src/bridge.ts';
import { prefab, ZONES } from '../src/city.ts';
const nums = process.argv.slice(2, 6).map(Number);
if (nums.length < 4 || nums.some(n => !Number.isFinite(n))) { console.log('usage: node test/dezone.ts <x0> <z0> <x1> <z1> [build] [force]'); process.exit(1); }
const build = process.argv[6] === 'build' || process.argv[7] === 'build';
const force = process.argv[6] === 'force' || process.argv[7] === 'force';
const [x0, x1] = [Math.min(nums[0], nums[2]), Math.max(nums[0], nums[2])]; const [z0, z1] = [Math.min(nums[1], nums[3]), Math.max(nums[1], nums[3])];
const side = Math.max(x1 - x0, z1 - z0);
if (side > 200) { console.log(`refused: side ${Math.round(side)} m is over 200 m; split the box`); process.exit(0); }
const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, r = Math.hypot(x1 - x0, z1 - z0) / 2 + 10;
const inBox = (x: number, z: number) => x >= x0 && x <= x1 && z >= z0 && z <= z1;
const wait = (ms: number) => new Promise(res => setTimeout(res, ms));

// Zone cells in the box, by zone code (the cell's zone index; 0 = unzoned). Paged; the box is read through a circle around it.
async function cellCounts(): Promise<{ total: number; zoned: number; byZone: Record<string, number> }> {
  const byZone: Record<string, number> = {}; let total = 0, zoned = 0;
  for (let offset = 0; ;) {
    const p = await callOk('get_zone_cells', { x: cx, z: cz, radius: r, limit: 8192, offset }, 60);
    for (const c of p.cells ?? []) { if (!inBox(c.position.x, c.position.z)) continue; total++; const code = String(c.zone); byZone[code] = (byZone[code] ?? 0) + 1; if (Number(c.zone) !== 0) zoned++; }
    if (!p.truncated || p.nextOffset == null) break; offset = p.nextOffset;
  }
  return { total, zoned, byZone };
}
const zonable = async () => Number((await callOk('zone_area_count', { x0, z0, x1, z1, margin: 0 }, 20)).zonable);

// Zoned buildings in the box: the same prefab-name test block.ts uses (residential, commercial, office, industrial, mixed).
const zonedBuildings: any[] = [];
for (let offset = 0; ;) {
  const p = await callOk('get_buildings', { x: cx, z: cz, radius: r, limit: 2000, offset, fields: ['index', 'version', 'prefab', 'position'] }, 60);
  for (const o of p.buildings ?? []) if (inBox(o.position.x, o.position.z) && /(Residential|Commercial|Office|Industrial|Mixed)/.test(o.prefab)) zonedBuildings.push(o);
  if (!p.truncated || p.nextOffset == null) break; offset = p.nextOffset;
}

const before = await cellCounts(); const zb = await zonable();
console.log(`box ${Math.round(x0)},${Math.round(z0)} to ${Math.round(x1)},${Math.round(z1)} (${Math.round(x1 - x0)} x ${Math.round(z1 - z0)} m): zone cells ${before.total}, zoned ${before.zoned}, by zone code ${JSON.stringify(before.byZone)}; zone_area_count zonable ${zb}`);
console.log(`zoned buildings in the box: ${zonedBuildings.length}${zonedBuildings.slice(0, 20).map(o => `\n  B ${o.index} ${o.version} ${o.prefab} (${Math.round(o.position.x)},${Math.round(o.position.z)})`).join('')}`);
if (zonedBuildings.length && !force) { console.log(`refused: ${zonedBuildings.length} zoned building(s) stand in the box; clearing would leave them without zoning. Add "force" as the 6th argument to clear anyway.`); process.exit(0); }
if (!before.zoned) { console.log('nothing zoned in the box: nothing to clear'); process.exit(0); }
if (!build) { console.log(`would clear zoning on ${before.zoned} zoned cell(s); not built (add "build" to run)`); process.exit(0); }

const zone = await prefab(ZONES.res, 'zone');
if (!zone.found || zone.locked) { console.log('refused: zone prefab not found or locked'); process.exit(0); }
const args = { prefabIndex: zone.index, prefabVersion: zone.version, start: { x: x0, z: z0 }, end: { x: x1, z: z1 } };
let op: any = { status: 'failed', error: 'busy' };
for (let t = 0; t < 10; t++) {
  const o = await call('clear_zoning', args, 15);
  if (!o.ok) { const e = JSON.stringify(o.error); if (/busy|finish_or_cancel|batch_in_progress/.test(e)) { await wait(3000); continue; } op = { status: 'refused', error: e }; break; }
  op = await waitOperation(o.result.id, 120); break;
}
const after = await cellCounts(); const za = await zonable();
console.log(JSON.stringify({ cleared: op.status, error: op.error ?? null, zonedBefore: before.zoned, zonedAfter: after.zoned, zonableBefore: zb, zonableAfter: za }));
