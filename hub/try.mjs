import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { listBoards, readManifest, readJSON, saveJSON, GITHUB_STATE, REPO_FETCH } from './boards.mjs';
import { boardRepo, githubFromOrigin } from './board-repo.mjs';
import { gitReachFault, remoteFromInput, remoteGitEnv } from './repos.mjs';
import { readiness } from './readiness.mjs';
import { buildScriptError } from '../board/build-script.mjs';
import { appendThread, recordedWorktree, setItem } from '../board/store.mjs';

export class BuildError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const execFileAsync = promisify(execFile);
const git = async (dir, ...args) => (await execFileAsync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 3000 })).stdout.trim();
const KEYCHAIN = /errSecInternalComponent|keychain[^\n]*\blocked\b|\blocked\b[^\n]*keychain/i;
export const TRY_PORTS = { first: 8500, last: 8599 };
export const isTryPort = (port) => /^\d+$/.test(String(port)) && Number(port) >= TRY_PORTS.first && Number(port) <= TRY_PORTS.last;
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

export function createTryManager({ now = Date.now, answers = probe, log = console.log, waiting = async () => null } = {}) {
  const boards = new Map();
  const runs = new Map();
  const starting = new Set();
  const interrupted = new Set();
  const cardPorts = new Map();
  const mainPorts = new Map();
  const lastHeads = new Map();
  let stopping = false;
  let ticking = null;
  let initializing = null;
  const stamp = () => new Date(now()).toISOString();
  function stateOf(board) {
    if (boards.has(board.dir)) return boards.get(board.dir);
    const file = path.join(board.dir, 'data', 'try.json');
    const saved = readJSON(file, { kind: null, main: null, cards: {} });
    const state = { ...(isTryPort(saved.main_port) ? { main_port: saved.main_port } : {}), kind: saved.kind || null, main: saved.main || null, cards: { ...saved.cards } };
    const record = { state, file, written: JSON.stringify(saved) };
    boards.set(board.dir, record);
    if (state.main_port) mainPorts.set(board.dir, state.main_port);
    const unfinished = Object.entries(state.cards).filter(([, card]) => card.state === 'running');
    for (const [key] of unfinished) interrupted.add(runKey(board, key));
    if (state.kind === 'web') {
      state.cards = Object.fromEntries(unfinished);
      if (state.main && state.main.state !== 'failed') { delete state.main.state; delete state.main.port; delete state.main.https; }
    } else if (state.main?.state === 'running') { delete state.main.state; delete state.main.sha; }
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
  function reserveMains(manifest) {
    const sites = [...Object.values(manifest?.sites || {}), ...Object.values(manifest?.closed || {}).map((entry) => entry.site)];
    for (const site of sites) {
      if (!site?.dir) continue;
      const port = readJSON(path.join(site.dir, 'data', 'try.json'), {}).main_port;
      if (isTryPort(port)) mainPorts.set(site.dir, Number(port));
    }
  }
  function publicPort(run) {
    const { board, key } = run;
    const id = runKey(board, key);
    const held = key === 'main' ? mainPorts.get(board.dir) : cardPorts.get(id);
    if (held) return held;
    const used = new Set([...mainPorts.values(), ...cardPorts.values()]);
    let port = TRY_PORTS.first;
    while (used.has(port) && port <= TRY_PORTS.last) port++;
    if (port > TRY_PORTS.last) throw new Error(`No try ports available (${TRY_PORTS.first}–${TRY_PORTS.last}). Stop a served card and retry.`);
    if (key === 'main') {
      mainPorts.set(board.dir, port);
      stateOf(board).state.main_port = port;
      persist(board);
    } else cardPorts.set(id, port);
    return port;
  }
  const tailscale = (args) => execFileAsync('tailscale', args, { encoding: 'utf8', timeout: 10_000 });
  async function removePort(port) {
    try { await tailscale(['serve', `--https=${port}`, 'off']); }
    catch (e) { log(`try port ${port}: could not close port: ${(e.stderr || e.message).trim()}`); }
  }
  async function openPort(run) {
    run.https = publicPort(run);
    const sockets = run.sockets = new Set();
    const visit = () => { run.visited = now(); };
    run.relay = net.createServer((socket) => {
      visit();
      const up = net.connect(run.port, '127.0.0.1');
      for (const peer of [socket, up]) {
        sockets.add(peer);
        peer.on('data', visit);
        peer.on('error', () => { socket.destroy(); up.destroy(); });
        peer.on('close', () => { sockets.delete(peer); socket.destroy(); up.destroy(); });
      }
      socket.pipe(up); up.pipe(socket);
    });
    await new Promise((resolve, reject) => {
      run.relay.once('error', reject);
      run.relay.listen(0, '127.0.0.1', resolve);
    });
    if (run.stopped) return;
    run.exposed = true;
    try { await tailscale(['serve', '--bg', `--https=${run.https}`, `http://127.0.0.1:${run.relay.address().port}`]); }
    catch (e) { throw new Error(`Couldn't open try port ${run.https}: ${(e.stderr || e.message).trim()}`); }
  }
  async function closePort(run) {
    await run.opening?.catch(() => {});
    if (run.exposed) await removePort(run.https);
    if (run.relay) {
      for (const socket of run.sockets) socket.destroy();
      await new Promise((resolve) => run.relay.close(resolve));
    }
    if (!run.keepPort) cardPorts.delete(runKey(run.board, run.key));
  }
  function initialize(manifest = readManifest()) {
    if (initializing) return initializing;
    reserveMains(manifest);
    for (const board of listBoards(manifest)) stateOf(board);
    initializing = (async () => {
      try {
        const { stdout } = await tailscale(['serve', 'status', '--json']);
        const status = JSON.parse(stdout);
        for (const port of Object.keys(status?.TCP || {})) {
          if (isTryPort(port) && ![...runs.values()].some((run) => run.https === Number(port))) await removePort(port);
        }
      } catch (e) { log(`try startup cleanup: ${(e.stderr || e.message).trim()}`); }
    })();
    return initializing;
  }
  async function failure(run, code, signal, error) {
    const { board, key } = run;
    update(board, key, { state: 'failed', port: undefined, https: undefined });
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
  async function halt(run, keepPort = false) {
    run.keepPort = keepPort;
    run.stopped = true;
    clearTimeout(run.deadline);
    clearInterval(run.poll);
    await terminate(run);
    await run.done;
  }
  async function stopRun(run, keepPort = false) {
    await halt(run, keepPort);
    update(run.board, run.key, { state: undefined, port: undefined, https: undefined, ...(!run.ready ? { sha: undefined } : {}) });
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
    delete entry.https;
    const logFile = logFileOf(board, key);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const fd = fs.openSync(logFile, 'w', 0o600);
    fs.fchmodSync(fd, 0o600);
    const child = spawn(script, [key, worktree], { cwd: worktree, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, KICKFLIP_BOARD: board.route } });
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
            run.opening = openPort(run);
            await run.opening;
            if (run.stopped || failed || child.exitCode !== null || child.signalCode !== null) return;
            run.ready = true;
            run.visited = now();
            state.kind = 'web';
            update(board, key, { state: 'ready', port, https: run.https });
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
        await closePort(run);
        run.finished = true;
        if (run.stopped) return;
        if (failed || spawnError || code !== 0 || (run.port && !run.ready)) await failure(run, code ?? 1, signal, failed || spawnError || (run.port && !run.ready ? new Error('Build script exited before its port answered.') : null));
        else if (run.ready) {
          if (key === 'main') { delete state.main.state; delete state.main.port; delete state.main.https; }
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
  async function launchMain(board, repo, metadata) {
    const id = runKey(board, 'main');
    if (starting.has(id)) throw new BuildError('A build is already running for main.', 409);
    starting.add(id);
    try {
      if (runs.has(id)) await stopRun(runs.get(id), true);
      const dir = path.join(os.homedir(), '.claude', 'kickflip', 'try', `${board.route}-main`);
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      if (exists(dir)) await git(dir, 'checkout', '--detach', '--force', metadata.sha);
      else {
        await git(repo, 'worktree', 'prune');
        await git(repo, 'worktree', 'add', '--detach', dir, metadata.sha);
      }
      return await launch(board, 'main', dir, metadata);
    } catch (e) {
      if (e.status !== 503) {
        stateOf(board).state.main = { ...metadata, state: 'failed' };
        failureLog(board, 'main', e);
        persist(board);
      }
      throw e;
    } finally { starting.delete(id); }
  }
  async function start(input, { manifest = readManifest() } = {}) {
    await initialize(manifest);
    reserveMains(manifest);
    if (stopping) throw new BuildError('The hub is stopping. Try again after it restarts.', 503);
    if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).some((k) => !['route', 'key'].includes(k))
      || typeof input.route !== 'string' || typeof input.key !== 'string') throw new BuildError('Send only the board route and card key.');
    const { route, key } = input;
    if (key !== 'main' && (!/^[\w.-]+\/[\w.-]+$/.test(key) || key.split('/').some((s) => s === '.' || s === '..'))) throw new BuildError('Card key must be <wave>/<id>.');
    const board = listBoards(manifest).find((b) => b.route === route);
    if (!board) throw new BuildError(`/${route} is not a board.`, 404);
    if (key !== 'main' && !board.waves.some(({ slug, wave }) => wave.items.some((it) => `${slug}/${it.id}` === key))) throw new BuildError('There is no item with this card key.', 404);
    const reason = await waiting();
    if (reason) throw new BuildError(reason, 409);
    const id = runKey(board, key);
    const current = runs.get(id);
    if (starting.has(id) || (current && !current.ready && !current.finished)) throw new BuildError(`A build is already running for ${key === 'main' ? 'main' : 'this card'}.`, 409);
    if (key === 'main') {
      const entry = stateOf(board).state.main;
      if (entry?.state === 'running') throw new BuildError('A build is already running for main.', 409);
      if (entry?.state !== 'failed' || !entry.sha) throw new BuildError('Main has no failed build to retry.', 409);
      const { sha, branch, slug, at, script } = entry;
      return launchMain(board, boardRepo(route, manifest).repo, { sha, branch, slug, at, script });
    }
    starting.add(id);
    const resuming = interrupted.delete(id);
    try {
      if (runs.has(id)) await stopRun(runs.get(id), true);
      const worktree = await installWorktree(board, key, manifest);
      return await launch(board, key, worktree);
    } catch (e) {
      cardPorts.delete(id);
      if (resuming && e.status !== 503) update(board, key, { state: undefined, sha: undefined });
      throw e;
    }
    finally { starting.delete(id); }
  }
  function lookup(route, id, { manifest = readManifest() } = {}) {
    const board = listBoards(manifest).find((b) => b.route === route);
    if (!board) return null;
    const run = [...runs.values()].find((r) => r.board.dir === board.dir && r.key.split('/').at(-1).toLowerCase() === id.toLowerCase() && r.ready && !r.stopped && r.child.exitCode === null && r.child.signalCode === null);
    if (!run) return null;
    return { key: run.key, port: run.port };
  }
  async function tick({ manifest = readManifest() } = {}) {
    await initialize(manifest);
    reserveMains(manifest);
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
        const ref = source.local ? 'refs/heads/main' : `refs/remotes/origin/${branch}`;
        for (const { slug, wave } of board.waves) for (const item of wave.items) {
          const key = `${slug}/${item.id}`;
          if (['done', 'merged', 'dropped'].includes(String(item.status).toLowerCase()) || ['MERGED', 'CLOSED'].includes(prs[`${board.github || wave.repo}#${item.pr}`]?.state)) continue;
          try {
            const id = runKey(board, key);
            const worktree = await installWorktree(board, key, manifest);
            if (worktree) {
              const head = await git(worktree, 'rev-parse', 'HEAD');
              let ahead = 0;
              try { ahead = Number(await git(worktree, 'rev-list', '--count', `${ref}..HEAD`)); } catch {}
              Object.assign(state.cards[key] ||= {}, { head, ahead, script: exists(scriptAt(worktree)) });
              persist(board);
            } else if (!interrupted.has(id)) continue;
            const entry = state.cards[key];
            const wanted = interrupted.has(id)
              || (board.auto_build && entry.script && entry.ahead > 0 && (entry.sha || lastHeads.get(id)) !== entry.head && entry.state !== 'running');
            if (wanted && !starting.has(id)) {
              try { await start({ route: board.route, key }, { manifest }); }
              catch (e) {
                if ([409, 503].includes(e.status)) continue;
                update(board, key, { sha: entry.head });
                await failure({ board, key, logFile: failureLog(board, key, e) }, 1);
                throw e;
              }
            }
          } catch (e) { log(`try /${board.route} ${key}: ${e.message}`); }
        }
        try {
          if (!source.repo || await waiting()) continue;
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
          await launchMain(board, source.repo, metadata);
        } catch (e) { log(`try /${board.route} main: ${e.message}`); }
      }
    })().finally(() => { ticking = null; });
    return ticking;
  }
  async function stop() {
    stopping = true;
    // A build still going keeps `running`, so the next hub starts it again (docs/adr/0119-a-build-the-hub-stops-starts-again-after-it-restarts.md).
    const stopped = Promise.all([...runs.values()].map((run) => run.ready ? stopRun(run) : halt(run)));
    await Promise.all([stopped, ticking]);
  }
  return { start, tick, stop, lookup, initialize };
}

