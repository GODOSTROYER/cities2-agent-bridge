// LIVE helper, READ ONLY: what it would cost to own every tile of the map, by the game's own formula (mod command
// tile_prices, which reads MapTilePurchaseSystem's data and selects or buys nothing).
//   node test/tileprices.ts            summary
//   node test/tileprices.ts map        also a map of the tiles: O owned, digits = base price decile of unowned tiles (0 cheap .. 9 dear)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { callOk } from '../src/bridge.ts';
const r = await callOk('tile_prices', {}, 40);
const tiles: any[] = r.tiles; const { tiles: _t, ...head } = r;
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'journals', 'tile-prices.json'), JSON.stringify(r));
console.log(JSON.stringify(head));
const un = tiles.filter(t => !t.owned).sort((a, b) => a.base - b.base); const names = ['area', 'buildable', 'fertile', 'forest', 'oil', 'ore', 'surfaceWater', 'groundWater', 'fish'];
const sum = (v: any[], i: number) => Math.round(v.reduce((s, t) => s + (t.features[i] ?? 0), 0));
console.log('feature totals, owned:', JSON.stringify(Object.fromEntries(names.map((n, i) => [n, sum(tiles.filter(t => t.owned), i)]))));
console.log('feature totals, unowned:', JSON.stringify(Object.fromEntries(names.map((n, i) => [n, sum(un, i)]))));
if (un.length) console.log(`unowned base price: cheapest ${un[0].base} at (${un[0].x},${un[0].z}), median ${un[Math.floor(un.length / 2)].base}, dearest ${un[un.length - 1].base} at (${un[un.length - 1].x},${un[un.length - 1].z})`);
// Buildable share of each unowned tile (feature 1 over feature 0) says which tiles are land and which are water or mountain.
const share = (t: any) => t.features[0] > 0 ? t.features[1] / t.features[0] : 0; const band = (lo: number, hi: number) => un.filter(t => share(t) >= lo && share(t) < hi);
for (const [lo, hi, label] of [[0.6, 9, 'mostly buildable (60%+)'], [0.25, 0.6, 'partly buildable (25-60%)'], [0, 0.25, 'water, slope or forest (under 25% buildable)']] as [number, number, string][]) { const b = band(lo, hi); console.log(`${label}: ${b.length} tiles, base ${Math.round(b.reduce((s, t) => s + t.base, 0))}`); }
if (process.argv[2] === 'map') { const xs = [...new Set(tiles.map(t => t.x))].sort((a, b) => a - b), zs = [...new Set(tiles.map(t => t.z))].sort((a, b) => a - b); const dec = (t: any) => Math.min(9, Math.floor(10 * un.indexOf(t) / un.length));
  console.log(`x ${xs[0]} .. ${xs[xs.length - 1]} (left to right), z ${zs[0]} .. ${zs[zs.length - 1]} (top to bottom)`);
  for (const z of zs) console.log(xs.map(x => { const t = tiles.find(u => u.x === x && u.z === z); return !t ? ' ' : t.owned ? 'O' : String(dec(t)); }).join('')); }
