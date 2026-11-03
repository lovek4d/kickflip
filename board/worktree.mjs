// A builder's git worktree for a site or skill card (docs/adr/0064-every-builder-works-in-a-worktree.md):
// `board.mjs builder start --worktree` and the board server's Build tap make it, and `board.mjs land` brings its branch into the live repo's main.
// Worktrees resolve under $HOME and the repo defaults to the running clone, so a scratch HOME and --repo stand in for
// the real ones.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BoardError } from './store.mjs';
import { boardAt, hubCode, listBoards, readManifest } from '../hub/boards.mjs';
import { boardRepo } from '../hub/board-repo.mjs';
import { cloneRoot } from '../shared/repos.mjs';
import { storedPath } from '../bin/install.mjs';
import { hubService } from '../shared/service.mjs';

const KICKFLIP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kickflip.mjs');
export const skillRepo = cloneRoot;
export const worktreesDir = () => path.join(os.homedir(), '.claude', 'kickflip', 'worktrees');
const fail = (msg) => { throw new BoardError(msg); };

function git(cwd, ...args) {
  // core.commentChar=';' keeps a "#N: ..." subject: git's default cleanup strips lines starting with # when it rewrites a message.
  const r = spawnSync('git', ['-C', cwd, '-c', 'core.commentChar=;', ...args], { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || r.error?.message || '').trim().split('\n')[0] };
}
const short = (repo, ref) => git(repo, 'rev-parse', '--short', ref).out;

