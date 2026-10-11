// Owner money policy: let cash accumulate to a working reserve (about 1,000,000) before
// discretionary spending such as new districts, extra amenities and tile purchases.
//   critical      - an unserved district's utilities, a deathcare backlog, a factor worse than -5,
//                   a utility near capacity, a loose network end: spend at once, reserve ignored.
//   priority      - a factor worse than -3 or jobs while unemployment is high: fine when cheap
//                   (25,000 or less) or when the reserve survives the purchase.
//   discretionary - everything else: only when the reserve survives the purchase.
// PURE (no bridge imports) so it is unit-tested offline.
export const RESERVE = 1_000_000;
export const CHEAP = 25_000;
export type SpendClass = 'critical' | 'priority' | 'discretionary';

export interface SpendInput { cash: number; cost: number; cls: SpendClass; reserve?: number }
export interface SpendVerdict { ok: boolean; reason?: string; reserve: number; after: number }

export function spendVerdict(i: SpendInput): SpendVerdict {
  const reserve = Number.isFinite(i.reserve) ? Number(i.reserve) : RESERVE;
  const cost = Math.max(0, Number(i.cost) || 0); const after = Number(i.cash) - cost;
  if (after < 0) return { ok: false, reason: 'not_enough_money', reserve, after };
  if (i.cls === 'critical') return { ok: true, reserve, after };
  if (i.cls === 'priority' && cost <= CHEAP) return { ok: true, reserve, after };
  if (after >= reserve) return { ok: true, reserve, after };
  return { ok: false, reason: 'below_reserve', reserve, after };
}

// A new district is discretionary (it waits for the reserve), except a cheap one for a zone
// type whose demand is strong: demand of 60+ is the game asking for it, and zoning pays back
// through tax income, so it is `priority` (allowed under the reserve when it costs 25,000 or less).
export function growClass(zone: string, unemployment: number, demand = 0): SpendClass {
  if (demand >= 60) return 'priority';
  return (zone === 'com' || zone === 'ind' || zone === 'off') && unemployment > 10 ? 'priority' : 'discretionary';
}

// PURE. Which needs in a snapshot must be fixed before any growth: a utility that buildings
// lack (action connect or build at very high priority) and loose network ends.
export function blockingNeeds(needs: Record<string, any> | undefined): { need: string; say?: string; at?: unknown; unserved?: number }[] {
  const out: { need: string; say?: string; at?: unknown; unserved?: number }[] = [];
  for (const k of ['power', 'water', 'sewage', 'network']) {
    const n = needs?.[k]; if (!n) continue;
    if ((k === 'network' && Number(n.icons ?? 0) > 0) || (Number(n.unserved ?? 0) > 0 && (n.action === 'connect' || n.action === 'build')))
      out.push({ need: k, say: n.say, at: n.at, ...(n.unserved ? { unserved: n.unserved } : {}) });
  }
  return out;
}

// PURE. Outcome of the utility postcondition for a freshly built district (mod utility_check).
export function utilityOutcome(u: Record<string, any> | undefined): { ok: boolean; reason?: string; missing?: string[] } {
  if (!u) return { ok: false, reason: 'utility_check_failed' };
  const missing = ['road', 'power', 'water'].filter(k => u[k]?.linked !== true);
  if (missing.length) return { ok: false, reason: 'not_utility_connected', missing };
  if (u.verdict === 'unserved') return { ok: false, reason: 'buildings_unserved' };
  return { ok: true };
}

// PURE. Loose ends after a road, cable or pipe build (FAILURES #82). For cables and pipes the
// game's own warning icons decide ("Powerline Not Connected", "Pipeline Not Connected"...): they
// appear at once, even while paused, and they know about building terminals and line-to-cable
// joints that a count of edges at the node does not. For roads the mod's island flag decides.
export function looseFrom(points: { x: number; z: number }[], icons: { type: string; x: number; z: number }[], ends: ({ kind: string; x: number; z: number; island?: boolean; prefab?: string }[] | undefined)[], radius = 16): Record<string, any>[] {
  const loose: Record<string, any>[] = [];
  points.forEach((p, i) => {
    for (const icon of icons) if (Math.hypot(icon.x - p.x, icon.z - p.z) <= radius) loose.push({ x: icon.x, z: icon.z, why: icon.type });
    const here = ends[i] ?? [];
    if (!here.length) loose.push({ x: Math.round(p.x), z: Math.round(p.z), why: 'no_network_end_here' });
    for (const e of here) if (e.kind === 'road' && e.island) loose.push({ x: e.x, z: e.z, kind: e.kind, prefab: e.prefab, why: 'road_not_joined_to_the_main_network' });
  });
  return loose.filter((l, i) => loose.findIndex(o => o.x === l.x && o.z === l.z && o.why === l.why) === i);
}

