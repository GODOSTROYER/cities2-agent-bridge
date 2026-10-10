// Native build path: grids, zoning, links and service placement driven directly from the
// MCP server through the mod's planning queries. No PowerShell, no cell dumps: planning is
// non-pausing (the simulation keeps running), and the game is paused only inside mutate().
import { call, callOk, multi, mutate, waitBatch, waitOperation, readSession } from './bridge.ts';
import type { Json } from './bridge.ts';

export const ZONES: Record<string, string> = { res: 'NA Residential Low', resmed: 'NA Residential Medium Row', com: 'NA Commercial Low', ind: 'Industrial Manufacturing', off: 'Office Low' };
const ROAD_CAP = 8000;        // per road (a full grid line up to ~900 m); Small Road costs ~4 per metre
const now = () => Date.now();
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// Prefab index/version/costs by exact name, cached per city session.
const prefabCache = new Map<string, Json>(); let cacheCity = '';
export async function prefab(name: string, kind = 'all'): Promise<Json> {
  const city = (await readSession()).citySession;
  if (city !== cacheCity) { prefabCache.clear(); cacheCity = city; }
  const key = `${kind}:${name}`;
  if (!prefabCache.has(key)) {
    const page = await callOk('get_build_prefabs', { kind, filter: name, limit: 200 }, 20);
    const hit = (page.prefabs ?? []).find((p: Json) => p.name === name);
    if (!hit) return { name, found: false, similar: (page.prefabs ?? []).slice(0, 8).map((p: Json) => p.name) };
    const details = await callOk('get_prefab_details', { index: hit.index, version: hit.version }, 10);
    prefabCache.set(key, { name, found: true, index: hit.index, version: hit.version, locked: hit.locked, ...(details.costs ?? {}) });
  }
  return prefabCache.get(key);
}

const roadStep = (road: Json, a: Json, b: Json, preview: boolean) => ({ command: 'build_road', args: { prefabIndex: road.prefabIndex, prefabVersion: road.prefabVersion, start: a, end: b, maxCost: ROAD_CAP, ...(preview ? { previewOnly: true } : {}) } });
const connectorStart = (c: Json) => c.from.endpoint ? { x: c.from.x, z: c.from.z } : { x: c.from.x, z: c.from.z, index: c.from.index, version: c.from.version, curvePosition: c.from.t };
const reasonsOf = (batch: Json) => [...new Set((batch.results ?? []).flatMap((r: Json) => (r.placementErrors ?? []).flatMap((e: Json) => e.reasons ?? [])))].slice(0, 6);

async function runBatch(steps: Json[], extra: Json = {}): Promise<Json> {
  let last: Json = { status: 'complete', completed: 0 }; let done = 0;
  for (let i = 0; i < steps.length; i += 56) {
    const started = await callOk('batch_execute', { steps: steps.slice(i, i + 56), compact: true, ...extra }, 20);
    last = await waitBatch(started.id, 300);
    done += Number(last.completed ?? 0);
    if (last.status !== 'complete') { last.failedIndex = i + Number(last.failedStep ?? 0); break; }
  }
  last.completedTotal = done;
  return last;
}

export interface GridOptions { x: number; z: number; cols: number; rows: number; zone: string; plan?: boolean; road?: string }

