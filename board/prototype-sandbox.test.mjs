// docs/adr/2026-11-18-0523-previews-run-in-a-sandboxed-opaque-origin.md
// Loads a take-file round's viewer in headless Chrome, with its stage served as the board serves it, and follows a
// switch from the viewer's bar into the sandboxed stage and a key in the stage back out to the viewer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeInstalled, sharedChrome } from '../shared/test-helpers.mjs';
import { tempDir } from '../shared/temp-dir.mjs';
import { SANDBOX, SANDBOX_MODULE, prototypePage, prototypeStage } from './prototype-page.mjs';

const chrome = sharedChrome();
const board = path.dirname(fileURLToPath(import.meta.url));
const roots = [path.join(board, 'public'), path.join(board, '..', 'starter', 'public'), path.join(board, '..', 'shared')];
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };

// A draws; B, once the viewer's › has switched to it, notes what it can reach and presses → in the stage; C, which that
// key switches to, sends B's notes to the viewer, which writes them into <pre id="probe">.
const TAKES = {
  A: 'export function render(stage) { stage.innerHTML = "<p>A</p>"; }',
  B: `export function render(stage) {
  stage.innerHTML = '<p>B</p>';
  const tries = (fn) => { try { return fn(); } catch { return 'refused'; } };
  globalThis.fromB = { origin: self.origin, viewer: tries(() => typeof top.document.body), stored: tries(() => localStorage.length), cookie: tries(() => document.cookie) };
  queueMicrotask(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
}`,
  C: 'export function render(stage) { stage.innerHTML = "<p>C</p>"; top.postMessage(JSON.stringify({ ...globalThis.fromB, now: "C" }), "*"); }',
};
const PROBE = `<script>
addEventListener('message', (e) => { if (typeof e.data !== 'string') return; const d = document.createElement('pre'); d.id = 'probe';
  d.textContent = JSON.stringify({ ...JSON.parse(e.data), take: document.documentElement.dataset.take, sandbox: document.querySelector('iframe.kit-frame')?.getAttribute('sandbox'),
    stageRead: (() => { try { return typeof document.querySelector('iframe.kit-frame').contentDocument?.body; } catch { return 'refused'; } })() }); document.body.append(d); });
addEventListener('load', () => document.querySelector('[data-ps="next"]').click());
</script>`;

test('a take runs in an opaque origin framed by the viewer: the bar switches it by message, a key in it switches the bar, and it reaches nothing of the board', { skip: !chromeInstalled }, async () => {
  const site = tempDir('sandbox-site-');
  const proto = { topic: 't', title: 'T', takes: Object.keys(TAKES).map((key) => ({ key, label: `Take ${key}` })) };
  for (const [key, src] of Object.entries(TAKES)) {
    fs.mkdirSync(path.join(site, 'public', 'prototypes', 't'), { recursive: true });
    fs.writeFileSync(path.join(site, 'public', 'prototypes', 't', `${key}.js`), src);
  }
  const server = http.createServer(async (req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/prototype-t.html') return res.writeHead(200, { 'content-type': 'text/html' }).end((await prototypePage(site, proto)).replace('</body>', `${PROBE}</body>`));
    if (p === '/prototype-t.stage.html') return res.writeHead(200, { 'content-type': 'text/html', ...SANDBOX }).end(await prototypeStage(site, proto));
    if (p.startsWith('/prototypes/t/')) return res.writeHead(200, { 'content-type': 'text/javascript', ...SANDBOX, ...SANDBOX_MODULE }).end(fs.readFileSync(path.join(site, 'public', p)));
    for (const root of roots) {
      const file = path.join(root, p);
      if (file.startsWith(root + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) return res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' }).end(fs.readFileSync(file));
    }
    res.writeHead(404).end();
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    const got = await chrome.probe(`http://127.0.0.1:${server.address().port}/prototype-t.html`, 1280);
    assert.deepEqual(got, { origin: 'null', viewer: 'refused', stored: 'refused', cookie: 'refused', now: 'C', take: 'C', sandbox: 'allow-scripts', stageRead: 'undefined' });
  } finally {
    server.close();
    fs.rmSync(site, { recursive: true, force: true });
  }
});

// A visual as the board serves it, sandboxed with preview-frame.js before </body>, framed by a page standing in for
// the reader sheet: it sends its title once loaded, and a tap on a link, but not on one to a place on the page.
test('a sandboxed page of the site sends the frame around it its title and its link taps, but not a tap on a link to a place on the page', { skip: !chromeInstalled }, async () => {
  const script = fs.readFileSync(path.join(board, 'public', 'preview-frame.js'), 'utf8');
  const visual = `<title>Flow</title><body><a id="here" href="#part">part</a><a id="away" href="/board/questions.html#q1">q1</a><p id="part">x</p>
<script>${script}</script><script>addEventListener('load', () => { document.getElementById('here').click(); document.getElementById('away').click(); });</script></body>`;
  const reader = `<body><iframe src="/visual.html"></iframe><script>
const got = [];
addEventListener('message', (e) => {
  got.push(e.data);
  if (e.data.kickflip !== 'page-link') return;
  const d = document.createElement('pre'); d.id = 'probe'; d.textContent = JSON.stringify({ got, fromFrame: e.source === document.querySelector('iframe').contentWindow }); document.body.append(d);
});
</script></body>`;
  const server = http.createServer((req, res) => {
    if (req.url === '/visual.html') return res.writeHead(200, { 'content-type': 'text/html', ...SANDBOX }).end(visual);
    res.writeHead(200, { 'content-type': 'text/html' }).end(reader);
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    const { port } = server.address();
    const got = await chrome.probe(`http://127.0.0.1:${port}/`, 1280);
    assert.deepEqual(got, { got: [{ kickflip: 'page', title: 'Flow' }, { kickflip: 'page-link', href: `http://127.0.0.1:${port}/board/questions.html#q1` }], fromFrame: true });
  } finally { server.close(); }
});
