// LIVE helper: previews (or builds) the upgrade of every edge on the network path through the points to one road type,
// so a corridor gets one type end to end. Lists per edge what the game refuses and the zoned buildings that front it
// (the game removes zoned buildings a wider road cuts; service buildings make it refuse).
//   node test/widen.ts '<json: {road:"Medium Road", points:[[x,z],...], only?:"Small Road"}>' [build]
import { call, callOk, waitOperation } from '../src/bridge.ts';
import { prefab } from '../src/city.ts';
const a = JSON.parse(process.argv[2]); const build = process.argv[3] === 'build'; const p = await prefab(a.road, 'network'); const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const near = async (q: [number, number]) => ((await callOk('get_network', { x: q[0], z: q[1], radius: 45, limit: 80 }, 20)).nodes ?? []).filter((n: any) => (n.edges ?? []).length > 0).sort((u: any, v: any) => Math.hypot(u.position.x - q[0], u.position.z - q[1]) - Math.hypot(v.position.x - q[0], v.position.z - q[1]))[0];
const ids: any[] = [];
for (let i = 0; i < a.points.length - 1; i++) { const s = await near(a.points[i]), t = await near(a.points[i + 1]); const path = await callOk('trace_network', { fromIndex: s.index, fromVersion: s.version, toIndex: t.index, toVersion: t.version }, 20); for (const e of path.edges ?? []) if (!ids.some(x => x.index === e.index)) ids.push(e); }
let ok = 0, fronting = 0; const rows: string[] = [];
for (const id of ids) {
  const e = ((await callOk('get_network_edges', { x: 0, z: 0, radius: 1 }, 5).catch(() => ({}))) as any, id); const info = await callOk('inspect_entity', { index: id.index, version: id.version }, 20).catch(() => null); if (!info) continue; if (a.only && info.prefab !== a.only) continue; if (info.prefab === a.road) continue;
  let d: any = null; for (let t = 0; t < 6; t++) { const o = await call('upgrade_network', { index: id.index, version: id.version, prefabIndex: p.index, prefabVersion: p.version, maxCost: 300000, ...(build ? {} : { previewOnly: true }) }, 15); if (!o.ok) { d = { status: 'refused', error: JSON.stringify(o.error) }; if (/busy|finish_or_cancel|batch/.test(d.error)) { await wait(3000); continue; } break; } d = await waitOperation(o.result.id, 60); break; }
  const reasons = [...new Set((d?.placementErrors ?? []).flatMap((x: any) => x.reasons ?? []))].join(','); const blockers = (d?.placementErrors ?? []).filter((x: any) => x.position).slice(0, 2).map((x: any) => `${Math.round(x.position.x)},${Math.round(x.position.z)}`).join(' ');
  if (d?.status === 'complete') ok++; rows.push(`${id.index} ${info.prefab} -> ${d?.status}${reasons ? ' ' + reasons : ''}${blockers ? ' at ' + blockers : ''}${d?.error && !reasons ? ' ' + String(d.error).slice(0, 40) : ''}`);
}
console.log(rows.join('\n')); console.log(JSON.stringify({ road: a.road, edges: rows.length, [build ? 'upgraded' : 'possible']: ok }));