// Road grid + connector + zoning. Phases are timed so the slow part is always visible.
export async function buildGrid(o: GridOptions): Promise<Json> {
  const phases: Record<string, number> = {}; let t = now();
  const zoneName = ZONES[o.zone]; if (!zoneName) return { ok: false, reason: `unknown_zone:${o.zone}` };
  const [plan, city0] = await multi([{ command: 'plan_grid', args: { x: o.x, z: o.z, cols: o.cols, rows: o.rows, road: o.road ?? 'Small Road' } }, { command: 'get_city_state' }]);
  phases.plan = now() - t; t = now();
  if (plan.blocked) return { ok: false, reason: 'grid_blocked', lotCells: plan.lotCells, outsideCells: plan.outsideCells, phases };
  const roads: Json[] = plan.roads.map((r: number[]) => [{ x: r[0], z: r[1] }, { x: r[2], z: r[3] }]);
  if (!roads.length) return { ok: false, reason: 'no_new_roads', phases };
  const connectors: Json[] = plan.connectors ?? [];
  if (!plan.shared && !connectors.length) return { ok: false, reason: 'no_lot_free_connector', phases };
  const metres = roads.reduce((sum, r) => sum + Math.hypot(r[1].x - r[0].x, r[1].z - r[0].z), 0) + (connectors[0]?.d ?? 0);
  const est = Math.round(metres * 5);
  if (Number(city0.money) < est + 5000) return { ok: false, reason: 'not_enough_money', money: city0.money, estimate: est, phases };

  return mutate(async () => {
    // Native preview of every street and the connector in one batch (nothing is built).
    let connector: Json | null = connectors[0] ?? null;
    const previewSteps = roads.map(r => roadStep(plan.road, r[0], r[1], true));
    if (connector) previewSteps.push(roadStep(plan.road, connectorStart(connector), connector.to, true));
    let pv = await runBatch(previewSteps);
    while (pv.status !== 'complete' && connector && pv.failedIndex === roads.length) {
      // Only the connector was rejected: try the next lot-free candidate.
      const next = connectors[connectors.indexOf(connector) + 1]; if (!next) { connector = null; break; }
      connector = next;
      const op = await call('build_road', roadStep(plan.road, connectorStart(connector), connector.to, true).args, 15);
      if (op.ok && (await waitOperation(op.result.id, 30)).status === 'complete') { pv = { status: 'complete' }; break; }
    }
    phases.preview = now() - t; t = now();
    if (pv.status !== 'complete' && (pv.failedIndex ?? 0) < roads.length) return { ok: false, reason: 'road_rejected_by_game', road: pv.failedIndex, reasons: reasonsOf(pv), error: pv.error, phases, built: 0 };
    if (!plan.shared && !connector) return { ok: false, reason: 'every_connector_rejected', reasons: reasonsOf(pv), phases, built: 0 };
    if (o.plan) return { ok: true, plan: true, roads: roads.length, shared: plan.shared, connector: connector ? Math.round(connector.d) : 0, estimate: est, phases };

    const steps = roads.map(r => roadStep(plan.road, r[0], r[1], false));
    if (connector) steps.push(roadStep(plan.road, connectorStart(connector), connector.to, false));
    const built = await runBatch(steps);
    let linked = built.status === 'complete'; const notes: string[] = [];
    if (built.status !== 'complete') {
      if ((built.failedIndex ?? 0) < roads.length) return { ok: false, reason: 'build_failed_partial', builtRoads: built.completedTotal, error: built.error, reasons: reasonsOf(built), phases };
      // Streets are in, the connector failed (roads renumber as they are built): re-query and retry.
      const again = await callOk('grid_connectors', { x0: plan.bounds[0], z0: plan.bounds[1], x1: plan.bounds[2], z1: plan.bounds[3], top: 8 }, 20);
      for (const c of again.links ?? []) {
        const op = await call('build_road', roadStep(plan.road, connectorStart(c), c.to, false).args, 15);
        if (op.ok && (await waitOperation(op.result.id, 30)).status === 'complete') { linked = true; connector = c; notes.push(`connector rebuilt (${Math.round(c.d)} m)`); break; }
      }
    }
    phases.build = now() - t; t = now();

    const rect = { x0: plan.bounds[0], z0: plan.bounds[1], x1: plan.bounds[2], z1: plan.bounds[3] };
    // Direct zoning in the mod: every Visible unzoned cell of the area in one frame (the same
    // cell write the game's zone tool applies). The game creates zone blocks a few frames
    // after the roads, so wait until the zonable count settles, zone, re-count and repeat;
    // the native zone tool (one rectangle per block) is the last resort.
    const settle = async () => { let last = -1; for (let k = 0; k < 12; k++) { const c = Number((await callOk('zone_area_count', rect, 10)).zonable); if (c === last && c > 0) return c; last = c; await sleep(150); } return last; };
    let zonableTotal = 0, zoneStatus = 'nothing_to_zone', zoneMode = 'none', zoneOps = 0;
    for (let pass = 0; pass < 3; pass++) {
      const before = await settle(); if (before <= 0) break;
      const z = await callOk('zone_area', { ...rect, zone: zoneName }, 30);
      zonableTotal += Number(z.applied ?? 0); zoneStatus = 'complete'; zoneMode = 'direct' + (pass ? `x${pass + 1}` : '');
    }
    if (Number((await callOk('zone_area_count', rect, 10)).zonable) > 0) {
      const z2 = await callOk('zone_area', { ...rect, zone: zoneName, tool: true, perBlock: true }, 30);
      if (z2.batch) { zoneStatus = (await waitBatch(z2.batch, 300)).status; zoneMode += '+tool'; zoneOps += Number(z2.steps ?? 0); }
    }
    const z = { zonable: zonableTotal };
    phases.zone = now() - t; t = now();

    const checks = await multi([
      { command: 'zone_area_count', args: { x0: plan.bounds[0], z0: plan.bounds[1], x1: plan.bounds[2], z1: plan.bounds[3] } },
      { command: 'get_city_state' },
      ...(connector ? [{ command: 'connected', args: { a: { x: plan.bounds[0], z: plan.bounds[1] }, b: { x: connector.from.x, z: connector.from.z } } }] : []),
    ]);
    phases.verify = now() - t;
    return {
      ok: linked, cost: Number(city0.money) - Number(checks[1].money), monthlyUpkeep: null,
      roads: steps.length, shared: plan.shared, zoned: z.zonable, leftZonable: checks[0].zonable, zone: zoneStatus, zoneMode, zoneOps,
      connected: connector ? checks[2].connected : true, ...(notes.length ? { notes } : {}), ...(linked ? {} : { reason: 'grid_built_but_not_connected' }), phases,
    };
  });
}

