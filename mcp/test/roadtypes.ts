// LIVE helper (READ ONLY): the road, bridge, track, bus lane, bike and pedestrian prefabs the game offers, by class,
// with lock state, and a suggested best unlocked pick for highway, large, medium and small roads.
//   node test/roadtypes.ts        summary by class (best pick, open types, locked types)
//   node test/roadtypes.ts all    every road prefab, one line each
// Source: get_build_prefabs (kind "network", paged; prefabType RoadPrefab, TrackPrefab, PathwayPrefab, FencePrefab kept,
// water, power, pipe, harbour, marker and invisible prefabs dropped) and get_prefab_details per candidate for
// the construction cost and net upkeep (per segment unit, not per metre) and the width (NetGeometryData m_DefaultWidth).
// Not in the reply: lanes and speed. Lanes are read from the name ("3 lanes", "2+4 lanes"); a name without a count takes
// the family default (Small 2, Medium 4, Large 6, XL 8, Alley 2, Gravel 2) and is marked "~". Speed is not shown.
// Classes come from the name. Best picks: highway = most lanes; large and medium = divided first, then most lanes;
// small = the plain two-way street without parking (the names carry no tree or sidewalk flag, so the plain one is taken).
import { callOk } from '../src/bridge.ts';

const all = process.argv[2] === 'all';
const page = await callOk('get_build_prefabs', { kind: 'network', limit: 4096 }, 30);
const DROP = /Invisible|Marker|Lane Editor|Pier|Quay|Harbor|Seaway|Boatway|\bDam\b|Oil|Ferry|Fishing|Leisure|Crosswalk|Forbid|Lighting|RoadZones|Traffic|All-way|Sidewalk|Trees|Grass|Sound|Hedge/i;
const KEEP_TYPE = /Game\.Prefabs\.(RoadPrefab|TrackPrefab|PathwayPrefab|FencePrefab)$/;
const CLASSES = [
  ['bridges', /Bridge|Golden Gate|Grand Bridge/],
  ['highway', /^Highway/],
  ['large', /^(XL )?Large Road|^XL Road/],
  ['medium', /^Medium Road/],
  ['small', /^Small Road|^Gravel Road/],
  ['alleys', /^Alley/],
  ['bus lanes', /Public Transport Lane/],
  ['tram tracks', /Tram/],
  ['train and subway tracks', /Train|Subway/],
  ['bike', /Bike/],
  ['pedestrian streets and paths', /Pedestrian|Pavement|Pathway/],
] as const;
const FAMILY_LANES: [RegExp, number][] = [[/^XL Road/, 8], [/^Large Road/, 6], [/^Medium Road/, 4], [/^Small Road|^Gravel|^Alley/, 2]];
const classOf = (name: string, prefabType: string): string => {
  for (const [cls, re] of CLASSES) if (re.test(name)) return cls;
  return /TrackPrefab/.test(prefabType) ? 'train and subway tracks' : /PathwayPrefab/.test(prefabType) ? 'pedestrian streets and paths' : 'other';
};
function lanesOf(name: string): { n: number | null; inferred: boolean } {
  const sum = /(\d+)\s*\+\s*(\d+)\s*lanes?/i.exec(name); if (sum) return { n: Number(sum[1]) + Number(sum[2]), inferred: false };
  const m = /(\d+)\s*lanes?/i.exec(name); if (m) return { n: Number(m[1]), inferred: false };
  const f = FAMILY_LANES.find(([re]) => re.test(name)); return f ? { n: f[1], inferred: true } : { n: null, inferred: false };
}

const rows: any[] = [];
for (const r of page.prefabs ?? []) {
  if (!KEEP_TYPE.test(String(r.prefabType)) || DROP.test(r.name)) continue;
  if (/FencePrefab/.test(r.prefabType) && !/Bike/.test(r.name)) continue;
  const d = await callOk('get_prefab_details', { index: r.index, version: r.version }, 10);
  const geo = d.rawData?.['Game.Prefabs.NetGeometryData'] ?? {};
  const { n, inferred } = lanesOf(r.name);
  const cls = classOf(r.name, String(r.prefabType));
  rows.push({ name: r.name, index: r.index, version: r.version, cls, locked: r.locked === true, lanes: n, inferred, width: geo.m_DefaultWidth ?? null, construction: d.costs?.construction ?? null, upkeep: d.costs?.netUpkeep ?? null });
}

const fmt = (x: any) => `${x.name} [${x.lanes == null ? '-' : (x.inferred ? '~' : '') + x.lanes + ' lanes'}, w${x.width ?? '-'}, c${x.construction ?? '-'} u${x.upkeep ?? '-'}]`;
if (all) { for (const x of rows) console.log(`${x.cls.padEnd(28)} ${x.locked ? 'LOCKED' : 'open  '} ${fmt(x)}`); process.exit(0); }

const bestOf: Record<string, (open: any[]) => any> = {
  highway: open => [...open].sort((a, b) => (b.lanes ?? 0) - (a.lanes ?? 0) || (b.width ?? 0) - (a.width ?? 0))[0],
  large: open => [...open].sort((a, b) => Number(/Divided/.test(b.name)) - Number(/Divided/.test(a.name)) || (b.lanes ?? 0) - (a.lanes ?? 0))[0],
  medium: open => [...open].sort((a, b) => Number(/Divided/.test(b.name)) - Number(/Divided/.test(a.name)) || (b.lanes ?? 0) - (a.lanes ?? 0))[0],
  small: open => open.find(x => x.name === 'Small Road') ?? open.find(x => x.lanes === 2 && !/Parking|Oneway|Asymmetric|Divided/.test(x.name)) ?? open[0],
};
for (const [cls] of CLASSES) {
  const members = rows.filter(x => x.cls === cls); if (!members.length) continue;
  const open = members.filter(x => !x.locked), locked = members.filter(x => x.locked);
  const pick = bestOf[cls] && open.length ? bestOf[cls](open) : null;
  console.log(`${cls.toUpperCase()}: ${open.length} open, ${locked.length} locked${pick ? `; best ${pick.name} (${pick.lanes ?? '-'} lanes, w${pick.width ?? '-'}, c${pick.construction ?? '-'} u${pick.upkeep ?? '-'})` : ''}`);
  console.log(`  open: ${open.map(fmt).join('; ') || 'none'}`);
  if (locked.length) console.log(`  locked: ${locked.map(x => x.name).join('; ')}`);
}
const ramps = rows.filter(x => /Ramp/i.test(x.name)).length;
console.log(`ramps: ${ramps} in the prefab list (none named Ramp: highway ramps are not a separate prefab here)`);
