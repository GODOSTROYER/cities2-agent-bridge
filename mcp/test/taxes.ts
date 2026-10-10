// Offline checks for the tax autopilot: owner pins are honoured, one step at a time.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'cs2-taxes-'));
process.env.CS2_TAX_PINS = join(dir, 'tax-pins.json');
process.env.CS2_MAILBOX = dir;          // never the real mailbox
const { decideTax, parsePins, readPins, writePin, pinViolation, longRates } = await import('../src/taxes.ts');

let failed = 0; const check = (ok: boolean, label: string) => { console.log((ok ? 'PASS: ' : 'FAIL: ') + label); if (!ok) failed++; };
const owner = parsePins({ Residential: { min: 15, max: 15 }, Industrial: { min: 10, max: 11, start: 10 }, Commercial: { min: 10, max: 11, start: 11 }, Office: { min: 10, max: 11, start: 11 }, setBy: 'owner', note: 'x' });

check(Object.keys(owner).length === 4 && owner.Industrial.start === 10, 'parsePins keeps the four areas and ignores metadata');
check(parsePins({ Residential: 15 }).Residential.min === 15 && parsePins({ Residential: 15 }).Residential.max === 15, 'a plain number is a fixed pin');
check(Object.keys(parsePins({ Residential: { min: 12, max: 10 }, Office: 'x' })).length === 0, 'malformed pins are dropped');
check(JSON.stringify(longRates({ R: 15, C: 13, I: 15, O: 13 })) === '{"Residential":15,"Commercial":13,"Industrial":15,"Office":13}', 'longRates maps R/C/I/O');

let d = decideTax({ rates: { R: 15, C: 13, I: 15, O: 13 }, pins: owner, demand: { c: 0, i: 0, o: 0 }, unemployment: 31.9, taxFactor: -4.7 });
check(d.action === 'restore_pin' && d.area === 'Commercial' && d.to === 11, 'a rate above its range is put back to the pin start (Commercial 13 -> 11)');
d = decideTax({ rates: { R: 15, C: 11, I: 15, O: 13 }, pins: owner, demand: {}, unemployment: 31.9 });
check(d.action === 'restore_pin' && d.area === 'Industrial' && d.to === 10, 'then Industrial 15 -> 10');
d = decideTax({ rates: { R: 13, C: 11, I: 10, O: 11 }, pins: owner, demand: {} });
check(d.action === 'restore_pin' && d.area === 'Residential' && d.to === 15, 'Residential below its fixed pin is restored to 15');
d = decideTax({ rates: { R: 15, C: 9, I: 10, O: 11 }, pins: owner, demand: {} });
check(d.action === 'restore_pin' && d.area === 'Commercial' && d.to === 11, 'a rate below its range goes to start');
check(decideTax({ rates: { R: 15, C: 9, I: 10, O: 11 }, pins: { ...owner, Commercial: { min: 10, max: 11 } }, demand: {} }).to === 10, 'without start it goes to the nearest bound');

d = decideTax({ rates: { R: 15, C: 11, I: 10, O: 11 }, pins: owner, demand: { rL: 100, c: 5, i: 30, o: 40 }, unemployment: 30, taxFactor: -4.7 });
check(d.action === 'lower' && d.area === 'Commercial' && d.to === 10, 'demand under 20 lowers that zone inside its range');
d = decideTax({ rates: { R: 15, C: 10, I: 10, O: 10 }, pins: owner, demand: { c: 0, i: 0, o: 0 }, unemployment: 30 });
check(d.action === 'hold', 'at the bottom of every range nothing goes lower');
d = decideTax({ rates: { R: 15, C: 10, I: 10, O: 10 }, pins: owner, demand: { c: 80, i: 90, o: 70 }, unemployment: 6 });
check(d.action === 'raise' && d.area === 'Industrial' && d.to === 11, 'strong demand and low unemployment raise the strongest zone one point');
d = decideTax({ rates: { R: 15, C: 10, I: 10, O: 10 }, pins: owner, demand: { c: 80, i: 90, o: 70 }, unemployment: 22 });
check(d.action === 'hold', 'no raise while unemployment is 10% or more');
d = decideTax({ rates: { R: 15, C: 11, I: 11, O: 11 }, pins: owner, demand: { c: 80, i: 90, o: 70 }, unemployment: 5 });
check(d.action === 'hold', 'no raise above the top of the range');
d = decideTax({ rates: { R: 15, C: 11, I: 10, O: 11 }, pins: owner, demand: { rL: 0, rM: 0, rH: 0, c: 50, i: 50, o: 50 }, unemployment: 5, taxFactor: -9 });
check(d.action === 'hold' && d.taxFactor === -9, 'the Tax factor never changes a rate (reported only); fixed Residential is never moved');
d = decideTax({ rates: { R: 9, C: 30, I: 2, O: 11 }, pins: {}, demand: {} });
check(d.action === 'hold' && d.unpinned.length === 4, 'areas without a pin are never touched');

check(pinViolation('Industrial', 15, owner) !== null && pinViolation('Industrial', 11, owner) === null && pinViolation('Residential', 14, owner) !== null, 'pinViolation flags manual rates outside a pin');
check(pinViolation('Industrial', 15, {}) === null, 'no pin, no violation');

check(Object.keys(await readPins()).length === 0, 'readPins of a missing file is {}');
await writePin('Industrial', { min: 10, max: 11, start: 10 }); await writePin('Residential', { min: 15, max: 15 });
let p = await readPins(); check(p.Industrial.max === 11 && p.Residential.min === 15, 'writePin round-trips');
await writePin('Industrial', null); p = await readPins(); check(!p.Industrial && !!p.Residential, 'writePin(null) removes one pin and keeps the others');

rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
