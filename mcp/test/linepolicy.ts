// LIVE helper: transit lines (vehicles, riders, waiting, ticket price, vehicle interval) and the two line policies.
//   node test/linepolicy.ts                                   list every line, most waiting first
//   node test/linepolicy.ts <lineIndex> <VehicleInterval|TicketPrice> <value> [build]
// Data: transit_lines (lines, stops, policyRanges). The setter is route_policy {index, version, type, value}; it calls
// the game's own line-panel policy call (SetRoutePolicy in src/RouteTool.cs). The value is the game's slider value.
// VehicleInterval is the slider: a share of the line's vehicles, and a higher value means more vehicles (as the
// slider reads in the game; the direction is not checked by the mod). transit_lines does not read the slider back:
// its vehicleInterval column is the line's own value. The value must lie in policyRanges (printed in the list).
// Dry run by default: prints what would change. With build: sets it (synchronous, no operation) and prints before and after.
import { call, callOk } from '../src/bridge.ts';
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const readLines = async () => callOk('transit_lines', {}, 30);

const data = await readLines();
const ranges = data.policyRanges ?? {};
const lines: any[] = data.lines ?? [];
const fmtRange = (k: string) => (ranges[k] ? `${ranges[k].min}..${ranges[k].max} (default ${ranges[k].default}, step ${ranges[k].step})` : 'none');
const short = (p: string) => String(p ?? '').replace(/ Line$/, '');

if (process.argv.length <= 2) {
  console.log(`policy ranges: VehicleInterval ${fmtRange('VehicleInterval')}; TicketPrice ${fmtRange('TicketPrice')}; lines ${lines.length}, stops ${(data.stops ?? []).length}`);
  for (const l of [...lines].sort((a, b) => Number(b.waiting ?? 0) - Number(a.waiting ?? 0)))
    console.log(`#${l.number ?? '-'} ${short(l.prefab)} idx ${l.index} v${l.version}: vehicles ${l.vehicles}, aboard ${l.aboard}, waiting ${l.waiting}, vehicleInterval ${l.vehicleInterval}, ticketPrice ${l.ticketPrice}, segmentsWithoutPath ${l.segmentsWithoutPath}`);
  process.exit(0);
}

const [lineIndex, typeArg, valueArg] = process.argv.slice(2, 5); const build = process.argv[5] === 'build';
const type = ['VehicleInterval', 'TicketPrice'].find(t => t.toLowerCase() === String(typeArg ?? '').toLowerCase());
const value = Number(valueArg);
if (!type || !Number.isFinite(value)) { console.log('usage: node test/linepolicy.ts <lineIndex> <VehicleInterval|TicketPrice> <value> [build]'); process.exit(1); }
const line = lines.find(l => Number(l.index) === Number(lineIndex));
if (!line) { console.log(`refused: no transit line with index ${lineIndex}`); process.exit(0); }
const range = ranges[type];
if (!range) { console.log(`refused: no policy range for ${type}`); process.exit(0); }
if (value < range.min || value > range.max) { console.log(`refused: ${type} ${value} is outside ${range.min}..${range.max}`); process.exit(0); }
const current = type === 'TicketPrice' ? line.ticketPrice : line.vehicleInterval;
const shown = type === 'VehicleInterval' ? `line value ${current} (the slider is not read back; set the slider to ${value})` : `${current} -> ${value}`;
const what = `line #${line.number ?? '-'} ${short(line.prefab)} idx ${line.index}: ${type} ${shown}`;
if (!build) { console.log(`would set ${what} (not set; add "build" to run)`); process.exit(0); }

let reply: any = null;
for (let t = 0; t < 10; t++) {
  const o = await call('route_policy', { index: line.index, version: line.version, type, value }, 15);
  if (!o.ok) { const e = JSON.stringify(o.error); if (/busy|finish_or_cancel|batch_in_progress/.test(e)) { await wait(3000); continue; } console.log(`refused: ${e}`); process.exit(0); }
  reply = o.result; break;
}
if (!reply) { console.log('failed: bridge busy after retries'); process.exit(0); }
const after = (await readLines()).lines.find((l: any) => Number(l.index) === Number(lineIndex)) ?? {};
console.log(`set ${what}`);
console.log(JSON.stringify({ before: reply.before, after: { vehicleInterval: after.vehicleInterval, ticketPrice: after.ticketPrice }, range: reply.range }));
