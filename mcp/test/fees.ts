// Offline checks: parking and service fee decisions, judging, summary and report lines.
import { occupancyPct, decideParkingFees, decideServiceFees, judgeFeeChange, parkingSummary, feeLines } from '../src/fees.ts';
import type { ParkingSite, FeeChange, FeeHistoryRow, FeePolicy } from '../src/fees.ts';
let failed = 0; const check = (ok: boolean, label: string) => { console.log((ok ? 'PASS: ' : 'FAIL: ') + label); if (!ok) failed++; };

const MIN = 60000;
const NOW = Date.parse('2026-10-11T12:00:00Z');
const S = (id: string, capacity: number, parked: number, fee: number): ParkingSite => ({ id, kind: 'lot', x: 0, z: 0, capacity, parked, fee });
const H = (target: string, minAgo: number, from: number, to: number, before?: number, after?: number): FeeHistoryRow => ({ target, t: NOW - minAgo * MIN, from, to, before, after });
const one = (s: ParkingSite, hist: FeeHistoryRow[] = [], policy: FeePolicy = {}) => decideParkingFees([s], policy, hist, NOW);

// occupancyPct
check(occupancyPct(S('a', 100, 92, 10)) === 92, 'occupancy: 92 of 100 places is 92%');
check(occupancyPct(S('a', 3, 1, 10)) === 33, 'occupancy: 1 of 3 places rounds to 33%');
check(occupancyPct(S('a', 0, 0, 10)) === null, 'occupancy: a site with no capacity has no percentage');
check(occupancyPct(S('a', NaN, 5, 10)) === null, 'occupancy: a capacity that is not a number has no percentage');

// parking: raise and lower
const r1 = one(S('a', 100, 92, 10));
check(r1.length === 1 && r1[0].from === 10 && r1[0].to === 15 && r1[0].kind === 'parking' && r1[0].target === 'a', 'parking: 92% full with fee 10 is raised one step to 15');
check(r1[0].why === 'occupancy 92% is above 85%: fee 10 -> 15', 'parking: the raise reason is one sentence with the numbers');
check(one(S('a', 100, 92, 48))[0]?.to === 50, 'parking: a raise from 48 stops at the maximum of 50');
check(one(S('a', 100, 92, 50)).length === 0, 'parking: a full site already at the maximum fee is left alone');
const l1 = one(S('a', 100, 40, 10));
check(l1.length === 1 && l1[0].to === 5 && l1[0].why === 'occupancy 40% is below 50%: fee 10 -> 5', 'parking: 40% full with fee 10 is lowered one step to 5');
check(one(S('a', 100, 40, 3))[0]?.to === 0, 'parking: a lowering from 3 stops at the minimum of 0');
check(one(S('a', 100, 40, 0)).length === 0, 'parking: an empty site that is already free is left alone');
check(one(S('a', 100, 78, 10)).length === 0, 'parking: 78% is inside the 70 to 85 band, no change');
check(one(S('a', 100, 85, 10)).length === 0 && one(S('a', 100, 50, 10)).length === 0, 'parking: exactly 85% and exactly 50% are not past the thresholds');

// parking: start moderate
check(one(S('a', 100, 75, 0))[0]?.to === 10, 'parking: a free site at 75% that was never changed starts at 10');
check(one(S('a', 100, 90, 0))[0]?.to === 10, 'parking: a free site at 90% that was never changed starts at 10, not 5');
check(one(S('a', 100, 60, 0)).length === 0, 'parking: a free site at 60% stays free because it is below the band');
check(one(S('a', 100, 75, 0), [H('a', 120, 5, 0)]).length === 0, 'parking: a free site at 75% that was changed before is not restarted');
check(one(S('a', 100, 90, 0), [H('a', 60, 5, 0)])[0]?.to === 5, 'parking: a free site at 90% that was changed before gets the normal one step raise');

