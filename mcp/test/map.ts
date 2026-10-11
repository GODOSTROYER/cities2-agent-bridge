// LIVE helper (read only): character map of an area: water, homes by density, garbage/hearse icons.
//   node test/map.ts <x0> <x1> <z0> <z1> [step]      (z printed north at the top)
// ~ water, H high/medium-density home, l low-density home, o other building, . empty; a digit replaces
// the letter where garbage or hearse icons stand (count, 9 = nine or more).
import { callOk } from '../src/bridge.ts';
const [x0, x1, z0, z1] = process.argv.slice(2, 6).map(Number); let step = Number(process.argv[6] ?? 50);
while (((x1 - x0) / step + 1) * ((z1 - z0) / step + 1) > 1024) step += 10;
const xs: number[] = [], zs: number[] = []; for (let x = x0; x <= x1; x += step) xs.push(x); for (let z = z1; z >= z0; z -= step) zs.push(z);
const points = zs.flatMap(z => xs.map(x => ({ x, z })));
const samples: any[] = []; for (let i = 0; i < points.length; i += 400) { const t = await callOk('sample_terrain', { points: points.slice(i, i + 400) }, 40); samples.push(...(t.samples ?? t.points ?? [])); }
const wet = (s: any) => Number(s?.waterDepth ?? s?.water?.depth ?? s?.depth ?? 0) > 0.5;
const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, r = Math.hypot(x1 - x0, z1 - z0) / 2 + step;
const cell = (x: number, z: number) => `${Math.round((x - x0) / step)},${Math.round((z1 - z) / step)}`;
const kind = new Map<string, string>(); let offset = 0;
for (;;) { const b = await callOk('get_buildings', { x: cx, z: cz, radius: r, limit: 500, offset, fields: ['prefab', 'position'] }, 40); for (const o of b.buildings ?? []) { const k = cell(o.position.x, o.position.z); const c = /Residential(High|Medium)|MixedUse|LowRent/i.test(o.prefab) ? 'H' : /Residential/i.test(o.prefab) ? 'l' : 'o'; if (c === 'H' || !kind.has(k) || (c === 'l' && kind.get(k) === 'o')) kind.set(k, c); } if (b.nextOffset == null) break; offset = b.nextOffset; }
const icons = new Map<string, number>();
for (const type of ['Garbage Notification', 'Hearse Notification']) { const d = await callOk('notifications', { type, top: 100 }, 30); for (const i of d.items ?? []) { if (i.type !== type) continue; const k = cell(i.x, i.z); icons.set(k, (icons.get(k) ?? 0) + 1); } }
console.log(`x ${x0}..${x1} step ${step}; rows from z ${z1} (north, top) to ${z0}; sample keys: ${Object.keys(samples[0] ?? {}).join(',')}`);
zs.forEach((z, j) => console.log(String(z).padStart(6) + ' ' + xs.map((x, i) => { const k = `${i},${j}`; const n = icons.get(k); if (n) return String(Math.min(9, n)); if (wet(samples[j * xs.length + i])) return '~'; return kind.get(k) ?? '.'; }).join('')));
