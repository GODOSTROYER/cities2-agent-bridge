// MCP stdio server for the CitiesIIAgentBridge mod. Thin tool layer over bridge.ts.
// Logs go to stderr only; stdout belongs to the MCP transport.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { callOk, readEvents, runPwsh, assertIdle, fixPopups, run, prefabInfo, money, ensureClear, waitOperation, startBackground, stopBackground, background, stats, state, REPO } from './bridge.ts';
import { buildGrid, grow, zoneArea, link, placeService, buyTile, fixTraffic, buildCorridor, addConnections, removeRoad, buildLine, relocate, devTree, unlockNode, upgradeCorridor, addPower } from './city.ts';
import { fixServices } from './services.ts';
import { instrument, registerTimingsTool } from './timing.ts';
import { registerHappinessTool, recordFactors, recordAction } from './happiness.ts';
import { notifications, clearRuins, fixJams } from './notifications.ts';
import { fit } from './project.ts';
import { runCycle } from './pilot-cycle.ts';
import { registerTaxTool, readPins, pinViolation } from './taxes.ts';
import { invalidatePrefabCache } from './city.ts';

const server = new McpServer({ name: 'cs2', version: '0.1.0' });
instrument(server);          // every tool: wall-clock ms in the result and in journals/mcp-timings.jsonl
// Registry of the tool handlers, so `autoplay_cycle` can run a whole rule cycle through the same
// tools (and therefore the same guards) an agent would call one by one.
const handlers = new Map<string, (a: any) => Promise<any>>();
{ const register = server.registerTool.bind(server) as any; (server as any).registerTool = (name: string, def: any, fn: any) => { handlers.set(name, fn); return register(name, def, fn); }; }
const innerTool = async (name: string, args: Record<string, any> = {}): Promise<Record<string, any>> => {
  const fn = handlers.get(name); if (!fn) throw new Error(`unknown_tool:${name}`);
  const r = await fn(args); const text = String(r?.content?.[0]?.text ?? '');
  let body: Record<string, any>; try { body = JSON.parse(text); } catch { body = { text: text.slice(0, 300) }; }
  if (r?.isError && body.error === undefined) body.error = text.slice(0, 300);
  return body;
};
registerTimingsTool(server, z);
registerHappinessTool(server, z);
registerTaxTool(server, z);
let lastMilestone: number | null = null;   // unlocks change with milestones: drop cached prefab lock state

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function ok(obj: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

function fail(e: any): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: String(e?.message ?? e) }) }], isError: true };
}

function tail(lines: string[], n = 12): string[] {
  return lines.slice(-n);
}

// Adds the popups cleared by the guard to an object result; other shapes pass through unchanged.
function withCleared(v: any, cleared: string[]): any {
  if (!cleared.length) return v;
  if (v && typeof v === 'object' && !Array.isArray(v)) return { ...v, cleared };
  return v;
}

// Compact projection of get_ui_state for the agent (non-pausing read).
function dropPendingText(m: any): any {
  if (!m || typeof m !== 'object') return m;
  const { pendingText, ...rest } = m;
  return rest;
}

function uiView(u: any) {
  return {
    speed: u.selectedSpeed,
    blocker: u.likelyBlocker,
    fixable: u.resolvableByBridge,
    screen: u.screen,
    panel: u.activePanel,
    tutorial: u.tutorial?.activeTutorialPhase,
    milestone: dropPendingText(u.milestone),
    signatures: u.signatures?.pending?.map((s: any) => s.name),
    dialogs: u.dialogs?.map((d: any) => d.title),
    tool: u.activeTool,
    focus: u.hasFocus,
    chirps: u.chirps?.map((c: any) => String(c.text).slice(0, 100)),
    errors: u.errors,
  };
}

const zoneEnum = z.enum(['res', 'resmed', 'resmid', 'reshigh', 'mixed', 'com', 'ind', 'off']);
const growZoneEnum = z.enum(['res', 'resmed', 'resmid', 'reshigh', 'mixed', 'com', 'ind', 'off']);

server.registerTool('snapshot', {
  description: 'Cached city state (about 1 s old) without pausing the game; safe during a run. brief=true returns only the decision fields (~1/3 of the tokens): money, net, pop, demand, unemployment, vacancies, utilities %, escalated needs, milestone, blocker.',
  inputSchema: { brief: z.boolean().optional() },
}, async (a) => {
  try {
    const d = await callOk('get_snapshot', {}, 10);
    void recordFactors(d);
    const milestone = Number(d.milestone?.achieved ?? NaN);
    if (Number.isFinite(milestone)) { if (lastMilestone !== null && milestone !== lastMilestone) invalidatePrefabCache(); lastMilestone = milestone; }
    if (!a.brief) return ok(d);
    const needs = Object.fromEntries(Object.entries(d.needs ?? {}).filter(([k]) => k !== 'iconsTop').map(([k, v]: [string, any]) => [k, `${v.score} ${v.action}${v.say ? ': ' + v.say : ''}${v.at && !v.say ? ' at ' + JSON.stringify(v.at) : ''}`]));
    return ok({ money: d.city?.money, net: d.city?.net, pop: d.city?.pop, moveIn: d.city?.moveIn, happy: d.happy, health: d.health, demand: d.demand, unemp: d.jobs?.unemp, vacant: d.jobs?.vacantByEdu,
      why: d.demandWhy, happiness: Object.fromEntries(Object.entries(d.happiness ?? d.worstHappy ?? {}).filter(([, v]) => Number(v) < 0)), util: [d.util?.power?.pct, d.util?.water?.pct, d.util?.sewage?.pct], needs, xp: `${d.milestone?.xp}/${d.milestone?.nextXp}`, ms: d.milestone?.achieved, blocker: d.ui?.blocker, speed: d.liveSpeed, frame: d.liveFrame, capturedFrame: d.frame, ageSec: d.ageSec, fire: d.buildings?.onFire, priority: d.happinessPriority, icons: d.icons, clusters: (d.iconClusters ?? []).map((c: any[]) => `${c[0]} x${c[1]} at (${c[2]},${c[3]}) -> ${c[4]}`), shortages: d.shortages, jams: d.jams, errors: d.errors });
  } catch (e) { return fail(e); }
});

