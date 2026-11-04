// Which Claude Code sessions are running. Claude Code writes ~/.claude/sessions/<pid>.json {pid, sessionId, cwd,
// procStart, kind ("interactive" | "bg"), name, …} for each running session, and can leave one behind when it dies.
// A record counts as live while its pid runs and, since pids get reused, that process started when procStart says.
// procStart is `ps -o lstart=` text in UTC.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

export const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const START_SLACK = 2000;

const utc = (lstart) => Date.parse(`${String(lstart).trim().replace(/\s+/g, ' ')} UTC`);

// [record] and a Map pid → the process's start (ms) → the records whose process still runs.
export function liveOf(records, starts) {
  return records.filter((r) => {
    if (!starts.has(r.pid)) return false;
    if (typeof r.procStart !== 'string') return true;
    const recorded = utc(r.procStart);
    return Number.isNaN(recorded) || Math.abs(recorded - starts.get(r.pid)) <= START_SLACK;
  });
}

export function sessionRecords(dir = SESSIONS_DIR) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch {}
  return files.flatMap((f) => {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      return Number.isInteger(r?.pid) && typeof r.sessionId === 'string' ? [r] : [];
    } catch { return []; }
  });
}

// pids → Map pid → start time (ms) for those still running, from one ps call.
export function processStarts(pids) {
  const starts = new Map();
  if (!pids.length) return starts;
  let text = '';
  try {
    text = execFileSync('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], { encoding: 'utf8', timeout: 3000, env: { ...process.env, TZ: 'UTC' } });
  } catch (e) { text = e.stdout || ''; }
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (m) starts.set(Number(m[1]), utc(m[2]));
  }
  return starts;
}

export function verifiedProcess(record, starts = processStarts) {
  if (!Number.isInteger(record?.pid) || record.pid <= 0 || !record.sessionId || typeof record.procStart !== 'string') return false;
  const recorded = utc(record.procStart);
  if (!Number.isFinite(recorded)) return false;
  const actual = starts([record.pid]).get(record.pid);
  return Number.isFinite(actual) && Math.abs(recorded - actual) <= START_SLACK;
}

// → Map sessionId → its live record.
export function liveSessions({ dir = SESSIONS_DIR, starts = processStarts } = {}) {
  const records = sessionRecords(dir);
  return new Map(liveOf(records, starts([...new Set(records.map((r) => r.pid))])).map((r) => [r.sessionId, r]));
}

// pid's parent pid, or null once pid no longer runs.
export function parentOf(pid) {
  try { return Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 }).trim()) || null; } catch { return null; }
}

// Whether the Claude Code session that launched a process has died, for bin/wait-events.mjs: its parent (the shell
// the session ran it in) changed, that shell's parent (the session's process) changed, which happens when the session
// dies and the shell is reparented to launchd, or the session no longer runs at all. start is [parent, grandparent] as
// the process started (docs/adr/2026-11-03-2010-a-watcher-exits-when-its-session-dies.md).
export function sessionGone(session, start, { ppid = process.ppid, parent = parentOf, live = liveSessions } = {}) {
  return ppid !== start[0] || parent(start[0]) !== start[1] || !live().has(session);
}
