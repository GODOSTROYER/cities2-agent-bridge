// LIVE helper: where are zonable cells that carry no zone (a grid left unzoned by the utility postcondition)?
import { callOk } from '../src/bridge.ts';
const tiles = await callOk('get_tiles', {}, 20); const owned = (tiles.tiles ?? tiles.owned ?? []).filter((t: any) => t.owned !== false);
const xs = owned.flatMap((t: any) => [t.x0 ?? t.bounds?.[0], t.x1 ?? t.bounds?.[2]]).filter(Number.isFinite), zs = owned.flatMap((t: any) => [t.z0 ?? t.bounds?.[1], t.z1 ?? t.bounds?.[3]]).filter(Number.isFinite);
const [x0, x1, z0, z1] = xs.length ? [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)] : [-2200, 1600, -2900, 2100];
const step = 400; const hits: any[] = [];
for (let x = x0; x < x1; x += step) for (let z = z0; z < z1; z += step) {
  const c = await callOk('zone_area_count', { x0: x, z0: z, x1: x + step, z1: z + step }, 15);
  if (Number(c.zonable) >= 40) hits.push({ x: x + step / 2, z: z + step / 2, zonable: c.zonable });
}
console.log(JSON.stringify({ bounds: [x0, z0, x1, z1], hits }));
