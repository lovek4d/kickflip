import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fixedDate } from '../shared/fixed-clock.mjs';
import { toneOf } from '../hub/usage.mjs';
import { usageGate } from '../shared/usage-gate.mjs';
import { buildersView, orchestratorsView } from '../shared/model-views.mjs';
import { footerOf } from './domain.mjs';

// The one time every test here builds its data from and every renderer counts to: each sandbox's Date stands still at it
// (docs/adr/2026-11-13-1417-ui-tests-freeze-date-in-their-sandbox.md). Local noon, so a day either side stays a day.
const NOW = new Date(2026, 10, 13, 12).getTime();
const PageDate = fixedDate(() => NOW);
const context = vm.createContext({ Date: PageDate, location: { hostname: 'mac.ts.net', host: 'mac.ts.net:443' }, navigator: { onLine: true }, setTimeout, clearTimeout, AbortController });
for (const file of ['ui-icon-text.js', 'ui.js','ui-links.js', 'ui-enums.js', 'ui-progress-bar.js', 'ui-cards.js', 'ui-header.js', 'ui-threads.js', 'ui-questions.js', 'ui-prompts.js', 'ui-markdown.js', 'ui-page-header.js', 'ui-snapshot.js', 'ui-icon-text.js', 'ui-sidebar.js', 'ui-hub.js']) {
  vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), context);
}
const ui = context.BoardUI;
// A card as the page draws it carries the footer words the server sends with it (domain.mjs footerOf): a fixture states the
// facts, and any it leaves out of its footer are what the server would have sent.
const workLines = (it, opts) => ui.workLines({ footer: footerOf({ blockedBy: [], ...it }), ...it }, opts);

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&(amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e]).replace(/\s+/g, ' ').trim();
const ago = (hours) => new Date(NOW - hours * 3600000).toISOString();
// The last option and take end where the question's note composer starts.
const beforeComposer = (chunk) => chunk.split('<div class="composer"')[0];
const options = (html) => html.split(/<label class="opt"[^>]*>/).slice(1).map(beforeComposer);
const plain = (v) => JSON.parse(JSON.stringify(v));
// A sidebar row's grey paused dot and word (ui-icon-text.js iconText).
const PAUSED = /<span class="it it-grey"><span class="it-i it-dot" aria-hidden="true"><\/span><span class="it-w">paused<\/span>/g;

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

test('one human blue: no colour is named for a person or a hue, and every label on an accent fill reads --on-accent', () => {
  assert.deepEqual([...definedIn(colorsCss)].filter((v) => /love|blue/.test(v)), []);
  for (const f of ['style.css', 'sidebar.css', 'hub.css']) {
    const css = fs.readFileSync(new URL(`./public/${f}`, import.meta.url), 'utf8');
    const filled = css.split('}').filter((r) => /background:\s*var\(--accent\)/.test(r) && /[^-]color:/.test(r));
    for (const r of filled) assert.match(r, /[^-]color:\s*var\(--on-accent\)/, `${f}: ${r.trim()}`);
  }
});

test("OLED mode is a :root[data-oled] override inside the dark block: pure-black ground, panels just above it, the semantic colours untouched", () => {
  const dark = colorsCss.split('@media (prefers-color-scheme: dark)')[1];
  const [, oled] = /:root\[data-oled\]\s*\{([^}]*)\}/.exec(dark) || [];
  assert.ok(oled, 'a :root[data-oled] rule inside the dark block');
  assert.doesNotMatch(colorsCss.split('@media (prefers-color-scheme: dark)')[0], /data-oled/);
  const value = (name) => new RegExp(`${name}:\\s*([^;]+);`).exec(oled)?.[1].trim();
  assert.deepEqual(['--bg', '--panel', '--line', '--text', '--muted', '--chip', '--band', '--claude', '--accent-soft'].map(value),
    ['#000000', '#08080a', '#1c1c20', '#f2f2f5', '#85858f', '#121215', '#0d0d0f', '#17120a', '#0d141d']);
  assert.deepEqual(['--accent', '--ok', '--warn', '--bad', '--purple'].map(value), [undefined, undefined, undefined, undefined, undefined]);
});

