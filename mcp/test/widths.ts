// LIVE helper: the audit's width changes (a corridor that changes road type at a plain two-arm node).
// For each one the narrower piece is brought to the wider type when nothing stands in the way: no building lot
// within the wider road's half-width of its line (the game would remove zoned buildings; this helper does not
// let it). Signals a rebuilt node gets back are removed when the node has three arms or fewer.
//   node test/widths.ts [build] [maxLength=260]
import { call, callOk, waitOperation } from '../src/bridge.ts';
import { prefab } from '../src/city.ts';
import { readAuditEdges } from '../src/design-live.ts';
import { audit, roadClass, ROAD_WIDTH } from '../src/design.ts';
const build = process.argv[2] === 'build'; const maxLen = Number(process.argv[3] ?? 260); const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const edges = await readAuditEdges(); const byId = new Map(edges.map(e => [e.index, e])); const rank: Record<string, number> = { small: 1, medium: 2, large: 3 }; const name: Record<string, string> = { medium: 'Medium Road', large: 'Large Road' };
const lights = await prefab('Traffic Lights', 'network'); let done = 0; const out: string[] = []; const seen = new Set<number>();
for (const d of audit({ edges }).defects.filter(x => x.kind === 'width_change')) {
  const pair = d.edges.map(i => byId.get(i)).filter(Boolean) as any[]; if (pair.length < 2) continue; pair.sort((a, b) => rank[roadClass(a.prefab)] - rank[roadClass(b.prefab)]);
  const [narrow, wide] = pair; const target = roadClass(wide.prefab); if (!name[target] || seen.has(narrow.index)) continue; seen.add(narrow.index);
  if (narrow.length > maxLen) { out.push(`(${d.x},${d.z}) ${narrow.prefab} ${Math.round(narrow.length)} m -> ${name[target]}: longer than ${maxLen} m, a corridor decision`); continue; }
  const half = ROAD_WIDTH[target as 'medium' | 'large'] / 2 + 1; const map = await callOk('get_city_map', { x: (narrow.a.x + narrow.d.x) / 2, z: (narrow.a.z + narrow.d.z) / 2, radius: Math.min(500, narrow.length / 2 + 30) }, 30); let hit = '';
  for (const o of map.buildings ?? []) { const xs = o.polygon.map((q: any) => q.x), zs = o.polygon.map((q: any) => q.z); for (let t = 0; t <= 1.0001 && !hit; t += 0.05) { const x = narrow.a.x + (narrow.d.x - narrow.a.x) * t, z = narrow.a.z + (narrow.d.z - narrow.a.z) * t; if (x > Math.min(...xs) - half && x < Math.max(...xs) + half && z > Math.min(...zs) - half && z < Math.max(...zs) + half) hit = String(o.prefab); } if (hit) break; }
  if (hit) { out.push(`(${d.x},${d.z}) ${narrow.prefab} ${Math.round(narrow.length)} m -> ${name[target]}: a lot stands in the wider road (${hit}), left for a corridor decision`); continue; }
  const live = ((await callOk('get_network_edges', { x: (narrow.a.x + narrow.d.x) / 2, z: (narrow.a.z + narrow.d.z) / 2, radius: 30 }, 20)).edges ?? []).find((e: any) => e.index === narrow.index); if (!live) continue; const p = await prefab(name[target], 'network');
  let r: any = null; for (let t = 0; t < 6; t++) { const o = await call('upgrade_network', { index: live.index, version: live.version, prefabIndex: p.index, prefabVersion: p.version, maxCost: 200000, ...(build ? {} : { previewOnly: true }) }, 15); if (!o.ok) { r = { status: 'refused', error: JSON.stringify(o.error) }; if (/busy|finish_or_cancel|batch/.test(r.error)) { await wait(3000); continue; } break; } r = await waitOperation(o.result.id, 60); break; }
  const why = [...new Set((r?.placementErrors ?? []).flatMap((x: any) => x.reasons ?? []))].join(',') || (r?.status !== 'complete' ? String(r?.error ?? '').slice(0, 40) : '');
  out.push(`(${d.x},${d.z}) ${narrow.prefab} ${Math.round(narrow.length)} m -> ${name[target]}: ${r?.status}${why ? ' ' + why : ''}`); if (r?.status !== 'complete') continue; done++;
  if (build) for (const q of [narrow.a, narrow.d]) { const n = ((await callOk('get_network', { x: q.x, z: q.z, radius: 12, limit: 20 }, 20)).nodes ?? []).filter((n: any) => (n.edges ?? []).length > 0).sort((u: any, v: any) => Math.hypot(u.position.x - q.x, u.position.z - q.z) - Math.hypot(v.position.x - q.x, v.position.z - q.z))[0]; if (!n) continue; const j = await callOk('junction_info', { index: n.index, version: n.version }, 20); if (j.trafficLights && (j.arms ?? []).length <= 3) { const o = await call('road_option', { index: n.index, version: n.version, prefabIndex: lights.index, prefabVersion: lights.version, remove: true, maxCost: 1000 }, 15); if (o.ok) await waitOperation(o.result.id, 60); } }
}
console.log(out.join('\n')); console.log(JSON.stringify({ widthChanges: out.length, [build ? 'widened' : 'possible']: done }));
