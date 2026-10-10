// LIVE helper: bulldoze one entity by id (building, cable, pipe). Usage: node test/demolish.ts <index> <version>
import { call, waitOperation } from '../src/bridge.ts';
const [index, version] = process.argv.slice(2).map(Number);
const op = await call('demolish', { index, version }, 15);
if (!op.ok) { console.log('REFUSED', JSON.stringify(op.error)); process.exit(0); }
const done = await waitOperation(op.result.id, 60);
console.log(JSON.stringify({ status: done.status, error: done.error }));
