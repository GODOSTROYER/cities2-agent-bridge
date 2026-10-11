// LIVE helper: road option "Lighting" on every highway edge on owned land (accidents are likelier on unlit roads).
//   node test/hwlights.ts [build]
import { call, callOk, waitOperation } from '../src/bridge.ts';
import { prefab } from '../src/city.ts';
const build = process.argv[2] === 'build'; const p = await prefab('Lighting', 'network'); const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const tiles = ((await callOk('get_tiles', {}, 30)).tiles ?? []).filter((t: any) => t.purchased); const seen = new Map<number, any>();
for (const t of tiles) { const xs = t.polygon.map((q: any) => q.x), zs = t.polygon.map((q: any) => q.z); const r = await callOk('get_network_edges', { x: (Math.min(...xs) + Math.max(...xs)) / 2, z: (Math.min(...zs) + Math.max(...zs)) / 2, radius: 470 }, 40); for (const e of r.edges ?? []) if (/Highway/.test(String(e.prefab)) && !/Lighting/.test(String(e.upgraded ?? ''))) seen.set(e.index, e); }
let done = 0; const refused: Record<string, number> = {};
for (const e of seen.values()) { let d: any = null; for (let t = 0; t < 6; t++) { const o = await call('road_option', { index: e.index, version: e.version, prefabIndex: p.index, prefabVersion: p.version, maxCost: 100000, ...(build ? {} : { previewOnly: true }) }, 15); if (!o.ok) { d = { status: 'refused', error: JSON.stringify(o.error) }; if (/busy|finish_or_cancel|batch/.test(d.error)) { await wait(3000); continue; } break; } d = await waitOperation(o.result.id, 60); break; } if (d?.status === 'complete') done++; else { const k = String([...new Set((d?.placementErrors ?? []).flatMap((x: any) => x.reasons ?? []))][0] ?? d?.error).slice(0, 40); refused[k] = (refused[k] ?? 0) + 1; } }
console.log(JSON.stringify({ highwayEdgesWithoutLighting: seen.size, [build ? 'lit' : 'possible']: done, refused }));