server.registerTool('events', {
  description: 'Reads bridge events after a cursor (ISO UTC timestamp or sequence number); reads local files only.',
  inputSchema: {
    since: z.string().optional(),
    limit: z.number().int().min(1).max(200).default(20),
    types: z.array(z.string()).optional(),
  },
}, async (a) => {
  try {
    return ok(await readEvents(a.since, a.limit, a.types));
  } catch (e) { return fail(e); }
});

server.registerTool('ui', {
  description: 'Returns a compact UI state projection (speed, blockers, popups, tool, chirps) without pausing the game.',
  inputSchema: {},
}, async () => {
  try {
    const u = await callOk('get_ui_state', { chirps: 3 }, 10);
    return ok(uiView(u));
  } catch (e) { return fail(e); }
});

server.registerTool('fix_popup', {
  description: 'Dismisses milestone, signature and tutorial popups that block the game, then returns the UI projection.',
  inputSchema: {},
}, async () => {
  try {
    assertIdle();
    const actions = await fixPopups(10);
    const u = await callOk('get_ui_state', { chirps: 3 }, 10);
    return ok({ actions, ui: uiView(u) });
  } catch (e) { return fail(e); }
});

server.registerTool('run', {
  description: 'Bounded simulation at speed 1, 2 or 4. Default: blocks until done and returns a one-line summary. background=true returns at once and keeps the simulation running for `seconds` while you plan and build (planning reads never pause; a build pauses only for itself and the run resumes). seconds=0 with background=true stops it.',
  inputSchema: {
    seconds: z.number().int().min(0).max(7200),
    speed: z.union([z.literal(1), z.literal(2), z.literal(4)]).default(4),
    cashFloor: z.number().int().min(0).default(0),
    background: z.boolean().optional(),
    stopOnNewShortage: z.boolean().optional().describe('background only: stop after three steps in a row end on a new utility shortage (default false)'),
  },
}, async (a) => {
  try {
    if (a.background) {
      if (a.seconds === 0) { stopBackground(); return ok({ background: 'stopping' }); }
      startBackground(a.seconds, a.speed, a.cashFloor, a.stopOnNewShortage ?? false);
      return ok({ background: 'running', seconds: a.seconds, speed: a.speed });
    }
    return ok({ summary: await run(a.seconds, a.speed, a.cashFloor) });
  } catch (e) { return fail(e); }
});

server.registerTool('run_status', {
  description: 'Background run state and how much of the wall-clock time the simulation actually ran since this server started (non-pausing).',
  inputSchema: {},
}, async () => {
  try {
    const wall = (Date.now() - stats.startedAt) / 1000;
    return ok({ background: background.active, remainingSec: Math.max(0, Math.round((background.until - Date.now()) / 1000)), lastStop: background.lastStop, mutating: state.mutating,
      simSeconds: Math.round(stats.simSeconds), wallSeconds: Math.round(wall), simSharePct: Math.round(100 * stats.simSeconds / Math.max(1, wall)), bridgeCalls: stats.calls, avgCallMs: Math.round(stats.callMs / Math.max(1, stats.calls)) });
  } catch (e) { return fail(e); }
});

server.registerTool('build_grid', {
  description: 'Road grid (110 m blocks) at min corner x,z with a lot-free connector, zoned and connectivity-checked, all through mod queries (seconds, no PowerShell). Every road is previewed by the game before anything is built. plan=true previews only. Pauses the game only while building.',
  inputSchema: {
    x: z.number(), z: z.number(),
    cols: z.number().int().min(1).max(6).default(3), rows: z.number().int().min(1).max(6).default(2),
    zone: zoneEnum.default('res'), plan: z.boolean().default(false),
    legacy: z.boolean().optional().describe('use the old PowerShell path (for timing comparison only)'),
  },
}, async (a) => {
  try {
    const cleared = await ensureClear();
    assertIdle();
    if (a.legacy) {
      const m0 = await money();
      const r = await runPwsh('play.ps1', ['grid', '-X', String(a.x), '-Z', String(a.z), '-Cols', String(a.cols), '-Rows', String(a.rows), '-Zone', a.zone, ...(a.plan ? ['-Plan'] : [])]);
      return ok(withCleared({ legacy: true, cost: m0 - (await money()), exit: r.code, lines: tail(r.lines) }, cleared));
    }
    return ok(withCleared(await buildGrid({ x: a.x, z: a.z, cols: a.cols, rows: a.rows, zone: a.zone, plan: a.plan }), cleared));
  } catch (e) { return fail(e); }
});

