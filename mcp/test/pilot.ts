// Offline checks for the rule loop (pure decide / learn / growthZone / diagnoseJobs / selfCheck).
import { decide, learn, growthZone, growthSet, diagnoseJobs, selfCheck, progressBlock, wishedNode, kindOf } from '../src/pilot.ts';
import type { PilotMemo } from '../src/pilot.ts';
let failed = 0; const check = (ok: boolean, label: string) => { console.log((ok ? 'PASS: ' : 'FAIL: ') + label); if (!ok) failed++; };
const T = 1_000_000_000_000; const MIN = 60_000;
const fresh = (): PilotMemo => ({ last: {}, backoff: {} });
// The owner's milestone-8 case: all housing demand at maximum, job demand near zero, offices
// short of employees, 15% unemployment with vacancies at every education level.
const base = { city: { money: 3_400_000, pop: 12598, net: 995000 }, jobs: { unemp: 16, eligible: 6900, workers: 5800, vacant: 1351, vacantByEdu: [581, 168, 56, 208, 338] }, demand: { rL: 100, rM: 100, rH: 100, c: 0, i: 5, o: 0 }, needs: {}, servicePenalties: { byFactor: { NotEnoughEmployees: 6 } }, happiness: { Tax: -5, TrafficPenalty: -3.3 }, happinessPriority: { very_high: [], priority: ['TrafficPenalty'] }, milestone: { achieved: 8, xp: 47815, nextXp: 65700 }, ui: { blocker: 'none' }, icons: { 'Noise Pollution': 59 }, shortages: {} };
const keys = (snap: any, memo = fresh(), now = T) => decide(snap, memo, now).actions.map(a => a.key);

// Diagnosis before any zoning decision.
check(diagnoseJobs(base.jobs, base.servicePenalties).state === 'mismatch', 'the live case: 16% unemployment with 1,351 vacancies and short-staffed services is an education mismatch');
check(diagnoseJobs({ unemp: 22, eligible: 6000, workers: 4700, vacant: 60 }).state === 'no_jobs', '22% unemployment with 60 vacancies for 1,300 people is a jobs shortage');
check(diagnoseJobs({ unemp: 6, eligible: 6000, workers: 5640, vacant: 10 }).state === 'ok', 'under 10% is not a problem to diagnose');
check(diagnoseJobs({ unemp: 15, vacantByEdu: [300, 20, 0, 50, 100] }).state === 'mismatch', 'vacancies are summed from the education levels when the total is missing');

// Growth follows the demand bars; unemployment never gates housing.
check(growthZone(base.demand, 'mismatch')!.kind === 'housing', 'THE REGRESSION: maxed housing demand with 16% unemployment builds housing');
check(growthZone(base.demand, 'no_jobs')!.kind === 'housing', 'even with a jobs shortage housing is built when no job zone has any demand');
check(growthZone({ rL: 100, rM: 100, rH: 100, o: 85 }, 'no_jobs')!.zone === 'off', 'a jobs shortage puts a job zone with demand ahead of housing');
check(growthZone({ rL: 100, rM: 100, rH: 100, o: 85 }, 'mismatch')!.kind === 'housing', 'a mismatch does not: the stronger demand wins');
check(growthZone({ rL: 40, c: 70 }, 'ok')!.zone === 'com', 'the strongest demand wins between types');
const recent = fresh(); recent.zoned = { housing: T - 2 * MIN };
check(growthZone({ rL: 100, rM: 100, rH: 100, c: 80 }, 'ok', recent, T)!.zone === 'com', 'a type zoned in the last 6 minutes yields to another with demand');
check(growthZone({ rL: 100, rM: 100, rH: 100, c: 30 }, 'ok', recent, T)!.kind === 'housing', 'but not to a much weaker one');
check(growthZone({ rL: 10, rM: 5, c: 10, o: 0, i: 0 }, 'ok') === null, 'no demand, no growth');
const t0 = fresh(), t1 = fresh(), t2 = fresh(), t4 = fresh(); t1.turn = 1; t2.turn = 2; t4.turn = 4;
check(growthZone(base.demand, 'ok', t0)!.zone === 'reshigh' && growthZone(base.demand, 'ok', t1)!.zone === 'resmed' && growthZone(base.demand, 'ok', t2)!.zone === 'mixed' && growthZone(base.demand, 'ok', t4)!.zone === 'res', 'the housing densities take turns: high, row, mixed, medium, low');
const lk = fresh(); lk.lockedZones = ['reshigh'];
check(growthZone(base.demand, 'ok', lk)!.zone === 'resmed', 'a locked zone is skipped');
check(kindOf('reshigh') === 'housing' && kindOf('mixed') === 'housing' && kindOf('off') === 'off', 'zone kinds');

