// Structured projection for raw query results: the output is always valid JSON. Callers pick
// fields (dot paths; arrays are mapped) or page arrays; an oversized result is summarised with
// its shape instead of being cut in the middle of a string.
import type { Json } from './bridge.ts';

// "a.b.c" on objects; arrays are mapped element-wise; missing paths are omitted.
export function pluck(value: Json, path: string[]): Json {
  if (path.length === 0 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(v => pluck(v, path));
  if (typeof value !== 'object') return undefined;
  return pluck(value[path[0]], path.slice(1));
}

// Keeps only the requested dot paths, rebuilding the nesting ({a:{b:1}} for "a.b").
export function project(value: Json, fields: string[]): Json {
  if (Array.isArray(value)) return value.map(v => project(v, fields));
  if (value === null || typeof value !== 'object') return value;
  // Group the paths by their first segment so "edges.index" and "edges.prefab" project the
  // same array once, keeping both fields on every element.
  const groups = new Map<string, string[] | null>();
  for (const f of fields) {
    const parts = f.split('.').filter(Boolean); if (!parts.length) continue;
    const head = parts[0]; const rest = parts.slice(1).join('.');
    if (!rest) groups.set(head, null);                               // the whole value
    else if (groups.get(head) !== null) groups.set(head, [...(groups.get(head) ?? []), rest]);
  }
  const out: Json = {};
  for (const [head, subs] of groups) {
    if (!(head in value)) continue;
    const v = value[head];
    out[head] = subs === null || v === null || typeof v !== 'object' ? v : project(v, subs);
  }
  return out;
}

// One line per top-level key: type and size, so the caller can ask for the right fields.
export function shapeOf(value: Json): Json {
  if (Array.isArray(value)) return { type: 'array', length: value.length, itemKeys: value.length && value[0] && typeof value[0] === 'object' ? Object.keys(value[0]).slice(0, 20) : undefined };
  if (value === null || typeof value !== 'object') return { type: typeof value };
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, Array.isArray(v) ? `array[${v.length}]` + (v.length && v[0] && typeof v[0] === 'object' ? ` of {${Object.keys(v[0]).slice(0, 8).join(',')}}` : '') : v !== null && typeof v === 'object' ? `object{${Object.keys(v).slice(0, 8).join(',')}}` : typeof v]));
}

// Applies fields and array paging, then guarantees valid JSON within maxChars.
export function fit(value: Json, opts: { fields?: string[]; offset?: number; limit?: number; maxChars: number }): string {
  let v = opts.fields?.length ? project(value, opts.fields) : value;
  // Page the first array found at the top level (or the value itself when it is an array).
  const pageArray = (arr: Json[]) => arr.slice(opts.offset ?? 0, opts.limit !== undefined ? (opts.offset ?? 0) + opts.limit : undefined);
  let paged: Json = null;
  if (opts.offset !== undefined || opts.limit !== undefined) {
    if (Array.isArray(v)) { paged = { total: v.length }; v = pageArray(v); }
    else if (v && typeof v === 'object') {
      const key = Object.keys(v).find(k => Array.isArray(v[k]));
      if (key) { paged = { key, total: v[key].length }; v = { ...v, [key]: pageArray(v[key]) }; }
    }
  }
  const text = JSON.stringify(paged ? { page: { ...paged, offset: opts.offset ?? 0, limit: opts.limit ?? null }, result: v } : v) ?? 'null';
  if (text.length <= opts.maxChars) return text;
  // Too large: shrink the first array until it fits, and say what was left out.
  if (v && typeof v === 'object') {
    const key = Array.isArray(v) ? null : Object.keys(v).find(k => Array.isArray(v[k]));
    const arr: Json[] | null = Array.isArray(v) ? v : key ? v[key] : null;
    if (arr) {
      let n = arr.length;
      while (n > 0) {
        n = Math.floor(n / 2);
        const cut = Array.isArray(v) ? arr.slice(0, n) : { ...v, [key as string]: arr.slice(0, n) };
        const t = JSON.stringify({ truncated: true, returned: n, total: arr.length, hint: 'pass offset/limit to page, or fields to project', result: cut });
        if (t.length <= opts.maxChars) return t;
      }
    }
  }
  const summary = JSON.stringify({ truncated: true, chars: text.length, shape: shapeOf(v), hint: 'pass fields (dot paths) to project, or offset/limit to page an array' });
  if (summary.length <= opts.maxChars) return summary;
  // Even the shape is too large: name as many top-level keys as fit. Never cut inside a string.
  let keys = v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : [];
  for (;;) {
    const minimal = JSON.stringify({ truncated: true, chars: text.length, keys });
    if (minimal.length <= opts.maxChars || keys.length === 0) return minimal;
    keys = keys.slice(0, Math.floor(keys.length / 2));
  }
}
