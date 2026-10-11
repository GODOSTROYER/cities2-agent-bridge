// LIVE helper: builds one straight street between two existing road nodes (a joining street proposed by joins.ts).
//   node test/join.ts <x1> <z1> <x2> <z2> [build] [road="Small Road"]
// Previewed by the game first. It lists the buildings whose lot the street would cut (zoned buildings are
// removed by the game when a road is built over them; a service building makes the game refuse).
import { call, callOk, waitOperation } from '../src/bridge.ts';
import { prefab } from '../src/city.ts';
const [x1, z1, x2, z2] = process.argv.slice(2, 6).map(Number); const build = process.argv[6] === 'build'; const road = process.argv[7] ?? 'Small Road';
const p = await prefab(road, 'network'); const half = /Large/.test(road) ? 16 : /Medium/.test(road) ? 12 : 8;
const node = async (x: number, z: number) => ((await callOk('get_network', { x, z, radius: 10, limit: 12 }, 20)).nodes ?? []).filter((n: any) => (n.edges ?? []).length > 0).sort((u: any, v: any) => Math.hypot(u.position.x - x, u.position.z - z) - Math.hypot(v.position.x - x, v.position.z - z))[0];
const a = await node(x1, z1), b = await node(x2, z2); if (!a || !b) { console.log('no road node at one of the points'); process.exit(0); }
const A = a.position, B = b.position; const L = Math.hypot(B.x - A.x, B.z - A.z);
const map = await callOk('get_city_map', { x: (A.x + B.x) / 2, z: (A.z + B.z) / 2, radius: Math.min(500, L / 2 + 40) }, 30); const hit: string[] = [];
for (const o of map.buildings ?? []) { const xs = o.polygon.map((q: any) => q.x), zs = o.polygon.map((q: any) => q.z); for (let t = 0.08; t <= 0.92; t += 0.04) { const x = A.x + (B.x - A.x) * t, z = A.z + (B.z - A.z) * t; if (x > Math.min(...xs) - half && x < Math.max(...xs) + half && z > Math.min(...zs) - half && z < Math.max(...zs) + half) { hit.push(`${o.prefab} (${Math.round(o.position.x)},${Math.round(o.position.z)})`); break; } } }
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const run = async (previewOnly: boolean) => { const args: any = { prefabIndex: p.index, prefabVersion: p.version, start: { x: A.x, z: A.z, index: a.index, version: a.version }, end: { x: B.x, z: B.z, index: b.index, version: b.version }, maxCost: 60000, ...(previewOnly ? { previewOnly: true } : {}) }; for (let t = 0; t < 8; t++) { const o = await call('build_road', args, 15); if (!o.ok) { const e = JSON.stringify(o.error); if (/busy|finish_or_cancel|batch/.test(e)) { await wait(3000); continue; } return { status: 'refused', error: e }; } return await waitOperation(o.result.id, 60); } return { status: 'failed', error: 'busy' }; };
const pv: any = await run(true); const reasons = [...new Set((pv.placementErrors ?? []).flatMap((e: any) => e.reasons ?? []))];
console.log(JSON.stringify({ from: [Math.round(A.x), Math.round(A.z)], to: [Math.round(B.x), Math.round(B.z)], metres: Math.round(L), slopePct: Number((Math.abs(A.y - B.y) / L * 100).toFixed(1)), preview: pv.status, cost: pv.previewCost, reasons, buildingsOnTheLine: hit }));
if (!build || pv.status !== 'complete') process.exit(0);
const d: any = await run(false); console.log(JSON.stringify({ built: d.status, error: d.error, created: (d.createdRoads ?? []).length }));
