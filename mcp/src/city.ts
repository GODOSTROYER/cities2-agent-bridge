// Native build path: grids, zoning, links and service placement driven directly from the
// MCP server through the mod's planning queries. No PowerShell, no cell dumps: planning is
// non-pausing (the simulation keeps running), and the game is paused only inside mutate().
import { call, callOk, multi, mutate, waitBatch, waitOperation, readSession } from './bridge.ts';
import type { Json } from './bridge.ts';
import { spendVerdict, growClass, blockingNeeds, utilityOutcome, looseFrom, linePoints, wetSpan, spansWater } from './budget.ts';
import type { SpendClass } from './budget.ts';
import { diagnoseJobs } from './pilot.ts';

export const ZONES: Record<string, string> = { res: 'NA Residential Low', resmed: 'NA Residential Medium Row', resmid: 'NA Residential Medium', reshigh: 'NA Residential High', mixed: 'NA Residential Mixed', com: 'NA Commercial Low', ind: 'Industrial Manufacturing', off: 'Office Low' };
const HOUSING = ['res', 'resmed', 'resmid', 'reshigh', 'mixed'];
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
// Districts built this session whose buildings have not been seen receiving utilities yet.
export const pendingDistricts: { x: number; z: number; radius: number; builtAt: number }[] = [];

// Re-check once buildings appear: returns the districts whose buildings lack a utility and
// forgets the ones that are served.
export async function recheckDistricts(): Promise<Json[]> {
  const bad: Json[] = [];
  for (const d of [...pendingDistricts]) {
    const u = await call('utility_check', { x: d.x, z: d.z, radius: d.radius }, 20); if (!u.ok) continue;
    const verdict = u.result.verdict;
    if (verdict === 'served') pendingDistricts.splice(pendingDistricts.indexOf(d), 1);
    // One building short among dozens is a single lot problem (a park without a road), not an
    // unserved district: it must not stop growth (FAILURES #104). Three or 10% of the buildings do.
    else if (verdict === 'unserved' && Math.max(Number(u.result.buildings?.electricity ?? 0), Number(u.result.buildings?.water ?? 0), Number(u.result.buildings?.sewage ?? 0)) < Math.max(3, Number(u.result.buildings?.total ?? 0) * 0.1)) continue;
    else if (verdict === 'unserved' || verdict === 'not_connected') bad.push({ x: Math.round(d.x), z: Math.round(d.z), verdict, buildings: u.result.buildings, linked: { road: u.result.road?.linked, power: u.result.power?.linked, water: u.result.water?.linked } });
  }
  return bad;
}

