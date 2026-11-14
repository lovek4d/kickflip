// docs/adr/2026-11-07-0900-a-prototype-question-publishes-only-when-every-take-renders.md
// Needs a real headless Chrome, so it is skipped where none is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ChromeStartError, startChrome } from '../shared/chrome.mjs';
import { sharedChrome } from '../shared/test-helpers.mjs';
import { boardWith, home, at, site, write, read, run, question, takePath, recordPrototype } from './board-fixture.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const skip = !fs.existsSync(CHROME) && 'no Chrome';
// One Chrome for the file; each check opens a tab in it. The tests of a Chrome that fails to start launch their own.
const chrome = sharedChrome();
const checkEnv = (env = {}) => ({ KICKFLIP_RENDER_CHECK: 'on', ...(skip ? {} : { KICKFLIP_RENDER_CHROME_PORT: chrome.port }), ...env });
const add = async (options, env = {}) => {
  write(path.join(home, 'q.json'), question('q1', { url: 'prototype-site.html?q=q1', options: options.map((id) => ({ id, label: `Take ${id}` })) }));
  return await boardWith(['question', 'add', '--site', 'orch', '--file', path.join(home, 'q.json')], checkEnv(env));
};

test('a Chrome that fails to start once is launched again in a fresh profile', async () => {
  const dir = tempDir('launch-test-');
  const dirs = [];
  const started = { port: '1', stop() {} };
  const once = async (d) => {
    dirs.push(d);
    if (dirs.length === 1) { fs.writeFileSync(path.join(d, 'stale'), 'x'); throw new ChromeStartError('could not start Chrome'); }
    assert.deepEqual(fs.readdirSync(d), [], 'the retry profile is empty');
    return started;
  };
  try { assert.equal(await startChrome(dir, [], once), started); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.equal(dirs.length, 2);
});

test('a Chrome that fails to start twice is refused as a ChromeStartError, which the check names, not a raw TypeError', async () => {
  const dir = tempDir('launch-test-');
  let launches = 0;
  const never = async () => { launches++; throw new ChromeStartError('could not start Chrome'); };
  try { await assert.rejects(startChrome(dir, [], never), ChromeStartError); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.equal(launches, 2);
});

// #353's round-1 takes drew the board's real threads, which the prototype page did not load.
const THREADS = `export function render(stage, kit) { stage.innerHTML = BoardUI.threadMessages([{ ts: new Date().toISOString(), who: 'claude', kind: 'status', text: 'Reading' }], {}); }`;

test('a prototype question publishes when every take renders, threads included', { skip }, async () => {
  await recordPrototype('site', ['A:Plain', 'B:Threads'], false);
  write(takePath('site', 'A'), 'export function render(stage, kit) { stage.innerHTML = `<p>${kit.esc("hello")}</p>`; }');
  write(takePath('site', 'B'), THREADS);
  const r = await add(['A', 'B']);
  assert.equal(r.code, 0, r.err);
  assert.equal(read(site('orch', 'data', 'owner.json')).items.length, 1);
});

test('a prototype question is refused, naming each take that throws, logs an error or draws nothing', { skip }, async () => {
  await recordPrototype('site', ['A:Fine', 'B:Throws', 'C:Logs', 'D:Empty', 'E:Rejects'], false);
  write(takePath('site', 'A'), 'export function render(stage) { stage.innerHTML = "<p>ok</p>"; }');
  write(takePath('site', 'B'), 'export function render() { null.missing; }');
  write(takePath('site', 'C'), 'export function render(stage) { stage.innerHTML = "<p>ok</p>"; console.error("late boom"); }');
  write(takePath('site', 'D'), 'export function render() {}');
  write(takePath('site', 'E'), 'export async function render(stage) { stage.innerHTML = "<p>ok</p>"; Promise.reject(new Error("unhandled boom")); }');
  const r = await add(['A', 'B', 'C', 'D', 'E']);
  assert.equal(r.code, 1);
  for (const want of ['take B at 390px: ', 'take B at 1280px: ', 'take C at 390px: console error: late boom', 'take D at 1280px: renders an empty stage', 'take E at 390px: ']) {
    assert.ok(r.err.includes(want), `${want} in ${r.err}`);
  }
  assert.ok(!/take A /.test(r.err), r.err);
  assert.equal(fs.existsSync(site('orch', 'data', 'owner.json')) ? read(site('orch', 'data', 'owner.json')).items.length : 0, 0);
});

// docs/adr/2026-11-12-0300-a-prototype-stage-shows-what-the-board-hides-by-width.md
// T-90's round 3 drew inside a box style.css hid from 900px, so it was blank on a desktop.
test('a take whose box is hidden at one width is refused naming its class; the stage shows the key hint and the board pane at both', { skip }, async () => {
  await recordPrototype('site', ['A:Hint', 'B:Pane', 'C:Hidden'], false);
  write(takePath('site', 'A'), 'export function render(stage) { stage.innerHTML = `<p><span class="key-hint">⌘K</span></p>`; }');
  write(takePath('site', 'B'), 'export function render(stage) { stage.innerHTML = `<aside class="board-pane"><p>pane</p></aside>`; }');
  write(takePath('site', 'C'), 'export function render(stage) { stage.innerHTML = `<style>@media (min-width: 900px) { .gone { display: none; } }</style><p class="gone">x</p><p class="kept">y</p>`; }');
  const r = await add(['A', 'B', 'C']);
  assert.equal(r.code, 1);
  assert.ok(r.err.includes('take C: .gone is hidden at 1280px and shown at 390px'), r.err);
  assert.ok(!/take [AB]/.test(r.err), r.err);
  assert.ok(!r.err.includes('.kept'), r.err);
});

// docs/adr/2026-11-06-1500-a-prototype-round-is-a-page-in-the-boards-base-worktree.md
// A served round's check runs the base worktree's build script itself and loads the page for each take and state.
test("a served round's question is refused naming each take or state whose page throws, and publishes once they all draw", { skip }, async () => {
  const base = at('kickflip', 'worktrees', 'orch-prototypes');
  write(at('kickflip', 'manifest.json'), { sites: { orch: { dir: site('orch'), cmd: ['node', 'board/server.mjs'], owner: { repo: home } } } });
  const page = (bad) => `<!doctype html><body><main id="app"></main><script>
    const q = new URLSearchParams(location.search);
    if (${JSON.stringify(bad)}.includes(q.get('variant') + '/' + q.get('state'))) null.missing;
    document.getElementById('app').textContent = q.get('variant') + ' ' + q.get('state');
  </script></body>`;
  const serve = (bad) => {
    write(path.join(base, 'page.html'), page(bad));
    write(path.join(base, '.kickflip', 'build'), `#!${process.execPath}
const http = require('node:http');
const fs = require('node:fs');
const server = http.createServer((req, res) => req.url.startsWith('/proto/look') ? res.writeHead(200, { 'content-type': 'text/html' }).end(fs.readFileSync('page.html')) : res.writeHead(404).end());
server.listen(0, process.env.HOST, () => console.log('port ' + server.address().port));
`);
    fs.chmodSync(path.join(base, '.kickflip', 'build'), 0o700);
  };
  const r0 = await boardWith(['prototype', 'add', 'look', '--site', 'orch', '--title', 'Look', '--served', '/proto/look', '--take', 'A:Chips', '--take', 'B:Stepper', '--state', 'empty:None', '--state', 'busy:Ten']);
  assert.equal(r0.code, 0, r0.err);
  write(path.join(home, 'q.json'), question('q1', { url: 'prototype-look.html?q=q1', options: [{ id: 'A', label: 'Chips' }, { id: 'B', label: 'Stepper' }] }));
  const ask = () => boardWith(['question', 'add', '--site', 'orch', '--file', path.join(home, 'q.json')], checkEnv());
  serve(['B/empty', 'A/busy']);
  const refused = await ask();
  assert.equal(refused.code, 1);
  for (const want of ['take B, state empty at 390px: ', 'take A, state busy at 1280px: ']) assert.ok(refused.err.includes(want), `${want} in ${refused.err}`);
  assert.ok(!refused.err.includes('take A, state empty'), refused.err);
  assert.match(refused.err, /fix its page in .*orch-prototypes and ask again/);
  serve([]);
  const r = await ask();
  assert.equal(r.code, 0, r.err);
});

// The hub serves these under /_hub/; the check serves the same files, so a take that draws the kit's sidebar or hub header passes.
test('a prototype question publishes when a take draws the sidebar and one draws the hub with its header', { skip }, async () => {
  await recordPrototype('site', ['A:Sidebar', 'B:Hub'], false);
  write(takePath('site', 'A'), 'export function render(stage, kit) { stage.innerHTML = kit.sidebar(); }');
  write(takePath('site', 'B'), 'export function render(stage, kit) { stage.innerHTML = kit.hub(); }');
  const r = await add(['A', 'B']);
  assert.equal(r.code, 0, r.err);
  assert.equal(read(site('orch', 'data', 'owner.json')).items.length, 1);
});
