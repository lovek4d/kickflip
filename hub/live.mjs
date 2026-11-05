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

// Whether pid runs, by signal 0, which needs no ps: EPERM is a process this user can't signal, still running.
const running = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

// ps's answer for argv, or null when ps gave none: it timed out (a loaded Mac takes seconds) or didn't run. ps exits
// 1 when a pid it was asked about doesn't run, and that is still its answer. The timeout is 3 s, or
// KICKFLIP_PS_TIMEOUT_MS, which tests of a stalled ps set short.
export function ps(argv) {
  const timeout = Number(process.env.KICKFLIP_PS_TIMEOUT_MS) || 3000;
  try { return execFileSync('ps', argv, { encoding: 'utf8', timeout, env: { ...process.env, TZ: 'UTC' } }); }
  catch (e) { return typeof e.status === 'number' && !e.signal ? e.stdout || '' : null; }
}

// pids → Map pid → start time (ms) for those still running, from one ps call over the pids that still run, or null
// when ps gave no answer, which leaves every pid's liveness unknown.
export function processStarts(pids) {
  const starts = new Map();
  const alive = pids.filter(running);
  if (!alive.length) return starts;
  const text = ps(['-o', 'pid=,lstart=', '-p', alive.join(',')]);
  if (text === null) return null;
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
  const actual = starts([record.pid])?.get(record.pid);
  return Number.isFinite(actual) && Math.abs(recorded - actual) <= START_SLACK;
}

// → Map sessionId → its live record, or null when ps gave no answer and which sessions run is unknown. session limits
// it to that session's records, so ps is asked about its pid alone.
export function liveSessions({ dir = SESSIONS_DIR, starts = processStarts, session = null } = {}) {
  const records = sessionRecords(dir).filter((r) => !session || r.sessionId === session);
  const found = starts([...new Set(records.map((r) => r.pid))]);
  return found && new Map(liveOf(records, found).map((r) => [r.sessionId, r]));
}

// pid's parent pid, null once pid no longer runs, or undefined when ps gave no answer.
export function parentOf(pid) {
  const text = ps(['-o', 'ppid=', '-p', String(pid)]);
  return text === null ? undefined : Number(text.trim()) || null;
}

// Whether the Claude Code session that launched a process has died, for bin/wait-events.mjs: its parent (the shell
// the session ran it in) changed, that shell's parent (the session's process) changed, which happens when the session
// dies and the shell is reparented to launchd, or the session no longer runs at all. start is [parent, grandparent] as
// the process started, the grandparent undefined while ps hasn't answered for it. A check ps gives no answer for
// leaves the session's liveness unknown, which never counts as gone
// (docs/adr/2026-11-03-2010-a-watcher-exits-when-its-session-dies.md).
export function sessionGone(session, start, { ppid = process.ppid, parent = parentOf, live = liveSessions } = {}) {
  if (ppid !== start[0]) return true;
  const grandparent = parent(start[0]);
  if (grandparent === null) return true;
  if (grandparent !== undefined && start[1] !== undefined && grandparent !== start[1]) return true;
  const running = live({ session });
  return running !== null && !running.has(session);
}