server.registerTool('grow', {
  description: 'Picks a zone by demand (jobs first above 10% unemployment; or the given zone, demand >= 20), finds free owned land with the mod (stepping the grid size down when land is short), then builds, zones and connects it. plan=true validates only. Seconds, no PowerShell.',
  inputSchema: {
    zone: growZoneEnum.optional(),
    cols: z.number().int().min(1).max(6).optional(), rows: z.number().int().min(1).max(6).optional(),
    plan: z.boolean().optional(),
    reserve: z.number().int().min(0).optional().describe('cash to keep (default 1,000,000: new districts are discretionary below it)'),
    legacy: z.boolean().optional().describe('use the old PowerShell path (for timing comparison only)'),
  },
}, async (a) => {
  try {
    const cleared = await ensureClear();
    assertIdle();
    if (a.legacy) {
      const m0 = await money();
      const r = await runPwsh('play.ps1', ['grow', ...(a.zone ? ['-Zone', a.zone] : []), ...(a.cols ? ['-Cols', String(a.cols)] : []), ...(a.rows ? ['-Rows', String(a.rows)] : []), ...(a.plan ? ['-Plan'] : [])]);
      return ok(withCleared({ legacy: true, cost: m0 - (await money()), exit: r.code, lines: tail(r.lines, 15) }, cleared));
    }
    return ok(withCleared(await grow({ zone: a.zone, cols: a.cols, rows: a.rows, plan: a.plan, reserve: a.reserve }), cleared));
  } catch (e) { return fail(e); }
});

server.registerTool('link', {
  description: 'Shortest lot-free straight road from the existing network to (x,z), previewed by the game and then built; connects grids or adds arterials. plan=true previews only.',
  inputSchema: { x: z.number(), z: z.number(), road: z.string().optional(), max: z.number().int().optional(), plan: z.boolean().optional(), overWater: z.boolean().optional().describe('allow a connector over water deeper than 2 m (the game builds a bridge; check the water level on both sides afterwards)') },
}, async (a) => {
  try {
    const cleared = await ensureClear();
    assertIdle();
    return ok(withCleared(await link(a.x, a.z, a.road ?? 'Small Road', a.max ?? 60000, !!a.plan, !!a.overWater), cleared));
  } catch (e) { return fail(e); }
});

server.registerTool('zone', {
  description: 'Zones every zonable empty cell within radius of (x,z) in one mod-side batch; free.',
  inputSchema: { x: z.number(), z: z.number(), radius: z.number().min(20).max(500).optional(), zone: zoneEnum, replace: z.boolean().optional().describe('also rezone cells of another zone type that have no building on them') },
}, async (a) => {
  try {
    const cleared = await ensureClear();
    assertIdle();
    return ok(withCleared(await zoneArea(a.x, a.z, a.radius ?? 300, a.zone, !!a.replace), cleared));
  } catch (e) { return fail(e); }
});

server.registerTool('place_service', {
  description: 'Places a building by exact prefab name near (x,z): the mod finds rotated roadside lots clear of lots, roads and unowned land, then the game places it. Returns cost and monthly upkeep. plan=true reports cost, upkeep and whether a site exists without building.',
  inputSchema: {
    prefab: z.string(), x: z.number(), z: z.number(),
    radius: z.number().default(400), maxCost: z.number().int().optional(), plan: z.boolean().default(false),
  },
}, async (a) => {
  try {
    const cleared = await ensureClear();
    assertIdle();
    const placedResult = await placeService(a.prefab, a.x, a.z, a.radius, a.maxCost, a.plan);
    const need = /Police/i.test(a.prefab) ? 'police' : /Fire/i.test(a.prefab) ? 'fire' : /Clinic|Hospital/i.test(a.prefab) ? 'health' : /Park|Playground|Plaza/i.test(a.prefab) ? 'entertainment' : /RadioMast|Telecom|Server/i.test(a.prefab) ? 'telecom' : /School|College|University/i.test(a.prefab) ? 'education' : /Cemetery|Crematorium/i.test(a.prefab) ? 'deathcare' : /Landfill|Incinerat|Recycl/i.test(a.prefab) ? 'garbage' : /Power|Wind|Solar/i.test(a.prefab) ? 'power' : null;
    if (placedResult.ok && !a.plan && need) await recordAction({ need, tool: 'place_service', detail: `${a.prefab}@${placedResult.at?.x},${placedResult.at?.z}` });
    return ok(withCleared(placedResult, cleared));
  } catch (e) { return fail(e); }
});