export async function buildGrid(o: GridOptions): Promise<Json> {
  const phases: Record<string, number> = {}; let t = now();
  const zoneName = ZONES[o.zone]; if (!zoneName) return { ok: false, reason: `unknown_zone:${o.zone}` };
  // A locked zone must be refused BEFORE any road is built (zoning would fail afterwards).
  const zonePrefab = await prefab(zoneName, 'zone'); if (!zonePrefab.found || zonePrefab.locked) return { ok: false, reason: 'zone_prefab_locked', zone: o.zone };
  const [plan, city0] = await multi([{ command: 'plan_grid', args: { x: o.x, z: o.z, cols: o.cols, rows: o.rows, road: o.road ?? 'Small Road', maxConnector: 950 } }, { command: 'get_city_state' }]);
  phases.plan = now() - t; t = now();
  if (plan.blocked) return { ok: false, reason: 'grid_blocked', lotCells: plan.lotCells, outsideCells: plan.outsideCells, phases };
  const roads: Json[] = plan.roads.map((r: number[]) => [{ x: r[0], z: r[1] }, { x: r[2], z: r[3] }]);
  if (!roads.length) return { ok: false, reason: 'no_new_roads', phases };
  // Long connectors reach land that has no road yet; one that would cross water deeper than
  // 2 m is dropped (FAILURES #84: check before any network crosses water).
  const connectors: Json[] = [];
  for (const c of (plan.connectors ?? []).slice(0, 6)) { const wet = await waterUnder(connectorStart(c), c.to); if (!(wet.wet && wet.deepest > 2)) connectors.push(c); }
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
    // Postcondition (FAILURES #73): a district is zoned only when the game's own networks say it
    // is joined to the city by road AND by the edges that carry power and water. A grid that is
    // not gets no zoning (so no homes appear without utilities) and the call returns partial.
    const centre = { x: (rect.x0 + rect.x1) / 2, z: (rect.z0 + rect.z1) / 2 };
    const utilities = await call('utility_check', { ...centre, radius: Math.hypot(rect.x1 - rect.x0, rect.z1 - rect.z0) / 2 + 40 }, 20);
    const served = utilityOutcome(utilities.ok ? utilities.result : undefined);
    if (!served.ok && served.reason !== 'buildings_unserved') {
      const money1 = Number((await callOk('get_city_state', {}, 10)).money);
      return { ok: false, partial: true, reason: served.reason, missing: served.missing, at: { x: Math.round(centre.x), z: Math.round(centre.z) }, hint: 'roads are built but NOT zoned: join the district to the city network (link / build_line), then zone it',
        ...quotedCost(built.spentQuoted && built.status === 'complete' ? built.spentTotal + connectorCost : undefined, Number(city0.money), money1), roads: steps.length, zoned: 0, phases };
    }
    pendingDistricts.push({ ...centre, radius: Math.hypot(rect.x1 - rect.x0, rect.z1 - rect.z0) / 2 + 40, builtAt: Date.now() });
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

// Postcondition for every road, cable and pipe build (FAILURES #77, #82): a cable or pipe end
// is loose when the game shows its "not connected" icon there; a road end is loose when the
// road is an island cut off from the main road network.
export async function looseEnds(points: { x: number; z: number }[], radius = 16): Promise<Json[]> {
  if (!points.length) return [];
  const [icons, ...ends] = await multi([{ command: 'notifications', args: { type: 'Not Connected', top: 100 } }, ...points.map(p => ({ command: 'network_ends', args: { x: p.x, z: p.z, radius } }))]);
  return looseFrom(points, icons?.items ?? [], ends.map((e: Json) => e?.ends));
}

// Water under a planned line (non-pausing terrain samples).
export async function waterUnder(from: { x: number; z: number }, to: { x: number; z: number }): Promise<Json> {
  const pts = linePoints(from, to); const r = await callOk('sample_terrain', { points: pts }, 20);
  return wetSpan(pts, (r.samples ?? []).map((q: Json) => q.waterDepth));
}

const LINES: Record<string, string> = { power_low: 'Low-voltage Ground Cable', power_high: 'High-voltage Ground Cable', power_high_overhead: 'High-voltage Line', power_low_overhead: 'Low-voltage Line', water: 'Small Water Pipe', sewage: 'Small Sewage Pipe', pipe: 'Combined Small Pipe' };

// One cable or pipe between two points (ends snap to the networks and terminals there), with
// the both-ends-connected postcondition: ok only when neither end is loose afterwards.
export async function buildLine(kind: string, from: { x: number; z: number }, to: { x: number; z: number }, control?: { x: number; z: number }, plan = false): Promise<Json> {
  const name = LINES[kind] ?? kind; const net = await prefab(name, 'network');
  if (!net.found) return { ok: false, reason: 'line_prefab_not_found', similar: net.similar, kinds: Object.keys(LINES) };
  if (net.locked) return { ok: false, reason: 'line_prefab_locked', prefab: name };
  // Never lay a ground cable or pipe across water: it dams the river (FAILURES #84).
  if (!spansWater(name)) {
    const water = await waterUnder(from, control ?? to); const water2 = control ? await waterUnder(control, to) : { wet: false };
    if (water.wet || water2.wet) return { ok: false, reason: 'crosses_water', water: water.wet ? water : water2, prefab: name, hint: 'a ground cable or pipe across water acts as a dam: use power_high_overhead / power_low_overhead for the wet stretch, or route around' };
  }
  const args = { prefabIndex: net.index, prefabVersion: net.version, start: from, end: to, maxCost: 60000, ...(control ? { control, mode: 'curve' } : {}) };
  return mutate(async () => {
    const pv = await call('build_network', { ...args, previewOnly: true }, 15);
    const pvDone = pv.ok ? await waitOperation(pv.result.id, 30) : { status: 'failed', error: pv.error };
    const reasons = (d: Json) => [...new Set((d.placementErrors ?? []).flatMap((e: Json) => e.reasons ?? []))];
    if (pvDone.status !== 'complete') return { ok: false, reason: 'line_rejected_by_game', error: pvDone.error, reasons: reasons(pvDone), built: 0 };
    if (plan) return { ok: true, plan: true, prefab: name, previewCost: pvDone.previewCost };
    const op = await callOk('build_network', args, 15); const done = await waitOperation(op.id, 60);
    if (done.status !== 'complete') return { ok: false, reason: 'line_build_failed', error: done.error, reasons: reasons(done) };
    // The game clears a warning icon a few frames after the join: re-read before reporting.
    let dangling = await looseEnds([from, to]);
    for (let k = 0; k < 3 && dangling.length; k++) { await sleep(400); dangling = await looseEnds([from, to]); }
    return { ok: dangling.length === 0, ...(dangling.length ? { partial: true, reason: 'loose_end', dangling } : {}), prefab: name, cost: Number(done.previewCost ?? 0), costSource: 'quoted', created: (done.createdRoads ?? []).length };
  });
}

export interface GrowOptions { zone?: string; cols?: number; rows?: number; plan?: boolean; reserve?: number; cls?: SpendClass }

// Demand-driven growth: zone choice from the non-pausing snapshot, site from find_free_lots.
// The site search and the build run inside ONE goal (FAILURES #95): two growth calls planned at
// the same time picked overlapping land and one grid was left half built.
export async function grow(o: GrowOptions): Promise<Json> { return o.plan ? growInner(o) : mutate(() => growInner(o)); }
async function growInner(o: GrowOptions): Promise<Json> {
  const phases: Record<string, number> = {}; let t = now();
  const snap = await callOk('get_snapshot', {}, 10); const d = snap.demand ?? {}; const unemp = Number(snap.jobs?.unemp ?? 0);
  let choices = [{ k: 'res', v: d.rL }, { k: 'resmed', v: d.rM }, { k: 'resmid', v: d.rM }, { k: 'mixed', v: d.rM }, { k: 'reshigh', v: d.rH }, { k: 'com', v: d.c }, { k: 'ind', v: d.i }, { k: 'off', v: d.o }].map(c => ({ k: c.k, v: Number(c.v ?? 0) })).sort((a, b) => b.v - a.v);
  const jobs = ['com', 'ind', 'off'];
  // No unemployment gate (FAILURES #91): the demand bars decide. Unemployment with open vacancies is
  // an education mismatch; holding housing back then starves the workplaces. Only when jobs are
  // truly missing (few vacancies for the people out of work) do job zones go first.
  const noJobs = diagnoseJobs(snap.jobs, snap.servicePenalties).state === 'no_jobs';
  if (noJobs) choices = [...choices.filter(c => jobs.includes(c.k)), ...choices.filter(c => !jobs.includes(c.k))];
  if (o.zone) choices = choices.filter(c => c.k === o.zone);
  const pick = choices.find(c => c.v >= 20);
  if (!pick) return { ok: false, reason: 'demand_too_low', demand: d, unemp };
  // Never grow past a broken utility: an unserved district or a loose cable/pipe comes first.
  const blockers = blockingNeeds(snap.needs);
  if (blockers.length) return { ok: false, reason: 'fix_utilities_first', blockers };
  const unservedDistricts = o.plan ? [] : await recheckDistricts();
  if (unservedDistricts.length) return { ok: false, partial: true, reason: 'previous_district_unserved', districts: unservedDistricts, hint: 'connect it (link / build_line) before building another' };
  // Owner money policy: a new district is discretionary below the reserve (job zones while
  // unemployment is above 10% are priority and go ahead when cheap).
  const cls = o.cls ?? growClass(pick.k, unemp, pick.v); const cash = Number(snap.city?.money ?? 0);
  const want: [number, number] = [o.cols ?? 3, o.rows ?? 2];
  const sizes = ([want, [2, 2], [2, 1], [1, 1]] as [number, number][]).filter((s, i, all) => s[0] * s[1] <= want[0] * want[1] && all.findIndex(x => x[0] === s[0] && x[1] === s[1]) === i);
  const tried: string[] = [];
  for (const [cols, rows] of sizes) {
    const lots = await callOk('find_free_lots', { width: cols * 110, depth: rows * 110, count: 4, zone: HOUSING.includes(pick.k) ? 'res' : pick.k, maxLink: 900 }, 30);
    phases[`sites${cols}x${rows}`] = now() - t; t = now();
    for (const site of lots.sites ?? []) {
      // Quality floor for housing: never next to industry or on polluted ground (the score only
      // ranks what is free; when everything free is bad, buy land elsewhere instead).
      if (HOUSING.includes(pick.k) && (Number(site.toIndustry) < 250 || Number(site.pollution) > 8000)) { tried.push(`${cols}x${rows}@${site.x},${site.z}:polluted_or_near_industry`); continue; }
      const estimate = Math.round((cols * (rows + 1) + rows * (cols + 1)) * 110 * 5);
      const spend = spendVerdict({ cash, cost: estimate, cls, reserve: o.reserve });
      if (!spend.ok && !o.plan) return { ok: false, reason: spend.reason, cls, cash, estimate, reserve: spend.reserve, zone: pick.k, hint: 'owner policy: bank cash to the reserve before new districts; pass reserve or cls to override for a flagged need' };
      const r = await buildGrid({ x: site.x, z: site.z, cols, rows, zone: pick.k, plan: o.plan });
      if (r.ok || r.partial || r.reason === 'build_failed_partial')
        return { ...r, zone: pick.k, demand: pick.v, unemp, site: { x: site.x, z: site.z, cols, rows, score: site.score, toIndustry: site.toIndustry, pollution: site.pollution, noise: site.noise, air: site.air, toNoise: site.toNoise }, siteRejects: lots.rejected?.site, phases: { ...phases, ...(r.phases ?? {}) }, ...(tried.length ? { tried } : {}) };
      tried.push(`${cols}x${rows}@${site.x},${site.z}:${r.reason}`);
    }
  }
  return { ok: false, reason: 'no_free_site', zone: pick.k, tried, siteRules: 'homes are refused in noise (4000+), polluted air or ground (3000+), within 250 m of a noise source and downwind of plants and industry', hint: 'no acceptable free land: buy_tile (x,z away from industry for housing), then grow again', phases };
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
export async function link(x: number, z: number, roadName = 'Small Road', maxCost = 60000, plan = false, overWater = false): Promise<Json> {
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
      const water = await waterUnder(connectorStart(c), { x, z });
      if (water.wet && water.deepest > 2 && !overWater) { tried.push(`${Math.round(c.d)}m:crosses_water(${water.metres}m, ${water.deepest}m deep)`); continue; }
      if (plan) return { ok: true, plan: true, length: Math.round(c.d), previewCost: pvDone.previewCost, from: c.from, phases: { plan: planMs, preview: now() - t1 } };
      const op = await callOk('build_road', args, 15); const done = await waitOperation(op.id, 60);
      const money1 = Number((await callOk('get_city_state', {}, 10)).money);
      const dangling = done.status === 'complete' ? await looseEnds([connectorStart(c), { x, z }]) : [];
      return { ok: done.status === 'complete' && dangling.length === 0, ...(dangling.length ? { partial: true, reason: 'loose_end', dangling } : {}), ...quotedCost(done.status === 'complete' ? done.previewCost : 0, Number(city0.money), money1), monthlyUpkeep: null, length: Math.round(c.d), error: done.error, ...(tried.length ? { tried } : {}), phases: { plan: planMs, build: now() - t1 } };
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
    const t1 = now(); const cap = Math.min(1_000_000, maxCost ?? Math.max(150000, Math.ceil(Number(costs.construction ?? 0) * 1.2))); // the mod accepts budgets up to 1,000,000
    const op = await callOk('place_building', { prefabIndex: info.index, prefabVersion: info.version, position: cands[0].position, rotation: cands[0].rotation, candidates: cands.map(c => ({ position: c.position, rotation: c.rotation })), maxCost: cap }, 20);
    const done = await waitOperation(op.id, 120);
    const money1 = Number((await callOk('get_city_state', {}, 10)).money);
    const reasons = [...new Set((done.placementErrors ?? []).flatMap((e: Json) => e.reasons ?? []))].slice(0, 6);
    // Postcondition (FAILURES #86): the game accepts a building that touches no road (a park was
    // left without road, power and water). Check the road edge; move it along the other
    // candidates, and bulldoze it when none gives it a road.
    if (done.status === 'complete' && done.snappedPosition) {
      const roadOf = async (p: Json) => { const b = (await callOk('get_buildings', { x: p.x, z: p.z, radius: 6, limit: 3 }, 15)).buildings ?? []; const me = b.find((q: Json) => String(q.prefab) === name) ?? b[0]; return me ? { id: { index: me.index, version: me.version }, road: Number(me.roadEdge?.index ?? 0) > 0 || !(me.issues ?? []).includes('no_road_connection') } : null; };
      let me = await roadOf(done.snappedPosition); let moved = 0;
      for (const c of cands.slice(1, 6)) {
        if (!me || me.road) break;
        const mv = await call('relocate_building', { moveIndex: me.id.index, moveVersion: me.id.version, prefabIndex: info.index, prefabVersion: info.version, position: c.position, rotation: c.rotation, maxCost: cap }, 20);
        const mvDone = mv.ok ? await waitOperation(mv.result.id, 60) : null; moved++;
        if (mvDone?.status === 'complete' && mvDone.snappedPosition) { done.snappedPosition = mvDone.snappedPosition; me = await roadOf(mvDone.snappedPosition); }
      }
      if (me && !me.road) {
        const rm = await call('demolish', me.id, 15); if (rm.ok) await waitOperation(rm.result.id, 30);
        return { ok: false, reason: 'no_road_connection', hint: 'placed, found without a road at every candidate tried, removed again', ...costs, tried: moved + 1, phases: { plan: planMs, place: now() - t1 } };
      }
    }
    return { ok: done.status === 'complete', ...quotedCost(done.status === 'complete' ? done.previewCost : 0, Number(city0.money), money1), ...costs, at: done.snappedPosition ? { x: Math.round(done.snappedPosition.x), z: Math.round(done.snappedPosition.z) } : undefined, error: done.error, ...(reasons.length ? { reasons } : {}), attempts: (done.attempts ?? []).length, phases: { plan: planMs, place: now() - t1 } };
  });
}

