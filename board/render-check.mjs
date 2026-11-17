// docs/adr/2026-11-07-0900-a-prototype-question-publishes-only-when-every-take-renders.md
// Loads every take of a recorded prototype in headless Chrome, at phone and desktop width, from the page the board
// serves, and refuses naming each take that throws, logs a console error or leaves its stage empty or hides a box at one of the two widths. A served round
// (docs/adr/2026-11-06-1500-a-prototype-round-is-a-page-in-the-boards-base-worktree.md) is loaded straight from the
// board's base prototype worktree, whose build script the check runs itself on a loopback port: every take at the
// first state, and every state on the first take.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { chromePath, ChromeStartError, openTab, startChrome } from '../shared/chrome.mjs';
import { BoardError } from './checks.mjs';
import { readPrototypes } from './questions.mjs';
import { prototypePage } from './prototype-page.mjs';
import { BASE_KEY, baseWorktreeOf } from './prototype-base.mjs';
import { buildScriptError, buildScriptOf } from './build-script.mjs';
import { boardAt } from '../hub/boards.mjs';

const board = path.dirname(fileURLToPath(import.meta.url));
export const WIDTHS = [390, 1280];
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const PORT_MS = 120_000;
// Resolves once the page has drawn, read after its load event: a take page once the kit's first take has drawn
// (prototype-kit.js drawn), which can follow the load event since the take is a dynamic import; a served page at once.
// The task after it lets an error the drawing left unhandled reach the problems first. No clock decides it
// (docs/adr/2026-11-13-2233-render-check-reads-a-page-once-it-has-drawn.md).
const DRAWN = `(async () => { await globalThis.PrototypeKit?.drawn; await new Promise((resolve) => setTimeout(resolve)); })()`;
// What the page drew: a take file's stage, or a served page's body text.
const STAGE = `(document.getElementById('stage')?.innerHTML || '').trim()`;
// Each element of the stage, by position: null where it is shown, else the name a take's author knows it by.
const HIDDEN = `[...document.querySelectorAll('#stage *')].map((e) => getComputedStyle(e).display !== 'none' ? null : (e.getAttribute('class') || '').trim().split(/\\s+/).filter(Boolean).map((c) => '.' + c).join('') || e.localName)`;
const BODY = `(document.body?.innerText || '').trim()`;

