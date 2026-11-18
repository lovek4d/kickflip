import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { siteStatus, laneChips, readNeeds, sidebarSites, startRoute, hubHealth, holdNeeds, statusLine, sidebarPause, heldSite } from './home.mjs';

test('a failed needs read keeps the last good answer, still counted, and marks it stale only once it is 15 seconds old', () => {
  const good = { working: 1, count: 2, lanes: { review: 1, progress: 0, todo: 0 }, building: false };
  const first = holdNeeds(null, good, 1000, 1000);
  assert.equal(first.needs, good);
  const soon = holdNeeds(first.good, null, 0, 1000 + 14_999);
  assert.equal(soon.needs.count, 2);
  assert.equal(soon.needs.stale, undefined);
  const old = holdNeeds(first.good, null, 0, 1000 + 15_000);
  assert.equal(old.needs.count, 2);
  assert.equal(old.needs.stale, true);
  assert.equal(old.good, first.good);
  const back = holdNeeds(old.good, good, 99_000, 99_000);
  assert.equal(back.needs.stale, undefined);
  assert.equal(holdNeeds(null, null, 0, 5).needs, null);
});

test("a row's status line is data: its status, whether it is stale, and its chips", () => {
  const needs = { working: 1, count: 0, lanes: { review: 0, progress: 0, todo: 0 }, building: false, stale: true };
  assert.deepEqual(statusLine('up', needs, 'listening'), { status: { shape: 'pulse', colour: 'orange', word: 'working' }, stale: true, chips: [] });
  assert.equal(statusLine('up', { ...needs, stale: undefined }, 'listening').stale, false);
  assert.equal(statusLine('up', null, 'listening'), null, 'nothing to say');
});

test('the status word is the most urgent of down, not listening, starting, working, waking, asleep and implementing, every word lowercase', () => {
  const up = { state: 'up', working: 1, count: 2, lanes: { review: 1, progress: 0, todo: 0 }, building: true };
  const word = (s) => siteStatus(s)?.word ?? null;
  assert.equal(word({ ...up, state: 'down', listen: 'deaf' }), 'down');
  assert.equal(word({ ...up, state: 'starting', listen: 'deaf' }), 'not listening');
  assert.equal(word({ ...up, listen: 'deaf' }), 'not listening');
  assert.deepEqual(siteStatus({ state: 'up', listen: 'deaf' }), { shape: 'dot', colour: 'red', word: 'not listening' });
  assert.equal(word({ ...up, listen: 'listening' }), 'working');
  assert.equal(word({ ...up, listen: 'asleep' }), 'working');
  assert.equal(word({ ...up, count: 0, listen: 'asleep' }), 'working');
  assert.deepEqual(siteStatus({ ...up, working: 0, count: 0, listen: 'asleep' }), { shape: 'dot', colour: 'grey', word: 'asleep' });
  assert.deepEqual(siteStatus({ ...up, working: 0, count: 0, listen: 'waking' }), { shape: 'dot', colour: 'grey', word: 'waking…' });
  assert.equal(word({ ...up, listen: 'waking' }), 'working');
  assert.equal(word({ ...up, state: 'down' }), 'down');
  assert.equal(word({ ...up, state: 'starting' }), 'starting');
  assert.equal(word(up), 'working');
  assert.equal(word({ state: 'stopped', count: 3 }), 'stopped', 'need you is a chip, so it no longer hides starting or stopped');
  assert.equal(word({ ...up, count: 0 }), 'working');
  assert.equal(word({ ...up, working: 0, count: 0 }), 'implementing');
  assert.equal(word({ ...up, working: 0, count: 0, building: false }), null);
  assert.equal(word({ state: 'up' }), null);
  const look = (s) => `${s.shape} ${s.colour}`;
  assert.deepEqual(
    ['down', 'starting', 'stopped'].map((state) => look(siteStatus({ state }))).concat(look(siteStatus(up)), look(siteStatus({ state: 'up', building: true }))),
    ['dot red', 'dot orange', 'dot grey', 'pulse orange', 'dot orange'],
  );
});

test("a course page's row reads its lesson count, green, once it has a lesson, and a fault still reads first", () => {
  assert.deepEqual(siteStatus({ state: 'up', lessons: 1 }), { shape: 'dot', colour: 'green', word: '1 lesson' });
  assert.deepEqual(siteStatus({ state: 'up', lessons: 3 }), { shape: 'dot', colour: 'green', word: '3 lessons' });
  assert.equal(siteStatus({ state: 'up', lessons: 0 }), null);
  assert.equal(siteStatus({ state: 'down', lessons: 3 }).word, 'down');
  const [row] = sidebarSites([{ route: 'rust', title: 'Rust', state: 'up', lessons: 2 }], new Map(), new Set());
  assert.deepEqual(row.sub, { status: { shape: 'dot', colour: 'green', word: '2 lessons' }, stale: false, chips: null });
});

