import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ location: { hostname: 'mac.ts.net', host: 'mac.ts.net:443' } });
for (const file of ['ui.js', 'ui-links.js', 'ui-enums.js', 'ui-phase-bars.js', 'ui-cards.js', 'ui-header.js', 'ui-threads.js', 'ui-questions.js', 'ui-prompts.js', 'ui-markdown.js', 'ui-page-header.js', 'ui-snapshot.js', 'ui-sidebar.js', 'ui-hub.js']) {
  vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), context);
}
const ui = context.BoardUI;

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&(amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e]).replace(/\s+/g, ' ').trim();
const ago = (hours) => new Date(Date.now() - hours * 3600000).toISOString();
// The last option and take end where the question's note composer starts.
const beforeComposer = (chunk) => chunk.split('<div class="composer"')[0];
const options = (html) => html.split(/<label class="opt"[^>]*>/).slice(1).map(beforeComposer);
const plain = (v) => JSON.parse(JSON.stringify(v));

const openPR = { number: 7, url: 'https://github.com/o/repo/pull/7', state: 'OPEN', isDraft: false, status: 'open', checks: { state: 'pass' } };

const colorsCss = fs.readFileSync(new URL('../shared/colors.css', import.meta.url), 'utf8');
const definedIn = (src) => new Set([...src.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
const usedIn = (src) => new Set([...src.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]));

test('the board and the hub take every colour from shared/colors.css and define none of their own', () => {
  const shared = definedIn(colorsCss);
  const boardCss = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  const hubCss = fs.readFileSync(new URL('./public/hub.css', import.meta.url), 'utf8');
  const sidebarCss = fs.readFileSync(new URL('./public/sidebar.css', import.meta.url), 'utf8');
  for (const [name, css, local] of [['style.css', boardCss, definedIn(boardCss)], ['hub.css', hubCss, definedIn(hubCss + ['ui-hub.js', 'view-hub-settings.js'].map((f) => fs.readFileSync(new URL(`./public/${f}`, import.meta.url), 'utf8')).join(''))], ['sidebar.css', sidebarCss, definedIn(sidebarCss + fs.readFileSync(new URL('./public/ui-sidebar.js', import.meta.url), 'utf8'))]]) {
    assert.deepEqual([...usedIn(css)].filter((v) => !shared.has(v) && !local.has(v)), [], name);
    assert.deepEqual([...definedIn(css)].filter((v) => shared.has(v)), [], name);
  }
});

test('one human blue: --accent is the planner blue in both modes, and every label on an accent fill reads --on-accent', () => {
  const [light, dark] = colorsCss.split('@media (prefers-color-scheme: dark)');
  const value = (src, name) => new RegExp(`${name}:\\s*([^;]+);`).exec(src)?.[1].trim();
  assert.deepEqual([value(light, '--accent'), value(light, '--accent-soft'), value(light, '--on-accent')], ['#2b6cb0', '#eef6ff', '#ffffff']);
  assert.deepEqual([value(dark, '--accent'), value(dark, '--accent-soft'), value(dark, '--on-accent')], ['#6fa8e8', '#1b2533', '#0b0b0e']);
  assert.deepEqual([...definedIn(colorsCss)].filter((v) => /love|blue/.test(v)), []);
  for (const f of ['style.css', 'sidebar.css', 'hub.css']) {
    const css = fs.readFileSync(new URL(`./public/${f}`, import.meta.url), 'utf8');
    const filled = css.split('}').filter((r) => /background:\s*var\(--accent\)/.test(r) && /[^-]color:/.test(r));
    for (const r of filled) assert.match(r, /[^-]color:\s*var\(--on-accent\)/, `${f}: ${r.trim()}`);
  }
});

test("every hub.css selector is under .hub-view, so the hub's short class names never reach a board's elements", () => {
  const css = fs.readFileSync(new URL('./public/hub.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = [];
  const rules = (src) => {
    for (let i = 0; i < src.length;) {
      const open = src.indexOf('{', i);
      if (open < 0) break;
      let depth = 1, end = open + 1;
      for (; depth; end++) depth += src[end] === '{' ? 1 : src[end] === '}' ? -1 : 0;
      const prelude = src.slice(i, open).replace(/^[\s;}]+/, '').trim();
      if (/^@(media|supports)/.test(prelude)) rules(src.slice(open + 1, end - 1));
      else if (!prelude.startsWith('@')) selectors.push(...prelude.split(/,(?![^(]*\))/).map((x) => x.trim()));
      i = end;
    }
  };
  rules(css);
  assert.ok(selectors.length > 50);
  assert.deepEqual(selectors.filter((x) => !/^\.hub-view(?![\w-])/.test(x)), []);
});

test('a closed ask in the Asks lane shows the done icon a done work card shows', () => {
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  const rule = (lane) => new RegExp(`(?:^|\\n)([^{}\\n]*\\.status\\.${lane}\\b[^{}]*)\\{([^}]*)\\}`).exec(css);
  const done = rule('done');
  assert.ok(done);
  const asks = css.split('\n').find((l) => /\.status\.asks\b/.test(l));
  assert.ok(asks, 'no .status.asks rule');
  assert.match(asks, new RegExp(`\\{\\s*${done[2].trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}`));
});

test('a badge takes one of the six tones, each coloured by a shared colour constant, as a span or a link, and refuses any other tone', () => {
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  const shared = definedIn(colorsCss);
  assert.deepEqual(plain(ui.BADGE_TONES), ['quiet', 'normal', 'notice', 'danger', 'ready', 'merged']);
  for (const tone of ui.BADGE_TONES) {
    assert.equal(ui.badge(tone, 'A &amp; B'), `<span class="chip tone-${tone}">A &amp; B</span>`);
    const color = new RegExp(`\\.chip\\.tone-${tone}\\s*\\{[^}]*color:\\s*var\\((--color-[\\w-]+)\\)`).exec(css)?.[1];
    assert.ok(shared.has(color), tone);
  }
  assert.equal(ui.badge('notice', 'Open items', { href: 'questions.html#q"1', title: '2 <open>', attrs: { target: '_blank' } }),
    '<a class="chip tone-notice" href="questions.html#q&quot;1" title="2 &lt;open&gt;" target="_blank">Open items</a>');
  assert.throws(() => ui.badge('warn', 'x'), /warn/);
  assert.throws(() => ui.badge(undefined, 'x'));
});

test('a review chip shows the reviewer\'s GitHub login, its age once it has waited a day, then its mark', () => {
  const chips = (since) => text(ui.reviewChips({ pr: openPR, reviewers: ['Jamie'], review: { Jamie: { state: 'sent', since, github: 'jamie-gh' } } }));
  assert.equal(chips(ago(3)), 'jamie-gh ●');
  assert.equal(chips(ago(50)), 'jamie-gh (2d) ●');
  assert.match(ui.reviewChips({ pr: openPR, reviewers: ['Jamie'], review: { Jamie: { state: 'sent', since: ago(50), github: 'jamie-gh' } } }), /title="Jamie \(jamie-gh\): sent, not approved yet"/);
  assert.equal(text(ui.reviewChips({ pr: openPR, reviewers: ['Jamie'], review: { Jamie: { state: 'approved', since: null, github: null } } })), 'Jamie ✓');
});

test('a merged PR shows no review chips', () => {
  assert.equal(ui.reviewChips({ pr: { ...openPR, state: 'MERGED' }, reviewers: ['Jamie'], review: {} }), '');
});

test('PR chips show the repo with an orange dot for a draft or a green check once ready, then CI and unanswered Codex findings', () => {
  const draft = ui.prChips({ prs: [{ ...openPR, isDraft: true, status: 'draft', codexOpen: 2 }] });
  assert.equal(text(draft), 'repo#7 ● CI ✓ codex 2');
  assert.match(draft, /^<a class="chip tone-notice" [^>]*title="Draft" [^>]*aria-label="repo#7: Draft">/);
  const ready = ui.prChips({ prs: [openPR] });
  assert.equal(text(ready), 'repo#7 ✓ CI ✓');
  assert.match(ready, /^<a class="chip tone-ready" [^>]*title="Ready for review" [^>]*aria-label="repo#7: Ready for review">/);
  const badgeTone = (pr) => /^<a class="chip (tone-\w+)"/.exec(ui.prChips({ prs: [{ ...openPR, ...pr }] }))[1];
  assert.deepEqual([{}, { reviewDecision: 'REVIEW_REQUIRED' }, { checks: { state: 'fail' } }, { checks: { state: 'pending' } }, { checks: undefined }, { reviewDecision: 'CHANGES_REQUESTED' }].map(badgeTone),
    ['tone-ready', 'tone-ready', 'tone-quiet', 'tone-quiet', 'tone-quiet', 'tone-quiet']);
  const ci = (state) => /<span class="chip (tone-\w+)" title="CI/.exec(ui.prChips({ prs: [{ ...openPR, checks: { state } }] }))[1];
  assert.deepEqual(['pass', 'fail', 'pending', 'unknown'].map(ci), ['tone-ready', 'tone-danger', 'tone-notice', 'tone-quiet']);
});

test("a card with several PRs shows a badge for each, in its order, with that PR's state, CI and link", () => {
  const site = { ...openPR, number: 1, url: 'https://github.com/o/site/pull/1', isDraft: true, status: 'draft', checks: { state: 'fail' } };
  const merged = { ...openPR, state: 'MERGED', status: 'merged' };
  const chips = ui.prChips({ prs: [merged, site] });
  assert.equal(text(chips), 'repo#7 ✓ site#1 ● CI ✗');
  assert.deepEqual([...chips.matchAll(/<a class="chip (tone-\w+)" href="([^"]+)"/g)].map((m) => [m[1], m[2]]), [
    ['tone-merged', 'https://github.com/o/repo/pull/7'], ['tone-notice', 'https://github.com/o/site/pull/1'],
  ]);
  assert.equal(ui.prChips({ prs: [] }), '');
});

test("the PR badge alone shows the PR's state, linking to the PR: a purple check once merged, a red cross once closed, a plain name before GitHub is read", () => {
  assert.deepEqual(plain(ui.PR_STATE), { open: 'open', draft: 'draft', merged: 'merged', closed: 'closed' });
  const merged = ui.prChips({ prs: [{ ...openPR, state: 'MERGED', status: 'merged', codexOpen: 2 }] });
  assert.equal(text(merged), 'repo#7 ✓');
  assert.match(merged, /^<a class="chip tone-merged" href="https:\/\/github\.com\/o\/repo\/pull\/7" title="Merged" [^>]*aria-label="repo#7: Merged">[^<]*<\/a>$/);
  const closed = ui.prChips({ prs: [{ ...openPR, state: 'CLOSED', status: 'closed' }] });
  assert.equal(text(closed), 'repo#7 ✗');
  assert.match(closed, /^<a class="chip tone-danger" [^>]*title="Closed" [^>]*aria-label="repo#7: Closed">[^<]*<\/a>$/);
  assert.match(ui.prChips({ prs: [{ ...openPR, state: undefined, checks: undefined, status: null }] }), /^<a class="chip tone-quiet" href="[^"]+" target="_blank" rel="noopener">repo#7<\/a>$/);
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  const [light, dark] = colorsCss.split('@media (prefers-color-scheme: dark)');
  assert.match(css, /\.chip\.tone-merged \{ color: var\(--color-merged\); \}/);
  assert.deepEqual([/--purple:\s*([^;]+);/.exec(light)?.[1], /--purple:\s*([^;]+);/.exec(dark)?.[1]], ['#8250df', '#ab7df8']);
});

test('the header reads the time since the last change signal or refresh, and the In Review header when GitHub was checked, each saying when it needs a look', () => {
  const checks = { at: ago(4 / 60), every: 30, late: false, watcher: 'running', claudeAt: ago(3) };
  const fresh = ago(1 / 60);
  assert.equal(text(ui.statusLine(fresh)), '1 min');
  assert.match(ui.statusLine(fresh), /title="Updated 1 min ago[^"]*"/);
  assert.equal(text(ui.statusLine(ago(0))), 'now');
  assert.equal(text(ui.statusLine(ago(2), { watcher: 'running' })), '2 h');
  assert.equal(ui.statusLine(null), '');
  assert.match(ui.statusLine(fresh, { watcher: 'stopped' }), /^<span class="claude down" title="Claude not listening">not listening<\/span>$/);
  assert.match(ui.statusLine(fresh, { watcher: 'stopped', link: 'offline' }), /^<span class="link-state offline" title="Offline: can't reach the host">1 min<\/span>$/);
  // An asleep board says so in grey where a deaf one is red, and waking… once the page asked the hub to wake it.
  assert.match(ui.statusLine(fresh, { watcher: 'asleep' }), /^<span class="claude asleep" title="Asleep: [^"]*wakes it">asleep<\/span>$/);
  assert.equal(text(ui.statusLine(fresh, { watcher: 'asleep', waking: true })), 'waking…');
  assert.match(ui.statusLine(fresh, { watcher: 'waking' }), /^<span class="claude asleep" title="Waking: [^"]*">waking…<\/span>$/);
  assert.equal(text(ui.statusLine(fresh, { watcher: 'running', waking: true })), '1 min');
  assert.equal(text(ui.statusLine(fresh, { watcher: 'stopped', waking: true })), 'not listening');
  assert.equal(text(ui.statusLine(fresh, { link: 'reconnecting' })), 'reconnecting…');
  assert.match(ui.statusLine(undefined, { link: 'offline' }), /^<span class="link-state offline"[^>]*>offline<\/span>$/);
  assert.equal(text(ui.githubLine(checks)), 'GitHub 4 min');
  assert.match(ui.githubLine(checks), /<svg class="gh-mark"[^>]*aria-label="GitHub"/);
  assert.equal(text(ui.githubLine(checks, { pending: true })), 'GitHub Checking…');
  assert.equal(text(ui.githubLine({ ...checks, at: null })), 'GitHub not checked');
  const late = ui.githubLine({ ...checks, at: ago(2), late: true });
  assert.match(late, /^<span class="github late" title="GitHub checked 2 h ago; checks are late">/);
  assert.equal(text(late), 'GitHub 2 h · checks are late');
  const idle = ui.githubLine({ ...checks, at: ago(2), every: null, idle: true });
  assert.doesNotMatch(idle, /late/);
  assert.equal(text(idle), 'GitHub 2 h');
});

test('the header time moves on a refresh, the first load and a change signal that brought something new, never on a poll', () => {
  const board = { generatedAt: '2026-10-23T12:00:00Z', items: [{ key: 'w/A', lane: 'todo' }] };
  const threads = new Map([['w/A', [{ text: 'a' }]]]);
  const sig = ui.freshSig(board, threads, ['w/A']);
  assert.equal(ui.freshSig({ ...board, generatedAt: '2026-10-23T12:05:00Z' }, threads, ['w/A']), sig);
  const replied = ui.freshSig(board, new Map([['w/A', [{ text: 'a' }, { text: 'b' }]]]), ['w/A']);
  assert.notEqual(replied, sig);
  assert.notEqual(ui.freshSig({ ...board, items: [] }, threads, ['w/A']), sig);
  const snapshot = { at: '2026-10-23T08:00:00Z', sig: null };
  assert.deepEqual(plain(ui.nextFresh(snapshot, { via: 'poll', at: 't1', sig })), { at: 't1', sig });
  assert.deepEqual(plain(ui.nextFresh(null, { via: 'signal', at: 't1', sig })), { at: 't1', sig });
  const landed = { at: 't1', sig };
  assert.equal(ui.nextFresh(landed, { via: 'poll', at: 't2', sig: replied }), landed);
  assert.equal(ui.nextFresh(landed, { via: 'signal', at: 't2', sig }), landed);
  assert.deepEqual(plain(ui.nextFresh(landed, { via: 'signal', at: 't2', sig: replied })), { at: 't2', sig: replied });
  assert.deepEqual(plain(ui.nextFresh(landed, { via: 'refresh', at: 't2', sig })), { at: 't2', sig });
});

test('the GitHub refresh spins and rests only while a check is pending', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  const checks = (s) => ({ at: new Date(now - s * 1000).toISOString() });
  assert.equal(ui.checkLanded(checks(20), now - 1000), false);
  assert.equal(ui.checkLanded({ at: new Date(now).toISOString() }, now - 1000), true);
  const spinning = (html) => /aria-disabled="true"/.test(html) && /class="[^"]*\bspinning\b/.test(html);
  assert.equal(spinning(ui.githubRefresh(checks(1), null)), false);
  assert.equal(spinning(ui.githubRefresh(checks(20), now - 1000)), true);
  assert.match(ui.githubRefresh({ at: null }, null), /data-check-github/);
  assert.match(ui.githubRefresh(null, null), /data-check-github/);
});

test('header controls turn on together once the first board load lands, refresh spinning until then', () => {
  const on = (o) => ({ ...ui.headerControls(o) });
  const waiting = { refresh: false, settings: false, spin: true };
  assert.deepEqual(on({}), waiting);
  assert.deepEqual(on({ wired: true }), waiting);
  assert.deepEqual(on({ boardSettled: true }), { ...waiting, spin: false });
  assert.deepEqual(on({ wired: true, boardSettled: true }), { refresh: true, settings: true, spin: false });
  assert.deepEqual(on({ wired: true, boardSettled: true, link: 'offline' }), { refresh: true, settings: false, spin: false });
  assert.deepEqual(on({ wired: true, boardSettled: true, link: 'reconnecting', reloading: true }), { refresh: false, settings: false, spin: true });
});

test("a snapshot keeps the board and the threads of its cards, open cards' first, dropping threads past the size cap", () => {
  const savedAt = '2026-10-23T08:00:00.000Z';
  const board = { generatedAt: savedAt, items: [{ key: 'w/A', lane: 'todo' }, { key: 'w/B', lane: 'done' }, { key: 'w/C', lane: 'progress' }] };
  const threads = new Map([['w/B', [{ text: 'b' }]], ['w/A', [{ text: 'a' }]], ['w/gone', [{ text: 'x' }]], ['w/C', [{ text: 'c'.repeat(200) }]]]);
  const raw = ui.packSnapshot(board, threads, { build: 'b1', savedAt, keep: ['w/A'] });
  const back = plain(ui.unpackSnapshot(raw, 'b1'));
  assert.deepEqual([back.savedAt, back.board], [savedAt, board]);
  assert.deepEqual(Object.keys(back.threads), ['w/A', 'w/B', 'w/C']);
  assert.deepEqual(back.threads['w/A'], [{ text: 'a' }]);
  const capped = plain(ui.unpackSnapshot(ui.packSnapshot(board, threads, { build: 'b1', savedAt, keep: ['w/A'], max: raw.length - 100 }), 'b1'));
  assert.deepEqual(Object.keys(capped.threads), ['w/A', 'w/B']);
  assert.equal(ui.packSnapshot(board, threads, { build: 'b1', savedAt, max: 50 }), null);
});

// A board of today's shape and size, as /api/board answers it: its 100 Done cards slim (board/domain.mjs slimDone), a few
// open cards and their open question.
function bigBoard() {
  const done = (n) => ({ key: `hub/GH-${n}`, kind: 'work', id: `GH-${n}`, ref: `#${n}`, title: `Done card ${n}`, lane: 'done', status: 'done', wave: 'hub', waveTitle: 'Hub', internal: true,
    ticket: { id: `#${n}`, source: 'github' }, ticketSource: 'github', prs: [], threadCount: 9, othersAt: [ago(3), ago(2), ago(1)], hasNotes: true, sortAt: ago(1),
    questions: { topic: `item:hub/GH-${n}`, state: 'resolved', open: 0, answered: 0, replied: 0, resolved: 3, first: 'q1' }, manualSteps: [] });
  const open = [{ key: 'hub/GH-1', lane: 'todo', ref: '#1', title: 'Todo', questions: { state: 'open', open: 1, answered: 0, replied: 0, first: 'live' }, agents: [{ name: 'main' }] },
    { key: 'hub/GH-2', lane: 'progress', ref: '#2', title: 'Progress', builder: { progress: 'building' }, prs: [{ state: 'OPEN' }] }];
  return { generatedAt: ago(0), title: 'Hub', items: [...open, ...Array.from({ length: 100 }, (_, n) => done(100 + n))],
    owner: [{ id: 'live', topic: 'item:hub/GH-1', state: 'open', question: 'Which?' }], waveBands: [{ slug: 'hub', keys: ['hub/GH-1', 'hub/GH-100'] }] };
}
const packed = (board, o = {}) => ui.packSnapshot(board, new Map(), { build: 'b1', savedAt: board.generatedAt, ...o });

test('a snapshot keeps no version, and keeps every card as the board sent it', () => {
  const board = bigBoard();
  const back = plain(ui.unpackSnapshot(packed({ ...board, version: 'v1' }), 'b1'));
  assert.equal(back.board.version, undefined, "a reload names no version for a snapshot's board, so it downloads the whole one");
  assert.deepEqual(back.board.items, board.items);
  assert.deepEqual(back.board.owner, board.owner);
});

test("a snapshot of a board at today's size fits under the cap and draws open lanes as the live board does", () => {
  const board = bigBoard();
  const raw = packed(board);
  assert.ok(raw && raw.length < ui.SNAPSHOT_MAX, String(raw?.length));
  const back = plain(ui.unpackSnapshot(raw, 'b1'));
  assert.deepEqual(back.board.items.filter((i) => i.lane !== 'done'), board.items.filter((i) => i.lane !== 'done'));
  assert.deepEqual(back.board.waveBands, board.waveBands);
});

test('a board whose trimmed form is still over the cap saves its open lanes alone rather than nothing', () => {
  const board = bigBoard();
  const back = plain(ui.unpackSnapshot(packed(board, { max: packed(board).length - 1000 }), 'b1'));
  assert.deepEqual(back.board.items.map((i) => i.key), ['hub/GH-1', 'hub/GH-2']);
  assert.equal(packed(board, { max: 50 }), null);
});

