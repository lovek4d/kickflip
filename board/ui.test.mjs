import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({ location: { hostname: 'mac.ts.net', host: 'mac.ts.net:443' }, navigator: { onLine: true }, setTimeout, clearTimeout });
for (const file of ['ui.js', 'ui-links.js', 'ui-enums.js', 'ui-progress-bar.js', 'ui-cards.js', 'ui-header.js', 'ui-threads.js', 'ui-questions.js', 'ui-prompts.js', 'ui-markdown.js', 'ui-page-header.js', 'ui-snapshot.js', 'ui-sidebar.js', 'ui-hub.js']) {
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
  assert.deepEqual([value(dark, '--accent'), value(dark, '--accent-soft'), value(dark, '--on-accent')], ['#6fa8e8', '#141b26', '#0b0b0e']);
  assert.deepEqual([...definedIn(colorsCss)].filter((v) => /love|blue/.test(v)), []);
  for (const f of ['style.css', 'sidebar.css', 'hub.css']) {
    const css = fs.readFileSync(new URL(`./public/${f}`, import.meta.url), 'utf8');
    const filled = css.split('}').filter((r) => /background:\s*var\(--accent\)/.test(r) && /[^-]color:/.test(r));
    for (const r of filled) assert.match(r, /[^-]color:\s*var\(--on-accent\)/, `${f}: ${r.trim()}`);
  }
});

