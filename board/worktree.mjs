// A builder's git worktree for a site or skill card (docs/adr/0064-every-builder-works-in-a-worktree.md):
// `board.mjs builder start --worktree` makes it, and `board.mjs land` brings its branch into the live repo's main.
// Paths resolve under $HOME, so a scratch HOME and repo stand in for the real ones. Refusals are one-line BoardErrors.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BoardError } from './store.mjs';
import { hubCode, listBoards } from '../hub/boards.mjs';

const WEB_TS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'web-ts.mjs');
export const skillRepo = () => path.join(os.homedir(), '.claude', 'skills', 'join-web-ts');
export const worktreesDir = () => path.join(os.homedir(), '.claude', 'web-ts', 'worktrees');
const fail = (msg) => { throw new BoardError(msg); };

function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || r.error?.message || '').trim().split('\n')[0] };
}
const short = (repo, ref) => git(repo, 'rev-parse', '--short', ref).out;

// → {path, branch, repo}: a new branch <id> from the repo's main, checked out at ~/.claude/web-ts/worktrees/<id>.
export function makeWorktree(id, { repo = skillRepo() } = {}) {
  const root = path.resolve(repo);
  if (!git(root, 'rev-parse', '--git-dir').ok) fail(`--repo ${root} is not a git repo`);
  if (!git(root, 'check-ref-format', '--branch', id).ok) fail(`--worktree: "${id}" can't be a branch name`);
  if (!git(root, 'rev-parse', '--verify', '--quiet', 'refs/heads/main').ok) fail(`--worktree: ${root} has no main branch`);
  const dir = path.join(worktreesDir(), id);
  if (fs.existsSync(dir)) fail(`--worktree: ${dir} already exists; land or remove it first`);
  if (git(root, 'rev-parse', '--verify', '--quiet', `refs/heads/${id}`).ok) fail(`--worktree: branch ${id} already exists in ${root}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const r = git(root, 'worktree', 'add', '--quiet', '-b', id, dir, 'main');
  if (!r.ok) fail(`--worktree: git worktree add failed: ${r.err}`);
  return { path: dir, branch: id, repo: root };
}

function testFiles(dir) {
  const found = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.endsWith('.test.mjs')) found.push(path.join(d, e.name));
    }
  };
  walk(dir);
  return found.sort();
}

// The full suite of the worktree. NODE_TEST_CONTEXT is dropped, since a run started from inside a test would
// otherwise report to that test's runner instead of exiting with its own result. → {ok, pass, fail}
export function nodeTests(dir) {
  const files = testFiles(dir);
  if (!files.length) return { ok: true, pass: 0, fail: 0 };
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: dir, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const count = (name) => Number((r.stdout || '').match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1] ?? 0);
  return { ok: r.status === 0, pass: count('pass'), fail: count('fail') };
}

// Restarts the hub ('hub') or one board server ('board', route). WEB_TS_RESTART_CMD='["<cmd>", …]' replaces both,
// with what to restart appended, so a test never reaches launchd or a real board.
export function restartRunner(what, route) {
  let cmd;
  if (process.env.WEB_TS_RESTART_CMD) {
    try { cmd = JSON.parse(process.env.WEB_TS_RESTART_CMD); } catch {}
    if (!Array.isArray(cmd) || !cmd.length || !cmd.every((a) => typeof a === 'string')) fail('WEB_TS_RESTART_CMD must be a JSON array of strings');
    cmd = [...cmd, what, ...(route ? [route] : [])];
  } else {
    cmd = what === 'hub' ? ['launchctl', 'kickstart', '-k', `gui/${process.getuid()}/local.claude.web-ts-hub`] : [process.execPath, WEB_TS, 'restart', route];
  }
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8' });
  return r.status === 0 ? null : (r.stderr || r.error?.message || `exit ${r.status}`).trim().split('\n')[0];
}

// Brings a checked worktree's branch into the live repo's main, saying each step: refuses while the worktree has
// uncommitted changes or the branch adds nothing; rebases it onto main when main moved, refusing on a conflict with
// the rebase undone; runs the worktree's full suite; fast-forwards main; restarts the hub when its code changed,
// else the board servers when board/ changed (a hub restart restarts every site); removes the worktree and branch.
// Never pushes. A restart that fails is reported after the rest is done.
export function land({ path: dir, branch, repo }, { say = console.log, runTests = nodeTests, restart = restartRunner, boards = () => listBoards() } = {}) {
  if (!fs.existsSync(dir)) fail(`no worktree at ${dir}`);
  const head = git(repo, 'symbolic-ref', '--quiet', '--short', 'HEAD').out;
  if (head !== 'main') fail(`${repo} is on ${head || 'a detached HEAD'}, not main; land fast-forwards main there`);
  if (git(dir, 'status', '--porcelain').out) fail(`${dir} has uncommitted changes; commit them there first`);
  if (Number(git(repo, 'rev-list', '--count', `main..${branch}`).out) === 0) fail(`${branch} has no commits beyond main; nothing to land`);

  if (!git(repo, 'merge-base', '--is-ancestor', 'main', branch).ok) {
    if (!git(dir, 'rebase', '--quiet', 'main').ok) {
      const conflicted = git(dir, 'diff', '--name-only', '--diff-filter=U').out.split('\n').filter(Boolean);
      git(dir, 'rebase', '--abort');
      fail(`rebasing ${branch} onto main conflicts in ${conflicted.join(', ') || 'files git did not name'}; resolve it in ${dir} and land again`);
    }
    say(`rebased ${branch} onto main (${short(repo, 'main')})`);
  }

  const tests = runTests(dir);
  if (!tests.ok) fail(`tests failed in ${dir} (${tests.fail} failing); nothing landed`);
  say(`tests passed: ${tests.pass}`);

  const changed = git(repo, 'diff', '--name-only', 'main', branch).out.split('\n').filter(Boolean);
  const merged = git(repo, 'merge', '--quiet', '--ff-only', branch);
  if (!merged.ok) fail(`could not fast-forward main in ${repo}: ${merged.err}`);
  say(`main fast-forwarded to ${short(repo, 'main')} in ${repo}`);

  const failed = [];
  const hubFiles = new Set(hubCode(path.join(repo, 'hub', 'hub.mjs')).files);
  if (changed.some((f) => f.startsWith('hub/') || hubFiles.has(f))) {
    const err = restart('hub');
    if (err) failed.push(`the hub didn't restart (${err})`); else say('hub restarted, with every site');
  } else if (changed.some((f) => f.startsWith('board/'))) {
    for (const b of boards()) {
      const err = restart('board', b.route);
      if (err) failed.push(`/${b.route} didn't restart (${err})`); else say(`board restarted: ${b.route}`);
    }
  }

  const removed = git(repo, 'worktree', 'remove', dir);
  if (removed.ok) say(`worktree removed: ${dir}`); else failed.push(`could not remove ${dir} (${removed.err})`);
  const deleted = git(repo, 'branch', '--quiet', '-d', branch);
  if (deleted.ok) say(`branch deleted: ${branch}`); else failed.push(`could not delete branch ${branch} (${deleted.err})`);
  if (failed.length) fail(`landed, but ${failed.join('; ')}`);
}
