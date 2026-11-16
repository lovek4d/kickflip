import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { audit, hubAudit } from '../shared/audit.mjs';
import { FOREVER } from './duration.mjs';

const CODEX_FILES = 6;
const CLAUDE_LOGS = 12;
const SAME_WINDOW_S = 180;
const WINDOW_MS = { five_hour: 5 * 3600_000, seven_day: 7 * 86400_000 };
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const isoOf = (v) => {
  if (v == null || v === '') return null;
  const numeric = typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v));
  const ms = numeric ? (Number(v) > 1e12 ? Number(v) : Number(v) * 1000) : Date.parse(String(v));
  return Number.isFinite(new Date(ms).getTime()) ? new Date(ms).toISOString() : null;
};
const win = (pct, resets) => ({ used_percentage: num(pct), resets_at: isoOf(resets) });

// The last line of file, from its end, that holds needle and that pick turns into a value, or null. It reads the last
// 256KB first, then 2MB.
function lastMatch(file, needle, pick) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    for (const span of [256 * 1024, 2 * 1024 * 1024]) {
      const start = Math.max(0, size - span);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString('utf8').split('\n');
      if (start > 0) lines.shift();
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes(needle)) continue;
        try {
          const found = pick(JSON.parse(lines[i]));
          if (found) return found;
        } catch { /* a cut or odd line */ }
      }
      if (start === 0) break;
    }
  } catch { /* unreadable */ } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  return null;
}

const lastRateLimits = (file) => lastMatch(file, 'rate_limits', (o) => {
  const rl = o?.payload?.rate_limits ?? o?.rate_limits;
  return rl?.primary ? { rl } : null;
});

// docs/adr/2026-11-06-1249-the-pause-line-reads-every-headless-agents-usage.md
// A headless Claude run's log (board/agents.mjs) is stream-json, one event a line, with a rate_limit_event on each turn:
// {status, rateLimitType, resetsAt, unifiedWindows: {five_hour: {utilization 0..1, resetsAt, status}, seven_day}}, status
// allowed, allowed_warning or rejected. A rejected window reads 100%.
const lastRateLimitEvent = (file) => lastMatch(file, '"rate_limit_event"', (o) => (o?.type === 'rate_limit_event' && o.rate_limit_info ? o.rate_limit_info : null));
function eventWindows(info) {
  const window = (key) => {
    const w = info.unifiedWindows?.[key];
    if (!w || num(w.utilization) == null) return null;
    const rejected = w.status === 'rejected' || (info.status === 'rejected' && info.rateLimitType === key);
    return win(rejected ? 100 : Math.round(num(w.utilization) * 1000) / 10, w.resetsAt);
  };
  return { five_hour: window('five_hour'), seven_day: window('seven_day') };
}

// When a run whose log is file stopped on the limit: the reset of the window its last rate_limit_event rejected, while
// that reset is after now, else null. → an ISO time or null.
export function runLimit(file, now = Date.now()) {
  const info = lastRateLimitEvent(file);
  if (info?.status !== 'rejected') return null;
  const rejected = Object.values(info.unifiedWindows || {}).find((w) => w?.status === 'rejected');
  const at = isoOf(rejected?.resetsAt ?? info.resetsAt);
  return at && Date.parse(at) > now ? at : null;
}

// The board's run logs, ~/.claude/kickflip/logs/<role>-<id>-<launch time>.log, newest written first: the CLAUDE_LOGS
// newest, each with its launch time, whether it is a Claude run (its first line a stream-json event) and its newest
// rate_limit_event's windows. A file is read again only once its size or mtime changes.
const RUN_LOG = /-(\d{4}-\d\d-\d\dT\d\d)-(\d\d)-(\d\d)-(\d{3})Z\.log$/;
function runLogs(dir, seen) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const files = [];
  for (const name of names) {
    const m = name.match(RUN_LOG);
    if (!m) continue;
    try { const st = fs.statSync(path.join(dir, name)); files.push({ file: path.join(dir, name), started: `${m[1]}:${m[2]}:${m[3]}.${m[4]}Z`, mtime: st.mtimeMs, size: st.size }); } catch {}
  }
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, CLAUDE_LOGS).map((f) => {
    const key = `${f.size}:${f.mtime}`;
    let parsed = seen.get(f.file);
    if (parsed?.key !== key) {
      const info = f.size ? lastRateLimitEvent(f.file) : null;
      parsed = { key, claude: f.size > 0 && firstByte(f.file) === '{', windows: info ? eventWindows(info) : null };
      seen.set(f.file, parsed);
    }
    return { ...f, claude: parsed.claude, windows: parsed.windows };
  });
}
function firstByte(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, 0); return b.toString(); } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

