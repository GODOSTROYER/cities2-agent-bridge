// Offline checks for the rule loop (pure decide / learn / progressBlock).
import { decide, learn, growthZone, progressBlock, wishedNode } from '../src/pilot.ts';
import type { PilotMemo } from '../src/pilot.ts';
let failed = 0; const check = (ok: boolean, label: string) => { console.log((ok ? 'PASS: ' : 'FAIL: ') + label); if (!ok) failed++; };
const T = 1_000_000_000_000; const MIN = 60_000;
const fresh = (): PilotMemo => ({ last: {}, backoff: {} });
const base = { city: { money: 1_280_000, pop: 10840, net: 798000 }, jobs: { unemp: 14.6, vacantByEdu: [454, 37, 1, 135, 280] }, demand: { rL: 100, rM: 100, rH: 100, c: 0, i: 5, o: 0 }, needs: {}, happiness: { Tax: -5, TrafficPenalty: -3.3 }, happinessPriority: { very_high: [], priority: ['TrafficPenalty'] }, milestone: { achieved: 7, xp: 37669, nextXp: 46700 }, ui: { blocker: 'none' }, icons: { 'Noise Pollution': 59 }, shortages: {} };
const keys = (snap: any, memo = fresh(), now = T) => decide(snap, memo, now).actions.map(a => a.key);

check(growthZone(base.demand, 14.6) === null, 'the live case: 14.6% unemployment and no job zone with demand means no growth (housing is held)');
check(growthZone({ ...base.demand, o: 85 }, 17)!.zone === 'off', 'above 10% unemployment the strongest job zone is grown');
check(growthZone({ rL: 100, rM: 100, c: 30 }, 6)!.zone === 'resmed', 'under 10% housing is grown, row houses first when high density has no demand');
check(growthZone({ rL: 100, rM: 100, rH: 100 }, 6, 0)!.zone === 'reshigh' && growthZone({ rL: 100, rM: 100, rH: 100 }, 6, 1)!.zone === 'resmed' && growthZone({ rL: 100, rM: 100, rH: 100 }, 6, 2)!.zone === 'mixed' && growthZone({ rL: 100, rM: 100, rH: 100 }, 6, 4)!.zone === 'res', 'the housing densities take turns');
check(growthZone({ rL: 100, rM: 100, rH: 100 }, 6, 0, ['reshigh'])!.zone === 'resmed', 'a locked zone is skipped');
check(growthZone({ rL: 100, rM: 10, c: 30 }, 6)!.zone === 'res', 'low density when medium has no demand');
check(growthZone({ rL: 100, rM: 100, c: 70 }, 6)!.zone === 'com', 'a job zone at 60+ goes before housing so jobs keep pace');
check(growthZone({ rL: 10, rM: 5, c: 10, o: 0, i: 0 }, 4) === null, 'no demand, no growth');

let k = keys(base);
check(k.includes('services') && k.includes('traffic') && k.includes('tax') && !k.includes('grow'), 'first cycle: services, traffic (factor worse than -3) and taxes; no growth without a zone');
check(k.includes('save'), 'a save is due when none is recorded');
const memo = fresh(); memo.last = { services: T, traffic: T, tax: T, save: T };
check(keys(base, memo, T + MIN).length === 0, 'nothing is repeated one minute later');
check(keys(base, memo, T + 5 * MIN).join() === 'services', 'services again after 4 minutes');
check(keys({ ...base, jobs: { unemp: 6 } }, memo, T + MIN).join() === 'grow', 'under 10% unemployment housing growth starts');
let plan = decide({ ...base, jobs: { unemp: 6 }, city: { money: 1_400_000 } }, memo, T + MIN);
check(plan.actions[0].args.cols === 4 && plan.actions[0].args.rows === 3 && plan.actions[0].args.zone === 'reshigh', 'with 300k above the reserve the district is 4x3');

