// Max out: every service building gets every missing, unlocked extension (service upgrade) the game
// allows, within the cash reserve and the net floor of policy.json. An extension is placed the way
// test/upgrades.ts and test/extendall.ts do it: place_building with upgradeOf = the owner, the owner's
// position and yaw, and maxSnapDistance 128, so the game snaps it into the owner. Never free-placed.
//
// Which extension belongs to which owner is not exposed by the mod, so candidates are matched by the
// prefab name (token before the first space, or the pack/variant prefix stripped) and the game's own
// preview decides: an extension the game does not accept for that owner is skipped with its reasons.
import { call, callOk, waitOperation } from './bridge.ts';
import type { Json } from './bridge.ts';
import { prefab } from './city.ts';
import { loadPolicy, forbiddenBy } from './policy.ts';
import { floorVerdict, netFloor as floorOf } from './budget.ts';

const EXTENSION_TYPE = 'Game.Prefabs.BuildingExtensionPrefab';
const BUSY = /finish_or_cancel_current_tool_first|busy/;
const RETRIES = 6;          // owner's rule: wait 10 s and retry on the shared build tool, up to 6 times
const RETRY_MS = 10_000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
// Pollution and waste parts (owner: zero raw sewage, clean power only, no landfill, no incinerator).
const FORBIDDEN_PART = /incinerat|furnace|landfill|coal|gaspower|sewage|wastewater|exhaust filter|purification/i;
const PACK_PREFIX = /^(Pack\d+-|UbPr_|RS_|CCP\d+_|EU_|NA_)/;

// Building importance, the order of the owner's standing order; first match wins.
export const RANKS: { rank: number; name: string; rx: RegExp }[] = [
  { rank: 0, name: 'health', rx: /MedicalClinic|Hospital|DiseaseControl|MedicalCenter/i },
  { rank: 1, name: 'education', rx: /School|University|College|Academy|Library/i },
  { rank: 2, name: 'police', rx: /Police/i },
  { rank: 3, name: 'fire', rx: /FireHouse|FireStation/i },
  { rank: 4, name: 'deathcare', rx: /Cemetery|Crematorium|Deathcare/i },
  { rank: 5, name: 'garbage', rx: /Recycling|Garbage|Landfill|Incinerat/i },
  { rank: 6, name: 'power', rx: /Power|Solar|Wind|Transformer|Nuclear|Geothermal|Hydro|Battery|Electric/i },
  { rank: 7, name: 'water', rx: /Water|Pump|Sewage|Desalin|Wastewater/i },
  { rank: 8, name: 'depot', rx: /Depot|Garage|Yard|Terminal|Station|Stop|Terminus|Interface/i },
  { rank: 9, name: 'park', rx: /Park|Playground|Plaza|Pool|Court|Field|Garden|Ferris|Sunken|Bicycle|Tennis|Chirper|Dog|Skate|Basketball|Sport|Stand/i },
  { rank: 10, name: 'other', rx: /.*/ },
];
export function categoryOf(owner: string): { rank: number; name: string } {
  const r = RANKS.find(x => x.rx.test(owner)) ?? RANKS[RANKS.length - 1];
  return { rank: r.rank, name: r.name };
}

// PURE. Owner-side and extension-side names that a forbidden rule or the waste/pollution pattern hits.
export function forbiddenName(name: string, policy: Json | undefined = loadPolicy()): boolean {
  return !!forbiddenBy(policy, name) || FORBIDDEN_PART.test(name);
}

// PURE. Could this extension belong to this owner prefab? Candidate only; the game's preview decides.
// "BusDepot01 Electric Bus Maintenance" -> BusDepot01; "RS_FireHouse01_Ext01" -> RS_FireHouse01 or FireHouse01;
// "Pack7-BusStation02-Roof01" -> Pack7-BusStation02 or BusStation02.
export function ownerMatches(owner: string, ext: string): boolean {
  const token = ext.split(' ')[0].replace(/_Ext\d*$/i, '');
  const bare = token.replace(PACK_PREFIX, '');
  return [token, bare].some(t => t === owner || t.startsWith(owner + '_') || t.startsWith(owner + '-'));
}

