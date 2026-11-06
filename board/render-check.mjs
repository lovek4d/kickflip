// docs/adr/2026-11-07-0900-a-prototype-question-publishes-only-when-every-take-renders.md
// Loads every take of a recorded prototype in headless Chrome, at phone and desktop width, from the page the board
// serves, and refuses naming each take that throws, logs a console error or leaves its stage empty.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { BoardError, readPrototypes } from './store.mjs';
import { prototypePage } from './prototype-page.mjs';

const board = path.dirname(fileURLToPath(import.meta.url));
export const WIDTHS = [390, 1280];
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const SETTLE_MS = 3000;
const LATE_MS = 300;

// The board server's static roots, minus the hub's.
function serve(site, proto) {
  const roots = [path.join(site, 'public'), path.join(board, 'public'), path.join(board, '..', 'starter', 'public'), path.join(board, '..', 'shared')];
  return http.createServer(async (req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === `/prototype-${proto.topic}.html`) { res.writeHead(200, { 'content-type': types['.html'] }).end(await prototypePage(site, proto)); return; }
    for (const root of roots) {
      const file = path.resolve(root, `.${p}`);
      if (file.startsWith(root + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' }).end(await fsp.readFile(file));
        return;
      }
    }
    res.writeHead(p === '/favicon.ico' ? 204 : 404).end();
  });
}

async function launch(dir) {
  if (!fs.existsSync(CHROME)) throw new BoardError(`the render check needs Chrome; none at ${CHROME}, set CHROME to its path`);
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', 'about:blank'],
    // The account's own home, not a $HOME a caller pointed elsewhere: Chrome's network stack stalls on a home without its keychain.
    { stdio: 'ignore', env: { ...process.env, HOME: os.userInfo().homedir } });
  const portFile = path.join(dir, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
  if (!fs.existsSync(portFile)) { chrome.kill(); throw new BoardError('the render check could not start Chrome'); }
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    target = (await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json(), () => [])).find((p) => p.type === 'page');
    if (!target) await sleep(100);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
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
    const exited = new Promise((resolve) => chrome.once('exit', resolve));
    chrome.kill();
    await exited;
  };
  return { cdp, on: (fn) => { listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1); }, close };
}

const described = (ex) => ex.exception?.description?.split('\n')[0] || ex.text;

// → [problem] for the take at this width, [] when it draws.
async function checkTake({ cdp, on }, url, key, width) {
  const problems = [];
  const off = on((m) => {
    if (m.method === 'Runtime.exceptionThrown') problems.push(described(m.params.exceptionDetails));
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push(`console error: ${m.params.args.map((a) => a.value ?? a.description).join(' ').split('\n')[0]}`);
    else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && m.params.entry.source !== 'javascript') problems.push(`${m.params.entry.text}${m.params.entry.url ? ` ${m.params.entry.url}` : ''}`);
  });
  await cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
  await cdp('Page.navigate', { url: `${url}?variant=${key}` });
  const stage = async () => (await cdp('Runtime.evaluate', { expression: `(document.getElementById('stage')?.innerHTML || '').trim()`, returnByValue: true })).result.value;
  let html = '';
  for (let waited = 0; waited < SETTLE_MS && !html; waited += 100) { await sleep(100); html = await stage(); }
  await sleep(LATE_MS);
  off();
  if (!html) problems.push('renders an empty stage');
  return [...new Set(problems)];
}

// Throws a BoardError listing each failing take and width, or returns when every take of prototype topic renders.
export async function checkTakesRender(site, topic) {
  const proto = (await readPrototypes(site)).find((p) => p.topic === topic);
  const server = serve(site, proto);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'render-check-'));
  let chrome;
  try {
    chrome = await launch(dir);
    await chrome.cdp('Runtime.enable');
    await chrome.cdp('Log.enable');
    const url = `http://127.0.0.1:${server.address().port}/prototype-${topic}.html`;
    const failures = [];
    for (const take of proto.takes) {
      for (const width of WIDTHS) {
        const problems = await checkTake(chrome, url, take.key, width);
        for (const p of problems) failures.push(`take ${take.key} at ${width}px: ${p}`);
      }
    }
    if (failures.length) throw new BoardError(`prototype ${topic} does not render, so its question is not published; fix the take files and ask again:\n${failures.join('\n')}`);
  } finally {
    await chrome?.close();
    server.close();
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
  }
}