test('a stored snapshot that is damaged, saved under another build or undated reads as none', () => {
  const good = ui.packSnapshot({ items: [{ key: 'w/A', lane: 'todo' }] }, new Map(), { build: 'b1', savedAt: '2026-10-23T08:00:00.000Z' });
  assert.ok(ui.unpackSnapshot(good, 'b1'));
  assert.equal(ui.unpackSnapshot(good, 'b2'), null);
  for (const raw of [null, '', 'not json', good.slice(0, -3), good.replace('"build":"b1"', '"v":2'), good.replace('"items":[', '"cards":['), good.replace('2026-10-23T08:00:00.000Z', 'soon')]) {
    assert.equal(ui.unpackSnapshot(raw, 'b1'), null, String(raw));
  }
  const odd = JSON.parse(good);
  odd.threads = { 'w/A': 'text', 'w/B': [{ text: 'b' }] };
  assert.deepEqual(Object.keys(ui.unpackSnapshot(JSON.stringify(odd), 'b1').threads), ['w/B']);
});

test('threads load in the background for every In Review, Stale, In Progress and Todo card that is not already open', () => {
  const items = ['review', 'stale', 'progress', 'todo', 'followups', 'done', 'asks', 'todo'].map((lane, n) => ({ key: `w/${n}`, lane }));
  assert.deepEqual([...ui.preloadKeys(items, new Set(['w/2']))], ['w/0', 'w/1', 'w/3', 'w/7']);
  assert.deepEqual([...ui.preloadKeys(items, [])], ['w/0', 'w/1', 'w/2', 'w/3', 'w/7']);
});

test('while the last visit shows, reading and asking work but card buttons and thread sends wait for the fresh board', () => {
  const live = (view) => { const { blocked, ...rest } = ui.liveControls(view); return { ...rest, blocks: Boolean(blocked) }; };
  assert.deepEqual(live('snapshot'), { read: true, ask: true, cards: false, send: false, blocks: true });
  assert.deepEqual(live('fresh'), { read: true, ask: true, cards: true, send: true, blocks: false });
  assert.deepEqual(live(null), { read: true, ask: true, cards: true, send: true, blocks: false });
});

test('when the fresh board replaces the last visit, only lines whose text changed or that are new flash', () => {
  assert.deepEqual([...ui.changedLines({ a: 'Running tests', b: '2', c: 'gone' }, { a: 'Running tests', b: '3', d: 'new' })], ['b', 'd']);
  assert.deepEqual([...ui.changedLines({}, {})], []);
});

test('every page header has a logo, a back arrow where needed, the title and disabled controls', () => {
  const logo = ui.header({ lead: 'logo', title: 'iOS <Orchestrator>' });
  assert.match(logo, /^<header class="top"><div class="brand"><a class="hub" href="\/_hub\/" aria-label="Boards"><img src="kickflip\.png" alt=""><\/a><h1>iOS &lt;Orchestrator&gt;<\/h1><\/div>/);
  assert.match(logo, /<button class="ghost spinning" id="refresh" type="button" disabled/);
  assert.match(logo, /<span class="muted" id="status">…<\/span>/);
  assert.match(logo, /<a href="settings\.html" id="settingsLink" class="ghost icon"[^>]*aria-disabled="true" tabindex="-1" aria-haspopup="dialog">/);
  assert.equal(text(logo), 'iOS <Orchestrator> …');

  const back = ui.header({ lead: 'back', backHref: '/', backLabel: 'Back to Claude', title: 'Settings', logoSrc: '/_hub/kickflip.png', settingsHref: '/_hub/settings', time: 'now' });
  assert.match(back, /^<header class="top"><div class="brand"><a class="hub" href="\/_hub\/" aria-label="Boards"><img src="\/_hub\/kickflip\.png" alt=""><\/a><a class="back" href="\/" aria-label="Back to Claude"><svg width="24" height="24"[^>]*>.*?<\/svg><\/a><h1>Settings<\/h1><\/div>/);
  assert.equal((back.match(/class="hub"/g) || []).length, 1);
  assert.ok(back.indexOf('class="hub"') < back.indexOf('class="back"'), 'the icon comes before the back button');
  assert.match(back, /href="\/_hub\/settings" id="settingsLink"/);
  assert.match(back, /id="status">now</);

  const bare = ui.header({ lead: 'back', title: 'Waiting on you', titleId: 'gtitle', backId: 'back', controls: false, trail: '<span class="muted small" id="progress"></span>' });
  assert.match(bare, /<a class="back" href="\.\/" id="back" aria-label="Back to the board">/);
  assert.match(bare, /<h1 id="gtitle">Waiting on you<\/h1><\/div><span class="muted small" id="progress"><\/span><\/header><script>[\s\S]*<\/script>$/);
  assert.doesNotMatch(bare, /id="refresh"|settingsLink/);
  assert.doesNotMatch(logo, /<script>/);
});

