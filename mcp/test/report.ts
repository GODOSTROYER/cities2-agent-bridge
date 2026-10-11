// Offline checks for the city report (journals/REPORT.md).
import { buildReport, gradeOf, NOT_READ } from '../src/report.ts';
let failed = 0; const check = (ok: boolean, label: string) => { console.log((ok ? 'PASS: ' : 'FAIL: ') + label); if (!ok) failed++; };

check(gradeOf(6.3, 'ok', 24) === 'ok', 'post with a good factor and spare capacity but 24% of homes uncovered is only ok');
check(gradeOf(-0.7, 'ok', 45) === 'bad', 'the worse of the measures decides: 45% uncovered is bad whatever capacity says');
check(gradeOf(null, 'over', null) === 'critical' && gradeOf(null, 'low', null) === 'bad', 'over capacity is critical, low headroom is bad');
check(gradeOf(-5.5, 'ok', 0) === 'critical' && gradeOf(-3.8, 'ok', 0) === 'bad' && gradeOf(2, 'ok', 0) === 'ok', 'factors worse than -5 are critical, worse than -3 bad');
check(gradeOf(null, null, null) === 'unknown', 'no data is unknown, never good');

const snap = { city: { pop: 17000, money: 1_400_000, net: 1_050_000 }, happy: 67, health: 57, cityFlow: 53, tax: { R: 15, C: 10, I: 10, O: 10 },
  happiness: { Tax: -4.9, TrafficPenalty: -3.8, Crime: -2.8, Garbage: -1, NoisePollution: -0.9, Mail: 6.3, Leisure: 1.1, Entertainment: 3.9, Education: 2.4 },
  icons: { 'Noise Pollution': 61, 'Traffic Bottleneck Notification': 16, 'Garbage Notification': 8 }, needs: { deathcare: { dead: 5 } },
  demand: { rL: 100, rM: 0, rH: 0, c: 0, i: 0, o: 64 }, jobs: { unemp: 22.6, vacantByEdu: [634, 374, 40, 174, 526] }, milestone: { achieved: 8, xp: 61571, nextXp: 65700 } };
const table = { fire: { pct: 114, projected: 129, status: 'over' }, highschool: { pct: 85, projected: 96, status: 'low' }, post: { pct: 20, projected: 23, status: 'ok' }, power: { pct: 68, projected: 77, status: 'ok' } };
const r = buildReport({ snap, table, coverage: { PostService: 24, Park: 28, FireRescue: 5 }, blocked: { fire: 'no_roadside_site' }, did: ['00:05 built res 5x4'], when: '2026-10-11 00:10 UTC', prev: { Traffic: 5.9, Police: -1.0 } });
const row = (name: string) => r.rows.find(x => x.system === name)!;
check(r.rows[0].system === 'Fire and rescue' && r.rows[0].status === 'critical', 'the worst system is first: fire engines over capacity');
check(row('Traffic').status === 'bad' && row('Traffic').outcome.startsWith('flow 53%') && row('Traffic').trend === 'worse', 'traffic is scored on its flow (53%) and shows the trend since the last report');
check(row('Post').status === 'ok' && row('Post').capacity === '20% -> 23% planned' && row('Post').coverage === '24% homes uncovered', 'post shows capacity AND coverage; the good factor does not hide the coverage gap');
check(row('Education: high school').status === 'bad', 'low headroom is bad');
check(row('Noise pollution').status === 'bad' && row('Noise pollution').outcome.includes('61 icons'), '61 icons make noise bad although the factor is mild');
check(row('Police').trend === 'worse' && row('Fire and rescue').blocked === 'no_roadside_site', 'trend and the blocking reason are carried');
check(row('Zones: housing (demand low/medium/high)').status === 'bad' && row('Workplaces and jobs').status === 'bad', 'maxed housing demand and 22% unemployment are bad');
const oc = { post: { sharePct: 46, avgMail: 61, worst: [[1200, -500, 40]] }, garbage: { sharePct: 4, worst: [] }, crime: { highSharePct: 35 }, parking: { kerbLanesFullPct: 72, parkedCars: 5100, garageCars: 0, garageCapacity: 0 }, roads: { avgWear: 1.2, wornSharePct: 3 }, landValue: { avg: 61.5 }, profitability: { avg: 150, companies: 420, losingSharePct: 12 }, tourism: { tourists: 12, attractiveness: 31 } };
const r2 = buildReport({ snap, table, coverage: { PostService: 2 }, outcomes: oc, when: 'x' }); const row2 = (name: string) => r2.rows.find(x => x.system.startsWith(name))!;
check(row2('Post').status === 'critical' && row2('Post').outcome.startsWith('mail waiting in 46% of buildings, worst at (1200,-500) x40'), 'THE OWNER CASE: post at 20% of capacity with a good factor is critical when mail waits in 46% of buildings');
check(row2('Parking').status === 'critical' && row2('Parking').capacity === 'no garages', 'parking is read: 72% of kerbside lanes full and no garages is critical');
check(row2('Police').outcome.startsWith('high crime in 35% of buildings') && row2('Roads').status === 'good' && row2('Profitability').status === 'good' && row2('LandValue').outcome === 'average 61.5', 'crime share, road wear, profitability and land value are in the report');
check(buildReport({ snap, when: 'x' }).rows.some(x => x.system === 'Parking' && x.status === 'unknown'), 'without the reader parking is listed as unknown');
check(NOT_READ.every(n => r.rows.some(x => x.system === n && x.status === 'unknown')), 'infoviews the bridge cannot read yet are listed as unknown, not left out');
check(r.markdown.includes('## Top problems and what is being done') && r.markdown.split('\n')[3].startsWith('1. **Fire and rescue** (critical)'), 'the report opens with the top problems');
check(r.markdown.includes('| system | status | outcome |') && Object.keys(r.values).length > 10, 'one table, and the values for the next trend are returned');
process.exit(failed ? 1 : 0);
