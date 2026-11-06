// docs/adr/2026-11-07-0900-a-prototype-question-publishes-only-when-every-take-renders.md
// Needs a real headless Chrome, so it is skipped where none is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { home, site, write, read, run, question, takePath, recordPrototype } from './board-fixture.mjs';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const skip = !fs.existsSync(CHROME) && 'no Chrome';
const add = (options) => {
  write(path.join(home, 'q.json'), question('q1', { url: 'prototype-site.html?q=q1', options: options.map((id) => ({ id, label: `Take ${id}` })) }));
  return run('board.mjs', ['question', 'add', '--site', 'orch', '--file', path.join(home, 'q.json')], undefined, { KICKFLIP_RENDER_CHECK: 'on' });
};

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
