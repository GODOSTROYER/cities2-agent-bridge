// Native city-services planner: the TypeScript port of services.ps1 (same intent, same rules).
// decideServices() is pure and fed with snapshot/building/gap data; fixServices() is the only
// part that talks to the game (non-pausing reads, then placeService() for the chosen needs).
import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { callOk, multi, REPO } from './bridge.ts';
import type { Json } from './bridge.ts';
import { placeService } from './city.ts';

export interface Rule { t: string; need: string; rx: RegExp; prefabs: string[]; cov?: string; minPop: number }

export const RULES: Rule[] = [
  { t: 'health', need: 'health', rx: /^(MedicalClinic|Hospital)/, prefabs: ['MedicalClinic01', 'MedicalClinic02'], cov: 'Healthcare', minPop: 300 },
  { t: 'deathcare', need: 'deathcare', rx: /^(Cemetery|Crematorium)/, prefabs: ['Cemetery01', 'Cemetery02', 'Crematorium01'], minPop: 500 },
  { t: 'fire', need: 'fire', rx: /^(FireHouse|RS_FireHouse|FireStation)/, prefabs: ['FireHouse01', 'RS_FireHouse01', 'FireHouse02'], cov: 'FireRescue', minPop: 600 },
  { t: 'police', need: 'police', rx: /^(PoliceStation|RS_PoliceStation|CCP5_PoliceStation)/, prefabs: ['PoliceStation01', 'PoliceStation02'], cov: 'Police', minPop: 800 },
  { t: 'school', need: 'education', rx: /^ElementarySchool/, prefabs: ['ElementarySchool01', 'ElementarySchool02'], cov: 'Education', minPop: 600 },
  { t: 'highschool', need: 'education_high', rx: /^HighSchool/, prefabs: ['HighSchool01', 'HighSchool02'], minPop: 2500 },
  { t: 'post', need: 'post', rx: /^(PostOffice|PostSorting)/, prefabs: ['PostOffice01', 'PostOffice02'], cov: 'PostService', minPop: 1500 },
  { t: 'garbage', need: 'garbage', rx: /^(Landfill|Incinerat|Recycling)/, prefabs: ['Landfill01', 'IncinerationPlant01'], minPop: 1000 },
];

export interface Center { n: number; x: number; z: number }
export interface Gap { uncoveredPct: number; gapClusters: { x: number; z: number; homes: number }[] }
export interface Buildings { services: [string, number, number][]; homes: Center; industry: Center }

export interface ServicesInput {
  snap: Json;
  buildings: Buildings;
  gaps: Record<string, Gap>;
  cooldown: Record<string, string>;
  nowMs: number;
  cashFloor?: number;
  uncoveredShare?: number;
}