// parking: review hold
check(one(S('a', 100, 92, 10), [H('a', 10, 5, 10)]).length === 0, 'parking: a site changed 10 minutes ago is held for review');
check(one(S('a', 100, 92, 10), [H('a', 20, 5, 10)]).length === 1, 'parking: a site changed exactly 20 minutes ago is open for change again');
check(one(S('a', 100, 92, 10), [H('a', 100, 5, 10), H('a', 5, 10, 15)]).length === 0, 'parking: the latest history row decides the hold, not the oldest');
check(one(S('a', 100, 92, 10), [H('a', 10, 5, 10)], { reviewMinutes: 5 }).length === 1, 'parking: a shorter review period of 5 minutes releases the hold');
check(one(S('a', 100, 92, 10), [H('b', 1, 5, 10)]).length === 1, 'parking: history of another site does not hold this one');

// parking: edge inputs and policy
check(one(S('a', 0, 0, 10)).length === 0, 'parking: a site with capacity 0 is left alone');
check(decideParkingFees([], {}, [], NOW).length === 0, 'parking: no sites gives no changes');
check(decideParkingFees([S('a', 100, 92, 10), S('b', 100, 20, 20), S('c', 100, 78, 10)], {}, [], NOW).length === 2, 'parking: three sites give one change each for the two outside the band');
check(one(S('a', 100, 92, 25), [], { parking: { step: 10, max: 30 } })[0]?.to === 30, 'parking: a custom step of 10 with maximum 30 caps 25 at 30');
check(one(S('a', 100, 88, 10), [], { raiseAbovePct: 90 }).length === 0, 'parking: with raiseAbovePct 90 a site at 88% is left alone');
check(one(S('a', 100, 30, 10), [], { lowerBelowPct: 25 }).length === 0, 'parking: with lowerBelowPct 25 a site at 30% is left alone');

// service fees
const P: FeePolicy = { service: { Water: { min: 50, max: 150, step: 10 } } };
const svc = (fee: number, factor: number | undefined, hist: FeeHistoryRow[] = [], pol: FeePolicy = P) => decideServiceFees([{ name: 'Water', fee, factor }], pol, hist, NOW);
check(decideServiceFees([{ name: 'Electricity', fee: 100, factor: 2 }], P, [], NOW).length === 0, 'service: a service that is not in the policy is left alone');
const n1 = svc(100, -2);
check(n1.length === 1 && n1[0].to === 90 && n1[0].kind === 'service' && n1[0].target === 'Water', 'service: a negative factor lowers a fee of 100 by one step to 90');
check(/negative/.test(n1[0].why), 'service: the lowering reason says the factor is negative');
check(svc(50, -2).length === 0, 'service: a negative factor at the minimum fee changes nothing');
check(svc(55, -2)[0]?.to === 50, 'service: a lowering from 55 stops at the minimum of 50');
const u1 = svc(110, 1, [H('Water', 60, 100, 110, 5000, 4200)]);
check(u1.length === 1 && u1[0].from === 110 && u1[0].to === 100 && /income fell/.test(u1[0].why), 'service: a raise that lost income (5,000 to 4,200) is undone back to 100');
check(svc(110, 1, [H('Water', 60, 110, 100, 5000, 4000)])[0]?.to === 120, 'service: a lowering that lost income is not undone, the fee is raised instead');
check(svc(110, 1, [H('Water', 60, 100, 110, 5000, 5600)])[0]?.to === 120, 'service: a raise that gained income is followed by another raise');
check(svc(100, 1)[0]?.to === 110, 'service: a fee of 100 with a good factor and no history is raised to 110');
check(svc(100, undefined)[0]?.to === 110, 'service: a missing factor still allows a raise');
check(svc(100, 0.3).length === 0, 'service: a factor of 0.3 is not good enough to raise');
check(svc(100, 0.5)[0]?.to === 110, 'service: a factor of exactly 0.5 allows a raise');
check(svc(150, 1).length === 0, 'service: a fee at the maximum is not raised');
check(svc(145, 1)[0]?.to === 150, 'service: a raise from 145 stops at the maximum of 150');
check(svc(100, 1, [H('Water', 5, 90, 100)]).length === 0, 'service: a fee changed 5 minutes ago is not raised again');
check(svc(110, 1, [H('Water', 5, 100, 110, 5000, 4200)])[0]?.to === 100, 'service: the undo of a losing raise is not held back by the review period');
check(decideServiceFees([], P, [], NOW).length === 0, 'service: no fees gives no changes');

