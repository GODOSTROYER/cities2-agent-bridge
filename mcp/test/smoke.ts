// Offline smoke test: starts the MCP server over stdio, checks the tool list and calls
// only `events` (reads local mailbox files). It never calls a tool that talks to the game.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mcpDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED = [
  'snapshot', 'events', 'ui', 'fix_popup', 'run', 'build_grid', 'grow', 'link', 'zone', 'place_service',
  'prefabs', 'set_tax', 'set_service_budget', 'services', 'buy_tile', 'save', 'restart', 'quit', 'upgrade_road', 'run_status', 'timings', 'fix_traffic', 'build_arterial', 'happiness', 'notifications', 'clear_ruins', 'tax_autopilot', 'query',
  'free_lots', 'corridor', 'coverage_gaps', 'traffic_hotspots', 'project', 'fix_services', 'roadside_lots',
];

async function main(): Promise<number> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['src/server.ts'],
    cwd: mcpDir,
  });
  const client = new Client({ name: 'cs2-smoke', version: '0.1.0' });
  try {
    await client.connect(transport);

    const { tools } = await client.listTools();
    const names = new Set(tools.map(t => t.name));
    const missing = EXPECTED.filter(n => !names.has(n));
    let code = 0;
    if (missing.length) {
      console.log('FAIL: missing ' + missing.join(', '));
      code = 1;
    } else {
      console.log(`PASS: ${EXPECTED.length} tools`);
    }
    if (EXPECTED.length !== 35) {
      console.log(`FAIL: expected list has ${EXPECTED.length} names, want 35`);
      code = 1;
    }

    const res: any = await client.callTool({ name: 'events', arguments: { limit: 3 } });
    const text = String(res.content?.[0]?.text ?? '');
    console.log(text.slice(0, 350));
    if (res.isError) {
      console.log('FAIL: events returned an error');
      code = 1;
    } else {
      console.log('PASS: events');
    }
    return code;
  } catch (e: any) {
    console.log('FAIL: ' + String(e?.message ?? e));
    return 1;
  } finally {
    await client.close();
  }
}

process.exitCode = await main();