// Moves a placed building (a noisy wind turbine, a polluting plant) to a roadside site near
// (x,z). The mod's lot finder applies the site rules for polluters by itself: no homes within
// 300 m, and for air polluters no homes in the plume. Postcondition: the new place is joined to
// the road, power and water networks.
export async function relocate(index: number, version: number, x: number, z: number, radius = 400, plan = false): Promise<Json> {
  const t = now(); const info = await callOk('inspect_entity', { index, version }, 10);
  if (!(info.components ?? []).includes('Game.Buildings.Building')) return { ok: false, reason: 'target_is_not_a_building' };
  const name = String(info.prefab); const pf = await prefab(name, 'building');
  if (!pf.found) return { ok: false, reason: 'prefab_not_found', prefab: name };
  const [lots, city0] = await multi([{ command: 'find_roadside_lots', args: { prefab: name, x, z, radius, count: 16 } }, { command: 'get_city_state' }]);
  const cands: Json[] = lots.candidates ?? [];
  if (!cands.length) return { ok: false, reason: 'no_roadside_site', prefab: name, rejected: lots.rejected, polluter: lots.polluter, phases: { plan: now() - t } };
  if (plan) return { ok: true, plan: true, prefab: name, sites: lots.found, nearest: cands[0], polluter: lots.polluter, rejected: lots.rejected, phases: { plan: now() - t } };
  return mutate(async () => {
    const t1 = now();
    const op = await callOk('relocate_building', { moveIndex: index, moveVersion: version, prefabIndex: pf.index, prefabVersion: pf.version, position: cands[0].position, rotation: cands[0].rotation, candidates: cands.map(c => ({ position: c.position, rotation: c.rotation })), maxCost: 150000 }, 20);
    const done = await waitOperation(op.id, 120);
    const money1 = Number((await callOk('get_city_state', {}, 10)).money);
    const at = done.snappedPosition ? { x: Math.round(done.snappedPosition.x), z: Math.round(done.snappedPosition.z) } : undefined;
    const reasons = [...new Set((done.placementErrors ?? []).flatMap((e: Json) => e.reasons ?? []))].slice(0, 6);
    if (done.status !== 'complete') return { ok: false, reason: 'relocation_failed', error: done.error, ...(reasons.length ? { reasons } : {}), prefab: name, phases: { plan: t1 - t, move: now() - t1 } };
    const u = at ? await call('utility_check', { x: at.x, z: at.z, radius: 120 }, 20) : null;
    const served = utilityOutcome(u?.ok ? u.result : undefined);
    return { ok: served.ok || served.reason === 'buildings_unserved', ...(served.ok ? {} : { partial: true, reason: served.reason, missing: served.missing }), prefab: name, at, toHomes: cands[0].toHomes, polluter: lots.polluter, ...quotedCost(done.previewCost, Number(city0.money), money1), phases: { plan: t1 - t, move: now() - t1 } };
  });
}

