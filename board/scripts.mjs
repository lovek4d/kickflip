// A script the orchestrator offers in a thread and the owner runs with a held Run
// (docs/adr/2026-11-14-2359-the-orchestrator-offers-a-script-and-the-owner-holds-run.md): its hash, which a run names so
// a page drawn from other text can't run it, and the run itself.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The longest script an offer takes; the owner reads every line of it before Run.
export const SCRIPT_LIMIT = 64 * 1024;
// The most output a run keeps for its result, its tail; the whole of it goes in the run's log.
export const OUTPUT_CAP = 64 * 1024;
// How long a run may take before it is killed.
export const SCRIPT_TIMEOUT = 10 * 60000;

export const scriptSha = (body) => createHash('sha256').update(body).digest('hex');
// The run's log in ~/.claude/kickflip/logs, which GET /api/log and log.html read by name.
export const scriptLogName = (id) => `script-${id}.log`;
export const logsDir = () => path.join(os.homedir(), '.claude', 'kickflip', 'logs');
// Where the offer says it runs: the host's name without .local, and the user.
export const runsAs = () => ({ host: os.hostname().replace(/\.local$/, ''), user: os.userInfo().username });

// Runs body with sh in cwd, its stdout and stderr together into the file log as they come and their last cap bytes kept,
// killed with its process group past timeoutMs. → {exit, timedOut, output, ms}; exit is the shell's code, or 128 plus
// the signal's number for a killed run.
export function runScript({ body, cwd, log, timeoutMs = SCRIPT_TIMEOUT, cap = OUTPUT_CAP }) {
  return new Promise((resolve) => {
    const started = Date.now();
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const out = fs.createWriteStream(log);
    let kept = Buffer.alloc(0);
    let timedOut = false;
    const keep = (chunk) => {
      out.write(chunk);
      kept = Buffer.concat([kept, chunk]);
      if (kept.length > cap) kept = kept.subarray(kept.length - cap);
    };
    const finish = (exit) => out.end(() => resolve({ exit, timedOut, output: kept.toString('utf8'), ms: Date.now() - started }));
    const child = spawn('/bin/sh', ['-c', body], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); keep(Buffer.from(`${e.message}\n`)); finish(127); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) out.write(`\nStopped after ${Math.round(timeoutMs / 1000)} s.\n`);
      finish(code ?? 128 + (os.constants.signals[signal] || 0));
    });
  });
}