export interface Ext { name: string; index: number; version: number; locked: boolean }
export interface Owner { prefab: string; x: number; z: number }
export interface Building { index: number; version: number; position: { x: number; z: number }; rotation: number }
export interface Task { owner: string; x: number; z: number; ext: Ext; rank: number; cat: string; cost: number; upkeep: number }
export interface Install { owner: string; x: number; z: number; ext: string; cost: number; upkeep: number; result: string }
export interface MaxOutResult {
  mode: 'plan' | 'build';
  owners: number;
  candidates: number;
  planned: Task[];
  plannedCost: number;
  plannedUpkeep: number;
  plannedByOwner: Record<string, number>;
  installs: Install[];
  spent: number;
  upkeepAdded: number;
  skipped: Record<string, number>;
  stopped: string;   // '' or the reason the run stopped early
  cash: number;
  net: number;
  netFloor: number;
  cashReserve: number;
}

function bump(map: Record<string, number>, key: string, n = 1): void { map[key] = (map[key] ?? 0) + n; }

// All extension prefabs (kind 'all'; an extension's kind is 'prop' in get_build_prefabs).
export async function extensionCatalog(): Promise<Ext[]> {
  const out: Ext[] = []; let offset = 0;
  for (let page = 0; page < 60; page++) {
    const r = await callOk('get_build_prefabs', { kind: 'all', filter: '', limit: 4096, offset }, 30);
    for (const p of r.prefabs ?? []) if (p.prefabType === EXTENSION_TYPE) out.push({ name: String(p.name), index: Number(p.index), version: Number(p.version), locked: !!p.locked });
    if (!r.truncated) break;
    offset = Number(r.nextOffset ?? offset + 4096);
  }
  return out;
}

// Service buildings from the mod (rows [prefab, x, z]); the mod caps the list at 300 rows.
export async function serviceOwners(onlyPrefab?: string): Promise<{ owners: Owner[]; capped: boolean }> {
  const s = await callOk('service_buildings', {}, 30);
  const rows: [string, number, number][] = s.services ?? [];
  const seen = new Set<string>(); const owners: Owner[] = [];
  for (const [prefabName, x, z] of rows) {
    const key = `${prefabName}@${x},${z}`; if (seen.has(key)) continue; seen.add(key);
    if (onlyPrefab && !prefabName.toLowerCase().includes(onlyPrefab.toLowerCase())) continue;
    owners.push({ prefab: prefabName, x, z });
  }
  return { owners, capped: rows.length >= 300 };
}

// The owner building at a service row (index, version, position, yaw), as test/upgrades.ts resolves it.
export async function resolveBuilding(o: Owner): Promise<Building | null> {
  const r = await callOk('get_buildings', { x: o.x, z: o.z, radius: 30, limit: 6 }, 30);
  const b = (r.buildings ?? []).find((q: Json) => q.prefab === o.prefab && Math.hypot(q.position.x - o.x, q.position.z - o.z) < 12);
  if (!b) return null;
  return {
    index: Number(b.index), version: Number(b.version),
    position: { x: Number(b.position.x), z: Number(b.position.z) },
    rotation: 2 * Math.atan2(b.rotationQuaternion[1], b.rotationQuaternion[3]) * 180 / Math.PI,
  };
}

// A building with no extension yet has no upgrade buffer: the mod answers not_a_building_with_upgrades, i.e. none installed.
export async function installedNames(b: Building): Promise<string[]> {
  const r = await call('building_upgrades', { index: b.index, version: b.version }, 30);
  if (!r.ok) {
    if (/not_a_building_with_upgrades/.test(String(r.error))) return [];
    throw new Error(`building_upgrades: ${r.error}`);
  }
  return (r.result?.upgrades ?? []).map((u: Json) => String(u.prefab));
}