export interface GrowOptions { zone?: string; cols?: number; rows?: number; plan?: boolean }

// Demand-driven growth: zone choice from the non-pausing snapshot, site from find_free_lots.
export async function grow(o: GrowOptions): Promise<Json> {
  const phases: Record<string, number> = {}; let t = now();
  const snap = await callOk('get_snapshot', {}, 10); const d = snap.demand ?? {}; const unemp = Number(snap.jobs?.unemp ?? 0);
  let choices = [{ k: 'res', v: d.rL }, { k: 'resmed', v: d.rM }, { k: 'com', v: d.c }, { k: 'ind', v: d.i }, { k: 'off', v: d.o }].map(c => ({ k: c.k, v: Number(c.v ?? 0) })).sort((a, b) => b.v - a.v);
  const jobs = ['com', 'ind', 'off'];
  if (unemp > 10) choices = [...choices.filter(c => jobs.includes(c.k)), ...choices.filter(c => !jobs.includes(c.k))];
  if (o.zone) choices = choices.filter(c => c.k === o.zone);
  const pick = choices.find(c => c.v >= 20);
  if (!pick) return { ok: false, reason: 'demand_too_low', demand: d, unemp };
  const want: [number, number] = [o.cols ?? 3, o.rows ?? 2];
  const sizes = ([want, [2, 2], [2, 1], [1, 1]] as [number, number][]).filter((s, i, all) => s[0] * s[1] <= want[0] * want[1] && all.findIndex(x => x[0] === s[0] && x[1] === s[1]) === i);
  const tried: string[] = [];
  for (const [cols, rows] of sizes) {
    const lots = await callOk('find_free_lots', { width: cols * 110, depth: rows * 110, count: 4, zone: pick.k }, 30);
    phases[`sites${cols}x${rows}`] = now() - t; t = now();
    for (const site of lots.sites ?? []) {
      // Quality floor for housing: never next to industry or on polluted ground (the score only
      // ranks what is free; when everything free is bad, buy land elsewhere instead).
      if ((pick.k === 'res' || pick.k === 'resmed') && (Number(site.toIndustry) < 250 || Number(site.pollution) > 8000)) { tried.push(`${cols}x${rows}@${site.x},${site.z}:polluted_or_near_industry`); continue; }
      const r = await buildGrid({ x: site.x, z: site.z, cols, rows, zone: pick.k, plan: o.plan });
      if (r.ok || r.reason === 'build_failed_partial' || r.reason === 'grid_built_but_not_connected')
        return { ...r, zone: pick.k, demand: pick.v, unemp, site: { x: site.x, z: site.z, cols, rows, score: site.score, toIndustry: site.toIndustry, pollution: site.pollution }, phases: { ...phases, ...(r.phases ?? {}) }, ...(tried.length ? { tried } : {}) };
      tried.push(`${cols}x${rows}@${site.x},${site.z}:${r.reason}`);
    }
  }
  return { ok: false, reason: 'no_free_site', zone: pick.k, tried, hint: 'no acceptable free land: buy_tile (x,z away from industry for housing), then grow again', phases };
}

