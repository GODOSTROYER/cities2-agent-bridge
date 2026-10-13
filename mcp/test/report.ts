// Offline checks for the city report (journals/REPORT.md).
import { buildReport, gradeOf, NOT_READ } from '../src/report.ts';
import { summarizeTransit, summarizeOutside, readExtra } from '../src/report-extra.ts';
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
check(rw.markdown.includes("- [ ] traffic flow weighted by vehicles 60% or better: 22% (the game's unweighted figure: 48%, shown for reference only; 60 is the first mark, then as high as real improvements take it)") && rw.rows.find(r => r.system === 'Traffic')!.status === 'critical', 'THE RESTATED TARGET: the headline is flow weighted by vehicles (22% is critical), with the game figure beside it');
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
// ---- data the bridge already reads (report-extra.ts) ----
const rowOf = (rep: { rows: { system: string }[] }, name: string) => rep.rows.find(x => x.system === name) as any;
// Shaped like the live transit_lines reply (lines: prefab, vehicles, aboard, waiting, segmentsWithoutPath; stops: kind, waiting).
const tLines = [
  { prefab: 'Bus Line', vehicles: 7, aboard: 98, waiting: 52, segmentsWithoutPath: 4 }, { prefab: 'Bus Line', vehicles: 8, aboard: 72, waiting: 37, segmentsWithoutPath: 0 },
  { prefab: 'Bus Line', vehicles: 1, aboard: 0, waiting: 0, segmentsWithoutPath: 0 }, { prefab: 'Tram Line', vehicles: 10, aboard: 10, waiting: 207, segmentsWithoutPath: 4 },
  { prefab: 'Tram Line', vehicles: 13, aboard: 220, waiting: 47, segmentsWithoutPath: 0 }, { prefab: 'Passenger Train Line', vehicles: 4, aboard: 78, waiting: 23, segmentsWithoutPath: 0 }];
