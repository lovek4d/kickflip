// docs/adr/2026-11-06-0145-every-run-takes-its-lanes-colour.md: the progress-bar review page (public/progress-review.html).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { miniDom } from './mini-dom.mjs';

const page = fs.readFileSync(new URL('./public/progress-review.html', import.meta.url), 'utf8');
const scripts = [...page.matchAll(/<script src="([\w.-]+)"><\/script>/g)].map((m) => m[1]);
const context = vm.createContext({ location: { hostname: 'mac.ts.net', host: 'mac.ts.net:443' }, setTimeout, clearTimeout });
for (const file of scripts.filter((f) => f !== 'claude.js')) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), context);
const { ProgressReview: review, BoardUI: ui } = context;
const plain = (v) => JSON.parse(JSON.stringify(v));

test('the review page lays out every bar and status line the board draws, in the lane it shows in, its steps read from the live renderers, each drawn by the real card or sidebar renderer', () => {
  const entries = review.entries();
  assert.deepEqual(plain(entries.map((e) => [e.id, e.lane])), [
    ['grill', 'todo'], ['prototype', 'todo'],
    ['build', 'progress'], ['check', 'progress'], ['install', 'progress'], ['start', 'progress'],
    ['rebase', 'review'], ['merging', 'review'], ['stopped', 'review']]);
  const steps = Object.fromEntries(entries.map((e) => [e.id, e.steps]));
  for (const id of ['grill', 'prototype', 'build', 'check', 'install']) assert.deepEqual(plain(steps[id]), plain(ui.BUILD_PHASES), id);
  assert.deepEqual(plain(steps.start), Object.values(plain(ui.START_STEPS)));
  for (const id of ['rebase', 'merging', 'stopped']) assert.deepEqual(plain(steps[id]), [], `${id} is a status line, no bar`);
  // The steps are the entry's own copy, so a rename on the page never reaches the board's renderers.
  steps.build[0] = 'renamed';
  assert.equal(ui.BUILD_PHASES[0], 'reading');
  const drawn = Object.fromEntries(entries.map((e) => [e.id, review.cardHtml(e)]));
  assert.match(drawn.grill, /class="line3 sub agent planner in-todo"/);
  assert.match(drawn.grill, /class="phase-bars in-todo"/);
  assert.match(drawn.build, /class="line3 sub agent in-progress"/);
  assert.match(drawn.check, /aria-label="Orchestrator review, step 4 of 5"/);
  assert.match(drawn.start, /class="sb-steps"><span class="phase-bars"/);
  assert.match(drawn.rebase, /class="line3 sub agent in-review"><span class="working-dot" aria-hidden="true"><\/span>Rebasing onto main/);
  assert.doesNotMatch(drawn.rebase, /phase-bars/);
  assert.match(drawn.merging, /Next: Merging/);
  assert.match(drawn.stopped, /Land stopped/);
});

// The page on a mini DOM: events bubble from their target to the root, and Send records what it would post.
async function mountedPage() {
  const listeners = [];
  class Target {
    addEventListener(type, fn) { listeners.push({ target: this, type, fn }); }
  }
  const document = new Target();
  miniDom(Target, document);
  const sent = [];
  const colours = { '--muted': '#6b6b76', '--color-notice': '#d97706', '--color-info': '#2b6cb0' };
  const win = { document, location: context.location, setTimeout, clearTimeout,
    getComputedStyle: () => ({ getPropertyValue: (name) => ` ${colours[name]}` }),
    ClaudeSite: { send: async (kind, data) => { sent.push({ kind, ...data }); return { id: 'e1' }; } } };
  vm.createContext(win);
  document.body.innerHTML = '<div id="review"></div>';
  document.getElementById = (id) => document.body.querySelector(`#${id}`);
  for (const file of scripts.filter((f) => f !== 'claude.js')) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), win);
  const root = document.body.querySelector('#review');
  const fire = async (target, type) => {
    const ev = { type, target, preventDefault() {} };
    for (let n = target; n; n = n.parentNode) for (const l of listeners.filter((x) => x.target === n && x.type === type)) await l.fn(ev);
  };
  const $ = (sel) => root.querySelector(sel);
  const set = (sel, value, type = 'input') => { const el = $(sel); el.value = value; return fire(el, type); };
  return { root, $, fire, set, sent };
}

test('the page draws the lanes with their colours, opens a tapped card beneath, and Send posts what was renamed, reordered, moved and recoloured as one owner ask', async () => {
  const p = await mountedPage();
  assert.deepEqual(p.root.querySelectorAll('.pr-lane').map((s) => [s.querySelector('h2 span').textContent, s.getAttribute('style'), s.querySelectorAll('.item').length]),
    [['Todo', '--lane:#6b6b76', 2], ['In Progress', '--lane:#d97706', 4], ['In Review', '--lane:#2b6cb0', 3]]);
  assert.equal(p.$('.item[data-open]').dataset.entry, 'grill');
  await p.fire(p.$('.item[data-entry="build"] .title'), 'click');
  assert.equal(p.$('.item[data-open]').dataset.entry, 'build');
  await p.set('[data-name]', 'Building');
  assert.match(p.$('.item[data-entry="build"] .title').textContent, /Building/);
  await p.set('[data-step="0"]', 'planning');
  await p.fire(p.$('button[data-move="0"][value="1"]'), 'click');
  assert.deepEqual(p.root.querySelectorAll('[data-step]').map((i) => i.value), ['building', 'planning', 'testing', 'checking', 'landing']);
  assert.equal(p.$('button[data-move="0"][value="-1"]').hasAttribute('disabled'), true);
  await p.fire(p.$('.item[data-entry="rebase"] .title'), 'click');
  assert.match(p.$('.pr-editor').textContent, /A status line, no steps/);
  await p.set('[data-lane]', 'progress', 'change');
  assert.equal(p.root.querySelectorAll('.pr-lane')[1].querySelectorAll('.item').length, 5);
  await p.set('[data-colour="todo"]', '#999999');
  assert.equal(p.root.querySelectorAll('.pr-lane')[0].getAttribute('style'), '--lane:#999999');
  await p.fire(p.$('[data-send]'), 'click');
  assert.equal(p.sent.length, 1);
  assert.equal(p.sent[0].kind, 'ask');
  const lines = p.sent[0].text.split('\n');
  assert.equal(lines[0], 'Progress bar review');
  assert.ok(lines.includes('Grilling, Todo: reading › building › testing › checking › landing'), 'an untouched bar reads with no was');
  assert.equal(lines[2], 'Lane colours: Todo #999999 (was #6b6b76), In Progress #d97706, In Review #2b6cb0');
  assert.ok(lines.includes('Building (was Build), In Progress: building › planning › testing › checking › landing (was reading › building › testing › checking › landing)'), p.sent[0].text);
  assert.ok(lines.includes('Rebase run, In Progress (was In Review): a status line, no bar'));
  assert.equal(p.$('[data-sent]').textContent, 'Sent. The orchestrator files it as a card.');
});
