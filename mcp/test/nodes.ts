// LIVE helper: road nodes near a point (index, version, position incl. height).
import { callOk } from '../src/bridge.ts';
const [x, z, r] = process.argv.slice(2).map(Number);
const d = await callOk('get_network', { x, z, radius: r, limit: 200 }, 30);
for (const n of d.nodes ?? []) console.log(n.index, n.version, Math.round(n.position.x), Math.round(n.position.y), Math.round(n.position.z), 'edges', (n.edges ?? []).length);
console.log('total', d.total);
