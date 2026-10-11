// Native city-services planner: the TypeScript port of services.ps1 (same intent, same rules).
// decideServices() is pure and fed with snapshot/building/gap data; fixServices() is the only
// part that talks to the game (non-pausing reads, then placeService() for the chosen needs).
import { serviceTable, headroomFor, tableLine, utilityAlerts } from './headroom.ts';
import { RESERVE, floorVerdict } from './budget.ts';
import { recordFactors, recordAction, assess, readJsonl, HISTORY_PATH, ACTIONS_PATH } from './happiness.ts';
import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { callOk, multi, REPO } from './bridge.ts';
import type { Json } from './bridge.ts';
import { placeService } from './city.ts';

export interface Rule { t: string; need: string; rx: RegExp; prefabs: string[]; cov?: string; minPop: number; spacing: number }

export const RULES: Rule[] = [
  { t: 'health', need: 'health', rx: /^(MedicalClinic|Hospital)/, prefabs: ['MedicalClinic01', 'MedicalClinic02'], cov: 'Healthcare', minPop: 300, spacing: 700 },
  { t: 'deathcare', need: 'deathcare', rx: /^(Cemetery|Crematorium)/, prefabs: ['Crematorium01', 'Cemetery02', 'Cemetery01'], minPop: 500, spacing: 2500 },
  { t: 'fire', need: 'fire', rx: /^(FireHouse|RS_FireHouse|FireStation)/, prefabs: ['FireHouse01', 'RS_FireHouse01', 'FireHouse02'], cov: 'FireRescue', minPop: 600, spacing: 900 },
  { t: 'police', need: 'police', rx: /^(PoliceStation|RS_PoliceStation|CCP5_PoliceStation)/, prefabs: ['PoliceStation02', 'PoliceStation01'], cov: 'Police', minPop: 800, spacing: 900 },
  { t: 'school', need: 'education', rx: /^ElementarySchool/, prefabs: ['ElementarySchool01', 'ElementarySchool02'], cov: 'Education', minPop: 600, spacing: 900 },
  { t: 'highschool', need: 'education_high', rx: /^HighSchool/, prefabs: ['HighSchool02', 'HighSchool01'], minPop: 2500, spacing: 2000 },
  { t: 'college', need: 'education_college', rx: /College/, prefabs: ['College01'], minPop: 6000, spacing: 3000 },
  { t: 'university', need: 'education_university', rx: /University/, prefabs: ['RS_University01', 'TechnicalUniversity01'], minPop: 9000, spacing: 3000 },
  { t: 'post', need: 'post', rx: /^(PostOffice|PostSorting)/, prefabs: ['PostOffice01', 'PostOffice02'], cov: 'PostService', minPop: 1500, spacing: 1500 },
  { t: 'garbage', need: 'garbage', rx: /^(Landfill|Incinerat|Recycling)/, prefabs: ['RecyclingCenter01', 'Landfill01', 'IncinerationPlant01'], minPop: 1000, spacing: 3000 },
  { t: 'entertainment', need: 'entertainment', rx: /Park|Playground|Plaza/, prefabs: ['ChirperPark01', 'Playground01', 'CityPark05', 'CityPark01'], cov: 'Park', minPop: 300, spacing: 350 },
  { t: 'telecom', need: 'telecom', rx: /RadioMast|ServerFarm|Telecom/, prefabs: ['RadioMast01'], minPop: 1000, spacing: 1500 },
];

export interface Center { n: number; x: number; z: number }
export interface Gap { uncoveredPct: number; gapClusters: { x: number; z: number; homes: number }[] }
export interface Buildings { services: [string, number, number][]; homes: Center; industry: Center }
// Where people live: [x, z, homes] per cell (mod home_clusters).
export type Cluster = [number, number, number];

export interface ServicesInput {
  // Headroom per rule type (headroom.ts): low/over/none means capacity is added this cycle,
  // ahead of complaints; over/none is critical (the reserve does not hold it back).
  headroom?: Record<string, { status: string; pct: number | null; projected: number | null }>;
  snap: Json;
  buildings: Buildings;
  gaps: Record<string, Gap>;
  cooldown: Record<string, string>;
  nowMs: number;
  cashFloor?: number;
  uncoveredShare?: number;
  clusters?: Cluster[];
  perRule?: number; // placements per rule in one call (only entertainment uses more than one)
}

