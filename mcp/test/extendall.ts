// LIVE helper: installs one extension on every building of a type that does not have it yet.
//   node test/extendall.ts "<owner prefab>" "<extension prefab>" [max] [build]
// Each one is previewed by the game first; refusals are listed with the game's reasons.
import { callOk, call, waitOperation } from '../src/bridge.ts';
import { prefab } from '../src/city.ts';
const [ownerName, extName, maxArg, mode] = process.argv.slice(2); const max = Number(maxArg ?? 99); const build = mode === 'build';
const p = await prefab(extName, 'all'); if (!p.found) { console.log('NOT FOUND', extName, JSON.stringify(p.similar ?? []).slice(0, 300)); process.exit(0); }
const owners = ((await callOk('service_buildings', {}, 30)).services ?? []).filter((s: any) => s[0] === ownerName);
let done = 0, cost = 0; const refused: string[] = [];
for (const [, x, z] of owners) {
  if (done >= max) break;
  const b = ((await callOk('get_buildings', { x, z, radius: 30, limit: 6 }, 30)).buildings ?? []).find((q: any) => q.prefab === ownerName && Math.hypot(q.position.x - x, q.position.z - z) < 12);
  if (!b) { refused.push(`(${x},${z}) owner not found`); continue; }
  const has = (b.components ?? []).length && false; // upgrades are read from the result of the preview instead
  const args = { prefabIndex: p.index, prefabVersion: p.version, position: { x: b.position.x, z: b.position.z }, rotation: 0, maxCost: 400000, upgradeOf: { index: b.index, version: b.version }, maxSnapDistance: 128 };
  const run = async (previewOnly: boolean) => { const op = await call('place_building', { ...args, ...(previewOnly ? { previewOnly: true } : {}) }, 15); if (!op.ok) return { status: 'refused', error: JSON.stringify(op.error) }; return await waitOperation(op.result.id, 60); };
  let r: any = null; for (let t = 0; t < 8; t++) { r = await run(true); if (!/busy|finish_or_cancel/.test(String(r.error))) break; await new Promise(res => setTimeout(res, 3000)); }
  const why = () => `${r.error ?? ''} ${[...new Set((r.placementErrors ?? []).flatMap((e: any) => e.reasons ?? []))].join(',')}`.trim();
  if (r.status !== 'complete') { refused.push(`(${x},${z}) ${why()}`); continue; }
  if (build) { for (let t = 0; t < 8; t++) { r = await run(false); if (r.status === 'complete' || !/busy|finish_or_cancel/.test(String(r.error))) break; await new Promise(res => setTimeout(res, 3000)); } if (r.status !== 'complete') { refused.push(`(${x},${z}) build: ${why()}`); continue; } }
  done++; cost += Number(r.previewCost ?? 0);
}
console.log(JSON.stringify({ owner: ownerName, extension: extName, owners: owners.length, [build ? 'installed' : 'possible']: done, cost, refused }));