// Several bars high -> several districts in one cycle.
let set = growthSet(base.demand, 'mismatch');
check(set.length === 3 && set.map(z => z.zone).sort().join() === 'res,reshigh,resmed', 'THE OWNER CASE: three maxed housing bars give high, medium and low density districts in the same cycle');
set = growthSet({ rL: 100, rM: 24, rH: 100, c: 0, i: 0, o: 85 }, 'mismatch');
check(set.map(z => z.zone).sort().join() === 'off,res,reshigh', 'each bar at 60+ gets its district; the weak medium bar does not');
check(growthSet({ rL: 100, rH: 100, o: 85 }, 'no_jobs')[0].zone === 'off', 'a real jobs shortage puts the job zone first');
check(growthSet({ rL: 40, c: 30 }, 'ok').length === 1 && growthSet({ rL: 10 }, 'ok').length === 0, 'below 60 only the single best candidate (20+) is built; no demand builds nothing');
const tm = fresh(); tm.turn = 1; check(growthSet(base.demand, 'ok', tm).some(z => z.zone === 'resmid'), 'the medium bar alternates between row, medium and mixed housing');
check(growthSet(base.demand, 'ok', fresh(), 0, 2).length === 2, 'the number of districts per cycle is capped');
let plan = decide(base, fresh(), T);
check(plan.actions.filter(a => a.key === 'grow').length === 3, 'the live case plans three housing districts at once');
check(plan.actions.some(a => a.key === 'grow' && a.args.zone === 'reshigh' && a.args.cols === 4 && a.args.rows === 3), 'first cycle of the live case: a 4x3 high-density district (cash is far above the reserve)');
check(plan.diagnosis!.includes('mismatch') && plan.actions.find(a => a.key === 'grow')!.why.includes('mismatch'), 'the diagnosis is written into the reason');
let k = keys(base);
check(k.includes('services') && k.includes('traffic') && k.includes('tax') && k.includes('save'), 'services, traffic (factor worse than -3), taxes and a save are due on the first cycle');
const memo = fresh(); memo.last = { services: T, traffic: T, tax: T, save: T, grow: T };
check(keys(base, memo, T + MIN).length === 0, 'nothing is repeated one minute later');
const withGrow = decide(base, fresh(), T).actions; const sv = withGrow.find(a => a.key === 'services')!;
check(withGrow.findIndex(a => a.key === 'services') < withGrow.findIndex(a => a.key === 'grow') && sv.args.projectPeople > 10000, 'services are sized for the planned districts and placed BEFORE they are zoned');
check(keys(base, memo, T + 2 * MIN).join() === 'services,grow,grow,grow', 'growth again after 90 seconds, with the services for it first');
check(decide({ ...base, city: { money: 1_100_000 } }, fresh(), T).actions.find(a => a.key === 'grow')!.args.cols === 3 && decide({ ...base, city: { money: 1_100_000 } }, fresh(), T).actions.filter(a => a.key === 'grow').length === 2, 'near the reserve the districts are 3x2 and two per cycle');
check(decide({ ...base, city: { money: 600_000 } }, fresh(), T).attention.some(a => a.includes('under the reserve')), 'cash under the reserve is raised');

