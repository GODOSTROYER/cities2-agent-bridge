// Expansion rule (owner, 2026-10-11): the city expands only while it is happy.
//   below the threshold (80): improve mode, no expansion except what a fix needs;
//   at or above it for at least two reviews in a row (not one reading): grow-optimal, one district per step,
//   paid from cash above the reserve; after each district the next one waits for a review that still shows
//   happiness at the threshold, every non-tax factor at 0 or better and traffic no worse than before the district;
//   the moment happiness drops under the threshold: back to improve, fix first.
// Pure: the cycle keeps the state and calls this once per cycle.
export interface ExpansionState { streak: number; lastDistrict?: { t: number; flow: number; weighted: number; reviewed: boolean }; }
export interface ExpansionInput { happy: number; factors: Record<string, number>; cash: number; flow: number; weighted: number; }
export interface ExpansionPolicy { atHappiness?: number; sustainedReviews?: number; exempt?: string[]; trafficTolerance?: number; }

export function expansionStep(policy: ExpansionPolicy | undefined, reserve: number, i: ExpansionInput, st: ExpansionState | undefined, isReview: boolean): { mode: 'improve' | 'grow-optimal'; state: ExpansionState; why: string } {
  const at = Number(policy?.atHappiness ?? 80), need = Number(policy?.sustainedReviews ?? 2), exempt = policy?.exempt ?? ['Tax'], tol = Number(policy?.trafficTolerance ?? 1);
  const state: ExpansionState = { streak: st?.streak ?? 0, ...(st?.lastDistrict ? { lastDistrict: { ...st.lastDistrict } } : {}) };
  if (!policy) return { mode: 'improve', state, why: 'no expansion rule in policy.json' };
  if (!(i.happy >= at)) { state.streak = 0; return { mode: 'improve', state, why: `happiness ${i.happy} is under ${at}: improve first, no expansion` }; }
  if (isReview) { state.streak++; if (state.lastDistrict) state.lastDistrict.reviewed = true; }
  if (state.streak < need) return { mode: 'improve', state, why: `happiness ${i.happy} at ${at}+ for ${state.streak} of ${need} reviews: not yet sustained` };
  const negative = Object.entries(i.factors ?? {}).filter(([k, v]) => !exempt.includes(k) && Number(v) < 0).map(([k, v]) => `${k} ${v}`);
  if (negative.length) return { mode: 'improve', state, why: `a happiness factor is negative (${negative.join(', ')}): fix before the next district` };
  if (!(i.cash > reserve)) return { mode: 'improve', state, why: `cash ${Math.round(i.cash)} is not above the reserve ${reserve}` };
  const d = state.lastDistrict;
  if (d && !d.reviewed) return { mode: 'improve', state, why: 'the last district has not had its review yet (one district per step)' };
  if (d && (i.flow < d.flow - tol || i.weighted < d.weighted - tol)) return { mode: 'improve', state, why: `traffic got worse since the last district (game flow ${d.flow} -> ${i.flow}, weighted ${d.weighted} -> ${i.weighted}): fix first` };
  return { mode: 'grow-optimal', state, why: `happiness ${i.happy} at ${at}+ for ${state.streak} reviews, no negative factor, cash above the reserve: one district may be built` };
}

/** Called when a district was built: the next one waits for a review and for traffic no worse than now. */
export function districtBuilt(st: ExpansionState, i: ExpansionInput, nowMs: number): ExpansionState {
  return { streak: st.streak, lastDistrict: { t: nowMs, flow: i.flow, weighted: i.weighted, reviewed: false } };
}