// Cash and monthly net, read as the pilot and get_snapshot readers do.
export async function moneyNow(): Promise<{ cash: number; net: number }> {
  const s = await callOk('get_snapshot', {}, 10);
  return { cash: Number(s.city?.money ?? 0), net: Number(s.city?.net ?? 0) };
}

// One place_building (preview or real) with the busy retry. Returns the finished operation.
async function place(b: Building, ext: Ext, previewOnly: boolean, maxCost: number): Promise<Json> {
  const args: Json = {
    prefabIndex: ext.index, prefabVersion: ext.version,
    position: b.position, rotation: b.rotation, maxCost,
    upgradeOf: { index: b.index, version: b.version }, maxSnapDistance: 128,
    ...(previewOnly ? { previewOnly: true } : {}),
  };
  for (let t = 0; ; t++) {
    const r = await call('place_building', args, 15);
    if (!r.ok) {
      if (BUSY.test(String(r.error)) && t < RETRIES) { await sleep(RETRY_MS); continue; }
      return { status: 'refused', error: String(r.error) };
    }
    const d = await waitOperation(r.result.id, 60);
    if (d.status === 'complete') return d;
    if (BUSY.test(String(d.error)) && t < RETRIES) { await sleep(RETRY_MS); continue; }
    return d;
  }
}

function reasonsOf(d: Json): string {
  const reasons = [...new Set((d.placementErrors ?? []).flatMap((e: Json) => e.reasons ?? []))].map(String);
  const text = reasons.length ? reasons.join(',') : String(d.error ?? d.status ?? 'refused');
  return text.slice(0, 120);
}

// Costs from the prefab's catalogue entry (construction and monthly upkeep in money).
async function costsOf(name: string): Promise<{ cost: number; upkeep: number }> {
  const p = await prefab(name, 'all');
  if (!p.found) return { cost: 0, upkeep: 0 };
  return { cost: Number(p.construction ?? 0), upkeep: Number(p.monthlyUpkeep ?? p.consumptionUpkeep ?? 0) };
}

// The scan: every service owner, its installed extensions, and the candidates still to install
// (unlocked, not forbidden, not installed). Pure reads; nothing is placed.
export async function planTasks(onlyPrefab?: string): Promise<{ tasks: Task[]; skipped: Record<string, number>; owners: number; candidates: number; capped: boolean }> {
  const policy = loadPolicy();
  const catalog = await extensionCatalog();
  const { owners, capped } = await serviceOwners(onlyPrefab);
  const tasks: Task[] = []; const skipped: Record<string, number> = {}; let candidates = 0;
  const costCache = new Map<string, { cost: number; upkeep: number }>();
  for (const o of owners) {
    if (forbiddenName(o.prefab, policy)) { bump(skipped, 'forbidden_owner'); continue; }
    const matches = catalog.filter(e => ownerMatches(o.prefab, e.name));
    if (!matches.length) continue;
    const b = await resolveBuilding(o);
    if (!b) { bump(skipped, 'owner_not_found'); continue; }
    const installed = new Set(await installedNames(b));
    const cat = categoryOf(o.prefab);
    for (const e of matches) {
      candidates++;
      if (forbiddenName(e.name, policy)) { bump(skipped, 'forbidden'); continue; }
      if (e.locked) { bump(skipped, 'locked'); continue; }
      if (installed.has(e.name)) { bump(skipped, 'installed'); continue; }
      let c = costCache.get(e.name); if (!c) { c = await costsOf(e.name); costCache.set(e.name, c); }
      tasks.push({ owner: o.prefab, x: o.x, z: o.z, ext: e, rank: cat.rank, cat: cat.name, cost: c.cost, upkeep: c.upkeep });
    }
  }
  // Importance first, then cheapest first, then a stable tie-break.
  tasks.sort((a, b) => a.rank - b.rank || a.cost - b.cost || a.owner.localeCompare(b.owner) || a.x - b.x || a.z - b.z);
  return { tasks, skipped, owners: owners.length, candidates, capped };
}