// → {path, branch, repo}: a builder branch from base, checked out outside the shared clone.
export function makeWorktree(id, { repo = skillRepo(), base = 'main', remote = false } = {}) {
  const root = path.resolve(repo);
  if (!git(root, 'rev-parse', '--git-dir').ok) fail(`--repo ${root} is not a git repo`);
  if (!git(root, 'check-ref-format', '--branch', id).ok) fail(`--worktree: "${id}" can't be a branch name`);
  if (!git(root, 'check-ref-format', '--branch', base).ok) fail('--worktree: invalid base branch');
  const ref = remote ? `refs/remotes/origin/${base}` : `refs/heads/${base}`;
  // The shared clone is fetched only when a board picks it; offline, the last fetched tip still serves.
  if (remote) git(root, 'fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${base}:${ref}`);
  if (!git(root, 'rev-parse', '--verify', '--quiet', ref).ok) fail(`--worktree: ${root} has no ${base} branch`);
  const dir = path.join(worktreesDir(), id);
  if (fs.existsSync(dir)) fail(`--worktree: ${dir} already exists; land or remove it first`);
  if (git(root, 'rev-parse', '--verify', '--quiet', `refs/heads/${id}`).ok) fail(`--worktree: branch ${id} already exists in ${root}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const r = git(root, 'worktree', 'add', '--quiet', '-b', id, dir, ref);
  if (!r.ok) fail(`--worktree: git worktree add failed: ${r.err}`);
  return { path: storedPath(dir), branch: id, repo: storedPath(root) };
}

// Where the board at site's builders branch from and land (hub/board-repo.mjs boardRepo): a board on GitHub or a plain
// git remote from its branch of its shared clone, fetched first; a local board, the hub board included, from its repo's
// local main. With no site, or a site that isn't a board, the running kickflip clone's main. repo stands in for the
// board's folder. → {repo, base, remote}
export function builderRepo(site, { repo, manifest = readManifest() } = {}) {
  const board = site ? boardAt(site, manifest) : null;
  if (!board) return { repo: repo ?? skillRepo(), base: 'main', remote: false };
  const chosen = boardRepo(board.route, manifest);
  const folder = repo ?? (chosen.repo || fail(`/${board.route} has no folder recorded for its session; rejoin it from its repo folder`));
  return chosen.local ? { repo: folder, base: 'main', remote: false } : { repo: folder, base: chosen.branch || 'main', remote: true };
}

// The worktree of card id on the board at site, from builderRepo. → as makeWorktree
export const boardWorktree = (site, id, { repo } = {}) => makeWorktree(id, builderRepo(site, { repo }));

function testFiles(dir) {
  const found = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === '.repos' || e.name === 'node_modules') continue;
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.endsWith('.test.mjs')) found.push(path.join(d, e.name));
    }
  };
  walk(dir);
  return found.sort();
}

// The full suite of the worktree. NODE_TEST_CONTEXT is dropped, since a run started from inside a test would
// otherwise report to that test's runner instead of exiting with its own result.
export function nodeTests(dir) {
  const files = testFiles(dir);
  if (!files.length) return { ok: true, pass: 0, fail: 0 };
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: dir, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const count = (name) => Number((r.stdout || '').match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1] ?? 0);
  const result = { ok: r.status === 0, pass: count('pass'), fail: count('fail') };
  if (!result.ok) {
    const output = (r.stdout || '') + (r.stderr || '') + (r.error ? `\n${r.error.message}\n` : '');
    const logs = path.join(os.homedir(), '.claude', 'kickflip', 'logs');
    try {
      fs.mkdirSync(logs, { recursive: true });
      const log = path.join(logs, `land-${randomUUID()}.tap`);
      fs.writeFileSync(log, output, { mode: 0o600 });
      result.log = log;
    } catch (e) { result.logError = `Could not save the full test output: ${e.message}`; }
    result.failures = tapFailures(r.stdout || '');
    const stderr = (r.stderr || '').trim().split('\n')[0];
    result.error = r.error?.message || `${r.signal ? `test runner killed by ${r.signal}` : `test runner exited ${r.status}`}${stderr ? `: ${stderr}` : ''}`;
  }
  return result;
}

function tapFailures(tap) {
  const lines = tap.split('\n');
  const parents = [];
  const failures = [];
  const scalar = (s) => s.startsWith("'") ? s.slice(1, -1).replaceAll("''", "'") : s.startsWith('"') ? JSON.parse(s) : s;
  for (let i = 0; i < lines.length; i++) {
    const subtest = /^(\s*)# Subtest: (.*)$/.exec(lines[i]);
    if (subtest) {
      const indent = subtest[1].length;
      while (parents.length && parents.at(-1).indent >= indent) parents.pop();
      parents.push({ indent, name: subtest[2] });
    }
    const failed = /^(\s*)not ok \d+ - (.*)$/.exec(lines[i]);
    if (!failed || / # (?:TODO|SKIP)\b/i.test(failed[2])) continue;
    const indent = failed[1].length;
    const name = [...parents.filter((p) => p.indent < indent).map((p) => p.name), failed[2]].join(' > ');
    const diagnostic = [];
    for (let j = i + 1; j < lines.length && lines[j].startsWith(' '.repeat(indent + 2)); j++) diagnostic.push(lines[j]);
    const field = (key) => diagnostic.find((line) => line.startsWith(`${' '.repeat(indent + 2)}${key}: `))?.slice(indent + key.length + 4);
    const location = field('location');
    const error = field('error');
    let excerpt = [];
    if (error && /^[|>]/.test(error)) {
      const start = diagnostic.findIndex((line) => line.startsWith(`${' '.repeat(indent + 2)}error: `)) + 1;
      for (let j = start; j < diagnostic.length && diagnostic[j].startsWith(' '.repeat(indent + 4)); j++) excerpt.push(diagnostic[j].slice(indent + 4));
    } else if (error) excerpt = scalar(error).split('\n');
    if (excerpt[0] === 'test failed') {
      const output = [];
      let j = i - 1;
      if (lines[j]?.startsWith('# Subtest: ')) j--;
      for (; j >= 0 && lines[j].startsWith('# ') && !lines[j].startsWith('# Subtest: '); j--) output.unshift(lines[j].slice(2));
      const start = output.findIndex((line) => /^\w*Error(?: \[[^\]]+\])?:/.test(line));
      if (start >= 0) excerpt = output.slice(start);
    }
    failures.push(`${name}\n  ${location ? scalar(location) : 'file not reported by test runner'}${excerpt.length ? '\n' + excerpt.slice(0, 3).map((line) => `  ${line}`).join('\n') : ''}`);
  }
  return failures;
}

// Restarts the hub ('hub') through its service (../shared/service.mjs) or one board server ('board', route).
// KICKFLIP_RESTART_CMD='["<cmd>", …]' replaces both, with what to restart appended, so a test never reaches the
// host's service manager or a real board.
export function restartRunner(what, route) {
  let cmd;
  if (process.env.KICKFLIP_RESTART_CMD) {
    try { cmd = JSON.parse(process.env.KICKFLIP_RESTART_CMD); } catch {}
    if (!Array.isArray(cmd) || !cmd.length || !cmd.every((a) => typeof a === 'string')) fail('KICKFLIP_RESTART_CMD must be a JSON array of strings');
    cmd = [...cmd, what, ...(route ? [route] : [])];
  } else if (what === 'hub') {
    return hubService().restart();
  } else {
    cmd = [process.execPath, KICKFLIP, 'restart', route];
  }
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8' });
  return r.status === 0 ? null : (r.stderr || r.error?.message || `exit ${r.status}`).trim().split('\n')[0];
}

// Brings a checked worktree's branch into the live repo's main, saying each step: refuses while the worktree has
// uncommitted changes or the branch adds nothing; rebases it onto main when main moved, refusing on a conflict with
// the rebase undone; runs the worktree's full suite; fast-forwards main; when repo is the running kickflip clone,
// restarts the hub when its code changed, else the board servers when board/ changed (a hub restart restarts every
// site), test files aside; removes the worktree and branch.
// Never pushes. A restart that fails is reported after the rest is done.
// One land at a time on the host, since a land can restart the hub and every board server: ~/.claude/kickflip/land.lock
// {card, pid, at} names the card landing. A lock whose process is gone is taken over.
const landLock = () => path.join(os.homedir(), '.claude', 'kickflip', 'land.lock');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
export async function holdingLandLock(card, fn) {
  const file = landLock();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (;;) {
    try { fs.writeFileSync(file, JSON.stringify({ card, pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' }); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let held = null;
      try { held = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      if (Number.isInteger(held?.pid) && alive(held.pid)) fail(`${held.card} is landing (since ${held.at}); land again once it finishes`);
      fs.rmSync(file, { force: true });
    }
  }
  try { return await fn(); } finally {
    try { if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.rmSync(file, { force: true }); } catch {}
  }
}

// Two ADRs sharing a 4-digit prefix mean two builders took the same next number.
function refuseDuplicateAdr(dir) {
  const adrDir = path.join(dir, 'docs', 'adr');
  if (!fs.existsSync(adrDir)) return;
  const byNumber = new Map();
  for (const file of fs.readdirSync(adrDir).sort()) {
    const number = file.match(/^(\d{4})-/)?.[1];
    if (number) byNumber.set(number, [...(byNumber.get(number) || []), file]);
  }
  const duplicate = [...byNumber].find(([, files]) => files.length > 1);
  if (!duplicate) return;
  const [number, files] = duplicate;
  const next = String(Math.max(...byNumber.keys().map(Number)) + 1).padStart(4, '0');
  fail(`land: docs/adr has two ADRs numbered ${number} (${files.join(', ')}); renumber yours to ${next} and land again`);
}

export function land({ path: dir, branch, repo }, { say = console.log, runTests = nodeTests, restart = restartRunner, boards = () => listBoards(), clone = skillRepo() } = {}) {
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

  const blank = git(repo, 'log', '--format=%h %s', `main..${branch}`).out.split('\n').filter((l) => l && !l.includes(' '));
  if (blank.length) fail(`${branch} has a commit with an empty subject (${blank[0]}); reword it in ${dir} and land again`);

  refuseDuplicateAdr(dir);

  const tests = runTests(dir);
  if (!tests.ok) fail([
    `tests failed in ${dir} (${tests.fail} failing); nothing landed`,
    ...(tests.failures?.length ? tests.failures : [tests.error || 'test runner failed without test diagnostics']),
    ...(tests.log ? [`Full test output: ${tests.log}`] : tests.logError ? [tests.logError] : []),
  ].join('\n'));
  say(`tests passed: ${tests.pass}`);

  const changed = git(repo, 'diff', '--name-only', 'main', branch).out.split('\n').filter(Boolean);
  const merged = git(repo, 'merge', '--quiet', '--ff-only', branch);
  if (!merged.ok) fail(`could not fast-forward main in ${repo}: ${merged.err}`);
  say(`main fast-forwarded to ${short(repo, 'main')} in ${repo}`);

  const failed = [];
  // Only the running kickflip clone's code runs in the hub and the board servers, and no test file runs in either.
  const running = fs.realpathSync(repo) === fs.realpathSync(clone) ? changed.filter((f) => !/\.test\.mjs$/.test(f)) : [];
  const hubFiles = new Set(running.length ? hubCode(path.join(repo, 'hub', 'hub.mjs')).files : []);
  if (running.some((f) => f.startsWith('hub/') || hubFiles.has(f))) {
    const err = restart('hub');
    if (err) failed.push(`the hub didn't restart (${err})`); else say('hub restarted, with every site');
  } else if (running.some((f) => f.startsWith('board/'))) {
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
