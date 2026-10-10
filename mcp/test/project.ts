// Offline checks for the query projection: output is always valid JSON within the limit.
import { fit, project, pluck, shapeOf } from '../src/project.ts';
let failed = 0; const check = (ok: boolean, label: string) => { console.log((ok ? 'PASS: ' : 'FAIL: ') + label); if (!ok) failed++; };
const big = { total: 500, edges: Array.from({ length: 500 }, (_, i) => ({ index: i, prefab: 'Small Road', curve: [{ x: i, z: i }, { x: i + 1, z: i + 1 }], note: 'x'.repeat(40) })), citySession: 'abc' };
const parse = (t: string) => { try { return JSON.parse(t); } catch { return undefined; } };
check(parse(fit(big, { maxChars: 4000 })) !== undefined, 'oversized result is still valid JSON');
check(fit(big, { maxChars: 4000 }).length <= 4000, 'oversized result respects maxChars');
check(parse(fit(big, { maxChars: 4000 })).truncated === true, 'oversized result is flagged truncated');
const p = parse(fit(big, { fields: ['edges.index', 'edges.prefab'], limit: 5, offset: 10, maxChars: 4000 }));
check(p.page.total === 500 && p.result.edges.length === 5 && p.result.edges[0].index === 10 && p.result.edges[0].curve === undefined, 'fields + offset/limit project and page the array');
check(JSON.stringify(project({ a: { b: 1, c: 2 }, d: 3 }, ['a.b'])) === '{"a":{"b":1}}', 'project keeps the nested path only');
check(JSON.stringify(pluck([{ a: { b: 1 } }, { a: { b: 2 } }], ['a', 'b'])) === '[1,2]', 'pluck maps arrays');
check(typeof shapeOf(big).edges === 'string' && shapeOf(big).edges.startsWith('array[500]'), 'shapeOf describes arrays');
check(parse(fit({ s: 'y'.repeat(50000) }, { maxChars: 300 })) !== undefined, 'a huge string value never produces cut JSON');
check(parse(fit(Object.fromEntries(Array.from({ length: 400 }, (_, i) => ['key_' + i, 'v'.repeat(100)])), { maxChars: 250 })) !== undefined, 'many keys with a tiny limit is still valid JSON');
check(fit({ ok: true }, { maxChars: 4000 }) === '{"ok":true}', 'small results pass through unchanged');
process.exit(failed ? 1 : 0);
