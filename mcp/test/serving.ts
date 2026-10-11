// LIVE helper (read only): is a service building open and serving? Students, patients, staff and shortages of every
// service building near a point, from the game's own buffers (get_city_diagnostics).
//   node test/serving.ts <x> <z> [radius=60] [prefab filter]
import { callOk } from '../src/bridge.ts';
const [x, z] = process.argv.slice(2, 4).map(Number); const r = Number(process.argv[4] ?? 60); const filter = process.argv[5] ?? '';
const d = await callOk('get_city_diagnostics', {}, 90);
const rows: any[] = []; const walk = (v: any) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') { if (v.prefab && v.position && ('students' in v || 'staff' in v)) rows.push(v); else Object.values(v).forEach(walk); } }; walk(d);
const short = new Map<string, string>(); for (const s of d.shortages ?? []) short.set(`${s.index}`, JSON.stringify(s.shortages));
for (const o of rows) { if (Math.hypot(o.position.x - x, o.position.z - z) > r || !o.prefab.includes(filter)) continue;
  console.log(o.prefab, `(${Math.round(o.position.x)},${Math.round(o.position.z)})`, 'students', o.students ?? '-', 'patients', o.patients ?? '-', 'staff', o.staff ?? '-', short.get(`${o.index}`) ?? '', JSON.stringify(o.actual ?? {}).slice(0, 260)); }
