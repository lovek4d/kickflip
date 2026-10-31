import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({});
for (const file of ['ui.js', 'ui-links.js', 'ui-enums.js', 'ui-cards.js', 'ui-header.js', 'ui-threads.js', 'ui-questions.js', 'ui-prompts.js', 'ui-markdown.js', 'ui-page-header.js', 'ui-snapshot.js', 'ui-sidebar.js']) {
  vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), context);
}
const ui = context.BoardUI;

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&(amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e]).replace(/\s+/g, ' ').trim();
const ago = (hours) => new Date(Date.now() - hours * 3600000).toISOString();
const options = (html) => html.split('<label class="opt">').slice(1);
const plain = (v) => JSON.parse(JSON.stringify(v));

const openPR = { number: 7, url: 'https://github.com/o/repo/pull/7', state: 'OPEN', isDraft: false, checks: { state: 'pass' } };

const colorsCss = fs.readFileSync(new URL('../shared/colors.css', import.meta.url), 'utf8');
const definedIn = (src) => new Set([...src.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
const usedIn = (src) => new Set([...src.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]));

test('the board and the hub take every colour from shared/colors.css and define none of their own', () => {
  const shared = definedIn(colorsCss);
  const boardCss = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  const hubCss = fs.readFileSync(new URL('./public/hub.css', import.meta.url), 'utf8');
  const sidebarCss = fs.readFileSync(new URL('./public/sidebar.css', import.meta.url), 'utf8');
  for (const [name, css, local] of [['style.css', boardCss, definedIn(boardCss)], ['hub.css', hubCss, definedIn(hubCss + ['ui-hub.js', 'view-polling.js'].map((f) => fs.readFileSync(new URL(`./public/${f}`, import.meta.url), 'utf8')).join(''))], ['sidebar.css', sidebarCss, definedIn(sidebarCss + fs.readFileSync(new URL('./public/ui-sidebar.js', import.meta.url), 'utf8'))]]) {
    assert.deepEqual([...usedIn(css)].filter((v) => !shared.has(v) && !local.has(v)), [], name);
    assert.deepEqual([...definedIn(css)].filter((v) => shared.has(v)), [], name);
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

test('a badge takes one of the five tones, each coloured by a shared colour constant, as a span or a link, and refuses any other tone', () => {
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  const shared = definedIn(colorsCss);
  assert.deepEqual(plain(ui.BADGE_TONES), ['quiet', 'normal', 'notice', 'danger', 'ready']);
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

test('a review chip shows its age once it has waited a day', () => {
  const chips = (since) => text(ui.reviewChips({ pr: openPR, reviewers: ['Jamie'], review: { Jamie: { state: 'sent', since } } }));
  assert.equal(chips(ago(3)), 'J ●');
  assert.equal(chips(ago(50)), 'J ● 2d');
  assert.equal(text(ui.reviewChips({ pr: openPR, reviewers: ['Jamie'], review: { Jamie: { state: 'approved', since: null } } })), 'J ✓');
});

test('a merged PR shows no review chips', () => {
  assert.equal(ui.reviewChips({ pr: { ...openPR, state: 'MERGED' }, reviewers: ['Jamie'], review: {} }), '');
});

test('PR chips show the repo with an orange dot for a draft or a green check once ready, then CI and unanswered Codex findings', () => {
  const draft = ui.prChips({ pr: { ...openPR, isDraft: true, codexOpen: 2 } });
  assert.equal(text(draft), 'repo#7 ● CI ✓ codex 2');
  assert.match(draft, /^<a class="chip tone-notice" [^>]*title="Draft" [^>]*aria-label="repo#7: Draft">/);
  const ready = ui.prChips({ pr: openPR });
  assert.equal(text(ready), 'repo#7 ✓ CI ✓');
  assert.match(ready, /^<a class="chip tone-ready" [^>]*title="Ready for review" [^>]*aria-label="repo#7: Ready for review">/);
  const ci = (state) => /<span class="chip (tone-\w+)" title="CI/.exec(ui.prChips({ pr: { ...openPR, checks: { state } } }))[1];
  assert.deepEqual(['pass', 'fail', 'pending', 'unknown'].map(ci), ['tone-ready', 'tone-danger', 'tone-notice', 'tone-quiet']);
  assert.equal(text(ui.prChips({ pr: { ...openPR, state: 'MERGED', codexOpen: 2 } })), 'repo#7 merged');
  assert.equal(text(ui.prChips({ pr: { ...openPR, state: 'CLOSED' } })), 'repo#7 closed');
});

test('the header reads the time since the last change signal or refresh, and the In Review header when GitHub was checked, each saying when it needs a look', () => {
  const checks = { at: ago(4 / 60), every: 30, late: false, watcher: 'running', claudeAt: ago(3) };
  const fresh = ago(1 / 60);
  assert.equal(text(ui.statusLine(fresh)), '1 min');
  assert.match(ui.statusLine(fresh), /title="Updated 1 min ago[^"]*"/);
  assert.equal(text(ui.statusLine(ago(0))), 'now');
  assert.equal(text(ui.statusLine(ago(2), { watcher: 'running' })), '2 h');
  assert.equal(ui.statusLine(null), '');
  assert.match(ui.statusLine(fresh, { watcher: 'stopped' }), /^<span class="claude late" title="Claude not listening">not listening<\/span>$/);
  assert.match(ui.statusLine(fresh, { watcher: 'stopped', link: 'offline' }), /^<span class="link-state offline" title="Offline: can't reach the Mac">1 min<\/span>$/);
  assert.equal(text(ui.statusLine(fresh, { link: 'reconnecting' })), 'Reconnecting…');
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
  const raw = ui.packSnapshot(board, threads, { savedAt, keep: ['w/A'] });
  const back = plain(ui.unpackSnapshot(raw));
  assert.deepEqual([back.savedAt, back.board], [savedAt, board]);
  assert.deepEqual(Object.keys(back.threads), ['w/A', 'w/B', 'w/C']);
  assert.deepEqual(back.threads['w/A'], [{ text: 'a' }]);
  const capped = plain(ui.unpackSnapshot(ui.packSnapshot(board, threads, { savedAt, keep: ['w/A'], max: raw.length - 100 })));
  assert.deepEqual(Object.keys(capped.threads), ['w/A', 'w/B']);
  assert.equal(ui.packSnapshot(board, threads, { savedAt, max: 50 }), null);
});

test('a stored snapshot that is damaged, from another version or undated reads as none', () => {
  const good = ui.packSnapshot({ items: [{ key: 'w/A', lane: 'todo' }] }, new Map(), { savedAt: '2026-10-23T08:00:00.000Z' });
  assert.ok(ui.unpackSnapshot(good));
  for (const raw of [null, '', 'not json', good.slice(0, -3), good.replace('"v":1', '"v":0'), good.replace('"items":[', '"cards":['), good.replace('2026-10-23T08:00:00.000Z', 'soon')]) {
    assert.equal(ui.unpackSnapshot(raw), null, String(raw));
  }
  const odd = JSON.parse(good);
  odd.threads = { 'w/A': 'text', 'w/B': [{ text: 'b' }] };
  assert.deepEqual(Object.keys(ui.unpackSnapshot(JSON.stringify(odd)).threads), ['w/B']);
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

test('every page header leads with the logo or a back arrow, then the title, then disabled controls', () => {
  const logo = ui.header({ lead: 'logo', title: 'iOS <Orchestrator>' });
  assert.match(logo, /^<header class="top"><div class="brand"><a class="hub" href="\/_hub\/" aria-label="Boards"><img src="kickflip\.png" alt=""><\/a><h1>iOS &lt;Orchestrator&gt;<\/h1><\/div>/);
  assert.match(logo, /<button class="ghost spinning" id="refresh" type="button" disabled/);
  assert.match(logo, /<span class="muted" id="status">…<\/span>/);
  assert.match(logo, /<a href="settings\.html" id="settingsLink" class="ghost icon"[^>]*aria-disabled="true" tabindex="-1">/);
  assert.equal(text(logo), 'iOS <Orchestrator> …');

  const back = ui.header({ lead: 'back', backHref: '/', backLabel: 'Back to Claude', title: 'Settings', logoSrc: '/_hub/kickflip.png', settingsHref: '/_hub/settings', time: 'now' });
  assert.match(back, /^<header class="top"><div class="brand"><a class="back" href="\/" aria-label="Back to Claude"><svg width="24" height="24"[^>]*>.*?<\/svg><\/a><h1>Settings<\/h1><\/div>/);
  assert.doesNotMatch(back, /kickflip/);
  assert.match(back, /href="\/_hub\/settings" id="settingsLink"/);
  assert.match(back, /id="status">now</);

  const bare = ui.header({ lead: 'back', title: 'Waiting on you', titleId: 'gtitle', backId: 'back', controls: false, trail: '<span class="muted small" id="progress"></span>' });
  assert.match(bare, /<a class="back" href="\.\/" id="back" aria-label="Back to the board">/);
  assert.match(bare, /<h1 id="gtitle">Waiting on you<\/h1><\/div><span class="muted small" id="progress"><\/span><\/header><script>[\s\S]*<\/script>$/);
  assert.doesNotMatch(bare, /id="refresh"|settingsLink/);
  assert.doesNotMatch(logo, /<script>/);
});

test("the sidebar's head is the page header, whose logo and ✕ close it, then it lists the boards then the pages, marks this one, counts what waits on the others, and ends with the hub's rows", () => {
  const site = (route, board, count, sub = '') => ({ route, title: route.toUpperCase(), board, count, icon: `<i data-r="${route}"></i>`, sub });
  const data = {
    sites: [site('ios', true, 2, '<b>2 need you</b>'), site('learn', false, 1), site('shop', true, 0), site('hub', true, 3)],
    hub: { tone: 'ok', word: 'Healthy', detail: '4 of 4 sites up' }, notifications: { state: 'on', text: 'On' }, polling: { text: 'Every 15 min · next 4:45pm' },
  };
  const html = ui.sidebar(data, { here: 'ios', device: 'on' });
  assert.equal(text(html), 'Boards IOS 2 need you SHOP HUB New board Pages LEARN Hub Hub Healthy 4 of 4 sites up Settings Notifications, polling and rules');
  const foot = (html) => html.slice(html.indexOf('<div class="sb-foot">'));
  assert.deepEqual([...foot(html).matchAll(/href="([^"]+)"/g)].map((m) => m[1]), ['/_hub/', '/_hub/settings']);
  assert.match(html, /^<header class="top"><div class="brand"><a class="hub" href="\/_hub\/" aria-label="Hide boards" title="Hide boards" data-sidebar-close=""><img src="\/_hub\/kickflip\.png" alt=""><\/a><h2>Boards<\/h2><\/div><div class="nav"><button type="button" class="sb-close" data-sidebar-close aria-label="Close boards"><svg [^>]*>.*?<\/svg><\/button><\/div><\/header>/);
  assert.doesNotMatch(html, /<h1|id="refresh"|settingsLink/);
  assert.match(html, /<a class="sb-row on" href="\/ios\/" aria-current="page"><i data-r="ios"><\/i>/);
  assert.match(html, /href="\/_hub\/"[^>]*>.*Hub<\/span>/);
  assert.equal(ui.othersWaiting(data, 'ios'), 4);
  assert.equal(ui.othersWaiting(data, '_hub'), 6);
  for (const [device, notifications, status, urgent] of [
    ['off', data.notifications, 'Off on this device', true],
    ['blocked', data.notifications, 'Blocked on this device', true],
    ['on', { state: 'off', text: 'Off' }, 'Off', true],
    ['on', { state: 'held', text: 'Snoozed until 6pm' }, 'Snoozed until 6pm', false],
    ['on', { state: 'held', text: 'Off on weekends' }, 'Off on weekends', false],
  ]) {
    const settings = foot(ui.sidebar({ ...data, notifications }, { device }));
    assert.match(text(settings), new RegExp(`Settings ${status}$`));
    assert.equal(settings.includes('word t-needs'), urgent);
  }
  for (const here of ['_hub', '_hub/', '_hub/settings', '_hub/settings/polling']) {
    const selected = [...ui.sidebar(data, { here }).matchAll(/<a class="sb-row on" href="([^"]+)" aria-current="page"/g)].map((m) => m[1]);
    assert.deepEqual(selected, [here.startsWith('_hub/settings') ? '/_hub/settings' : '/_hub/'], here);
  }
  assert.match(ui.sidebar({ sites: [] }), /data-new-board aria-haspopup="dialog"/);
});

test('pending boards have muted non-link rows, failed starts can be dismissed, and New board stays last in Boards', () => {
  const data = { sites: [{ route: 'page', title: 'Page', board: false, icon: '' }], starting: [
    { route: 'new', title: 'Backend <audit>', failed: false }, { route: 'old', title: 'Old board', failed: true },
  ] };
  const html = ui.sidebar(data, { switching: true });
  assert.match(html, /<div class="sb-row sb-starting" data-starting="new">.*Starting….*Backend &lt;audit&gt; · Waiting for the board to answer/);
  assert.match(html, /data-starting="old">.*Didn't start.*data-dismiss-board="old"/);
  assert.doesNotMatch(html, /href="\/(new|old)\//);
  assert.ok(html.indexOf('data-starting="old"') < html.indexOf('data-new-board'));
  assert.ok(html.indexOf('data-new-board') < html.indexOf('>Pages<'));
  assert.deepEqual(plain(ui.switchKeys(data)).map((r) => r.href), ['/page/', '/_hub/', '/_hub/settings']);
});

test('pending board folders use home labels with a directory boundary and tolerate cached data without home', () => {
  const home = '/Users/you';
  for (const [repo, label] of [[`${home}/x`, '~/x'], [home, '~'], ['/opt/x', '/opt/x'], [`${home}2/x`, `${home}2/x`]]) {
    for (const failed of [false, true]) {
      const data = { home, sites: [], starting: [{ route: 'new', title: 'New', repo, failed }] };
      assert.ok(ui.sidebar(data).includes(`New · ${label}`));
      assert.ok(ui.sidebar({ ...data, home: undefined }).includes(`New · ${repo}`));
    }
  }
});

test("switch mode numbers the first nine boards in sidebar order, and gives every row a letter from its name, boards claiming first in the order they joined, so a new board moves only a page's or a Hub row's letter", () => {
  const site = (route, title, created, board = true) => ({ route, title, board, created, icon: '<span class="icon" style="--c:#000" aria-hidden="true"><svg></svg></span>' });
  const live = [site('backend-audit', 'Backend Audit', '2026-10-22T21:47:40Z'), site('hub-orchestrator', 'Hub Orchestrator', '2026-10-29T21:49:30Z'),
    site('ios-orchestrator', 'iOS Orchestrator', '2026-10-22T19:19:11Z'), site('learn', 'Sync V2.1 course', '2026-10-22T05:35:39Z', false),
    site('shipyard-orchestrator', 'Shipyard Orchestrator', '2026-10-23T20:06:41Z'), site('software-pipeline', 'Software Pipeline', '2026-10-30T09:00:00Z')];
  const keys = (sites) => plain(ui.switchKeys({ sites })).map((k) => [k.title, k.num ?? null, k.letter ?? null]);
  assert.deepEqual(keys(live), [
    ['Backend Audit', '1', 'b'], ['Hub Orchestrator', '2', 'h'], ['iOS Orchestrator', '3', 'i'], ['Shipyard Orchestrator', '4', 's'], ['Software Pipeline', '5', 'o'],
    ['Sync V2.1 course', null, 'y'], ['Hub', null, 'u'], ['Settings', null, 'e'],
  ]);

  const added = [...live.slice(0, 2), site('inkwell', 'Inkwell', '2026-10-30T10:00:00Z'), ...live.slice(2)];
  assert.deepEqual(keys(added), [
    ['Backend Audit', '1', 'b'], ['Hub Orchestrator', '2', 'h'], ['Inkwell', '3', 'n'], ['iOS Orchestrator', '4', 'i'], ['Shipyard Orchestrator', '5', 's'], ['Software Pipeline', '6', 'o'],
    ['Sync V2.1 course', null, 'y'], ['Hub', null, 'u'], ['Settings', null, 'e'],
  ]);

  const many = [site('a0', 'Zed One'), site('a1', 'Zed Two', '2026-10-21T00:00:00Z'), ...Array.from({ length: 8 }, (_, i) => site(`a${i + 2}`, `Q${i + 2}`, '2026-10-22T00:00:00Z'))];
  const k = keys(many);
  assert.deepEqual([k[0], k[1], k[2], k[9]], [['Zed One', '1', 'e'], ['Zed Two', '2', 'z'], ['Q2', '3', 'q'], ['Q9', null, null]]);

  const html = ui.sidebar({ sites: live }, { here: 'ios-orchestrator', device: 'off', switching: true });
  assert.match(html, /href="\/ios-orchestrator\/"[^>]*><span class="icon"[^>]*><svg><\/svg><span class="ks-key">3<\/span><\/span><span class="sb-text"><span class="sb-title"><span class="ks-u">i<\/span>OS Orchestrator</);
  assert.match(html, /href="\/learn\/"[^>]*><span class="icon"[^>]*><svg><\/svg><span class="ks-key">y<\/span><\/span><span class="sb-text"><span class="sb-title">S<span class="ks-u">y<\/span>nc V2\.1 course</);
  assert.match(html, /<span class="sb-title">S<span class="ks-u">e<\/span>ttings</);
  assert.match(text(html), /^Boards Turn on notifications Off on this device 1 B ackend Audit /);
  assert.match(html, /class="ks-hint"/);
  assert.doesNotMatch(ui.sidebar({ sites: live }, { here: 'ios-orchestrator' }), /ks-/);
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
    ['/_hub/', { kind: 'hub' }],
    ['/_hub/settings', { kind: 'hub-settings', hash: '' }],
    ['/_hub/settings#rules', { kind: 'hub-settings', hash: '#rules' }],
    ['/_hub/settings/polling', { kind: 'polling', w: null }],
    ['/_hub/settings/polling?w=09%3A00', { kind: 'polling', w: '09:00' }],
    ['/orch/prototype-sidebar.html?q=q1&from=push', { kind: 'frame', route: 'orch', url: '/orch/prototype-sidebar.html?q=q1&from=push' }],
    ['/orch/shots-gallery.html', { kind: 'frame', route: 'orch', url: '/orch/shots-gallery.html' }],
    ['/learn/', { kind: 'frame', route: 'learn', url: '/learn/' }],
    ['/learn/lessons/lesson-2.html#top', { kind: 'frame', route: 'learn', url: '/learn/lessons/lesson-2.html#top' }],
  ];
  for (const [url, view] of table) {
    assert.deepEqual(read(url), view, url);
    assert.equal(urlOf(view), url, url);
  }
  assert.deepEqual(read('/orch/plan.html?item=w%2FA1'), { kind: 'notes', route: 'orch', item: 'w/A1' });
  assert.deepEqual(read('/orch/questions.html?from=push#q-1'), { kind: 'questions', route: 'orch', id: 'q-1' });
  assert.deepEqual(read('/orch/notes.html?item=w%2FA1&from=push'), { kind: 'notes', route: 'orch', item: 'w/A1' });
  assert.equal(viewOf('https://elsewhere.example/orch/', { boards: new Set(['orch']), base }), null);
  for (const url of ['/orch/uploads/1-shot.png', '/orch/api/board', '/learn', '/_hub/kickflip.png', '/sw.js']) assert.equal(read(url), null, url);
  assert.deepEqual(table.filter(([, view]) => mounted(view)).map(([url]) => url),
    ['/orch/', '/orch/#item=w%2FA1&reply', '/orch/settings.html', '/orch/questions.html#q-1', '/orch/notes.html?item=w%2FA1',
      '/_hub/', '/_hub/settings', '/_hub/settings#rules', '/_hub/settings/polling', '/_hub/settings/polling?w=09%3A00',
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

test('the Action needed badge shows only while the card waits on the owner, and links to what they act on', () => {
  assert.equal(ui.actionChip({ questions: { open: 2, first: 'q1' }, action: null }), '');
  const pick = ui.actionChip({ action: { kind: 'pick', url: 'https://mac.ts.net/r/prototype-x.html?q=q1', label: 'Prototypes ready: pick a take' } });
  assert.match(pick, /^<a class="chip tone-notice" href="https:\/\/mac\.ts\.net\/r\/prototype-x\.html\?q=q1"[^>]*>Action needed<\/a>$/);
  assert.doesNotMatch(pick, /target=/);
  assert.match(ui.actionChip({ action: { kind: 'ready', url: 'https://github.com/o/r/pull/7', label: 'Tap Ready on GitHub' } }), /href="https:\/\/github\.com\/o\/r\/pull\/7"[^>]*target="_blank"/);
});

test('a thread message shows its text as written, never as markup', () => {
  const html = ui.threadMessages([{ ts: ago(1), who: 'claude', text: '<img src=x onerror=alert(1)> done' }]);
  assert.doesNotMatch(html, /<img/);
  assert.match(text(html), /<img src=x onerror=alert\(1\)> done/);
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
});

const takeCards = (html) => html.split('<article class="take"').slice(1);
const frames = (html) => [...html.matchAll(/<iframe src="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
const fullSize = (html) => [...html.matchAll(/<a class="take-open" href="([^"]*)">Open full size →<\/a>/g)].map((m) => m[1].replace(/&amp;/g, '&'));

const shots = (html) => [...html.matchAll(/<a class="(take-shot[^"]*)"[^>]*?(?: style="([^"]*)")?><iframe/g)].map((m) => [m[1], m[2] ?? '']);

test("a question on a prototype page sets its takes in one grid with no carousel, each its option over a frame hidden until measured, opening full size in place", () => {
  const proto = ui.questionCard({ ...question, url: 'prototype-hub-snooze.html?q=q1#top' }, { draft: { choice: 'B' } });
  assert.match(proto, /<div class="takes"><article class="take" data-opt="A"><label class="opt">[\s\S]*<\/label><a class="take-shot[\s\S]*<\/article><article class="take" data-opt="B">[\s\S]*<\/article><\/div>/);
  assert.doesNotMatch(proto, /take-track|take-dots|data-dot/);
  assert.deepEqual(takeCards(proto).map((t) => /\bchecked>/.test(t)), [false, true]);
  assert.deepEqual(frames(proto), ['prototype-hub-snooze.html?q=q1&take=A#top', 'prototype-hub-snooze.html?q=q1&take=B#top']);
  assert.match(proto, /<iframe [^>]*loading="lazy"/);
  assert.deepEqual(shots(proto), [['take-shot measuring', ''], ['take-shot measuring', '']]);
  assert.deepEqual(fullSize(proto), ['prototype-hub-snooze.html?q=q1&variant=A#top', 'prototype-hub-snooze.html?q=q1&variant=B#top']);
  assert.doesNotMatch(proto, /See the prototypes|target="_blank"|<label class="opt">[\s\S]*<label class="opt">[\s\S]*<label class="opt">/);
  context.location = { origin: 'https://mac.tail.ts.net', href: 'https://mac.tail.ts.net/orch/' };
  try {
    const absolute = ui.questionCard({ ...question, url: 'https://mac.tail.ts.net/orch/prototype-hub-snooze.html?q=q1' });
    assert.deepEqual(frames(absolute), ['https://mac.tail.ts.net/orch/prototype-hub-snooze.html?q=q1&take=A', 'https://mac.tail.ts.net/orch/prototype-hub-snooze.html?q=q1&take=B']);
    assert.doesNotMatch(absolute, /target="_blank"/);
    const elsewhere = ui.questionCard({ ...question, url: 'https://elsewhere.example/orch/prototype-hub-snooze.html?q=q1' });
    assert.deepEqual(takeCards(elsewhere), []);
    assert.match(elsewhere, /target="_blank"/);
  } finally { delete context.location; }
});

test('a measured take shows its frame at its page\'s height, and a take that scrolls shows only the full-width Open full size button', () => {
  const sizes = { A: { h: 214.4 }, B: { scrolls: true } };
  const proto = ui.questionCard({ ...question, url: 'prototype-hub-snooze.html?q=q1' }, { fit: (id) => sizes[id] });
  const [a, b] = takeCards(proto);
  assert.deepEqual(shots(a), [['take-shot', 'height:214px']]);
  assert.deepEqual(fullSize(a), ['prototype-hub-snooze.html?q=q1&variant=A']);
  assert.deepEqual([frames(b), fullSize(b)], [[], []]);
  assert.match(b, /<a class="take-full" href="prototype-hub-snooze\.html\?q=q1&amp;variant=B"><span class="go">Open full size →<\/span><span class="why">This take scrolls, so it opens full size\.<\/span><\/a><\/article>/);
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
  } finally { delete context.location; }
  const linear = ui.questionCard({ ...question, url: 'https://linear.app/acme/issue/INT-1' });
  assert.match(linear, /href="https:\/\/linear\.app\/acme\/issue\/INT-1" target="_blank"/);
  assert.match(text(linear), /INT-1 ↗/);
});

test('a resolved question says how it was resolved', () => {
  assert.match(text(ui.questionCard({ ...question, state: 'resolved', resolved: 'Kept it.' })), /Resolved: Kept it\. A new answer reopens it\./);
});

test('a topic pill is named by the card id its title starts with, else by its whole title', () => {
  assert.deepEqual(['INT-92: Hub home rows', 'B5: Lane chips', 'Release plan', 'INT-92 without a colon', 'Other'].map((title) => ui.topicName({ title })),
    ['INT-92', 'B5', 'Release plan', 'INT-92 without a colon', 'Other']);
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

test("a thread's Done shows on every card not in Done, orange while it clears an ask's Action needed, and a work card's reads Closing…, disabled, while it is sent or waits on the session", () => {
  const done = (it, sending) => { const html = ui.doneButton(it, sending); return html && [text(html), /disabled/.test(html)]; };
  assert.deepEqual(done({ key: 'ask:a1', kind: 'ask', finishable: true }), ['Done', false]);
  assert.deepEqual(done({ key: 'ask:a1', kind: 'ask', finishable: true }, true), ['Done', false]);
  assert.match(ui.doneButton({ key: 'ask:a1', kind: 'ask', finishable: true, resolvedBy: 'markDone' }), /^<button type="button" class="resolves"/);
  assert.doesNotMatch(ui.doneButton({ key: 'ask:a1', kind: 'ask', finishable: true }), /resolves/);
  assert.deepEqual(done({ key: 'w/A1', kind: 'work', finishable: true, closing: false }), ['Done', false]);
  assert.deepEqual(done({ key: 'w/A1', kind: 'work', finishable: true, closing: false }, true), ['Closing…', true]);
  assert.deepEqual(done({ key: 'w/A1', kind: 'work', finishable: true, closing: true }), ['Closing…', true]);
  assert.equal(done({ key: 'w/A1', kind: 'work', finishable: false }), '');
  assert.equal(done(undefined), '');
});

test("the open card's details list ends with Notes, Install and GitHub links in order, omitting links that do not apply; Notes has no summary or button, and a follow-up's Build is filled orange", () => {
  const css = fs.readFileSync(new URL('./public/style.css', import.meta.url), 'utf8');
  assert.match(css, /button\.build \{[^}]*background: var\(--color-notice\)/);

  const app = vm.createContext({ document: { addEventListener() {} }, CSS: { escape: (s) => s } });
  for (const file of ['ui.js', 'ui-links.js', 'ui-enums.js', 'ui-cards.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), app);
  const B = { on() {}, store: {}, state: { board: { items: [] } }, seen: {}, thread: () => '', links: (key) => app.BoardUI.linkContext([], key) };
  app.BoardView = { part: (fn) => fn(B) };
  vm.runInContext(fs.readFileSync(new URL('./public/app-cards.js', import.meta.url), 'utf8'), app);
  const open = { ...workCard, pr: null, reviewers: [], key: 'w/A1', action: null, waveTitle: 'W', deps: [], manualSteps: [], kind: 'work', holdable: true, hasNotes: true, notes: 'Old short note', summary: 'A stored summary' };
  const rows = (it) => [...B.detail(it).matchAll(/<dt[^>]*>(.*?)<\/dt><dd[^>]*>(.*?)<\/dd>/g)].map(([, k, v]) => [text(k), text(v)]);
  assert.deepEqual(rows(open), [['Wave', 'W'], ['Next', 'Waiting for PR reviewers'], ['Links', 'Notes ↗']]);
  assert.match(B.detail(open), /href="notes.html\?item=w%2FA1"/);
  assert.doesNotMatch(B.detail(open), /Old short note|A stored summary|view more|<summary[^>]*>Notes|class="actions"[^]*notes\.html/);
  assert.doesNotMatch(B.detail({ ...open, hasNotes: false }), /Notes|notes\.html/);
  const install = { url: 'https://m/app.apk', older: false };
  const pr = { state: 'OPEN', url: 'https://github.com/o/r/pull/1' };
  for (const hasNotes of [false, true]) {
    for (const build of [null, install]) {
      for (const state of ['OPEN', 'MERGED', 'CLOSED']) {
        const it = { ...open, hasNotes, install: build, pr: { ...pr, state } };
        const expected = [hasNotes && 'Notes ↗', build && 'Install ↗', state === 'OPEN' && 'Review on GitHub ↗'].filter(Boolean);
        assert.deepEqual(rows(it).filter(([label]) => label === 'Links'), expected.length ? [['Links', expected.join(' · ')]] : []);
        assert.match(B.detail(it), expected.length ? /<dd class="external-links">[^]*<\/dd><\/dl>/ : /<dd>Waiting for PR reviewers<\/dd><\/dl>/);
        assert.doesNotMatch(B.detail(it), /action-row external/);
      }
    }
  }
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

test("an open card waiting on the owner's Merge shows a Merge button that confirms first, and reads Merging…, disabled, while it is sent or waits on the session", () => {
  const merge = (it, sending) => { const html = ui.mergeButton(it, sending); return html && [text(html), /disabled/.test(html), /data-confirm="merge"/.test(html), /data-key="w\/A1"/.test(html)]; };
  const waiting = { key: 'w/A1', action: { kind: 'merge', url: '#item=w%2FA1', label: 'Merge' }, merging: false };
  assert.deepEqual(merge(waiting), ['Merge', false, true, true]);
  assert.deepEqual(merge(waiting, true), ['Merging…', true, true, true]);
  assert.deepEqual(merge({ key: 'w/A1', action: null, merging: true }), ['Merging…', true, true, true]);
  assert.equal(merge({ key: 'w/A1', action: { kind: 'steps', url: '#item=w%2FA1', label: 'Run the manual steps, then merge' }, merging: false }), '');
  assert.equal(merge({ key: 'w/A1', action: null, merging: false }), '');
  assert.equal(merge(undefined), '');
});

test('a thread message says Working on it while Claude works on it, and only a pending message can be deleted', () => {
  const html = ui.threadMessages([
    { ts: ago(3), who: 'love', via: 'site', kind: 'item-message', text: 'Fix it', eventId: 'e1', reply: null, state: 'working', canDelete: true },
    { ts: ago(2), who: 'love', via: 'site', kind: 'item-message', text: 'Old', eventId: 'e2', reply: null, state: 'answered', canDelete: false },
  ]);
  assert.match(text(html), /Fix it Working on it .* Old$/);
  assert.deepEqual([...html.matchAll(/data-withdraw="(\w+)"/g)].map((m) => m[1]), ['e1']);
});

test('a stalled builder adds a fault-tone button in the chip row and keeps its builder line', () => {
  const builder = { progress: 'Running tests', at: null, stalled: true };
  const html = ui.workLines({ ...workCard, builder });
  assert.match(html, /<div class="line2 meta"><button class="chip tone-danger"[^>]*type="button"[^>]*data-confirm="nudge"[^>]*data-key="w\/B5"[^>]*>Stalled<\/button>/);
  assert.match(html, /<div class="line3 sub agent"><span class="working-dot" aria-hidden="true"><\/span>Running tests<\/div>/);
  for (const next of [{ ...builder, stalled: false }, null]) assert.doesNotMatch(ui.workLines({ ...workCard, builder: next }), /Stalled|data-confirm="nudge"/);
});

test("a builder line shows the progress and its age, not who is building", () => {
  const at = new Date(Date.now() - 4 * 60000).toISOString();
  assert.equal(ui.builderLine({ label: 'Opus builder', progress: 'Running tests', at }), 'Running tests · 4m ago');
  assert.equal(ui.builderLine({ label: 'Opus builder', progress: null, at: null }), 'Building');
  assert.equal(ui.builderLine({ label: null, progress: 'Making changes', at: null }), 'Making changes');
});

test("a New card reads New and its first line, then when it was sent and whether Claude has started, with bump, edit and delete and no Action needed", () => {
  const card = (ask, extra = {}) => ui.workLines({ kind: 'ask', id: 'a1', key: 'ask:a1', ref: 'New', isNew: true, title: 'Fix <it>', linear: [], pr: null, deps: [], blockedBy: [],
    bumpedAt: ask.bumpedAt || null, ask: { askedAt: ago(1), bumpedAt: null, canEdit: true, text: 'Fix <it>\nand more', files: [], ...ask }, ...extra }, { top: Boolean(ask.bumpedAt) });
  assert.deepEqual(lines(card({ state: 'waiting' })).map((l, n) => (n === 1 ? l.split(' · ').slice(1).join(' · ') : l)), ['New Fix <it>', 'Waiting']);
  assert.deepEqual(lines(card({ state: 'working', bumpedAt: ago(0.5), edited: true })).map((l, n) => (n === 1 ? l.split(' · ').slice(1).join(' · ') : l)), ['New Fix <it>', 'Edited · Working on it', 'bumped']);
  assert.deepEqual([...card({ state: 'waiting' }).matchAll(/data-(bump|edit|withdraw)="a1"/g)].map((m) => m[1]), ['bump', 'edit', 'withdraw']);
  assert.match(card({ state: 'waiting', bumpedAt: ago(0.5) }), /data-bump="a1"[^>]* disabled/);
  assert.doesNotMatch(card({ state: 'waiting' }), /Action needed/);
  assert.deepEqual(lines(card({ state: 'answered' }, { isNew: false, ref: 'Task', working: false })), ['Task Fix <it>']);
  assert.match(lines(card({ state: 'waiting', from: 'Orch' }))[1], /^Moved from Orch · .+ · Waiting$/);
  const asked = card({ state: 'waiting' }, { next: 'Answer 1 question', action: { kind: 'questions', url: 'questions.html#mv', label: 'Answer 1 question' } });
  assert.deepEqual(lines(asked), ['New Fix <it>', 'Next: Answer 1 question', 'Action needed']);
});

test('a pending prototype request offers a bump unless it is already the latest bump', () => {
  assert.deepEqual({ ...ui.protoNotice('e1', 'e9') }, { text: 'Prototypes are being made. Bump them to the top of the queue?', bump: true });
  assert.deepEqual({ ...ui.protoNotice('e1', 'e1') }, { text: 'Prototypes are being made.', bump: false });
});

const lines = (html) => html.split('<div class="line').slice(1).map((l) => text('<div class="line' + l));
const workCard = { kind: 'work', key: 'w/B5', id: 'B5', ref: 'B5', title: 'Five', internal: false, held: false, risky: false, threadCount: 4,
  linear: [{ id: 'PROD-1', url: 'https://linear.app/x/PROD-1' }], pr: { ...openPR, isDraft: true }, reviewers: ['Jamie'], review: { Jamie: { state: 'unsent' } },
  questions: null, builder: null, working: false, next: 'Waiting for PR reviewers' };

test('a work card reads its title, then its next step or builder, its chips led by its unread messages, and last its Blocked by chips', () => {
  assert.deepEqual(lines(ui.workLines(workCard, { unread: 2 })), ['PROD-1 Five', 'Next: Waiting for PR reviewers', '2 new repo#7 ● CI ✓ J ✗']);
  assert.deepEqual(lines(ui.workLines({ ...workCard, next: null, pr: null, reviewers: [] }, { unread: 1 })), ['PROD-1 Five', '1 new']);
  assert.match(ui.workLines(workCard, { unread: 1 }), /<div class="line2 meta"><span class="chip unread"[^>]* aria-label="1 unread message">1 new<\/span>/);
  assert.match(ui.workLines(workCard, { unread: 3 }), /aria-label="3 unread messages">3 new</);
  assert.doesNotMatch(text(ui.workLines(workCard)), /B5|msg|unread/);
  const busy = { ...workCard, held: true, risky: true, builder: { progress: 'Running tests', at: null } };
  assert.deepEqual(lines(ui.workLines(busy)), ['PROD-1 Five', 'Running tests', 'repo#7 ● CI ✓ J ✗ held risky']);
  const internal = { ...workCard, key: 'site/S3', id: 'S3', ref: 'INT-3', internal: true, pr: null, linear: [{ id: 'PROD-9', url: 'u' }], next: null };
  assert.deepEqual(lines(ui.workLines(internal)), ['INT-3 Five']);
  assert.deepEqual(lines(ui.workLines({ ...workCard, questions: { open: 1, first: 'q1' }, action: { kind: 'questions', url: 'questions.html#q1', label: 'Answer 1 question' } })),
    ['PROD-1 Five', 'Next: Waiting for PR reviewers', 'Action needed repo#7 ● CI ✓ J ✗']);
  assert.deepEqual(lines(ui.workLines({ ...workCard, questions: { open: 1, first: 'q1' }, action: { kind: 'questions', url: 'questions.html#q1', label: 'Answer 1 question' } }, { unread: 3 })),
    ['PROD-1 Five', 'Next: Waiting for PR reviewers', '3 new Action needed repo#7 ● CI ✓ J ✗']);
  const blocked = { ...internal, lane: 'todo', deps: ['S1', 'S2'], blockedBy: [{ key: 'site/S2', ref: 'INT-2' }] };
  assert.deepEqual(lines(ui.workLines(blocked)), ['INT-3 Five', 'blocked by INT-2']);
  assert.match(ui.workLines(blocked), /href="#item=site%2FS2"/);
  assert.deepEqual(lines(ui.workLines({ ...blocked, blockedBy: [] })), ['INT-3 Five', 'ready to start']);
  assert.deepEqual(lines(ui.workLines({ ...blocked, blockedBy: [], next: 'Answer 1 question', action: { kind: 'questions', url: 'questions.html#q1', label: 'Answer 1 question' } })),
    ['INT-3 Five', 'Next: Answer 1 question', 'Action needed']);
  const waiting = { ...workCard, lane: 'todo', deps: ['S2'], blockedBy: [{ key: 'site/S2', ref: 'INT-2' }], bumpedAt: ago(1) };
  assert.deepEqual(lines(ui.workLines(waiting, { unread: 1 })), ['PROD-1 Five', 'Next: Waiting for PR reviewers', '1 new repo#7 ● CI ✓ J ✗ bumped', 'blocked by INT-2']);
  const ask = { kind: 'ask', key: 'ask:a1', id: 'a1', ref: 'Task', title: 'Fix it', internal: false, linear: [], pr: null, deps: [], blockedBy: [], working: true };
  assert.deepEqual(lines(ui.workLines(ask)), ['Task Fix it', 'Working on it']);
  assert.deepEqual(lines(ui.workLines(ask, { unread: 2 })), ['Task Fix it', 'Working on it', '2 new']);
  assert.deepEqual(lines(ui.workLines({ ...internal, waitsOn: 'checking', working: true, next: 'Verify it' })), ['INT-3 Five', 'Orchestrator review']);
  const followup = { ...workCard, kind: 'followup', key: 'w/PROD-7', id: 'PROD-7', ref: 'PROD-7', linear: [{ id: 'PROD-7', url: 'u' }], pr: null, reviewers: [], next: null, lane: 'todo', deps: [], blockedBy: [] };
  assert.deepEqual(lines(ui.workLines(followup)), ['PROD-7 Five', 'follow-up']);
  assert.match(ui.workLines(followup), /<a class="chip tone-normal" href="u"[^>]*>PROD-7<\/a>.*<span class="chip tone-quiet">follow-up<\/span>/s);
});

test('a Todo age uses muted secondary text on its own line below the title', () => {
  const card = { ...workCard, lane: 'todo', pr: null, reviewers: [], next: null };
  assert.deepEqual(lines(ui.workLines(card)), ['PROD-1 Five']);
  const html = ui.workLines({ ...card, todoAge: '3 days ago', held: true });
  assert.deepEqual(lines(html), ['PROD-1 Five', '3 days ago', 'held']);
  assert.match(html, /<div class="line1 title">.*Five<\/div>\s*<div class="line3 sub">3 days ago<\/div>/);
  assert.doesNotMatch(html, /tone-notice/);
});

test("a card with an install shows its Install link last among its badges, opening in place, and marks an older build", () => {
  const url = 'itms-services://?action=download-manifest&url=https://m/x/manifest.plist';
  const install = { url, label: null, builtAt: ago(2), sha: 'abc1234', older: false };
  const asking = { ...workCard, action: { kind: 'questions', url: 'questions.html#q1', label: 'Answer 1 question' }, install };
  assert.deepEqual(lines(ui.workLines(asking)), ['PROD-1 Five', 'Next: Waiting for PR reviewers', 'Action needed repo#7 ● CI ✓ J ✗ Install']);
  const html = ui.workLines({ ...workCard, install });
  assert.equal(lines(html)[2], 'repo#7 ● CI ✓ J ✗ Install');
  const link = /<a class="chip tone-ready" href="([^"]*)"[^>]*>Install<\/a>/.exec(html);
  assert.equal(link?.[1], url.replaceAll('&', '&amp;'));
  assert.doesNotMatch(link[0], /target=/);
  assert.match(ui.workLines({ ...workCard, install: { ...install, label: 'Install beta', older: true } }), /<a class="chip tone-quiet" href="[^"]*"[^>]*>Install beta · older build<\/a>/);
  assert.doesNotMatch(ui.workLines(workCard), /Install/);
});

test('the install chip and details link share rebuilding, first build, older build and current states', () => {
  const install = { url: 'https://m/app.apk', sha: 'abc1234', older: true };
  const building = { ...workCard, builder: { kind: 'install' } };
  for (const render of [ui.installChip, ui.installButton]) {
    const arrow = render === ui.installButton ? ' ↗' : '';
    assert.equal(render(workCard), '');
    const first = render(building);
    assert.equal(text(first), 'Building…');
    assert.match(first, /tone-notice/);
    assert.match(first, /aria-disabled="true"/);
    assert.doesNotMatch(first, /href=|data-install-confirm/);
    for (const older of [false, true]) {
      const rebuilding = render({ ...building, install: { ...install, older } });
      assert.equal(text(rebuilding), `Rebuilding…${arrow}`);
      assert.match(rebuilding, /tone-notice/);
      assert.match(rebuilding, /data-install-confirm="w\/B5"/);
      assert.match(rebuilding, /href="https:\/\/m\/app.apk"/);
    }
    for (const kind of ['opus', undefined]) {
      const older = render({ ...workCard, install, builder: kind ? { kind } : null });
      assert.match(older, /tone-quiet/);
      assert.equal(text(older), `Install · older build${arrow}`);
      assert.doesNotMatch(older, /data-install-confirm/);
      const current = render({ ...workCard, install: { ...install, older: false } });
      assert.match(current, /tone-ready/);
      assert.equal(text(current), `Install${arrow}`);
      assert.doesNotMatch(current, /target=|class="pill/);
    }
    assert.equal(render({ ...building, lane: 'done' }), '');
  }
});

test('Todo offers to plan a wave from its follow-ups once it holds two, with their keys', () => {
  const todo = [{ key: 'w/A1', kind: 'work' }, { key: 'w/PROD-1', kind: 'followup' }, { key: 'v/PROD-2', kind: 'followup' }];
  const html = ui.planButton(todo);
  assert.equal(/data-plan="([^"]*)"/.exec(html)[1], 'w/PROD-1 v/PROD-2');
  assert.equal(text(html), 'Plan a wave from these 2 follow-ups →');
  assert.equal(ui.planButton(todo.slice(0, 2)), '');
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
});

test("an open card's thread shows its newest 3 messages with the lines between them, every unread one when more are unread, a message being edited or waiting on Claude always, and Show more saying how many messages it hides", () => {
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

  const waiting = ui.threadMessages(msgs.map((m) => (m.eventId ? { ...m, state: 'waiting', reply: null } : m)), {}, new Map(), read);
  assert.deepEqual(shown(waiting).slice(0, 2), ['Two?', 'Opus builder started']);
  assert.equal(more(waiting), 'Show more · 1 previous message');
  const editing = ui.threadMessages(msgs, {}, new Map([['e1', { text: 'Two, edited' }]]), read);
  assert.deepEqual(shown(editing).slice(0, 2), ['Two?', 'Two.']);
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
  } finally { delete context.location; }
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
  { key: 'site/INT-56', wave: 'site', kind: 'followup', ref: 'INT-56', internal: true, linear: [{ id: 'INT-56' }], repo: null },
  { key: 'att/A1', wave: 'att', kind: 'work', ref: 'A1', internal: false, linear: [{ id: 'PROD-2310' }], repo: 'acme/app' },
  { key: 'att/A2', wave: 'att', kind: 'work', ref: 'A2', internal: false, linear: [], repo: 'acme/app' },
  { key: 'att/PROD-2467', wave: 'att', kind: 'followup', ref: 'PROD-2467', internal: false, linear: [{ id: 'PROD-2467' }], repo: 'acme/app' },
  { key: 'elig/A1', wave: 'elig', kind: 'work', ref: 'A1', internal: false, linear: [{ id: 'ENG-7' }], repo: 'o/r' },
  { key: 'ask:e9', wave: null, kind: 'ask', ref: 'Ask', internal: false, linear: [], repo: null },
];
const refLine = 'INT-54 shipped, INT-99 did not. PROD-2310, ENG-7 and PROD-2467 next, then A1. See acme/app#3116, app#3050, foo#4 and #2988, not #ffffff, #000000 or UTF-8. https://github.com/o/r/pull/1#issuecomment-2 and (https://x.test/a_(b)).';

test('a thread line links each ref the board knows to its card, Linear ids and PRs to their pages, and bare URLs, leaving the text as written', () => {
  const html = ui.threadMessages([{ ts: ago(1), who: 'claude', text: refLine }], ui.linkContext(boardItems, 'att/A1'));
  assert.deepEqual(anchors(html), [
    ['#item=site%2FS54', 'INT-54', false],
    ['https://linear.app/acme/issue/PROD-2310', 'PROD-2310', true],
    ['https://linear.app/acme/issue/ENG-7', 'ENG-7', true],
    ['#item=att%2FPROD-2467', 'PROD-2467', false],
    ['#item=att%2FA1', 'A1', false],
    ['https://github.com/acme/app/pull/3116', 'acme/app#3116', true],
    ['https://github.com/acme/app/pull/3050', 'app#3050', true],
    ['https://github.com/acme/app/pull/2988', '#2988', true],
    ['https://github.com/o/r/pull/1#issuecomment-2', 'https://github.com/o/r/pull/1#issuecomment-2', true],
    ['https://x.test/a_(b)', 'https://x.test/a_(b)', true],
  ]);
  assert.ok(shown(html).includes(refLine));
});

test("a bare #n links only in a thread whose item has a repo, and a wave's short id links only from that wave's cards", () => {
  const line = [{ ts: ago(1), who: 'claude', text: 'A1 and A2 wait on #2988' }];
  assert.deepEqual(anchors(ui.threadMessages(line, ui.linkContext(boardItems, 'elig/A1'))), [
    ['#item=elig%2FA1', 'A1', false], ['https://github.com/o/r/pull/2988', '#2988', true],
  ]);
  assert.deepEqual(anchors(ui.threadMessages(line, ui.linkContext(boardItems, 'site/S54'))), []);
  assert.deepEqual(anchors(ui.threadMessages(line, ui.linkContext(boardItems, 'ask:e9'))), []);
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
    { ts: ago(1), who: 'love', text: 'Is INT-56 filed?', eventId: 'e1', reply: { html: '<p>Yes, INT-56 &mdash; see PROD-2310.</p>' }, state: 'replied' },
  ], links);
  assert.deepEqual(anchors(html), [
    ['https://x.test/', 'INT-54 notes', false],
    ['#item=site%2FS54', 'INT-54', false],
    ['https://x.test/b?c=1&amp;d=2', 'https://x.test/b?c=1&d=2', true],
    ['#item=site%2FINT-56', 'INT-56', false],
    ['#item=site%2FINT-56', 'INT-56', false],
    ['https://linear.app/acme/issue/PROD-2310', 'PROD-2310', true],
  ]);
  assert.match(html, /&rarr; done<\/p><pre>INT-54<\/pre>/);
  assert.match(html, /INT-56<\/a> &mdash; see/);
});

test('a question card and a full plan link refs too, to the board page from another page', () => {
  const onPage = ui.linkContext(boardItems, 'site/S54', { base: './' });
  const q = { ...question, question: 'Keep INT-54?', context: 'See PROD-2310', state: 'replied', answers: [{ ts: ago(1), choice: 'A', note: 'Like INT-56', reply: { html: '<p>Done in INT-54</p>' } }] };
  assert.deepEqual(anchors(ui.questionCard(q, { links: onPage })), [
    ['./#item=site%2FS54', 'INT-54', false],
    ['https://linear.app/acme/issue/PROD-2310', 'PROD-2310', true],
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
});