// Development tree: points from milestones buy nodes that unlock buildings (college, bus lines,
// wider roads). The purchase goes through the game's own system; the node is re-read to confirm.
export async function devTree(all = false): Promise<Json> { return callOk('dev_tree', { all }, 15); }
export async function unlockNode(name: string): Promise<Json> {
  return mutate(async () => {
    const r = await call('purchase_dev_node', { name }, 15);
    if (!r.ok) return { ok: false, reason: String(r.error?.message ?? r.error ?? 'refused') };
    for (let k = 0; k < 10; k++) {
      await sleep(200); const t = await callOk('dev_tree', { all: true }, 15); const node = (t.nodes ?? []).find((n: Json) => n.name === r.result.name);
      if (node?.bought) { invalidatePrefabCache(); return { ok: true, name: node.name, service: node.service, cost: node.cost, pointsLeft: t.points }; }
    }
    return { ok: false, reason: 'purchase_not_observed', name };
  });
}

// Tile purchase: adjacency/dryness ranking in the mod, the game's own price for the selection
// previewed first (so a purchase never fails on funds), then the purchase.
export async function buyTile(o: { n?: number; max?: number; x?: number; z?: number; plan?: boolean; reserve?: number; cls?: SpendClass; allowUnreachable?: boolean }): Promise<Json> {
  const t = now(); const n = Math.max(1, Math.min(3, o.n ?? 1));
  const [opts, city0] = await multi([{ command: 'tile_options', args: { top: Math.max(3, n), ...(o.x !== undefined && o.z !== undefined ? { x: o.x, z: o.z } : {}) } }, { command: 'get_city_state' }]);
  // Never buy land that cannot be reached (FAILURES #98: 316,000 went into tiles behind the
  // highway and the lake). A tile counts as reachable when a lot-free connector of up to 950 m
  // from the existing road network ends inside it; highways are barriers for connectors and
  // connectors over deep water are dropped. allowUnreachable is for road work the agent plans.
  let options: Json[] = opts.tiles ?? []; const skipped: Json[] = [];
  if (!o.allowUnreachable) {
    const keep: Json[] = [];
    // An unowned tile is "outside" for the connector search, so reachability is judged from the
    // owned side: a local road edge within 950 m of the tile's edge, with no deep water between.
    for (const t of options.slice(0, 6)) {
      if (keep.length >= n) break;
      const cx = (t.x0 + t.x1) / 2, cz = (t.z0 + t.z1) / 2;
      const near = await callOk('get_network_edges', { x: cx, z: cz, radius: Math.hypot(t.x1 - t.x0, t.z1 - t.z0) / 2 + 950 }, 30);
      let reachable = false;
      for (const e of (near.edges ?? []).filter((q: Json) => !/Highway|Cable|Line|Pipe/.test(String(q.prefab))).slice(0, 400)) {
        const a = e.curve[e.curve.length - 1]; const px = Math.max(t.x0, Math.min(t.x1, a.x)), pz = Math.max(t.z0, Math.min(t.z1, a.z));
        if (Math.hypot(px - a.x, pz - a.z) > 950) continue;
        const wet = await waterUnder({ x: a.x, z: a.z }, { x: px, z: pz }); if (wet.wet && wet.deepest > 2) continue;
        reachable = true; break;
      }
      if (reachable) keep.push(t); else skipped.push({ x: [t.x0, t.x1], z: [t.z0, t.z1] });
    }
    options = keep;
    if (!options.length) return { ok: false, reason: 'no_reachable_tile', skipped, hint: 'every adjacent tile is behind a highway or water: build a crossing (underpass, bridge) first, or pass allowUnreachable for planned road work', phases: { plan: now() - t } };
  }
  const picks: Json[] = options.slice(0, n);
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
    const spend = spendVerdict({ cash: money, cost, cls: o.cls ?? 'discretionary', reserve: o.reserve });
    if (!spend.ok) return { ok: false, reason: spend.reason, reserve: spend.reserve, hint: 'owner policy: tile purchases wait until cash stays above the reserve', ...base };
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
  // Road hierarchy ladder (FAILURES #97): a congested Small Road becomes a Medium Road, a congested
  // Medium Road a Large Road once that is unlocked. Anything else (highways, already large) is
  // reported as needing a parallel route or a junction redesign.
  const large = await prefab('Large Road', 'network'); const medium = await prefab('Medium Road', 'network');
  const step = (h: Json): Json | null => nextRoad(String(h.prefab), medium.found && !medium.locked, large.found && !large.locked) === 'Medium Road' ? medium : nextRoad(String(h.prefab), medium.found && !medium.locked, large.found && !large.locked) === 'Large Road' ? large : null;
  const small = hot.filter(h => step(h) !== null);
  const other = hot.filter(h => step(h) === null).slice(0, 5).map(h => ({ prefab: h.prefab, x: h.x, z: h.z, flowPct: h.flowPct }));
  const base = { cityFlow: hs.cityFlow, meanFlowPct: hs.meanFlowPct, congested: hot.length, notUpgradable: other, phases: { plan: now() - t } };
  if (!small.length) return { ok: true, upgraded: [], note: 'no congested road with a wider prefab left; the remaining hotspots need a parallel route, another highway link or a junction redesign', ...base };
  if (o.plan) return { ok: true, plan: true, wouldUpgrade: small.slice(0, max).map(h => ({ x: h.x, z: h.z, length: h.length, flowPct: h.flowPct, from: h.prefab, to: step(h)!.name ?? nextRoad(String(h.prefab), true, true) })), ...base };
  return mutate(async () => {
    const t1 = now(); const upgraded: Json[] = [];
    for (const h of small.slice(0, max)) {
      const to = step(h)!;
      const op = await call('upgrade_network', { index: h.index, version: h.version, prefabIndex: to.index, prefabVersion: to.version, maxCost: 60000 }, 15);
      const done = op.ok ? await waitOperation(op.result.id, 60) : { status: 'failed', error: op.error };
      upgraded.push({ x: h.x, z: h.z, length: h.length, flowPct: h.flowPct, from: h.prefab, to: nextRoad(String(h.prefab), true, true), status: done.status, ...(done.status === 'complete' ? { cost: Number(done.previewCost ?? 0) } : { error: done.error, reasons: (done.placementErrors ?? []).flatMap((e: Json) => e.reasons ?? []).slice(0, 4) }) });
    }
    const money1 = Number((await callOk('get_city_state', {}, 10)).money);
    return { ok: upgraded.some(u => u.status === 'complete'), ...quotedCost(upgraded.reduce((sum, u) => sum + Number(u.cost ?? 0), 0), Number(city0.money), money1), monthlyUpkeep: null, upgraded, ...base, phases: { plan: base.phases.plan, build: now() - t1 } };
  });
}

