// Scenario tests: each fixture under test/fixtures/ is a saved city snapshot (plus the extra report
// inputs) replayed through the pure functions, with checks on what the harness must decide.
// Offline: nothing here talks to the game.
import { readFileSync } from 'node:fs';
import { decide, diagnoseJobs, kindOf } from '../src/pilot.ts';
import type { PilotAction, PilotMemo } from '../src/pilot.ts';
import { buildReport, gradeOf } from '../src/report.ts';
import { blockingNeeds, floorVerdict } from '../src/budget.ts';

let failed = 0;
const check = (ok: boolean, label: string) => { console.log((ok ? 'PASS: ' : 'FAIL: ') + label); if (!ok) failed++; };
const NOW = 1_000_000_000_000;
const fresh = (): PilotMemo => ({ last: {}, backoff: {} });
const load = (name: string): any => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const has = (actions: PilotAction[], key: string) => actions.some(a => a.key === key);
const grows = (actions: PilotAction[]) => actions.filter(a => a.key === 'grow');

// 1. A district with no power: growth stops, the loop names the place, the report grades Electricity critical.
{
  const f = load('district-without-power.json'); const snap = f.snap;
  const plan = decide(snap, fresh(), NOW);
  check(!has(plan.actions, 'grow') && !has(plan.actions, 'tile'), 'a district with no power stops all growth and the buying of land');
  check(plan.attention.some(a => a.startsWith('power: connect district at (-1512,-175)')), 'attention names the unpowered district and its position');
  check(blockingNeeds(snap.needs).some(b => b.need === 'power' && b.unserved === 65), 'blockingNeeds returns the power need with 65 buildings unserved');
  const r = buildReport({ snap, table: f.table, when: f.when });
  check(r.rows.find(x => x.system === 'Electricity')!.status === 'critical', 'the report grades the Electricity row critical');
}

// 2. Post with capacity to spare and a good factor, but mail waiting in 70% of buildings.
{
  const f = load('post-failing-capacity-fine.json');
  const r = buildReport({ snap: f.snap, table: f.table, outcomes: f.outcomes, when: f.when });
  const post = r.rows.find(x => x.system === 'Post')!;
  check(post.status === 'critical', 'the report grades Post critical while its capacity is fine');
  check(post.outcome.startsWith('mail waiting in 70% of buildings'), 'the Post outcome says mail waits in 70% of buildings');
  check(gradeOf(6, 'ok', null, 'good') === 'ok', 'without the mail outcome the same factor and capacity would grade Post ok');
  check(r.markdown.split('## Top problems and what is being done')[1].split('Last actions')[0].includes('**Post** (critical'), 'Post is listed among the top problems');
}

// 3. Maxed housing demand, 16% unemployed, 1,351 vacancies: an education mismatch. Three districts, no job zone.
{
  const f = load('maxed-demand-education-mismatch.json'); const snap = f.snap;
  check(diagnoseJobs(snap.jobs, snap.servicePenalties).state === 'mismatch', 'the diagnosis is an education mismatch, not a jobs shortage');
  const plan = decide(snap, fresh(), NOW);
  const g = grows(plan.actions); const zones = g.map(a => String(a.args.zone));
  check(g.length === 3 && zones.includes('reshigh') && zones.includes('res') && zones.some(z => ['resmed', 'resmid', 'mixed'].includes(z)), `three districts in one cycle: high, a medium and low density (${zones.join(', ')})`);
  check(!zones.some(z => kindOf(z) !== 'housing'), 'no job zone (commercial, office, industrial) is planned');
  check(g.every(a => a.why.includes('mismatch')), 'each growth reason carries the mismatch diagnosis');
  check(g.every(a => a.args.cols === 4 && a.args.rows === 3), 'with 3.4 million in cash the districts use the large 4x3 size');
}

// 4. Improve mode, net under the floor: no growth, the floor is raised, the services get the floor, the budget fails.
{
  const f = load('improve-mode-net-under-floor.json'); const snap = f.snap;
  const plan = decide(snap, fresh(), NOW);
  check(!has(plan.actions, 'grow') && !has(plan.actions, 'tile'), 'improve mode with net under the floor plans no district and no tile');
  check(plan.attention.some(a => a.includes('under the floor')), 'attention says net is under the floor');
  check(plan.actions.find(a => a.key === 'services')?.args.netFloor === 1960000, 'the services action carries netFloor 1960000');
  check(floorVerdict({ net: snap.city.net, floor: snap.netFloor, monthlyUpkeep: 0 }).ok === false, 'the floor verdict refuses even a zero-upkeep action while net is under the floor');
  const r = buildReport({ snap, netFloor: snap.netFloor, when: f.when });
  check(r.rows.find(x => x.system === 'Budget')!.status === 'critical', 'the report grades Budget critical');
  check(r.markdown.includes('- [ ] net at or above the floor: net 1900000, floor 1960000'), 'the definition-of-done line for the floor is unchecked');
}

// 5. Bank mode: zoning continues at most two districts a cycle, no tile purchase, services only for over-capacity needs.
{
  const f = load('bank-mode.json'); const snap = f.snap;
  const memo = fresh(); memo.wantTile = true; // a site is short: a tile would be bought outside bank mode
  const plan = decide(snap, memo, NOW);
  const g = grows(plan.actions);
  check(g.length >= 1 && g.length <= 2, `bank mode: zoning continues with at most two districts (${g.length} planned)`);
  check(!has(plan.actions, 'tile'), 'bank mode: no tile purchase, even when a site is short');
  const svc = plan.actions.find(a => a.key === 'services');
  check(svc?.args.reserve === 1_000_000_000, 'the services action in bank mode carries reserve 1,000,000,000');
  check(svc?.args.maxPlacements === 2, 'the services action in bank mode places at most two services');
}

// 6. Everything in order: all five definition-of-done lines checked, nothing raised, no growth.
{
  const f = load('all-good.json'); const snap = f.snap;
  const r = buildReport({ snap, netFloor: snap.netFloor, mode: snap.pilotMode, when: f.when });
  const doneLines = r.markdown.split('\n').filter(l => /^- \[(x| )\]/.test(l));
  check(doneLines.length === 5 && doneLines.every(l => l.startsWith('- [x]')), 'the definition of done has all five lines checked');
  check(r.markdown.includes('- [x] every system good: all good'), 'every system is good');
  const plan = decide(snap, fresh(), NOW);
  check(!has(plan.actions, 'grow'), 'decide plans no growth while demand is low');
  check(plan.attention.length === 0, 'nothing is raised for the agent');
}

process.exit(failed ? 1 : 0);