// The board server's static roots, minus the hub's.
function serve(site, proto) {
  const roots = [path.join(site, 'public'), path.join(board, 'public'), path.join(board, '..', 'starter', 'public'), path.join(board, '..', 'shared')];
  return http.createServer(async (req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    // The hub's own /_hub/ files (hub/hub.mjs), from the folders they live in.
    const icon = /^\/_hub\/(icon-(?:180|192|512)\.png)$/.exec(p);
    if (icon) {
      res.writeHead(200, { 'content-type': types['.png'] }).end(await fsp.readFile(path.join(board, '..', 'hub', icon[1])));
      return;
    }
    if (['/_hub/kickflip.png', '/_hub/hub.css', '/_hub/colors.css'].includes(p)) p = p.slice('/_hub'.length);
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

const described = (ex) => ex.exception?.description?.split('\n')[0] || ex.text;

// → [problem] for the page at url at this width, [] when it draws.
async function checkTake({ cdp, on }, url, width, drawn = STAGE) {
  const problems = [];
  const off = on((m) => {
    if (m.method === 'Runtime.exceptionThrown') problems.push(described(m.params.exceptionDetails));
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') problems.push(`console error: ${m.params.args.map((a) => a.value ?? a.description).join(' ').split('\n')[0]}`);
    // The browser asks every site for /favicon.ico on its own, so a site without one still draws.
    else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && m.params.entry.source !== 'javascript' && !/\/favicon\.ico$/.test(m.params.entry.url || '')) problems.push(`${m.params.entry.text}${m.params.entry.url ? ` ${m.params.entry.url}` : ''}`);
  });
  await cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
  const loaded = new Promise((resolve) => { const stop = on((m) => { if (m.method === 'Page.loadEventFired') { stop(); resolve(); } }); });
  await cdp('Page.navigate', { url });
  await loaded;
  await cdp('Runtime.evaluate', { expression: DRAWN, awaitPromise: true });
  const html = (await cdp('Runtime.evaluate', { expression: drawn, returnByValue: true })).result.value;
  off();
  if (!html) problems.push(drawn === STAGE ? 'renders an empty stage' : 'renders an empty page');
  return [...new Set(problems)];
}

// → [problem] for each stage element hidden at one of the two widths and shown at the other, by the board's own styles or the take's.
function hiddenAtOneWidth(hidden) {
  const [narrow, wide] = hidden;
  const found = [];
  for (let i = 0; i < Math.min(narrow.length, wide.length); i++) {
    if (narrow[i] && !wide[i]) found.push(`${narrow[i]} is hidden at ${WIDTHS[0]}px and shown at ${WIDTHS[1]}px`);
    if (wide[i] && !narrow[i]) found.push(`${wide[i]} is hidden at ${WIDTHS[1]}px and shown at ${WIDTHS[0]}px`);
  }
  return [...new Set(found)];
}

// Runs the base worktree's build script as the hub does, on a loopback port. → {origin, stop}
async function serveBase(site) {
  const board = boardAt(site);
  if (!board) throw new BoardError(`${site} is not a board in the hub's manifest, so it has no base prototype worktree to check`);
  const dir = baseWorktreeOf(board.route);
  const script = path.join(dir, buildScriptOf(board.build_target));
  const invalid = buildScriptError(script);
  if (invalid) throw new BoardError(`the base prototype worktree can't serve the round: ${invalid} (${script})`);
  const child = spawn(script, [BASE_KEY, dir], { cwd: dir, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, KICKFLIP_BOARD: board.route, HOST: '127.0.0.1' } });
  const tail = [];
  const keep = (line) => { tail.push(line); if (tail.length > 5) tail.shift(); };
  createInterface({ input: child.stderr }).on('line', keep);
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const stop = async () => {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { return; }
    if (await Promise.race([exited.then(() => true), sleep(4000).then(() => false)])) return;
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
    await exited;
  };
  const port = await new Promise((resolve) => {
    const lines = createInterface({ input: child.stdout });
    const done = (value) => { clearTimeout(timer); lines.close(); resolve(value); };
    const timer = setTimeout(() => done(null), PORT_MS);
    lines.on('line', (line) => { const m = /^port (\d{1,5})$/.exec(line); if (m) done(Number(m[1])); else keep(line); });
    exited.then(() => done(null));
  });
  const answers = () => fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
  let up = Boolean(port);
  for (let waited = 0; up && !(await answers()); waited += 250) { if (waited >= 60_000) up = false; else await sleep(250); }
  if (!up) {
    await stop();
    throw new BoardError(`the base prototype worktree's ${buildScriptOf(board.build_target)} didn't serve on a port, so the round's question is not published:\n${tail.join('\n')}`);
  }
  return { origin: `http://127.0.0.1:${port}`, dir, stop };
}

// Runs fn on a tab of the Chrome that KICKFLIP_RENDER_CHROME_PORT names, which its caller owns (a test file shares one
// across its checks), else of a Chrome of its own.
async function withChrome(fn) {
  const shared = process.env.KICKFLIP_RENDER_CHROME_PORT;
  if (!shared && !fs.existsSync(chromePath())) throw new BoardError(`the render check needs Chrome; none at ${chromePath()}, set CHROME to its path`);
  const dir = shared ? null : await fsp.mkdtemp(path.join(os.tmpdir(), 'render-check-'));
  let chrome;
  let tab;
  try {
    try {
      chrome = shared ? { port: shared, stop: async () => {} } : await startChrome(dir);
      tab = await openTab(chrome.port);
    } catch (e) {
      if (e instanceof ChromeStartError) throw new BoardError(`the render check ${e.message}`);
      throw e;
    }
    await tab.cdp('Runtime.enable');
    await tab.cdp('Log.enable');
    await tab.cdp('Page.enable');
    return await fn(tab);
  } finally {
    await tab?.close();
    await chrome?.stop();
    if (dir) await fsp.rm(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 });
  }
}

async function checkServedRender(site, proto) {
  const base = await serveBase(site);
  try {
    const first = proto.takes[0].key;
    const states = (proto.states || []).map((s) => s.key);
    const loads = [...proto.takes.map((t) => [t.key, states[0] ?? null]), ...states.slice(1).map((s) => [first, s])];
    const failures = await withChrome(async (chrome) => {
      const found = [];
      for (const [take, state] of loads) {
        const url = new URL(proto.served, base.origin);
        url.searchParams.set('variant', take);
        if (state) url.searchParams.set('state', state);
        for (const width of WIDTHS) {
          for (const p of await checkTake(chrome, url.href, width, BODY)) found.push(`take ${take}${state ? `, state ${state}` : ''} at ${width}px: ${p}`);
        }
      }
      return found;
    });
    if (failures.length) throw new BoardError(`prototype ${proto.topic} does not render, so its question is not published; fix its page in ${base.dir} and ask again:\n${failures.join('\n')}`);
  } finally { await base.stop(); }
}

// Throws a BoardError listing each failing take and width, or returns when every take of prototype topic renders.
export async function checkTakesRender(site, topic) {
  const proto = (await readPrototypes(site)).find((p) => p.topic === topic);
  if (proto.served) return checkServedRender(site, proto);
  const server = serve(site, proto);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/prototype-${topic}.html`;
    const failures = await withChrome(async (chrome) => {
      const found = [];
      for (const take of proto.takes) {
        const hidden = [];
        for (const width of WIDTHS) {
          for (const p of await checkTake(chrome, `${url}?variant=${take.key}`, width)) found.push(`take ${take.key} at ${width}px: ${p}`);
          hidden.push((await chrome.cdp('Runtime.evaluate', { expression: HIDDEN, returnByValue: true })).result.value || []);
        }
        for (const p of hiddenAtOneWidth(hidden)) found.push(`take ${take.key}: ${p}`);
      }
      return found;
    });
    if (failures.length) throw new BoardError(`prototype ${topic} does not render, so its question is not published; fix the take files and ask again:\n${failures.join('\n')}`);
  } finally { server.close(); }
}
