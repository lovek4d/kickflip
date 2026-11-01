#!/usr/bin/env node
// Claude Code calls this on every redraw. Print first; usage must never hold up the line.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

process.stdout.on('error', () => {});

function branchOf(cwd) {
  if (!cwd) return '';
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 500,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  }).trim();
  try {
    if (git('rev-parse', '--is-inside-work-tree') !== 'true') return '';
    const branch = git('symbolic-ref', '--short', 'HEAD');
    try { git('diff', '--quiet'); git('diff', '--cached', '--quiet'); }
    catch { return branch + '*'; }
    return branch;
  } catch { return ''; }
}

function shortDir(cwd) {
  if (!cwd) return '';
  const home = os.homedir();
  const dir = cwd === home ? '~' : cwd.startsWith(home + '/') ? '~' + cwd.slice(home.length) : cwd;
  const parts = dir.split('/');
  return parts.length > 2 ? parts.slice(-2).join('/') : dir;
}

function isoOf(value) {
  if (value == null || value === '') return null;
  const numeric = typeof value === 'number' || /^\d+(\.\d+)?$/.test(String(value));
  const n = Number(value);
  const ms = numeric ? (n > 1e12 ? n : n * 1000) : Date.parse(String(value));
  return Number.isFinite(ms) && Number.isFinite(new Date(ms).getTime()) ? new Date(ms).toISOString() : null;
}

function windowOf(window) {
  if (!window || typeof window !== 'object') return null;
  const value = window.used_percentage;
  return {
    used_percentage: value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value),
    resets_at: isoOf(window.resets_at),
    resets_at_raw: window.resets_at ?? null,
  };
}

function saveUsage(input) {
  const limits = input.rate_limits;
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) return;
  const file = path.join(os.homedir(), '.claude', 'web-ts', 'usage.json');
  let previous = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) previous = parsed;
  } catch {}
  const claude = {
    five_hour: windowOf(limits.five_hour),
    seven_day: windowOf(limits.seven_day),
    at: new Date().toISOString(),
    ...(input.session_id ? { session: input.session_id } : {}),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ ...previous, claude }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const cwd = typeof input.cwd === 'string' ? input.cwd : '';
    const model = typeof input.model?.display_name === 'string' ? input.model.display_name : '';
    const percent = (value) => (value == null || value === '' || !Number.isFinite(Number(value)) ? null : Math.floor(Number(value)));
    const ctx = percent(input.context_window?.used_percentage);
    const usage = [['5h', input.rate_limits?.five_hour], ['7d', input.rate_limits?.seven_day]]
      .map(([name, window]) => [name, percent(window?.used_percentage)])
      .filter(([, value]) => value != null).map(([name, value]) => `${name} ${value}%`).join(' · ');
    const line = [shortDir(cwd), branchOf(cwd), model, ctx == null ? '' : `${ctx}% ctx`, usage].filter(Boolean).join('  ');
    // Wait for stdout to flush before doing filesystem work; errors stay off both streams.
    process.stdout.write(line + '\n', () => { try { saveUsage(input); } catch {} });
  }
} catch { /* Invalid input and every other error leave the status line alone. */ }
process.exitCode = 0;
