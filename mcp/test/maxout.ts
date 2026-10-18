// LIVE: installs every missing, unlocked extension on every service building (see src/maxout.ts).
//   node test/maxout.ts [plan|build] [maxSpend] [prefabFilter]
// plan: lists the candidates per building type with catalogue cost and upkeep (no placement).
// build: previews each candidate, checks cashReserve and netFloor, installs through the owner's snap.
import { maxOut } from '../src/maxout.ts';

const [modeArg = 'plan', spendArg, filter] = process.argv.slice(2);
if (modeArg !== 'plan' && modeArg !== 'build') { console.log('usage: node test/maxout.ts [plan|build] [maxSpend] [prefabFilter]'); process.exit(1); }
const maxSpend = spendArg === undefined ? undefined : Number(spendArg);
if (maxSpend !== undefined && !(maxSpend > 0)) { console.log('maxSpend must be a positive number'); process.exit(1); }
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const MAX_LINES = 46;

if (modeArg === 'plan') {
  const r = await maxOut({ plan: true, maxSpend, onlyPrefab: filter });
  const byOwner = Object.entries(r.plannedByOwner).sort((a, b) => b[1] - a[1]);
  const costOf = (owner: string) => r.planned.filter(t => t.owner === owner).reduce((s, t) => s + t.cost, 0);
  const upkeepOf = (owner: string) => r.planned.filter(t => t.owner === owner).reduce((s, t) => s + t.upkeep, 0);
  console.log(`PLAN owners ${r.owners}, extension candidates ${r.candidates}, to install ${r.planned.length}`);
  for (const [owner, n] of byOwner.slice(0, MAX_LINES - 8)) console.log(`  ${owner}: ${n} (cost ${fmt(costOf(owner))}, upkeep ${fmt(upkeepOf(owner))}/mo)`);
  if (byOwner.length > MAX_LINES - 8) console.log(`  ... ${byOwner.length - (MAX_LINES - 8)} more building types`);
  console.log(`TOTAL cost ${fmt(r.plannedCost)}, upkeep ${fmt(r.plannedUpkeep)}/mo (catalogue prices; build verifies each by preview)`);
  console.log(`SKIPPED ${Object.entries(r.skipped).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  console.log(`CITY cash ${fmt(r.cash)}, net ${fmt(r.net)}, cashReserve ${fmt(r.cashReserve)}, netFloor ${fmt(r.netFloor)}`);
} else {
  const shown: string[] = [];
  const r = await maxOut({ plan: false, maxSpend, onlyPrefab: filter, log: line => shown.push(line) });
  for (const line of shown.slice(0, MAX_LINES - 6)) console.log(line);
  if (shown.length > MAX_LINES - 6) console.log(`... ${shown.length - (MAX_LINES - 6)} more installs (see counts below)`);
  const skipped = Object.entries(r.skipped).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${v}`);
  console.log(`SUMMARY planned ${r.planned.length}, installed ${r.installs.length}, skipped ${Object.values(r.skipped).reduce((s, v) => s + v, 0)}${r.stopped ? `, stopped: ${r.stopped}` : ''}`);
  console.log(`SKIP REASONS ${skipped.join('; ') || 'none'}`);
  console.log(`SPENT ${fmt(r.spent)} one-off, upkeep added ${fmt(r.upkeepAdded)}/mo (catalogue monthly upkeep)`);
  console.log(`CITY cash ${fmt(r.cash)}, net ${fmt(r.net)}, cashReserve ${fmt(r.cashReserve)}, netFloor ${fmt(r.netFloor)}`);
}
