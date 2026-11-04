// A builder's git worktree for a site or skill card (docs/adr/2026-10-30-1654-every-builder-works-in-a-worktree.md):
// A build's `board.mjs builder start` (with or without --worktree) and the board server's Build tap make it, and `board.mjs land` brings its branch into the live repo's main.
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

export function git(cwd, ...args) {
  // core.commentChar=';' keeps a "#N: ..." subject: git's default cleanup strips lines starting with # when it rewrites a message.
  const r = spawnSync('git', ['-C', cwd, '-c', 'core.commentChar=;', ...args], { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || r.error?.message || '').trim().split('\n')[0] };
}
const short = (repo, ref) => git(repo, 'rev-parse', '--short', ref).out;

// → {path, branch, repo, remade}: a builder branch from base, checked out outside the shared clone. A worktree an earlier
// build left at the path is remade when it holds no work (removeLeftover), and remade is the line saying so, else null.
export function makeWorktree(id, { repo = skillRepo(), base = 'main', remote = false, busy = [] } = {}) {
  const root = path.resolve(repo);
  if (!git(root, 'rev-parse', '--git-dir').ok) fail(`--repo ${root} is not a git repo`);
  if (!git(root, 'check-ref-format', '--branch', id).ok) fail(`--worktree: "${id}" can't be a branch name`);
  if (!git(root, 'check-ref-format', '--branch', base).ok) fail('--worktree: invalid base branch');
  const ref = remote ? `refs/remotes/origin/${base}` : `refs/heads/${base}`;
  // The shared clone is fetched only when a board picks it; offline, the last fetched tip still serves.
  if (remote) git(root, 'fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${base}:${ref}`);
  if (!git(root, 'rev-parse', '--verify', '--quiet', ref).ok) fail(`--worktree: ${root} has no ${base} branch`);
  const dir = path.join(worktreesDir(), id);
  const remade = fs.existsSync(dir) ? removeLeftover(root, dir, id, { ref, base, busy }) : null;
  if (git(root, 'rev-parse', '--verify', '--quiet', `refs/heads/${id}`).ok) fail(`--worktree: branch ${id} already exists in ${root}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const r = git(root, 'worktree', 'add', '--quiet', '-b', id, dir, ref);
  if (!r.ok) fail(`--worktree: git worktree add failed: ${r.err}`);
  return { path: storedPath(dir), branch: id, repo: storedPath(root), remade };
}

// The worktree at dir, on branch id of root, that an earlier build left: removed with its branch when it holds no commits
// beyond ref and no changes and no path in busy (the other open builder records' worktrees) names it; anything else at
// dir refuses, naming the work it holds (docs/adr/2026-11-03-1653-a-build-remakes-a-leftover-worktree-that-holds-no-work.md).
function removeLeftover(root, dir, id, { ref, base, busy }) {
  const refuse = (why) => fail(`--worktree: ${dir} ${why}; land or remove it first`);
  if (busy.includes(storedPath(dir))) refuse('already exists and another open builder record uses it');
  const real = fs.realpathSync(dir);
  const ours = git(root, 'worktree', 'list', '--porcelain').out.split('\n\n').some((entry) => {
    const lines = entry.split('\n');
    const at = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
    try { return lines.includes(`branch refs/heads/${id}`) && fs.realpathSync(at) === real; } catch { return false; }
  });
  if (!ours) refuse('already exists');
  const commits = Number(git(root, 'rev-list', '--count', `${ref}..refs/heads/${id}`).out);
  const changed = git(dir, 'status', '--porcelain').out.split('\n').filter(Boolean).length;
  const count = (n, what) => `${n} ${what}${n === 1 ? '' : 's'}`;
  const work = [...(commits ? [`${count(commits, 'commit')} beyond ${base}`] : []), ...(changed ? [count(changed, 'changed file')] : [])];
  if (work.length) refuse(`holds ${work.join(' and ')}`);
  // --force takes the ignored files (node_modules and the like) with it; status has shown nothing else is there.
  const removed = git(root, 'worktree', 'remove', '--force', dir);
  if (!removed.ok) fail(`--worktree: could not remove the leftover ${dir}: ${removed.err}`);
  const deleted = git(root, 'branch', '--quiet', '-D', id);
  if (!deleted.ok) fail(`--worktree: could not delete the leftover branch ${id}: ${deleted.err}`);
  return `Remade the leftover worktree ${storedPath(dir)} from ${base}: it held no commits or changes.`;
}

// Where the board at site's builders branch from and land (hub/board-repo.mjs boardRepo): a board on GitHub or a plain
// git remote from its branch of its shared clone, fetched first; a local board, the hub board included, from its repo's
// local copy of its recorded branch (`kickflip join` saves the folder's default branch), else main. With no site, or a
// site that isn't a board, the running kickflip clone's main. repo stands in for the board's folder. → {repo, base, remote}
export function builderRepo(site, { repo, manifest = readManifest() } = {}) {
  const board = site ? boardAt(site, manifest) : null;
  if (!board) return { repo: repo ?? skillRepo(), base: 'main', remote: false };
  const chosen = boardRepo(board.route, manifest);
  const folder = repo ?? (chosen.repo || fail(`/${board.route} has no folder recorded for its session; rejoin it from its repo folder`));
  return { repo: folder, base: chosen.branch || 'main', remote: !chosen.local };
}

// The worktree of card id on the board at site, from builderRepo. → as makeWorktree
export const boardWorktree = (site, id, { repo, busy } = {}) => makeWorktree(id, { ...builderRepo(site, { repo }), busy });

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

// Brings a checked worktree's branch into the live repo's base branch (builderRepo's base), saying each step: refuses
// unless the repo has base checked out, naming it, or while the worktree has uncommitted changes or the branch adds
// nothing; rebases it onto base when base moved, refusing on a conflict with the rebase undone; runs the worktree's
// full suite; fast-forwards base; when repo is the running kickflip clone,
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

// An ADR is named by the minute it was written, docs/adr/YYYY-MM-DD-HHMM-<slug>.md, so parallel builds never take the same name.
// A branch adding one named with a number instead (0181-<slug>.md) is refused.
function refuseNumberedAdr(repo, base, branch) {
  const added = git(repo, 'diff', '--name-only', '--no-renames', '--diff-filter=A', base, branch, '--', 'docs/adr').out.split('\n');
  const numbered = added.find((f) => /^docs\/adr\/\d{4}-(?!\d{2}-\d{2}-\d{4}-)/.test(f));
  if (numbered) fail(`land: ${numbered} is named with a number; name it docs/adr/YYYY-MM-DD-HHMM-${path.basename(numbered).replace(/^\d{4}-/, '')}, the time you wrote it, and land again`);
}

// Every commit the branch adds starts its subject with the card's ref and a colon ("#114: ..."), and none still holds
// the "# Conflicts:" note a `rebase --continue` under core.commentChar=';' keeps as message text.
function refuseBadMessages(repo, base, branch, ref) {
  const commits = git(repo, 'log', '--format=%h', `${base}..${branch}`).out.split('\n').filter(Boolean);
  for (const c of commits) {
    const subject = git(repo, 'log', '-1', '--format=%s', c).out;
    if (ref && !subject.startsWith(`${ref}: `)) fail(`land: commit ${c} "${subject}" doesn't start with "${ref}: "; reword it and land again`);
    if (/^# Conflicts:/m.test(git(repo, 'log', '-1', '--format=%B', c).out)) fail(`land: commit ${c} "${subject}" still holds a "# Conflicts:" note in its message; amend it out and land again`);
  }
}

// A shared clone's base brought up to origin's before a land into it, on a board on GitHub whose PRs are off: fetched,
// then fast-forwarded while the clone has base checked out (land refuses any other branch, naming it).
export function syncBase(repo, base) {
  const fetched = git(repo, 'fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`);
  if (!fetched.ok) fail(`could not fetch ${base} from origin into ${repo}: ${fetched.err}`);
  if (git(repo, 'symbolic-ref', '--quiet', '--short', 'HEAD').out !== base) return;
  const moved = git(repo, 'merge', '--quiet', '--ff-only', `refs/remotes/origin/${base}`);
  if (!moved.ok) fail(`${base} in ${repo} doesn't fast-forward to origin's (${moved.err}); bring it level with origin/${base} and land again`);
}

// Runs the worktree's full suite, refusing on a failure with each failing test and outcome, what the refusal left undone.
export function passTests(dir, { say = console.log, runTests = nodeTests, outcome }) {
  const tests = runTests(dir);
  if (!tests.ok) fail([
    `tests failed in ${dir} (${tests.fail} failing); ${outcome}`,
    ...(tests.failures?.length ? tests.failures : [tests.error || 'test runner failed without test diagnostics']),
    ...(tests.log ? [`Full test output: ${tests.log}`] : tests.logError ? [tests.logError] : []),
  ].join('\n'));
  say(`tests passed: ${tests.pass}`);
}

// hold stops once the tests pass, before the fast-forward: the verified branch waits in its worktree for the owner's
// Merge (docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md).
export function land({ path: dir, branch, repo, base, ref }, { say = console.log, runTests = nodeTests, restart = restartRunner, boards = () => listBoards(), clone = skillRepo(), hold = false } = {}) {
  if (!fs.existsSync(dir)) fail(`no worktree at ${dir}`);
  const head = git(repo, 'symbolic-ref', '--quiet', '--short', 'HEAD').out;
  if (head !== base) fail(`${repo} is on ${head || 'a detached HEAD'}, not ${base}; switch it to ${base} (git -C ${repo} switch ${base}) and land again`);
  if (git(dir, 'status', '--porcelain').out) fail(`${dir} has uncommitted changes; commit them there first`);
  if (Number(git(repo, 'rev-list', '--count', `${base}..${branch}`).out) === 0) fail(`${branch} has no commits beyond ${base}; nothing to land`);

  if (!git(repo, 'merge-base', '--is-ancestor', base, branch).ok) {
    if (!git(dir, 'rebase', '--quiet', base).ok) {
      const conflicted = git(dir, 'diff', '--name-only', '--diff-filter=U').out.split('\n').filter(Boolean);
      git(dir, 'rebase', '--abort');
      fail(`rebasing ${branch} onto ${base} conflicts in ${conflicted.join(', ') || 'files git did not name'}; resolve it in ${dir} and land again`);
    }
    say(`rebased ${branch} onto ${base} (${short(repo, base)})`);
  }

  const blank = git(repo, 'log', '--format=%h %s', `${base}..${branch}`).out.split('\n').filter((l) => l && !l.includes(' '));
  if (blank.length) fail(`${branch} has a commit with an empty subject (${blank[0]}); reword it in ${dir} and land again`);

  refuseNumberedAdr(repo, base, branch);
  refuseBadMessages(repo, base, branch, ref);

  passTests(dir, { say, runTests, outcome: 'nothing landed' });
  if (hold) return;

  const changed = git(repo, 'diff', '--name-only', base, branch).out.split('\n').filter(Boolean);
  const merged = git(repo, 'merge', '--quiet', '--ff-only', branch);
  if (!merged.ok) fail(`could not fast-forward ${base} in ${repo}: ${merged.err}`);
  say(`${base} fast-forwarded to ${short(repo, base)} in ${repo}`);

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
