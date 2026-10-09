// MCP stdio server for the CitiesIIAgentBridge mod. Thin tool layer over bridge.ts.
// Logs go to stderr only; stdout belongs to the MCP transport.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { callOk, readEvents, runPwsh, assertIdle, fixPopups, run, prefabInfo, money } from './bridge.ts';

const server = new McpServer({ name: 'cs2', version: '0.1.0' });

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

const zoneEnum = z.enum(['res', 'resmed', 'com', 'ind', 'off']);
const growZoneEnum = z.enum(['res', 'resmed', 'com', 'ind', 'off']);

server.registerTool('snapshot', {
  description: 'Returns the cached city state (about 1 s old) without pausing the game; safe during a run.',
  inputSchema: {},
}, async () => {
  try {
    return ok(await callOk('get_snapshot', {}, 10));
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
  description: 'Runs a bounded simulation for the given seconds at speed 1, 2 or 4, passing popups and stopping early on new shortages or the cash floor.',
  inputSchema: {
    seconds: z.number().int().min(1).max(1800),
    speed: z.union([z.literal(1), z.literal(2), z.literal(4)]).default(4),
    cashFloor: z.number().int().min(0).default(0),
  },
}, async (a) => {
  try {
    return ok({ summary: await run(a.seconds, a.speed, a.cashFloor) });
  } catch (e) { return fail(e); }
});

server.registerTool('build_grid', {
  description: 'Places a grid of zoned lots or roads at x,z; pauses the game. Use plan=true to preview the cost without building.',
  inputSchema: {
    x: z.number(),
    z: z.number(),
    cols: z.number().int().min(1).max(6).default(3),
    rows: z.number().int().min(1).max(6).default(2),
    zone: zoneEnum.default('res'),
    plan: z.boolean().default(false),
  },
}, async (a) => {
  try {
    assertIdle();
    const m0 = await money();
    const r = await runPwsh('play.ps1', [
      'grid', '-X', String(a.x), '-Z', String(a.z), '-Cols', String(a.cols), '-Rows', String(a.rows),
      '-Zone', a.zone, ...(a.plan ? ['-Plan'] : []),
    ]);
    const m1 = await money();
    return ok({
      cost: m0 - m1,
      monthlyUpkeep: null,
      upkeepNote: 'road upkeep shows in snapshot expense after the next budget period',
      exit: r.code,
      lines: tail(r.lines),
    });
  } catch (e) { return fail(e); }
});

server.registerTool('grow', {
  description: 'Picks a zone by demand (or the given zone, demand >= 20), finds free owned land, builds a road grid, zones and connects it (play.ps1 grow); pauses the game. Use plan=true first.',
  inputSchema: {
    zone: growZoneEnum.optional(),
    cols: z.number().int().min(1).max(6).optional(),
    rows: z.number().int().min(1).max(6).optional(),
    plan: z.boolean().optional(),
    buyTiles: z.boolean().optional(),
  },
}, async (a) => {
  try {
    assertIdle();
    const m0 = await money();
    const r = await runPwsh('play.ps1', [
      'grow',
      ...(a.zone ? ['-Zone', a.zone] : []),
      ...(a.cols ? ['-Cols', String(a.cols)] : []),
      ...(a.rows ? ['-Rows', String(a.rows)] : []),
      ...(a.plan ? ['-Plan'] : []),
      ...(a.buyTiles ? ['-BuyTiles'] : []),
    ]);
    const m1 = await money();
    return ok({
      cost: m0 - m1,
      monthlyUpkeep: null,
      upkeepNote: 'road upkeep shows in snapshot expense after the next budget period',
      exit: r.code,
      lines: tail(r.lines, 15),
    });
  } catch (e) { return fail(e); }
});

server.registerTool('link', {
  description: 'Builds a straight road from the nearest existing road to (x,z) that crosses no lot, checked by the game (play.ps1 link); connects grids or adds arterials. Pauses the game.',
  inputSchema: { x: z.number(), z: z.number(), road: z.string().optional(), max: z.number().int().optional(), plan: z.boolean().optional() },
}, async (a) => {
  try {
    assertIdle();
    const m0 = await money();
    const r = await runPwsh('play.ps1', ['link', '-X', String(a.x), '-Z', String(a.z), '-Road', a.road ?? 'Small Road', '-Max', String(a.max ?? 60000), ...(a.plan ? ['-Plan'] : [])]);
    const m1 = await money();
    return ok({ cost: m0 - m1, monthlyUpkeep: null, exit: r.code, lines: tail(r.lines, 6) });
  } catch (e) { return fail(e); }
});

server.registerTool('zone', {
  description: 'Zones every zonable empty cell within radius of (x,z) with the zone type (play.ps1 zone); free. Pauses the game.',
  inputSchema: { x: z.number(), z: z.number(), radius: z.number().min(20).max(500).optional(), zone: zoneEnum },
}, async (a) => {
  try {
    assertIdle();
    const r = await runPwsh('play.ps1', ['zone', '-X', String(a.x), '-Z', String(a.z), '-R', String(a.radius ?? 300), '-Zone', a.zone]);
    return ok({ cost: 0, monthlyUpkeep: 0, exit: r.code, lines: tail(r.lines, 4) });
  } catch (e) { return fail(e); }
});

server.registerTool('place_service', {
  description: 'Places a building prefab by exact name near x,z; pauses the game. Use plan=true to check cost and upkeep without placing.',
  inputSchema: {
    prefab: z.string(),
    x: z.number(),
    z: z.number(),
    radius: z.number().default(300),
    maxCost: z.number().int().default(150000),
    plan: z.boolean().default(false),
  },
}, async (a) => {
  try {
    assertIdle();
    const info = await prefabInfo(a.prefab, 'building');
    if (!info.found) return ok({ found: false, similar: info.similar });
    if (info.locked) return fail('prefab_locked: ' + a.prefab);
    if (a.plan) {
      return ok({
        plan: true,
        construction: info.construction,
        monthlyUpkeep: info.monthlyUpkeep,
        consumptionUpkeep: info.consumptionUpkeep,
      });
    }
    const m0 = await money();
    const r = await runPwsh('play.ps1', [
      'place', a.prefab, '-X', String(a.x), '-Z', String(a.z), '-R', String(a.radius), '-Max', String(a.maxCost),
    ]);
    const m1 = await money();
    return ok({
      cost: m0 - m1,
      construction: info.construction,
      monthlyUpkeep: info.monthlyUpkeep ?? info.consumptionUpkeep ?? null,
      exit: r.code,
      lines: tail(r.lines, 8),
    });
  } catch (e) { return fail(e); }
});

server.registerTool('prefabs', {
  description: 'Searches build prefabs by name (unlocked first) with construction and upkeep costs for the top matches; pauses the game.',
  inputSchema: {
    filter: z.string(),
    kind: z.enum(['building', 'network', 'zone', 'service', 'all']).default('building'),
    limit: z.number().int().min(1).max(30).default(12),
    costs: z.boolean().default(true),
  },
}, async (a) => {
  try {
    assertIdle();
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
    return ok({
      total: page.total ?? list.length,
      prefabs: top.map(p => ({ name: p.name, locked: p.locked, ...(p.costs ?? {}) })),
    });
  } catch (e) { return fail(e); }
});

server.registerTool('set_tax', {
  description: 'Sets the tax rate (percent) for one zone area; pauses the game.',
  inputSchema: {
    area: z.enum(['Residential', 'Commercial', 'Industrial', 'Office']),
    rate: z.number().int().min(-10).max(30),
  },
}, async (a) => {
  try {
    assertIdle();
    const r = await callOk('set_tax', { area: a.area, rate: a.rate });
    return ok({ area: a.area, before: r.before, after: r.after, cost: 0, monthlyUpkeep: 0 });
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
    return ok({ service: s.name, before: r.before, after: r.after, workers: s.workers, workplaces: s.workplaces, cost: 0 });
  } catch (e) { return fail(e); }
});

server.registerTool('services', {
  description: 'Lists city services with budget, building count, workers and workplaces; pauses the game.',
  inputSchema: {},
}, async () => {
  try {
    assertIdle();
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

server.registerTool('buy_tile', {
  description: 'Buys one to three map tiles within a cost cap; pauses the game. Use plan=true to preview.',
  inputSchema: {
    n: z.number().int().min(1).max(3).default(1),
    max: z.number().int().default(300000),
    plan: z.boolean().optional(),
  },
}, async (a) => {
  try {
    assertIdle();
    const m0 = await money();
    const r = await runPwsh('play.ps1', ['buy', '-N', String(a.n), '-Max', String(a.max), ...(a.plan ? ['-Plan'] : [])]);
    const m1 = await money();
    return ok({
      cost: m0 - m1,
      monthlyUpkeep: null,
      upkeepNote: 'tile upkeep appears in snapshot expense',
      exit: r.code,
      lines: tail(r.lines),
    });
  } catch (e) { return fail(e); }
});

server.registerTool('save', {
  description: 'Saves the game through the harness script and returns its last output lines; pauses the game.',
  inputSchema: {},
}, async () => {
  try {
    assertIdle();
    const r = await runPwsh('play.ps1', ['save']);
    return ok({ exit: r.code, lines: tail(r.lines, 4) });
  } catch (e) { return fail(e); }
});

server.registerTool('restart', {
  description: 'Saves (verified), quits safely, optionally rebuilds and installs, relaunches and loads the newest autosave; pauses the game.',
  inputSchema: {
    build: z.boolean().default(false),
    noInstall: z.boolean().default(false),
  },
}, async (a) => {
  try {
    assertIdle();
    const args = a.build ? ['-Build'] : (a.noInstall ? ['-NoInstall'] : []);
    const r = await runPwsh('upgrade.ps1', args, 1800000);
    return ok({ exit: r.code, lines: tail(r.lines, 12) });
  } catch (e) { return fail(e); }
});

server.registerTool('query', {
  description: 'Raw read-only bridge query; pauses the game. Last resort when no dedicated tool fits.',
  inputSchema: {
    command: z.enum([
      'get_city_state', 'get_city_management', 'get_city_diagnostics', 'get_services', 'get_buildings',
      'diagnose_connections', 'get_city_map', 'get_network_edges', 'get_tiles', 'get_water_facilities',
      'find_building_sites', 'get_prefab_details', 'get_build_prefabs', 'sample_terrain', 'get_zone_cells',
      'get_capabilities',
    ]),
    args: z.record(z.any()).default({}),
    maxChars: z.number().int().min(200).max(20000).default(4000),
  },
}, async (a) => {
  try {
    assertIdle();
    const res = await callOk(a.command, a.args ?? {}, 30);
    const text = JSON.stringify(res) ?? 'null';
    const out = text.length > a.maxChars
      ? text.slice(0, a.maxChars) + ' …[truncated ' + text.length + ' chars]'
      : text;
    return { content: [{ type: 'text', text: out }] };
  } catch (e) { return fail(e); }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('cs2 MCP server ready on stdio');
