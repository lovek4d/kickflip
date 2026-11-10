// A builder's git worktree for a site or skill card (docs/adr/2026-10-30-1654-every-builder-works-in-a-worktree.md):
// A build's `board.mjs builder start` (with or without --worktree) and the board server's Build tap make it, and `board.mjs land` brings its branch into the live repo's main.
// Worktrees resolve under $HOME and the repo defaults to the running clone, so a scratch HOME and --repo stand in for
// the real ones.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BoardError, opensPRs, settingsOf } from './store.mjs';
import { boardAt, hubCode, listBoards, readJSON, readManifest, samePath } from '../hub/boards.mjs';
import { boardRepo } from '../hub/board-repo.mjs';
import { cloneRoot } from '../shared/repos.mjs';
import { nodeBin, storedPath } from '../bin/install.mjs';
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
// git remote from its branch of its shared clone, fetched first; a local board from its repo's local copy of its
// recorded branch (`kickflip join` saves the folder's default branch), else main. The hub board is local while its
// Landing is Merge; on Draft PR or Ready PR (store.mjs opensPRs) it branches from origin's branch, fetched first, and
// finishes with a PR, still in its folder (docs/adr/2026-11-05-1100-the-hub-board-shows-landing-and-defaults-to-merge.md).
// With no site, or a site that isn't a board, the running kickflip clone's main. repo stands in for the board's folder.
// → {repo, base, remote}
export function builderRepo(site, { repo, manifest = readManifest() } = {}) {
  const board = site ? boardAt(site, manifest) : null;
  if (!board) return { repo: repo ?? skillRepo(), base: 'main', remote: false };
  const chosen = boardRepo(board.route, manifest);
  const folder = repo ?? (chosen.repo || fail(`/${board.route} has no folder recorded for its session; rejoin it from its repo folder`));
  const prs = opensPRs(chosen, settingsOf(readJSON(path.join(board.dir, 'board.json'), {}), chosen));
  return { repo: folder, base: chosen.branch || 'main', remote: !chosen.local || prs };
}

// The worktree of card id on the board at site, from builderRepo. → as makeWorktree
export const boardWorktree = (site, id, { repo, busy } = {}) => makeWorktree(id, { ...builderRepo(site, { repo }), busy });

// docs/adr/2026-11-06-0425-the-implementer-limit-counts-agents-and-a-card-spawns-helpers.md
// The worktree of helper name on card id: branch <id>-<name> from base, the card's branch, in repo. → as makeWorktree
export const helperWorktree = (id, name, { repo, base, busy }) => makeWorktree(`${id}-${name}`, { repo, base, busy });

// `agent merge`: brings a helper's branch (helper {path, branch}) into the card's worktree (card {path}), then removes
// the helper's worktree and branch. A branch already in the card's history skips the merge, so a run after a conflict
// the builder resolved and committed only cleans up. A conflict is left for the builder, naming its files.
// → {lines}
export function mergeHelper(card, helper) {
  const lines = [];
  if (git(card.path, 'merge-base', '--is-ancestor', helper.branch, 'HEAD').ok) lines.push(`${helper.branch} is already merged`);
  else {
    const merged = git(card.path, 'merge', '--no-edit', helper.branch);
    if (!merged.ok) {
      const files = git(card.path, 'diff', '--name-only', '--diff-filter=U').out.split('\n').filter(Boolean);
      fail(files.length
        ? `merging ${helper.branch} conflicts in ${files.join(', ')}: resolve them, commit, and run agent merge again`
        : `could not merge ${helper.branch}: ${merged.err}`);
    }
    lines.push(`merged ${helper.branch} into ${git(card.path, 'rev-parse', '--abbrev-ref', 'HEAD').out}`);
  }
  if (fs.existsSync(helper.path)) {
    const removed = git(card.path, 'worktree', 'remove', helper.path);
    if (!removed.ok) fail(`merged, but could not remove ${helper.path}: ${removed.err}`);
    lines.push(`worktree removed: ${helper.path}`);
  }
  const deleted = git(card.path, 'branch', '--quiet', '-d', helper.branch);
  if (deleted.ok) lines.push(`branch deleted: ${helper.branch}`);
  return { lines };
}

