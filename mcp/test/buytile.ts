// Offline checks for tileAt, the point-to-tile helper behind buy_tile exact:true. Fixture tiles are
// squares of get_tiles entries ({index, version, purchased, polygon}); nothing here calls the bridge.
// src/city.ts is imported after fs and fetch are replaced with spies that refuse any I/O.
import { promises as fsp } from 'node:fs';

const ioCalls: string[] = [];
const fsNames = ['readFile', 'writeFile', 'appendFile', 'readdir', 'stat', 'lstat', 'mkdir', 'rm', 'rename', 'unlink', 'open', 'access', 'copyFile'];
const fsObj = fsp as unknown as Record<string, unknown>;
for (const n of fsNames) fsObj[n] = async () => { ioCalls.push(`fs.promises.${n}`); throw new Error(`io during import: fs.promises.${n}`); };
globalThis.fetch = (async () => { ioCalls.push('fetch'); throw new Error('io during import: fetch'); }) as typeof fetch;

const { tileAt } = await import('../src/city.ts');
let failed = 0; const check = (ok: boolean, label: string) => { console.log((ok ? 'PASS: ' : 'FAIL: ') + label); if (!ok) failed++; };

const square = (x0: number, z0: number, x1: number, z1: number) => [
  { x: x0, y: 0, z: z0 }, { x: x1, y: 0, z: z0 }, { x: x1, y: 0, z: z1 }, { x: x0, y: 0, z: z1 },
];
const tile = (index: number, purchased: boolean, x0: number, z0: number, x1: number, z1: number) => ({ index, version: 1, purchased, polygon: square(x0, z0, x1, z1) });
const A = tile(1, false, 0, 0, 100, 100);      // unowned, centre (50,50)
const B = tile(2, true, 100, 0, 200, 100);     // owned, east of A
const C = tile(3, false, 0, 100, 100, 200);    // unowned, north of A, centre (50,150)
const D = tile(4, false, 500, 500, 600, 600);  // unowned, far away
const E = tile(5, true, 300, 0, 400, 100);     // owned, leaves a gap at x 200..300
const tiles = [A, B, C, D, E];

const hit = (p: ReturnType<typeof tileAt>) => p ? `${p.tile.index}/${p.by}` : 'null';

const inside = tileAt(tiles, 50, 50);
check(inside?.tile.index === 1 && inside.by === 'contains' && inside.distance === 0, 'a point inside an unowned tile returns that tile: ' + hit(inside));
const ownedInside = tileAt(tiles, 350, 50);
check(ownedInside?.tile.index === 5 && ownedInside.tile.purchased === true && ownedInside.by === 'contains', 'a point inside an owned tile returns the owned tile (the caller refuses it): ' + hit(ownedInside));
const edgeOwned = tileAt(tiles, 100, 50);
check(edgeOwned?.tile.index === 1 && edgeOwned.by === 'contains', 'on the shared edge of an owned and an unowned tile the unowned one is chosen: ' + hit(edgeOwned));
const edgeFree = tileAt(tiles, 50, 100);
check(edgeFree?.by === 'contains' && (edgeFree.tile.index === 1 || edgeFree.tile.index === 3), 'on the shared edge of two unowned tiles one of them is chosen (tie by centre distance): ' + hit(edgeFree));
const corner = tileAt(tiles, 100, 100);
check(corner?.by === 'contains' && corner.tile.purchased === false, 'a corner shared by an owned tile and unowned tiles picks an unowned one: ' + hit(corner));
const gap = tileAt(tiles, 250, 50);
check(gap?.tile.index === 1 && gap.by === 'nearest' && Math.abs(gap.distance - 200) < 1e-6, 'a point in a gap between owned tiles takes the nearest unowned centre (A at 200 m), owned centres ignored: ' + hit(gap));
const near = tileAt(tiles, 250, 250);
check(near?.tile.index === 3 && near.by === 'nearest' && Math.abs(near.distance - Math.hypot(200, 100)) < 1e-6, 'nearest-centre fallback: a point outside every tile takes the nearest unowned tile within 320 m: ' + hit(near));
check(tileAt(tiles, 1000, 1000) === null, 'a point outside every tile and farther than 320 m from any unowned centre finds nothing');
check(tileAt(tiles, 240, 60, 10) === null, 'the fallback radius is honoured (a 10 m radius refuses a gap point 200 m from the centre)');
check(tileAt([E], 350, 50) !== null && tileAt([E], 250, 50) === null, 'with only owned tiles the owned one is still reported when it contains the point, but nothing is nearest-chosen');
check(tileAt([{ index: 9, purchased: false }, A], 50, 50)?.tile.index === 1, 'entries without a polygon are ignored');
check(tileAt([], 0, 0) === null, 'no tiles, no tile');
check(ioCalls.length === 0, 'no I/O happened while importing city.ts' + (ioCalls.length ? ': ' + ioCalls.join(',') : ''));
process.exit(failed ? 1 : 0);
