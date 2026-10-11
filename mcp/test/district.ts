// LIVE helper (read only): the problem icons inside a rectangle (one district), exact counts by type.
//   node test/district.ts <x0> <x1> <z0> <z1>
import { callOk } from '../src/bridge.ts';
const [x0, x1, z0, z1] = process.argv.slice(2, 6).map(Number);
const d = await callOk('notifications', { x0, x1, z0, z1, top: 1 }, 30); const city = await callOk('notifications', { top: 1 }, 30);
const pick = (c: Record<string, number>) => ({ garbage: c['Garbage Notification'] ?? 0, hearse: c['Hearse Notification'] ?? 0, total: Object.values(c).reduce((a, b) => a + Number(b), 0) });
console.log(JSON.stringify({ utc: new Date().toISOString().slice(11, 16), area: [x0, x1, z0, z1], district: pick(d.counts ?? {}), city: pick(city.counts ?? {}), other: Object.fromEntries(Object.entries(d.counts ?? {}).filter(([k]) => !/Garbage|Hearse/.test(k))) }));