test("dark mode's ground is near-black like Linear's, and the semantic colours stay as they were", () => {
  const dark = colorsCss.split('@media (prefers-color-scheme: dark)')[1];
  const value = (name) => new RegExp(`${name}:\\s*([^;]+);`).exec(dark)?.[1].trim();
  assert.deepEqual(['--bg', '--panel', '--line', '--text', '--muted', '--chip', '--band', '--claude'].map(value),
    ['#0b0c0d', '#111214', '#212226', '#e8e9ec', '#8a8f98', '#1a1b1e', '#141517', '#1f1a12']);
  assert.deepEqual(['--ok', '--warn', '--bad', '--purple'].map(value), ['#3ccf7f', '#e3a33a', '#f0687f', '#ab7df8']);
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

test('a merged or closed PR keeps its review chips at their last state, gray; a PR GitHub has not been read for shows none', () => {
  const review = { Jamie: { state: 'approved', since: null, github: 'jamie-gh' }, Sam: { state: 'changes', since: null, github: null } };
  for (const state of ['MERGED', 'CLOSED']) {
    const chips = ui.reviewChips({ pr: { ...openPR, state, status: state.toLowerCase() }, reviewers: ['Jamie', 'Sam'], review });
    assert.equal(text(chips), 'jamie-gh ✓ Sam ✗');
    assert.deepEqual([...chips.matchAll(/class="chip (tone-\w+)"/g)].map((m) => m[1]), ['tone-quiet', 'tone-quiet']);
    assert.match(chips, /title="Sam: asked for changes"/);
  }
  assert.equal(ui.reviewChips({ pr: { ...openPR, state: undefined, checks: undefined, status: null }, reviewers: ['Jamie'], review }), '');
});

test('a merged PR keeps its CI and Codex chips at their last state, gray, beside its Merged badge', () => {
  const chips = ui.prChips({ prs: [{ ...openPR, state: 'MERGED', status: 'merged', checks: { state: 'fail' }, codexOpen: 2 }] });
  assert.equal(text(chips), 'repo#7 ✓ CI ✗ codex 2');
  assert.deepEqual([...chips.matchAll(/class="chip (tone-\w+)"/g)].map((m) => m[1]), ['tone-merged', 'tone-quiet', 'tone-quiet']);
  assert.match(chips, /title="CI fail"/);
  // An archived card read only from what it kept, with no GitHub state, draws the same.
  assert.equal(text(ui.prChips({ prs: [{ ...openPR, state: undefined, status: 'merged', checks: { state: 'pass' } }] })), 'repo#7 ✓ CI ✓');
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

// docs/adr/2026-11-09-1626-gh-refuses-while-githubs-hourly-limit-holds.md
test("while GitHub's limit holds the hub's check, a PR's badge, CI and Codex chips dim and say when it resets", () => {
  const reset = new Date(2026, 10, 9, 15, 12).toISOString();
  const chips = ui.prChips({ prs: [{ ...openPR, codexOpen: 1, limited: reset }] });
  assert.equal(text(chips), 'repo#7 ✓ CI ✓ codex 1');
  assert.equal([...chips.matchAll(/<(?:a|span) class="chip tone-\w+"[^>]* data-limited="">/g)].length, 3);
  assert.equal([...chips.matchAll(/title="[^"]*· GitHub rate limited, resets at 3:12 pm"/g)].length, 3);
  assert.doesNotMatch(ui.prChips({ prs: [{ ...openPR, codexOpen: 1, limited: null }] }), /data-limited|rate limited/);
});

test("a card with several PRs shows a badge for each, in its order, with that PR's state, CI and link", () => {
  const site = { ...openPR, number: 1, url: 'https://github.com/o/site/pull/1', isDraft: true, status: 'draft', checks: { state: 'fail' } };
  const merged = { ...openPR, state: 'MERGED', status: 'merged' };
  const chips = ui.prChips({ prs: [merged, site] });
  assert.equal(text(chips), 'repo#7 ✓ CI ✓ site#1 ● CI ✗');
  assert.deepEqual([...chips.matchAll(/<a class="chip (tone-\w+)" href="([^"]+)"/g)].map((m) => [m[1], m[2]]), [
    ['tone-merged', 'https://github.com/o/repo/pull/7'], ['tone-notice', 'https://github.com/o/site/pull/1'],
  ]);
  assert.equal(ui.prChips({ prs: [] }), '');
});

test("the PR badge alone shows the PR's state, linking to the PR: a purple check once merged, a red cross once closed, a plain name before GitHub is read", () => {
  assert.deepEqual(plain(ui.PR_STATE), { open: 'open', draft: 'draft', merged: 'merged', closed: 'closed' });
  const merged = ui.prChips({ prs: [{ ...openPR, state: 'MERGED', status: 'merged', checks: undefined }] });
  assert.equal(text(merged), 'repo#7 ✓');
  assert.match(merged, /^<a class="chip tone-merged" href="https:\/\/github\.com\/o\/repo\/pull\/7" title="Merged" [^>]*aria-label="repo#7: Merged">[^<]*<\/a>$/);
  const closed = ui.prChips({ prs: [{ ...openPR, state: 'CLOSED', status: 'closed', checks: undefined }] });
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
  // The time never changes to words: only the span's class (red, orange) and title move.
  const cls = (html) => /class="([^"]*)"/.exec(html)[1];
  for (const opts of [{ watcher: 'stopped' }, { link: 'offline' }, { link: 'reconnecting' }, { watcher: 'asleep' }, { watcher: 'asleep', waking: true }, { watcher: 'waking' }, { pause: { state: 'paused', resets_at: ago(-1) } }, { watcher: 'stopped', waking: true }]) {
    assert.equal(text(ui.statusLine(fresh, opts)), '1 min', JSON.stringify(opts));
  }
  assert.equal(cls(ui.statusLine(fresh, { watcher: 'stopped' })), 'fresh', 'never coloured: the logo dot says it');
  assert.match(ui.statusLine(fresh, { watcher: 'stopped' }), /title="Claude not listening\. Updated /);
  assert.equal(cls(ui.statusLine(fresh, { link: 'offline' })), 'fresh');
  assert.equal(cls(ui.statusLine(fresh, { pause: { state: 'paused', resets_at: ago(-1) } })), 'fresh');
  assert.equal(cls(ui.statusLine(fresh, { watcher: 'stopped', pause: { state: 'paused', resets_at: ago(-1) } })), 'fresh');
  assert.equal(cls(ui.statusLine(fresh, { link: 'reconnecting' })), 'fresh');
  assert.match(ui.statusLine(fresh, { link: 'reconnecting' }), /title="Reconnecting…\. Updated /);
  assert.match(ui.statusLine(fresh, { watcher: 'asleep' }), /title="Asleep: [^"]*wakes it\. Updated /);
  assert.equal(text(ui.statusLine(fresh, { watcher: 'running', waking: true })), '1 min');
  assert.equal(text(ui.statusLine(undefined, { link: 'offline' })), '');
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
  assert.deepEqual(on({ wired: true, boardSettled: true, link: 'offline' }), { refresh: true, settings: true, spin: false }, 'Settings opens its read-only copy offline');
  assert.deepEqual(on({ wired: true, boardSettled: true, link: 'reconnecting', reloading: true }), { refresh: false, settings: false, spin: true });
});

// docs/adr/2026-11-05-1819-the-board-syncs-by-change-number.md
test("the saved copy keeps the board whole, its change number included, and the threads of the cards still on it", () => {
  const savedAt = '2026-10-23T08:00:00.000Z';
  const board = { version: 1762400000123, generatedAt: savedAt, items: [{ key: 'w/A', lane: 'todo', changed: 1762400000120 }, { key: 'w/B', lane: 'done', changed: 1762400000123 }] };
  const threads = new Map([['w/B', [{ text: 'b' }]], ['w/A', [{ text: 'a' }]], ['w/gone', [{ text: 'x' }]]]);
  const copy = ui.copyOf(board, threads, { build: 'b1', savedAt });
  assert.deepEqual(plain(copy), { build: 'b1', savedAt, board, threads: { 'w/B': [{ text: 'b' }], 'w/A': [{ text: 'a' }] } });
  const back = plain(ui.readCopy(plain(copy), 'b1'));
  assert.deepEqual([back.savedAt, back.board, Object.keys(back.threads)], [savedAt, board, ['w/B', 'w/A']]);
});

test('a stored copy that is damaged, saved under another build, undated or holding no change number reads as none', () => {
  const good = plain(ui.copyOf({ version: 7, items: [{ key: 'w/A', lane: 'todo' }] }, new Map(), { build: 'b1', savedAt: '2026-10-23T08:00:00.000Z' }));
  assert.ok(ui.readCopy(good, 'b1'));
  assert.equal(ui.readCopy(good, 'b2'), null);
  for (const odd of [null, undefined, 'text', { ...good, build: undefined }, { ...good, board: { ...good.board, items: undefined } }, { ...good, savedAt: 'soon' }, { ...good, board: { ...good.board, version: 'v1' } }]) {
    assert.equal(ui.readCopy(odd, 'b1'), null, JSON.stringify(odd));
  }
  assert.deepEqual(Object.keys(ui.readCopy({ ...good, threads: { 'w/A': 'text', 'w/B': [{ text: 'b' }] } }, 'b1').threads), ['w/B']);
});

test('threads load in the background for every In Review, In Progress and Todo card that is not already open', () => {
  const items = ['review', 'review', 'progress', 'todo', 'followups', 'done', 'todo'].map((lane, n) => ({ key: `w/${n}`, lane }));
  assert.deepEqual([...ui.preloadKeys(items, new Set(['w/2']))], ['w/0', 'w/1', 'w/3', 'w/6']);
  assert.deepEqual([...ui.preloadKeys(items, [])], ['w/0', 'w/1', 'w/2', 'w/3', 'w/6']);
});

test('when the catch-up lands on the saved copy, only lines whose text changed or that are new flash', () => {
  assert.deepEqual([...ui.changedLines({ a: 'Running tests', b: '2', c: 'gone' }, { a: 'Running tests', b: '3', d: 'new' })], ['b', 'd']);
  assert.deepEqual([...ui.changedLines({}, {})], []);
});

test('every page header has a logo, a back arrow where needed, the title and disabled controls', () => {
  const logo = ui.header({ lead: 'logo', title: 'iOS <Orchestrator>' });
  assert.match(logo, /^<header class="top"><div class="brand"><a class="hub" href="\/_hub\/" aria-label="Boards"><img src="kickflip\.png" alt=""><\/a><h1>iOS &lt;Orchestrator&gt;<\/h1><\/div>/);
  assert.match(logo, /<button class="ghost spinning" id="refresh" type="button" disabled/);
  assert.match(logo, /<span class="muted" id="status">…<\/span>/);
  assert.doesNotMatch(logo, /settingsLink|archBulb|pages-switch/, 'the gear and bulb sit at the foot of the board, and only a board page has the switch');
  assert.equal(text(logo), 'iOS <Orchestrator> …');
  const foot = ui.boardFoot();
  assert.match(foot, /^<div class="board-foot"><button class="ghost icon arch-bulb" id="archBulb" type="button"[^>]*>.*<\/button><a href="settings\.html" id="settingsLink" class="ghost icon"[^>]*aria-disabled="true" tabindex="-1" aria-haspopup="dialog">/);

  // docs/adr/2026-11-07-1300-board-and-open-questions-are-two-pages.md
  const board = ui.header({ lead: 'logo', title: 'Board', pages: 'questions' });
  assert.match(board, /<\/span><a href="questions\.html" id="questionsLink" class="ghost icon pages-switch" aria-label="Open questions" title="Open questions"><svg[^>]*><path d="M6\.5 8\.5a5\.5 5\.5 0 1 1 8\.2 4\.8[^"]*"\/><path d="M12 21h\.01"\/><\/svg><span class="q-badge" hidden><\/span><\/a><\/nav>/);
  const questions = ui.header({ lead: 'logo', title: 'Waiting on you', controls: false, trail: '<span id="progress"></span>', pages: 'board' });
  assert.match(questions, /<span id="progress"><\/span><a class="ghost icon pages-switch back" href="\.\/" aria-label="Back to the board" title="Back to the board"><svg[^>]*><path d="M20 6 9 17l-5-5"\/><\/svg><\/a><\/header>$/);

  const back = ui.header({ lead: 'back', backHref: '/', backLabel: 'Back to Claude', title: 'Settings', logoSrc: '/_hub/kickflip.png', time: 'now' });
  assert.match(back, /^<header class="top"><div class="brand"><a class="hub" href="\/_hub\/" aria-label="Boards"><img src="\/_hub\/kickflip\.png" alt=""><\/a><a class="back" href="\/" aria-label="Back to Claude"><svg width="24" height="24"[^>]*>.*?<\/svg><\/a><h1>Settings<\/h1><\/div>/);
  assert.equal((back.match(/class="hub"/g) || []).length, 1);
  assert.ok(back.indexOf('class="hub"') < back.indexOf('class="back"'), 'the icon comes before the back button');
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
    tickets: { source: 'github' }, error: 'claude --bg failed (1): <Not signed in>' };
  const sheet = ui.failedStart(failed, { home: '/Users/you', now });
  assert.match(sheet, /<h2 id="failedStartTitle">Firm &lt;ware&gt; failed to start<\/h2>/);
  assert.equal(text(sheet), 'Firm <ware> failed to start ✕ claude --bg failed (1): <Not signed in> Repo ~/dev/.repos/acme/firmware Branch release/next Tickets GitHub issues Asked 3 min ago Dismiss Retry');
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
  const script = /<script>([\s\S]*)<\/script>$/.exec(ui.header({ lead: 'back', backHref: './#selectedCard=w%2FA1', title: 'Prototype' }))[1];
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

test("a board's fragment names the focused card, reads the older #item= link as the card, and drops a key it doesn't know", () => {
  const routerContext = vm.createContext({ URL });
  vm.runInContext(fs.readFileSync(new URL('./public/router.js', import.meta.url), 'utf8'), routerContext);
  const { fragmentOf, hashWith, viewOf } = routerContext.AppRouter;
  const base = { review: null, reply: false };
  assert.deepEqual(plain(fragmentOf('#selectedCard=w%2FA1&openItemsCard=item%3Aw%2FA2')), { selectedCard: 'w/A1', ...base });
  assert.deepEqual(plain(fragmentOf('#item=w%2FA1&reply')), { selectedCard: 'w/A1', review: null, reply: true });
  assert.deepEqual(plain(fragmentOf('#review=12')), { selectedCard: null, review: 12, reply: false });
  assert.deepEqual(plain(fragmentOf('')), { selectedCard: null, ...base });
  assert.equal(hashWith('#item=w%2FA1&reply', { selectedCard: 'w/A1' }), '#selectedCard=w%2FA1');
  assert.equal(hashWith('#selectedCard=w%2FA1&openItemsCard=q-1', { selectedCard: 'w/B' }), '#selectedCard=w%2FB');
  assert.equal(hashWith('#selectedCard=w%2FA1', { selectedCard: null }), '');
  const read = (url) => plain(viewOf(`https://mac.ts.net${url}`, { boards: new Set(['orch']), base: 'https://mac.ts.net/orch/' }));
  assert.deepEqual(read('/orch/#selectedCard=w%2FA1&openItemsCard=q-1'), { kind: 'board', route: 'orch', hash: '#selectedCard=w%2FA1&openItemsCard=q-1' });
  assert.deepEqual(read('/orch/questions.html#openItemsCard=q-1'), { kind: 'questions', route: 'orch', id: 'q-1' });
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
    ['/orch/#selectedCard=w%2FA1&reply', { kind: 'board', route: 'orch', hash: '#selectedCard=w%2FA1&reply' }],
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
    ['/orch/', '/orch/#selectedCard=w%2FA1&reply', '/orch/settings.html', '/orch/questions.html#q-1', '/orch/notes.html?item=w%2FA1', '/orch/notes.html?wave=mon',
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
  assert.equal(inApp.tap('./#selectedCard=w%2FA1', 'back'), 'back');
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
  assert.equal(cold.tap('./#selectedCard=w%2FA1', { cls: 'back' }), 'back');
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
  assert.deepEqual(thread.stack(), ['#selectedCard=w%2FA1', 'questions.html#q1']);
  thread.tap('prototype-x.html?q=q2&variant=B');
  assert.deepEqual(thread.stack(), ['#selectedCard=w%2FA1', 'questions.html#q2', 'prototype-x.html?q=q2&variant=B']);
  thread.router.replace('https://mac.ts.net/orch/prototype-y.html?q=q3');
  assert.deepEqual([thread.stack(), plain(thread.history.state)], [['#selectedCard=w%2FA1', 'questions.html#q2', 'prototype-y.html?q=q3'], { idx: 2, up: 2 }]);
  assert.equal(thread.router.replace('https://mac.ts.net/orch/questions.html#q4'), 'up');
  assert.deepEqual([thread.stack(), thread.shown.at(-1)], [['#selectedCard=w%2FA1', 'questions.html#q4'], 'pop questions']);
  assert.equal(thread.tap('./', { cls: 'back' }), 'back');
  assert.deepEqual(thread.stack(), ['#selectedCard=w%2FA1']);

  const line = appHistory('https://mac.ts.net/orch/');
  line.tap('prototype-x.html?q=q1', { card: 'w/A1' });
  assert.deepEqual(line.stack(), ['#selectedCard=w%2FA1', 'questions.html#q1', 'prototype-x.html?q=q1']);

  const needs = appHistory('https://mac.ts.net/orch/#selectedCard=w%2FA1&reply');
  needs.tap('questions.html#q1');
  assert.deepEqual(needs.stack(), ['', 'questions.html#q1']);
  needs.tap('#q2');
  assert.deepEqual(needs.stack(), ['', 'questions.html#q2']);
  assert.equal(needs.tap('./', { cls: 'back' }), 'back');
  assert.deepEqual(needs.stack(), ['']);

  const picked = appHistory('https://mac.ts.net/orch/prototype-x.html?q=q1&from=push');
  picked.router.replace('https://mac.ts.net/orch/#selectedCard=w%2FA1&reply');
  assert.deepEqual([picked.stack(), picked.shown.at(-1)], [['#selectedCard=w%2FA1&reply'], 'pop board']);
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

// docs/adr/2026-11-09-1453-orchestrator-messages-replies-and-transcript-text-are-markdown.md
test("the orchestrator's thread message draws as compact markdown, linking refs, while the owner's and others' stay as written", () => {
  const items = [{ key: 'site/S54', file: 'site', kind: 'work', ref: 'INT-54', internal: true, linear: [], repo: null }];
  const html = ui.threadMessages([
    { ts: ago(3), who: 'claude', text: 'Landed:\n\n- **INT-54** done\n- `node --test` green' },
    { ts: ago(2), who: 'love', text: '- **mine** stays\nas typed' },
    { ts: ago(1), who: 'Jamie', via: 'github', text: '**theirs**' },
  ], ui.linkContext(items, 'site/S54'));
  const [orch, love, other] = html.split(/(?=<div class="msg )/).filter((h) => h.startsWith('<div class="msg '));
  assert.match(orch, /<div class="body md"><p>Landed:<\/p>\s*<ul><li><strong><a href="#selectedCard=site%2FS54"[^>]*>INT-54<\/a><\/strong> done<\/li><li><code>node --test<\/code> green<\/li><\/ul><\/div>/);
  assert.match(love, /<div class="body">- \*\*mine\*\* stays\nas typed<\/div>/);
  assert.match(other, /<div class="body">\*\*theirs\*\*<\/div>/);
});

test("a markdown reply draws as compact markdown in the thread and under an answered question, and an older HTML reply as written", () => {
  const items = [{ key: 'site/S54', file: 'site', kind: 'work', ref: 'INT-54', internal: true, linear: [], repo: null }];
  const links = ui.linkContext(items, 'site/S54');
  const html = ui.threadMessages([
    { ts: ago(3), who: 'love', text: 'Why?', eventId: 'e1', state: 'replied', reply: { md: '**Because** of INT-54\n\n- one', at: ago(2) } },
    { ts: ago(1), who: 'love', text: 'And?', eventId: 'e2', state: 'replied', reply: { html: '<p>Old <b>HTML</b></p>', at: ago(0) } },
  ], links);
  assert.match(html, /<div class="body md"><p><strong>Because<\/strong> of <a href="#selectedCard=site%2FS54"[^>]*>INT-54<\/a><\/p>\s*<ul><li>one<\/li><\/ul><\/div>/);
  assert.match(html, /<div class="body"><p>Old <b>HTML<\/b><\/p><\/div>/);
  const q = { ...question, state: 'replied', answers: [{ ts: ago(1), choice: 'A', note: '', files: [], reply: { md: '**Kept**' } }] };
  assert.match(ui.questionCard(q, { links }), /<div class="rep md"><div class="muted small">Claude<\/div><p><strong>Kept<\/strong><\/p><\/div>/);
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
  assert.match(text(html), /^Jamie · GitHub · .* Looks good You · .* Ship it waiting…$/);
  const log = ui.threadMessages([{ ts: ago(1), who: 'claude', text: 'done', log: 'b.log' }]);
  assert.match(log, /<a href="log\.html\?file=b\.log">View transcript<\/a>/);
  assert.doesNotMatch(log, /link-arrow|→/);
  assert.equal(text(ui.threadMessages([])), 'No messages here yet.');
});

const question = {
  id: 'q1', source: 'Triage', question: 'Keep <it>?', state: 'open', answers: [],
  options: [{ id: 'A', label: 'Keep' }, { id: 'B', label: 'Drop', recommended: true, detail: 'Saves a step' }],
};

test('a question card marks the recommended option', () => {
  const opts = options(ui.questionCard(question));
  assert.deepEqual(opts.map((o) => text(o)), ['A. Keep', 'B. Drop recommended Saves a step']);
  assert.match(text(ui.questionCard(question)), /Keep <it>\?/);
});

// docs/adr/2026-11-09-1500-a-questions-descriptions-are-markdown-and-its-text-is-one-brief-line.md
test("a question's context and an option's detail draw as markdown, its text stays plain", () => {
  const md = { ...question, question: 'Use **it**?', context: 'Why:\n\n- one\n- two\n\n## Head', options: [{ id: 'A', label: 'Keep', detail: 'Use `x` and **bold**' }] };
  const html = ui.questionCard(md);
  assert.match(html, /<div class="ctx"><p>Why:<\/p>\s*<ul><li>one<\/li>/);
  assert.match(html, /<div class="det">.*<code>x<\/code>.*<strong>bold<\/strong>/);
  assert.match(html, /<h3>Use \*\*it\*\*\?<\/h3>/);
  assert.match(ui.questionCard({ ...md, state: 'resolved', answers: [] }), /<div class="ctx"><p>Why:<\/p>/);
});

// docs/adr/2026-11-04-2200-overnight-triage-suggests-your-earlier-answers.md
test('a question card pre-checks its suggested option, with a blue Orchestrator choice line under its label giving the reason, else the earlier answer it came from', () => {
  const suggested = { ...question, suggested: { option: 'A', card: '#186', answer: 'Keep, nothing floats over a question.' } };
  const opts = options(ui.questionCard(suggested));
  const checked = (html) => options(html).map((o) => /\bchecked>/.test(o));
  assert.deepEqual(opts.map((o) => text(o)), ['A. Keep Orchestrator choice: you answered this on #186: "Keep, nothing floats over a question."', 'B. Drop recommended Saves a step']);
  assert.doesNotMatch(opts[0], /chip/);
  assert.match(opts[0], /<span class="lbl">A\. Keep<\/span><div class="suggested-why">Orchestrator choice: /);
  const links = ui.linkContext([{ key: 'w/A1', file: 'w', id: 'A1', ref: '#186' }], null);
  assert.match(options(ui.questionCard(suggested, { links }))[0], /<div class="suggested-why">Orchestrator choice: you answered this on <a [^>]*>#186<\/a>: /);
  const reasoned = { ...suggested, suggested: { ...suggested.suggested, reason: 'It is the same trade-off as <b>#186</b>.' } };
  assert.match(options(ui.questionCard(reasoned))[0], /<div class="suggested-why">Orchestrator choice: It is the same trade-off as &lt;b&gt;#186&lt;\/b&gt;\.<\/div>/);
  assert.deepEqual(checked(ui.questionCard(suggested)), [true, false]);
  assert.deepEqual(checked(ui.questionCard(suggested, { draft: { choice: 'B' } })), [false, true]);
  const answered = { ...suggested, state: 'open', reopened: true, answers: [{ ts: ago(1), choice: 'B', note: '', reply: null }] };
  assert.deepEqual(checked(ui.questionCard(answered)), [false, true]);
  assert.equal(ui.choiceOf(suggested, {}), 'A');
  assert.equal(ui.choiceOf(answered, {}), 'B');
  assert.equal(ui.choiceOf(question, {}), null);
  assert.equal(ui.choiceOf(suggested, { choice: null }), null, 'a cleared pick stays cleared, not the suggestion');
  assert.equal(ui.choiceOf(answered, { choice: null }), null);
});

// docs/adr/2026-11-05-2331-a-sent-answer-is-resolved-in-place-until-the-page-reloads.md
test("a reopened question checks this device's draft over the last answer and fills its note box with the note it sent, with no waiting line", () => {
  const reopened = { ...question, state: 'open', reopened: true, answers: [{ ts: ago(1), choice: 'A', note: 'Keep the badge', reply: null }] };
  const checked = (html) => options(html).map((o) => /\bchecked>/.test(o));
  assert.deepEqual(checked(ui.questionCard(reopened)), [true, false]);
  assert.deepEqual(checked(ui.questionCard(reopened, { draft: { choice: 'B' } })), [false, true]);
  assert.match(ui.questionCard(reopened), /<textarea class="note" rows="2" placeholder="Note \(optional\)">Keep the badge<\/textarea>/);
  assert.match(ui.questionCard(reopened, { draft: { note: 'Drop it' } }), />Drop it<\/textarea>/);
  assert.equal(ui.noteOf(reopened, {}), 'Keep the badge');
  assert.equal(ui.noteOf({ ...reopened, reopened: false }, {}), '');
  assert.doesNotMatch(text(ui.questionCard(reopened)), /waiting…/);
});

test("a sent question, waiting on Claude, replied to or resolved, draws as the green Resolved card, numbered, locked at its pick, saying how to reopen it", () => {
  const sent = (state) => ui.questionCard({ ...question, state, answers: [{ ts: ago(1), choice: 'B', note: '', reply: null }] }, { n: 3 });
  for (const state of ['answered', 'replied', 'resolved']) {
    const html = sent(state);
    assert.match(html, /^<section class="q resolved" id="q1"/);
    assert.match(html, /<span class="muted small">3\. Triage<\/span><button class="chip tone-ready" title="Reopen this question" type="button" data-reopen="q1">✓ Resolved<\/button>/);
    assert.match(html, /<div class="sent-line">Sent\. Tap Resolved to reopen it\.<\/div>/);
    assert.doesNotMatch(html, /<textarea|data-proto|waiting…/);
    assert.match(html, /value="B" checked disabled/);
  }
  assert.doesNotMatch(ui.questionCard({ ...question, state: 'resolved', resolved: 'Replaced by q9' }), /sent-line/, 'one resolved with no answer sent says nothing of sending');
  assert.equal(ui.isSent({ state: 'open' }) || ui.isSent({ state: 'requested' }), false);
});

const takeCards = (html) => html.split('<article class="take"').slice(1).map(beforeComposer);
const frames = (html) => [...html.matchAll(/<iframe src="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));

// docs/adr/2026-11-05-1302-a-questions-prototypes-open-in-a-full-page-viewer.md
test("a question on a prototype page shows plain options and one View prototypes button that opens its viewer, with no take framed in the question", () => {
  const proto = ui.questionCard({ ...question, url: 'prototype-hub-snooze.html?q=q1#top' }, { draft: { choice: 'B' } });
  assert.deepEqual(frames(proto), []);
  assert.doesNotMatch(proto, /class="takes|take-shot|takes-full|See the prototypes|target="_blank"/);
  assert.equal((proto.match(/<a class="button proto-view" href="prototype-hub-snooze\.html\?q=q1#top">View prototypes<\/a>/g) || []).length, 1);
  assert.deepEqual(options(proto).map((o) => /\bchecked>/.test(o)), [false, true]);
  assert.deepEqual(options(proto).map((o) => text(o)), ['A. Keep', 'B. Drop recommended Saves a step']);
  assert.ok(proto.indexOf('View prototypes') < proto.indexOf('<label class="opt">'));
  context.location = { origin: 'https://mac.tail.ts.net', href: 'https://mac.tail.ts.net/orch/' };
  try {
    const absolute = ui.questionCard({ ...question, url: 'https://mac.tail.ts.net/orch/prototype-hub-snooze.html?q=q1' });
    assert.match(absolute, /<a class="button proto-view" href="https:\/\/mac\.tail\.ts\.net\/orch\/prototype-hub-snooze\.html\?q=q1">View prototypes<\/a>/);
    const elsewhere = ui.questionCard({ ...question, url: 'https://elsewhere.example/orch/prototype-hub-snooze.html?q=q1' });
    assert.doesNotMatch(elsewhere, /View prototypes/);
    assert.match(elsewhere, /target="_blank"/);
  } finally { context.location = { hostname: 'mac.ts.net', host: 'mac.ts.net:443' }; }
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
  assert.deepEqual(anchors(a), [['./#selectedCard=site%2FS54', 'INT-54', false]]);
  assert.match(b, /<div class="flow-box tone-danger">Each &lt;own&gt; read<\/div>/);
  assert.match(text(b), /In practice Nothing to build\. Each feature forgets a kind\.$/);
  assert.match(html, /<a class="button proto-view" href="prototype-seams\.html\?q=q1">View prototypes<\/a>/);
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

// docs/adr/2026-11-04-2130-a-prototype-request-waits-for-its-prototype.md
test('a question asked for a prototype reads prototype requested with a spinner, locked at the pick and note the request sent, with no eye, until its round arrives', () => {
  const asked = { ...question, state: 'requested', request: { id: 'r1', ts: ago(1), note: 'On a phone', choice: question.options[0].id } };
  const html = ui.questionCard(asked);
  assert.match(html, /<span class="try-spin" aria-hidden="true"><\/span>prototype requested/);
  assert.match(html, /^<section class="q pr-busy" id="q1"/, 'it takes the blue tint');
  assert.doesNotMatch(html, /data-proto|<textarea/);
  assert.equal((html.match(/<input [^>]*disabled/g) || []).length, question.options.length);
  assert.match(html, new RegExp(`value="${question.options[0].id}" checked disabled`));
  assert.match(text(html), /On a phone/);
});

// docs/adr/2026-11-03-1803-a-question-asked-for-a-prototype-is-resolved.md
test('an open question has its eye on and nothing locked, a resolved one has no eye; a confirm opens the viewer on its one take and says why it is asked', () => {
  assert.match(ui.questionCard(question), /<button type="button" class="attach proto-ask" data-proto="q:q1" aria-label="Ask for a prototype instead" title="Ask for a prototype instead">/);
  assert.doesNotMatch(ui.questionCard(question), /disabled|pr-busy|try-spin/);
  assert.doesNotMatch(ui.questionCard({ ...question, state: 'resolved' }), /data-proto/);

  const confirm = { ...question, id: 'c1', question: 'Is this it?', url: 'prototype-search.html?q=c1', options: [{ id: 'B', label: 'Icon' }], round: 1, confirm_of: 'q1' };
  const open = ui.questionCard(confirm);
  assert.match(open, /<a class="button proto-view" href="prototype-search\.html\?q=c1&amp;variant=B">View prototypes<\/a>/);
  assert.doesNotMatch(open, /pr-open|Open the prototype|[?&]take=/);
  assert.match(text(open), /A pick with a note gets a one-take confirm once Claude has updated the take\./);
  assert.deepEqual(frames(open), []);
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
  assert.match(html, /<button class="chip tone-ready" title="Reopen this question" type="button" data-reopen="q1">✓ Resolved<\/button>/);
  assert.doesNotMatch(html, /re-ask requested/);
  const pending = ui.questionCard({ ...question, state: 'resolved', resolved: 'Kept it', resolved_at: at, answers: [answer], reask: { id: 'r1', ts: new Date().toISOString() } });
  assert.match(text(pending), /re-ask requested/);
});

test("a resolved question keeps Claude's reply under the note, and one with no answer shows no answer box", () => {
  const answer = { ts: new Date().toISOString(), choice: 'A', note: '', files: [], reply: { html: '<p>Done that.</p>' }, acted: true };
  const html = ui.questionCard({ ...question, state: 'resolved', resolved: 'Kept it', answers: [answer] });
  assert.match(text(html), /Claude Done that\./);
  assert.doesNotMatch(text(html), /acted on/, 'with no resolved_at it says no time');
  assert.doesNotMatch(ui.questionCard({ ...question, state: 'resolved', resolved: 'Kept it' }), /class="ans/);
});

test('a topic pill reads its whole title, a Linear and a GitHub card alike', () => {
  const titles = ['INT-92: Hub home rows', 'B5: Lane chips', '#422: Open-items pills', 'Release plan'];
  assert.deepEqual(titles.map((title) => ui.topicName({ title })), titles);
});

test("a card's topic, which the board sends with no title, takes its name from its card, and every other topic keeps its own", () => {
  const cards = [{ key: 'w/B5', kind: 'work', ref: 'B5', title: 'Lane chips' }, { key: 'w/T-3', kind: 'work', ref: 'T-3', title: 'Fix it', isNew: true, ask: { askedAt: ago(1) } }];
  const named = ui.cardTopics([{ id: 'item:w/B5', card: 'w/B5', open: 1 }, { id: 'item:w/T-3', card: 'w/T-3', open: 1 }, { id: 'plan', title: 'Release plan' }, { id: 'item:w/Z', card: 'w/Z', title: 'Z9: Archived' }], cards);
  assert.deepEqual(plain(named.map((t) => [t.title, t.summary ?? null, ui.topicName(t)])),
    [['B5: Lane chips', null, 'B5: Lane chips'], ['T-3: Fix it', null, 'T-3: Fix it'], ['Release plan', null, 'Release plan'], ['Z9: Archived', null, 'Z9: Archived']]);
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

test("a thread's Done is the box's second send button, on ⌥↵, never disabled, and orange while a card waits only on it", () => {
  const done = (it) => { const html = ui.doneButton(it); return [text(html), /disabled/.test(html), /data-nth="1"/.test(html), /data-confirm="finish"/.test(html)]; };
  assert.deepEqual(done({ key: 'w/T-3', kind: 'work', finishable: true }).slice(1), [false, true, true]);
  assert.match(text(ui.doneButton({ key: 'w/T-3', kind: 'work' })), /^Done/);
  assert.match(ui.doneButton({ key: 'w/A1', kind: 'work', finishable: true, awaitsDone: true }), /^<button type="submit" data-nth="1" class="closes"/);
  assert.match(ui.doneButton({ key: 'w/A1', kind: 'work', finishable: true }), /^<button type="submit" data-nth="1" data-confirm/);
  assert.match(ui.doneButton({ key: 'w/A1', kind: 'work', finishable: true, resolvedBy: ui.BUTTON.done }), /^<button type="submit" data-nth="1" class="closes"/);
});

test("the open card's details list ends with Notes, Install and GitHub links in order, omitting links that do not apply; Notes has no summary or button, and a ready card's Implement is filled orange", () => {
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  assert.match(css, /button\.build\.ready, button\.unhold, button\.closes \{[^}]*background: var\(--color-notice\)/);

  const app = vm.createContext({ document: { addEventListener() {} }, CSS: { escape: (s) => s }, matchMedia: () => ({ matches: false }) });
  for (const file of ['ui.js', 'ui-links.js', 'ui-enums.js', 'ui-progress-bar.js', 'ui-cards.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), app);
  const clicks = [], later = [];
  const B = { $: () => ({}), alive: () => false, on: (el, type, fn) => { if (type === 'click') clicks.push(fn); }, later: (ms, fn) => later.push([ms, fn]), store: {}, state: { board: { items: [] }, mainPull: { open: false } }, seen: {}, thread: () => '', links: (key) => app.BoardUI.linkContext([], key) };
  app.BoardView = { part: (fn) => fn(B) };
  vm.runInContext(fs.readFileSync(new URL('./public/app-cards.js', import.meta.url), 'utf8'), app);
  const open = { ...workCard, pr: null, prs: [], reviewers: [], key: 'w/A1', action: null, wave: { slug: 'w1', title: 'W' }, deps: [], manualSteps: [], kind: 'work', holdable: true, hasNotes: true, notes: 'Old short note', summary: 'A stored summary' };
  const rows = (it) => [...B.detail(it).matchAll(/<dt[^>]*>(.*?)<\/dt><dd[^>]*>(.*?)<\/dd>/g)].map(([, k, v]) => [text(k), text(v)]);
  const pushed = { ...open, ref: 'INT-12', next: 'merge INT-12 into main', branch: 'INT-12', pushed: { branch: 'INT-12', at: new Date(Date.now() - 25 * 60_000).toISOString(), host: 'gitlab.com' } };
  assert.deepEqual(rows(pushed), [['Wave', 'W'], ['Branch', 'INT-12'], ['Status', 'in review'], ['Next', 'merge INT-12 into main'], ['Links', 'Pushed INT-12 to gitlab.com · 25m ago']]);
  assert.doesNotMatch(B.detail(pushed), /github\.com|gitlab\.com\/|<button[^>]*data-copy/);
  // Notes is a button at the end of the workflow row, after Hold, and has no ↗.
  assert.match(B.detail(open), /<div class="action-row workflow">.*<a class="button" href="notes\.html\?item=w%2FA1">Notes<\/a><\/div>/s);
  assert.match(B.detail({ ...open, pr: openPR, prs: [openPR] }), /target="_blank"[^>]*>Review on GitHub <svg[^>]*link-arrow/);
  const copied = [];
  app.navigator = { clipboard: { writeText: async (t) => { copied.push(t); } } };
  const link = { dataset: { copyBranch: 'INT-12' }, textContent: 'Pushed INT-12 to gitlab.com · 25m ago', isConnected: true };
  B.state.board.items = [pushed];
  let prevented = false;
  for (const fn of clicks) fn({ target: { closest: (sel) => (sel === '[data-copy-branch]' ? link : null) }, preventDefault: () => { prevented = true; } });
  assert.deepEqual([copied, link.textContent, prevented], [['INT-12'], 'Copied the branch name', true]);
  later.at(-1)[1]();
  assert.equal(link.textContent, 'Pushed INT-12 to gitlab.com · 25m ago');
  assert.deepEqual(rows(open), [['Wave', 'W'], ['Status', 'in review'], ['Next', 'Waiting for PR reviewers']]);
  assert.doesNotMatch(B.detail(open), /Old short note|A stored summary|view more|<summary[^>]*>Notes/);
  assert.doesNotMatch(B.detail({ ...open, hasNotes: false }), /Notes|notes\.html/);
  const install = { url: 'https://m/app.apk', older: false };
  const pr = { state: 'OPEN', url: 'https://github.com/o/r/pull/1' };
  for (const hasNotes of [false, true]) {
    for (const build of [null, install]) {
      for (const state of ['OPEN', 'MERGED', 'CLOSED']) {
        const it = { ...open, hasNotes, install: build, pr: { ...pr, state }, prs: [{ ...pr, state }] };
        const expected = [build && 'Install', state === 'OPEN' && 'Review on GitHub'].filter(Boolean);
        assert.deepEqual(rows(it).filter(([label]) => label === 'Links'), expected.length ? [['Links', expected.join(' · ')]] : []);
        assert.match(B.detail(it), expected.length ? /<dd class="external-links">[^]*<\/dd><\/dl>/ : /<dd>Waiting for PR reviewers<\/dd><\/dl>/);
        assert.doesNotMatch(B.detail(it), /action-row external/);
      }
    }
  }
});

test("a card with a worktree opens it in VS Code from its Links line, live on the host and muted with a tooltip off it",() => {
  const app = vm.createContext({ document: { addEventListener() {} }, CSS: { escape: (s) => s }, matchMedia: () => ({ matches: false }) });
  for (const file of ['ui.js', 'ui-links.js', 'ui-enums.js', 'ui-progress-bar.js', 'ui-cards.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), app);
  const B = { $: () => ({}), on() {}, later() {}, store: {}, state: { board: { items: [], onHost: true } }, seen: {}, thread: () => '', links: (key) => app.BoardUI.linkContext([], key) };
  app.BoardView = { part: (fn) => fn(B) };
  vm.runInContext(fs.readFileSync(new URL('./public/app-cards.js', import.meta.url), 'utf8'), app);
  const rows = (it) => [...B.detail(it).matchAll(/<dt[^>]*>(.*?)<\/dt><dd[^>]*>(.*?)<\/dd>/g)].map(([, k, v]) => [text(k), text(v)]);
  const open = { ...workCard, pr: null, prs: [], reviewers: [], key: 'w/A1', action: null, wave: { slug: 'w1', title: 'W' }, deps: [], manualSteps: [], kind: 'work', holdable: true, hasNotes: true, worktree: '/Users/me/.claude/kickflip/worktrees/A 1' };
  assert.deepEqual(rows(open).at(-1), ['Links', 'Open in VS Code']);
  assert.match(B.detail(open), /<a href="vscode:\/\/file\/Users\/me\/\.claude\/kickflip\/worktrees\/A%201" title="Open the worktree in VS Code">Open in VS Code /);
  assert.deepEqual(rows({ ...open, hasNotes: false }).at(-1), ['Links', 'Open in VS Code']);
  for (const lane of ['progress', 'review']) assert.match(B.detail({ ...open, lane }), /Open in VS Code/);
  assert.doesNotMatch(B.detail({ ...open, worktree: null }), /vscode:|Open in VS Code/);
  B.state.board.onHost = false;
  assert.doesNotMatch(B.detail(open), /vscode:/);
  assert.match(B.detail(open), /<a aria-disabled="true" title="not on kickflip host" data-tip="not on kickflip host">Open in VS Code<\/a>/);
  assert.deepEqual(rows(open).at(-1), ['Links', 'Open in VS Code']);
  assert.doesNotMatch(B.detail({ ...open, worktree: null }), /Open in VS Code/);
});

// docs/adr/2026-11-03-0526-a-follow-up-is-a-work-card-with-a-parent.md
test("the open card's details list shows Parent, Children, Related to, Blocked by and Waits on it as rows of tappable labels, leaving out empty rows; the workflow row has no follow-up Build", () => {
  const app = vm.createContext({ document: { addEventListener() {} }, CSS: { escape: (s) => s }, matchMedia: () => ({ matches: false }) });
  for (const file of ['ui.js', 'ui-links.js', 'ui-enums.js', 'ui-progress-bar.js', 'ui-cards.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), app);
  const B = { $: () => ({}), on() {}, store: {}, state: { board: { items: [] } }, seen: {}, thread: () => '', links: (key) => app.BoardUI.linkContext([], key) };
  app.BoardView = { part: (fn) => fn(B) };
  vm.runInContext(fs.readFileSync(new URL('./public/app-cards.js', import.meta.url), 'utf8'), app);
  const link = (ref) => ({ key: `w/GH-${ref.slice(1)}`, ref });
  const card = { ...workCard, pr: null, prs: [], reviewers: [], key: 'w/GH-93', ref: '#93', lane: 'todo', action: null, wave: { slug: 'w1', title: 'W' }, storedLane: 'todo', next: null, deps: ['GH-80'], manualSteps: [], holdable: true,
    parent: link('#53'), children: [link('#94'), link('#95')], related: [link('#75')], blockedBy: [link('#80')], waitsOnIt: [link('#99')] };
  const rows = (it) => [...B.detail(it).matchAll(/<dt[^>]*>(.*?)<\/dt><dd[^>]*>(.*?)<\/dd>/g)].map(([, k, v]) => [text(k), text(v)]);
  assert.deepEqual(rows(card), [['Wave', 'W'], ['Status', 'to do'], ['Parent', '#53'], ['Children', '#94 #95'], ['Related to', '#75'], ['Blocked by', '#80'], ['Waits on it', '#99']]);
  assert.deepEqual([...B.detail(card).matchAll(/<a class="card-link" href="([^"]*)">([^<]*)<\/a>/g)].map(([, href, ref]) => [href, ref]),
    [['#selectedCard=w%2FGH-53', '#53'], ['#selectedCard=w%2FGH-94', '#94'], ['#selectedCard=w%2FGH-95', '#95'], ['#selectedCard=w%2FGH-75', '#75'], ['#selectedCard=w%2FGH-80', '#80'], ['#selectedCard=w%2FGH-99', '#99']]);
  assert.deepEqual(rows({ ...card, parent: null, children: [], related: [], blockedBy: [], waitsOnIt: [] }), [['Wave', 'W'], ['Status', 'to do']]);
  // The Status row reads the card's lane and agent, never the wave file's stored lane
  // (docs/adr/2026-11-05-0410-a-card-status-word-comes-from-a-signal-the-board-checks.md).
  const bare = { ...card, storedLane: 'review', parent: null, children: [], related: [], blockedBy: [], waitsOnIt: [] };
  const testing = { progress: 'Testing · x', phase: 'testing', at: null };
  for (const [extra, want] of [
    [{ lane: 'progress', builder: testing }, 'implementing'],
    [{ lane: 'progress', builder: { ...testing, phase: 'landing' } }, 'landing'],
    [{ lane: 'progress', builder: { ...testing, alive: false, stale: true } }, 'stopped'],
    [{ lane: 'progress', builder: null, waitsOn: 'checking' }, 'Orchestrator review'],
    [{ lane: 'progress', builder: null, reachedPhase: 'testing' }, 'stopped at testing'],
    [{ lane: 'todo', builder: { progress: 'Grilling · x', planner: true, kind: 'grill' } }, 'grilling'],
    [{ lane: 'todo', grilling: true, planning: 'preheating' }, 'preheating'],
    [{ lane: 'todo', prototyping: true, planning: 'planning prototype' }, 'planning prototype'],
    [{ lane: 'todo', phase: 'discussing', turn: 'owner', planning: 'generating visual' }, 'generating visual'],
    [{ lane: 'todo', grilling: true }, 'to do'],
    [{ lane: 'todo', ready: true, phase: 'ready' }, 'ready'],
    [{ lane: 'review' }, 'in review'],
    [{ lane: 'done' }, 'done'],
  ]) assert.deepEqual(rows({ ...bare, ...extra }), [['Wave', 'W'], ['Status', want]], JSON.stringify(extra));
  assert.doesNotMatch(B.detail(card), /data-confirm="build"|Filed from|Waits on</);
  assert.deepEqual(lines(app.BoardUI.workLines({ ...card, linear: [], ticket: null })).slice(0, 2), ['Task Five', 'blocked by #80']);
  assert.doesNotMatch(app.BoardUI.workLines(card), /follow-up/);
});

test('the side pages wait out a board restart: a failed request, a 5xx or a body that is not JSON shows Board restarting… and retries with a growing backoff, until about limit ms', async () => {
  const answers = (list) => { const calls = []; return { calls, fetch: async (url) => { calls.push(url); const a = list.shift(); if (a instanceof Error) throw a; return { ok: a.status < 400, status: a.status, headers: new Headers({ 'x-kickflip-hub': '1' }), text: async () => a.body }; } }; };
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

// docs/adr/2026-11-06-0135-a-board-out-of-reach-keeps-its-copy-or-shows-a-landing.md
test('a failed board request reads as one of six states, each with its landing line and hint, from what the hub marks on its answer', () => {
  const answer = (status, headers = {}) => ({ status, headers: new Headers(headers) });
  const read = (r, online) => { const d = ui.downOf(r, online); return [d.state, d.line, d.hint]; };
  const back = 'This page comes back by itself.';
  assert.deepEqual(read(answer(502, { 'x-kickflip-down': 'code' })), ['restarting', 'Board restarting', `Its code changed. ${back}`]);
  assert.deepEqual(read(answer(502, { 'x-kickflip-down': 'starting' })), ['restarting', 'Board restarting', `It’s starting. ${back}`]);
  assert.deepEqual(read(answer(502, { 'x-kickflip-down': 'crashed' })), ['restarting', 'Board restarting', `It stopped, and the hub is starting it again. ${back}`]);
  assert.deepEqual(read(answer(502, { 'x-kickflip-down': 'stopped' })), ['stopped', 'Board stopped', 'Nothing answers on its port. Its Claude session has to start it.']);
  assert.deepEqual(read(answer(404, { 'x-kickflip-down': 'removed' })), ['removed', 'This board is gone', 'The hub no longer lists it.']);
  assert.deepEqual(read(answer(403, { 'x-kickflip-down': 'access' })), ['access', 'You no longer have access', 'Ask its owner to share it again.']);
  assert.equal(ui.downOf(answer(200, { 'x-app-shell': '1' })).state, 'access', 'a dropped share redirects the request to the shell at /');
  assert.deepEqual(read(answer(500, { 'x-kickflip-hub': '1' })), ['erroring', 'Board restarting', 'It answers with errors. Retrying for 30 seconds.']);
  assert.equal(ui.downOf(answer(200, { 'x-kickflip-hub': '1' })).state, 'erroring', 'a body that is not JSON');
  const offline = ['unreachable', 'Board offline', 'The hub, your connection or the host is down. Retrying.'];
  assert.deepEqual(read(null), offline, 'nothing answered, or the request timed out');
  assert.deepEqual(read(answer(502)), offline, 'an answer the hub never marked: Tailscale, with the hub down');
  assert.deepEqual(read(answer(502, { 'x-kickflip-down': 'code' }), false), offline, 'the device itself is offline');

  const html = ui.downLanding(ui.downOf(answer(502, { 'x-kickflip-down': 'stopped' })));
  assert.match(html, /class="down-landing" data-down="stopped"/);
  assert.match(html, /<img class="down-landing-mark" src="\/_hub\/kickflip.png"/);
  assert.deepEqual(text(html), 'Board stopped Nothing answers on its port. Its Claude session has to start it.');
  assert.equal(ui.downOf(answer(502, { 'x-kickflip-down': 'code' })).retries, true);
  assert.deepEqual(['removed', 'access'].map((d) => ui.downOf(answer(404, { 'x-kickflip-down': d })).retries), [false, false], 'nothing brings these back by itself');
  assert.equal(text(ui.copyNote('the notes', ago(0.2))), 'Copy of the notes as of 12 min ago. Read only.');
});

test('a side page request that keeps failing carries its state, and each wait names the state so far', async () => {
  const waits = [];
  const down = async () => ({ ok: false, status: 502, headers: new Headers({ 'x-kickflip-down': 'stopped' }), text: async () => 'down' });
  await assert.rejects(ui.fetchJSON('x', { fetch: down, sleep: async () => {}, limit: 1000, onWait: (ms, d) => waits.push(d.state) }), (e) => e.down.state === 'stopped');
  assert.deepEqual(waits, ['stopped', 'stopped']);
  await assert.rejects(ui.fetchJSON('x', { fetch: async () => { throw new TypeError('Failed to fetch'); }, sleep: async () => {}, limit: 0 }), (e) => e.down.state === 'unreachable');
});

test("offline, the board neither dims nor blocks reading: only the buttons that send are held, each keeping its label", () => {
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.offline main > \*\s*\{\s*opacity/);
  assert.doesNotMatch(css, /\.offline[^{]*\{[^}]*pointer-events:\s*none/);
  assert.doesNotMatch(css, /\.offline #compose\s*\{\s*display:\s*none/);
  assert.ok(css.includes(`.offline :is(${ui.SENDS})`), 'every sending button is held');
  assert.doesNotMatch(css, /Waits for the board/);
  assert.equal(ui.SENDS_LABELLED, undefined);
  for (const sel of ['button[data-edit]', 'a.button', 'button[data-lane-more]', 'button[data-thread-more]']) assert.equal(ui.SENDS.includes(sel), false, sel);
});

test('a tap on a held sending button tells onHeld and goes nowhere; a live board lets it through', () => {
  const handlers = {};
  const on = (root, type, fn) => { handlers[type] = fn; };
  let held = true;
  const told = [];
  ui.holdSends(on, {}, () => held, () => told.push('held'));
  const tap = (matches) => {
    const ev = { type: 'click', target: { closest: () => matches }, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() {} };
    handlers.click(ev);
    return ev.defaultPrevented;
  };
  assert.equal(tap(true), true);
  assert.equal(tap(false), false);
  held = false;
  assert.equal(tap(true), false);
  assert.deepEqual(told, ['held']);
  assert.equal(ui.WAITING, 'Waiting for the board to reconnect');
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
  const waiting = { key: 'w/A1', action: { kind: 'merge', url: '#selectedCard=w%2FA1', label: 'Merge' }, merging: false };
  assert.deepEqual(merge(waiting), ['Merge', false, true, true]);
  assert.deepEqual(merge({ key: 'w/A1', action: null, merging: true }), ['Merge', true, true, true]);
  assert.equal(merge({ key: 'w/A1', action: { kind: 'steps', url: '#selectedCard=w%2FA1', label: 'Run the manual steps, then merge' }, merging: false }), '');
  assert.equal(merge({ key: 'w/A1', action: null, merging: false }), '');
  assert.equal(merge(undefined), '');
});

// docs/adr/2026-11-06-0102-a-block-past-todo-bumps-a-build-and-holds-a-land.md
test('a blocked card shows its Merge disabled, its tooltip naming what blocks it', () => {
  const html = ui.mergeButton({ key: 'w/A1', action: null, merging: false, mergeBlocked: 'Blocked by #53' });
  assert.equal(text(html), 'Merge');
  assert.match(html, / disabled[ >]/);
  assert.match(html, /title="Blocked by #53"/);
  assert.doesNotMatch(html, /data-confirm/);
});

test("the Merge button keeps its colour from idle through the tap and the merge", () => {
  const cls = (it) => /class="([^"]*)"/.exec(ui.mergeButton(it))[1];
  const idle = { key: 'w/A1', action: { kind: 'merge', url: '#selectedCard=w%2FA1', label: 'Merge' }, resolvedBy: 'merge', merging: false };
  assert.equal(cls(idle), 'resolves');
  ui.pending.start('w/A1:merge', () => false);
  assert.equal(cls(idle), 'resolves');
  ui.pending.drop('w/A1:merge');
  assert.equal(cls({ key: 'w/A1', action: null, resolvedBy: null, merging: true }), 'resolves');
});

// docs/adr/2026-11-05-0300-implement-in-the-thread-queues-the-card-for-the-orchestrator.md
test("an open card's action row has no Implement, which lives in a Todo card's thread box, nor Grill or Prototype; a held card shows Unhold", () => {
  assert.equal(ui.buildButton, undefined);
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  assert.match(css, /button\.build\.ready[,\s][^{]*\{[^}]*--color-notice/);
  assert.doesNotMatch(css, /button\.build[,\s{]/);

  const app = vm.createContext({ document: { addEventListener() {} }, CSS: { escape: (s) => s }, matchMedia: () => ({ matches: false }) });
  for (const file of ['ui.js', 'ui-links.js', 'ui-enums.js', 'ui-progress-bar.js', 'ui-cards.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), app);
  const B = { $: () => ({}), on() {}, store: {}, state: { board: { items: [] } }, seen: {}, thread: () => '', links: (key) => app.BoardUI.linkContext([], key) };
  app.BoardView = { part: (fn) => fn(B) };
  vm.runInContext(fs.readFileSync(new URL('./public/app-cards.js', import.meta.url), 'utf8'), app);
  const todo = { ...workCard, pr: null, prs: [], reviewers: [], key: 'w/A1', lane: 'todo', action: null, actionButton: null, wave: { slug: 'w1', title: 'W' }, deps: [], manualSteps: [], holdable: true, hasNotes: true,
    try: { kind: 'web', script: true, changes: false }, buildable: true };
  const row = (it) => [...B.detail(it).match(/<div class="action-row workflow">(.*?)<\/div>/)[1].matchAll(/<button[^>]*>(.*?)<\/button>/g)].map(([, label]) => label);
  assert.deepEqual(row(todo), ['Hold']);
  const changed = { ...todo, try: { ...todo.try, changes: true } };
  assert.deepEqual(row(changed), ['Hold', 'Serve']);
  assert.deepEqual(row({ ...changed, ready: true }), ['Hold', 'Serve']);
  assert.deepEqual(row({ ...changed, lane: 'progress' }), ['Hold', 'Serve']);
  assert.deepEqual(row({ ...todo, held: true }), ['Unhold']);
  assert.deepEqual(row({ ...todo, held: true, buildable: false }), ['Unhold']);
  assert.doesNotMatch(B.detail({ ...todo, held: true, ready: true }), /data-confirm="card-build"/);
});

test('the working line reads thinking, in one shared class on the card and in the thread', () => {
  const ask = { kind: 'ask', key: 'ask:a1', id: 'a1', ref: '10:00', title: 'Fix it', internal: false, linear: [], pr: null, prs: [], deps: [], blockedBy: [], working: true, ask: { askedAt: ago(1) } };
  assert.match(ui.workLines(ask), /<div class="line3 sub agent"><span class="thinking">/);
  assert.match(ui.threadMessages([{ ts: ago(3), who: 'love', via: 'site', kind: 'item-message', text: 'Fix it', eventId: 'e1', reply: null, state: 'working', canDelete: true }]), /<div class="reply muted small"><span class="thinking">/);
});

test('a thread message says thinking while Claude works on it, and only a pending message can be deleted', () => {
  const html = ui.threadMessages([
    { ts: ago(3), who: 'love', via: 'site', kind: 'item-message', text: 'Fix it', eventId: 'e1', reply: null, state: 'working', canDelete: true },
    { ts: ago(2), who: 'love', via: 'site', kind: 'item-message', text: 'Old', eventId: 'e2', reply: null, state: 'answered', canDelete: false },
  ]);
  assert.match(text(html), /Fix it thinking… .* Old$/);
  assert.deepEqual([...html.matchAll(/data-withdraw="(\w+)"/g)].map((m) => m[1]), ['e1']);
});

// docs/adr/2026-11-06-1252-stale-is-automatic-stalled-is-the-orchestrators-flag.md
test('a stale builder has no badge and no nudge: its status line goes grey with its dot still, and the footer reads stale', () => {
  const builder = { progress: 'Running tests', at: null, stale: true };
  const html = ui.workLines({ ...workCard, lane: 'progress', stale: true, builder });
  assert.match(html, /<div class="line3 sub agent in-progress stale"><span class="working-dot" aria-hidden="true"><\/span>Running tests<\/div>/);
  assert.doesNotMatch(html, /<button[^>]*line3|data-confirm="nudge"|Stalled|tone-danger/);
  assert.match(html, /<span class="card-stale">stale<\/span>/);
  // docs/adr/2026-11-05-0410-a-card-status-word-comes-from-a-signal-the-board-checks.md: a builder whose process is gone
  // reads stopped in the same grey at once, and one whose live process went quiet keeps its words in grey, with no dot.
  assert.match(ui.workLines({ ...workCard, lane: 'progress', builder: { ...builder, alive: false } }), /<div class="line3 sub agent in-progress stale"><span class="working-dot" aria-hidden="true"><\/span>stopped · Running tests<\/div>/);
  const quiet = ui.workLines({ ...workCard, lane: 'progress', builder: { ...builder, stale: false, alive: true, quiet: true } });
  assert.match(quiet, /<div class="line3 sub agent in-progress quiet">Running tests<\/div>/);
  assert.doesNotMatch(quiet, /working-dot|stale/);
  for (const next of [{ ...builder, stale: false }, null]) assert.doesNotMatch(ui.workLines({ ...workCard, builder: next }), /stale/);
  assert.doesNotMatch(ui.workLines({ ...workCard, lane: 'done', builder }), /class="[^"]*\bstale\b/);
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  assert.match(css, /^\.sub\.agent\.stale \{ color: var\(--muted\); \}$/m);
  assert.match(css, /^\.card-stale \{ color: var\(--muted\); \}$/m);
  assert.match(css, /^\.card-stalled \{ color: var\(--color-danger\); \}$/m);
  assert.doesNotMatch(css, /nudg|button\.sub/);
});

test('a card the orchestrator stalled reads red stalled rightmost on the row under its footer, after its Action needed, in place of stale', () => {
  const action = { kind: 'stalled', url: '#selectedCard=w%2FB5', label: 'stalled: Crashed twice' };
  const html = ui.workLines({ ...workCard, lane: 'progress', sortAt: ago(5), stale: true, stalled: 'Crashed twice', action });
  assert.match(html, /<div class="line6 sub card-alert"><a class="card-action" href="#selectedCard=w%2FB5" title="stalled: Crashed twice"[^>]*>Action needed<\/a><span class="sep"> · <\/span><span class="card-stalled">stalled<\/span><\/div>$/);
  assert.doesNotMatch(html, /card-stale"/);
  const review = ui.workLines({ ...workCard, lane: 'review', sortAt: ago(60 * 24 * 8), stale: true });
  assert.match(review, /<\/time><span class="sep"> · <\/span><span class="card-stale">stale<\/span>/);
});

// docs/adr/2026-11-05-1809-the-orchestrator-stops-the-boards-own-runs.md
test("a run the orchestrator stopped reads the stop's words as its status, plain, with no dot, and a stopped Merge land reads them in In Review", () => {
  const builder = { progress: 'Running tests', at: ago(1), stale: true, alive: false, silentSince: ago(0.05), stopped: 'build stopped by orchestrator' };
  const html = ui.workLines({ ...workCard, lane: 'progress', builder });
  assert.match(html, /<div class="line3 sub agent in-progress">build stopped by orchestrator · \d+m<\/div>/);
  assert.doesNotMatch(html, /working-dot|Running tests/);
  assert.equal(ui.statusWord({ ...workCard, lane: 'progress', builder }), 'build stopped by orchestrator');
  const review = ui.workLines({ ...workCard, lane: 'review', builder: null, next: 'Verified: tap Merge to land it on main', landStopped: { words: 'land stopped by orchestrator', at: ago(0.05) } });
  assert.match(review, /<div class="line3 sub">land stopped by orchestrator · \d+m<\/div>/);
});

test("a refused Implement's reason takes the card's status line, in place of its next step", () => {
  const reason = "Couldn't start implementing: it's held. Unhold it, then tap Implement.";
  const html = ui.workLines({ ...workCard, lane: 'todo', builder: null, next: 'Grill the notes', refusal: reason });
  assert.match(html, /<div class="line3 sub refused">Couldn&#39;t start implementing: it&#39;s held\. Unhold it, then tap Implement\.<\/div>/);
  assert.doesNotMatch(html, /Next: /);
});

// docs/adr/2026-11-06-0038-a-progress-bar-pulses-one-step-at-a-time.md
test("one progress bar draws every bar: count steps, done of them filled, the one running step at now pulsing, a percent filling the next, dim and tone", () => {
  const bar = (strip) => /<span[^>]*>(.*)<\/span>/.exec(ui.progressBar(strip))[1].match(/<i class="\w*"(?: style="[^"]*")?><\/i>/g).join('');
  assert.equal(ui.progressBar(null), '');
  assert.equal(ui.progressBar({ count: 3, done: 2, now: 1, label: 'B <2>' }),
    '<span class="phase-bars" role="img" aria-label="B &lt;2&gt;" title="B &lt;2&gt;"><i class="done"></i><i class="now"></i><i class=""></i></span>');
  assert.equal(ui.progressBar({ count: 3, done: 0, percent: 30, label: 'x' }),
    '<span class="phase-bars" role="img" aria-label="x" title="x"><i class="fill" style="--p:30%"></i><i class=""></i><i class=""></i></span>');
  assert.equal(bar({ count: 4, done: 4, label: 'x' }), '<i class="done"></i>'.repeat(4));
  assert.equal(bar({ count: 4, done: 0, label: 'x' }), '<i class=""></i>'.repeat(4));
  // A dimmed bar is written without its pulse, so the markup, not CSS, says nothing pulses.
  assert.equal(ui.progressBar({ count: 3, done: 2, now: 1, dim: true, label: 'x' }),
    '<span class="phase-bars dim" role="img" aria-label="x" title="x"><i class="done"></i><i class="done"></i><i class=""></i></span>');
  // now is one index, so a bar never draws two pulsing steps, whatever it is given.
  for (let count = 1; count <= 5; count++) {
    for (let done = 0; done <= count; done++) {
      for (const now of [undefined, ...Array.from({ length: count }, (_, i) => i)]) {
        for (const percent of [undefined, 40]) {
          const html = ui.progressBar({ count, done, now, percent, label: 'x' });
          assert.equal((html.match(/<i /g) || []).length, count);
          assert.ok((html.match(/class="now"/g) || []).length <= 1, html);
        }
      }
    }
  }
});

// docs/adr/2026-11-06-0038-a-progress-bar-pulses-one-step-at-a-time.md
test("every pulse beats on one clock: a pulse animation starting anywhere on the page is set to the document timeline's origin, so the bar's running step and its card's status dot blink together and a redraw never restarts the beat", () => {
  const anim = (animationName) => ({ animationName, startTime: 812 });
  for (const name of ['pulse', 'pulse-fill', 'sb-pulse', 'reader-pulse']) {
    const own = anim(name);
    const other = anim('spin');
    ui.onePulse({ animationName: name, target: { getAnimations: () => [own, other] } });
    assert.deepEqual([own.startTime, other.startTime], [0, 812], name);
  }
  const ping = anim('spin');
  ui.onePulse({ animationName: 'spin', target: { getAnimations: () => [ping] } });
  assert.equal(ping.startTime, 812, 'other animations keep their own start');
  const heard = [];
  const ctx = vm.createContext({ document: { addEventListener: (type, fn) => heard.push([type, fn]) } });
  vm.runInContext(fs.readFileSync(new URL('./public/ui-progress-bar.js', import.meta.url), 'utf8'), ctx);
  assert.deepEqual(heard.map(([type, fn]) => [type, fn === ctx.BoardUI.onePulse]), [['animationstart', true]]);
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
    [{ builder: { progress: null, phase: null, at: null } }, { dim: false, label: 'Starting, no step yet', bars: '- - - - -' }],
    [{ builder: { ...testing, phase: 'reading' } }, { dim: false, label: 'Reading, step 1 of 5', bars: 'now - - - -' }],
    [{ builder: testing }, { dim: false, label: 'Testing, step 3 of 5', bars: 'done done now - -' }],
    [{ builder: { ...testing, phase: 'landing' } }, { dim: false, label: 'Landing, step 5 of 5', bars: 'done done done done now' }],
    [{ builder: { ...testing, stale: true } }, { dim: true, label: 'Testing, step 3 of 5', bars: 'done done done - -' }],
    [{ waitsOn: 'checking' }, { dim: false, label: 'Orchestrator review, step 4 of 5', bars: 'done done done now -' }],
    [{ builder: { ...testing, phase: 'building' }, action: questions }, { dim: true, label: 'Building, step 2 of 5, waiting on your answers', bars: 'done done - - -' }],
    [{ reachedPhase: 'building', action: questions }, { dim: true, label: 'Stopped at building, step 2 of 5, waiting on your answers', bars: 'done done - - -' }],
    [{ reopened: true, reachedPhase: 'testing' }, { dim: true, label: 'Reopened, all 5 steps done', bars: 'done done done done done' }],
    [{ reachedPhase: 'landing', next: 'Fix the failing CI' }, { dim: true, label: 'Stopped at landing, step 5 of 5', bars: 'done done done done done' }],
    [{}, { dim: true, label: 'No step yet', bars: '- - - - -' }],
    [{ builder: { kind: 'install', progress: null, phase: null, at: null }, reachedPhase: 'landing' }, { dim: false, label: 'Stopped at landing, step 5 of 5', bars: 'done done done done done' }],
  ];
  for (const [extra, want] of cases) assert.deepEqual(strip({ ...card, ...extra }), want, JSON.stringify(extra));
  for (const off of [{ lane: 'todo', builder: testing }, { lane: 'done', reopened: false }, { lane: 'review' }, { builder: { ...testing, planner: true } }]) {
    assert.doesNotMatch(ui.workLines({ ...card, ...off }), /phase-bars/, JSON.stringify(off));
  }
  assert.match(ui.workLines(card, { unread: 1 }), /<\/time><span class="sep"> · <\/span><span class="phase-bars dim"[^>]*>.*<\/span><\/div><div class="line6 sub card-alert"><span class="card-unread">1 new message<\/span><\/div>/);
  const building = ui.workLines({ ...card, builder: testing }, { unread: 2 });
  assert.match(building, /<div class="line3 sub agent in-progress"><span class="working-dot" aria-hidden="true"><\/span>Testing · the limiter<\/div>/);
  assert.equal(building.match(/phase-bars/g).length, 1);
});

// docs/adr/2026-11-03-1551-planners-and-implementers-are-two-kinds-of-agent.md,
// docs/adr/2026-11-04-2300-each-lane-is-a-queue-for-the-orchestrator.md
test("a planner's line on a card is marked planner, keeping its dot, where a running grill or prototype draws no bar; a card owing a brief reads its word in the same blue line, with its dot, until the planner's line takes it", () => {
  const planner = { progress: 'Prototyping · the takes', kind: 'prototype', phase: null, at: null, planner: true };
  for (const [lane, tone] of [['todo', 'in-todo'], ['progress', 'in-progress']]) {
    const html = ui.workLines({ ...workCard, lane, sortAt: '2020-01-01T10:00:00.000Z', builder: planner });
    assert.match(html, new RegExp(`<div class="line3 sub agent planner ${tone}"><span class="working-dot" aria-hidden="true"></span>Prototyping · the takes</div>`));
    assert.doesNotMatch(html, /Building/);
  }
  // docs/adr/2026-11-11-1200-every-lane-has-phases.md: a Todo card's grill or prototype reads as its phase word instead.
  for (const kind of ['prototype', 'grill']) assert.doesNotMatch(ui.workLines({ ...workCard, lane: 'todo', sortAt: '2020-01-01T10:00:00.000Z', builder: { ...planner, kind } }), /phase-bars/);
  assert.doesNotMatch(ui.workLines({ ...workCard, lane: 'progress', sortAt: '2020-01-01T10:00:00.000Z', builder: planner }), /phase-bars/, 'no dashes in In Progress');
  const line = (it) => /<div class="line3 sub agent planner in-todo">.*?<\/span>([^<]*)<\/div>/.exec(ui.workLines({ ...workCard, lane: 'todo', sortAt: '2020-01-01T10:00:00.000Z', ...it }))?.[1];
  // docs/adr/2026-11-12-0600-every-planner-launches-from-the-orchestrators-brief.md
  const blue = (it) => /<div class="line3 sub agent planner"><span class="working-dot" aria-hidden="true"><\/span>([^<]*)<\/div>/.exec(ui.workLines({ ...workCard, lane: 'todo', sortAt: '2020-01-01T10:00:00.000Z', ...it }))?.[1];
  for (const word of ['preheating', 'planning prototype', 'planning visual', 'generating visual']) {
    assert.equal(blue({ planning: word, orchestrator: { kind: 'brief', since: '2020-01-01T10:00:00.000Z', picked: null, next: 'x' } }), word, 'before the wait on the orchestrator');
  }
  assert.equal(blue({ grilling: true }), undefined, 'a request alone reads no word');
  assert.doesNotMatch(ui.workLines({ ...workCard, lane: 'todo', sortAt: '2020-01-01T10:00:00.000Z', grilling: true }), /preheating/);
  assert.equal(line({ grilling: true }), undefined);
  assert.equal(line({ prototyping: true, planning: 'planning visual', builder: planner }), 'Prototyping · the takes', "a running planner's line wins");
  assert.equal(line({}), undefined);
});

// docs/adr/2026-11-04-2300-each-lane-is-a-queue-for-the-orchestrator.md
test("a card idle on the orchestrator reads waiting for orchestrator with how long, then orchestrator review with its dot once picked up, in its lane's colour", () => {
  const minutes = (n) => new Date(Date.now() - n * 60000).toISOString();
  const status = (it) => /<div class="line3 sub agent ([\w -]+)">(.*?)<\/div>/.exec(ui.workLines({ ...workCard, sortAt: '2020-01-01T10:00:00.000Z', ...it }))?.slice(1);
  const waiting = { kind: 'calls', since: minutes(14), picked: null, next: 'x' };
  assert.deepEqual(status({ lane: 'progress', waitsOn: 'checking', orchestrator: waiting }), ['in-progress waiting-gray', 'waiting for orchestrator · 14m']);
  assert.deepEqual(status({ lane: 'progress', waitsOn: 'checking', orchestrator: { ...waiting, picked: minutes(3) } }),
    ['in-progress', '<span class="working-dot" aria-hidden="true"></span>orchestrator review · 3m']);
  // A usage pause reads paused in gray, picked up or not, on the card and in a thread's pick-up line.
  ui.usagePause = () => ({ state: 'paused' });
  assert.deepEqual(status({ lane: 'progress', waitsOn: 'checking', orchestrator: { ...waiting, picked: minutes(3) } }),
    ['in-progress waiting-gray', '<span class="paused">paused</span> · 3m']);
  assert.match(ui.threadMessages([{ ts: '2020-01-01T10:00:00Z', who: 'love', kind: 'item-message', text: 'x', eventId: 'e1', state: 'working' }]), /<span class="paused">paused<\/span>/);
  ui.usagePause = null;
  assert.deepEqual(status({ lane: 'todo', refusal: 'Couldn’t start', orchestrator: { ...waiting, kind: 'refused' } }), ['in-todo waiting-gray', 'waiting for orchestrator · 14m']);
  // docs/adr/2026-11-05-0802-todo-has-no-queue.md: an Implement message's card waits like any other.
  assert.deepEqual(status({ lane: 'progress', orchestrator: { ...waiting, kind: 'implement' } }), ['in-progress waiting-gray', 'waiting for orchestrator · 14m']);
  // A running builder keeps its own line while its ask waits.
  assert.deepEqual(status({ lane: 'progress', builder: { progress: 'Testing · x', phase: 'testing', at: minutes(2) }, orchestrator: { ...waiting, kind: 'ask' } }),
    ['in-progress', '<span class="working-dot" aria-hidden="true"></span>Testing · x · 2m']);
  // docs/adr/2026-11-06-0200-the-board-rebases-a-conflicting-pr-with-a-headless-run.md: a rebase run's hand-back, In
  // Review, reads its own failure line above the wait.
  const failed = ui.workLines({ ...workCard, sortAt: '2020-01-01T10:00:00.000Z', lane: 'review', waitsOn: 'checking', orchestrator: waiting, rebaseFailed: 'Rebase failed in 2 files · <both sides>' });
  assert.match(failed, /<div class="line3 sub">Rebase failed in 2 files · &lt;both sides&gt;<\/div><div class="line3 sub agent in-review waiting-gray">waiting for orchestrator · 14m<\/div>/);
});

// docs/adr/2026-11-06-0145-every-run-takes-its-lanes-colour.md
test("a run's line, dot and bar take its card's lane colour: grey in Todo, orange in In Progress, blue in In Review, where a rebase run is a line with no bar", () => {
  const at = new Date(Date.now() - 2 * 60000).toISOString();
  const lineClass = (it) => /<div class="line3 sub agent([\w -]*)">/.exec(ui.workLines({ ...workCard, sortAt: '2020-01-01T10:00:00.000Z', ...it }))?.[1].trim();
  const rebase = { ...workCard, sortAt: '2020-01-01T10:00:00.000Z', lane: 'review', builder: { progress: 'Rebasing onto main', phase: null, at } };
  assert.equal(lineClass(rebase), 'in-review');
  assert.doesNotMatch(ui.workLines(rebase), /phase-bars/);
  assert.equal(lineClass({ lane: 'review', waitsOn: 'checking', orchestrator: { kind: 'calls', since: at, picked: at, next: 'x' } }), 'in-review');
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  const rule = (selector) => new RegExp(`(^|\\n)${selector.replace(/[.()]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)?.[2].trim();
  assert.equal(rule('.sub.agent.in-todo'), 'color: var(--muted);');
  assert.equal(rule('.sub.agent.in-progress'), 'color: var(--color-notice);');
  assert.equal(rule('.sub.agent.in-review'), 'color: var(--color-info);');
  // One pulse for every bar, in the bar's own fill.
  assert.match(css, /@keyframes pulse-fill \{ 50% \{ background-color: color-mix\(in srgb, var\(--bar-fill\) 35%, transparent\); \} \}/);
  assert.doesNotMatch(css, /pulse-fill-plan|\.phase-bars\.plan/);
});

test("a builder line shows the progress and its age, not who is building", () => {
  const at = new Date(Date.now() - 4 * 60000).toISOString();
  assert.equal(ui.builderLine({ label: 'Opus builder', progress: 'Testing · the limiter', at }), 'Testing · the limiter · 4m');
  assert.equal(ui.builderLine({ label: 'Opus builder', progress: null, at }), 'starting · 4m');
  assert.equal(ui.builderLine({ label: 'Opus builder', progress: null, at: null }), 'starting');
  assert.equal(ui.builderLine({ progress: null, at, alive: false }), 'stopped · 4m');
  assert.equal(ui.builderLine({ progress: 'Testing · x', at, quiet: true }), 'Testing · x · 4m');
  assert.equal(ui.builderLine({ label: null, progress: 'Making changes', at: null }), 'Making changes');
});

test("a New card reads its ticket chip and its first line, then whether it was moved or edited and whether Claude has started, with bump, edit and delete and no Action needed, and ends with when it was sent", () => {
  const sent = ago(1);
  const card = (ask, extra = {}) => ui.workLines({ kind: 'work', id: 'T-3', key: 'w/T-3', ref: 'T-3', internal: true, isNew: true, title: 'Fix <it>', linear: [], pr: null, prs: [], deps: [], blockedBy: [], created: sent, updatedAt: sent, sortAt: sent,
    bumpedAt: ask.bumpedAt || null, ask: { eventId: 'a1', askedAt: sent, canEdit: true, text: 'Fix <it>\nand more', files: [], ...ask }, ...extra });
  const at = ui.cardTime(sent);
  // docs/adr/2026-11-07-0115-the-orchestrator-sorts-new-tasks-itself.md: grey "waiting…", its dot still, until the
  // orchestrator picks the task up, then the blue "thinking…".
  assert.deepEqual(lines(card({ state: 'waiting' })), ['T-3 Fix <it>', 'waiting…', at]);
  assert.match(card({ state: 'waiting' }), /<span class="pickup-wait"><span class="working-dot" aria-hidden="true"><\/span>waiting…<\/span>/);
  assert.doesNotMatch(card({ state: 'waiting' }), /class="thinking"/);
  assert.deepEqual(lines(card({ state: 'working', bumpedAt: ago(0.5), edited: true })), ['T-3 Fix <it>', 'Edited · thinking…', at]);
  // docs/adr/2026-11-09-1900-every-ask-is-a-task-card-from-the-moment-it-arrives.md: it bumps as a card, and edits and deletes its ask.
  assert.deepEqual([...card({ state: 'waiting' }).matchAll(/data-(card-bump="w\/T-3"|edit="a1"|withdraw="a1")/g)].map((m) => m[1].split('=')[0]), ['card-bump', 'edit', 'withdraw']);
  assert.match(card({ state: 'waiting', bumpedAt: ago(0.5) }), /class="ghost icon bumped" data-card-bump="w\/T-3" data-bumped aria-pressed="true" aria-label="Unbump"/);
  assert.doesNotMatch(card({ state: 'waiting' }), /bumped/);
  assert.doesNotMatch(card({ state: 'waiting' }), /Action needed/);
  assert.deepEqual(lines(card({ state: 'waiting', from: 'Orch' })), ['T-3 Fix <it>', 'Moved from Orch · waiting…', at]);
  const asked = card({ state: 'waiting' }, { next: 'Answer 1 question', action: { kind: 'questions', url: 'questions.html#mv', label: 'Answer 1 question' } });
  assert.deepEqual(lines(asked), ['T-3 Fix <it>', 'Next: Answer 1 question', at, 'Action needed']);
});

const lines = (html) => html.split('<div class="line').slice(1).map((l) => text('<div class="line' + l));
const workCard = { kind: 'work', key: 'w/B5', id: 'B5', ref: 'B5', title: 'Five', internal: false, held: false, risky: false, threadCount: 4,
  linear: [{ id: 'ENG-1', url: 'https://linear.app/x/ENG-1' }], pr: { ...openPR, isDraft: true, status: 'draft' }, prs: [{ ...openPR, isDraft: true, status: 'draft' }], reviewers: ['Jamie'], review: { Jamie: { state: 'unsent' } },
  questions: null, builder: null, working: false, next: 'Waiting for PR reviewers' };

test('ticket badges use the board source, link out, and give a New card its ticket from the moment it lands', () => {
  for (const [source, id, url] of [['github', '#9', 'https://github.com/o/r/issues/9'], ['linear', 'ENG-9', 'https://linear.app/another/issue/ENG-9']]) {
    const card = { ...workCard, ticket: { source, id, url } };
    const html = ui.workLines(card);
    assert.match(html, new RegExp(`>${id.replace('#', '#')}<`));
    assert.ok(html.includes(`href="${url}"`));
    assert.ok(html.indexOf('target="_blank"') >= 0 && html.indexOf('target="_blank"') < html.indexOf('</a>'));
    assert.doesNotMatch(html, /ENG-1/);
    assert.match(ui.workLines({ ...card, isNew: true, ask: { eventId: 'a1', askedAt: ago(1), state: 'waiting' } }), new RegExp(`>${id}<`));
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
  assert.match(ui.workLines(blocked), /<div class="line6 sub card-time"><a class="card-blocked" href="#selectedCard=site%2FS2">blocked by INT-2<\/a><\/div>/);
  assert.match(ui.workLines({ ...blocked, blockedBy: [{ key: 'site/S1', ref: 'INT-1' }, { key: 'site/S2', ref: 'INT-2' }] }), />blocked by INT-1<\/a><span class="sep">, <\/span><a class="card-blocked" href="#selectedCard=site%2FS2">INT-2<\/a>/);
  assert.deepEqual(lines(ui.workLines({ ...blocked, blockedBy: [] })), ['INT-3 Five']);
  // docs/adr/2026-11-05-2358-nothing-waiting-on-the-orchestrator-is-missed.md: a condition and a reason read on the time line.
  const until = { ...blocked, blockedBy: [], blockedUntil: 'the CI run on main is green', blockReason: 'the suite is red <now>' };
  assert.deepEqual(lines(ui.workLines(until)), ['INT-3 Five', 'blocked until the CI run on main is green, the suite is red <now>']);
  assert.match(ui.workLines(until), /<div class="line6 sub card-time"><span class="card-blocked">blocked until the CI run on main is green, the suite is red &lt;now&gt;<\/span><\/div>/);
  assert.deepEqual(lines(ui.workLines({ ...until, blockReason: null })), ['INT-3 Five', 'blocked until the CI run on main is green']);
  assert.match(ui.workLines({ ...blocked, blockReason: 'shares the send bar' }), />blocked by INT-2<\/a><span class="card-blocked">, shares the send bar<\/span><\/div>/);
  assert.match(ui.workLines({ ...until, blockedBy: blocked.blockedBy }), />blocked by INT-2<\/a><span class="card-blocked"> and until the CI run on main is green, the suite is red &lt;now&gt;<\/span><\/div>/);
  // docs/adr/2026-11-05-0802-todo-has-no-queue.md: a bumped blocked card waits for the pull; held, it is blocked as before (below).
  assert.match(ui.workLines({ ...blocked, bumpedAt: '2026-11-05T10:00:00.000Z' }), /<a class="card-blocked" href="#selectedCard=site%2FS2">waits on INT-2<\/a>/);
  assert.deepEqual(lines(ui.workLines({ ...blocked, blockedBy: [], next: 'Answer 1 question', action: { kind: 'questions', url: 'questions.html#q1', label: 'Answer 1 question' } })),
    ['INT-3 Five', 'Next: Answer 1 question', 'Action needed']);
  // docs/adr/2026-11-03-0301-build-on-a-blocked-card-queues-it.md: no bumped badge; the bump icon fills orange and unbumps.
  const sortAt = ago(2);
  const waiting = { ...workCard, lane: 'todo', deps: ['S2'], blockedBy: [{ key: 'site/S2', ref: 'INT-2' }], bumpable: true, bumpedAt: ago(1), held: true, sortAt,
    action: { kind: 'questions', url: 'questions.html#q1', label: 'Answer 1 question' } };
  assert.deepEqual(lines(ui.workLines(waiting, { unread: 1 })), ['ENG-1 Five', 'Next: Waiting for PR reviewers', 'repo#7 ● CI ✓ Jamie ✗', `${ui.cardTime(sortAt)} · held · blocked by INT-2`, 'Action needed · 1 new message']);
  assert.match(ui.workLines(waiting), /<button class="ghost icon bumped" data-card-bump="w\/B5" data-bumped aria-pressed="true" aria-label="Unbump"/);
  assert.doesNotMatch(ui.workLines(waiting), /disabled|data-confirm="bump"/);
  assert.match(ui.workLines({ ...waiting, bumpedAt: null }), /<button class="ghost icon" data-card-bump="w\/B5" aria-pressed="false" aria-label="Bump to top"/);
  // The card an ask became, once sorted, reads as any task: Task where its ticket would be, and no asked line.
  const fromAsk = { kind: 'work', key: 'w/T-3', id: 'T-3', ref: 'T-3', title: 'Fix it', internal: false, linear: [], pr: null, prs: [], deps: [], blockedBy: [], working: true };
  assert.deepEqual(lines(ui.workLines(fromAsk)), ['Task Fix it', 'thinking…']);
  assert.deepEqual(lines(ui.workLines(fromAsk, { unread: 2 })), ['Task Fix it', 'thinking…', '2 new messages']);
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
  assert.deepEqual(lines(ui.workLines(card, { unread: 3 })).slice(-2), [ui.cardTime(sortAt), '3 new messages']);
  assert.match(ui.workLines(card, { unread: 3 }), /<div class="line6 sub card-alert"><span class="card-unread">3 new messages<\/span><\/div>$/);
  assert.doesNotMatch(text(ui.workLines(card)), /days? ago/);

  const held = { ...card, held: true };
  assert.deepEqual(lines(ui.workLines(held)), ['ENG-1 Five', `${ui.cardTime(sortAt)} · held`]);
  assert.match(ui.workLines(held), /<span class="card-hold"[^>]*>held<\/span>/);
  assert.deepEqual(lines(ui.workLines({ ...held, sortAt: null }, { unread: 1 })), ['ENG-1 Five', 'held', '1 new message']);
  const now = new Date();
  const at = (days, h, m) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, h, m);
  const clock = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?([AP]M)$/i, (_, x) => ` ${x.toLowerCase()}`);
  const until = (d) => ({ ...held, heldUntil: d.toISOString() });
  assert.deepEqual(lines(ui.workLines(until(at(2, 9, 0)), { unread: 2 })).slice(-2), [`${ui.cardTime(sortAt)} · held until ${at(2, 9, 0).toLocaleDateString([], { weekday: 'short' })} ${clock(at(2, 9, 0))}`, '2 new messages']);
  assert.equal(last(ui.workLines(until(at(0, 23, 59)))), `${ui.cardTime(sortAt)} · held until ${clock(at(0, 23, 59))}`);
  assert.equal(last(ui.workLines(until(at(6, 9, 0)))), `${ui.cardTime(sortAt)} · held until ${at(6, 9, 0).toLocaleDateString([], { weekday: 'short' })} ${clock(at(6, 9, 0))}`);
  assert.equal(last(ui.workLines(until(at(7, 9, 0)))), `${ui.cardTime(sortAt)} · held until ${at(7, 9, 0).toLocaleDateString([], { month: 'numeric', day: 'numeric' })}, ${clock(at(7, 9, 0))}`);
  assert.doesNotMatch(ui.workLines(until(at(2, 9, 0))), /class="chip[^"]*">held/);
});

// docs/adr/2026-11-03-0516-a-new-card-is-ready-grilling-or-prototyping.md
test("a ready card's time line reads ready in green after its hold and before its unread messages, and an unsorted work card shows its ticket, and the card an ask became shows its ticket chip from the moment it lands", () => {
  const sortAt = ago(24 * 2);
  const card = { ...workCard, lane: 'todo', pr: null, prs: [], reviewers: [], next: null, sortAt };
  const html = ui.workLines({ ...card, held: true, ready: true, phase: 'ready' }, { unread: 2 });
  assert.deepEqual(lines(html).slice(-2), [`${ui.cardTime(sortAt)} · held`, '2 new messages']);
  const open = ui.workLines({ ...card, ready: true, phase: 'ready' }, { unread: 2 });
  assert.deepEqual(lines(open).slice(-2), [`${ui.cardTime(sortAt)} · ready`, '2 new messages']);
  assert.match(open, /<span class="card-phase ph-success">ready<\/span><\/div><div class="line6 sub card-alert"><span class="card-unread">/);
  assert.doesNotMatch(ui.workLines(card), /card-phase/);
  assert.deepEqual(lines(ui.workLines({ ...card, unsorted: true }))[0], 'ENG-1 Five');
  assert.doesNotMatch(ui.workLines({ ...card, unsorted: true }), />New</);
  assert.doesNotMatch(ui.workLines(card), />New</);
  // docs/adr/2026-11-09-1900-every-ask-is-a-task-card-from-the-moment-it-arrives.md: the card an ask became reads New
  // with its ask's line until it is sorted, bumps as a card, and edits and deletes its ask.
  const arrived = { ...card, key: 'w/T-3', id: 'T-3', ref: 'T-3', internal: true, linear: [], unsorted: true, isNew: true, ask: { eventId: 'a7', state: 'waiting', canEdit: true, files: [] } };
  assert.deepEqual(lines(ui.workLines(arrived)).slice(0, 2), ['T-3 Five', 'waiting…']);
  assert.deepEqual([...ui.workLines(arrived).matchAll(/data-(card-bump|bump|edit|withdraw)="([^"]+)"/g)].map((m) => [m[1], m[2]]), [['card-bump', 'w/T-3'], ['edit', 'a7'], ['withdraw', 'a7']]);
});

// docs/adr/2026-11-06-1700-a-bump-marks-the-priority-through-every-lane.md
test('a bumped ready card the host holds reads held while host recovers, in grey', () => {
  const sortAt = ago(24 * 2);
  const card = { ...workCard, lane: 'todo', pr: null, prs: [], reviewers: [], next: null, sortAt, ready: true, phase: 'ready' };
  const held = ui.workLines({ ...card, bumpedAt: ago(1), hostHeld: true });
  assert.equal(lines(held).at(-1), `${ui.cardTime(sortAt)} · ready · held while host recovers`);
  assert.match(held, /<span class="card-host-held">held while host recovers<\/span>/);
  assert.doesNotMatch(ui.workLines(card), /host/);
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  assert.match(css, /^\.card-host-held, \.card-paused \{ color: var\(--muted\); \}$/m);
});

// docs/adr/2026-11-09-1300-a-card-pause-stops-its-builder-at-its-next-stopping-point.md
test('a paused build reads "pausing · <cause>" in orange, then "paused · <cause>" in grey, its bars dimmed at the phase it stopped at, in place of the block it names', () => {
  const sortAt = ago(40);
  const builder = { kind: 'claude', phase: 'building', progress: 'Building · Writing the limiter test', at: ago(3), alive: true, quiet: true, stale: false };
  const card = { ...workCard, lane: 'progress', pr: null, prs: [], reviewers: [], next: null, sortAt, deps: ['w/B1'], blockedBy: [{ key: 'w/B1', ref: '#61' }], blocked: true };
  const pausing = ui.workLines({ ...card, builder: { ...builder, pause: { cause: 'blocked', words: 'blocked by #61', paused: false } } });
  assert.match(lines(pausing).at(-1), new RegExp(`^${ui.cardTime(sortAt)} · pausing · blocked by #61 ·`));
  assert.match(pausing, /<span class="card-pausing">pausing · blocked by #61<\/span><span class="sep"> · <\/span><span class="phase-bars dim"/);
  assert.match(pausing, /Building · Writing the limiter test/, 'its progress line stays');
  assert.doesNotMatch(pausing, /working-dot/);
  const paused = ui.workLines({ ...card, builder: { ...builder, held: true, alive: null, pause: { cause: 'blocked', words: 'blocked by #61', paused: true } } });
  assert.match(paused, /<span class="card-paused">paused · blocked by #61<\/span>/);
  assert.match(paused, /aria-label="Building, step 2 of 5"/);
  const awake = { ...builder, quiet: false };
  assert.match(ui.workLines({ ...card, builder: { ...awake, pause: { cause: 'blocked', words: 'blocked by #61', paused: false } } }), /<span class="phase-bars"/, 'a pausing build runs on, its bars lit');
  const pausedAwake = ui.workLines({ ...card, builder: { ...awake, pause: { cause: 'blocked', words: 'blocked by #61', paused: true } } });
  assert.match(pausedAwake, /<span class="phase-bars dim"[^>]*aria-label="Building, step 2 of 5"/, 'a paused build dims its bars at the phase it stopped at');
  assert.equal(ui.statusWord({ ...card, builder: { ...builder, pause: { paused: true } } }), 'paused');
  assert.equal(ui.statusWord({ ...card, builder: { ...builder, pause: { paused: false } } }), 'pausing');
  const held = ui.workLines({ ...card, blockedBy: [], blocked: false, held: true, builder: { ...builder, pause: { cause: 'held', words: 'held', paused: true } } });
  assert.match(lines(held).at(-1), new RegExp(`^${ui.cardTime(sortAt)} · paused · held ·`), 'the hold reads once');
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  assert.match(css, /^\.card-pausing \{ color: var\(--color-notice\); \}$/m);
});

// docs/adr/2026-11-12-0500-a-new-task-is-a-conversation.md
test("a discussing card's time line says whose turn it is: blue for the owner's, orange for Claude's", () => {
  const sortAt = ago(24 * 2);
  const card = { ...workCard, lane: 'todo', pr: null, prs: [], reviewers: [], next: null, sortAt, phase: 'discussing' };
  const yours = ui.workLines({ ...card, turn: 'owner' }, { unread: 1 });
  assert.deepEqual(lines(yours).slice(-2), [`${ui.cardTime(sortAt)} · discussing`, '1 new message']);
  assert.match(yours, /<span class="card-phase ph-info">discussing<\/span>/);
  assert.match(ui.workLines({ ...card, turn: 'claude' }), /<span class="card-phase ph-quiet">discussing<\/span>/);
  assert.equal(ui.statusWord(card), 'discussing');
});

// docs/adr/2026-11-07-0700-staging-then-ready.md
test("a staging card's time line reads staging in orange where ready reads, and its Status row says staging", () => {
  const sortAt = ago(24 * 2);
  const card = { ...workCard, lane: 'todo', pr: null, prs: [], reviewers: [], next: null, sortAt, staging: true, phase: 'staging' };
  const html = ui.workLines(card, { unread: 1 });
  assert.deepEqual(lines(html).slice(-2), [`${ui.cardTime(sortAt)} · staging`, '1 new message']);
  assert.match(html, /<span class="card-phase ph-notice">staging<\/span><\/div>/);
  assert.doesNotMatch(ui.workLines({ ...card, held: true }), /card-phase/);
  assert.doesNotMatch(html, /ph-success/);
  assert.equal(ui.statusWord(card), 'staging');
  assert.equal(ui.statusWord({ ...card, staging: false, ready: true, phase: 'ready' }), 'ready');
  assert.match(fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8'), /\.card-phase\.ph-notice \{ color: var\(--color-notice\); \}/);
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
    const going = 'serving…';
    const failed = 'serve failed';
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
    assert.match(error, /tone-danger.*href="#selectedCard=w%2FB5"/);
    assert.equal(render({ ...card, try: { kind } }), '');
    assert.equal(render({ ...card, lane: 'done' }), '');
  }
});

test('try buttons show only while Auto-build is off on a branch with changes, explain an app’s running and current runs, and offer Retry after failure only on scripted work cards', () => {
  for (const kind of ['web', 'app']) {
    const card = { ...workCard, kind: 'work', try: { kind, script: true, changes: true, autoBuild: false } };
    assert.equal(text(ui.tryButton(card)), 'Serve');
    assert.equal(ui.tryButton({ ...card, try: { ...card.try, changes: false } }), '');
    for (const state of [undefined, 'failed', ...kind === 'app' ? ['ready'] : []]) assert.equal(ui.tryButton({ ...card, try: { ...card.try, state, stale: true, autoBuild: true } }), '');
    for (const [change, reason] of kind === 'app' ? [[{ state: 'running' }, 'Serving now.'], [{ state: 'ready' }, 'Nothing new to']] : []) {
      const html = ui.tryButton({ ...card, try: { ...card.try, ...change } });
      assert.match(html, /aria-disabled="true"/);
      assert.ok(html.includes(reason));
    }
    assert.equal(text(ui.tryButton({ ...card, try: { ...card.try, state: 'failed' } })), 'Retry');
    assert.equal(text(ui.tryButton({ ...card, try: { ...card.try, state: 'ready', stale: true } })), kind === 'app' ? 'Serve' : 'Kill');
    assert.equal(ui.tryButton({ ...card, kind: 'ask' }), '');
    assert.equal(ui.tryButton({ ...card, try: { ...card.try, script: false } }), '');
  }
});

test('a web card whose serve is running or up shows Kill in place of Serve, whatever Auto serve and its changes say', () => {
  const card = { ...workCard, kind: 'work', try: { kind: 'web', script: true, changes: true, autoBuild: false } };
  for (const change of [{ state: 'running' }, { state: 'ready' }, { state: 'ready', stale: true }, { state: 'ready', autoBuild: true, changes: false }]) {
    const html = ui.tryButton({ ...card, try: { ...card.try, ...change } });
    assert.equal(text(html), 'Kill');
    assert.match(html, new RegExp(`data-try-kill="${card.key}"`));
    assert.doesNotMatch(html, /aria-disabled/);
  }
  assert.equal(text(ui.tryButton({ ...card, try: { ...card.try, state: 'failed' } })), 'Retry');
  assert.equal(text(ui.tryButton({ ...card, try: { ...card.try, kind: 'app', state: 'ready', stale: true } })), 'Serve');
  assert.equal(ui.tryButton({ ...card, try: { ...card.try, state: 'failed', autoBuild: true } }), '');
});

test('main is a slim branch bar with a ready link, running status or failed log button', () => {
  assert.equal(ui.mainBar(null), '');
  for (const kind of ['web', 'app']) {
    const main = { kind, slug: 'owner/repo', branch: 'develop', sha: '1234567', at: ago(2), state: 'ready', url: kind === 'web' ? null : 'https://m/main.apk', port: kind === 'web' ? 8500 : null };
    assert.ok(ui.mainBar(main).includes(`href="${kind === 'web' ? 'https://mac.ts.net:8500/' : 'https://m/main.apk'}"`));
    assert.match(ui.mainBar(main), /tb-main.*owner\/repo.*<strong>develop<\/strong>@<code>1234567<\/code> <span class="muted">2h<\/span>/);
    assert.equal(text(ui.mainBar(main)).includes(kind === 'web' ? 'Visit' : 'Install'), true);
    assert.match(ui.mainBar({ ...main, state: 'running' }), /role="status"/);
    assert.doesNotMatch(ui.mainBar({ ...main, state: 'running' }), /href=|<button/);
    assert.match(ui.mainBar({ ...main, state: 'failed' }), /<button[^>]*data-main-log=""[^>]*aria-haspopup="dialog"/);
  }
});

test('while main re-serves or after its new build failed, the bar names the old server’s commit and keeps Visit to it, with Updating… or Update failed on row 2', () => {
  const main = { kind: 'web', slug: 'owner/repo', branch: 'main', sha: '58818ab', at: ago(1), state: 'running', url: null, port: 8500, serving: { sha: '54837cd', at: ago(9) } };
  const rebuilding = ui.mainBar(main);
  assert.match(rebuilding, /@<code>54837cd<\/code> <span class="muted">9h<\/span>/);
  assert.match(rebuilding, /<div class="meta"><span[^>]*role="status"[^>]*><span class="try-spin"[^>]*><\/span>Updating…<\/span><\/div><\/div><\/div>$/);
  assert.match(rebuilding, /<div class="meta"><a[^>]*href="https:\/\/mac\.ts\.net:8500\/"/);
  assert.ok(text(rebuilding).indexOf('Visit') < text(rebuilding).indexOf('Updating…'));
  const failed = ui.mainBar({ ...main, state: 'failed' });
  assert.match(failed, /@<code>54837cd<\/code>/);
  assert.match(failed, /<button[^>]*data-main-log=""[^>]*>Update failed<\/button><\/div><\/div><\/div>$/);
  assert.match(failed, /<div class="meta"><a[^>]*href="https:\/\/mac\.ts\.net:8500\/"/);
  // With no old server left (a hub restart, or a build on the old server's port), the bar is as before.
  assert.doesNotMatch(ui.mainBar({ ...main, port: null, serving: null }), /href=/);
  assert.match(ui.mainBar({ ...main, port: null, serving: null }), /@<code>58818ab<\/code>/);
});

test("a local board's Main has a refresh icon right of its timestamp that spins while a pull runs and turns red with the reason when one fails", () => {
  const main = { kind: 'web', slug: 'owner/repo', branch: 'main', sha: '1234567', at: ago(2), state: 'ready', url: null, port: 8500 };
  assert.doesNotMatch(ui.mainBar({ ...main, pull: null }), /data-main-pull/);
  const idle = ui.mainBar({ ...main, pull: { running: false, error: null } });
  assert.match(idle, /<\/code> <span class="muted">[^<]+<\/span><span class="main-pull"><button class="ghost gh-refresh" type="button" data-main-pull aria-label="Pull main now"><svg/);
  assert.doesNotMatch(idle, /role="tooltip"/);
  assert.equal(text(idle).includes('Visit'), true);
  ui.pending.start('main:pull', () => false);
  const tapped = ui.mainBar({ ...main, pull: { running: false, error: null } });
  ui.pending.drop('main:pull');
  for (const html of [ui.mainBar({ ...main, pull: { running: true, error: null } }), tapped]) {
    assert.match(html, /class="ghost gh-refresh spinning" type="button" data-main-pull aria-label="Pulling main" aria-disabled="true"/);
    assert.equal(text(html).includes('Visit'), true);
  }
  const failed = ui.mainBar({ ...main, pull: { running: false, error: 'can’t pull: local changes' } });
  assert.match(failed, /class="ghost gh-refresh failed" type="button" data-main-pull aria-label="can’t pull: local changes"/);
  assert.match(failed, /<span class="main-pull-why" role="tooltip">can’t pull: local changes<\/span>/);
  assert.match(ui.mainBar({ ...main, pull: { running: false, error: 'x' } }, { open: true }), /class="main-pull-why open"/);
});

test('Todo offers Plan waves in the Show more style once two cards are free, with their keys', () => {
  const todo = [{ key: 'w/A1', kind: 'work' }, { key: 'w/ENG-1', kind: 'work' }, { key: 'v/B2', kind: 'work', blockedBy: [] }, { key: 'v/C3', kind: 'work', held: true }, { key: 'v/D4', kind: 'work', blockedBy: [{ ref: 'A1' }], blocked: true }, { key: 'v/E5', kind: 'work', blockedBy: [], blockedUntil: 'x', blocked: true }, { key: 'ask:n1', kind: 'ask' }];
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
  const order = (html) => [...html.matchAll(/data-(card-bump|edit|withdraw)="/g)].map((m) => m[1]);
  const fresh = { kind: 'work', id: 'T-3', key: 'w/T-3', isNew: true, ask: { eventId: 'a1', state: 'waiting', canEdit: true } };
  assert.deepEqual(order(ui.askActions(fresh)), ['card-bump', 'edit', 'withdraw']);
  const html = ui.threadMessages([{ ts: ago(1), who: 'love', via: 'site', kind: 'item-message', text: 'Fix it well', edited: true, eventId: 'e1', reply: null, state: 'waiting', canDelete: true, canEdit: true }]);
  assert.deepEqual(order(html), ['edit', 'withdraw']);
  assert.match(text(html), /^You · Edited · .* Fix it well waiting…$/);
  const moved = ui.threadMessages([{ ts: ago(1), who: 'love', via: 'ask', kind: 'ask', text: 'Swipe the gallery', moved: true, eventId: 'a1', reply: null, state: 'answered' }]);
  assert.match(text(moved), /^You · Moved · .* Swipe the gallery$/);
});

test('a builder status line, and an agent starting or finishing, reads as one line with its time and no author or actions, a running agent with its ETA', () => {
  const html = ui.threadMessages([{ ts: ago(1), who: 'claude', kind: 'status', text: 'Codex: <b>Running</b> tests' }]);
  assert.match(html, /class="msg status-line builder-status">/);
  assert.match(text(html), /^Codex: <b>Running<\/b> tests · \S/);
  assert.doesNotMatch(html, /class="who"|data-withdraw|data-edit/);
  const agents = ui.threadMessages([
    { ts: ago(1), who: 'claude', kind: 'agent', text: 'Codex started', finished: false, eta: new Date(Date.now() + 3600000).toISOString() },
    { ts: ago(0.8), who: 'claude', kind: 'agent', text: 'Opus builder started', finished: false, eta: null },
    { ts: ago(0.5), who: 'claude', kind: 'agent', text: 'Opus builder <b>finished</b>', finished: true, eta: null },
  ]);
  const dot = '<span class="mark" aria-hidden="true"><span class="agent-dot"><\\/span><\\/span>';
  assert.match(agents, new RegExp(`^<div class="msg status-line agent started">${dot}Codex started`));
  assert.match(agents, new RegExp(`<div class="msg status-line agent started">${dot}Opus builder started`));
  assert.match(agents, new RegExp(`<div class="msg status-line agent finished">${dot}Opus builder &lt;b&gt;finished`));
  assert.match(text(agents), /^Codex started · \S.* · ETA about .+ Opus builder started · [^·]+ Opus builder <b>finished<\/b> · [^·]+$/);
  assert.doesNotMatch(agents, /class="who"|data-withdraw|data-edit/);
  const planner = ui.threadMessages([
    { ts: ago(1), who: 'claude', kind: 'agent', text: 'Claude Sonnet prototype started', finished: false, eta: null, planner: true },
    { ts: ago(0.8), who: 'claude', kind: 'status', text: 'Reading: the notes', planner: true },
  ]);
  assert.match(planner, /<div class="msg status-line agent started planner"><span class="mark" aria-hidden="true"><span class="agent-dot"><\/span><\/span>Claude Sonnet prototype started/);
  assert.match(planner, /<div class="msg status-line builder-status planner"><span class="mark" aria-hidden="true"><span class="working-dot"><\/span><\/span>Reading: the notes/);
  // A bare Grill or Prototype tap, and a New task sent with Implement, are a muted request entry, not a message from the
  // owner, led by its icon in the same box as the dots; a Full person's names them
  // (docs/adr/2026-11-06-0021-a-button-without-a-text-box-posts-a-keyed-status-line.md).
  const requests = ui.threadMessages([
    { ts: ago(2), who: 'love', via: 'site', kind: 'grill-more', request: true, text: 'Grill requested', eventId: 'g1', state: 'waiting', files: [] },
    { ts: ago(1), who: 'love', via: 'site', kind: 'prototype-request', request: true, text: 'Prototype requested', eventId: 'p1', state: 'waiting', files: [] },
    { ts: ago(0.5), who: 'love', kind: 'command', command: 'implement', request: true, mark: 'Implementation requested', text: 'Implementation requested', by: 'Dana Reyes' },
  ]);
  assert.match(requests, new RegExp(`^<div class="msg status-line request"><span class="mark" aria-hidden="true">${ui.MARK_ICONS['Grill requested']}</span>Grill requested <span class="muted">· [^<]+</span></div><div class="msg status-line request"><span class="mark" aria-hidden="true">${ui.MARK_ICONS['Prototype requested'].replace(/[.*+?()[\]]/g, '\\$&')}</span>Prototype requested <span class="muted">`));
  assert.ok(requests.includes(`<div class="msg status-line request"><span class="mark" aria-hidden="true">${ui.MARK_ICONS['Implementation requested']}</span>Implementation requested <span class="muted">· Dana Reyes · `));
  // docs/adr/2026-11-05-2331-a-sent-answer-is-resolved-in-place-until-the-page-reloads.md: a reopened question's line
  // varies with its number, so it names its mark.
  const reopened = ui.threadMessages([{ ts: ago(0.2), who: 'love', kind: 'question-reopen', request: true, mark: 'question reopened', text: 'Question 2 was reopened' }]);
  assert.ok(ui.MARK_ICONS['question reopened']);
  assert.ok(reopened.startsWith(`<div class="msg status-line request"><span class="mark" aria-hidden="true">${ui.MARK_ICONS['question reopened']}</span>Question 2 was reopened <span class="muted">`));
  assert.doesNotMatch(requests, /class="who"|waiting…|data-event/);
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.msg\.request \{[^}]*color: var\(--muted\)/);
  // One fixed box for every mark, so the text starts at the same place.
  assert.match(css, /\.mark \{[^}]*width: 18px;[^}]*margin-right: 5px/);
  // The calls line's summary drops the native marker so its caret is the mark; the list starts at the text's edge, with no per-line margin.
  assert.match(css, /\.msg\.calls summary \{[^}]*list-style: none/);
  assert.match(css, /\.msg\.calls ol \{[^}]*padding-left: 23px/);
});

// docs/adr/2026-11-04-2130-a-button-tap-is-a-status-line-or-a-message-footer.md
test("a request with text, a question's prototype request and an answer are the owner's message with the tap's status in the footer, waiting… to its right until Claude picks it up; a folded submit of answers carries one footer", () => {
  const msg = (extra) => ({ ts: ago(1), who: 'love', via: 'site', kind: 'prototype-request', text: 'Phone width first', eventId: 'p1', state: 'waiting', files: [], status: 'Prototype requested', ...extra });
  const foot = (html) => /<div class="reply muted small">(.*?)<\/div>/s.exec(html)?.[1];
  const status = (words) => `<span class="foot-status"><span class="mark" aria-hidden="true">${ui.MARK_ICONS[words]}</span>${words}</span>`;
  assert.equal(foot(ui.threadMessages([msg()])), `${status('Prototype requested')}waiting…`);
  assert.match(ui.threadMessages([msg()]), /<div class="body">Phone width first<\/div>/);
  assert.equal(foot(ui.threadMessages([msg({ state: 'answered' })])), status('Prototype requested'));
  assert.match(foot(ui.threadMessages([msg({ state: 'working' })])), /^<span class="foot-status">.*Prototype requested<\/span><span class="thinking">/);
  assert.equal(foot(ui.threadMessages([msg({ kind: 'grill-more', status: 'Grill requested' })])), `${status('Grill requested')}waiting…`);
  const answer = (id, ts) => ({ ts, who: 'love', via: 'questions', kind: 'owner-answer', text: `${id}?\n→ A`, eventId: id, state: 'waiting', files: [], status: 'answers submitted' });
  const submit = { ...answer('a1', ago(1)), text: 'a1?\n→ A\n\na2?\n→ B', answers: [{ eventId: 'a1', state: 'waiting', text: 'a1?\n→ A' }, { eventId: 'a2', state: 'waiting', text: 'a2?\n→ B' }] };
  const folded = ui.threadMessages([submit]);
  assert.equal(folded.match(/class="msg love"/g).length, 1);
  assert.equal(folded.match(/answers submitted/g).length, 1);
  assert.match(folded, /a1\?\n→ A\n\na2\?\n→ B/);
  assert.equal(foot(folded), `${status('answers submitted')}waiting…`);
  // Answers that were submitted apart each draw their own footer.
  assert.equal(ui.threadMessages([answer('a1', ago(2)), answer('a2', ago(1))]).match(/answers submitted/g).length, 2);
  // A member's reply draws under the message, quoting its own answer.
  const replied = ui.threadMessages([{ ...submit, answers: [submit.answers[0], { ...submit.answers[1], state: 'replied', reply: { html: 'Done B', at: ago(0) } }] }]);
  assert.match(replied, /<blockquote class="quote">a2\?\n→ B<\/blockquote>/);
  assert.doesNotMatch(replied, /<blockquote class="quote">a1/);
  // An owner message with no tap behind it keeps its plain footer.
  assert.equal(foot(ui.threadMessages([msg({ kind: 'item-message', status: undefined })])), 'waiting…');
});

test("a card's open questions asked since it was last seen are one blue line in its thread, with a plain question mark, linking to the first", () => {
  const questions = { first: 'q 1', askedAt: ['2026-11-04T10:00:00Z', '2026-11-04T11:00:00Z', '2026-11-04T12:00:00Z'] };
  const plain = (v) => JSON.parse(JSON.stringify(v));
  assert.deepEqual(plain(ui.newQuestionsLine(questions, '2026-11-04T10:30:00Z')), [{ ts: '2026-11-04T12:00:00Z', who: 'claude', kind: 'questions', text: '2 new questions', link: 'questions.html#q%201' }]);
  assert.equal(ui.newQuestionsLine(questions, '2026-11-04T11:30:00Z')[0].text, '1 new question');
  assert.deepEqual(plain([ui.newQuestionsLine(questions, '2026-11-04T12:00:00Z'), ui.newQuestionsLine(questions, null), ui.newQuestionsLine(null, '2026-11-04T10:30:00Z')]), [[], [], []]);
  const html = ui.threadMessages(ui.newQuestionsLine(questions, '2026-11-04T10:30:00Z'));
  assert.match(html, new RegExp(`^<div class="msg status-line builder-status planner new-questions"><span class="mark" aria-hidden="true">${ui.MARK_ICONS.questions}</span><a href="questions.html#q%201">2 new questions</a>`));
  assert.match(ui.MARK_ICONS.questions, /class="mark-icon big"/);
  assert.doesNotMatch(ui.MARK_ICONS.questions, /<circle/);
});

// docs/adr/2026-11-07-0700-one-agents-status-lines-fold-into-one-line.md
test("one agent run folds into one closed line with a caret holding its started line, status lines and finished line; running shows its newest status, finished says so, neither counts lines; an orchestrator or owner message never folds", () => {
  const ln = (n, extra = {}) => ({ ts: ago(10 - n), who: 'claude', kind: 'status', text: `Step ${n}`, ...extra });
  const run = (name, running, planner) => ({ agent: `Claude ${name}`, run: name, ...(planner ? { planner: true } : {}), running });
  const agentLine = (n, finished, r) => ({ ts: ago(10 - n), who: 'claude', kind: 'agent', text: `${r.agent} ${finished ? 'finished' : 'started'}`, finished, ...r });
  const live = run('main', true);
  const html = ui.threadMessages([ln(0), agentLine(1, false, live), ln(2, live), { ts: ago(7.5), who: 'claude', text: 'Between' }, ln(3, live), { ts: ago(6), who: 'love', text: 'Owner says' }]);
  assert.equal(html.match(/<details/g).length, 1);
  assert.match(html, /<details class="msg status-line calls status-fold"><summary><span class="mark" aria-hidden="true"><svg/);
  assert.match(text(html), /^Step 0 · \S.* Claude main · running(?! ·)/);
  assert.match(text(html), /Claude main started · \S.* Step 2 · \S.* Step 3 · \S.* Between .*Owner says/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  const p = run('grill', false, true);
  const done = ui.threadMessages([agentLine(1, false, p), ln(2, p), ln(3, p), agentLine(4, true, p)]);
  assert.match(done, /<details class="msg status-line calls status-fold planner"><summary class="finished">/);
  assert.doesNotMatch(html, /finished/);
  assert.match(html, /<details class="msg status-line calls status-fold"><summary>/);
  assert.match(text(done), /^Claude grill · finished(?! · \d)/);
  assert.match(text(ui.threadMessages([agentLine(1, false, live)])), /^Claude main · running(?! · \d)/);
  assert.match(text(ui.threadMessages([agentLine(1, false, p), agentLine(2, true, p)])), /^Claude grill · finished(?! · \d)/);
});

test("a builder's judgment calls show collapsed under its lines, saying whether the session verified them, and count as no message", () => {
  const open = { ts: ago(1), who: 'claude', kind: 'calls', text: 'Claude Opus builder', calls: ['Kept <the> old name', 'Question: every agent?'], verified: null };
  const html = ui.threadMessages([open]);
  assert.match(html, /^<details class="msg status-line calls"><summary><span class="mark" aria-hidden="true">/);
  assert.ok(html.includes(ui.MARK_ICONS['judgment calls']));
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

test("withdrawing a pending message keeps the window's top edge, so no older message comes out from behind Show more", () => {
  const at = (n) => `2020-01-01T10:${String(n).padStart(2, '0')}:00.000Z`;
  const msgs = ['One', 'Two', 'Three', 'Four', 'Five', 'Six'].map((text, i) => ({ ts: at(i), who: 'claude', text }));
  msgs[5] = { ts: at(5), who: 'love', kind: 'item-message', text: 'Six', eventId: 'e6', state: 'waiting', reply: null };
  const words = (html) => [...html.matchAll(/>(One|Two|Three|Four|Five|Six)</g)].map((m) => m[1]);
  const more = (html) => html.match(/· (\d+) previous/)?.[1] ?? null;
  const read = { seenAt: at(59), more: 0, upto: at(5) };
  const first = ui.threadMessages(msgs, {}, new Map(), read);
  assert.deepEqual([words(first), more(first)], [['Four', 'Five', 'Six'], '3']);
  const from = ui.threadFrom(msgs, read, new Map());
  assert.equal(from, at(3));
  const after = ui.threadMessages(msgs.slice(0, 5), {}, new Map(), { ...read, from });
  assert.deepEqual([words(after), more(after)], [['Four', 'Five'], '3']);
  const tapped = ui.threadMessages(msgs.slice(0, 5), {}, new Map(), { ...read, from, more: 1 });
  assert.deepEqual([words(tapped), more(tapped)], [['One', 'Two', 'Three', 'Four', 'Five'], null]);
});

test("only Claude's and GitHub's messages are unread: the owner's answers after an unread reply fold under Show more past 10 lines, and each answer submitted apart waits on Claude under itself", () => {
  const at = (n) => `2020-01-01T10:${String(n).padStart(2, '0')}:00.000Z`;
  const answer = (n) => ({ ts: at(n), who: 'love', via: 'questions', kind: 'owner-answer', text: `Q${n}?\n→ A${n}`, eventId: `o${n}`, reply: null, state: 'waiting' });
  const grill = { ts: at(0), who: 'love', via: 'site', kind: 'grill-more', text: 'Grill', eventId: 'g1', state: 'replied', reply: { html: 'Questions up.', at: at(1) } };
  const answers = Array.from({ length: 12 }, (_, i) => answer(10 + i));
  const bodies = (html) => [...html.matchAll(/<div class="body">([^<]*)/g)].map((m) => m[1].replace(/\n.*/, ''));
  const waits = (html) => html.split(/(?=<div class="msg )/).filter((h) => h.includes('waiting…')).map((h) => /Q\d+/.exec(h)[0]);

  const read = ui.threadMessages([grill, ...answers], {}, new Map(), { seenAt: at(59), more: 0 });
  assert.deepEqual(bodies(read), ['Q19?', 'Q20?', 'Q21?']);
  assert.deepEqual(waits(read), ['Q19', 'Q20', 'Q21']);
  const unread = ui.threadMessages([grill, ...answers], {}, new Map(), { seenAt: at(0), more: 0 });
  assert.deepEqual(bodies(unread), answers.slice(2).map((a) => a.text.replace(/\n.*/, '')));
  assert.deepEqual(waits(unread), answers.slice(2).map((a) => /Q\d+/.exec(a.text)[0]));
  const all = ui.threadMessages([grill, ...answers], {}, new Map(), null);
  assert.deepEqual(waits(all), answers.map((a) => /Q\d+/.exec(a.text)[0]));

  const split = ui.threadMessages([answer(10), answer(11), { ts: at(12), who: 'claude', text: 'On it' }, answer(13), { ts: at(14), who: 'claude', kind: 'status', text: 'Testing' }, answer(15)], {}, new Map(), null);
  assert.deepEqual(waits(split), ['Q10', 'Q11', 'Q13', 'Q15']);
  const acted = ui.threadMessages([answer(10), { ...answer(11), state: 'answered' }], {}, new Map(), null);
  assert.deepEqual(waits(acted), ['Q10']);
});

test("a run's fold ends its summary at its status (running or finished); its log is a link inside the open section, and a run with no log has none", () => {
  const started = (extra = {}) => ({ ts: ago(3), who: 'claude', kind: 'agent', run: 'r1', agent: 'Claude Opus grill', text: 'Claude Opus grill started', finished: false, planner: true, ...extra });
  const status = { ts: ago(2), who: 'claude', kind: 'status', run: 'r1', agent: 'Claude Opus grill', planner: true, text: 'Reading' };
  const done = { ts: ago(1), who: 'claude', kind: 'agent', run: 'r1', agent: 'Claude Opus grill', text: 'Claude Opus grill finished', finished: true, planner: true };
  const running = ui.threadMessages([started({ log: 'planner-A1-2026.log' }), status]);
  assert.match(running, /Claude Opus grill · running<\/summary>.*<a href="log\.html\?file=planner-A1-2026\.log">View transcript<\/a><\/div><\/details>$/);
  assert.match(ui.threadMessages([started({ log: 'planner-A1-2026.log' }), status, done]), /grill · finished<\/summary>/);
  assert.doesNotMatch(ui.threadMessages([started(), status]), /View transcript/);
});

test("an ask's link line opens the work it became, and a thread line opens a linked card on the board", () => {
  assert.match(ui.threadMessages([{ ts: ago(1), who: 'claude', kind: 'ask-link', text: 'Became INT-21', link: '#selectedCard=site%2FS21' }]), /<a href="#selectedCard=site%2FS21">Became INT-21 →<\/a>/);
  const html = ui.threadMessages([{ ts: ago(1), who: 'claude', text: 'Asked to keep it', link: '#selectedCard=ask:e1' }]);
  assert.match(html, /<a href="#selectedCard=ask:e1">Open the task →<\/a>/);
  assert.doesNotMatch(html, /target="_blank"/);
  const moved = ui.threadMessages([{ ts: ago(1), who: 'claude', text: 'Moved to Audit.', link: '/audit/#selectedCard=ask%3Ab1' }]);
  assert.match(moved, /<a href="\/audit\/#selectedCard=ask%3Ab1">Open the task →<\/a>/);
  const arrived = ui.threadMessages([{ ts: ago(1), who: 'love', via: 'ask', kind: 'ask', text: 'Fix the header', from: 'Orch', eventId: 'b1', reply: null, state: 'waiting' }]);
  assert.match(text(arrived), /^You · Moved from Orch · .* Fix the header waiting…$/);
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
  { key: 'site/S54', file: 'site', kind: 'work', ref: 'INT-54', internal: true, linear: [], repo: null },
  { key: 'site/INT-56', file: 'site', kind: 'work', ref: 'INT-56', internal: true, linear: [{ id: 'INT-56' }], repo: null },
  { key: 'att/A1', file: 'att', kind: 'work', ref: 'A1', internal: false, linear: [{ id: 'ENG-2310', url: 'https://linear.app/acme/issue/ENG-2310' }], repo: 'acme/app' },
  { key: 'att/A2', file: 'att', kind: 'work', ref: 'A2', internal: false, linear: [], repo: 'acme/app' },
  { key: 'att/ENG-2467', file: 'att', kind: 'work', ref: 'ENG-2467', internal: false, linear: [{ id: 'ENG-2467', url: 'https://linear.app/acme/issue/ENG-2467' }], repo: 'acme/app' },
  { key: 'elig/A1', file: 'elig', kind: 'work', ref: 'A1', internal: false, linear: [{ id: 'OPS-7', url: 'https://linear.app/acme/issue/OPS-7' }], repo: 'o/r' },
  { key: 'ask:e9', wave: null, kind: 'ask', ref: 'Ask', internal: false, linear: [], repo: null },
];
const refLine = 'INT-54 shipped, INT-99 did not. ENG-2310, OPS-7 and ENG-2467 next, then A1. See acme/app#3116, app#3050, foo#4 and #2988, not #ffffff, #000000 or UTF-8. https://github.com/o/r/pull/1#issuecomment-2 and (https://x.test/a_(b)).';

test('a thread line links each ref the board knows to its card, Linear ids and PRs to their pages, and bare URLs, leaving the text as written', () => {
  const html = ui.threadMessages([{ ts: ago(1), who: 'claude', text: refLine }], ui.linkContext(boardItems, 'att/A1'));
  assert.deepEqual(anchors(html), [
    ['#selectedCard=site%2FS54', 'INT-54', false],
    ['https://linear.app/acme/issue/ENG-2310', 'ENG-2310', true],
    ['https://linear.app/acme/issue/OPS-7', 'OPS-7', true],
    ['#selectedCard=att%2FENG-2467', 'ENG-2467', false],
    ['#selectedCard=att%2FA1', 'A1', false],
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
  const items = (url) => [{ key: 'w/A1', file: 'w', kind: 'work', ref: 'A1', internal: false, linear: [{ id: 'ENG-2310', url }], repo: null }];
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
    ['#selectedCard=elig%2FA1', 'A1', false], ['https://github.com/o/r/pull/2988', '#2988', true],
  ]);
  assert.deepEqual(anchors(ui.threadMessages(line, ui.linkContext(boardItems, 'site/S54'))), []);
  assert.deepEqual(anchors(ui.threadMessages(line, ui.linkContext(boardItems, 'ask:e9'))), []);
  const hub = [...boardItems, { key: 'hub/INT-269', file: 'hub', kind: 'work', id: 'INT-269', ref: '#27', internal: true, linear: [], repo: null }];
  const ticketed = [{ ts: ago(1), who: 'claude', text: '#27 was INT-269; #2988 is a PR' }];
  for (const key of ['ask:e9', 'elig/A1']) {
    assert.deepEqual(anchors(ui.threadMessages(ticketed, ui.linkContext(hub, key))).slice(0, 2), [['#selectedCard=hub%2FINT-269', '#27', false], ['#selectedCard=hub%2FINT-269', 'INT-269', false]]);
  }
  assert.deepEqual(anchors(ui.threadMessages(ticketed, ui.linkContext(hub, 'elig/A1'))).at(-1), ['https://github.com/o/r/pull/2988', '#2988', true]);
});

test('a linked thread line still shows markup in its text as text', () => {
  const html = ui.threadMessages([{ ts: ago(1), who: 'love', text: '<b>INT-54</b> <img src=x>' }], ui.linkContext(boardItems, 'site/S54'));
  assert.doesNotMatch(html, /<b>|<img/);
  assert.deepEqual(anchors(html), [['#selectedCard=site%2FS54', 'INT-54', false]]);
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
    ['#selectedCard=site%2FS54', 'INT-54', false],
    ['https://x.test/b?c=1&amp;d=2', 'https://x.test/b?c=1&d=2', true],
    ['#selectedCard=site%2FINT-56', 'INT-56', false],
    ['#selectedCard=site%2FINT-56', 'INT-56', false],
    ['https://linear.app/acme/issue/ENG-2310', 'ENG-2310', true],
  ]);
  assert.match(html, /&rarr; done<\/p><pre>INT-54<\/pre>/);
  assert.match(html, /INT-56<\/a> &mdash; see/);
});

test('a question card and a full plan link refs too, to the board page from another page', () => {
  const onPage = ui.linkContext(boardItems, 'site/S54', { base: './' });
  const q = { ...question, question: 'Keep INT-54?', context: 'See ENG-2310', state: 'replied', answers: [{ ts: ago(1), choice: 'A', note: 'Like INT-56', reply: { html: '<p>Done in INT-54</p>' } }] };
  assert.deepEqual(anchors(ui.questionCard(q, { links: onPage })), [
    ['./#selectedCard=site%2FS54', 'INT-54', false],
    ['https://linear.app/acme/issue/ENG-2310', 'ENG-2310', true],
    ['./#selectedCard=site%2FINT-56', 'INT-56', false],
    ['./#selectedCard=site%2FS54', 'INT-54', false],
  ]);
  assert.deepEqual(anchors(ui.markdown('Builds on INT-54, see [notes](https://x.test/n).\n\n```\nINT-54\n```', onPage)), [
    ['./#selectedCard=site%2FS54', 'INT-54', false], ['https://x.test/n', 'notes', true],
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
  assert.equal(text(setup), 'Connecting this board Waiting for Claude to answer the ping GitHub checks reach this board');
  assert.equal(text(ui.setupCard({ events: false })), 'Connecting this board Waiting for Claude to answer the ping');
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

test('the sidebar shows Claude’s week as a second bar once it is within the near band of the pause line', () => {
  const resets_at = new Date(Date.now() + 3600_000).toISOString();
  const live = (used_percentage) => ({ used_percentage, resets_at, state: 'live' });
  const hub = (week, pause_at, state = 'live') => /<a class="sb-row on sb-hub-usage"[^>]*>([^]*?)<\/a>/.exec(ui.sidebar({
    usage: { claude: { at: resets_at, five_hour: live(34), seven_day: { ...live(week), state } }, codex: null }, pause: { pause_at },
  }, { here: '_hub/' }))[1];
  const bars = (html) => (html.match(/class="u-bar"/g) || []).length;
  assert.equal(bars(hub(79, 90)), 1);
  assert.equal(bars(hub(80, 90)), 2);
  assert.match(text(hub(86, 90)), /Claude 34% · resets .* Claude week 86% · resets /);
  assert.match(hub(86, 90), /u-tone-high[^]*Claude week/);
  assert.match(hub(90, 90), /u-tone-full"><span class="u-line"><span class="u-name">Claude week/);
  assert.equal(bars(hub(60, 80)), 2);
  assert.equal(bars(hub(59, 80)), 1);
  assert.equal(bars(hub(99, 100)), 1);
  assert.equal(bars(hub(95, 90, 'stale')), 1);
  assert.equal(bars(hub(95, 90, 'reset')), 1);
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
  // docs/adr/2026-11-06-1249-the-pause-line-reads-every-headless-agents-usage.md
  const near = { ...pause, state: 'normal', window: null, used: null, near: { window: 'five_hour', used: 84, resets_at: pause.resets_at, from: 80, going: false, waiting: true } };
  const slowing = hub.pauseBanner(near);
  assert.match(slowing, /hold-banner ub-banner ub-paused/);
  assert.equal(text(slowing), 'Approaching usage limit, reducing parallel agents Keep going');
  assert.match(slowing, /action="\/_hub\/settings\/keep-going"><button class="btn quiet" name="value" value="on">/);
  const together = hub.pauseBanner({ ...near, near: { ...near.near, going: true } });
  assert.match(together, /hold-banner ub-banner ub-going/);
  assert.match(text(together), /^Approaching usage limit: agents start in parallel until .* Stop$/);
  assert.match(together, /name="value" value="off"/);
  assert.equal(hub.pauseBanner({ state: 'normal', near: null }), '');
  const sites = [{ route: 'a', title: 'A', board: true, icon: '', sub: '<span class="dot t-working" aria-hidden="true"></span><span class="word t-working">working</span><span class="lcs"><span class="lc">3 todo</span></span>' }];
  const sidebar = ui.sidebar({ pause, sites, hub: { tone: 'ok', word: 'healthy', detail: 'up' } });
  assert.equal([...sidebar.matchAll(/class="word t-paused">paused/g)].length, 2);
  assert.ok(text(sidebar).includes(`until ${until}`));
  assert.match(text(sidebar), /paused 3 todo/);
  assert.doesNotMatch(sidebar, />working</);
  // Red beats grey and orange: a fault on a board row or the Hub row stays while a pause or busy host lasts.
  const faulty = [{ route: 'a', title: 'A', board: true, icon: '', sub: '<span class="dot t-down" aria-hidden="true"></span><span class="word t-down">not listening</span><span class="lcs"><span class="lc">3 todo</span></span>' }];
  const down = ui.sidebar({ pause, sites: faulty, hub: { tone: 'down', word: '1 site down', detail: '0 of 1 site up' } });
  assert.equal([...down.matchAll(/class="word t-paused">paused/g)].length, 0);
  assert.match(down, />not listening</);
  assert.match(down, /class="word t-down">1 site down/);
  const busyDown = ui.sidebar({ pause: { state: 'normal', machine: { state: 'busy' } }, sites: [], hub: { tone: 'down', word: '1 site down', detail: 'x' } });
  assert.match(busyDown, /class="word t-down">1 site down/);
  assert.doesNotMatch(busyDown, />busy</);
  const degradedPaused = ui.sidebar({ pause, sites: [], hub: { tone: 'wait', word: 'degraded', detail: 'x' } });
  assert.match(degradedPaused, /class="word t-wait">degraded/);
  assert.doesNotMatch(degradedPaused, /class="word t-paused">paused/);
  assert.match(ui.statusLine(ago(0), { pause }), new RegExp(`^<span class="fresh" title="Paused until ${until}\\. Updated [^"]*">now</span>$`));
  assert.doesNotMatch(ui.statusLine(null, { pause: { ...pause, state: 'going' } }), /paused/i);
});

// docs/adr/2026-11-05-1849-pause-board-and-pause-hub-pause-new-work-by-hand.md
test('Pause hub reads paused on the Hub row and every board with Resume on its banner; Pause board on its own row alone', () => {
  const resets_at = new Date(Date.now() + 3600_000).toISOString();
  const until = ui.usageClock(resets_at);
  const manual = (scope) => ({ pause_at: 90, state: 'paused', manual: scope, window: null, used: null, resets_at });
  const working = '<span class="dot t-working" aria-hidden="true"></span><span class="word t-working">working</span>';
  const banner = context.HubUI.pauseBanner(manual('hub'));
  assert.equal(text(banner), `Work paused: you paused the hub. Resumes at ${until}. Resume`);
  assert.match(banner, /hold-banner ub-banner ub-paused/);
  assert.match(banner, /action="\/_hub\/settings\/hub-pause"><button class="btn quiet" name="pause" value="off">Resume/);
  const sites = [{ route: 'a', title: 'A', board: true, icon: '', sub: working }, { route: 'b', title: 'B', board: true, icon: '', sub: working }];
  const hubPaused = ui.sidebar({ pause: manual('hub'), sites, hub: { tone: 'ok', word: 'healthy', detail: 'up' } });
  assert.equal([...hubPaused.matchAll(/class="word t-paused">paused/g)].length, 3);
  const boardPaused = ui.sidebar({ pause: { state: 'normal' }, sites: [{ ...sites[0], pause: manual('board') }, sites[1]], hub: { tone: 'ok', word: 'healthy', detail: 'up' } });
  assert.equal([...boardPaused.matchAll(/class="word t-paused">paused/g)].length, 1, 'only the paused board');
  assert.equal([...boardPaused.matchAll(/>working</g)].length, 1);
  assert.match(text(boardPaused), /healthy/);
  assert.equal(ui.statusLine(null, { pause: manual('board') }), `<span class="fresh" title="Paused until ${until}"></span>`);
});

// docs/adr/2026-11-06-0106-a-busy-mac-holds-new-work.md
test('a busy host reads busy on the Hub row and the logo dot, not on a board or the header, a pause first, and Health has a Machine row', () => {
  const machine = { state: 'busy', reason: 'memory pressure critical' };
  const working = '<span class="dot t-working" aria-hidden="true"></span><span class="word t-working">working</span>';
  const sites = [{ route: 'a', title: 'A', board: true, icon: '', sub: `${working}<span class="lcs"><span class="lc">3 todo</span></span>` }, { route: 'p', title: 'P', board: false, icon: '', sub: '' }];
  const busy = ui.sidebar({ pause: { state: 'normal', machine }, sites, hub: { tone: 'ok', word: 'healthy', detail: 'up' } });
  assert.equal([...busy.matchAll(/class="word t-wait">busy/g)].length, 1, 'the Hub row alone');
  assert.match(text(busy), /busy the host is busy/);
  assert.match(text(busy), /working 3 todo/, 'a board keeps its own status');
  assert.equal(ui.hubDot({ pause: { state: 'normal', machine }, hub: { tone: 'ok' } }), 'busy');
  assert.equal(ui.hubDot({ pause: { state: 'normal', machine }, hub: { tone: 'down' } }), 'down', 'a broken hub reads red before busy');
  assert.equal(ui.hubDot({ pause: { state: 'paused', machine }, hub: { tone: 'ok' } }), 'paused', 'a pause shows grey, not busy');
  assert.equal(ui.hubDot({ pause: { state: 'normal', machine: { state: 'normal' } }, hub: { tone: 'ok' } }), '');
  const both = ui.sidebar({ pause: { state: 'paused', resets_at: new Date(Date.now() + 3600_000).toISOString(), machine }, sites, hub: { tone: 'ok', word: 'healthy', detail: 'up' } });
  assert.doesNotMatch(both, />busy</, 'a pause reads first');
  assert.equal([...both.matchAll(/class="word t-paused">paused/g)].length, 2);
  const calm = ui.sidebar({ pause: { state: 'normal', machine: { state: 'normal', reason: null } }, sites, hub: { tone: 'ok', word: 'healthy', detail: 'up' } });
  assert.doesNotMatch(calm, />busy</);
  assert.match(calm, />working</);
  assert.equal(text(ui.statusLine(ago(0), { pause: { state: 'normal', machine } })), 'now', 'the header keeps reading the age');
  assert.doesNotMatch(ui.statusLine(ago(0), { pause: { state: 'normal', machine } }), /hold|busy/, 'and does not change colour');
  assert.equal(ui.statusLine(null, { pause: { state: 'normal', machine } }), '');
  assert.equal(text(ui.statusLine(ago(0), { pause: { state: 'normal', machine: { state: 'normal', reason: null } } })), 'now');
  const row = context.HubUI.machineRow(machine);
  assert.equal(text(row), 'Machine busy · memory pressure critical');
  assert.match(row, /<span class="st wait">busy<\/span>/);
  assert.equal(text(context.HubUI.machineRow({ state: 'normal', reason: null })), 'Machine normal');
  assert.match(context.HubUI.machineRow({ state: 'normal', reason: null }), /<span class="st ok">normal<\/span>/);
});

test('a Forever Pause hub or Pause board reads until you resume on the banner, the Hub row and the header', () => {
  const forever = (scope) => ({ pause_at: 90, state: 'paused', manual: scope, window: null, used: null, resets_at: 'forever' });
  assert.equal(text(context.HubUI.pauseBanner(forever('hub'))), 'Work paused: you paused the hub until you resume. Resume');
  assert.match(text(ui.sidebar({ pause: forever('hub'), sites: [], hub: { tone: 'ok', word: 'healthy', detail: 'up' } })), /paused until you resume/);
  assert.equal(ui.statusLine(null, { pause: forever('board') }), '<span class="fresh" title="Paused until you resume"></span>');
});

// docs/adr/2026-11-06-0800-the-update-row-shows-only-new-version-and-reload.md
test('the update row reads the new version, or New version when none is known, with Reload only, shows nothing otherwise, and spins while reloading', () => {
  assert.equal(ui.updateRow(null), '');
  const ready = ui.updateRow('ready');
  assert.match(ready, /<button type="button" class="sb-row sb-update-row" data-app-reload>/);
  assert.equal(text(ready), 'New version Reload');
  assert.equal(text(ui.updateRow('ready', '0.5.1')), 'v0.5.1 Reload');
  const reloading = ui.updateRow('reloading');
  assert.match(reloading, /data-app-reload disabled aria-busy="true"/);
  assert.equal(text(reloading), 'New version Reload');
  // The hub's npm pull state is no part of the sidebar's data, so a stale field draws nothing.
  const html = ui.sidebar({ sites: [], upgrade: { state: 'failed', version: '0.4.0' } });
  assert.match(html, /<div class="sb-update" role="status"><\/div>/);
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
  const reached = (it) => ui.phaseStrip(it)?.done ?? null;
  assert.equal(reached({ lane: 'progress', builder: { phase: 'testing' } }), 3);
  assert.equal(reached({ lane: 'progress', builder: { phase: null } }), 0);
  assert.equal(reached({ lane: 'progress', waitsOn: 'checking' }), 4);
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
  // On the hub page a board session's prompt names its board first (docs/adr/2026-11-12-0700-the-board-has-no-needs-you-deck-or-pane.md).
  assert.match(ui.promptItem({ ...perm, board: 'Shop' }), /<span class="muted small">Shop · /);
  assert.doesNotMatch(ui.promptItem(perm), /Shop/);
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

test("a card waiting on its owner step reads its code check under the Next, or that the check can't run", () => {
  const step = 'Publish kickflip to npm';
  const waiting = { ...workCard, lane: 'review', waitsOn: 'owner', next: step, ownerStep: step, awaitsDone: true, bumpable: false };
  assert.deepEqual(lines(ui.workLines({ ...waiting, ownerCheck: { words: 'kickflip@0.3.* on npm', broken: null } })).slice(0, 3), ['ENG-1 Five', `Next: ${step}`, 'Checks: kickflip@0.3.* on npm']);
  assert.deepEqual(lines(ui.workLines({ ...waiting, ownerCheck: { words: 'kickflip@0.3.* on npm', broken: 'npm view failed: <E404>' } })).slice(0, 3),
    ['ENG-1 Five', `Next: ${step}`, "Check can't run: npm view failed: <E404>"]);
  assert.match(ui.workLines({ ...waiting, ownerCheck: { words: 'x', broken: '<b>' } }), /<div class="line3 sub refused">Check can&#39;t run: &lt;b&gt;<\/div>/);
  assert.doesNotMatch(ui.workLines(waiting), /Checks:|Check can/);
});

// docs/adr/2026-11-05-0200-a-tap-spins-until-the-board-shows-its-change.md
test('a pending tap keeps its button busy through any repaint until a board made after the answer shows its change, a refusal drops it, and 60 seconds without one runs its late callback', () => {
  const timers = [];
  context.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  context.clearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].fn = null; };
  const card = (extra) => ({ key: 'w/A1', kind: 'work', lane: 'todo', ...extra });
  const busy = (html) => / disabled aria-busy="true"/.test(html);
  const grills = (board) => board.items.some((i) => i.grilling);
  const planButton = () => ui.planButton([card(), { ...card(), key: 'w/A2' }]);
  assert.equal(busy(planButton()), false);

  let late = 0;
  ui.pending.start('todo:plan', grills, () => { late += 1; });
  assert.equal(timers.at(-1).ms, 60000);
  assert.equal(busy(planButton()), true);
  // Nothing ends it before the POST is answered, whatever the board says.
  ui.pending.settle({ generatedAt: 5, items: [card({ grilling: true })] });
  assert.equal(busy(planButton()), true);
  ui.pending.answered('todo:plan', 10);
  ui.pending.settle({ generatedAt: 9, items: [card({ grilling: true })] });
  ui.pending.settle({ generatedAt: 11, items: [card()] });
  assert.equal(busy(planButton()), true, 'a board without the change leaves it busy');
  ui.pending.settle({ generatedAt: 12, items: [card({ grilling: true })] });
  assert.equal(busy(planButton()), false, 'the board that shows the change ends it');
  assert.equal(timers.at(-1).fn, null, 'and cancels its timeout');
  assert.equal(late, 0);

  // A tap whose answer carries no board: any board then settles it.
  ui.pending.start('w/A1:try', (board) => board.items[0].try === 'running');
  ui.pending.answered('w/A1:try');
  ui.pending.settle({ generatedAt: 1, items: [{ try: 'ready' }] });
  assert.equal(ui.pending.has('w/A1:try'), true);
  ui.pending.settle({ generatedAt: 2, items: [{ try: 'running' }] });
  assert.equal(ui.pending.has('w/A1:try'), false);

  // A refusal drops it; the other card's entry stays.
  ui.pending.start('w/A1:merge', () => false);
  ui.pending.start('w/A2:merge', () => false);
  ui.pending.drop('w/A1:merge');
  assert.deepEqual([ui.pending.has('w/A1:merge'), ui.pending.has('w/A2:merge')], [false, true]);
  ui.pending.drop('w/A2:merge');

  // 60 seconds on, it drops by itself and says so once.
  ui.pending.start('todo:plan', grills, () => { late += 1; });
  timers.at(-1).fn();
  assert.deepEqual([ui.pending.has('todo:plan'), late], [false, 1]);

  // Try draws busy from the entry, through any repaint.
  ui.pending.start('w/A1:try', () => false);
  assert.equal(busy(ui.tryButton({ key: 'w/A1', kind: 'work', lane: 'todo', try: { script: true, changes: true, kind: 'web', state: 'ready' } })), true);
  ui.pending.drop('w/A1:try');
  assert.equal(busy(ui.tryButton({ key: 'w/A1', kind: 'work', lane: 'todo', try: { script: true, changes: true, kind: 'web', state: 'ready' } })), false);
  Object.assign(context, { setTimeout, clearTimeout });
});

test('pending.within settles with its work, and past 60 seconds runs onLate and resolves', async () => {
  const timers = [];
  context.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  context.clearTimeout = (id) => { timers[id - 1].fn = null; };
  let late = 0;
  const done = await ui.pending.within(Promise.resolve('ok'), () => { late += 1; });
  assert.deepEqual([done, late, timers.at(-1).ms, timers.at(-1).fn], ['ok', 0, 60000, null]);
  await assert.rejects(ui.pending.within(Promise.reject(new Error('refused')), () => { late += 1; }), /refused/);
  assert.equal(timers.at(-1).fn, null);
  const never = ui.pending.within(new Promise(() => {}), () => { late += 1; });
  timers.at(-1).fn();
  assert.equal(await never, undefined);
  assert.equal(late, 1);
  Object.assign(context, { setTimeout, clearTimeout });
});

// docs/adr/2026-11-05-2215-a-board-is-shared-view-only-with-a-tailscale-login.md
test("a shared person's sidebar lists only their boards: no Hub row, no New board, no update or notification rows", () => {
  const data = { shared: { by: 'Love' }, sites: [{ route: 'orch', title: 'Orch', board: true, icon: '<span class="icon"></span>', sub: 'idle' }], starting: [] };
  const html = ui.sidebar(data, { here: 'orch', device: 'off', update: 'ready' });
  assert.match(html, /<a class="sb-row on" href="\/orch\/" aria-current="page">/);
  assert.doesNotMatch(html, /sb-row[^"]*" href="\/_hub\/"|data-new-board|sb-utility|data-app-reload|Turn on notifications/);
  assert.deepEqual(plain(ui.switchKeys(data)).map((r) => r.href), ['/orch/']);
});

// docs/adr/2026-11-05-1912-a-shared-person-is-view-or-full.md
test("a Full person's line in a thread is named as them, the owner's stays You", () => {
  const html = ui.threadMessages([
    { ts: ago(2), who: 'love', via: 'site', kind: 'item-message', text: 'Per key', by: 'Dana <R>', files: [] },
    { ts: ago(1), who: 'love', via: 'site', kind: 'item-message', text: 'Agreed', files: [] },
  ]);
  assert.match(html, /<div class="who">Dana &lt;R&gt; · /);
  assert.match(html, /<div class="who">You · /);
});

test('while typing, no header strip or docked bar', () => {
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /kb-up|\.docked|--keyboard/);
});

// docs/adr/2026-11-07-0600-typing-only-disables-the-plus-button.md
test('while typing on a phone the floating + is hidden, and on a wider screen it stays as it is', () => {
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\n:root\.typing \.fab \{/);
  assert.match(css, /@media \(max-width: 699px\) \{\s*:root\.typing \.fab \{ display: none; \}/);
});

test('a ↗ written in a question, its context and its options draws as the arrow icon, never the character', () => {
  const q = { ...question, question: 'See Notes ↗ first?', context: 'Open take A↗︎ for more', options: [{ id: 'A', label: 'Notes ↗', detail: 'Open take B ↗' }, { id: 'B', label: 'Drop' }] };
  const html = ui.questionCard(q);
  assert.doesNotMatch(html, /[↗︎]/);
  assert.equal(html.split('class="link-arrow"').length - 1, 4);
});

test("a Todo thread message's footer leads with an icon for Reply and Implement, and a bare Implement's line with Implement's", () => {
  const html = ui.threadMessages([
    { ts: ago(2), who: 'love', via: 'site', kind: 'item-message', text: 'hello', status: 'Reply', eventId: 'm1', state: 'waiting', files: [] },
    { ts: ago(1), who: 'love', via: 'site', kind: 'item-message', text: 'go', status: 'Implement', eventId: 'm2', state: 'waiting', files: [] },
    { ts: ago(0.5), who: 'love', kind: 'command', command: 'implement', request: true, mark: 'Implementation requested', text: 'Implementation requested' },
  ]);
  for (const words of ['Reply', 'Implement']) {
    assert.match(ui.MARK_ICONS[words], /^<svg class="mark-icon"/);
    assert.ok(html.includes(`<span class="foot-status"><span class="mark" aria-hidden="true">${ui.MARK_ICONS[words]}</span>${words}</span>`), words);
  }
  assert.equal(ui.MARK_ICONS['Implementation requested'], ui.MARK_ICONS.Implement);
  assert.ok(html.includes(`<div class="msg status-line request"><span class="mark" aria-hidden="true">${ui.MARK_ICONS.Implement}</span>Implementation requested`));
});

test('a ↗ in a card title, a card details line, a thread line and a question draws as the arrow icon, never the character', () => {
  const card = ui.workLines({ key: 'w/A1', ref: 'A1', title: 'Fix ↗ link', next: 'Open ↗', lane: 'todo' });
  const thread = ui.threadMessages([{ ts: ago(1), who: 'claude', kind: 'agent', text: 'Started ↗', finished: false }]);
  const asked = ui.questionCard({ ...question, question: 'See Notes ↗ first?' });
  for (const html of [card, thread, asked]) {
    assert.doesNotMatch(html, /↗/);
    assert.match(html, /class="link-arrow"/);
  }
});

// docs/adr/2026-11-05-1921-a-visual-is-a-page-an-agent-draws-for-a-thread.md
test("a bare visual request is a request line led by the image mark, and the agent's page a plain link line that opens it full page", () => {
  const html = ui.threadMessages([
    { ts: ago(2), who: 'love', via: 'site', kind: 'visual-request', request: true, text: 'Visual requested', eventId: 'v1', state: 'waiting', files: [] },
    { ts: ago(1), who: 'claude', kind: 'visual', text: 'How a land <moves>', link: 'visuals/A1/how-a-land-moves.html' },
  ]);
  assert.match(ui.MARK_ICONS['Visual requested'], /<rect x="3" y="3" width="18" height="18" rx="2"\/>/);
  assert.ok(html.startsWith(`<div class="msg status-line request"><span class="mark" aria-hidden="true">${ui.MARK_ICONS['Visual requested']}</span>Visual requested <span class="muted">`));
  assert.match(html, /<div class="msg status-line link visual"><span class="mark" aria-hidden="true"><svg.*?<\/svg><\/span><a href="visuals\/A1\/how-a-land-moves\.html">How a land &lt;moves&gt; →<\/a> <span class="muted">· [^<]+<\/span><\/div>$/);
  assert.doesNotMatch(html, /target="_blank"|class="who"/);
});

// docs/adr/2026-11-08-0900-ready-and-staging-moves-are-bare-status-lines.md
test('a "Marked as staging" line is a bare gray status line and a "Marked as ready" line is the same in green', () => {
  const line = (command, text) => ({ ts: ago(1), who: 'claude', kind: 'command', command, request: true, mark: text, text });
  const html = ui.threadMessages([line('staged', 'Marked as staging'), line('readied', 'Marked as ready')]);
  assert.ok(html.includes(`<div class="msg status-line request"><span class="mark" aria-hidden="true">${ui.MARK_ICONS['Marked as staging']}</span>Marked as staging <span class="muted">`));
  assert.ok(html.includes(`<div class="msg status-line request readied"><span class="mark" aria-hidden="true">${ui.MARK_ICONS['Marked as ready']}</span>Marked as ready <span class="muted">`));
  assert.match(fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8'), /\.msg\.request\.readied \{ color: var\(--color-success\); \}/);
});

// docs/adr/2026-11-07-0600-every-thread-status-line-carries-an-icon.md
test('every kind of thread status or system line leads with an icon, so a new kind cannot ship without one', async () => {
  const { ACTION_LABELS, INTENT_LABELS, COMMANDS, ANSWERS_SUBMITTED } = await import('./domain.mjs');
  // Each word domain.mjs puts on a request line or a message footer has an icon: every command key's among them.
  const words = [...Object.values(ACTION_LABELS).filter((w) => w !== ACTION_LABELS['mark-ready']), ...Object.values(INTENT_LABELS), ...Object.values(COMMANDS), ANSWERS_SUBMITTED];
  for (const w of words) assert.match(ui.MARK_ICONS[w] || '', /class="mark-icon/, `${w} has an icon`);
  // Each system line kind renders a mark holding an icon, or the dot of a builder or agent that is running.
  const sample = { ts: ago(1), who: 'claude', text: 'x', link: '#selectedCard=a', calls: ['c'], verified: null };
  for (const kind of ui.SYSTEM_KINDS) {
    const html = ui.threadMessages([{ ...sample, kind, ...(kind === 'command' ? { command: 'hold', mark: COMMANDS.hold, text: 'Held until Fri', request: true } : {}), ...(kind === 'hub' ? { mark: 'Held' } : {}) }]);
    assert.match(html, /<span class="mark" aria-hidden="true">(<svg class="mark-icon|<span class="(working|agent)-dot")/, `${kind} line has a mark`);
  }
  // A request line with no icon for its words renders an empty mark, which this catches.
  for (const text of words.filter((w) => !INTENT_LABELS.reply || w !== INTENT_LABELS.reply)) {
    const html = ui.threadMessages([{ ts: ago(1), who: 'love', kind: 'grill-more', request: true, text }]);
    assert.match(html, /<span class="mark" aria-hidden="true"><svg class="mark-icon/, `${text} request line has an icon`);
  }
});

test('a held card reads gray while blocked and action stay orange', () => {
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  const colour = (cls) => css.split('\n').find((l) => new RegExp(`^(\\.[\\w-]+, )*\\.${cls}( |,)`).test(l) && l.includes('color:'));
  assert.match(colour('card-hold'), /^\.card-hold \{ color: var\(--color-quiet\); \}/);
  assert.match(colour('card-blocked'), /--color-notice/);
  assert.doesNotMatch(colour('card-blocked'), /card-hold/);
});

test("a link's thread line is one link icon and a plain link to the other card, and is never unread", () => {
  const html = ui.threadMessages([{ ts: ago(1), who: 'claude', kind: 'command', command: 'followup', request: true, mark: 'Follow-up', text: 'Follow-up #12: Tidy', link: '#selectedCard=w%2FA2', card: 'w/A2' }], { seenAt: ago(5) });
  assert.match(html, /^<div class="msg status-line request"><span class="mark" aria-hidden="true"><svg class="mark-icon"/);
  assert.ok(html.includes('<a href="#selectedCard=w%2FA2">Follow-up #12: Tidy</a>'));
  assert.doesNotMatch(html, /unread/);
});

test('on a phone the board page bottom bar hides while a text field has focus, like the +', () => {
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  const phone = /@media \(max-width: 699px\) \{([^@]*?)\n\}/.exec(css.slice(css.indexOf('Typing, a text field focused')))[1];
  assert.match(phone, /:root\.typing \.fab \{ display: none; \}/);
  assert.match(phone, /:root\.typing body > \.top, :root\.typing body\.has-sidebar > :not\(\.sidebar\) > \.top \{ display: none; \}/);
});

// docs/adr/2026-11-07-2100-a-cards-past-runs-keep-their-records-so-they-fold.md
test("a run's section reads finished or running by its newest line, so a finished build that lands reads running again with its finished line kept in place", () => {
  const r = { agent: 'Claude implementer', run: 'build' };
  const l = (n, extra) => ({ ts: ago(10 - n), who: 'claude', ...extra, ...r });
  const lines = [l(1, { kind: 'agent', text: 'started', finished: false }), l(2, { kind: 'status', text: 'Building: x' }), l(3, { kind: 'agent', text: 'finished', finished: true })];
  assert.match(ui.threadMessages(lines), /<summary class="finished">/);
  const landing = ui.threadMessages([...lines, l(4, { kind: 'status', text: 'Landing: rebasing' })]);
  assert.match(landing, /<summary><span/);
  assert.doesNotMatch(landing, /<summary class="finished">/);
  assert.match(text(landing), /^Claude implementer · running/);
  assert.match(text(landing), /finished · \S.* Landing: rebasing/);
  const relanded = ui.threadMessages([...lines, l(4, { kind: 'agent', text: 'lander started', finished: false }), l(5, { kind: 'agent', text: 'lander finished', finished: true })]);
  assert.match(relanded, /<summary class="finished">/);
});

// docs/adr/2026-11-09-1200-the-board-writes-status-lines-and-only-the-orchestrator-writes-messages.md
test("the board's line is a status line with its mark, never an Orchestrator message, and only a fault is red and unread", () => {
  const quiet = { ts: ago(1), who: 'claude', kind: 'hub', line: 'host-busy', mark: 'Held', fault: false, text: 'Host is busy, work will resume when the host recovers' };
  const fault = { ts: ago(1), who: 'claude', kind: 'hub', line: 'relaunch-failed', mark: 'Fault', fault: true, text: "Couldn't relaunch the builder headless: spawn ENOENT" };
  const html = ui.threadMessages([quiet]);
  assert.match(html, /<div class="msg status-line request hub"><span class="mark" aria-hidden="true"><svg class="mark-icon/);
  assert.doesNotMatch(html, /Orchestrator/);
  assert.match(ui.threadMessages([fault]), /<div class="msg status-line request hub fault">/);
  assert.match(ui.MARK_ICONS.Blocked, /circle/);
  assert.match(ui.MARK_ICONS.Fault, /mark-icon/);
  // The window opens from the oldest unread line: a fault reaches past the last three messages, a quiet line doesn't.
  const msg = (h) => ({ ts: ago(h), who: 'love', text: `m${h}` });
  const older = [{ ...fault, ts: ago(9) }, msg(8), msg(7), msg(6), msg(5)];
  assert.match(ui.threadMessages(older, {}, new Map(), { seenAt: ago(10) }), /relaunch/);
  assert.doesNotMatch(ui.threadMessages([{ ...quiet, ts: ago(9) }, ...older.slice(1)], {}, new Map(), { seenAt: ago(10) }), /Host is busy/);
});

test('every status line kind takes the shared status-line class, whose rule alone holds spacing, and only the logo is .hub-flexed', () => {
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  const lines = [
    { ts: ago(1), who: 'claude', kind: 'hub', line: 'pulled', mark: 'Held', text: 'Pulled in' },
    { ts: ago(1), who: 'claude', kind: 'move', text: 'Moved' },
    { ts: ago(1), who: 'claude', kind: 'status', text: 'Reading' },
    { ts: ago(1), who: 'claude', kind: 'agent', text: 'Opus started' },
    { ts: ago(1), who: 'claude', kind: 'visual', link: 'visuals/A1/x.html', text: 'Page' },
    { ts: ago(1), who: 'claude', kind: 'calls', text: 'Opus', calls: ['a'] },
  ];
  for (const m of lines) assert.match(ui.threadMessages([m]), /^<(div|details) class="msg status-line /, m.kind);
  for (const kind of ['link', 'builder-status', 'request', 'agent', 'calls']) {
    const rule = css.match(new RegExp(`^\\.msg\\.${kind}[^{]*\\{([^}]*)\\}`, 'm'))?.[1] || '';
    assert.doesNotMatch(rule, /padding|margin|font-size|overflow-wrap/, kind);
  }
  assert.match(css, /^a\.hub \{ display: inline-flex/m);
  assert.match(css, /^\.status-line \{ padding: 0 10px; margin: 4px 0; font-size: 12px;/m);
});

// docs/adr/2026-11-09-1500-a-task-is-a-card-with-no-ticket-keyed-t-n.md: a card with no ticket wears a quiet Task badge
// in the ticket slot, its T-<n> only in the badge's title; a ticket replaces it.
test('a task wears a Task badge where a ticket would be, and a ticketed card its ticket', () => {
  const task = { ...workCard, key: 'w/T-8', id: 'T-8', ref: 'T-8', linear: [], ticket: null, pr: null, prs: [] };
  assert.match(ui.workLines(task), /<span class="chip tone-quiet" title="T-8 · a task, no ticket">Task<\/span>/);
  const ticketed = { ...task, ref: '#451', ticket: { id: '#451', url: 'https://github.com/o/r/issues/451', source: 'github' } };
  assert.doesNotMatch(ui.workLines(ticketed), />Task</);
  assert.match(ui.workLines(ticketed), />#451</);
  assert.match(ui.workLines({ ...task, ticket: { id: 'INT-3', url: null, source: null } }), /title="INT-3 · not from this board’s ticket source">INT-3</);
});

test('a fault line with an error draws as a closed section: its title shows, the whole error sits in a monospace block, escaped', () => {
  const why = 'Warning: client version "1.104.5" != tailscaled server version "1.96.2"\nCouldn\'t open try port 8504 <denied>';
  const html = ui.threadMessages([{ ts: ago(1), who: 'claude', kind: 'hub', line: 'run-failed', mark: 'Fault', fault: true, text: 'Serve failed (exit 1)', detail: why }]);
  assert.match(html, /<details class="msg status-line request hub fault-detail fault"><summary>.*Serve failed \(exit 1\).*<\/summary><pre class="fault-error">/s);
  assert.ok(html.includes('&lt;denied&gt;') && html.includes('client version &quot;1.104.5&quot;'));
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.doesNotMatch(ui.threadMessages([{ ts: ago(1), who: 'claude', kind: 'hub', line: 'exited-twice', mark: 'Fault', fault: true, text: 'x' }]), /<details/);
});

test('the header time stays plain while usage is paused, and the hub pause banner with Keep going is the one the board shows', () => {
  const resets_at = new Date(Date.now() + 3600_000).toISOString();
  const pause = { pause_at: 90, state: 'paused', manual: null, window: 'weekly', used: 95, resets_at, near: null };
  assert.equal(/class="fresh"/.test(ui.statusLine(null, { pause })), true);
  assert.match(context.HubUI.pauseBanner(pause), /action="\/_hub\/settings\/keep-going"><button class="btn quiet" name="value" value="on">Keep going/);
});

test("a link to a card on the board starts with that card's lane ring; an id with no card stays plain", () => {
  const items = [{ key: 'w/A1', file: 'w', id: 'A1', ref: '#186', lane: 'review' }, { key: 'w/A2', file: 'w', id: 'A2', ref: 'INT-5', lane: 'progress', internal: true, linear: [] }];
  const html = ui.linkText('#186 and INT-5 and #999 and ENG-1', ui.linkContext(items, 'w/A1'));
  assert.match(html, /<a href="#selectedCard=w%2FA1"><span class="status link-lane review"><\/span>#186<\/a>/);
  assert.match(html, /<a href="#selectedCard=w%2FA2"><span class="status link-lane progress"><\/span>INT-5<\/a>/);
  assert.doesNotMatch(html, /link-lane[^>]*><\/span>(#999|ENG-1)/);
});

// docs/adr/2026-11-12-1000-the-logo-dot-carries-the-hub-state.md
test('the logo dot is the highest of red, orange, blue, grey: not listening or offline, busy, an update, paused', () => {
  const ok = { pause: { state: 'normal' }, hub: { tone: 'ok' }, sites: [{ route: 'a', board: true, listen: 'listening' }] };
  assert.equal(ui.hubDot(ok), '');
  assert.equal(ui.hubDot({ ...ok, sites: [{ route: 'a', board: true, listen: 'listening' }, { route: 'b', board: true, listen: 'deaf' }] }), 'down', 'not listening on any board');
  assert.equal(ui.hubDot({ ...ok, sites: [{ route: 'b', board: true, listen: 'full' }] }), 'down');
  assert.equal(ui.hubDot({ ...ok, sites: [{ route: 'b', board: true, listen: 'asleep' }] }), '', 'asleep is not a fault');
  assert.equal(ui.hubDot(ok, { offline: true }), 'down', 'a page that cannot reach the host');
  const busy = { ...ok, pause: { state: 'normal', machine: { state: 'busy' } } };
  assert.equal(ui.hubDot({ ...busy, sites: [{ route: 'b', board: true, listen: 'deaf' }] }), 'down', 'red beats orange');
  assert.equal(ui.hubDot(busy, { update: 'ready' }), 'busy', 'orange beats blue');
  assert.equal(ui.hubDot(ok, { update: 'ready' }), 'update');
  const paused = { ...ok, pause: { state: 'paused' } };
  assert.equal(ui.hubDot(paused, { update: 'ready' }), 'update', 'blue beats grey');
  assert.equal(ui.hubDot(paused), 'paused');
  assert.equal(ui.hubDot(null), '');
});
