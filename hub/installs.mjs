import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { DEFAULT_REPO, listBoards, readManifest } from './boards.mjs';
import { installScriptError } from '../board/install-script.mjs';
import { appendThread, recordedWorktree, startBuilder, stopBuilder } from '../board/store.mjs';

export class InstallError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const running = new Map();
const finishing = new Set();
let stopping = false;
const KEYCHAIN = /errSecInternalComponent|keychain[^\n]*\blocked\b|\blocked\b[^\n]*keychain/i;
const execFileAsync = promisify(execFile);
// Async because this runs in the hub process, where a sync git call stalls every site's requests.
const git = async (dir, ...args) => (await execFileAsync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 3000 })).stdout.trim();

async function installWorktree(board, key, manifest) {
  const record = await recordedWorktree(board.dir, key);
  const [slug, id] = key.split('/');
  const wave = board.waves.find((w) => w.slug === slug)?.wave;
  const candidate = record?.path || wave?.items.find((it) => it.id === id)?.worktree;
  if (typeof candidate !== 'string' || !candidate || candidate.split(path.sep).includes('..')) return '';
  let repo = record?.repo;
  if (!repo) {
    const dirs = [board.owner?.repo, board.dir, ...Object.values(manifest?.sites || {}).map((s) => s.owner?.repo)];
    for (const dir of new Set(dirs.filter((d) => typeof d === 'string' && path.isAbsolute(d)))) {
      try {
        const remote = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(await git(dir, 'remote', 'get-url', 'origin'));
        if (remote?.[1].toLowerCase() === (board.github || wave?.repo || DEFAULT_REPO).toLowerCase()) {
          repo = await git(dir, 'rev-parse', '--show-toplevel');
          break;
        }
      } catch {}
    }
  }
  if (!record?.path && !repo) return '';
  if (record?.path && !path.isAbsolute(candidate)) return '';
  try {
    const roots = [path.join(fs.realpathSync(os.homedir()), '.claude', 'web-ts', 'worktrees')];
    if (typeof repo === 'string' && path.isAbsolute(repo)) {
      try { roots.push(path.join(fs.realpathSync(repo), '.claude', 'worktrees')); } catch {}
    }
    const absolute = path.resolve(repo || '/', candidate);
    const resolved = fs.realpathSync(absolute);
    return roots.some((root) => absolute.startsWith(root + path.sep) && resolved.startsWith(root + path.sep))
      && fs.statSync(resolved).isDirectory() ? resolved : '';
  } catch { return ''; }
}

// release() frees the card before its result line is written: a caller that sees the result and starts again at once
// would otherwise get a 409. It waits for stopBuilder and the log read, which a new install would clobber.
async function report(site, key, logFile, code, signal, error, release) {
  await stopBuilder(site, key, { agent: 'install' });
  const tail = [];
  let keychain = false;
  try {
    for await (const line of createInterface({ input: fs.createReadStream(logFile), crlfDelay: Infinity })) {
      tail.push(line);
      if (tail.length > 5) tail.shift();
      keychain ||= KEYCHAIN.test(line);
    }
  } catch (e) { tail.push(`Could not read the install log: ${e.message}`); }
  const result = code === 0 ? 'Install build finished' : `Install build failed (exit ${error ? 1 : code ?? 1})`;
  release();
  await appendThread(site, key, { text: [result, error?.message, signal && `Stopped by ${signal}.`,
    keychain && 'The login keychain must be unlocked on the Mac.', ...tail].filter((line) => line !== false && line != null).join('\n') });
}

export async function startInstall(input, { manifest = readManifest(), log = console.log } = {}) {
  if (stopping) throw new InstallError('The hub is stopping. Try again after it restarts.', 503);
  if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).some((k) => !['route', 'key'].includes(k))
    || typeof input.route !== 'string' || typeof input.key !== 'string') throw new InstallError('Send only the board route and card key.');
  const { route, key } = input;
  if (!/^[\w.-]+\/[\w.-]+$/.test(key) || key.split('/').some((s) => s === '.' || s === '..')) throw new InstallError('Card key must be <wave>/<id>.');
  const board = listBoards(manifest).find((b) => b.route === route);
  if (!board) throw new InstallError(`/${route} is not a board.`, 404);
  if (!board.install_script) throw new InstallError('Set an install script on this board’s Settings page first.');
  const error = installScriptError(board.install_script);
  if (error) throw new InstallError(error);
  const runKey = `${board.dir}\0${key}`;
  if (running.has(runKey)) throw new InstallError('An install build is already running for this card.', 409);
  running.set(runKey, null);
  let fd;
  let started = false;
  try {
    const worktree = await installWorktree(board, key, manifest);
    const logFile = path.join(board.dir, 'data', 'installs', key.split('/')[1] + '.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fd = fs.openSync(logFile, 'w', 0o600);
    const error = installScriptError(board.install_script);
    if (error) throw new InstallError(error);
    await startBuilder(board.dir, key, { kind: 'install', agent: 'install' });
    started = true;
    if (stopping) throw new InstallError('The hub is stopping. Try again after it restarts.', 503);
    const child = spawn(board.install_script, [key, worktree], { cwd: board.dir, stdio: ['ignore', fd, fd], detached: true });
    let spawnError;
    child.once('error', (e) => { spawnError = e; });
    const run = { child };
    const release = () => { if (running.get(runKey) === run) running.delete(runKey); };
    const finished = new Promise((resolve) => {
      child.once('close', (code, signal) => {
        report(board.dir, key, logFile, code, signal, spawnError, release)
          .catch((e) => log(`install /${route} ${key}: could not finish records: ${e.message}`))
          .finally(() => { release(); finishing.delete(finished); resolve(); });
      });
    });
    finishing.add(finished);
    running.set(runKey, run);
    log(`install /${route} ${key}: started; log ${logFile}`);
    return { status: 'started' };
  } catch (e) {
    if (started) await stopBuilder(board.dir, key, { agent: 'install' });
    running.delete(runKey);
    throw new InstallError(e.message, e.status);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export async function stopInstalls() {
  stopping = true;
  const runs = [...running.values()].filter(Boolean);
  const signal = (child, name) => { try { process.kill(-child.pid, name); } catch { child.kill(name); } };
  for (const { child } of runs) signal(child, 'SIGTERM');
  const force = setTimeout(() => { for (const { child } of runs) if (child.exitCode === null && child.signalCode === null) signal(child, 'SIGKILL'); }, 4000);
  try { await Promise.all(finishing); } finally { clearTimeout(force); }
}
