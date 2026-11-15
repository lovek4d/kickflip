// A builder's git worktree for a site or skill card (docs/adr/2026-10-30-1654-every-builder-works-in-a-worktree.md):
// A build's `board.mjs builder start` (with or without --worktree) and the board server's Build tap make it, and `board.mjs land` brings its branch into the live repo's main.
// Worktrees resolve under $HOME and the repo defaults to the running clone, so a scratch HOME and --repo stand in for
// the real ones.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { BoardError, opensPRs, settingsOf } from './store.mjs';
import { boardAt, hubCode, listBoards, readJSON, readManifest, samePath } from '../hub/boards.mjs';
import { boardRepo } from '../hub/board-repo.mjs';
import { cloneRoot } from '../shared/repos.mjs';
import { nodeBin, storedPath } from '../bin/install.mjs';
import { hubService } from '../shared/service.mjs';
import { squashMessage, subjectFault } from './commit-message.mjs';
import { releaseTag, tagRelease } from './release-tag.mjs';
import { affectedTests } from './affected.mjs';
import { readMachineState } from '../shared/machine-gate.mjs';

const KICKFLIP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kickflip.mjs');
export const skillRepo = cloneRoot;
export const worktreesDir = () => path.join(os.homedir(), '.claude', 'kickflip', 'worktrees');
const fail = (msg) => { throw new BoardError(msg); };

