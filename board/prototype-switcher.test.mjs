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

// docs/adr/2026-11-05-1302-a-questions-prototypes-open-in-a-full-page-viewer.md
test("a drafted pick, the one Send on the question would send, reads Picked over the last answer; a resolved question offers no pick", () => {
  assert.equal(sw.pickState(question, 'B', 'B').kind, 'picked');
  assert.equal(sw.pickState(question, 'A', 'B').kind, 'change');
  assert.equal(sw.pickState(answered('A'), 'B', 'B').kind, 'picked');
  assert.equal(sw.pickState(answered('A'), 'A', 'B').kind, 'change');
  const resolved = { ...answered('B'), state: 'resolved' };
  assert.equal(sw.pickState(resolved, 'B').kind, 'picked');
  assert.equal(sw.pickState(resolved, 'A').kind, 'none');
  // A question waiting on the prototype the owner asked for is locked at the request's pick, whatever is drafted.
  const requested = { ...question, state: 'requested', request: { choice: 'B' } };
  assert.equal(sw.pickState(requested, 'B', 'A').kind, 'picked');
  assert.equal(sw.pickState(requested, 'A', 'A').kind, 'none');
  // The option the overnight triage suggested is pre-checked on the question, so it reads Picked here too.
  assert.equal(sw.pickState({ ...question, suggested: { option: 'B' } }, 'B').kind, 'picked');
  assert.equal(sw.pickState({ ...question, suggested: { option: 'B' } }, 'A').kind, 'change');
});

test("the pill shows the take's name and the pick control for its state", () => {
  const pill = (pick) => sw.pillHtml({ name: 'Named <chips>', pick });
  assert.equal(text(pill({ kind: 'none' })), '‹ Named &lt;chips&gt; ›');
  assert.doesNotMatch(pill({ kind: 'none' }), /data-ps="pick"/);
  assert.match(pill(sw.pickState(question, 'A')), /<button type="button" class="ps-pick" data-ps="pick">Pick this<\/button>/);
  assert.match(pill(sw.pickState(answered('B'), 'A')), />Change pick<\/button>/);
  assert.match(pill(sw.pickState(answered('A'), 'A')), /<span class="ps-picked">Picked<\/span>/);
  assert.doesNotMatch(pill(sw.pickState(answered('A'), 'A')), /data-ps="pick"/);
  const name = 'A long take name with "quotes" & <details> '.repeat(8);
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

// resolved: the questions of its topic /api/board leaves out, which /api/questions answers. drafts: this device's
// unsent {choice, note} by question id, as questions.html keeps them.
function prototypePage(url, { framed = false, owner, resolved = [], drafts = {} }) {
  const listeners = [];
  const el = () => {
    const e = { hidden: false, value: '', textContent: '', innerHTML: '', parts: {}, classList: { add() {} },
      addEventListener: (type, fn) => listeners.push({ target: e, type, fn }), prepend() {}, append() {},
      querySelector: (sel) => (e.parts[sel] ||= el()) };
    return e;
  };
  const sent = [];
  const moves = [];
  const replacements = [];
  let styles = '';
  let fetches = 0;
  const rendered = [];
  const classes = [];
  const controls = [];
  const storage = (entries = {}) => {
    const data = new Map(Object.entries(entries));
    return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) };
  };
  const topics = [{ id: 'item:w/A1', title: 'INT-1: Snooze', state: 'open', open: owner.length, questions: [...owner, ...resolved].map((q) => q.id) }];
  const asked = [];
  const u = new URL(url);
  const win = {
    URL, URLSearchParams, Map, Set, JSON,
    location: { href: u.href, search: u.search, replace: (to) => moves.push(['load', String(to)]) },
    history: { replaceState: (...args) => replacements.push(args) },
    localStorage: storage(Object.fromEntries(Object.entries(drafts).map(([id, d]) => ['qdraft:' + id, JSON.stringify(d)]))),
    sessionStorage: storage(),
    document: { getElementById: () => null, head: { insertAdjacentHTML: (_, html) => { styles += html; } }, body: { append: (el) => controls.push(el) }, documentElement: { classList: { add: (name) => classes.push(name) } },
      createElement: el, querySelector: () => null, addEventListener: (type, fn) => listeners.push({ target: 'document', type, fn }) },
    fetch: async (to) => { fetches++; asked.push(String(to)); return { json: async () => (/api\/questions/.test(to) ? { questions: resolved } : { owner, ownerTopics: topics }) }; },
    ClaudeSite: { url: (p) => new URL(p, 'https://mac.ts.net/orch/').href, send: async (kind, data) => { sent.push([kind, data]); return {}; } },
  };
  win.window = win;
  win.top = framed ? { AppShell: { open: (to, opts) => { moves.push(['app', to, { ...opts }]); return true; } } } : win;
  vm.createContext(win);
  const loaded = [];
  win.document.head.append = (script) => { loaded.push(script.src); script.onload?.(); };
  vm.runInContext(fs.readFileSync(new URL('./public/prototype-switcher.js', import.meta.url), 'utf8'), win);
  const mounted = win.PrototypeSwitcher.mount({ takes: { A: 'Named chips', B: 'One stepper' }, initial: 'A', render: (take) => rendered.push(take) });
  const pill = listeners.find((l) => l.type === 'click')?.target;
  const part = (sel) => controls[0]?.parts[sel];
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const pick = async () => {
    await settle();
    for (const l of listeners.filter((x) => x.target === pill && x.type === 'click')) l.fn({ target: { closest: () => ({ dataset: { ps: 'pick' } }) } });
    await settle();
  };
  return { pick, settle, pillName: () => /<span class="ps-name"[^>]*>([^<]*)</.exec(part('.ps-pill')?.innerHTML || '')?.[1], pill: () => part('.ps-pill')?.innerHTML || '',
    typeNote: (v) => { part('.ps-text').value = v; }, noteBox: () => part('.ps-text')?.value, draft: (id) => JSON.parse(win.localStorage.getItem('qdraft:' + id) ?? 'null'),
    sent, moves, loaded, styles, rendered, classes, controls, replacements, take: mounted.take, fetches: () => fetches, asked };
}

