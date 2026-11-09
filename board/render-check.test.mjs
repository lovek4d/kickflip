// docs/adr/2026-11-07-0900-a-prototype-question-publishes-only-when-every-take-renders.md
// Needs a real headless Chrome, so it is skipped where none is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { home, at, site, write, read, run, question, takePath, recordPrototype } from './board-fixture.mjs';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const skip = !fs.existsSync(CHROME) && 'no Chrome';
const add = (options, env = {}) => {
  write(path.join(home, 'q.json'), question('q1', { url: 'prototype-site.html?q=q1', options: options.map((id) => ({ id, label: `Take ${id}` })) }));
  return run('board.mjs', ['question', 'add', '--site', 'orch', '--file', path.join(home, 'q.json')], undefined, { KICKFLIP_RENDER_CHECK: 'on', ...env });
};

// A Chrome stand-in that exits at once on its first `failures` launches, then runs the real one: Chrome failing to start under load.
const flakyChrome = (failures) => {
  const script = path.join(home, 'flaky-chrome.sh');
  const count = path.join(home, 'chrome-launches');
  write(script, `#!/bin/sh\necho x >> '${count}'\n[ "$(wc -l < '${count}')" -le ${failures} ] && exit 1\nexec '${CHROME}' "$@"\n`);
  fs.chmodSync(script, 0o755);
  return script;
};

test('a Chrome that fails to start once is launched again, and the question publishes', { skip }, () => {
  recordPrototype('site', ['A:Plain'], false);
  write(takePath('site', 'A'), 'export function render(stage, kit) { stage.innerHTML = `<p>${kit.esc("hello")}</p>`; }');
  const r = add(['A'], { CHROME: flakyChrome(1) });
  assert.equal(r.code, 0, r.err);
  assert.equal(read(site('orch', 'data', 'owner.json')).items.length, 1);
});

test('a Chrome that fails to start twice is refused naming it, not a raw TypeError', { skip }, () => {
  recordPrototype('site', ['A:Plain'], false);
  write(takePath('site', 'A'), 'export function render(stage, kit) { stage.innerHTML = `<p>${kit.esc("hello")}</p>`; }');
  const r = add(['A'], { CHROME: flakyChrome(2) });
  assert.notEqual(r.code, 0);
  assert.match(r.err, /could not start Chrome/);
  assert.doesNotMatch(r.err, /TypeError/);
});

// #353's round-1 takes drew the board's real threads, which the prototype page did not load.
const THREADS = `export function render(stage, kit) { stage.innerHTML = BoardUI.threadMessages([{ ts: new Date().toISOString(), who: 'claude', kind: 'status', text: 'Reading' }], {}); }`;

test('a prototype question publishes when every take renders, threads included', { skip }, () => {
  recordPrototype('site', ['A:Plain', 'B:Threads'], false);
  write(takePath('site', 'A'), 'export function render(stage, kit) { stage.innerHTML = `<p>${kit.esc("hello")}</p>`; }');
  write(takePath('site', 'B'), THREADS);
  const r = add(['A', 'B']);
  assert.equal(r.code, 0, r.err);
  assert.equal(read(site('orch', 'data', 'owner.json')).items.length, 1);
});

test('a prototype question is refused, naming each take that throws, logs an error or draws nothing', { skip }, () => {
  recordPrototype('site', ['A:Fine', 'B:Throws', 'C:Logs', 'D:Empty', 'E:Rejects'], false);
  write(takePath('site', 'A'), 'export function render(stage) { stage.innerHTML = "<p>ok</p>"; }');
  write(takePath('site', 'B'), 'export function render() { null.missing; }');
  write(takePath('site', 'C'), 'export function render(stage) { stage.innerHTML = "<p>ok</p>"; console.error("late boom"); }');
  write(takePath('site', 'D'), 'export function render() {}');
  write(takePath('site', 'E'), 'export async function render(stage) { stage.innerHTML = "<p>ok</p>"; Promise.reject(new Error("unhandled boom")); }');
  const r = add(['A', 'B', 'C', 'D', 'E']);
  assert.equal(r.code, 1);
  for (const want of ['take B at 390px: ', 'take B at 1280px: ', 'take C at 390px: console error: late boom', 'take D at 1280px: renders an empty stage', 'take E at 390px: ']) {
    assert.ok(r.err.includes(want), `${want} in ${r.err}`);
  }
  assert.ok(!/take A /.test(r.err), r.err);
  assert.equal(fs.existsSync(site('orch', 'data', 'owner.json')) ? read(site('orch', 'data', 'owner.json')).items.length : 0, 0);
});

// docs/adr/2026-11-06-1500-a-prototype-round-is-a-page-in-the-boards-base-worktree.md
// A served round's check runs the base worktree's build script itself and loads the page for each take and state.
test("a served round's question is refused naming each take or state whose page throws, and publishes once they all draw", { skip }, () => {
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
  const r0 = run('board.mjs', ['prototype', 'add', 'look', '--site', 'orch', '--title', 'Look', '--served', '/proto/look', '--take', 'A:Chips', '--take', 'B:Stepper', '--state', 'empty:None', '--state', 'busy:Ten']);
  assert.equal(r0.code, 0, r0.err);
  write(path.join(home, 'q.json'), question('q1', { url: 'prototype-look.html?q=q1', options: [{ id: 'A', label: 'Chips' }, { id: 'B', label: 'Stepper' }] }));
  const ask = () => run('board.mjs', ['question', 'add', '--site', 'orch', '--file', path.join(home, 'q.json')], undefined, { KICKFLIP_RENDER_CHECK: 'on' });
  serve(['B/empty', 'A/busy']);
  const refused = ask();
  assert.equal(refused.code, 1);
  for (const want of ['take B, state empty at 390px: ', 'take A, state busy at 1280px: ']) assert.ok(refused.err.includes(want), `${want} in ${refused.err}`);
  assert.ok(!refused.err.includes('take A, state empty'), refused.err);
  assert.match(refused.err, /fix its page in .*orch-prototypes and ask again/);
  serve([]);
  const r = ask();
  assert.equal(r.code, 0, r.err);
});