server.registerTool('prefabs', {
  description: 'Searches build prefabs by name (unlocked first) with construction and upkeep costs for the top matches.',
  inputSchema: {
    filter: z.string(),
    kind: z.enum(['building', 'network', 'zone', 'service', 'all']).default('building'),
    limit: z.number().int().min(1).max(30).default(12),
    costs: z.boolean().default(true),
  },
}, async (a) => {
  try {
    const cleared = await ensureClear();
    const page = await callOk('get_build_prefabs', { kind: a.kind, filter: a.filter, limit: 400 }, 20);
    const list: any[] = page.prefabs ?? [];
    list.sort((x, y) => Number(x.locked) - Number(y.locked) || String(x.name).localeCompare(String(y.name)));
    const top = list.slice(0, a.limit);
    if (a.costs) {
      for (const p of top.slice(0, Math.min(a.limit, 10))) {
        try {
          const d = await callOk('get_prefab_details', { index: p.index, version: p.version }, 10);
          const c = d.costs ?? {};
          p.costs = { construction: c.construction, monthlyUpkeep: c.monthlyUpkeep, consumptionUpkeep: c.consumptionUpkeep };
        } catch { /* per-entry failure: leave costs off this entry */ }
      }
    }
    return ok(withCleared({
      total: page.total ?? list.length,
      prefabs: top.map(p => ({ name: p.name, locked: p.locked, ...(p.costs ?? {}) })),
    }, cleared));
  } catch (e) { return fail(e); }
});

server.registerTool('set_tax', {
  description: 'Sets the tax rate (percent) for one zone area; pauses the game. A rate outside the owner pin for that area is refused unless ownerSaid=true.',
  inputSchema: {
    area: z.enum(['Residential', 'Commercial', 'Industrial', 'Office']),
    rate: z.number().int().min(-10).max(30),
    ownerSaid: z.boolean().optional().describe('true only when the owner asked for this rate; needed to leave an owner pin (journals/tax-pins.json)'),
  },
}, async (a) => {
  try {
    const cleared = await ensureClear();
    assertIdle();
    const violation = a.ownerSaid ? null : pinViolation(a.area, a.rate, await readPins());
    if (violation) return fail(violation);
    const r = await callOk('set_tax', { area: a.area, rate: a.rate });
    if (Number(r.after) !== Number(r.before)) await recordAction({ need: 'tax', tool: 'set_tax', detail: `${a.area} ${r.before}->${r.after}` });
    return ok(withCleared({ area: a.area, before: r.before, after: r.after, cost: 0, monthlyUpkeep: 0 }, cleared));
  } catch (e) { return fail(e); }
});

server.registerTool('set_service_budget', {
  description: 'Sets a city service budget (50-150 percent) by exact or unique partial name; pauses the game.',
  inputSchema: {
    service: z.string(),
    budget: z.number().int().min(50).max(150),
  },
}, async (a) => {
  try {
    const cleared = await ensureClear();
    assertIdle();
    const list: any[] = (await callOk('get_services', {}, 20)).services ?? [];
    const label = (x: any) => `${x.name}(${x.budget}%)`;
    const q = a.service.toLowerCase();
    const exact = list.filter(x => String(x.name).toLowerCase() === q);
    const matches = exact.length ? exact : list.filter(x => String(x.name).toLowerCase().includes(q));
    if (matches.length !== 1) {
      const candidates = matches.length ? matches : list;
      return fail(`${matches.length ? 'ambiguous' : 'no_match'} for "${a.service}": ${candidates.map(label).join(', ')}`);
    }
    const s = matches[0];
    const r = await callOk('set_service_budget', { prefabIndex: s.index, prefabVersion: s.version, budget: a.budget });
    return ok(withCleared({ service: s.name, before: r.before, after: r.after, workers: s.workers, workplaces: s.workplaces, cost: 0 }, cleared));
  } catch (e) { return fail(e); }
});

server.registerTool('services', {
  description: 'Lists city services with budget, building count, workers and workplaces.',
  inputSchema: {},
}, async () => {
  try {
    await ensureClear(); // result is an array; popups cleared here are not reported
    const list: any[] = (await callOk('get_services', {}, 20)).services ?? [];
    return ok(list.map(s => ({
      name: s.name,
      budget: s.budget,
      buildings: s.buildings?.length ?? 0,
      workers: s.workers,
      workplaces: s.workplaces,
    })));
  } catch (e) { return fail(e); }
});

server.registerTool('fix_services', {
  description: 'Builds city services that are escalated (snapshot needs with action=build), missing, or uncovered by native coverage, plus utilities near capacity, before growth. Escalated needs override the cash floor and upkeep discipline. plan=true lists what it would build.',
  inputSchema: { maxPlacements: z.number().int().min(1).max(8).default(2), plan: z.boolean().optional(), upkeepAllowance: z.number().optional().describe('improve mode: real upkeep this review may still add (half of the margin over the net floor)'), skip: z.array(z.string()).optional().describe('needs whose fix the effects table judged ineffective: not repeated unless critical or very high'), reserve: z.number().int().min(0).optional().describe('cash to keep (default 1,000,000); critical utilities and very_high factors ignore it'), netFloor: z.number().optional().describe('improve mode: a placement is deferred when net minus its real running cost (listed upkeep x 2.7) would fall under this floor; critical needs still go ahead'), upkeepFactor: z.number().optional(), projectPeople: z.number().int().min(0).optional().describe('residents the districts about to be zoned will add: services are sized for them now (headroom rule: usage under 78% of capacity)') },
}, async (a) => {
  try {
    const cleared = await ensureClear();
    assertIdle();
    return ok(withCleared(await fixServices({ maxPlacements: a.maxPlacements, plan: a.plan, reserve: a.reserve, projectPeople: a.projectPeople, netFloor: a.netFloor, upkeepFactor: a.upkeepFactor, skip: a.skip, upkeepAllowance: a.upkeepAllowance }), cleared));
  } catch (e) { return fail(e); }
});

