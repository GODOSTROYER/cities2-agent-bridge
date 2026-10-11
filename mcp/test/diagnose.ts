// Offline checks: each diagnosis rule, rule order, and the root-cause ranking. No game, no bridge.
import { diagnose, rankRootCauses, TRAFFIC_DEPENDENT, LINKS } from '../src/diagnose.ts';
let failed = 0; const check = (ok: boolean, label: string) => { console.log((ok ? 'PASS: ' : 'FAIL: ') + label); if (!ok) failed++; };

// Rule 1-2: good/ok need no fix; unknown needs a reader.
const ok1 = diagnose({ system: 'Power', status: 'good', capacityPct: 150 });
check(ok1.cause === 'none', 'rule 1: a good system is cause none, even with bad numbers');
check(diagnose({ system: 'Police', status: 'ok', blocked: 'prefab_locked' }).cause === 'none', 'rule 1 comes before the locked rule: an ok system is never diagnosed');
const un = diagnose({ system: 'Garbage', status: 'unknown', capacityPct: 150 });
check(un.cause === 'unknown' && un.fix === 'add a reader', 'rule 2: an unknown status asks for a reader');

// Rule 3: locked blocks placement, whatever the numbers.
const lk = diagnose({ system: 'Garbage', status: 'bad', blocked: 'prefab_locked' });
check(lk.cause === 'locked' && lk.fix === 'buy the development node or reach the milestone', 'rule 3 (live case): a bad Garbage with prefab_locked is locked');
check(diagnose({ system: 'Garbage', status: 'bad', blocked: 'PREFAB_LOCKED' }).cause === 'locked', 'rule 3 is case-insensitive');
check(diagnose({ system: 'Garbage', status: 'bad', blocked: 'no_roadside_site' }).cause !== 'locked', 'rule 3: a blocker without "locked" is not locked');
check(diagnose({ system: 'Garbage', status: 'bad', blocked: 'prefab_locked', capacityPct: 150 }).cause === 'locked', 'rule order: locked wins over capacity');

// Rule 4: staffing, below 70% efficiency.
const st = diagnose({ system: 'Fire and rescue', status: 'bad', efficiencyPct: 50, capacityPct: 120 });
check(st.cause === 'staffing' && st.why.includes('50'), 'rule 4: efficiency 50 wins over capacity 120 and quotes the number');
check(diagnose({ system: 'Fire and rescue', status: 'bad', efficiencyPct: 70 }).cause !== 'staffing', 'rule 4: exactly 70% efficiency is not staffing');
check(diagnose({ system: 'Fire and rescue', status: 'bad', efficiencyPct: null, capacityPct: 120 }).cause === 'capacity', 'rule 4: no efficiency reading is skipped');

// Rule 5: capacity above 100% now or projected.
const cap = diagnose({ system: 'Education: high school', status: 'bad', capacityPct: 98, projectedPct: 104 });
check(cap.cause === 'capacity' && cap.why.includes('104'), 'rule 5 (live case): high school at 98% now, 104% projected is capacity');
check(diagnose({ system: 'Power', status: 'bad', capacityPct: 120 }).cause === 'capacity', 'rule 5: capacity 120% alone is capacity');
check(diagnose({ system: 'Power', status: 'bad', projectedPct: 101 }).cause === 'capacity', 'rule 5: projected 101% alone is capacity');
check(diagnose({ system: 'Power', status: 'bad', capacityPct: 100, projectedPct: 100 }).cause === 'unknown', 'rule 5: exactly 100% is not over capacity');
check(diagnose({ system: 'Post', status: 'bad', capacityPct: 120, uncoveredPct: 24 }).cause === 'capacity', 'rule order: capacity wins over coverage');

// Rule 6: coverage, more than 8% of homes uncovered.
const cov = diagnose({ system: 'Post', status: 'critical', busyPct: 73, capacityPct: 31, uncoveredPct: 24 });
check(cov.cause === 'coverage' && cov.why.includes('24'), 'rule 6 (live case): Post with 24% uncovered homes is coverage');
check(diagnose({ system: 'Post', status: 'bad', uncoveredPct: 8 }).cause !== 'coverage', 'rule 6: exactly 8% uncovered is not coverage');
check(diagnose({ system: 'Post', status: 'bad', uncoveredPct: 24, busyPct: 100, flowPct: 50 }).cause === 'coverage', 'rule order: coverage wins over access_traffic');

// Rule 7: access_traffic, stations busy and traffic jammed.
const at = diagnose({ system: 'Police', status: 'bad', busyPct: 100, flowPct: 50, factor: -4.8 });
check(at.cause === 'access_traffic' && at.why.includes('100') && at.why.includes('50'), 'rule 7 (live case): Police, all busy and flow 50% is access_traffic');
check(diagnose({ system: 'Police', status: 'bad', busyPct: 78, flowPct: 59 }).cause === 'access_traffic', 'rule 7: busy 78% and flow 59% is access_traffic (boundary)');
check(diagnose({ system: 'Police', status: 'bad', busyPct: 78, flowPct: 60 }).cause === 'capacity', 'rule 7: flow exactly 60% is not jammed, so busy is capacity');

