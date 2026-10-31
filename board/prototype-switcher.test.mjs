import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({});
for (const file of ['ui.js', 'ui-links.js', 'ui-questions.js', 'prototype-switcher.js']) {
  vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), context);
}
const sw = context.PrototypeSwitcher;
const ui = context.BoardUI;
const plain = (v) => JSON.parse(JSON.stringify(v));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const question = {
  id: 'q1', question: 'Which snooze?', state: 'open', answers: [],
  options: [{ id: 'A', label: 'Named chips', recommended: true }, { id: 'B', label: 'One stepper' }],
};
const answered = (...choices) => ({ ...question, state: 'answered', answers: choices.map((choice) => ({ ts: '2026-10-23T10:00:00Z', choice, note: '', reply: null })) });

test('takes cycle in order and wrap at both ends', () => {
  const keys = ['now', 'A', 'B', 'C'];
  assert.equal(sw.takeAt(keys, 'A', 1), 'B');
  assert.equal(sw.takeAt(keys, 'C', 1), 'now');
  assert.equal(sw.takeAt(keys, 'now', -1), 'C');
  assert.equal(sw.takeAt(keys, 'gone', 1), 'A');
});

test('the page opens on the take in ?variant=, else its initial take, else the first', () => {
  assert.equal(sw.startTake(['now', 'A', 'B'], 'B', 'A'), 'B');
  assert.equal(sw.startTake(['now', 'A', 'B'], 'Z', 'A'), 'A');
  assert.equal(sw.startTake(['now', 'A', 'B'], null, undefined), 'now');
});

test('a take is pickable only when it is one of the question options', () => {
  assert.equal(sw.pickState(null, 'A').kind, 'none');
  assert.equal(sw.pickState(question, 'now').kind, 'none');
  assert.deepEqual(plain(sw.pickState(question, 'A')), { kind: 'pick', option: question.options[0] });
});

test('once answered, the picked take reads Picked and every other take offers Change pick', () => {
  assert.equal(sw.pickState(answered('B'), 'B').kind, 'picked');
  assert.equal(sw.pickState(answered('B'), 'A').kind, 'change');
  assert.equal(sw.pickState(answered('A', 'B'), 'B').kind, 'picked');
  assert.equal(sw.pickState(answered('B', null), 'B').kind, 'picked');
});

test("the pill shows the take's name and the pick control for its state", () => {
  const pill = (pick, busy) => sw.pillHtml({ name: 'A. Named <chips>', pick, busy });
  assert.equal(text(pill({ kind: 'none' })), '‹ A. Named &lt;chips&gt; ›');
  assert.doesNotMatch(pill({ kind: 'none' }), /data-ps="pick"/);
  assert.match(pill(sw.pickState(question, 'A')), /<button type="button" class="ps-pick" data-ps="pick">Pick this<\/button>/);
  assert.match(pill(sw.pickState(answered('B'), 'A')), />Change pick<\/button>/);
  assert.match(pill(sw.pickState(answered('A'), 'A')), /<span class="ps-picked">Picked<\/span>/);
  assert.doesNotMatch(pill(sw.pickState(answered('A'), 'A')), /data-ps="pick"/);
  assert.match(pill(sw.pickState(question, 'A'), true), /data-ps="pick" disabled>Sending…/);
  const name = 'A. A long take name with "quotes" & <details> '.repeat(8);
  const html = sw.pillHtml({ name });
  const escaped = name.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  assert.ok(html.includes(`<span class="ps-name" title="${escaped}">${escaped}</span>`));
  assert.match(html, /data-ps="prev" aria-label="Previous take"/);
  assert.match(html, /data-ps="next" aria-label="Next take"/);
  const page = prototypePage('https://mac.ts.net/orch/prototype-snooze.html', { owner: [] });
  assert.match(page.styles, /\.ps-switch\s*\{[^}]*left:16px;[^}]*right:16px;/);
  assert.match(page.styles, /\.ps-switch > \*\s*\{[^}]*max-width:100%;[^}]*box-sizing:border-box;/);
  assert.match(page.styles, /\.ps-name\s*\{[^}]*min-width:0;[^}]*overflow:hidden;[^}]*text-overflow:ellipsis;/);
  assert.match(page.styles, /\.ps-pill button\s*\{[^}]*flex-shrink:0;[^}]*min-width:44px;[^}]*min-height:44px;/);
});

test("a pick answers with the label questions.html sends for that option", () => {
  for (const o of question.options) assert.equal(sw.answerLabel(o), ui.choiceLabel(question, o.id));
});