test('every page that links colors.css applies the per-device OLED key before paint', () => {
  for (const f of ['app.html', 'log.html', 'progress-review.html', 'prototype.html']) {
    const html = fs.readFileSync(new URL(`./public/${f}`, import.meta.url), 'utf8');
    const at = html.search(/<script>[^<]*hub:oled[^<]*<\/script>/);
    assert.ok(at >= 0 && at < html.indexOf('colors.css'), f);
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
  assert.match(ui.reviewChips({ pr: openPR, reviewers: ['Jamie'], review: { Jamie: { state: 'sent', since: ago(50), github: 'jamie-gh' } } }), /title="Jamie \(jamie-gh\): sent, not reviewed yet"/);
  assert.equal(text(ui.reviewChips({ pr: openPR, reviewers: ['Jamie'], review: { Jamie: { state: 'approved', since: null, github: null } } })), 'Jamie ✓');
});

// A chip per person who reviewed: gray ● pending, orange ● commented, red ✗ changes, green ✓ approved.
test("an open PR's review chips mark each state, the board's reviewers first, then each other GitHub login that reviewed", () => {
  const review = { Ann: { state: 'unsent', since: null, github: 'ann' }, Bo: { state: 'sent', since: ago(3), github: 'bo' }, Cy: { state: 'commented', since: null, github: 'cy' } };
  const otherReviews = [{ github: 'chatgpt-codex-connector', state: 'commented' }, { github: 'dee', state: 'changes' }, { github: 'eli', state: 'approved' }];
  const chips = ui.reviewChips({ pr: openPR, reviewers: ['Ann', 'Bo', 'Cy'], review, otherReviews });
  assert.equal(text(chips), 'ann ● bo ● cy ● chatgpt-codex-connector ● dee ✗ eli ✓');
  assert.deepEqual([...chips.matchAll(/class="chip (tone-\w+)"/g)].map((m) => m[1]), ['tone-quiet', 'tone-quiet', 'tone-notice', 'tone-notice', 'tone-danger', 'tone-ready']);
  assert.match(chips, /title="Ann \(ann\): not sent yet"/);
  assert.match(chips, /title="Cy \(cy\): commented"/);
  assert.match(chips, /title="chatgpt-codex-connector \(not a board reviewer\): commented"/);
  assert.match(chips, /title="dee \(not a board reviewer\): asked for changes"/);
  const merged = ui.reviewChips({ pr: { ...openPR, state: 'MERGED', status: 'merged' }, reviewers: [], review: {}, otherReviews });
  assert.equal(text(merged), 'chatgpt-codex-connector ● dee ✗ eli ✓');
  assert.deepEqual([...merged.matchAll(/class="chip (tone-\w+)"/g)].map((m) => m[1]), ['tone-quiet', 'tone-quiet', 'tone-quiet']);
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

test('a merged PR keeps its last CI in its purple badge tooltip alone, with no CI chip', () => {
  const chips = ui.prChips({ prs: [{ ...openPR, state: 'MERGED', status: 'merged', checks: { state: 'fail', total: 3, fail: 1, pending: 0 } }] });
  assert.equal(text(chips), 'repo#7 ✓');
  assert.match(chips, /^<a class="chip tone-merged" [^>]*title="Merged · CI failing: 1 check"/);
  assert.equal(text(ui.prChips({ prs: [{ ...openPR, state: undefined, status: 'merged', checks: { state: 'pass' } }] })), 'repo#7 ✓');
});

// docs/adr/2026-11-14-1600-a-prs-one-badge-shows-draft-ready-by-ci-or-merged.md
test("a PR's one badge: draft grey dot, ready orange dot, red cross or green check by CI, with the CI in its tooltip", () => {
  const badgeOf = (pr) => ui.prChips({ prs: [{ ...openPR, ...pr }] });
  const look = (pr) => { const c = badgeOf(pr); return [/^<a class="chip (tone-\w+)"/.exec(c)[1], text(c), /title="([^"]*)"/.exec(c)[1]]; };
  assert.deepEqual(look({ isDraft: true, status: 'draft' }), ['tone-quiet', 'repo#7 ●', 'Draft · CI passed']);
  assert.deepEqual(look({ isDraft: true, status: 'draft', checks: { state: 'fail', total: 2, fail: 2, pending: 0 } }), ['tone-quiet', 'repo#7 ●', 'Draft · CI failing: 2 checks']);
  assert.deepEqual(look({ checks: { state: 'pending', total: 4, fail: 0, pending: 3 } }), ['tone-notice', 'repo#7 ●', 'Ready · CI waiting: 3 of 4 checks']);
  assert.deepEqual(look({ checks: undefined }), ['tone-notice', 'repo#7 ●', 'Ready · CI not read yet']);
  assert.deepEqual(look({ checks: { state: 'fail', total: 5, fail: 1, pending: 0 } }), ['tone-danger', 'repo#7 ✗', 'Ready · CI failing: 1 check']);
  assert.deepEqual(look({}), ['tone-ready', 'repo#7 ✓', 'Ready · CI passed']);
  assert.deepEqual(look({ checks: { state: 'none', total: 0, fail: 0, pending: 0 } }), ['tone-ready', 'repo#7 ✓', 'Ready · no CI checks']);
  // Changes requested go by CI alone; the reviewer chip says it.
  assert.equal(look({ reviewDecision: 'CHANGES_REQUESTED' })[0], 'tone-ready');
  assert.match(badgeOf({}), /aria-label="repo#7: Ready · CI passed"/);
  assert.doesNotMatch(badgeOf({}), /CI ✓/);
});

// docs/adr/2026-11-09-1626-gh-refuses-while-githubs-hourly-limit-holds.md
test("while GitHub's limit holds the hub's check, a PR's badge dims and says when it resets", () => {
  const reset = new Date(2026, 10, 9, 15, 12).toISOString();
  const chips = ui.prChips({ prs: [{ ...openPR, limited: reset }] });
  assert.equal(text(chips), 'repo#7 ✓');
  assert.equal([...chips.matchAll(/<a class="chip tone-\w+"[^>]* data-limited="">/g)].length, 1);
  assert.equal([...chips.matchAll(/title="[^"]*· GitHub rate limited, resets at 3:12 pm"/g)].length, 1);
  assert.doesNotMatch(ui.prChips({ prs: [{ ...openPR, limited: null }] }), /data-limited|rate limited/);
});

test("a card with several PRs shows a badge for each, in its order, with that PR's state, CI and link", () => {
  const site = { ...openPR, number: 1, url: 'https://github.com/o/site/pull/1', isDraft: true, status: 'draft', checks: { state: 'fail' } };
  const merged = { ...openPR, state: 'MERGED', status: 'merged' };
  const chips = ui.prChips({ prs: [merged, site] });
  assert.equal(text(chips), 'repo#7 ✓ site#1 ●');
  assert.deepEqual([...chips.matchAll(/<a class="chip (tone-\w+)" href="([^"]+)"/g)].map((m) => [m[1], m[2]]), [
    ['tone-merged', 'https://github.com/o/repo/pull/7'], ['tone-quiet', 'https://github.com/o/site/pull/1'],
  ]);
  assert.equal(ui.prChips({ prs: [] }), '');
});

test("the PR badge alone shows the PR's state, linking to the PR: a purple check once merged, a grey cross once closed, a plain name before GitHub is read", () => {
  assert.deepEqual(plain(ui.PR_STATE), { open: 'open', draft: 'draft', merged: 'merged', closed: 'closed' });
  const merged = ui.prChips({ prs: [{ ...openPR, state: 'MERGED', status: 'merged', checks: undefined }] });
  assert.equal(text(merged), 'repo#7 ✓');
  assert.match(merged, /^<a class="chip tone-merged" href="https:\/\/github\.com\/o\/repo\/pull\/7" title="Merged" [^>]*aria-label="repo#7: Merged">[^<]*<\/a>$/);
  const closed = ui.prChips({ prs: [{ ...openPR, state: 'CLOSED', status: 'closed', checks: undefined }] });
  assert.equal(text(closed), 'repo#7 ✗');
  assert.match(closed, /^<a class="chip tone-quiet" [^>]*title="Closed" [^>]*aria-label="repo#7: Closed">[^<]*<\/a>$/);
  assert.match(ui.prChips({ prs: [{ ...openPR, state: undefined, checks: undefined, status: null }] }), /^<a class="chip tone-quiet" href="[^"]+" target="_blank" rel="noopener">repo#7<\/a>$/);
});

test('the header reads the time since the last change signal or refresh, and the In Review header when GitHub was checked, each saying when it needs a look', () => {
  const checks = { at: ago(4 / 60), every: 30, late: false, watcher: 'running', claudeAt: ago(3) };
  const fresh = ago(30 / 3600);
  assert.equal(text(ui.statusLine(fresh)), 'now');
  assert.match(ui.statusLine(fresh), /title="Updated [^"]*"/);
  assert.equal(text(ui.statusLine(ago(2 / 60))), '2 min');
  assert.equal(text(ui.statusLine(ago(0))), 'now');
  assert.equal(text(ui.statusLine(ago(2), { watcher: 'running' })), '2 h');
  assert.equal(ui.statusLine(null), '');
  // The time never changes to words: only the span's class (red, orange) and title move.
  const cls = (html) => /class="([^"]*)"/.exec(html)[1];
  for (const opts of [{ watcher: 'stopped' }, { link: 'offline' }, { link: 'reconnecting' }, { watcher: 'asleep' }, { watcher: 'waking' }, { pause: { paused: true, resets_at: ago(-1) } }, { watcher: 'stopped' }]) {
    assert.equal(text(ui.statusLine(fresh, opts)), 'now', JSON.stringify(opts));
  }
  assert.equal(cls(ui.statusLine(fresh, { watcher: 'stopped' })), 'fresh', 'never coloured: the logo dot says it');
  assert.match(ui.statusLine(fresh, { watcher: 'stopped' }), /title="Claude not listening\. Updated /);
  assert.equal(cls(ui.statusLine(fresh, { link: 'offline' })), 'fresh');
  assert.equal(cls(ui.statusLine(fresh, { pause: { paused: true, resets_at: ago(-1) } })), 'fresh');
  assert.equal(cls(ui.statusLine(fresh, { watcher: 'stopped', pause: { paused: true, resets_at: ago(-1) } })), 'fresh');
  assert.equal(cls(ui.statusLine(fresh, { link: 'reconnecting' })), 'fresh');
  assert.match(ui.statusLine(fresh, { link: 'reconnecting' }), /title="Reconnecting…\. Updated /);
  assert.match(ui.statusLine(fresh, { watcher: 'asleep' }), /title="Asleep: [^"]*wakes it\. Updated /);
  assert.match(ui.statusLine(fresh, { watcher: 'waking' }), /title="Waking: /);
  assert.match(ui.statusLine(fresh, { watcher: 'asleep', waking: true }), /title="Asleep: /, 'a client flag no longer says waking');
  // The time and the arrow go orange (class late) only once the data is more than 60 s old, whatever else the header says.
  const sec = (n) => new Date(NOW - n * 1000).toISOString();
  assert.equal(cls(ui.statusLine(sec(59))), 'fresh');
  assert.equal(cls(ui.statusLine(sec(61))), 'fresh late');
  assert.equal(cls(ui.statusLine(sec(61), { watcher: 'stopped', link: 'offline' })), 'fresh late');
  assert.equal(cls(ui.statusLine(sec(59), { watcher: 'stopped', pause: { paused: true, resets_at: ago(-1) } })), 'fresh');
  assert.equal(text(ui.statusLine(undefined, { link: 'offline' })), '');
  assert.equal(text(ui.githubLine(checks)), 'GitHub 4 min');
  assert.match(ui.githubLine(checks), /<svg class="gh-mark"[^>]*aria-label="GitHub"/);
  assert.equal(text(ui.githubLine({ ...checks, requested: { at: checks.at, state: 'pending' } })), 'GitHub Checking…');
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

test("the GitHub refresh spins and rests only while the server's checks.requested reads pending", () => {
  const checks = (state) => ({ at: '2026-10-23T11:59:00.000Z', requested: state && { at: '2026-10-23T12:00:00.000Z', state } });
  const spinning = (html) => /aria-disabled="true"/.test(html) && /class="[^"]*\bspinning\b/.test(html);
  for (const [state, pending] of [[null, false], ['landed', false], ['gave-up', false], ['pending', true]]) {
    assert.equal(spinning(ui.githubRefresh(checks(state))), pending, String(state));
    assert.equal(/Checking…/.test(ui.githubLine(checks(state))), pending, String(state));
  }
  assert.match(ui.githubRefresh({ at: null }), /data-check-github/);
  assert.match(ui.githubRefresh(null), /data-check-github/);
  assert.equal(ui.checkLanded, undefined);
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
// docs/adr/2026-11-15-1200-notes-ride-the-boards-sync.md: and the notes of the cards still on it.
test("the saved copy keeps the board whole, its change number included, and the threads and notes of the cards still on it", () => {
  const savedAt = '2026-10-23T08:00:00.000Z';
  const board = { version: 1762400000123, generatedAt: savedAt, items: [{ key: 'w/A', lane: 'todo', changed: 1762400000120 }, { key: 'w/B', lane: 'done', changed: 1762400000123 }] };
  const threads = new Map([['w/B', [{ text: 'b' }]], ['w/A', [{ text: 'a' }]], ['w/gone', [{ text: 'x' }]]]);
  const notes = new Map([['w/A', '# A'], ['w/gone', '# Gone']]);
  const copy = ui.copyOf(board, threads, notes, { build: 'b1', savedAt });
  assert.deepEqual(plain(copy), { build: 'b1', savedAt, board, threads: { 'w/B': [{ text: 'b' }], 'w/A': [{ text: 'a' }] }, notes: { 'w/A': '# A' } });
  const back = plain(ui.readCopy(plain(copy), 'b1'));
  assert.deepEqual([back.savedAt, back.board, Object.keys(back.threads), back.notes], [savedAt, board, ['w/B', 'w/A'], { 'w/A': '# A' }]);
});

test('a stored copy that is damaged, saved under another build, undated or holding no change number reads as none', () => {
  const good = plain(ui.copyOf({ version: 7, items: [{ key: 'w/A', lane: 'todo' }] }, new Map(), new Map(), { build: 'b1', savedAt: '2026-10-23T08:00:00.000Z' }));
  assert.ok(ui.readCopy(good, 'b1'));
  assert.equal(ui.readCopy(good, 'b2'), null);
  for (const odd of [null, undefined, 'text', { ...good, build: undefined }, { ...good, board: { ...good.board, items: undefined } }, { ...good, savedAt: 'soon' }, { ...good, board: { ...good.board, version: 'v1' } }]) {
    assert.equal(ui.readCopy(odd, 'b1'), null, JSON.stringify(odd));
  }
  assert.deepEqual(Object.keys(ui.readCopy({ ...good, threads: { 'w/A': 'text', 'w/B': [{ text: 'b' }] } }, 'b1').threads), ['w/B']);
  assert.deepEqual(plain(ui.readCopy({ ...good, notes: { 'w/A': ['x'], 'w/B': '# B' } }, 'b1').notes), { 'w/B': '# B' });
  assert.deepEqual(plain(ui.readCopy({ ...good, notes: undefined }, 'b1').notes), {}, 'a copy saved before notes rode the sync reads as holding none');
});

// docs/adr/2026-11-14-1340-threads-ride-the-boards-sync.md
test("after a whole board every card's thread loads, Done's and New's too: the open cards' first, then those the page lacks, then those it holds, each in board order", () => {
  const items = ['review', 'progress', 'todo', 'new', 'done', 'done'].map((lane, n) => ({ key: `w/${n}`, lane }));
  assert.deepEqual(plain(ui.fillOrder(items, new Set(['w/4']), new Map([['w/0', []], ['w/3', []]]))), { open: ['w/4'], rest: ['w/1', 'w/2', 'w/5', 'w/0', 'w/3'] });
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
  assert.doesNotMatch(logo, /settingsLink|archBulb/, 'the gear and bulb are rows of the board menu');
  assert.equal(text(logo), 'iOS <Orchestrator> …');

  // navAfter's slot is right of the refresh and its time and ends the nav: the board's search, filter and waits mark
  // (docs/adr/2026-11-17-2000-one-board-filter-replaces-waiting-on-you.md).
  const withSlot = ui.header({ lead: 'logo', title: 'Board', navAfter: '<span id="waitsChip"></span>' });
  assert.match(withSlot, /id="refresh"[^]*id="status"[^]*<\/span><span id="waitsChip"><\/span><\/nav>/);
  assert.doesNotMatch(withSlot, /questionsLink|pages-switch/);

  const back = ui.header({ lead: 'back', backHref: '/', backLabel: 'Back to Claude', title: 'Settings', logoSrc: '/_hub/kickflip.png', time: 'now' });
  assert.match(back, /^<header class="top"><div class="brand"><a class="hub" href="\/_hub\/" aria-label="Boards"><img src="\/_hub\/kickflip\.png" alt=""><\/a><a class="back" href="\/" aria-label="Back to Claude"><svg width="24" height="24"[^>]*>.*?<\/svg><\/a><h1>Settings<\/h1><\/div>/);
  assert.equal((back.match(/class="hub"/g) || []).length, 1);
  assert.ok(back.indexOf('class="hub"') < back.indexOf('class="back"'), 'the icon comes before the back button');
  assert.match(back, /id="status">now</);

  const bare = ui.header({ lead: 'back', title: 'Notes', titleId: 'gtitle', backId: 'back', controls: false, trail: '<span class="muted small" id="progress"></span>' });
  assert.match(bare, /<a class="back" href="\.\/" id="back" aria-label="Back to the board">/);
  assert.match(bare, /<h1 id="gtitle">Notes<\/h1><\/div><span class="muted small" id="progress"><\/span><\/header><script>[\s\S]*<\/script>$/);
  assert.doesNotMatch(bare, /id="refresh"|settingsLink/);
  assert.doesNotMatch(logo, /<script>/);
});

test("a board's sidebar row shows its context at the top right beside its name, red from 90% and dimmed once stale", () => {
  const site = (route, ctx) => ({ route, title: route, board: true, count: 0, icon: '', sub: { status: { shape: 'pulse', colour: 'orange', word: 'Working' }, stale: false, chips: null }, ctx });
  const ago = (ms) => new Date(NOW - ms).toISOString();
  const html = ui.sidebar({ sites: [site('a', { percent: 62, full: false, at: ago(60_000) }), site('b', { percent: 91, full: true, at: ago(3 * 3600_000) }), site('c', null), site('d')] });
  const heads = [...html.matchAll(/<span class="sb-head">(.*?<\/span>)<\/span>(?=<span class="sb-sub">|<\/span><\/a>)/g)].map((m) => m[1]);
  assert.deepEqual(heads, [
    '<span class="sb-title">a</span><span class="sb-ctx" title="62% of its context window">62% ctx</span>',
    '<span class="sb-title">b</span><span class="sb-ctx full stale" title="91% of its context window, read 3 h ago">91% ctx</span>',
  ]);
  assert.equal(html.match(/sb-ctx/g).length, 2);
  assert.doesNotMatch(html, /<span class="sb-status">.*?Working<\/span><\/span><span class="sb-ctx/);
  assert.match(html, /<span class="sb-title">c<\/span><span class="sb-sub">/);
});

test("the Kickflip sidebar lists Hub, notifications, Pages, then Boards with New last", () => {
  const site = (route, board, count, sub = null) => ({ route, title: route.toUpperCase(), board, count, icon: `<i data-r="${route}"></i>`, sub });
  const data = {
    sites: [site('ios', true, 2, { status: null, stale: false, chips: [{ lane: 'needs', text: '2 need you' }] }), site('learn', false, 1), site('shop', true, 0), site('hub', true, 3)],
    hub: { tone: 'ok', word: 'healthy', detail: '4 of 4 sites up' }, notifications: { state: 'on', text: 'On' }, polling: { text: 'Every 15 min · next 4:45pm' },
  };
  const html = ui.sidebar(data, { here: 'ios', device: 'on' });
  assert.equal(text(html), 'Kickflip Hub healthy 4 of 4 sites up Pages LEARN Boards IOS 2 need you SHOP HUB New');
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
    assert.equal(/class="it it-red"><span class="it-i it-dot" aria-hidden="true"><\/span><span class="it-w">Notifications/.test(hubRow), urgent);
    const mark = /<span class="sb-title">Hub<span class="sb-moon" role="img" aria-label="([^"]*)" title="([^"]*)"><svg /.exec(hubRow);
    assert.deepEqual(mark && [mark[1], mark[2]], moon && [moon, moon]);
  }
  for (const here of ['_hub', '_hub/', '_hub/settings', '_hub/settings/polling']) {
    const selected = [...ui.sidebar(data, { here }).matchAll(/<a class="sb-row on" href="([^"]+)" aria-current="page"/g)].map((m) => m[1]);
    assert.deepEqual(selected, ['/_hub/'], here);
  }
  assert.match(ui.sidebar({ sites: [] }), /data-new-board aria-haspopup="dialog"/);
});

test("pending boards have muted non-link rows, a failed start keeps its name with failed to start and opens its sheet, and New stays last in Boards", () => {
  const data = { sites: [{ route: 'page', title: 'Page', board: false, icon: '' }], starting: [
    { route: 'new', title: 'Backend <audit>', step: 'starting', stepAt: new Date(NOW).toISOString(), failed: false },
    { route: 'cloning', title: 'Cloning board', step: 'cloning', stepAt: new Date(NOW).toISOString(), failed: false },
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

// docs/adr/2026-11-18-0800-tapping-a-down-course-resumes-it-for-the-next-lesson.md
test("a course page whose session is down carries the tap that asks to resume it; a running one and a board's row do not", () => {
  const down = { route: 'rust', title: 'Rust "ownership"', board: false, icon: '', listen: 'asleep' };
  const html = ui.sidebar({ sites: [down, { ...down, route: 'go', listen: 'starting' }, { ...down, route: 'plain', listen: undefined }, { route: 'shop', title: 'Shop', board: true, icon: '', listen: 'asleep' }] }, { now: NOW });
  assert.equal([...html.matchAll(/data-resume-course="([^"]+)"/g)].map((m) => m[1]).join(), 'rust');
  assert.match(html, /data-title="Rust &quot;ownership&quot;"/);
});

// docs/adr/2026-11-18-0600-new-starts-a-board-or-a-teach-course.md
test("a starting course's row ends the Pages group, above the Boards label, orange while /teach writes lesson 1, and a failed one reads /teach failed", () => {
  const at = new Date(NOW - 42_000).toISOString();
  const data = { sites: [{ route: 'learn', title: 'Learn', board: false, icon: '' }, { route: 'shop', title: 'Shop', board: true, icon: '' }], starting: [
    { route: 'rust', title: 'Rust ownership', course: true, step: 'starting', stepAt: at, failed: false },
    { route: 'shop-2', title: 'Shop 2', step: 'starting', stepAt: at, failed: false },
    { route: 'bread', title: 'Bread', course: true, failed: true, error: 'claude --bg failed (1)' },
  ] };
  const html = ui.sidebar(data, { now: NOW });
  const pages = /<section class="sb-pages"[^>]*>(.*?)<\/section>/.exec(html)[1];
  const boards = /<section class="sb-boards"[^>]*>(.*?)<\/section>/.exec(html)[1];
  assert.equal(text(pages), 'Pages Learn Rust ownership writing lesson 1 · 42s Bread /teach failed');
  assert.match(pages, /<div class="sb-row sb-starting sb-course" data-starting="rust"><span class="icon sb-plus sb-start-icon" aria-hidden="true"><svg [^>]*><path d="M2 5h6/);
  assert.match(pages, /class="it it-orange"><span class="it-i it-dot" aria-hidden="true"><\/span><span class="it-w">writing lesson 1 · 42s/);
  assert.doesNotMatch(pages, /sb-steps/, 'a course has one step and no bars');
  assert.match(pages, /data-failed-start="bread"/);
  assert.match(text(boards), /^Boards Shop Shop 2 .*New$/);
  assert.equal(text(ui.sidebar({ sites: [], starting: [data.starting[0]] }, { now: NOW })).includes('Pages Rust ownership'), true, 'a course alone shows the Pages label');
  assert.equal(text(ui.sidebar({ sites: [], starting: [{ ...data.starting[0], activity: 'Searching the web' }] }, { now: NOW })).includes('Searching the web · 42s'), true);
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
    const html = ui.sidebar({ sites: [], starting: [{ route: 'audit', title: 'Backend audit', failed: false, stepAt: new Date(NOW).toISOString(), ...s }] });
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
  const course = ui.failedStart({ route: 'rust', title: 'Rust', repo: '/Users/you/.claude/kickflip/pages/rust', course: true, askedAt: ago(50), failed: true }, { home: '/Users/you', now });
  assert.equal(text(course), "Rust failed to start ✕ Its session didn't answer within 45 minutes. Repo ~/.claude/kickflip/pages/rust Asked 50 min ago Dismiss");
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

test("a board's fragment names the focused card and the filter boxes a link shows, reads the older #item= link as the card, and a card change drops the rest", () => {
  const routerContext = vm.createContext({ Date: PageDate, URL });
  vm.runInContext(fs.readFileSync(new URL('./public/router.js', import.meta.url), 'utf8'), routerContext);
  const { fragmentOf, hashWith, viewOf } = routerContext.AppRouter;
  const none = { selectedCard: null, review: null, reply: false, show: null };
  assert.deepEqual(plain(fragmentOf('#selectedCard=w%2FA1')), { ...none, selectedCard: 'w/A1' });
  assert.deepEqual(plain(fragmentOf('#item=w%2FA1&reply')), { ...none, selectedCard: 'w/A1', reply: true });
  assert.deepEqual(plain(fragmentOf('#review=12')), { ...none, review: 12 });
  assert.deepEqual(plain(fragmentOf('#show=action,questions')), { ...none, show: ['action', 'questions'] });
  assert.deepEqual(plain(fragmentOf('')), none);
  assert.equal(hashWith('#item=w%2FA1&reply', {}), '#selectedCard=w%2FA1');
  assert.equal(hashWith('#show=questions', { selectedCard: 'w/B' }), '#selectedCard=w%2FB');
  assert.equal(hashWith('#selectedCard=w%2FA1', { selectedCard: null }), '');
  const read = (url) => plain(viewOf(`https://mac.ts.net${url}`, { boards: new Set(['orch']), base: 'https://mac.ts.net/orch/' }));
  assert.deepEqual(read('/orch/#show=action,questions'), { kind: 'board', route: 'orch', hash: '#show=action,questions' });
  assert.deepEqual(read('/orch/questions.html#openItemsCard=q-1'), { kind: 'questions', route: 'orch', id: 'q-1' });
  assert.deepEqual(read('/orch/questions.html'), { kind: 'questions', route: 'orch', id: null });
});

test("the app's router reads every hub URL as a view and writes each view back as that URL, every push link's shape included, and mounts a board, its Settings, an old Waiting on you link and Notes, the hub's pages, and every other page in a frame, in place", () => {
  const routerContext = vm.createContext({ Date: PageDate, URL });
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
    ['/orch/', '/orch/#selectedCard=w%2FA1&reply', '/orch/settings.html', '/orch/questions.html#q-1', '/orch/notes.html?item=w%2FA1',
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
  const context = vm.createContext({ Date: PageDate, URL, URLSearchParams, location, history,
    HashChangeEvent: class { constructor(type) { this.type = type; } }, dispatchEvent: (e) => handlers[e.type]?.(e),
    document: { addEventListener: (type, fn) => { handlers[`document:${type}`] = fn; } },
    addEventListener: (type, fn) => { handlers[type] = fn; } });
  for (const file of ['ui-page-header.js', 'router.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), context);
  const shown = [];
  const router = context.AppRouter.listen({ boards: () => new Set(['orch']),
    go: (view, href, how) => {
      shown.push(`${how} ${view.kind}`);
      if (how === 'push') router.push(href);
      if (how === 'replace') router.replace(href);
      return true;
    } });
  const tap = (href, { cls = '' } = {}) => {
    const a = { href: new URL(href, location.href).href, target: '', hasAttribute: () => false, classList: { contains: (c) => c === cls } };
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

// docs/adr/2026-11-17-2000-one-board-filter-replaces-waiting-on-you.md
test("in the app, an old Waiting on you link is a view the shell shows on the board, so a tap on one is pushed like any page and a push keeps its mark", () => {
  const board = appHistory('https://mac.ts.net/orch/');
  assert.equal(board.tap('questions.html#q1'), 'push questions');
  assert.deepEqual(board.stack(), ['', 'questions.html#q1']);
  const cold = appHistory('https://mac.ts.net/orch/questions.html?from=push#q1');
  assert.deepEqual([cold.stack(), plain(cold.history.state)], [['questions.html#q1'], { idx: 0, pushed: true }]);
});

// docs/adr/2026-11-16-0514-prototypes-and-visuals-open-in-the-reader-sheet.md
test("a board's prototype or visual page is a card page, which opens in the board's sheet, and no other page is", () => {
  const routerContext = vm.createContext({ Date: PageDate, URL });
  vm.runInContext(fs.readFileSync(new URL('./public/router.js', import.meta.url), 'utf8'), routerContext);
  const { viewOf, isCardPage } = routerContext.AppRouter;
  const boards = new Set(['orch']);
  const card = (url) => isCardPage(viewOf(`https://mac.ts.net${url}`, { boards, base: 'https://mac.ts.net/orch/' }), boards);
  assert.deepEqual(['/orch/prototype-x.html?q=q1&from=push', '/orch/prototype-snooze-2.html', '/orch/visuals/A1/flow-2.html'].map(card), [true, true, true]);
  assert.deepEqual(['/orch/', '/orch/questions.html#q1', '/orch/shots-gallery.html', '/orch/visuals/flow.html', '/learn/prototype-x.html', '/orch/uploads/prototype-x.html'].map(card), [false, false, false, false, false, false]);
});

test("a thread's visual line is a plain link to its card page, so the shell opens it in the sheet and not in a new tab", () => {
  const html = ui.threadMessages([{ ts: ago(1), who: 'claude', kind: 'visual', text: 'Flow', link: 'visuals/A1/flow.html' }]);
  assert.match(html, /<a href="visuals\/A1\/flow\.html">Flow →<\/a>/);
  assert.doesNotMatch(html, /target=/);
});

test('Action needed shows only while the card waits on the owner, as orange words that link to what they act on', () => {
  assert.equal(ui.actionWords({ questions: { open: 2, first: 'q1' }, action: null }), '');
  const pick = ui.actionWords({ action: { kind: 'pick', url: 'https://mac.ts.net/r/prototype-x.html?q=q1', label: 'Prototypes ready: pick a take' } });
  assert.match(pick, /^<a class="card-action card-open-items" href="https:\/\/mac\.ts\.net\/r\/prototype-x\.html\?q=q1"[^>]*>Open items<\/a>$/);
  assert.doesNotMatch(pick, /target=|chip/);
  assert.match(ui.actionWords({ action: { kind: 'ready', url: 'https://github.com/o/r/pull/7', label: 'Tap Ready on GitHub' } }), /href="https:\/\/github\.com\/o\/r\/pull\/7"[^>]*target="_blank"/);
});

test('a card waiting on your answers reads Open items, and every other kind reads Action needed', () => {
  const word = (kind) => ui.actionWords({ action: { kind, url: '#u', label: 'L' } }).replace(/<[^>]*>/g, '');
  for (const kind of ['pick', 'questions']) assert.equal(word(kind), 'Open items');
  for (const kind of ['implement', 'close', 'merge', 'ready', 'steps', 'stalled']) assert.equal(word(kind), 'Action needed');
  assert.match(ui.actionWords({ action: { kind: 'questions', url: '#u', label: 'L' } }), /aria-label="Open items: L"/);
  assert.match(ui.actionWords({ action: { kind: 'merge', url: '#u', label: 'L' } }), /aria-label="Action needed: L"/);
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

test("a thread names the board's session Orchestrator and a builder Builder", () => {
  const html = ui.threadMessages([
    { ts: ago(3), who: 'Claude Opus builder', kind: 'builder-ask', text: 'Stay orange?' },
    { ts: ago(2), who: 'claude', kind: 'builder-answer', text: 'Go quiet.' },
    { ts: ago(1), who: 'claude', text: 'Landed.' },
  ]);
  assert.match(text(html), /^Builder Stay orange\? \S.* Orchestrator Go quiet\. \S.* Orchestrator Landed\. \S.*$/);
  assert.match(html, /<div class="msg builder"[^>]*>\s*<div class="who">Builder<\/div>/);
  assert.match(html, /<div class="msg claude"[^>]*>\s*<div class="who">Orchestrator<\/div>/);
});

// docs/adr/2026-11-14-1700-every-thread-message-has-the-owners-shape-and-its-time-in-a-footer.md
test("every sender's message is its name alone, the body, then a footer with its time", () => {
  const at = ago(1);
  const footer = (name, extra = '') => new RegExp(`<div class="who">${name}</div>[\\s\\S]*<div class="reply muted small msg-foot"><span>${ui.esc(ui.time(at))}</span>${extra}</div>`);
  const draw = (m) => ui.threadMessages([{ ts: at, text: 'Hi', ...m }]);
  assert.match(draw({ who: 'claude' }), footer('Orchestrator'));
  assert.match(draw({ who: 'claude', kind: 'reply', reply: { md: 'ok' } }), footer('Orchestrator'));
  assert.match(draw({ who: 'Claude Opus builder', kind: 'builder-ask' }), footer('Builder'));
  assert.match(draw({ who: 'builder', kind: 'builder-summary' }), footer('Builder'));
  assert.match(draw({ who: 'Claude planner' }), footer('Claude planner'));
  assert.match(draw({ who: 'Jamie', via: 'github' }), footer('Jamie', '<span>·</span><span>GitHub</span>'));
  assert.match(draw({ who: 'Sam', via: 'slack' }), footer('Sam', '<span>·</span><span>Slack</span>'));
  // A reply copied from a task's Slack thread by someone else: a grey .msg.slack headed "<name> · via Slack", with the link.
  const copied = draw({ who: 'love', via: 'slack', by: 'Pete', link: 'https://acme.slack.com/x', eventId: 'e2' });
  assert.match(copied, /<div class="msg slack"[^>]*>\s*<div class="who">Pete · via Slack<\/div>/);
  assert.match(copied, /acme\.slack\.com\/x/);
  assert.doesNotMatch(copied, /msg love|<span>Slack<\/span>/);
  // Without a sender it is the owner's own @kickflip: blue, You.
  assert.match(draw({ who: 'love', via: 'slack', link: 'https://acme.slack.com/x', eventId: 'e3' }), /<div class="msg love"[^>]*>\s*<div class="who">You<\/div>/);
  assert.match(draw({ who: 'love', via: 'site', kind: 'item-message', eventId: 'e1', reply: null, state: 'waiting' }), footer('You', '<span>·</span><span>waiting…</span>'));
  assert.doesNotMatch(draw({ who: 'claude' }), /waiting/);
  assert.doesNotMatch(draw({ who: 'claude' }), /Orchestrator ·/);
});

test('a time reads the time only today and the date and time on another day', () => {
  const now = new Date(2026, 10, 14, 15, 0);
  assert.equal(ui.time(new Date(2026, 10, 14, 14, 28).toISOString(), now), '2:28 pm');
  assert.equal(ui.time(new Date(2026, 10, 13, 14, 28).toISOString(), now), '11/13, 2:28 pm');
});

test('a thread names who wrote each message and where', () => {
  const html = ui.threadMessages([
    { ts: ago(2), who: 'Jamie', via: 'github', text: 'Looks good' },
    { ts: ago(1), who: 'love', via: 'site', text: 'Ship it', eventId: 'e1', reply: null },
  ]);
  assert.match(text(html), /^Jamie Looks good \S.* · GitHub You Ship it \S.* · waiting…$/);
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
  const suggested = { ...question, suggested: { option: 'A', task: '#186', answer: 'Keep, nothing floats over a question.' } };
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
  const answered = { ...suggested, state: 'open', answers: [{ ts: ago(1), choice: 'B', note: '', reply: null }] };
  assert.deepEqual(checked(ui.questionCard(answered)), [false, true]);
  assert.equal(ui.choiceOf(suggested, {}), 'A');
  assert.equal(ui.choiceOf(answered, {}), 'B');
  assert.equal(ui.choiceOf(question, {}), null);
  assert.equal(ui.choiceOf(suggested, { choice: null }), null, 'a cleared pick stays cleared, not the suggestion');
  assert.equal(ui.choiceOf(answered, { choice: null }), null);
});

test("a sent question, waiting on Claude, replied to or resolved, draws as the green Resolved card, numbered, locked at its pick, with a plain Resolved badge and no reopen", () => {
  const sent = (state) => ui.questionCard({ ...question, state, answers: [{ ts: ago(1), choice: 'B', note: '', reply: null }] }, { n: 3 });
  for (const state of ['answered', 'replied', 'resolved']) {
    const html = sent(state);
    assert.match(html, /^<section class="q resolved" id="q1"/);
    assert.match(html, /<span class="muted small">3\. Triage<\/span><span class="chip tone-ready">✓ Resolved<\/span>/);
    assert.match(html, /<div class="sent-line">Sent\.<\/div>/);
    assert.doesNotMatch(html, /<button|data-reopen|reopen/i);
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
test('a question asked for a prototype reads prototype requested with a spinner, locked at the pick and note the request sent, with no Prototype, until its round arrives', () => {
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
test('an open question has its Prototype on and nothing locked, a resolved one has no Prototype; a confirm opens the viewer on its one take and says why it is asked', () => {
  assert.match(ui.questionCard(question), /<button type="button" class="req" data-proto="q:q1" aria-label="Ask for a prototype instead" title="Ask for a prototype instead">/);
  assert.doesNotMatch(ui.questionCard(question), /disabled|pr-busy|try-spin/);
  assert.doesNotMatch(ui.questionCard({ ...question, state: 'resolved' }), /data-proto/);
  // docs/adr/2026-11-15-0730-each-question-has-the-threads-request-row.md: under the note box, the thread
  // reply's row: Prototype, Grill and Visual, the attach icon inside the note box.
  const card = ui.questionCard(question);
  assert.match(card, /<div class="dz"><textarea class="note"[^>]*><\/textarea><button[^>]*data-paste[^>]*>Paste<\/button><label class="attach"[\s\S]*<div class="dz-hint"/);
  assert.ok(card.includes(`<div class="note-tools"><div class="pending-files" data-files></div>${ui.requestRow('q:q1', { protoLabel: 'Ask for a prototype instead' })}</div>`));
  assert.deepEqual([...ui.requestRow('q:q1').matchAll(/data-(proto|grill|visual|review|attach)/g)].map((m) => m[1]), ['proto', 'grill', 'visual', 'review']);
  assert.match(ui.requestRow('q:q1'), /^<span class="request-row">/);
  // Each word carries its key hint, ⌥ on a Mac and Alt+ elsewhere (style.css shows it where there is a keyboard).
  assert.doesNotMatch(ui.requestRow('q:q1'), /data-quick|What's left/);
  // Each word is in its own span that clips with an ellipsis, beside the hint (style.css .req-word).
  assert.match(ui.requestRow('q:q1'), /<span class="req-word">Grill<\/span><span class="key-hint" aria-hidden="true">(⌥|Alt\+)G<\/span>/);
  // docs/adr/2026-11-16-2300-review-in-a-thread-launches-a-reviewer.md: Review is the fifth word of every request row, after Visual.
  assert.match(ui.requestRow('q:q1'),/Review<\/span><span class="key-hint" aria-hidden="true">(⌥|Alt\+)R<\/span>/);
  assert.equal(ui.requestOf({ hasAttribute: (a) => a === 'data-review' }), 'review');
  // Alt+letter presses its word's button within a scope: not with Ctrl or ⌘, not a button that is disabled or absent.
  const grill = { disabled: false };
  const scope = { querySelector: (sel) => ({ 'button[data-grill]': grill, 'button[data-visual]': { disabled: true } })[sel] ?? null };
  assert.equal(ui.keyedRequest({ altKey: true, code: 'KeyG' }, scope), grill);
  assert.equal(ui.keyedRequest({ altKey: true, code: 'KeyL' }, scope), null);
  assert.equal(ui.keyedRequest({ altKey: true, ctrlKey: true, code: 'KeyG' }, scope), null);
  assert.equal(ui.keyedRequest({ code: 'KeyG' }, scope), null);
  assert.equal(ui.keyedRequest({ altKey: true, code: 'KeyV' }, scope), null);

  const confirm = { ...question, id: 'c1', question: 'Is this it?', url: 'prototype-search.html?q=c1', options: [{ id: 'B', label: 'Icon' }], round: 1, confirm_of: 'q1' };
  const open = ui.questionCard(confirm);
  assert.match(open, /<a class="button proto-view" href="prototype-search\.html\?q=c1&amp;variant=B">View prototypes<\/a>/);
  assert.doesNotMatch(open, /pr-open|Open the prototype|[?&]take=/);
  assert.match(text(open), /A pick with a note gets a one-take confirm once Claude has updated the take\./);
  assert.deepEqual(frames(open), []);
  assert.doesNotMatch(ui.questionCard({ ...confirm, state: 'answered', answers: [{ ts: ago(1), choice: 'B', note: '', reply: null }] }), /one-take confirm/);
  assert.doesNotMatch(ui.questionCard({ ...confirm, url: 'prototype-search.html?q=c1', confirm_of: undefined }), /pr-open|one-take confirm/);
});

test('a resolved question is read-only: its pick checked and locked, no note box or Prototype, how it was resolved and when it was acted on, and the note said once', () => {
  const at = new Date(NOW - 3 * 3600_000).toISOString();
  const answer = { ts: new Date(NOW - 4 * 3600_000).toISOString(), choice: 'B', note: 'Drop it, it is noise', files: [], reply: null, acted: true };
  const html = ui.questionCard({ ...question, state: 'resolved', resolved: 'Kept it', resolved_at: at, answers: [answer], reask: null });
  assert.match(text(html), /Kept it\. acted on 3h ago ?\./);
  assert.doesNotMatch(html, /A new answer reopens it|<textarea|data-proto|<details/);
  assert.deepEqual([...html.matchAll(/<input [^>]*>/g)].map((m) => [/value="(\w)"/.exec(m[0])[1], /\bchecked\b/.test(m[0]), /\bdisabled\b/.test(m[0])]), [['A', false, true], ['B', true, true]]);
  assert.equal(html.split('Drop it, it is noise').length, 2, 'the note shows once');
  assert.doesNotMatch(text(html), /You · [^]*B\. Drop/, 'the pick is the checked option, not said again');
  assert.match(html, /<span class="chip tone-ready">✓ Resolved<\/span>/);
  assert.doesNotMatch(html, /re-ask requested/);
  const pending = ui.questionCard({ ...question, state: 'resolved', resolved: 'Kept it', resolved_at: at, answers: [answer], reask: { id: 'r1', ts: new Date(NOW).toISOString() } });
  assert.match(text(pending), /re-ask requested/);
});

test("a resolved question keeps Claude's reply under the note, and one with no answer shows no answer box", () => {
  const answer = { ts: new Date(NOW).toISOString(), choice: 'A', note: '', files: [], reply: { html: '<p>Done that.</p>' }, acted: true };
  const html = ui.questionCard({ ...question, state: 'resolved', resolved: 'Kept it', answers: [answer] });
  assert.match(text(html), /Claude Done that\./);
  assert.doesNotMatch(text(html), /acted on/, 'with no resolved_at it says no time');
  assert.doesNotMatch(ui.questionCard({ ...question, state: 'resolved', resolved: 'Kept it' }), /class="ans/);
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

// docs/adr/2026-11-15-0840-the-open-card-rows-start-at-its-links-and-drop-status-review-and-ci.md
test("the open card's details list ends with Notes, Install and GitHub links in order, omitting links that do not apply; Notes has no summary or button, and a ready card's Implement is filled orange", () => {
  const app = vm.createContext({ Date: PageDate, document: { addEventListener() {} }, CSS: { escape: (s) => s }, matchMedia: () => ({ matches: false }) });
  for (const file of ['ui-icon-text.js', 'ui.js','ui-links.js', 'ui-enums.js', 'ui-progress-bar.js', 'ui-cards.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), app);
  const clicks = [], later = [];
  const B = { $: () => ({ addEventListener() {}, removeEventListener() {} }), atUnmount() {}, alive: () => false, on: (el, type, fn) => { if (type === 'click') clicks.push(fn); }, later: (ms, fn) => later.push([ms, fn]), store: {}, state: { board: { items: [] }, mainPull: { open: false } }, seen: {}, thread: () => '', links: (key) => app.BoardUI.linkContext([], key) };
  app.BoardView = { part: (fn) => fn(B) };
  vm.runInContext(fs.readFileSync(new URL('./public/app-cards.js', import.meta.url), 'utf8'), app);
  const open = { ...workCard, pr: null, prs: [], reviewers: [], key: 'w/A1', action: null, deps: [], manualSteps: [], kind: 'work', holdable: true, hasNotes: true, notes: 'Old short note', summary: 'A stored summary' };
  const rows = (it) => [...B.detail(it).matchAll(/<dt[^>]*>(.*?)<\/dt><dd[^>]*>(.*?)<\/dd>/g)].map(([, k, v]) => [text(k), text(v)]);
  const pushed = { ...open, ref: 'INT-12', next: 'merge INT-12 into main', branch: 'INT-12', pushed: { branch: 'INT-12', at: new Date(NOW - 25 * 60_000).toISOString(), host: 'gitlab.com' } };
  assert.deepEqual(rows(pushed), [['Tags', '+ Add tag'], ['Branch', 'INT-12'], ['Next', 'merge INT-12 into main'], ['Links', 'Pushed INT-12 to gitlab.com · 25m ago']]);
  assert.doesNotMatch(B.detail(pushed), /github\.com|gitlab\.com\/|<button[^>]*data-copy/);
  // Notes is a button at the end of the workflow row, after Block, and has no ↗.
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
  assert.deepEqual(rows(open), [['Tags', '+ Add tag'], ['Next', 'Waiting for PR reviewers']]);
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

// docs/adr/2026-11-15-0840-the-open-card-rows-start-at-its-links-and-drop-status-review-and-ci.md
test("an open PR's card reads its merge state in a Merge row, after the card links and Risk and before Branch, with no CI or Review row; an unread merge state draws no row", () => {
  const app = vm.createContext({ Date: PageDate, document: { addEventListener() {} }, CSS: { escape: (s) => s }, matchMedia: () => ({ matches: false }) });
  for (const file of ['ui-icon-text.js', 'ui.js','ui-links.js', 'ui-enums.js', 'ui-progress-bar.js', 'ui-cards.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), app);
  const B = { $: () => ({ addEventListener() {}, removeEventListener() {} }), atUnmount() {}, on() {}, later() {}, store: {}, state: { board: { items: [] } }, seen: {}, thread: () => '', links: (key) => app.BoardUI.linkContext([], key) };
  app.BoardView = { part: (fn) => fn(B) };
  vm.runInContext(fs.readFileSync(new URL('./public/app-cards.js', import.meta.url), 'utf8'), app);
  const rows = (it) => [...B.detail(it).matchAll(/<dt[^>]*>(.*?)<\/dt><dd[^>]*>(.*?)<\/dd>/g)].map(([, k, v]) => [text(k), text(v)]);
  const pr = { ...openPR, mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', checks: { state: 'fail', fail: 2 } };
  const card = { ...workCard, key: 'w/A1', ref: 'A1', lane: 'review', action: null, deps: [], kind: 'work', pr, prs: [pr], reviewers: ['Jamie'], review: { Jamie: { state: 'approved' } },
    related: [{ key: 'w/A2', ref: 'A2' }], risk: 'medium', branch: 'A1', manualSteps: ['Restart the hub'] };
  assert.deepEqual(rows(card).map(([label]) => label), ['Tags', 'Related to', 'Risk', 'Merge', 'Branch', 'Manual steps', 'Next', 'Links']);
  assert.deepEqual(rows(card).find(([label]) => label === 'Merge'), ['Merge', 'blocked']);
  for (const unread of [{ ...pr, mergeStateStatus: undefined }, { ...pr, mergeStateStatus: undefined, reviewDecision: undefined, checks: null }]) {
    assert.deepEqual(rows({ ...card, pr: unread, prs: [unread] }).map(([label]) => label), ['Tags', 'Related to', 'Risk', 'Branch', 'Manual steps', 'Next', 'Links']);
  }
  for (const state of ['MERGED', 'CLOSED']) assert.equal(rows({ ...card, pr: { ...pr, state }, prs: [{ ...pr, state }] }).some(([label]) => label === 'Merge'), false);
});

test("collapsing the card the URL selects drops its selectedCard; collapsing any other card leaves the URL alone", () => {
  const app = vm.createContext({ Date: PageDate, document: { addEventListener() {} }, CSS: { escape: (s) => s }, matchMedia: () => ({ matches: false }), location: { hash: '' } });
  for (const file of ['ui-icon-text.js', 'ui.js','ui-links.js', 'ui-enums.js', 'ui-progress-bar.js', 'ui-cards.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), app);
  const saved = [];
  const handlers = {};
  const B = { $: () => ({ addEventListener() {}, removeEventListener() {} }), atUnmount() {}, on: (_, type, fn) => { (handlers[type] ||= []).push(fn); }, later() {}, root: {},
    store: { set() {} }, state: { board: { items: [] }, openItems: new Set(['w/A', 'w/B']) }, seen: {}, thread: () => '',
    links: (key) => app.BoardUI.linkContext([], key), saveFragment: (changes) => saved.push(changes) };
  app.BoardView = { part: (fn) => fn(B) };
  app.AppRouter = { fragmentOf: () => ({ selectedCard: 'w/A' }) };
  vm.runInContext(fs.readFileSync(new URL('./public/app-cards.js', import.meta.url), 'utf8'), app);
  const collapse = (key) => handlers.toggle.forEach((fn) => fn({ target: { matches: () => true, open: false, dataset: { key } } }));
  collapse('w/B');
  assert.deepEqual(saved, []);
  collapse('w/A');
  assert.equal(JSON.stringify(saved), '[{"selectedCard":null}]');
  assert.deepEqual([...B.state.openItems], []);
});

test("a card with a worktree opens it in VS Code from its Links line, live on the host and muted with a tooltip off it",() => {
  const app = vm.createContext({ Date: PageDate, document: { addEventListener() {} }, CSS: { escape: (s) => s }, matchMedia: () => ({ matches: false }) });
  for (const file of ['ui-icon-text.js', 'ui.js','ui-links.js', 'ui-enums.js', 'ui-progress-bar.js', 'ui-cards.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), app);
  const B = { $: () => ({ addEventListener() {}, removeEventListener() {} }), atUnmount() {}, on() {}, later() {}, store: {}, state: { board: { items: [], onHost: true } }, seen: {}, thread: () => '', links: (key) => app.BoardUI.linkContext([], key) };
  app.BoardView = { part: (fn) => fn(B) };
  vm.runInContext(fs.readFileSync(new URL('./public/app-cards.js', import.meta.url), 'utf8'), app);
  const rows = (it) => [...B.detail(it).matchAll(/<dt[^>]*>(.*?)<\/dt><dd[^>]*>(.*?)<\/dd>/g)].map(([, k, v]) => [text(k), text(v)]);
  const open = { ...workCard, pr: null, prs: [], reviewers: [], key: 'w/A1', action: null, deps: [], manualSteps: [], kind: 'work', holdable: true, hasNotes: true, worktree: '/Users/me/.claude/kickflip/worktrees/A 1' };
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
// docs/adr/2026-11-15-0840-the-open-card-rows-start-at-its-links-and-drop-status-review-and-ci.md
test("the open card's details list shows Parent, Children, Related to, Blocked by and Blocks as rows of tappable labels, leaving out empty rows and drawing no Status row; the workflow row has no follow-up Build", () => {
  const app = vm.createContext({ Date: PageDate, document: { addEventListener() {} }, CSS: { escape: (s) => s }, matchMedia: () => ({ matches: false }) });
  for (const file of ['ui-icon-text.js', 'ui.js','ui-links.js', 'ui-enums.js', 'ui-progress-bar.js', 'ui-cards.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), app);
  // The linked cards are on the board, so each label reads the ref its card has now.
  const onBoard = [53, 75, 80, 94, 95, 99].map((n) => ({ key: `w/GH-${n}`, id: `GH-${n}`, ref: `#${n}`, file: 'w' }));
  const B = { $: () => ({ addEventListener() {}, removeEventListener() {} }), atUnmount() {}, on() {}, store: {}, state: { board: { items: onBoard } }, seen: {}, thread: () => '', links: (key) => app.BoardUI.linkContext(onBoard, key) };
  app.BoardView = { part: (fn) => fn(B) };
  vm.runInContext(fs.readFileSync(new URL('./public/app-cards.js', import.meta.url), 'utf8'), app);
  const link = (ref) => ({ key: `w/GH-${ref.slice(1)}`, ref });
  const card = { ...workCard, pr: null, prs: [], reviewers: [], key: 'w/GH-93', ref: '#93', lane: 'todo', action: null, storedLane: 'todo', next: null, deps: ['GH-80'], manualSteps: [], holdable: true,
    parent: link('#53'), children: [link('#94'), link('#95')], related: [link('#75')], blockedBy: [link('#80')], blockers: [link('#80')], blocks: [link('#99')] };
  const rows = (it) => [...B.detail(it).matchAll(/<dt[^>]*>(.*?)<\/dt><dd[^>]*>(.*?)<\/dd>/g)].map(([, k, v]) => [text(k), text(v)]);
  assert.deepEqual(rows(card), [['Parent', '#53'], ['Children', '#94 , #95'], ['Tags', '+ Add tag'], ['Related to', '#75'], ['Blocked by', '#80'], ['Blocks', '#99']]);
  // The builder's risk is a Risk row under the card links, its word in the colour the PR's Slack bar has.
  for (const [risk, tone] of [['low', 'ready'], ['medium', 'notice'], ['high', 'danger']]) {
    assert.deepEqual(rows({ ...card, risk }).slice(-2), [['Blocks', '#99'], ['Risk', risk]]);
    assert.match(B.detail({ ...card, risk }), new RegExp(`<dt>Risk</dt><dd><span class="risk tone-${tone}">${risk}</span></dd>`));
  }
  assert.deepEqual([...B.detail(card).matchAll(/<a class="card-link" href="([^"]*)">([^<]*)<\/a>/g)].map(([, href, ref]) => [href, ref]),
    [['#selectedCard=w%2FGH-53', '#53'], ['#selectedCard=w%2FGH-94', '#94'], ['#selectedCard=w%2FGH-95', '#95'], ['#selectedCard=w%2FGH-75', '#75'], ['#selectedCard=w%2FGH-80', '#80'], ['#selectedCard=w%2FGH-99', '#99']]);
  // The links are text joined by a comma and a space, with nothing else between them.
  assert.match(B.detail(card), /<\/a>, <a class="card-link" href="#selectedCard=w%2FGH-95"/);
  // No row repeats the card's status: a card with nothing to list has only its Tags row, for its + Add tag, whatever its
  // lane or agent (docs/adr/2026-11-22-0200-a-card-carries-board-only-tags.md).
  const bare = { ...card, parent: null, children: [], related: [], blockedBy: [], blockers: [], blocks: [] };
  for (const extra of [{ lane: 'todo' }, { lane: 'progress', builder: { progress: 'Building · x', words: 'Building · x', phase: 'building', at: null } }, { lane: 'review' }, { lane: 'done' }]) {
    assert.deepEqual(rows({ ...bare, ...extra }), [['Tags', '+ Add tag']], JSON.stringify(extra));
  }
  // A blocker stays in Blocked by once it is Done, drawn with its done ring, while the footer drops it.
  const doneBlocker = { ...bare, blockers: [{ ...link('#80'), lane: 'done' }] };
  assert.deepEqual(rows(doneBlocker), [['Tags', '+ Add tag'], ['Blocked by', '#80']]);
  assert.match(B.detail(doneBlocker), /<dt>Blocked by<\/dt><dd><a class="card-link" href="#selectedCard=w%2FGH-80">#80<span class="status link-lane done"><\/span><\/a><\/dd>/);
  assert.doesNotMatch(app.BoardUI.workLines({ ...doneBlocker, footer: footerOf(doneBlocker), linear: [], ticket: null }), /blocked by/);
  assert.doesNotMatch(B.detail(card), /data-confirm="build"|Filed from|Waits on/);
  assert.deepEqual(lines(app.BoardUI.workLines({ ...card, footer: footerOf(card), linear: [], ticket: null })).slice(0, 2), ['#93 Five', 'blocked by #80']);
  assert.doesNotMatch(app.BoardUI.workLines(card), /follow-up/);
});

// docs/adr/2026-11-13-1120-every-task-reference-links-and-shows-its-lane-ring.md
test('every task reference the board draws is a link ending with its lane ring: the footer, the open card rows and the Done list', () => {
  const app = vm.createContext({ document: { addEventListener() {} }, CSS: { escape: (s) => s }, matchMedia: () => ({ matches: false }) });
  for (const file of ['ui-icon-text.js', 'ui.js','ui-links.js', 'ui-enums.js', 'ui-progress-bar.js', 'ui-cards.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), app);
  const B = { $: () => ({ addEventListener() {}, removeEventListener() {} }), atUnmount() {}, on() {}, store: {}, state: { board: { items: [] } }, seen: {}, thread: () => '', links: (key) => app.BoardUI.linkContext([], key) };
  app.BoardView = { part: (fn) => fn(B) };
  vm.runInContext(fs.readFileSync(new URL('./public/app-cards.js', import.meta.url), 'utf8'), app);
  const link = (ref, lane) => ({ key: `w/GH-${ref.slice(1)}`, ref, lane });
  const card = { ...workCard, pr: null, prs: [], reviewers: [], key: 'w/GH-93', ref: '#93', lane: 'todo', action: null, storedLane: 'todo', next: null, deps: ['GH-80'], manualSteps: [], holdable: true,
    parent: link('#53', 'done'), children: [link('#94', 'progress')], related: [link('#75', 'review')], blockedBy: [link('#80', 'progress'), link('#81', 'todo')], blockers: [link('#80', 'progress'), link('#81', 'todo')], blocks: [link('#99', 'todo')] };
  // Each anchor to a card is followed, inside it, by that card's ring.
  const anchors = (html) => [...html.matchAll(/<a\b[^>]*href="#selectedCard=[^"]*"[^>]*>(.*?)<\/a>/g)].map(([, inner]) => inner);
  const bare = (html) => anchors(html).filter((inner) => !/<span class="status link-lane \w+"><\/span>$/.test(inner));
  const detail = B.detail(card);
  const footer = app.BoardUI.workLines({ ...card, footer: footerOf(card) });
  assert.deepEqual(anchors(footer).map(text), ['blocked by #80', '#81']);
  assert.deepEqual(anchors(detail).map(text), ['#53', '#94', '#75', '#80', '#81', '#99']);
  assert.deepEqual(bare(footer), []);
  assert.deepEqual(bare(detail), []);
  assert.match(footer, /blocked by #80<span class="status link-lane progress"><\/span><\/a><span class="sep">, <\/span><a class="card-blocked" href="#selectedCard=w%2FGH-81">#81<span class="status link-lane todo">/);
  assert.match(app.BoardUI.taskLink('w/A1', 'A1', 'done', { cls: 'card-link' }), /^<a class="card-link" href="#selectedCard=w%2FA1">A1<span class="status link-lane done"><\/span><\/a>$/);
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
  assert.deepEqual(read(answer(403, { 'x-kickflip-down': 'access' })), ['access', 'You no longer have access', 'Only its owner’s Tailscale account opens it.']);
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

// docs/adr/2026-11-16-1600-owner-taps-wait-for-the-host-in-the-outbox.md
test("offline, no button is held: the board's copy greys and stops nothing, since every tap waits in the outbox", () => {
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.offline :is\(/);
  assert.deepEqual([ui.SENDS, ui.holdSends, ui.WAITING], [undefined, undefined, undefined]);
  assert.equal(ui.SEND_LIMIT_MS, 15000);
});

test('sendWithin hands the send a live abort signal and passes its answer through', async () => {
  let signal;
  assert.equal(await ui.sendWithin((s) => { signal = s; return Promise.resolve('ok'); }), 'ok');
  assert.equal(signal.aborted, false);
  await assert.rejects(ui.sendWithin(() => Promise.reject(Object.assign(new Error('409'), { status: 409 }))), { status: 409 });
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

// docs/adr/2026-11-18-2100-a-card-tap-logs-a-sending-line-and-its-button-just-disables.md: its thread line carries the
// tap's sending…, so a sending card button is only disabled (ui.js SENDING), dimmed as any disabled button, with no spinner.
test('a sending card button, Done, the owner check, Merge and the menu’s Bump, is disabled with no spinner', () => {
  const it = { key: 'w/A1', sending: ['finish', 'merge', 'bump'], merging: true, action: null, release: null, ownerStep: 'Deploy it' };
  assert.equal(ui.SENDING, ' disabled');
  for (const html of [ui.doneButton(it), ui.mergeButton(it), ui.cardBumpItem('w/A1', false, true)]) {
    assert.match(html, / disabled/);
    assert.doesNotMatch(html, /aria-busy|try-spin/);
  }
});

test("an open card waiting on the owner's Merge shows a Merge button that confirms first, and stays disabled, with no spinner, while the session merges it", () => {
  const merge = (it) => { const html = ui.mergeButton(it); return html && [text(html), / disabled/.test(html) && !/aria-busy/.test(html), /data-confirm="merge"/.test(html), /data-key="w\/A1"/.test(html)]; };
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
  assert.equal(cls({ key: 'w/A1', action: null, resolvedBy: null, merging: true }), 'resolves');
});

// docs/adr/2026-11-05-0300-implement-in-the-thread-queues-the-card-for-the-orchestrator.md
test("an open card's action row has no Implement, which lives in a Todo card's thread box, nor Grill or Prototype; a card the owner blocked shows Unblock", () => {
  assert.equal(ui.buildButton, undefined);
  const app = vm.createContext({ Date: PageDate, document: { addEventListener() {} }, CSS: { escape: (s) => s }, matchMedia: () => ({ matches: false }) });
  for (const file of ['ui-icon-text.js', 'ui.js','ui-links.js', 'ui-enums.js', 'ui-progress-bar.js', 'ui-cards.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), app);
  const B = { $: () => ({ addEventListener() {}, removeEventListener() {} }), atUnmount() {}, on() {}, store: {}, state: { board: { items: [] } }, seen: {}, thread: () => '', links: (key) => app.BoardUI.linkContext([], key) };
  app.BoardView = { part: (fn) => fn(B) };
  vm.runInContext(fs.readFileSync(new URL('./public/app-cards.js', import.meta.url), 'utf8'), app);
  const todo = { ...workCard, pr: null, prs: [], reviewers: [], key: 'w/A1', lane: 'todo', action: null, actionButton: null, deps: [], manualSteps: [], holdable: true, hasNotes: true,
    try: { kind: 'web', script: true, changes: false }, buildable: true };
  const row = (it) => [...B.detail(it).match(/<div class="action-row workflow">(.*?)<\/div>/)[1].matchAll(/<button[^>]*>(.*?)<\/button>/g)].map(([, label]) => label);
  assert.deepEqual(row(todo), ['Block']);
  const changed = { ...todo, try: { ...todo.try, changes: true } };
  assert.deepEqual(row(changed), ['Block', 'Serve']);
  assert.deepEqual(row({ ...changed, ready: true }), ['Block', 'Serve']);
  assert.deepEqual(row({ ...changed, lane: 'progress' }), ['Block', 'Serve']);
  const blocked = { ...todo, ownerBlock: { until: null }, blocked: true };
  assert.deepEqual(row(blocked), ['Unblock']);
  assert.deepEqual(row({ ...blocked, buildable: false }), ['Unblock']);
  assert.doesNotMatch(B.detail({ ...blocked, ready: true }), /data-confirm="card-build"/);
});

test('the working line reads thinking, in one shared class on the card and in the thread', () => {
  const ask = { kind: 'ask', key: 'ask:a1', id: 'a1', ref: '10:00', title: 'Fix it', linear: [], pr: null, prs: [], deps: [], blockedBy: [], working: true, ask: { askedAt: ago(1) } };
  assert.match(workLines(ask), /<div class="line3 sub agent"><span class="thinking">/);
  assert.match(ui.threadMessages([{ ts: ago(3), who: 'love', via: 'site', kind: 'item-message', text: 'Fix it', eventId: 'e1', reply: null, state: 'working' }]), /<div class="reply muted small msg-foot"><span>[^<]+<\/span><span>·<\/span><span class="thinking">/);
});

test('thinking… counts up from when the message was marked: bare under a minute, then minutes, then hours and minutes', () => {
  const marked = (min) => new Date(NOW - min * 60000).toISOString();
  const foot = (since) => text(ui.threadMessages([{ ts: ago(3), who: 'love', via: 'site', kind: 'item-message', text: 'Fix it', eventId: 'e1', reply: null, state: 'working', since }]).match(/<span class="thinking"[^>]*>.*?thinking…[^<]*<\/span>/s)[0]);
  assert.equal(foot(marked(0.5)), 'thinking…');
  assert.equal(foot(marked(3)), 'thinking… (3m)');
  assert.equal(foot(marked(65)), 'thinking… (1h 5m)');
  assert.equal(foot(marked(120)), 'thinking… (2h)');
  assert.equal(ui.liveFor(marked(0.5), NOW), '');
  assert.equal(ui.liveFor(marked(26 * 60), NOW), '(1d 2h)');
  assert.equal(ui.liveFor(marked(48 * 60), NOW), '(2d)');
  assert.match(ui.threadMessages([{ ts: ago(3), who: 'love', via: 'site', kind: 'item-message', text: 'x', eventId: 'e1', reply: null, state: 'working', since: marked(3) }]), new RegExp(`<span class="thinking" data-since="${ui.esc(marked(3))}" data-word="thinking…">`));
  assert.equal(ui.thinkingFor(marked(7), NOW), 'thinking… (7m)');
});

test('the New strip counts thinking… up the same way', () => {
  const since = new Date(NOW - 4 * 60000).toISOString();
  const ask = (extra) => ({ kind: 'work', id: 'T-3', key: 'w/T-3', ref: 'T-3', isNew: true, created: ago(1), ask: { eventId: 'a1', askedAt: ago(1), canEdit: true, text: 'Fix', files: [], state: 'working', ...extra } });
  const strip = (extra) => ui.newStrip(ui.newEntries({ items: [ask(extra)], merges: [] }, {}));
  assert.match(strip({ since }), /<span class="new-thinking" data-since="[^"]+" data-word="thinking…"><span class="it it-current"><span class="it-i it-pulse" aria-hidden="true"><\/span><\/span>thinking… \(4m\)<\/span>/);
  assert.match(strip({}), /<span class="new-thinking"><span class="it it-current"><span class="it-i it-pulse" aria-hidden="true"><\/span><\/span>thinking…<\/span>/);
});

// docs/adr/2026-11-15-0040-a-new-tasks-media-shows-as-thumbnails-and-sends-atomically.md
test("a New task's files show as the thread's thumbnails and file chips on its strip row while waiting, and still on its Ticket created and Added to rows", () => {
  const shot = { name: 'shot.png', url: 'uploads/1-shot.png', type: 'image/png' };
  const log = { name: 'run.log', url: 'uploads/2-run.log', type: 'text/plain' };
  const sent = ago(1);
  const waiting = { kind: 'work', id: 'T-3', key: 'w/T-3', ref: 'T-3', isNew: true, created: sent, ask: { eventId: 'a1', askedAt: sent, canEdit: true, text: 'Fix', files: [shot, log], state: 'waiting' } };
  const made = { kind: 'work', id: 'T-4', key: 'w/T-4', ref: 'T-4', fromAsk: 'a2', created: sent, ingested: { at: ago(0.5), text: 'Made', files: [shot] } };
  const merge = { key: 'w/T-2', ref: 'T-2', at: ago(0.2), id: 'a3', askedAt: ago(0.8), message: 'Also', files: [log] };
  const entries = ui.newEntries({ items: [waiting, made], merges: [merge] }, {});
  const filesOf = (id) => {
    const html = ui.newStrip(entries.filter((e) => e.id === id));
    return [...html.matchAll(/<(a|span) class="(file-thumb|file-link)"/g)].map((m) => m[2]);
  };
  assert.deepEqual([filesOf('a1'), filesOf('a2'), filesOf('a3')], [['file-thumb', 'file-link'], ['file-thumb'], ['file-link']]);
  // The thread's own renderer, so the row and the task's first thread message draw them alike.
  assert.ok(ui.newStrip(entries.filter((e) => e.id === 'a2')).includes(ui.attachments([shot])));
  assert.ok(ui.threadMessages([{ ts: sent, who: 'love', via: 'ask', kind: 'ask', text: 'Fix', files: [shot, log], eventId: 'a1', state: 'waiting' }]).includes(ui.attachments([shot, log])));
});

test("an unsent New task's files still uploading show as dimmed thumbnails or chips with a progress bar; a failed one is marked with why and an X to remove it, and no per-file retry", () => {
  const list = [
    { id: 'f1', name: 'up.png', type: 'image/png', preview: 'blob:up', status: 'done', file: { name: 'up.png', url: 'uploads/1-up.png', type: 'image/png' } },
    { id: 'f2', name: 'busy.png', type: 'image/png', preview: 'blob:busy', status: 'uploading', progress: 0.42 },
    { id: 'f3', name: 'bad.png', type: 'image/png', preview: 'blob:bad', status: 'error', error: 'Upload failed' },
    { id: 'f4', name: 'big.log', type: 'text/plain', status: 'error', error: 'Over 20 MB', final: true },
  ];
  const html = ui.uploadTiles(list);
  const tiles = [...html.matchAll(/<span class="(file-thumb|file-link) (\w+)"/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(tiles, [['file-thumb', 'done'], ['file-thumb', 'uploading'], ['file-thumb', 'error'], ['file-link', 'error']]);
  assert.match(html, /<img src="blob:busy" alt="busy\.png">/);
  assert.match(html, /role="progressbar" aria-label="Uploading busy\.png" aria-valuenow="42"/);
  assert.deepEqual([...html.matchAll(/data-unattach="(\w+)" aria-label="([^"]+)"/g)].map((m) => [m[1], m[2]]), [['f3', 'Remove bad.png'], ['f4', 'Remove big.log']]);
  assert.deepEqual([...html.matchAll(/<span class="perr">([^<]+)<\/span>/g)].map((m) => m[1]), ['Upload failed', 'Over 20 MB']);
  assert.doesNotMatch(html, /data-retry/);
  // The row draws them inside its uploads box, which attach.js's X reads, with the footer's sending… or not sent.
  const row = ui.newStrip([{ id: 's1', sent: ago(1), text: 'Look', files: [], uploads: { box: 'send:s1', list }, unsent: { sendId: 's1', state: 'failed' } }]);
  assert.ok(row.includes(`<div data-uploads="send:s1">${html}</div>`));
  assert.match(row, /not sent/);
});

// docs/adr/2026-11-18-2330-deleting-a-new-ask-reads-deleting-on-its-own-row.md
test("a New ask being deleted drops its trash and reads <time> · deleting…, waiting for the host while the host is away, or not deleted with the deletion's Retry and X; an unsent task that hasn't failed has a trash of its own", () => {
  const sent = ago(1);
  const card = { kind: 'work', id: 'T-3', key: 'w/T-3', ref: 'T-3', isNew: true, created: sent, ask: { eventId: 'a1', askedAt: sent, canEdit: true, text: 'Fix', files: [], state: 'waiting' } };
  const [entry] = ui.newEntries({ items: [card], merges: [] }, {});
  const row = (e) => ui.newStrip([e]);
  const foot = (html) => /<div class="new-line sub">(.*?)<\/div>/s.exec(html)[1].replace(/<[^>]+>/g, '');
  const at = ui.time(sent);
  assert.match(row(entry), /data-withdraw="a1"/);
  for (const [state, words] of [['sending', 'deleting…'], ['held', 'waiting for the host'], ['failed', 'not deleted']]) {
    const html = row({ ...entry, deleting: { sendId: 'd1', state } });
    assert.doesNotMatch(html, /data-withdraw/, state);
    assert.equal(foot(html), `${at} · ${words}`, state);
    assert.equal(/data-resend="d1"/.test(html) && /data-unsend="d1"/.test(html), state === 'failed', state);
  }
  // The New task box's send, before the board has it: its trash while it sends or waits for the host (app-threads.js unsentAsks gives it none once it failed, as its X drops it).
  const unsent = (state, extra) => row({ id: 's1', sent, text: 'Look', files: [], unsent: { sendId: 's1', state }, withdraw: true, ...extra });
  assert.match(unsent('sending'), /data-withdraw="s1"/);
  assert.match(unsent('held'), /data-withdraw="s1"/);
  assert.doesNotMatch(row({ id: 's1', sent, text: 'Look', files: [], unsent: { sendId: 's1', state: 'sending' } }), /data-withdraw/, 'a hub row has none');
  const deleting = unsent('sending', { deleting: { sendId: 'd2', state: 'sending' } });
  assert.deepEqual([/data-withdraw/.test(deleting), foot(deleting)], [false, `${at} · deleting…`]);
});

// docs/adr/2026-11-12-2030-a-thread-message-shows-at-once-and-the-browser-keeps-it-until-sent.md
test("an owner's message reads its time first in the footer, then sending… or waiting… in grey or thinking… with the working dot; a failed send reads not sent, bold red, with Retry then X; no message has Edit or Delete", () => {
  const sent = ago(3);
  const at = ui.esc(ui.time(sent));
  const foot = (html) => /<div class="reply muted small msg-foot">(.*?)<\/div>/s.exec(html)?.[1];
  const dot = '<span>·</span>';
  const mine = (extra) => ({ ts: sent, who: 'love', via: 'site', kind: 'item-message', text: 'Fix it', eventId: 'e1', reply: null, state: 'waiting', ...extra });
  const queued = (extra) => ({ ts: sent, who: 'love', kind: 'item-message', text: 'Fix it', files: [], sendId: 's1', state: 'sending', ...extra });
  assert.equal(foot(ui.threadMessages([queued()])), `<span>${at}</span>${dot}<span>sending…</span>`);
  assert.equal(foot(ui.threadMessages([mine()])), `<span>${at}</span>${dot}<span>waiting…</span>`);
  assert.equal(foot(ui.threadMessages([mine({ state: 'working' })])), `<span>${at}</span>${dot}${ui.workingLine}`);
  // A message the orchestrator answered keeps its time in the footer, alone.
  assert.equal(foot(ui.threadMessages([mine({ state: 'answered' })])), `<span>${at}</span>`);
  // The time moved to the footer, so the owner's name stands alone.
  assert.match(ui.threadMessages([mine()]), /<div class="who">You<\/div>/);
  const failed = ui.threadMessages([queued({ state: 'failed' })]);
  assert.ok(foot(failed).startsWith(`<span>${at}</span>${dot}<span class="not-sent">not sent</span><span class="send-again">`));
  assert.deepEqual([...failed.matchAll(/data-(resend|unsend)="(\w+)" aria-label="([^"]+)"/g)].map((m) => [m[1], m[2], m[3]]), [['resend', 's1', 'Retry'], ['unsend', 's1', 'Dismiss']]);
  assert.match(failed, /<div class="msg love" data-send="s1">/);
  assert.doesNotMatch(ui.threadMessages([queued()]), /data-resend|data-unsend|data-event/);
  // Nothing in a thread edits or deletes a message, waiting or working.
  const pending = ui.threadMessages([mine(), mine({ eventId: 'e2', state: 'working' }), mine({ eventId: 'a1', kind: 'ask', canEdit: true, canDelete: true })]);
  assert.doesNotMatch(pending, /data-edit|data-withdraw|ask-actions/);
});

// docs/adr/2026-11-14-0530-every-reply-box-tap-shows-its-line-at-once-and-retries-in-place.md
test("a bare tap's line reads its words and time, then sending…, waiting… or thinking… after a dot, plain once picked up and for a line no session acts on; a failed one reads not sent in red with Retry then X", () => {
  const sent = ago(3);
  const at = ui.time(sent);
  const words = (html) => html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const queued = (extra) => ({ ts: sent, who: 'love', kind: 'command', request: true, mark: 'Prototype requested', text: 'Prototype requested', sendId: 's1', state: 'sending', ...extra });
  const board = (extra) => ({ ts: sent, who: 'love', via: 'site', kind: 'prototype-request', text: 'Prototype requested', request: true, command: 'prototype', eventId: 'e1', reply: null, state: 'waiting', ...extra });
  assert.equal(words(ui.threadMessages([queued()])), `Prototype requested · ${at} · sending…`);
  assert.match(ui.threadMessages([queued()]), /<div class="msg status-line request" data-send="s1">/);
  // The line spins while its tap sends, a lane change's included, once, in its mark's place; waiting for the host, not sent and sent draw no spinner.
  assert.equal(ui.threadMessages([queued()]).match(/try-spin/g).length, 1);
  assert.match(ui.threadMessages([queued({ mark: 'Marked done', text: 'Marked done' })]), /try-spin/);
  for (const state of ['held', 'failed', 'waiting', 'answered']) assert.doesNotMatch(ui.threadMessages([queued({ state })]), /try-spin/);
  assert.equal(words(ui.threadMessages([board()])), `Prototype requested · ${at} · waiting…`);
  assert.ok(ui.threadMessages([board({ state: 'working' })]).includes(`· ${ui.esc(at)} · ${ui.workingLine}`));
  assert.equal(words(ui.threadMessages([board({ state: 'answered' })])), `Prototype requested · ${at}`);
  // A Block, Unblock, Done, Reopen or bare Implement's line is the board's own, which no session picks up.
  assert.equal(words(ui.threadMessages([{ ts: sent, who: 'love', kind: 'command', command: 'hold', request: true, mark: 'Blocked', text: 'Blocked until 3:00 PM' }])), `Blocked until 3:00 PM · ${at}`);
  // docs/adr/2026-11-18-0500-a-sending-tap-spins-in-its-status-line.md: a tap's line spins in its mark's place only while it reads sending….
  assert.match(ui.threadMessages([queued()]), /<span class="mark" aria-hidden="true"><span class="try-spin" role="status" aria-label="sending"><\/span><\/span>/);
  assert.doesNotMatch(ui.threadMessages([queued({ state: 'held' })]), /try-spin/);
  assert.doesNotMatch(ui.threadMessages([queued({ state: 'failed' })]), /try-spin/);
  assert.doesNotMatch(ui.threadMessages([board()]), /try-spin/);
  const failed = ui.threadMessages([queued({ state: 'failed' })]);
  assert.equal(words(failed), `Prototype requested · ${at} · not sent`);
  assert.match(failed, /<span class="not-sent">not sent<\/span><span class="send-again">/);
  assert.deepEqual([...failed.matchAll(/data-(resend|unsend)="(\w+)" aria-label="([^"]+)"/g)].map((m) => [m[1], m[2], m[3]]), [['resend', 's1', 'Retry'], ['unsend', 's1', 'Dismiss']]);
});

// docs/adr/2026-11-06-1252-stale-is-automatic-stalled-is-the-orchestrators-flag.md
test('a stale builder has no badge and no nudge: its status line and bars keep their colour, and only the footer reads stale', () => {
  const builder = { progress: 'Running tests', words: 'Running tests', phase: 'building', at: null, stale: true };
  const html = workLines({ ...workCard, lane: 'progress', stale: true, builder });
  assert.match(html, /<div class="line3 sub agent in-progress"><span class="it it-current"><span class="it-i it-pulse" aria-hidden="true"><\/span><\/span>Running tests<\/div>/);
  assert.doesNotMatch(html, /<button[^>]*line3|data-confirm="nudge"|Stalled|tone-danger|phase-bars dim/);
  assert.match(html, /<span class="card-stale">stale<\/span>/);
  // docs/adr/2026-11-05-0410-a-card-status-word-comes-from-a-signal-the-board-checks.md: a builder whose process is gone
  // reads stopped at once, in its lane colour.
  assert.match(workLines({ ...workCard, lane: 'progress', builder: { ...builder, alive: false, words: 'stopped · Running tests' } }), /<div class="line3 sub agent in-progress"><span class="it it-current"><span class="it-i it-pulse" aria-hidden="true"><\/span><\/span>stopped · Running tests<\/div>/);
  for (const next of [{ ...builder, stale: false }, null]) assert.doesNotMatch(workLines({ ...workCard, builder: next }), /stale/);
  assert.doesNotMatch(workLines({ ...workCard, lane: 'done', builder }), /class="[^"]*\bstale\b/);
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.sub\.agent\.(stale|quiet)/);
  assert.match(css, /^\.card-stale \{ color: var\(--muted\); \}$/m);
  assert.match(css, /^\.card-stalled \{ color: var\(--color-danger\); \}$/m);
  assert.doesNotMatch(css, /nudg|button\.sub/);
});

test('a card the orchestrator stalled reads red stalled rightmost on the row under its footer, after its Action needed, in place of stale', () => {
  const action = { kind: 'stalled', url: '#selectedCard=w%2FB5', label: 'stalled: Crashed twice' };
  const html = workLines({ ...workCard, lane: 'progress', sortAt: ago(5), stale: true, stalled: 'Crashed twice', action });
  assert.match(html, /<div class="line6 sub card-alert"><a class="card-action" href="#selectedCard=w%2FB5" title="stalled: Crashed twice"[^>]*>Action needed<\/a><span class="sep"> · <\/span><span class="card-stalled">stalled<\/span><\/div>$/);
  assert.doesNotMatch(html, /card-stale"/);
  const review = workLines({ ...workCard, lane: 'review', sortAt: ago(60 * 24 * 8), stale: true });
  assert.match(review, /<\/time><span class="sep"> · <\/span><span class="card-stale">stale<\/span>/);
});

// docs/adr/2026-11-05-1809-the-orchestrator-stops-the-boards-own-runs.md
test("a run the orchestrator stopped reads the stop's words as its status, plain, with no dot, and a stopped Merge land reads them in In Review", () => {
  const builder = { progress: 'Running tests', words: 'build stopped by orchestrator', at: ago(1), stale: true, alive: false, silentSince: ago(0.05), stopped: 'build stopped by orchestrator' };
  const html = workLines({ ...workCard, lane: 'progress', builder });
  assert.match(html, /<div class="line3 sub agent in-progress">build stopped by orchestrator \(\d+m\)<\/div>/);
  assert.doesNotMatch(html, /it-pulse|Running tests/);
  const review = workLines({ ...workCard, lane: 'review', builder: null, next: 'Verified: tap Merge to land it on main', landStopped: { words: 'land stopped by orchestrator', at: ago(0.05) } });
  assert.match(review, /<div class="line3 sub">land stopped by orchestrator \(\d+m\)<\/div>/);
});

test("a refused Implement's reason takes the card's status line, in place of its next step", () => {
  const reason = "Couldn't start implementing: it's blocked. Unblock it, then tap Implement.";
  const html = workLines({ ...workCard, lane: 'todo', builder: null, next: 'Grill the notes', refusal: reason });
  assert.match(html, /<div class="line3 sub refused">Couldn&#39;t start implementing: it&#39;s blocked\. Unblock it, then tap Implement\.<\/div>/);
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
  const ctx = vm.createContext({ Date: PageDate, document: { addEventListener: (type, fn) => heard.push([type, fn]) } });
  vm.runInContext(fs.readFileSync(new URL('./public/ui-progress-bar.js', import.meta.url), 'utf8'), ctx);
  assert.deepEqual(heard.map(([type, fn]) => [type, fn === ctx.BoardUI.onePulse]), [['animationstart', true]]);
});

// docs/adr/2026-11-03-2024-every-in-progress-card-shows-its-phase-bars.md
test('every In Progress card shows its four phase bars: empty before a phase, filled to the phase reached, all filled in review or reopened, dimmed while it waits on something other than a builder', () => {
  const sortAt = '2020-01-01T10:00:00.000Z';
  const card = { ...workCard, lane: 'progress', sortAt, builder: null, next: null };
  const building = { progress: 'Building · the limiter', words: 'Building · the limiter', phase: 'building', at: null };
  const questions = { kind: 'questions', url: 'questions.html#q1', label: 'Answer 2 questions' };
  const strip = (it) => {
    const m = workLines(it).match(/<span class="phase-bars( dim)?" role="img" aria-label="([^"]*)" title="\2">((?:<i class="\w*"><\/i>){4})<\/span>/);
    return m && { dim: Boolean(m[1]), label: m[2], bars: [...m[3].matchAll(/class="(\w*)"/g)].map((b) => b[1] || '-').join(' ') };
  };
  const cases = [
    [{ builder: { progress: null, words: 'starting', phase: null, at: null } }, { dim: false, label: 'Starting, no step yet', bars: '- - - -' }],
    [{ builder: { ...building, phase: 'reading' } }, { dim: false, label: 'Reading, step 1 of 4', bars: 'now - - -' }],
    [{ builder: building }, { dim: false, label: 'Building, step 2 of 4', bars: 'done now - -' }],
    [{ builder: { ...building, phase: 'landing' } }, { dim: false, label: 'Landing, step 4 of 4', bars: 'done done done now' }],
    [{ builder: { ...building, stale: true } }, { dim: false, label: 'Building, step 2 of 4', bars: 'done now - -' }],
    [{ waitsOn: 'checking' }, { dim: false, label: 'Orchestrator review, step 3 of 4', bars: 'done done now -' }],
    [{ builder: building, action: questions }, { dim: true, label: 'Building, step 2 of 4, waiting on your answers', bars: 'done done - -' }],
    [{ reachedPhase: 'building', action: questions }, { dim: true, label: 'Stopped at building, step 2 of 4, waiting on your answers', bars: 'done done - -' }],
    [{ reopened: true, reachedPhase: 'building' }, { dim: true, label: 'Reopened, all 4 steps done', bars: 'done done done done' }],
    [{ reachedPhase: 'landing', next: 'Fix the failing CI' }, { dim: true, label: 'Stopped at landing, step 4 of 4', bars: 'done done done done' }],
    [{}, { dim: true, label: 'No step yet', bars: '- - - -' }],
    [{ builder: { kind: 'install', progress: null, words: 'starting', phase: null, at: null }, reachedPhase: 'landing' }, { dim: false, label: 'Stopped at landing, step 4 of 4', bars: 'done done done done' }],
  ];
  for (const [extra, want] of cases) assert.deepEqual(strip({ ...card, ...extra }), want, JSON.stringify(extra));
  for (const off of [{ lane: 'todo', builder: building }, { lane: 'done', reopened: false }, { lane: 'review' }, { builder: { ...building, planner: true } }]) {
    assert.doesNotMatch(workLines({ ...card, ...off }), /phase-bars/, JSON.stringify(off));
  }
  assert.match(workLines(card, { unread: 1 }), /<\/time><span class="sep"> · <\/span><span class="phase-bars dim"[^>]*>.*<\/span><\/div><div class="line6 sub card-alert"><span class="card-unread">1 new message<\/span><\/div>/);
  const drawn = workLines({ ...card, builder: building }, { unread: 2 });
  assert.match(drawn, /<div class="line3 sub agent in-progress"><span class="it it-current"><span class="it-i it-pulse" aria-hidden="true"><\/span><\/span>Building · the limiter<\/div>/);
  assert.equal(drawn.match(/phase-bars/g).length, 1);
});

// docs/adr/2026-11-03-1551-planners-and-implementers-are-two-kinds-of-agent.md,
// docs/adr/2026-11-04-2300-each-lane-is-a-queue-for-the-orchestrator.md
test("a planner's line on a card is marked planner, keeping its dot, where a running grill or prototype draws no bar; a card owing a brief reads its word in the same blue line, with its dot, until the planner's line takes it", () => {
  const planner = { progress: 'Prototyping · the takes', words: 'Prototyping · the takes', kind: 'prototype', phase: null, at: null, planner: true };
  for (const [lane, tone] of [['todo', 'in-todo'], ['progress', 'in-progress']]) {
    const html = workLines({ ...workCard, lane, sortAt: '2020-01-01T10:00:00.000Z', builder: planner });
    assert.match(html, new RegExp(`<div class="line3 sub agent planner ${tone}"><span class="it it-current"><span class="it-i it-pulse" aria-hidden="true"></span></span>Prototyping · the takes</div>`));
    assert.doesNotMatch(html, /Building/);
  }
  // docs/adr/2026-11-11-1200-every-lane-has-phases.md: a Todo card's grill or prototype reads as its phase word instead.
  for (const kind of ['prototype', 'grill']) assert.doesNotMatch(workLines({ ...workCard, lane: 'todo', sortAt: '2020-01-01T10:00:00.000Z', builder: { ...planner, kind } }), /phase-bars/);
  assert.doesNotMatch(workLines({ ...workCard, lane: 'progress', sortAt: '2020-01-01T10:00:00.000Z', builder: planner }), /phase-bars/, 'no dashes in In Progress');
  const line = (it) => /<div class="line3 sub agent planner in-todo">.*?<\/span>([^<]*)<\/div>/.exec(workLines({ ...workCard, lane: 'todo', sortAt: '2020-01-01T10:00:00.000Z', ...it }))?.[1];
  // docs/adr/2026-11-12-0600-every-planner-launches-from-the-orchestrators-brief.md
  const blue = (it) => /<div class="line3 sub agent planner"><span class="it it-current"><span class="it-i it-pulse" aria-hidden="true"><\/span><\/span>([^<]*)<\/div>/.exec(workLines({ ...workCard, lane: 'todo', sortAt: '2020-01-01T10:00:00.000Z', ...it }))?.[1];
  for (const word of ['preheating', 'planning prototype', 'planning visual', 'generating visual']) {
    assert.equal(blue({ planning: word, orchestrator: { kind: 'brief', since: '2020-01-01T10:00:00.000Z', picked: null, next: 'x' } }), word, 'before the wait on the orchestrator');
  }
  assert.equal(blue({ grilling: true }), undefined, 'a request alone reads no word');
  assert.doesNotMatch(workLines({ ...workCard, lane: 'todo', sortAt: '2020-01-01T10:00:00.000Z', grilling: true }), /preheating/);
  assert.equal(line({ grilling: true }), undefined);
  assert.equal(line({ prototyping: true, planning: 'planning visual', builder: planner }), 'Prototyping · the takes', "a running planner's line wins");
  assert.equal(line({}), undefined);
});

// docs/adr/2026-11-04-2300-each-lane-is-a-queue-for-the-orchestrator.md
test("a card idle on the orchestrator reads waiting for orchestrator with how long, then orchestrator review with its dot once picked up, in its lane's colour", () => {
  const minutes = (n) => new Date(NOW - n * 60000).toISOString();
  const status = (it) => /<div class="line3 sub agent ([\w -]+)">(.*?)<\/div>/.exec(workLines({ ...workCard, sortAt: '2020-01-01T10:00:00.000Z', ...it }))?.slice(1);
  const waiting = { kind: 'calls', since: minutes(14), picked: null, next: 'x' };
  assert.deepEqual(status({ lane: 'progress', waitsOn: 'checking', orchestrator: waiting }), ['in-progress waiting-gray', 'waiting for orchestrator (14m)']);
  assert.deepEqual(status({ lane: 'progress', waitsOn: 'checking', orchestrator: { ...waiting, picked: minutes(3) } }),
    ['in-progress', '<span class="it it-current"><span class="it-i it-pulse" aria-hidden="true"></span></span>orchestrator review (3m)']);
  // The browser never reads the usage pause: the orchestrator's marks read the same under it.
  ui.usagePause = () => ({ state: 'paused' });
  assert.deepEqual(status({ lane: 'progress', waitsOn: 'checking', orchestrator: { ...waiting, picked: minutes(3) } }),
    ['in-progress', '<span class="it it-current"><span class="it-i it-pulse" aria-hidden="true"></span></span>orchestrator review (3m)']);
  assert.doesNotMatch(ui.threadMessages([{ ts: '2020-01-01T10:00:00Z', who: 'love', kind: 'item-message', text: 'x', eventId: 'e1', state: 'working' }]), /paused/);
  ui.usagePause = null;
  assert.deepEqual(status({ lane: 'todo', refusal: 'Couldn’t start', orchestrator: { ...waiting, kind: 'refused' } }), ['in-todo waiting-gray', 'waiting for orchestrator (14m)']);
  // docs/adr/2026-11-05-0802-todo-has-no-queue.md: an Implement message's card waits like any other.
  assert.deepEqual(status({ lane: 'progress', orchestrator: { ...waiting, kind: 'implement' } }), ['in-progress waiting-gray', 'waiting for orchestrator (14m)']);
  // A running builder keeps its own line while its ask waits.
  assert.deepEqual(status({ lane: 'progress', builder: { progress: 'Building · x', words: 'Building · x', phase: 'building', at: minutes(2) }, orchestrator: { ...waiting, kind: 'ask' } }),
    ['in-progress', '<span class="it it-current"><span class="it-i it-pulse" aria-hidden="true"></span></span>Building · x (2m)']);
  // docs/adr/2026-11-06-0200-the-board-rebases-a-conflicting-pr-with-a-headless-run.md: a rebase run's hand-back, In
  // Review, reads its own failure line above the wait.
  const failed = workLines({ ...workCard, sortAt: '2020-01-01T10:00:00.000Z', lane: 'review', waitsOn: 'checking', orchestrator: waiting, rebaseFailed: 'Rebase failed in 2 files · <both sides>' });
  assert.match(failed, /<div class="line3 sub">Rebase failed in 2 files · &lt;both sides&gt;<\/div><div class="line3 sub agent in-review waiting-gray">waiting for orchestrator \(14m\)<\/div>/);
});

// docs/adr/2026-11-15-1700-a-card-reads-thinking-from-its-events-delivery-until-the-orchestrator-writes.md
test('a card waiting on the orchestrator reads thinking, counting from when its event reached the orchestrator, until the orchestrator writes on it', () => {
  const minutes = (n) => new Date(NOW - n * 60000).toISOString();
  const html = (it) => workLines({ ...workCard, sortAt: '2020-01-01T10:00:00.000Z', lane: 'todo', ...it });
  const reply = { kind: 'reply', since: minutes(14), picked: minutes(3), next: 'x' };
  assert.match(html({ orchestrator: reply, working: true, workingSince: minutes(3) }),
    /<div class="line3 sub agent"><span class="thinking" data-since="[^"]+" data-word="thinking…"><span class="it it-current"><span class="it-i it-pulse" aria-hidden="true"><\/span><\/span>thinking… \(3m\)<\/span><\/div>/);
  // Not handed over yet: waiting for orchestrator, grey.
  assert.match(html({ orchestrator: { ...reply, picked: null } }), /waiting-gray">waiting for orchestrator \(14m\)/);
  // Handed over and written on, the wait still open: orchestrator review.
  assert.match(html({ orchestrator: reply }), /orchestrator review \(3m\)/);
  // A card with no wait reads thinking with its count too.
  assert.match(html({ working: true, workingSince: minutes(3) }), /<div class="line3 sub agent"><span class="thinking" data-since="[^"]+" data-word="thinking…">.*thinking… \(3m\)/);
});

// docs/adr/2026-11-06-0145-every-run-takes-its-lanes-colour.md
test("a run's line, dot and bar take its card's lane colour: grey in Todo, orange in In Progress, blue in In Review, where a rebase run is a line with no bar", () => {
  const at = new Date(NOW - 2 * 60000).toISOString();
  const lineClass = (it) => /<div class="line3 sub agent([\w -]*)">/.exec(workLines({ ...workCard, sortAt: '2020-01-01T10:00:00.000Z', ...it }))?.[1].trim();
  const rebase = { ...workCard, sortAt: '2020-01-01T10:00:00.000Z', lane: 'review', builder: { progress: 'Rebasing onto main', words: 'Rebasing onto main', phase: null, at } };
  assert.equal(lineClass(rebase), 'in-review');
  assert.doesNotMatch(workLines(rebase), /phase-bars/);
  assert.equal(lineClass({ lane: 'review', waitsOn: 'checking', orchestrator: { kind: 'calls', since: at, picked: at, next: 'x' } }), 'in-review');
});

test("a builder line shows the progress and its age, not who is building", () => {
  const at = new Date(NOW - 4 * 60000).toISOString();
  assert.equal(ui.builderLine({ words: 'Testing · the limiter', at }), 'Testing · the limiter (4m)');
  assert.equal(ui.builderLine({ words: 'starting', at }), 'starting (4m)');
  assert.equal(ui.builderLine({ words: 'starting', at: null }), 'starting');
  assert.equal(ui.builderLine({ words: 'stopped', at, alive: false }), 'stopped (4m)');
  assert.equal(ui.builderLine({ words: 'build stopped by orchestrator', at, silentSince: new Date(NOW - 2 * 60000).toISOString(), stopped: 'build stopped by orchestrator' }), 'build stopped by orchestrator (2m)');
  assert.equal(ui.builderLine({ words: 'Making changes', at: null }), 'Making changes');
});

// docs/adr/2026-11-12-0228-new-asks-sit-in-a-new-strip-above-the-lanes.md
test("an ask in the New strip reads the owner's whole message, then whether it was moved or edited and a grey waiting… or a blue thinking…, with delete; an ingested one links to its card, in blue, with Dismiss", () => {
  const sent = ago(1);
  const ask = (extra) => ({ kind: 'work', id: 'T-3', key: 'w/T-3', ref: 'T-3', isNew: true, created: sent, ask: { eventId: 'a1', askedAt: sent, canEdit: true, text: 'Fix <it>\nand more', files: [], ...extra } });
  const strip = (items, merges = []) => ui.newStrip(ui.newEntries({ items, merges }, {}));
  const entryText = (html) => text(html.split('<div class="list">')[1]);
  // docs/adr/2026-11-15-0730-a-new-task-is-triaged-in-one-command-before-it-is-investigated.md: grey "waiting…", with no
  // dot, counting up from the ask, until the orchestrator picks the task up, then the blue "thinking…".
  const triaging = '<span class="pickup-wait" data-since="[^"]+" data-word="waiting…">waiting…(?: \\([^)]+\\))?</span>';
  assert.match(strip([ask({ state: 'waiting' })]), /<div class="new-msg">Fix &lt;it&gt;\nand more<\/div>/);
  assert.match(strip([ask({ state: 'waiting' })]), new RegExp(triaging));
  assert.match(strip([ask({ state: 'working', edited: true })]), /<div class="new-line sub"><span class="new-time">[^<]+<\/span> · Edited · <span class="new-thinking"><span class="it it-current"><span class="it-i it-pulse" aria-hidden="true"><\/span><\/span>thinking…<\/span><\/div>/);
  // docs/adr/2026-11-14-2340-handoff-moves-a-ticket-to-another-board-and-leaves-a-pointer.md: a handed ask's source
  // line links the card it came from, and the sender's note is quoted under the message.
  const handed = strip([ask({ state: 'waiting', from: { words: '/orch · A1', link: '/orch/#selectedCard=w%2FA1' }, note: 'Yours <now>' })]);
  assert.match(entryText(handed), /From \/orch · A1 · waiting…(?: \([^)]+\))?$/);
  assert.match(handed, /<a class="new-source" href="\/orch\/#selectedCard=w%2FA1">From \/orch · A1<\/a>/);
  assert.match(handed, /<div class="new-msg">Fix &lt;it&gt;\nand more<\/div><blockquote class="quote new-note">Yours &lt;now&gt;<\/blockquote>/);
  assert.doesNotMatch(strip([ask({ state: 'waiting' })]), /new-note|new-source/);
  // The thinking line is info, blue (AGENTS.md colour priority), dot and word.
  const style = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  assert.match(style, /\.new-entry \.new-thinking \{ color: var\(--color-info\);/);
  assert.doesNotMatch(style, /\.new-entry \.new-thinking \{[^}]*--color-notice/);
  // docs/adr/2026-11-13-0000-a-new-strip-entry-shows-its-time-first.md: the footer starts with the ask's time, as a thread reply's does.
  assert.match(entryText(strip([ask({ state: 'waiting' })])), new RegExp(`${ui.time(sent)} · waiting…(?: \\([^)]+\\))?$`));
  assert.deepEqual([...strip([ask({ state: 'waiting' })]).matchAll(/data-(card-bump|edit|withdraw|dismiss-new)="([^"]+)"/g)].map((m) => [m[1], m[2]]), [['withdraw', 'a1']]);
  // Ingested: a line to the card it became or was added to, and Dismiss, which carries the card's key and the ingest's time.
  const made = { kind: 'work', id: 'T-3', key: 'w/T-3', ref: 'T-3', title: 'fix: <header>', fromAsk: 'a1', created: sent, ingested: { at: ago(0.5), text: 'Fix it' } };
  const html = strip([made], [{ key: 'w/T-2', ref: 'T-2', at: ago(0.2), id: 'a2', askedAt: ago(0.8), message: 'Also this' }]);
  assert.deepEqual([...html.matchAll(/class="new-link" href="([^"]+)" data-dismiss-new="([^"]+)" data-at="[^"]+">(.*?)<\/a>/g)].map((m) => [m[1], m[2], text(m[3])]),
    [['#selectedCard=w%2FT-3', 'w/T-3', 'Ticket created: T-3'], ['#selectedCard=w%2FT-2', 'w/T-2', 'Added to T-2']], 'following the link reads the task up to the ingest');
  assert.deepEqual([...html.matchAll(/data-dismiss-new="([^"]+)" data-at="[^"]+" aria-label="Dismiss"/g)].map((m) => m[1]), ['w/T-3', 'w/T-2']);
  assert.doesNotMatch(html, /data-edit|data-withdraw/);
  // A card read since its ingest has no entry.
  assert.equal(ui.newEntries({ items: [made], merges: [] }, { 'w/T-3': ago(0.1) }).length, 0);
});

// docs/adr/2026-11-12-2345-a-haiku-router-files-each-incoming-request-on-a-board.md
test("the hub's Routed section is the New strip under its own head: each row links to its card, the reason on a muted second line, with Dismiss on each routed one", () => {
  const at = ago(3);
  const rows = [
    { id: 'q1', at, text: 'held one', via: 'slack', by: 'Quinn', waiting: true },
    { id: 'r1', at, text: 'checkout <500s>', via: 'slack', by: 'Maya', reason: 'checkout is the shop', to: { route: 'shop', ref: 'T-5', title: 'Checkout 500s', href: '/shop/#selectedCard=items%2FT-5' } },
    { id: 'r2', at, text: 'rename it', via: 'slack', by: 'Sam', reason: 'nearest board', to: { route: 'shop', ref: null, title: null, href: '/shop/#selectedCard=ask%3Ae2' }, moved: { route: 'other', ref: 'T-9', title: 'Rename', href: '/other/#selectedCard=items%2FT-9' } },
    { id: 'r3', at, text: 'also this', via: 'slack', by: 'Sam', reason: 'same work', to: { route: 'shop', ref: 'T-5', title: 'Checkout 500s', href: '/shop/#selectedCard=items%2FT-5', into: true } },
  ];
  const html = ui.newStrip(rows.map((routed) => ({ id: routed.id, routed })), { label: 'Routed', empty: 'Nothing routed yet.' });
  assert.match(html, /<summary><span class="lane-name">Routed<\/span><span class="count">4<\/span><\/summary>/);
  assert.match(html, /<div class="new-msg">checkout &lt;500s&gt;<\/div>/);
  assert.deepEqual([...html.matchAll(/class="new-link" href="([^"]+)"[^>]*>(.*?)<\/a>/g)].map((m) => [m[1], text(m[2])]), [
    ['/shop/#selectedCard=items%2FT-5', 'Routed to /shop T-5 · Checkout 500s'],
    ['/other/#selectedCard=items%2FT-9', 'Moved to /other T-9 · Rename'],
    ['/shop/#selectedCard=items%2FT-5', 'Added to /shop T-5 · Checkout 500s'],
  ]);
  const whys = [...html.matchAll(/<div class="new-line sub new-why">(.*?)<\/div>/g)].map((m) => text(m[1]));
  assert.deepEqual(whys, ['Quinn · Slack', 'Maya · Slack — checkout is the shop', 'Sam · Slack — was routed to /shop: nearest board', 'Sam · Slack — same work']);
  const firsts = [...html.matchAll(/<div class="new-line sub[^"]*">(<span class="new-time">.*?)<\/div>/g)].map((m) => text(m[1]));
  assert.equal(firsts.length, 4, 'every row opens its first line with its time');
  assert.ok(firsts.every((f) => f.startsWith(`${ui.time(at)} · `)));
  assert.match(html, /pickup-wait/, 'a queued request reads waiting…');
  assert.doesNotMatch(html, /data-dismiss-new|data-edit|data-withdraw/);
  const entry = (id) => html.split('<div class="new-entry"').find((e) => e.includes(`data-new="${id}"`));
  assert.doesNotMatch(entry('q1'), /data-dismiss-row|new-dismiss/, 'a waiting row has neither X nor a dismissing link');
  for (const id of ['r1', 'r2', 'r3']) {
    assert.match(entry(id), new RegExp(`<button type="button" class="ghost icon new-dismiss" data-dismiss-row="${id}" aria-label="Dismiss"`));
    assert.match(entry(id), new RegExp(`<a class="new-link" href="[^"]+" data-dismiss-row="${id}">`), 'following the link dismisses too');
  }
  assert.match(ui.newStrip([], { label: 'Routed', empty: 'Nothing routed yet.' }), /<span class="count">0<\/span>[^]*<div class="new-entry new-empty">Nothing routed yet\.<\/div>/);
});

// docs/adr/2026-11-21-2300-each-board-takes-a-routed-ask-or-passes-it-down-haikus-ranking.md
test("the hub's New strip: an ask still routing reads trying with each pass; one no board took shows the passes, Haiku's answer and a board picker; a placed one links where you put it", () => {
  const at = ago(3);
  const passed = [{ route: 'flight-control', reason: 'not this repo' }];
  const three = [...passed, { route: 'kickflip-site', reason: 'a website' }, { route: 'hub-orchestrator', reason: 'a macOS question' }];
  const places = [{ route: 'kickflip-site', title: 'Kickflip site' }, { route: 'hub-orchestrator', title: 'Hub <orchestrator>' }];
  const rows = [
    { id: 't1', at, text: 'which Mac?', via: 'hub', by: 'love', reason: 'site', trying: true, passed, to: { route: 'kickflip-site', ref: 'T-1', title: 'which Mac?', href: '/kickflip-site/#selectedCard=items%2FT-1' } },
    { id: 'u1', at, text: 'keep my Mac awake?', via: 'hub', by: 'love', reason: 'hub', unplaced: true, passed, answer: { text: 'Run it under caffeinate -i.', at, slack: false }, places, to: { route: 'hub-orchestrator', ref: null, title: null, href: '/hub-orchestrator/#selectedCard=ask%3Ae4' } },
    { id: 'u2', at, text: 'same, from Slack', via: 'slack', by: 'Maya', link: 'https://slack.com/x', reason: 'hub', unplaced: true, passed: three, answer: { text: 'Run it under caffeinate -i.', at, slack: true }, places, to: { route: 'hub-orchestrator', ref: null, title: null, href: '/hub-orchestrator/#selectedCard=ask%3Ae5' } },
    { id: 'u3', at, text: 'answering', via: 'hub', by: 'love', reason: 'hub', unplaced: true, passed, answer: null, places, to: { route: 'hub-orchestrator', ref: null, title: null, href: '/x' } },
    { id: 'u4', at, text: 'no answer', via: 'hub', by: 'love', reason: 'hub', unplaced: true, passed, answer: null, answerError: 'claude -p timed out', places, to: { route: 'hub-orchestrator', ref: null, title: null, href: '/x' } },
    { id: 'p1', at, text: 'placed', via: 'hub', by: 'love', reason: 'you put it here after no board took it', placed: true, passed, to: { route: 'kickflip-site', ref: 'T-7', title: 'placed', href: '/kickflip-site/#selectedCard=items%2FT-7' } },
  ];
  const html = ui.newStrip(rows.map((routed) => ({ id: routed.id, routed })), { label: 'New', empty: '' });
  const entry = (id) => html.split('<div class="new-entry"').find((e) => e.includes(`data-new="${id}"`));
  assert.match(text(entry('t1')), /Trying \/kickflip-site…/);
  assert.match(entry('t1'), /class="routed-trying"/, 'trying reads orange, as work does');
  assert.match(text(entry('t1')), /\/flight-control passed: not this repo/);
  assert.doesNotMatch(entry('t1'), /data-dismiss-row/, 'no X while it routes');
  assert.match(text(entry('u1')), /Answered by Haiku/);
  assert.match(text(entry('u1')), /No board took this · \/flight-control: not this repo/);
  assert.match(entry('u1'), /<div class="routed-reply"><div class="routed-reply-from">Router · Haiku<\/div><p>Run it under caffeinate -i\.<\/p><\/div>/);
  assert.match(entry('u1'), /<select class="routed-place" data-place-row="u1" aria-label="Put on a board"><option value="" selected disabled>Put on a board…<\/option><option value="kickflip-site">\/kickflip-site<\/option><option value="hub-orchestrator">\/hub-orchestrator<\/option><\/select>/);
  assert.match(entry('u1'), /data-dismiss-row="u1" aria-label="Dismiss"/);
  assert.doesNotMatch(entry('u1'), /Slack thread/);
  assert.match(entry('u2'), /<details class="routed-passes"><summary>No board took this · 3 passed<\/summary>/, 'three passes or more fold to a count');
  assert.match(entry('u2'), /<a class="routed-slack" href="https:\/\/slack.com\/x" target="_blank" rel="noopener">Answer also posted in its Slack thread<\/a>/);
  assert.match(text(entry('u3')), /Haiku is answering…/);
  assert.match(entry('u3'), /data-place-row="u3"/, 'it can be placed before the answer comes');
  assert.match(text(entry('u4')), /Haiku couldn't answer: claude -p timed out/);
  assert.match(entry('u4'), /class="routed-fault"/);
  assert.deepEqual([...entry('p1').matchAll(/class="new-link" href="([^"]+)"[^>]*>(.*?)<\/a>/g)].map((m) => [m[1], text(m[2])]), [['/kickflip-site/#selectedCard=items%2FT-7', 'Placed on /kickflip-site T-7 · placed']]);
  assert.match(text(entry('p1')), /love · hub — you put it here after no board took it/);
});

test("the hub's New strip draws an incoming ask: who asked whom, queued or answered with a link to the asking card", () => {
  const at = ago(3);
  const asks = [
    { id: 'a1', at, text: 'why <X>?', asked: { from: { route: 'other', title: 'Other', ref: 'T-9' }, to: { route: 'shop', href: '/shop/#selectedCard=ask%3Aa1' }, answered: null } },
    { id: 'a2', at, text: 'and Y?', asked: { from: { route: 'other', title: 'Other' }, to: { route: 'shop', href: '/shop/#selectedCard=ask%3Aa2' }, answered: { at, href: '/other/#selectedCard=items%2FT-9' } } },
    { id: 'a3', at, text: 'and Z?', asked: { from: { route: 'other', title: 'Other' }, to: { route: 'shop', href: '/shop/#selectedCard=ask%3Aa3' }, answered: { at, href: null } } },
  ];
  const html = ui.newStrip(asks.map((routed) => ({ id: routed.id, routed })), { label: 'New', empty: '' });
  assert.match(html, /<span class="lane-name">New<\/span><span class="count">3<\/span>/);
  assert.match(html, /<div class="new-msg">why &lt;X&gt;\?<\/div>/);
  const firsts = [...html.matchAll(/<div class="new-line sub[^"]*">(<span class="new-time">.*?)<\/div>/g)].map((m) => text(m[1]));
  assert.deepEqual(firsts.map((f) => f.slice(ui.time(at).length + 3)), ['Asked /shop · queued', 'Asked /shop · Answered', 'Asked /shop · Answered']);
  assert.deepEqual([...html.matchAll(/class="new-link" href="([^"]+)"[^>]*>(.*?)<\/a>/g)].map((m) => [m[1], text(m[2])]), [
    ['/shop/#selectedCard=ask%3Aa1', 'Asked /shop'], ['/shop/#selectedCard=ask%3Aa2', 'Asked /shop'], ['/other/#selectedCard=items%2FT-9', 'Answered'], ['/shop/#selectedCard=ask%3Aa3', 'Asked /shop']]);
  const whys = [...html.matchAll(/<div class="new-line sub new-why">(.*?)<\/div>/g)].map((m) => text(m[1]));
  assert.deepEqual(whys, ['/other T-9 · board ask', '/other · board ask', '/other · board ask']);
  assert.doesNotMatch(html, /data-dismiss-new|data-edit|data-withdraw/);
  const entry = (id) => html.split('<div class="new-entry"').find((e) => e.includes(`data-new="${id}"`));
  assert.doesNotMatch(entry('a1'), /data-dismiss-row/, 'a queued ask has no X');
  for (const id of ['a2', 'a3']) assert.match(entry(id), new RegExp(`class="ghost icon new-dismiss" data-dismiss-row="${id}"`));
  assert.equal([...entry('a2').matchAll(/<a class="new-link"[^>]*data-dismiss-row="a2"/g)].length, 2, 'both links of an answered ask dismiss it');
});

const lines = (html) => html.split('<div class="line').slice(1).map((l) => text('<div class="line' + l));
const workCard = { kind: 'work', key: 'w/B5', id: 'B5', ref: 'B5', title: 'Five', internal: false, ownerBlock: null, threadCount: 4,
  linear: [{ id: 'ENG-1', url: 'https://linear.app/x/ENG-1' }], pr: { ...openPR, isDraft: true, status: 'draft' }, prs: [{ ...openPR, isDraft: true, status: 'draft' }], reviewers: ['Jamie'], review: { Jamie: { state: 'unsent' } },
  questions: null, builder: null, working: false, next: 'Waiting for PR reviewers' };

test('ticket badges use the board source and link out', () => {
  for (const [source, id, url] of [['github', '#9', 'https://github.com/o/r/issues/9'], ['linear', 'ENG-9', 'https://linear.app/another/issue/ENG-9']]) {
    const card = { ...workCard, ticket: { source, id, url } };
    const html = workLines(card);
    assert.match(html, new RegExp(`>${id.replace('#', '#')}<`));
    assert.ok(html.includes(`href="${url}"`));
    assert.ok(html.indexOf('target="_blank"') >= 0 && html.indexOf('target="_blank"') < html.indexOf('</a>'));
    assert.doesNotMatch(html, /ENG-1/);
  }
  assert.match(workLines({ ...workCard, linear: [...workCard.linear, { id: 'ENG-2', url: 'https://linear.app/another/issue/ENG-2' }] }), /ENG-1.*ENG-2/);
  const foreign = workLines({ ...workCard, ticket: { id: 'INT-4', url: null, source: null } });
  assert.match(foreign, /<span class="chip tone-quiet"[^>]*>INT-4<\/span>/);
  assert.doesNotMatch(foreign, /ENG-1|#4/);
});

// docs/adr/2026-11-14-1200-waves-are-dropped-deps-and-related-carry-order-and-grouping.md
test('a card names no wave or item file in any lane', () => {
  for (const lane of ['todo', 'progress', 'review', 'done']) {
    assert.doesNotMatch(workLines({ ...workCard, lane, wave: { slug: 'w', title: 'Search' }, fileLabel: 'Search', fileTitle: 'Search' }), /Wave: |Search/);
  }
});

test('a work card reads its title, then its next step or builder, its chips, and last its time line with what blocks it, Action needed and its unread messages', () => {
  assert.deepEqual(lines(workLines(workCard, { unread: 2 })), ['ENG-1 Five', 'Next: Waiting for PR reviewers', 'repo#7 ● Jamie ●', '2 new messages']);
  assert.deepEqual(lines(workLines({ ...workCard, next: null, pr: null, prs: [], reviewers: [] }, { unread: 1 })), ['ENG-1 Five', '1 new message']);
  assert.doesNotMatch(text(workLines(workCard)), /B5|msg|unread|new/);
  const busy = { ...workCard, ownerBlock: { until: null }, builder: { progress: 'Running tests', words: 'Running tests', at: null } };
  assert.deepEqual(lines(workLines(busy)), ['ENG-1 Five', 'Running tests', 'repo#7 ● Jamie ●', 'blocked']);
  // The builder's risk is a Risk row on the open card, not a chip on the face.
  for (const risk of ['low', 'medium', 'high']) {
    assert.deepEqual(lines(workLines({ ...workCard, risk })), ['ENG-1 Five', 'Next: Waiting for PR reviewers', 'repo#7 ● Jamie ●']);
    assert.doesNotMatch(workLines({ ...workCard, risk }), /risk/);
  }
  const internal = { ...workCard, key: 'site/S3', id: 'S3', ref: 'INT-3', pr: null, prs: [], linear: [], next: null };
  assert.deepEqual(lines(workLines(internal)), ['INT-3 Five']);
  assert.deepEqual(lines(workLines({ ...workCard, questions: { open: 1, first: 'q1' }, action: { kind: 'questions', url: 'questions.html#q1', label: 'Answer 1 question' } })),
    ['ENG-1 Five', 'Next: Waiting for PR reviewers', 'repo#7 ● Jamie ●', 'Open items']);
  assert.deepEqual(lines(workLines({ ...workCard, questions: { open: 1, first: 'q1' }, action: { kind: 'questions', url: 'questions.html#q1', label: 'Answer 1 question' } }, { unread: 3 })),
    ['ENG-1 Five', 'Next: Waiting for PR reviewers', 'repo#7 ● Jamie ●', 'Open items · 3 new messages']);
  const blocked = { ...internal, lane: 'todo', deps: ['S1', 'S2'], blockedBy: [{ key: 'site/S2', ref: 'INT-2' }] };
  assert.deepEqual(lines(workLines(blocked)), ['INT-3 Five', 'blocked by INT-2']);
  assert.match(workLines(blocked), /<div class="line6 sub card-time"><a class="card-blocked" href="#selectedCard=site%2FS2">blocked by INT-2<\/a><\/div>/);
  assert.match(workLines({ ...blocked, blockedBy: [{ key: 'site/S1', ref: 'INT-1' }, { key: 'site/S2', ref: 'INT-2' }] }), />blocked by INT-1<\/a><span class="sep">, <\/span><a class="card-blocked" href="#selectedCard=site%2FS2">INT-2<\/a>/);
  assert.deepEqual(lines(workLines({ ...blocked, blockedBy: [] })), ['INT-3 Five']);
  // docs/adr/2026-11-05-2358-nothing-waiting-on-the-orchestrator-is-missed.md: a condition and a reason read on the time line.
  const until = { ...blocked, blockedBy: [], blockedUntil: 'the CI run on main is green', blockReason: 'the suite is red <now>' };
  assert.deepEqual(lines(workLines(until)), ['INT-3 Five', 'blocked until the CI run on main is green, the suite is red <now>']);
  assert.match(workLines(until), /<div class="line6 sub card-time"><span class="card-blocked">blocked until the CI run on main is green, the suite is red &lt;now&gt;<\/span><\/div>/);
  assert.deepEqual(lines(workLines({ ...until, blockReason: null })), ['INT-3 Five', 'blocked until the CI run on main is green']);
  assert.match(workLines({ ...blocked, blockReason: 'shares the send bar' }), />blocked by INT-2<\/a><span class="card-blocked">, shares the send bar<\/span><\/div>/);
  assert.match(workLines({ ...until, blockedBy: blocked.blockedBy }), />blocked by INT-2<\/a><span class="card-blocked"> and until the CI run on main is green, the suite is red &lt;now&gt;<\/span><\/div>/);
  // docs/adr/2026-11-05-0802-todo-has-no-queue.md: a bumped blocked card waits for the pull; blocked by the owner too, it reads both (below).
  assert.match(workLines({ ...blocked, bumpedAt: '2026-11-05T10:00:00.000Z' }), /<a class="card-blocked" href="#selectedCard=site%2FS2">blocked by INT-2<\/a>/);
  assert.deepEqual(lines(workLines({ ...blocked, blockedBy: [], next: 'Answer 1 question', action: { kind: 'questions', url: 'questions.html#q1', label: 'Answer 1 question' } })),
    ['INT-3 Five', 'Next: Answer 1 question', 'Open items']);
  // docs/adr/2026-11-03-0301-build-on-a-blocked-card-queues-it.md: no bumped badge; the card's "…" fills orange while
  // bumped (docs/adr/2026-11-17-1100-a-cards-menu-narrows-the-board-to-its-chain.md).
  const sortAt = ago(2);
  const waiting = { ...workCard, lane: 'todo', deps: ['S2'], blockedBy: [{ key: 'site/S2', ref: 'INT-2' }], bumpable: true, bumpedAt: ago(1), ownerBlock: { until: null }, sortAt,
    action: { kind: 'questions', url: 'questions.html#q1', label: 'Answer 1 question' } };
  assert.deepEqual(lines(workLines(waiting, { unread: 1 })), ['ENG-1 Five', 'Next: Waiting for PR reviewers', 'repo#7 ● Jamie ●', `${ui.cardTime(sortAt)} · blocked · blocked by INT-2`, 'Open items · 1 new message']);
  assert.match(workLines(waiting), /<div class="ask-actions"><button type="button" class="ghost icon card-more bumped" data-card-menu="w\/B5" aria-haspopup="menu" aria-expanded="false" aria-label="More" title="Bumped · More">/);
  assert.doesNotMatch(workLines(waiting), /disabled|data-confirm="bump"|data-card-bump/);
  assert.match(workLines({ ...waiting, bumpedAt: null }), /<button type="button" class="ghost icon card-more" data-card-menu="w\/B5" aria-haspopup="menu" aria-expanded="false" aria-label="More" title="More">/);
  // The card an ask became, once sorted, reads as any task: Task where its ticket would be, and no asked line.
  const fromAsk = { kind: 'work', key: 'w/T-3', id: 'T-3', ref: 'T-3', title: 'Fix it', linear: [], pr: null, prs: [], deps: [], blockedBy: [], working: true };
  assert.deepEqual(lines(workLines(fromAsk)), ['T-3 Fix it', 'thinking…']);
  assert.deepEqual(lines(workLines(fromAsk, { unread: 2 })), ['T-3 Fix it', 'thinking…', '2 new messages']);
  assert.deepEqual(lines(workLines({ ...internal, waitsOn: 'checking', working: true, next: 'Verify it' })), ['INT-3 Five', 'Orchestrator review']);
  // docs/adr/2026-11-14-0725-one-land-step-decides-a-verified-cards-land.md: a verified card reads its land step, over
  // the orchestrator's wait: a hold in grey, a fault in red.
  const landing = (step, words) => workLines({ ...internal, lane: 'progress', waitsOn: 'checking', land: { step, words }, orchestrator: { kind: 'checking', since: ago(5), picked: ago(4), next: 'x' } });
  assert.deepEqual(lines(landing('held', 'Landing held: host busy')).slice(0, 2), ['INT-3 Five', 'Landing held: host busy']);
  assert.match(landing('held', 'Landing held: host busy'), /class="line3 sub agent waiting-gray">Landing held/);
  assert.match(landing('fault', 'Lander exited twice without landing'), /class="line3 sub refused">Lander exited twice/);
  assert.match(landing('running', 'Lander running'), /class="line3 sub agent in-progress"><span class="it it-current"><span class="it-i it-pulse"[^>]*><\/span><\/span>Lander running/);
  const followup = { ...workCard, key: 'w/ENG-7', id: 'ENG-7', ref: 'ENG-7', linear: [{ id: 'ENG-7', url: 'u' }], pr: null, prs: [], reviewers: [], next: null, lane: 'todo', deps: [], blockedBy: [] };
  assert.deepEqual(lines(workLines(followup)), ['ENG-7 Five']);
  assert.doesNotMatch(workLines(followup), /follow-up/);
});

test("a card's last line is the time its lane sorts by, then the owner's block with no chip, then its unread messages, with no age badge", () => {
  const created = ago(24 * 5);
  const updatedAt = ago(30);
  const sortAt = ago(24 * 2);
  const card = { ...workCard, lane: 'todo', pr: null, prs: [], reviewers: [], next: null, created, updatedAt, sortAt };
  const last = (html) => lines(html).at(-1);
  assert.deepEqual(lines(workLines(card)), ['ENG-1 Five', ui.cardTime(sortAt)]);
  assert.match(workLines(card), new RegExp(`<div class="line6 sub card-time"><time datetime="${sortAt}">`));
  assert.deepEqual(lines(workLines(card, { unread: 3 })).slice(-2), [ui.cardTime(sortAt), '3 new messages']);
  assert.match(workLines(card, { unread: 3 }), /<div class="line6 sub card-alert"><span class="card-unread">3 new messages<\/span><\/div>$/);
  assert.doesNotMatch(text(workLines(card)), /days? ago/);

  const held = { ...card, ownerBlock: { until: null }, blocked: true };
  assert.deepEqual(lines(workLines(held)), ['ENG-1 Five', `${ui.cardTime(sortAt)} · blocked`]);
  assert.match(workLines(held), /<span class="card-owner-block" title="Blocked until you unblock it\.">blocked<\/span>/);
  assert.deepEqual(lines(workLines({ ...held, sortAt: null }, { unread: 1 })), ['ENG-1 Five', 'blocked', '1 new message']);
  const now = new Date(NOW);
  const at = (days, h, m) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, h, m);
  const clock = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?([AP]M)$/i, (_, x) => ` ${x.toLowerCase()}`);
  const heldTill = (d) => ({ ...held, ownerBlock: { until: d.toISOString() } });
  assert.deepEqual(lines(workLines(heldTill(at(2, 9, 0)), { unread: 2 })).slice(-2), [`${ui.cardTime(sortAt)} · blocked until ${at(2, 9, 0).toLocaleDateString([], { weekday: 'short' })} ${clock(at(2, 9, 0))}`, '2 new messages']);
  assert.equal(last(workLines(heldTill(at(0, 23, 59)))), `${ui.cardTime(sortAt)} · blocked until ${clock(at(0, 23, 59))}`);
  assert.equal(last(workLines(heldTill(at(6, 9, 0)))), `${ui.cardTime(sortAt)} · blocked until ${at(6, 9, 0).toLocaleDateString([], { weekday: 'short' })} ${clock(at(6, 9, 0))}`);
  assert.equal(last(workLines(heldTill(at(7, 9, 0)))), `${ui.cardTime(sortAt)} · blocked until ${at(7, 9, 0).toLocaleDateString([], { month: 'numeric', day: 'numeric' })}, ${clock(at(7, 9, 0))}`);
  assert.doesNotMatch(workLines(heldTill(at(2, 9, 0))), /class="chip[^"]*">blocked/);
});

// docs/adr/2026-11-03-0516-a-new-card-is-ready-grilling-or-prototyping.md
test("a ready card's time line reads ready in green ahead of its block and before its unread messages, and an unsorted work card shows its ticket", () => {
  const sortAt = ago(24 * 2);
  const card = { ...workCard, lane: 'todo', pr: null, prs: [], reviewers: [], next: null, sortAt };
  const html = workLines({ ...card, ownerBlock: { until: null }, phase: 'ready' }, { unread: 2 });
  assert.deepEqual(lines(html).slice(-2), [`${ui.cardTime(sortAt)} · ready · blocked`, '2 new messages']);
  const open = workLines({ ...card, ready: true, phase: 'ready' }, { unread: 2 });
  assert.deepEqual(lines(open).slice(-2), [`${ui.cardTime(sortAt)} · ready`, '2 new messages']);
  assert.match(open, /<span class="card-phase ph-success">ready<\/span><\/div><div class="line6 sub card-alert"><span class="card-unread">/);
  assert.doesNotMatch(workLines(card), /card-phase/);
  assert.deepEqual(lines(workLines({ ...card, unsorted: true }))[0], 'ENG-1 Five');
  assert.doesNotMatch(workLines({ ...card, unsorted: true }), />New</);
  assert.doesNotMatch(workLines(card), />New</);
});


// docs/adr/2026-11-09-1300-a-card-pause-stops-its-builder-at-its-next-stopping-point.md
test('a paused build reads "pausing · <cause>" in orange, then "paused · <cause>" in grey, its bars dimmed at the phase it stopped at, in place of the block it names', () => {
  const sortAt = ago(40);
  const builder = { kind: 'claude', phase: 'building', progress: 'Building · Writing the limiter test', words: 'Building · Writing the limiter test', at: ago(3), alive: true, stale: false };
  const card = { ...workCard, lane: 'progress', pr: null, prs: [], reviewers: [], next: null, sortAt, deps: ['w/B1'], blockedBy: [{ key: 'w/B1', ref: '#61' }], blocked: true };
  const pausing = workLines({ ...card, builder: { ...builder, pause: { cause: 'blocked', words: 'blocked by #61', paused: false } } });
  assert.match(lines(pausing).at(-1), new RegExp(`^${ui.cardTime(sortAt)} · pausing · blocked by #61 ·`));
  assert.match(pausing, /<span class="card-pausing">pausing · blocked by #61<\/span><span class="sep"> · <\/span><span class="phase-bars"/);
  assert.match(pausing, /Building · Writing the limiter test/, 'its progress line stays');
  const paused = workLines({ ...card, builder: { ...builder, held: true, alive: null, pause: { cause: 'blocked', words: 'blocked by #61', paused: true } } });
  assert.match(paused, /<span class="card-paused">paused · blocked by #61<\/span>/);
  assert.match(paused, /aria-label="Building, step 2 of 4"/);
  assert.match(workLines({ ...card, builder: { ...builder, pause: { cause: 'blocked', words: 'blocked by #61', paused: false } } }), /<span class="phase-bars"/, 'a pausing build runs on, its bars lit');
  const pausedAwake = workLines({ ...card, builder: { ...builder, pause: { cause: 'blocked', words: 'blocked by #61', paused: true } } });
  assert.match(pausedAwake, /<span class="phase-bars dim"[^>]*aria-label="Building, step 2 of 4"/, 'a paused build dims its bars at the phase it stopped at');
  const held = workLines({ ...card, blockedBy: [], ownerBlock: { until: null }, builder: { ...builder, pause: { cause: 'held', words: 'blocked', paused: true } } });
  assert.match(lines(held).at(-1), new RegExp(`^${ui.cardTime(sortAt)} · paused · blocked ·`), "the owner's block reads once");
});

// docs/adr/2026-11-12-0500-a-new-task-is-a-conversation.md
test("a discussing card's time line reads discussing in grey on either turn", () => {
  const sortAt = ago(24 * 2);
  const card = { ...workCard, lane: 'todo', pr: null, prs: [], reviewers: [], next: null, sortAt, phase: 'discussing' };
  const yours = workLines({ ...card, turn: 'owner' }, { unread: 1 });
  assert.deepEqual(lines(yours).slice(-2), [`${ui.cardTime(sortAt)} · discussing`, '1 new message']);
  assert.match(yours, /<span class="card-phase ph-quiet">discussing<\/span>/);
  assert.match(workLines({ ...card, turn: 'claude' }), /<span class="card-phase ph-quiet">discussing<\/span>/);
});

// docs/adr/2026-11-07-0700-staging-then-ready.md
test("a staged card's time line reads staged in orange where ready reads", () => {
  const sortAt = ago(24 * 2);
  const card = { ...workCard, lane: 'todo', pr: null, prs: [], reviewers: [], next: null, sortAt, staging: true, phase: 'staging' };
  const html = workLines(card, { unread: 1 });
  assert.deepEqual(lines(html).slice(-2), [`${ui.cardTime(sortAt)} · staged`, '1 new message']);
  assert.match(html, /<span class="card-phase ph-notice">staged<\/span><\/div>/);
  assert.match(lines(workLines({ ...card, ownerBlock: { until: null } })).slice(-1)[0], /^.* · staged · blocked/);
  assert.doesNotMatch(html, /ph-success/);
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
  const html = workLines({ ...workCard, install });
  assert.equal(lines(html)[2], 'repo#7 ● Jamie ● Install');
  assert.match(html, /href="itms-services:/);
  assert.doesNotMatch(ui.installButton({ ...workCard, install }), /target=/);
  assert.equal(text(ui.installChip({ ...workCard, install: { ...install, older: true } })), 'Install (stale)');
  assert.doesNotMatch(workLines(workCard), /Install/);
});

test('try badges share ready, stale, running, failed and absent states for both kinds, including legacy builders', () => {
  for (const kind of ['web', 'app']) for (const render of [ui.installChip, ui.installButton]) {
    const { done, going, failed } = ui.tryWords(kind);
    const card = { ...workCard, try: { kind, state: 'ready', url: kind === 'web' ? null : 'https://m/app.apk', port: kind === 'web' ? 8501 : null, sha: 'abcdef1' } };
    assert.equal(text(render(card)), done);
    assert.match(render(card), /tone-ready/);
    assert.ok(render(card).includes(`href="${kind === 'web' ? 'https://mac.ts.net:8501/' : 'https://m/app.apk'}"`));
    assert.equal(/target="_blank"/.test(render(card)), kind === 'web');
    assert.ok(text(render({ ...card, try: { ...card.try, stale: true } })).startsWith(`${done} `));
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

test('main\'s repo and commit link to GitHub when the repo is known, plain text when not', () => {
  const main = { kind: 'web', slug: 'owner/repo', branch: 'main', sha: '1234567', at: ago(2), state: 'ready', port: 8500 };
  const html = ui.mainBar(main);
  assert.match(html, /<a class="plain-link" href="https:\/\/github\.com\/owner\/repo" target="_blank" rel="noopener"><span>owner\/repo<\/span><\/a>/);
  assert.match(html, /<a class="plain-link" href="https:\/\/github\.com\/owner\/repo\/commit\/1234567" target="_blank" rel="noopener"><code>1234567<\/code><\/a>/);
  const old = ui.mainBar({ ...main, serving: { sha: '7654321', at: ago(5) } });
  assert.match(old, /commit\/7654321/);
  assert.doesNotMatch(old, /commit\/1234567/);
  const bare = ui.mainBar({ ...main, slug: '' });
  assert.doesNotMatch(bare, /github\.com/);
  assert.match(bare, /<code>1234567<\/code>/);
});

test('main is a slim branch bar with a ready link, running status or failed log button', () => {
  assert.equal(ui.mainBar(null), '');
  for (const kind of ['web', 'app']) {
    const main = { kind, slug: 'owner/repo', branch: 'develop', sha: '1234567', at: ago(2), state: 'ready', url: kind === 'web' ? null : 'https://m/main.apk', port: kind === 'web' ? 8500 : null };
    assert.ok(ui.mainBar(main).includes(`href="${kind === 'web' ? 'https://mac.ts.net:8500/' : 'https://m/main.apk'}"`));
    assert.match(ui.mainBar(main), /tb-main.*owner\/repo.*<strong>develop<\/strong>@<a [^>]*><code>1234567<\/code><\/a> <span class="muted">2h<\/span>/);
    assert.equal(text(ui.mainBar(main)).includes(kind === 'web' ? 'Visit' : 'Install'), true);
    assert.match(ui.mainBar({ ...main, state: 'running' }), /role="status"/);
    assert.doesNotMatch(ui.mainBar({ ...main, state: 'running' }), /class="chip tone-ready"|<button/);
    assert.match(ui.mainBar({ ...main, state: 'failed' }), /<button[^>]*data-main-log=""[^>]*aria-haspopup="dialog"/);
  }
});

test('while main re-serves or after its new build failed, the bar names the old server’s commit and keeps Visit to it, with Updating… or Update failed left of Visit', () => {
  const main = { kind: 'web', slug: 'owner/repo', branch: 'main', sha: '58818ab', at: ago(1), state: 'running', url: null, port: 8500, serving: { sha: '54837cd', at: ago(9) } };
  const rebuilding = ui.mainBar(main);
  assert.match(rebuilding, /@<a [^>]*><code>54837cd<\/code><\/a> <span class="muted">9h<\/span>/);
  assert.match(rebuilding, /<div class="meta"><span[^>]*role="status"[^>]*><span class="try-spin"[^>]*><\/span>Updating…<\/span><a[^>]*href="https:\/\/mac\.ts\.net:8500\/"[^>]*>Visit .*<\/a><\/div><\/div>$/);
  assert.ok(text(rebuilding).indexOf('Updating…') < text(rebuilding).indexOf('Visit'));
  const failed = ui.mainBar({ ...main, state: 'failed' });
  assert.match(failed, /@<a [^>]*><code>54837cd<\/code><\/a>/);
  assert.match(failed, /<div class="meta"><button[^>]*data-main-log=""[^>]*>Update failed<\/button><a[^>]*href="https:\/\/mac\.ts\.net:8500\/"/);
  // With no old server left (a hub restart, or a build on the old server's port), the bar is as before.
  assert.doesNotMatch(ui.mainBar({ ...main, port: null, serving: null }), /tone-ready/);
  assert.match(ui.mainBar({ ...main, port: null, serving: null }), /@<a [^>]*><code>58818ab<\/code><\/a>/);
});

test("a local board's Main has a refresh icon right of its timestamp that spins while a pull runs and turns red with the reason when one fails", () => {
  const main = { kind: 'web', slug: 'owner/repo', branch: 'main', sha: '1234567', at: ago(2), state: 'ready', url: null, port: 8500 };
  assert.doesNotMatch(ui.mainBar({ ...main, pull: null }), /data-main-pull/);
  const idle = ui.mainBar({ ...main, pull: { running: false, error: null } });
  assert.match(idle, /<\/code><\/a> <span class="muted">[^<]+<\/span><\/span><span class="main-pull"><button class="ghost gh-refresh" type="button" data-main-pull aria-label="Pull main now"><svg/);
  assert.doesNotMatch(idle, /role="tooltip"/);
  assert.equal(text(idle).includes('Visit'), true);
  const running = ui.mainBar({ ...main, pull: { running: true, error: null } });
  assert.match(running, /class="ghost gh-refresh spinning" type="button" data-main-pull aria-label="Pulling main" aria-disabled="true"/);
  assert.equal(text(running).includes('Visit'), true);
  const failed = ui.mainBar({ ...main, pull: { running: false, error: 'can’t pull: local changes' } });
  assert.match(failed, /class="ghost gh-refresh failed" type="button" data-main-pull aria-label="can’t pull: local changes"/);
  assert.match(failed, /<span class="main-pull-why" role="tooltip">can’t pull: local changes<\/span>/);
  assert.match(ui.mainBar({ ...main, pull: { running: false, error: 'x' } }, { open: true }), /class="main-pull-why open"/);
});

test("a card's ETA line gives the time, with the day when not today", () => {
  const now = new Date(2026, 9, 23, 9, 0);
  assert.equal(ui.etaLine(new Date(2026, 9, 23, 16, 30).toISOString(), now), 'ETA about 4:30 pm');
  assert.match(ui.etaLine(new Date(2026, 9, 24, 9, 5).toISOString(), now), /^ETA about Oct 24, 9:05 am$/);
  const busy = { ...workCard, builder: { progress: 'Running benchmarks', words: 'Running benchmarks', at: null }, eta: new Date(NOW + 3600000).toISOString() };
  assert.match(lines(workLines(busy))[1], /^Running benchmarks$/);
  assert.match(lines(workLines(busy))[2], /^ETA about /);
  assert.equal(lines(workLines({ ...busy, builder: null })).some((l) => l.startsWith('ETA')), false);
});

test('a thread counts as unread only the messages from others since this browser last opened it', () => {
  const at = ['2026-10-23T09:00:00Z', '2026-10-23T10:00:00Z', '2026-10-23T11:00:00Z'];
  assert.equal(ui.unreadCount(at, null), 0);
  assert.equal(ui.unreadCount(at, '2026-10-23T09:30:00Z'), 2);
  assert.equal(ui.unreadCount(at, '2026-10-23T11:00:00Z'), 0);
});

test('a message edited before thread edits went says so beside its author, as a moved one does', () => {
  const html = ui.threadMessages([{ ts: ago(1), who: 'love', via: 'site', kind: 'item-message', text: 'Fix it well', edited: true, eventId: 'e1', reply: null, state: 'waiting' }]);
  assert.match(text(html), /^You Fix it well \S.* · Edited · waiting…$/);
  const moved = ui.threadMessages([{ ts: ago(1), who: 'love', via: 'ask', kind: 'ask', text: 'Swipe the gallery', moved: true, eventId: 'a1', reply: null, state: 'answered' }]);
  assert.match(text(moved), /^You Swipe the gallery \S.* · Moved$/);
});

test('a builder status line, and an agent starting or finishing, reads as one line with its time and no author or actions, a running agent with its ETA', () => {
  const html = ui.threadMessages([{ ts: ago(1), who: 'claude', kind: 'status', text: 'Codex: <b>Running</b> tests' }]);
  assert.match(html, /class="msg status-line builder-status">/);
  assert.match(text(html), /^Codex: <b>Running<\/b> tests · \S/);
  assert.doesNotMatch(html, /class="who"|data-withdraw|data-edit/);
  const agents = ui.threadMessages([
    { ts: ago(1), who: 'claude', kind: 'agent', text: 'Codex started', finished: false, eta: new Date(NOW + 3600000).toISOString() },
    { ts: ago(0.8), who: 'claude', kind: 'agent', text: 'Opus builder started', finished: false, eta: null },
    { ts: ago(0.5), who: 'claude', kind: 'agent', text: 'Opus builder <b>finished</b>', finished: true, eta: null },
  ]);
  const dot = '<span class="mark" aria-hidden="true"><span class="it it-current"><span class="it-i it-dot" aria-hidden="true"><\\/span><\\/span><\\/span>';
  assert.match(agents, new RegExp(`^<div class="msg status-line agent started">${dot}Codex started`));
  assert.match(agents, new RegExp(`<div class="msg status-line agent started">${dot}Opus builder started`));
  assert.match(agents, new RegExp(`<div class="msg status-line agent finished">${dot}Opus builder &lt;b&gt;finished`));
  assert.match(text(agents), /^Codex started · \S.* · ETA about .+ Opus builder started · [^·]+ Opus builder <b>finished<\/b> · [^·]+$/);
  assert.doesNotMatch(agents, /class="who"|data-withdraw|data-edit/);
  const planner = ui.threadMessages([
    { ts: ago(1), who: 'claude', kind: 'agent', text: 'Claude Sonnet prototype started', finished: false, eta: null, planner: true },
    { ts: ago(0.8), who: 'claude', kind: 'status', text: 'Reading: the notes', planner: true },
  ]);
  assert.match(planner, /<div class="msg status-line agent started planner"><span class="mark" aria-hidden="true"><span class="it it-current"><span class="it-i it-dot" aria-hidden="true"><\/span><\/span><\/span>Claude Sonnet prototype started/);
  assert.match(planner, /<div class="msg status-line builder-status planner"><span class="mark" aria-hidden="true"><span class="it it-current"><span class="it-i it-pulse" aria-hidden="true"><\/span><\/span><\/span>Reading: the notes/);
  // A bare Grill or Prototype tap, and a New task sent with Implement, are a muted request entry, not a message from the
  // owner, led by its icon in the same box as the dots; a Full person's names them
  // (docs/adr/2026-11-06-0021-a-button-without-a-text-box-posts-a-keyed-status-line.md). A request's event line reads
  // waiting… after its time until a session picks it up; the board's own Implement line has no state
  // (docs/adr/2026-11-14-0530-every-reply-box-tap-shows-its-line-at-once-and-retries-in-place.md).
  const requests = ui.threadMessages([
    { ts: ago(2), who: 'love', via: 'site', kind: 'grill-more', request: true, text: 'Grill requested', eventId: 'g1', state: 'waiting', files: [] },
    { ts: ago(1), who: 'love', via: 'site', kind: 'prototype-request', request: true, text: 'Prototype requested', eventId: 'p1', state: 'waiting', files: [] },
    { ts: ago(0.5), who: 'claude', kind: 'command', command: 'staged', request: true, mark: 'Marked as staged', text: 'Marked as staged', tone: 'orange', by: 'Dana Reyes' },
  ]);
  assert.match(requests, new RegExp(`^<div class="msg status-line request"><span class="mark" aria-hidden="true">${ui.MARK_ICONS['Grill requested']}</span>Grill requested <span class="muted">· [^<]+ · <span>waiting…</span></span></div><div class="msg status-line request"><span class="mark" aria-hidden="true">${ui.MARK_ICONS['Prototype requested'].replace(/[.*+?()[\]]/g, '\\$&')}</span>Prototype requested <span class="muted">`));
  assert.ok(requests.includes(`<div class="msg status-line request tone-orange"><span class="mark" aria-hidden="true">${ui.MARK_ICONS['Marked as staged']}</span>Marked as staged <span class="muted">· Dana Reyes · `));
  assert.doesNotMatch(requests, /class="who"|data-event/);
  assert.match(requests, /Marked as staged <span class="muted">· Dana Reyes · [^<]+<\/span><\/div>$/);
});

// docs/adr/2026-11-04-2130-a-button-tap-is-a-status-line-or-a-message-footer.md
test("a request with text, a question's prototype request and an answer are the owner's message with the tap's status in the footer, waiting… to its right until Claude picks it up; a folded submit of answers carries one footer", () => {
  const msg = (extra) => ({ ts: ago(1), who: 'love', via: 'site', kind: 'prototype-request', text: 'Phone width first', eventId: 'p1', state: 'waiting', files: [], status: 'Prototype requested', ...extra });
  // The footer after its time, each · as |.
  const foot = (html) => /<div class="reply muted small msg-foot"><span>[^<]+<\/span>(.*?)<\/div>/s.exec(html)?.[1].replaceAll('<span>·</span>', '|');
  const status = (words) => `<span class="foot-status"><span class="mark" aria-hidden="true">${ui.MARK_ICONS[words]}</span>${words}</span>`;
  const waiting = '|<span>waiting…</span>';
  assert.equal(foot(ui.threadMessages([msg()])), `|${status('Prototype requested')}${waiting}`);
  assert.match(ui.threadMessages([msg()]), /<div class="body">Phone width first<\/div>/);
  assert.equal(foot(ui.threadMessages([msg({ state: 'answered' })])), `|${status('Prototype requested')}`);
  assert.match(foot(ui.threadMessages([msg({ state: 'working' })])), /^\|<span class="foot-status">.*Prototype requested<\/span>\|<span class="thinking">/);
  assert.equal(foot(ui.threadMessages([msg({ kind: 'grill-more', status: 'Grill requested' })])), `|${status('Grill requested')}${waiting}`);
  const answer = (id, ts) => ({ ts, who: 'love', via: 'questions', kind: 'owner-answer', text: `${id}?\n→ A`, eventId: id, state: 'waiting', files: [], status: 'answers submitted' });
  const submit = { ...answer('a1', ago(1)), text: 'a1?\n→ A\n\na2?\n→ B', answers: [{ eventId: 'a1', state: 'waiting', text: 'a1?\n→ A' }, { eventId: 'a2', state: 'waiting', text: 'a2?\n→ B' }] };
  const folded = ui.threadMessages([submit]);
  assert.equal(folded.match(/class="msg love"/g).length, 1);
  assert.equal(folded.match(/answers submitted/g).length, 1);
  assert.match(folded, /a1\?\n→ A\n\na2\?\n→ B/);
  assert.equal(foot(folded), `|${status('answers submitted')}${waiting}`);
  // Answers that were submitted apart each draw their own footer.
  assert.equal(ui.threadMessages([answer('a1', ago(2)), answer('a2', ago(1))]).match(/answers submitted/g).length, 2);
  // A member's reply draws under the message, quoting its own answer.
  const replied = ui.threadMessages([{ ...submit, answers: [submit.answers[0], { ...submit.answers[1], state: 'replied', reply: { html: 'Done B', at: ago(0) } }] }]);
  assert.match(replied, /<blockquote class="quote">a2\?\n→ B<\/blockquote>/);
  assert.doesNotMatch(replied, /<blockquote class="quote">a1/);
  // An owner message with no tap behind it keeps its plain footer.
  assert.equal(foot(ui.threadMessages([msg({ kind: 'item-message', status: undefined })])), waiting);
});

// docs/adr/2026-11-13-0130-a-questions-added-line-is-stored-and-stays-in-the-thread.md
test("a Questions added line keeps its words, orange while its batch has an open question and gray (not blue) once none has, with a plain question mark, linking to its first and opening the questions sheet from it", () => {
  const added = (open) => ({ ts: '2026-11-04T12:00:00Z', who: 'claude', kind: 'hub', line: 'questions-added', mark: 'questions', fault: false, ...(open ? { tone: 'orange' } : {}), text: '2 questions added', link: 'questions.html#q1', questions: ['q1', 'q2'], open });
  const lead = `<span class="mark" aria-hidden="true">${ui.MARK_ICONS.questions}</span><button type="button" class="link-text" data-questions="q1">2 questions added</button>`;
  assert.match(ui.threadMessages([added(true)]), new RegExp(`^<div class="msg status-line request hub tone-orange">${lead}`));
  assert.match(ui.threadMessages([added(false)]), new RegExp(`^<div class="msg status-line request hub">${lead}`));
  assert.ok(!('newQuestionsLine' in ui));
  assert.match(ui.MARK_ICONS.questions, /class="it-i it-question"/);
  assert.doesNotMatch(ui.MARK_ICONS.questions, /<circle/);
});

// docs/adr/2026-11-07-0700-one-agents-status-lines-fold-into-one-line.md
test("one agent run folds into one closed line with a caret holding its started line, status lines and finished line; running shows its newest status, finished says so, each with its newest line's time, neither counts lines; an orchestrator or owner message never folds", () => {
  const ln = (n, extra = {}) => ({ ts: ago(10 - n), who: 'claude', kind: 'status', text: `Step ${n}`, ...extra });
  const run = (name, running, planner) => ({ agent: `Claude ${name}`, run: name, ...(planner ? { planner: true } : {}), running });
  const agentLine = (n, finished, r) => ({ ts: ago(10 - n), who: 'claude', kind: 'agent', text: `${r.agent} ${finished ? 'finished' : 'started'}`, finished, ...r });
  const live = run('main', true);
  const html = ui.threadMessages([ln(0), agentLine(1, false, live), ln(2, live), { ts: ago(7.5), who: 'claude', text: 'Between' }, ln(3, live), { ts: ago(6), who: 'love', text: 'Owner says' }]);
  assert.equal(html.match(/<details/g).length, 1);
  assert.match(html, /<details class="msg status-line calls status-fold"><summary><span class="mark" aria-hidden="true"><span class="it it-current"><span class="it-i it-chevron" aria-hidden="true"><svg/);
  assert.match(text(html), /^Step 0 · \S.* Claude main · running · \S.* Claude main started/);
  assert.match(text(html), /Claude main started · \S.* Step 2 · \S.* Step 3 · \S.* Between .*Owner says/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.equal(html.match(/it-pulse/g).length, 1, 'only the line outside the run draws a dot, none inside the fold');
  assert.match(ui.threadMessages([ln(0)]), /it-pulse/, 'a lone status line keeps its dot');
  const p = run('grill', false, true);
  const done = ui.threadMessages([agentLine(1, false, p), ln(2, p), ln(3, p), agentLine(4, true, p)]);
  assert.match(done, /<details class="msg status-line calls status-fold planner"><summary class="finished">/);
  assert.doesNotMatch(html, /finished/);
  assert.match(html, /<details class="msg status-line calls status-fold"><summary>/);
  assert.ok(text(done).startsWith(`Claude grill · finished · ${ui.time(ago(6))} `));
  assert.ok(text(ui.threadMessages([agentLine(1, false, live)])).startsWith(`Claude main · running · ${ui.time(ago(9))} `));
  assert.ok(text(ui.threadMessages([agentLine(1, false, p), agentLine(2, true, p)])).startsWith(`Claude grill · finished · ${ui.time(ago(8))} `));
});

test("a builder's judgment calls show collapsed under its lines, with their posted time, saying whether the session verified them, and count as no message", () => {
  const open = { ts: ago(1), who: 'claude', kind: 'calls', text: 'Claude Opus builder', calls: ['Kept <the> old name', 'Question: every agent?'], verified: null };
  const html = ui.threadMessages([open]);
  assert.match(html, /^<details class="msg status-line calls"><summary><span class="mark" aria-hidden="true">/);
  assert.ok(html.includes(ui.MARK_ICONS['judgment calls']));
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.match(text(html), /^Claude Opus builder's judgment calls · 2 · \S.* · not verified yet Kept <the> old name Question: every agent\?$/);
  assert.match(text(ui.threadMessages([{ ...open, state: 'waiting' }])), /· 2 · \S.* · waiting… Kept/);
  const picked = ui.threadMessages([{ ...open, state: 'working', since: new Date(NOW - 3 * 60000).toISOString() }]);
  assert.match(picked, /<span class="thinking" data-since="[^"]+" data-word="thinking…"><span class="it it-current">/);
  assert.match(text(picked), /· thinking… \(3m\) Kept/);
  assert.doesNotMatch(text(picked), /not verified yet|verifying/);
  const checked = text(ui.threadMessages([{ ...open, verified: { at: ago(0.5), note: 'Match the notes.' } }]));
  assert.match(checked, /· 2 · \S.* · verified .+ Kept <the> old name Question: every agent\? Verified: Match the notes\.$/);
  const msgs = [{ ts: ago(3), who: 'claude', text: 'One' }, { ts: ago(2), who: 'claude', text: 'Two' }, { ts: ago(1.5), who: 'claude', text: 'Three' }, open];
  assert.doesNotMatch(ui.threadMessages(msgs, {},{ seenAt: ago(9), more: 0 }), /thread-more/);
});

// docs/adr/2026-11-16-0830-a-builder-hands-back-with-a-summary-message.md
test("a builder's summary and its asks read Builder in a grey message, the orchestrator's Orchestrator, and a teammate's Slack reply and any other voice share the grey", () => {
  const summary = ui.threadMessages([{ ts: ago(1), who: 'builder', kind: 'builder-summary', text: 'Added the footer.' }]);
  assert.match(summary, /^<div class="msg builder">\s*<div class="who">Builder<\/div>/);
  assert.ok(text(summary).includes('Added the footer.'));
  const ask = ui.threadMessages([{ ts: ago(1), who: 'Claude Opus builder', kind: 'builder-ask', ask: 'ask1', text: 'Stay orange?' }]);
  assert.match(ask, /^<div class="msg builder">\s*<div class="who">Builder<\/div>/);
  assert.match(ui.threadMessages([{ ts: ago(1), who: 'claude', text: 'Hi' }]), /^<div class="msg claude">\s*<div class="who">Orchestrator<\/div>/);
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.msg\.slack, \.msg\.builder, \.msg\.reviewer, \.msg\.other \{ background: var\(--chip\); \}/);
});

test("an open card's thread shows its newest 3 messages with the lines between them, from its oldest unread one when more are unread, and Show more saying how many messages it hides", () => {
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

  const newest = ui.threadMessages(msgs, {},read);
  assert.deepEqual(shown(newest), ['Four', 'Opened #1', 'Five', 'Opus builder finished', 'Six', 'CI green']);
  assert.equal(more(newest), 'Show more · 4 previous messages');
  const once = ui.threadMessages(msgs, {},{ ...read, more: 1 });
  assert.deepEqual(shown(once), ['Two?', 'Two.', 'Opus builder started', 'Three', 'Four', 'Opened #1', 'Five', 'Opus builder finished', 'Six', 'CI green']);
  const all = ui.threadMessages(msgs, {},{ ...read, more: 2 });
  assert.deepEqual([more(once), more(all), shown(all).length], ['Show more · 1 previous message', null, 12]);

  const unread = ui.threadMessages(msgs, {},{ seenAt: at(2), more: 0 });
  assert.deepEqual(shown(unread), ['Two.', 'Opus builder started', 'Three', 'Four', 'Opened #1', 'Five', 'Opus builder finished', 'Six', 'CI green']);
  assert.match(unread, /<blockquote class="quote">Two\?<\/blockquote>/);
  assert.equal(more(unread), 'Show more · 2 previous messages');

  const slack = ui.threadMessages(msgs, {},{ seenAt: at(4), more: 0 });
  assert.deepEqual(shown(slack), ['Four', 'Opened #1', 'Five', 'Opus builder finished', 'Six', 'CI green']);

  const waiting = ui.threadMessages(msgs.map((m) => (m.eventId ? { ...m, state: 'waiting', reply: null } : m)), {},read);
  assert.deepEqual(shown(waiting), shown(newest));
  assert.equal(more(waiting), 'Show more · 3 previous messages');
});

test("a message leaving the thread keeps the window's top edge, so no older message comes out from behind Show more", () => {
  const at = (n) => `2020-01-01T10:${String(n).padStart(2, '0')}:00.000Z`;
  const msgs = ['One', 'Two', 'Three', 'Four', 'Five', 'Six'].map((text, i) => ({ ts: at(i), who: 'claude', text }));
  msgs[5] = { ts: at(5), who: 'love', kind: 'item-message', text: 'Six', eventId: 'e6', state: 'waiting', reply: null };
  const words = (html) => [...html.matchAll(/>(One|Two|Three|Four|Five|Six)</g)].map((m) => m[1]);
  const more = (html) => html.match(/· (\d+) previous/)?.[1] ?? null;
  const read = { seenAt: at(59), more: 0, upto: at(5) };
  const first = ui.threadMessages(msgs, {},read);
  assert.deepEqual([words(first), more(first)], [['Four', 'Five', 'Six'], '3']);
  const from = ui.threadFrom(msgs, read);
  assert.equal(from, at(3));
  const after = ui.threadMessages(msgs.slice(0, 5), {},{ ...read, from });
  assert.deepEqual([words(after), more(after)], [['Four', 'Five'], '3']);
  const tapped = ui.threadMessages(msgs.slice(0, 5), {},{ ...read, from, more: 1 });
  assert.deepEqual([words(tapped), more(tapped)], [['One', 'Two', 'Three', 'Four', 'Five'], null]);
});

test("only Claude's and GitHub's messages are unread: the owner's answers after an unread reply fold under Show more past 10 lines, and each answer submitted apart waits on Claude under itself", () => {
  const at = (n) => `2020-01-01T10:${String(n).padStart(2, '0')}:00.000Z`;
  const answer = (n) => ({ ts: at(n), who: 'love', via: 'questions', kind: 'owner-answer', text: `Q${n}?\n→ A${n}`, eventId: `o${n}`, reply: null, state: 'waiting' });
  const grill = { ts: at(0), who: 'love', via: 'site', kind: 'grill-more', text: 'Grill', eventId: 'g1', state: 'replied', reply: { html: 'Questions up.', at: at(1) } };
  const answers = Array.from({ length: 12 }, (_, i) => answer(10 + i));
  const bodies = (html) => [...html.matchAll(/<div class="body">([^<]*)/g)].map((m) => m[1].replace(/\n.*/, ''));
  const waits = (html) => html.split(/(?=<div class="msg )/).filter((h) => h.includes('waiting…')).map((h) => /Q\d+/.exec(h)[0]);

  const read = ui.threadMessages([grill, ...answers], {},{ seenAt: at(59), more: 0 });
  assert.deepEqual(bodies(read), ['Q19?', 'Q20?', 'Q21?']);
  assert.deepEqual(waits(read), ['Q19', 'Q20', 'Q21']);
  const unread = ui.threadMessages([grill, ...answers], {},{ seenAt: at(0), more: 0 });
  assert.deepEqual(bodies(unread), answers.slice(2).map((a) => a.text.replace(/\n.*/, '')));
  assert.deepEqual(waits(unread), answers.slice(2).map((a) => /Q\d+/.exec(a.text)[0]));
  const all = ui.threadMessages([grill, ...answers], {},null);
  assert.deepEqual(waits(all), answers.map((a) => /Q\d+/.exec(a.text)[0]));

  const split = ui.threadMessages([answer(10), answer(11), { ts: at(12), who: 'claude', text: 'On it' }, answer(13), { ts: at(14), who: 'claude', kind: 'status', text: 'Testing' }, answer(15)], {},null);
  assert.deepEqual(waits(split), ['Q10', 'Q11', 'Q13', 'Q15']);
  const acted = ui.threadMessages([answer(10), { ...answer(11), state: 'answered' }], {},null);
  assert.deepEqual(waits(acted), ['Q10']);
});

test("a run's fold ends its summary at its status (running or finished) and its newest line's time; its log is a link inside the open section, and a run with no log has none", () => {
  const started = (extra = {}) => ({ ts: ago(3), who: 'claude', kind: 'agent', run: 'r1', agent: 'Claude Opus grill', text: 'Claude Opus grill started', finished: false, planner: true, ...extra });
  const status = { ts: ago(2), who: 'claude', kind: 'status', run: 'r1', agent: 'Claude Opus grill', planner: true, text: 'Reading' };
  const done = { ts: ago(1), who: 'claude', kind: 'agent', run: 'r1', agent: 'Claude Opus grill', text: 'Claude Opus grill finished', finished: true, planner: true };
  const running = ui.threadMessages([started({ log: 'planner-A1-2026.log' }), status]);
  assert.match(running, /Claude Opus grill · running <span class="muted">· [^<]+<\/span><\/summary>.*<a href="log\.html\?file=planner-A1-2026\.log">View transcript<\/a><\/div><\/details>$/);
  assert.match(ui.threadMessages([started({ log: 'planner-A1-2026.log' }), status, done]), /grill · finished <span class="muted">· [^<]+<\/span><\/summary>/);
  assert.doesNotMatch(ui.threadMessages([started(), status]), /View transcript/);
});

test("an ask's link line opens the work it became, and a thread line opens a linked card on the board", () => {
  const became = ui.linkContext([{ key: 'site/S21', id: 'S21', ref: 'INT-21', file: 'site', lane: 'progress' }], 'ask:e0');
  assert.match(ui.threadMessages([{ ts: ago(1), who: 'claude', kind: 'ask-link', words: 'Became', text: 'Became INT-21', card: 'site/S21', link: '#selectedCard=site%2FS21' }], became), /Became <a href="#selectedCard=site%2FS21">INT-21<span class="status link-lane progress"><\/span><\/a>/);
  const html = ui.threadMessages([{ ts: ago(1), who: 'claude', text: 'Asked to keep it', link: '#selectedCard=ask:e1' }]);
  assert.match(html, /<a href="#selectedCard=ask:e1">Open the task →<\/a>/);
  assert.doesNotMatch(html, /target="_blank"/);
  const moved = ui.threadMessages([{ ts: ago(1), who: 'claude', text: 'Moved to Audit.', link: '/audit/#selectedCard=ask%3Ab1' }]);
  assert.match(moved, /<a href="\/audit\/#selectedCard=ask%3Ab1">Open the task →<\/a>/);
  // A handed ask's source is its thread's Handed from line (blue, as created), so its message carries only the note.
  const arrived = ui.threadMessages([
    { ts: ago(2), who: 'claude', kind: 'hub', line: 'handed-from', mark: 'ask-link', tone: 'blue', text: 'Handed from /orch · A1', link: '/orch/#selectedCard=w%2FA1' },
    { ts: ago(1), who: 'love', via: 'ask', kind: 'ask', text: 'Fix the header', note: 'Yours now', from: { words: '/orch · A1', link: '/orch/#selectedCard=w%2FA1' }, eventId: 'b1', reply: null, state: 'waiting' },
  ]);
  assert.match(arrived, /class="msg status-line request hub tone-blue"><span[^]*<a href="\/orch\/#selectedCard=w%2FA1">Handed from \/orch · A1<\/a>/);
  assert.match(arrived, /<blockquote class="quote">Yours now<\/blockquote>/);
  assert.doesNotMatch(text(arrived), /Moved from/);
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

test("a markdown link to a page on this hub, a visual, a prototype round, a log or notes, opens in place for the shell's sheet, and another origin's in a new tab", () => {
  const html = ui.markdown('[v](visuals/A1/flow.html) [p](prototype-x.html?q=q1) [l](log.html?file=a.log) [n](notes.html?item=w%2FA1) [abs](/shop/visuals/A1/flow.html) [ext](https://x.test/a)');
  assert.deepEqual(anchors(html).map((a) => [a[0], a[2]]), [
    ['visuals/A1/flow.html', false], ['prototype-x.html?q=q1', false], ['log.html?file=a.log', false],
    ['notes.html?item=w%2FA1', false], ['/shop/visuals/A1/flow.html', false], ['https://x.test/a', true],
  ]);
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
  { key: 'ask:e9', kind: 'ask', ref: 'Ask', internal: false, linear: [], repo: null },
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

test("a bare #n opens the card it is the ticket of from any thread, else links only in a thread whose item has a repo, and an item file's short id links only from that file's cards", () => {
  const line = [{ ts: ago(1), who: 'claude', text: 'A1 and A2 wait on #2988' }];
  assert.deepEqual(anchors(ui.threadMessages(line, ui.linkContext(boardItems, 'elig/A1'))), [
    ['#selectedCard=elig%2FA1', 'A1', false], ['https://github.com/o/r/pull/2988', '#2988', true],
  ]);
  assert.deepEqual(anchors(ui.threadMessages(line, ui.linkContext(boardItems, 'site/S54'))), []);
  assert.deepEqual(anchors(ui.threadMessages(line, ui.linkContext(boardItems, 'ask:e9'))), []);
  const hub = [...boardItems, { key: 'hub/INT-269', file: 'hub', kind: 'work', id: 'INT-269', ref: '#27', internal: true, linear: [], repo: null }];
  const ticketed = [{ ts: ago(1), who: 'claude', text: '#27 was INT-269; #2988 is a PR' }];
  for (const key of ['ask:e9', 'elig/A1']) {
    assert.deepEqual(anchors(ui.threadMessages(ticketed, ui.linkContext(hub, key))).slice(0, 2), [['#selectedCard=hub%2FINT-269', '#27', false], ['#selectedCard=hub%2FINT-269', '#27', false]]);
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

test('the rules editor sends the whole list with the ids it loaded, tags Claude\'s rules, and takes colours only from colors.css', () => {
  const ctx = vm.createContext({ Date: PageDate });
  vm.runInContext(fs.readFileSync(new URL('./public/rules-editor.js', import.meta.url), 'utf8'), ctx);
  const ed = ctx.RulesEditor;
  const list = ed.rows([{ id: 'r1', text: 'Ask first', by: 'claude', at: 'x' }, { id: 'r2', text: 'Screenshots <b>', by: 'owner', at: 'x' }]);
  assert.match(ed.render(list), /Added by Claude/);
  assert.equal(text(ed.render(list)).match(/Added by Claude/g).length, 1);
  assert.match(ed.render(list), /Screenshots &lt;b&gt;/);
  assert.doesNotMatch(ed.render(list, { readOnly: true }), /<button/);
  assert.match(ed.render([], { empty: 'None.' }), /None\./);
  const html = ed.render(list, { buttons: { quiet: 'btn quiet', icon: 'ghost' } });
  assert.match(html, /class="ghost" data-act="remove"/);
  assert.doesNotMatch(html, /data-act="(undo|done|cancel|save)"/);
  assert.match(ed.render(list, { editing: 'r1' }), /<textarea class="rule-input"[^>]*>Ask first<\/textarea>/);
  assert.match(ed.render(list, { editing: 'r1', text: 'Ask before main' }), /<textarea class="rule-input"[^>]*>Ask before main<\/textarea>/);
  assert.doesNotMatch(ed.render(list, { editing: 'r1' }), /<button[^>]*data-act="(done|cancel)"/);
  list[0].text = 'Ask before main';
  list.push({ key: undefined, id: null, text: 'New', by: 'owner' });
  assert.deepEqual(plain(ed.payload(list)), { rules: [{ id: 'r1', text: 'Ask before main' }, { id: 'r2', text: 'Screenshots <b>' }, { text: 'New' }], base: ['r1', 'r2'] });

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
  assert.match(list, /<span class="it it-green"><span class="it-i it-dot" role="img" aria-label="Working">[^]*<span class="it it-red"><span class="it-i it-dot" role="img" aria-label="Not working">/);
  assert.match(ui.linksList(null), /doesn't list this board/);
  const settling = [links[0], { ...links[1], state: 'settling' }];
  assert.doesNotMatch(ui.githubLine(checks, { links: settling }), /links-dot/);
  assert.match(ui.linksList(settling), /<span class="it it-grey"><span class="it-i it-dot" role="img" aria-label="Settling">[^]*Settling: No watcher/);
  assert.match(ui.githubLine(checks, { links: [links[0], { ...links[1], state: 'broken' }] }), /links-dot/);
  assert.equal(ui.setupCard(null), '');
  const setup = ui.setupCard({ events: false, github: true });
  assert.equal(text(setup), 'Connecting this board Waiting for Claude to answer the ping GitHub checks reach this board');
  assert.match(setup, /it-orange"><span class="it-i it-dot" aria-hidden="true"><\/span><span class="it-w">Waiting for Claude[^]*it-green"[^]*GitHub checks reach/);
  assert.equal(text(ui.setupCard({ events: false })), 'Connecting this board Waiting for Claude to answer the ping');
  const remote = ui.remoteLine({ host: 'gitlab.com', name: 'gitlab.com/acme/firmware' }, { links });
  assert.match(remote, /data-hub-links[^>]*aria-label="Hub links: 1 not working"/);
  assert.doesNotMatch(remote, /GitHub|data-check-github/);
  assert.equal(text(remote), 'gitlab.com/acme/firmware');
});

test('usage stays within the Hub link and its card shows both windows, reset, stale and missing readings', () => {
  const at = new Date(NOW).toISOString();
  const resets_at = new Date(NOW + 3600_000).toISOString();
  const live = (used_percentage) => ({ used_percentage, resets_at, state: 'live', tone: toneOf('live', used_percentage) });
  const usage = { claude: { at, five_hour: live(80), seven_day: live(90) }, codex: { at, five_hour: live(42), seven_day: null } };
  const html = ui.sidebar({ usage }, { here: '_hub/' });
  const hub = /<a class="sb-row on sb-hub-usage"[^>]*>([^]*?)<\/a>/.exec(html)[1];
  assert.equal((hub.match(/class="u-bar"/g) || []).length, 2);
  assert.match(text(hub), /Hub Claude 80% · resets .* Codex 42% · resets/);
  assert.doesNotMatch(hub, /<a|<button|popover|dialog/);
  const card = context.HubUI.usageCard(usage);
  assert.match(text(card), /^Usage Claude read .*5-hour 80% · resets .*Week 90% · resets .*Codex read .*No reading/);
  assert.match(card, /u-tone-high/);
  assert.match(card, /u-tone-full/);
  assert.doesNotMatch(card, /Raw readings|<button|<details/);
  usage.claude.five_hour = { ...live(0), state: 'reset' };
  assert.match(text(ui.sidebar({ usage })), /Claude · reset /);
  assert.match(text(context.HubUI.usageCard(usage)), /5-hour Reset /);
  usage.claude.five_hour = { ...live(95), state: 'stale', tone: toneOf('stale', 95) };
  const stale = ui.sidebar({ usage });
  assert.match(text(stale), /Claude · last seen/);
  assert.match(stale, /u-tone-stale/);
  assert.doesNotMatch(stale, /95%/);
  assert.match(text(context.HubUI.usageCard(usage)), /95% at/);
  usage.claude = null;
  assert.doesNotMatch(ui.sidebar({ usage }), /u-name">Claude/);
  assert.doesNotMatch(context.HubUI.usageCard(usage), /title">Claude/);
  assert.equal(context.HubUI.usageCard({ claude: null, codex: null }), '');
  assert.equal(ui.usageTone(live(80)), 'high');
  assert.equal(ui.usageTone(null), 'none');
});

test('the sidebar shows Claude’s week as a second bar once it is within the near band of the pause line', () => {
  const resets_at = new Date(NOW + 3600_000).toISOString();
  const live = (used_percentage) => ({ used_percentage, resets_at, state: 'live', tone: toneOf('live', used_percentage) });
  const hub = (week, pauseAt, state = 'live') => {
    const claude = { at: resets_at, five_hour: live(34), seven_day: { ...live(week), state } };
    return /<a class="sb-row on sb-hub-usage"[^>]*>([^]*?)<\/a>/.exec(ui.sidebar({ usage: { claude, codex: null }, pause: usageGate({ claude, pauseAt, now: NOW }) }, { here: '_hub/' }))[1];
  };
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

// docs/adr/2026-11-19-0602-one-hub-wide-build-cap-boards-take-turns.md
// docs/adr/2026-11-19-0800-every-hub-limit-takes-the-same-turns.md
test('Capacity, its own section, draws Maximum tasks in progress, Maximum parallel serves then Maximum parallel land tests, steppers posting one fewer or one more, from 1 to 99', () => {
  const card = (tasksInProgress, landTests, serves = 10) => context.HubUI.capacityCard({ tasksInProgress, serves, landTests });
  const both = card(4, 3, 6);
  assert.match(text(both), /^Capacity Maximum tasks in progress − 4 \+ Hub-wide\. Each counts from its build starting until it lands\. Boards take turns, one card each\. Maximum parallel serves − 6 \+ Hub-wide\. Each open task worktree keeps one serve up\. Installs aren’t counted\. A busy host asks before it starts another\. Boards take turns, one card each\. Maximum parallel land tests − 3 \+ Hub-wide\. Lands run the tests their change affects\. Boards take turns, one card each\.$/);
  assert.match(both, /action="\/_hub\/settings\/serves"[^]*value="5" aria-label="One fewer">[^]*value="7" aria-label="One more">/);
  assert.match(both, /<section class="capacity"><h2 class="label">Capacity<\/h2><div class="group"><div class="block">/);
  assert.match(both, /form class="segments ub-step" method="post" action="\/_hub\/settings\/tasks-in-progress" role="group" aria-label="Maximum tasks in progress"><button name="value" value="3" aria-label="One fewer">/);
  assert.match(both, /action="\/_hub\/settings\/land-tests"[^]*value="2" aria-label="One fewer">[^]*value="4" aria-label="One more">/);
  assert.match(card(1, 1), /value="0" aria-label="One fewer" disabled/);
  assert.match(card(99, 1), /value="100" aria-label="One more" disabled/);
  const usage = context.HubUI.usageCard({ claude: { at: new Date(NOW).toISOString(), five_hour: null, seven_day: null } }, null, null, { model: 'auto', builder: 'Claude', builders: buildersView('auto'), orchestrators: orchestratorsView('opus') });
  assert.doesNotMatch(usage, /land-tests|tasks-in-progress/, 'Usage keeps no capacity row');
});

test('the pause line stepper, both tools’ ticks, banners and status slots follow the gate', () => {
  const resets_at = new Date(NOW + 3600_000).toISOString();
  const until = ui.usageClock(resets_at);
  const reading = { at: new Date(NOW).toISOString(), five_hour: { used_percentage: 91, resets_at, state: 'live' }, seven_day: null };
  const live = (used_percentage) => ({ used_percentage, resets_at, state: 'live' });
  const gateOf = (five, keepGoing, week = null) => usageGate({ claude: { five_hour: live(five), seven_day: week && live(week) }, keepGoing, now: NOW });
  const pause = gateOf(91);
  const hub = context.HubUI;
  const card = hub.usageCard({ claude: reading, codex: reading }, null, pause);
  assert.match(text(card), /Codex .*Pause work at 10% buffer − 90% \+/);
  assert.match(text(card), /Claude’s new work waits.*Codex hands its work to Claude implementers/);
  for (const builder of ['Opus', 'Sonnet']) assert.match(text(hub.usageCard({ claude: reading }, null, pause, { model: builder.toLowerCase(), builder, builders: buildersView(builder.toLowerCase()), orchestrators: orchestratorsView('opus') })), new RegExp(`Codex hands its work to ${builder} implementers`));
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
  const weekly = hub.pauseBanner(gateOf(10, undefined, 91));
  assert.match(text(weekly), /weekly usage is at 91%. Resumes /);
  assert.doesNotMatch(text(weekly), /Resumes at/);
  const keep = { window: 'five_hour', until: resets_at };
  const going = hub.pauseBanner(gateOf(91, keep));
  assert.match(going, /hold-banner ub-banner ub-going/);
  assert.match(text(going), /Past the buffer: spending usage until .* Stop/);
  assert.match(going, /<button class="btn quiet" name="value" value="off">Stop/);
  assert.equal(hub.pauseBanner({ state: 'normal' }), '');
  // docs/adr/2026-11-06-1249-the-pause-line-reads-every-headless-agents-usage.md
  const near = gateOf(84);
  const slowing = hub.pauseBanner(near);
  assert.match(slowing, /hold-banner ub-banner ub-paused/);
  assert.equal(text(slowing), 'Approaching usage limit, reducing parallel tasks in progress Keep going');
  assert.match(slowing, /action="\/_hub\/settings\/keep-going"><button class="btn quiet" name="value" value="on">/);
  const together = hub.pauseBanner(gateOf(84, { ...keep, near: true }));
  assert.match(together, /hold-banner ub-banner ub-going/);
  assert.match(text(together), /^Approaching usage limit: tasks in progress back to the full cap until .* Stop$/);
  assert.match(together, /name="value" value="off"/);
  assert.equal(hub.pauseBanner(gateOf(50)), '');
  const chips = [{ lane: 'todo', text: '3 todo' }];
  // The hub sends a held board's row already grey paused (hub/home.mjs heldSite).
  const sites = [{ route: 'a', title: 'A', board: true, icon: '', sub: { status: { shape: 'dot', colour: 'grey', word: 'paused' }, stale: false, chips } }];
  const sidebar = ui.sidebar({ pause, sites, hub: { tone: 'ok', word: 'healthy', detail: 'up' } });
  assert.equal([...sidebar.matchAll(PAUSED)].length, 2);
  assert.ok(text(sidebar).includes(`until ${until}`));
  assert.match(text(sidebar), /paused 3 todo/);
  assert.doesNotMatch(sidebar, />working</);
  // A stale row under a pause: the chips first, then paused and (stale) beside it, all in one grey line.
  const stale = ui.sidebar({ pause, sites: [{ ...sites[0], sub: { ...sites[0].sub, stale: true } }], hub: { tone: 'ok', word: 'healthy', detail: 'up' } });
  assert.match(stale, /<span class="sb-status stale"><span class="it it-grey"><span class="it-i it-dot" aria-hidden="true"><\/span><span class="it-w">paused<\/span><\/span><span class="stale-word">\(stale\)<\/span><span class="lcs"><span class="lc lc-todo">3 todo<\/span><\/span><\/span>/);
  // Red beats grey and orange: a fault on a board row or the Hub row stays while a pause or busy host lasts.
  const faulty = [{ route: 'a', title: 'A', board: true, icon: '', sub: { status: { shape: 'dot', colour: 'red', word: 'not listening' }, stale: false, chips } }];
  const down = ui.sidebar({ pause, sites: faulty, hub: { tone: 'down', word: '1 site down', detail: '0 of 1 site up' } });
  assert.equal([...down.matchAll(PAUSED)].length, 0);
  assert.match(down, /it-red"><span class="it-i it-dot" aria-hidden="true"><\/span><span class="it-w">not listening</);
  assert.match(down, /it-red"><span class="it-i it-dot" aria-hidden="true"><\/span><span class="it-w">1 site down/);
  const staleDown = ui.sidebar({ pause, sites: [{ ...faulty[0], sub: { ...faulty[0].sub, stale: true } }], hub: { tone: 'ok', word: 'healthy', detail: 'up' } });
  assert.match(staleDown, /it-grey"><span class="it-i it-dot" aria-hidden="true"><\/span><span class="it-w">not listening<\/span><\/span><span class="stale-word">/, 'a stale fault keeps its word, grey');
  const busyDown = ui.sidebar({ pause: { state: 'normal', machine: { state: 'busy', busy: true, banner: false, since: new Date(NOW - 5 * 60_000).toISOString() } }, sites: [], hub: { tone: 'down', word: '1 site down', detail: 'x' } });
  assert.match(busyDown, /it-red"><span class="it-i it-dot" aria-hidden="true"><\/span><span class="it-w">1 site down/);
  assert.doesNotMatch(busyDown, />busy</);
  const degradedPaused = ui.sidebar({ pause, sites: [], hub: { tone: 'wait', word: 'degraded', detail: 'x' } });
  assert.match(degradedPaused, /it-orange"><span class="it-i it-dot" aria-hidden="true"><\/span><span class="it-w">degraded/);
  assert.doesNotMatch(degradedPaused, PAUSED);
  assert.match(ui.statusLine(ago(0), { pause }), new RegExp(`^<span class="fresh" title="Paused until ${until}\\. Updated [^"]*">now</span>$`));
  assert.doesNotMatch(ui.statusLine(null, { pause: gateOf(91, keep) }), /paused/i);
});

// docs/adr/2026-11-05-1849-pause-board-and-pause-hub-pause-new-work-by-hand.md
test('Pause hub reads paused on the Hub row and every board with Resume on its banner; Pause board on its own row alone', () => {
  const resets_at = new Date(NOW + 3600_000).toISOString();
  const until = ui.usageClock(resets_at);
  const manual = (scope) => usageGate({ hubPause: scope === 'hub' ? resets_at : null, boardPause: scope === 'board' ? resets_at : null, now: NOW });
  const working = { status: { shape: 'pulse', colour: 'orange', word: 'working' }, stale: false, chips: null };
  const banner = context.HubUI.pauseBanner(manual('hub'));
  assert.equal(text(banner), `Work paused: you paused the hub. Resumes at ${until}. Resume`);
  assert.match(banner, /hold-banner ub-banner ub-paused/);
  assert.match(banner, /action="\/_hub\/settings\/hub-pause"><button class="btn quiet" name="pause" value="off">Resume/);
  const held = { ...working, status: { shape: 'dot', colour: 'grey', word: 'paused' } };
  const sites = [{ route: 'a', title: 'A', board: true, icon: '', sub: working }, { route: 'b', title: 'B', board: true, icon: '', sub: working }];
  const hubPaused = ui.sidebar({ pause: manual('hub'), sites: sites.map((s) => ({ ...s, sub: held })), hub: { tone: 'ok', word: 'healthy', detail: 'up' } });
  assert.equal([...hubPaused.matchAll(PAUSED)].length, 3);
  const boardPaused = ui.sidebar({ pause: { state: 'normal' }, sites: [{ ...sites[0], pause: manual('board'), sub: held }, sites[1]], hub: { tone: 'ok', word: 'healthy', detail: 'up' } });
  assert.equal([...boardPaused.matchAll(PAUSED)].length, 1, 'only the paused board');
  assert.equal([...boardPaused.matchAll(/>working</g)].length, 1);
  assert.match(text(boardPaused), /healthy/);
  assert.equal(ui.statusLine(null, { pause: manual('board') }), `<span class="fresh" title="Paused until ${until}"></span>`);
});

// docs/adr/2026-11-06-0106-a-busy-mac-holds-new-work.md
test('a busy host reads busy on the Hub row and the logo dot, not on a board or the header, a pause first, and Health has a Machine row', () => {
  const machine = { state: 'busy', busy: true, banner: true, reason: 'memory pressure critical', since: new Date(NOW - 42 * 60_000).toISOString() };
  const working = { status: { shape: 'pulse', colour: 'orange', word: 'working' }, stale: false, chips: [{ lane: 'todo', text: '3 todo' }] };
  const sites = [{ route: 'a', title: 'A', board: true, icon: '', sub: working }, { route: 'p', title: 'P', board: false, icon: '', sub: null }];
  const busy = ui.sidebar({ pause: { state: 'normal', machine }, sites, hub: { tone: 'ok', word: 'healthy', detail: 'up' } });
  assert.equal([...busy.matchAll(/it-orange"><span class="it-i it-dot" aria-hidden="true"><\/span><span class="it-w">busy/g)].length, 1, 'the Hub row alone');
  assert.match(text(busy), /busy \(42m\)/);
  assert.doesNotMatch(text(busy), /the host is busy/);
  const fresh = { state: 'busy', busy: false, banner: false, reason: 'load high', since: new Date(NOW - 59_000).toISOString() };
  assert.doesNotMatch(ui.sidebar({ pause: { state: 'normal', machine: fresh }, sites, hub: { tone: 'ok', word: 'healthy', detail: '' } }), />busy</, 'busy under a minute reads as not busy');
  assert.equal(ui.hubDot({ pause: { state: 'normal', machine: fresh }, hub: { tone: 'ok' } }), '');
  assert.match(ui.sidebar({ pause: { state: 'normal', machine: { state: 'normal' } }, sites: [], hub: { tone: 'ok', word: 'healthy', detail: '' } }), /it-green"><span class="it-i it-dot" aria-hidden="true"><\/span><span class="it-w">healthy<\/span><\/span><\/button><\/span>/, 'healthy reads alone');
  assert.match(text(busy), /working 3 todo/, 'a board keeps its own status');
  assert.match(busy, /<span class="it it-orange"><span class="it-i it-pulse" aria-hidden="true"><\/span><span class="it-w">working/, 'its working dot pulses');
  assert.equal(ui.hubDot({ pause: { state: 'normal', machine }, hub: { tone: 'ok' } }), 'busy');
  assert.equal(ui.hubDot({ pause: { state: 'normal', machine }, hub: { tone: 'down' } }), 'down', 'a broken hub reads red before busy');
  assert.equal(ui.hubDot({ pause: { paused: true, machine: { ...machine, busy: false, banner: false } }, hub: { tone: 'ok' } }), 'paused', 'a pause shows grey, not busy');
  assert.equal(ui.hubDot({ pause: { state: 'normal', machine: { state: 'normal' } }, hub: { tone: 'ok' } }), '');
  const heldSites = [{ ...sites[0], sub: { ...working, status: { shape: 'dot', colour: 'grey', word: 'paused' } } }, sites[1]];
  const both = ui.sidebar({ pause: { paused: true, resets_at: new Date(NOW + 3600_000).toISOString(), machine: { ...machine, busy: false, banner: false } }, sites: heldSites, hub: { tone: 'ok', word: 'healthy', detail: 'up' } });
  assert.doesNotMatch(both, />busy</, 'a pause reads first');
  assert.equal([...both.matchAll(PAUSED)].length, 2);
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
  const forever = (scope) => usageGate({ hubPause: scope === 'hub' ? 'forever' : null, boardPause: scope === 'board' ? 'forever' : null, now: NOW });
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

// docs/adr/2026-11-17-1015-new-code-restarts-by-itself-with-no-restart-row.md
test("the sidebar's update slot holds only Reload: new server or hub code adds no Restart row", () => {
  const data = { sites: [{ route: 'shop', title: 'Shop', board: true, newServer: true }], newHub: true };
  const slot = (html) => /<div class="sb-update" role="status">(.*?)<\/div><div class="sb-group">/s.exec(html)[1];
  assert.equal(slot(ui.sidebar(data, { here: 'shop' })), '');
  assert.equal(slot(ui.sidebar(data, { here: '_hub/' })), '');
  assert.equal(text(slot(ui.sidebar(data, { here: 'shop', update: 'ready' }))), 'New version Reload');
  assert.equal(ui.restartRow, undefined);
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
  assert.equal(reached({ lane: 'progress', builder: { phase: 'building' } }), 2);
  assert.equal(reached({ lane: 'progress', builder: { phase: null } }), 0);
  assert.equal(reached({ lane: 'progress', waitsOn: 'checking' }), 3);
  assert.equal(reached({ lane: 'todo', builder: { phase: 'building' } }), null);
  assert.equal(reached({ lane: 'progress', builder: { planner: true, phase: 'building' } }), null);
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
  const at = new Date(NOW).toISOString();
  const perm = { id: 'p1', cwd: '~/repo', tool: 'Bash', action: 'run npm test', detail: 'npm test', rule: 'Bash(npm test)', questions: null, at };
  const ask = { id: 'p2', cwd: '~/repo', tool: 'AskUserQuestion', at, questions: [{ question: 'Colour?', header: '', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] }] };
  const looks = (html) => [...html.matchAll(/<button[^>]*?(data-prompt-(?:choice|opt|send)(?:="[^"]*")?)[^>]*>/g)].map(([tag, name]) => [name, / disabled aria-busy="true"/.test(tag) ? 'waits' : / disabled/.test(tag) ? 'disabled' : 'on']);
  assert.deepEqual(looks(ui.promptItem(perm, { sending: 'always' })), [['data-prompt-choice="allow"', 'disabled'], ['data-prompt-choice="always"', 'waits'], ['data-prompt-choice="deny"', 'disabled']]);
  assert.deepEqual(looks(ui.promptItem(perm)), [['data-prompt-choice="allow"', 'on'], ['data-prompt-choice="always"', 'on'], ['data-prompt-choice="deny"', 'on']]);
  assert.deepEqual(looks(ui.promptItem(ask, { sending: '0:Blue' })), [['data-prompt-opt="Red"', 'disabled'], ['data-prompt-opt="Blue"', 'waits'], ['data-prompt-choice="deny"', 'disabled']]);
  assert.doesNotMatch(text(ui.promptItem(perm, { sending: 'allow' })), /Sending/);
  assert.equal(text(ui.promptItem(perm, { sending: 'allow' })).includes('Allow once'), true);
  // The hub page lists only prompts of sessions that own no board, so a line names when and where it was asked.
  assert.match(ui.promptItem(perm), /<span class="muted small">just now · ~\/repo<\/span>/);
});

// docs/adr/2026-11-16-1930-a-joined-boards-prompts-show-on-the-board.md
test("a joined board's prompt strip draws one red pause-banner row per prompt, with Allow once, Always and Deny, and an answered row fading", () => {
  const at = new Date(NOW).toISOString();
  const perm = { id: 'p1', cwd: '~/repo', tool: 'Bash', action: 'run npm test', detail: 'npm test <x>', rule: 'Bash(npm test)', questions: null, at };
  const write = { id: 'p2', cwd: '~/repo', tool: 'Write', action: 'write app.html', detail: '', rule: 'Write(//r/app.html)', questions: null, at };
  assert.equal(ui.promptStrip([]), '');
  const strip = ui.promptStrip([perm, write]);
  assert.match(strip, /^<ul class="prompt-strip">/);
  const rows = strip.split('<li ').slice(1).map((row) => `<li ${row}`);
  assert.equal(rows.length, 2, 'one row a prompt');
  assert.match(rows[0], /^<li class="hold-banner ub-banner ub-going prompt-row" data-prompt="p1" role="alert"><svg/);
  assert.equal(text(rows[0]), 'Orchestrator waits on you · Bash: npm test <x> Allow once Always Deny');
  assert.match(rows[0], /<button type="button" class="btn primary" data-prompt-choice="allow">Allow once<\/button><button type="button" class="btn quiet" data-prompt-choice="always">Always<\/button><button type="button" class="btn quiet deny" data-prompt-choice="deny">Deny<\/button>/);
  assert.equal(text(rows[1]), 'Orchestrator waits on you · Write: write app.html Allow once Always Deny', 'no detail reads its action');

  const looks = (html) => [...html.matchAll(/<button[^>]*?data-prompt-choice="(\w+)"[^>]*>/g)].map(([tag, name]) => [name, / disabled aria-busy="true"/.test(tag) ? 'waits' : / disabled/.test(tag) ? 'disabled' : 'on']);
  assert.deepEqual(looks(ui.promptStrip([perm], { state: () => ({ sending: 'allow' }) })), [['allow', 'waits'], ['always', 'disabled'], ['deny', 'disabled']]);
  const answered = ui.promptStrip([perm, write], { answered: (p) => p.id === 'p1' });
  assert.match(answered, /class="hold-banner ub-banner ub-going prompt-row prompt-answered" data-prompt="p1"/, 'an answered row fades out');
  assert.deepEqual(looks(answered.split('<li ')[1]), [['allow', 'disabled'], ['always', 'disabled'], ['deny', 'disabled']]);
  assert.doesNotMatch(answered.split('<li ')[2], /prompt-answered|disabled/);
});

test("This device's Turn on and Test wait in place of their label while they run", () => {
  const row = (action) => context.HubUI.deviceRow({ title: 'This device', sub: 'Off', action });
  assert.match(row({ label: 'Turn on', act: 'on', busy: true }), /data-device="on" disabled aria-busy="true">Turn on</);
  assert.match(row({ label: 'Test', act: 'test', quiet: true }), /data-device="test">Test</);
});

test("a card waiting on its owner step reads the step as its orange Next, with Done as a check icon where the bump sits", () => {
  const step = 'Add the npm trusted publisher';
  const waiting = { ...workCard, lane: 'review', waitsOn: 'owner', next: step, ownerStep: step, awaitsDone: true, bumpable: false };
  assert.deepEqual(lines(workLines(waiting)).slice(0, 2), ['ENG-1 Five', `Next: ${step}`]);
  assert.match(workLines(waiting), /<div class="line3 sub next">Next: /);
  assert.match(workLines(waiting), /<div class="ask-actions"><button type="button" class="ghost icon owner-done" data-confirm="finish" data-key="w\/B5" aria-label="Done" title="Done: Add the npm trusted publisher"><svg/);
  assert.doesNotMatch(workLines({ ...waiting, ownerStep: null }), /owner-done/);
  // docs/adr/2026-11-22-0200-a-card-carries-board-only-tags.md: every card has its "…", beside the check.
  assert.match(workLines(waiting), /<div class="ask-actions"><button type="button" class="ghost icon owner-done"[^]*?<\/button><button type="button" class="ghost icon card-more" data-card-menu="w\/B5"/);
});

// docs/adr/2026-11-17-1100-a-cards-menu-narrows-the-board-to-its-chain.md
test("a card's chain is its links walked both ways, depth first, stopping on a repeat: 1 hop the direct links, all the whole chain", () => {
  const link = (key) => ({ key, ref: key.slice(2) });
  const cards = [
    { key: 'w/P', children: [link('w/A'), link('w/B'), link('w/C')] },
    { key: 'w/A', parent: link('w/P'), related: [link('w/R')] },
    { key: 'w/B', parent: link('w/P'), blocks: [link('w/C')] },
    { key: 'w/C', parent: link('w/P'), blockers: [link('w/B')], children: [link('w/F')] },
    { key: 'w/F', parent: link('w/C') },
    { key: 'w/R', related: [link('w/A'), link('w/GONE')] },
    { key: 'w/U' },
  ];
  const byKey = new Map(cards.map((c) => [c.key, c]));
  const chain = (root, depth) => [...ui.linkedKeys(byKey, root, depth)].sort();
  assert.deepEqual(chain('w/P', 'hop'), ['w/A', 'w/B', 'w/C', 'w/P']);
  assert.deepEqual(chain('w/P', 'all'), ['w/A', 'w/B', 'w/C', 'w/F', 'w/GONE', 'w/P', 'w/R'], 'a link to a card not held is in the chain, not walked');
  assert.deepEqual(chain('w/B', 'hop'), ['w/B', 'w/C', 'w/P'], 'blocks and the parent');
  assert.deepEqual(chain('w/C', 'hop'), ['w/B', 'w/C', 'w/F', 'w/P'], 'blocked by, the parent and a follow-up');
  assert.deepEqual(chain('w/F', 'all'), chain('w/P', 'all'), 'the same chain from any card in it');
  assert.deepEqual(chain('w/U', 'all'), ['w/U']);
  assert.deepEqual([ui.hasLinks(cards[6]), ui.hasLinks(cards[4])], [false, true]);
});

test("a card's menu holds Bump or Unbump when it can be bumped and Tag… on every card, then Linked · 1 hop and Linked · all when it has links", () => {
  const items = (html) => [...html.matchAll(/<button type="button" role="menuitem"([^>]*)>.*?<span>([^<]+)<\/span><\/button>/g)].map((m) => [m[2], m[1].trim()]);
  const related = [{ key: 'w/B6', ref: 'ENG-2' }];
  assert.deepEqual(items(ui.cardMenu({ ...workCard, bumpable: true, related })), [
    ['Bump', 'data-card-bump="w/B5"'], ['Tag…', 'data-card-tag="w/B5"'], ['Linked · 1 hop', 'data-linked="w/B5" data-depth="hop"'], ['Linked · all', 'data-linked="w/B5" data-depth="all"']]);
  assert.match(ui.cardMenu({ ...workCard, bumpable: true, related }), /Tag…<\/span><\/button><div class="sep" role="separator"><\/div><button/);
  assert.deepEqual(items(ui.cardMenu({ ...workCard, bumpable: true, bumpedAt: ago(1) })), [['Unbump', 'data-card-bump="w/B5" data-bumped'], ['Tag…', 'data-card-tag="w/B5"']]);
  assert.deepEqual(items(ui.cardMenu({ ...workCard, bumpable: false, related })).map(([label]) => label), ['Tag…', 'Linked · 1 hop', 'Linked · all']);
  assert.deepEqual(items(ui.cardMenu({ ...workCard, lane: 'done', bumpable: false })).map(([label]) => label), ['Tag…'], 'a Done card with no links has Tag… alone');
  assert.doesNotMatch(ui.cardMenu({ ...workCard, bumpable: false }), /class="sep"/);
});

// docs/adr/2026-11-22-0200-a-card-carries-board-only-tags.md
test("every work card has its \"…\", and its tags read as chips right of its ticket badge, two at most then +N", () => {
  const head = (it) => workLines({ ...workCard, lane: 'todo', bumpable: false, ...it }).split('</div>')[1];
  assert.match(workLines({ ...workCard, lane: 'done', bumpable: false }), /data-card-menu="w\/B5"/);
  assert.doesNotMatch(head({}), /tag-chip/);
  const chips = (html) => [...html.matchAll(/<span class="tag-chip( more)?" title="([^"]*)">([^<]*)<\/span>/g)].map((m) => [m[3], m[2]]);
  assert.deepEqual(chips(head({ tags: ['phone'] })), [['phone', 'phone']]);
  assert.deepEqual(chips(head({ tags: ['phone', 'sidebar', 'perf', 'docs'] })), [['phone', 'phone'], ['sidebar', 'sidebar'], ['+2', 'perf, docs']]);
  // The chips sit after the ticket's badge and before the title.
  assert.match(head({ tags: ['phone'] }), /ENG-1<\/a>.*tag-chip.*Five/s);
  assert.match(head({ tags: ['<b>'] }), /title="&lt;b&gt;">&lt;b&gt;</);
});

test("the open card's Tags row lists every tag whole, each with a × that takes it off, then + Add tag", () => {
  const row = ui.tagRow({ key: 'w/B5', ref: 'B5', tags: ['phone', 'a-very-long-tag-name', '<b>'] });
  const removes = [...row.matchAll(/<span class="tag-chip whole">([^<]*)<button type="button" data-tag-remove="([^"]*)" data-key="w\/B5" aria-label="([^"]*)">×<\/button><\/span>/g)].map((m) => [m[1], m[2], m[3]]);
  assert.deepEqual(removes, [['phone', 'phone', 'Remove the tag phone'], ['a-very-long-tag-name', 'a-very-long-tag-name', 'Remove the tag a-very-long-tag-name'], ['&lt;b&gt;', '&lt;b&gt;', 'Remove the tag &lt;b&gt;']]);
  assert.match(row, /<button type="button" class="tag-add" data-tag-add="w\/B5">\+ Add tag<\/button>$/);
  assert.equal(ui.tagRow({ key: 'w/B5', tags: [] }), '<button type="button" class="tag-add" data-tag-add="w/B5">+ Add tag</button>');
});

test("the Tag… picker lists the board's tags by use, ticked where the card has them, narrowed by the words typed, with a New tag row for a name no tag has", () => {
  const board = [{ kind: 'work', tags: ['phone', 'perf'] }, { kind: 'work', tags: ['phone'] }, { kind: 'work', tags: ['docs', 'Phone'] }, { kind: 'ask' }];
  assert.deepEqual(plain(ui.boardTags(board)), [{ name: 'phone', count: 3 }, { name: 'docs', count: 1 }, { name: 'perf', count: 1 }]);
  const rows = (html) => [...html.matchAll(/<button type="button" role="menuitemcheckbox" aria-checked="(true|false)" data-tag-pick="([^"]+)"/g)].map((m) => [m[2], m[1]]);
  const it = { key: 'w/B5', tags: ['perf'] };
  assert.deepEqual(rows(ui.tagRows(it, ui.boardTags(board), '')), [['phone', 'false'], ['docs', 'false'], ['perf', 'true']]);
  assert.match(ui.tagRows(it, ui.boardTags(board), ''), /3 cards/);
  assert.deepEqual(rows(ui.tagRows(it, ui.boardTags(board), 'PH')), [['phone', 'false']]);
  assert.doesNotMatch(ui.tagRows(it, ui.boardTags(board), 'phone'), /data-tag-new/, 'a typed name a tag has, in any case, is that tag');
  assert.match(ui.tagRows(it, ui.boardTags(board), '  dark   mode '), /<button type="button" role="menuitem" data-tag-new="dark mode">.*New tag “dark mode”/s);
  assert.match(ui.tagRows({ key: 'w/B5', tags: [] }, [], ''), /No tags on this board yet/);
  assert.match(ui.tagRows(it, ui.boardTags(board), 'a,b'), /takes no comma/);
});

test("a Tag… pick in the outbox draws on its card at once, put on or taken off, until the board answers; a failed one leaves the card as the board has it", () => {
  const items = [{ key: 'w/A1', tags: ['phone'] }, { key: 'w/B1' }];
  const tap = (key, tag, on, extra = {}) => ({ kind: 'card-tag', key, fields: { tag, on }, ...extra });
  const drawn = ui.tapped(items, [tap('w/A1', 'perf', true), tap('w/A1', 'PHONE', false), tap('w/B1', 'docs', true), tap('w/B1', 'x', true, { failed: true })]);
  assert.deepEqual(plain(drawn.map((i) => i.tags)), [['perf'], ['docs']]);
  assert.equal(drawn[0].sending, undefined, 'a tag pick disables no button');
});

test("a menu drawn while the board is narrowed to the card's chain marks the matching Linked item on, whose tap ends it", () => {
  const related = [{ key: 'w/B6', ref: 'ENG-2' }];
  const html = ui.cardMenu({ ...workCard, bumpable: false, related }, { key: 'w/B5', depth: 'hop' });
  assert.match(html, /<button type="button" role="menuitemcheckbox" aria-checked="true" data-linked="w\/B5" data-depth="hop" data-on>/);
  assert.match(html, /<button type="button" role="menuitem" data-linked="w\/B5" data-depth="all">/);
  assert.doesNotMatch(ui.cardMenu({ ...workCard, bumpable: false, related }, { key: 'w/B6', depth: 'hop' }), /aria-checked/);
});

test("a card waiting on its owner step reads its code check under the Next, or that the check can't run", () => {
  const step = 'Publish kickflip to npm';
  const waiting = { ...workCard, lane: 'review', waitsOn: 'owner', next: step, ownerStep: step, awaitsDone: true, bumpable: false };
  assert.deepEqual(lines(workLines({ ...waiting, ownerCheck: { words: 'kickflip@0.3.* on npm', broken: null } })).slice(0, 3), ['ENG-1 Five', `Next: ${step}`, 'Checks: kickflip@0.3.* on npm']);
  assert.deepEqual(lines(workLines({ ...waiting, ownerCheck: { words: 'kickflip@0.3.* on npm', broken: 'npm view failed: <E404>' } })).slice(0, 3),
    ['ENG-1 Five', `Next: ${step}`, "Check can't run: npm view failed: <E404>"]);
  assert.match(workLines({ ...waiting, ownerCheck: { words: 'x', broken: '<b>' } }), /<div class="line3 sub refused">Check can&#39;t run: &lt;b&gt;<\/div>/);
  assert.doesNotMatch(workLines(waiting), /Checks:|Check can/);
});

// docs/adr/2026-11-18-0200-a-release-card-waits-in-in-review-until-its-release-is-published.md
test("a release card reads publishing in orange, published in green with Done as a check icon, or its failure in red, each linking the run", () => {
  const url = 'https://github.com/o/r/actions/runs/5';
  const card = (release, more = {}) => workLines({ ...workCard, lane: 'review', waitsOn: null, next: null, bumpable: true, release: { version: '0.19.1', url, failure: null, ...release }, ...more });
  const publishing = card({ state: 'publishing', url: null });
  assert.deepEqual(lines(publishing).slice(0, 2), ['ENG-1 Five', 'publishing v0.19.1']);
  assert.match(publishing, /<div class="line3 sub agent release"><span[^]*?publishing v0\.19\.1<\/div>/);
  assert.match(card({ state: 'publishing' }), new RegExp(`<a href="${url}" target="_blank" rel="noopener">publishing v0\\.19\\.1 `));
  const published = card({ state: 'published' }, { waitsOn: 'owner', next: 'Tap Done', awaitsDone: true, bumpable: false });
  assert.deepEqual(lines(published).slice(0, 3), ['ENG-1 Five', 'Next: Tap Done', 'published 0.19.1']);
  assert.match(published, /<div class="line3 sub release-published"><a href=/);
  assert.match(published, /class="ghost icon owner-done" data-confirm="finish" data-key="w\/B5" aria-label="Done" title="Done: published 0\.19\.1"/);
  const failed = card({ state: 'failed', failure: 'a <test> (a.test.mjs:9)' });
  assert.deepEqual(lines(failed).slice(0, 2), ['ENG-1 Five', 'release v0.19.1 failed: a <test> (a.test.mjs:9)']);
  assert.match(failed, /<div class="line3 sub refused release"><a href=[^>]+>release v0\.19\.1 failed: a &lt;test&gt;/);
  assert.doesNotMatch(failed, /owner-done/);
  assert.doesNotMatch(workLines(workCard), /release/);
});

// docs/adr/2026-11-05-0200-a-tap-spins-until-the-board-shows-its-change.md
test('pending.within resolves with its work, or after 60 seconds runs its late callback and resolves, so a spinner rests either way', async () => {
  const timers = [];
  context.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  context.clearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].fn = null; };
  let late = 0;
  assert.equal(await ui.pending.within(Promise.resolve('done'), () => { late += 1; }), 'done');
  assert.deepEqual([timers.at(-1).ms, timers.at(-1).fn, late], [60000, null, 0], 'the work settled first, so the timer is cancelled');
  const waiting = ui.pending.within(new Promise(() => {}), () => { late += 1; });
  timers.at(-1).fn();
  assert.equal(await waiting, undefined);
  assert.equal(late, 1);
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

test("an owner line with a by is named by it, the owner's own stays You", () => {
  const html = ui.threadMessages([
    { ts: ago(2), who: 'love', via: 'site', kind: 'item-message', text: 'Per key', by: 'Dana <R>', files: [] },
    { ts: ago(1), who: 'love', via: 'site', kind: 'item-message', text: 'Agreed', files: [] },
  ]);
  assert.match(html, /<div class="who">Dana &lt;R&gt;<\/div>/);
  assert.match(html, /<div class="who">You<\/div>/);
});

test('a ↗ written in a question, its context and its options draws as the arrow icon, never the character', () => {
  const q = { ...question, question: 'See Notes ↗ first?', context: 'Open take A↗︎ for more', options: [{ id: 'A', label: 'Notes ↗', detail: 'Open take B ↗' }, { id: 'B', label: 'Drop' }] };
  const html = ui.questionCard(q);
  assert.doesNotMatch(html, /[↗︎]/);
  assert.equal(html.split('class="link-arrow"').length - 1, 4);
});

test("a Todo thread message's footer leads with an icon for Implement, a Reply's has none, and a bare Implement's line with Implement's", () => {
  const html = ui.threadMessages([
    { ts: ago(2), who: 'love', via: 'site', kind: 'item-message', text: 'hello', eventId: 'm1', state: 'waiting', files: [] },
    { ts: ago(1), who: 'love', via: 'site', kind: 'item-message', text: 'go', status: 'Implement', eventId: 'm2', state: 'waiting', files: [] },
    { ts: ago(0.5), who: 'claude', kind: 'command', command: 'staged', request: true, mark: 'Marked as staged', text: 'Marked as staged', tone: 'orange' },
  ]);
  assert.equal(html.split('class="foot-status"').length - 1, 1);
  assert.match(ui.MARK_ICONS.Implement, /^<span class="it it-current"><span class="it-i it-code"/);
  assert.ok(html.includes(`<span class="foot-status"><span class="mark" aria-hidden="true">${ui.MARK_ICONS.Implement}</span>Implement</span>`));
  assert.equal(ui.MARK_ICONS['Marked as staged'], ui.MARK_ICONS.Implement);
  assert.equal(ui.MARK_ICONS['Implementation requested'], ui.MARK_ICONS['Marked as staged']);
  assert.ok(html.includes(`<div class="msg status-line request tone-orange"><span class="mark" aria-hidden="true">${ui.MARK_ICONS.Implement}</span>Marked as staged`));
});

test('a ↗ in a card title, a card details line, a thread line and a question draws as the arrow icon, never the character', () => {
  const card = workLines({ key: 'w/A1', ref: 'A1', title: 'Fix ↗ link', next: 'Open ↗', lane: 'todo' });
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
  const [request, page] = html.split(/(?=<div class="msg )/);
  assert.match(request, /^<div class="msg status-line request">/);
  assert.ok(request.includes(ui.MARK_ICONS['Visual requested']), 'led by the image mark');
  assert.notEqual(ui.MARK_ICONS['Visual requested'], ui.MARK_ICONS.Implement);
  assert.match(page, /^<div class="msg status-line link visual">/);
  assert.match(page, /<a href="visuals\/A1\/how-a-land-moves\.html">How a land &lt;moves&gt;/);
  assert.doesNotMatch(html, /target="_blank"|class="who"/);
});

// docs/adr/2026-11-08-0900-ready-and-staging-moves-are-bare-status-lines.md
test('a "Marked as staged" line is a bare orange status line and a "Marked as ready" line is the same in green', () => {
  const line = (command, text, tone) => ({ ts: ago(1), who: 'claude', kind: 'command', command, request: true, mark: text, text, tone });
  const html = ui.threadMessages([line('staged', 'Marked as staged', 'orange'), line('readied', 'Marked as ready', 'green')]);
  assert.deepEqual([...html.matchAll(/<div class="msg status-line ([^"]*)">/g)].map((m) => m[1]), ['request tone-orange', 'request tone-green'], 'bare status lines, each in its own tone');
  for (const words of ['Marked as staged', 'Marked as ready']) assert.ok(html.includes(ui.MARK_ICONS[words]), words);
  assert.doesNotMatch(html, /class="who"/);
});

// Every Created line is blue (--accent); Related to and Unrelated from stay gray.
test('a Created ticket, a Created from and a ticket-made line are blue; a Related to line is gray', () => {
  const link = (command, words) => ({ ts: ago(1), who: 'claude', kind: 'command', command, request: true, mark: words, text: `${words} #12: Tidy`, link: '#selectedCard=w%2FA2', card: 'w/A2', tone: command === 'related' ? 'grey' : 'blue' });
  const html = ui.threadMessages([link('created', 'Created ticket'), link('created-from', 'Created from'), link('related', 'Related to')]);
  assert.equal(html.match(/msg status-line request tone-blue/g).length, 2);
  assert.equal(html.match(/<div class="msg status-line request">/g).length, 1);
  const made = ui.threadMessages([{ ts: ago(1), who: 'claude', kind: 'hub', line: 'ticket-made', mark: 'Created ticket', text: 'Created ticket #5', fault: false, tone: 'blue' }]);
  assert.match(made, /class="msg status-line request hub tone-blue"/);
  // docs/adr/2026-11-12-2345-a-haiku-router-files-each-incoming-request-on-a-board.md: the router's line is info the owner reads.
  const routed = ui.threadMessages([{ ts: ago(1), who: 'claude', kind: 'hub', line: 'ask-routed', mark: 'ask-link', text: 'Routed here from Slack: the shop', link: 'https://slack.com/x', fault: false, tone: 'blue' }]);
  assert.match(routed, /class="msg status-line request hub tone-blue"><span class="mark" aria-hidden="true"><span class="it it-current"><span class="it-i it-arrow"[^]*<a href="https:\/\/slack.com\/x">Routed here from Slack: the shop<\/a>/);
});

// docs/adr/2026-11-12-2000-a-status-line-has-one-tone-for-its-icon-words-and-link.md
test('a status line draws icon, words and link in one tone; Created gets its own plus icon', () => {
  assert.equal(ui.MARK_ICONS['Created ticket'], ui.MARK_ICONS['Created from']);
  assert.notEqual(ui.MARK_ICONS['Created ticket'], ui.MARK_ICONS['Related to']);
  assert.match(ui.MARK_ICONS['Created ticket'], /<rect x="3" y="3" width="18" height="18" rx="2"\/>/);
  const card = (command, mark, tone) => ({ ts: ago(1), who: 'claude', kind: 'command', command, request: true, mark, text: `${mark} #12: Tidy`, link: '#selectedCard=w%2FA2', card: 'w/A2', tone });
  const tone = (html) => html.match(/class="msg status-line ([^"]*)"/)[1];
  assert.equal(tone(ui.threadMessages([card('created', 'Created ticket', 'blue')])), 'request tone-blue');
  assert.equal(tone(ui.threadMessages([card('related', 'Related to', 'grey')])), 'request');
  const hub = (extra) => ({ ts: ago(1), who: 'claude', kind: 'hub', text: 'x', mark: 'Fault', ...extra });
  assert.equal(tone(ui.threadMessages([hub({ tone: 'red', link: '#a' })])), 'request hub tone-red');
  assert.equal(tone(ui.threadMessages([hub({ line: 'ticket-made', mark: 'Created ticket', tone: 'blue' })])), 'request hub tone-blue');
  assert.ok(ui.threadMessages([hub({ line: 'ticket-made', mark: 'Created ticket' })]).includes(ui.MARK_ICONS['Created ticket']));
});

// docs/adr/2026-11-07-0600-every-thread-status-line-carries-an-icon.md
test('every kind of thread status or system line leads with an icon, so a new kind cannot ship without one', async () => {
  const { ACTION_LABELS, INTENT_LABELS, COMMANDS, ANSWERS_SUBMITTED } = await import('./domain.mjs');
  // Each word domain.mjs puts on a request line or a message footer has an icon: every command key's among them.
  const words = [...Object.values(ACTION_LABELS).filter((w) => w !== ACTION_LABELS['mark-ready']), ...Object.values(INTENT_LABELS), ...Object.values(COMMANDS), ANSWERS_SUBMITTED];
  for (const w of words) assert.match(ui.MARK_ICONS[w] || '', /class="it-i it-[a-z-]+"[^>]*><svg/, `${w} has an icon`);
  // Each system line kind renders a mark holding an icon, or the dot of a builder or agent that is running.
  const sample = { ts: ago(1), who: 'claude', text: 'x', link: '#selectedCard=a', calls: ['c'], verified: null };
  for (const kind of ui.SYSTEM_KINDS) {
    const html = ui.threadMessages([{ ...sample, kind, ...(kind === 'command' ? { command: 'hold', mark: COMMANDS.hold, text: 'Held until Fri', request: true } : {}), ...(kind === 'hub' ? { mark: 'Held' } : {}), ...(kind === 'ask-link' ? { words: 'Became', card: 'w/a' } : {}) }]);
    assert.match(html, /<span class="mark" aria-hidden="true"><span class="it it-current"><span class="it-i it-[a-z-]+"/, `${kind} line has a mark`);
  }
  // A request line with no icon for its words renders an empty mark, which this catches.
  for (const text of words.filter((w) => !INTENT_LABELS.reply || w !== INTENT_LABELS.reply)) {
    const html = ui.threadMessages([{ ts: ago(1), who: 'love', kind: 'grill-more', request: true, text }]);
    assert.match(html, /<span class="mark" aria-hidden="true"><span class="it it-current"><span class="it-i it-[a-z-]+" aria-hidden="true"><svg/, `${text} request line has an icon`);
  }
});

test("a link's thread line is one link icon, its words and the other card's ref linked with its lane ring, and is never unread", () => {
  const links = ui.linkContext([{ key: 'w/A2', id: 'A2', ref: '#12', file: 'w', lane: 'progress' }], 'w/A1');
  const html = ui.threadMessages([{ ts: ago(1), who: 'claude', kind: 'command', command: 'followup', request: true, mark: 'Follow-up', words: 'Follow-up', text: 'Follow-up #12', link: '#selectedCard=w%2FA2', card: 'w/A2' }], links, { seenAt: ago(5) });
  assert.match(html, /^<div class="msg status-line request"><span class="mark" aria-hidden="true"><span class="it it-current"><span class="it-i it-link"/);
  assert.ok(html.includes('Follow-up <a href="#selectedCard=w%2FA2">#12<span class="status link-lane progress"></span></a>'));
  assert.doesNotMatch(html, /unread/);
});

// docs/adr/2026-11-13-0230-a-card-reference-is-drawn-by-one-helper-with-its-lane-ring.md
test("one helper draws every card reference: its current ref, linked to the card, with its lane ring; a card off the board reads by its id, never its key", () => {
  const links = ui.linkContext([{ key: 'hub/T-1', id: 'T-1', ref: '#620', file: 'hub', lane: 'todo' }, { key: 'hub/T-2', id: 'T-2', ref: '#631', file: 'hub', lane: 'progress' }], 'hub/T-2');
  assert.equal(ui.cardRef('hub/T-1', links), '<a href="#selectedCard=hub%2FT-1">#620<span class="status link-lane todo"></span></a>');
  assert.equal(ui.cardRef('hub/T-9', links), '<a href="#selectedCard=hub%2FT-9">T-9</a>');
  assert.equal(ui.cardRef('hub/T-1', { ...links, base: './' }, { className: 'card-link' }), '<a class="card-link" href="./#selectedCard=hub%2FT-1">#620<span class="status link-lane todo"></span></a>');
  // A ref in written text links through the same helper.
  assert.ok(ui.linkText('See #620.', links).includes(ui.cardRef('hub/T-1', links)));
  // Every line naming a card draws it with the helper, at the ref the card has now, whatever the line's stored text read.
  const named = [
    { ts: ago(3), who: 'claude', kind: 'command', command: 'created-from', request: true, mark: 'Created from', words: 'Created from', text: 'Created from hub/T-1', card: 'hub/T-1', link: '#selectedCard=hub%2FT-1' },
    { ts: ago(2), who: 'claude', kind: 'hub', line: 'ticket-made', mark: 'Created ticket', tone: 'blue', words: 'Created ticket', text: 'Created ticket #5', card: 'hub/T-2', link: '#selectedCard=hub%2FT-2', fault: false },
    { ts: ago(1), who: 'claude', kind: 'ask-link', words: 'Became', text: 'Became T-2', card: 'hub/T-2', link: '#selectedCard=hub%2FT-2' },
  ];
  const html = ui.threadMessages(named, links);
  assert.ok(html.includes(`Created from ${ui.cardRef('hub/T-1', links)}`));
  assert.ok(html.includes(`Created ticket ${ui.cardRef('hub/T-2', links)}`));
  assert.ok(html.includes(`Became ${ui.cardRef('hub/T-2', links)}`));
  assert.match(html, /class="msg status-line request hub tone-blue"/);
  assert.doesNotMatch(text(html), /hub\/T-\d|#5\b/);
  // A ref in the words of the board's own line links through it too.
  const blocked = ui.threadMessages([{ ts: ago(1), who: 'claude', kind: 'hub', line: 'build-paused', mark: 'Held', text: 'Paused: blocked by #620', fault: false }], links);
  assert.ok(blocked.includes(`blocked by ${ui.cardRef('hub/T-1', links, { was: '#620' })}`));
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
  const fault = { ts: ago(1), who: 'claude', kind: 'hub', line: 'relaunch-failed', mark: 'Fault', fault: true, tone: 'red', text: "Couldn't relaunch the builder headless: spawn ENOENT" };
  const html = ui.threadMessages([quiet]);
  assert.match(html, /<div class="msg status-line request hub"><span class="mark" aria-hidden="true"><span class="it it-current"><span class="it-i it-pause"/);
  assert.doesNotMatch(html, /Orchestrator/);
  assert.match(ui.threadMessages([fault]), /<div class="msg status-line request hub tone-red">/);
  assert.match(ui.MARK_ICONS.Blocked, /circle/);
  assert.match(ui.MARK_ICONS.Fault, /it-warn/);
  // The window opens from the oldest unread line: a fault reaches past the last three messages, a quiet line doesn't.
  const msg = (h) => ({ ts: ago(h), who: 'love', text: `m${h}` });
  const older = [{ ...fault, ts: ago(9) }, msg(8), msg(7), msg(6), msg(5)];
  assert.match(ui.threadMessages(older, {},{ seenAt: ago(10) }), /relaunch/);
  assert.doesNotMatch(ui.threadMessages([{ ...quiet, ts: ago(9) }, ...older.slice(1)], {},{ seenAt: ago(10) }), /Host is busy/);
});

test('every status line kind takes the shared status-line class', () => {
  const lines = [
    { ts: ago(1), who: 'claude', kind: 'hub', line: 'pulled', mark: 'Held', text: 'Pulled in' },
    { ts: ago(1), who: 'claude', kind: 'move', text: 'Moved' },
    { ts: ago(1), who: 'claude', kind: 'status', text: 'Reading' },
    { ts: ago(1), who: 'claude', kind: 'agent', text: 'Opus started' },
    { ts: ago(1), who: 'claude', kind: 'visual', link: 'visuals/A1/x.html', text: 'Page' },
    { ts: ago(1), who: 'claude', kind: 'calls', text: 'Opus', calls: ['a'] },
  ];
  for (const m of lines) assert.match(ui.threadMessages([m]), /^<(div|details) class="msg status-line /, m.kind);
});

// docs/adr/2026-11-13-1959-every-status-line-shows-its-time-from-one-shell.md
test('every status line kind line() draws carries its time, a folded run its newest line\'s and judgment calls their posted one before verified', () => {
  const at = (h) => ui.time(ago(h));
  const run = { agent: 'Claude main', run: 'main' };
  const lines = [
    { ts: ago(1), who: 'claude', kind: 'ask-link', words: 'Became', card: 'site/S21', text: 'Became S21', link: '#selectedCard=site%2FS21' },
    { ts: ago(1), who: 'claude', kind: 'visual', link: 'visuals/A1/x.html', text: 'Page' },
    { ts: ago(1), who: 'claude', request: true, words: 'Made', card: 'w/A-1', link: '#selectedCard=w%2FA-1', mark: 'move', text: 'Made A-1' },
    { ts: ago(1), who: 'love', request: true, text: 'Grill requested', by: 'Dana Reyes' },
    { ts: ago(1), who: 'claude', kind: 'hub', line: 'serve-failed', mark: 'Held', text: 'Serve failed', detail: 'boom', fault: true },
    { ts: ago(1), who: 'claude', kind: 'hub', line: 'pulled', mark: 'Held', text: 'Pulled in' },
    { ts: ago(1), who: 'claude', kind: 'move', text: 'Moved' },
    { ts: ago(1), who: 'claude', kind: 'hub', line: 'questions-added', link: 'questions.html#q1', questions: ['q1', 'q2'], text: '2 questions added', open: true },
    { ts: ago(1), who: 'claude', kind: 'status', text: 'Reading' },
    { ts: ago(1), who: 'claude', kind: 'agent', text: 'Opus started' },
    { ts: ago(1), who: 'claude', kind: 'calls', text: 'Opus', calls: ['a'], verified: null },
  ];
  for (const m of lines) assert.ok(text(ui.threadMessages([m])).includes(`· ${at(1)}`), m.kind || m.text);
  const fold = ui.threadMessages([{ ts: ago(3), who: 'claude', kind: 'agent', text: 'Claude main started', ...run }, { ts: ago(2), who: 'claude', kind: 'status', text: 'Step', ...run }]);
  assert.ok(fold.split('</summary>')[0].includes(`· ${at(2)}`), 'a folded run shows its newest line\'s time');
  const verified = text(ui.threadMessages([{ ...lines.at(-1), verified: { at: ago(0.5) } }]));
  assert.ok(verified.includes(`· ${at(1)} · verified ${at(0.5)}`), verified);
});

// docs/adr/2026-11-17-0300-a-task-with-no-ticket-shows-its-t-n-on-the-badge.md: a card with no ticket wears a quiet badge
// of its T-<n> in the ticket slot; a ticket replaces it.
test('a task wears its T-number where a ticket would be, and a ticketed card its ticket', () => {
  const task = { ...workCard, key: 'w/T-8', id: 'T-8', ref: 'T-8', linear: [], ticket: null, pr: null, prs: [] };
  assert.match(workLines(task), /<span class="chip tone-quiet" title="T-8 · a task, no ticket">T-8<\/span>/);
  const ticketed = { ...task, ref: '#451', ticket: { id: '#451', url: 'https://github.com/o/r/issues/451', source: 'github' } };
  assert.doesNotMatch(workLines(ticketed), />Task</);
  assert.match(workLines(ticketed), />#451</);
  assert.match(workLines({ ...task, ticket: { id: 'INT-3', url: null, source: null } }), /title="INT-3 · not from this board’s ticket source">INT-3</);
});

test('a fault line with an error draws as a closed section: its title shows, the whole error sits in a monospace block, escaped', () => {
  const why = 'Warning: client version "1.104.5" != tailscaled server version "1.96.2"\nCouldn\'t open try port 8504 <denied>';
  const html = ui.threadMessages([{ ts: ago(1), who: 'claude', kind: 'hub', line: 'run-failed', mark: 'Fault', fault: true, tone: 'red', text: 'Serve failed (exit 1)', detail: why }]);
  assert.match(html, /<details class="msg status-line request hub fault-detail tone-red"><summary>.*Serve failed \(exit 1\).*<\/summary><pre class="fault-error">/s);
  assert.ok(html.includes('&lt;denied&gt;') && html.includes('client version &quot;1.104.5&quot;'));
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.doesNotMatch(ui.threadMessages([{ ts: ago(1), who: 'claude', kind: 'hub', line: 'exited-twice', mark: 'Fault', fault: true, text: 'x' }]), /<details/);
});

test('the header time stays plain while usage is paused, and the hub pause banner with Keep going is the one the board shows', () => {
  const resets_at = new Date(NOW + 3600_000).toISOString();
  const pause = usageGate({ claude: { five_hour: { used_percentage: 95, resets_at, state: 'live' } }, now: NOW });
  assert.equal(/class="fresh"/.test(ui.statusLine(null, { pause })), true);
  assert.match(context.HubUI.pauseBanner(pause), /action="\/_hub\/settings\/keep-going"><button class="btn quiet" name="value" value="on">Keep going/);
});

test("a link to a card on the board ends with that card's lane ring; an id with no card stays plain", () => {
  const items = [{ key: 'w/A1', file: 'w', id: 'A1', ref: '#186', lane: 'review' }, { key: 'w/A2', file: 'w', id: 'A2', ref: 'INT-5', lane: 'progress', internal: true, linear: [] }];
  const html = ui.linkText('#186 and INT-5 and #999 and ENG-1', ui.linkContext(items, 'w/A1'));
  assert.match(html, /<a href="#selectedCard=w%2FA1">#186<span class="status link-lane review"><\/span><\/a>/);
  assert.match(html, /<a href="#selectedCard=w%2FA2">INT-5<span class="status link-lane progress"><\/span><\/a>/);
  assert.doesNotMatch(html, /(#999|ENG-1)<span class="status link-lane/);
});

test('a link to a card shows its current ref, with the id as written as the hover title', () => {
  const items = [{ key: 'w/A1', file: 'w', id: 'T-57', ref: 'PAD-123', lane: 'review' }];
  const html = ui.linkText('see T-57 and PAD-123', ui.linkContext(items, 'w/A1'));
  assert.match(html, /<a href="#selectedCard=w%2FA1" title="was T-57">PAD-123<span/);
  assert.match(html, /<a href="#selectedCard=w%2FA1">PAD-123<span/);
  assert.doesNotMatch(html, />T-57</);
});

// docs/adr/2026-11-12-1000-the-logo-dot-carries-the-hub-state.md
test('the logo dot is the highest of red, orange, blue, grey: not listening or offline, busy, an update, paused', () => {
  const ok = { pause: { state: 'normal' }, hub: { tone: 'ok' }, sites: [{ route: 'a', board: true, listen: 'listening' }] };
  assert.equal(ui.hubDot(ok), '');
  assert.equal(ui.hubDot({ ...ok, sites: [{ route: 'a', board: true, listen: 'listening' }, { route: 'b', board: true, listen: 'deaf' }] }), 'down', 'not listening on any board');
  assert.equal(ui.hubDot({ ...ok, sites: [{ route: 'b', board: true, listen: 'full' }] }), 'down');
  assert.equal(ui.hubDot({ ...ok, sites: [{ route: 'b', board: true, listen: 'asleep' }] }), '', 'asleep is not a fault');
  assert.equal(ui.hubDot(ok, { offline: true }), 'down', 'a page that cannot reach the host');
  const busy = { ...ok, pause: { state: 'normal', machine: { state: 'busy', busy: true, banner: false, since: new Date(NOW - 5 * 60_000).toISOString() } } };
  assert.equal(ui.hubDot({ ...busy, sites: [{ route: 'b', board: true, listen: 'deaf' }] }), 'down', 'red beats orange');
  assert.equal(ui.hubDot(busy, { update: 'ready' }), 'busy', 'orange beats blue');
  assert.equal(ui.hubDot(ok, { update: 'ready' }), 'update');
  const paused = { ...ok, pause: { paused: true } };
  assert.equal(ui.hubDot(paused, { update: 'ready' }), 'update', 'blue beats grey');
  assert.equal(ui.hubDot(paused), 'paused');
  assert.equal(ui.hubDot(null), '');
});

test("only written messages count toward a thread's newest 3: command lines and bare request lines are neither shown as hidden messages nor unread", () => {
  const at = (n) => `2020-01-01T10:${String(n).padStart(2, '0')}:00.000Z`;
  const msgs = [
    { ts: at(0), who: 'claude', text: 'One' },
    { ts: at(1), who: 'claude', text: 'Two' },
    { ts: at(2), who: 'claude', text: 'Three' },
    { ts: at(3), who: 'claude', kind: 'command', command: 'staged', request: true, mark: 'Marked as staged', text: 'Marked as staged' },
    { ts: at(4), who: 'claude', kind: 'command', command: 'readied', request: true, mark: 'Marked as ready', text: 'Marked as ready' },
    { ts: at(5), who: 'claude', kind: 'command', command: 'related', request: true, card: 'hub/T-1', link: '#selectedCard=hub%2FT-1', text: 'Related to hub/T-1' },
    { ts: at(6), who: 'love', via: 'site', kind: 'visual-request', request: true, command: 'visual', mark: 'Visual requested', text: 'Visual requested' },
  ];
  const html = ui.threadMessages(msgs, {},{ seenAt: at(59), more: 0 });
  for (const w of ['One', 'Two', 'Three']) assert.match(html, new RegExp(`>${w}`));
  assert.doesNotMatch(html, /thread-more/);
  assert.equal(ui.isMessage({ ts: at(6), request: true, kind: 'visual-request' }), false);
  assert.equal(ui.isMessage({ ts: at(6), who: 'love', kind: 'visual-request', text: 'Show it' }), true);
});

// docs/adr/2026-11-06-1305-a-busy-host-shows-only-on-the-hub-row-and-the-logo-dot.md
test('a host busy for more than 30 minutes adds a banner at the sidebar top that opens the load sheet, gone when the host eases', () => {
  // The hub sends busy (a minute, no usage pause) and banner (past 30 minutes); the sidebar draws them.
  const busyFor = (minutes, extra = {}) => ui.sidebar({ pause: { state: 'normal', machine: { state: 'busy', busy: true, banner: minutes > 30, reason: 'load high', since: new Date(NOW - minutes * 60_000).toISOString() } }, sites: [], hub: { tone: 'ok', word: 'healthy', detail: '' }, ...extra });
  assert.doesNotMatch(busyFor(29), /sb-busy-banner/, 'no banner at 29 minutes');
  assert.match(busyFor(29), /data-load-sheet/, 'the Hub row still reads busy');
  const banner = busyFor(31).match(/<button[^>]*sb-busy-banner[^>]*>.*?<\/button>/s)?.[0];
  assert.ok(banner, 'a banner at 31 minutes');
  assert.match(banner, /data-load-sheet/, 'it opens the load sheet');
  assert.match(text(banner), /Host busy \(31m\): load high/);
  assert.ok(busyFor(31).indexOf('sb-busy-banner') < busyFor(31).indexOf('sb-utility'), 'it sits above the Hub section');
  assert.doesNotMatch(ui.sidebar({ pause: { state: 'normal', machine: { state: 'normal' } }, sites: [], hub: { tone: 'ok', word: 'healthy', detail: '' } }), /sb-busy-banner/, 'gone when idle');
  assert.doesNotMatch(busyFor(31, { pause: { paused: true, resets_at: new Date(NOW + 3600_000).toISOString(), machine: { state: 'busy', busy: false, banner: false, reason: 'load high', since: new Date(NOW - 31 * 60_000).toISOString() } } }), /sb-busy-banner/, 'a usage pause reads first');
});

// docs/adr/2026-11-13-0026-the-busy-hub-row-opens-whats-loading-the-host.md
// docs/adr/2026-11-16-1915-the-hub-status-opens-the-load-sheet-at-any-load-collapsed.md
test("the Hub row's status opens what's loading the host at any load: the load now and over the hour, then every group collapsed and Stop on orphans alone", () => {
  const machine = { state: 'busy', busy: true, banner: true, reason: 'load high', since: new Date(NOW - 42 * 60_000).toISOString() };
  const busy = ui.sidebar({ pause: { state: 'normal', machine }, sites: [], hub: { tone: 'ok', word: 'healthy', detail: '' } });
  assert.match(busy, /<button type="button" class="sb-load" data-load-sheet aria-label="busy \(42m\), what's loading the host" aria-haspopup="dialog">/);
  const calm = ui.sidebar({ pause: { state: 'normal', machine: { state: 'normal' } }, sites: [], hub: { tone: 'ok', word: 'healthy', detail: '' } });
  assert.match(calm, /<button type="button" class="sb-load" data-load-sheet aria-label="healthy, what's loading the host" aria-haspopup="dialog">/, 'healthy opens it too');
  const paused = ui.sidebar({ pause: { paused: true, resets_at: new Date(NOW + 3600_000).toISOString(), machine: { state: 'normal' } }, sites: [], hub: { tone: 'ok', word: 'healthy', detail: '' } });
  assert.match(paused, /<button type="button" class="sb-load" data-load-sheet [^>]*aria-label="paused [^"]*, what's loading the host"/, 'and paused');
  const detailed = ui.sidebar({ pause: { state: 'normal', machine: { state: 'normal' } }, sites: [], hub: { tone: 'ok', word: 'healthy', detail: '3 of 3 sites up' } });
  assert.equal(detailed.match(/data-load-sheet/g).length, 1, 'the word is the only control on the row');
  assert.match(detailed, /<button [^>]*data-load-sheet[^>]*>(?:(?!<\/button>).)*healthy<\/span><\/span><\/button><span>3 of 3 sites up<\/span>/, 'the detail sits outside the button, as plain text');

  assert.match(text(ui.loadSheet(null)), /What's loading the host ✕ Reading the host…/);
  const H = 3600;
  const data = {
    load: 58.04, cores: 10, average: 46.25,
    samples: [{ at: '2026-11-12T01:00:00Z', load: 31 }, { at: '2026-11-12T01:01:00Z', load: 63 }, { at: '2026-11-12T01:02:00Z', load: 58 }],
    groups: [
      { key: 'orphan', title: 'Looks orphaned', rows: [{ pid: 4127, cmd: 'node --test board/server.test.mjs', age: 5 * 24 * H, cpu: 212, owner: 'no board or session' }, { pid: 5530, cmd: 'node board/server.mjs --port 4431', age: 3 * 24 * H, cpu: 38.4, owner: 'no board or session' }] },
      { key: 'suite', title: 'Test suites', rows: [{ pid: 122, cmd: 'node --test hub/hub.test.mjs', age: 720, cpu: 96, owner: 'T-171 build' }] },
      { key: 'session', title: 'Claude sessions', rows: [{ pid: 200, cmd: 'Hub Orchestrator', age: 9 * H, cpu: 3, owner: 'orchestrator' }] },
      { key: 'other', title: 'Other', rows: [{ pid: 300, cmd: 'mds_stores', age: 40, cpu: 18, owner: '' }] },
    ],
  };
  const sheet = ui.loadSheet(data);
  assert.match(text(sheet), /^What's loading the host ✕ 58 now, 10 cores 46\.3 hour average 60 min ago now /);
  assert.match(sheet, /<polyline [^>]*points="0,[\d.]+ 60,[\d.]+ 120,[\d.]+"/);
  const folds = [...sheet.matchAll(/<button type="button" class="ls-fold" data-fold="(\w+)" aria-expanded="(true|false)">(.*?)<\/button>/g)].map((m) => [m[1], m[2], text(m[3])]);
  assert.deepEqual(folds, [
    ['orphan', 'false', '› Looks orphaned 2 · 250%'], ['suite', 'false', '› Test suites 1 · 96%'], ['session', 'false', '› Claude sessions 1 · 3%'], ['other', 'false', '› Other 1 · 18%'],
  ]);
  assert.equal([...sheet.matchAll(/<div class="ls-inner"( hidden)?>/g)].map((m) => Boolean(m[1])).join(), 'true,true,true,true', 'every group opens collapsed');
  // A re-read after a Stop keeps the groups the owner opened.
  const reread = ui.loadSheet(data, { open: new Set(['orphan', 'other']) });
  assert.equal([...reread.matchAll(/<div class="ls-inner"( hidden)?>/g)].map((m) => Boolean(m[1])).join(), 'false,true,true,false');
  assert.match(reread, /data-fold="orphan" aria-expanded="true"/);
  assert.match(text(sheet), /node --test board\/server\.test\.mjs 5d · no board or session 212% Stop Stop node --test board\/server\.test\.mjs \(pid 4127\)\? It ends the process and anything it's doing\. Keep Stop it/);
  assert.match(text(sheet), /node --test hub\/hub\.test\.mjs 12m · T-171 build 96%/);
  assert.match(text(sheet), /Hub Orchestrator 9h · orchestrator 3%/);
  assert.match(text(sheet), /mds_stores 40s 18%/);
  assert.deepEqual([...sheet.matchAll(/data-stop="(\d+)"/g)].map((m) => m[1]), ['4127', '5530'], 'Stop on orphans alone');
  assert.equal([...sheet.matchAll(/<div class="ls-confirm" hidden>/g)].length, 2);
  assert.match(sheet, /class="ls-cpu hot">212%/);

  assert.doesNotMatch(sheet, /ls-busy/, 'green while the hub does not read busy');
  assert.match(ui.loadSheet({ ...data, busy: true }), /<div class="ls-load ls-busy">/, 'orange while it reads busy');
  assert.doesNotMatch(sheet, /<polyline [^>]*stroke="/, 'the line takes its colour from the sheet');

  assert.match(text(ui.loadSheet({ ...data, groups: [] })), /Nothing is loading the host\.$/);
  assert.match(text(ui.loadSheet({ ...data, groups: null })), /ps gave no answer in time, as happens on a busy host\. Try again in a moment\.$/);
  assert.match(text(ui.loadSheet({ ...data, average: null, samples: [] })), /58 now, 10 cores No samples yet/);
});

test('a card whose planner is queued for the usage reset ends its alert row with a grey bold paused', () => {
  const alert = (it) => /<div class="line6 sub card-alert">(.*?)<\/div>/.exec(workLines({ ...workCard, sortAt: '2020-01-01T10:00:00.000Z', ...it }))?.[1];
  assert.equal(alert({ plannerQueued: true }), '<span class="paused">paused</span>');
  assert.equal(alert({ plannerQueued: false }), undefined);
  assert.match(alert({ plannerQueued: true, stalled: true }), /card-stalled">stalled<\/span><span class="sep"> · <\/span><span class="paused">paused<\/span>$/);
});

// docs/adr/2026-11-15-0715-a-merge-mode-done-card-shows-its-commit-as-a-badge.md
test("a Merge-mode Done card's commit is a purple badge of its short sha in mono, a link when it has a url, plain when not, and nothing without one", () => {
  const linked = ui.commitChip({ commit: { sha: 'abcdef0', url: 'https://github.com/o/r/commit/abcdef0' } });
  assert.equal(text(linked), 'abcdef0');
  assert.match(linked, /^<a class="chip tone-merged" href="https:\/\/github.com\/o\/r\/commit\/abcdef0" [^>]*target="_blank"[^>]*><code>abcdef0<\/code><\/a>$/);
  assert.match(ui.commitChip({ commit: { sha: 'abcdef0', url: null } }), /^<span class="chip tone-merged"[^>]*><code>abcdef0<\/code><\/span>$/);
  assert.equal(ui.commitChip({ commit: null }), '');
  assert.equal(ui.prChips({ commit: { sha: 'abcdef0', url: null }, prs: [] }), '');
});

// docs/adr/2026-11-16-1030-a-thread-replys-and-an-answers-attachments-send-atomically-with-thumbnails.md
test("an unsent thread reply's line draws its box's tiles in the uploads wrapper, and a sent one its files as attachments", () => {
  const shot = { name: 'shot.png', url: 'uploads/1-shot.png', type: 'image/png' };
  const list = [{ id: 'f1', name: 'bad.png', type: 'image/png', preview: 'blob:bad', status: 'error', error: 'Upload failed' }];
  const unsent = ui.threadMessages([{ ts: ago(1), who: 'love', kind: 'item-message', text: 'See', files: [], uploads: { box: 'send:s1', list }, sendId: 's1', state: 'failed' }]);
  assert.ok(unsent.includes(`<div data-uploads="send:s1">${ui.uploadTiles(list)}</div>`));
  assert.match(unsent, /data-unattach="f1"/);
  assert.ok(ui.threadMessages([{ ts: ago(1), who: 'love', kind: 'item-message', text: 'See', files: [shot], sendId: 's2', state: 'sending' }]).includes(ui.attachments([shot])));
});

// docs/adr/2026-11-16-1200-the-server-sends-a-cards-footer-and-builder-words.md
test("the footer draws the server's words as sent, comparing none of the card's fields, and the builder line draws its words with the age", () => {
  const sortAt = ago(24 * 2);
  const card = { ...workCard, lane: 'todo', pr: null, prs: [], reviewers: [], next: null, sortAt, stale: false, ownerBlock: null, blockedBy: [], blockedUntil: 'ignored' };
  const footer = [{ kind: 'stale', words: 'stale' }, { kind: 'blocked', lead: 'blocked by ', deps: [{ key: 'w/B1', ref: '#61', lane: 'progress' }], tail: ', waiting' },
    { kind: 'pause', paused: true, words: 'paused · usage pause' }];
  assert.match(lines(ui.workLines({ ...card, footer })).at(-1), /^.* · stale · blocked by #61 ?, waiting · paused · usage pause$/);
  assert.equal(lines(ui.workLines({ ...card, footer: [] })).at(-1), ui.cardTime(sortAt));
  const at = new Date(NOW - 4 * 60000).toISOString();
  assert.equal(ui.builderLine({ words: 'stopped · Running tests', alive: true, progress: null, at }), 'stopped · Running tests (4m)');
});

// docs/adr/2026-11-16-1500-new-groups-the-orchestrators-asks-under-a-collapsed-orchestrator-section.md
test("New draws an ask the orchestrator filed under a collapsed Orchestrator sub-head, apart from the owner's, and counts only the main list", () => {
  const card = (id, ask) => ({ kind: 'work', id, key: `w/${id}`, ref: id, isNew: true, created: ago(2), ask: { eventId: id, askedAt: ago(2), canEdit: true, text: `Ask ${id}`, files: [], state: 'waiting', ...ask } });
  const strip = (items, open) => ui.newStrip(ui.newEntries({ items, merges: [] }, {}), { open });
  const items = [card('T-1', {}), card('T-2', { asked: true }), card('T-3', { asked: true })];
  const [main, group] = strip(items).split('<details class="new-orchestrator"');
  assert.match(main, /<details class="lane new-lane" data-lane="new" open><summary><span class="lane-name">New<\/span><span class="count">1<\/span>/);
  assert.match(main, /Ask T-1/);
  assert.doesNotMatch(main, /Ask T-[23]/, "the orchestrator's asks leave the main list");
  assert.match(group, /^ data-lane="new-orchestrator" ><summary><span class="lane-name">Orchestrator<\/span><span class="count">2<\/span>/, 'collapsed by default');
  assert.match(group, /Ask T-2[^]*Ask T-3/);
  assert.match(strip(items, { 'new-orchestrator': true }), /<details class="new-orchestrator" data-lane="new-orchestrator" open>/);
  // Only orchestrator asks wait: New is its head and the collapsed sub-head, counting nothing, and says nothing empty.
  const only = strip(items.slice(1));
  assert.match(only, /<span class="count">0<\/span><\/summary><div class="list"><details class="new-orchestrator"/);
  assert.doesNotMatch(only, /new-empty/);
  // New collapses like a lane: its remembered state shuts it.
  assert.match(strip(items, { new: false }), /<details class="lane new-lane" data-lane="new" >/);
  assert.doesNotMatch(strip(items.slice(0, 1)), /new-orchestrator/);
});

// docs/adr/2026-11-17-0254-a-new-board-opens-empty-while-its-orchestrator-starts.md
test("a New board served while its orchestrator starts: its New asks read waiting for the orchestrator, its sidebar row opens it, and its banner carries the start's step, prompt, stall and failure until it joins", () => {
  const sent = ago(1);
  const strip = ui.newStrip(ui.newEntries({ items: [{ kind: 'work', id: 'T-3', key: 'w/T-3', ref: 'T-3', isNew: true, created: sent, ask: { eventId: 'a1', askedAt: sent, canEdit: true, text: 'Fix it', files: [], state: 'starting' } }], merges: [] }, {}));
  assert.match(strip, /<span class="pickup-wait" data-since="[^"]+" data-word="waiting for the orchestrator">waiting for the orchestrator(?: \([^)]+\))?<\/span>/);
  assert.match(strip, /data-withdraw="a1"/, 'it deletes and has no Edit');
  assert.doesNotMatch(strip, /data-edit/);

  const now = Date.parse('2026-11-16T22:00:00.000Z');
  const at = (seconds) => new Date(now - seconds * 1000).toISOString();
  const base = { route: 'shop', title: 'Shop', step: 'starting', stepAt: at(42), branch: 'main', failed: false, served: true };
  const sidebar = (here) => ui.sidebar({ sites: [], starting: [base] }, { now, here });
  assert.match(sidebar(''), /<div class="sb-row sb-starting" data-starting="shop">.*?<a class="sb-title" href="\/shop\/">Shop<\/a>/);
  assert.match(sidebar('shop'), /<div class="sb-row sb-starting on" data-starting="shop" aria-current="page">/);
  assert.match(ui.sidebar({ sites: [], starting: [{ ...base, served: undefined }] }, { now }), /<span class="sb-title">Shop<\/span>/, 'a start not served yet has nothing to open');

  const banner = (s) => ui.startBanner({ ...base, ...s }, now);
  assert.match(banner({ activity: 'joining the hub' }), /^<div class="start-banner wait" data-starting="shop"><span class="sb-text"><b>orchestrator starting<\/b><span class="sb-steps">.*<\/span><span class="sb-sub sb-step">joining the hub · 42s<\/span><\/span><\/div>$/);
  assert.match(banner({ stalled: true, quietSince: at(180) }), /<span class="sb-sub sb-step sb-stalled">stalled · 3m quiet<\/span><span class="sb-start-actions"><button type="button" class="sb-start-retry" data-start-retry="shop">Retry<\/button>/);
  const asking = banner({ prompt: { id: 'p1', tool: 'Bash', action: 'run kickflip doctor --fix', detail: 'kickflip doctor --fix', questions: null } });
  assert.match(asking, /^<div class="start-banner down"/, 'a prompt waiting on the owner is red');
  assert.match(asking, /<div class="sb-prompt" role="alert" data-start-prompt="p1"><b>waiting on you · Bash: kickflip doctor --fix<\/b><div class="sb-prompt-btns"><button type="button" class="primary" data-start-answer="allow">Allow once<\/button><button type="button" data-start-answer="always" data-start-rule="[^"]*">Always<\/button>/);
  const ended = banner({ failed: true, ended: true, error: 'Its session ended before it joined the hub.' });
  assert.match(ended, /^<div class="start-banner down" data-starting="shop"><span class="sb-text"><b>orchestrator didn’t start<\/b><span class="sb-sub">Its session ended before it joined the hub\.<\/span><span class="sb-start-actions"><button type="button" class="sb-start-retry" data-start-retry="shop">Retry<\/button><\/span><\/span><\/div>$/);
  assert.doesNotMatch(banner({ failed: true, error: 'x', branch: undefined }), /Retry/);
  assert.equal(banner({ step: 'landing', joined: true }), '', 'the banner goes once the session joins');
  assert.equal(ui.startBanner(undefined, now), '');
});

// docs/adr/2026-11-16-2300-a-starting-board-shows-its-sessions-liveness-activity-and-prompt.md
test("a starting board's row shows its session's last activity, an orange stalled with Retry, a red prompt block with Allow once, Always and Deny, and an ended session's failed row", () => {
  const now = Date.parse('2026-11-16T22:00:00.000Z');
  const at = (seconds) => new Date(now - seconds * 1000).toISOString();
  const base = { route: 'shop', title: 'Shop', step: 'starting', stepAt: at(42), branch: 'main', failed: false };
  const row = (s) => /<div class="sb-row sb-starting" data-starting="shop">.*?<\/div>(?=<button type="button" class="sb-row sb-new")/.exec(ui.sidebar({ sites: [], starting: [{ ...base, ...s }] }, { now }))[0];
  assert.equal(ui.startCaption({ ...base, activity: 'loading the kickflip skill' }, now), 'loading the kickflip skill · 42s');
  assert.equal(ui.startCaption({ ...base, activity: 'x', stalled: true, quietSince: at(200) }, now), 'stalled · 3m quiet');
  assert.match(row({ activity: 'joining the hub' }), /<span class="sb-sub sb-step">joining the hub · 42s<\/span><\/span><\/div>$/);

  const stalled = row({ activity: 'running kickflip doctor', stalled: true, quietSince: at(180) });
  assert.match(stalled, /<span class="sb-sub sb-step sb-stalled">stalled · 3m quiet<\/span><span class="sb-start-actions"><button type="button" class="sb-start-retry" data-start-retry="shop">Retry<\/button><\/span>/);
  assert.doesNotMatch(row({ stalled: true, quietSince: at(180), branch: undefined }), /Retry/, 'only a New board start can run again');

  const asking = row({ activity: 'running kickflip doctor', prompt: { id: 'p1', tool: 'Bash', action: 'run kickflip doctor --fix', detail: 'kickflip doctor --fix <x>', questions: null } });
  assert.match(asking, /<div class="sb-prompt" role="alert" data-start-prompt="p1"><b>waiting on you · Bash: kickflip doctor --fix &lt;x&gt;<\/b><div class="sb-prompt-btns"><button type="button" class="primary" data-start-answer="allow">Allow once<\/button><button type="button" data-start-answer="always" data-start-rule="[^"]*">Always<\/button><button type="button" class="deny" data-start-answer="deny">Deny<\/button><\/div><\/div>/);
  assert.match(row({ prompt: { id: 'p2', tool: 'mcp__x__y', action: 'use x y', detail: '', questions: null } }), /<b>waiting on you · mcp__x__y: use x y<\/b>/);
  const question = { question: 'Which <repo>?', header: '', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] };
  assert.match(row({ prompt: { id: 'p3', tool: 'AskUserQuestion', questions: [question] } }),
    /<b>waiting on you · asks: Which &lt;repo&gt;\?<\/b><div class="sb-prompt-btns"><button type="button" data-start-question="Which &lt;repo&gt;\?" data-start-option="A">A<\/button><button type="button" data-start-question="Which &lt;repo&gt;\?" data-start-option="B">B<\/button><button type="button" class="deny" data-start-answer="deny">Skip<\/button><\/div>/);
  assert.match(row({ prompt: { id: 'p4', tool: 'AskUserQuestion', questions: [question, question] } }), /<b>waiting on you · asks: Which &lt;repo&gt;\?<\/b><div class="sb-prompt-btns"><a href="\/_hub\/">Answer on the hub page<\/a><\/div>/);

  const html = ui.sidebar({ sites: [], starting: [{ ...base, failed: true, ended: true, error: 'Its session ended before it joined the hub.' }] }, { now });
  assert.match(html, /data-failed-start="shop" aria-haspopup="dialog">.*?<span class="sb-title">Shop<\/span><span class="sb-sub">session ended<\/span><\/span><\/button>/);
});

test("a question on a card's visual shows a See the visual link row under its context, and one with no url shows no row", () => {
  const withContext = { ...question, context: 'Four fixes are left.' };
  const html = ui.questionCard({ ...withContext, url: 'visuals/T-1/four-fixes.html' });
  assert.match(html, /<div class="small"[^>]*><a href="visuals\/T-1\/four-fixes\.html">See the visual /);
  assert.ok(html.indexOf('Four fixes are left.') < html.indexOf('See the visual'));
  assert.ok(html.indexOf('See the visual') < html.indexOf('<label class="opt">'));
  assert.doesNotMatch(ui.questionCard(withContext), /See the visual/);
});

test("a message footer's Retry and X overlap its line like a status line's, so a failed send doesn't grow the row", () => {
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  // 28px tap targets in a ~16px footer: the vertical margins cancel the difference.
  assert.match(css, /^\.msg-foot \.send-again \{ margin: -6px 0 -6px auto;/m);
});