// Utilities and loose ends are immediate: no growth, and the agent is told where.
plan = decide({ ...base, needs: { power: { unserved: 65, action: 'connect', say: 'connect district at (-1512,-175)', at: [-1512, -175] } } }, fresh(), T);
check(!plan.actions.some(a => a.key === 'grow') && plan.attention[0].startsWith('power: connect district at (-1512,-175)'), 'an unserved district stops growth and is raised with its place');
plan = decide({ ...base, needs: { network: { icons: 2, action: 'connect', at: [['Powerline Not Connected', 402, 487]] } } }, fresh(), T);
check(plan.attention.some(a => a.startsWith('network')), 'a loose cable is raised at once');
plan = decide({ ...base, happinessPriority: { very_high: ['Crime'], priority: [] } }, fresh(), T);
check(plan.attention.some(a => a.includes('Crime')), 'a factor worse than -5 is raised');
plan = decide({ ...base, ui: { blocker: 'menu_screen' } }, fresh(), T);
check(plan.attention.some(a => a.includes('menu_screen')), 'a UI blocker the mod cannot clear is raised');

// Self-check: blocked demand and needs stuck at watch.
const sc = fresh(); let raised: string[] = [];
for (let c = 0; c < 5; c++) raised = selfCheck(base, sc, T + c * MIN);
check(raised.some(r => r.startsWith('housing demand 100 for 5 cycles and nothing zoned')), 'housing demand at 100 for five cycles with nothing zoned is raised');
sc.lastGrowReason = 'res: no_free_site'; raised = selfCheck(base, sc, T + 6 * MIN);
check(raised[0].includes('no_free_site'), 'the line says why it is blocked');
sc.zoned = { housing: T + 6 * MIN }; raised = selfCheck(base, sc, T + 7 * MIN);
check(raised.length === 0 && sc.starved!.housing === 0, 'a district zoned for it clears the count');
const sn = fresh(); raised = [];
for (const icons of [5, 6, 8, 11]) raised = selfCheck({ ...base, demand: {}, needs: { garbage: { icons, score: '1/3', action: 'watch' } } }, sn, T);
check(raised.some(r => r.startsWith('garbage is still "watch"') && r.includes('to 11')), 'a need at "watch" whose count rises three cycles in a row is raised');
raised = selfCheck({ ...base, demand: {}, needs: { garbage: { icons: 12, score: '3/3', action: 'build' } } }, sn, T);
check(raised.length === 0, 'once the need escalates to build it is no longer a stuck watch');
check(selfCheck({ ...base, demand: { rL: 30, c: 10 }, needs: {} }, fresh(), T).length === 0, 'weak demand is not blocked demand');

const bk = decide({ ...base, pilotMode: 'bank' }, fresh(), T).actions;
check(bk.filter(a => a.key === 'grow').length === 2 && !bk.some(a => a.key === 'tile') && bk.find(a => a.key === 'services')!.args.reserve === 1_000_000_000, 'bank mode: zoning by the demand bars continues (two districts a cycle), no tiles, services only for over-capacity and very-high needs');

const pw = fresh(); pw.utilityAlerts = ['power at 81% of capacity (projected 85%): add capacity before it passes 100%', 'water at 80% of capacity (projected 84%): add capacity'];
const pwPlan = decide({ ...base, pilotMode: 'bank' }, pw, T);
check(pwPlan.actions.some(a => a.tool === 'add_power') && pwPlan.attention.some(a => a.startsWith('water')) && !pwPlan.attention.some(a => a.startsWith('power')), 'power past the target is added by the loop itself (even in bank mode); water is raised for the agent');

