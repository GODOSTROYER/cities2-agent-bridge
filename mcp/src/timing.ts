// Per-tool wall-clock timing for the cs2 MCP server. Offline: it only touches the timings file.
// Usage: call instrument(server) before registering tools; registerTimingsTool(server, z) adds a
// `timings` summary tool. Logging never throws into a tool call.
//
// Each call is classified three ways (B12: a normal result whose JSON says ok:false is not a success):
//   transport: 'ok' when the handler returned and result.isError is not true; 'error' when it threw
//              or returned isError (bridge not responding, timeout, validation error).
//   domain:    from the JSON object in the first text block: 'ok' (ok === true), 'failed' (ok === false),
//              'partial' (partial === true, takes precedence), 'n/a' (no boolean ok, or not an object).
//   verified:  true only for a completed verification; false for failed or partial; null otherwise.
// The log line's `ok` is kept for compatibility: transport 'ok' and domain neither 'failed' nor 'partial'.
import { appendFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TIMINGS_PATH: string = process.env.CS2_TIMINGS ?? join(REPO_ROOT, 'journals', 'mcp-timings.jsonl');

type Transport = 'ok' | 'error';
type Domain = 'ok' | 'failed' | 'partial' | 'n/a';
const DOMAINS: string[] = ['ok', 'failed', 'partial', 'n/a'];

function isPlainObject(v: any): boolean {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function appendLine(entry: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(TIMINGS_PATH), { recursive: true });
    appendFileSync(TIMINGS_PATH, JSON.stringify(entry) + '\n');
  } catch {
    // Logging must never break a tool call.
  }
}

// The first content block parsed as a JSON object, or undefined for anything else.
function readObject(result: any): { first: any; obj: Record<string, any> } | undefined {
  try {
    const first = result?.content?.[0];
    if (first?.type !== 'text' || typeof first.text !== 'string') return undefined;
    const obj = JSON.parse(first.text);
    return isPlainObject(obj) ? { first, obj } : undefined;
  } catch {
    return undefined;
  }
}

function classifyDomain(obj: Record<string, any> | undefined): Domain {
  if (!obj) return 'n/a';
  if (obj.partial === true) return 'partial';
  if (obj.ok === true) return 'ok';
  if (obj.ok === false) return 'failed';
  return 'n/a';
}

function classifyVerified(obj: Record<string, any> | undefined): boolean | null {
  if (!obj) return null;
  if (obj.ok === false || obj.partial === true) return false;
  const completed = obj.connected === true || obj.leftZonable === 0 || obj.verified === true
    || (obj.at !== null && typeof obj.at === 'object');
  return obj.ok === true && completed ? true : null;
}

// Adds timing to the parsed object and returns the new result plus any `phases` object.
function annotate(result: any, parsed: { first: any; obj: Record<string, any> } | undefined, ms: number):
  { result: any; phases?: Record<string, unknown> } {
  if (!parsed) return { result };
  try {
    const { first, obj } = parsed;
    const phases = isPlainObject(obj.phases) ? obj.phases : undefined;
    if ('ms' in obj) obj.totalMs = ms;
    else obj.ms = ms;
    const content = [{ ...first, text: JSON.stringify(obj) }, ...result.content.slice(1)];
    return { result: { ...result, content }, phases };
  } catch {
    return { result };
  }
}

export function instrument(server: any): void {
  const original = server.registerTool;
  server.registerTool = function (name: string, config: any, handler: any) {
    const wrapped = async function (...args: any[]): Promise<any> {
      const start = performance.now();
      let result: any;
      try {
        result = await handler.apply(this, args);
      } catch (err: any) {
        appendLine({
          utc: new Date().toISOString(),
          tool: name,
          ms: Math.round(performance.now() - start),
          ok: false,
          transport: 'error',
          domain: 'n/a',
          verified: null,
          error: String(err?.message ?? err),
        });
        throw err;
      }
      const ms = Math.round(performance.now() - start);
      const transport: Transport = result?.isError === true ? 'error' : 'ok';
      const parsed = readObject(result);
      const domain = classifyDomain(parsed?.obj);
      const verified = classifyVerified(parsed?.obj);
      const reason = parsed?.obj.reason;
      const annotated = annotate(result, parsed, ms);
      const line: Record<string, unknown> = {
        utc: new Date().toISOString(),
        tool: name,
        ms,
        ok: transport === 'ok' && domain !== 'failed' && domain !== 'partial',
        transport,
        domain,
        verified,
      };
      if ((domain === 'failed' || domain === 'partial') && typeof reason === 'string') line.reason = reason;
      if (annotated.phases) line.phases = annotated.phases;
      appendLine(line);
      return annotated.result;
    };
    return original.call(this, name, config, wrapped);
  };
}

