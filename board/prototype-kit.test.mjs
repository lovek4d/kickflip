import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { tempDir } from '../shared/temp-dir.mjs';

const listeners = [];
const capture = (opts) => opts === true || Boolean(opts?.capture);
class Target {
  addEventListener(type, fn, opts) { listeners.push({ target: this, type, fn, capture: capture(opts) }); }
  removeEventListener(type, fn, opts) {
    const i = listeners.findIndex((l) => l.target === this && l.type === type && l.fn === fn && l.capture === capture(opts));
    if (i >= 0) listeners.splice(i, 1);
  }
}
const timers = new Set();
let timerIds = 0;
const stages = [];
function stage() {
  const s = { id: 'stage', innerHTML: '', style: {}, offsetHeight: 400, boxes: [], cloneNode: () => stage(), replaceWith: (next) => { current = next; },
    querySelectorAll: (sel) => (sel === '*' ? s.boxes : []) };
  stages.push(s);
  return s;
}
let current = stage();
const toastEl = { hidden: true, textContent: '' };
const document = Object.assign(new Target(), {
  documentElement: { dataset: {}, classList: { add() {} } },
  getElementById: (id) => (id === 'stage' ? current : id === 'protoToast' ? toastEl : null),
});
let mounted = null;
const scrolls = [];
Object.assign(globalThis, {
  EventTarget: Target, window: globalThis, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  MutationObserver: class { observe() {} disconnect() {} }, requestAnimationFrame: (fn) => fn(), document, scrollY: 250, scrollTo: (...args) => scrolls.push(args),
  setTimeout: () => { timers.add(++timerIds); return timerIds; }, clearTimeout: (id) => timers.delete(id),
  setInterval: () => { timers.add(++timerIds); return timerIds; }, clearInterval: (id) => timers.delete(id),
  PrototypeSwitcher: { startTake: (keys, wanted, initial) => (keys.includes(wanted) ? wanted : initial) },
});
const dir = tempDir('kit-');
globalThis.location = { href: pathToFileURL(path.join(dir, 'prototype-x.stage.html')).href, search: '' };
const load = (file) => vm.runInThisContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
for (const file of ['ui-icon-text.js', 'ui.js','ui-links.js', 'ui-enums.js', 'ui-progress-bar.js', 'ui-cards.js', 'ui-page-header.js', 'ui-icon-text.js', 'ui-sidebar.js', 'ui-hub.js', 'prototype-kit.js']) load(file);
const kit = globalThis.PrototypeKit;

const takeDir = path.join(dir, 'prototypes', 'x');
fs.mkdirSync(takeDir, { recursive: true });
fs.writeFileSync(path.join(takeDir, 'A.js'), `export function render(stage, kit) {
  stage.innerHTML = 'A ' + typeof kit.hub;
  document.addEventListener('keydown', function onKey() {});
  window.addEventListener('resize', () => {});
  setInterval(() => {}, 1000);
  kit.on(stage, 'click', () => {});
  return () => { globalThis.cleanedA = (globalThis.cleanedA || 0) + 1; };
}`);
fs.writeFileSync(path.join(takeDir, 'B.js'), 'export async function render(stage) { stage.innerHTML = "B"; }');
fs.writeFileSync(path.join(takeDir, 'D.js'), 'export function render() { throw new Error("no <stage>"); }');
// E and F draw the same page with a scrolled list and a strip; F's strip sits one level deeper.
const boxes = (deep) => `(stage) => {
  const box = (tagName, className, parentElement) => ({ tagName, className, parentElement, scrollTop: 0, scrollLeft: 0 });
  const main = box('MAIN', 'take', stage);
  const lists = [box('UL', 'list', main), box('UL', 'list', main)];
  const wrap = box('DIV', 'wrap', main);
  const strip = box('DIV', 'strip', ${deep} ? wrap : main);
  stage.boxes = [main, ...lists, wrap, strip];
  stage.innerHTML = 'boxes';
}`;
fs.writeFileSync(path.join(takeDir, 'E.js'), `export const render = ${boxes(false)};`);
fs.writeFileSync(path.join(takeDir, 'F.js'), `export const render = ${boxes(true)};`);
const takes = [{ key: 'A', label: 'Keys', src: 'prototypes/x/A.js?v=1', file: 'prototypes/x/A.js' }, { key: 'B', label: 'Plain', src: 'prototypes/x/B.js?v=1', file: 'prototypes/x/B.js' },
  { key: 'C', label: 'Missing', src: null, file: 'prototypes/x/C.js' }, { key: 'D', label: 'Broken', src: 'prototypes/x/D.js?v=1', file: 'prototypes/x/D.js' },
  { key: 'E', label: 'Boxes', src: 'prototypes/x/E.js?v=1', file: 'prototypes/x/E.js' }, { key: 'F', label: 'Deeper', src: 'prototypes/x/F.js?v=1', file: 'prototypes/x/F.js' }];

test('each take renders into a fresh stage, the first the URL names, and switching ends what the last take added and keeps the scroll position', async () => {
  const before = listeners.length;
  mounted = kit.stage({ topic: 'x', title: 'X', takes });
  const kitListeners = listeners.slice(before);
  await kit.drawn;
  assert.equal(current.innerHTML, 'A function');
  assert.equal(document.documentElement.dataset.take, 'A');
  const added = listeners.slice(before + kitListeners.length);
  assert.deepEqual(added.map((l) => [l.target === document ? 'document' : l.target === globalThis ? 'window' : 'stage', l.type]), [['document', 'keydown'], ['window', 'resize'], ['stage', 'click']]);
  assert.equal(timers.size, 1);

  await mounted.render('B');
  assert.equal(globalThis.cleanedA, 1);
  assert.deepEqual(listeners.slice(before), kitListeners);
  assert.equal(timers.size, 0);
  assert.equal(current.innerHTML, 'B');
  assert.notEqual(current, stages[1]);
  assert.equal(current.style.minHeight, '');
  assert.deepEqual(scrolls.at(-1), [0, 250]);

  await mounted.render('C');
  assert.equal(current.innerHTML, '<p class="kit-missing">Take C has no file yet: write public/prototypes/x/C.js, exporting render(stage, kit).</p>');
  await mounted.render('D');
  assert.equal(current.innerHTML, '<p class="kit-missing">Take D failed: no &lt;stage&gt;</p>');
});