// A remote board's git, with git's own credential and its prompts off (repos.mjs remoteGitEnv).
const remoteGit = async (dir, ...args) => (await execFileAsync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 10_000, env: remoteGitEnv() })).stdout;

// Fetches the branch of each board that isn't local (board-repo.mjs boardRepo) and writes REPO_FETCH {<route>: {at, ok, error?, hint?}} for the boards it
// fetched, which boards.mjs linksOf reads as each board's repo-fetch link. On a board whose repo is a plain git
// remote, it then moves each pushed card to Done once its branch is merged or gone (settlePushed).
export async function fetchTryBranches({ manifest = readManifest(), log = console.log } = {}) {
  const fetched = {};
  for (const board of listBoards(manifest)) {
    const source = boardRepo(board.route, manifest);
    if (source.local || !source.repo) continue;
    const branch = source.branch || 'main';
    const at = new Date().toISOString();
    try {
      const refspec = `+refs/heads/${branch}:refs/remotes/origin/${branch}`;
      if (board.remote) await remoteGit(source.repo, 'fetch', '--quiet', '--no-tags', 'origin', refspec);
      else await git(source.repo, 'fetch', '--quiet', '--no-tags', 'origin', refspec);
      fetched[board.route] = { at, ok: true };
    } catch (e) {
      log(`fetch /${board.route}: ${e.message}`);
      let github = board.github;
      if (!github && !board.remote) { try { github = githubFromOrigin(await git(source.repo, 'remote', 'get-url', 'origin')); } catch {} }
      fetched[board.route] = { at, ok: false, ...gitReachFault(e.killed ? 'git fetch timed out' : e.stderr, { github: github || '', remote: board.remote, repo: source.repo }) };
      continue;
    }
    if (board.remote) {
      try { await settlePushed(board, source.repo, branch, log); }
      catch (e) { log(`pushed branches /${board.route}: ${e.message}`); }
    }
  }
  saveJSON(REPO_FETCH, fetched);
}