// Claude's reading from the status line's usage.json (saved, its own {at, five_hour, seven_day}) and the run logs: per
// window the highest in the newest window, as scanCodex does, at the newest reading's time. Each log's reading is at its
// mtime. → a raw reading for readingOf, or null with none.
function claudeReading(saved, logs) {
  const readings = logs.filter((l) => l.windows).map((l) => ({ at: new Date(l.mtime).toISOString(), ...l.windows }));
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) readings.push(saved);
  if (!readings.length) return null;
  const window = (key) => {
    const ws = readings.map((r) => r[key] && win(r[key].used_percentage, r[key].resets_at)).filter((w) => w?.used_percentage != null);
    const current = Math.max(...ws.map((w) => (w.resets_at ? Date.parse(w.resets_at) : -Infinity)));
    const same = ws.filter((w) => (w.resets_at ? Math.abs(Date.parse(w.resets_at) - current) <= SAME_WINDOW_S * 1000 : current === -Infinity));
    return same.reduce((best, w) => (!best || w.used_percentage > best.used_percentage ? w : best), null);
  };
  const ats = readings.map((r) => isoOf(r.at)).filter(Boolean).sort();
  return { at: ats.at(-1) ?? null, five_hour: window('five_hour'), seven_day: window('seven_day') };
}

function newestRollouts(sessions) {
  const files = [];
  const kids = (d) => { try { return fs.readdirSync(d).sort().reverse(); } catch { return []; } };
  outer: for (const y of kids(sessions)) for (const m of kids(path.join(sessions, y))) for (const d of kids(path.join(sessions, y, m))) {
    const dir = path.join(sessions, y, m, d);
    for (const f of kids(dir)) {
      if (!/^rollout-.*\.jsonl$/.test(f)) continue;
      try { files.push({ file: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtimeMs }); } catch {}
    }
    if (files.length >= CODEX_FILES * 2) break outer;
  }
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, CODEX_FILES);
}

// Parallel sessions report the same window a few points apart: keep the highest reading for the newest window.
function scanCodex(sessions) {
  const readings = [];
  for (const { file, mtime } of newestRollouts(sessions)) {
    const r = lastRateLimits(file);
    if (r) readings.push({ ...r, mtime, resets: num(r.rl.primary.resets_at) });
  }
  if (!readings.length) return null;
  const current = Math.max(...readings.map((r) => r.resets ?? -Infinity));
  const same = readings.filter((r) => r.resets != null && Math.abs(r.resets - current) <= SAME_WINDOW_S);
  const pick = (key) => same.reduce((best, r) => (num(r.rl[key]?.used_percent) ?? -1) > (num(best?.rl[key]?.used_percent) ?? -1) ? r : best, null);
  if (!same.length) return null;
  const p = pick('primary');
  const s = pick('secondary');
  const newest = same.reduce((a, b) => (b.mtime > a.mtime ? b : a));
  const w = (r, key) => (r ? win(r.rl[key].used_percent, r.rl[key].resets_at) : null);
  return { five_hour: w(p, 'primary'), seven_day: w(s, 'secondary'), at: new Date(newest.mtime).toISOString() };
}

// The colour a usage bar draws: stale readings grey, else ok under 75%, high from 75%, full from 90%.
export const toneOf =(state, used) => (state === 'stale' ? 'stale' : used >= 90 ? 'full' : used >= 75 ? 'high' : 'ok');

