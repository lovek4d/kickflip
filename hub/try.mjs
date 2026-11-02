import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { listBoards, readManifest, readJSON, saveJSON, GITHUB_STATE } from './boards.mjs';
import { boardRepo, githubFromOrigin } from './board-repo.mjs';
import { buildScriptError } from '../board/build-script.mjs';
import { appendThread, recordedWorktree } from '../board/store.mjs';

export class BuildError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const execFileAsync = promisify(execFile);
const git = async (dir, ...args) => (await execFileAsync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 3000 })).stdout.trim();
const KEYCHAIN = /errSecInternalComponent|keychain[^\n]*\blocked\b|\blocked\b[^\n]*keychain/i;
const IDLE_MS = 30 * 60_000;
const scriptAt = (dir) => path.join(dir, '.kickflip', 'build');
const exists = (file) => fs.existsSync(file);
const logFileOf = (board, key) => path.join(board.dir, 'data', 'try', `${key.split('/').at(-1)}.log`);
function failureLog(board, key, error) {
  const file = logFileOf(board, key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, error.message + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}
const probe = (port) => new Promise((resolve) => {
  const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1000 }, (res) => { res.destroy(); resolve(true); });
  req.on('timeout', () => req.destroy());
  req.on('error', () => resolve(false));
});
const signalGroup = (child, signal) => { try { process.kill(-child.pid, signal); } catch {} };

export async function installWorktree(board, key, manifest) {
  const record = await recordedWorktree(board.dir, key);
  const [slug, id] = key.split('/');
  const wave = board.waves.find((w) => w.slug === slug)?.wave;
  const candidate = record?.path || wave?.items.find((it) => it.id === id)?.worktree;
  if (typeof candidate !== 'string' || !candidate || candidate.split(path.sep).includes('..')) return '';
  let repo = record?.repo;
  const github = (board.github || wave?.repo || '').toLowerCase();
  if (!repo && github) {
    const dirs = [board.owner?.repo, board.dir, ...Object.values(manifest?.sites || {}).map((s) => s.owner?.repo)];
    for (const dir of new Set(dirs.filter((d) => typeof d === 'string' && path.isAbsolute(d)))) {
      try {
        const remote = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(await git(dir, 'remote', 'get-url', 'origin'));
        if (remote?.[1].toLowerCase() === github) {
          repo = await git(dir, 'rev-parse', '--show-toplevel');
          break;
        }
      } catch {}
    }
  }
  if (!record?.path && !repo) return '';
  if (record?.path && !path.isAbsolute(candidate)) return '';
  try {
    const roots = [path.join(fs.realpathSync(os.homedir()), '.claude', 'kickflip', 'worktrees')];
    if (typeof repo === 'string' && path.isAbsolute(repo)) {
      try { roots.push(path.join(fs.realpathSync(repo), '.claude', 'worktrees')); } catch {}
    }
    const absolute = path.resolve(repo || '/', candidate);
    const resolved = fs.realpathSync(absolute);
    return roots.some((root) => absolute.startsWith(root + path.sep) && resolved.startsWith(root + path.sep))
      && fs.statSync(resolved).isDirectory() ? resolved : '';
  } catch { return ''; }
}