// docs/adr/2026-11-06-0200-the-board-rebases-a-conflicting-pr-with-a-headless-run.md
// The worktree of card id for its open PR's branch, fetched from origin, for a rebase run on a PR no build of the board
// made (a PR linked by hand). The local branch is made from origin's, or checked out as it is when it already exists.
// → as makeWorktree
export function prWorktree(site, id, branch) {
  const { repo } = builderRepo(site);
  const root = path.resolve(repo);
  if (!git(root, 'check-ref-format', '--branch', branch).ok) fail(`"${branch}" can't be a branch name`);
  const ref = `refs/remotes/origin/${branch}`;
  const fetched = git(root, 'fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:${ref}`);
  if (!fetched.ok) fail(`could not fetch ${branch} from origin: ${fetched.err}`);
  const dir = path.join(worktreesDir(), id);
  if (fs.existsSync(dir)) fail(`${storedPath(dir)} already exists; land or remove it first`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const exists = git(root, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).ok;
  const r = exists ? git(root, 'worktree', 'add', '--quiet', dir, branch) : git(root, 'worktree', 'add', '--quiet', '--track', '-b', branch, dir, ref);
  if (!r.ok) fail(`git worktree add failed: ${r.err}`);
  return { path: storedPath(dir), branch, repo: storedPath(root), remade: null };
}

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

// The full suite of the worktree, as a promise. NODE_TEST_CONTEXT is dropped, since a run started from inside a test
// would otherwise report to that test's runner instead of exiting with its own result. Each test fails once it runs past
// testLimit, and the whole run is cut off at limit: its process group is killed, so a hung file's child dies with it, and
// → {hung: {after, files}} naming the files still running, with the partial output and those processes saved to the log
// (docs/adr/2026-11-05-0725-land-suites-run-side-by-side-under-a-time-limit.md). Whatever the run's tests left
// running in its process group is killed as the run exits.
export function nodeTests(dir, { limit = 15 * 60 * 1000, testLimit = 5 * 60 * 1000 } = {}) {
  const files = testFiles(dir);
  if (!files.length) return Promise.resolve({ ok: true, pass: 0, fail: 0 });
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  const child = spawn(nodeBin(), ['--test', '--test-reporter=tap', `--test-timeout=${testLimit}`, ...files], { cwd: dir, env, detached: true });
  // macOS answers EPERM, not ESRCH, for a group whose processes have all died but aren't yet reaped.
  child.once('exit', () => { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH' && e.code !== 'EPERM') throw e; } });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
  child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
  let left = null;
  const cutoff = setTimeout(() => {
    left = spawnSync('ps', ['-A', '-o', 'pgid=,pid=,args='], { encoding: 'utf8' }).stdout.split('\n')
      .filter((line) => Number(line.trim().split(/\s+/)[0]) === child.pid).map((line) => line.trim());
    if (left.length) process.kill(-child.pid, 'SIGKILL');
    // A process outside the group can still hold the output pipes open.
    const release = () => { child.stdout.destroy(); child.stderr.destroy(); };
    if (child.exitCode === null && child.signalCode === null) child.once('exit', release); else release();
  }, limit);
  return new Promise((resolve) => child.on('close', (status, signal) => {
    clearTimeout(cutoff);
    const count = (name) => Number(stdout.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1] ?? 0);
    const result = { ok: status === 0, pass: count('pass'), fail: count('fail') };
    if (result.ok) { resolve(result); return; }
    const logs = path.join(os.homedir(), '.claude', 'kickflip', 'logs');
    try {
      fs.mkdirSync(logs, { recursive: true });
      const log = path.join(logs, `land-${randomUUID()}.tap`);
      fs.writeFileSync(log, stdout + stderr + (left ? `\n# processes still running at the cutoff\n${left.join('\n')}\n` : ''), { mode: 0o600 });
      result.log = log;
    } catch (e) { result.logError = `Could not save the full test output: ${e.message}`; }
    // The runner's own args name every file, so only its children's name the files still running.
    const children = left?.filter((line) => Number(line.split(/\s+/)[1]) !== child.pid);
    if (left) result.hung = { after: duration(limit), files: files.filter((f) => children.some((p) => p.includes(f))).map((f) => path.relative(dir, f)) };
    result.failures = tapFailures(stdout);
    const firstErr = stderr.trim().split('\n')[0];
    result.error = `${signal ? `test runner killed by ${signal}` : `test runner exited ${status}`}${firstErr ? `: ${firstErr}` : ''}`;
    resolve(result);
  }));
}
const duration = (ms) => ms % 60000 ? `${ms / 1000} seconds` : `${ms / 60000} minutes`;

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
    cmd = [nodeBin(), KICKFLIP, 'restart', route];
  }
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8' });
  return r.status === 0 ? null : (r.stderr || r.error?.message || `exit ${r.status}`).trim().split('\n')[0];
}

// Brings a checked worktree's branch into the live repo's base branch (builderRepo's base), saying each step: refuses
// unless the repo has base checked out, naming it, or while the worktree has uncommitted changes or the branch adds
// nothing; rebases it onto base when base moved, refusing on a conflict with the rebase undone; runs the worktree's
// full suite unless that commit passed it already (prepareLand); fast-forwards base (landPrepared); when repo is the running kickflip clone,
// restarts the hub when its code changed, else the board servers when board/ changed (a hub restart restarts every
// site), test files aside; removes the worktree and branch.
// Never pushes. A restart that fails is reported after the rest is done.
// One land at a time on the host, since a land can restart the hub and every board server: ~/.claude/kickflip/land.lock
// {card, pid, at} names the card landing. A land that finds it held waits its turn across every process, in a file per
// ask in ~/.claude/kickflip/land.queue, named <asked ms>-<count>-<pid> and holding {card, site, key, first}, calling
// onWait(card) with the card it waits for. The queue goes bumped first, the latest bump (first) ahead, then first in
// first out by asked, when the land was asked for, so a land that lets go of the lock to test again keeps its place
// (docs/adr/2026-11-05-1809-the-orchestrator-stops-the-boards-own-runs.md). A bump never stops the land holding the
// lock. A waiter wakes when its own ask is moved or the one file it waits on goes: the lock, or the nearest ask ahead
// of it. A lock or ask whose process is gone is taken over, found by a slow recheck since a process that dies removes
// neither.
const kickflipDir = () => path.join(os.homedir(), '.claude', 'kickflip');
const landing = () => path.join(kickflipDir(), 'landing');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const RECHECK_MS = 5000;
// Resolves once any of files is removed or replaced, or after RECHECK_MS; at once if one is already gone. On macOS a
// file's watch is a kqueue note the event loop registers on its next poll, so the files are checked again once a poll
// has run (two immediates on, since one can fall in the check phase right after the poll that ran this): a file removed
// before the note was live is caught there (docs/adr/2026-11-05-2159-a-land-waits-on-one-file-and-a-hub-event-is-written-once.md).
async function untilGone(files) {
  const watched = [];
  let timer;
  try {
    for (const file of files) {
      try { watched.push({ file, ino: fs.statSync(file).ino, watcher: fs.watch(file) }); } catch { return; }
    }
    await new Promise((resolve) => {
      for (const { watcher } of watched) watcher.on('change', resolve).on('error', resolve);
      timer = setTimeout(resolve, RECHECK_MS);
      setImmediate(() => setImmediate(() => {
        for (const { file, ino } of watched) {
          let now = null;
          try { now = fs.statSync(file).ino; } catch {}
          if (now !== ino) resolve();
        }
      }));
    });
  } finally { clearTimeout(timer); for (const { watcher } of watched) watcher.close(); }
}
const queueDir = (name) => path.join(kickflipDir(), `${name}.queue`);
const ticketPid = (ticket) => Number(ticket.split('-')[2]);
const readTicket = (queue, ticket) => { try { return JSON.parse(fs.readFileSync(path.join(queue, ticket), 'utf8')); } catch { return {}; } };
// Where an ask stands in the queue: bumped asks first, the latest bump ahead, then by name, which starts with asked.
const rank = (ticket, { first }) => `${first ? `0${String(1e15 - Date.parse(first)).padStart(16, '0')}` : '1'}-${ticket}`;
// The live asks of queue name, in queue order, each {ticket, card, site, key, first}.
function queuedAsks(name) {
  const queue = queueDir(name);
  let tickets = [];
  try { tickets = fs.readdirSync(queue).filter((t) => !t.endsWith('.tmp')); } catch {}
  return tickets.filter((t) => alive(ticketPid(t))).map((ticket) => ({ ticket, ...readTicket(queue, ticket) }))
    .sort((a, b) => (rank(a.ticket, a) < rank(b.ticket, b) ? -1 : 1));
}
const writeTicket = (queue, ticket, content) => {
  const tmp = path.join(queue, `${ticket}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(content));
  fs.renameSync(tmp, path.join(queue, ticket));
};
let asks = 0;
// The lock named name (<name>.lock, queue in <name>.queue) held while fn runs; onWait(card) names who it waits for.
// site and key name the board card the ask is for, and first its standing bump, so a bump can move it.
async function holdingQueuedLock(name, card, fn, { onWait, asked = Date.now(), site = null, key = null, first = null } = {}) {
  const file = path.join(kickflipDir(), `${name}.lock`);
  const queue = queueDir(name);
  fs.mkdirSync(queue, { recursive: true });
  const ticket = `${String(asked).padStart(15, '0')}-${String(asks++).padStart(6, '0')}-${process.pid}`;
  writeTicket(queue, ticket, { card, site, key, first });
  let waitingFor = null;
  try {
    for (;;) {
      const all = queuedAsks(name);
      const mine = all.findIndex((a) => a.ticket === ticket);
      const ahead = all.slice(0, mine);
      let held = null;
      if (!ahead.length) {
        try { fs.writeFileSync(file, JSON.stringify({ card, pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' }); break; }
        catch (e) {
          if (e.code !== 'EEXIST') throw e;
          try { held = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
          if (!(Number.isInteger(held?.pid) && alive(held.pid))) { fs.rmSync(file, { force: true }); continue; }
        }
      }
      const who = held?.card ?? (ahead.length ? `the ${name} ahead` : null);
      if (who && who !== waitingFor) { waitingFor = who; await onWait?.(who); }
      await untilGone([ahead.length ? path.join(queue, ahead.at(-1).ticket) : file, path.join(queue, ticket)]);
    }
  } finally {
    fs.rmSync(path.join(queue, ticket), { force: true });
  }
  try { return await fn(); } finally {
    try { if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.rmSync(file, { force: true }); } catch {}
  }
}
export const holdingLandLock = (card, fn, opts) => holdingQueuedLock('land', card, fn, opts);

// A bump of the card key on the board at site moves its queued lands: first, the bump's time, puts them ahead of every
// ask not bumped since; null puts them back in ask order. → how many it moved
export function moveQueuedLand(site, key, first) {
  const queue = queueDir('land');
  const mine = queuedAsks('land').filter((a) => a.key === key && a.site && samePath(a.site, site));
  for (const { ticket, ...content } of mine) writeTicket(queue, ticket, { ...content, first });
  return mine.length;
}

// The host's land queue in its order: the land holding the lock, running, then the asks waiting, each {card, running,
// first}.
export function landQueue() {
  const holder = landLock();
  return [
    ...(holder ? [{ card: holder.card, running: true, first: null }] : []),
    ...queuedAsks('land').map(({ card, first }) => ({ card, running: false, first: first ?? null })),
  ];
}

// The live land lock {card, pid, at}, or null.
export function landLock() {
  try {
    const held = JSON.parse(fs.readFileSync(path.join(kickflipDir(), 'land.lock'), 'utf8'));
    return Number.isInteger(held?.pid) && alive(held.pid) ? held : null;
  } catch { return null; }
}

// One land per card: ~/.claude/kickflip/landing/<card> {pid, at, merge?} while fn runs, merge marking the land a held
// card's Merge tap started (finish.mjs landHeld). A land asked for a card already landing joins that land instead: it
// waits for it to end and → {joined: true}, so the caller reads what became of the card. A marker whose process is gone
// is taken over.
export async function joiningLand(card, fn, { merge = false } = {}) {
  const dir = landing();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, encodeURIComponent(card));
  let joined = false;
  for (;;) {
    if (joined && !fs.existsSync(file)) return { joined: true };
    try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), ...(merge ? { merge } : {}) }), { flag: 'wx' }); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let held = null;
      try { held = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      if (!(Number.isInteger(held?.pid) && alive(held.pid))) { fs.rmSync(file, { force: true }); continue; }
      joined = true;
      await untilGone([file]);
    }
  }
  try { return await fn(); } finally { fs.rmSync(file, { force: true }); }
}

// The live land of card, its landing marker {pid, at, merge?}, or null.
export function runningLand(card) {
  try {
    const held = JSON.parse(fs.readFileSync(path.join(landing(), encodeURIComponent(card)), 'utf8'));
    return Number.isInteger(held?.pid) && alive(held.pid) ? held : null;
  } catch { return null; }
}

// After a stop: card's landing marker and the queued asks whose process was one of pids leave, so neither reads as
// waiting.
export function clearStoppedLand(card, pids) {
  const marker = path.join(landing(), encodeURIComponent(card));
  try { if (pids.includes(JSON.parse(fs.readFileSync(marker, 'utf8')).pid)) fs.rmSync(marker, { force: true }); } catch {}
  let tickets = [];
  try { tickets = fs.readdirSync(queueDir('land')); } catch {}
  for (const t of tickets.filter((t) => pids.includes(ticketPid(t)))) fs.rmSync(path.join(queueDir('land'), t), { force: true });
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

// Runs the worktree's full suite, refusing on a failure with each failing test, or on a run cut off at its time limit
// with the files still running, and outcome, what the refusal left undone.
export async function passTests(dir, { say = console.log, runTests = nodeTests, outcome }) {
  const tests = await runTests(dir);
  const log = tests.log ? [`Full test output: ${tests.log}`] : tests.logError ? [tests.logError] : [];
  if (tests.hung) fail([`tests hung past ${tests.hung.after} in ${tests.hung.files.join(', ') || 'the test runner'}; ${outcome}`, ...log].join('\n'));
  if (!tests.ok) fail([
    `tests failed in ${dir} (${tests.fail} failing); ${outcome}`,
    ...(tests.failures?.length ? tests.failures : [tests.error || 'test runner failed without test diagnostics']),
    ...log,
  ].join('\n'));
  say(`tests passed: ${tests.pass}`);
}

// docs/adr/2026-11-04-2320-a-merge-tap-waits-its-turn-to-land.md
// The part of a land that runs outside the land lock: the checks, the rebase onto base when base moved, and the suite.
// → the commit it tested. refs/kickflip/tested/<branch> keeps that commit, so a branch whose head is still it, with base
// not moved past it, is not tested again.
export async function prepareLand({ path: dir, branch, repo, base, ref }, { say = console.log, runTests = nodeTests } = {}) {
  if (!fs.existsSync(dir)) fail(`no worktree at ${dir}`);
  onBase(repo, base);
  if (git(dir, 'status', '--porcelain').out) fail(`${dir} has uncommitted changes; commit them there first`);
  if (Number(git(repo, 'rev-list', '--count', `${base}..${branch}`).out) === 0) fail(`${branch} has no commits beyond ${base}; nothing to land`);

  if (!git(repo, 'merge-base', '--is-ancestor', base, branch).ok) {
    const rebased = git(dir, 'rebase', '--quiet', base);
    if (!rebased.ok) {
      const conflicted = git(dir, 'diff', '--name-only', '--diff-filter=U').out.split('\n').filter(Boolean);
      git(dir, 'rebase', '--abort');
      if (!conflicted.length) fail(`rebasing ${branch} onto ${base} failed: ${rebased.err}`);
      fail(`rebasing ${branch} onto ${base} conflicts in ${conflicted.join(', ')}; resolve it in ${dir} and land again`);
    }
    say(`rebased ${branch} onto ${base} (${short(repo, base)})`);
  }

  const blank = git(repo, 'log', '--format=%h %s', `${base}..${branch}`).out.split('\n').filter((l) => l && !l.includes(' '));
  if (blank.length) fail(`${branch} has a commit with an empty subject (${blank[0]}); reword it in ${dir} and land again`);

  refuseNumberedAdr(repo, base, branch);
  refuseBadMessages(repo, base, branch, ref);

  const head = git(repo, 'rev-parse', branch).out;
  if (git(repo, 'rev-parse', '--verify', '--quiet', testedRef(branch)).out === head) {
    say(`${branch} was tested on ${base} as it is now; not testing it again`);
    return head;
  }
  await passTests(dir, { say, runTests, outcome: 'nothing landed' });
  git(repo, 'update-ref', testedRef(branch), head);
  return head;
}
const testedRef = (branch) => `refs/kickflip/tested/${branch}`;
function onBase(repo, base) {
  const head = git(repo, 'symbolic-ref', '--quiet', '--short', 'HEAD').out;
  if (head !== base) fail(`${repo} is on ${head || 'a detached HEAD'}, not ${base}; switch it to ${base} (git -C ${repo} switch ${base}) and land again`);
}

// A whole land: prepareLand, then, under the land lock, the fast-forward (landPrepared). When base moved while the
// branch was prepared, the lock is let go and the branch is prepared again. hold stops once the tests pass, before the
// fast-forward: the verified branch waits in its worktree for the owner's Merge
// (docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md). sync runs under the lock before the fast-forward. queue
// {site, key, first} names the board card the land is for and its standing bump, for its place in the land queue.
export async function landInTurn(tree, { hold = false, onWait, sync = () => {}, queue = {}, ...opts } = {}) {
  const { say = console.log } = opts;
  const asked = Date.now();
  for (;;) {
    const tested = await prepareLand(tree, opts);
    if (hold) return;
    const landed = await holdingLandLock(tree.ref ?? tree.branch, () => { sync(); return landPrepared(tree, tested, opts); }, { onWait, asked, ...queue });
    if (landed) return;
    say(`${tree.base} moved while ${tree.branch} was tested; testing it on ${tree.base} again`);
  }
}

// The land as one synchronous step, for a caller that holds the land lock already.
export async function land(tree, { hold = false, ...opts } = {}) {
  const tested = await prepareLand(tree, opts);
  if (hold) return;
  if (!landPrepared(tree, tested, opts)) fail(`${tree.base} moved while ${tree.branch} was tested; land again`);
}

// Under the land lock: fast-forwards base to tested, the commit prepareLand tested, then restarts what runs the changed
// code and removes the worktree and branch. → false, changing nothing, when base moved past tested or the branch moved.
export function landPrepared({ path: dir, branch, repo, base }, tested, { say = console.log, restart = restartRunner, boards = () => listBoards(), clone = skillRepo() } = {}) {
  onBase(repo, base);
  if (git(repo, 'rev-parse', branch).out !== tested || !git(repo, 'merge-base', '--is-ancestor', base, tested).ok) return false;
  const changed = git(repo, 'diff', '--name-only', base, branch).out.split('\n').filter(Boolean);
  const merged = git(repo, 'merge', '--quiet', '--ff-only', tested);
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
  git(repo, 'update-ref', '-d', testedRef(branch));
  if (failed.length) fail(`landed, but ${failed.join('; ')}`);
  return true;
}