// Plan (no placement) or build (preview each candidate, check the floors, install).
export async function maxOut(opts: { plan: boolean; maxSpend?: number; onlyPrefab?: string; log?: (line: string) => void }): Promise<MaxOutResult> {
  const policy = loadPolicy();
  const reserve = Number(policy.cashReserve ?? 20_000_000);
  const floor = floorOf(policy);
  const factor = Number(policy.upkeepRealFactor ?? 2.7);
  const maxSpend = Number.isFinite(opts.maxSpend) ? Number(opts.maxSpend) : 5_000_000;
  const scan = await planTasks(opts.onlyPrefab);
  const skipped = { ...scan.skipped };
  const plannedByOwner: Record<string, number> = {};
  for (const t of scan.tasks) bump(plannedByOwner, t.owner);
  const money0 = await moneyNow();
  const result: MaxOutResult = {
    mode: opts.plan ? 'plan' : 'build', owners: scan.owners, candidates: scan.candidates,
    planned: scan.tasks, plannedCost: scan.tasks.reduce((s, t) => s + t.cost, 0), plannedUpkeep: scan.tasks.reduce((s, t) => s + t.upkeep, 0),
    plannedByOwner, installs: [], spent: 0, upkeepAdded: 0, skipped, stopped: '',
    cash: money0.cash, net: money0.net, netFloor: floor, cashReserve: reserve,
  };
  if (scan.capped) bump(skipped, 'service_list_capped_300');
  if (opts.plan) return result;

  for (const t of scan.tasks) {
    if (result.spent >= maxSpend) { result.stopped = 'max_spend'; break; }
    try {
      const b = await resolveBuilding({ prefab: t.owner, x: t.x, z: t.z });
      if (!b) { bump(skipped, 'owner_gone'); continue; }
      // 1. The game's own preview: accepted or refused for this owner.
      const pv = await place(b, t.ext, true, Math.max(400_000, Math.ceil(t.cost * 1.25)));
      if (pv.status !== 'complete') { bump(skipped, `refused: ${reasonsOf(pv)}`); continue; }
      const cost = Number(pv.previewCost ?? t.cost);
      if (result.spent + cost > maxSpend) { result.stopped = 'max_spend'; break; }
      // 2. Floors, read now. The upkeep this run already added is counted in full until the game's net shows it.
      const m = await moneyNow();
      if (m.cash - cost < reserve) { bump(skipped, 'cash_reserve'); continue; }
      const verdict = floorVerdict({ net: m.net - result.upkeepAdded * factor, floor, monthlyUpkeep: t.upkeep, factor });
      if (!verdict.ok) { bump(skipped, `floor: ${verdict.reason}`); continue; }
      // 3. Install the same placement for real.
      const done = await place(b, t.ext, false, Math.max(400_000, Math.ceil(cost * 1.25)));
      if (done.status !== 'complete') { bump(skipped, `install_failed: ${reasonsOf(done)}`); continue; }
      result.installs.push({ owner: t.owner, x: t.x, z: t.z, ext: t.ext.name, cost, upkeep: t.upkeep, result: 'complete' });
      result.spent += cost; result.upkeepAdded += t.upkeep;
      opts.log?.(`INSTALL ${t.owner} (${t.x},${t.z}) + ${t.ext.name} cost ${cost} upkeep ${t.upkeep}/mo`);
    } catch (e: any) {
      // A transport error or a pending operation may have placed something: stop and inspect.
      result.stopped = `error: ${String(e?.message ?? e).slice(0, 160)}`; break;
    }
  }
  const after = await moneyNow().catch(() => ({ cash: result.cash, net: result.net }));
  result.cash = after.cash; result.net = after.net;
  return result;
}