const tStops = [{ kind: 'bus', waiting: 5 }, { kind: 'tram', waiting: 207 }, { kind: 'train' }];
const ts = summarizeTransit(tLines, tStops);
check(ts.lines === 6 && ts.vehicles === 43 && ts.aboard === 478 && ts.waiting === 366 && ts.empty === 1 && ts.linesNoPath === 2 && ts.segmentsNoPath === 8 && ts.stopsQueued === 1 && ts.maxStopWaiting === 207, 'transit totals: 6 lines, 43 vehicles, 478 aboard, 2 lines with 8 segments without a path, 1 stop queued at 200+');
check(ts.byMode.bus.lines === 3 && ts.byMode.tram.lines === 2 && ts.byMode.train.lines === 1, 'transit lines are counted by mode from the prefab name');
const rt = rowOf(buildReport({ snap, extra: { transit: ts }, when: 'x' }), 'Public transport');
check(rt.status === 'bad' && rt.outcome.includes('8 segments without a path on 2 line(s)') && rt.outcome.includes('bus 3, tram 2, train 1') && rt.outcome.includes('(1 stop(s) at 200+)'), 'public transport is bad with the real numbers: segments without a path and a stop queue of 200+');
const tGood = summarizeTransit([{ prefab: 'Bus Line', vehicles: 2, aboard: 5, waiting: 1, segmentsWithoutPath: 0 }], [{ kind: 'bus', waiting: 30 }]);
check(rowOf(buildReport({ snap, extra: { transit: tGood }, when: 'x' }), 'Public transport').status === 'good', 'public transport is good when every path is there, no queue of 200+ and riders are carried');
const tEmpty = summarizeTransit([{ prefab: 'Bus Line', vehicles: 3, aboard: 0, waiting: 0, segmentsWithoutPath: 0 }, { prefab: 'Bus Line', vehicles: 2, aboard: 1, waiting: 0, segmentsWithoutPath: 0 }], []);
check(rowOf(buildReport({ snap, extra: { transit: tEmpty }, when: 'x' }), 'Public transport').status === 'ok', 'half the lines carrying nobody is ok, not bad');
const rtErr = rowOf(buildReport({ snap, extra: { transitError: 'bridge down' }, when: 'x' }), 'Public transport');
check(rtErr.status === 'unknown' && rtErr.outcome.includes('bridge down'), 'a failed transit read leaves the row unknown with the error text');
// Shaped like the live outside_connections reply: 4 road, 2 ship, 2 train, 4 airplane, 1 power, 1 water pipe.
const oConns = [...Array(4).fill({ kind: 'transport', prefab: 'Road Outside Connection - Oneway' }), ...Array(2).fill({ kind: 'transport', prefab: 'Ship Outside Connection - Twoway' }), ...Array(2).fill({ kind: 'transport', prefab: 'Train Outside Connection - Twoway' }), ...Array(4).fill({ kind: 'transport', prefab: 'Airplane Outside Connection' }), { kind: 'power', prefab: 'Powerline Outside Connection' }, { kind: 'pipe', prefab: 'Water Outside Connection' }];
const os = summarizeOutside(oConns);
check(os.transport === 12 && os.power === 1 && os.pipe === 1 && os.byMode.road === 4 && os.byMode.air === 4, 'outside connections: 12 transport by mode, 1 power, 1 water pipe');
const ro = rowOf(buildReport({ snap, extra: { outside: os }, when: 'x' }), 'Outside connections');
check(ro.status === 'good' && ro.outcome.startsWith('12 transport (road 4, train 2, ship 2, air 4), 1 power, 1 water pipe; no link by none'), 'outside connections are good with every link type present, and the outcome says so with the numbers');
check(rowOf(buildReport({ snap, extra: { outside: summarizeOutside([{ kind: 'power', prefab: 'P' }]) }, when: 'x' }), 'Outside connections').status === 'bad', 'no transport link at all is bad');
const ro2 = rowOf(buildReport({ snap, extra: { outside: summarizeOutside([{ kind: 'transport', prefab: 'Road Outside Connection' }, { kind: 'pipe', prefab: 'W' }]) }, when: 'x' }), 'Outside connections');
check(ro2.status === 'ok' && ro2.outcome.includes('no link by train, ship, air') && ro2.outcome.includes('power'), 'a missing power link is ok, and the missing transport modes are named');
// Telecom and the pollution factors: absent from the list means 0 (no effect), graded on the icons, not unknown.
check(rowOf(buildReport({ snap, when: 'x' }), 'Telecom').status === 'good' && rowOf(buildReport({ snap, when: 'x' }), 'Telecom').outcome.startsWith('factor 0 (not listed'), 'Telecom absent from the happiness list is good (factor 0), not unknown');
check(rowOf(buildReport({ snap, when: 'x' }), 'Air pollution').status === 'good' && rowOf(buildReport({ snap, when: 'x' }), 'Ground pollution').status === 'good', 'air and ground pollution absent from the list are good');
check(rowOf(buildReport({ snap: { ...snap, happiness: {} }, when: 'x' }), 'Telecom').status === 'unknown', 'no happiness list at all keeps Telecom unknown: absence is only 0 when the list was read');
const rTel = rowOf(buildReport({ snap, extra: { telecom: { capacity: 31500, buildings: 9 } }, when: 'x' }), 'Telecom');
check(rTel.outcome.startsWith('9 telecom buildings, network capacity 31500'), 'Telecom outcome carries the telecom headroom from get_metrics');
check(rowOf(buildReport({ snap: { ...snap, happiness: { ...snap.happiness, Telecom: -5.5 } }, when: 'x' }), 'Telecom').status === 'critical' && rowOf(buildReport({ snap: { ...snap, happiness: { ...snap.happiness, Telecom: -4.2 } }, when: 'x' }), 'Telecom').status === 'bad', 'a listed Telecom factor is graded as before: -5.5 critical, -4.2 bad');
// Homelessness: census count against the population. Good at 0, ok when small, bad above 0.5% or when rising.
const withHl = (h: number) => ({ ...snap, jobs: { ...snap.jobs, homeless: h } });
check(rowOf(buildReport({ snap: withHl(0), when: 'x' }), 'Homelessness').status === 'good', 'no homeless citizens is good');
const hlSmall = rowOf(buildReport({ snap: withHl(40), when: 'x' }), 'Homelessness');
check(hlSmall.status === 'ok' && hlSmall.outcome.startsWith('40 homeless (0.24% of 17000)'), 'a small homeless count (40 of 17000, 0.24%) is ok with the share shown');
check(rowOf(buildReport({ snap: withHl(120), when: 'x' }), 'Homelessness').status === 'bad', 'above 0.5% of the population (120 of 17000) is bad');
check(rowOf(buildReport({ snap: withHl(5), prev: { Homelessness: 0 }, when: 'x' }), 'Homelessness').status === 'bad', 'rising homelessness since the last report is bad even when small');
check(rowOf(buildReport({ snap, when: 'x' }), 'Homelessness').status === 'unknown', 'no homeless count in the census keeps Homelessness unknown');
// The rows that are still unread say what is missing.
const unreadRows = buildReport({ snap, when: 'x' }).rows.filter(x => NOT_READ.includes(x.system));
check(unreadRows.length === NOT_READ.length && unreadRows.every(x => x.status === 'unknown' && x.outcome.startsWith('needs a mod reader: ')), 'every unread infoview is unknown and names what the mod must read');
check(!NOT_READ.includes('Transport (no lines: locked in the game)') && !NOT_READ.includes('OutsideConnections'), 'transport and outside connections are no longer listed as unread');
// readExtra: failure-tolerant, one read per source, unwraps paged replies.
const allFail = await readExtra(async () => { throw new Error('bridge down'); });
check(allFail.transitError === 'bridge down' && allFail.outsideError === 'bridge down' && allFail.telecom === undefined, 'readExtra never throws: each failed read records its error');
const fakeOk = async (_name: string, args: Record<string, any> = {}) => {
  if (args.command === 'transit_lines') return args.fields[0] === 'lines.prefab' ? { lines: tLines } : { result: { stops: tStops } };
  if (args.command === 'outside_connections') return { pipes: 1, connections: oConns };
  if (args.command === 'get_metrics') return { headroom: { telecom: { capacity: 31500, buildings: 9 } } };
  return {};
};
const extraOk = await readExtra(fakeOk);
check(extraOk.transit?.linesNoPath === 2 && extraOk.transit?.stopsQueued === 1 && extraOk.outside?.transport === 12 && extraOk.telecom?.buildings === 9 && !extraOk.transitError, 'readExtra reads transit (lines and stops, unwrapping a result), outside connections and telecom');
const extraCut = await readExtra(async (_n, args = {}) => args.command === 'transit_lines' ? { truncated: true, returned: 40, total: 162, result: { stops: [] } } : { connections: [] });
check(/was cut|no lines/.test(String(extraCut.transitError)) && extraCut.outside?.transport === 0, 'a cut transit reply is an error for that read only; the other read still lands');
process.exit(failed ? 1 : 0);
