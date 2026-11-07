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

test('once answered, the picked take reads Picked and every other take offers Choose this again', () => {
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
  assert.equal(sw.pickState(resolved, 'A').kind, 'closed');
  // A question waiting on the prototype the owner asked for is locked at the request's pick, whatever is drafted.
  const requested = { ...question, state: 'requested', request: { choice: 'B' } };
  assert.equal(sw.pickState(requested, 'B', 'A').kind, 'picked');
  assert.equal(sw.pickState(requested, 'A', 'A').kind, 'none');
  // The option the overnight triage suggested is pre-checked on the question, so it reads Picked here too.
  assert.equal(sw.pickState({ ...question, suggested: { option: 'B' } }, 'B').kind, 'picked');
  assert.equal(sw.pickState({ ...question, suggested: { option: 'B' } }, 'A').kind, 'change');
});

// docs/adr/2026-11-07-0300-prototypes-have-their-own-button-and-viewer.md
test("the bar shows the take's name between ‹ and ›, and below it, on its own row, the pick control for its state", () => {
  const pill = (pick) => sw.pillHtml({ name: 'Named <chips>', pick });
  assert.equal(text(pill({ kind: 'none' })), '‹ Named &lt;chips&gt; ›');
  assert.doesNotMatch(pill({ kind: 'none' }), /data-ps="pick"|ps-act/);
  assert.match(pill(sw.pickState(question, 'A')), /<\/div><div class="ps-row ps-act"><button type="button" class="ps-pick" data-ps="pick">Choose this<\/button><\/div>$/);
  assert.match(pill(sw.pickState(answered('B'), 'A')), />Choose this<\/button>/);
  assert.match(pill(sw.pickState(answered('A'), 'A')), /<span class="ps-picked">Picked<\/span>/);
  assert.doesNotMatch(pill(sw.pickState(answered('A'), 'A')), /data-ps="pick"/);
  assert.match(pill(sw.pickState({ ...answered('B'), state: 'resolved' }, 'A')), /<span class="ps-closed">Round answered<\/span>/);
  const name = 'A long take name with "quotes" & <details> '.repeat(8);
  const html = sw.pillHtml({ name });
  const escaped = name.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  assert.ok(html.includes(`<span class="ps-name" title="${escaped}">${escaped}</span>`));
  assert.match(html, /data-ps="prev" aria-label="Previous take"/);
  assert.match(html, /data-ps="next" aria-label="Next take"/);
  const page = prototypePage('https://mac.ts.net/orch/prototype-snooze.html', { owner: [] });
  assert.match(page.styles, /\.ps-switch\s*\{[^}]*left:0; right:0;/);
  assert.match(page.styles, /\.ps-switch > \*\s*\{[^}]*min-width:0;[^}]*box-sizing:border-box;/);
  assert.match(page.styles, /\.ps-name\s*\{[^}]*min-width:0;[^}]*overflow:hidden;[^}]*text-overflow:ellipsis;/);
  assert.match(page.styles, /\.ps-pill button\s*\{[^}]*flex-shrink:0;[^}]*min-width:44px;[^}]*min-height:44px;/);
});

