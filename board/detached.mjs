// docs/adr/2026-11-16-1915-the-hub-status-opens-the-load-sheet-at-any-load-collapsed.md
// The processes a build left running detached, which builder done refuses to finish over (store.mjs refuseDetached):
// this user's, left to launchd (parent pid 1), started since the build began, working in its worktree (their working
// directory, or a path on their command line, inside it), and not git's or the calling command's own ancestors (a
// resumed builder's session is left to launchd and works in its worktree, yet is the one finishing).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ps as runPs } from '../hub/live.mjs';
import { etimeSeconds } from '../hub/machine-load.mjs';

const realpath = (dir) => { try { return fs.realpathSync(dir); } catch { return dir; } };

// pids → lsof's -Fpn output naming each one's working directory. lsof exits 1 when it can't read some process, so its
// output is read either way.
function lsofCwds(pids) {
  try { return execFileSync('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')], { encoding: 'utf8', timeout: 5000 }); }
  catch (e) { return e.stdout || ''; }
}

// dir: the build's worktree; since: when the build began (ms). → [{pid, command}], by pid; none when ps gave no answer
// in time, so a busy host never holds a finish.
export function detachedIn(dir, since, { ps = () => runPs(['-axo', 'pid=,ppid=,uid=,etime=,command=']), cwds = lsofCwds, uid = process.getuid(), now = Date.now(), pid: self = process.pid } = {}) {
  const text = ps();
  if (text === null) return [];
  const parent = new Map();
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s/);
    if (m) parent.set(Number(m[1]), Number(m[2]));
  }
  const ancestors = new Set();
  for (let p = parent.get(self); p && !ancestors.has(p); p = parent.get(p)) ancestors.add(p);
  const candidates = text.split('\n').flatMap((line) => {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    // git detaches its own auto gc and maintenance, which end by themselves.
    if (!m || Number(m[2]) !== 1 || Number(m[3]) !== uid || path.basename(m[5].split(/\s/)[0]) === 'git' || ancestors.has(Number(m[1]))) return [];
    // ps's elapsed time counts whole seconds, so a process started in the build's first second still counts.
    return now - etimeSeconds(m[4]) * 1000 >= since - 1000 ? [{ pid: Number(m[1]), command: m[5] }] : [];
  });
  if (!candidates.length) return [];
  const cwd = new Map();
  let pid;
  for (const line of cwds(candidates.map((p) => p.pid)).split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n') cwd.set(pid, line.slice(1));
  }
  // lsof names a working directory by its real path (/private/var on a Mac for /var).
  const dirs = [...new Set([dir, realpath(dir)])];
  const inside = (value) => dirs.some((d) => value === d || value.startsWith(d + path.sep));
  return candidates.filter((p) => inside(cwd.get(p.pid) ?? '') || dirs.some((d) => p.command.includes(d + path.sep) || p.command.endsWith(d)))
    .sort((a, b) => a.pid - b.pid);
}
