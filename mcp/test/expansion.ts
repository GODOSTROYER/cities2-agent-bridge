// Offline checks: the owner's expansion rule (expand only at happiness 80+, sustained, step by step).
import { expansionStep, districtBuilt } from '../src/expansion.ts';
import type { ExpansionState } from '../src/expansion.ts';
let failed = 0; const check = (ok: boolean, label: string) => { console.log((ok ? 'PASS: ' : 'FAIL: ') + label); if (!ok) failed++; };
const pol = { atHappiness: 80, sustainedReviews: 2, exempt: ['Tax'], trafficTolerance: 1 }; const reserve = 20_000_000;
const good = { happy: 81, factors: { Tax: -5.8, Mail: 6, Education: 4 }, cash: 43_000_000, flow: 53, weighted: 37 };
let st: ExpansionState | undefined;

let r = expansionStep(pol, reserve, { ...good, happy: 75 }, st, true); st = r.state;
check(r.mode === 'improve' && r.state.streak === 0 && /under 80/.test(r.why), 'happiness 75: improve mode, no expansion');
r = expansionStep(pol, reserve, good, st, true); st = r.state;
check(r.mode === 'improve' && st.streak === 1 && /1 of 2 reviews/.test(r.why), 'the first review at 81 is one reading, not yet sustained');
r = expansionStep(pol, reserve, good, st, false); st = r.state;
check(r.mode === 'improve' && st.streak === 1, 'cycles between reviews do not count as reviews');
r = expansionStep(pol, reserve, good, st, true); st = r.state;
check(r.mode === 'grow-optimal' && st.streak === 2, 'two reviews in a row at 80+ switch to grow-optimal: ' + r.why);
check(expansionStep(pol, reserve, { ...good, factors: { ...good.factors, NoisePollution: -0.9 } }, st, false).mode === 'improve', 'a negative non-tax factor holds expansion even at 81');
check(expansionStep(pol, reserve, { ...good, factors: { Tax: -9 } }, st, false).mode === 'grow-optimal', 'the Tax factor is exempt');
check(expansionStep(pol, reserve, { ...good, cash: 19_900_000 }, st, false).mode === 'improve', 'cash under the 20M reserve: no district');
check(expansionStep(pol, reserve, { ...good, cash: 20_000_000 }, st, false).mode === 'improve', 'cash exactly at the reserve is not above it');
// one district per step
st = districtBuilt(st!, good, 1000);
r = expansionStep(pol, reserve, good, st, false); st = r.state;
check(r.mode === 'improve' && /has not had its review/.test(r.why), 'after a district the next one waits for a review');
r = expansionStep(pol, reserve, { ...good, flow: 50, weighted: 37 }, st, true); st = r.state;
check(r.mode === 'improve' && /traffic got worse/.test(r.why), 'the review after a district finds traffic worse (53 -> 50): fix first, no next district');
r = expansionStep(pol, reserve, { ...good, flow: 52.5 }, st, false);
check(r.mode === 'grow-optimal', 'traffic within one point of the level before the district counts as no worse');
// a drop under 80 stops expansion at once and the streak starts again
r = expansionStep(pol, reserve, { ...good, happy: 79 }, st, false); st = r.state;
check(r.mode === 'improve' && st.streak === 0, 'happiness 79 on any cycle: back to improve at once, streak reset');
r = expansionStep(pol, reserve, good, st, true); st = r.state;
check(r.mode === 'improve', 'after a drop one good review is again not enough');
check(expansionStep(undefined, reserve, good, undefined, true).mode === 'improve', 'without the rule in policy.json nothing expands');
check(expansionStep({ atHappiness: 80 }, reserve, good, { streak: 5 }, false).mode === 'grow-optimal', 'defaults: two reviews, Tax exempt, tolerance one point');
console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`); process.exit(failed ? 1 : 0);
