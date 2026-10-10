// Native build path: grids, zoning, links and service placement driven directly from the
// MCP server through the mod's planning queries. No PowerShell, no cell dumps: planning is
// non-pausing (the simulation keeps running), and the game is paused only inside mutate().
import { call, callOk, multi, mutate, waitBatch, waitOperation, readSession } from './bridge.ts';
import type { Json } from './bridge.ts';

export const ZONES: Record<string, string> = { res: 'NA Residential Low', resmed: 'NA Residential Medium Row', com: 'NA Commercial Low', ind: 'Industrial Manufacturing', off: 'Office Low' };
const ROAD_CAP = 8000;        // per road (a full grid line up to ~900 m); Small Road costs ~4 per metre
const now = () => Date.now();
export function quotedCost(quoted: unknown, cashBefore: number, cashAfter: number): { cost: number; costSource: 'quoted' | 'cash_delta' } {
  return typeof quoted === 'number' && Number.isFinite(quoted) ? { cost: quoted, costSource: 'quoted' } : { cost: cashBefore - cashAfter, costSource: 'cash_delta' };
}
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// Prefab index/version/costs by exact name, cached per city session. An entry lives at most
// PREFAB_TTL_MS, a locked entry is never served (an unlock changes it), and the whole cache is
// dropped when a different milestone is passed (milestones unlock prefabs).
const PREFAB_TTL_MS = 5 * 60 * 1000;
const prefabCache = new Map<string, { at: number; value: Json }>(); let cacheCity = '';
let lastMilestone: number | undefined;
export function invalidatePrefabCache(): void { prefabCache.clear(); }
export async function prefab(name: string, kind = 'all', milestone?: number): Promise<Json> {
  const city = (await readSession()).citySession;
  if (city !== cacheCity) { prefabCache.clear(); cacheCity = city; }
  if (typeof milestone === 'number' && milestone !== lastMilestone) { prefabCache.clear(); lastMilestone = milestone; }
  const key = `${kind}:${name}`;
  const cached = prefabCache.get(key);
  if (cached && now() - cached.at < PREFAB_TTL_MS && cached.value.locked !== true) return cached.value;
  const page = await callOk('get_build_prefabs', { kind, filter: name, limit: 200 }, 20);
  const hit = (page.prefabs ?? []).find((p: Json) => p.name === name);
  if (!hit) return { name, found: false, similar: (page.prefabs ?? []).slice(0, 8).map((p: Json) => p.name) };
  const details = await callOk('get_prefab_details', { index: hit.index, version: hit.version }, 10);
  const value = { name, found: true, index: hit.index, version: hit.version, locked: hit.locked, ...(details.costs ?? {}) };
  prefabCache.set(key, { at: now(), value });
  return value;
}

const roadStep = (road: Json, a: Json, b: Json, preview: boolean) => ({ command: 'build_road', args: { prefabIndex: road.prefabIndex, prefabVersion: road.prefabVersion, start: a, end: b, maxCost: ROAD_CAP, ...(preview ? { previewOnly: true } : {}) } });
const connectorStart = (c: Json) => c.from.endpoint ? { x: c.from.x, z: c.from.z } : { x: c.from.x, z: c.from.z, index: c.from.index, version: c.from.version, curvePosition: c.from.t };
const reasonsOf = (batch: Json) => [...new Set((batch.results ?? []).flatMap((r: Json) => (r.placementErrors ?? []).flatMap((e: Json) => e.reasons ?? [])))].slice(0, 6);

// The mod rejects a request file over 16,384 bytes and the client refuses above 15,000. The
// 600 bytes kept back cover the request envelope around the batch payload.
const ENVELOPE_BYTES = 600;
const byteLength = (s: string) => new TextEncoder().encode(s).length;