export interface Need {
  t: string; need: string; prefabs: string[]; x: number; z: number; have: number;
  uncoveredPct: number; escalated: boolean; critical: boolean; why: string;
  distance: number | null; // metres to the nearest existing building of this rule, null when none exists
}

const COOLDOWN_MS = 10 * 60 * 1000;
const inCooldown = (iso: string | undefined, nowMs: number): boolean => {
  if (!iso) return false;
  const t = Date.parse(iso);
  return !Number.isNaN(t) && nowMs - t < COOLDOWN_MS;
};
const avg = (xs: number[]): number => xs.reduce((s, v) => s + v, 0) / xs.length;

// Centroid of the matching services, else the homes centroid (utilities).
function anchor(services: [string, number, number][], rx: RegExp, homes: Center): { x: number; z: number } {
  const hit = services.filter(s => rx.test(s[0]));
  if (hit.length) return { x: Math.round(avg(hit.map(s => s[1]))), z: Math.round(avg(hit.map(s => s[2]))) };
  return { x: homes.x, z: homes.z };
}

type Pt = { x: number; z: number };
const metres = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.z - b.z);
const nearestTo = (p: Pt, pts: Pt[]): number => Math.min(...pts.map(q => metres(p, q)));
const rotate = <T,>(xs: T[], by: number): T[] => {
  const k = by % xs.length;
  return [...xs.slice(k), ...xs.slice(0, k)];
};

// Where the next building of a rule goes. existing = buildings already standing, planned = picks made earlier in
// this call. Returns null when the city is already dense enough for the rule (nothing worth adding).
function placement(rule: Rule, existing: Pt[], planned: Pt[], gap: Gap | undefined, share: number,
  uncoveredShare: number, clusters: Cluster[] | undefined, buildings: Buildings): { at: Pt; distance: number | null } | null {
  const all = [...existing, ...planned];
  const cluster = gap?.gapClusters?.[0];

  // First building of this rule: the original targeting (gap cluster, else homes centroid; garbage -> industry).
  if (all.length === 0) {
    const at = rule.t === 'garbage' && buildings.industry.n > 0 ? buildings.industry
      : cluster ? { x: Number(cluster.x), z: Number(cluster.z) }
      : buildings.homes;
    return { at: { x: at.x, z: at.z }, distance: null };
  }

  // a. A coverage gap applies: the gap cluster (a cluster already picked in this call does not count again).
  if (rule.cov && share > uncoveredShare && cluster) {
    const gapAt = { x: Number(cluster.x), z: Number(cluster.z) };
    if (!planned.some(p => metres(p, gapAt) < rule.spacing)) {
      return { at: gapAt, distance: Math.round(nearestTo(gapAt, all)) };
    }
  }

  // No cluster data: the old target, once per call.
  if (!clusters || clusters.length === 0) {
    if (planned.length > 0) return null;
    const at = rule.t === 'garbage' && buildings.industry.n > 0 ? buildings.industry
      : cluster ? { x: Number(cluster.x), z: Number(cluster.z) }
      : buildings.homes;
    return { at: { x: at.x, z: at.z }, distance: Math.round(nearestTo(at, all)) };
  }

  // b. The populated cluster (>= 10 homes) furthest from every existing building of this rule.
  let best: { at: Pt; d: number } | null = null;
  for (const c of clusters) {
    if (Number(c[2]) < 10) continue;
    const at = { x: Number(c[0]), z: Number(c[1]) };
    const d = nearestTo(at, all);
    if (!best || d > best.d) best = { at, d };
  }
  if (!best || best.d < rule.spacing) return null; // dense enough already
  return { at: best.at, distance: Math.round(best.d) };
}

