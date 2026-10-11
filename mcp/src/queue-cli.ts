// Work queue from the command line (journals/queue.json).
//   node src/queue-cli.ts list
//   node src/queue-cli.ts set <id> <queued|in_progress|blocked|done|dropped> [blocker or note]
//   node src/queue-cli.ts wait <id> <minutes> <what it waits for>      (a measurement window or money)
//   node src/queue-cli.ts add <id> <priority> <code|haiku|opus> <title>
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadQueue, saveQueue, queueLine, queueMarkdown } from './queue.ts';
import type { QueueItem, QueueStatus } from './queue.ts';
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const [cmd, id, ...rest] = process.argv.slice(2); const now = new Date().toISOString();
const { items } = await loadQueue(repo); const item = items.find(i => i.id === id);
if (cmd === 'set') { if (!item) { console.log('no such item', id); process.exit(1); } item.status = rest[0] as QueueStatus; item.updated = now; delete item.waitUntil; delete item.waitFor; if (rest[0] === 'blocked') item.blocker = rest.slice(1).join(' ') || 'no reason given'; else delete item.blocker; await saveQueue(repo, items); }
else if (cmd === 'wait') { if (!item) { console.log('no such item', id); process.exit(1); } item.waitUntil = new Date(Date.now() + Number(rest[0]) * 60000).toISOString(); item.waitFor = rest.slice(1).join(' ') || 'a measurement'; item.updated = now; await saveQueue(repo, items); }
else if (cmd === 'add') { if (item) { console.log('already there', id); process.exit(1); } items.push({ id, priority: Number(rest[0]), owner: rest[1] as QueueItem['owner'], title: rest.slice(2).join(' '), status: 'queued', created: now, updated: now }); await saveQueue(repo, items); }
console.log(queueLine(items, Date.now()) || 'queue: empty'); if (cmd === 'list' || !cmd) console.log(queueMarkdown(items, Date.now()));