// Utilities and loose ends are immediate: no growth, and the agent is told where.
plan = decide({ ...base, jobs: { unemp: 6 }, needs: { power: { unserved: 65, action: 'connect', say: 'connect district at (-1512,-175)', at: [-1512, -175] } } }, memo, T + MIN);
check(!plan.actions.some(a => a.key === 'grow') && plan.attention[0].startsWith('power: connect district at (-1512,-175)'), 'an unserved district stops growth and is raised with its place');
plan = decide({ ...base, needs: { network: { icons: 2, action: 'connect', at: [['Powerline Not Connected', 402, 487]] } } }, memo, T + MIN);
check(plan.attention.some(a => a.startsWith('network')), 'a loose cable is raised at once');
plan = decide({ ...base, happinessPriority: { very_high: ['Crime'], priority: [] } }, memo, T + MIN);
check(plan.attention.some(a => a.includes('Crime')), 'a factor worse than -5 is raised');
plan = decide({ ...base, ui: { blocker: 'menu_screen' } }, memo, T + MIN);
check(plan.attention.some(a => a.includes('menu_screen')), 'a UI blocker the mod cannot clear is raised');

// Milestone -> save at once.
const m2 = fresh(); m2.last = { services: T, traffic: T, tax: T, save: T }; m2.milestone = 7;
check(keys({ ...base, milestone: { achieved: 8 } }, m2, T + MIN).includes('save'), 'a new milestone is saved at once');

// learn(): back-off and land.
const m3 = fresh(); const g = { key: 'grow', tool: 'grow', args: { zone: 'res', cols: 3, rows: 2 }, why: '' };
check(learn(m3, g, { ok: false, reason: 'no_free_site' }, T).includes('tile') && m3.wantTile === true, 'no free site asks for a tile');
check(decide({ ...base, jobs: { unemp: 6 } }, m3, T + MIN).actions.some(a => a.key === 'tile') && !decide({ ...base, jobs: { unemp: 6 } }, m3, T + MIN).actions.some(a => a.key === 'grow'), 'next cycle buys a tile and does not retry growth yet');
learn(m3, { key: 'tile', tool: 'buy_tile', args: {}, why: '' }, { ok: true, cost: 28000 }, T + MIN);
check(m3.wantTile === false && decide({ ...base, jobs: { unemp: 6 } }, m3, T + 4 * MIN).actions.some(a => a.key === 'grow'), 'after the purchase growth resumes');
const m4 = fresh(); learn(m4, g, { ok: false, reason: 'below_reserve' }, T);
check(!decide({ ...base, jobs: { unemp: 6 } }, m4, T + 3 * MIN).actions.some(a => a.key === 'grow') && decide({ ...base, jobs: { unemp: 6 } }, m4, T + 7 * MIN).actions.some(a => a.key === 'grow'), 'a reserve refusal backs growth off for 6 minutes');
check(learn(fresh(), g, { ok: true, cost: 7904, site: { cols: 3, rows: 2 } }, T) === 'built res 3x2 for 7904', 'a built district is summarised');
check(learn(fresh(), { key: 'services', tool: 'fix_services', args: {}, why: '' }, { placed: [{ prefab: 'PostOffice02' }] }, T) === 'services placed PostOffice02', 'placed services are summarised');

const nodes = [{ name: 'Crematorium', service: 'Deathcare', cost: 2, canBuy: true }, { name: 'College', service: 'Education', cost: 3, canBuy: true }, { name: 'University', service: 'Education', cost: 5, canBuy: false }, { name: 'Bus Depot', service: 'Transportation', cost: 1, canBuy: true }];
check(wishedNode(nodes, 4)!.name === 'College', 'development points go to the college first');
check(wishedNode(nodes, 2)!.name === 'Bus Depot', 'when the college is too dear the next wish that fits is bought');
check(wishedNode(nodes, 0) === null && wishedNode([], 9) === null, 'no points or no open node buys nothing');
const mu = fresh(); mu.last = { services: T, traffic: T, tax: T, save: T };
check(decide({ ...base, devTree: { points: 4, nodes } }, mu, T + MIN).actions.some(a => a.key === 'unlock' && a.args.unlock === 'College'), 'the loop spends development points');
const ml = fresh(); check(learn(ml, { key: 'grow', tool: 'grow', args: { zone: 'reshigh' }, why: '' }, { ok: false, reason: 'zone_prefab_locked' }, T).includes('locked') && ml.lockedZones![0] === 'reshigh', 'a locked zone is remembered');
const block = progressBlock(base, ['21:10 built off 3x2 for 9216'], ['keep growing'], ['power: connect district at (x,z)'], '2026-10-11 02:00 UTC');
check(block.split('\n').length <= 25 && block.includes('pop 10840') && block.includes('TrafficPenalty -3.3') && block.includes('Tax -5 (exempt)') && block.includes('ATTENTION'), 'the progress block is short and carries the fields the coordinator asked for');
process.exit(failed ? 1 : 0);