// docs/adr/2026-11-05-1302-a-questions-prototypes-open-in-a-full-page-viewer.md
test('a pick in the viewer drafts that take with the note typed above the pill and returns to its question, sending nothing, through the app shell around a framed page', async () => {
  const owner = [{ ...question, topic: 'item:w/A1' }, { id: 'q2', topic: 'item:w/A1', state: 'open', question: 'Next?', options: [] }];
  for (const framed of [false, true]) {
    const page = prototypePage('https://mac.ts.net/orch/prototype-snooze.html?q=q1', { framed, owner });
    await page.settle();
    page.typeNote('  On a phone  ');
    await page.pick();
    assert.equal(page.pillName(), 'Named chips');
    assert.deepEqual(page.sent, []);
    assert.deepEqual(page.draft('q1'), { choice: 'A', note: 'On a phone' });
    assert.deepEqual(plain(page.moves), [framed ? ['app', 'https://mac.ts.net/orch/questions.html#q1', { replace: true }] : ['load', 'https://mac.ts.net/orch/questions.html#q1']]);
    assert.deepEqual(page.loaded, []);
  }
});

test('the viewer keeps a drafted note and its pick, and Change pick drafts the new take over them', async () => {
  const page = prototypePage('https://mac.ts.net/orch/prototype-snooze.html?q=q1', { owner: [{ ...question, topic: 'item:w/A1' }], drafts: { q1: { choice: 'B', note: 'Kept' } } });
  await page.settle();
  assert.equal(page.noteBox(), 'Kept');
  assert.match(page.pill(), />Change pick<\/button>/);
  await page.pick();
  assert.deepEqual(page.draft('q1'), { choice: 'A', note: 'Kept' });
});

test('?take= is no longer an embed: the page keeps its header, pill and question at any take', () => {
  const page = prototypePage('https://mac.ts.net/orch/prototype-snooze.html?q=q1&take=B', { owner: [question] });
  assert.deepEqual(page.classes, []);
  assert.equal(page.controls.length, 1);
  assert.doesNotMatch(page.styles, /ps-embed/);
});

// docs/adr/2026-11-04-0128-the-board-download-leaves-out-resolved-questions.md
test("a prototype page for a resolved question, which /api/board leaves out, loads it from its topic's resolved questions and shows its pick with nothing to change", async () => {
  const done = { ...answered('B'), topic: 'item:w/A1', state: 'resolved' };
  const page = prototypePage('https://mac.ts.net/orch/prototype-snooze.html?q=q1', { owner: [], resolved: [done], next: null });
  await page.settle();
  assert.deepEqual(page.asked, ['https://mac.ts.net/orch/api/board', 'https://mac.ts.net/orch/api/questions?topic=item%3Aw%2FA1']);
  assert.doesNotMatch(page.pill(), /data-ps="pick"/);
  await page.pick();
  assert.deepEqual(page.moves, []);
  assert.equal(page.draft('q1'), null);
});
