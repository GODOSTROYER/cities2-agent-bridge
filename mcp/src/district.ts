// District watch (policy.json watchDistricts: [{ name, x0, x1, z0, z1 }]): the problem icons inside a
// rectangle, counted by the loop at every review and compared with the first count. A city total can
// improve while one district does not (the east high-density district stood full of garbage and
// hearse icons for hours while the report said "improving").
export interface DistrictCount { utc: string; name: string; garbage: number; hearse: number; total: number }

export function districtCount(name: string, counts: Record<string, number>, utc: string): DistrictCount {
  return { utc, name, garbage: Number(counts['Garbage Notification'] ?? 0), hearse: Number(counts['Hearse Notification'] ?? 0), total: Object.values(counts).reduce((a, b) => a + Number(b), 0) };
}

const change = (now: number, first: number) => first > 0 ? ` (${now >= first ? '+' : ''}${Math.round((now - first) / first * 100)}% since ${first})` : '';

/** One line for progress.md: the count now against the first count and the previous one. */
export function districtLine(now: DistrictCount, first?: DistrictCount, prev?: DistrictCount): string {
  const since = first && first.utc !== now.utc ? ` since ${first.utc.slice(11, 16)} UTC` : '';
  const trend = prev && prev.utc !== now.utc ? `; previous count ${prev.utc.slice(11, 16)}: garbage ${prev.garbage}, hearse ${prev.hearse}` : '';
  return `- DISTRICT ${now.name}${since}: garbage icons ${now.garbage}${first ? change(now.garbage, first.garbage) : ''}, hearse icons ${now.hearse}${first ? change(now.hearse, first.hearse) : ''}, all problem icons ${now.total}${trend}`;
}

/** Raised when a watched district has not improved over the last hour (the totals may hide it). */
export function districtAttention(history: DistrictCount[], nowMs: number): string {
  if (history.length < 2) return ''; const now = history[history.length - 1];
  const old = [...history].reverse().find(h => nowMs - Date.parse(h.utc) >= 60 * 60000); if (!old) return '';
  const a = now.garbage + now.hearse, b = old.garbage + old.hearse;
  return a > 20 && a >= b * 0.9 ? `district ${now.name}: garbage+hearse icons ${b} -> ${a} in the last hour, not improving: diagnose this district (reach, access, facility on its side)` : '';
}