export function git(cwd, ...args) {
  // core.commentChar=';' keeps a message line starting with # (an older "#N: ..." subject, or a ref wrapped to a line's
  // start): git's default cleanup strips such lines when it rewrites a message.
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
// the builder resolved and committed only cleans up. A conflict is left for the builder, naming its files. A merge
// commit follows the commit standard, naming the card's ref.
// → {lines}
export function mergeHelper(card, helper, ref) {
  const lines = [];
  if (git(card.path, 'merge-base', '--is-ancestor', helper.branch, 'HEAD').ok) lines.push(`${helper.branch} is already merged`);
  else {
    const merged = git(card.path, 'merge', '--no-edit', '-m', `chore: merge the ${helper.branch} helper branch\n\nRefs: ${ref}`, helper.branch);
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

const EXIT_WITH_RUN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'exit-with-run.mjs');

// The test files a run starts at once: half the host's cores, at least one, so several suites at a time don't pile their
// files up on a loaded Mac (docs/adr/2026-11-12-1600-the-test-runner-caps-concurrency-to-half-the-cores.md).
export const testConcurrency = () => Math.max(1, Math.floor(os.availableParallelism() / 2));

// The `node --test` arguments of a run over files.
export const testArgs = (testLimit, files) => ['--test', '--test-reporter=tap', `--test-concurrency=${testConcurrency()}`, `--test-timeout=${testLimit}`, ...files];

// The worktree's tests, as a promise: files, repo-relative, else every *.test.mjs file in it. NODE_TEST_CONTEXT is dropped, since a run started from inside a test
// would otherwise report to that test's runner instead of exiting with its own result. KICKFLIP_TAILSCALE is a failing
// stub, so a test's hub never reaches the host's Tailscale; a test with its own stub names it. Every node process of the
// run loads exit-with-run.mjs, which exits it once this process is gone. Each test fails once it runs past
// testLimit, and the whole run is cut off at limit: its process group is killed, so a hung file's child dies with it, and
// → {hung: {after, files}} naming the files still running, with the partial output and those processes saved to the log
// (docs/adr/2026-11-05-0725-land-suites-run-side-by-side-under-a-time-limit.md). Whatever the run's tests left
// running in its process group is killed as the run exits.
export function nodeTests(dir, { files: chosen, limit = 15 * 60 * 1000, testLimit = 5 * 60 * 1000, report, every = REPORT_EVERY } = {}) {
  const files = chosen ? chosen.map((f) => path.join(dir, f)) : testFiles(dir);
  if (!files.length) return Promise.resolve({ ok: true, pass: 0, fail: 0 });
  const began = Date.now();
  const said = [report?.start(chosen ? `${files.length} test files` : `full suite, ${files.length} test files`)];
  // The runner's TAP lists every test of every file at the top level, each with its own "ok" or "not ok" line, and
  // names no total before the run ends, so progress counts the tests that have run.
  const testsDone = (tap) => [...tap.matchAll(/^(not )?ok \d+ /gm)].map((m) => Boolean(m[1]));
  const ticker = report && setInterval(() => {
    const done = testsDone(stdout);
    said.push(report.update(`${done.length} tests run, ${done.filter(Boolean).length} failing`));
  }, every);
  const { NODE_TEST_CONTEXT: _, ...rest } = process.env;
  // A run started from inside a run's test has the import already, and watches its own starter.
  const exitWithRun = `--import=${JSON.stringify(EXIT_WITH_RUN)}`;
  const options = rest.NODE_OPTIONS?.includes(exitWithRun) ? rest.NODE_OPTIONS : [rest.NODE_OPTIONS, exitWithRun].filter(Boolean).join(' ');
  const env = { ...rest, KICKFLIP_TAILSCALE: '/usr/bin/false', KICKFLIP_TEST_RUN: String(process.pid), NODE_OPTIONS: options };
  const child = spawn(nodeBin(), testArgs(testLimit, files), { cwd: dir, env, detached: true });
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
  return new Promise((resolve, reject) => child.on('close', async (status, signal) => {
    clearTimeout(cutoff);
    clearInterval(ticker);
    const count = (name) => Number(stdout.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1] ?? 0);
    const result = { ok: status === 0, pass: count('pass'), fail: count('fail') };
    const seconds = Math.round((Date.now() - began) / 1000);
    try {
      said.push(report?.end(`${result.pass} passed, ${result.fail} failed in ${Math.floor(seconds / 60)}m ${seconds % 60}s`));
      await Promise.all(said);
    } catch (e) { reject(e); return; }
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
    // The test files holding a failing test, by the location the runner reports for it.
    const places = stdout.split('\n').filter((line) => /^\s*location: /.test(line));
    result.failedFiles = files.map((f) => path.relative(dir, f)).filter((rel) => places.some((line) => line.includes(`/${rel}:`)));
    const firstErr = stderr.trim().split('\n')[0];
    result.error = `${signal ? `test runner killed by ${signal}` : `test runner exited ${status}`}${firstErr ? `: ${firstErr}` : ''}`;
    resolve(result);
  }));
}
// How often a run's progress is reported.
const REPORT_EVERY = 2 * 60 * 1000;
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
// nothing; squashes it into one commit and rebases that onto base when base moved, refusing on a conflict with the
// rebase undone; runs the tests the change affects unless that commit passed them already (prepareLand); fast-forwards base
// (landPrepared); when repo is the running kickflip clone,
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
  const added = git(repo, 'diff', '--name-only', '--no-renames', '--diff-filter=A', `${base}...${branch}`, '--', 'docs/adr').out.split('\n');
  const numbered = added.find((f) => /^docs\/adr\/\d{4}-(?!\d{2}-\d{2}-\d{4}-)/.test(f));
  if (numbered) fail(`land: ${numbered} is named with a number; name it docs/adr/YYYY-MM-DD-HHMM-${path.basename(numbered).replace(/^\d{4}-/, '')}, the time you wrote it, and land again`);
}

