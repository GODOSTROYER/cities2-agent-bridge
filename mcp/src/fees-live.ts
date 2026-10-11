// Fees, live: the glue between the pure rules in fees.ts and the game. Reads get_fees, applies each
// decision with set_parking_fee / set_service_fee, enforces the owner's hard rule (a service fee is never
// raised above the game's default) and keeps a small history in the state it is given.
// All game access goes through the injected `call`, so test/fees-live.ts runs fully offline.
import { decideParkingFees, decideServiceFees, parkingSummary, feeLines } from './fees.ts';
import type { ParkingSite, ServiceFee, FeePolicy, FeeChange, FeeHistoryRow } from './fees.ts';

export type Call = (command: string, args?: Record<string, any>) => Promise<Record<string, any>>;
export interface FeeHistoryEntry { t: number; kind: string; id: string; from: number; to: number; occupancyBefore?: number }
export interface FeeState { lastRun?: number; history?: FeeHistoryEntry[] }
export interface LiveChange { kind: 'parking' | 'service'; id: string; from: number; to: number; why: string }
export interface TuneResult { changed: LiveChange[]; lines: string[]; state: FeeState; skipped?: string }
export interface FeeActionRow { need: 'parking' | 'fees'; tool: 'set_parking_fee' | 'set_service_fee'; detail: string }

const MIN = 60000, HISTORY_CAP = 200, LINE_MAX = 200;
const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const clip = (s: string) => s.length > LINE_MAX ? s.slice(0, LINE_MAX - 3) + '...' : s;
const msg = (e: unknown) => String((e as any)?.message ?? e);

function pass(state: FeeState, lines: string[], skipped: string): TuneResult {
  return { changed: [], lines: lines.map(clip), state, skipped };
}