export async function zoneArea(x: number, z: number, radius: number, zone: string, replace = false): Promise<Json> {
  const zoneName = ZONES[zone]; if (!zoneName) return { ok: false, reason: `unknown_zone:${zone}` };
  const rect = { x0: x - radius, z0: z - radius, x1: x + radius, z1: z + radius, margin: 0 };
  return mutate(async () => {
    const t = now(); const r = await callOk('zone_area', { ...rect, zone: zoneName, ...(replace ? { replace: true } : {}) }, 30);
    let status = r.batch ? (await waitBatch(r.batch, 300)).status : (r.mode === 'direct' ? 'complete' : 'nothing_to_zone');
    let left = await callOk('zone_area_count', rect, 10);
    if (left.zonable > 0 && Number(r.zonable ?? 0) > 0) {
      const r2 = await callOk('zone_area', { ...rect, zone: zoneName, tool: true, perBlock: true }, 30);
      if (r2.batch) status = (await waitBatch(r2.batch, 300)).status;
      left = await callOk('zone_area_count', rect, 10);
    }
    return { ok: status !== 'failed', cost: 0, monthlyUpkeep: 0, status, zoned: Number(r.applied ?? r.zonable - left.zonable), replaced: r.replaced, leftZonable: left.zonable, blocks: r.blocks, phases: { zone: now() - t } };
  });
}

// Shortest lot-free straight road from the existing network to (x,z), previewed then built.
export async function link(x: number, z: number, roadName = 'Small Road', maxCost = 60000, plan = false): Promise<Json> {
  const t = now(); const road = await prefab(roadName, 'network');
  if (!road.found) return { ok: false, reason: 'road_not_found', similar: road.similar };
  if (road.locked) return { ok: false, reason: 'road_locked' };
  const [links, city0] = await multi([{ command: 'grid_connectors', args: { x0: x - 1, z0: z - 1, x1: x + 1, z1: z + 1, maxLength: 1000, top: 8 } }, { command: 'get_city_state' }]);
  const planMs = now() - t;
  if (!(links.links ?? []).length) return { ok: false, reason: 'no_lot_free_link', phases: { plan: planMs } };
  return mutate(async () => {
    const t1 = now(); const tried: string[] = [];
    for (const c of links.links) {
      const args = { prefabIndex: road.index, prefabVersion: road.version, start: connectorStart(c), end: { x, z }, maxCost };
      const pv = await call('build_road', { ...args, previewOnly: true }, 15);
      const pvDone = pv.ok ? await waitOperation(pv.result.id, 30) : { status: 'failed', error: pv.error };
      if (pvDone.status !== 'complete') { tried.push(`${Math.round(c.d)}m:${pvDone.error ?? 'rejected'}`); continue; }
      if (plan) return { ok: true, plan: true, length: Math.round(c.d), previewCost: pvDone.previewCost, from: c.from, phases: { plan: planMs, preview: now() - t1 } };
      const op = await callOk('build_road', args, 15); const done = await waitOperation(op.id, 60);
      const money1 = Number((await callOk('get_city_state', {}, 10)).money);
      return { ok: done.status === 'complete', cost: Number(city0.money) - money1, monthlyUpkeep: null, length: Math.round(c.d), error: done.error, ...(tried.length ? { tried } : {}), phases: { plan: planMs, build: now() - t1 } };
    }
    return { ok: false, reason: 'every_link_rejected', tried, phases: { plan: planMs, preview: now() - t1 } };
  });
}