// Power ahead of need (headroom rule): one small coal plant where the polluter site rules allow
// (no homes within 300 m, none downwind), then a transformer beside it and a high-voltage cable
// between the two terminals, because the game flags a plant whose high-voltage terminal is unused.
export async function addPower(plan = false): Promise<Json> {
  // Utility land first (FAILURES #103): around the plants and the landfill that already exist,
  // where the polluter rules were satisfied before; only then around the homes.
  const sb = await callOk('service_buildings', {}, 20); const centre = sb.homes ?? { x: 0, z: 0 };
  const utility: { x: number; z: number }[] = (sb.services ?? []).filter((b: Json) => /PowerPlant|Landfill/.test(String(b[0]))).map((b: Json) => ({ x: Number(b[1]), z: Number(b[2]) }));
  let sites: Json = { candidates: [] };
  for (const u of utility.reverse()) { sites = await callOk('find_roadside_lots', { prefab: 'SmallCoalPowerPlant01', x: u.x, z: u.z, radius: 450, count: 4 }, 30); if ((sites.candidates ?? []).length) break; }
  if (!(sites.candidates ?? []).length) sites = await callOk('find_roadside_lots', { prefab: 'SmallCoalPowerPlant01', x: centre.x, z: centre.z, radius: 2000, count: 4 }, 30);
  const site = (sites.candidates ?? [])[0]; if (!site) return { ok: false, reason: 'no_site_for_a_plant', rejected: sites.rejected, hint: 'no roadside site passes the polluter rules: the agent must open land (arterial) or unlock a cleaner plant' };
  if (plan) return { ok: true, plan: true, at: site.position, toHomes: site.toHomes };
  const terminal = async (prefabName: string, near: { x: number; z: number }) => { for (let k = 0; k < 8; k++) { await sleep(500); const n = await callOk('notifications', { type: 'Powerline Not Connected', top: 30 }, 15); const hit = (n.items ?? []).filter((i: Json) => i.ownerPrefab === prefabName && i.type === 'Powerline Not Connected').sort((a: Json, b: Json) => Math.hypot(a.x - near.x, a.z - near.z) - Math.hypot(b.x - near.x, b.z - near.z))[0]; if (hit && Math.hypot(hit.x - near.x, hit.z - near.z) < 200) return hit; } return null; };
  const plant = await placeService('SmallCoalPowerPlant01', site.position.x, site.position.z, 120);
  if (!plant.ok) return { ok: false, reason: 'plant_not_placed', detail: plant.reason ?? plant.error };
  const out: Json = { ok: true, plant: plant.at, cost: Number(plant.cost ?? 0) };
  const a = await terminal('SmallCoalPowerPlant01', plant.at);
  if (!a) return out; // no warning raised: nothing to join
  const tr = await placeService('TransformerStation01', plant.at.x, plant.at.z, 300);
  if (!tr.ok) return { ...out, partial: true, reason: 'transformer_not_placed', loose: a };
  out.cost += Number(tr.cost ?? 0); const b = await terminal('TransformerStation01', tr.at);
  if (!b) return { ...out, partial: true, reason: 'transformer_terminal_not_found', loose: a };
  const line = await buildLine('power_high', { x: a.x, z: a.z }, { x: b.x, z: b.z });
  return line.ok ? { ...out, cost: out.cost + Number(line.cost ?? 0), transformer: tr.at } : { ...out, partial: true, reason: line.reason ?? 'cable_failed', loose: a };
}