// Rule 8: busy stations with free roads means more vehicles.
check(diagnose({ system: 'Post', status: 'bad', busyPct: 80 }).cause === 'capacity', 'rule 8: busy 80% with no traffic reading is capacity');
check(diagnose({ system: 'Post', status: 'bad', busyPct: 80, flowPct: 90 }).cause === 'capacity', 'rule 8: busy 80% with free traffic is capacity');
check(diagnose({ system: 'Power', status: 'bad', busyPct: 77, flowPct: 40 }).cause !== 'capacity', 'rule 8: busy 77% is below the busy threshold');

// Rule 9: pollution is a siting problem.
const pol = diagnose({ system: 'Noise pollution', status: 'bad', icons: 59 });
check(pol.cause === 'siting_pollution' && pol.fix.includes('pollution_sources'), 'rule 9 (live case): Noise pollution with 59 icons is siting_pollution');
check(diagnose({ system: 'AIR POLLUTION', status: 'critical' }).cause === 'siting_pollution', 'rule 9 is case-insensitive');
check(diagnose({ system: 'Ground pollution', status: 'bad', busyPct: 100, flowPct: 50 }).cause === 'access_traffic', 'rule order: access_traffic wins over pollution');

// Rule 10: a traffic-dependent system with jammed traffic is a knock-on.
const ko = diagnose({ system: 'Fire and rescue', status: 'bad', flowPct: 55 });
check(ko.cause === 'knock_on' && ko.fix === 'traffic is the root cause', 'rule 10: Fire and rescue with flow 55% is knock_on');
check(diagnose({ system: 'Post', status: 'bad', flowPct: 59 }).cause === 'knock_on', 'rule 10: flow 59% is jammed (boundary)');
check(diagnose({ system: 'Power', status: 'bad', flowPct: 10 }).cause === 'unknown', 'rule 10: a system that is not traffic-dependent is not knock_on');
check(TRAFFIC_DEPENDENT.includes('Garbage') && TRAFFIC_DEPENDENT.length === 6, 'the traffic-dependent list holds the six road-served systems');

// Rule 11: nothing matched.
const nm = diagnose({ system: 'Workplaces and jobs', status: 'bad', flowPct: 30 });
check(nm.cause === 'unknown' && nm.fix === 'inspect: no rule matched' && nm.why.includes('Workplaces and jobs'), 'rule 11: no rule matched is unknown and names the system');

// Ranking: roots first, then critical before bad, knock-on and access_traffic last.
const ranked = rankRootCauses([
  { system: 'Police', status: 'bad', cause: 'access_traffic' },
  { system: 'Post', status: 'critical', cause: 'coverage' },
  { system: 'Traffic', status: 'bad', cause: 'unknown' },
  { system: 'Budget', status: 'good', cause: 'none' },
]);
const names = ranked.map(r => r.system);
check(names[0] === 'Traffic', 'ranking: Traffic, the root of the others, comes first');
check(!names.includes('Budget'), 'ranking: a good system is left out');
const tr = ranked.find(r => r.system === 'Traffic');
check(!!tr && tr.rootOf.includes('Police') && tr.rootOf.includes('Post'), 'ranking: Traffic rootOf lists Police and Post');
check(!!tr && tr.drivenBy === null, 'ranking: Traffic is driven by nothing');
check(names.indexOf('Post') < names.indexOf('Police'), 'ranking: Post (critical, coverage) comes before Police (access_traffic)');
const po = ranked.find(r => r.system === 'Police');
check(!!po && po.drivenBy === 'Traffic' && po.rootOf.length === 0, 'ranking: Police is driven by Traffic and roots nothing');
check(ranked.find(r => r.system === 'Post')?.drivenBy === 'Traffic', 'ranking: Post is driven by Traffic');

const crit = rankRootCauses([
  { system: 'Deathcare', status: 'bad', cause: 'capacity' },
  { system: 'Fire and rescue', status: 'critical', cause: 'capacity' },
]);
check(crit[0].system === 'Fire and rescue', 'ranking: critical comes before bad when neither is a root');

const chain = rankRootCauses([
  { system: 'Healthcare', status: 'bad', cause: 'knock_on' },
  { system: 'Garbage', status: 'critical', cause: 'unknown' },
  { system: 'Unknown thing', status: 'unknown', cause: 'unknown' },
]);
check(chain.length === 2 && chain[0].system === 'Garbage', 'ranking: Garbage roots Healthcare and comes first; unknown status is left out');
check(chain[1].drivenBy === 'Garbage' && chain[0].rootOf[0] === 'Healthcare', 'ranking: Healthcare is driven by Garbage, which lists it in rootOf');
check(LINKS['Traffic'] === TRAFFIC_DEPENDENT, 'LINKS: Traffic drives the traffic-dependent systems');
check(rankRootCauses([]).length === 0, 'ranking: no rows gives no ranking');
process.exit(failed ? 1 : 0);