server.registerTool('buy_tile', {
  description: 'Buys one to three adjacent map tiles (dry, flat; nearest the city or the given x,z). The game price and monthly upkeep of the selection are previewed first, so it never fails on funds. plan=true returns price, upkeep and the tile bounds without buying.',
  inputSchema: {
    n: z.number().int().min(1).max(3).default(1), max: z.number().int().default(300000),
    x: z.number().optional(), z: z.number().optional(), plan: z.boolean().optional(),
    reserve: z.number().int().min(0).optional().describe('cash to keep (default 1,000,000)'),
    allowUnreachable: z.boolean().optional().describe('buy a tile no road can reach yet (behind a highway or water); only for road work the agent has planned'),
  },
}, async (a) => {
  try {
    const cleared = await ensureClear();
    assertIdle();
    return ok(withCleared(await buyTile({ n: a.n, max: a.max, x: a.x, z: a.z, plan: a.plan, reserve: a.reserve, allowUnreachable: a.allowUnreachable }), cleared));
  } catch (e) { return fail(e); }
});

server.registerTool('save', {
  description: 'Saves the game through the harness script and returns its last output lines; pauses the game.',
  inputSchema: {},
}, async () => {
  try {
    const cleared = await ensureClear();
    assertIdle();
    const r = await runPwsh('play.ps1', ['save']);
    return ok(withCleared({ exit: r.code, lines: tail(r.lines, 4) }, cleared));
  } catch (e) { return fail(e); }
});

server.registerTool('restart', {
  description: 'Saves (verified), quits safely, optionally rebuilds and installs, relaunches and loads the newest autosave; pauses the game. Takes a few minutes.',
  inputSchema: {
    build: z.boolean().default(false),
    noInstall: z.boolean().default(false),
  },
}, async (a) => {
  try {
    const cleared = await ensureClear();
    assertIdle();
    const args = a.build ? ['-Build'] : (a.noInstall ? ['-NoInstall'] : []);
    const r = await runPwsh('upgrade.ps1', args, 2400000);
    return ok(withCleared({ exit: r.code, lines: tail(r.lines, 12) }, cleared));
  } catch (e) { return fail(e); }
});

server.registerTool('upgrade_road', {
  description: 'Replaces one road edge (index/version from traffic_hotspots) with another road prefab, e.g. Medium Road -> Large Road, for congested arterials. Pauses the game; returns the cost.',
  inputSchema: { index: z.number().int(), version: z.number().int(), road: z.string(), maxCost: z.number().int().optional() },
}, async (a) => {
  try {
    const cleared = await ensureClear();
    assertIdle();
    const info = await prefabInfo(a.road, 'network');
    if (!info.found) return ok({ found: false, similar: info.similar });
    if (info.locked) return fail('prefab_locked: ' + a.road);
    const m0 = await money();
    const started = await callOk('upgrade_network', { index: a.index, version: a.version, prefabIndex: info.index, prefabVersion: info.version, maxCost: a.maxCost ?? 60000 }, 20);
    const done = started.id ? await waitOperation(started.id, 60) : started;
    const m1 = await money();
    return ok({ status: done.status, error: done.error, reasons: (done.placementErrors ?? []).flatMap((e: any) => e.reasons ?? []).slice(0, 6), cost: m0 - m1, monthlyUpkeep: null, ...(cleared.length ? { cleared } : {}) });
  } catch (e) { return fail(e); }
});

server.registerTool('fix_traffic', {
  description: 'Upgrades the most congested Small Road segments (native traffic flow) to Medium Road and reports the hotspots it cannot fix (highway ramps, roads already Medium). plan=true lists them without building.',
  inputSchema: { max: z.number().int().min(1).max(8).optional(), flowBelow: z.number().min(1).max(90).optional(), plan: z.boolean().optional() },
}, async (a) => {
  try {
    const cleared = await ensureClear();
    assertIdle();
    const jams = await fixJams(a.max ?? 3, !!a.plan);
    const flow = await fixTraffic({ max: a.max, flowBelow: a.flowBelow, plan: a.plan });
    if ((flow.upgraded ?? []).some((u: any) => u.status === 'complete')) await recordAction({ need: 'traffic', tool: 'fix_traffic', detail: 'congested Small Road widened (flow hotspots)' });
    return ok(withCleared({ ok: jams.ok !== false && flow.ok !== false, jamIcons: jams, flowHotspots: flow }, cleared));
  } catch (e) { return fail(e); }
});

server.registerTool('build_arterial', {
  description: "Builds a road (default Medium Road) from a point on the existing network to a target along the lot-free corridor found by the mod: straight when possible, otherwise around lots. Every segment is previewed by the game first. Use it to open new land or add a parallel connection. plan=true previews only.",
  inputSchema: { fromX: z.number(), fromZ: z.number(), toX: z.number(), toZ: z.number(), road: z.string().optional(), plan: z.boolean().optional() },
}, async (a) => {
  try {
    const cleared = await ensureClear();
    assertIdle();
    return ok(withCleared(await buildCorridor(a.fromX, a.fromZ, a.toX, a.toZ, a.road ?? 'Medium Road', !!a.plan), cleared));
  } catch (e) { return fail(e); }
});

