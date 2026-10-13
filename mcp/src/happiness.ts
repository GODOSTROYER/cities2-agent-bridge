// Happiness factor monitor for the cs2 MCP server. Owner rule: a factor worse than -5 is
// very_high (act now, every cycle until it improves); worse than -3 is priority (act this cycle,
// ahead of growth); -3 or better is normal. Every check is recorded so each action can be judged:
// if a factor does not improve after two actions, investigate instead of placing more of the same.
// Logging never throws into a tool call.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { callOk, REPO } from './bridge.ts';
import type { Json } from './bridge.ts';

export const HISTORY_PATH: string = process.env.CS2_HAPPINESS_HISTORY ?? join(REPO, 'journals', 'happiness-history.jsonl');
export const ACTIONS_PATH: string = process.env.CS2_ACTIONS ?? join(REPO, 'journals', 'actions.jsonl');

const SETTLE_MS = 5 * 60 * 1000;
const WINDOW_MS = 3 * 60 * 60 * 1000;
const RECORD_GAP_MS = 60 * 1000;

export function priorityOf(value: number): 'very_high' | 'priority' | 'normal' {
  if (value < -5) return 'very_high';
  if (value < -2) return 'priority'; // owner, 2026-10-13: nothing worse than -2 except Tax
  return 'normal';
}

export const FACTORS: Record<string, { need: string; fix: string }> = {
  Crime: { need: 'police', fix: 'police stations at the districts farthest from one or with the highest crime (crime_map); police budget 100% and staffing' },
  TrafficPenalty: { need: 'traffic', fix: 'fix_traffic (widen congested streets), parallel links (build_arterial), second highway connection' },
  Entertainment: { need: 'entertainment', fix: 'parks and playgrounds spread over residential districts' },
  Telecom: { need: 'telecom', fix: 'radio masts covering all homes' },
  Healthcare: { need: 'health', fix: 'clinics by coverage; health budget 100%' },
  DeathPenalty: { need: 'deathcare', fix: 'cemetery or crematorium' },
  Garbage: { need: 'garbage', fix: 'landfill or incinerator' },
  Education: { need: 'education', fix: 'schools by coverage' },
  Mail: { need: 'post', fix: 'post office' },
  Tax: { need: 'tax', fix: 'exempt by owner decision: rates are set to maximise tax income; report this factor, never lower rates because of it' },
  Unemployment: { need: 'jobs', fix: 'zone commercial, industrial or office where demand allows; lower their taxes' },
  Homelessness: { need: 'housing', fix: 'zone housing' },
  Electricity: { need: 'power', fix: 'power plants' },
  Water: { need: 'water', fix: 'water pumping' },
  Sewage: { need: 'sewage', fix: 'sewage outlets' },
  AirPollution: { need: 'pollution', fix: 'keep housing away from industry and highways; no building fixes it directly' },
  GroundPollution: { need: 'pollution', fix: 'keep housing away from industry and highways; no building fixes it directly' },
  NoisePollution: { need: 'pollution', fix: 'keep housing away from industry and highways; no building fixes it directly' },
};

// ---- recording ----
// The last write time is kept in memory; the first call seeds it from the last history line.
let lastWriteMs: number | undefined;
let lastWriteLoaded: Promise<void> | null = null;

async function lastRecordMs(): Promise<number | undefined> {
  try {
    const lines = (await readFile(HISTORY_PATH, 'utf8')).split('\n').filter(l => l.trim());
    if (!lines.length) return undefined;
    const t = Date.parse(String(JSON.parse(lines[lines.length - 1]).utc));
    return Number.isNaN(t) ? undefined : t;
  } catch {
    return undefined; // absent or unreadable: treat as no previous record
  }
}

// Appends one happiness record unless the previous one is under 60 s old. Returns true when written.
export async function recordFactors(snap: Json, nowMs = Date.now()): Promise<boolean> {
  try {
    if (snap?.happiness == null) return false;
    lastWriteLoaded ??= (async () => { lastWriteMs = await lastRecordMs(); })();
    await lastWriteLoaded;
    if (lastWriteMs !== undefined && nowMs - lastWriteMs < RECORD_GAP_MS) return false;
    const previous = lastWriteMs;
    lastWriteMs = nowMs; // reserve the slot before awaiting the write so concurrent calls skip
    const record = {
      utc: new Date(nowMs).toISOString(),
      frame: snap.liveFrame ?? snap.frame,
      pop: snap.city?.pop,
      happy: snap.happy,
      f: snap.happiness,
    };
    try {
      await mkdir(dirname(HISTORY_PATH), { recursive: true });
      await appendFile(HISTORY_PATH, JSON.stringify(record) + '\n', 'utf8');
      return true;
    } catch {
      lastWriteMs = previous;
      return false;
    }
  } catch {
    return false;
  }
}

