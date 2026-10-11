// The agent's wait, in short slices (never one long sleep):  node src/wait.ts [seconds, at most 60]
// Returns at once when
//   - journals/inbox/WAKE exists (the coordinator sent a message): the file is deleted, "WAKE" is printed;
//   - the status line (journals/pilot/last-line.txt) shows an ATTENTION or STALLED text not seen by the last wait;
//   - journals/queue.json changes;
// otherwise after the given seconds. It always prints the reason and the current status line.
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const inbox = join(repo, 'journals', 'inbox'); mkdirSync(inbox, { recursive: true });
const wake = join(inbox, 'WAKE'), seen = join(inbox, 'seen-alert.txt'), queue = join(repo, 'journals', 'queue.json'), lineFile = join(repo, 'journals', 'pilot', 'last-line.txt');
const seconds = Math.max(1, Math.min(60, Number(process.argv[2] ?? 60)));
const read = (f: string) => { try { return readFileSync(f, 'utf8').trim(); } catch { return ''; } };
const mtime = (f: string) => { try { return statSync(f).mtimeMs; } catch { return 0; } };
// The alert text without the clock and the numbers that change every cycle, so a standing alert wakes once.
const alertOf = (line: string) => { const m = /(STALLED[^|]*|ATTENTION: .*)$/.exec(line); return m ? m[0].replace(/\d+ minutes/g, 'N minutes').slice(0, 400) : ''; };
const q0 = mtime(queue); const t0 = Date.now(); let reason = `timeout ${seconds}s`;
while (Date.now() - t0 < seconds * 1000) {
  if (existsSync(wake)) { const text = read(wake); try { unlinkSync(wake); } catch { /* already gone */ } reason = 'WAKE' + (text ? `: ${text.slice(0, 300)}` : ''); break; }
  const alert = alertOf(read(lineFile)); if (alert && alert !== read(seen)) { writeFileSync(seen, alert); reason = /STALLED/.test(alert) ? 'STALLED' : 'ATTENTION'; break; }
  if (mtime(queue) !== q0) { reason = 'queue changed'; break; }
  await new Promise(r => setTimeout(r, 1000));
}
console.log(reason); console.log(read(lineFile).slice(0, 900));
