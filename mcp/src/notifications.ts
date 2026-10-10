// On-map notification icons (the hexagons over buildings and roads) and the action each one
// asks for. The mod reads the icon entities; this module turns them into work.
import { call, callOk, mutate, waitOperation } from './bridge.ts';
import type { Json } from './bridge.ts';
import { prefab } from './city.ts';
import { recordAction } from './happiness.ts';

// Icon prefab name (substring, case-insensitive) -> what to do about it.
export const ICON_ACTIONS: { match: RegExp; need: string; action: string }[] = [
  { match: /not connected|dead ?end|connection|no outlet|no inlet/i, need: 'network', action: 'IMMEDIATE: a cable, pipe or road end is loose. build_line (power_low to the nearest road, power_high to a transformer, pipe to the pipe network) or remove it; never wait' },
  { match: /air pollution|ground pollution/i, need: 'pollution', action: 'pollution_sources (query): find the plant or industry upwind; move it where no homes are downwind, or stop zoning homes in the plume' },
  { match: /traffic|bottleneck/i, need: 'traffic', action: 'fix_traffic: widen that road or junction; add a parallel link (build_arterial)' },
  { match: /burned|collapsed|destroyed/i, need: 'ruins', action: 'clear_ruins: bulldoze the ruin so the lot rebuilds; add fire coverage where fires recur' },
  { match: /abandon/i, need: 'abandoned', action: 'check why (no jobs, no services, pollution, high rent) before clearing' },
  { match: /noise/i, need: 'pollution', action: 'find the source (industry, busy road, service building); do not zone homes next to it; buffer with parks' },
  { match: /hearse|dead/i, need: 'deathcare', action: 'fix_services: cemetery or crematorium' },
  { match: /garbage/i, need: 'garbage', action: 'fix_services: landfill or incinerator; garbage budget' },
  { match: /sick|ambulance|health/i, need: 'health', action: 'fix_services: clinic; health budget' },
  { match: /crime|police/i, need: 'police', action: 'fix_services: police station; crime_map' },
  { match: /fire/i, need: 'fire', action: 'fix_services: fire house' },
  { match: /electric|power/i, need: 'power', action: 'fix_services: power plant; check connections' },
  { match: /sewage/i, need: 'sewage', action: 'fix_services: sewage outlet' },
  { match: /water/i, need: 'water', action: 'fix_services: water pumping' },
];
export const actionFor = (type: string) => ICON_ACTIONS.find(a => a.match.test(type)) ?? null;

// Counts by type with the mapped action, plus the items (position, owner) for one type.
export async function notifications(type?: string, top = 20): Promise<Json> {
  const r = await callOk('notifications', { ...(type ? { type } : {}), top }, 15);
  const counts = Object.entries(r.counts ?? {}).map(([name, n]) => ({ type: name, count: n, need: actionFor(name)?.need ?? null, action: actionFor(name)?.action ?? null }));
  // Where the icons of this type concentrate (300 m buckets), so the cause can be looked up there.
  const buckets = new Map<string, { x: number; z: number; n: number }>();
  for (const i of r.items ?? []) { const k = `${Math.round(i.x / 300)}:${Math.round(i.z / 300)}`; const b = buckets.get(k) ?? { x: 0, z: 0, n: 0 }; b.x += i.x; b.z += i.z; b.n++; buckets.set(k, b); }
  const clusters = [...buckets.values()].sort((a, b) => b.n - a.n).slice(0, 5).map(b => ({ x: Math.round(b.x / b.n), z: Math.round(b.z / b.n), icons: b.n }));
  return { total: r.total, counts, ...(type ? { clusters, items: (r.items ?? []).slice(0, Math.min(top, 12)) } : {}) };
}