export function decideServices(input: ServicesInput): Need[] {
  const { snap, buildings, gaps, cooldown, nowMs } = input;
  const cashFloor = input.cashFloor ?? 250000;
  const uncoveredShare = input.uncoveredShare ?? 0.08; // full coverage is the target: a gap above 8% of homes is unmet need
  const perRule = Math.max(1, Math.floor(Number(input.perRule ?? 1)) || 1);
  const needs: Json = snap?.needs ?? {};
  const pop = Number(snap?.city?.pop ?? 0);
  const money = Number(snap?.city?.money ?? 0);
  const net = Number(snap?.city?.net ?? 0);

  // Escalated = the mod says "build" for this need and it was not built in the last 10 minutes.
  // Escalated: the mod's score reached the threshold, or a standing signal is strong on its own
  // (>= 10 notification icons, or >= 20 dead/sick citizens) even without chirps (FAILURES #45).
  const strong = (v: Json) => Number(v?.icons ?? 0) >= 10 || Number(v?.dead ?? 0) + Number(v?.sick ?? 0) >= 20;
  const escalated = Object.keys(needs).filter(k =>
    k !== 'iconsTop' && (needs[k]?.action === 'build' || strong(needs[k])) && !inCooldown(cooldown?.[k], nowMs));

  const out: Need[] = [];
  for (const rule of RULES) {
    let isEsc = escalated.includes(rule.need);
    const have = buildings.services.filter(s => rule.rx.test(s[0]));
    // A service that already exists needs a strong, sustained signal before another building
    // is added (6 dead and a wobbling icon count scored 3/3 with a cemetery already working):
    // 3+ chirps, 10+ icons, dead+sick above max(20, 1% of the population), or a happiness factor <= -2.
    const sig = needs[rule.need] ?? {};
    const sustained = Number(sig.chirps ?? 0) >= 3 || Number(sig.icons ?? 0) >= 10 || Number(sig.dead ?? 0) + Number(sig.sick ?? 0) >= Math.max(20, pop / 100)
      || Number(sig.factor ?? 0) <= -2;
    isEsc = isEsc && (have.length === 0 || sustained);
    if (pop < rule.minPop && !isEsc) continue;
    if ((rule.t === 'college' || rule.t === 'university') && have.length > 0 && !(input.headroom?.[rule.t] && input.headroom[rule.t].status !== 'ok')) continue; // one each until capacity says more
    const gap = rule.cov ? gaps?.[rule.cov] : undefined;
    const share = gap ? Number(gap.uncoveredPct ?? 0) / 100 : 0;
    const room = input.headroom?.[rule.t]; const short = !!room && room.status !== 'ok';
    const missing = isEsc || have.length === 0 || (!!rule.cov && share > uncoveredShare) || short;
    if (!missing) continue;
    if (net < 0 && !isEsc && !short) continue; // upkeep discipline: no new permanent upkeep while losing money

    const pct = Math.round(share * 100);
    const existing: Pt[] = have.map(s => ({ x: Number(s[1]), z: Number(s[2]) }));
    const planned: Pt[] = [];
    // Several placements only for entertainment (parks spread out); each pick counts as a building for the next.
    const copies = rule.t === 'entertainment' ? perRule : 1;
    for (let i = 0; i < copies; i++) {
      const pick = placement(rule, existing, planned, gap, share, uncoveredShare, input.clusters, buildings);
      if (!pick) break;
      planned.push(pick.at);
      // Park variety: rotate the prefab list so successive parks differ.
      const prefabs = rule.t === 'entertainment' ? rotate(rule.prefabs, have.length + i) : rule.prefabs;
      const base = short && !isEsc ? `capacity ${room!.pct ?? '-'}% now, ${room!.projected ?? '-'}% with planned growth (target under 78%)`
        : isEsc ? `escalated ${needs[rule.need]?.score ?? ''}`.trim()
        : have.length === 0 && i === 0 ? 'none built'
        : pct > 0 ? `${pct}% homes uncovered`
        : 'spread further';
      const why = pick.distance === null ? base : `${base}, nearest ${pick.distance} m`;
      out.push({ t: rule.t, need: rule.need, prefabs, x: pick.at.x, z: pick.at.z, have: have.length,
        uncoveredPct: pct, escalated: isEsc, critical: !!room && (room.status === 'over' || room.status === 'none'), why, distance: pick.distance });
    }
  }

  // Utilities: critical, never skipped by upkeep discipline.
  const powerPct = Number(snap?.util?.power?.pct ?? 0);
  const powerImport = Number(snap?.util?.power?.import ?? 0);
  const waterPct = Number(snap?.util?.water?.pct ?? 0);
  const sewagePct = Number(snap?.util?.sewage?.pct ?? 0);
  const utility = (t: string, need: string, prefabs: string[], rx: RegExp, why: string): Need => {
    const near = anchor(buildings.services, rx, buildings.homes);
    return { t, need, prefabs, x: near.x, z: near.z, have: buildings.services.filter(s => rx.test(s[0])).length,
      uncoveredPct: 0, escalated: false, critical: true, why, distance: null };
  };
  if (powerPct > 85 || powerImport > 0) {
    out.push(utility('power', 'power', ['SmallCoalPowerPlant01', 'WindTurbine01'], /Power|WindTurbine|Transformer/,
      `power ${powerPct}%${powerImport > 0 ? ', importing' : ''}`));
  }
  if (waterPct > 70) {
    out.push(utility('water', 'water', ['GroundwaterPumpingStation01', 'WaterTower01', 'WaterPumpingStation01'],
      /WaterPump|WaterTower|Groundwater/, `water ${waterPct}%`));
  }
  if (sewagePct > 70) {
    out.push(utility('sewage', 'sewage', ['SewageOutlet01'], /Sewage/, `sewage ${sewagePct}%`));
  }

  // Cash floor: below it only critical or escalated needs survive.
  const kept = money < cashFloor ? out.filter(n => n.critical || n.escalated) : out;
  // Owner rule: critical utilities first, then happiness factors worse than -5 (very_high), then
  // worse than -3 (priority), then the other escalated needs.
  const rank = (n: Need) => { const p = needs[n.need]?.priority; return p === 'very_high' ? 2 : p === 'priority' ? 1 : 0; };
  return kept.sort((a, b) =>
    (Number(b.critical) - Number(a.critical)) ||
    (rank(b) - rank(a)) ||
    (Number(b.escalated) - Number(a.escalated)) ||
    (Number(b.have === 0) - Number(a.have === 0)) ||
    (b.uncoveredPct - a.uncoveredPct));
}

