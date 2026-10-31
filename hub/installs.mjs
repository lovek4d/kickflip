import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { listBoards } from './boards.mjs';
import { installScriptError } from '../board/install-script.mjs';
import { appendThread, recordedWorktree, startBuilder, stopBuilder } from '../board/store.mjs';

export class InstallError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const running = new Map();
let stopping = false;
const KEYCHAIN = /errSecInternalComponent|keychain[^\n]*\blocked\b|\blocked\b[^\n]*keychain/i;

async function report(site, key, logFile, code, signal, error) {
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
  await appendThread(site, key, { text: [result, error?.message, signal && `Stopped by ${signal}.`,
    keychain && 'The login keychain must be unlocked on the Mac.', ...tail].filter((line) => line !== false && line != null).join('\n') });
}

export async function startInstall(input, { manifest, log = console.log } = {}) {
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
    const worktree = (await recordedWorktree(board.dir, key))?.path || '';
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
    const finished = new Promise((resolve) => {
      child.once('close', (code, signal) => {
        report(board.dir, key, logFile, code, signal, spawnError)
          .catch((e) => log(`install /${route} ${key}: could not finish records: ${e.message}`))
          .finally(() => { running.delete(runKey); resolve(); });
      });
    });
    running.set(runKey, { child, finished });
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
  try { await Promise.all(runs.map((run) => run.finished)); } finally { clearTimeout(force); }
}
