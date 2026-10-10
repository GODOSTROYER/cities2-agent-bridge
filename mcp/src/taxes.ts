// Tax autopilot that honours the owner's pins. A pin is a range per tax area
// (journals/tax-pins.json, e.g. Residential {min:15,max:15}, Industrial {min:10,max:11,start:10}):
// the autopilot never leaves a range, only moves one point at a time inside it, and does
// nothing at all for an area without a pin. The Tax happiness factor is exempt by owner
// decision: it is reported, never a reason to change a rate.
import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { callOk, mutate, REPO } from './bridge.ts';
import type { Json } from './bridge.ts';
import { recordAction } from './happiness.ts';

export const PINS_PATH: string = process.env.CS2_TAX_PINS ?? join(REPO, 'journals', 'tax-pins.json');
export const AREAS = ['Residential', 'Commercial', 'Industrial', 'Office'] as const;
const SHORT: Record<string, string> = { R: 'Residential', C: 'Commercial', I: 'Industrial', O: 'Office' };
export interface Pin { min: number; max: number; start?: number }

// Only well-formed range pins for known areas; a plain number means a fixed rate.
export function parsePins(raw: Json): Record<string, Pin> {
  const pins: Record<string, Pin> = {};
  for (const area of AREAS) {
    const v = raw?.[area];
    if (typeof v === 'number' && Number.isFinite(v)) pins[area] = { min: v, max: v };
    else if (v && typeof v === 'object' && Number.isFinite(v.min) && Number.isFinite(v.max) && v.min <= v.max)
      pins[area] = { min: Number(v.min), max: Number(v.max), ...(Number.isFinite(v.start) ? { start: Math.min(v.max, Math.max(v.min, Number(v.start))) } : {}) };
  }
  return pins;
}

export async function readPins(): Promise<Record<string, Pin>> {
  try { return parsePins(JSON.parse((await fs.readFile(PINS_PATH, 'utf8')).replace(/^﻿/, ''))); } catch { return {}; }
}

export async function writePin(area: string, pin: Pin | null): Promise<void> {
  let raw: Json = {};
  try { raw = JSON.parse((await fs.readFile(PINS_PATH, 'utf8')).replace(/^﻿/, '')); } catch { raw = {}; }
  if (pin === null) delete raw[area]; else raw[area] = pin;
  raw.utc = new Date().toISOString();
  await fs.mkdir(dirname(PINS_PATH), { recursive: true });
  await fs.writeFile(PINS_PATH, JSON.stringify(raw, null, 1), 'utf8');
}

// Snapshot rates use R/C/I/O; everything here uses the long names.
export function longRates(rates: Json): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(rates ?? {})) out[SHORT[k] ?? k] = Number(v);
  return out;
}

const demandOf = (area: string, d: Json): number => area === 'Residential' ? Math.max(Number(d?.rL ?? 0), Number(d?.rM ?? 0), Number(d?.rH ?? 0)) : Number(d?.[area === 'Commercial' ? 'c' : area === 'Industrial' ? 'i' : 'o'] ?? 0);

export interface TaxInput { rates: Json; pins: Record<string, Pin>; demand?: Json; unemployment?: number; taxFactor?: number }

