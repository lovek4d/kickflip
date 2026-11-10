import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { listBoards, readManifest, readJSON, saveJSON, appendEvent, GITHUB_STATE, REPO_FETCH } from './boards.mjs';
import { boardRepo, githubFromOrigin, mainRefOf } from './board-repo.mjs';
import { gitReachFault, remoteFromInput, remoteGitEnv } from './repos.mjs';
import { readiness } from './readiness.mjs';
import { tailscaleBin } from '../shared/tailscale.mjs';
import { buildScriptError, buildScriptOf } from '../board/build-script.mjs';
import { appendStatus, recordedWorktree, servedRoundsOpen, setItem } from '../board/store.mjs';
import { BASE_KEY, baseWorktreeOf } from '../board/prototype-base.mjs';
import { cardPRs, hasPR, prKeyOf } from '../shared/card-prs.mjs';
import { hubGate } from '../board/on-host.mjs';
import { pipeUpgrade, refuse, refuseUpgrade } from './front-door.mjs';
import { shareOf } from './share.mjs';

export class BuildError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const execFileAsync = promisify(execFile);
const git = async (dir, ...args) => (await execFileAsync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 3000 })).stdout.trim();
const KEYCHAIN = /errSecInternalComponent|keychain[^\n]*\blocked\b|\blocked\b[^\n]*keychain/i;
export const TRY_PORTS = { first: 8500, last: 8599 };
export const isTryPort = (port) => /^\d+$/.test(String(port)) && Number(port) >= TRY_PORTS.first && Number(port) <= TRY_PORTS.last;
const IDLE_MS = 30 * 60_000;
// What tailscale serve adds to say who a request is from; the try relay drops them before the app.
const IDENTITY_HEADERS = ['tailscale-user-login', 'tailscale-user-name', 'tailscale-user-profile-pic', 'x-forwarded-for'];
// What stops a page from being framed by the board, which is another origin on the same host.
const FRAME_HEADERS = ['x-frame-options'];
const withoutFraming = (headers) => {
  const kept = Object.fromEntries(Object.entries(headers).filter(([name]) => !FRAME_HEADERS.includes(name)));
  if (typeof kept['content-security-policy'] === 'string') {
    const policy = kept['content-security-policy'].split(';').filter((part) => !/^\s*frame-ancestors\b/i.test(part)).join(';').trim();
    if (policy) kept['content-security-policy'] = policy; else delete kept['content-security-policy'];
  }
  return kept;
};
// Main and the board's base prototype worktree (docs/adr/2026-11-06-1500-a-prototype-round-is-a-page-in-the-boards-base-worktree.md)
// are no card: each keeps its own entry in try.json, posts no thread line and never idles out.
const OWN_ENTRY = { main: 'main', [BASE_KEY]: 'prototypes' };
const isCard = (key) => !Object.hasOwn(OWN_ENTRY, key);
const scriptAt = (dir, target) => path.join(dir, buildScriptOf(target));
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
const signalGroup = (pgid, signal) => { try { process.kill(-pgid, signal); } catch {} };
const groupUp = (pgid) => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
// SIGTERM to a process group, SIGKILL after 4s, then up to 1s more until the kernel has removed it.
const endGroup = (pgid) => new Promise((resolve) => {
  const finish = () => { clearTimeout(timer); clearInterval(check); resolve(); };
  signalGroup(pgid, 'SIGTERM');
  let timer = setTimeout(() => { signalGroup(pgid, 'SIGKILL'); timer = setTimeout(finish, 1000); }, 4000);
  const check = setInterval(() => { if (!groupUp(pgid)) finish(); }, 20);
});
// The pids of a process group, each with its command and its working directory.
async function groupMembers(pgid) {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,pgid=,command='], { encoding: 'utf8', timeout: 5000 });
  const members = stdout.split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter((m) => m && Number(m[2]) === pgid)
    .map((m) => ({ pid: m[1], command: m[3], cwd: '' }));
  if (!members.length) return members;
  await readCwds(members, ['-a', '-d', 'cwd', '-Fpn', '-p', members.map((m) => m.pid).join(',')]);
  return members;
}
// Fills each process's cwd from lsof; lsof exits 1 when it can't read some process, so its output is read either way.
async function readCwds(processes, args) {
  let out = '';
  try { out = (await execFileAsync('lsof', args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 * 1024 })).stdout; }
  catch (e) { out = e.stdout || ''; }
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  let current;
  for (const line of out.split('\n')) {
    if (line[0] === 'p') current = byPid.get(line.slice(1));
    else if (line[0] === 'n' && current) current.cwd = line.slice(1);
  }
}
// Every process whose working directory or command line is inside dir, each with its process group.
async function processesIn(dir) {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,pgid=,command='], { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 * 1024 });
  const all = stdout.split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean)
    .map((m) => ({ pid: m[1], pgid: Number(m[2]), command: m[3], cwd: '' }));
  await readCwds(all, ['-d', 'cwd', '-Fpn']);
  return all.filter((p) => inWorktree(p, dir));
}
const insideDir = (value, dir) => value === dir || value.startsWith(dir + path.sep);
const inWorktree = (member, worktree) => insideDir(member.cwd, worktree) || member.command.includes(worktree + path.sep) || member.command.endsWith(worktree);