// docs/adr/2026-11-11-2318-every-land-squashes-the-branch-into-one-commit.md
// The commits branch adds since it left base made one commit in the worktree dir, its message squashMessage's (ref the
// card's, title the builder's --title), its author and date the branch's first commit's. Refuses, changing nothing, a
// message with an empty subject, one still holding the "# Conflicts:" note a `rebase --continue` under
// core.commentChar=';' keeps as message text, or on a card a subject off the commit standard
// (docs/adr/2026-11-11-1700-commits-are-conventional-and-name-their-card-in-a-refs-trailer.md), naming the first commit,
// where the subject and detail come from. A branch already one commit with that message is left as it is.
function squash(dir, repo, base, branch, { ref, title }) {
  const from = git(repo, 'merge-base', base, branch).out;
  const first = git(repo, 'rev-list', '--first-parent', '--reverse', `${from}..${branch}`).out.split('\n')[0];
  const commits = git(repo, 'rev-list', '--reverse', `${from}..${branch}`).out.split('\n');
  const messageOf = (c) => git(repo, 'log', '-1', '--format=%B', c).out;
  const message = squashMessage([first, ...commits.filter((c) => c !== first)].map(messageOf), { ref, title });
  const subject = message.split('\n')[0];
  const named = `commit ${short(repo, first)} "${subject}"`;
  if (!subject) fail(`${branch} has a commit with an empty subject (${short(repo, first)}); reword it in ${dir} and land again`);
  if (/^# Conflicts:/m.test(message)) fail(`land: ${named} still holds a "# Conflicts:" note in its message; amend it out and land again`);
  const fault = ref && subjectFault(subject);
  if (fault) fail(`land: ${named} ${fault}; reword it to the commit standard and land again`);
  if (commits.length === 1 && messageOf(first) === message) return;
  if (git(repo, 'diff', '--quiet', from, branch).ok) fail(`${branch}'s commits change nothing beyond ${base}; nothing to land`);

  const [author, date] = git(repo, 'log', '-1', '--format=%an <%ae>%x00%aI', first).out.split('\0');
  const head = git(repo, 'rev-parse', branch).out;
  git(dir, 'reset', '--quiet', '--soft', from);
  const made = git(dir, 'commit', '--quiet', '--no-verify', '--cleanup=verbatim', `--author=${author}`, `--date=${date}`, '-m', message);
  if (!made.ok) {
    git(dir, 'reset', '--quiet', '--soft', head);
    fail(`squashing ${branch} into one commit failed: ${made.err}`);
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

// The tests the change in a worktree since base affects (affected.mjs), as passTests' runTests, saying which run.
export const affectedRun = (base, say = console.log) => (dir, { report } = {}) => {
  const { files, full, touched } = affectedTests(dir, base);
  say(full ? `testing every test file, as ${full}` : `testing the ${files.length} test files the change affects`);
  return nodeTests(dir, { files, report }).then((tests) => ({ ...tests, touched }));
};
// docs/adr/2026-11-14-1530-a-land-reruns-an-untouched-failing-test-on-main.md
// Runs test files on base's commit in a worktree of its own beside the repo, removed after. → the files among them that
// fail there too.
export async function failingOnBase(repo, base, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kickflip-base-'));
  const added = git(repo, 'worktree', 'add', '--quiet', '--detach', dir, base);
  if (!added.ok) { fs.rmSync(dir, { recursive: true, force: true }); fail(`could not check out ${base} to rerun ${files.join(', ')}: ${added.err}`); }
  try {
    const rerun = await nodeTests(dir, { files: files.filter((f) => fs.existsSync(path.join(dir, f))) });
    return rerun.ok ? [] : rerun.failedFiles;
  } finally {
    git(repo, 'worktree', 'remove', '--force', dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// docs/adr/2026-11-14-1217-test-runs-wait-while-the-host-is-busy-and-leave-nothing-behind.md
// Resolves once the host doesn't read busy by the rule that holds new work (shared/machine-gate.mjs readMachineState:
// the sidebar's busy dot and a launch's hold), saying HOST_BUSY once, to say and to report's live line, when it has to
// wait. wait(ms) is the pause between reads.
export const HOST_BUSY = 'waiting: the host is busy';
const HOST_RECHECK_MS = 30_000;
export async function untilHostEases({ say = console.log, report, wait = sleep } = {}) {
  if (readMachineState().state !== 'busy') return;
  say(HOST_BUSY);
  await report?.update(HOST_BUSY);
  do await wait(HOST_RECHECK_MS); while (readMachineState().state === 'busy');
}

// Runs the worktree's tests (runTests, else the full suite) once the host eases (untilHostEases), refusing on a failure with each failing test, or on a run cut off at its time limit
// with the files still running, and outcome, what the refusal left undone.
// report, when given, is told the run's start, progress and result ({start, update, end}, each taking words; nodeTests).
// onUntouchedFailure, when given, is told the failing test files when none of them is one the change reaches (the run's
// touched) and answers which of them fail on base too; when all do, the run passes and the land goes on, the failure
// left to a Found: call, not the card.
export async function passTests(dir, { say = console.log, runTests = nodeTests, outcome, report, onUntouchedFailure, wait }) {
  await untilHostEases({ say, report, wait });
  const tests = await runTests(dir, { report });
  if (!tests.ok && !tests.hung && onUntouchedFailure && tests.failedFiles?.length && tests.failedFiles.every((f) => tests.touched && !tests.touched.includes(f))) {
    const onBase = await onUntouchedFailure(tests.failedFiles);
    if (tests.failedFiles.every((f) => onBase.includes(f))) { say(`${tests.failedFiles.join(', ')} fail on the base too, so the change didn't break them`); return; }
  }
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
// The part of a land that runs outside the land lock: the checks, the squash of the branch into one commit (squash),
// the rebase of that commit onto base when base moved, a release's check (release-tag.mjs releaseTag), and the tests
// the change affects (affectedRun).
// title is the builder's --title, the squash commit's subject. → the commit it tested. refs/kickflip/tested/<branch> keeps that commit, so a branch whose head is
// still it, with base not moved past it, is not tested again.
export async function prepareLand({ path: dir, branch, repo, base, ref, title }, { say = console.log, runTests = affectedRun(base, say), report, found = () => {} } = {}) {
  if (!fs.existsSync(dir)) fail(`no worktree at ${dir}`);
  onBase(repo, base);
  if (git(dir, 'status', '--porcelain').out) fail(`${dir} has uncommitted changes; commit them there first`);
  if (Number(git(repo, 'rev-list', '--count', `${base}..${branch}`).out) === 0) fail(`${branch} has no commits beyond ${base}; nothing to land`);
  const fault = title !== undefined && subjectFault(title);
  if (fault) fail(`--title "${title}" ${fault}; pass --title "<type>(<scope>): <summary>", at most 100 characters`);
  refuseNumberedAdr(repo, base, branch);
  squash(dir, repo, base, branch, { ref, title });

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

  const head = git(repo, 'rev-parse', branch).out;
  releaseTag(repo, head);
  if (git(repo, 'rev-parse', '--verify', '--quiet', testedRef(branch)).out === head) {
    say(`${branch} was tested on ${base} as it is now; not testing it again`);
    return head;
  }
  const onUntouchedFailure = async (files) => {
    const failing = await failingOnBase(repo, base, files);
    if (failing.length) await found(`Found: ${failing.join(', ')} fails on ${base} too (flaky or already broken); the land went on`);
    return failing;
  };
  await passTests(dir, { say, runTests, outcome: 'nothing landed', report, onUntouchedFailure });
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
// → landPrepared's {tag} once it landed.
export async function landInTurn(tree, { hold = false, onWait, sync = () => {}, queue = {}, ...opts } = {}) {
  const { say = console.log } = opts;
  const asked = Date.now();
  for (;;) {
    const tested = await prepareLand(tree, opts);
    if (hold) return;
    const landed = await holdingLandLock(tree.ref ?? tree.branch, () => { sync(); return landPrepared(tree, tested, opts); }, { onWait, asked, ...queue });
    if (landed) return landed;
    say(`${tree.base} moved while ${tree.branch} was tested; testing it on ${tree.base} again`);
  }
}

// The land as one synchronous step, for a caller that holds the land lock already.
export async function land(tree, { hold = false, ...opts } = {}) {
  const tested = await prepareLand(tree, opts);
  if (hold) return;
  if (!landPrepared(tree, tested, opts)) fail(`${tree.base} moved while ${tree.branch} was tested; land again`);
}

// Under the land lock: fast-forwards base to tested, the commit prepareLand tested, tags it when it is a release
// (release-tag.mjs), then restarts what runs the changed code and removes the worktree and branch. → {tag, commit}, the
// release tag it made or null and the commit it landed, or false, changing nothing, when base moved past tested or the branch moved.
export function landPrepared({ path: dir, branch, repo, base }, tested, { say = console.log, restart = restartRunner, boards = () => listBoards(), clone = skillRepo() } = {}) {
  onBase(repo, base);
  if (git(repo, 'rev-parse', branch).out !== tested || !git(repo, 'merge-base', '--is-ancestor', base, tested).ok) return false;
  const changed = git(repo, 'diff', '--name-only', base, branch).out.split('\n').filter(Boolean);
  const merged = git(repo, 'merge', '--quiet', '--ff-only', tested);
  if (!merged.ok) fail(`could not fast-forward ${base} in ${repo}: ${merged.err}`);
  say(`${base} fast-forwarded to ${short(repo, base)} in ${repo}`);

  const failed = [];
  // docs/adr/2026-11-12-1251-land-tags-a-release-commit-and-pushes-the-tag.md: the tag goes on the commit as it landed.
  const { tag, err: untagged } = tagRelease(repo, tested);
  if (untagged) failed.push(untagged); else if (tag) say(`tagged ${tag}`);
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
  return { tag, commit: tested };
}
