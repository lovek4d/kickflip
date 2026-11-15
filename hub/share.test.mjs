// docs/adr/2026-11-05-2215-a-board-is-shared-view-only-with-a-tailscale-login.md
// docs/adr/2026-11-05-1912-a-shared-person-is-view-or-full.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shareOf, shareEntries, sharedRoutes, shareReach, routeOfPath, sharedSidebar, shareTracker, validLogin } from './share.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

const tmp = () => fs.realpathSync(tempDir('share-'));
const boardSite = (dir) => ({ cmd: ['node', '/x/board/server.mjs'], dir, port: 1 });

test('a login is kept exactly as Tailscale sends it, and board.json share lists each once', () => {
  assert.equal(validLogin('maya@github'), true);
  assert.equal(validLogin('sam.lee@example.com'), true);
  for (const bad of ['maya', 'a b@github', '@github', 'x@', 42, null, 'a@'.padEnd(201, 'b')]) assert.equal(validLogin(bad), false, String(bad));
  assert.deepEqual(shareOf({ share: ['maya@github', 'maya@github', 'nope', 'Sam@Example.com'] }), ['maya@github', 'Sam@Example.com']);
  assert.deepEqual(shareOf({}), []);
});

test('a share entry is a bare login for View, or {login, level: full}; shareOf lists every login', () => {
  const cfg = { share: ['maya@github', { login: 'sam@example.com', level: 'full' }, { login: 'kim@github', level: 'view' }, { login: 'maya@github', level: 'full' }, { login: 'nope' }, { level: 'full' }, 7] };
  assert.deepEqual(shareEntries(cfg), [{ login: 'maya@github', level: 'view' }, { login: 'sam@example.com', level: 'full' }, { login: 'kim@github', level: 'view' }]);
  assert.deepEqual(shareOf(cfg), ['maya@github', 'sam@example.com', 'kim@github']);
  assert.deepEqual(shareEntries({}), []);
});

test("a login reaches the boards whose board.json shares with it, read afresh on each ask", (t) => {
  const home = tmp();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const write = (route, cfg) => { fs.mkdirSync(path.join(home, route), { recursive: true }); fs.writeFileSync(path.join(home, route, 'board.json'), JSON.stringify(cfg)); };
  write('a', { share: ['maya@github'] });
  write('b', { share: ['sam@example.com'] });
  const sites = { a: boardSite(path.join(home, 'a')), b: boardSite(path.join(home, 'b')), page: { port: 2, dir: path.join(home, 'a') } };
  assert.deepEqual([...sharedRoutes('maya@github', sites)], [['a', 'view']]);
  assert.deepEqual([...sharedRoutes('nobody@github', sites)], []);
  write('b', { share: ['sam@example.com', { login: 'maya@github', level: 'full' }] });
  assert.deepEqual([...sharedRoutes('maya@github', sites)], [['a', 'view'], ['b', 'full']]);
});

test('a shared person reads the shell and their boards, and nothing else; a write is view only', () => {
  const routes = new Map([['orch', 'view']]);
  const reach = (pathname, method = 'GET') => shareReach({ method, pathname, routes });
  for (const p of ['/', '/sw.js', '/manifest.webmanifest', '/favicon.ico', '/_hub/app/app.js', '/_hub/colors.css', '/_hub/kickflip.png', '/_hub/icon-180.png',
    '/_hub/sidebar.json', '/_hub/stream', '/orch', '/orch/', '/orch/api/board', '/orch/api/thread', '/orch/notes.html', '/orch/questions.html', '/orch/uploads/x.png',
    '/orch/style.css', '/orch/prototype-kit.js', '/orch/prototype-nav.html', '/orch/prototypes/nav/GH-1.js', '/orch/api/done']) {
    assert.equal(reach(p), 'pass', p);
  }
  assert.equal(reach('/orch/api/board', 'HEAD'), 'pass');
  for (const p of ['/_hub', '/_hub/', '/_hub/settings']) assert.equal(reach(p), 'home', p);
  for (const p of ['/other/', '/other/api/board', '/_hub/api/hub', '/_hub/api/settings', '/_hub/status.json', '/_hub/needs.json', '/_hub/share/orch', '/_hub/close-board/orch', '/_hub/repos']) {
    assert.equal(reach(p), 'other', p);
  }
  // Only what a shared view reads passes: the owner's reads, anything unlisted, and a path naming the route again don't.
  for (const p of ['/orch/settings.html', '/orch/api/settings', '/orch/api/permissions', '/orch/api/rules', '/orch/api/reviewer-people', '/orch/api/log', '/orch/api/transcript', '/orch/api/try/main/log',
    '/orch/log.html', '/orch/api/stream', '/orch/_claude/events', '/orch/_claude/needs', '/orch/socket', '/orch//api/log', '/orch/orch/api/board', '/orch/orch',
    '/orch/api%2flog', '/orch/%2e%2e/api/log', '/orch/api/board/x']) {
    assert.equal(reach(p), 'view-only', p);
  }
  for (const [method, p] of [['POST', '/orch/api/read'], ['POST', '/orch/_claude/events'], ['POST', '/_hub/presence'], ['POST', '/_hub/push/subscribe'], ['DELETE', '/orch/x'], ['PUT', '/']]) {
    assert.notEqual(reach(p, method), 'pass', `${method} ${p}`);
  }
  assert.equal(reach('/orch/api/read', 'POST'), 'view-only');
  assert.equal(reach('/_hub/presence', 'POST'), 'other');
});