// PURE. Water under a planned cable, pipe or road (FAILURES #84): a ground cable laid across a
// river raised the bed like a dam; the water rose about 8 m upstream and destroyed homes within
// minutes. Points along the line every `step` metres; `depths` are the water depths sampled
// there (null = no water). Returns the wet length and the deepest point.
export function linePoints(from: { x: number; z: number }, to: { x: number; z: number }, step = 25, max = 60): { x: number; z: number }[] {
  const len = Math.hypot(to.x - from.x, to.z - from.z); const n = Math.max(1, Math.min(max, Math.ceil(len / step)));
  return Array.from({ length: n + 1 }, (_, i) => ({ x: Math.round(from.x + (to.x - from.x) * i / n), z: Math.round(from.z + (to.z - from.z) * i / n) }));
}
export function wetSpan(points: { x: number; z: number }[], depths: (number | null | undefined)[], minDepth = 0.3): { wet: boolean; metres: number; deepest: number; at?: { x: number; z: number } } {
  let metres = 0, deepest = 0; let at: { x: number; z: number } | undefined;
  for (let i = 0; i < points.length; i++) {
    const d = Number(depths[i] ?? 0); if (!(d > minDepth)) continue;
    const prev = points[Math.max(0, i - 1)], next = points[Math.min(points.length - 1, i + 1)];
    metres += Math.hypot(next.x - prev.x, next.z - prev.z) / 2;
    if (d > deepest) { deepest = d; at = points[i]; }
  }
  return { wet: metres > 0, metres: Math.round(metres), deepest: Math.round(deepest * 10) / 10, ...(at ? { at } : {}) };
}
// Overhead lines span water on pylons; everything laid in or on the ground must not cross it.
export const spansWater = (prefabName: string): boolean => /(^|\s)Line$/.test(prefabName) || /Bridge/i.test(prefabName);

// ---- Net floor (owner, improve mode): monthly net must never fall. ----
// floor = max(baseline, highest SUSTAINED net) minus a noise margin (2%). "Sustained" is the
// lowest of the last readings, so one lucky month does not raise the floor.
// An action that adds upkeep is allowed only when net minus its real running cost stays at or
// above the floor. Real cost = prefab upkeep x a factor (measured live: wages and consumption make
// a building cost about 2.7x its listed upkeep).
export function sustainedNet(recent: number[], window = 8): number | null {
  const r = recent.slice(-window); return r.length >= Math.min(window, 6) ? Math.min(...r) : null;
}
export function netFloor(baseline: number, highestSustained: number | null | undefined, marginPct = 2): number {
  return Math.round(Math.max(baseline, Number(highestSustained ?? 0)) * (1 - marginPct / 100));
}
export interface FloorVerdict { ok: boolean; projected: number; floor: number; margin: number; reason?: string }
export function floorVerdict(i: { net: number; floor: number; monthlyUpkeep: number; factor?: number; critical?: boolean }): FloorVerdict {
  const cost = Math.max(0, Number(i.monthlyUpkeep) || 0) * (i.factor ?? 2.7); const projected = Math.round(Number(i.net) - cost);
  const margin = Math.round(Number(i.net) - i.floor);
  if (projected >= i.floor) return { ok: true, projected, floor: i.floor, margin };
  // A critical fix (a service over capacity, an unserved district) goes ahead; the breach is reported.
  if (i.critical) return { ok: true, projected, floor: i.floor, margin, reason: 'critical_despite_floor' };
  return { ok: false, projected, floor: i.floor, margin, reason: 'net_floor' };
}

// PURE. What the improve loop is waiting for and roughly how long (owner: waiting, not cutting, is
// the answer to "cannot afford it yet"). track = recent readings {t (ms), cash, net}; rates come
// from the first and last reading. Returns '' when both floors are met with room to spend.
export function waitingFor(track: { t: number; cash: number; net: number }[], reserve: number, floor: number, minUpkeepRoom = 30_000): string {
  if (!track.length) return ''; const last = track[track.length - 1], first = track[0]; const minutes = Math.max(1 / 60, (last.t - first.t) / 60000);
  const eta = (missing: number, perMinute: number) => missing <= 0 ? '' : perMinute > 0 ? `about ${Math.max(1, Math.round(missing / perMinute))} min` : 'not rising yet';
  const m = (n: number) => (n / 1e6).toFixed(2) + 'M'; const parts: string[] = [];
  if (last.cash < reserve) parts.push(`cash ${m(last.cash)} of ${m(reserve)}, ${eta(reserve - last.cash, (last.cash - first.cash) / minutes)}`);
  if (last.net < floor + minUpkeepRoom) parts.push(`net ${m(last.net)} needs ${m(floor + minUpkeepRoom)} for new upkeep, ${eta(floor + minUpkeepRoom - last.net, (last.net - first.net) / minutes)}`);
  return parts.length ? 'waiting: ' + parts.join('; ') : '';
}
