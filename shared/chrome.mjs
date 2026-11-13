// docs/adr/2026-11-13-1030-render-and-layout-tests-share-one-chrome-per-file.md
// A headless Chrome, and a tab in it that is driven over the DevTools protocol. A caller starts one Chrome and opens a
// tab for each page it loads, so the cost of a launch is paid once however many pages follow.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

// Read when used: a test points CHROME at a stand-in for one run.
export const chromePath = () => process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export class ChromeStartError extends Error {}
const COULD_NOT_START = 'could not start Chrome';

async function launchOnce(dir, flags) {
  const chrome = spawn(chromePath(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', ...flags, 'about:blank'],
    // The account's own home, not a $HOME a caller pointed elsewhere: Chrome's network stack stalls on a home without its keychain.
    { stdio: 'ignore', env: { ...process.env, HOME: os.userInfo().homedir } });
  const portFile = path.join(dir, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
  if (!fs.existsSync(portFile)) { chrome.kill(); throw new ChromeStartError(COULD_NOT_START); }
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const stop = async () => {
    const exited = new Promise((resolve) => chrome.once('exit', resolve));
    chrome.kill();
    await exited;
  };
  return { port, stop };
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