// True when `utc` is strictly later than `sinceUtc`. Falls back to string order if either is unparseable.
function afterSince(utc: unknown, sinceUtc: string): boolean {
  const t = Date.parse(String(utc));
  const s = Date.parse(sinceUtc);
  if (Number.isNaN(t) || Number.isNaN(s)) return String(utc) > sinceUtc;
  return t > s;
}

// Classes for one log line. Old lines (only `ok`) map to: ok:false = transport error,
// ok:true = transport ok with domain n/a.
function classifyLine(e: any): { transport: Transport; domain: Domain; verified: boolean } {
  if (typeof e.transport !== 'string') {
    return { transport: e.ok === false ? 'error' : 'ok', domain: 'n/a', verified: false };
  }
  return {
    transport: e.transport === 'error' ? 'error' : 'ok',
    domain: DOMAINS.includes(e.domain) ? e.domain : 'n/a',
    verified: e.verified === true,
  };
}

export async function summarize(sinceUtc?: string): Promise<any> {
  let raw: string;
  try {
    raw = await readFile(TIMINGS_PATH, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { calls: 0, tools: [], totals: { transportErrors: 0, domainFailed: 0, partial: 0, verified: 0 } };
    throw err;
  }

  const entries: any[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPlainObject(e)) continue;
    if (sinceUtc && !afterSince(e.utc, sinceUtc)) continue;
    entries.push(e);
  }

  // Each call lands in at most one of transportErrors / domainFailed / partial, so their sum is the
  // number of calls that were not ok.
  type Stat = { ms: number[]; transportErrors: number; domainFailed: number; partial: number; verified: number };
  const byTool = new Map<string, Stat>();
  let totalMs = 0;
  for (const e of entries) {
    const tool = String(e.tool ?? '?');
    const ms = Number(e.ms) || 0;
    totalMs += ms;
    let s = byTool.get(tool);
    if (!s) {
      s = { ms: [], transportErrors: 0, domainFailed: 0, partial: 0, verified: 0 };
      byTool.set(tool, s);
    }
    s.ms.push(ms);
    const c = classifyLine(e);
    if (c.transport === 'error') s.transportErrors++;
    else if (c.domain === 'failed') s.domainFailed++;
    else if (c.domain === 'partial') s.partial++;
    if (c.verified) s.verified++;
  }

  const tools = [...byTool].map(([tool, s]) => {
    const sorted = [...s.ms].sort((a, b) => a - b);
    const n = sorted.length;
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
      tool,
      n,
      avgMs: Math.round(sum / n),
      p50Ms: sorted[Math.ceil(n / 2) - 1], // nearest-rank median
      maxMs: sorted[n - 1],
      totalMs: sum,
      transportErrors: s.transportErrors,
      domainFailed: s.domainFailed,
      partial: s.partial,
      verified: s.verified,
      failed: s.transportErrors + s.domainFailed + s.partial,
    };
  }).sort((a, b) => b.totalMs - a.totalMs);

  const totals = { transportErrors: 0, domainFailed: 0, partial: 0, verified: 0 };
  for (const t of tools) {
    totals.transportErrors += t.transportErrors;
    totals.domainFailed += t.domainFailed;
    totals.partial += t.partial;
    totals.verified += t.verified;
  }

  const slowest = entries
    .map(e => ({ tool: String(e.tool ?? '?'), ms: Number(e.ms) || 0, utc: String(e.utc ?? '') }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 5);

  return { calls: entries.length, totalMs, tools, slowest, totals };
}

export function registerTimingsTool(server: any, z: any): void {
  server.registerTool(
    'timings',
    {
      description: 'Per-tool wall-clock timings of this MCP server (calls, avg, p50, max, slowest, transport/domain failures, verified); use it to find harness overhead.',
      inputSchema: { since: z.string().optional() },
    },
    async ({ since }: { since?: string }) => ({
      content: [{ type: 'text', text: JSON.stringify(await summarize(since)) }],
    }),
  );
}
