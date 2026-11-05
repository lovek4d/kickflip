import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// docs/adr/2026-11-05-0913-the-hub-and-each-board-keep-an-audit-log-of-the-calls-their-code-makes.md
// One JSON line for each call the code makes on its own, {at, call, key?, result, reason, inputs}: a board's in
// <site>/data/audit.jsonl, the hub's own in ~/.claude/kickflip/audit.jsonl. inputs is what the call read to decide.
// An append drops the entries older than AUDIT_DAYS, so each log keeps the last AUDIT_DAYS days; a read skips them too.
// A call the code retries on every check until something changes, such as a merge GitHub refuses, passes once: true,
// so it is logged when its outcome changes, not on each try.
export const AUDIT_DAYS = 30;
const DAY = 86400_000;
export const boardAudit = (site) => path.join(site, 'data', 'audit.jsonl');
export const hubAudit = (home = os.homedir()) => path.join(home, '.claude', 'kickflip', 'audit.jsonl');

// The time of the log's first entry, which is its oldest, read from the start of the file alone; null without a log.
function oldestAt(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try {
    const head = Buffer.alloc(64);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    return Date.parse(head.toString('utf8', 0, read).match(/^\{"at":"([^"]+)"/)?.[1]);
  } finally { fs.closeSync(fd); }
}

export function audit(file, { call, key, result, reason, inputs }, { now = new Date(), once = false } = {}) {
  if (once) {
    const last = readAudit(file, { key, now }).findLast((e) => e.call === call);
    if (last?.result === result && last.reason === reason) return;
  }
  const line = JSON.stringify({ at: now.toISOString(), call, ...(key ? { key } : {}), result, reason, inputs }) + '\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const cutoff = now.getTime() - AUDIT_DAYS * DAY;
  if (!(oldestAt(file) < cutoff)) return fs.appendFileSync(file, line);
  const kept = readAudit(file, { now }).map((e) => JSON.stringify(e) + '\n').join('');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, kept + line);
  fs.renameSync(tmp, file);
}

// The log's entries from the last AUDIT_DAYS days, oldest first, only key's when given. A line a crash cut short is skipped.
export function readAudit(file, { key, now = new Date() } = {}) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const cutoff = now.getTime() - AUDIT_DAYS * DAY;
  return text.split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
    .filter((e) => Date.parse(e.at) >= cutoff && (!key || e.key === key));
}

// `board.mjs audit` and `kickflip audit`: each entry as "<at> <call> [<key>]: <result>. <reason>", then its inputs.
export function auditLines(entries) {
  if (!entries.length) return [`No calls in the last ${AUDIT_DAYS} days.`];
  return entries.flatMap((e) => [`${e.at} ${[e.call, e.key].filter(Boolean).join(' ')}: ${e.result}. ${e.reason}`, `  inputs: ${JSON.stringify(e.inputs ?? {})}`]);
}