export async function recordAction(a: { need: string; tool: string; detail?: string; factor?: number }, nowMs = Date.now()): Promise<void> {
  try {
    await mkdir(dirname(ACTIONS_PATH), { recursive: true });
    await appendFile(ACTIONS_PATH, JSON.stringify({ utc: new Date(nowMs).toISOString(), ...a }) + '\n', 'utf8');
  } catch {
    // Logging must never break a tool call.
  }
}

export async function readJsonl(path: string): Promise<Json[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return [];
    throw e; // an unreadable history must not look like an empty one
  }
  const out: Json[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip a torn line */ }
  }
  return out;
}

// ---- assessment (pure) ----
const round1 = (x: number): number => Math.round(x * 10) / 10;

export function assess(input: {
  factors: Record<string, number>;
  history: Json[];
  actions: Json[];
  nowMs: number;
  settleMs?: number;
  windowMs?: number;
}): Json[] {
  const nowMs = input.nowMs;
  const settleMs = input.settleMs ?? SETTLE_MS;
  const windowMs = input.windowMs ?? WINDOW_MS;
  const start = nowMs - windowMs;
  const inWindow = (t: number) => t >= start && t <= nowMs;
  const timed = (rows: Json[]) => rows
    .map(r => ({ r, t: Date.parse(String(r?.utc)) }))
    .filter(x => inWindow(x.t))
    .sort((a, b) => a.t - b.t);
  const history = timed(input.history);
  const actions = timed(input.actions);

  const out: Json[] = [];
  for (const [factor, value] of Object.entries(input.factors ?? {})) {
    if (typeof value !== 'number' || !(value < 0)) continue;
    const meta = Object.hasOwn(FACTORS, factor) ? FACTORS[factor] : undefined;
    const need = meta ? meta.need : null;
    const fix = meta ? meta.fix : '';
    const priority = priorityOf(value);

    let first = value;
    const oldest = history.find(x => typeof x.r?.f?.[factor] === 'number');
    if (oldest) first = oldest.r.f[factor];

    const acts = need === null ? [] : actions.filter(x => x.r?.need === need);
    const last = acts.length ? acts[acts.length - 1].t : null;
    const lastActionMinAgo = last === null ? null : Math.round((nowMs - last) / 60000);

    let verdict: string;
    if (need === null) {
      verdict = 'no_fix_known';
    } else if (acts.length >= 2) {
      const firstFactor = acts[0].r.factor;
      const base = typeof firstFactor === 'number' ? firstFactor : first;
      if (nowMs - (last as number) < settleMs) verdict = 'waiting';
      else if (value - base >= 0.5) verdict = 'improving';
      else verdict = 'investigate';
    } else if (acts.length === 1 && nowMs - (last as number) < settleMs) {
      verdict = 'waiting';
    } else {
      verdict = priority === 'very_high' ? 'act_now' : priority === 'priority' ? 'act' : 'watch';
    }

    out.push({
      factor,
      value,
      priority,
      need,
      fix,
      first,
      delta: round1(value - first),
      actions: acts.length,
      lastActionMinAgo,
      verdict,
    });
  }
  // Owner rule: the Tax factor is exempt from the priority rules (report only).
  for (const row of out) if (row.factor === 'Tax') { row.priority = 'exempt'; row.verdict = 'report_only'; }
  return out.sort((a, b) => a.value - b.value);
}

// ---- report and tool ----
export async function happinessReport(): Promise<Json> {
  const snap = await callOk('get_snapshot', {}, 10);
  await recordFactors(snap);
  const factors: Record<string, number> = snap.happiness ?? {};
  const assessed = assess({
    factors,
    history: await readJsonl(HISTORY_PATH),
    actions: await readJsonl(ACTIONS_PATH),
    nowMs: Date.now(),
  });
  const positive = Object.fromEntries(Object.entries(factors).filter(([, v]) => typeof v === 'number' && v > 0));
  return { happy: snap.happy, factors: assessed, positive };
}

export function registerHappinessTool(server: any, z: any): void {
  server.registerTool(
    'happiness',
    {
      description: "Happiness factors worst first with the owner's priority tags (worse than -5 very_high: act now; worse than -3 priority: act this cycle), the mapped fix, the trend since the first record, how many actions were taken, and a verdict (act_now, act, watch, waiting, improving, investigate). Non-pausing. Check it every play cycle.",
      inputSchema: {},
    },
    async () => {
      try {
        return { content: [{ type: 'text', text: JSON.stringify(await happinessReport()) }] };
      } catch (err: any) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: String(err?.message ?? err) }) }] };
      }
    },
  );
}
