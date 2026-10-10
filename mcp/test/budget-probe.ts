// LIVE: marginal monthly cost of each service budget (cost per budget point), measured by
// lowering each budget 10 points, reading ServiceUpkeep, and restoring it.
import { callOk } from '../src/bridge.ts';
const upkeep = async () => Number((await callOk('get_city_management', {}, 20)).budget.expenseBySourceRaw.ServiceUpkeep);
const services = (await callOk('get_services', {}, 20)).services;
const base = await upkeep(); const rows: string[] = [];
for (const s of services) {
  const probe = Math.max(50, s.budget - 10); if (probe === s.budget) continue;
  await callOk('set_service_budget', { prefabIndex: s.index, prefabVersion: s.version, budget: probe }, 10);
  const u = await upkeep();
  await callOk('set_service_budget', { prefabIndex: s.index, prefabVersion: s.version, budget: s.budget }, 10);
  const perPoint = Math.round((base - u) / (s.budget - probe));
  rows.push(`${s.name}: budget ${s.budget}% | ~${perPoint}/point | ~${Math.round(perPoint * s.budget / 1000)}k at current`);
}
console.log(`ServiceUpkeep ${base}`); console.log(rows.join('\n'));
