// LIVE helper (read-only): how inbound highway traffic splits between the city's entries, with the speed on each ramp.
// Volume = vehicles per time bucket on the ramp edge; ratio = share of free speed.
import { callOk } from '../src/bridge.ts';
const E: [string, number, number][] = [
  ['north exit (southbound) -> (-836,1140)', -985, 1235], ['Northgate exit (city-bound) -> zone', 656, 2931],
  ['spur, southbound ramp', -1244, 85], ['spur, northbound ramp', -1375, -63], ['spur itself (both)', -951, 38],
  ['centre exit (southbound) -> roundabout (-1158,-175)', -1280, -236], ['west branch (northbound) -> (-1404,-175)', -1374, -174],
  ['south exit (southbound) -> (-1405,-2085)', -1438, -2005], ['south tunnel exit (northbound) -> (-1401,-2445)', -1730, -2520],
  ['mainline from the north (city-bound)', -952, 1492], ['mainline from the south (city-bound)', -1714, -2817],
];
for (const [name, x, z] of E) {
  const d = await callOk('get_network_edges', { x, z, radius: 28 }, 30); let best: any = null, bd = 1e9;
  for (const e of d.edges ?? []) { if (!/Highway/.test(e.prefab) || !e.trafficDistanceRaw?.length) continue; const a = e.curve[0], b = e.curve[e.curve.length - 1]; const dd = Math.hypot((a.x + b.x) / 2 - x, (a.z + b.z) / 2 - z); if (dd < bd) { bd = dd; best = e; } }
  if (!best) { console.log(name.padEnd(52), 'no edge'); continue; }
  const di = best.trafficDistanceRaw.slice(0, 4), du = best.trafficDurationRaw.slice(0, 4); const vol = di.reduce((s: number, v: number) => s + v, 0) / 4, T = du.reduce((s: number, v: number) => s + v, 0);
  console.log(name.padEnd(52), 'vehicles', String(Math.round(vol)).padStart(4), ' speed', T > 0 ? (di.reduce((s: number, v: number) => s + v, 0) / T).toFixed(2) : ' -  ', ' ', best.prefab.replace('Highway Oneway - ', ''));
}