export interface Need {
  t: string; need: string; prefabs: string[]; x: number; z: number; have: number;
  uncoveredPct: number; escalated: boolean; critical: boolean; why: string;
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

export function decideServices(input: ServicesInput): Need[] {
  const { snap, buildings, gaps, cooldown, nowMs } = input;
  const cashFloor = input.cashFloor ?? 250000;
  const uncoveredShare = input.uncoveredShare ?? 0.15;
  const needs: Json = snap?.needs ?? {};
  const pop = Number(snap?.city?.pop ?? 0);
  const money = Number(snap?.city?.money ?? 0);
  const net = Number(snap?.city?.net ?? 0);

  // Escalated = the mod says "build" for this need and it was not built in the last 10 minutes.
  const escalated = Object.keys(needs).filter(k =>
    k !== 'iconsTop' && needs[k]?.action === 'build' && !inCooldown(cooldown?.[k], nowMs));

  const out: Need[] = [];
  for (const rule of RULES) {
    const isEsc = escalated.includes(rule.need);
    if (pop < rule.minPop && !isEsc) continue;
    const have = buildings.services.filter(s => rule.rx.test(s[0]));
    const gap = rule.cov ? gaps?.[rule.cov] : undefined;
    const share = gap ? Number(gap.uncoveredPct ?? 0) / 100 : 0;
    const missing = isEsc || have.length === 0 || (!!rule.cov && share > uncoveredShare);
    if (!missing) continue;
    if (net < 0 && !isEsc) continue; // upkeep discipline: no new permanent upkeep while losing money

    const cluster = gap?.gapClusters?.[0];
    const at = rule.t === 'garbage' && buildings.industry.n > 0 ? buildings.industry
      : cluster ? { x: Number(cluster.x), z: Number(cluster.z) }
      : buildings.homes;
    const pct = Math.round(share * 100);
    const why = isEsc ? `escalated ${needs[rule.need]?.score ?? ''}`.trim()
      : have.length === 0 ? 'none built'
      : `${pct}% homes uncovered`;
    out.push({ t: rule.t, need: rule.need, prefabs: rule.prefabs, x: at.x, z: at.z, have: have.length,
      uncoveredPct: pct, escalated: isEsc, critical: false, why });
  }

  // Utilities: critical, never skipped by upkeep discipline.
  const powerPct = Number(snap?.util?.power?.pct ?? 0);
  const powerImport = Number(snap?.util?.power?.import ?? 0);
  const waterPct = Number(snap?.util?.water?.pct ?? 0);
  const sewagePct = Number(snap?.util?.sewage?.pct ?? 0);
  const utility = (t: string, need: string, prefabs: string[], rx: RegExp, why: string): Need => {
    const near = anchor(buildings.services, rx, buildings.homes);
    return { t, need, prefabs, x: near.x, z: near.z, have: buildings.services.filter(s => rx.test(s[0])).length,
      uncoveredPct: 0, escalated: false, critical: true, why };
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
  return kept.sort((a, b) =>
    (Number(b.critical) - Number(a.critical)) ||
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

export async function fixServices(opts: { maxPlacements?: number; plan?: boolean } = {}): Promise<Json> {
  const t0 = Date.now();
  const [snap, buildings] = await multi([{ command: 'get_snapshot' }, { command: 'service_buildings' }]);

  // The game's own per-road coverage; a failed query just means no gap entry (distance-free fallback).
  const gaps: Record<string, Gap> = {};
  const covs = [...new Set(RULES.map(r => r.cov).filter((c): c is string => !!c))];
  for (const cov of covs) {
    try { gaps[cov] = await callOk('coverage_gaps', { service: cov, top: 1 }, 20); } catch { /* no entry */ }
  }

  const cooldown = await readCooldown();
  const needs = decideServices({ snap, buildings, gaps, cooldown, nowMs: Date.now() });

  if (opts.plan) {
    return {
      plan: true,
      needs: needs.map(n => ({ t: n.t, prefab: n.prefabs[0], x: n.x, z: n.z, why: n.why })),
      ms: Date.now() - t0,
    };
  }

  const requested = Number.isFinite(opts.maxPlacements) ? Math.floor(opts.maxPlacements as number) : 2;
  const maxPlacements = Math.max(1, Math.min(4, requested));
  const placed: Json[] = [];
  const failed: Json[] = [];
  let cooldownError: string | undefined;

  for (const n of needs.slice(0, maxPlacements)) {
    let settled = false; let lastPrefab = n.prefabs[0]; let lastReason = 'no_prefab_tried';
    for (const prefab of n.prefabs) {
      lastPrefab = prefab;
      const r = await placeService(prefab, n.x, n.z, 600);
      if (r.ok) {
        placed.push({ t: n.t, prefab, cost: r.cost, monthlyUpkeep: r.monthlyUpkeep, at: r.at });
        if (n.escalated) {
          cooldown[n.need] = new Date().toISOString();
          try { await writeCooldown(cooldown); } catch (e: any) { cooldownError = String(e?.message ?? e); }
        }
        settled = true; break;
      }
      lastReason = String(r.reason ?? r.error ?? 'unknown');
      // Prefab missing or locked: try the next type. Any other failure: report it and stop for this need.
      if (r.reason === 'prefab_not_found' || r.reason === 'prefab_locked') continue;
      failed.push({ t: n.t, prefab, failed: lastReason });
      settled = true; break;
    }
    if (!settled) failed.push({ t: n.t, prefab: lastPrefab, failed: `no_prefab_available: ${lastReason}` });
  }

  const pending = needs.slice(maxPlacements).map(n => ({ t: n.t, why: n.why }));
  return {
    placed,
    failed,
    pending,
    cost: placed.reduce((s, p) => s + Number(p.cost ?? 0), 0),
    monthlyUpkeep: placed.reduce((s, p) => s + Number(p.monthlyUpkeep ?? 0), 0),
    ...(cooldownError ? { cooldownError } : {}),
    ms: Date.now() - t0,
  };
}