// A continuous wide corridor (road hierarchy): every road edge on the network path between two
// points is upgraded to the given prefab (highways and edges already that wide are skipped).
// Flow of the corridor is measured before; measure again after a few minutes with traffic_hotspots.
export async function upgradeCorridor(from: { x: number; z: number }, to: { x: number; z: number }, roadName = 'Large Road', plan = false): Promise<Json> {
  const road = await prefab(roadName, 'network'); if (!road.found || road.locked) return { ok: false, reason: 'road_unavailable', road: roadName };
  const near = async (p: { x: number; z: number }) => { const n = (await callOk('get_network', { x: p.x, z: p.z, radius: 60, limit: 60 }, 20)).nodes ?? []; return n.sort((a: Json, b: Json) => Math.hypot(a.position.x - p.x, a.position.z - p.z) - Math.hypot(b.position.x - p.x, b.position.z - p.z))[0]; };
  const a = await near(from), b = await near(to); if (!a || !b) return { ok: false, reason: 'no_road_node_near_an_end' };
  const path = await callOk('trace_network', { fromIndex: a.index, fromVersion: a.version, toIndex: b.index, toVersion: b.version }, 20);
  if (!path.connected) return { ok: false, reason: 'ends_not_connected' };
  const edges: Json[] = path.edges ?? []; if (plan) return { ok: true, plan: true, edges: edges.length, road: roadName };
  return mutate(async () => {
    let done = 0, skipped = 0, cost = 0; const refused: string[] = [];
    for (const e of edges) {
      const op = await call('upgrade_network', { index: e.index, version: e.version, prefabIndex: road.index, prefabVersion: road.version, maxCost: 80000 }, 15);
      if (!op.ok) { skipped++; continue; }
      const r = await waitOperation(op.result.id, 60);
      if (r.status === 'complete') { done++; cost += Number(r.previewCost ?? 0); } else refused.push(String([...new Set((r.placementErrors ?? []).flatMap((x: Json) => x.reasons ?? []))][0] ?? r.error));
    }
    return { ok: done > 0, upgraded: done, skipped, refused: refused.slice(0, 5), edges: edges.length, road: roadName, cost, costSource: 'quoted' };
  });
}

