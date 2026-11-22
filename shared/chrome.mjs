// docs/adr/2026-11-13-1030-render-and-layout-tests-share-one-chrome-per-file.md
// A headless Chrome, and a tab in it that is driven over the DevTools protocol. A caller starts one Chrome and opens a
// tab for each page it loads, so the cost of a launch is paid once however many pages follow.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

// Read when used: a test points CHROME at a stand-in for one run.
export const chromePath = () => process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export class ChromeStartError extends Error {}
const COULD_NOT_START = 'could not start Chrome';

// How long a launch waits for the DevTools port file. A host running the whole suite at once starts Chromes slowly.
const START_WAIT_MS = 45000;

// No crash handler and no updater: those helpers detach from Chrome and outlive it. Chrome runs in its own process group
// with its profile dir as cwd, so stop() takes down whatever it started and nothing is left in a worktree.
const NO_HELPERS = ['--disable-crash-reporter', '--disable-breakpad', '--disable-component-update', '--disable-background-networking'];

// The Chromes this process started and has not stopped. The process's exit, including a process.exit from
// exit-with-run.mjs at a file's limit, kills their groups; a SIGKILL gives no exit, so sweepOrphanChromes ends those.
const running = new Set();
process.on('exit', () => { for (const pid of running) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } } });

const groupAlive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch { return false; } };

async function launchOnce(dir, flags) {
  const env = { ...process.env, HOME: os.userInfo().homedir };
  delete env.CHROME_CRASHPAD_PIPE_NAME;
  // Its own process group, so stop can end every helper at once; its cwd is the profile, not the caller's worktree.
  const chrome = spawn(chromePath(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', ...NO_HELPERS, ...flags, 'about:blank'],
    // The account's own home, not a $HOME a caller pointed elsewhere: Chrome's network stack stalls on a home without its keychain.
    { stdio: 'ignore', env, cwd: dir, detached: true });
  running.add(chrome.pid);
  const exited = new Promise((resolve) => chrome.once('exit', resolve));
  const stop = async () => {
    running.delete(chrome.pid);
    try { process.kill(-chrome.pid, 'SIGKILL'); } catch { /* the group is already gone */ }
    await exited;
    // SIGKILL reaches every member at once, but the kernel reaps them a moment after the leader.
    while (groupAlive(chrome.pid)) await sleep(20);
  };
  const portFile = path.join(dir, 'DevToolsActivePort');
  for (let i = 0; i < START_WAIT_MS / 100 && !fs.existsSync(portFile); i++) await sleep(100);
  if (!fs.existsSync(portFile)) { await stop(); throw new ChromeStartError(COULD_NOT_START); }
  return { port: fs.readFileSync(portFile, 'utf8').split('\n')[0], stop };
}

// → {port, stop} for a Chrome running with its profile in dir. A busy host can leave Chrome without a port, so a launch
// that fails is tried once more in a fresh profile.
export async function startChrome(dir, flags = [], once = launchOnce) {
  try { return await once(dir, flags); } catch (e) {
    if (!(e instanceof ChromeStartError)) throw e;
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
    await fsp.mkdir(dir);
    return once(dir, flags);
  }
}

// → {cdp(method, params), on(listener) → off, close()} for a new tab in the Chrome listening on port.
export async function openTab(port) {
  const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json(), () => null);
  if (!target?.webSocketDebuggerUrl) throw new ChromeStartError(COULD_NOT_START);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  try { await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; }); } catch { throw new ChromeStartError(COULD_NOT_START); }
  let id = 0;
  const waiting = new Map();
  const listeners = [];
  ws.onmessage = ({ data }) => {
    const m = JSON.parse(data);
    if (m.id) waiting.get(m.id)?.(m);
    else listeners.forEach((fn) => fn(m));
  };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    waiting.set(n, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const close = async () => {
    ws.close();
    await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
  };
  return { cdp, on: (fn) => { listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1); }, close };
}

// Ends each headless Chrome whose parent is gone (parent 1) and whose profile dir is under the temp dir: one a test file
// started with startChrome and was killed before it could stop. A Chrome of a test file still running has its parent.
export async function sweepOrphanChromes() {
  const { stdout } = await promisify(execFile)('/bin/ps', ['-A', '-o', 'pid=,ppid=,args=']);
  const profiles = [os.tmpdir(), fs.realpathSync(os.tmpdir())].map((dir) => `--user-data-dir=${dir}${path.sep}`);
  for (const line of stdout.split('\n')) {
    const [, pid, ppid, args] = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line) ?? [];
    if (ppid !== '1' || !args.includes('--headless') || !args.includes('--remote-debugging-port=0') || !profiles.some((p) => args.includes(p))) continue;
    try { process.kill(-Number(pid), 'SIGKILL'); } catch { /* gone */ }
  }
}
