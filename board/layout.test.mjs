// Layout the vm and fake-DOM tests can't see, measured in a real headless Chrome. Skipped where Chrome isn't installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { freePorts, until } from '../shared/test-helpers.mjs';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const SCRIPTS = ['ui.js', 'ui-links.js', 'ui-enums.js', 'ui-phase-bars.js', 'ui-cards.js'];

const card = (key, stalled) => ({ kind: 'work', key, id: key, ref: key, title: 'Short title', lane: 'progress', bumpable: true, internal: true,
  builder: { progress: 'Running tests', phase: 'testing', at: null, stalled } });

const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>${read('../shared/colors.css')}${read('./public/style.css')}</style>
<div id="root"></div>
${SCRIPTS.map((f) => `<script>${read(`./public/${f}`)}</script>`).join('\n')}
<script>
  document.getElementById('root').innerHTML = ${JSON.stringify([card('working', false), card('stalled', true)])}.map((it) =>
    '<details class="item" data-key="' + it.key + '"><summary class="work"><span class="status progress"></span><div class="title-wrap">' + BoardUI.workLines(it) + '</div></summary></details>').join('');
</script>`;

test('a red status line sits as close to its title as an orange one, beside the bump icons', { skip: !fs.existsSync(CHROME) && 'no Chrome' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-'));
  const [port] = await freePorts();
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  t.after(async () => {
    const exited = new Promise((resolve) => chrome.once('exit', resolve));
    chrome.kill();
    await exited;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  let target;
  await until(async () => {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((p) => p.type === 'page'); } catch { return false; }
    return Boolean(target);
  }, 'Chrome never listed a page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = ({ data }) => { const m = JSON.parse(data); waiting.get(m.id)?.(m); };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    waiting.set(n, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  t.after(() => ws.close());

  const gaps = `[...document.querySelectorAll('details.item')].map((c) => ({ float: Boolean(c.querySelector('.ask-actions')),
    gap: c.querySelector('.line3').getBoundingClientRect().top - c.querySelector('.line1').getBoundingClientRect().bottom }))`;
  for (const [width, mobile] of [[1280, false], [390, true]]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile });
    await cdp('Page.navigate', { url: `data:text/html;base64,${Buffer.from(page).toString('base64')}` });
    await until(async () => (await cdp('Runtime.evaluate', { expression: `document.querySelectorAll('.line3').length === 2`, returnByValue: true })).result.value, 'page never drew');
    const [orange, red] = (await cdp('Runtime.evaluate', { expression: gaps, returnByValue: true })).result.value;
    assert.ok(orange.float && red.float, `${width}px: both cards have the bump icons' float`);
    assert.equal(red.gap, orange.gap, `${width}px: red ${red.gap}px, orange ${orange.gap}px`);
  }
});