test("a board's sidebar row shows its context at the top right beside its name, red from 90% and dimmed once stale", () => {
  const site = (route, ctx) => ({ route, title: route, board: true, count: 0, icon: '', sub: '<b>Working</b>', ctx });
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  const html = ui.sidebar({ sites: [site('a', { percent: 62, at: ago(60_000) }), site('b', { percent: 91, at: ago(3 * 3600_000) }), site('c', null), site('d')] });
  const heads = [...html.matchAll(/<span class="sb-head">(.*?<\/span>)<\/span>(?=<span class="sb-sub">|<\/span><\/a>)/g)].map((m) => m[1]);
  assert.deepEqual(heads, [
    '<span class="sb-title">a</span><span class="sb-ctx" title="62% of its context window">62% ctx</span>',
    '<span class="sb-title">b</span><span class="sb-ctx full stale" title="91% of its context window, read 3 h ago">91% ctx</span>',
  ]);
  assert.equal(html.match(/sb-ctx/g).length, 2);
  assert.doesNotMatch(html, /<span class="sb-status"><b>Working<\/b><span class="sb-ctx/);
  assert.match(html, /<span class="sb-title">c<\/span><span class="sb-sub">/);
});

test("the Kickflip sidebar lists Hub, notifications, Pages, then Boards with New board last", () => {
  const site = (route, board, count, sub = '') => ({ route, title: route.toUpperCase(), board, count, icon: `<i data-r="${route}"></i>`, sub });
  const data = {
    sites: [site('ios', true, 2, '<b>2 need you</b>'), site('learn', false, 1), site('shop', true, 0), site('hub', true, 3)],
    hub: { tone: 'ok', word: 'healthy', detail: '4 of 4 sites up' }, notifications: { state: 'on', text: 'On' }, polling: { text: 'Every 15 min · next 4:45pm' },
  };
  const html = ui.sidebar(data, { here: 'ios', device: 'on' });
  assert.equal(text(html), 'Kickflip Hub healthy 4 of 4 sites up Pages LEARN Boards IOS 2 need you SHOP HUB New board');
  const utility = (html) => /<section class="sb-utility"[^>]*>(.*?)<\/section>/.exec(html)[1];
  assert.deepEqual([...utility(html).matchAll(/href="([^"]+)"/g)].map((m) => m[1]), ['/_hub/']);
  assert.match(html, /^<header class="top"><div class="brand"><a class="hub" href="\/_hub\/" aria-label="Hide boards" title="Hide boards" data-sidebar-close=""><img src="\/_hub\/kickflip\.png" alt=""><\/a><h2>Kickflip<\/h2><\/div><div class="nav"><button type="button" class="sb-close" data-sidebar-close aria-label="Close boards"><svg [^>]*>.*?<\/svg><\/button><\/div><\/header>/);
  assert.doesNotMatch(html, /<h1|id="refresh"|settingsLink/);
  assert.match(html, /<a class="sb-row on" href="\/ios\/" aria-current="page"><i data-r="ios"><\/i>/);
  assert.match(html, /href="\/_hub\/"[^>]*>.*Hub<\/span>/);
  assert.equal(ui.othersWaiting(data, 'ios'), 4);
  assert.equal(ui.othersWaiting(data, '_hub'), 6);
  const turnOn = utility(ui.sidebar(data, { device: 'off' }));
  assert.match(text(turnOn), /Turn on notifications Off on this device/);
  assert.match(turnOn, /href="\/_hub\/#notifications"/);
  assert.doesNotMatch(turnOn, />Settings</);
  const weekend = { state: 'held', text: 'Held for the weekend until 8:00am tomorrow' };
  for (const [device, notifications, status, urgent, moon] of [
    ['blocked', data.notifications, ' Notifications blocked on this device', true, null],
    ['on', { state: 'off', text: 'Off' }, ' Notifications off', true, null],
    ['on', { state: 'held', text: 'Snoozed until 6pm' }, '', false, 'Notifications snoozed until 6pm'],
    ['on', weekend, '', false, 'Notifications held for the weekend until 8:00am tomorrow'],
    ['blocked', weekend, ' Notifications blocked on this device', true, 'Notifications held for the weekend until 8:00am tomorrow'],
  ]) {
    const hubRow = utility(ui.sidebar({ ...data, notifications }, { device }));
    assert.equal(text(hubRow), `Hub healthy 4 of 4 sites up${status}`);
    assert.equal(hubRow.includes('word t-needs'), urgent);
    const mark = /<span class="sb-title">Hub<span class="sb-moon" role="img" aria-label="([^"]*)" title="([^"]*)"><svg /.exec(hubRow);
    assert.deepEqual(mark && [mark[1], mark[2]], moon && [moon, moon]);
  }
  for (const here of ['_hub', '_hub/', '_hub/settings', '_hub/settings/polling']) {
    const selected = [...ui.sidebar(data, { here }).matchAll(/<a class="sb-row on" href="([^"]+)" aria-current="page"/g)].map((m) => m[1]);
    assert.deepEqual(selected, ['/_hub/'], here);
  }
  assert.match(ui.sidebar({ sites: [] }), /data-new-board aria-haspopup="dialog"/);
});

test("pending boards have muted non-link rows, a failed start keeps its name with failed to start and opens its sheet, and New board stays last in Boards", () => {
  const data = { sites: [{ route: 'page', title: 'Page', board: false, icon: '' }], starting: [
    { route: 'new', title: 'Backend <audit>', step: 'starting', stepAt: new Date().toISOString(), failed: false },
    { route: 'cloning', title: 'Cloning board', step: 'cloning', stepAt: new Date().toISOString(), failed: false },
    { route: 'old', title: 'Old board', failed: true },
    { route: 'broken', title: 'Broken', failed: true, error: 'claude --bg failed (1): <Not signed in>' },
  ] };
  const html = ui.sidebar(data, { switching: true });
  assert.match(html, /<div class="sb-row sb-starting" data-starting="new">.*?<span class="sb-title">Backend &lt;audit&gt;<\/span>.*?starting orchestrator · 0s/);
  assert.match(html, /data-starting="cloning">.*?Cloning board.*?cloning \(0%\) · 0s<\/span>/);
  for (const [route, title] of [['old', 'Old board'], ['broken', 'Broken']]) {
    const row = new RegExp(`<button type="button" class="sb-row sb-starting sb-failed" data-starting="${route}" data-failed-start="${route}" aria-haspopup="dialog">.*?</button>`).exec(html)?.[0];
    assert.match(row, new RegExp(`<span class="sb-title">${title}</span><span class="sb-sub">failed to start</span></span></button>$`));
  }
  assert.doesNotMatch(html, /Didn't start|Not signed in|Dismiss|→/);
  assert.doesNotMatch(html, /href="\/(new|old)\//);
  assert.ok(html.indexOf('data-starting="old"') < html.indexOf('data-new-board'));
  assert.ok(html.indexOf('>Pages<') < html.indexOf('>Boards<'));
  assert.match(html, /data-new-board[\s\S]*?<\/button><\/div><\/section><\/div>/);
  assert.deepEqual(plain(ui.switchKeys(data)).map((r) => r.href), ['/page/', '/_hub/']);
});

// docs/adr/2026-11-04-1914-a-new-board-shows-its-start-steps-and-clone-progress.md
test("a starting board's row shows the three start steps on the board's phase bars: cloning fills to git's percent, the later steps run the pulse, each with its seconds", () => {
  const now = Date.parse('2026-11-04T19:00:00.000Z');
  const at = (seconds) => new Date(now - seconds * 1000).toISOString();
  const row = (s) => {
    const html = ui.sidebar({ sites: [], starting: [{ route: 'audit', title: 'Backend audit', failed: false, ...s }] }, { now });
    return /<div class="sb-row sb-starting" data-starting="audit">.*?<\/div>/.exec(html)[0];
  };
  const plus = /<span class="icon sb-plus sb-start-icon" aria-hidden="true"><svg [^>]*>.*?<\/svg><\/span>/.source;
  const bars = (label, inner) => `<span class="sb-steps"><span class="phase-bars" role="img" aria-label="${label}" title="${label}">${inner}</span></span>`;
  const shape = (label, inner, caption) => new RegExp(`^<div class="sb-row sb-starting" data-starting="audit">${plus}<span class="sb-text"><span class="sb-title">Backend audit</span>${bars(label, inner).replace(/[()]/g, '\\$&')}<span class="sb-sub sb-step">${caption.replace(/[()]/g, '\\$&')}</span></span></div>$`);
  assert.match(row({ step: 'cloning', stepAt: at(7.9), percent: 42 }), shape('cloning, step 1 of 3', '<i class="fill" style="--p:42%"></i><i class=""></i><i class=""></i>', 'cloning (42%) · 7s'));
  assert.match(row({ step: 'cloning', stepAt: at(0) }), shape('cloning, step 1 of 3', '<i class="fill" style="--p:0%"></i><i class=""></i><i class=""></i>', 'cloning (0%) · 0s'));
  assert.match(row({ step: 'starting', stepAt: at(12) }), shape('starting orchestrator, step 2 of 3', '<i class="done"></i><i class="now"></i><i class=""></i>', 'starting orchestrator · 12s'));
  assert.match(row({ step: 'landing', stepAt: at(125) }), shape('landing it, step 3 of 3', '<i class="done"></i><i class="done"></i><i class="now"></i>', 'landing it · 125s'));
  assert.match(row({ step: 'starting', stepAt: new Date(now + 4000).toISOString() }), /starting orchestrator · 0s/, "a host clock ahead of this device's counts from 0s");
  assert.equal(ui.startCaption({ step: 'landing', stepAt: at(3) }, now), 'landing it · 3s');
});

test("a starting board's row draws an icon for its step, the download arrow, the terminal prompt, then take A's skateboard, and the New board and failed rows keep the plus", () => {
  const glyph = (s) => {
    const html = ui.sidebar({ sites: [], starting: [{ route: 'audit', title: 'Backend audit', failed: false, stepAt: new Date().toISOString(), ...s }] });
    return /<span class="icon sb-plus sb-start-icon" aria-hidden="true"><svg [^>]*>(.*?)<\/svg>/.exec(html)[1];
  };
  assert.equal(glyph({ step: 'cloning' }), '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 20h14"/>');
  assert.equal(glyph({ step: 'starting' }), '<path d="m5 7 5 5-5 5M12 18h7"/>');
  assert.equal(glyph({ step: 'landing' }), '<path d="M2.5 9c0 1.7 1.2 3 3 3h13c1.8 0 3-1.3 3-3"/><circle cx="7.5" cy="16.5" r="2"/><circle cx="16.5" cy="16.5" r="2"/>');
  const html = ui.sidebar({ sites: [], starting: [{ route: 'bad', title: 'Bad', failed: true }] });
  assert.doesNotMatch(html, /sb-start-icon/);
  assert.match(html, /sb-failed[^>]*>\s*<span class="icon sb-plus" aria-hidden="true"><svg [^>]*><path d="M12 5v14M5 12h14"\/>/);
  assert.match(html, /data-new-board[^>]*><span class="icon sb-plus" aria-hidden="true"><svg [^>]*><path d="M12 5v14M5 12h14"\/>/);
});

test("a failed start's sheet labels its folder from home with a directory boundary, and without home shows the whole path", () => {
  const home = '/Users/you';
  for (const [repo, label] of [[`${home}/x`, '~/x'], [home, '~'], ['/opt/x', '/opt/x'], [`${home}2/x`, `${home}2/x`]]) {
    const failed = { route: 'new', title: 'New', repo, failed: true };
    assert.ok(ui.failedStart(failed, { home }).includes(`<dt>Repo</dt><dd>${label}</dd>`));
    assert.ok(ui.failedStart(failed).includes(`<dt>Repo</dt><dd>${repo}</dd>`));
  }
});

test("a failed start's sheet names it, shows its error or the 15-minute wait, what the start used and when it was asked, and offers Retry only for a New board start", () => {
  const now = Date.parse('2026-11-02T15:00:00Z');
  const ago = (min) => new Date(now - min * 60_000).toISOString();
  const entities = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&#39;': "'", '&quot;': '"' };
  const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&[#\w]+;/g, (e) => entities[e]).replace(/\s+/g, ' ').trim();
  const clone = '/Users/you/dev/.repos/acme/firmware';
  const failed = { route: 'firmware', title: 'Firm <ware>', repo: clone, branch: 'release/next', askedAt: ago(3), failed: true,
    tickets: { source: 'internal', prefix: 'FW' }, error: 'claude --bg failed (1): <Not signed in>' };
  const sheet = ui.failedStart(failed, { home: '/Users/you', now });
  assert.match(sheet, /<h2 id="failedStartTitle">Firm &lt;ware&gt; failed to start<\/h2>/);
  assert.equal(text(sheet), 'Firm <ware> failed to start ✕ claude --bg failed (1): <Not signed in> Repo ~/dev/.repos/acme/firmware Branch release/next Tickets Internal · FW Asked 3 min ago Dismiss Retry');
  assert.match(sheet, /<button type="button" class="primary" data-failed-retry>Retry<\/button>/);
  for (const [tickets, label] of [[{ source: 'github' }, 'GitHub issues'], [{ source: 'github', account: 'octo' }, 'GitHub issues · octo'], [{ source: 'linear', workspace: 'acme', team: 'ENG', project: 'p1' }, 'Linear · ENG']]) {
    assert.ok(ui.failedStart({ ...failed, tickets }, { now }).includes(`<dt>Tickets</dt><dd>${label}</dd>`), label);
  }
  assert.doesNotMatch(ui.failedStart({ ...failed, joined: true }, { now }), /data-failed-retry/, 'a joined board that is not listening can only be dismissed');
  const timedOut = { ...failed, error: undefined, askedAt: ago(0.5) };
  assert.match(text(ui.failedStart(timedOut, { now })), /failed to start ✕ Its session didn't answer within 15 minutes\. Repo .* Asked just now Dismiss Retry$/);
  assert.match(text(ui.failedStart({ ...timedOut, askedAt: ago(59) }, { now })), /Asked 59 min ago/);
  assert.doesNotMatch(text(ui.failedStart({ ...timedOut, askedAt: ago(90) }, { now })), /min ago|just now/);
  const started = ui.failedStart({ route: 'cli', title: 'CLI', repo: clone, askedAt: ago(20), failed: true }, { now });
  assert.match(text(started), /Repo \S+ Asked 20 min ago Dismiss$/);
  assert.doesNotMatch(started, /Branch|Tickets|data-failed-retry/);
});

test("switch mode numbers the first nine boards in sidebar order, and gives every row a letter from its name, boards claiming first in the order they joined, so a new board moves only a page's or a Hub row's letter", () => {
  const site = (route, title, created, board = true) => ({ route, title, board, created, icon: '<span class="icon" style="--c:#000" aria-hidden="true"><svg></svg></span>' });
  const live = [site('backend-audit', 'Backend Audit', '2026-10-22T21:47:40Z'), site('hub-orchestrator', 'Hub Orchestrator', '2026-10-29T21:49:30Z'),
    site('ios-orchestrator', 'iOS Orchestrator', '2026-10-22T19:19:11Z'), site('learn', 'Sync V2.1 course', '2026-10-22T05:35:39Z', false),
    site('shipyard-orchestrator', 'Shipyard Orchestrator', '2026-10-23T20:06:41Z'), site('software-pipeline', 'Software Pipeline', '2026-10-30T09:00:00Z')];
  const keys = (sites) => plain(ui.switchKeys({ sites })).map((k) => [k.title, k.num ?? null, k.letter ?? null]);
  assert.deepEqual(keys(live), [
    ['Backend Audit', '1', 'b'], ['Hub Orchestrator', '2', 'h'], ['iOS Orchestrator', '3', 'i'], ['Shipyard Orchestrator', '4', 's'], ['Software Pipeline', '5', 'o'],
    ['Sync V2.1 course', null, 'y'], ['Hub', null, 'u'],
  ]);

  const added = [...live.slice(0, 2), site('inkwell', 'Inkwell', '2026-10-30T10:00:00Z'), ...live.slice(2)];
  assert.deepEqual(keys(added), [
    ['Backend Audit', '1', 'b'], ['Hub Orchestrator', '2', 'h'], ['Inkwell', '3', 'n'], ['iOS Orchestrator', '4', 'i'], ['Shipyard Orchestrator', '5', 's'], ['Software Pipeline', '6', 'o'],
    ['Sync V2.1 course', null, 'y'], ['Hub', null, 'u'],
  ]);

  const many = [site('a0', 'Zed One'), site('a1', 'Zed Two', '2026-10-21T00:00:00Z'), ...Array.from({ length: 8 }, (_, i) => site(`a${i + 2}`, `Q${i + 2}`, '2026-10-22T00:00:00Z'))];
  const k = keys(many);
  assert.deepEqual([k[0], k[1], k[2], k[9]], [['Zed One', '1', 'e'], ['Zed Two', '2', 'z'], ['Q2', '3', 'q'], ['Q9', null, null]]);

  const html = ui.sidebar({ sites: live }, { here: 'ios-orchestrator', device: 'off', switching: true });
  assert.match(html, /href="\/ios-orchestrator\/"[^>]*><span class="icon"[^>]*><svg><\/svg><span class="ks-key">3<\/span><\/span><span class="sb-text"><span class="sb-title"><span class="ks-u">i<\/span>OS Orchestrator</);
  assert.match(html, /href="\/learn\/"[^>]*><span class="icon"[^>]*><svg><\/svg><span class="ks-key">y<\/span><\/span><span class="sb-text"><span class="sb-title">S<span class="ks-u">y<\/span>nc V2\.1 course</);
  assert.doesNotMatch(html, /href="\/_hub\/settings"/);
  assert.match(text(html), /^Kickflip u H u b Turn on notifications Off on this device Pages /);
  assert.match(html, /<div class="sb-label ks-label"><span class="ks-label-text">Boards<\/span><span class="ks-label-hint" role="status">– press a key to switch<i class="ks-bar"><\/i><\/span><\/div>/);
  assert.doesNotMatch(ui.sidebar({ sites: live }, { here: 'ios-orchestrator' }), /ks-(?!label(-text)?")/);
});

test("a back arrow goes one step back after a page on this hub, and to its href after a push, on that push's reloads, or with nothing before it", () => {
  const script = /<script>([\s\S]*)<\/script>$/.exec(ui.header({ lead: 'back', backHref: './#item=w%2FA1', title: 'Prototype' }))[1];
  const store = new Map();
  const tap = ({ url, referrer = '', depth = 2, nav = 'navigate', state = null }) => {
    let onClick = null;
    let back = false;
    vm.runInNewContext(script, {
      URL, URLSearchParams,
      location: new URL(url),
      document: { referrer, addEventListener: (kind, fn) => { if (kind === 'click') onClick = fn; } },
      history: { length: depth, state, back: () => { back = true; } },
      sessionStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
      performance: { getEntriesByType: () => [{ type: nav }] },
    });
    let followed = true;
    onClick({ target: { closest: (sel) => (sel === 'a.back' ? {} : null) }, preventDefault: () => { followed = false; } });
    return followed ? 'href' : back && 'back';
  };
  const page = 'https://mac.ts.net/orch/prototype-x.html?q=q1';
  assert.equal(tap({ url: page, referrer: 'https://mac.ts.net/orch/questions.html' }), 'back');
  assert.equal(tap({ url: page, referrer: 'https://mac.ts.net/' }), 'back');
  assert.equal(tap({ url: `${page}&from=push`, referrer: 'https://mac.ts.net/orch/questions.html' }), 'href');
  assert.equal(tap({ url: page, referrer: 'https://mac.ts.net/orch/questions.html', nav: 'reload' }), 'href');
  assert.equal(tap({ url: page, referrer: 'https://mac.ts.net/orch/questions.html' }), 'back');
  assert.equal(tap({ url: page, depth: 1 }), 'href');
  assert.equal(tap({ url: page, referrer: 'https://elsewhere.example/' }), 'href');
  assert.equal(tap({ url: page, depth: 1, state: { idx: 2 } }), 'back');
  assert.equal(tap({ url: page, referrer: 'https://mac.ts.net/orch/questions.html', state: { idx: 0 } }), 'href');
  assert.equal(tap({ url: `${page}&from=push`, state: { idx: 3 } }), 'href');
});

test("the app's router reads every hub URL as a view and writes each view back as that URL, every push link's shape included, and mounts a board, its Settings, Waiting on you and Notes, the hub's pages, and every other page in a frame, in place", () => {
  const routerContext = vm.createContext({ URL });
  vm.runInContext(fs.readFileSync(new URL('./public/router.js', import.meta.url), 'utf8'), routerContext);
  const { viewOf, urlOf, mounted } = routerContext.AppRouter;
  const base = 'https://mac.ts.net/orch/';
  const read = (url) => plain(viewOf(`https://mac.ts.net${url}`, { boards: new Set(['orch']), base }));
  const table = [
    ['/', { kind: 'start' }],
    ['/orch/', { kind: 'board', route: 'orch', hash: '' }],
    ['/orch/#item=w%2FA1&reply', { kind: 'board', route: 'orch', hash: '#item=w%2FA1&reply' }],
    ['/orch/settings.html', { kind: 'settings', route: 'orch' }],
    ['/orch/questions.html#q-1', { kind: 'questions', route: 'orch', id: 'q-1' }],
    ['/orch/notes.html?item=w%2FA1', { kind: 'notes', route: 'orch', item: 'w/A1' }],
    ['/orch/notes.html?wave=mon', { kind: 'notes', route: 'orch', wave: 'mon' }],
    ['/_hub/', { kind: 'hub' }],
    ['/_hub/settings', { kind: 'hub', hash: '#notifications' }],
    ['/_hub/settings#rules', { kind: 'hub', hash: '#rules' }],
    ['/_hub/#quiet', { kind: 'hub', hash: '#quiet' }],
    ['/orch/prototype-sidebar.html?q=q1&from=push', { kind: 'frame', route: 'orch', url: '/orch/prototype-sidebar.html?q=q1&from=push' }],
    ['/orch/shots-gallery.html', { kind: 'frame', route: 'orch', url: '/orch/shots-gallery.html' }],
    ['/learn/', { kind: 'frame', route: 'learn', url: '/learn/' }],
    ['/learn/lessons/lesson-2.html#top', { kind: 'frame', route: 'learn', url: '/learn/lessons/lesson-2.html#top' }],
  ];
  for (const [url, view] of table) {
    assert.deepEqual(read(url), view, url);
    assert.equal(urlOf(view), url === '/_hub/settings' ? '/_hub/#notifications' : url.replace('/_hub/settings#', '/_hub/#'), url);
  }
  // The old Polling page, which pushes and bookmarks may still link, opens Quiet hours.
  assert.deepEqual(read('/_hub/settings/polling?w=09%3A00'), { kind: 'hub', hash: '#quiet' });
  assert.deepEqual(read('/orch/plan.html?item=w%2FA1'), { kind: 'notes', route: 'orch', item: 'w/A1' });
  assert.deepEqual(read('/orch/questions.html?from=push#q-1'), { kind: 'questions', route: 'orch', id: 'q-1' });
  assert.deepEqual(read('/orch/notes.html?item=w%2FA1&from=push'), { kind: 'notes', route: 'orch', item: 'w/A1' });
  assert.deepEqual(read('/_hub/settings?from=push#notifications'), { kind: 'hub', hash: '#notifications' });
  assert.deepEqual(read('/_hub/settings#closed'), { kind: 'hub', hash: '#closed' });
  assert.deepEqual(read('/_hub/#rules'), { kind: 'hub', hash: '#rules' });
  assert.equal(viewOf('https://elsewhere.example/orch/', { boards: new Set(['orch']), base }), null);
  for (const url of ['/orch/uploads/1-shot.png', '/orch/api/board', '/learn', '/_hub/kickflip.png', '/sw.js']) assert.equal(read(url), null, url);
  assert.deepEqual(table.filter(([, view]) => mounted(view)).map(([url]) => url),
    ['/orch/', '/orch/#item=w%2FA1&reply', '/orch/settings.html', '/orch/questions.html#q-1', '/orch/notes.html?item=w%2FA1', '/orch/notes.html?wave=mon',
      '/_hub/', '/_hub/settings', '/_hub/settings#rules', '/_hub/#quiet',
      '/orch/prototype-sidebar.html?q=q1&from=push', '/orch/shots-gallery.html', '/learn/', '/learn/lessons/lesson-2.html#top']);
});

function appHistory(url, state = null) {
  let entries = [{ url: new URL(url), state }];
  let at = 0;
  let backs = 0;
  const handlers = {};
  const cur = () => entries[at];
  const location = { get href() { return cur().url.href; }, get pathname() { return cur().url.pathname; }, get search() { return cur().url.search; }, get hash() { return cur().url.hash; } };
  const history = {
    get state() { return cur().state; },
    replaceState(state, _, u) { entries[at] = { url: u ? new URL(u, location.href) : cur().url, state }; },
    pushState(state, _, u) { entries = [...entries.slice(0, at + 1), { url: new URL(u, location.href), state }]; at++; },
    go(n) {
      if (n < 0) backs++;
      if (!entries[at + n]) return;
      at += n;
      handlers.popstate({ state: cur().state });
    },
    back() { history.go(-1); },
  };
  const context = vm.createContext({ URL, URLSearchParams, location, history,
    HashChangeEvent: class { constructor(type) { this.type = type; } }, dispatchEvent: (e) => handlers[e.type]?.(e),
    document: { addEventListener: (type, fn) => { handlers[`document:${type}`] = fn; } },
    addEventListener: (type, fn) => { handlers[type] = fn; } });
  for (const file of ['ui-page-header.js', 'router.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), context);
  const shown = [];
  const router = context.AppRouter.listen({ boards: () => new Set(['orch']),
    go: (view, href, how, from) => {
      shown.push(`${how} ${view.kind}`);
      if (how === 'push') router.push(href, from);
      if (how === 'replace') router.replace(href);
      return true;
    } });
  const tap = (href, { cls = '', card = null } = {}) => {
    const a = { href: new URL(href, location.href).href, target: '', hasAttribute: () => false, classList: { contains: (c) => c === cls },
      closest: (sel) => (card && sel === 'details.item[open][data-key]' ? { dataset: { key: card } } : null) };
    const was = [backs, shown.length];
    handlers['document:click']({ defaultPrevented: false, button: 0, target: { closest: () => a }, preventDefault() {} });
    return backs > was[0] ? 'back' : shown.slice(was[1]).join(', ');
  };
  const stack = () => entries.slice(0, at + 1).map((e) => e.url.href.replace('https://mac.ts.net/orch/', ''));
  return { tap, router, location, history, stack, shown };
}

test("in the app, a view's back arrow goes one step back after a view, and to its href when a push opened the view, on a reload of it, or with nothing before it", () => {
  const app = (url, state) => {
    const page = appHistory(url, state);
    return { ...page, tap: (href, cls = '') => page.tap(href, { cls }) };
  };

  const pushed = app('https://mac.ts.net/orch/notes.html?item=w%2FA1&from=push');
  assert.deepEqual([pushed.location.href, plain(pushed.history.state)], ['https://mac.ts.net/orch/notes.html?item=w%2FA1', { idx: 0, pushed: true }]);
  assert.equal(pushed.tap('./', 'back'), 'push board');
  assert.equal(pushed.tap('settings.html'), 'push settings');
  assert.equal(pushed.tap('./', 'back'), 'back');

  const inApp = app('https://mac.ts.net/orch/');
  assert.equal(inApp.tap('notes.html?item=w%2FA1'), 'push notes');
  assert.equal(inApp.tap('./#item=w%2FA1', 'back'), 'back');
  inApp.router.push('https://mac.ts.net/orch/notes.html?item=w%2FA2&from=push');
  assert.deepEqual([inApp.location.href, plain(inApp.history.state)], ['https://mac.ts.net/orch/notes.html?item=w%2FA2', { idx: 1, pushed: true }]);
  assert.equal(inApp.tap('./', 'back'), 'push board');

  assert.equal(app('https://mac.ts.net/orch/settings.html', { idx: 3, pushed: true }).tap('./', 'back'), 'push board');
  assert.equal(app('https://mac.ts.net/orch/settings.html', { idx: 3 }).tap('./', 'back'), 'back');
  assert.equal(app('https://mac.ts.net/orch/settings.html').tap('./', 'back'), 'push board');
});

test("in the app, back follows the page tree: a prototype goes up to Waiting on you on its question, which goes up to the board, with the card open when the owner came from its thread, however the page was reached", () => {
  const cold = appHistory('https://mac.ts.net/orch/prototype-x.html?q=q1&from=push');
  assert.deepEqual(cold.stack(), ['', 'questions.html#q1', 'prototype-x.html?q=q1']);
  assert.deepEqual(plain(cold.history.state), { idx: 2, up: 2, pushed: true });
  assert.equal(cold.tap('./#item=w%2FA1', { cls: 'back' }), 'back');
  assert.deepEqual([cold.stack(), cold.shown.at(-1)], [['', 'questions.html#q1'], 'pop questions']);
  assert.equal(cold.tap('./', { cls: 'back' }), 'back');
  assert.deepEqual([cold.stack(), cold.shown.at(-1)], [[''], 'pop board']);

  const swipe = appHistory('https://mac.ts.net/orch/prototype-x.html?q=q1&from=push');
  swipe.history.back();
  swipe.history.back();
  assert.deepEqual([swipe.stack(), swipe.shown], [[''], ['pop questions', 'pop board']]);

  const reloaded = appHistory('https://mac.ts.net/orch/prototype-x.html?q=q1', { idx: 2, up: 2 });
  assert.deepEqual(reloaded.stack(), ['prototype-x.html?q=q1']);
  assert.deepEqual(appHistory('https://mac.ts.net/orch/questions.html?from=push#q1').stack(), ['', 'questions.html#q1']);

  const thread = appHistory('https://mac.ts.net/orch/');
  thread.tap('questions.html#q1', { card: 'w/A1' });
  assert.deepEqual(thread.stack(), ['#item=w%2FA1', 'questions.html#q1']);
  thread.tap('prototype-x.html?q=q2&variant=B');
  assert.deepEqual(thread.stack(), ['#item=w%2FA1', 'questions.html#q2', 'prototype-x.html?q=q2&variant=B']);
  thread.router.replace('https://mac.ts.net/orch/prototype-y.html?q=q3');
  assert.deepEqual([thread.stack(), plain(thread.history.state)], [['#item=w%2FA1', 'questions.html#q2', 'prototype-y.html?q=q3'], { idx: 2, up: 2 }]);
  assert.equal(thread.router.replace('https://mac.ts.net/orch/questions.html#q4'), 'up');
  assert.deepEqual([thread.stack(), thread.shown.at(-1)], [['#item=w%2FA1', 'questions.html#q4'], 'pop questions']);
  assert.equal(thread.tap('./', { cls: 'back' }), 'back');
  assert.deepEqual(thread.stack(), ['#item=w%2FA1']);

  const line = appHistory('https://mac.ts.net/orch/');
  line.tap('prototype-x.html?q=q1', { card: 'w/A1' });
  assert.deepEqual(line.stack(), ['#item=w%2FA1', 'questions.html#q1', 'prototype-x.html?q=q1']);

  const needs = appHistory('https://mac.ts.net/orch/#item=w%2FA1&reply');
  needs.tap('questions.html#q1');
  assert.deepEqual(needs.stack(), ['', 'questions.html#q1']);
  needs.tap('#q2');
  assert.deepEqual(needs.stack(), ['', 'questions.html#q2']);
  assert.equal(needs.tap('./', { cls: 'back' }), 'back');
  assert.deepEqual(needs.stack(), ['']);

  const picked = appHistory('https://mac.ts.net/orch/prototype-x.html?q=q1&from=push');
  picked.router.replace('https://mac.ts.net/orch/#item=w%2FA1&reply');
  assert.deepEqual([picked.stack(), picked.shown.at(-1)], [['#item=w%2FA1&reply'], 'pop board']);
});

test('Action needed shows only while the card waits on the owner, as orange words that link to what they act on', () => {
  assert.equal(ui.actionWords({ questions: { open: 2, first: 'q1' }, action: null }), '');
  const pick = ui.actionWords({ action: { kind: 'pick', url: 'https://mac.ts.net/r/prototype-x.html?q=q1', label: 'Prototypes ready: pick a take' } });
  assert.match(pick, /^<a class="card-action" href="https:\/\/mac\.ts\.net\/r\/prototype-x\.html\?q=q1"[^>]*>Action needed<\/a>$/);
  assert.doesNotMatch(pick, /target=|chip/);
  assert.match(ui.actionWords({ action: { kind: 'ready', url: 'https://github.com/o/r/pull/7', label: 'Tap Ready on GitHub' } }), /href="https:\/\/github\.com\/o\/r\/pull\/7"[^>]*target="_blank"/);
});

test('a thread message shows its text as written, never as markup', () => {
  const html = ui.threadMessages([{ ts: ago(1), who: 'claude', text: '<img src=x onerror=alert(1)> done' }]);
  assert.doesNotMatch(html, /<img/);
  assert.match(text(html), /<img src=x onerror=alert\(1\)> done/);
});

test("a thread names the board's session Orchestrator and a builder by its model", () => {
  const html = ui.threadMessages([
    { ts: ago(3), who: 'Claude Opus builder', kind: 'builder-ask', text: 'Stay orange?' },
    { ts: ago(2), who: 'claude', kind: 'builder-answer', text: 'Go quiet.' },
    { ts: ago(1), who: 'claude', text: 'Landed.' },
  ]);
  assert.match(text(html), /^Claude Opus builder · .* Stay orange\? Orchestrator · .* Go quiet\. Orchestrator · .* Landed\.$/);
  assert.match(html, /<div class="msg other"[^>]*>\s*<div class="who">Claude Opus builder ·/);
  assert.match(html, /<div class="msg claude"[^>]*>\s*<div class="who">Orchestrator ·/);
});

test('a thread names who wrote each message and where', () => {
  const html = ui.threadMessages([
    { ts: ago(2), who: 'Jamie', via: 'github', text: 'Looks good' },
    { ts: ago(1), who: 'love', via: 'site', text: 'Ship it', eventId: 'e1', reply: null },
  ]);
  assert.match(text(html), /^Jamie · GitHub · .* Looks good You · .* Ship it Waiting for Claude…$/);
  assert.equal(text(ui.threadMessages([])), 'No messages here yet.');
});

const question = {
  id: 'q1', source: 'Triage', question: 'Keep <it>?', state: 'open', answers: [],
  options: [{ id: 'A', label: 'Keep' }, { id: 'B', label: 'Drop', recommended: true, detail: 'Saves a step' }],
};

test('a question card marks the recommended option', () => {
  const opts = options(ui.questionCard(question));
  assert.deepEqual(opts.map((o) => text(o)), ['A. Keep', 'B. Drop Recommended Saves a step']);
  assert.match(text(ui.questionCard(question)), /Keep <it>\?/);
});

test("a question card checks this device's draft over the last answer", () => {
  const answered = { ...question, state: 'answered', answers: [{ ts: ago(1), choice: 'A', note: '', reply: null }] };
  const checked = (html) => options(html).map((o) => /\bchecked>/.test(o));
  assert.deepEqual(checked(ui.questionCard(answered)), [true, false]);
  assert.deepEqual(checked(ui.questionCard(answered, { draft: { choice: 'B' } })), [false, true]);
  assert.match(text(ui.questionCard(answered)), /You · .* A\. Keep Waiting for Claude…/);
  const acted = { ...question, state: 'resolved', answers: [{ ...answered.answers[0], acted: true }] };
  assert.doesNotMatch(text(ui.questionCard(acted)), /Waiting for Claude/);
});

const takeCards = (html) => html.split('<article class="take"').slice(1).map(beforeComposer);
const frames = (html) => [...html.matchAll(/<iframe src="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));

const shots = (html) => [...html.matchAll(/<div class="(take-shot[^"]*)"[^>]*?(?: style="([^"]*)")?><iframe/g)].map((m) => [m[1], m[2] ?? '']);

test("a question on a prototype page sets its takes in one grid with no carousel, each its option over a frame hidden until measured, with no full-size link", () => {
  const proto = ui.questionCard({ ...question, url: 'prototype-hub-snooze.html?q=q1#top' }, { draft: { choice: 'B' } });
  assert.match(proto, /<div class="takes"><article class="take" data-opt="A"><label class="opt">[\s\S]*<\/label><div class="take-shot[\s\S]*<\/article><article class="take" data-opt="B">[\s\S]*<\/article><\/div>/);
  assert.doesNotMatch(proto, /take-track|take-dots|data-dot/);
  assert.deepEqual(takeCards(proto).map((t) => /\bchecked>/.test(t)), [false, true]);
  assert.deepEqual(frames(proto), ['prototype-hub-snooze.html?q=q1&take=A#top', 'prototype-hub-snooze.html?q=q1&take=B#top']);
  assert.doesNotMatch(proto, /loading="lazy"/);
  assert.deepEqual(shots(proto), [['take-shot measuring', ''], ['take-shot measuring', '']]);
  assert.deepEqual([...proto.matchAll(/<iframe [^>]*>/g)].map((m) => /tabindex="-1"|aria-hidden/.test(m[0])), [false, false]);
  assert.doesNotMatch(fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8'), /\.take-shot iframe \{[^}]*pointer-events: none/);
  assert.doesNotMatch(proto, /Open full size|take-full|take-open|variant=/);
  assert.doesNotMatch(proto, /See the prototypes|target="_blank"|<label class="opt">[\s\S]*<label class="opt">[\s\S]*<label class="opt">/);
  context.location = { origin: 'https://mac.tail.ts.net', href: 'https://mac.tail.ts.net/orch/' };
  try {
    const absolute = ui.questionCard({ ...question, url: 'https://mac.tail.ts.net/orch/prototype-hub-snooze.html?q=q1' });
    assert.deepEqual(frames(absolute), ['https://mac.tail.ts.net/orch/prototype-hub-snooze.html?q=q1&take=A', 'https://mac.tail.ts.net/orch/prototype-hub-snooze.html?q=q1&take=B']);
    assert.doesNotMatch(absolute, /target="_blank"/);
    const elsewhere = ui.questionCard({ ...question, url: 'https://elsewhere.example/orch/prototype-hub-snooze.html?q=q1' });
    assert.deepEqual(takeCards(elsewhere), []);
    assert.match(elsewhere, /target="_blank"/);
  } finally { context.location = { hostname: 'mac.ts.net', host: 'mac.ts.net:443' }; }
});

test('one scrolling take gives the question a chooser in stored order and one full-size frame, defaulting to the recommended take without answering', () => {
  const q = { ...question, url: 'prototype-hub-snooze.html?q=q1' };
  const sizes = { A: { h: 214 }, B: { h: 902, scrolls: true, fullH: 1102 } };
  const render = (question = q, draft = {}) => ui.questionCard(question, { draft, fit: (id) => sizes[id] });
  const proto = render();
  assert.match(proto, /class="takes takes-full"/);
  assert.deepEqual(options(proto).map((o) => text(o)), ['A. Keep', 'B. Drop Recommended Saves a step']);
  assert.deepEqual(frames(proto), ['prototype-hub-snooze.html?q=q1&take=B']);
  assert.deepEqual([...proto.matchAll(/aria-current="true"><input [^>]*value="(\w+)"/g)].map((m) => m[1]), ['B']);
  assert.deepEqual(shots(proto), [['take-shot', 'height:1102px']]);
  assert.equal(takeCards(proto).length, 1);
  assert.doesNotMatch(proto, /checked|Open full size|take-full|take-open|variant=/);
  assert.ok(proto.indexOf('<iframe') < proto.indexOf('class="composer"'));
  assert.deepEqual(frames(render(q, { choice: 'A' })), ['prototype-hub-snooze.html?q=q1&take=A']);
  assert.deepEqual(frames(render({ ...q, answers: [{ choice: 'A' }] })), ['prototype-hub-snooze.html?q=q1&take=A']);
  assert.deepEqual(frames(render({ ...q, options: q.options.map((o) => ({ ...o, recommended: false })) })), ['prototype-hub-snooze.html?q=q1&take=A']);
  const fitting = ui.questionCard(q, { fit: () => ({ h: 214 }) });
  assert.doesNotMatch(fitting, /takes-full|Open full size/);
  assert.deepEqual(frames(fitting), ['prototype-hub-snooze.html?q=q1&take=A', 'prototype-hub-snooze.html?q=q1&take=B']);
});

test('a take with nothing to see draws its boxes and arrows, coloured by meaning, and what it means in practice', () => {
  const drawn = {
    ...question, url: 'prototype-seams.html?q=q1',
    options: [
      { id: 'A', label: 'One registry', diagram: [[{ text: 'Poll' }, { text: 'Wake', to: [0] }], [{ text: 'boards.mjs', tone: 'info' }, { text: 'Unused', tone: 'quiet' }]], practice: ['A new feature asks INT-54.'] },
      { id: 'B', label: 'Keep it', diagram: [[{ text: 'Each <own> read', tone: 'danger' }]], practice: ['Nothing to build.', 'Each feature forgets a kind.'] },
    ],
  };
  const html = ui.questionCard(drawn, { links: ui.linkContext(boardItems, null, { base: './' }) });
  const [a, b] = takeCards(html);
  assert.deepEqual(frames(html), []);
  assert.deepEqual([...a.matchAll(/<div class="flow-box([^"]*)">([^<]*)<\/div>/g)].map((m) => [m[2], m[1].trim()]),
    [['Poll', ''], ['Wake', ''], ['boards.mjs', 'in tone-info'], ['Unused', 'in tone-quiet']]);
  assert.equal((a.match(/<line /g) || []).length, 3);
  assert.match(text(a), /In practice A new feature asks INT-54 \.$/);
  assert.deepEqual(anchors(a), [['./#item=site%2FS54', 'INT-54', false]]);
  assert.match(b, /<div class="flow-box tone-danger">Each &lt;own&gt; read<\/div>/);
  assert.match(text(b), /In practice Nothing to build\. Each feature forgets a kind\.$/);
  assert.match(html, /<a class="pill proto" href="prototype-seams\.html\?q=q1">See the prototypes →<\/a>/);
});

test("a question's link opens in place on this hub, and outside the board anywhere else", () => {
  context.location = { origin: 'https://mac.tail.ts.net', href: 'https://mac.tail.ts.net/orch/' };
  try {
    assert.doesNotMatch(ui.questionCard({ ...question, url: 'https://mac.tail.ts.net/orch/plan.html?item=w%2FA1' }), /target="_blank"/);
  } finally { context.location = { hostname: 'mac.ts.net', host: 'mac.ts.net:443' }; }
  const linear = ui.questionCard({ ...question, url: 'https://linear.app/acme/issue/INT-1' });
  assert.match(linear, /href="https:\/\/linear\.app\/acme\/issue\/INT-1" target="_blank"/);
  assert.match(linear, /target="_blank" rel="noopener">INT-1 <svg class="link-arrow"[^>]*>[^]*<\/svg><\/a>/);
});

// docs/adr/2026-11-03-1803-a-question-asked-for-a-prototype-is-resolved.md
test('an open question has its eye on and nothing locked, a resolved one has no eye; a confirm links its one take alone and says why it is asked', () => {
  assert.match(ui.questionCard(question), /<button type="button" class="attach proto-ask" data-proto="q:q1" aria-label="Ask for a prototype instead" title="Ask for a prototype instead">/);
  assert.doesNotMatch(ui.questionCard(question), /disabled|pr-busy|try-spin/);
  assert.doesNotMatch(ui.questionCard({ ...question, state: 'resolved' }), /data-proto/);

  const confirm = { ...question, id: 'c1', question: 'Is this it?', url: 'prototype-search.html?q=c1', options: [{ id: 'B', label: 'Icon' }], round: 1, confirm_of: 'q1' };
  const open = ui.questionCard(confirm);
  assert.match(open, /<a class="pill proto pr-open" href="prototype-search\.html\?q=c1&amp;take=B">Open the prototype →<\/a>/);
  assert.match(text(open), /A pick with a note gets a one-take confirm once Claude has updated the take\./);
  assert.deepEqual(frames(open), ['prototype-search.html?q=c1&take=B']);
  assert.doesNotMatch(ui.questionCard({ ...confirm, state: 'answered', answers: [{ ts: ago(1), choice: 'B', note: '', reply: null }] }), /one-take confirm/);
  assert.doesNotMatch(ui.questionCard({ ...confirm, url: 'prototype-search.html?q=c1', confirm_of: undefined }), /pr-open|one-take confirm/);
});

test("a topic's prototype round chip is blue with a spinner while being made, blue while back, and grey once its confirm closes it", () => {
  assert.equal(ui.roundChip(null), '');
  assert.equal(ui.roundChip({ n: 2, state: 'making' }), '<span class="chip tone-normal"><span class="try-spin" aria-hidden="true"></span>Prototype round 2</span>');
  assert.equal(ui.roundChip({ n: 2, state: 'back' }), '<span class="chip tone-normal">Prototype round 2</span>');
  assert.equal(ui.roundChip({ n: 2, state: 'closed', take: 'B' }), '<span class="chip tone-quiet">Round 2 closed · take B</span>');
});

test('a resolved question is read-only: its pick checked and locked, no note box or eye, how it was resolved and when it was acted on, and the note said once', () => {
  const at = new Date(Date.now() - 3 * 3600_000).toISOString();
  const answer = { ts: new Date(Date.now() - 4 * 3600_000).toISOString(), choice: 'B', note: 'Drop it, it is noise', files: [], reply: null, acted: true };
  const html = ui.questionCard({ ...question, state: 'resolved', resolved: 'Kept it', resolved_at: at, answers: [answer], reask: null });
  assert.match(text(html), /Kept it\. acted on 3h ago ?\./);
  assert.doesNotMatch(html, /A new answer reopens it|<textarea|data-proto|<details/);
  assert.deepEqual([...html.matchAll(/<input [^>]*>/g)].map((m) => [/value="(\w)"/.exec(m[0])[1], /\bchecked\b/.test(m[0]), /\bdisabled\b/.test(m[0])]), [['A', false, true], ['B', true, true]]);
  assert.equal(html.split('Drop it, it is noise').length, 2, 'the note shows once');
  assert.doesNotMatch(text(html), /You · [^]*B\. Drop/, 'the pick is the checked option, not said again');
  assert.match(html, /<button class="chip tone-ready" title="Ask this question again" type="button" data-reask="q1">resolved<\/button>/);
  assert.doesNotMatch(html, /re-ask requested/);
  const pending = ui.questionCard({ ...question, state: 'resolved', resolved: 'Kept it', resolved_at: at, answers: [answer], reask: { id: 'r1', ts: new Date().toISOString() } });
  assert.match(pending, /data-reask="q1" disabled="">resolved<\/button>/);
  assert.match(text(pending), /re-ask requested/);
});

test("a resolved question keeps Claude's reply under the note, and one with no answer shows no answer box", () => {
  const answer = { ts: new Date().toISOString(), choice: 'A', note: '', files: [], reply: { html: '<p>Done that.</p>' }, acted: true };
  const html = ui.questionCard({ ...question, state: 'resolved', resolved: 'Kept it', answers: [answer] });
  assert.match(text(html), /Claude Done that\./);
  assert.doesNotMatch(text(html), /acted on/, 'with no resolved_at it says no time');
  assert.doesNotMatch(ui.questionCard({ ...question, state: 'resolved', resolved: 'Kept it' }), /class="ans/);
});

test('a topic pill is named by the card id its title starts with, else by its whole title', () => {
  assert.deepEqual(['INT-92: Hub home rows', 'B5: Lane chips', 'Release plan', 'INT-92 without a colon', 'Other'].map((title) => ui.topicName({ title })),
    ['INT-92', 'B5', 'Release plan', 'INT-92 without a colon', 'Other']);
});

test('an ask topic pill reads the time it appeared, not its title', () => {
  const at = new Date(); at.setHours(10, 26, 0, 0);
  assert.equal(ui.topicName({ title: 'New: Fix it', askedAt: at.toISOString() }), ui.cardTime(at.toISOString()));
});

test("a card's topic, which the board sends with no title, takes its name from its card, and every other topic keeps its own", () => {
  const at = new Date(); at.setHours(9, 5, 0, 0);
  const cards = [{ key: 'w/B5', kind: 'work', ref: 'B5', title: 'Lane chips' }, { key: 'ask:e1', kind: 'ask', ref: 'New', title: 'Fix it', ask: { askedAt: at.toISOString() } }];
  const named = ui.cardTopics([{ id: 'item:w/B5', card: 'w/B5', open: 1 }, { id: 'item:ask:e1', card: 'ask:e1', open: 1 }, { id: 'plan', title: 'Release plan' }, { id: 'item:w/Z', card: 'w/Z', title: 'Z9: Archived' }], cards);
  assert.deepEqual(plain(named.map((t) => [t.title, t.summary ?? null, ui.topicName(t)])),
    [['B5: Lane chips', 'Questions about this work item.', 'B5'], ['New: Fix it', 'Questions about this work item.', ui.cardTime(at.toISOString())], ['Release plan', null, 'Release plan'], ['Z9: Archived', null, 'Z9']]);
});

test('the topic row shows only topics with an open question, the current one kept, and the rest wait on Claude', () => {
  const t = (id, state, open, answered = 0, replied = 0) => ({ id, title: id, state, open, answered, replied });
  const topics = [t('a', 'open', 0, 1), t('b', 'open', 2), t('c', 'open', 0, 0, 1), t('d', 'resolved', 0), t('e', 'open', 1), t('f', 'resolved', 0)];
  const ids = (row) => ({ pills: row.pills.map((x) => x.id), waiting: row.waiting.map((x) => x.id) });
  assert.deepEqual(ids(ui.topicRow(topics, 'b')), { pills: ['b', 'e'], waiting: ['a', 'c'] });
  assert.deepEqual(ids(ui.topicRow(topics, 'c')), { pills: ['b', 'c', 'e'], waiting: ['a'] });
  assert.deepEqual(ids(ui.topicRow(topics, 'f')), { pills: ['b', 'e', 'f'], waiting: ['a', 'c'] });
  assert.deepEqual(ids(ui.topicRow(topics, null)), { pills: ['b', 'e'], waiting: ['a', 'c'] });
});

test('Send and prototype picks share one move-on rule: same topic next and wrap, left topic, right topic, any, none, including an urgent question shown alone', () => {
  const q = (id, topic, state = 'open', urgent = false) => Object.freeze({ id, topic, state, urgent });
  const owner = Object.freeze([q('a', 't1'), q('b', 't1', 'answered'), q('c', 't2'), q('d', 't1'), q('e', 't1'), q('f', 't3')]);
  const topics = Object.freeze(['t2', 't3', 't1'].map((id) => Object.freeze({ id })));
  const cases = [
    ['same topic next', owner, topics, owner[3], 'e'],
    ['same topic wrap', owner, topics, owner[4], 'a'],
    ['left topic in pill order', owner, topics, owner[5], 'c'],
    ['nearest left topic', [q('a', 't1'), q('b', 't2'), q('c', 't3', 'answered')], ['t1', 't2', 't3'].map((id) => ({ id })), { id: 'c', topic: 't3' }, 'b'],
    ['right topic', owner, topics, owner[2], 'f'],
    ['any unlisted topic', [q('a', 'other'), q('b', 't1', 'answered')], topics, { id: 'b', topic: 't1' }, 'a'],
    ['no pills', owner, [], owner[5], 'a'],
    ['none', [q('a', 't'), q('b', 't', 'resolved')], [], { id: 'a', topic: 't' }, null],
    ['empty', [], [], { topic: 'gone' }, null],
    ['topic-wide Send stays', owner, topics, { topic: 't1' }, 'a'],
    ['urgent answered, same topic still open', [q('a', 't1', 'answered', true), q('b', 't1'), q('c', 't2')], topics, { topic: 't1' }, 'b'],
    ['urgent answered, left topic', [q('a', 't1', 'answered', true), q('b', 't2'), q('c', 't3')], topics, { topic: 't1' }, 'c'],
    ['another urgent question does not override pill order', [q('a', 't1', 'answered'), q('b', 't2', 'open', true), q('c', 't3')], topics, { topic: 't1' }, 'c'],
    ['answered question removed', [q('a', 't2'), q('b', 't3')], topics, { id: 'gone', topic: 't1' }, 'b'],
  ];
  for (const [label, questions, pills, answered, expected] of cases) {
    const before = JSON.stringify([questions, pills, answered]);
    assert.equal(ui.nextQuestion(questions, pills, answered)?.id ?? null, expected, label);
    assert.equal(JSON.stringify([questions, pills, answered]), before, label + ' is pure');
  }
});

const shot = { name: 'shot.png', url: 'uploads/1-shot.png', type: 'image/png', size: 3 };
const log = { name: '<b>build</b>.log', url: 'uploads/2-build-.log', type: 'text/plain', size: 9 };

test('a thread message shows an image as a thumbnail that opens the file, and any other file as a named link', () => {
  const html = ui.threadMessages([{ ts: ago(1), who: 'love', via: 'site', text: '', files: [shot, log], eventId: 'e1', reply: null }]);
  assert.match(html, /<a class="file-thumb" href="uploads\/1-shot\.png"[^>]*><img src="uploads\/1-shot\.png"/);
  assert.match(html, /<a class="file-link" href="uploads\/2-build-\.log"[^>]*>&lt;b&gt;build&lt;\/b&gt;\.log<\/a>/);
  assert.doesNotMatch(html, /<b>/);
});

test('an attachment that is not an upload gets no link', () => {
  const html = ui.attachments([{ name: 'x', url: 'javascript:alert(1)', type: 'image/png' }]);
  assert.doesNotMatch(html, /href|src=/);
  assert.equal(text(html), 'x');
});

test("a question's answer history shows the answer's files", () => {
  const answered = { ...question, state: 'answered', answers: [{ ts: ago(1), choice: 'A', note: 'see', files: [shot], reply: null }] };
  assert.match(ui.answerHistory(answered), /<img src="uploads\/1-shot\.png"/);
});

test('a pending upload shows its progress and a remove button naming the file', () => {
  const html = ui.pendingFiles([{ id: 'f1', name: 'a.pdf', type: 'application/pdf', status: 'uploading', progress: 0.5 }, { id: 'f2', name: 'big.mov', type: 'video/quicktime', status: 'error', error: 'Over 20 MB' }]);
  assert.match(html, /aria-valuenow="50"/);
  assert.match(html, /data-unattach="f1" aria-label="Remove a\.pdf"/);
  assert.match(text(html), /big\.mov Over 20 MB/);
});

test("a thread's Done reads Done and is never disabled on a finishable card, orange while it clears an ask's Action needed and orange while a card waits only on it", () => {
  const done = (it) => { const html = ui.doneButton(it); return html && [text(html), /disabled/.test(html)]; };
  assert.deepEqual(done({ key: 'ask:a1', kind: 'ask', finishable: true }), ['Done', false]);
  assert.match(ui.doneButton({ key: 'ask:a1', kind: 'ask', finishable: true, resolvedBy: 'markDone' }), /^<button type="button" class="resolves"/);
  assert.doesNotMatch(ui.doneButton({ key: 'ask:a1', kind: 'ask', finishable: true }), /resolves/);
  assert.match(ui.doneButton({ key: 'w/A1', kind: 'work', finishable: true, awaitsDone: true }), /^<button type="button" class="closes"/);
  assert.doesNotMatch(ui.doneButton({ key: 'w/A1', kind: 'work', finishable: true }), /class=/);
  assert.deepEqual(done({ key: 'w/A1', kind: 'work', finishable: true }), ['Done', false]);
  assert.equal(done({ key: 'w/A1', kind: 'work', finishable: false }), '');
  assert.equal(done(undefined), '');
});

test("the open card's details list ends with Notes, Install and GitHub links in order, omitting links that do not apply; Notes has no summary or button, and a ready card's Implement is filled orange", () => {
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  assert.match(css, /button\.build\.ready, button\.unhold, button\.closes \{[^}]*background: var\(--color-notice\)/);

  const app = vm.createContext({ document: { addEventListener() {} }, CSS: { escape: (s) => s }, matchMedia: () => ({ matches: false }) });
  for (const file of ['ui.js', 'ui-links.js', 'ui-enums.js', 'ui-phase-bars.js', 'ui-cards.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), app);
  const clicks = [], later = [];
  const B = { $: () => ({}), alive: () => false, on: (el, type, fn) => { if (type === 'click') clicks.push(fn); }, later: (ms, fn) => later.push([ms, fn]), store: {}, state: { board: { items: [] }, mainPull: { sending: false, open: false } }, seen: {}, thread: () => '', links: (key) => app.BoardUI.linkContext([], key) };
  app.BoardView = { part: (fn) => fn(B) };
  vm.runInContext(fs.readFileSync(new URL('./public/app-cards.js', import.meta.url), 'utf8'), app);
  const open = { ...workCard, pr: null, prs: [], reviewers: [], key: 'w/A1', action: null, waveTitle: 'W', deps: [], manualSteps: [], kind: 'work', holdable: true, hasNotes: true, notes: 'Old short note', summary: 'A stored summary' };
  const rows = (it) => [...B.detail(it).matchAll(/<dt[^>]*>(.*?)<\/dt><dd[^>]*>(.*?)<\/dd>/g)].map(([, k, v]) => [text(k), text(v)]);
  const pushed = { ...open, ref: 'INT-12', next: 'merge INT-12 into main', branch: 'INT-12', pushed: { branch: 'INT-12', at: new Date(Date.now() - 25 * 60_000).toISOString(), host: 'gitlab.com' } };
  assert.deepEqual(rows(pushed), [['Wave', 'W'], ['Branch', 'INT-12'], ['Next', 'merge INT-12 into main'], ['Links', 'Notes · Pushed INT-12 to gitlab.com · 25m ago']]);
  assert.doesNotMatch(B.detail(pushed), /github\.com|gitlab\.com\/|<button[^>]*data-copy/);
  const copied = [];
  app.navigator = { clipboard: { writeText: async (t) => { copied.push(t); } } };
  const link = { dataset: { copyBranch: 'INT-12' }, textContent: 'Pushed INT-12 to gitlab.com · 25m ago', isConnected: true };
  B.state.board.items = [pushed];
  let prevented = false;
  for (const fn of clicks) fn({ target: { closest: (sel) => (sel === '[data-copy-branch]' ? link : null) }, preventDefault: () => { prevented = true; } });
  assert.deepEqual([copied, link.textContent, prevented], [['INT-12'], 'Copied the branch name', true]);
  later.at(-1)[1]();
  assert.equal(link.textContent, 'Pushed INT-12 to gitlab.com · 25m ago');
  assert.deepEqual(rows(open), [['Wave', 'W'], ['Next', 'Waiting for PR reviewers'], ['Links', 'Notes']]);
  assert.match(B.detail(open), /href="notes.html\?item=w%2FA1"/);
  assert.doesNotMatch(B.detail(open), /Old short note|A stored summary|view more|<summary[^>]*>Notes|class="actions"[^]*notes\.html/);
  assert.doesNotMatch(B.detail({ ...open, hasNotes: false }), /Notes|notes\.html/);
  const install = { url: 'https://m/app.apk', older: false };
  const pr = { state: 'OPEN', url: 'https://github.com/o/r/pull/1' };
  for (const hasNotes of [false, true]) {
    for (const build of [null, install]) {
      for (const state of ['OPEN', 'MERGED', 'CLOSED']) {
        const it = { ...open, hasNotes, install: build, pr: { ...pr, state }, prs: [{ ...pr, state }] };
        const expected = [hasNotes && 'Notes', build && 'Install', state === 'OPEN' && 'Review on GitHub'].filter(Boolean);
        assert.deepEqual(rows(it).filter(([label]) => label === 'Links'), expected.length ? [['Links', expected.join(' · ')]] : []);
        assert.match(B.detail(it), expected.length ? /<dd class="external-links">[^]*<\/dd><\/dl>/ : /<dd>Waiting for PR reviewers<\/dd><\/dl>/);
        assert.doesNotMatch(B.detail(it), /action-row external/);
      }
    }
  }
});

test("a card with a worktree opens it in VS Code from its Links line after Notes, only on the host", () => {
  const app = vm.createContext({ document: { addEventListener() {} }, CSS: { escape: (s) => s }, matchMedia: () => ({ matches: false }) });
  for (const file of ['ui.js', 'ui-links.js', 'ui-enums.js', 'ui-phase-bars.js', 'ui-cards.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), app);
  const B = { $: () => ({}), on() {}, later() {}, store: {}, state: { board: { items: [], onHost: true } }, seen: {}, thread: () => '', links: (key) => app.BoardUI.linkContext([], key) };
  app.BoardView = { part: (fn) => fn(B) };
  vm.runInContext(fs.readFileSync(new URL('./public/app-cards.js', import.meta.url), 'utf8'), app);
  const rows = (it) => [...B.detail(it).matchAll(/<dt[^>]*>(.*?)<\/dt><dd[^>]*>(.*?)<\/dd>/g)].map(([, k, v]) => [text(k), text(v)]);
  const open = { ...workCard, pr: null, prs: [], reviewers: [], key: 'w/A1', action: null, waveTitle: 'W', deps: [], manualSteps: [], kind: 'work', holdable: true, hasNotes: true, worktree: '/Users/me/.claude/kickflip/worktrees/A 1' };
  assert.deepEqual(rows(open).at(-1), ['Links', 'Notes · Open in VS Code']);
  assert.match(B.detail(open), /<a href="vscode:\/\/file\/Users\/me\/\.claude\/kickflip\/worktrees\/A%201" title="Open the worktree in VS Code">Open in VS Code /);
  assert.deepEqual(rows({ ...open, hasNotes: false }).at(-1), ['Links', 'Open in VS Code']);
  assert.doesNotMatch(B.detail({ ...open, worktree: null }), /vscode:|Open in VS Code/);
  B.state.board.onHost = false;
  assert.doesNotMatch(B.detail(open), /vscode:|Open in VS Code/);
});

// docs/adr/2026-11-03-0526-a-follow-up-is-a-work-card-with-a-parent.md
test("the open card's details list shows Parent, Children, Related to, Blocked by and Waits on it as rows of tappable labels, leaving out empty rows; the workflow row has no follow-up Build", () => {
  const app = vm.createContext({ document: { addEventListener() {} }, CSS: { escape: (s) => s }, matchMedia: () => ({ matches: false }) });
  for (const file of ['ui.js', 'ui-links.js', 'ui-enums.js', 'ui-phase-bars.js', 'ui-cards.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), app);
  const B = { $: () => ({}), on() {}, store: {}, state: { board: { items: [] } }, seen: {}, thread: () => '', links: (key) => app.BoardUI.linkContext([], key) };
  app.BoardView = { part: (fn) => fn(B) };
  vm.runInContext(fs.readFileSync(new URL('./public/app-cards.js', import.meta.url), 'utf8'), app);
  const link = (ref) => ({ key: `w/GH-${ref.slice(1)}`, ref });
  const card = { ...workCard, pr: null, prs: [], reviewers: [], key: 'w/GH-93', ref: '#93', lane: 'todo', action: null, waveTitle: 'W', status: 'planned', next: null, deps: ['GH-80'], manualSteps: [], holdable: true,
    parent: link('#53'), children: [link('#94'), link('#95')], related: [link('#75')], blockedBy: [link('#80')], waitsOnIt: [link('#99')] };
  const rows = (it) => [...B.detail(it).matchAll(/<dt[^>]*>(.*?)<\/dt><dd[^>]*>(.*?)<\/dd>/g)].map(([, k, v]) => [text(k), text(v)]);
  assert.deepEqual(rows(card), [['Wave', 'W'], ['Status', 'planned'], ['Parent', '#53'], ['Children', '#94 #95'], ['Related to', '#75'], ['Blocked by', '#80'], ['Waits on it', '#99']]);
  assert.deepEqual([...B.detail(card).matchAll(/<a class="card-link" href="([^"]*)">([^<]*)<\/a>/g)].map(([, href, ref]) => [href, ref]),
    [['#item=w%2FGH-53', '#53'], ['#item=w%2FGH-94', '#94'], ['#item=w%2FGH-95', '#95'], ['#item=w%2FGH-75', '#75'], ['#item=w%2FGH-80', '#80'], ['#item=w%2FGH-99', '#99']]);
  assert.deepEqual(rows({ ...card, parent: null, children: [], related: [], blockedBy: [], waitsOnIt: [] }), [['Wave', 'W'], ['Status', 'planned']]);
  // An In Progress card whose agent works on it reads implementing; Build only means the package (docs/adr/2026-11-03-1549-a-todo-cards-button-reads-implement.md).
  assert.deepEqual(rows({ ...card, status: 'building', parent: null, children: [], related: [], blockedBy: [], waitsOnIt: [] }), [['Wave', 'W'], ['Status', 'implementing']]);
  assert.doesNotMatch(B.detail(card), /data-confirm="build"|Filed from|Waits on</);
  assert.deepEqual(lines(app.BoardUI.workLines({ ...card, linear: [], ticket: null })).slice(0, 2), ['Five', 'blocked by #80']);
  assert.doesNotMatch(app.BoardUI.workLines(card), /follow-up/);
});

test('the side pages wait out a board restart: a failed request, a 5xx or a body that is not JSON shows Board restarting… and retries with a growing backoff, until about limit ms', async () => {
  const answers = (list) => { const calls = []; return { calls, fetch: async (url) => { calls.push(url); const a = list.shift(); if (a instanceof Error) throw a; return { ok: a.status < 400, status: a.status, text: async () => a.body }; } }; };
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  const restarting = answers([new Error('refused'), { status: 502, body: '<html>Bad gateway</html>' }, { status: 200, body: '<!doctype html>' }, { status: 200, body: '{"ref":"INT-1"}' }]);
  const r = await ui.fetchJSON('api/notes?item=w%2FA1', { fetch: restarting.fetch, sleep, onWait: (ms) => waits.push(`wait ${ms}`) });
  assert.deepEqual(plain(r), { ok: true, status: 200, body: { ref: 'INT-1' } });
  assert.deepEqual(waits, ['wait 0', 500, 'wait 500', 1000, 'wait 1500', 2000]);
  const missing = await ui.fetchJSON('x', { fetch: answers([{ status: 404, body: '{"error":"w/A1 has no notes"}' }]).fetch, sleep });
  assert.deepEqual(plain(missing), { ok: false, status: 404, body: { error: 'w/A1 has no notes' } });
  const down = answers(Array.from({ length: 20 }, () => ({ status: 502, body: 'Bad gateway' })));
  await assert.rejects(ui.fetchJSON('x', { fetch: down.fetch, sleep, limit: 3000 }), /the board answered 502/);
  assert.equal(down.calls.length, 4);
  assert.equal(ui.restartNotice().includes(ui.RESTARTING), true);
});

// docs/adr/2026-11-04-0128-the-board-download-leaves-out-resolved-questions.md
test('a side page names the board it holds by its version, and an unchanged board answers 304 with no body', async () => {
  const asked = [];
  const fetch = async (url, opts) => { asked.push(opts.headers || {}); return opts.headers?.['if-none-match'] === '"v1"' ? { ok: false, status: 304, text: async () => '' } : { ok: true, status: 200, text: async () => '{"version":"v2"}' }; };
  assert.deepEqual(plain(await ui.fetchJSON('api/board', { fetch, tag: 'v1' })), { ok: true, status: 304, body: null });
  assert.deepEqual(plain(await ui.fetchJSON('api/board', { fetch, tag: 'v0' })), { ok: true, status: 200, body: { version: 'v2' } });
  await ui.fetchJSON('api/board', { fetch });
  assert.deepEqual(plain(asked), [{ 'if-none-match': '"v1"' }, { 'if-none-match': '"v0"' }, {}]);
});

test("an open card waiting on the owner's Merge shows a Merge button that confirms first, and waits, disabled with its label kept behind the spinner, while the session merges it", () => {
  const merge = (it) => { const html = ui.mergeButton(it); return html && [text(html), / disabled aria-busy="true"/.test(html), /data-confirm="merge"/.test(html), /data-key="w\/A1"/.test(html)]; };
  const waiting = { key: 'w/A1', action: { kind: 'merge', url: '#item=w%2FA1', label: 'Merge' }, merging: false };
  assert.deepEqual(merge(waiting), ['Merge', false, true, true]);
  assert.deepEqual(merge({ key: 'w/A1', action: null, merging: true }), ['Merge', true, true, true]);
  assert.equal(merge({ key: 'w/A1', action: { kind: 'steps', url: '#item=w%2FA1', label: 'Run the manual steps, then merge' }, merging: false }), '');
  assert.equal(merge({ key: 'w/A1', action: null, merging: false }), '');
  assert.equal(merge(undefined), '');
});

test("an open card that can be implemented shows Implement rightmost in its action row, which confirms first, plain until the card is ready and builder orange once it is, beside Grill and Prototype", () => {
  const build = (it) => { const html = ui.buildButton(it); return html && [text(html), /disabled/.test(html), /data-confirm="card-build"/.test(html), /data-key="w\/A1"/.test(html), /class="([^"]*)"/.exec(html)[1]]; };
  const todoCard = { key: 'w/A1', kind: 'work', lane: 'todo' };
  assert.deepEqual(build({ ...todoCard, buildable: true }), ['Implement', false, true, true, 'build']);
  assert.deepEqual(build({ ...todoCard, buildable: true, ready: true }), ['Implement', false, true, true, 'build ready']);
  // Always on a Todo card, plain while its questions wait on the owner.
  assert.deepEqual(build({ ...todoCard, buildable: false, action: { kind: 'questions' } }), ['Implement', false, true, true, 'build']);
  for (const off of [{ lane: 'progress' }, { lane: 'review' }, { lane: 'done' }, { kind: 'ask' }]) assert.equal(build({ ...todoCard, ...off }), '', JSON.stringify(off));
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  assert.match(css, /button\.build\.ready[,\s][^{]*\{[^}]*--color-notice/);
  assert.doesNotMatch(css, /button\.build[,\s{]/);

  const app = vm.createContext({ document: { addEventListener() {} }, CSS: { escape: (s) => s }, matchMedia: () => ({ matches: false }) });
  for (const file of ['ui.js', 'ui-links.js', 'ui-enums.js', 'ui-phase-bars.js', 'ui-cards.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), app);
  const B = { $: () => ({}), on() {}, store: {}, state: { board: { items: [] } }, seen: {}, thread: () => '', links: (key) => app.BoardUI.linkContext([], key) };
  app.BoardView = { part: (fn) => fn(B) };
  vm.runInContext(fs.readFileSync(new URL('./public/app-cards.js', import.meta.url), 'utf8'), app);
  const todo = { ...workCard, pr: null, prs: [], reviewers: [], key: 'w/A1', lane: 'todo', action: null, actionButton: 'grill', waveTitle: 'W', deps: [], manualSteps: [], holdable: true, hasNotes: true,
    try: { kind: 'web', script: true, changes: false }, buildable: true };
  const row = (it) => [...B.detail(it).match(/<div class="action-row workflow">(.*?)<\/div>/)[1].matchAll(/<button[^>]*>(.*?)<\/button>/g)].map(([, label]) => label);
  assert.deepEqual(row(todo), ['Hold', 'Grill', 'Prototype', 'Implement']);
  const changed = { ...todo, try: { ...todo.try, changes: true } };
  assert.deepEqual(row(changed), ['Hold', 'Grill', 'Prototype', 'Serve', 'Implement']);
  assert.deepEqual(row({ ...changed, buildable: false }), ['Hold', 'Grill', 'Prototype', 'Serve', 'Implement']);
  assert.deepEqual(row({ ...changed, lane: 'progress' }), ['Hold', 'Grill', 'Prototype', 'Serve']);
  assert.deepEqual(row({ ...todo, held: true }), ['Grill', 'Prototype', 'Implement']);
  assert.deepEqual(row({ ...todo, held: true, buildable: false }), ['Unhold', 'Grill', 'Prototype', 'Implement']);
  assert.match(B.detail({ ...todo, held: true }), /data-confirm="card-build"/);
});

test('the working line reads thinking, in one shared class on the card and in the thread', () => {
  assert.equal(ui.workingLine, '<span class="thinking"><span class="working-dot" aria-hidden="true"></span>thinking</span>');
  const ask = { kind: 'ask', key: 'ask:a1', id: 'a1', ref: '10:00', title: 'Fix it', internal: false, linear: [], pr: null, prs: [], deps: [], blockedBy: [], working: true };
  assert.match(ui.workLines(ask), /<div class="line3 sub agent"><span class="thinking">/);
  assert.match(ui.threadMessages([{ ts: ago(3), who: 'love', via: 'site', kind: 'item-message', text: 'Fix it', eventId: 'e1', reply: null, state: 'working', canDelete: true }]), /<div class="reply muted small"><span class="thinking">/);
});

test('a thread message says thinking while Claude works on it, and only a pending message can be deleted', () => {
  const html = ui.threadMessages([
    { ts: ago(3), who: 'love', via: 'site', kind: 'item-message', text: 'Fix it', eventId: 'e1', reply: null, state: 'working', canDelete: true },
    { ts: ago(2), who: 'love', via: 'site', kind: 'item-message', text: 'Old', eventId: 'e2', reply: null, state: 'answered', canDelete: false },
  ]);
  assert.match(text(html), /Fix it thinking .* Old$/);
  assert.deepEqual([...html.matchAll(/data-withdraw="(\w+)"/g)].map((m) => m[1]), ['e1']);
});

// docs/adr/2026-11-03-2024-every-in-progress-card-shows-its-phase-bars.md
test('a stalled builder has no Stalled badge: its status line turns the needs-you red and nudges Claude when tapped', () => {
  const builder = { progress: 'Running tests', at: null, stalled: true };
  const html = ui.workLines({ ...workCard, lane: 'progress', builder });
  assert.match(html, /<button type="button" class="line3 sub agent stalled" data-confirm="nudge" data-key="w\/B5" title="No recent progress\. Nudge Claude to check this implementer"><span class="working-dot" aria-hidden="true"><\/span>Running tests<\/button>/);
  assert.doesNotMatch(html, /Stalled|tone-danger/);
  for (const next of [{ ...builder, stalled: false }, null]) assert.doesNotMatch(ui.workLines({ ...workCard, builder: next }), /stalled|data-confirm="nudge"/);
  assert.doesNotMatch(ui.workLines({ ...workCard, lane: 'done', builder }), /stalled|data-confirm="nudge"/);
});

test("a refused Implement's reason takes the card's status line, in place of its next step", () => {
  const reason = "Couldn't start implementing: it's held. Unhold it, then tap Implement.";
  const html = ui.workLines({ ...workCard, lane: 'todo', builder: null, next: 'Grill the notes', refusal: reason });
  assert.match(html, /<div class="line3 sub refused">Couldn&#39;t start implementing: it&#39;s held\. Unhold it, then tap Implement\.<\/div>/);
  assert.doesNotMatch(html, /Next: /);
});

test("the phase bars draw any list of phases: the board's five build phases and a start's three steps share one renderer", () => {
  assert.equal(ui.phaseBars(null, ['a', 'b']), '');
  assert.equal(ui.phaseBars({ reached: 2, running: true, dim: true, label: 'B <2>' }, ['a', 'b', 'c']),
    '<span class="phase-bars dim" role="img" aria-label="B &lt;2&gt;" title="B &lt;2&gt;"><i class="done"></i><i class="now"></i><i class=""></i></span>');
  assert.equal(ui.phaseBars({ reached: 1, running: false, fill: 30, label: 'x' }, ['a', 'b', 'c']),
    '<span class="phase-bars" role="img" aria-label="x" title="x"><i class="done"></i><i class="fill" style="--p:30%"></i><i class=""></i></span>');
  assert.match(ui.workLines({ ...workCard, lane: 'progress', builder: { progress: 'x', phase: 'building', at: null } }), /<span class="phase-bars" role="img" aria-label="Building, step 2 of 5" title="Building, step 2 of 5"><i class="done"><\/i><i class="now"><\/i>(<i class=""><\/i>){3}<\/span>/);
});

test('a building card in In Progress ends its time row with five bars, before the new-messages count, done phases filled and the current one marked', () => {
  const builder = { progress: 'Testing · the limiter', phase: 'testing', at: null };
  const sortAt = '2020-01-01T10:00:00.000Z';
  const building = { ...workCard, lane: 'progress', sortAt, builder };
  const html = ui.workLines(building, { unread: 2 });
  assert.match(html, /<div class="line3 sub agent"><span class="working-dot" aria-hidden="true"><\/span>Testing · the limiter<\/div>/);
  assert.match(html, new RegExp(`<div class="line6 sub card-time"><time datetime="${sortAt}">[^<]*</time><span class="sep"> · </span><span class="phase-bars" role="img" aria-label="Testing, step 3 of 5" title="Testing, step 3 of 5"><i class="done"></i><i class="done"></i><i class="now"></i><i class=""></i><i class=""></i></span><span class="card-unread"><span class="sep"> · </span>2 new messages</span></div>`));
  assert.equal(html.match(/phase-bars/g).length, 1);
  assert.match(ui.workLines(building), /<\/time><span class="sep"> · <\/span><span class="phase-bars"/);
  const first = ui.workLines({ ...building, builder: { ...builder, phase: 'reading' } });
  assert.match(first, /<i class="now"><\/i><i class=""><\/i><i class=""><\/i><i class=""><\/i><i class=""><\/i>/);
  assert.match(ui.workLines({ ...building, builder: { ...builder, phase: 'landing' } }), /aria-label="Landing, step 5 of 5"/);
});

// docs/adr/2026-11-03-2024-every-in-progress-card-shows-its-phase-bars.md
test('every In Progress card shows its five phase bars: empty before a phase, filled to the phase reached, all filled in review or reopened, dimmed while it waits on something other than a builder', () => {
  const sortAt = '2020-01-01T10:00:00.000Z';
  const card = { ...workCard, lane: 'progress', sortAt, builder: null, next: null };
  const testing = { progress: 'Testing · the limiter', phase: 'testing', at: null };
  const questions = { kind: 'questions', url: 'questions.html#q1', label: 'Answer 2 questions' };
  const strip = (it) => {
    const m = ui.workLines(it).match(/<span class="phase-bars( dim)?" role="img" aria-label="([^"]*)" title="\2">((?:<i class="\w*"><\/i>){5})<\/span>/);
    return m && { dim: Boolean(m[1]), label: m[2], bars: [...m[3].matchAll(/class="(\w*)"/g)].map((b) => b[1] || '-').join(' ') };
  };
  const cases = [
    [{ builder: { progress: null, phase: null, at: null } }, { dim: false, label: 'Preheating, no step yet', bars: '- - - - -' }],
    [{ builder: testing }, { dim: false, label: 'Testing, step 3 of 5', bars: 'done done now - -' }],
    [{ builder: { ...testing, stalled: true } }, { dim: true, label: 'Testing, step 3 of 5', bars: 'done done now - -' }],
    [{ waitsOn: 'checking' }, { dim: false, label: 'Orchestrator review, all 5 steps done', bars: 'done done done done done' }],
    [{ builder: { ...testing, phase: 'building' }, action: questions }, { dim: true, label: 'Building, step 2 of 5, waiting on your answers', bars: 'done now - - -' }],
    [{ reachedPhase: 'building', action: questions }, { dim: true, label: 'Stopped at building, step 2 of 5, waiting on your answers', bars: 'done done - - -' }],
    [{ queued: true, blockedBy: [{ key: 'w/A1', ref: 'A1' }] }, { dim: true, label: 'Queued, no step yet', bars: '- - - - -' }],
    [{ reopened: true, reachedPhase: 'testing' }, { dim: true, label: 'Reopened, all 5 steps done', bars: 'done done done done done' }],
    [{ reachedPhase: 'landing', next: 'Fix the failing CI' }, { dim: true, label: 'Stopped at landing, step 5 of 5', bars: 'done done done done done' }],
    [{}, { dim: true, label: 'No step yet', bars: '- - - - -' }],
    [{ builder: { kind: 'install', progress: null, phase: null, at: null }, reachedPhase: 'landing' }, { dim: false, label: 'Stopped at landing, step 5 of 5', bars: 'done done done done done' }],
  ];
  for (const [extra, want] of cases) assert.deepEqual(strip({ ...card, ...extra }), want, JSON.stringify(extra));
  for (const off of [{ lane: 'todo', builder: testing }, { lane: 'done', reopened: false }, { lane: 'review' }, { builder: { ...testing, planner: true } }]) {
    assert.doesNotMatch(ui.workLines({ ...card, ...off }), /phase-bars/, JSON.stringify(off));
  }
  assert.match(ui.workLines({ ...card, queued: true }, { unread: 1 }), /<\/time><span class="sep"> · <\/span><span class="phase-bars dim"[^>]*>.*<\/span><span class="card-unread"><span class="sep"> · <\/span>1 new message<\/span><\/div>/);
});

// docs/adr/2026-11-03-1551-planners-and-implementers-are-two-kinds-of-agent.md
test("a planner's line on a card is marked planner, keeping its dot, and never has phase bars, in Todo or In Progress; a Grill or Prototype request reads preheating or prototyping in the same slot until the planner's line takes it", () => {
  const planner = { progress: 'Prototyping · the takes', phase: null, at: null, planner: true };
  for (const lane of ['todo', 'progress']) {
    const html = ui.workLines({ ...workCard, lane, sortAt: '2020-01-01T10:00:00.000Z', builder: planner });
    assert.match(html, /<div class="line3 sub agent planner"><span class="working-dot" aria-hidden="true"><\/span>Prototyping · the takes<\/div>/);
    assert.doesNotMatch(html, /phase-bars|Building/);
  }
  const line = (it) => /<div class="line3 sub agent planner">.*?<\/span>([^<]*)<\/div>/.exec(ui.workLines({ ...workCard, lane: 'todo', sortAt: '2020-01-01T10:00:00.000Z', ...it }))?.[1];
  assert.equal(line({ grilling: true }), 'preheating');
  assert.equal(line({ prototyping: true }), 'prototyping');
  assert.equal(line({ prototyping: true, builder: planner }), 'Prototyping · the takes');
  assert.equal(line({}), undefined);
});

test("a builder line shows the progress and its age, not who is building", () => {
  const at = new Date(Date.now() - 4 * 60000).toISOString();
  assert.equal(ui.builderLine({ label: 'Opus builder', progress: 'Testing · the limiter', at }), 'Testing · the limiter · 4m ago');
  assert.equal(ui.builderLine({ label: 'Opus builder', progress: null, at }), 'preheating · 4m ago');
  assert.equal(ui.builderLine({ label: 'Opus builder', progress: null, at: null }), 'preheating');
  assert.equal(ui.builderLine({ label: null, progress: 'Making changes', at: null }), 'Making changes');
});

test("a New card reads New and its first line, then whether it was moved or edited and whether Claude has started, with bump, edit and delete and no Action needed, and ends with when it was sent", () => {
  const sent = ago(1);
  const card = (ask, extra = {}) => ui.workLines({ kind: 'ask', id: 'a1', key: 'ask:a1', ref: 'New', isNew: true, title: 'Fix <it>', linear: [], pr: null, prs: [], deps: [], blockedBy: [], created: sent, updatedAt: sent, sortAt: sent,
    bumpedAt: ask.bumpedAt || null, ask: { askedAt: sent, bumpedAt: null, canEdit: true, text: 'Fix <it>\nand more', files: [], ...ask }, ...extra }, { top: Boolean(ask.bumpedAt) });
  const at = ui.cardTime(sent);
  assert.deepEqual(lines(card({ state: 'waiting' })), ['New Fix <it>', at]);
  assert.deepEqual(lines(card({ state: 'working', bumpedAt: ago(0.5), edited: true })), ['New Fix <it>', 'Edited · thinking', at]);
  assert.deepEqual([...card({ state: 'waiting' }).matchAll(/data-(bump|edit|withdraw)="a1"/g)].map((m) => m[1]), ['bump', 'edit', 'withdraw']);
  assert.match(card({ state: 'waiting', bumpedAt: ago(0.5) }), /class="ghost icon bumped" data-bump="a1"[^>]* disabled/);
  assert.doesNotMatch(card({ state: 'waiting' }), /bumped/);
  assert.doesNotMatch(card({ state: 'waiting' }), /Action needed/);
  assert.deepEqual(lines(card({ state: 'answered' }, { isNew: false, ref: '10:00', working: false })), ['Fix <it>', at]);
  assert.deepEqual(lines(card({ state: 'waiting', from: 'Orch' })), ['New Fix <it>', 'Moved from Orch', at]);
  const asked = card({ state: 'waiting' }, { next: 'Answer 1 question', action: { kind: 'questions', url: 'questions.html#mv', label: 'Answer 1 question' } });
  assert.deepEqual(lines(asked), ['New Fix <it>', 'Next: Answer 1 question', `${at} · Action needed`]);
});

test('a pending prototype request offers a bump unless it is already the latest bump', () => {
  assert.deepEqual({ ...ui.protoNotice('e1', 'e9') }, { text: 'Prototypes are being made. Bump them to the top of the queue?', bump: true });
  assert.deepEqual({ ...ui.protoNotice('e1', 'e1') }, { text: 'Prototypes are being made.', bump: false });
});

const lines = (html) => html.split('<div class="line').slice(1).map((l) => text('<div class="line' + l));
const workCard = { kind: 'work', key: 'w/B5', id: 'B5', ref: 'B5', title: 'Five', internal: false, held: false, risky: false, threadCount: 4,
  linear: [{ id: 'ENG-1', url: 'https://linear.app/x/ENG-1' }], pr: { ...openPR, isDraft: true, status: 'draft' }, prs: [{ ...openPR, isDraft: true, status: 'draft' }], reviewers: ['Jamie'], review: { Jamie: { state: 'unsent' } },
  questions: null, builder: null, working: false, next: 'Waiting for PR reviewers' };

test('ticket badges use the board source, link internally or externally, and leave asks without a ticket', () => {
  for (const [source, id, url] of [['internal', 'OPS-9', '#item=w%2FB5'], ['github', '#9', 'https://github.com/o/r/issues/9'], ['linear', 'ENG-9', 'https://linear.app/another/issue/ENG-9']]) {
    const card = { ...workCard, ticket: { source, id, url } };
    const html = ui.workLines(card);
    assert.match(html, new RegExp(`>${id.replace('#', '#')}<`));
    assert.ok(html.includes(`href="${url}"`));
    assert.equal(html.includes('target="_blank"', 0) && html.indexOf('target="_blank"') < html.indexOf('</a>'), source !== 'internal');
    assert.doesNotMatch(html, /ENG-1/);
    assert.doesNotMatch(ui.workLines({ ...card, kind: 'ask', isNew: false }), new RegExp(`>${id}<`));
  }
  assert.match(ui.workLines({ ...workCard, linear: [...workCard.linear, { id: 'ENG-2', url: 'https://linear.app/another/issue/ENG-2' }] }), /ENG-1.*ENG-2/);
  const foreign = ui.workLines({ ...workCard, ticket: { id: 'INT-4', url: null, source: null } });
  assert.match(foreign, /<span class="chip tone-quiet"[^>]*>INT-4<\/span>/);
  assert.doesNotMatch(foreign, /ENG-1|#4/);
});

test('a work card reads its title, then its next step or builder, its chips, and last its time line with what blocks it, Action needed and its unread messages', () => {
  assert.deepEqual(lines(ui.workLines(workCard, { unread: 2 })), ['ENG-1 Five', 'Next: Waiting for PR reviewers', 'repo#7 ● CI ✓ Jamie ✗', '2 new messages']);
  assert.deepEqual(lines(ui.workLines({ ...workCard, next: null, pr: null, prs: [], reviewers: [] }, { unread: 1 })), ['ENG-1 Five', '1 new message']);
  assert.doesNotMatch(text(ui.workLines(workCard)), /B5|msg|unread|new/);
  const busy = { ...workCard, held: true, risky: true, builder: { progress: 'Running tests', at: null } };
  assert.deepEqual(lines(ui.workLines(busy)), ['ENG-1 Five', 'Running tests', 'repo#7 ● CI ✓ Jamie ✗ risky', 'held']);
  const internal = { ...workCard, key: 'site/S3', id: 'S3', ref: 'INT-3', internal: true, pr: null, prs: [], linear: [{ id: 'ENG-9', url: 'u' }], next: null };
  assert.deepEqual(lines(ui.workLines(internal)), ['INT-3 Five']);
  assert.deepEqual(lines(ui.workLines({ ...workCard, questions: { open: 1, first: 'q1' }, action: { kind: 'questions', url: 'questions.html#q1', label: 'Answer 1 question' } })),
    ['ENG-1 Five', 'Next: Waiting for PR reviewers', 'repo#7 ● CI ✓ Jamie ✗', 'Action needed']);
  assert.deepEqual(lines(ui.workLines({ ...workCard, questions: { open: 1, first: 'q1' }, action: { kind: 'questions', url: 'questions.html#q1', label: 'Answer 1 question' } }, { unread: 3 })),
    ['ENG-1 Five', 'Next: Waiting for PR reviewers', 'repo#7 ● CI ✓ Jamie ✗', 'Action needed · 3 new messages']);
  const blocked = { ...internal, lane: 'todo', deps: ['S1', 'S2'], blockedBy: [{ key: 'site/S2', ref: 'INT-2' }] };
  assert.deepEqual(lines(ui.workLines(blocked)), ['INT-3 Five', 'blocked by INT-2']);
  assert.match(ui.workLines(blocked), /<div class="line6 sub card-time"><a class="card-blocked" href="#item=site%2FS2">blocked by INT-2<\/a><\/div>/);
  assert.match(ui.workLines({ ...blocked, blockedBy: [{ key: 'site/S1', ref: 'INT-1' }, { key: 'site/S2', ref: 'INT-2' }] }), />blocked by INT-1<\/a><span class="sep">, <\/span><a class="card-blocked" href="#item=site%2FS2">INT-2<\/a>/);
  assert.deepEqual(lines(ui.workLines({ ...blocked, blockedBy: [] })), ['INT-3 Five']);
  assert.deepEqual(lines(ui.workLines({ ...blocked, blockedBy: [], next: 'Answer 1 question', action: { kind: 'questions', url: 'questions.html#q1', label: 'Answer 1 question' } })),
    ['INT-3 Five', 'Next: Answer 1 question', 'Action needed']);
  // docs/adr/2026-11-03-0301-build-on-a-blocked-card-queues-it.md: no bumped badge; the bump icon fills orange and unbumps.
  const sortAt = ago(2);
  const waiting = { ...workCard, lane: 'todo', deps: ['S2'], blockedBy: [{ key: 'site/S2', ref: 'INT-2' }], bumpable: true, bumpedAt: ago(1), held: true, sortAt,
    action: { kind: 'questions', url: 'questions.html#q1', label: 'Answer 1 question' } };
  assert.deepEqual(lines(ui.workLines(waiting, { unread: 1 })), ['ENG-1 Five', 'Next: Waiting for PR reviewers', 'repo#7 ● CI ✓ Jamie ✗', `${ui.cardTime(sortAt)} · held · blocked by INT-2 · Action needed · 1 new message`]);
  assert.match(ui.workLines(waiting), /<button class="ghost icon bumped" data-card-bump="w\/B5" data-bumped aria-pressed="true" aria-label="Unbump"/);
  assert.doesNotMatch(ui.workLines(waiting), /disabled|data-confirm="bump"/);
  assert.match(ui.workLines({ ...waiting, bumpedAt: null }), /<button class="ghost icon" data-card-bump="w\/B5" aria-pressed="false" aria-label="Bump to top"/);
  const ask = { kind: 'ask', key: 'ask:a1', id: 'a1', ref: '10:00', title: 'Fix it', internal: false, linear: [], pr: null, prs: [], deps: [], blockedBy: [], working: true };
  assert.deepEqual(lines(ui.workLines(ask)), ['Fix it', 'thinking']);
  assert.deepEqual(lines(ui.workLines(ask, { unread: 2 })), ['Fix it', 'thinking', '2 new messages']);
  assert.deepEqual(lines(ui.workLines({ ...internal, waitsOn: 'checking', working: true, next: 'Verify it' })), ['INT-3 Five', 'Orchestrator review']);
  const followup = { ...workCard, key: 'w/ENG-7', id: 'ENG-7', ref: 'ENG-7', linear: [{ id: 'ENG-7', url: 'u' }], pr: null, prs: [], reviewers: [], next: null, lane: 'todo', deps: [], blockedBy: [] };
  assert.deepEqual(lines(ui.workLines(followup)), ['ENG-7 Five']);
  assert.doesNotMatch(ui.workLines(followup), /follow-up/);
});

test("a card's last line is the time its lane sorts by, then its hold with no held chip, then its unread messages, with no age badge", () => {
  const created = ago(24 * 5);
  const updatedAt = ago(30);
  const sortAt = ago(24 * 2);
  const card = { ...workCard, lane: 'todo', pr: null, prs: [], reviewers: [], next: null, created, updatedAt, sortAt };
  const last = (html) => lines(html).at(-1);
  assert.deepEqual(lines(ui.workLines(card)), ['ENG-1 Five', ui.cardTime(sortAt)]);
  assert.match(ui.workLines(card), new RegExp(`<div class="line6 sub card-time"><time datetime="${sortAt}">`));
  assert.equal(last(ui.workLines(card, { unread: 3 })), `${ui.cardTime(sortAt)} · 3 new messages`);
  assert.match(ui.workLines(card, { unread: 3 }), /<span class="card-unread"><span class="sep"> · <\/span>3 new messages<\/span><\/div>/);
  // New questions come before new messages, in the same chip.
  assert.equal(last(ui.workLines(card, { unread: 1, newQuestions: 1 })), `${ui.cardTime(sortAt)} · 1 new question · 1 new message`);
  assert.equal(last(ui.workLines(card, { newQuestions: 2 })), `${ui.cardTime(sortAt)} · 2 new questions`);
  assert.match(ui.workLines(card, { newQuestions: 1 }), /<span class="card-unread"><span class="sep"> · <\/span>1 new question<\/span><\/div>/);
  assert.doesNotMatch(text(ui.workLines(card)), /days? ago/);

  const held = { ...card, held: true };
  assert.deepEqual(lines(ui.workLines(held)), ['ENG-1 Five', `${ui.cardTime(sortAt)} · held`]);
  assert.match(ui.workLines(held), /<span class="card-hold"[^>]*>held<\/span>/);
  assert.deepEqual(lines(ui.workLines({ ...held, sortAt: null }, { unread: 1 })), ['ENG-1 Five', 'held · 1 new message']);
  const now = new Date();
  const at = (days, h, m) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, h, m);
  const clock = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?([AP]M)$/i, (_, x) => ` ${x.toLowerCase()}`);
  const until = (d) => ({ ...held, heldUntil: d.toISOString() });
  assert.equal(last(ui.workLines(until(at(2, 9, 0)), { unread: 2 })), `${ui.cardTime(sortAt)} · held until ${at(2, 9, 0).toLocaleDateString([], { weekday: 'short' })} ${clock(at(2, 9, 0))} · 2 new messages`);
  assert.equal(last(ui.workLines(until(at(0, 23, 59)))), `${ui.cardTime(sortAt)} · held until ${clock(at(0, 23, 59))}`);
  assert.equal(last(ui.workLines(until(at(6, 9, 0)))), `${ui.cardTime(sortAt)} · held until ${at(6, 9, 0).toLocaleDateString([], { weekday: 'short' })} ${clock(at(6, 9, 0))}`);
  assert.equal(last(ui.workLines(until(at(7, 9, 0)))), `${ui.cardTime(sortAt)} · held until ${at(7, 9, 0).toLocaleDateString([], { month: 'numeric', day: 'numeric' })}, ${clock(at(7, 9, 0))}`);
  assert.doesNotMatch(ui.workLines(until(at(2, 9, 0))), /class="chip[^"]*">held/);
});

// docs/adr/2026-11-03-0516-a-new-card-is-ready-grilling-or-prototyping.md
test("a ready card's time line reads ready in green after its hold and before its unread messages, and a card from an ask still unsorted reads New", () => {
  const sortAt = ago(24 * 2);
  const card = { ...workCard, lane: 'todo', pr: null, prs: [], reviewers: [], next: null, sortAt };
  const html = ui.workLines({ ...card, held: true, ready: true }, { unread: 2 });
  assert.equal(lines(html).at(-1), `${ui.cardTime(sortAt)} · held · ready · 2 new messages`);
  assert.match(html, /<span class="card-ready">ready<\/span><span class="card-unread">/);
  assert.doesNotMatch(ui.workLines(card), /card-ready/);
  assert.deepEqual(lines(ui.workLines({ ...card, unsorted: true }))[0], 'New ENG-1 Five');
  assert.match(ui.workLines({ ...card, unsorted: true }), /<span class="chip tone-notice"[^>]*>New<\/span>/);
  assert.doesNotMatch(ui.workLines(card), />New</);
});

test("a card's time reads the time only today, adds the day before today, and adds the year past 365 days", () => {
  const now = new Date(2026, 10, 2, 16, 0);
  assert.match(ui.cardTime(new Date(2026, 10, 2, 14, 49).toISOString(), now), /^2:49\sPM$/);
  assert.match(ui.cardTime(new Date(2026, 10, 1, 23, 5).toISOString(), now), /^11\/1, 11:05\sPM$/);
  assert.match(ui.cardTime(new Date(2025, 10, 3, 9, 0).toISOString(), now), /^11\/3, 9:00\sAM$/);
  assert.match(ui.cardTime(new Date(2025, 9, 31, 14, 49).toISOString(), now), /^10\/31\/2025, 2:49\sPM$/);
});

test('an app install badge opens in place and uses the agreed current and stale words', () => {
  const url = 'itms-services://?action=download-manifest&url=https://m/x/manifest.plist';
  const install = { url, sha: 'abc1234', older: false };
  const html = ui.workLines({ ...workCard, install });
  assert.equal(lines(html)[2], 'repo#7 ● CI ✓ Jamie ✗ Install');
  assert.match(html, /href="itms-services:/);
  assert.doesNotMatch(ui.installButton({ ...workCard, install }), /target=/);
  assert.equal(text(ui.installChip({ ...workCard, install: { ...install, older: true } })), 'Install (stale)');
  assert.doesNotMatch(ui.workLines(workCard), /Install/);
});

test('try badges share ready, stale, running, failed and absent states for both kinds, including legacy builders', () => {
  for (const kind of ['web', 'app']) for (const render of [ui.installChip, ui.installButton]) {
    const done = kind === 'web' ? 'Visit' : 'Install';
    const going = kind === 'web' ? 'serving…' : 'building…';
    const failed = kind === 'web' ? 'serve failed' : 'build failed';
    const card = { ...workCard, try: { kind, state: 'ready', url: kind === 'web' ? null : 'https://m/app.apk', port: kind === 'web' ? 8501 : null, sha: 'abcdef1' } };
    assert.equal(text(render(card)), done);
    assert.match(render(card), /tone-ready/);
    assert.ok(render(card).includes(`href="${kind === 'web' ? 'https://mac.ts.net:8501/' : 'https://m/app.apk'}"`));
    assert.equal(/target="_blank"/.test(render(card)), kind === 'web');
    assert.equal(text(render({ ...card, try: { ...card.try, stale: true } })), `${done} (stale)`);
    assert.match(render({ ...card, try: { ...card.try, stale: true } }), /tone-quiet.*Built from abcdef1/);
    for (const busy of [{ ...card, try: { ...card.try, state: 'running' } }, { ...card, builder: { kind: 'install' } }]) {
      assert.equal(text(render(busy)), going);
      assert.match(render(busy), /role="status"/);
      assert.match(render(busy), /try-spin/);
      assert.doesNotMatch(render(busy), /href=/);
    }
    const error = render({ ...card, try: { kind, state: 'failed' } });
    assert.equal(text(error), failed);
    assert.match(error, /tone-danger.*href="#item=w%2FB5"/);
    assert.equal(render({ ...card, try: { kind } }), '');
    assert.equal(render({ ...card, lane: 'done' }), '');
  }
});

test('try buttons show only while Auto-build is off on a branch with changes, explain running and current runs, and offer Retry after failure only on scripted work cards', () => {
  for (const kind of ['web', 'app']) {
    const card = { ...workCard, kind: 'work', try: { kind, script: true, changes: true, autoBuild: false } };
    assert.equal(text(ui.tryButton(card)), kind === 'web' ? 'Serve' : 'Build');
    assert.equal(ui.tryButton({ ...card, try: { ...card.try, changes: false } }), '');
    for (const state of [undefined, 'failed', 'ready']) assert.equal(ui.tryButton({ ...card, try: { ...card.try, state, stale: true, autoBuild: true } }), '');
    for (const [change, reason] of [[{ state: 'running' }, kind === 'web' ? 'Serving now.' : 'Building now.'], [{ state: 'ready' }, 'Nothing new to']]) {
      const html = ui.tryButton({ ...card, try: { ...card.try, ...change } });
      assert.match(html, /aria-disabled="true"/);
      assert.ok(html.includes(reason));
    }
    assert.equal(text(ui.tryButton({ ...card, try: { ...card.try, state: 'failed' } })), 'Retry');
    assert.equal(text(ui.tryButton({ ...card, try: { ...card.try, state: 'ready', stale: true } })), kind === 'web' ? 'Serve' : 'Build');
    assert.equal(ui.tryButton({ ...card, kind: 'ask' }), '');
    assert.equal(ui.tryButton({ ...card, try: { ...card.try, script: false } }), '');
  }
});

test('main is a slim branch bar with a ready link, running status or failed log button', () => {
  assert.equal(ui.mainBar(null), '');
  for (const kind of ['web', 'app']) {
    const main = { kind, slug: 'owner/repo', branch: 'develop', sha: '1234567', at: ago(2), state: 'ready', url: kind === 'web' ? null : 'https://m/main.apk', port: kind === 'web' ? 8500 : null };
    assert.ok(ui.mainBar(main).includes(`href="${kind === 'web' ? 'https://mac.ts.net:8500/' : 'https://m/main.apk'}"`));
    assert.match(ui.mainBar(main), /tb-main.*owner\/repo · <strong>develop<\/strong>@<code>1234567<\/code>/);
    assert.equal(text(ui.mainBar(main)).includes(kind === 'web' ? 'Visit' : 'Install'), true);
    assert.match(ui.mainBar({ ...main, state: 'running' }), /role="status"/);
    assert.doesNotMatch(ui.mainBar({ ...main, state: 'running' }), /href=|<button/);
    assert.match(ui.mainBar({ ...main, state: 'failed' }), /<button[^>]*data-main-log=""[^>]*aria-haspopup="dialog"/);
  }
});

test("a local board's Main has a refresh icon right of its timestamp that spins while a pull runs and turns red with the reason when one fails", () => {
  const main = { kind: 'web', slug: 'owner/repo', branch: 'main', sha: '1234567', at: ago(2), state: 'ready', url: null, port: 8500 };
  assert.doesNotMatch(ui.mainBar({ ...main, pull: null }), /data-main-pull/);
  const idle = ui.mainBar({ ...main, pull: { running: false, error: null } });
  assert.match(idle, /<\/code> · [^<]+<span class="main-pull"><button class="ghost gh-refresh" type="button" data-main-pull aria-label="Pull main now"><svg/);
  assert.doesNotMatch(idle, /role="tooltip"/);
  assert.equal(text(idle).includes('Visit'), true);
  for (const html of [ui.mainBar({ ...main, pull: { running: true, error: null } }), ui.mainBar({ ...main, pull: { running: false, error: null } }, { sending: true })]) {
    assert.match(html, /class="ghost gh-refresh spinning" type="button" data-main-pull aria-label="Pulling main" aria-disabled="true"/);
    assert.equal(text(html).includes('Visit'), true);
  }
  const failed = ui.mainBar({ ...main, pull: { running: false, error: 'can’t pull: local changes' } });
  assert.match(failed, /class="ghost gh-refresh failed" type="button" data-main-pull aria-label="can’t pull: local changes"/);
  assert.match(failed, /<span class="main-pull-why" role="tooltip">can’t pull: local changes<\/span>/);
  assert.match(ui.mainBar({ ...main, pull: { running: false, error: 'x' } }, { open: true }), /class="main-pull-why open"/);
});

test('Todo offers Plan waves in the Show more style once two cards are free, with their keys', () => {
  const todo = [{ key: 'w/A1', kind: 'work' }, { key: 'w/ENG-1', kind: 'work' }, { key: 'v/B2', kind: 'work', blockedBy: [] }, { key: 'v/C3', kind: 'work', held: true }, { key: 'v/D4', kind: 'work', blockedBy: [{ ref: 'A1' }] }, { key: 'ask:n1', kind: 'ask' }];
  const html = ui.planButton(todo);
  assert.match(html, /^<button type="button" class="thread-more" data-plan="w\/A1 w\/ENG-1 v\/B2">/);
  assert.equal(text(html), 'Plan waves');
  assert.equal(ui.planButton(todo.slice(0, 1)), '');
  assert.equal(ui.planButton([todo[0], todo[3], todo[4], todo[5]]), '');
});

test("a card's ETA line gives the time, with the day when not today", () => {
  const now = new Date(2026, 9, 23, 9, 0);
  assert.equal(ui.etaLine(new Date(2026, 9, 23, 16, 30).toISOString(), now), 'ETA about 4:30 pm');
  assert.match(ui.etaLine(new Date(2026, 9, 24, 9, 5).toISOString(), now), /^ETA about Oct 24, 9:05 am$/);
  const busy = { ...workCard, builder: { progress: 'Running benchmarks', at: null }, eta: new Date(Date.now() + 3600000).toISOString() };
  assert.match(lines(ui.workLines(busy))[1], /^Running benchmarks$/);
  assert.match(lines(ui.workLines(busy))[2], /^ETA about /);
  assert.equal(lines(ui.workLines({ ...busy, builder: null })).some((l) => l.startsWith('ETA')), false);
});

test('a thread counts as unread only the messages from others since this browser last opened it', () => {
  const at = ['2026-10-23T09:00:00Z', '2026-10-23T10:00:00Z', '2026-10-23T11:00:00Z'];
  assert.equal(ui.unreadCount(at, null), 0);
  assert.equal(ui.unreadCount(at, '2026-10-23T09:30:00Z'), 2);
  assert.equal(ui.unreadCount(at, '2026-10-23T11:00:00Z'), 0);
});

test('a pending message offers bump, edit and delete in that order, a thread message edit and delete, and an edited one says so', () => {
  const order = (html) => [...html.matchAll(/data-(bump|edit|withdraw)="/g)].map((m) => m[1]);
  const ask = { kind: 'ask', id: 'a1', key: 'ask:a1', ask: { state: 'waiting', canEdit: true } };
  assert.deepEqual(order(ui.askActions(ask, false)), ['bump', 'edit', 'withdraw']);
  const html = ui.threadMessages([{ ts: ago(1), who: 'love', via: 'site', kind: 'item-message', text: 'Fix it well', edited: true, eventId: 'e1', reply: null, state: 'waiting', canDelete: true, canEdit: true }]);
  assert.deepEqual(order(html), ['edit', 'withdraw']);
  assert.match(text(html), /^You · Edited · .* Fix it well Waiting for Claude…$/);
  const moved = ui.threadMessages([{ ts: ago(1), who: 'love', via: 'ask', kind: 'ask', text: 'Swipe the gallery', moved: true, eventId: 'a1', reply: null, state: 'answered' }]);
  assert.match(text(moved), /^You · Moved · .* Swipe the gallery$/);
});

test('a builder status line, and an agent starting or finishing, reads as one line with its time and no author or actions, a running agent with its ETA', () => {
  const html = ui.threadMessages([{ ts: ago(1), who: 'claude', kind: 'status', text: 'Codex: <b>Running</b> tests' }]);
  assert.match(html, /class="msg builder-status">/);
  assert.match(text(html), /^Codex: <b>Running<\/b> tests · \S/);
  assert.doesNotMatch(html, /class="who"|data-withdraw|data-edit/);
  const agents = ui.threadMessages([
    { ts: ago(1), who: 'claude', kind: 'agent', text: 'Codex started', finished: false, eta: new Date(Date.now() + 3600000).toISOString() },
    { ts: ago(0.8), who: 'claude', kind: 'agent', text: 'Opus builder started', finished: false, eta: null },
    { ts: ago(0.5), who: 'claude', kind: 'agent', text: 'Opus builder <b>finished</b>', finished: true, eta: null },
  ]);
  assert.match(agents, /^<div class="msg agent started"><span class="agent-dot" aria-hidden="true"><\/span>Codex started/);
  assert.match(agents, /<div class="msg agent started"><span class="agent-dot" aria-hidden="true"><\/span>Opus builder started/);
  assert.match(agents, /<div class="msg agent finished"><span class="agent-dot" aria-hidden="true"><\/span>Opus builder &lt;b&gt;finished/);
  assert.match(text(agents), /^Codex started · \S.* · ETA about .+ Opus builder started · [^·]+ Opus builder <b>finished<\/b> · [^·]+$/);
  assert.doesNotMatch(agents, /class="who"|data-withdraw|data-edit/);
  const planner = ui.threadMessages([
    { ts: ago(1), who: 'claude', kind: 'agent', text: 'Claude Sonnet prototype started', finished: false, eta: null, planner: true },
    { ts: ago(0.8), who: 'claude', kind: 'status', text: 'Reading: the notes', planner: true },
  ]);
  assert.match(planner, /<div class="msg agent started planner"><span class="agent-dot" aria-hidden="true"><\/span>Claude Sonnet prototype started/);
  assert.match(planner, /<div class="msg builder-status planner"><span class="working-dot" aria-hidden="true"><\/span>Reading: the notes/);
  // A Grill or Prototype tap, and a Quick build ask's note, are a muted request entry, not a message from the owner.
  const requests = ui.threadMessages([
    { ts: ago(2), who: 'love', via: 'site', kind: 'grill-more', request: true, text: 'grill requested', eventId: 'g1', state: 'waiting', files: [] },
    { ts: ago(1), who: 'love', via: 'site', kind: 'prototype-request', request: true, text: 'prototype requested', eventId: 'p1', state: 'waiting', files: [] },
  ]);
  assert.match(requests, /^<div class="msg request">grill requested <span class="muted">· [^<]+<\/span><\/div><div class="msg request">prototype requested <span class="muted">/);
  assert.doesNotMatch(requests, /class="who"|Waiting for Claude|data-event/);
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.msg\.request \{[^}]*color: var\(--muted\)/);
});

test("a builder's judgment calls show collapsed under its lines, saying whether the session verified them, and count as no message", () => {
  const open = { ts: ago(1), who: 'claude', kind: 'calls', text: 'Claude Opus builder', calls: ['Kept <the> old name', 'Question: every agent?'], verified: null };
  const html = ui.threadMessages([open]);
  assert.match(html, /^<details class="msg calls"><summary>/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.match(text(html), /^Claude Opus builder's judgment calls · 2 · not verified yet Kept <the> old name Question: every agent\?$/);
  const checked = text(ui.threadMessages([{ ...open, verified: { at: ago(0.5), note: 'Match the notes.' } }]));
  assert.match(checked, /· 2 · verified .+ Kept <the> old name Question: every agent\? Verified: Match the notes\.$/);
  const msgs = [{ ts: ago(3), who: 'claude', text: 'One' }, { ts: ago(2), who: 'claude', text: 'Two' }, { ts: ago(1.5), who: 'claude', text: 'Three' }, open];
  assert.doesNotMatch(ui.threadMessages(msgs, {}, new Map(), { seenAt: ago(9), more: 0 }), /thread-more/);
});

test("an open card's thread shows its newest 3 messages with the lines between them, from its oldest unread one when more are unread, a message being edited always, and Show more saying how many messages it hides", () => {
  const at = (n) => `2020-01-01T10:${String(n).padStart(2, '0')}:00.000Z`;
  const msgs = [
    { ts: at(0), who: 'claude', text: 'One' },
    { ts: at(1), who: 'claude', kind: 'status', text: 'Plan written' },
    { ts: at(2), who: 'love', kind: 'item-message', text: 'Two?', eventId: 'e1', state: 'replied', reply: { html: 'Two.', at: at(3) } },
    { ts: at(4), who: 'claude', kind: 'agent', text: 'Opus builder started', finished: false, eta: null },
    { ts: at(5), who: 'Sam', via: 'slack', text: 'Three' },
    { ts: at(6), who: 'claude', text: 'Four' },
    { ts: at(7), who: 'claude', kind: 'status', text: 'Opened #1' },
    { ts: at(8), who: 'claude', text: 'Five' },
    { ts: at(9), who: 'claude', kind: 'agent', text: 'Opus builder finished', finished: true, eta: null },
    { ts: at(10), who: 'claude', text: 'Six' },
    { ts: at(11), who: 'claude', kind: 'status', text: 'CI green' },
  ];
  const WORDS = ['One', 'Plan written', 'Two.', 'Two?', 'Opus builder started', 'Three', 'Four', 'Opened #1', 'Five', 'Opus builder finished', 'Six', 'CI green'];
  const shown = (html) => html.split(/(?=<div class="msg )/).filter((h) => h.startsWith('<div class="msg ')).map((h) => WORDS.find((w) => h.includes(`>${w}`)));
  const more = (html) => (/^<button type="button" class="thread-more" data-thread-more>/.test(html) ? text(html.slice(0, html.indexOf('</button>'))) : null);
  const read = { seenAt: at(59), more: 0 };

  const newest = ui.threadMessages(msgs, {}, new Map(), read);
  assert.deepEqual(shown(newest), ['Four', 'Opened #1', 'Five', 'Opus builder finished', 'Six', 'CI green']);
  assert.equal(more(newest), 'Show more · 4 previous messages');
  const once = ui.threadMessages(msgs, {}, new Map(), { ...read, more: 1 });
  assert.deepEqual(shown(once), ['Two?', 'Two.', 'Opus builder started', 'Three', 'Four', 'Opened #1', 'Five', 'Opus builder finished', 'Six', 'CI green']);
  const all = ui.threadMessages(msgs, {}, new Map(), { ...read, more: 2 });
  assert.deepEqual([more(once), more(all), shown(all).length], ['Show more · 1 previous message', null, 12]);

  const unread = ui.threadMessages(msgs, {}, new Map(), { seenAt: at(2), more: 0 });
  assert.deepEqual(shown(unread), ['Two.', 'Opus builder started', 'Three', 'Four', 'Opened #1', 'Five', 'Opus builder finished', 'Six', 'CI green']);
  assert.match(unread, /<blockquote class="quote">Two\?<\/blockquote>/);
  assert.equal(more(unread), 'Show more · 2 previous messages');

  const slack = ui.threadMessages(msgs, {}, new Map(), { seenAt: at(4), more: 0 });
  assert.deepEqual(shown(slack), ['Four', 'Opened #1', 'Five', 'Opus builder finished', 'Six', 'CI green']);

  const waiting = ui.threadMessages(msgs.map((m) => (m.eventId ? { ...m, state: 'waiting', reply: null } : m)), {}, new Map(), read);
  assert.deepEqual(shown(waiting), shown(newest));
  assert.equal(more(waiting), 'Show more · 3 previous messages');
  const editing = ui.threadMessages(msgs, {}, new Map([['e1', { text: 'Two, edited' }]]), read);
  assert.deepEqual(shown(editing).slice(0, 2), ['Two?', 'Two.']);
});

test("only Claude's and GitHub's messages are unread: the owner's answers after an unread reply fold under Show more past 10 lines, and a batch of answers waits on Claude once, under its last answer", () => {
  const at = (n) => `2020-01-01T10:${String(n).padStart(2, '0')}:00.000Z`;
  const answer = (n) => ({ ts: at(n), who: 'love', via: 'questions', kind: 'owner-answer', text: `Q${n}?\n→ A${n}`, eventId: `o${n}`, reply: null, state: 'waiting' });
  const grill = { ts: at(0), who: 'love', via: 'site', kind: 'grill-more', text: 'Grill', eventId: 'g1', state: 'replied', reply: { html: 'Questions up.', at: at(1) } };
  const answers = Array.from({ length: 12 }, (_, i) => answer(10 + i));
  const bodies = (html) => [...html.matchAll(/<div class="body">([^<]*)/g)].map((m) => m[1].replace(/\n.*/, ''));
  const waits = (html) => html.split(/(?=<div class="msg )/).filter((h) => h.includes('Waiting for Claude')).map((h) => /Q\d+/.exec(h)[0]);

  const read = ui.threadMessages([grill, ...answers], {}, new Map(), { seenAt: at(59), more: 0 });
  assert.deepEqual(bodies(read), ['Q19?', 'Q20?', 'Q21?']);
  assert.deepEqual(waits(read), ['Q21']);
  const unread = ui.threadMessages([grill, ...answers], {}, new Map(), { seenAt: at(0), more: 0 });
  assert.deepEqual(bodies(unread), answers.slice(2).map((a) => a.text.replace(/\n.*/, '')));
  assert.deepEqual(waits(unread), ['Q21']);
  const all = ui.threadMessages([grill, ...answers], {}, new Map(), null);
  assert.deepEqual(waits(all), ['Q21']);

  const split = ui.threadMessages([answer(10), answer(11), { ts: at(12), who: 'claude', text: 'On it' }, answer(13), { ts: at(14), who: 'claude', kind: 'status', text: 'Testing' }, answer(15)], {}, new Map(), null);
  assert.deepEqual(waits(split), ['Q11', 'Q15']);
  const acted = ui.threadMessages([answer(10), { ...answer(11), state: 'answered' }], {}, new Map(), null);
  assert.deepEqual(waits(acted), ['Q10']);
});

test('a thread line with a log field links to open the log', () => {
  const html = ui.threadMessages([{ ts: ago(1), who: 'claude', text: 'Builder launched headless on Claude Sonnet in /wt/A1.', log: 'builder-A1-2026.log' }]);
  assert.match(html, /<a href="log\.html\?file=builder-A1-2026\.log">Open the log →<\/a>/);
  assert.doesNotMatch(html, /its log is/);
});

test("an ask's link line opens the work it became, and a thread line opens a linked card on the board", () => {
  assert.match(ui.threadMessages([{ ts: ago(1), who: 'claude', kind: 'ask-link', text: 'Became INT-21', link: '#item=site%2FS21' }]), /<a href="#item=site%2FS21">Became INT-21 →<\/a>/);
  const html = ui.threadMessages([{ ts: ago(1), who: 'claude', text: 'Asked to keep it', link: '#item=ask:e1' }]);
  assert.match(html, /<a href="#item=ask:e1">Open the task →<\/a>/);
  assert.doesNotMatch(html, /target="_blank"/);
  const moved = ui.threadMessages([{ ts: ago(1), who: 'claude', text: 'Moved to Audit.', link: '/audit/#item=ask%3Ab1' }]);
  assert.match(moved, /<a href="\/audit\/#item=ask%3Ab1">Open the task →<\/a>/);
  const arrived = ui.threadMessages([{ ts: ago(1), who: 'love', via: 'ask', kind: 'ask', text: 'Fix the header', from: 'Orch', eventId: 'b1', reply: null, state: 'waiting' }]);
  assert.match(text(arrived), /^You · Moved from Orch · .* Fix the header Waiting for Claude…$/);
});

test("a thread's links to this hub's pages open in place, and only other origins open a new window", () => {
  context.location = { origin: 'https://mac.tail.ts.net', href: 'https://mac.tail.ts.net/orch/' };
  try {
    const html = ui.threadMessages([
      { ts: ago(2), who: 'claude', text: 'Prototypes: https://mac.tail.ts.net/orch/prototype-x.html?q=q1 and https://elsewhere.example/x', link: 'prototype-x.html?q=q1' },
      { ts: ago(1), who: 'claude', text: 'Mirror', link: 'https://mac.tail.ts.net/orch/prototype-y.html' },
      { ts: ago(1), who: 'claude', text: 'Elsewhere', link: 'https://elsewhere.example/y' },
    ]);
    assert.deepEqual(anchors(html), [
      ['https://mac.tail.ts.net/orch/prototype-x.html?q=q1', 'https://mac.tail.ts.net/orch/prototype-x.html?q=q1', false],
      ['https://elsewhere.example/x', 'https://elsewhere.example/x', true],
      ['prototype-x.html?q=q1', 'prototype-x.html?q=q1', false],
      ['https://mac.tail.ts.net/orch/prototype-y.html', 'https://mac.tail.ts.net/orch/prototype-y.html', false],
      ['https://elsewhere.example/y', 'https://elsewhere.example/y', true],
    ]);
  } finally { context.location = { hostname: 'mac.ts.net', host: 'mac.ts.net:443' }; }
});

test('a plan renders headings, lists, emphasis, code and links, escapes raw HTML, and wraps each table in its own scroll box', () => {
  const html = ui.markdown([
    '# Plan <b>x</b>', '', 'Some **bold** and `a <tag>` with [a link](https://x.test/a?b=1&c=2) and [bad](javascript:alert(1)).', 'Same paragraph.',
    '', '- one', '  - two', '- three', '', '1. first', '2. second', '',
    '| id | Scope |', '|---|---|', `| I1 | ${'long '.repeat(20)}|`, '| I2 | a \\| b |', '', '```', '<script>', '```',
  ].join('\n'));
  assert.match(html, /<h1>Plan &lt;b&gt;x&lt;\/b&gt;<\/h1>/);
  assert.match(html, /<p>Some <strong>bold<\/strong> and <code>a &lt;tag&gt;<\/code> with <a href="https:\/\/x.test\/a\?b=1&amp;c=2" target="_blank" rel="noopener">a link<\/a> and \[bad\]\(javascript:alert\(1\)\)\. Same paragraph\.<\/p>/);
  assert.match(html, /<ul><li>one<\/li><li class="nested">two<\/li><li>three<\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<div class="md-table"><table><thead><tr><th>id<\/th><th>Scope<\/th><\/tr><\/thead><tbody><tr><td>I1<\/td><td class="wide">/);
  assert.match(html, /<td>a \| b<\/td>/);
  assert.match(html, /<pre><code>&lt;script&gt;<\/code><\/pre>/);
  assert.doesNotMatch(html, /<script|<b>/);
});

const shown = (html) => html.replace(/<[^>]+>/g, '').replace(/&(amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e]);
const anchors = (html) => [...html.matchAll(/<a href="([^"]*)"([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => [m[1], text(m[3]), /target="_blank" rel="noopener"/.test(m[2])]);
const boardItems = [
  { key: 'site/S54', wave: 'site', kind: 'work', ref: 'INT-54', internal: true, linear: [], repo: null },
  { key: 'site/INT-56', wave: 'site', kind: 'work', ref: 'INT-56', internal: true, linear: [{ id: 'INT-56' }], repo: null },
  { key: 'att/A1', wave: 'att', kind: 'work', ref: 'A1', internal: false, linear: [{ id: 'ENG-2310', url: 'https://linear.app/acme/issue/ENG-2310' }], repo: 'acme/app' },
  { key: 'att/A2', wave: 'att', kind: 'work', ref: 'A2', internal: false, linear: [], repo: 'acme/app' },
  { key: 'att/ENG-2467', wave: 'att', kind: 'work', ref: 'ENG-2467', internal: false, linear: [{ id: 'ENG-2467', url: 'https://linear.app/acme/issue/ENG-2467' }], repo: 'acme/app' },
  { key: 'elig/A1', wave: 'elig', kind: 'work', ref: 'A1', internal: false, linear: [{ id: 'OPS-7', url: 'https://linear.app/acme/issue/OPS-7' }], repo: 'o/r' },
  { key: 'ask:e9', wave: null, kind: 'ask', ref: 'Ask', internal: false, linear: [], repo: null },
];
const refLine = 'INT-54 shipped, INT-99 did not. ENG-2310, OPS-7 and ENG-2467 next, then A1. See acme/app#3116, app#3050, foo#4 and #2988, not #ffffff, #000000 or UTF-8. https://github.com/o/r/pull/1#issuecomment-2 and (https://x.test/a_(b)).';

test('a thread line links each ref the board knows to its card, Linear ids and PRs to their pages, and bare URLs, leaving the text as written', () => {
  const html = ui.threadMessages([{ ts: ago(1), who: 'claude', text: refLine }], ui.linkContext(boardItems, 'att/A1'));
  assert.deepEqual(anchors(html), [
    ['#item=site%2FS54', 'INT-54', false],
    ['https://linear.app/acme/issue/ENG-2310', 'ENG-2310', true],
    ['https://linear.app/acme/issue/OPS-7', 'OPS-7', true],
    ['#item=att%2FENG-2467', 'ENG-2467', false],
    ['#item=att%2FA1', 'A1', false],
    ['https://github.com/acme/app/pull/3116', 'acme/app#3116', true],
    ['https://github.com/acme/app/pull/3050', 'app#3050', true],
    ['https://github.com/acme/app/pull/2988', '#2988', true],
    ['https://github.com/o/r/pull/1#issuecomment-2', 'https://github.com/o/r/pull/1#issuecomment-2', true],
    ['https://x.test/a_(b)', 'https://x.test/a_(b)', true],
  ]);
  assert.ok(shown(html).includes(refLine));
});

test("a Linear id links in its board's own workspace, and a board without a workspace shows it unlinked", () => {
  const line = [{ ts: ago(1), who: 'claude', text: 'ENG-2310 and ENG-12 next' }];
  const items = (url) => [{ key: 'w/A1', wave: 'w', kind: 'work', ref: 'A1', internal: false, linear: [{ id: 'ENG-2310', url }], repo: null }];
  assert.deepEqual(anchors(ui.threadMessages(line, ui.linkContext(items('https://linear.app/other-co/issue/ENG-2310'), 'w/A1'))), [
    ['https://linear.app/other-co/issue/ENG-2310', 'ENG-2310', true], ['https://linear.app/other-co/issue/ENG-12', 'ENG-12', true],
  ]);
  const bare = ui.threadMessages(line, ui.linkContext(items(null), 'w/A1'));
  assert.deepEqual(anchors(bare), []);
  assert.ok(shown(bare).includes('ENG-2310 and ENG-12 next'));
  assert.match(ui.linearChips({ linear: [{ id: 'ENG-2310', url: null }] }), /^<span class="chip tone-quiet"[^>]*>ENG-2310<\/span>$/);
});

test("a bare #n opens the card it is the ticket of from any thread, else links only in a thread whose item has a repo, and a wave's short id links only from that wave's cards", () => {
  const line = [{ ts: ago(1), who: 'claude', text: 'A1 and A2 wait on #2988' }];
  assert.deepEqual(anchors(ui.threadMessages(line, ui.linkContext(boardItems, 'elig/A1'))), [
    ['#item=elig%2FA1', 'A1', false], ['https://github.com/o/r/pull/2988', '#2988', true],
  ]);
  assert.deepEqual(anchors(ui.threadMessages(line, ui.linkContext(boardItems, 'site/S54'))), []);
  assert.deepEqual(anchors(ui.threadMessages(line, ui.linkContext(boardItems, 'ask:e9'))), []);
  const hub = [...boardItems, { key: 'hub/INT-269', wave: 'hub', kind: 'work', id: 'INT-269', ref: '#27', internal: true, linear: [], repo: null }];
  const ticketed = [{ ts: ago(1), who: 'claude', text: '#27 was INT-269; #2988 is a PR' }];
  for (const key of ['ask:e9', 'elig/A1']) {
    assert.deepEqual(anchors(ui.threadMessages(ticketed, ui.linkContext(hub, key))).slice(0, 2), [['#item=hub%2FINT-269', '#27', false], ['#item=hub%2FINT-269', 'INT-269', false]]);
  }
  assert.deepEqual(anchors(ui.threadMessages(ticketed, ui.linkContext(hub, 'elig/A1'))).at(-1), ['https://github.com/o/r/pull/2988', '#2988', true]);
});

test('a linked thread line still shows markup in its text as text', () => {
  const html = ui.threadMessages([{ ts: ago(1), who: 'love', text: '<b>INT-54</b> <img src=x>' }], ui.linkContext(boardItems, 'site/S54'));
  assert.doesNotMatch(html, /<b>|<img/);
  assert.deepEqual(anchors(html), [['#item=site%2FS54', 'INT-54', false]]);
  assert.ok(shown(html).includes('<b>INT-54</b> <img src=x>'));
});

test('a reply is Claude’s own message at its time, quoting the owner’s message only when others came between', () => {
  const msgs = [
    { ts: '2026-10-23T10:00:00Z', who: 'love', text: 'Why red?', eventId: 'e1', state: 'replied', reply: { html: '<p>Offline.</p>', at: '2026-10-23T10:20:00Z' } },
    { ts: '2026-10-23T10:10:00Z', who: 'claude', text: 'Reading app.js' },
    { ts: '2026-10-23T10:30:00Z', who: 'love', text: 'And blue?', eventId: 'e2', state: 'replied', reply: { html: '<p>Links.</p>', at: '2026-10-23T10:31:00Z' } },
  ];
  assert.deepEqual(ui.withReplies(msgs).map((m) => [m.who, m.kind || '', m.quote ?? null]), [
    ['love', '', null], ['claude', '', null], ['claude', 'reply', 'Why red?'], ['love', '', null], ['claude', 'reply', ''],
  ]);
  const html = ui.threadMessages(msgs);
  assert.equal((html.match(/class="msg claude reply-msg"/g) || []).length, 2);
  assert.match(html, /<blockquote class="quote">Why red\?<\/blockquote><div class="body"><p>Offline\.<\/p>/);
  assert.doesNotMatch(html, /quote">And blue/);
  assert.doesNotMatch(html, /class="reply">/);
});

test('an HTML line and a reply link refs in their text but leave existing links and preformatted text alone', () => {
  const links = ui.linkContext(boardItems, 'site/S54');
  const html = ui.threadMessages([
    { ts: ago(2), who: 'claude', html: '<p>See <a href="https://x.test/">INT-54 notes</a> &amp; INT-54 at https://x.test/b?c=1&amp;d=2 &rarr; done</p><pre>INT-54</pre>' },
    { ts: ago(1), who: 'love', text: 'Is INT-56 filed?', eventId: 'e1', reply: { html: '<p>Yes, INT-56 &mdash; see ENG-2310.</p>' }, state: 'replied' },
  ], links);
  assert.deepEqual(anchors(html), [
    ['https://x.test/', 'INT-54 notes', false],
    ['#item=site%2FS54', 'INT-54', false],
    ['https://x.test/b?c=1&amp;d=2', 'https://x.test/b?c=1&d=2', true],
    ['#item=site%2FINT-56', 'INT-56', false],
    ['#item=site%2FINT-56', 'INT-56', false],
    ['https://linear.app/acme/issue/ENG-2310', 'ENG-2310', true],
  ]);
  assert.match(html, /&rarr; done<\/p><pre>INT-54<\/pre>/);
  assert.match(html, /INT-56<\/a> &mdash; see/);
});

test('a question card and a full plan link refs too, to the board page from another page', () => {
  const onPage = ui.linkContext(boardItems, 'site/S54', { base: './' });
  const q = { ...question, question: 'Keep INT-54?', context: 'See ENG-2310', state: 'replied', answers: [{ ts: ago(1), choice: 'A', note: 'Like INT-56', reply: { html: '<p>Done in INT-54</p>' } }] };
  assert.deepEqual(anchors(ui.questionCard(q, { links: onPage })), [
    ['./#item=site%2FS54', 'INT-54', false],
    ['https://linear.app/acme/issue/ENG-2310', 'ENG-2310', true],
    ['./#item=site%2FINT-56', 'INT-56', false],
    ['./#item=site%2FS54', 'INT-54', false],
  ]);
  assert.deepEqual(anchors(ui.markdown('Builds on INT-54, see [notes](https://x.test/n).\n\n```\nINT-54\n```', onPage)), [
    ['./#item=site%2FS54', 'INT-54', false], ['https://x.test/n', 'notes', true],
  ]);
});

test('the rules editor stages edits until Save, sends the list with the ids it loaded, tags Claude\'s rules, and takes colours only from colors.css', () => {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(new URL('./public/rules-editor.js', import.meta.url), 'utf8'), ctx);
  const ed = ctx.RulesEditor;
  const list = ed.rows([{ id: 'r1', text: 'Ask first', by: 'claude', at: 'x' }, { id: 'r2', text: 'Screenshots <b>', by: 'owner', at: 'x' }]);
  assert.equal(ed.dirty(list), false);
  assert.match(ed.render(list), /Added by Claude/);
  assert.equal(text(ed.render(list)).match(/Added by Claude/g).length, 1);
  assert.match(ed.render(list), /Screenshots &lt;b&gt;/);
  assert.doesNotMatch(ed.render(list, { readOnly: true }), /<button/);
  assert.match(ed.render([], { empty: 'None.' }), /None\./);

  list[0].text = 'Ask before main';
  list[1].gone = true;
  list.push({ key: 'new-1', id: null, text: 'New', by: 'owner', orig: null, gone: false });
  assert.equal(ed.dirty(list), true);
  const html = ed.render(list, { buttons: { primary: 'btn', quiet: 'btn quiet', icon: 'ghost' } });
  assert.match(html, /class="rule edited"/);
  assert.match(html, /class="rule gone"[\s\S]*data-act="undo"/);
  assert.match(html, /class="rule new"/);
  assert.match(html, /class="ghost" data-act="remove"/);
  assert.match(ed.render(list, { editing: 'r1' }), /<textarea class="rule-input"[^>]*>Ask before main<\/textarea>/);
  assert.deepEqual(plain(ed.payload(list)), { rules: [{ id: 'r1', text: 'Ask before main' }, { text: 'New' }], base: ['r1', 'r2'] });

  const shared = definedIn(colorsCss);
  assert.deepEqual([...usedIn(ed.CSS)].filter((v) => !shared.has(v)), []);
  assert.doesNotMatch(ed.CSS, /#[0-9a-f]{3,6}\b|rgb/i);
});

test('the GitHub mark opens the Hub links sheet, with a red dot while a link is broken, and a new board shows its setup checklist', () => {
  const checks = { at: ago(4 / 60), every: 30, late: false, watcher: 'running' };
  const links = [{ link: 'github', ok: true, detail: '1 open PR, all in the last check.' }, { link: 'events', ok: false, detail: 'No watcher is running <now>.' }];
  assert.match(ui.githubLine(checks), /<button class="ghost gh-links" type="button" data-hub-links [^>]*aria-label="Hub links"/);
  assert.doesNotMatch(ui.githubLine(checks, { links: [links[0]] }), /links-dot/);
  const broken = ui.githubLine(checks, { links });
  assert.match(broken, /aria-label="Hub links: 1 not working"[^>]*><svg class="gh-mark"[^]*<span class="links-dot"/);
  assert.equal(text(broken), 'GitHub 4 min');
  const list = ui.linksList(links);
  assert.equal(text(list), 'GitHub polling 1 open PR, all in the last check. Events No watcher is running <now>.');
  assert.match(list, /<span class="dot pass" role="img" aria-label="Working">[^]*<span class="dot fail" role="img" aria-label="Not working">/);
  assert.match(ui.linksList(null), /doesn't list this board/);
  const settling = [links[0], { ...links[1], state: 'settling' }];
  assert.doesNotMatch(ui.githubLine(checks, { links: settling }), /links-dot/);
  assert.match(ui.linksList(settling), /<span class="dot" role="img" aria-label="Settling">[^]*Settling: No watcher/);
  assert.match(ui.githubLine(checks, { links: [links[0], { ...links[1], state: 'broken' }] }), /links-dot/);
  assert.equal(ui.setupCard(null), '');
  const setup = ui.setupCard({ events: false, github: true });
  assert.equal(text(setup), 'Connecting this board Waiting for Claude to answer the hello GitHub checks reach this board');
  assert.equal(text(ui.setupCard({ events: false })), 'Connecting this board Waiting for Claude to answer the hello');
  const remote = ui.remoteLine({ host: 'gitlab.com', name: 'gitlab.com/acme/firmware' }, { links });
  assert.match(remote, /data-hub-links[^>]*aria-label="Hub links: 1 not working"/);
  assert.doesNotMatch(remote, /GitHub|data-check-github/);
  assert.equal(text(remote), 'gitlab.com/acme/firmware');
});

test('usage stays within the Hub link and its card shows both windows, reset, stale and missing readings', () => {
  const at = new Date().toISOString();
  const resets_at = new Date(Date.now() + 3600_000).toISOString();
  const live = (used_percentage) => ({ used_percentage, resets_at, state: 'live' });
  const usage = { claude: { at, five_hour: live(75), seven_day: live(90) }, codex: { at, five_hour: live(42), seven_day: null } };
  const html = ui.sidebar({ usage }, { here: '_hub/' });
  const hub = /<a class="sb-row on sb-hub-usage"[^>]*>([^]*?)<\/a>/.exec(html)[1];
  assert.equal((hub.match(/class="u-bar"/g) || []).length, 2);
  assert.match(text(hub), /Hub Claude 75% · resets .* Codex 42% · resets/);
  assert.doesNotMatch(hub, /<a|<button|popover|dialog/);
  const card = context.HubUI.usageCard(usage);
  assert.match(text(card), /^Usage Claude read .*5-hour 75% · resets .*Week 90% · resets .*Codex read .*No reading/);
  assert.match(card, /u-tone-high/);
  assert.match(card, /u-tone-full/);
  assert.doesNotMatch(card, /Raw readings|<button|<details/);
  usage.claude.five_hour = { ...live(0), state: 'reset' };
  assert.match(text(ui.sidebar({ usage })), /Claude · reset /);
  assert.match(text(context.HubUI.usageCard(usage)), /5-hour Reset /);
  usage.claude.five_hour = { ...live(95), state: 'stale' };
  const stale = ui.sidebar({ usage });
  assert.match(text(stale), /Claude · last seen/);
  assert.match(stale, /u-tone-stale/);
  assert.doesNotMatch(stale, /95%/);
  assert.match(text(context.HubUI.usageCard(usage)), /95% at/);
  usage.claude = null;
  assert.doesNotMatch(ui.sidebar({ usage }), /u-name">Claude/);
  assert.doesNotMatch(context.HubUI.usageCard(usage), /title">Claude/);
  assert.equal(context.HubUI.usageCard({ claude: null, codex: null }), '');
  assert.deepEqual([74, 75, 89, 90].map((n) => ui.usageTone(live(n))), ['ok', 'high', 'high', 'full']);
});

test('the pause line stepper, both tools’ ticks, banners and status slots follow the gate', () => {
  const resets_at = new Date(Date.now() + 3600_000).toISOString();
  const until = ui.usageClock(resets_at);
  const reading = { at: new Date().toISOString(), five_hour: { used_percentage: 91, resets_at, state: 'live' }, seven_day: null };
  const pause = { pause_at: 90, state: 'paused', window: 'five_hour', used: 91, resets_at };
  const hub = context.HubUI;
  const card = hub.usageCard({ claude: reading, codex: reading }, null, pause);
  assert.match(text(card), /Codex .*Pause work at 10% buffer − 90% \+/);
  assert.match(text(card), /Claude’s new work waits.*Codex hands its work to Claude implementers/);
  for (const builder of ['Opus', 'Sonnet']) assert.match(text(hub.usageCard({ claude: reading }, null, pause, { model: builder.toLowerCase(), builder, choices: [], description: '' })), new RegExp(`Codex hands its work to ${builder} implementers`));
  assert.equal([...card.matchAll(/class="ub-mark" style="left:90%"/g)].length, 4);
  assert.match(card, /form class="segments ub-step" method="post" action="\/_hub\/settings\/pause-at"/);
  assert.match(card, /value="85" aria-label="Pause 5% sooner"/);
  assert.match(card, /value="95" aria-label="Pause 5% later"/);
  const low = hub.usageCard({ claude: reading }, null, { ...pause, pause_at: 50 });
  assert.match(low, /Pause 5% sooner" disabled/);
  const off = hub.usageCard({ claude: reading }, null, { ...pause, pause_at: 100 });
  assert.match(text(off), /No buffer − Off \+ Off: work keeps going until usage runs out/);
  assert.match(off, /Pause 5% later" disabled/);
  assert.doesNotMatch(off, /class="ub-mark"/);
  const banner = hub.pauseBanner(pause);
  assert.match(text(banner), /Work paused: Claude’s 5‑hour usage is at 91%. Resumes at/);
  assert.match(banner, /action="\/_hub\/settings\/keep-going"/);
  assert.match(banner, /name="value" value="on">Keep going/);
  const weekly = hub.pauseBanner({ ...pause, window: 'seven_day' });
  assert.match(text(weekly), /weekly usage is at 91%. Resumes /);
  assert.doesNotMatch(text(weekly), /Resumes at/);
  const going = hub.pauseBanner({ ...pause, state: 'going' });
  assert.match(going, /hold-banner ub-banner ub-going/);
  assert.match(text(going), /Past the buffer: spending usage until .* Stop/);
  assert.match(going, /name="value" value="off"/);
  assert.equal(hub.pauseBanner({ state: 'normal' }), '');
  const sites = [{ route: 'a', title: 'A', board: true, icon: '', sub: '<span class="dot t-working" aria-hidden="true"></span><span class="word t-working">working</span><span class="lcs"><span class="lc">3 todo</span></span>' }];
  const sidebar = ui.sidebar({ pause, sites, hub: { tone: 'ok', word: 'healthy', detail: 'up' } });
  assert.equal([...sidebar.matchAll(/class="word t-wait">paused/g)].length, 2);
  assert.ok(text(sidebar).includes(`until ${until}`));
  assert.match(text(sidebar), /paused 3 todo/);
  assert.doesNotMatch(sidebar, />working</);
  assert.equal(ui.statusLine(null, { pause }), `<span class="late">paused until ${until}</span>`);
  assert.doesNotMatch(ui.statusLine(null, { pause: { ...pause, state: 'going' } }), /paused/i);
});

test('the New version row offers the npm update, waits with its pill spinning while the update waits for builders or runs, and gives Reload priority', () => {
  const row = (update, upgrade) => ui.updateRow(update, upgrade);
  assert.equal(row(null, null), '');
  const available = row(null, { state: 'available', version: '0.4.0' });
  assert.match(available, /<button type="button" class="sb-row sb-update-row" data-app-upgrade>/);
  assert.equal(text(available), 'Update available Upgrade');
  const waiting = row(null, { state: 'waiting', version: '0.4.0', builders: 2 });
  assert.match(waiting, /data-app-upgrade disabled aria-busy="true"/);
  assert.equal(text(waiting), 'Update waits for 2 implementers Upgrade');
  assert.equal(text(row(null, { state: 'waiting', version: '0.4.0', builders: 1 })), 'Update waits for 1 implementer Upgrade');
  const updating = row(null, { state: 'updating', version: '0.4.0' });
  assert.match(updating, /data-app-upgrade disabled aria-busy="true"/);
  assert.equal(text(updating), 'Update available Upgrade');
  const failed = row(null, { state: 'failed', version: '0.4.0', error: 'npm <update> failed' });
  assert.doesNotMatch(failed, /disabled/);
  assert.equal(text(failed), 'Update failed npm <update> failed Upgrade');
  assert.equal(text(row('ready', { state: 'available', version: '0.4.0' })), 'New version Reload');
  const reloading = row('reloading', null);
  assert.match(reloading, /data-app-reload disabled aria-busy="true"/);
  assert.equal(text(reloading), 'New version Reload');
  const html = ui.sidebar({ sites: [], upgrade: { state: 'available', version: '0.4.0' } });
  assert.match(html, /<div class="sb-update" role="status"><button[^>]*data-app-upgrade>/);
});

// docs/adr/2026-11-03-1731-each-board-reviews-incoming-prs-that-touch-its-work.md
test('the Auto Review lane shows each PR with its author, cards and state, opens to the review and its links, and folds older posted ones', () => {
  const c = (number, state, over = {}) => ({ number, title: `PR ${number}`, author: 'Quinn', url: `https://github.com/o/r/pull/${number}`, asked: false,
    touches: [{ key: 'w/A2', ref: '#47' }], state, at: ago(0.1), text: null, reviewUrl: null, ...over });
  const reviews = { on: true, shown: true, at: ago(0.1), repo: 'o/r', waiting: 0, due: null,
    cards: [c(437, 'needs', { text: 'Clashes with **#47**.' }), c(440, 'reviewing', { asked: true }), c(431, 'posted', { text: 'Fine.', reviewUrl: 'https://github.com/o/r/pull/431#pullrequestreview-1' })],
    earlier: [{ ...c(421, 'posted', { text: 'Nothing new.' }), open: false }] };
  const html = ui.reviewLane(reviews, { open: { cards: new Set([437]) } });
  assert.match(text(html), /^Auto Review 3 1 needs you/);
  const cards = html.split('<details class="rv-card"').slice(1);
  assert.deepEqual(cards.map((h) => /class="rv-word s-\w+">([^<]+)</.exec(h)[1]), ['needs you', 'reviewing', 'posted']);
  assert.match(text(cards[0]), /PR #437 PR 437 needs you · .* from Quinn touches #47 Draft, not posted\. Clashes with #47 \. PR #437 on GitHub Post it Skip$/);
  assert.match(cards[0], /data-review="437" open/);
  assert.match(cards[0], /<strong>#47<\/strong>/);
  assert.match(text(cards[1]), /reviewing · started .* asked you Nothing posted yet/);
  assert.doesNotMatch(cards[1], /data-review-answer/);
  assert.match(cards[2], /href="https:\/\/github\.com\/o\/r\/pull\/431#pullrequestreview-1"/);
  assert.match(text(html), /Posted earlier 1 PR #421 PR 421 Quinn · posted .* · closed/);

  assert.equal(text(ui.reviewLane({ ...reviews, cards: [], earlier: [] })), 'Auto Review 0 No incoming PR touches this board’s work yet. Checked o/r 6m ago.');
  assert.match(text(ui.reviewLane({ ...reviews, cards: [], earlier: [], waiting: 2 })), /2 incoming PRs wait until the board is idle\./);
  assert.equal(ui.reviewLane({ ...reviews, shown: false }), '');
});

// docs/adr/2026-11-03-2024-every-in-progress-card-shows-its-phase-bars.md
test("a card's phase bars enter as it lands in In Progress, empty or not, fill as it reaches more phases, leave as it goes, and are still otherwise", () => {
  const reached = (it) => ui.phaseStrip(it)?.reached ?? null;
  assert.equal(reached({ lane: 'progress', builder: { phase: 'testing' } }), 3);
  assert.equal(reached({ lane: 'progress', builder: { phase: null } }), 0);
  assert.equal(reached({ lane: 'progress', waitsOn: 'checking' }), 5);
  assert.equal(reached({ lane: 'todo', builder: { phase: 'testing' } }), null);
  assert.equal(reached({ lane: 'progress', builder: { planner: true, phase: 'testing' } }), null);
  assert.equal(ui.phaseMotion(undefined, 0), 'enter');
  assert.equal(ui.phaseMotion(null, 5), 'enter');
  assert.equal(ui.phaseMotion(0, 1), 'fill');
  assert.equal(ui.phaseMotion(1, 3), 'fill');
  assert.equal(ui.phaseMotion(5, 5), null);
  assert.equal(ui.phaseMotion(3, 1), null);
  assert.equal(ui.phaseMotion(0, null), 'leave');
  assert.equal(ui.phaseMotion(null, null), null);
});

// docs/adr/2026-11-03-1915-every-pending-control-waits-in-one-style.md
test("a prompt line's tapped answer waits, disabled with its label kept behind the spinner, while the line's other buttons are disabled, with no Sending… line", () => {
  const at = new Date().toISOString();
  const perm = { id: 'p1', cwd: '~/repo', tool: 'Bash', action: 'run npm test', detail: 'npm test', rule: 'Bash(npm test)', questions: null, at };
  const ask = { id: 'p2', cwd: '~/repo', tool: 'AskUserQuestion', at, questions: [{ question: 'Colour?', header: '', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] }] };
  const looks = (html) => [...html.matchAll(/<button[^>]*?(data-prompt-(?:choice|opt|send)(?:="[^"]*")?)[^>]*>/g)].map(([tag, name]) => [name, / disabled aria-busy="true"/.test(tag) ? 'waits' : / disabled/.test(tag) ? 'disabled' : 'on']);
  assert.deepEqual(looks(ui.promptItem(perm, { sending: 'always' })), [['data-prompt-choice="allow"', 'disabled'], ['data-prompt-choice="always"', 'waits'], ['data-prompt-choice="deny"', 'disabled']]);
  assert.deepEqual(looks(ui.promptItem(perm)), [['data-prompt-choice="allow"', 'on'], ['data-prompt-choice="always"', 'on'], ['data-prompt-choice="deny"', 'on']]);
  assert.deepEqual(looks(ui.promptItem(ask, { sending: '0:Blue' })), [['data-prompt-opt="Red"', 'disabled'], ['data-prompt-opt="Blue"', 'waits'], ['data-prompt-choice="deny"', 'disabled']]);
  assert.doesNotMatch(text(ui.promptItem(perm, { sending: 'allow' })), /Sending/);
  assert.equal(text(ui.promptItem(perm, { sending: 'allow' })).includes('Allow once'), true);
});

test("This device's Turn on and Test wait in place of their label while they run", () => {
  const row = (action) => context.HubUI.deviceRow({ title: 'This device', sub: 'Off', action });
  assert.match(row({ label: 'Turn on', act: 'on', busy: true }), /data-device="on" disabled aria-busy="true">Turn on</);
  assert.match(row({ label: 'Test', act: 'test', quiet: true }), /data-device="test">Test</);
});

test("a card waiting on its owner step reads the step as its orange Next, with Done as a check icon where the bump sits", () => {
  const step = 'Add the npm trusted publisher';
  const waiting = { ...workCard, lane: 'review', waitsOn: 'owner', next: step, ownerStep: step, awaitsDone: true, bumpable: false };
  assert.deepEqual(lines(ui.workLines(waiting)).slice(0, 2), ['ENG-1 Five', `Next: ${step}`]);
  assert.match(ui.workLines(waiting), /<div class="line3 sub next">Next: /);
  assert.match(ui.workLines(waiting), /<div class="ask-actions"><button type="button" class="ghost icon owner-done" data-confirm="finish" data-key="w\/B5" aria-label="Done" title="Done: Add the npm trusted publisher"><svg/);
  assert.doesNotMatch(ui.workLines(waiting), /data-card-bump/);
  assert.doesNotMatch(ui.workLines({ ...waiting, ownerStep: null }), /owner-done/);
});
