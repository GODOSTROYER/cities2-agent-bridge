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

// A new district is discretionary, except job zones while unemployment is above 10%
// (they pay back through tax income and cut the Unemployment factor).
export function growClass(zone: string, unemployment: number): SpendClass {
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
