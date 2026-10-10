// Per-tool wall-clock timing for the cs2 MCP server. Offline: it only touches the timings file.
// Usage: call instrument(server) before registering tools; registerTimingsTool(server, z) adds a
// `timings` summary tool. Logging never throws into a tool call.
import { appendFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TIMINGS_PATH: string = process.env.CS2_TIMINGS ?? join(REPO_ROOT, 'journals', 'mcp-timings.jsonl');

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

// If the first content block is text holding a JSON object, add timing to it and return the
// new result plus any `phases` object. Otherwise return the result untouched.
function annotate(result: any, ms: number): { result: any; phases?: Record<string, unknown> } {
  try {
    const first = result?.content?.[0];
    if (first?.type !== 'text' || typeof first.text !== 'string') return { result };
    let obj: any;
    try {
      obj = JSON.parse(first.text);
    } catch {
      return { result };
    }
    if (!isPlainObject(obj)) return { result };
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
          error: String(err?.message ?? err),
        });
        throw err;
      }
      const ms = Math.round(performance.now() - start);
      const annotated = annotate(result, ms);
      const line: Record<string, unknown> = {
        utc: new Date().toISOString(),
        tool: name,
        ms,
        ok: !result?.isError,
      };
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

export async function summarize(sinceUtc?: string): Promise<any> {
  let raw: string;
  try {
    raw = await readFile(TIMINGS_PATH, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { calls: 0, tools: [] };
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

  const byTool = new Map<string, { ms: number[]; failed: number }>();
  let totalMs = 0;
  for (const e of entries) {
    const tool = String(e.tool ?? '?');
    const ms = Number(e.ms) || 0;
    totalMs += ms;
    let s = byTool.get(tool);
    if (!s) {
      s = { ms: [], failed: 0 };
      byTool.set(tool, s);
    }
    s.ms.push(ms);
    if (e.ok === false) s.failed++;
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
      failed: s.failed,
    };
  }).sort((a, b) => b.totalMs - a.totalMs);

  const slowest = entries
    .map(e => ({ tool: String(e.tool ?? '?'), ms: Number(e.ms) || 0, utc: String(e.utc ?? '') }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 5);

  return { calls: entries.length, totalMs, tools, slowest };
}

export function registerTimingsTool(server: any, z: any): void {
  server.registerTool(
    'timings',
    {
      description: 'Per-tool wall-clock timings of this MCP server (calls, avg, p50, max, slowest); use it to find harness overhead.',
      inputSchema: { since: z.string().optional() },
    },
    async ({ since }: { since?: string }) => ({
      content: [{ type: 'text', text: JSON.stringify(await summarize(since)) }],
    }),
  );
}