server.registerTool('add_power', {
  description: 'Adds electricity capacity ahead of need: one small coal plant sited by the polluter rules (no homes within 300 m or downwind), a transformer next to it and the high-voltage cable between their terminals, so no loose-end warning is left. Use when power passes 78% of capacity. plan=true reports the site only.',
  inputSchema: { plan: z.boolean().optional() },
}, async (a) => {
  try {
    const cleared = await ensureClear();
    assertIdle();
    const r = await addPower(!!a.plan);
    if (r.ok && !a.plan) await recordAction({ need: 'power', tool: 'add_power', detail: `plant at ${r.plant?.x},${r.plant?.z}` });
    return ok(withCleared(r, cleared));
  } catch (e) { return fail(e); }
});

server.registerTool('upgrade_corridor', {
  description: 'Road hierarchy: upgrades every road edge on the network path between two points to a wider prefab (default Large Road; Medium Road for collectors), making one continuous arterial instead of single widened blocks. Highways are skipped. plan=true only counts the edges. Measure traffic_hotspots before and a few minutes after.',
  inputSchema: { fromX: z.number(), fromZ: z.number(), toX: z.number(), toZ: z.number(), road: z.string().optional(), plan: z.boolean().optional() },
}, async (a) => {
  try {
    const cleared = await ensureClear();
    assertIdle();
    const r = await upgradeCorridor({ x: a.fromX, z: a.fromZ }, { x: a.toX, z: a.toZ }, a.road ?? 'Large Road', !!a.plan);
    if (r.ok && !a.plan) await recordAction({ need: 'traffic', tool: 'upgrade_corridor', detail: `${r.upgraded} edges to ${r.road} (${a.fromX},${a.fromZ})->(${a.toX},${a.toZ})` });
    return ok(withCleared(r, cleared));
  } catch (e) { return fail(e); }
});

server.registerTool('autoplay_cycle', {
  description: 'ONE full rule-driven play cycle, returning one line. Keeps the background run alive, reads the snapshot, runs the self-check, then acts by the standing rules through the other tools: ruins, services by escalation, traffic, owner tax pins, growth by the demand bars (all densities, jobs and housing; a tile is bought when no site is free), development points, rolling save every 30 minutes and at each milestone. Writes journals/progress.md (every 15 minutes), journals/pilot/status.json and log.jsonl. The line ends with ATTENTION items that need an agent: unserved districts, loose network ends, factors worse than -5, blocked demand, cash under the reserve. Call it about once a minute and sleep in between.',
  inputSchema: {},
}, async () => {
  try {
    const r = await runCycle(innerTool, REPO);
    return { content: [{ type: 'text', text: r.line }] };
  } catch (e) { return fail(e); }
});

server.registerTool('dev_tree', {
  description: 'Development tree: points available and the nodes that can be bought now (all=true lists every node with why it cannot be bought). unlock=<node name> buys that node through the game and confirms it; many buildings (college, bus lines, wider roads) stay locked until their node is bought.',
  inputSchema: { all: z.boolean().optional(), unlock: z.string().optional() },
}, async (a) => {
  try {
    if (!a.unlock) return ok(await devTree(!!a.all));
    const cleared = await ensureClear();
    assertIdle();
    const r = await unlockNode(a.unlock);
    if (r.ok) await recordAction({ need: 'unlock', tool: 'dev_tree', detail: `${r.name} (${r.service}) for ${r.cost} points` });
    return ok(withCleared(r, cleared));
  } catch (e) { return fail(e); }
});

server.registerTool('relocate_building', {
  description: 'Moves a placed building by id (index/version from notifications or the pollution_sources query) to a roadside site near (x,z). For a noisy or polluting building the site rules apply automatically: no homes within 300 m and, for air polluters, no homes downwind. Use it for noise or air-pollution icon clusters whose source is a turbine or plant, instead of rezoning the homes. plan=true only reports the site.',
  inputSchema: { index: z.number().int(), version: z.number().int(), x: z.number(), z: z.number(), radius: z.number().min(50).max(2000).optional(), plan: z.boolean().optional() },
}, async (a) => {
  try {
    const cleared = await ensureClear();
    assertIdle();
    const r = await relocate(a.index, a.version, a.x, a.z, a.radius ?? 400, !!a.plan);
    if (r.ok && !a.plan) await recordAction({ need: 'pollution', tool: 'relocate_building', detail: `${r.prefab} -> ${r.at?.x},${r.at?.z}` });
    return ok(withCleared(r, cleared));
  } catch (e) { return fail(e); }
});

