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
const r4 = buildReport({ snap: { ...snap, cityFlow: 50, happiness: { ...snap.happiness, Crime: -4.8 } }, table: { police: { pct: 100, projected: 100, status: 'low' } }, vehicles: { police: { busyPct: 100, efficiencyPct: 120 } }, when: 'x' });
const police = r4.rows.find(x => x.system === 'Police')!;
check(police.cause === 'access_traffic' && r4.markdown.includes('| Police | bad | access_traffic |'), 'DIAGNOSIS: police with every station busy and traffic flow at 50% is an access problem, not a capacity one');
check(r4.markdown.indexOf('**Traffic**') < r4.markdown.indexOf('**Police**') && /Traffic\*\* \([^)]*root of [^)]*Police/.test(r4.markdown), 'root causes rank first: Traffic is listed before Police and named as its root');
const r5 = buildReport({ snap, outcomes: { power: { mix: { coal: { n: 5, capacity: 700000, production: 600000, heldBack: 0 }, wind: { n: 12, capacity: 700000, production: 690000, heldBack: 0 } }, cleanShareOfUsePct: 91, heldBack: 0 }, sewage: { rawOutlets: 4 } }, when: 'x' });
check(r5.markdown.includes('- [ ] energy 100% clean and renewable: clean share of use 91%, 5 coal plants left') && r5.markdown.includes('- [ ] zero raw sewage discharge: 4 raw outlets'), 'the energy and sewage targets are lines of the definition of done');
check(buildReport({ snap, outcomes: { power: { mix: { wind: { n: 20 } }, cleanShareOfUsePct: 140, heldBack: 0 }, sewage: { rawOutlets: 0 } }, when: 'x' }).markdown.includes('- [x] energy 100% clean and renewable'), 'with no coal or gas plant left the energy line passes');
check(buildReport({ snap, garbage: { full: 2, buildings: 4, processingLive: 897000 }, when: 'x' }).rows.find(r => r.system === 'Garbage')!.outcome.startsWith('2 of 4 facilities FULL') && buildReport({ snap, garbage: { full: 2, buildings: 4 }, when: 'x' }).rows.find(r => r.system === 'Garbage')!.status !== 'good', 'THE LIVE CASE: two full landfills are named in the Garbage row and it cannot be good');
const rw = buildReport({ snap: { ...snap, cityFlow: 48, flowByVolume: 22 }, when: 'x' });
check(rw.markdown.includes("- [ ] traffic flow weighted by vehicles 60% or better: 22% (the game's unweighted figure: 48%, old target 75)") && rw.rows.find(r => r.system === 'Traffic')!.status === 'critical', 'THE RESTATED TARGET: the headline is flow weighted by vehicles (22% is critical), with the game figure beside it');
check(buildReport({ snap: { ...snap, cityFlow: 52, flowByVolume: 64 }, when: 'x' }).markdown.includes('- [x] traffic flow weighted by vehicles 60% or better'), 'weighted flow of 64% meets the target although the unweighted figure is 52%');
check(buildReport({ snap, sewageExport: { pipes: 1, use: 205019, fulfilled: 205019, local: 0, fee: 20511 }, when: 'x' }).markdown.includes('- [x] sewage 100% exported, zero local discharge or treatment: 1 outside pipe connection(s), 205019 of 205019 carried, 0 local outlet or treatment buildings left, export fee 20511 a month'), 'THE OWNER TARGET: the sewage line passes when the outside pipe carries everything and no outlet or treatment plant is left');
check(buildReport({ snap, sewageExport: { pipes: 1, use: 205019, fulfilled: 205019, local: 0 }, when: 'x' }).rows.find(r => r.system === 'Sewage')!.status === 'good', 'the Sewage row is good when everything is exported');
check(buildReport({ snap, sewageExport: { pipes: 1, use: 205019, fulfilled: 205019, local: 3 }, when: 'x' }).markdown.includes('- [ ] sewage 100% exported'), 'treatment plants still standing fail the line');
check(NOT_READ.every(n => r.rows.some(x => x.system === n && x.status === 'unknown')), 'infoviews the bridge cannot read yet are listed as unknown, not left out');
check(r.markdown.includes('## Top problems and what is being done') && r.markdown.includes('**Fire and rescue** (critical; cause: capacity'), 'the report lists the top problems with their cause');
const r3 = buildReport({ snap, table, netFloor: 1_100_000, mode: 'improve', when: 'x' });
check(r3.markdown.includes('## Definition of done') && r3.markdown.includes('- [ ] every happiness factor except Tax at 0 or better: TrafficPenalty -3.8') && r3.markdown.includes('- [ ] net at or above the floor: net 1050000, floor 1100000') && r3.rows.find(x => x.system === 'Budget')!.status === 'critical', 'the definition of done is a checklist; net under the floor fails it and makes the budget critical');
check(buildReport({ snap: { ...snap, happiness: { Tax: -5, Leisure: 2 }, icons: {}, cityFlow: 80 }, netFloor: 1_000_000, when: 'x' }).markdown.includes('- [x] every happiness factor except Tax at 0 or better'), 'Tax is exempt in the checklist');
check(r.markdown.includes('| system | status | cause | outcome |') && Object.keys(r.values).length > 10, 'one table, and the values for the next trend are returned');
process.exit(failed ? 1 : 0);