// resolved: the questions of its topic /api/board leaves out, which /api/questions answers. drafts: this device's
// unsent {choice, note} by question id, as questions.html keeps them. pane: framed in the board's right pane
// (app-needs.js openViewer).
function prototypePage(url, { framed = false, pane = false, owner, resolved = [], drafts = {}, rounds = null }) {
  const listeners = [];
  const el = () => {
    const e = { hidden: false, value: '', textContent: '', innerHTML: '', parts: {}, classList: { add() {}, remove() {} },
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
  let backs = 0;
  const backLink = { click: () => { backs++; } };
  const u = new URL(url);
  const win = {
    URL, URLSearchParams, Map, Set, JSON,
    ResizeObserver: class { observe() {} },
    setTimeout: () => 0,
    location: { href: u.href, search: u.search, replace: (to) => moves.push(['load', String(to)]) },
    history: { replaceState: (...args) => replacements.push(args) },
    localStorage: storage(Object.fromEntries(Object.entries(drafts).map(([id, d]) => ['qdraft:' + id, JSON.stringify(d)]))),
    sessionStorage: storage(),
    document: { getElementById: () => null, head: { insertAdjacentHTML: (_, html) => { styles += html; } }, body: { append: (el) => controls.push(el) }, documentElement: { style: { setProperty() {} }, classList: { add: (name) => classes.push(name) } },
      createElement: el, querySelector: (sel) => (sel === 'header.top a.back' ? backLink : null), addEventListener: (type, fn) => listeners.push({ target: 'document', type, fn }) },
    fetch: async (to) => { fetches++; asked.push(String(to)); return { json: async () => (/api\/questions/.test(to) ? { questions: resolved } : { owner, ownerTopics: topics, items: [{ key: 'w/A1', ref: 'INT-1', questions: { topic: 'item:w/A1' }, prototypes: rounds && { open: false, rounds } }] }) }; },
    ClaudeSite: { url: (p) => new URL(p, 'https://mac.ts.net/orch/').href, send: async (kind, data) => { sent.push([kind, data]); return {}; } },
  };
  win.window = win;
  if (pane) win.frameElement = { closest: (sel) => (sel === '.needs-pane' ? {} : null) };
  win.top = framed || pane ? { AppShell: { open: (to, opts) => { moves.push(['app', to, { ...opts }]); return true; } } } : win;
  vm.createContext(win);
  for (const file of ['ui.js', 'ui-links.js', 'ui-questions.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), win);
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
    typeNote: (v) => { part('.ps-text').value = v; }, noteBox: () => part('.ps-text')?.value, noteHidden: () => part('.ps-text')?.hidden, draft: (id) => JSON.parse(win.localStorage.getItem('qdraft:' + id) ?? 'null'),
    sent, moves, loaded, styles, rendered, classes, controls, replacements, take: mounted.take, fetches: () => fetches, asked, backs: () => backs, listeners };
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

test('the viewer keeps a drafted note and its pick, and Choose this drafts the new take over them', async () => {
  const page = prototypePage('https://mac.ts.net/orch/prototype-snooze.html?q=q1', { owner: [{ ...question, topic: 'item:w/A1' }], drafts: { q1: { choice: 'B', note: 'Kept' } } });
  await page.settle();
  assert.equal(page.noteBox(), 'Kept');
  assert.match(page.pill(), />Choose this<\/button>/);
  await page.pick();
  assert.deepEqual(page.draft('q1'), { choice: 'A', note: 'Kept' });
});

test('the note field stays after a take is picked', async () => {
  const picked = prototypePage('https://mac.ts.net/orch/prototype-snooze.html?q=q1', { owner: [{ ...question, topic: 'item:w/A1' }], drafts: { q1: { choice: 'A', note: 'Kept' } } });
  await picked.settle();
  assert.match(picked.pill(), /Picked/);
  assert.equal(picked.noteHidden(), false);
  assert.equal(picked.noteBox(), 'Kept');
});

// docs/adr/2026-11-07-2030-on-desktop-the-prototype-viewer-opens-in-the-right-pane.md
test('the bar is the full-width footer at every width, and from 900px its pill and note are 640px and its state pills wrap', () => {
  const css = prototypePage('https://mac.ts.net/orch/prototype-snooze.html', { owner: [] }).styles;
  assert.match(css, /\n\.ps-switch \{[^}]*left:0; right:0; bottom:var\(--app-bottom, 0px\);[^}]*background:#202026; border-top:1px solid #fff3;/);
  assert.match(css, /\n\.ps-pill \{[^}]*border-radius:0;/);
  assert.doesNotMatch(css, /max-width: 899px/, 'no floating bar at any width');
  assert.match(css, /@media \(min-width: 900px\) \{[^@]*\.ps-pill \{[^}]*width:min\(640px, 100%\)/);
  assert.match(css, /@media \(min-width: 900px\) \{[^@]*\.ps-states \{[^}]*flex-wrap:wrap/);
});

// docs/adr/2026-11-07-2030-on-desktop-the-prototype-viewer-opens-in-the-right-pane.md
test("framed in the board's right pane, the page hides its ✕ and Round pill, which the pane's top bar holds, starts at the top and wraps its state pills", () => {
  const inPane = prototypePage('https://mac.ts.net/orch/prototype-snooze.html?q=q1', { pane: true, owner: [question] });
  assert.deepEqual(inPane.classes, ['ps-pane']);
  assert.match(inPane.styles, /\.ps-pane \.ps-top \{ display:none; \}/);
  assert.match(inPane.styles, /\.ps-pane main\.proto-main \{ padding-top:0; \}/);
  assert.match(inPane.styles, /\.ps-pane \.ps-states \{[^}]*flex-wrap:wrap;/);
  assert.deepEqual(prototypePage('https://mac.ts.net/orch/prototype-snooze.html?q=q1', { framed: true, owner: [question] }).classes, [], 'a page framed anywhere else keeps them');
});

test('?take= is no longer an embed: the page keeps its bar, top controls and question at any take', () => {
  const page = prototypePage('https://mac.ts.net/orch/prototype-snooze.html?q=q1&take=B', { owner: [question] });
  assert.deepEqual(page.classes, []);
  assert.equal(page.controls.length, 2);
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

// docs/adr/2026-11-07-0300-prototypes-have-their-own-button-and-viewer.md
const rounds = [
  { n: 1, q: 'q0', url: 'prototype-snooze.html?q=q0', confirm: false, state: 'resolved' },
  { n: 1, q: 'q0c', url: 'prototype-snooze.html?q=q0c', confirm: true, state: 'resolved' },
  { n: 2, q: 'q1', url: 'prototype-snooze-2.html?q=q1', confirm: false, state: 'open' },
];

test("the viewer's round pill names the round it shows of the card's rounds, and only a card with an earlier round gets one", () => {
  assert.equal(text(ui.roundPill(rounds, 'q1')), 'Round 2 of 2 · earlier');
  assert.equal(text(ui.roundPill(rounds, 'q0')), 'Round 1 of 2 · earlier');
  assert.match(ui.roundPill(rounds, 'q1'), /data-ps-top="rounds"/);
  assert.equal(ui.roundPill([rounds[2]], 'q1'), '');
  assert.equal(ui.roundPill(rounds, 'gone'), '');
  assert.equal(ui.roundPill(null, 'q1'), '');
});

test("the rounds sheet lists the card's rounds newest first, the one showing marked, each saying whether it is open or answered", () => {
  const sheet = ui.roundSheet({ ref: '#287', rounds, qid: 'q0' });
  assert.match(sheet, /<h3>Rounds on #287<\/h3>/);
  const rows = [...sheet.matchAll(/<button type="button" data-ps-round="([^"]+)">(.*?)<\/button>/g)].map(([, url, body]) => [url, text(body)]);
  assert.deepEqual(rows, [
    ['prototype-snooze-2.html?q=q1', 'Round 2 open'],
    ['prototype-snooze.html?q=q0c', 'Round 1 confirm answered'],
    ['prototype-snooze.html?q=q0', 'Round 1 · showing answered'],
  ]);
});

test('a mostly sideways swipe of 50px or more switches takes, a swipe left to the next one, and one from the left edge or mostly down is left alone', () => {
  assert.equal(sw.swipeStep({ x: 300, y: 400 }, { x: 200, y: 420 }), 1);
  assert.equal(sw.swipeStep({ x: 100, y: 400 }, { x: 200, y: 380 }), -1);
  assert.equal(sw.swipeStep({ x: 300, y: 400 }, { x: 260, y: 400 }), 0);
  assert.equal(sw.swipeStep({ x: 300, y: 400 }, { x: 200, y: 480 }), 0);
  assert.equal(sw.swipeStep({ x: 10, y: 400 }, { x: 200, y: 400 }), 0);
});

test("the viewer is full bleed: its header hides, ✕ goes back the way the header's back arrow does, and a round in the sheet replaces the page", async () => {
  const page = prototypePage('https://mac.ts.net/orch/prototype-snooze-2.html?q=q1', { framed: true, owner: [{ ...question, id: 'q1', topic: 'item:w/A1' }], rounds });
  await page.settle();
  assert.match(page.styles, /body > header\.top\s*\{[^}]*display:none/);
  const top = page.controls[1];
  assert.match(top.innerHTML, /Round 2 of 2 · earlier/);
  assert.match(top.innerHTML, /data-ps-top="close"[^>]*aria-label="Close"/);
  const click = (target) => page.listeners.filter((l) => l.target === top && l.type === 'click').forEach((l) => l.fn({ target: { closest: (sel) => target[sel] || null } }));
  click({ '[data-ps-top]': { dataset: { psTop: 'close' } } });
  assert.equal(page.backs(), 1);
  click({ '[data-ps-top]': { dataset: { psTop: 'rounds' } } });
  assert.match(top.innerHTML, /Rounds on INT-1/);
  click({ '[data-ps-round]': { dataset: { psRound: 'prototype-snooze.html?q=q0' } } });
  assert.deepEqual(plain(page.moves), [['app', 'https://mac.ts.net/orch/prototype-snooze.html?q=q0', { replace: true }]]);
});