server.registerTool('build_line', {
  description: 'Builds one cable or pipe between two points (kind: power_low, power_high, power_high_overhead, power_low_overhead, water, sewage, pipe, or a network prefab name; ground cables and pipes are refused across water, use the overhead kinds there); the ends snap to the road, pipe, cable or building terminal there. Previewed by the game first. Postcondition: both ends must be connected; a loose end returns partial with its position. Use it for the network need in the snapshot (loose cable/pipe icons) and to join a district the snapshot reports as not connected.',
  inputSchema: { kind: z.string(), fromX: z.number(), fromZ: z.number(), toX: z.number(), toZ: z.number(), viaX: z.number().optional(), viaZ: z.number().optional(), plan: z.boolean().optional() },
}, async (a) => {
  try {
    const cleared = await ensureClear();
    assertIdle();
    const r = await buildLine(a.kind, { x: a.fromX, z: a.fromZ }, { x: a.toX, z: a.toZ }, a.viaX !== undefined && a.viaZ !== undefined ? { x: a.viaX, z: a.viaZ } : undefined, !!a.plan);
    if (r.ok && !a.plan) await recordAction({ need: 'network', tool: 'build_line', detail: `${r.prefab} (${a.fromX},${a.fromZ})->(${a.toX},${a.toZ})` });
    return ok(withCleared(r, cleared));
  } catch (e) { return fail(e); }
});

server.registerTool('notifications', {
  description: 'On-map notification icons (traffic bottleneck, burned down, noise pollution, hearse, garbage, no power...): counts by type with the action each asks for, and the positions/owners for one type. Non-pausing. Check every play cycle.',
  inputSchema: { type: z.string().optional(), top: z.number().int().min(1).max(100).optional() },
}, async (a) => {
  try { return ok(await notifications(a.type, a.top ?? 20)); } catch (e) { return fail(e); }
});

server.registerTool('clear_ruins', {
  description: 'Bulldozes burned-down or collapsed buildings (from their notification icons) so the lots rebuild. plan=true lists them. Add fire coverage where fires recur.',
  inputSchema: { max: z.number().int().min(1).max(30).optional(), plan: z.boolean().optional() },
}, async (a) => {
  try {
    const cleared = await ensureClear();
    assertIdle();
    return ok(withCleared(await clearRuins(a.max ?? 8, !!a.plan), cleared));
  } catch (e) { return fail(e); }
});

server.registerTool('add_connections', {
  description: "Adds extra road links between an existing grid rectangle (min corner x0,z0 to max corner x1,z1) and the surrounding network on other sides, lot-free and previewed by the game. Use when a block's single connector is the local traffic bottleneck. plan=true previews only.",
  inputSchema: { x0: z.number(), z0: z.number(), x1: z.number(), z1: z.number(), count: z.number().int().min(1).max(4).optional(), road: z.string().optional(), plan: z.boolean().optional() },
}, async (a) => {
  try {
    const cleared = await ensureClear();
    assertIdle();
    const r = await addConnections(a.x0, a.z0, a.x1, a.z1, a.count ?? 2, a.road ?? 'Small Road', !!a.plan);
    if (r.ok && !a.plan) await recordAction({ need: 'traffic', tool: 'add_connections', detail: `${(r.added ?? []).length} extra links for grid ${a.x0},${a.z0}` });
    return ok(withCleared(r, cleared));
  } catch (e) { return fail(e); }
});

server.registerTool('remove_road', {
  description: "Bulldozes one road edge by id (index/version from traffic_hotspots, notifications or a network query). Use only to undo a road that turned out to be harmful; it never removes buildings.",
  inputSchema: { index: z.number().int(), version: z.number().int(), why: z.string().min(5) },
}, async (a) => {
  try {
    const cleared = await ensureClear();
    assertIdle();
    const info = await callOk('inspect_entity', { index: a.index, version: a.version }, 10);
    if (!(info.components ?? []).includes('Game.Net.Edge') || (info.components ?? []).includes('Game.Buildings.Building')) return fail('target_is_not_a_road_edge');
    if (/Highway/i.test(String(info.prefab))) return fail('refusing_to_remove_a_highway');
    const r = await removeRoad(a.index, a.version);
    if (r.ok) await recordAction({ need: 'traffic', tool: 'remove_road', detail: `${info.prefab} ${a.index}: ${a.why}` });
    return ok(withCleared({ ...r, prefab: info.prefab }, cleared));
  } catch (e) { return fail(e); }
});

server.registerTool('quit', {
  description: 'Verified rolling save, then a clean quit through the mod (never force-kills). Use it instead of leaving the game idle during long offline work.',
  inputSchema: {},
}, async () => {
  try {
    assertIdle();
    const r = await runPwsh('upgrade.ps1', ['-QuitOnly'], 600000);
    return ok({ exit: r.code, lines: tail(r.lines, 8) });
  } catch (e) { return fail(e); }
});

