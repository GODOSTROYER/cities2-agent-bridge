// LIVE helper: applies or removes a road option (Traffic Lights, Sound Barrier, Trees, Grass, Wide Sidewalk, Lighting, Crosswalk)
// on a node or edge through the game's replace tool.  node test/roadopt.ts '<json: {option, index, version, remove?}>' [build]
import { call, callOk, waitOperation } from '../src/bridge.ts';
import { prefab } from '../src/city.ts';
const a = JSON.parse(process.argv[2]); const build = process.argv[3] === 'build';
const p = await prefab(a.option, 'network'); if (!p.found) { console.log('NOT FOUND', JSON.stringify(p.similar ?? [])); process.exit(0); }
const wait = (ms: number) => new Promise(r => setTimeout(r, ms)); let d: any = null;
for (let t = 0; t < 8; t++) { const o = await call('road_option', { index: a.index, version: a.version, prefabIndex: p.index, prefabVersion: p.version, remove: a.remove === true, maxCost: 50000, ...(build ? {} : { previewOnly: true }) }, 15); if (!o.ok) { d = { status: 'refused', error: JSON.stringify(o.error) }; if (/busy|finish_or_cancel/.test(d.error)) { await wait(3000); continue; } break; } d = await waitOperation(o.result.id, 60); if (d.status === 'complete' || !/busy|finish_or_cancel/.test(String(d.error))) break; await wait(3000); }
console.log(JSON.stringify({ status: d.status, error: d.error, cost: d.previewCost, before: d.before, after: d.after, reasons: [...new Set((d.placementErrors ?? []).flatMap((e: any) => e.reasons ?? []))] }).slice(0, 900));