// docs/adr/2026-11-05-1302-a-questions-prototypes-open-in-a-full-page-viewer.md
test("a switch keeps each scrolled box inside the take where it was, matched by its place in the stage, as well as the page's scroll", async () => {
  await mounted.render('E');
  const [, , second, , strip] = current.boxes;
  second.scrollTop = 140;
  strip.scrollLeft = 60;
  await mounted.render('E');
  assert.deepEqual(current.boxes.map((b) => [b.scrollTop, b.scrollLeft]), [[0, 0], [0, 0], [140, 0], [0, 0], [0, 60]]);
  assert.deepEqual(scrolls.at(-1), [0, 250]);
  await mounted.render('F');
  assert.deepEqual(current.boxes.map((b) => [b.scrollTop, b.scrollLeft]), [[0, 0], [0, 0], [140, 0], [0, 0], [0, 0]]);
  await mounted.render('B');
  assert.equal(current.innerHTML, 'B');
});

test('a link or form in the stage never navigates or sends, and toasts unless the take showed its own toast', () => {
  const fire = (type, target, between = () => {}) => {
    const e = { type, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const l of listeners.filter((x) => x.target === document && x.type === type && x.capture)) l.fn(e);
    between();
    for (const l of listeners.filter((x) => x.target === globalThis && x.type === type && !x.capture)) l.fn(e);
    return e;
  };
  const inStage = (match) => ({ closest: (sel) => (match(sel) ? { getAttribute: () => 'questions.html' } : null) });
  const link = inStage((sel) => sel === '#stage a[href]');
  assert.equal(fire('click', link).defaultPrevented, true);
  assert.deepEqual([toastEl.hidden, toastEl.textContent], [false, 'Prototype: this link opens questions.html']);
  fire('click', link, () => kit.toast('Opens Hub.'));
  assert.equal(toastEl.textContent, 'Opens Hub.');
  fire('click', inStage((sel) => sel === '#stage [data-kit-inert]'));
  assert.equal(toastEl.textContent, 'Prototype: nothing happens here.');
  assert.equal(fire('submit', inStage((sel) => sel === '#stage form')).defaultPrevented, true);
  assert.equal(toastEl.textContent, 'Prototype: nothing is sent.');
  toastEl.textContent = '';
  assert.equal(fire('click', inStage(() => false)).defaultPrevented, false);
  assert.equal(toastEl.textContent, '');
});

test("the kit draws the real sidebar, Hub page, cards and a sheet in the stage's flow", () => {
  const data = kit.fake.sidebar();
  assert.equal(kit.sidebar(data, { here: 'hub-orchestrator' }), `<aside class="sidebar kit-sidebar" aria-label="Boards">${globalThis.BoardUI.sidebar(data, { here: 'hub-orchestrator' })}</aside>`);
  assert.match(kit.sidebar(data, { switching: true, head: true, height: 500 }), /^<aside class="sidebar kit-sidebar kit-head ks-on" aria-label="Boards" style="height:500px">/);
  const usage = kit.fake.usage({ claude: [10, 66], codex: null });
  assert.deepEqual(Object.keys(usage), ['claude']);
  assert.equal(usage.claude.seven_day.used_percentage, 66);
  const hub = kit.hub({ usage, afterUsage: '<section id="mine"></section>', settings: [['rules', 'Rules', '1 rule']] });
  assert.ok(hub.startsWith('<div class="hub-view view-hub kit-hub"><header class="top">'));
  assert.ok(hub.includes(`${globalThis.HubUI.usageCard(usage)}<section id="mine"></section><h2 class="label">Health</h2>`));
  assert.match(hub, /<button type="button" class="hub-setting" data-setting="rules" data-kit-inert aria-haspopup="dialog">/);
  assert.doesNotMatch(kit.hub({ header: false, usageCard: '<div id="card"></div>' }), /<header|u-block/);
  const cards = kit.cards();
  assert.deepEqual([...cards.matchAll(/data-lane="(\w+)"/g)].map((m) => m[1]), ['review', 'progress', 'todo']);
  assert.match(cards, /<details class="item" data-key="w\/C0"><summary class="work"><span class="status review"><\/span><div class="title-wrap">/);
  assert.doesNotMatch(kit.cards(kit.fake.items(), { lanes: false }), /data-lane/);
  assert.match(kit.sheet('<p>Body</p>', { title: 'New <task>' }), /<section class="kit-sheet" role="group" aria-label="New &lt;task&gt;"><div class="sheet-head"><h2>New &lt;task&gt;<\/h2>[\s\S]*<div class="kit-sheet-body"><p>Body<\/p><\/div>/);
});

test('the prototype viewer and its stage load every script app.html does, in its order, then the switcher and the kit', () => {
  const srcs = (file) => [...fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8').matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  const app = srcs('app.html').map((src) => src.replace('/_hub/app/', ''));
  assert.deepEqual(srcs('prototype.html'), [...app, 'prototype-switcher.js', 'prototype-kit.js']);
  assert.deepEqual(srcs('prototype-stage.html'), [...app, 'prototype-switcher.js', 'prototype-kit.js']);
});
