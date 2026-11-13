#!/usr/bin/env node
// Claude Code calls this on every redraw. Print first; usage must never hold up the line.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Each git call has 500 ms, so a slow repo drops the branch rather than hold up the redraw
// (docs/adr/2026-11-13-2234-a-limit-a-person-sees-stays-and-its-test-passes-the-runner.md). → stdout; throws when git fails
const timedGit = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 500,
  env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
});

function branchOf(cwd, run) {
  if (!cwd) return '';
  const git = (...args) => run(cwd, args).trim();
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
  const file = path.join(os.homedir(), '.claude', 'kickflip', 'usage.json');
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

// One file per session, so parallel sessions never overwrite each other's reading.
function saveContext(input, percent) {
  const session = input.session_id;
  if (percent == null || typeof session !== 'string' || !/^[\w-]+$/.test(session)) return;
  const dir = path.join(os.homedir(), '.claude', 'kickflip', 'context');
  const file = path.join(dir, `${session}.json`);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ percent, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

const percent = (value) => (value == null || value === '' || !Number.isFinite(Number(value)) ? null : Math.floor(Number(value)));

// The line for Claude Code's input: directory and branch, model and context, usage. git(cwd, args) runs one git command.
export function statusLine(input, { git = timedGit } = {}) {
  const cwd = typeof input.cwd === 'string' ? input.cwd : '';
  const model = typeof input.model?.display_name === 'string' ? input.model.display_name : '';
  const ctx = percent(input.context_window?.used_percentage);
  const usage = [['5h', input.rate_limits?.five_hour], ['7d', input.rate_limits?.seven_day]]
    .map(([name, window]) => [name, percent(window?.used_percentage)])
    .filter(([, value]) => value != null).map(([name, value]) => `${name}: ${value}%`).join(' / ');
  const join = (parts, separator) => parts.filter(Boolean).join(separator);
  return join([
    join([shortDir(cwd), branchOf(cwd, git)], ' '),
    join([model, ctx == null ? '' : `${ctx}% ctx`], ' / '),
    usage,
  ], ' · ');
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.on('error', () => {});
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      // Wait for stdout to flush before doing filesystem work; errors stay off both streams.
      process.stdout.write(statusLine(input) + '\n', () => {
        try { saveUsage(input); } catch {}
        try { saveContext(input, percent(input.context_window?.used_percentage)); } catch {}
      });
    }
  } catch { /* Invalid input and every other error leave the status line alone. */ }
  process.exitCode = 0;
}