const im = decide({ ...base, pilotMode: 'improve', netFloor: 960_000, policy: { upkeepRealFactor: 2.7 } }, fresh(), T);
check(!im.actions.some(a => a.key === 'grow' || a.key === 'tile') && im.actions.find(a => a.key === 'services')!.args.netFloor === 960_000, 'IMPROVE mode: no districts, no tiles; the service planner gets the net floor');
check(decide({ ...base, pilotMode: 'improve', netFloor: 1_200_000 }, fresh(), T).attention.some(a => a.includes('under the floor')), 'net under the floor is raised and stops upkeep-adding actions');
check(!decide({ ...base, pilotMode: 'improve', netFloor: 1_200_000 }, fresh(), T).attention.some(a => /trim|cut services|over-provisioned/.test(a)) && decide({ ...base, pilotMode: 'improve', netFloor: 1_200_000 }, fresh(), T).attention.some(a => a.includes('nothing is cut')), 'under the floor the loop waits: it never advises trimming services');
check(decide({ ...base, pilotMode: 'improve', netFloor: 500_000, upkeepAllowance: 247_500 }, fresh(), T).actions.find(a => a.key === 'services')!.args.upkeepAllowance === 247_500, 'the service planner gets what this review may still add as upkeep');
const jobless = { ...base, pilotMode: 'improve', netFloor: 960_000, demand: { rL: 100, rM: 100, rH: 100, c: 69, i: 54, o: 0 }, happiness: { Tax: -5, Unemployment: -1.8 } };
const jb = decide(jobless, fresh(), T).actions.filter(a => a.tool === 'grow');
check(jb.length === 1 && jb[0].key === 'jobs' && jb[0].args.zone === 'com' && jb[0].why.includes('exception'), 'THE LIVE CASE: improve mode with the Unemployment factor at -1.8 builds one job district of the strongest job zone, and no homes');
check(!decide({ ...jobless, happiness: { Tax: -5, Unemployment: -0.4 } }, fresh(), T).actions.some(a => a.tool === 'grow') && !decide({ ...jobless, demand: { rL: 100, c: 30, i: 40, o: 0 } }, fresh(), T).actions.some(a => a.tool === 'grow'), 'no job district without the negative factor or without job demand of 50');
check(!decide(jobless, (() => { const m = fresh(); m.last.jobs = T - 5 * MIN; return m; })(), T).actions.some(a => a.tool === 'grow'), 'one job district per 12 minutes, so its effect can be measured');
check(JSON.stringify(decide({ ...jobless, stopRepeating: ['entertainment'] }, fresh(), T).actions.find(a => a.key === 'services')!.args.skip) === '["entertainment"]', 'fix types judged ineffective are handed to the service planner as a stop list');
const treeT = { points: 1, nodes: [{ name: 'TramNode', cost: 2, bought: false, service: 'Transportation', canBuy: false }, { name: 'LargeParksNode', cost: 1, bought: false, service: 'Parks & Recreation', canBuy: true }] };
check(!decide({ ...base, devTree: treeT, policy: { devPointsFor: ['TramNode'] } }, fresh(), T).actions.some(a => a.key === 'unlock'), 'THE LIVE CASE: with Tram reserved and 1 point of the 2 it costs, nothing else is bought');
check(decide({ ...base, devTree: { ...treeT, points: 2, nodes: [{ ...treeT.nodes[0], canBuy: true }, treeT.nodes[1]] }, policy: { devPointsFor: ['TramNode'] } }, fresh(), T).actions.find(a => a.key === 'unlock')?.args.unlock === 'TramNode', 'when the points are there the reserved node is bought first');
check(!decide({ ...base, devTree: { points: 11, nodes: [{ name: 'TramNode', cost: 2, bought: true }, { name: 'HealthResearchInstituteNode', cost: 8, bought: false, service: 'Health & Deathcare', canBuy: true }] }, policy: { devPointsFor: ['TramNode'] } }, fresh(), T).actions.some(a => a.key === 'unlock'), 'THE LIVE CASE: once the reserved node is bought the spare points are kept for the owner, not spent on the wish list');
check(selfCheck({ ...base, pilotMode: 'improve' }, (() => { const m = fresh(); m.starved = { housing: 9 }; return m; })(), T).length === 0, 'in improve mode unmet housing demand is not a fault (expansion is off by policy)');

