// LIVE helper: builds a chain of track or road pieces, each starting on the end node of the previous one.
//   node test/chain.ts '<json: {road, fromNode:{index,version,x,z}, pieces:[{to:[x,z], control?:[x,z], toEdge?:{index,version,curvePosition}}]}>' [build]
// Every piece is previewed before it is built; the chain stops at the first refusal.
import { call, callOk, waitOperation } from '../src/bridge.ts';
import { prefab } from '../src/city.ts';
const a = JSON.parse(process.argv[2]); const build = process.argv[3] === 'build'; const p = await prefab(a.road, 'network'); const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
let start: any = { x: a.fromNode.x, z: a.fromNode.z, index: a.fromNode.index, version: a.fromNode.version };
const run = async (args: any) => { for (let t = 0; t < 8; t++) { const o = await call('build_road', args, 15); if (!o.ok) { const e = JSON.stringify(o.error); if (/busy|finish_or_cancel|batch/.test(e)) { await wait(3000); continue; } return { status: 'refused', error: e }; } return await waitOperation(o.result.id, 90); } return { status: 'failed', error: 'busy' }; };
for (const [i, pc] of a.pieces.entries()) {
  const end = pc.toEdge ? { x: pc.to[0], z: pc.to[1], index: pc.toEdge.index, version: pc.toEdge.version, curvePosition: pc.toEdge.curvePosition } : { x: pc.to[0], z: pc.to[1] };
  const args: any = { prefabIndex: p.index, prefabVersion: p.version, start, end, maxCost: 200000, ...(pc.control ? { control: { x: pc.control[0], z: pc.control[1] }, mode: 'curve' } : {}) };
  const pv: any = await run({ ...args, previewOnly: true }); const why = [...new Set((pv.placementErrors ?? []).flatMap((x: any) => x.reasons ?? []))].join(',');
  console.log(`piece ${i + 1} preview ${pv.status} ${pv.previewCost ?? ''} ${why || pv.error || ''}`); if (pv.status !== 'complete') break; if (!build) { start = { x: pc.to[0], z: pc.to[1] }; continue; }
  const d: any = await run(args); console.log(`piece ${i + 1} built ${d.status} ${d.error ?? ''}`); if (d.status !== 'complete') break; await wait(2500);
  const ends = (await callOk('network_ends', { x: pc.to[0], z: pc.to[1], radius: 14 }, 30)).ends ?? []; const e = ends.sort((u: any, v: any) => Math.hypot(u.x - pc.to[0], u.z - pc.to[1]) - Math.hypot(v.x - pc.to[0], v.z - pc.to[1]))[0];
  if (!e && i < a.pieces.length - 1) { console.log('end node not found'); break; } if (e) start = { x: e.x, z: e.z, index: e.node.index, version: e.node.version };
}
