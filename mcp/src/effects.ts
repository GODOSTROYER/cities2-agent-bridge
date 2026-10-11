// Verify and learn: did the metric an action aimed at move? Each action is judged by its system's
// value just before it and WINDOW minutes after it (higher is better). Later planning prefers the
// tools that moved their system and undoes the ones that did not. PURE: no imports, unit-tested in
// test/effects.ts.
export interface ActionRow { utc: string; need: string; tool: string; detail?: string }
export interface MetricRow { utc: string; values: Record<string, number> }
export type Verdict = 'effective' | 'ineffective' | 'worse' | 'unknown' | 'pending';
export interface Evaluated { utc: string; need: string; tool: string; detail?: string; system: string | null; before: number | null; after: number | null; delta: number | null; verdict: Verdict }
export interface EffectRow { tool: string; need: string; n: number; effective: number; ineffective: number; worse: number; pending: number; avgDelta: number | null; rate: number | null }

// Planner need -> the system name reported in journals/metrics-history.jsonl.
export const NEED_SYSTEM: Record<string, string> = { police: 'Police', health: 'Healthcare', deathcare: 'Deathcare', fire: 'Fire and rescue', garbage: 'Garbage', post: 'Post', entertainment: 'Parks and recreation (leisure)', telecom: 'Telecom', education: 'Education: elementary', education_high: 'Education: high school', education_college: 'Education: college', education_university: 'Education: university', traffic: 'Traffic', power: 'Electricity', water: 'Water', sewage: 'Sewage', pollution: 'Air pollution', network: 'Electricity' };

const MIN = 60000;
const round2 = (x: number) => Math.round(x * 100) / 100;

// The last row at or before timeMs that reports the system. Rows may be unsorted; the input is not changed.
function rowAt(metrics: MetricRow[], system: string, timeMs: number): { t: number; v: number } | null {
  let best: { t: number; v: number } | null = null;
  for (const m of metrics) {
    const t = Date.parse(m.utc), v = m.values?.[system];
    if (!Number.isFinite(t) || !(t <= timeMs) || typeof v !== 'number' || !Number.isFinite(v)) continue;
    if (best === null || t >= best.t) best = { t, v };
  }
  return best;
}

export function valueAt(metrics: MetricRow[], system: string, timeMs: number): number | null {
  return rowAt(metrics, system, timeMs)?.v ?? null;
}

// Change in value, cleaned of float noise (1.3 - 1 is not exactly 0.3).
export function change(before: number | null, after: number | null): number | null {
  return before == null || after == null ? null : Math.round((after - before) * 1e6) / 1e6;
}

export function judge(before: number | null, after: number | null, minDelta = 0.3): Exclude<Verdict, 'pending'> {
  const d = change(before, after);
  return d === null ? 'unknown' : d >= minDelta ? 'effective' : d <= -minDelta ? 'worse' : 'ineffective';
}

export function evaluate(actions: ActionRow[], metrics: MetricRow[], nowMs: number, windowMin = 20): Evaluated[] {
  const windowMs = windowMin * MIN;
  return actions.map((a): Evaluated => {
    const t = Date.parse(a.utc);
    // An unmapped need can never be judged, so it is unknown at once rather than pending.
    const system = Object.hasOwn(NEED_SYSTEM, a.need) ? NEED_SYSTEM[a.need] : null;
    const base = { utc: a.utc, need: a.need, tool: a.tool, detail: a.detail, system };
    if (system === null) return { ...base, before: null, after: null, delta: null, verdict: 'unknown' };
    const before = valueAt(metrics, system, t);
    if (nowMs - t < windowMs) return { ...base, before, after: null, delta: null, verdict: 'pending' };
    // The after value counts only from a row LATER than the action; otherwise nothing has been measured.
    const later = rowAt(metrics, system, t + windowMs);
    const after = later && later.t > t ? later.v : null;
    return { ...base, before, after, delta: change(before, after), verdict: judge(before, after) };
  });
}

// Actions grouped by (tool, need), in first-seen order.
function groupBy(items: Evaluated[]): Evaluated[][] {
  const groups = new Map<string, Evaluated[]>();
  for (const e of items) {
    const key = JSON.stringify([e.tool, e.need]);
    const g = groups.get(key);
    if (g) g.push(e); else groups.set(key, [e]);
  }
  return [...groups.values()];
}

export function effectsTable(evaluated: Evaluated[]): EffectRow[] {
  const rows = groupBy(evaluated).map((items): EffectRow => {
    const count = (v: Verdict) => items.filter(i => i.verdict === v).length;
    const effective = count('effective'), ineffective = count('ineffective'), worse = count('worse');
    const deltas = items.map(i => i.delta).filter(d => d !== null) as number[];
    const judged = effective + ineffective + worse;
    return {
      tool: items[0].tool, need: items[0].need, n: items.length, effective, ineffective, worse, pending: count('pending'),
      avgDelta: deltas.length ? round2(deltas.reduce((s, d) => s + d, 0) / deltas.length) : null,
      rate: judged ? round2(effective / judged) : null,
    };
  });
  return rows.sort((a, b) => b.n - a.n);
}

// Groups with enough judged actions and not one effective: the first things to undo when the floor is breached.
export function undoCandidates(evaluated: Evaluated[], minRepeats = 2): { need: string; tool: string; details: string[]; why: string }[] {
  const out: { need: string; tool: string; details: string[]; why: string }[] = [];
  for (const items of groupBy(evaluated)) {
    const { tool, need } = items[0];
    const judged = items.filter(i => i.verdict === 'effective' || i.verdict === 'ineffective' || i.verdict === 'worse');
    if (judged.length < Math.max(1, minRepeats) || judged.some(i => i.verdict === 'effective')) continue;
    const details = [...new Set(judged.map(i => i.detail).filter(d => typeof d === 'string' && d !== ''))] as string[];
    const deltas = judged.map(i => i.delta).filter(d => d !== null) as number[];
    const avg = deltas.length ? round2(deltas.reduce((s, d) => s + d, 0) / deltas.length) : null;
    out.push({ need, tool, details, why: `${tool} for ${need}: ${judged.length} actions, none moved ${items[0].system ?? need} (avg delta ${avg ?? 'n/a'})` });
  }
  return out;
}

// One short report line per row, at most max lines.
export function effectsLines(table: EffectRow[], max = 6): string[] {
  return table.slice(0, Math.max(0, max)).map(r => {
    const head = `${r.tool}/${r.need}`;
    if (r.rate === null) return `${head}: no verdict yet`;
    const judged = r.effective + r.ineffective + r.worse;
    const avg = r.avgDelta === null ? '' : `, avg ${r.avgDelta >= 0 ? '+' : ''}${r.avgDelta}`;
    return `${head}: ${r.effective} of ${judged} effective${avg}`;
  });
}
