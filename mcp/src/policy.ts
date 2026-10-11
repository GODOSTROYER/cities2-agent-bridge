// Owner policy as data (policy.json): which building types may never be placed, whatever rule asks
// for them. FAILURES #117: after the raw sewage outlets were replaced by treatment, the loop's sewage
// headroom rule placed a new raw outlet. Every placement path checks this list.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Json = Record<string, any>;
let cache: { at: number; value: Json } | null = null;

// The policy file of the repository (CS2_POLICY overrides the path for tests). Cached for 20 s.
export function loadPolicy(): Json {
  if (cache && Date.now() - cache.at < 20_000) return cache.value;
  let value: Json = {};
  try { value = JSON.parse(readFileSync(process.env.CS2_POLICY ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'policy.json'), 'utf8')); } catch { /* no policy file: nothing is forbidden */ }
  cache = { at: Date.now(), value }; return value;
}

// PURE. The forbidden rule (a part of the prefab name) that matches, or null.
export function forbiddenBy(policy: Json | undefined, prefab: string): string | null {
  for (const part of (policy?.forbiddenPrefabs ?? []) as string[]) if (part && prefab.toLowerCase().includes(String(part).toLowerCase())) return String(part);
  return null;
}

// PURE. A prefab list with the forbidden ones removed, order kept.
export function allowed(policy: Json | undefined, prefabs: string[]): string[] {
  return prefabs.filter(p => !forbiddenBy(policy, p));
}