const COOL_FILE = join(REPO, 'journals', 'services-escalation.json');

async function readCooldown(): Promise<Record<string, string>> {
  try {
    const v = JSON.parse((await fs.readFile(COOL_FILE, 'utf8')).replace(/^﻿/, ''));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

async function writeCooldown(cool: Record<string, string>): Promise<void> {
  await fs.mkdir(dirname(COOL_FILE), { recursive: true });
  await fs.writeFile(COOL_FILE, JSON.stringify(cool), 'utf8');
}

// home_clusters result -> [x, z, homes] list; undefined when the mod gave none (decideServices then falls back).
function parseClusters(res: Json): Cluster[] | undefined {
  if (!Array.isArray(res?.clusters)) return undefined;
  return res.clusters
    .filter((c: Json) => Array.isArray(c) && c.length >= 3)
    .map((c: Json): Cluster => [Number(c[0]), Number(c[1]), Number(c[2])]);
}

export async function fixServices(opts: { maxPlacements?: number; plan?: boolean; reserve?: number; projectPeople?: number; netFloor?: number; upkeepFactor?: number; skip?: string[]; upkeepAllowance?: number } = {}): Promise<Json> {
  const t0 = Date.now();
  const [snap, buildings, homeClusters] = await multi([
    { command: 'get_snapshot' }, { command: 'service_buildings' },
    { command: 'home_clusters', args: { cell: 400, top: 24 } },
  ]);
  const clusters = parseClusters(homeClusters);

  // The game's own per-road coverage; a failed query just means no gap entry (distance-free fallback).
  const gaps: Record<string, Gap> = {};
  const covs = [...new Set(RULES.map(r => r.cov).filter((c): c is string => !!c))];
  for (const cov of covs) {
    try { gaps[cov] = await callOk('coverage_gaps', { service: cov, top: 1 }, 20); } catch { /* no entry */ }
  }

  const cooldown = await readCooldown();
  const happiness = snap?.happiness ?? {};
  // Record the factors, then judge each one against the actions already taken for it: a factor
  // that two actions did not move is investigated, not given a third building; one that was
  // acted on in the last 5 minutes is given time to respond.
  await recordFactors(snap);
  let verdicts: Json[] = [];
  try { verdicts = assess({ factors: happiness, history: await readJsonl(HISTORY_PATH), actions: await readJsonl(ACTIONS_PATH), nowMs: Date.now() }); } catch { verdicts = []; }
  const verdictOf = (need: string) => verdicts.filter(v => v.need === need).sort((a, b) => a.value - b.value)[0];
  // A very_high factor keeps being acted on every cycle (its own settle time replaces the cooldown).
  const liveCooldown = Object.fromEntries(Object.entries(cooldown).filter(([k]) => snap?.needs?.[k]?.priority !== 'very_high'));
  // Headroom: capacity against use for every service, projected for the districts about to be
  // zoned. The table is returned as one line; utilities past the target are raised.
  let table: Record<string, any> = {}; let servicesLine = ''; let alerts: string[] = [];
  try { table = serviceTable(await callOk('service_headroom', {}, 20), snap, Number(opts.projectPeople ?? 0)); servicesLine = tableLine(table); alerts = utilityAlerts(table); } catch { /* older mod: coverage and escalation only */ }
  const all = decideServices({ snap, buildings, gaps, cooldown: liveCooldown, nowMs: Date.now(), clusters, perRule: 3, headroom: Object.keys(table).length ? headroomFor(table) : undefined });
  const held = all.filter(n => ['investigate', 'waiting'].includes(verdictOf(n.need)?.verdict));
  // Fix types the effects table judged ineffective are not repeated (critical and very-high needs still are).
  const stopped = all.filter(n => !held.includes(n) && (opts.skip ?? []).includes(n.need) && !n.critical && snap?.needs?.[n.need]?.priority !== 'very_high');
  const needs = all.filter(n => !held.includes(n) && !stopped.includes(n));
  const investigate = verdicts.filter(v => v.verdict === 'investigate').map(v => ({ factor: v.factor, value: v.value, actions: v.actions, delta: v.delta, hint: v.fix }));
  const waiting = [...new Set(held.filter(n => verdictOf(n.need)?.verdict === 'waiting').map(n => n.t))];

  if (opts.plan) {
    return {
      plan: true,
      happiness,
      needs: needs.map(n => ({ t: n.t, prefab: n.prefabs[0], x: n.x, z: n.z, why: n.why, ...(snap?.needs?.[n.need]?.priority ? { priority: snap.needs[n.need].priority } : {}) })),
      ...(investigate.length ? { investigate } : {}), ...(waiting.length ? { waiting } : {}), ...(servicesLine ? { services: servicesLine } : {}), ...(alerts.length ? { utilityAlerts: alerts } : {}),
      ms: Date.now() - t0,
    };
  }

  const requested = Number.isFinite(opts.maxPlacements) ? Math.floor(opts.maxPlacements as number) : 2;
  const maxPlacements = Math.max(1, Math.min(8, requested));
  const placed: Json[] = [];
  const failed: Json[] = [];
  let cooldownError: string | undefined;

  // Cash reserve (owner rule: bank about 1,000,000 before discretionary spending): a need that is neither a critical utility nor a
  // very_high factor is deferred when its construction cost would take cash below the reserve.
  const reserve = Number.isFinite(opts.reserve) ? Number(opts.reserve) : RESERVE;
  let cash = Number(snap?.city?.money ?? 0); let net = Number(snap?.city?.net ?? 0); const deferred: Json[] = []; let placedCount = 0; let addedUpkeep = 0;
  for (const n of needs) {
    if (placedCount >= maxPlacements) break;
    let settled = false; let lastPrefab = n.prefabs[0]; let lastReason = 'no_prefab_tried';
    const mustAct = n.critical || snap?.needs?.[n.need]?.priority === 'very_high';
    for (const prefab of n.prefabs) {
      lastPrefab = prefab;
      if (!mustAct) {
        const quote = await placeService(prefab, n.x, n.z, 600, undefined, true);
        // Net floor (improve mode): the real running cost of the building must leave net at or above the floor.
        if (quote.ok && Number.isFinite(opts.netFloor)) {
          const fv = floorVerdict({ net, floor: Number(opts.netFloor), monthlyUpkeep: Number(quote.monthlyUpkeep ?? 0), factor: opts.upkeepFactor, ...(Number.isFinite(opts.upkeepAllowance) ? { allowance: Number(opts.upkeepAllowance) - addedUpkeep } : {}) });
          if (!fv.ok) { deferred.push({ t: n.t, prefab, monthlyUpkeep: quote.monthlyUpkeep, why: fv.reason === 'half_margin_per_review' ? 'waits for the next review: half of the margin is the most new upkeep per review' : `net floor: projected net ${fv.projected} would be under ${fv.floor}` }); settled = true; break; }
        }
        if (quote.ok && cash - Number(quote.construction ?? 0) < reserve) { deferred.push({ t: n.t, prefab, construction: quote.construction, why: `would leave ${cash - Number(quote.construction ?? 0)} cash, reserve is ${reserve}` }); settled = true; break; }
      }
      // No free roadside near the target (a built-up centre): take the nearest site within 1,500 m
      // rather than give up (FAILURES #101: police was "blocked by no_roadside_site" at crime -4.5).
      let r = await placeService(prefab, n.x, n.z, 600);
      if (!r.ok && r.reason === 'no_roadside_site') r = await placeService(prefab, n.x, n.z, 1500);
      if (r.ok) { cash -= Number(r.cost ?? r.construction ?? 0); placedCount++; net -= Number(r.monthlyUpkeep ?? 0) * (opts.upkeepFactor ?? 2.7); addedUpkeep += Number(r.monthlyUpkeep ?? 0) * (opts.upkeepFactor ?? 2.7); }
      if (r.ok) {
        placed.push({ t: n.t, prefab, cost: r.cost, monthlyUpkeep: r.monthlyUpkeep, at: r.at });
        await recordAction({ need: n.need, tool: 'fix_services', detail: `${prefab}@${r.at?.x},${r.at?.z}`, ...(typeof snap?.needs?.[n.need]?.factor === 'number' ? { factor: snap.needs[n.need].factor } : {}) });
        if (n.escalated) {
          cooldown[n.need] = new Date().toISOString();
          try { await writeCooldown(cooldown); } catch (e: any) { cooldownError = String(e?.message ?? e); }
        }
        settled = true; break;
      }
      lastReason = String(r.reason ?? r.error ?? 'unknown');
      // Prefab missing or locked: try the next type. Any other failure: report it and stop for this need.
      if (r.reason === 'prefab_not_found' || r.reason === 'prefab_locked' || r.reason === 'not_enough_money' || r.reason === 'no_roadside_site') continue; // a cheaper alternative may follow
      failed.push({ t: n.t, prefab, failed: lastReason });
      settled = true; break;
    }
    if (!settled) failed.push({ t: n.t, prefab: lastPrefab, failed: `no_prefab_available: ${lastReason}` });
  }

  const pending = needs.filter(n => !placed.some(p => p.t === n.t) && !failed.some(f => f.t === n.t) && !deferred.some(d => d.t === n.t)).map(n => ({ t: n.t, why: n.why }));
  return {
    ...(servicesLine ? { services: servicesLine } : {}), ...(alerts.length ? { utilityAlerts: alerts } : {}),
    table: Object.fromEntries(Object.entries(table).map(([k, r]: [string, any]) => [k, { pct: r.pct, projected: r.projected, status: r.status }])),
    coverage: Object.fromEntries(Object.entries(gaps).map(([k, g]) => [k, Math.round(Number(g?.uncoveredPct ?? 0))])),
    blocked: Object.fromEntries(failed.map((f: Json) => [RULES.find(r => r.t === f.t)?.need ?? f.t, String(f.failed ?? '').replace('no_prefab_available: ', '')])),
    happiness,
    addedUpkeep: Math.round(addedUpkeep),
    placed,
    failed,
    pending,
    cost: placed.reduce((s, p) => s + Number(p.cost ?? 0), 0),
    monthlyUpkeep: placed.reduce((s, p) => s + Number(p.monthlyUpkeep ?? 0), 0),
    ...(cooldownError ? { cooldownError } : {}),
    ...(deferred.length ? { deferred } : {}),
    ...(investigate.length ? { investigate } : {}), ...(waiting.length ? { waiting } : {}),
    ms: Date.now() - t0,
  };
}
