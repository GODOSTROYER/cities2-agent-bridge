// LIVE helper: lists the extensions of every building of a type; with "repair" removes the ones that do
// not share the owner's rotation (installed before the snapping fix) and installs them again through the game's snap.
//   node test/upgrades.ts "<owner prefab>" [repair]
import { callOk, call, waitOperation } from '../src/bridge.ts';
import { prefab } from '../src/city.ts';
const [ownerName, mode] = process.argv.slice(2); const repair = mode === 'repair';
const owners = ((await callOk('service_buildings', {}, 30)).services ?? []).filter((s: any) => s[0] === ownerName);
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const op = async (command: string, args: any) => { for (let t = 0; t < 8; t++) { const o = await call(command, args, 15); if (!o.ok) { if (/busy|finish_or_cancel/.test(JSON.stringify(o.error))) { await wait(3000); continue; } return { status: 'refused', error: JSON.stringify(o.error) }; } const d = await waitOperation(o.result.id, 60); if (d.status === 'complete' || !/busy|finish_or_cancel/.test(String(d.error))) return d; await wait(3000); } return { status: 'failed', error: 'busy' }; };
let wrong = 0, fixed = 0; const notes: string[] = [];
for (const [, x, z] of owners) {
  const b = ((await callOk('get_buildings', { x, z, radius: 30, limit: 6 }, 30)).buildings ?? []).find((q: any) => q.prefab === ownerName && Math.hypot(q.position.x - x, q.position.z - z) < 12);
  if (!b) continue;
  const ups = (await callOk('building_upgrades', { index: b.index, version: b.version }, 30)).upgrades ?? [];
  for (const u of ups) {
    const off = Number(u.rotationOffsetDeg ?? 0); const bad = off > 3 && off < 357;
    console.log(`${ownerName} (${x},${z}) ${u.prefab} offset ${off} deg${bad ? ' WRONG' : ''}`);
    if (!bad) continue; wrong++;
    if (!repair) continue;
    const del = await op('demolish', { index: u.index, version: u.version }); if (del.status !== 'complete') { notes.push(`(${x},${z}) remove failed: ${del.error}`); continue; }
    await wait(1500);
    const p = await prefab(u.prefab, 'all'); const re = await op('place_building', { prefabIndex: p.index, prefabVersion: p.version, position: { x: b.position.x, z: b.position.z }, rotation: 2 * Math.atan2(b.rotationQuaternion[1], b.rotationQuaternion[3]) * 180 / Math.PI, maxCost: 400000, upgradeOf: { index: b.index, version: b.version }, maxSnapDistance: 128 });
    if (re.status === 'complete') fixed++; else notes.push(`(${x},${z}) reinstall failed: ${re.error} ${[...new Set((re.placementErrors ?? []).flatMap((e: any) => e.reasons ?? []))].join(',')}`);
  }
}
console.log(JSON.stringify({ owner: ownerName, owners: owners.length, wrong, fixed, notes }));
