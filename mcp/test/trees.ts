// LIVE helper: plants trees (road option "Trees") on every medium or large road the design audit lists as no_trees.
//   node test/trees.ts [build]
import { call, callOk, waitOperation } from '../src/bridge.ts';
import { prefab } from '../src/city.ts';
import { readAuditEdges } from '../src/design-live.ts';
import { audit } from '../src/design.ts';
const build = process.argv[2] === 'build'; const p = await prefab('Trees', 'network'); const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const defects = audit({ edges: await readAuditEdges() }).defects.filter(d => d.kind === 'no_trees'); let done = 0; const refused: Record<string, number> = {};
for (const d of defects) {
  const e = ((await callOk('get_network_edges', { x: d.x, z: d.z, radius: 30 }, 20)).edges ?? []).find((e: any) => e.index === d.edges[0]); if (!e) continue;
  let r: any = null;
  for (let t = 0; t < 6; t++) { const o = await call('road_option', { index: e.index, version: e.version, prefabIndex: p.index, prefabVersion: p.version, maxCost: 100000, ...(build ? {} : { previewOnly: true }) }, 15); if (!o.ok) { r = { status: 'refused', error: JSON.stringify(o.error) }; if (/busy|finish_or_cancel|batch/.test(r.error)) { await wait(3000); continue; } break; } r = await waitOperation(o.result.id, 60); break; }
  if (r?.status === 'complete') done++; else { const k = String([...new Set((r?.placementErrors ?? []).flatMap((x: any) => x.reasons ?? []))][0] ?? r?.error).slice(0, 50); refused[k] = (refused[k] ?? 0) + 1; }
}
console.log(JSON.stringify({ roadsWithoutTrees: defects.length, [build ? 'planted' : 'possible']: done, refused }));
