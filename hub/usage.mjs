import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CODEX_FILES = 6;
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

function lastRateLimits(file) {
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
        if (!lines[i].includes('rate_limits')) continue;
        try {
          const o = JSON.parse(lines[i]);
          const rl = o?.payload?.rate_limits ?? o?.rate_limits;
          if (rl?.primary) return { rl };
        } catch { /* a cut or odd line */ }
      }
      if (start === 0) break;
    }
  } catch { /* unreadable */ } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  return null;
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
    return { ...w, used_percentage: state === 'reset' ? 0 : w.used_percentage, state };
  };
  return { at, five_hour: window('five_hour'), seven_day: window('seven_day') };
}

export function usageReader({ home = os.homedir(), now = Date.now, cacheMs = 60_000 } = {}) {
  const sessions = path.join(home, '.codex', 'sessions');
  let cached = null;
  let checked = -Infinity;
  return ({ codexShare = 'off' } = {}) => {
    const time = now();
    const claude = readingOf(readJson(path.join(home, '.claude', 'web-ts', 'usage.json'))?.claude, time);
    if (codexShare === 'off' || !fs.existsSync(path.join(home, '.codex', 'auth.json'))) return { claude, codex: null };
    if (time - checked >= cacheMs) {
      cached = scanCodex(sessions);
      checked = time;
    }
    return { claude, codex: readingOf(cached || { at: null }, time) };
  };
}
