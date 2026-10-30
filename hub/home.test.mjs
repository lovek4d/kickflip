import test from 'node:test';
import assert from 'node:assert/strict';
import { siteStatus, laneChips, readNeeds, sidebarSites, startRoute, hubHealth } from './home.mjs';

test('the status word is the most urgent of down, not listening, starting, working, need you, asleep and building', () => {
  const up = { state: 'up', working: 1, count: 2, lanes: { review: 1, progress: 0, todo: 0 }, building: true };
  const word = (s) => siteStatus(s)?.word ?? null;
  assert.equal(word({ ...up, state: 'down', listen: 'deaf' }), 'Down');
  assert.equal(word({ ...up, state: 'starting', listen: 'deaf' }), 'Not listening');
  assert.equal(word({ ...up, listen: 'deaf' }), 'Not listening');
  assert.equal(siteStatus({ state: 'up', listen: 'deaf' }).tone, 'down');
  assert.equal(word({ ...up, listen: 'listening' }), 'Working');
  assert.equal(word({ ...up, listen: 'asleep' }), 'Working');
  assert.equal(word({ ...up, working: 0, listen: 'asleep' }), '2 need you');
  assert.deepEqual(siteStatus({ ...up, working: 0, count: 0, listen: 'asleep' }), { tone: 'asleep', word: 'Asleep' });
  assert.equal(word({ ...up, state: 'down' }), 'Down');
  assert.equal(word({ ...up, state: 'starting' }), 'Starting');
  assert.equal(word(up), 'Working');
  assert.equal(word({ ...up, working: 0 }), '2 need you');
  assert.equal(word({ ...up, working: 0, count: 0 }), 'Building');
  assert.equal(word({ ...up, working: 0, count: 0, building: false }), null);
  assert.equal(word({ state: 'up' }), null);
  assert.deepEqual(
    ['down', 'starting'].map((state) => siteStatus({ state }).tone).concat(siteStatus(up).tone, siteStatus({ state: 'up', count: 1 }).tone, siteStatus({ state: 'up', building: true }).tone),
    ['down', 'starting', 'working', 'needs', 'building'],
  );
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
  assert.match(deaf.sub, /^<span class="dot t-down" aria-hidden="true"><\/span><span class="word t-down">Not listening<\/span><span class="lcs"><span class="lc lc-review">1 review<\/span><span class="lc lc-todo">2 todo<\/span><\/span>$/);
  assert.deepEqual([ios.board, learn.board, gone.board], [true, false, true]);
  assert.deepEqual([ios.count, learn.count, gone.count], [1, 0, 0]);
  assert.deepEqual([ios.created, learn.created], ['2026-10-22T19:19:11.878Z', null]);
  assert.match(ios.icon, /data-icon="phone"/);
  assert.match(ios.sub, /1 need you.*1 review.*2 todo/);
  assert.equal(learn.sub, '');
  assert.match(gone.sub, />Down</);
});

test('a first visit opens the board with the most waiting, the most recently changed among equals, and never a site that is not a board', () => {
  const site = (route, count, changedAt, board = true) => ({ route, count, changedAt, board });
  assert.equal(startRoute([site('a', 1, 1), site('b', 3, 0), site('c', 3, 2), site('page', 9, 9, false)]), 'c');
  assert.equal(startRoute([site('a', 0, 1), site('b', 0, 4)]), 'b');
  assert.equal(startRoute([site('page', 0, 0, false)]), null);
  assert.equal(startRoute([]), null);
});

test('the hub reads broken while a site is down or a board link stays broken, not while one settles', () => {
  const sites = [{ route: 'a', state: 'up' }, { route: 'b', state: 'up' }, { route: 'c', state: 'starting' }];
  assert.deepEqual(hubHealth(sites, { a: [{ link: 'events', state: 'settling' }] }), { tone: 'ok', word: 'Healthy', detail: '2 of 3 sites up', broken: [] });
  const bad = hubHealth([...sites, { route: 'd', state: 'down' }], { b: [{ link: 'github', state: 'ok' }, { link: 'events', state: 'broken' }] });
  assert.deepEqual([bad.tone, bad.word, bad.broken], ['down', '2 broken', ['b', 'd']]);
});