// docs/adr/0127-a-board-can-work-on-any-git-remote.md: a pushed card (board.mjs item set --pushed) is Done once its
// branch's tip is in the board's branch, as merged, or once the branch is gone from the remote, as merged when its last
// known tip is in the board's branch and done otherwise, since a squash merge leaves no trace of the branch.
async function settlePushed(board, repo, branch, log) {
  const open = board.waves.flatMap(({ slug, wave }) => wave.items
    .filter((it) => it.pushed?.branch && !it.pr && !['done', 'merged', 'dropped'].includes(String(it.status).toLowerCase()))
    .map((it) => ({ key: `${slug}/${it.id}`, branch: it.pushed.branch })));
  if (!open.length) return;
  const heads = new Map((await remoteGit(repo, 'ls-remote', '--heads', 'origin')).split('\n')
    .map((line) => /^([\da-f]+)\trefs\/heads\/(.+)$/.exec(line)).filter(Boolean).map((m) => [m[2], m[1]]));
  const host = remoteFromInput(board.remote)?.host || 'the remote';
  for (const card of open) {
    let tip = heads.get(card.branch);
    if (!tip) { try { tip = await git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${card.branch}^{commit}`); } catch {} }
    let merged = false;
    if (tip) { try { await git(repo, 'merge-base', '--is-ancestor', tip, `refs/remotes/origin/${branch}`); merged = true; } catch {} }
    if (!merged && heads.has(card.branch)) continue;
    try {
      await setItem(board.dir, card.key, { status: merged ? 'merged' : 'done', force: true, text: merged ? `${card.branch} is merged into ${branch} on ${host}, so this card is Done.`
        : `${card.branch} is gone from ${host}, so this card is Done.` });
    } catch (e) { log(`pushed ${card.key}: ${e.message}`); }
  }
}
const manager = createTryManager({ waiting: () => readiness.waiting('tailscale') });
export const startBuild = (...args) => manager.start(...args);
export const tryTick = (...args) => manager.tick(...args);
export const stopTries = () => manager.stop();
export const initializeTries = (...args) => manager.initialize(...args);