function readingOf(reading, now) {
  if (!reading || typeof reading !== 'object' || Array.isArray(reading)) return null;
  const at = isoOf(reading.at);
  const window = (key) => {
    const raw = reading[key];
    if (!raw) return null;
    const w = win(raw.used_percentage, raw.resets_at);
    if (w.used_percentage == null) return null;
    const state = !at || now - Date.parse(at) > WINDOW_MS[key] ? 'stale'
      : w.resets_at && now >= Date.parse(w.resets_at) ? 'reset' : 'live';
    const used_percentage = state === 'reset' ? 0 : w.used_percentage;
    return { ...w, used_percentage, state, tone: toneOf(state, used_percentage) };
  };
  return { at, five_hour: window('five_hour'), seven_day: window('seven_day') };
}

// codexShare: the setting in effect (push.mjs readCodexShare), which is Off while Codex isn't usable.
// Claude's reading is the status line's usage.json and every headless run's log together.
export function usageReader({ home = os.homedir(), now = Date.now, cacheMs = 60_000 } = {}) {
  const sessions = path.join(home, '.codex', 'sessions');
  const logDir = path.join(home, '.claude', 'kickflip', 'logs');
  const seen = new Map();
  let cached = null;
  let checked = -Infinity;
  return ({ codexShare = 'off' } = {}) => {
    const time = now();
    const saved = readJson(path.join(home, '.claude', 'kickflip', 'usage.json'))?.claude;
    const logs = runLogs(logDir, seen);
    const claude = readingOf(claudeReading(saved, logs), time);
    if (codexShare === 'off') return { claude, codex: null };
    if (time - checked >= cacheMs) {
      cached = scanCodex(sessions);
      checked = time;
    }
    return { claude, codex: readingOf(cached || { at: null }, time) };
  };
}

// A board session at or over this context percent that isn't listening has filled its context: its turns fail until it
// compacts (docs/adr/2026-11-03-1823-a-board-session-compacts-before-its-context-fills.md). listen is boards.mjs listenState, reading
// contextReading's.
export const CONTEXT_FULL = 95;
export const contextFull = (listen, reading) => listen === 'deaf' && reading?.percent >= CONTEXT_FULL;

// The context percentage bin/statusline.mjs last saved for a session, {percent, at}, or null.
export function contextReading(session, { home = os.homedir() } = {}) {
  if (typeof session !== 'string' || !/^[\w-]+$/.test(session)) return null;
  const saved = readJson(path.join(home, '.claude', 'kickflip', 'context', `${session}.json`));
  return num(saved?.percent) == null || !saved.at ? null : { percent: num(saved.percent), at: saved.at };
}

// docs/adr/2026-11-05-0913-the-hub-and-each-board-keep-an-audit-log-of-the-calls-their-code-makes.md: a pause that
// starts, and one that lifts and wakes the boards, go in the hub's audit log with the gate they read.
export async function checkUsagePause({ gate, home = os.homedir(), resume }) {
  const file = path.join(home, '.claude', 'kickflip', 'usage-gate-state.json');
  const previous = readJson(file);
  // Pause hub (docs/adr/2026-11-05-1849-pause-board-and-pause-hub-pause-new-work-by-hand.md) is a pause like the line's, its window 'manual'.
  if (gate.state === 'paused' && previous?.state !== 'paused') {
    const reason = gate.manual ? `The owner paused the hub ${gate.resets_at === FOREVER ? 'until they resume it' : `until ${gate.resets_at}`}.` : `Claude's ${gate.window === 'five_hour' ? '5-hour' : 'weekly'} usage reached the ${gate.pause_at}% line.`;
    audit(hubAudit(home), { call: 'usage-pause', result: 'paused', reason, inputs: { gate, previous: previous?.state ?? null } });
  }
  if (previous?.state === 'paused' && gate.state === 'normal') {
    const reason = previous.manual ? "The owner's pause of the hub ended, so every board was told." : `Claude's ${previous.window === 'five_hour' ? '5-hour' : 'weekly'} usage is under the line again, so every board was told.`;
    audit(hubAudit(home), { call: 'usage-resume', result: 'resumed', reason, inputs: { gate, previous: previous.manual ? 'manual' : previous.window } });
    await resume(previous.manual ? 'manual' : previous.window);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(gate) + '\n');
  fs.renameSync(tmp, file);
}
