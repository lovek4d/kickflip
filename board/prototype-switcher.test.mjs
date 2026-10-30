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
});

test("a pick answers with the label questions.html sends for that option", () => {
  for (const o of question.options) assert.equal(sw.answerLabel(o), ui.choiceLabel(question, o.id));
});

test('after a pick the page moves on to the next open question of the same topic, wrapping to the top, else to none', () => {
  const q = (id, topic, state = 'open') => ({ id, topic, state });
  const owner = [q('a', 'item:w/A1'), q('b', 'item:w/A1', 'answered'), q('c', 'item:w/A2'), q('d', 'item:w/A1'), q('e', 'item:w/A1')];
  assert.equal(sw.nextQuestion(owner, 'd').id, 'e');
  assert.equal(sw.nextQuestion(owner, 'e').id, 'a');
  assert.equal(sw.nextQuestion(owner, 'c'), null);
  assert.equal(sw.nextQuestion([q('a', 't'), q('b', 't', 'resolved')], 'a'), null);
});

function prototypePage(url, { framed = false, owner }) {
  const listeners = [];
  const el = () => {
    const e = { hidden: false, value: '', textContent: '', innerHTML: '', parts: {}, classList: { add() {} },
      addEventListener: (type, fn) => listeners.push({ target: e, type, fn }), prepend() {}, append() {},
      querySelector: (sel) => (e.parts[sel] ||= el()) };
    return e;
  };
  const sent = [];
  const moves = [];
  const u = new URL(url);
  const win = {
    URL, URLSearchParams, Map, Set, JSON,
    location: { href: u.href, search: u.search, replace: (to) => moves.push(['load', String(to)]) },
    history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { getElementById: () => null, head: { insertAdjacentHTML() {} }, body: { append() {} }, documentElement: { classList: { add() {} } },
      createElement: el, querySelector: () => null, addEventListener: (type, fn) => listeners.push({ target: 'document', type, fn }) },
    fetch: async () => ({ json: async () => ({ owner }) }),
    ClaudeSite: { url: (p) => new URL(p, 'https://mac.ts.net/orch/').href, send: async (kind, data) => { sent.push([kind, data]); return {}; } },
  };
  win.window = win;
  win.top = framed ? { AppShell: { open: (to, opts) => { moves.push(['app', to, { ...opts }]); return true; } } } : win;
  vm.createContext(win);
  vm.runInContext(fs.readFileSync(new URL('./public/prototype-switcher.js', import.meta.url), 'utf8'), win);
  win.PrototypeSwitcher.mount({ takes: { A: 'A. Named chips', B: 'B. One stepper' }, initial: 'A', render() {} });
  const pill = listeners.find((l) => l.type === 'click').target;
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const pick = async () => {
    await settle();
    for (const l of listeners.filter((x) => x.target === pill && x.type === 'click')) l.fn({ target: { closest: () => ({ dataset: { ps: 'pick' } }) } });
    await settle();
  };
  return { pick, sent, moves };
}

test('a pick on a prototype page sends the answer, then moves on to the next open question in its place, through the app shell around a framed page', async () => {
  const owner = [{ ...question, topic: 'item:w/A1' }, { id: 'q2', topic: 'item:w/A1', state: 'open', question: 'Next?', options: [] }];
  for (const framed of [false, true]) {
    const page = prototypePage('https://mac.ts.net/orch/prototype-snooze.html?q=q1', { framed, owner });
    await page.pick();
    assert.deepEqual(plain(page.sent), [['owner-answer', { id: 'q1', question: 'Which snooze?', choice: 'A', label: 'A. Named chips', note: '' }]]);
    assert.deepEqual(plain(page.moves), [framed ? ['app', 'https://mac.ts.net/orch/questions.html#q2', { replace: true }] : ['load', 'https://mac.ts.net/orch/questions.html#q2']]);
  }
});
