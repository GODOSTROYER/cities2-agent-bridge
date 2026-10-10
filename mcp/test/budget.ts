// Offline checks: the owner's reserve rule, the growth blockers and the utility postcondition.
import { spendVerdict, growClass, blockingNeeds, utilityOutcome, RESERVE } from '../src/budget.ts';
let failed = 0; const check = (ok: boolean, label: string) => { console.log((ok ? 'PASS: ' : 'FAIL: ') + label); if (!ok) failed++; };

check(RESERVE === 1_000_000, 'the working reserve is 1,000,000');
check(spendVerdict({ cash: 500_000, cost: 70_000, cls: 'critical' }).ok, 'a critical fix is paid at once below the reserve (landfill at 500k cash)');
check(!spendVerdict({ cash: 50_000, cost: 70_000, cls: 'critical' }).ok && spendVerdict({ cash: 50_000, cost: 70_000, cls: 'critical' }).reason === 'not_enough_money', 'even a critical fix needs the cash');
check(spendVerdict({ cash: 500_000, cost: 20_000, cls: 'priority' }).ok, 'a cheap priority item is fine below the reserve');
check(spendVerdict({ cash: 500_000, cost: 114_000, cls: 'priority' }).reason === 'below_reserve', 'an expensive priority item waits for the reserve');
check(spendVerdict({ cash: 1_200_000, cost: 114_000, cls: 'priority' }).ok, 'an expensive priority item is fine once the reserve survives it');
check(spendVerdict({ cash: 865_000, cost: 8_000, cls: 'discretionary' }).reason === 'below_reserve', 'a new district waits while cash is under the reserve, however cheap');
check(spendVerdict({ cash: 1_050_000, cost: 60_000, cls: 'discretionary' }).reason === 'below_reserve', 'discretionary spending may not dip into the reserve');
check(spendVerdict({ cash: 1_100_000, cost: 60_000, cls: 'discretionary' }).ok, 'discretionary spending is fine with the reserve intact');
check(spendVerdict({ cash: 300_000, cost: 60_000, cls: 'discretionary', reserve: 200_000 }).ok, 'an explicit reserve overrides the default');
check(growClass('ind', 14) === 'priority' && growClass('ind', 8) === 'discretionary' && growClass('res', 30) === 'discretionary', 'job zones are priority only while unemployment is above 10%; housing is always discretionary');

check(blockingNeeds({ power: { unserved: 65, action: 'connect', say: 'connect district at (-1512,-175)', at: [-1512, -175] } }).length === 1, 'an unserved district blocks growth');
check(blockingNeeds({ power: { unserved: 3, action: 'confirm' } }).length === 0, 'a first-snapshot shortage (confirm) does not block yet');
check(blockingNeeds({ network: { icons: 1, action: 'connect' } })[0].need === 'network', 'a loose network end blocks growth');
check(blockingNeeds({ garbage: { icons: 5, action: 'build' }, traffic: { action: 'build' } }).length === 0 && blockingNeeds(undefined).length === 0, 'ordinary service needs do not block growth');

check(utilityOutcome({ verdict: 'connected_no_buildings_yet', road: { linked: true }, power: { linked: true }, water: { linked: true } }).ok, 'a linked district passes the postcondition');
const u = utilityOutcome({ verdict: 'not_connected', road: { linked: true }, power: { linked: false }, water: { linked: false } });
check(!u.ok && u.reason === 'not_utility_connected' && u.missing!.join() === 'power,water', 'a district joined by road but not by power and water fails, naming what is missing');
check(utilityOutcome({ verdict: 'unserved', road: { linked: true }, power: { linked: true }, water: { linked: true } }).reason === 'buildings_unserved', 'linked but buildings still short is reported');
check(utilityOutcome(undefined).reason === 'utility_check_failed', 'no answer is a failure, not a pass');
process.exit(failed ? 1 : 0);
