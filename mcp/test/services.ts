// Offline checks for decideServices(): no game, no bridge calls. Run: node test/services.ts
import { decideServices } from '../src/services.ts';
import type { Need, Buildings, Gap } from '../src/services.ts';
import type { Json } from '../src/bridge.ts';

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const MIN = 60_000;
let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ` (${detail})` : ''}`);
}

// Baseline city: adequate everywhere except what each check sets up.
const SERVICES: [string, number, number][] = [
  ['MedicalClinic01', 100, 100], ['FireHouse01', 200, 100], ['PoliceStation01', 300, 100],
  ['ElementarySchool01', 400, 100], ['HighSchool01', 500, 100], ['PostOffice01', 600, 100], ['Landfill01', 700, 100],
];

function snapOf(o: { pop?: number; money?: number; net?: number; needs?: Json; powerPct?: number; powerImport?: number; waterPct?: number }): Json {
  return {
    city: { pop: o.pop ?? 3300, money: o.money ?? 300000, net: o.net ?? 10000 },
    needs: o.needs ?? {},
    util: { power: { pct: o.powerPct ?? 50, import: o.powerImport ?? 0 }, water: { pct: o.waterPct ?? 40 }, sewage: { pct: 40 } },
  };
}

function decide(o: { snap?: Json; services?: [string, number, number][]; gaps?: Record<string, Gap>; cooldown?: Record<string, string>; industry?: { n: number; x: number; z: number } } = {}): Need[] {
  const buildings: Buildings = {
    services: o.services ?? SERVICES,
    homes: { n: 1200, x: 1000, z: -500 },
    industry: o.industry ?? { n: 0, x: 0, z: 0 },
  };
  return decideServices({ snap: o.snap ?? snapOf({}), buildings, gaps: o.gaps ?? {}, cooldown: o.cooldown ?? {}, nowMs: NOW });
}

const deathcareBuild = { deathcare: { action: 'build', score: '4/3' } };
const deathcareWatch = { deathcare: { action: 'watch', score: '1/3' } };

// (a) escalated need bypasses low cash and negative upkeep.
{
  const r = decide({ snap: snapOf({ money: 50000, net: -10000, needs: deathcareBuild }) });
  const first = r.find(n => !n.critical);
  check('a: escalated deathcare is first non-critical need despite cash and upkeep',
    first?.need === 'deathcare' && first.escalated === true && first.why === 'escalated 4/3', JSON.stringify(first));
}

// (b) watch-only deathcare respects upkeep discipline; with positive net it is planned.
{
  const r = decide({ snap: snapOf({ net: -10000, needs: deathcareWatch }) });
  check('b: watch-only deathcare not returned while net < 0', !r.some(n => n.need === 'deathcare'));
  const r2 = decide({ snap: snapOf({ net: 10000, money: 300000, needs: deathcareWatch }) });
  const dc = r2.find(n => n.need === 'deathcare');
  check('b: watch-only deathcare returned with net >= 0 and why "none built"',
    !!dc && dc.escalated === false && dc.why === 'none built' && dc.have === 0, JSON.stringify(dc));
}

// (c) 10-minute escalation cooldown.
{
  const twoAgo = new Date(NOW - 2 * MIN).toISOString();
  const elevenAgo = new Date(NOW - 11 * MIN).toISOString();
  const r = decide({ snap: snapOf({ net: -10000, needs: deathcareBuild }), cooldown: { deathcare: twoAgo } });
  check('c: deathcare built 2 min ago is not escalated (and not returned with net < 0)', !r.some(n => n.need === 'deathcare'));
  const r2 = decide({ snap: snapOf({ net: -10000, needs: deathcareBuild }), cooldown: { deathcare: elevenAgo } });
  const dc = r2.find(n => n.need === 'deathcare');
  check('c: deathcare built 11 min ago is escalated again', !!dc && dc.escalated === true);
}

// (d) critical utilities sort first.
{
  const r = decide({ snap: snapOf({ powerPct: 90, needs: deathcareBuild }) });
  const first = r[0];
  check('d: power at 90% is a critical need sorted before escalated deathcare',
    first?.need === 'power' && first.critical === true && r[1]?.need === 'deathcare',
    r.map(n => n.need).join(','));
  check('d: power target falls back to homes and uses the power prefab list',
    first?.x === 1000 && first?.z === -500 && first?.prefabs[0] === 'SmallCoalPowerPlant01');
}

// (e) education coverage gap targets the cluster; a small gap with a school present does nothing.
{
  const gaps = { Education: { uncoveredPct: 22, gapClusters: [{ x: 500, z: -300, homes: 400 }] } };
  const school = decide({ gaps }).find(n => n.t === 'school');
  check('e: 22% education gap gives a school need at the cluster', school?.x === 500 && school?.z === -300 && school?.uncoveredPct === 22, JSON.stringify(school));
  const gapsSmall = { Education: { uncoveredPct: 5, gapClusters: [{ x: 500, z: -300, homes: 40 }] } };
  check('e: 5% education gap with a school present gives no school need', !decide({ gaps: gapsSmall }).some(n => n.t === 'school'));
}

// (f) below the cash floor only critical or escalated needs survive.
{
  const noHigh = SERVICES.filter(s => !s[0].startsWith('HighSchool'));
  const poor = decide({ snap: snapOf({ money: 100000, net: 10000, needs: deathcareWatch }), services: noHigh });
  check('f: low cash drops non-escalated, non-critical needs (highschool, watch-only deathcare)', poor.length === 0, poor.map(n => n.need).join(','));
  const poorEsc = decide({ snap: snapOf({ money: 100000, net: 10000, needs: deathcareBuild }), services: noHigh });
  check('f: low cash keeps escalated deathcare but still drops highschool',
    poorEsc.length === 1 && poorEsc[0].need === 'deathcare', poorEsc.map(n => n.need).join(','));
}

// (g) the iconsTop key is ignored (it is not a need).
{
  const plain = decide({ snap: snapOf({ needs: deathcareWatch }) });
  const withIcons = decide({ snap: snapOf({ needs: { ...deathcareWatch, iconsTop: { action: 'build', score: '4/3' } } }) });
  check('g: iconsTop in needs changes nothing', JSON.stringify(plain) === JSON.stringify(withIcons) && plain.length > 0 && plain.every(n => !n.escalated));
}

// Extra: garbage is targeted at industry when industry exists.
{
  const noLandfill = SERVICES.filter(s => !s[0].startsWith('Landfill'));
  const g = decide({ services: noLandfill, industry: { n: 5, x: 2000, z: 300 } }).find(n => n.t === 'garbage');
  check('extra: garbage need targets the industry centroid', g?.x === 2000 && g?.z === 300 && g?.why === 'none built', JSON.stringify(g));
}

console.log(failures ? `${failures} FAILED` : 'all checks PASS');
process.exitCode = failures ? 1 : 0;
