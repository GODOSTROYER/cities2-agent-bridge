// Fees: keep parking sites near a healthy occupancy band and nudge service fees one step at a time.
// Every decision is a single small step, held for a review period, and undone when it lost income.
// PURE: no imports, no I/O, time comes in as an argument. Unit-tested in test/fees.ts.
export interface ParkingSite { id: string; kind: 'lot' | 'garage' | 'roadside'; x: number; z: number; capacity: number; parked: number; fee: number }
export interface ServiceFee { name: string; fee: number; factor?: number }
export interface FeePolicy {
  occupancyBand?: [number, number];
  raiseAbovePct?: number;
  lowerBelowPct?: number;
  parking?: { min?: number; max?: number; start?: number; step?: number };
  service?: Record<string, { min: number; max: number; step: number }>;
  reviewMinutes?: number;
}
export interface FeeChange { target: string; kind: 'parking' | 'service'; from: number; to: number; why: string }
export interface FeeHistoryRow { target: string; t: number; from: number; to: number; before?: number; after?: number }

const MIN = 60000;
const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

export function occupancyPct(site: ParkingSite): number | null {
  if (!num(site.capacity) || site.capacity <= 0 || !num(site.parked)) return null;
  return Math.round(site.parked / site.capacity * 100);
}

function lastRow(history: FeeHistoryRow[], target: string): FeeHistoryRow | null {
  let best: FeeHistoryRow | null = null;
  for (const r of history) if (r.target === target && num(r.t) && (best === null || r.t >= best.t)) best = r;
  return best;
}

export function decideParkingFees(sites: ParkingSite[], policy: FeePolicy, history: FeeHistoryRow[], nowMs: number): FeeChange[] {
  const band = policy.occupancyBand ?? [70, 85];
  const raiseAbove = policy.raiseAbovePct ?? 85, lowerBelow = policy.lowerBelowPct ?? 50;
  const min = policy.parking?.min ?? 0, max = policy.parking?.max ?? 50, start = policy.parking?.start ?? 10, step = policy.parking?.step ?? 5;
  const hold = (policy.reviewMinutes ?? 20) * MIN;
  const out: FeeChange[] = [];
  for (const s of sites) {
    const occ = occupancyPct(s);
    if (occ === null || !num(s.fee)) continue;
    const last = lastRow(history, s.id);
    if (last && nowMs - last.t < hold) continue;
    let to = s.fee, why = '';
    if (s.fee === 0 && last === null && occ >= band[0]) {
      to = Math.min(max, Math.max(min, start));
      why = `occupancy ${occ}% is at or above ${band[0]}% and the site is free: start moderate, fee ${s.fee} -> ${to}`;
    } else if (occ > raiseAbove) {
      to = Math.min(max, s.fee + step);
      why = `occupancy ${occ}% is above ${raiseAbove}%: fee ${s.fee} -> ${to}`;
    } else if (occ < lowerBelow) {
      to = Math.max(min, s.fee - step);
      why = `occupancy ${occ}% is below ${lowerBelow}%: fee ${s.fee} -> ${to}`;
    }
    if (to !== s.fee) out.push({ target: s.id, kind: 'parking', from: s.fee, to, why });
  }
  return out;
}

export function decideServiceFees(fees: ServiceFee[], policy: FeePolicy, history: FeeHistoryRow[], nowMs: number): FeeChange[] {
  const hold = (policy.reviewMinutes ?? 20) * MIN;
  const out: FeeChange[] = [];
  for (const f of fees) {
    const rule = policy.service?.[f.name];
    if (!rule || !num(f.fee)) continue;
    const last = lastRow(history, f.name);
    let to = f.fee, why = '';
    if (num(f.factor) && f.factor < 0 && f.fee > rule.min) {
      to = Math.max(rule.min, f.fee - rule.step);
      why = `the ${f.name} happiness factor is negative (${f.factor}): fee ${f.fee} -> ${to}`;
    } else if (last && last.to > last.from && num(last.before) && num(last.after) && last.after < last.before) {
      to = Math.min(rule.max, Math.max(rule.min, last.from));
      why = `income fell from ${fmt(last.before)} to ${fmt(last.after)} after the last raise: undo, fee ${f.fee} -> ${to}`;
    } else if (f.fee < rule.max && (!num(f.factor) || f.factor >= 0.5) && (last === null || nowMs - last.t >= hold)) {
      to = Math.min(rule.max, f.fee + rule.step);
      why = `no complaints about ${f.name} and the fee is below ${rule.max}: fee ${f.fee} -> ${to}`;
    }
    if (to !== f.fee) out.push({ target: f.name, kind: 'service', from: f.fee, to, why });
  }
  return out;
}

export function judgeFeeChange(row: FeeHistoryRow, band: [number, number]): 'effective' | 'ineffective' | 'worse' | 'pending' {
  if (!num(row.after)) return 'pending';
  const dist = (x: number) => x < band[0] ? band[0] - x : x > band[1] ? x - band[1] : 0;
  if (dist(row.after) === 0) return 'effective';
  if (!num(row.before) || Math.abs(row.after - row.before) < 2) return 'ineffective';
  return dist(row.after) < dist(row.before) ? 'effective' : 'worse';
}

export function parkingSummary(sites: ParkingSite[]): { sites: number; capacity: number; parked: number; occupancyPct: number | null; full: number; empty: number; paid: number } {
  let capacity = 0, parked = 0, full = 0, empty = 0, paid = 0;
  for (const s of sites) {
    if (num(s.capacity) && s.capacity > 0) capacity += s.capacity;
    if (num(s.parked)) parked += s.parked;
    const o = occupancyPct(s);
    if (o !== null && o > 85) full++;
    if (o !== null && o < 50) empty++;
    if (num(s.fee) && s.fee > 0) paid++;
  }
  return { sites: sites.length, capacity, parked, occupancyPct: capacity > 0 ? Math.round(parked / capacity * 100) : null, full, empty, paid };
}

export function feeLines(sum: ReturnType<typeof parkingSummary>, monthlyParkingIncome: number | null, changes: FeeChange[]): string[] {
  const lines: string[] = [];
  const income = monthlyParkingIncome !== null && num(monthlyParkingIncome) ? `; income ${fmt(monthlyParkingIncome)} a month` : '';
  if (sum.sites === 0) lines.push(`parking: no sites${income}`);
  else lines.push(`parking: ${sum.sites} sites, ${fmt(sum.parked)} of ${fmt(sum.capacity)} places used (${sum.occupancyPct === null ? 'n/a' : sum.occupancyPct + '%'}), ${sum.full} full, ${sum.empty} nearly empty, ${sum.paid} paid${income}`);
  const shown = changes.slice(0, 2);
  shown.forEach((c, i) => {
    const more = i === shown.length - 1 && changes.length > 2 ? `; and ${changes.length - 2} more` : '';
    lines.push(`${c.kind} fee ${c.target}: ${c.from} -> ${c.to} (${c.why})${more}`);
  });
  return lines;
}