export function createTryManager({ now = Date.now, answers = probe, log = console.log } = {}) {
  const boards = new Map();
  const runs = new Map();
  const starting = new Set();
  const lastHeads = new Map();
  let stopping = false;
  let ticking = null;
  const stamp = () => new Date(now()).toISOString();
  function stateOf(board) {
    if (boards.has(board.dir)) return boards.get(board.dir);
    const file = path.join(board.dir, 'data', 'try.json');
    const saved = readJSON(file, { kind: null, main: null, cards: {} });
    const state = { kind: saved.kind || null, main: saved.main || null, cards: { ...saved.cards } };
    const record = { state, file, written: JSON.stringify(saved) };
    boards.set(board.dir, record);
    if (state.kind === 'web') {
      state.cards = {};
      if (state.main && state.main.state !== 'failed') { delete state.main.state; delete state.main.port; }
    } else {
      for (const card of Object.values(state.cards)) if (card.state === 'running') { delete card.state; delete card.sha; }
      if (state.main?.state === 'running') { delete state.main.state; delete state.main.sha; }
    }
    persist(board);
    return record;
  }
  function persist(board) {
    const record = boards.get(board.dir);
    const value = JSON.stringify(record.state);
    if (value === record.written) return;
    saveJSON(record.file, record.state);
    record.written = value;
  }
  const runKey = (board, key) => `${board.dir}\0${key}`;
  const entryOf = (state, key) => key === 'main' ? state.main : state.cards[key];
  function update(board, key, change) {
    const { state } = stateOf(board);
    const entry = entryOf(state, key);
    if (!entry) return;
    const changedState = Object.hasOwn(change, 'state') && change.state !== entry.state;
    Object.assign(entry, change, key !== 'main' && changedState ? { at: stamp() } : {});
    persist(board);
  }
  async function failure(run, code, signal, error) {
    const { board, key } = run;
    update(board, key, { state: 'failed', port: undefined });
    if (key === 'main') return;
    const tail = [];
    let keychain = false;
    try {
      for await (const line of createInterface({ input: fs.createReadStream(run.logFile), crlfDelay: Infinity })) {
        keychain ||= KEYCHAIN.test(line);
        tail.push(line);
        if (tail.length > 5) tail.shift();
      }
    } catch (e) { tail.push(`Could not read the build log: ${e.message}`); }
    const kind = run.port || (stateOf(board).state.kind || (board.waves.some(({ wave }) => wave.items.some((it) => it.install?.url)) ? 'app' : 'web')) === 'web' ? 'Serve' : 'Build';
    await appendThread(board.dir, key, { text: [`${kind} failed (exit ${code ?? 1})`, error?.message,
      signal && `Stopped by ${signal}.`, keychain && 'The login keychain must be unlocked on the Mac.', ...tail].filter(Boolean).join('\n') });
  }
  function terminate(run) {
    if (run.ending) return run.ending;
    signalGroup(run.child, 'SIGTERM');
    run.ending = new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); clearInterval(check); resolve(); };
      const timer = setTimeout(() => { signalGroup(run.child, 'SIGKILL'); finish(); }, 4000);
      const check = setInterval(() => {
        try { process.kill(-run.child.pid, 0); } catch { finish(); }
      }, 20);
    });
    return run.ending;
  }
  async function stopRun(run) {
    run.stopped = true;
    clearTimeout(run.deadline);
    clearInterval(run.poll);
    await terminate(run);
    await run.done;
    update(run.board, run.key, { state: undefined, port: undefined, ...(!run.ready ? { sha: undefined } : {}) });
    if (!run.ready) lastHeads.delete(runKey(run.board, run.key));
  }
  async function launch(board, key, worktree, metadata = {}) {
    if (!worktree) throw new BuildError('This card has no valid worktree.');
    const script = scriptAt(worktree);
    const error = buildScriptError(script);
    if (error) throw new BuildError(error);
    if (!fs.realpathSync(script).startsWith(fs.realpathSync(worktree) + path.sep)) throw new BuildError('Build script must be inside the worktree.');
    const sha = await git(worktree, 'rev-parse', 'HEAD');
    if (stopping) throw new BuildError('The hub is stopping. Try again after it restarts.', 503);
    const { state } = stateOf(board);
    const previous = entryOf(state, key);
    const entry = { ...(key === 'main' ? {} : previous), ...metadata, sha, script: true, state: 'running', ...(key === 'main' ? {} : { at: stamp(), head: sha }) };
    delete entry.port;
    const logFile = logFileOf(board, key);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const fd = fs.openSync(logFile, 'w', 0o600);
    fs.fchmodSync(fd, 0o600);
    const child = spawn(script, [key, worktree], { cwd: worktree, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, KICKFLIP_BOARD: board.route, KICKFLIP_BASE: `/${board.route}/try/${key.split('/').at(-1).toLowerCase()}/` } });
    if (key === 'main') state.main = entry; else state.cards[key] = entry;
    persist(board);
    const id = runKey(board, key);
    const run = { child, board, key, logFile, visited: now(), stopped: false, port: null, ready: false };
    runs.set(id, run);
    lastHeads.set(id, sha);
    let spawnError;
    let failed;
    const fail = (message) => { failed ||= new Error(message); terminate(run); };
    child.on('error', (e) => { spawnError = e; });
    child.stdout.on('data', (chunk) => fs.writeSync(fd, chunk));
    child.stderr.on('data', (chunk) => fs.writeSync(fd, chunk));
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      const match = /^port (\d{1,5})$/.exec(line);
      if (!match || run.port || run.stopped) return;
      const port = Number(match[1]);
      if (port < 1 || port > 65535) { fail('Build script printed an invalid port.'); return; }
      run.port = port;
      clearTimeout(run.deadline);
      const until = now() + 60_000;
      let probing = false;
      const check = async () => {
        if (probing || run.stopped || run.ready || child.exitCode !== null || child.signalCode !== null) return;
        probing = true;
        try {
          if (await answers(port)) {
            if (run.stopped || failed || child.exitCode !== null || child.signalCode !== null) return;
            run.ready = true;
            run.visited = now();
            state.kind = 'web';
            update(board, key, { state: 'ready', port });
            clearInterval(run.poll);
          } else if (now() >= until) fail('Nothing answered on the build script’s port within 60 seconds.');
        } finally { probing = false; }
      };
      run.poll = setInterval(() => check().catch((e) => fail(e.message)), 250);
      check().catch((e) => fail(e.message));
    });
    run.deadline = setTimeout(() => fail('No port line within 60 minutes.'), 60 * 60_000);
    // A script's process owns the server; surviving children cannot keep a dead run served.
    child.once('exit', () => { terminate(run); });
    run.done = new Promise((resolve) => child.once('close', (code, signal) => {
      clearTimeout(run.deadline);
      clearInterval(run.poll);
      lines.close();
      fs.closeSync(fd);
      (async () => {
        await terminate(run);
        if (run.stopped) return;
        if (failed || spawnError || code !== 0 || (run.port && !run.ready)) await failure(run, code ?? 1, signal, failed || spawnError || (run.port && !run.ready ? new Error('Build script exited before its port answered.') : null));
        else if (run.ready) {
          if (key === 'main') { delete state.main.state; delete state.main.port; }
          else delete state.cards[key];
          persist(board);
        } else {
          state.kind = 'app';
          update(board, key, { state: 'ready' });
        }
      })().catch((e) => log(`build /${board.route} ${key}: ${e.message}`)).finally(() => {
        if (runs.get(id) === run) runs.delete(id);
        resolve();
      });
    }));
    log(`build /${board.route} ${key}: started; log ${logFile}`);
    return { status: 'started' };
  }
  async function start(input, { manifest = readManifest() } = {}) {
    if (stopping) throw new BuildError('The hub is stopping. Try again after it restarts.', 503);
    if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).some((k) => !['route', 'key'].includes(k))
      || typeof input.route !== 'string' || typeof input.key !== 'string') throw new BuildError('Send only the board route and card key.');
    const { route, key } = input;
    if (!/^[\w.-]+\/[\w.-]+$/.test(key) || key.split('/').some((s) => s === '.' || s === '..')) throw new BuildError('Card key must be <wave>/<id>.');
    const board = listBoards(manifest).find((b) => b.route === route);
    if (!board) throw new BuildError(`/${route} is not a board.`, 404);
    if (!board.waves.some(({ slug, wave }) => wave.items.some((it) => `${slug}/${it.id}` === key))) throw new BuildError('There is no item with this card key.', 404);
    const id = runKey(board, key);
    if (starting.has(id) || (runs.has(id) && !runs.get(id).ready)) throw new BuildError('A build is already running for this card.', 409);
    starting.add(id);
    try {
      if (runs.has(id)) await stopRun(runs.get(id));
      const worktree = await installWorktree(board, key, manifest);
      return await launch(board, key, worktree);
    } finally { starting.delete(id); }
  }
  function lookup(route, id, { manifest = readManifest(), visit = false } = {}) {
    const board = listBoards(manifest).find((b) => b.route === route);
    if (!board) return null;
    const run = [...runs.values()].find((r) => r.board.dir === board.dir && r.key.split('/').at(-1).toLowerCase() === id.toLowerCase() && r.ready && !r.stopped && r.child.exitCode === null && r.child.signalCode === null);
    if (!run) return null;
    if (visit) run.visited = now();
    return { key: run.key, port: run.port };
  }
  async function tick({ manifest = readManifest() } = {}) {
    if (ticking || stopping) return ticking;
    ticking = (async () => {
      const listed = listBoards(manifest);
      const prs = readJSON(GITHUB_STATE, {}).prs || {};
      for (const run of [...runs.values()]) {
        if (!listed.some((b) => b.dir === run.board.dir) || (run.key !== 'main' && run.ready && now() - run.visited >= IDLE_MS)) {
          await stopRun(run);
          const { state } = stateOf(run.board);
          if (run.key === 'main') state.main = null; else delete state.cards[run.key];
          persist(run.board);
        }
      }
      for (const board of listed) {
        if (stopping) return;
        const { state } = stateOf(board);
        const source = boardRepo(board.route, manifest);
        const branch = source.branch || 'main';
        const ref = source.hub ? 'refs/heads/main' : `refs/remotes/origin/${branch}`;
        for (const { slug, wave } of board.waves) for (const item of wave.items) {
          const key = `${slug}/${item.id}`;
          if (['done', 'merged', 'dropped'].includes(String(item.status).toLowerCase()) || ['MERGED', 'CLOSED'].includes(prs[`${board.github || wave.repo}#${item.pr}`]?.state)) continue;
          try {
            const worktree = await installWorktree(board, key, manifest);
            if (!worktree) continue;
            const head = await git(worktree, 'rev-parse', 'HEAD');
            let ahead = 0;
            try { ahead = Number(await git(worktree, 'rev-list', '--count', `${ref}..HEAD`)); } catch {}
            const script = exists(scriptAt(worktree));
            const entry = state.cards[key] ||= {};
            Object.assign(entry, { head, ahead, script });
            persist(board);
            if (board.auto_build && script && ahead > 0 && (entry.sha || lastHeads.get(runKey(board, key))) !== head && entry.state !== 'running' && !starting.has(runKey(board, key))) {
              try { await start({ route: board.route, key }, { manifest }); }
              catch (e) {
                if ([409, 503].includes(e.status)) continue;
                update(board, key, { sha: head });
                await failure({ board, key, logFile: failureLog(board, key, e) }, 1);
                throw e;
              }
            }
          } catch (e) { log(`try /${board.route} ${key}: ${e.message}`); }
        }
        try {
          if (!source.repo) continue;
          const sha = await git(source.repo, 'rev-parse', ref);
          let script = false;
          try { await git(source.repo, 'cat-file', '-e', `${sha}:.kickflip/build`); script = true; } catch {}
          if (!script) {
            const run = runs.get(runKey(board, 'main'));
            if (run) await stopRun(run);
            state.main = null;
            persist(board);
            continue;
          }
          const entry = state.main;
          if (entry?.state === 'running' || (entry?.sha === sha && (entry.state === 'failed' || (entry.state === 'ready' && (state.kind !== 'web' || lookup(board.route, 'main', { manifest })))))) continue;
          const id = runKey(board, 'main');
          if (starting.has(id)) continue;
          const at = await git(source.repo, 'log', '-1', '--format=%cI', sha);
          let slug = board.github;
          if (!slug) { try { slug = githubFromOrigin(await git(source.repo, 'remote', 'get-url', 'origin')); } catch {} }
          const metadata = { sha, branch, slug: slug || '', at, script };
          starting.add(id);
          try {
            if (runs.has(id)) await stopRun(runs.get(id));
            const dir = path.join(os.homedir(), '.claude', 'kickflip', 'try', `${board.route}-main`);
            fs.mkdirSync(path.dirname(dir), { recursive: true });
            if (exists(dir)) await git(dir, 'checkout', '--detach', '--force', sha);
            else await git(source.repo, 'worktree', 'add', '--detach', dir, sha);
            await launch(board, 'main', dir, metadata);
          } catch (e) {
            if (e.status === 503) return;
            state.main = { ...metadata, state: 'failed' };
            failureLog(board, 'main', e);
            persist(board);
            throw e;
          } finally { starting.delete(id); }
        } catch (e) { log(`try /${board.route} main: ${e.message}`); }
      }
    })().finally(() => { ticking = null; });
    return ticking;
  }
  async function stop() {
    stopping = true;
    const stopped = Promise.all([...runs.values()].map(stopRun));
    await Promise.all([stopped, ticking]);
  }
  return { start, tick, stop, lookup, initialize: (manifest = readManifest()) => { for (const board of listBoards(manifest)) stateOf(board); } };
}

export async function fetchTryBranches({ manifest = readManifest(), log = console.log } = {}) {
  for (const board of listBoards(manifest)) {
    const source = boardRepo(board.route, manifest);
    if (source.hub || !source.repo) continue;
    const branch = source.branch || 'main';
    try { await git(source.repo, 'fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`); }
    catch (e) { log(`fetch /${board.route}: ${e.message}`); }
  }
}
const manager = createTryManager();
export const startBuild = (...args) => manager.start(...args);
export const tryTick = (...args) => manager.tick(...args);
export const stopTries = () => manager.stop();
export const servingTry = (...args) => manager.lookup(...args);
export const initializeTries = (...args) => manager.initialize(...args);