export async function installWorktree(board, key, manifest) {
  const record = await recordedWorktree(board.dir, key);
  const [slug, id] = key.split('/');
  const itemFile = board.files.find((w) => w.slug === slug)?.itemFile;
  const candidate = record?.path || itemFile?.items.find((it) => it.id === id)?.worktree;
  if (typeof candidate !== 'string' || !candidate || candidate.split(path.sep).includes('..')) return '';
  let repo = record?.repo;
  const github = (board.github || itemFile?.repo || '').toLowerCase();
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

export function createTryManager({ now = Date.now, answers = probe, lingers = probe, log = console.log, waiting = async () => null, event = appendEvent, gate = hubGate } = {}) {
  const boards = new Map();
  const runs = new Map();
  // Main's old run, still serving its port while its successor builds: board.dir → run
  // (docs/adr/2026-11-09-1815-a-main-re-serve-keeps-the-old-server-up-until-the-new-one-answers.md).
  const serving = new Map();
  const live = () => [...runs.values(), ...serving.values()];
  const starting = new Set();
  const interrupted = new Set();
  const cardPorts = new Map();
  const mainPorts = new Map();
  const lastHeads = new Map();
  const pulls = new Map();
  let stopping = false;
  let ticking = null;
  let queued = null;
  let initializing = null;
  const stamp = () => new Date(now()).toISOString();
  function stateOf(board) {
    if (boards.has(board.dir)) return boards.get(board.dir);
    const file = path.join(board.dir, 'data', 'try.json');
    const saved = readJSON(file, { kind: null, main: null, cards: {} });
    const state = { ...(Array.isArray(saved.groups) && saved.groups.length ? { groups: saved.groups } : {}), ...(isTryPort(saved.main_port) ? { main_port: saved.main_port } : {}), kind: saved.kind || null, main: saved.main || null, cards: { ...saved.cards },
      ...(saved.pull ? { pull: { ...saved.pull, running: undefined } } : {}) };
    const record = { state, file, written: JSON.stringify(saved) };
    boards.set(board.dir, record);
    if (state.main_port) mainPorts.set(board.dir, state.main_port);
    const unfinished = Object.entries(state.cards).filter(([, card]) => card.state === 'running');
    for (const [key] of unfinished) interrupted.add(runKey(board, key));
    if (state.kind === 'web') {
      state.cards = Object.fromEntries(unfinished);
      if (state.main && state.main.state !== 'failed') { delete state.main.state; delete state.main.port; delete state.main.https; }
    } else if (state.main?.state === 'running') { delete state.main.state; delete state.main.sha; }
    // A hub stops every server it started, so no old Main server outlives it.
    if (state.main) delete state.main.serving;
    // The next tick serves the base worktree again; a failure stays until Try again.
    if (saved.prototypes?.state === 'failed') state.prototypes = saved.prototypes;
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
  // Each live run's process group, so a hub that died hard can stop what it left running at its next startup.
  function recordGroup(run) {
    const { state } = stateOf(run.board);
    run.group = { pgid: run.child.pid, key: run.key, worktree: run.worktree };
    (state.groups ||= []).push(run.group);
    persist(run.board);
  }
  function forgetGroup(run) {
    const { state } = stateOf(run.board);
    if (!state.groups?.includes(run.group)) return;
    state.groups = state.groups.filter((group) => group !== run.group);
    if (!state.groups.length) delete state.groups;
    persist(run.board);
  }
  // Stops each recorded group still running its script: a leftover of a hub that died before it stopped its tries.
  async function sweepGroups(board) {
    const { state } = stateOf(board);
    const recorded = state.groups || [];
    delete state.groups;
    persist(board);
    for (const group of recorded) {
      if (!groupUp(group.pgid)) continue;
      let members = [];
      try { members = await groupMembers(group.pgid); } catch (e) { log(`try startup sweep: could not read group ${group.pgid}: ${e.message}`); }
      if (!members.some((member) => inWorktree(member, group.worktree))) continue;
      await endGroup(group.pgid);
      log(`stopped leftover try /${board.route} ${group.key} (pgid ${group.pgid})`);
      await checkQuiet(board, group.key, group.port);
    }
  }
  // After a stop, a port that still answers is a server outside the stopped group: a red fault on the card, else the log.
  async function checkQuiet(board, key, port) {
    if (!port || !await lingers(port)) return;
    const message = `Port ${port} still answers after the run was stopped.`;
    if (isCard(key)) await appendStatus(board.dir, key, 'run-failed', { kind: 'Serve', code: 1, why: message }).catch((e) => log(`build /${board.route} ${key}: ${e.message}`));
    log(`build /${board.route} ${key}: ${message}`);
  }
  const runKey = (board, key) => `${board.dir}\0${key}`;
  const entryOf = (state, key) => isCard(key) ? state.cards[key] : state[OWN_ENTRY[key]];
  const setEntry = (state, key, entry) => { if (isCard(key)) state.cards[key] = entry; else state[OWN_ENTRY[key]] = entry; };
  const dropEntry = (state, key) => { if (isCard(key)) delete state.cards[key]; else state[OWN_ENTRY[key]] = null; };
  function update(board, key, change) {
    const { state } = stateOf(board);
    const entry = entryOf(state, key);
    if (!entry) return;
    const changedState = Object.hasOwn(change, 'state') && change.state !== entry.state;
    Object.assign(entry, change, isCard(key) && changedState ? { at: stamp() } : {});
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
  const tailscale = async (args) => {
    const bin = tailscaleBin();
    if (!bin) throw new Error("Tailscale isn't installed on this host");
    return execFileAsync(bin, args, { encoding: 'utf8', timeout: 10_000 });
  };
  async function removePort(port) {
    try { await tailscale(['serve', `--https=${port}`, 'off']); }
    catch (e) { log(`try port ${port}: could not close port: ${(e.stderr || e.message).trim()}`); }
  }
  // The relay's verdict: the gate's, except that a login the run's board shares with is 'shared' by GET or HEAD, and any
  // other method of theirs, or an upgrade, is view only (docs/adr/2026-11-05-2215-a-board-is-shared-view-only-with-a-tailscale-login.md).
  const sharedWith = (board) => shareOf(readJSON(path.join(board.dir, 'board.json'), {}));
  async function relayVerdict(req, board) {
    const verdict = await gate(req);
    const login = req.headers['tailscale-user-login'];
    if (verdict !== 'other' || !login || !sharedWith(board).includes(login)) return verdict;
    return req.method === 'GET' || req.method === 'HEAD' ? 'shared' : 'view-only';
  }
  // A shared login's responses still open, ended once the board no longer shares with it; run.shared: Set of {login, res}.
  function endUnshared() {
    for (const run of live()) {
      if (!run.shared?.size) continue;
      const logins = sharedWith(run.board);
      for (const open of run.shared) if (!logins.includes(open.login)) { run.shared.delete(open); open.res.destroy(); }
    }
  }
  async function openPort(run) {
    run.https = publicPort(run);
    const sockets = run.sockets = new Set();
    const visit = () => { run.visited = now(); };
    const track = (socket) => {
      sockets.add(socket);
      socket.on('data', visit);
      socket.on('close', () => sockets.delete(socket));
    };
    // tailscale serve proxies the port as HTTP, so the relay reads each request's login and lets only the owner and the
    // board's shared logins through. It has judged the visitor, so the app gets the request as a direct loopback caller's,
    // without tailscale serve's identity headers: a demo hub behind it with its own owner gate passes it, where it would
    // ask its own, stubbed, tailscale who the login is and answer 503
    // (docs/adr/2026-11-06-1531-try-ports-stay-served-across-a-hub-restart-and-the-relay-hides-who-asked.md).
    const shared = run.shared = new Set();
    run.relay = http.createServer(async (req, res) => {
      const verdict = await relayVerdict(req, run.board);
      if (verdict !== 'owner' && verdict !== 'shared') { refuse(req, res, verdict); return; }
      if (verdict === 'shared') {
        const open = { login: req.headers['tailscale-user-login'], res };
        shared.add(open);
        res.on('close', () => shared.delete(open));
      }
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !IDENTITY_HEADERS.includes(name)));
      const up = http.request({ host: '127.0.0.1', port: run.port, method: req.method, path: req.url, headers }, (answer) => {
        // The prototype serve is framed by the board's own page, so its answers lose the headers that refuse a frame.
        res.writeHead(answer.statusCode, run.key === BASE_KEY ? withoutFraming(answer.headers) : answer.headers);
        answer.on('data', visit);
        answer.pipe(res);
        answer.on('close', () => { if (!answer.complete) res.destroy(); });
      });
      res.on('close', () => { if (!res.writableFinished) up.destroy(); });
      up.on('error', () => { if (res.headersSent) res.destroy(); else res.writeHead(502).end(); });
      req.pipe(up);
    });
    run.relay.on('connection', (socket) => { visit(); track(socket); });
    run.relay.on('upgrade', async (req, socket, head) => {
      const verdict = await relayVerdict(req, run.board);
      if (verdict !== 'owner') { refuseUpgrade(socket, verdict === 'shared' ? 'view-only' : verdict); return; }
      track(pipeUpgrade({ req, socket, head, port: run.port, path: req.url, replace: IDENTITY_HEADERS }));
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
    run.closing = true;
    await run.opening?.catch(() => {});
    // A stopping hub leaves its try ports mapped: the next hub starts before this one has exited, re-serves the same fixed
    // ports, and its startup sweep removes any no run claims. Main's old run leaves the port its successor now maps.
    const handedOver = [...runs.values()].some((other) => other !== run && other.exposed && other.https === run.https);
    if (run.exposed && !stopping && !handedOver) await removePort(run.https);
    if (run.relay) {
      for (const socket of run.sockets) socket.destroy();
      await new Promise((resolve) => run.relay.close(resolve));
    }
    if (!run.keepPort) cardPorts.delete(runKey(run.board, run.key));
  }
  // A try port's mapping can still go missing outside this hub, so each tick serves again any open port whose mapping
  // isn't its relay.
  async function reserve() {
    const open = live().filter((run) => run.ready && run.relay && !run.closing);
    if (!open.length) return;
    let config;
    try { config = JSON.parse((await tailscale(['serve', 'status', '--json'])).stdout); }
    catch (e) { log(`try ports check: ${(e.stderr || e.message).trim()}`); return; }
    for (const run of open) {
      // A run stopped while the status was read, such as Main's old run once its successor took the port, keeps no mapping.
      if (run.stopped) continue;
      const relay = `http://127.0.0.1:${run.relay.address().port}`;
      const web = Object.entries(config?.Web || {}).find(([host]) => host.endsWith(`:${run.https}`))?.[1];
      if (web?.Handlers?.['/']?.Proxy === relay) continue;
      log(`try port ${run.https}: its serve mapping was ${web ? 'changed' : 'gone'}; serving it again`);
      try { await tailscale(['serve', '--bg', `--https=${run.https}`, relay]); }
      catch (e) { log(`try port ${run.https}: could not serve it again: ${(e.stderr || e.message).trim()}`); }
    }
  }
  function initialize(manifest = readManifest()) {
    if (initializing) return initializing;
    reserveMains(manifest);
    for (const board of listBoards(manifest)) stateOf(board);
    initializing = (async () => {
      for (const board of listBoards(manifest)) await sweepGroups(board).catch((e) => log(`try startup sweep /${board.route}: ${e.message}`));
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
    if (!isCard(key)) return;
    // The thread's status line names one reason: the keychain, the error, the signal, else the log's last line.
    let last = '';
    let keychain = false;
    try {
      for await (const line of createInterface({ input: fs.createReadStream(run.logFile), crlfDelay: Infinity })) {
        keychain ||= KEYCHAIN.test(line);
        if (line.trim()) last = line;
      }
    } catch (e) { last = `could not read the build log: ${e.message}`; }
    const kind = run.port || (stateOf(board).state.kind || (board.files.some(({ itemFile }) => itemFile.items.some((it) => it.install?.url)) ? 'app' : 'web')) === 'web' ? 'Serve' : 'Build';
    const why = keychain ? 'unlock the login keychain on the host' : error?.message || (signal && `stopped by ${signal}`) || last;
    await appendStatus(board.dir, key, 'run-failed', { kind, code: code ?? 1, why });
  }
  function terminate(run) {
    if (run.ending) return run.ending;
    run.ending = endGroup(run.child.pid);
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
  async function launch(board, key, worktree, metadata = {}, preface = '') {
    if (!worktree) throw new BuildError('This card has no valid worktree.');
    const script = scriptAt(worktree, board.build_target);
    const error = buildScriptError(script);
    if (error) throw new BuildError(error);
    if (!fs.realpathSync(script).startsWith(fs.realpathSync(worktree) + path.sep)) throw new BuildError('Build script must be inside the worktree.');
    const sha = await git(worktree, 'rev-parse', 'HEAD');
    if (stopping) throw new BuildError('The hub is stopping. Try again after it restarts.', 503);
    const { state } = stateOf(board);
    const previous = entryOf(state, key);
    // since: when the base serve's run started, so a viewer tells a new run from the one it framed.
    const entry = { ...(isCard(key) ? previous : {}), ...metadata, sha, script: true, state: 'running', ...(isCard(key) ? { at: stamp(), head: sha } : {}), ...(key === BASE_KEY ? { since: stamp() } : {}) };
    delete entry.port;
    delete entry.https;
    const logFile = logFileOf(board, key);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const fd = fs.openSync(logFile, 'w', 0o600);
    fs.fchmodSync(fd, 0o600);
    if (preface) fs.writeSync(fd, preface);
    const child = spawn(script, [key, worktree], { cwd: worktree, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, KICKFLIP_BOARD: board.route, HOST: '127.0.0.1' } });
    setEntry(state, key, entry);
    const id = runKey(board, key);
    const run = { child, board, key, worktree, sha, at: metadata.at, metadata, logFile, visited: now(), stopped: false, port: null, ready: false };
    recordGroup(run);
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
      run.group.port = port;
      persist(board);
      clearTimeout(run.deadline);
      let until;
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
            if (key === 'main') await retire(board);
          } else if (now() >= until) fail('Nothing answered on the build script’s port within 60 seconds.');
        } finally { probing = false; }
      };
      const probeFrom = () => {
        if (run.stopped) return;
        until = now() + 60_000;
        run.poll = setInterval(() => check().catch((e) => fail(e.message)), 250);
        check().catch((e) => fail(e.message));
      };
      // A build on Main's old server's port can't overlap it: the old server stops first, so the probe hears the new one.
      if (key === 'main' && serving.get(board.dir)?.port === port) retire(board).then(probeFrom, (e) => fail(e.message));
      else probeFrom();
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
        forgetGroup(run);
        if (!stopping) await checkQuiet(board, key, run.port);
        run.finished = true;
        if (run.stopped) return;
        if (serving.get(board.dir) === run) {
          serving.delete(board.dir);
          update(board, key, { serving: undefined });
          return;
        }
        if (key === 'main' && !run.ready && serving.has(board.dir) && !stopping) {
          await handOverFailed(run);
          return;
        }
        // The prototype site is a web page, so a script that ends without serving one failed.
        const unserved = key === BASE_KEY && !run.port ? new Error('Build script exited without printing "port <n>".') : null;
        if (failed || spawnError || code !== 0 || (run.port && !run.ready) || unserved) await failure(run, code ?? 1, signal, failed || spawnError || (run.port && !run.ready ? new Error('Build script exited before its port answered.') : unserved));
        else if (run.ready) {
          if (key === 'main') { delete state.main.state; delete state.main.port; delete state.main.https; }
          else dropEntry(state, key);
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
  // Stops Main's old run: once its successor holds the port, or before a successor that printed the old run's port.
  async function retire(board) {
    const old = serving.get(board.dir);
    if (!old) return;
    serving.delete(board.dir);
    update(board, 'main', { serving: undefined });
    await halt(old);
  }
  // A Main serve that exits before answering while the old run serves may have been refused by it, as next dev refuses a
  // second dev server for a project: the old run stops and the serve runs once more in the same worktree
  // (docs/adr/2026-11-10-0108-main-serves-again-after-the-pair-update.md).
  async function handOverFailed(run) {
    const { board, worktree } = run;
    await retire(board);
    log(`try /${board.route} main: the new serve exited before answering while the old one served; stopped the old serve and serving again in ${worktree}`);
    const { serving: _old, ...metadata } = run.metadata;
    try { await launch(board, 'main', worktree, metadata, 'The new serve exited before answering while the old one served; stopped the old serve and serving again.\n'); }
    catch (e) { mainFailed(board, metadata, e); }
  }
  function mainFailed(board, metadata, error) {
    if (error.status === 503) return;
    stateOf(board).state.main = { ...metadata, state: 'failed' };
    failureLog(board, 'main', error);
    persist(board);
  }
  // The single Main worktree of a hub from before the alternating pair: every process in it stops, as a sweep stops a
  // leftover group, then it is removed, by git or else by hand. Nothing here fails the launch; each step logs.
  async function removeLegacyMain(board, repo, dir) {
    const prefix = `try /${board.route} main:`;
    try {
      const found = await processesIn(dir);
      for (const pgid of new Set(found.map((p) => p.pgid))) {
        await endGroup(pgid);
        for (const p of found.filter((p) => p.pgid === pgid)) log(`${prefix} stopped pid ${p.pid} (pgid ${pgid}) in the old main worktree ${dir}`);
      }
    } catch (e) { log(`${prefix} could not stop the processes in the old main worktree ${dir}: ${e.message}`); }
    try { await git(repo, 'worktree', 'remove', '--force', dir); return; }
    catch (e) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        log(`${prefix} git could not remove the old main worktree ${dir}; removed the folder: ${(e.stderr || e.message).trim().split('\n').at(-1)}`);
        await git(repo, 'worktree', 'prune');
      } catch (e2) { log(`${prefix} could not remove the old main worktree ${dir}: ${e2.message}`); }
    }
  }
  // Main builds each new tip in the other of two worktrees, <route>-main-a and -b, so a serving Main keeps its own
  // worktree while its successor builds; its old run moves to `serving` until the successor answers.
  async function launchMain(board, repo, metadata) {
    const id = runKey(board, 'main');
    if (starting.has(id)) throw new BuildError('A build is already running for main.', 409);
    starting.add(id);
    try {
      const current = runs.get(id);
      if (current?.ready && !current.ending) {
        runs.delete(id);
        serving.set(board.dir, current);
      } else if (current) await stopRun(current, true);
      const old = serving.get(board.dir);
      if (old) metadata = { ...metadata, serving: { sha: old.sha, at: old.at, https: old.https } };
      const worktreeOf = (side) => path.join(os.homedir(), '.claude', 'kickflip', 'try', `${board.route}-main${side}`);
      const dir = worktreeOf(old?.worktree === worktreeOf('-a') ? '-b' : '-a');
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      if (exists(worktreeOf(''))) await removeLegacyMain(board, repo, worktreeOf(''));
      if (exists(dir)) await git(dir, 'checkout', '--detach', '--force', metadata.sha);
      else {
        await git(repo, 'worktree', 'prune');
        await git(repo, 'worktree', 'add', '--detach', dir, metadata.sha);
      }
      return await launch(board, 'main', dir, metadata);
    } catch (e) {
      mainFailed(board, metadata, e);
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
    if (isCard(key) && (!/^[\w.-]+\/[\w.-]+$/.test(key) || key.split('/').some((s) => s === '.' || s === '..'))) throw new BuildError('Card key must be <file>/<id>.');
    const board = listBoards(manifest).find((b) => b.route === route);
    if (!board) throw new BuildError(`/${route} is not a board.`, 404);
    if (isCard(key) && !board.files.some(({ slug, itemFile }) => itemFile.items.some((it) => `${slug}/${it.id}` === key))) throw new BuildError('There is no item with this card key.', 404);
    const reason = await waiting();
    if (reason) throw new BuildError(reason, 409);
    const id = runKey(board, key);
    const current = runs.get(id);
    if (starting.has(id) || (current && !current.ready && !current.finished)) throw new BuildError(`A build is already running for ${key === 'main' ? 'main' : key === BASE_KEY ? 'the prototype site' : 'this card'}.`, 409);
    if (key === 'main') {
      const entry = stateOf(board).state.main;
      if (entry?.state === 'running') throw new BuildError('A build is already running for main.', 409);
      if (entry?.state !== 'failed' || !entry.sha) throw new BuildError('Main has no failed build to retry.', 409);
      const { sha, branch, slug, at, script } = entry;
      return launchMain(board, boardRepo(route, manifest).repo, { sha, branch, slug, at, script, ...(board.build_target ? { target: board.build_target } : {}) });
    }
    starting.add(id);
    const resuming = interrupted.delete(id);
    try {
      if (runs.has(id)) await stopRun(runs.get(id), true);
      const worktree = key === BASE_KEY ? baseWorktree(board) : await installWorktree(board, key, manifest);
      return await launch(board, key, worktree);
    } catch (e) {
      cardPorts.delete(id);
      if (resuming && e.status !== 503) update(board, key, { state: undefined, sha: undefined });
      throw e;
    }
    finally { starting.delete(id); }
  }
  // The board's base prototype worktree, when it exists; launch refuses ''.
  const baseWorktree = (board) => {
    const dir = baseWorktreeOf(board.route);
    return exists(dir) && fs.statSync(dir).isDirectory() ? fs.realpathSync(dir) : '';
  };
  // Serves the base worktree while an open question links a served round, and stops it once none does; a failed serve
  // waits for Try again (start with BASE_KEY) while a round stays open. A ready serve whose worktree moved to another
  // commit (prototype base) restarts on the same https port, so every open page reloads into the new tree whole
  // (docs/adr/2026-11-07-1231-a-base-move-restarts-the-prototype-serve-and-a-demo-hub-never-restarts-itself.md).
  async function serveBase(board, manifest) {
    const { state } = stateOf(board);
    const id = runKey(board, BASE_KEY);
    const run = runs.get(id);
    const open = (await servedRoundsOpen(board.dir)).length > 0 && baseWorktree(board);
    if (!open) {
      if (run) await stopRun(run);
      if (state.prototypes) { state.prototypes = null; persist(board); }
      return;
    }
    if (run?.ready && !run.stopped && !starting.has(id)) {
      const head = await git(open, 'rev-parse', 'HEAD');
      if (head === state.prototypes?.sha) return;
      log(`try /${board.route} prototypes: the base moved to ${head.slice(0, 7)}; restarting its serve`);
    } else if (run || starting.has(id) || state.prototypes?.state === 'failed' || await waiting()) return;
    try { await start({ route: board.route, key: BASE_KEY }, { manifest }); }
    catch (e) {
      if ([409, 503].includes(e.status)) return;
      state.prototypes = { state: 'failed' };
      failureLog(board, BASE_KEY, e);
      persist(board);
      throw e;
    }
  }
  function lookup(route, id, { manifest = readManifest() } = {}) {
    const board = listBoards(manifest).find((b) => b.route === route);
    if (!board) return null;
    const run = [...runs.values()].find((r) => r.board.dir === board.dir && r.key.split('/').at(-1).toLowerCase() === id.toLowerCase() && r.ready && !r.stopped && r.child.exitCode === null && r.child.signalCode === null);
    if (!run) return null;
    return { key: run.key, port: run.port };
  }
  // routes: only these boards' cards and Main, for a merge the poll saw (docs/adr/2026-11-03-1619-a-merge-refreshes-its-boards-main-at-once.md).
  // A tick with routes while one runs waits for it and then runs once for every route asked meanwhile; one without
  // routes shares the running tick.
  async function tick({ manifest = readManifest(), routes } = {}) {
    await initialize(manifest);
    reserveMains(manifest);
    if (stopping) return ticking;
    if (ticking && routes) {
      if (!queued) {
        const asked = { routes: new Set(), manifest };
        asked.done = ticking.catch(() => {}).then(() => { queued = null; return tick({ manifest: asked.manifest, routes: [...asked.routes] }); });
        queued = asked;
      }
      queued.manifest = manifest;
      for (const route of routes) queued.routes.add(route);
      return queued.done;
    }
    if (ticking) return ticking;
    ticking = (async () => {
      await reserve();
      const listed = listBoards(manifest);
      const prs = readJSON(GITHUB_STATE, {}).prs || {};
      for (const [dir, old] of [...serving]) if (!listed.some((b) => b.dir === dir)) { serving.delete(dir); await halt(old); }
      for (const run of [...runs.values()]) {
        if (!listed.some((b) => b.dir === run.board.dir) || (isCard(run.key) && run.ready && now() - run.visited >= IDLE_MS)) {
          await stopRun(run);
          const { state } = stateOf(run.board);
          dropEntry(state, run.key);
          persist(run.board);
        }
      }
      for (const board of listed) {
        if (stopping) return;
        if (routes && !routes.includes(board.route)) continue;
        const { state } = stateOf(board);
        const source = boardRepo(board.route, manifest);
        const branch = source.branch || 'main';
        const ref = mainRefOf(source);
        for (const { slug, itemFile } of board.files) for (const item of itemFile.items) {
          const key = `${slug}/${item.id}`;
          const states = cardPRs(item, board.github || itemFile.repo).map((p) => prs[prKeyOf(p)]);
          if (item.lane === 'done' || (states.length && states.every((pr) => ['MERGED', 'CLOSED'].includes(pr?.state)))) continue;
          try {
            const id = runKey(board, key);
            const worktree = await installWorktree(board, key, manifest);
            if (worktree) {
              const head = await git(worktree, 'rev-parse', 'HEAD');
              let ahead = 0;
              try { ahead = Number(await git(worktree, 'rev-list', '--count', `${ref}..HEAD`)); } catch {}
              Object.assign(state.cards[key] ||= {}, { head, ahead, script: exists(scriptAt(worktree, board.build_target)) });
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
        await serveBase(board, manifest).catch((e) => log(`try /${board.route} prototypes: ${e.message}`));
        try {
          if (!source.repo || await waiting()) continue;
          const sha = await git(source.repo, 'rev-parse', ref);
          let script = false;
          try { await git(source.repo, 'cat-file', '-e', `${sha}:${buildScriptOf(board.build_target)}`); script = true; } catch {}
          if (!script) {
            const run = runs.get(runKey(board, 'main'));
            if (run) await stopRun(run);
            await retire(board);
            state.main = null;
            persist(board);
            continue;
          }
          const entry = state.main;
          if (entry?.state === 'running' || (entry?.sha === sha && (entry.target || null) === (board.build_target || null) && (entry.state === 'failed' || (entry.state === 'ready' && (state.kind !== 'web' || lookup(board.route, 'main', { manifest })))))) continue;
          const id = runKey(board, 'main');
          if (starting.has(id)) continue;
          const at = await git(source.repo, 'log', '-1', '--format=%cI', sha);
          let slug = board.github;
          if (!slug) { try { slug = githubFromOrigin(await git(source.repo, 'remote', 'get-url', 'origin')); } catch {} }
          const metadata = { sha, branch, slug: slug || '', at, script, ...(board.build_target ? { target: board.build_target } : {}) };
          await launchMain(board, source.repo, metadata);
        } catch (e) { log(`try /${board.route} main: ${e.message}`); }
      }
    })().finally(() => { ticking = null; });
    return ticking;
  }
  // docs/adr/2026-11-03-1914-a-local-boards-main-pulls-from-origin-on-its-own.md: fast-forwards a local board's branch
  // from origin (pullBranch), or resets a clone's to it (resetBranch, docs/adr/2026-11-09-1620-a-kickflip-clone-is-reset-to-origin-on-every-poll-and-refresh.md) and records try.json pull {at, error?, running?}, which Main's refresh icon shows; new commits
  // send the board main-pulled {branch, from, to, commits}. One pull runs at a time on a board; a second call shares it.
  // → {commits, error?}, or null for a folder with no origin
  function pullMain(board, manifest) {
    if (pulls.has(board.dir)) return pulls.get(board.dir);
    const running = (async () => {
      const source = boardRepo(board.route, manifest);
      const branch = source.branch || 'main';
      const { state } = stateOf(board);
      state.pull = { ...state.pull, running: true };
      persist(board);
      let pulled, error;
      try { pulled = await (source.local ? pullBranch : resetBranch)(source.repo, branch); }
      catch (e) { error = e.message; }
      if (pulled === null) delete state.pull;
      else state.pull = { at: stamp(), ...(error ? { error } : {}) };
      persist(board);
      if (pulled === null) return null;
      if (error) { log(`pull /${board.route}: ${error}`); return { commits: 0, error }; }
      if (pulled.commits) {
        log(`pull /${board.route}: ${branch} ${source.local ? 'fast-forwarded' : 'reset'} ${pulled.commits} commit${pulled.commits === 1 ? '' : 's'} to ${pulled.to.slice(0, 7)}`);
        try { await event(board, 'main-pulled', { branch, ...pulled }); } catch (e) { log(`pull /${board.route}: could not send main-pulled (${e.message})`); }
      }
      return { commits: pulled.commits };
    })().finally(() => pulls.delete(board.dir));
    pulls.set(board.dir, running);
    return running;
  }
  // The poll's pull of every board with an origin, or only routes; a board whose pull throws is logged and the rest still pull. → the routes whose pull brought commits
  async function pullMains({ manifest = readManifest(), routes } = {}) {
    await initialize(manifest);
    const pulled = [];
    for (const board of listBoards(manifest)) {
      if (stopping) break;
      if (routes && !routes.includes(board.route)) continue;
      try {
        const source = boardRepo(board.route, manifest);
        if (!source.repo) continue;
        if ((await pullMain(board, manifest))?.commits) pulled.push(board.route);
      } catch (e) { log(`pull /${board.route} failed: ${e.message}`); }
    }
    return pulled;
  }
  // Main's refresh icon: pulls now, and rebuilds Main at once when the pull brought commits.
  async function pull(input, { manifest = readManifest() } = {}) {
    await initialize(manifest);
    if (stopping) throw new BuildError('The hub is stopping. Try again after it restarts.', 503);
    if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).some((k) => k !== 'route') || typeof input.route !== 'string') throw new BuildError('Send only the board route.');
    const board = listBoards(manifest).find((b) => b.route === input.route);
    if (!board) throw new BuildError(`/${input.route} is not a board.`, 404);
    const source = boardRepo(board.route, manifest);
    const result = await pullMain(board, manifest);
    if (!result) throw new BuildError('This board’s folder has no origin to pull from.', 409);
    if (result.commits || !source.local) tick({ manifest, routes: [board.route] }).catch((e) => log(`try /${board.route} main: ${e.message}`));
    return result;
  }
  async function stop() {
    stopping = true;
    // A build still going keeps `running`, so the next hub starts it again (docs/adr/2026-11-02-1731-a-build-the-hub-stops-starts-again-after-it-restarts.md).
    const stopped = Promise.all([...runs.values()].map((run) => run.ready ? stopRun(run) : halt(run)).concat([...serving.values()].map((old) => halt(old))));
    await Promise.all([stopped, ticking, ...pulls.values()]);
  }
  return { start, tick, stop, lookup, initialize, pull, pullMains, endUnshared };
}

// Git that reaches a board repo's origin, GitHub or a remote board's: git's own credential with its prompts off
// (repos.mjs remoteGitEnv), so a credential it can't get fails with git's error instead of waiting, and 10 s for a
// fetch from a private https origin, which waits on two round trips and the keychain.
const ORIGIN_TIMEOUT_MS = 10_000;
const originGit = async (dir, ...args) => (await execFileAsync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: ORIGIN_TIMEOUT_MS, env: remoteGitEnv() })).stdout;

// Makes branch in repo, a clone kickflip owns (repos.mjs), exactly origin's: fetched first with originGit, then checked
// out forced onto it and cleaned, so a clone never diverges. Throws "can’t pull: <reason>" when the fetch or the reset fails.
// → {from, to, commits}, from being the branch before the reset (origin's old tip when the clone had no branch yet)
export async function resetBranch(repo, branch, { run = originGit } = {}) {
  const git = async (...args) => (await run(...args)).trim();
  const tip = (ref) => git(repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`).catch(() => '');
  const origin = `refs/remotes/origin/${branch}`;
  const before = await tip(`refs/heads/${branch}`) || await tip(origin);
  try {
    await git(repo, 'fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:${origin}`);
    await git(repo, 'checkout', '--quiet', '--force', '-B', branch, origin);
    await git(repo, 'clean', '--quiet', '-fd');
  } catch (e) { throw new Error(`can’t pull: ${e.killed ? `git fetch timed out after ${ORIGIN_TIMEOUT_MS / 1000} s` : gitReachFault(e.stderr, { repo }).error}`); }
  const to = await tip(origin);
  const commits = before && before !== to ? Number(await git(repo, 'rev-list', '--count', `${before}..${to}`)) : 0;
  return { from: before || to, to, commits };
}

// Fast-forwards branch in repo to origin's: fetched first with originGit, then merged --ff-only in the worktree that has
// it checked out, refusing while that worktree has uncommitted changes, or moved in place when no worktree has it. A
// branch ahead of origin stays as it is. Throws "can’t pull: <reason>" when it can't fast-forward or the fetch fails.
// → {from, to, commits}, commits 0 when nothing is new, or null when repo has no origin
export async function pullBranch(repo, branch, { run = originGit } = {}) {
  const git = async (...args) => (await run(...args)).trim();
  const refuse = (reason) => { throw new Error(`can’t pull: ${reason}`); };
  try { await git(repo, 'config', '--get', 'remote.origin.url'); } catch { return null; }
  try { await git(repo, 'fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`); }
  catch (e) { refuse(e.killed ? `git fetch timed out after ${ORIGIN_TIMEOUT_MS / 1000} s` : gitReachFault(e.stderr, { repo }).error); }
  try {
    const from = await git(repo, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`);
    const to = await git(repo, 'rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`);
    const isAncestor = (a, b) => git(repo, 'merge-base', '--is-ancestor', a, b).then(() => true, (e) => { if (e.code === 1) return false; throw e; });
    if (from === to || await isAncestor(to, from)) return { from, to: from, commits: 0 };
    if (!await isAncestor(from, to)) refuse(`${branch} has split from origin`);
    const commits = Number(await git(repo, 'rev-list', '--count', `${from}..${to}`));
    const worktree = (await git(repo, 'worktree', 'list', '--porcelain')).split('\n\n')
      .map((block) => block.split('\n')).find((lines) => lines.includes(`branch refs/heads/${branch}`))?.[0].slice('worktree '.length);
    if (worktree) {
      if (await git(worktree, 'status', '--porcelain', '--untracked-files=no')) refuse('local changes');
      await git(worktree, 'merge', '--ff-only', '--quiet', to);
    } else await git(repo, 'update-ref', `refs/heads/${branch}`, to, from);
    return { from, to, commits };
  } catch (e) {
    if (e.message.startsWith('can’t pull: ')) throw e;
    refuse(String(e.stderr || e.message).trim().split('\n').at(-1));
  }
}

// Fetches the branch of each board that isn't local (board-repo.mjs boardRepo) and writes REPO_FETCH {<route>: {at, ok, error?, hint?}} for the boards it
// fetched, which boards.mjs linksOf reads as each board's repo-fetch link. On a board whose repo is a plain git
// remote, it then moves each pushed card to Done once its branch is merged or gone (settlePushed). routes: only these
// boards, keeping the other boards' records.
export async function fetchTryBranches({ manifest = readManifest(), log = console.log, routes } = {}) {
  const fetched = routes ? readJSON(REPO_FETCH, {}) : {};
  for (const board of listBoards(manifest)) {
    if (routes && !routes.includes(board.route)) continue;
    try {
      const source = boardRepo(board.route, manifest);
      if (source.local || !source.repo) continue;
      const branch = source.branch || 'main';
      const at = new Date().toISOString();
      const started = Date.now();
      try {
        await originGit(source.repo, 'fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
        fetched[board.route] = { at, ok: true };
      } catch (e) {
        log(`fetch /${board.route} after ${Date.now() - started} ms: ${e.message}`);
        let github = board.github;
        if (!github && !board.remote) { try { github = githubFromOrigin(await git(source.repo, 'remote', 'get-url', 'origin')); } catch {} }
        fetched[board.route] = { at, ok: false, ...gitReachFault(e.killed ? `git fetch timed out after ${ORIGIN_TIMEOUT_MS / 1000} s` : e.stderr, { github: github || '', remote: board.remote, repo: source.repo }) };
        continue;
      }
      if (board.remote) {
        try { await settlePushed(board, source.repo, branch, log); }
        catch (e) { log(`pushed branches /${board.route}: ${e.message}`); }
      }
    } catch (e) { log(`fetch /${board.route} failed: ${e.message}`); }
  }
  saveJSON(REPO_FETCH, fetched);
}

// docs/adr/2026-11-02-1850-a-board-can-work-on-any-git-remote.md: a pushed card (board.mjs item set --pushed) is Done once its
// branch's tip is in the board's branch, or once the branch is gone from the remote, its line saying which, since a
// squash merge leaves no trace of the branch.
async function settlePushed(board, repo, branch, log) {
  const open = board.files.flatMap(({ slug, itemFile }) => itemFile.items
    .filter((it) => it.pushed?.branch && !hasPR(it) && it.lane !== 'done')
    .map((it) => ({ key: `${slug}/${it.id}`, branch: it.pushed.branch })));
  if (!open.length) return;
  const heads = new Map((await originGit(repo, 'ls-remote', '--heads', 'origin')).split('\n')
    .map((line) => /^([\da-f]+)\trefs\/heads\/(.+)$/.exec(line)).filter(Boolean).map((m) => [m[2], m[1]]));
  const host = remoteFromInput(board.remote)?.host || 'the remote';
  for (const card of open) {
    let tip = heads.get(card.branch);
    if (!tip) { try { tip = await git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${card.branch}^{commit}`); } catch {} }
    let merged = false;
    if (tip) { try { await git(repo, 'merge-base', '--is-ancestor', tip, `refs/remotes/origin/${branch}`); merged = true; } catch {} }
    if (!merged && heads.has(card.branch)) continue;
    try {
      await setItem(board.dir, card.key, { done: true, force: true, landed: merged,
        closing: merged ? ['branch-merged', { branch: card.branch, into: branch, host }] : ['branch-gone', { branch: card.branch, host }] });
    } catch (e) { log(`pushed ${card.key}: ${e.message}`); }
  }
}
const manager = createTryManager({ waiting: () => readiness.waiting('tailscale') });
export const startBuild = (...args) => manager.start(...args);
export const tryTick = (...args) => manager.tick(...args);
export const pullNow = (...args) => manager.pull(...args);
export const pullMains = (...args) => manager.pullMains(...args);
export const stopTries = () => manager.stop();
export const endUnsharedTries = () => manager.endUnshared();
export const initializeTries = (...args) => manager.initialize(...args);