// Bulldozes burned-down / collapsed buildings so their lots rebuild. Only owners the game marks
// Destroyed (or that carry a Burned Down / Collapsed icon) are touched.
export async function clearRuins(max = 8, plan = false): Promise<Json> {
  // One query per icon type: an unfiltered page can end before the ruins are reached.
  const found: Json[] = [];
  for (const type of ['Burned', 'Collapsed', 'Destroyed']) found.push(...((await callOk('notifications', { type, top: 100 }, 15)).items ?? []));
  const ruins: Json[] = found.filter((i: Json) => i.ownerKind === 'building' && i.owner);
  const seen = new Set<string>(); const targets = ruins.filter(i => { const k = `${i.owner.index}:${i.owner.version}`; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, Math.max(1, Math.min(30, max)));
  if (!targets.length) return { ok: true, cleared: 0, note: 'no burned-down or collapsed buildings' };
  if (plan) return { ok: true, plan: true, wouldClear: targets.map(t => ({ prefab: t.ownerPrefab, x: t.x, z: t.z, destroyed: !!t.destroyed })) };
  return mutate(async () => {
    const t0 = Date.now(); const cleared: Json[] = []; const failed: Json[] = [];
    for (const t of targets) {
      const op = await call('demolish', { index: t.owner.index, version: t.owner.version }, 15);
      const done = op.ok ? (op.result.id ? await waitOperation(op.result.id, 30) : op.result) : { status: 'failed', error: op.error };
      (done.status === 'complete' ? cleared : failed).push({ prefab: t.ownerPrefab, x: t.x, z: t.z, ...(done.status === 'complete' ? {} : { error: done.error }) });
    }
    if (cleared.length) await recordAction({ need: 'ruins', tool: 'clear_ruins', detail: `${cleared.length} ruins cleared` });
    return { ok: failed.length === 0, cleared: cleared.length, sites: cleared.slice(0, 8), failed, phases: { clear: Date.now() - t0 } };
  });
}

// Traffic-jam icons name the exact road. Small Roads are widened to Medium Road (previewed
// first); anything else is reported with what it would need.
export async function fixJams(max = 3, plan = false): Promise<Json> {
  const r = await callOk('notifications', { type: 'Traffic', top: 30 }, 15);
  const jams: Json[] = r.items ?? [];
  if (!jams.length) return { ok: true, jams: 0, upgraded: [], unresolved: [] };
  // Older mod builds report the lane as owner; resolve such a jam to the nearest congested edge.
  if (jams.some(j => j.ownerKind !== 'road' && j.ownerKind !== 'junction')) {
    const hot: Json[] = (await callOk('traffic_hotspots', { top: 30, minLength: 10 }, 15)).hotspots ?? [];
    for (const j of jams) if (j.ownerKind !== 'road' && j.ownerKind !== 'junction') {
      const near = hot.map(h => ({ h, d: Math.hypot(h.x - j.x, h.z - j.z) })).sort((a, b) => a.d - b.d)[0];
      if (near && near.d <= 90) { j.ownerKind = 'road'; j.owner = { index: near.h.index, version: near.h.version }; j.ownerPrefab = near.h.prefab; }
    }
  }
  const upgradable = jams.filter(j => j.ownerKind === 'road' && /^Small Road/.test(String(j.ownerPrefab ?? ''))).slice(0, Math.max(1, Math.min(8, max)));
  const unresolved = jams.filter(j => !upgradable.includes(j)).slice(0, 8).map(j => ({ x: j.x, z: j.z, on: j.ownerPrefab ?? j.ownerKind,
    needs: j.ownerKind === 'junction' ? 'junction redesign (roundabout or fewer approaches)' : /Highway/.test(String(j.ownerPrefab)) ? 'second highway connection' : 'wider prefab (locked) or a parallel link' }));
  if (plan || !upgradable.length) return { ok: true, plan, jams: jams.length, wouldUpgrade: upgradable.map(j => ({ x: j.x, z: j.z, on: j.ownerPrefab })), unresolved };
  const medium = await prefab('Medium Road', 'network');
  if (!medium.found || medium.locked) return { ok: false, reason: 'medium_road_unavailable', jams: jams.length, unresolved };
  return mutate(async () => {
    const t0 = Date.now(); const upgraded: Json[] = [];
    for (const j of upgradable) {
      const args = { index: j.owner.index, version: j.owner.version, prefabIndex: medium.index, prefabVersion: medium.version, maxCost: 30000 };
      const pv = await call('upgrade_network', { ...args, previewOnly: true }, 15);
      const pvDone = pv.ok ? await waitOperation(pv.result.id, 30) : { status: 'failed', error: pv.error };
      if (pvDone.status !== 'complete') { upgraded.push({ x: j.x, z: j.z, status: 'rejected', error: pvDone.error, reasons: (pvDone.placementErrors ?? []).flatMap((e: Json) => e.reasons ?? []).slice(0, 4) }); continue; }
      const op = await call('upgrade_network', args, 15);
      const done = op.ok ? await waitOperation(op.result.id, 60) : { status: 'failed', error: op.error };
      upgraded.push({ x: j.x, z: j.z, status: done.status, cost: done.previewCost, ...(done.status === 'complete' ? {} : { error: done.error }) });
    }
    const okCount = upgraded.filter(u => u.status === 'complete').length;
    if (okCount) await recordAction({ need: 'traffic', tool: 'fix_traffic', detail: `${okCount} jammed Small Road segments widened` });
    return { ok: true, jams: jams.length, upgraded, unresolved, phases: { build: Date.now() - t0 } };
  });
}
