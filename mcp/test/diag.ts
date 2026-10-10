// LIVE helper: service-building efficiency and staffing for prefabs matching a pattern (pauses the game).
import { callOk } from '../src/bridge.ts';
const rx = new RegExp(process.argv[2] ?? 'Police', 'i');
const d = await callOk('get_city_diagnostics', {}, 40);
for (const b of d.serviceBuildings ?? []) if (rx.test(b.prefab)) {
  const pen = (d.efficiencyPenalties ?? []).find((p: any) => p.index === b.index)?.penalties ?? [];
  console.log(b.prefab, Math.round(b.position.x), Math.round(b.position.z), 'staff', b.staff, 'penalties', JSON.stringify(pen.map((p: any) => [p.factor, +p.multiplier.toFixed(2)])), JSON.stringify(b.actual ?? {}).slice(0, 200));
}