// judgeFeeChange
const band: [number, number] = [70, 85];
check(judgeFeeChange({ target: 'a', t: 0, from: 10, to: 15, before: 92 }, band) === 'pending', 'judge: a change with no after value is pending');
check(judgeFeeChange({ target: 'a', t: 0, from: 10, to: 15, before: 92, after: 80 }, band) === 'effective', 'judge: moving from 92% into the band is effective');
check(judgeFeeChange({ target: 'a', t: 0, from: 10, to: 15, before: 95, after: 90 }, band) === 'effective', 'judge: moving from 95% to 90% is closer to the band, so effective');
check(judgeFeeChange({ target: 'a', t: 0, from: 10, to: 15, before: 90, after: 97 }, band) === 'worse', 'judge: moving from 90% to 97% is further from the band, so worse');
check(judgeFeeChange({ target: 'a', t: 0, from: 10, to: 15, before: 95, after: 96 }, band) === 'ineffective', 'judge: a move of 1 point outside the band is ineffective');
check(judgeFeeChange({ target: 'a', t: 0, from: 10, to: 5, before: 40, after: 30 }, band) === 'worse', 'judge: falling from 40% to 30% below the band is worse');

// parkingSummary and feeLines
const sum = parkingSummary([S('a', 100, 92, 10), S('b', 100, 40, 0), S('c', 200, 160, 5), S('d', 0, 0, 0)]);
check(JSON.stringify(sum) === JSON.stringify({ sites: 4, capacity: 400, parked: 292, occupancyPct: 73, full: 1, empty: 1, paid: 2 }), 'summary: four sites give 292 of 400 places (73%), 1 full, 1 empty, 2 paid');
check(parkingSummary([]).occupancyPct === null && parkingSummary([]).sites === 0, 'summary: no sites gives no percentage');
const big = { sites: 12, capacity: 2400, parked: 1840, occupancyPct: 77, full: 3, empty: 2, paid: 9 };
check(feeLines(big, 41200, []).join('|') === 'parking: 12 sites, 1,840 of 2,400 places used (77%), 3 full, 2 nearly empty, 9 paid; income 41,200 a month', 'lines: the summary line matches the example with thousands separators');
check(feeLines(big, null, []).join('|') === 'parking: 12 sites, 1,840 of 2,400 places used (77%), 3 full, 2 nearly empty, 9 paid', 'lines: an unknown income is left out of the summary line');
check(feeLines(parkingSummary([]), null, []).join('|') === 'parking: no sites', 'lines: no sites gives the single line "parking: no sites"');
const C = (t: string, from: number, to: number): FeeChange => ({ target: t, kind: 'parking', from, to, why: `why ${t}` });
check(feeLines(big, 100, [C('a', 10, 15)]).join('|') === 'parking: 12 sites, 1,840 of 2,400 places used (77%), 3 full, 2 nearly empty, 9 paid; income 100 a month|parking fee a: 10 -> 15 (why a)', 'lines: one change adds one line');
const three = feeLines(big, null, [C('a', 10, 15), C('b', 5, 0), C('c', 0, 10), C('d', 0, 10)]);
check(three.length === 3 && three[2] === 'parking fee b: 5 -> 0 (why b); and 2 more', 'lines: four changes show two and then "and 2 more", never over 3 lines');
check(feeLines(big, null, [C('a', 10, 15), C('b', 5, 0)]).length === 3, 'lines: exactly two changes show both with no "and more"');

process.exit(failed ? 1 : 0);
