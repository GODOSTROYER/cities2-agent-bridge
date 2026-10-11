// LIVE helper: signal warrant audit (side arms must be Small roads that are not themselves jammed; rail crossings are never touched). Finds junctions with traffic lights where the side roads carry almost
// nothing compared with the main road (lights stop the arterial for a trickle), and with "build" removes those lights.
//   node test/signals.ts [build] [minMainPct=15] [maxSideShare=0.12]
import { callOk, call, waitOperation } from '../src/bridge.ts';
import { prefab } from '../src/city.ts';
const build = process.argv[2] === 'build'; const minMain = Number(process.argv[3] ?? 15), maxSide = Number(process.argv[4] ?? 0.12);
const lights = await prefab('Traffic Lights', 'network'); const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const seen = new Set<number>(); const rows: any[] = [];
for (let cx = -2300; cx <= 1900; cx += 600) for (let cz = -2700; cz <= 2000; cz += 600) {
  const n = await callOk('get_network', { x: cx, z: cz, radius: 450, limit: 400 }, 30); const nodes = (n.nodes ?? []).filter((x: any) => (x.edges ?? []).length >= 3 && !seen.has(x.index)); if (!nodes.length) continue;
  const t = await callOk('traffic_hotspots', { top: 400, minLength: 0, by: 'volume', x: cx, z: cz, radius: 560 }, 30); const by = new Map<number, any>((t.hotspots ?? []).map((h: any) => [h.index, h]));
  for (const x of nodes) {
    seen.add(x.index); const j = await callOk('junction_info', { index: x.index, version: x.version }, 30); if (!j.trafficLights) continue;
    const arms = (j.arms ?? []).map((a: any) => ({ prefab: String(a.prefab), vol: Number(by.get(a.index)?.volumePct ?? 0), flow: Number(by.get(a.index)?.flowPct ?? 0) })).sort((p: any, q: any) => q.vol - p.vol);
    if (arms.length < 3) continue; const main = arms[1].vol, side = arms[2].vol;
    rows.push({ index: x.index, version: x.version, x: Math.round(x.position.x), z: Math.round(x.position.z), arms, main, side, remove: main >= minMain && side <= maxSide * main && arms.slice(2).every((a: any) => /Small/.test(a.prefab) && (a.flow >= 14 || a.vol === 0)) && !arms.some((a: any) => /Track/.test(a.prefab)) });
  }
}
const cand = rows.filter(r => r.remove).sort((a, b) => b.main - a.main);
console.log(`junctions with lights ${rows.length}; lights that stop a main road (second arm >= ${minMain}% volume) for side roads under ${Math.round(maxSide * 100)}% of it: ${cand.length}`);
let done = 0;
for (const r of cand) {
  let note = '';
  if (build) { let d: any = null; for (let t = 0; t < 8; t++) { const o = await call('road_option', { index: r.index, version: r.version, prefabIndex: lights.index, prefabVersion: lights.version, remove: true, maxCost: 1000 }, 15); if (!o.ok) { d = { status: 'refused', error: JSON.stringify(o.error) }; if (/busy|finish_or_cancel/.test(d.error)) { await wait(3000); continue; } break; } d = await waitOperation(o.result.id, 60); if (d.status === 'complete' || !/busy|finish_or_cancel/.test(String(d.error))) break; await wait(3000); } note = d?.status === 'complete' && d.after?.trafficLights === false ? ' REMOVED' : ` failed: ${d?.error}`; if (note === ' REMOVED') done++; }
  console.log(`(${r.x},${r.z}) ${r.arms.map((a: any) => `${a.prefab.replace(' Road', '').replace('Highway Oneway - ', 'H')}:${a.vol}/${a.flow}`).join(' | ')}${note}`);
}
if (build) console.log('removed', done);