export async function tuneFees(call: Call, policy: Record<string, any>, state: FeeState, nowMs: number): Promise<TuneResult> {
  state = state ?? {};
  const fp = policy?.fees as (FeePolicy & { enabled?: boolean }) | undefined;
  if (!fp || typeof fp !== 'object' || fp.enabled === false) return pass(state, ['fees: the tuner is off (policy.fees is missing or disabled), nothing changed'], 'off');

  const reviewMin = num((fp as any).reviewMinutes) && (fp as any).reviewMinutes > 0 ? (fp as any).reviewMinutes : 30;
  if (num(state.lastRun) && nowMs - state.lastRun < reviewMin * MIN) return pass(state, [], 'not due');

  let data: Record<string, any>;
  try { data = await call('get_fees', {}); } catch (e) { return pass(state, [clip(`fees: could not read get_fees: ${msg(e)}`)], 'read failed'); }
  if (!data || typeof data !== 'object') return pass(state, ['fees: get_fees returned nothing usable'], 'read failed');

  // Sites: fees.ts wants ParkingSite; the live row also carries index/version for the write.
  const rows: any[] = Array.isArray(data.parking) ? data.parking : [];
  const sites: ParkingSite[] = [], ref = new Map<string, { index: number; version: number; x: number; z: number }>();
  for (const r of rows) {
    if (!r || !num(r.index) || !num(r.version)) continue;
    const id = `${r.index}:${r.version}`;
    sites.push({ id, kind: 'lot', x: r.x, z: r.z, capacity: r.capacity, parked: r.parked, fee: r.fee });
    ref.set(id, { index: r.index, version: r.version, x: r.x, z: r.z });
  }
  const services: ServiceFee[] = (Array.isArray(data.service) ? data.service : []).filter((f: any) => f && typeof f.name === 'string' && num(f.fee))
    .map((f: any) => ({ name: f.name, fee: f.fee, factor: num(f.factor) ? f.factor : undefined }));
  const defaults = (name: string): number | null => { const d = data.bounds?.[name]?.default; return num(d) ? d : null; };

  const hist: FeeHistoryEntry[] = Array.isArray(state.history) ? state.history : [];
  const feeHist: FeeHistoryRow[] = hist.map(h => ({ target: h.id, t: h.t, from: h.from, to: h.to, before: h.occupancyBefore }));
  const lines: string[] = [];
  const sum = parkingSummary(sites);
  const band: [number, number] = Array.isArray(fp.occupancyBand) && fp.occupancyBand.length === 2 ? fp.occupancyBand : [70, 85];
  lines.push(...feeLines(sum, null, []));

  // Decisions.
  const pMin = fp.parking?.min ?? 0, pMax = fp.parking?.max ?? 50;
  const decisions: FeeChange[] = [];
  for (const d of decideParkingFees(sites, fp, feeHist, nowMs)) {
    const to = Math.min(pMax, Math.max(pMin, d.to));
    if (to !== d.from) decisions.push({ ...d, to });
  }
  for (const d of decideServiceFees(services, fp, feeHist, nowMs)) {
    const def = defaults(d.target);
    if (d.to > d.from && (def === null || d.to > def)) {
      lines.push(`service fee ${d.target}: raise ${d.from} -> ${d.to} dropped, ${def === null ? 'the game default is unknown' : `above the game default ${def}`} (a raise would cost happiness)`);
      continue;
    }
    decisions.push(d);
  }

  // Apply, one failure never stops the rest.
  const changed: LiveChange[] = [], newHist: FeeHistoryEntry[] = [];
  const siteById = new Map(sites.map(s => [s.id, s]));
  for (const d of decisions) {
    try {
      let res: Record<string, any>;
      if (d.kind === 'parking') { const r = ref.get(d.target)!; res = await call('set_parking_fee', { index: r.index, version: r.version, fee: d.to }); }
      else res = await call('set_service_fee', { resource: d.target, fee: d.to });
      if (res && res.ok === false) throw new Error(res.error ? String(res.error) : 'ok false');
    } catch (e) {
      const nm = d.kind === 'parking' ? `parking (${ref.get(d.target)?.x},${ref.get(d.target)?.z})` : `service fee ${d.target}`;
      lines.push(`${nm}: ${d.from} -> ${d.to} refused (${msg(e)})`);
      continue;
    }
    changed.push({ kind: d.kind, id: d.target, from: d.from, to: d.to, why: d.why });
    const site = siteById.get(d.target);
    const occ = site && site.capacity > 0 ? Math.round(site.parked / site.capacity * 100) : undefined;
    newHist.push({ t: nowMs, kind: d.kind, id: d.target, from: d.from, to: d.to, ...(occ !== undefined && d.kind === 'parking' ? { occupancyBefore: occ } : {}) });
    if (d.kind === 'parking') {
      const r = ref.get(d.target)!;
      const where = occ === undefined ? '' : occ > band[1] ? `, occupancy ${occ}% above the ${band[0]}-${band[1]}% band` : occ < band[0] ? `, occupancy ${occ}% below the ${band[0]}-${band[1]}% band` : `, occupancy ${occ}% (starting a moderate fee)`;
      lines.push(`parking (${r.x},${r.z}): ${d.from} -> ${d.to}${where}`);
    } else lines.push(`service fee ${d.target}: ${d.from} -> ${d.to}, ${d.why}`);
  }

  return {
    changed,
    lines: lines.map(clip),
    state: { lastRun: nowMs, history: [...hist, ...newHist].slice(-HISTORY_CAP) },
  };
}

export function feeActions(changed: LiveChange[]): FeeActionRow[] {
  return changed.map(c => c.kind === 'parking'
    ? { need: 'parking' as const, tool: 'set_parking_fee' as const, detail: clip(`site ${c.id}: fee ${c.from} -> ${c.to} (${c.why})`) }
    : { need: 'fees' as const, tool: 'set_service_fee' as const, detail: clip(`${c.id}: fee ${c.from} -> ${c.to} (${c.why})`) });
}