// Splits steps into batch_execute payloads by serialized size (UTF-8 bytes of exactly the
// { steps, compact: true, ...extra } object that is sent) and by step count. Order is kept.
export function chunkSteps(steps: Json[], extra: Json = {}, maxBytes = 15000, maxSteps = 60): Json[][] {
  const budget = maxBytes - ENVELOPE_BYTES;
  // Payload size with no steps ('[]' included); each step adds its own bytes plus a comma.
  const base = byteLength(JSON.stringify({ steps: [], compact: true, ...extra }));
  const chunks: Json[][] = [];
  let cur: Json[] = []; let curBytes = base;
  for (const step of steps) {
    const bytes = byteLength(JSON.stringify(step));
    if (base + bytes > budget) throw new Error(`batch_step_too_large: one step needs ${base + bytes} bytes with the batch wrapper; the limit is ${budget} (maxBytes ${maxBytes} minus ${ENVELOPE_BYTES} envelope)`);
    let total = cur.length ? curBytes + 1 + bytes : base + bytes;
    if (cur.length && (cur.length >= maxSteps || total > budget)) { chunks.push(cur); cur = []; total = base + bytes; }
    cur.push(step); curBytes = total;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

async function runBatch(steps: Json[], extra: Json = {}): Promise<Json> {
  let last: Json = { status: 'complete', completed: 0 }; let done = 0; let offset = 0; let spent = 0; let quoted = true;
  for (const chunk of chunkSteps(steps, extra)) {
    const started = await callOk('batch_execute', { steps: chunk, compact: true, ...extra }, 20);
    last = await waitBatch(started.id, 300);
    done += Number(last.completed ?? 0);
    // The mod reports moneySpent for a completed batch, measured inside the paused batch.
    if (typeof last.moneySpent === 'number') spent += last.moneySpent; else if (Number(last.completed ?? 0) > 0) quoted = false;
    if (last.status !== 'complete') { last.failedIndex = offset + Number(last.failedStep ?? 0); break; }
    offset += chunk.length;
  }
  last.completedTotal = done; last.spentTotal = spent; last.spentQuoted = quoted;
  return last;
}

// Zoning verdict from the game's batch status and the zonable cells left in the area.
export function zoneOutcome(status: string, leftZonable: number): { ok: boolean; reason?: string } {
  if (status === 'complete' || status === 'nothing_to_zone') return leftZonable === 0 ? { ok: true } : { ok: false, reason: 'zoning_incomplete' };
  if (status === 'failed') return { ok: false, reason: 'zoning_failed' };
  if (status === 'interrupted') return { ok: false, reason: 'zoning_interrupted' };
  if (['queued', 'validating', 'applying', 'running'].includes(status)) return { ok: false, reason: 'zoning_still_running' };
  return { ok: false, reason: `zoning_status_unknown:${status}` };
}

// Grid success needs every check: streets and connector linked, the connector check passing
// when a connector was used, and the area fully zoned. The first failed check gives the reason.
export function gridOutcome(input: { linked: boolean; connectorUsed: boolean; connected: boolean; zoneStatus: string; leftZonable: number }): { ok: boolean; partial?: boolean; reason?: string } {
  if (!input.linked) return { ok: false, partial: true, reason: 'grid_built_but_not_connected' };
  if (input.connectorUsed && !input.connected) return { ok: false, partial: true, reason: 'connectivity_check_failed' };
  const zone = zoneOutcome(input.zoneStatus, input.leftZonable);
  if (!zone.ok) return { ok: false, partial: true, reason: zone.reason };
  return { ok: true };
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
    let linked = built.status === 'complete'; const notes: string[] = []; let connectorCost = 0;
    if (built.status !== 'complete') {
      if ((built.failedIndex ?? 0) < roads.length) return { ok: false, reason: 'build_failed_partial', builtRoads: built.completedTotal, error: built.error, reasons: reasonsOf(built), phases };
      // Streets are in, the connector failed (roads renumber as they are built): re-query and retry.
      const again = await callOk('grid_connectors', { x0: plan.bounds[0], z0: plan.bounds[1], x1: plan.bounds[2], z1: plan.bounds[3], top: 8 }, 20);
      for (const c of again.links ?? []) {
        const op = await call('build_road', roadStep(plan.road, connectorStart(c), c.to, false).args, 15);
        const rebuilt = op.ok ? await waitOperation(op.result.id, 30) : null;
        if (rebuilt?.status === 'complete') { connectorCost = Number(rebuilt.previewCost ?? 0); linked = true; connector = c; notes.push(`connector rebuilt (${Math.round(c.d)} m)`); break; }
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
    const verdict = gridOutcome({ linked, connectorUsed: connector !== null, connected: connector ? checks[2].connected === true : true, zoneStatus, leftZonable: Number(checks[0].zonable) });
    return {
      ok: verdict.ok, ...(verdict.partial ? { partial: true } : {}), ...quotedCost(built.spentQuoted && built.status === 'complete' ? built.spentTotal + connectorCost : undefined, Number(city0.money), Number(checks[1].money)), monthlyUpkeep: null,
      roads: steps.length, shared: plan.shared, zoned: z.zonable, leftZonable: checks[0].zonable, zone: zoneStatus, zoneMode, zoneOps,
      connected: connector ? checks[2].connected : true, ...(notes.length ? { notes } : {}), ...(verdict.reason ? { reason: verdict.reason } : {}), phases,
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
      if (r.ok || r.partial || r.reason === 'build_failed_partial')
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
    const verdict = zoneOutcome(status, Number(left.zonable));
    return { ok: verdict.ok, ...(verdict.reason ? { reason: verdict.reason } : {}), cost: 0, monthlyUpkeep: 0, status, zoned: Number(r.applied ?? r.zonable - left.zonable), replaced: r.replaced, leftZonable: left.zonable, blocks: r.blocks, phases: { zone: now() - t } };
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
      return { ok: done.status === 'complete', ...quotedCost(done.status === 'complete' ? done.previewCost : 0, Number(city0.money), money1), monthlyUpkeep: null, length: Math.round(c.d), error: done.error, ...(tried.length ? { tried } : {}), phases: { plan: planMs, build: now() - t1 } };
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
    return { ok: done.status === 'complete', ...quotedCost(done.status === 'complete' ? done.previewCost : 0, Number(city0.money), money1), ...costs, at: done.snappedPosition ? { x: Math.round(done.snappedPosition.x), z: Math.round(done.snappedPosition.z) } : undefined, error: done.error, ...(reasons.length ? { reasons } : {}), attempts: (done.attempts ?? []).length, phases: { plan: planMs, place: now() - t1 } };
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

// Traffic: widen the most congested local streets (native flow speed from traffic_hotspots).
// Highway ramps and roads that are already Medium are reported, not changed.
export async function fixTraffic(o: { max?: number; flowBelow?: number; plan?: boolean } = {}): Promise<Json> {
  const t = now(); const max = Math.max(1, Math.min(8, o.max ?? 3)); const limit = o.flowBelow ?? 35;
  const [hs, city0] = await multi([{ command: 'traffic_hotspots', args: { top: 30, minLength: 40 } }, { command: 'get_city_state' }]);
  const hot: Json[] = (hs.hotspots ?? []).filter((h: Json) => Number(h.flowPct) <= limit);
  const small = hot.filter(h => /^Small Road/.test(String(h.prefab)));
  const other = hot.filter(h => !/^Small Road/.test(String(h.prefab))).slice(0, 5).map(h => ({ prefab: h.prefab, x: h.x, z: h.z, flowPct: h.flowPct }));
  const base = { cityFlow: hs.cityFlow, meanFlowPct: hs.meanFlowPct, congested: hot.length, notUpgradable: other, phases: { plan: now() - t } };
  if (!small.length) return { ok: true, upgraded: [], note: 'no congested Small Road; remaining hotspots need wider prefabs or a second highway link', ...base };
  if (o.plan) return { ok: true, plan: true, wouldUpgrade: small.slice(0, max).map(h => ({ x: h.x, z: h.z, length: h.length, flowPct: h.flowPct })), ...base };
  const medium = await prefab('Medium Road', 'network');
  if (!medium.found || medium.locked) return { ok: false, reason: 'medium_road_unavailable', ...base };
  return mutate(async () => {
    const t1 = now(); const upgraded: Json[] = [];
    for (const h of small.slice(0, max)) {
      const op = await call('upgrade_network', { index: h.index, version: h.version, prefabIndex: medium.index, prefabVersion: medium.version, maxCost: 30000 }, 15);
      const done = op.ok ? await waitOperation(op.result.id, 60) : { status: 'failed', error: op.error };
      upgraded.push({ x: h.x, z: h.z, length: h.length, flowPct: h.flowPct, status: done.status, ...(done.status === 'complete' ? { cost: Number(done.previewCost ?? 0) } : { error: done.error, reasons: (done.placementErrors ?? []).flatMap((e: Json) => e.reasons ?? []).slice(0, 4) }) });
    }
    const money1 = Number((await callOk('get_city_state', {}, 10)).money);
    return { ok: upgraded.some(u => u.status === 'complete'), ...quotedCost(upgraded.reduce((sum, u) => sum + Number(u.cost ?? 0), 0), Number(city0.money), money1), monthlyUpkeep: null, upgraded, ...base, phases: { plan: base.phases.plan, build: now() - t1 } };
  });
}

// PURE. Waypoints -> roads. Where a segment is a short stub (under 60 m: what A* leaves when it
// steps around a lot corner), it and its neighbour become ONE road from A to C curved through B
// (the game's simple-curve mode). Corners between two long segments stay as they are: a corner
// at a node is valid, and a wide curve there would cut through the lots inside the corner. A leftover
// straight segment shorter than 12 m is merged into its neighbour's endpoint.
export function corridorRoads(points: { x: number; z: number }[]): { a: Json; b: Json; control?: Json }[] {
  const pts = points.filter((p, i) => i === 0 || Math.hypot(p.x - points[i - 1].x, p.z - points[i - 1].z) >= 1);
  const d = (p: Json, q: Json) => Math.hypot(q.x - p.x, q.z - p.z);
  const roads: { a: Json; b: Json; control?: Json }[] = []; let i = 0;
  while (i < pts.length - 1) {
    if (i + 2 < pts.length) {
      const ab = d(pts[i], pts[i + 1]), bc = d(pts[i + 1], pts[i + 2]);
      if ((ab < 60 || bc < 60) && ab >= 5 && bc >= 5 && ab + bc <= 950) { roads.push({ a: pts[i], b: pts[i + 2], control: pts[i + 1] }); i += 2; continue; }
    }
    roads.push({ a: pts[i], b: pts[i + 1] }); i += 1;
  }
  // A trailing or leading straight stub the game would refuse (< 12 m) is folded into its neighbour.
  for (let k = roads.length - 1; k >= 0; k--) {
    const r = roads[k]; if (r.control || d(r.a, r.b) >= 12 || roads.length === 1) continue;
    if (k > 0) roads[k - 1].b = r.b; else roads[1].a = r.a;
    roads.splice(k, 1);
  }
  return roads;
}

// Arterial along the mod's lot-free corridor (straight when possible, A* waypoints otherwise):
// every segment is previewed by the game in one batch, then built in one batch.
export async function buildCorridor(fromX: number, fromZ: number, toX: number, toZ: number, roadName = 'Medium Road', plan = false): Promise<Json> {
  const t = now(); const road = await prefab(roadName, 'network');
  if (!road.found) return { ok: false, reason: 'road_not_found', similar: road.similar };
  if (road.locked) return { ok: false, reason: 'road_locked' };
  const [route, city0] = await multi([{ command: 'corridor', args: { from: { x: fromX, z: fromZ }, to: { x: toX, z: toZ } } }, { command: 'get_city_state' }]);
  const planMs = now() - t;
  if (!route.found) return { ok: false, reason: 'no_corridor', phases: { plan: planMs } };
  // Geometry: the raw corridor has short stubs and sharp kinks the game rejects (InvalidShape).
  // corridorRoads() turns the waypoints into roads, replacing a kink A-B-C with one curve from A
  // to C whose control point is B.
  const pts: Json[] = route.waypoints;
  const roadsPlan = corridorRoads(pts);
  if (!roadsPlan.length) return { ok: false, reason: 'corridor_too_short', phases: { plan: planMs } };
  const info = { prefabIndex: road.index, prefabVersion: road.version };
  const step = (i: number, preview: boolean) => { const r = roadsPlan[i]; return { command: 'build_road', args: { ...info, start: { x: r.a.x, z: r.a.z }, end: { x: r.b.x, z: r.b.z }, ...(r.control ? { mode: 'curve', control: { x: r.control.x, z: r.control.z } } : {}), maxCost: 20000, ...(preview ? { previewOnly: true } : {}) } }; };
  const count = roadsPlan.length;
  return mutate(async () => {
    const t1 = now();
    const pv = await runBatch(Array.from({ length: count }, (_, i) => step(i, true)));
    const previewMs = now() - t1;
    if (pv.status !== 'complete') return { ok: false, reason: 'segment_rejected_by_game', segment: pv.failedIndex, reasons: reasonsOf(pv), waypoints: pts, phases: { plan: planMs, preview: previewMs } };
    if (plan) return { ok: true, plan: true, length: route.length, segments: count, curves: roadsPlan.filter(r => r.control).length, waypoints: pts, phases: { plan: planMs, preview: previewMs } };
    const t2 = now(); const built = await runBatch(Array.from({ length: count }, (_, i) => step(i, false)));
    const money1 = Number((await callOk('get_city_state', {}, 10)).money);
    return { ok: built.status === 'complete', ...quotedCost(built.spentQuoted && built.status === 'complete' ? built.spentTotal : undefined, Number(city0.money), money1), monthlyUpkeep: null, length: route.length, segments: count, curves: roadsPlan.filter(r => r.control).length, built: built.completedTotal, error: built.error, reasons: reasonsOf(built), phases: { plan: planMs, preview: previewMs, build: now() - t2 } };
  });
}
