// LIVE helper: creates one closed transport line from the stops that already stand along a closed travel path.
//   node test/routeline.ts '<json: {path:[[x,z],...], stop?:"NA_TramStop01", linePrefab?:180, tolerance?:26, leftHand?:true}>' [build]
// path = the way the vehicle travels, as a closed polyline (out, terminal loop, back, terminal loop; the last point
// joins the first). Every stop of the given kind that stands beside a leg on the side its traffic uses
// (left of travel on a left-hand map) is taken, in travel order. The game previews the line; a line with a
// segment the game cannot route is not created (the mod refuses it) and the metres per segment are printed.
import { call, callOk, waitOperation } from '../src/bridge.ts';
const a = JSON.parse(process.argv[2]); const build = process.argv[3] === 'build';
const P: [number, number][] = a.path; const tol = a.tolerance ?? 26; const left = a.leftHand !== false;
const stops: any[] = ((await callOk('transit_lines', {}, 30)).stops ?? []).filter((s: any) => s.prefab === (a.stop ?? 'NA_TramStop01'));
const legs = P.map((p, i) => ({ a: p, b: P[(i + 1) % P.length] })); let acc = 0; const start = legs.map(l => { const s = acc; acc += Math.hypot(l.b[0] - l.a[0], l.b[1] - l.a[1]); return s; });
const picks: { at: number; stop: any; side: number }[] = []; const skipped: any[] = [];
for (const s of stops) {
  let best: any = null;
  legs.forEach((l, i) => { const dx = l.b[0] - l.a[0], dz = l.b[1] - l.a[1], L = Math.hypot(dx, dz) || 1; const t = ((s.x - l.a[0]) * dx + (s.z - l.a[1]) * dz) / (L * L); if (t < -0.02 || t > 1.02) return; const cross = (dx * (s.z - l.a[1]) - dz * (s.x - l.a[0])) / L; // > 0: left of travel (x east, z north)
    const d = Math.abs(cross); if (d > tol || d < 3) return; if ((cross > 0) !== left) return; if (!best || d < best.d) best = { d, at: start[i] + Math.max(0, Math.min(1, t)) * L, side: cross }; });
  if (best) picks.push({ at: best.at, stop: s, side: best.side }); else skipped.push([s.x, s.z]);
}
picks.sort((u, v) => u.at - v.at);
console.log(`stops of this kind: ${stops.length}; on the path: ${picks.length}; not on the travel side of any leg: ${JSON.stringify(skipped)}`);
console.log(picks.map(p => `${Math.round(p.at)}m (${p.stop.x},${p.stop.z})`).join('  '));
if (picks.length < 2) process.exit(0);
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const op = async (args: any) => { for (let t = 0; t < 10; t++) { const o = await call('create_line', args, 15); if (!o.ok) { const e = JSON.stringify(o.error); if (/busy|finish_or_cancel|batch_in_progress/.test(e)) { await wait(3000); continue; } return { status: 'refused', error: e }; } return await waitOperation(o.result.id, 120); } return { status: 'failed', error: 'busy' }; };
const order = picks.map(p => ({ index: p.stop.index, version: p.stop.version }));
const pv: any = await op({ prefabIndex: a.linePrefab ?? 180, prefabVersion: 1, stops: order, closed: true, previewOnly: true });
console.log('preview:', pv.status, pv.error ?? '', 'metres per segment (-1 = no path):', JSON.stringify(pv.preview?.segmentMetres ?? []));
if (!build || pv.status !== 'complete' || Number(pv.preview?.segmentsWithoutPath ?? 0) > 0) process.exit(0);
const d: any = await op({ prefabIndex: a.linePrefab ?? 180, prefabVersion: 1, stops: order, closed: true });
console.log(JSON.stringify({ line: d.status, error: d.error, created: d.createdLines, stops: order.length }));
