// docs/adr/2026-11-18-0400-builds-run-at-background-priority.md
// The one seam every process the board starts for building goes through: builders, landers and planners
// (agents.mjs launchAgent), a land's test run (worktree.mjs nodeTests), render checks (render-check.mjs) and try serves
// (hub/try.mjs). Each wrapper execs the command, so the process keeps the pid and process group spawn gives it.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// → the executable file command names, a path or a name looked up on PATH, or null when there is none
export function onPath(command, PATH = process.env.PATH || '') {
  const runnable = (file) => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } };
  if (command.includes('/')) return runnable(command) ? command : null;
  for (const dir of PATH.split(':').filter(Boolean)) {
    const file = path.join(dir, command);
    if (runnable(file)) return file;
  }
  return null;
}

// Whether this process can start a systemd user scope: a scope running `true` exits 0, which needs systemd-run and a
// user manager to reach. Asked once per process. → boolean
let scopes;
export function userScopes() {
  scopes ??= spawnSync('systemd-run', ['--user', '--scope', '-q', 'true'], { stdio: 'ignore', timeout: 3000 }).status === 0;
  return scopes;
}

// argv wrapped to run at background priority on platform: macOS's background QoS (efficiency cores, throttled disk),
// a systemd user scope at a fifth of the default CPU and IO weight where one starts (scopes), else nice 19.
// → the argv to spawn
export function backgroundArgv(argv, { platform = process.platform, scopes = userScopes } = {}) {
  if (platform === 'darwin') return ['taskpolicy', '-b', ...argv];
  if (platform === 'linux' && scopes()) return ['systemd-run', '--user', '--scope', '-q', '-p', 'CPUWeight=20', '-p', 'IOWeight=20', ...argv];
  return ['nice', '-n', '19', ...argv];
}