server.registerTool('query', {
  description: 'Raw read-only bridge query (last resort). The result is always valid JSON: use fields (dot paths) to project, offset/limit to page an array; an oversized result is returned as a shape summary instead of cut text. Most commands pause the game.',
  inputSchema: {
    command: z.enum([
      'get_city_state', 'get_city_management', 'get_city_diagnostics', 'get_services', 'get_buildings',
      'diagnose_connections', 'get_city_map', 'get_network_edges', 'get_tiles', 'get_water_facilities',
      'find_building_sites', 'get_prefab_details', 'get_build_prefabs', 'sample_terrain', 'get_zone_cells', 'service_buildings', 'plan_grid', 'connected', 'zone_area_count', 'grid_connectors', 'home_clusters', 'crime_map', 'tile_options', 'notifications', 'transit_status', 'dev_tree', 'service_headroom', 'get_metrics', 'utility_check', 'network_ends', 'pollution_sources', 'garbage_system', 'junction_info', 'outside_connections', 'building_upgrades', 'find_free_lots', 'find_roadside_lots',
      'get_capabilities',
    ]),
    args: z.record(z.any()).default({}),
    fields: z.array(z.string()).max(20).optional().describe('dot paths to keep, e.g. ["edges.index","edges.prefab"]; arrays are mapped'),
    offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(500).optional(),
    maxChars: z.number().int().min(200).max(20000).default(4000),
  },
}, async (a) => {
  try {
    await ensureClear(); // text result: popups cleared here are not reported
    assertIdle();
    const res = await callOk(a.command, a.args ?? {}, 30);
    // Always valid JSON: projected by fields, paged by offset/limit, or summarised by shape.
    return { content: [{ type: 'text', text: fit(res, { fields: a.fields, offset: a.offset, limit: a.limit, maxChars: a.maxChars }) }] };
  } catch (e) { return fail(e); }
});

// Drops undefined optional args so the mod only sees keys the caller actually set.
function pick(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

server.registerTool('free_lots', {
  description: 'Free, owned, dry, flat land for a width x depth rectangle (metres; x,z = min corner), ranked by link length and land use, with a lot-free connector from the nearest road. Computed in the mod in milliseconds.',
  inputSchema: {
    width: z.number().min(16).max(1500),
    depth: z.number().min(16).max(1500),
    count: z.number().int().min(1).max(20).optional(),
    zone: zoneEnum.optional(),
    x: z.number().optional(),
    z: z.number().optional(),
    radius: z.number().optional(),
    step: z.number().optional(),
    margin: z.number().optional(),
    maxLink: z.number().optional(),
  },
}, async (a) => {
  try {
    const cleared = await ensureClear();
    return ok(withCleared(await callOk('find_free_lots', pick({
      width: a.width, depth: a.depth, count: a.count, zone: a.zone, x: a.x, z: a.z,
      radius: a.radius, step: a.step, margin: a.margin, maxLink: a.maxLink,
    }), 60), cleared));
  } catch (e) { return fail(e); }
});

server.registerTool('roadside_lots', {
  description: 'Rotated roadside positions for a building\'s lot, clear of lots, roads and unowned land.',
  inputSchema: {
    prefab: z.string(),
    x: z.number(),
    z: z.number(),
    radius: z.number().optional(),
    count: z.number().int().min(1).max(16).optional(),
  },
}, async (a) => {
  try {
    const cleared = await ensureClear();
    return ok(withCleared(await callOk('find_roadside_lots', pick({
      prefab: a.prefab, x: a.x, z: a.z, radius: a.radius, count: a.count,
    }), 60), cleared));
  } catch (e) { return fail(e); }
});

server.registerTool('corridor', {
  description: 'Lot-free road route on owned land (straight if possible, else A* waypoints); build each segment with link/build tools after a preview.',
  inputSchema: {
    fromX: z.number(),
    fromZ: z.number(),
    toX: z.number(),
    toZ: z.number(),
    halfWidth: z.number().optional(),
  },
}, async (a) => {
  try {
    const cleared = await ensureClear();
    return ok(withCleared(await callOk('corridor', pick({
      from: { x: a.fromX, z: a.fromZ },
      to: { x: a.toX, z: a.toZ },
      halfWidth: a.halfWidth,
    }), 60), cleared));
  } catch (e) { return fail(e); }
});

server.registerTool('coverage_gaps', {
  description: 'Homes whose road has low native service coverage, clustered; place the new facility at the densest cluster.',
  inputSchema: {
    service: z.enum(['Healthcare', 'FireRescue', 'Police', 'Park', 'PostService', 'Education', 'EmergencyShelter', 'Welfare']),
    threshold: z.number().optional(),
    cell: z.number().optional(),
    top: z.number().int().min(1).max(10).optional(),
  },
}, async (a) => {
  try {
    const cleared = await ensureClear();
    return ok(withCleared(await callOk('coverage_gaps', pick({
      service: a.service, threshold: a.threshold, cell: a.cell, top: a.top,
    }), 60), cleared));
  } catch (e) { return fail(e); }
});

server.registerTool('traffic_hotspots', {
  description: 'Road edges with the lowest native traffic flow (flowPct 100 = free flow).',
  inputSchema: {
    top: z.number().int().min(1).max(30).optional(),
    minLength: z.number().optional(),
  },
}, async (a) => {
  try {
    const cleared = await ensureClear();
    return ok(withCleared(await callOk('traffic_hotspots', pick({ top: a.top, minLength: a.minLength }), 60), cleared));
  } catch (e) { return fail(e); }
});

server.registerTool('project', {
  description: 'Projected construction cost, monthly upkeep, zone income and net per period for a list of proposed actions, from live city data. Call before building.',
  inputSchema: {
    actions: z.array(z.object({
      prefab: z.string().optional(),
      count: z.number().int().min(1).optional(),
      zone: zoneEnum.optional(),
      cells: z.number().int().min(0).optional(),
    })).max(20),
  },
}, async (a) => {
  try {
    const cleared = await ensureClear();
    return ok(withCleared(await callOk('project', { actions: a.actions }, 60), cleared));
  } catch (e) { return fail(e); }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('cs2 MCP server ready on stdio');