// Milestone -> save at once.
const m2 = fresh(); m2.last = { services: T, traffic: T, tax: T, save: T, grow: T }; m2.milestone = 8;
check(keys({ ...base, milestone: { achieved: 9 } }, m2, T + MIN).includes('save'), 'a new milestone is saved at once');

// learn(): back-off, land, rotation.
const m3 = fresh(); const g = { key: 'grow', tool: 'grow', args: { zone: 'res', cols: 3, rows: 2 }, why: '' };
check(learn(m3, g, { ok: false, reason: 'no_free_site' }, T).includes('arterial') && m3.wantTile === false && m3.lastGrowReason === 'res: no_free_site', 'no free site after the in-cycle purchase is remembered as the reason and asks for an arterial');
check(!decide(base, m3, T + 5 * MIN).actions.some(a => a.key === 'tile' || a.key === 'grow') && decide(base, m3, T + 11 * MIN).actions.some(a => a.key === 'grow'), 'THE LIVE CASE: no more tiles are bought and growth waits 10 minutes (three useless purchases happened before)');
const m4 = fresh(); learn(m4, g, { ok: false, reason: 'below_reserve' }, T);
check(!decide(base, m4, T + 3 * MIN).actions.some(a => a.key === 'grow') && decide(base, m4, T + 7 * MIN).actions.some(a => a.key === 'grow'), 'a reserve refusal backs growth off for 6 minutes');
const m5 = fresh(); check(learn(m5, g, { ok: true, cost: 7904, site: { cols: 3, rows: 2 } }, T) === 'built res 3x2 for 7904' && m5.zoned!.housing === T && m5.turn === 1, 'a built district is summarised, timed and advances the density turn');
check(learn(fresh(), { key: 'services', tool: 'fix_services', args: {}, why: '' }, { placed: [{ prefab: 'PostOffice02' }] }, T) === 'services placed PostOffice02', 'placed services are summarised');
const ml = fresh(); check(learn(ml, { key: 'grow', tool: 'grow', args: { zone: 'reshigh' }, why: '' }, { ok: false, reason: 'zone_prefab_locked' }, T).includes('locked') && ml.lockedZones![0] === 'reshigh', 'a locked zone is remembered');

const ms = fresh(); learn(ms, { key: 'grow', tool: 'grow', args: { zone: 'res', cols: 4, rows: 3 }, why: '' }, { ok: true, cost: 2016, site: { cols: 1, rows: 1 } }, T);
check(ms.wantTile === true, 'the live case: asked for 4x3 and got 1x1 means land is running out, so a tile is bought next');

// Development points.
const nodes = [{ name: 'CrematoriumNode', service: 'Health & Deathcare', cost: 2, canBuy: true }, { name: 'CollegeNode', service: 'Education & Research', cost: 3, canBuy: true }, { name: 'UniversityNode', service: 'Education & Research', cost: 5, canBuy: false }, { name: 'RoundaboutsNode', service: 'Roads', cost: 1, canBuy: true }];
check(wishedNode(nodes, 4)!.name === 'CollegeNode', 'development points go to the college first');
check(wishedNode(nodes, 2)!.name === 'RoundaboutsNode', 'when the college is too dear the next wish that fits is bought');
check(wishedNode(nodes, 0) === null && wishedNode([], 9) === null, 'no points or no open node buys nothing');
check(decide({ ...base, devTree: { points: 4, nodes } }, fresh(), T).actions.some(a => a.key === 'unlock' && a.args.unlock === 'CollegeNode'), 'the loop spends development points');

const block = progressBlock(base, ['21:10 built off 3x2 for 9216'], ['keep growing'], ['power: connect district at (x,z)'], '2026-10-11 02:00 UTC', 'unemployment 16%: mismatch');
check(block.split('\n').length <= 25 && block.includes('pop 12598') && block.includes('TrafficPenalty -3.3') && block.includes('Tax -5 (exempt)') && block.includes('ATTENTION') && block.includes('mismatch'), 'the progress block is short and carries the fields the coordinator asked for');
process.exit(failed ? 1 : 0);
