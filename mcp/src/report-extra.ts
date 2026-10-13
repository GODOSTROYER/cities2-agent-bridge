// Inputs for journals/REPORT.md from reads the bridge ALREADY answers (read-only query commands):
// transit_lines (lines and stops), outside_connections (connections by kind and prefab) and
// get_metrics.headroom.telecom. The summarizers are PURE; readExtra() makes the reads and never throws:
// a failed read leaves its row unknown with the error text (report.ts).
// Pausing: transit_lines, outside_connections and get_metrics are in the mod's NonPausingReads list.

export type Reader = (name: string, args?: Record<string, any>) => Promise<Record<string, any>>;

/** A stop with at least this many passengers waiting is a queue the report grades bad. */
export const STOP_QUEUE_BAD = 200;

export interface ModeTotals { lines: number; vehicles: number; aboard: number; waiting: number; noPath: number; empty: number }
export interface TransitSummary {
  lines: number; vehicles: number; aboard: number; seats: number; waiting: number;
  byMode: Record<string, ModeTotals>;
  linesNoPath: number; segmentsNoPath: number; empty: number; // empty: vehicles running, nobody aboard or waiting
  stops: number; stopsQueued: number; maxStopWaiting: number;
}
export interface OutsideSummary { total: number; transport: number; power: number; pipe: number; byMode: Record<string, number> }
export interface ExtraInput {
  transit?: TransitSummary; transitError?: string;
  outside?: OutsideSummary; outsideError?: string;
  telecom?: { capacity: number; buildings: number };
}

const num = (v: any) => Number.isFinite(Number(v)) ? Number(v) : 0;

/** Mode from the prefab name (the game names its line prefabs by mode: "Bus Line", "Tram Line", ...). */
export function modeOf(prefab: string): string {
  if (/Subway|Metro/i.test(prefab)) return 'subway';
  if (/Bus/i.test(prefab)) return 'bus';
  if (/Tram/i.test(prefab)) return 'tram';
  if (/Train|Rail/i.test(prefab)) return 'train';
  if (/Ship|Ferry|Harbor/i.test(prefab)) return 'ship';
  if (/Airplane|Airport|Air/i.test(prefab)) return 'air';
  if (/Taxi/i.test(prefab)) return 'taxi';
  return 'other';
}

/** transit_lines: lines (per line: vehicles, aboard, seats, waiting, segmentsWithoutPath) and stops (kind, waiting). */
export function summarizeTransit(lines: any[], stops: any[]): TransitSummary {
  const s: TransitSummary = { lines: lines.length, vehicles: 0, aboard: 0, seats: 0, waiting: 0, byMode: {}, linesNoPath: 0, segmentsNoPath: 0, empty: 0, stops: stops.length, stopsQueued: 0, maxStopWaiting: 0 };
  for (const l of lines) {
    const mode = modeOf(String(l.prefab ?? '')); const m: ModeTotals = s.byMode[mode] ?? (s.byMode[mode] = { lines: 0, vehicles: 0, aboard: 0, waiting: 0, noPath: 0, empty: 0 });
    const v = num(l.vehicles), a = num(l.aboard), w = num(l.waiting), bad = num(l.segmentsWithoutPath);
    m.lines++; m.vehicles += v; m.aboard += a; m.waiting += w;
    s.vehicles += v; s.aboard += a; s.seats += num(l.seats); s.waiting += w; s.segmentsNoPath += bad;
    if (bad > 0) { m.noPath++; s.linesNoPath++; }
    if (v > 0 && a === 0 && w === 0) { m.empty++; s.empty++; }
  }
  for (const st of stops) { const w = num(st.waiting); s.maxStopWaiting = Math.max(s.maxStopWaiting, w); if (w >= STOP_QUEUE_BAD) s.stopsQueued++; }
  return s;
}

/** outside_connections: connections by kind (transport, power, pipe) and, for transport, by mode. */
export function summarizeOutside(conns: any[]): OutsideSummary {
  const s: OutsideSummary = { total: conns.length, transport: 0, power: 0, pipe: 0, byMode: {} };
  for (const c of conns) {
    const kind = String(c.kind ?? ''), prefab = String(c.prefab ?? '');
    if (kind === 'power') s.power++;
    else if (kind === 'pipe') s.pipe++;
    else { s.transport++; const mode = /Road/i.test(prefab) ? 'road' : modeOf(prefab); s.byMode[mode] = (s.byMode[mode] ?? 0) + 1; }
  }
  return s;
}

// A reply is the projected object, or (when it was paged or summarised) { truncated, result: {...} }.
function listOf(r: any, key: string): any[] {
  if (r?.truncated) throw new Error(`${key} read was cut (${r.returned} of ${r.total})`);
  const a = r?.[key] ?? r?.result?.[key];
  if (!Array.isArray(a)) throw new Error(`no ${key} in the reply`);
  return a;
}

/** Makes the read-only calls. Each read is independent: one failure leaves only its own row unknown. */
export async function readExtra(tool: Reader): Promise<ExtraInput> {
  const out: ExtraInput = {};
  try {
    const lines = listOf(await tool('query', { command: 'transit_lines', args: {}, fields: ['lines.prefab', 'lines.vehicles', 'lines.aboard', 'lines.seats', 'lines.waiting', 'lines.segmentsWithoutPath'], limit: 200, maxChars: 8000 }), 'lines');
    const stops = listOf(await tool('query', { command: 'transit_lines', args: {}, fields: ['stops.kind', 'stops.waiting'], limit: 500, maxChars: 20000 }), 'stops');
    out.transit = summarizeTransit(lines, stops);
  } catch (e: any) { out.transitError = String(e?.message ?? e); }
  try { out.outside = summarizeOutside(listOf(await tool('query', { command: 'outside_connections', args: {}, fields: ['connections.kind', 'connections.prefab'], maxChars: 6000 }), 'connections')); }
  catch (e: any) { out.outsideError = String(e?.message ?? e); }
  try { const t = (await tool('query', { command: 'get_metrics', args: {}, fields: ['headroom.telecom'], maxChars: 400 })).headroom?.telecom; if (t) out.telecom = { capacity: num(t.capacity), buildings: num(t.buildings) }; }
  catch { /* optional: the Telecom outcome is then the factor alone */ }
  return out;
}