function prototypePage(url, { framed = false, owner, next = owner[1] || null }) {
  const listeners = [];
  const el = () => {
    const e = { hidden: false, value: '', textContent: '', innerHTML: '', parts: {}, classList: { add() {} },
      addEventListener: (type, fn) => listeners.push({ target: e, type, fn }), prepend() {}, append() {},
      querySelector: (sel) => (e.parts[sel] ||= el()) };
    return e;
  };
  const sent = [];
  const moves = [];
  const noticesAtMove = [];
  const decisions = [];
  const loaded = [];
  const replacements = [];
  let styles = '';
  let fetches = 0;
  const rendered = [];
  const classes = [];
  const controls = [];
  const storage = () => {
    const data = new Map();
    return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) };
  };
  const topics = [{ id: 'item:w/A1', title: 'INT-1: Snooze', state: 'open', open: owner.length }];
  const move = (to) => { noticesAtMove.push(shared.sessionStorage.getItem('sent:orch')); moves.push(to); };
  const u = new URL(url);
  const win = {
    URL, URLSearchParams, Map, Set, JSON,
    location: { href: u.href, search: u.search, replace: (to) => move(['load', String(to)]) },
    history: { replaceState: (...args) => replacements.push(args) },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: storage(),
    document: { getElementById: () => null, head: { insertAdjacentHTML: (_, html) => { styles += html; } }, body: { append: (el) => controls.push(el) }, documentElement: { classList: { add: (name) => classes.push(name) } },
      createElement: el, querySelector: () => null, addEventListener: (type, fn) => listeners.push({ target: 'document', type, fn }) },
    fetch: async () => { fetches++; return { json: async () => ({ owner, ownerTopics: topics }) }; },
    ClaudeSite: { url: (p) => new URL(p, 'https://mac.ts.net/orch/').href, send: async (kind, data) => { sent.push([kind, data]); return {}; } },
  };
  win.window = win;
  const app = { sessionStorage: storage(), AppShell: { open: (to, opts) => { move(['app', to, { ...opts }]); return true; } } };
  const shared = framed ? app : win;
  if (framed) {
    vm.createContext(app);
    for (const file of ['ui.js', 'ui-links.js', 'ui-questions.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), app);
  }
  const follow = () => {
    shared.BoardUI.nextQuestion = (...args) => { decisions.push(plain(args)); return next; };
  };
  if (framed) follow();
  win.top = framed ? app : win;
  vm.createContext(win);
  win.document.head.append = (script) => {
    const file = new URL(script.src).pathname.split('/').pop();
    loaded.push(script.src);
    vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), win);
    if (file === 'ui-questions.js') follow();
    script.onload();
  };
  vm.runInContext(fs.readFileSync(new URL('./public/prototype-switcher.js', import.meta.url), 'utf8'), win);
  const mounted = win.PrototypeSwitcher.mount({ takes: { A: 'A. Named chips', B: 'B. One stepper' }, initial: 'A', render: (take) => rendered.push(take) });
  const pill = listeners.find((l) => l.type === 'click')?.target;
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const pick = async () => {
    await settle();
    for (const l of listeners.filter((x) => x.target === pill && x.type === 'click')) l.fn({ target: { closest: () => ({ dataset: { ps: 'pick' } }) } });
    await settle();
  };
  return { pick, sent, moves, noticesAtMove, decisions, loaded, styles, rendered, classes, controls, replacements, take: mounted.take, fetches: () => fetches, notice: () => shared.BoardUI.sentNotice.take('orch'), localNotice: () => win.sessionStorage.getItem('sent:orch') };
}

test('a pick on a prototype page sends the answer, then moves on to the next open question in its place, or with none left to the board, through the app shell around a framed page', async () => {
  const owner = [{ ...question, topic: 'item:w/A1' }, { id: 'q2', topic: 'item:w/A1', state: 'open', question: 'Next?', options: [] }];
  for (const framed of [false, true]) {
    const page = prototypePage('https://mac.ts.net/orch/prototype-snooze.html?q=q1', { framed, owner });
    await page.pick();
    assert.deepEqual(plain(page.sent), [['owner-answer', { id: 'q1', question: 'Which snooze?', choice: 'A', label: 'A. Named chips', note: '' }]]);
    assert.deepEqual(plain(page.moves), [framed ? ['app', 'https://mac.ts.net/orch/questions.html#q2', { replace: true }] : ['load', 'https://mac.ts.net/orch/questions.html#q2']]);
    assert.deepEqual(page.decisions.map(([qs, pills, answered]) => [qs.map((q) => q.id), pills.map((t) => t.id), answered.id]), [[['q1', 'q2'], ['item:w/A1'], 'q1']]);
    assert.equal(page.notice(), '');
    assert.deepEqual(page.noticesAtMove, [null]);
    assert.deepEqual(page.loaded, framed ? [] : ['ui.js', 'ui-links.js', 'ui-questions.js'].map((f) => 'https://mac.ts.net/orch/' + f));
    const prototype = prototypePage('https://mac.ts.net/orch/prototype-snooze.html?q=q1', { framed, owner, next: { ...owner[1], url: 'prototype-next.html?q=q2' } });
    await prototype.pick();
    assert.deepEqual(plain(prototype.moves), [framed ? ['app', 'https://mac.ts.net/orch/prototype-next.html?q=q2', { replace: true }] : ['load', 'https://mac.ts.net/orch/prototype-next.html?q=q2']]);
    const last = prototypePage('https://mac.ts.net/orch/prototype-snooze.html?q=q1', { framed, owner: owner.slice(0, 1) });
    await last.pick();
    assert.deepEqual(plain(last.moves), [framed ? ['app', 'https://mac.ts.net/orch/', { replace: true }] : ['load', 'https://mac.ts.net/orch/']]);
    assert.equal(last.decisions.length, 1);
    assert.deepEqual(last.noticesAtMove, ['Sent 1 answer to INT-1.']);
    if (framed) assert.equal(last.localNotice(), null);
    assert.equal(last.notice(), 'Sent 1 answer to INT-1.');
    assert.equal(last.notice(), '');
  }
});

test('a take embedded by Waiting on you renders only that take without fetching the question, adding pick controls or changing history', () => {
  const page = prototypePage('https://mac.ts.net/orch/prototype-snooze.html?q=q1&take=B', { framed: true, owner: [question] });
  assert.deepEqual(page.rendered, ['B']);
  assert.equal(page.take, 'B');
  assert.deepEqual(page.classes, ['ps-embed']);
  assert.deepEqual(page.controls, []);
  assert.equal(page.fetches(), 0);
  assert.deepEqual(page.moves, []);
  assert.deepEqual(page.replacements, []);
  assert.deepEqual(page.sent, []);
  assert.deepEqual(page.loaded, []);
  assert.match(page.styles, /\.ps-embed header\.top \{ display:none; \}/);
  assert.match(page.styles, /\.ps-embed main \{ padding-bottom:12px !important; \}/);
});