// Service or any other ploppable building: roadside lot search in the mod, then native placement.
export async function placeService(name: string, x: number, z: number, radius = 400, maxCost?: number, plan = false): Promise<Json> {
  const t = now(); const info = await prefab(name, 'building');
  if (!info.found) return { ok: false, reason: 'prefab_not_found', similar: info.similar };
  if (info.locked) return { ok: false, reason: 'prefab_locked' };
  const costs = { construction: info.construction ?? null, monthlyUpkeep: info.monthlyUpkeep ?? info.consumptionUpkeep ?? null };
  const [lots, city0] = await multi([{ command: 'find_roadside_lots', args: { prefab: name, x, z, radius, count: 16 } }, { command: 'get_city_state' }]);
  const planMs = now() - t; const cands: Json[] = lots.candidates ?? [];
  if (!cands.length) return { ok: false, reason: 'no_roadside_site', ...costs, searched: { x, z, radius }, phases: { plan: planMs } };
  if (Number(city0.money) < Number(costs.construction ?? 0)) return { ok: false, reason: 'not_enough_money', money: city0.money, ...costs, phases: { plan: planMs } };
  if (plan) return { ok: true, plan: true, ...costs, sites: lots.found, nearest: cands[0].position, phases: { plan: planMs } };
  return mutate(async () => {
    const t1 = now(); const cap = maxCost ?? Math.max(150000, Math.ceil(Number(costs.construction ?? 0) * 1.2));
    const op = await callOk('place_building', { prefabIndex: info.index, prefabVersion: info.version, position: cands[0].position, rotation: cands[0].rotation, candidates: cands.map(c => ({ position: c.position, rotation: c.rotation })), maxCost: cap }, 20);
    const done = await waitOperation(op.id, 120);
    const money1 = Number((await callOk('get_city_state', {}, 10)).money);
    const reasons = [...new Set((done.placementErrors ?? []).flatMap((e: Json) => e.reasons ?? []))].slice(0, 6);
    return { ok: done.status === 'complete', cost: Number(city0.money) - money1, ...costs, at: done.snappedPosition ? { x: Math.round(done.snappedPosition.x), z: Math.round(done.snappedPosition.z) } : undefined, error: done.error, ...(reasons.length ? { reasons } : {}), attempts: (done.attempts ?? []).length, phases: { plan: planMs, place: now() - t1 } };
  });
}

// Tile purchase: adjacency/dryness ranking in the mod, the game's own price for the selection
// previewed first (so a purchase never fails on funds), then the purchase.
export async function buyTile(o: { n?: number; max?: number; x?: number; z?: number; plan?: boolean }): Promise<Json> {
  const t = now(); const n = Math.max(1, Math.min(3, o.n ?? 1));
  const [opts, city0] = await multi([{ command: 'tile_options', args: { top: Math.max(3, n), ...(o.x !== undefined && o.z !== undefined ? { x: o.x, z: o.z } : {}) } }, { command: 'get_city_state' }]);
  const picks: Json[] = (opts.tiles ?? []).slice(0, n);
  if (!picks.length) return { ok: false, reason: 'no_adjacent_tile', phases: { plan: now() - t } };
  const tiles = picks.map(p => ({ index: p.index, version: p.version }));
  const view = picks.map(p => ({ x: [p.x0, p.x1], z: [p.z0, p.z1], dry: p.dry, relief: p.relief }));
  return mutate(async () => {
    const pv = await callOk('purchase_tiles', { tiles, maxCost: 0, previewOnly: true }, 15); const price = await waitOperation(pv.id, 30);
    const cost = Number(price.cost ?? 0), upkeep = Number(price.upkeep ?? 0), money = Number(city0.money), max = o.max ?? 300000;
    const base = { cost, monthlyUpkeep: upkeep, money, tiles: view, alternatives: (opts.tiles ?? []).length, phases: { plan: now() - t } };
    if (price.status !== 'complete') return { ok: false, reason: price.error ?? 'price_preview_failed', ...base };
    if (o.plan) return { ok: true, plan: true, affordable: cost <= money, ...base };
    if (cost > money) return { ok: false, reason: 'not_enough_money', short: cost - money, ...base };
    if (cost > max) return { ok: false, reason: 'cost_exceeds_max', ...base };
    const t1 = now(); const op = await callOk('purchase_tiles', { tiles, maxCost: max }, 15); const done = await waitOperation(op.id, 30);
    return { ok: done.status === 'complete', error: done.error, ...base, cost: Number(done.cost ?? cost), phases: { plan: base.phases.plan, buy: now() - t1 } };
  });
}