// PURE. One step per call:
//  1. a rate outside its pin range is put back (to `start` when given, else the nearest bound);
//  2. inside a range with room: demand below 20 lowers that zone one point (jobs first);
//     demand of 60+ with unemployment under 10% raises it one point (revenue);
//  3. otherwise hold. Areas without a pin are never touched.
export function decideTax(input: TaxInput): Json {
  const rates = longRates(input.rates); const pins = input.pins; const unemployment = Number(input.unemployment ?? 0);
  const base = { taxFactor: Number(input.taxFactor ?? 0), taxFactorNote: 'exempt by owner decision: reported only', rates, pins, unpinned: AREAS.filter(a => !pins[a]) };
  for (const area of AREAS) {
    const pin = pins[area]; const rate = rates[area];
    if (!pin || !Number.isFinite(rate)) continue;
    if (rate < pin.min || rate > pin.max) return { action: 'restore_pin', area, from: rate, to: pin.start ?? (rate < pin.min ? pin.min : pin.max), reason: `owner pin ${pin.min}-${pin.max}`, ...base };
  }
  const movable = AREAS.filter(a => pins[a] && pins[a].min < pins[a].max && Number.isFinite(rates[a]));
  const low = movable.filter(a => rates[a] > pins[a].min && demandOf(a, input.demand) < 20).sort((a, b) => demandOf(a, input.demand) - demandOf(b, input.demand))[0];
  if (low) return { action: 'lower', area: low, from: rates[low], to: rates[low] - 1, reason: `${low} demand ${demandOf(low, input.demand)} is below 20: lowest pinned rate restores jobs`, ...base };
  const high = unemployment < 10 ? movable.filter(a => rates[a] < pins[a].max && demandOf(a, input.demand) >= 60).sort((a, b) => demandOf(b, input.demand) - demandOf(a, input.demand))[0] : undefined;
  if (high) return { action: 'raise', area: high, from: rates[high], to: rates[high] + 1, reason: `${high} demand ${demandOf(high, input.demand)} carries a higher rate and unemployment is ${unemployment}%`, ...base };
  return { action: 'hold', reason: movable.length ? 'every pinned rate is where demand and unemployment want it' : 'all pinned rates are fixed', ...base };
}

// Reads the city, decides, optionally applies one step, and reports what the owner asked to
// see each cycle: rates, tax income, net, cash and the Tax factor.
export async function taxAutopilot(apply = false): Promise<Json> {
  const snap = await callOk('get_snapshot', {}, 10);
  const pins = await readPins();
  const decision = decideTax({ rates: snap.tax, pins, demand: snap.demand, unemployment: Number(snap.jobs?.unemp ?? 0), taxFactor: Number(snap.happiness?.Tax ?? 0) });
  let income: Record<string, number> = {};
  try { const b = (await callOk('get_city_management', {}, 15)).budget.incomeBySourceRaw; income = { Residential: b.TaxResidential, Commercial: b.TaxCommercial, Industrial: b.TaxIndustrial, Office: b.TaxOffice }; } catch { /* report without income */ }
  let applied = false; let error: string | undefined;
  if (apply && decision.action !== 'hold') {
    try {
      await mutate(async () => { await callOk('set_tax', { area: decision.area, rate: decision.to }, 15); });
      applied = true;
      await recordAction({ need: 'tax', tool: 'tax_autopilot', detail: `${decision.area} ${decision.from}->${decision.to} (${decision.reason})`, factor: decision.taxFactor });
    } catch (e: any) { error = String(e?.message ?? e); }
  }
  return { ...decision, applied, ...(error ? { error } : {}), taxIncome: income, totalTaxIncome: Object.values(income).reduce((a, b) => a + Number(b ?? 0), 0), money: snap.city?.money, net: snap.city?.net, unemployment: snap.jobs?.unemp, demand: snap.demand };
}

// Used by the set_tax tool: a manual change must stay inside the owner's pin unless the
// caller states that the owner asked for it.
export function pinViolation(area: string, rate: number, pins: Record<string, Pin>): string | null {
  const pin = pins[area];
  return pin && (rate < pin.min || rate > pin.max) ? `owner pin for ${area} is ${pin.min}-${pin.max}; pass ownerSaid=true only if the owner asked for ${rate}` : null;
}

export function registerTaxTool(server: any, z: any): void {
  server.registerTool('tax_autopilot', {
    description: 'Tax policy inside the owner pins (journals/tax-pins.json: a fixed rate or a min-max range per area). Puts a rate back inside its pin, lowers a zone one point when its demand is under 20, raises one point when demand is 60+ and unemployment under 10%, and never touches an unpinned area. The Tax happiness factor is reported, never a reason to change. Returns rates, tax income, net, cash and the decision; apply=true performs one step.',
    inputSchema: { apply: z.boolean().optional() },
  }, async (a: Json) => {
    try { return { content: [{ type: 'text', text: JSON.stringify(await taxAutopilot(!!a?.apply)) }] }; }
    catch (e: any) { return { content: [{ type: 'text', text: JSON.stringify({ error: String(e?.message ?? e) }) }], isError: true }; }
  });
}