// PURE. The next wider two-way road for a congested one, or null when there is none.
export function nextRoad(prefabName: string, mediumOpen: boolean, largeOpen: boolean): string | null {
  if (/Highway|Oneway|Bridge|Divided|Asymmetric|Gravel|Path/i.test(prefabName)) return null;
  if (/^Small Road/.test(prefabName)) return mediumOpen ? 'Medium Road' : null;
  if (/^Medium Road/.test(prefabName)) return largeOpen ? 'Large Road' : null;
  return null;
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
    const dangling = built.status === 'complete' ? await looseEnds([roadsPlan[0].a, roadsPlan[roadsPlan.length - 1].b]) : [];
    return { ok: built.status === 'complete' && dangling.length === 0, ...(dangling.length ? { partial: true, reason: 'loose_end', dangling } : {}), ...quotedCost(built.spentQuoted && built.status === 'complete' ? built.spentTotal : undefined, Number(city0.money), money1), monthlyUpkeep: null, length: route.length, segments: count, curves: roadsPlan.filter(r => r.control).length, built: built.completedTotal, error: built.error, reasons: reasonsOf(built), phases: { plan: planMs, preview: previewMs, build: now() - t2 } };
  });
}

// A grid built by buildGrid hangs off the network by one connector, which becomes the local
// bottleneck once the block fills. This adds further lot-free links from other sides of the
// rectangle (previewed by the game, then built), at least `spacing` metres apart.
export async function addConnections(x0: number, z0: number, x1: number, z1: number, count = 2, roadName = 'Small Road', plan = false): Promise<Json> {
  const t = now(); const road = await prefab(roadName, 'network');
  if (!road.found || road.locked) return { ok: false, reason: 'road_unavailable' };
  const r = await callOk('grid_connectors', { x0, z0, x1, z1, maxLength: 300, top: 40 }, 20);
  const links: Json[] = (r.links ?? []).filter((l: Json) => Number(l.d) >= 12);
  const spacing = Math.max(100, Math.min(x1 - x0, z1 - z0) * 0.6);
  const picks: Json[] = [];
  for (const l of links) { if (picks.length >= count * 3) break; if (picks.every(p => Math.hypot(p.to.x - l.to.x, p.to.z - l.to.z) >= spacing)) picks.push(l); }
  if (!picks.length) return { ok: false, reason: 'no_lot_free_link', tested: r.tested, phases: { plan: now() - t } };
  return mutate(async () => {
    const t1 = now(); const built: Json[] = []; const tried: string[] = [];
    for (const l of picks) {
      if (built.length >= count) break;
      const args = { prefabIndex: road.index, prefabVersion: road.version, start: connectorStart(l), end: l.to, maxCost: ROAD_CAP };
      const pv = await call('build_road', { ...args, previewOnly: true }, 15);
      const pvDone = pv.ok ? await waitOperation(pv.result.id, 30) : { status: 'failed', error: pv.error };
      if (pvDone.status !== 'complete') { tried.push(`${Math.round(l.to.x)},${Math.round(l.to.z)}:${pvDone.error ?? 'rejected'}`); continue; }
      if (plan) { built.push({ to: l.to, length: Math.round(l.d), previewCost: pvDone.previewCost }); continue; }
      const op = await call('build_road', args, 15); const done = op.ok ? await waitOperation(op.result.id, 60) : { status: 'failed', error: op.error };
      if (done.status === 'complete') built.push({ to: l.to, length: Math.round(l.d), cost: Number(done.previewCost ?? 0) }); else tried.push(`${Math.round(l.to.x)},${Math.round(l.to.z)}:${done.error}`);
    }
    return { ok: built.length > 0, ...(plan ? { plan: true } : {}), added: built, cost: built.reduce((s, b) => s + Number(b.cost ?? 0), 0), costSource: 'quoted', ...(tried.length ? { tried } : {}), phases: { plan: t1 - t, build: now() - t1 } };
  });
}

// Removes one road edge by id (for undoing a road this session built). Buildings are never
// touched: the target must be a road edge reported by traffic_hotspots / notifications / edges.
export async function removeRoad(index: number, version: number): Promise<Json> {
  return mutate(async () => {
    const op = await call('demolish', { index, version }, 15);
    const done = op.ok ? (op.result.id ? await waitOperation(op.result.id, 30) : op.result) : { status: 'failed', error: op.error };
    return { ok: done.status === 'complete', status: done.status, error: done.error };
  });
}