test('lane chips list review, doing and todo, leaving out zero counts', () => {
  assert.deepEqual(laneChips({ review: 2, progress: 1, todo: 10 }), [
    { lane: 'review', text: '2 review' }, { lane: 'progress', text: '1 doing' }, { lane: 'todo', text: '10 todo' },
  ]);
  assert.deepEqual(laneChips({ review: 0, progress: 3, todo: 0 }), [{ lane: 'progress', text: '3 doing' }]);
  assert.deepEqual(laneChips({ review: 0, progress: 0, todo: 0 }), []);
  assert.equal(laneChips(null), null);
});

test("a site's needs answer may leave out lanes and building", () => {
  assert.deepEqual(readNeeds({ items: [{ kind: 'Question' }, { kind: 'Question' }], working: 1 }), {
    count: 2, working: 1, summary: '2 waiting: Question', lanes: null, building: false,
  });
  assert.deepEqual(readNeeds({ items: [], working: 0, summary: '', lanes: { review: 1, progress: 2, todo: 0 }, building: true }), {
    count: 0, working: 0, summary: '', lanes: { review: 1, progress: 2, todo: 0 }, building: true,
  });
  assert.equal(readNeeds({ items: [], lanes: { review: 'many' } }).lanes, null);
  assert.equal(readNeeds({ working: 1 }), null);
});

test("the sidebar's rows carry each site's icon, status line and count, and mark which are boards", () => {
  const rows = [
    { route: 'ios', title: 'iOS', state: 'up', icon: 'phone', color: '#3b82f6', changedAt: 5, created: '2026-10-22T19:19:11.878Z' },
    { route: 'learn', title: 'Course', state: 'up', changedAt: 9 },
    { route: 'gone', title: 'Gone', state: 'down' },
  ];
  const waiting = new Map([['ios', readNeeds({ items: [{ kind: 'Question' }], lanes: { review: 1, progress: 0, todo: 2 } })], ['learn', null]]);
  const [ios, learn, gone] = sidebarSites(rows, waiting, new Set(['ios', 'gone']));
  const [deaf] = sidebarSites(rows, waiting, new Set(['ios', 'gone']), new Map([['ios', 'deaf']]));
  assert.deepEqual(deaf.sub, { status: { shape: 'dot', colour: 'red', word: 'not listening' }, stale: false,
    chips: [{ lane: 'needs', text: '1 need you' }, { lane: 'review', text: '1 review' }, { lane: 'todo', text: '2 todo' }] });
  assert.deepEqual([ios.board, learn.board, gone.board], [true, false, true]);
  assert.deepEqual([ios.count, learn.count, gone.count], [1, 0, 0]);
  assert.deepEqual([ios.created, learn.created], ['2026-10-22T19:19:11.878Z', null]);
  assert.match(ios.icon, /data-icon="phone"/);
  assert.deepEqual(ios.sub, { status: null, stale: false, chips: deaf.sub.chips });
  assert.equal(learn.sub, null);
  assert.equal(gone.sub.status.word, 'down');
  const ctx = { percent: 62, at: '2026-11-03T10:00:00.000Z' };
  const [withCtx, without] = sidebarSites(rows, waiting, new Set(['ios', 'gone']), new Map(), new Map([['ios', ctx]]));
  assert.deepEqual(withCtx.ctx, { ...ctx, full: false });
  assert.equal(without.ctx, null);
});

test("a board's ctx is full from 90%", () => {
  const rows = [{ route: 'a', title: 'A', state: 'up' }];
  const full = (percent) => sidebarSites(rows, new Map(), new Set(['a']), new Map(), new Map([['a', { percent, at: 'x' }]]))[0].ctx.full;
  assert.deepEqual([full(89.9), full(90)], [false, true]);
});

test('the sidebar pause marks the host busy after a minute with no usage pause, and the banner after 30 minutes', () => {
  const now = Date.parse('2026-11-15T12:00:00.000Z');
  const gate = (state, since) => ({ state, machine: since ? { state: 'busy', reason: 'load high', since: new Date(now - since).toISOString() } : { state: 'normal' } });
  const flags = (g) => { const { busy, banner } = sidebarPause(g, now).machine; return [busy, banner]; };
  assert.deepEqual(flags(gate('normal', 0)), [false, false]);
  assert.deepEqual(flags(gate('normal', 59_000)), [false, false]);
  assert.deepEqual(flags(gate('normal', 60_000)), [true, false]);
  assert.deepEqual(flags(gate('normal', 30 * 60_000)), [true, false]);
  assert.deepEqual(flags(gate('normal', 30 * 60_000 + 1)), [true, true]);
  assert.deepEqual(flags(gate('paused', 40 * 60_000)), [false, false]);
});