test("a Full person's board passes their event and upload POSTs, and nothing else they write", () => {
  const routes = new Map([['orch', 'full'], ['look', 'view']]);
  const reach = (pathname, method = 'POST') => shareReach({ method, pathname, routes });
  for (const p of ['/orch/_claude/events', '/orch/api/upload']) assert.equal(reach(p), 'pass', p);
  assert.equal(reach('/orch/api/board', 'GET'), 'pass');
  for (const p of ['/look/_claude/events', '/look/api/upload', '/orch/api/share', '/orch/api/settings', '/orch/api/rules', '/orch/api/permissions', '/orch/api/read',
    '/orch/api/hide', '/orch/api/try', '/orch/api/arch-review', '/orch/orch/_claude/events', '/orch/_claude/events/x']) {
    assert.equal(reach(p), 'view-only', p);
  }
  // Reading the event log stays the owner's at every level.
  assert.equal(reach('/orch/_claude/events', 'GET'), 'view-only');
  for (const [method, p] of [['PUT', '/orch/_claude/events'], ['DELETE', '/orch/api/upload']]) assert.equal(reach(p, method), 'view-only', `${method} ${p}`);
  assert.equal(reach('/_hub/presence'), 'other');
});

test("the route a path names, for a refusal's board", () => {
  assert.equal(routeOfPath('/orch/api/board'), 'orch');
  assert.equal(routeOfPath('/orch'), 'orch');
  assert.equal(routeOfPath('/'), null);
  assert.equal(routeOfPath('/_hub/'), null);
  assert.equal(routeOfPath('/sw.js'), null);
});

test("a shared person's sidebar lists only their boards, without the owner's counts, context, usage or hub row", () => {
  const data = { code: 'abc', total: 4, start: 'mine', away: true, usage: { claude: {} }, hub: { tone: 'ok' }, notifications: { state: 'on' }, starting: [{ route: 'new' }],
    sites: [{ route: 'mine', title: 'Mine', board: true, count: 3, ctx: { percent: 40 }, sub: 'listening', icon: 'i' }, { route: 'orch', title: 'Orch', board: true, count: 1, sub: 'idle', icon: 'j' }] };
  assert.deepEqual(sharedSidebar(data, new Map([['orch', 'view']]), 'Love'), {
    code: 'abc', total: 0, start: 'orch', starting: [], shared: { by: 'Love', full: [] },
    sites: [{ route: 'orch', title: 'Orch', board: true, sub: 'idle', icon: 'j' }],
  });
  // The boards they have Full on, for the shell to follow.
  assert.deepEqual(sharedSidebar(data, new Map([['mine', 'full'], ['orch', 'view']]), 'Love').shared, { by: 'Love', full: ['mine'] });
});

test('the tracker keeps last seen per board across restarts, viewing now while their stream is open on that board, and who was just refused', (t) => {
  const home = tmp();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'share-seen.json');
  let clock = Date.parse('2026-11-05T10:00:00Z');
  const tracker = shareTracker({ file, now: () => clock });
  tracker.visit('maya@github', 'Maya Ortiz', null);
  assert.deepEqual(tracker.people('orch', ['maya@github', 'sam@example.com']), [
    { login: 'maya@github', name: 'Maya Ortiz', now: false, at: null },
    { login: 'sam@example.com', name: null, now: false, at: null },
  ]);
  const done = tracker.watching('maya@github');
  tracker.visit('maya@github', 'Maya Ortiz', 'orch');
  assert.deepEqual(tracker.people('orch', ['maya@github'])[0], { login: 'maya@github', name: 'Maya Ortiz', now: true, at: '2026-11-05T10:00:00.000Z' });
  assert.equal(tracker.people('other', ['maya@github'])[0].now, false, 'viewing now is for the board they last opened');
  done();
  assert.equal(tracker.people('orch', ['maya@github'])[0].now, false);
  // A later visit within a minute moves the time in memory; the file keeps up at most once a minute.
  clock += 30_000;
  tracker.visit('maya@github', 'Maya Ortiz', 'orch');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))['maya@github'].at.orch, '2026-11-05T10:00:00.000Z');
  assert.equal(tracker.people('orch', ['maya@github'])[0].at, '2026-11-05T10:00:30.000Z');
  clock += 60_000;
  tracker.visit('maya@github', 'Maya Ortiz', 'orch');
  const again = shareTracker({ file, now: () => clock });
  assert.deepEqual(again.people('orch', ['maya@github']), [{ login: 'maya@github', name: 'Maya Ortiz', now: false, at: '2026-11-05T10:01:30.000Z' }]);

  // Refusals at the board's paths or at none, newest first, once per login, for an hour, and not once shared.
  tracker.refuse('jo@github', 'Jo Park', 'orch');
  clock += 1000;
  tracker.refuse('lee@example.com', null, null);
  tracker.refuse('kim@github', 'Kim', 'elsewhere');
  clock += 1000;
  tracker.refuse('jo@github', 'Jo Park', 'orch');
  assert.deepEqual(tracker.refusals('orch', []), [
    { login: 'jo@github', name: 'Jo Park', at: '2026-11-05T10:01:32.000Z' },
    { login: 'lee@example.com', name: null, at: '2026-11-05T10:01:31.000Z' },
  ]);
  assert.deepEqual(tracker.refusals('orch', ['jo@github']).map((r) => r.login), ['lee@example.com']);
  clock += 60 * 60_000;
  assert.deepEqual(tracker.refusals('orch', []).map((r) => r.login), ['jo@github']);
  clock += 2000;
  assert.deepEqual(tracker.refusals('orch', []), []);
});