test("a board row reads grey paused under the hub's pause or its own, unless a red fault is on it", () => {
  const site = (colour) => ({ route: 'a', board: true, sub: { status: colour && { shape: 'dot', colour, word: 'w' }, stale: true, chips: [{ lane: 'todo', text: '1 todo' }] } });
  const paused = { shape: 'dot', colour: 'grey', word: 'paused' };
  assert.deepEqual(heldSite(site('orange'), true, null).sub, { stale: true, chips: [{ lane: 'todo', text: '1 todo' }], status: paused });
  assert.deepEqual(heldSite({ route: 'a', board: true, sub: null }, true, null).sub, { stale: false, chips: null, status: paused });
  assert.deepEqual(heldSite(site(null), false, { state: 'paused' }).sub.status, paused);
  assert.equal(heldSite(site('red'), true, null).sub.status.word, 'w');
  assert.equal(heldSite(site('orange'), false, null).sub.status.word, 'w');
  assert.equal(heldSite(site('orange'), false, { state: 'going' }).sub.status.word, 'w');
  assert.deepEqual(heldSite(site('orange'), false, { state: 'going' }).pause, { state: 'going' });
  assert.equal(heldSite({ ...site('orange'), board: false }, true, null).sub.status.word, 'w');
});

test('a board not listening with its context at 95% or more reads context full; listening, or below 95%, it does not', () => {
  const rows = [{ route: 'orch', title: 'Orchestrator', state: 'up' }];
  const word = (listen, percent) => sidebarSites(rows, new Map(), new Set(['orch']), new Map([['orch', listen]]), new Map([['orch', { percent, at: '2026-11-03T22:14:22.000Z' }]]))[0].sub?.status.word;
  assert.deepEqual(sidebarSites(rows, new Map(), new Set(['orch']), new Map([['orch', 'deaf']]), new Map([['orch', { percent: 97.6 }]]))[0].sub,
    { status: { shape: 'dot', colour: 'red', word: 'context full' }, stale: false, chips: null });
  assert.equal(word('deaf', 95), 'context full');
  assert.equal(word('deaf', 94.9), 'not listening');
  assert.notEqual(word('listening', 99), 'context full');
  assert.equal(word('asleep', 99), 'asleep');
});

test('a first visit opens the board with the most waiting, the most recently changed among equals, and never a site that is not a board', () => {
  const site = (route, count, changedAt, board = true) => ({ route, count, changedAt, board });
  assert.equal(startRoute([site('a', 1, 1), site('b', 3, 0), site('c', 3, 2), site('page', 9, 9, false)]), 'c');
  assert.equal(startRoute([site('a', 0, 1), site('b', 0, 4)]), 'b');
  assert.equal(startRoute([site('page', 0, 0, false)]), null);
  assert.equal(startRoute([]), null);
});

test('a sidebar site row carries its board listen state, for the logo dot', () => {
  const rows = [{ route: 'a', title: 'A', state: 'up' }, { route: 'p', title: 'P', state: 'up' }];
  const sites = sidebarSites(rows, new Map(), new Set(['a']), new Map([['a', 'deaf']]));
  assert.equal(sites[0].listen, 'deaf');
  assert.equal(sites[1].listen, undefined, 'a page is not a board');
});

test('the hub reads red only while a site is down, amber degraded while a board link stays broken, and not while one settles', () => {
  const sites = [{ route: 'a', state: 'up' }, { route: 'b', state: 'up' }, { route: 'c', state: 'starting' }];
  assert.deepEqual(hubHealth(sites, new Map([['a', [{ link: 'events', state: 'settling' }]]])), { tone: 'ok', word: 'healthy', detail: '' });
  const failing = new Map([['b', [{ link: 'github', state: 'ok' }, { link: 'events', state: 'broken' }]]]);
  assert.deepEqual(hubHealth(sites, failing), { tone: 'wait', word: 'degraded', detail: '2 of 3 sites up · 1 link failing' });
  failing.set('a', [{ link: 'wakes', state: 'broken' }]);
  assert.equal(hubHealth(sites, failing).detail, '2 of 3 sites up · 2 links failing');
  assert.deepEqual(hubHealth([...sites, { route: 'd', state: 'down' }], failing), { tone: 'down', word: '1 site down', detail: '2 of 4 sites up · 2 links failing' });
  assert.equal(hubHealth([...sites, { route: 'd', state: 'down' }, { route: 'e', state: 'down' }]).word, '2 sites down');
});

test('the hub reads healthy while every site is up and no link fails, whatever code it runs', () => {
  const sites = [{ route: 'a', state: 'up' }, { route: 'b', state: 'up' }];
  assert.deepEqual(hubHealth(sites, new Map()), { tone: 'ok', word: 'healthy', detail: '' });
});

test('a stale row lays out like a fresh one: no wrapper, so the chips stay first in the one flex line', () => {
  const css = fs.readFileSync(new URL('../board/public/sidebar.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.held\b/);
  assert.match(css, /\.sidebar \.sb-status \{[^}]*display: flex/);
  assert.match(css, /\.sidebar \.lcs \{[^}]*order: -1/);
});
