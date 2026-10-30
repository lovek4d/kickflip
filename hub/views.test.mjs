import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, windowAt, hold, flushAt } from './schedule.mjs';
import { hubView, settingsView, pollingView, pollLine, siteHealth, flushView } from './views.mjs';

const t = (h, m = 0, day = 14, s = 0) => new Date(2026, 9, day, h, m, s);
const ON = { on: true, weekends_off: false, snoozed_until: null };
const win = (...pairs) => ({ windows: pairs.map(([from, every_minutes]) => ({ from, every_minutes })), hold_overnight: true, wakes: ['08:00', '09:00'], notifications: ON });
const notify = (s, n) => ({ ...s, notifications: { ...ON, ...n } });
const status = (now, s, count = 0) => ({ settings: s, window: windowAt(now, s), hold: hold(now, s), count, nextFlushAt: count ? flushAt(now, s) : null });
const poll = (now, last = null) => ({ running: false, nextAt: new Date(now.getTime() + 30 * 60_000), last });
const plain = (v) => JSON.parse(JSON.stringify(v));

test('pollLine says when the next check runs and what the last one found', () => {
  const now = t(19);
  assert.equal(pollLine(poll(now), now), 'Next check 7:30pm');
  assert.equal(pollLine({ ...poll(now), running: true }, now), 'Checking GitHub now');
  const last = (r) => pollLine(poll(now, { at: t(18, 45).toISOString(), failed: [], watched: 0, changes: [], ...r }), now);
  assert.equal(last({ watched: 2, changes: [{}] }), 'Next check 7:30pm · last 6:45pm, 2 PRs, 1 changed');
  assert.equal(last({ watched: 1 }), 'Next check 7:30pm · last 6:45pm, 1 PR, no change');
  assert.equal(last({}), 'Next check 7:30pm · last 6:45pm, no PRs watched');
  assert.equal(last({ watched: 3, failed: ['x'] }), 'Next check 7:30pm · last 6:45pm, could not reach GitHub for every PR');
});

test('Polling shows every window of the day, the one ?w= names or the one now falls in, and the hold and wakes', () => {
  const now = t(19);
  const v = pollingView({ now, st: status(now, DEFAULTS), poll: poll(now) });
  assert.equal(v.select, '18:00');
  assert.equal(pollingView({ now, st: status(now, DEFAULTS), poll: poll(now), select: '08:00' }).select, '08:00');
  assert.equal(pollingView({ now, st: status(now, DEFAULTS), poll: poll(now), select: '07:00' }).select, '18:00');
  assert.deepEqual(plain(v.now), { title: 'Checks every 30 min until 10:00pm', lines: ['Next check 7:30pm', 'No pushes queued.'], count: 0 });
  assert.deepEqual(plain(v.windows[1]), {
    from: '18:00', range: '6:00pm – 10:00pm', ends: '10:00pm', checks: '8 checks in this window', split: true, remove: true,
    every: [5, 10, 15, 30, 60, 120].map((m) => ({ minutes: m, label: m >= 60 ? `${m / 60} h` : `${m} min`, on: m === 30 })),
  });
  assert.deepEqual(v.windows.map((w) => [w.range, w.checks]), [['8:00am – 6:00pm', '40 checks in this window'], ['6:00pm – 10:00pm', '8 checks in this window'], ['10:00pm – 8:00am', '10 checks in this window']]);
  assert.deepEqual(v.day.segments.map((g) => [g.w, g.left, g.width, g.held, g.label]), [
    ['08:00', '33.333%', '41.667%', false, '15m'], ['18:00', '75.000%', '16.667%', false, '30m'], ['22:00', '91.667%', '8.333%', true, '1h'], ['22:00', '0.000%', '33.333%', true, '1h']]);
  assert.equal(v.day.segments[2].aria, '10:00pm – 8:00am, every 1 h, pushes held');
  assert.deepEqual(v.day.segments.map((g) => g.shade), ['76%', '61%', '45%', '45%']);
  assert.deepEqual(plain(v.day.pins), [{ left: '33.333%', title: 'Wake 8:00am' }, { left: '37.500%', title: 'Wake 9:00am' }]);
  assert.deepEqual([v.day.now, v.day.held, v.day.wakes], ['79.167%', true, true]);
  assert.deepEqual(plain(v.hold), { on: true, sub: 'Pushes queued after 10:00pm wait until 8:00am. GitHub checks still run.' });
  assert.deepEqual(plain(v.wakes), [{ value: '08:00', label: '8:00am' }, { value: '09:00', label: '9:00am' }]);

  const one = pollingView({ now, st: status(now, { ...win(['09:00', 20]), wakes: [] }, 2), poll: poll(now) });
  assert.deepEqual([one.windows[0].range, one.windows[0].ends, one.windows[0].remove, one.windows[0].every.map((c) => c.minutes)], ['All day', '—', false, [5, 10, 15, 20, 30, 60, 120]]);
  assert.deepEqual([one.hold.sub, one.day.held, one.day.wakes, one.wakes], ['With one window there is no overnight to hold.', false, false, []]);
  assert.equal(one.now.lines[1], '2 pushes queued; next send 7:20pm.');
});

test('Hub Settings says whether pushes go, when a snooze ends and what each snooze choice would end at', () => {
  const now = t(10);
  const v = settingsView({ now, st: status(now, DEFAULTS), rules: [{ id: 'r1', text: 'Be brief' }] });
  assert.equal(v.snoozed, null);
  assert.deepEqual(plain(v.on), { on: true, sub: 'On. Turn off to drop every push, urgent ones too.',
    confirm: 'Turn off notifications? Every push is dropped until you turn them back on, urgent ones too. Needs you and the badge still update.' });
  assert.deepEqual(plain(v.snooze), { sub: 'Pushes wait, then go. Urgent ones still go.', value: 'Off' });
  assert.deepEqual(plain(v.weekends), { on: false, sub: 'Pushes wait from Friday 10:00pm until Monday 8:00am. Urgent ones still go.' });
  assert.equal(v.polling, '3 windows, 58 checks a day · held overnight · wakes 8:00am, 9:00am');
  assert.equal(v.device, 'checks every 15 min until 6:00pm');
  assert.equal(v.sheet.title, 'Snooze pushes');
  assert.deepEqual(v.sheet.choices.map((c) => [c.value, c.until, c.disabled]), [['1h', 'until 11:00am', false], ['3h', 'until 1:00pm', false],
    ['tonight', 'until 6:00pm', false], ['morning', 'until 8:00am tomorrow', false], ['monday', 'until 8:00am Mon Oct 19', false], ['1w', 'until 10:00am Wed Oct 21', false]]);
  assert.deepEqual([v.sheet.min, new Date(v.sheet.max) - now], ['2026-10-14T10:00', 30 * 86_400_000]);
  assert.deepEqual(plain(v.rules), [{ id: 'r1', text: 'Be brief' }]);

  const snoozed = settingsView({ now, st: status(now, notify(DEFAULTS, { snoozed_until: t(12).toISOString() }), 2) });
  assert.deepEqual(plain(snoozed.snoozed), { title: 'Snoozed until 12:00pm', sub: '2 h left · urgent pushes still go' });
  assert.deepEqual(plain(snoozed.snooze), { sub: 'Until 12:00pm', value: 'On' });
  assert.equal(snoozed.device, 'checks every 15 min until 6:00pm; snoozed until 12:00pm');
  assert.equal(snoozed.sheet.title, 'Extend snooze');
  assert.deepEqual(snoozed.sheet.choices.slice(0, 2).map((c) => [c.value, c.disabled]), [['1h', true], ['3h', false]]);
  assert.equal(snoozed.sheet.min, '2026-10-14T12:00');
  assert.match(snoozed.on.confirm, / The 2 queued pushes are dropped now\. /);

  const evening = settingsView({ now: t(19), st: status(t(19), DEFAULTS) });
  assert.deepEqual(evening.sheet.choices.map((c) => c.value), ['1h', '3h', 'morning', 'monday', '1w']);

  const off = settingsView({ now, st: status(now, notify(DEFAULTS, { on: false, snoozed_until: t(12).toISOString() })) });
  assert.deepEqual([off.snoozed, off.snooze, off.sheet], [null, null, null]);
  assert.deepEqual([off.on.on, off.on.sub], [false, 'Off. Every push is dropped, urgent ones too. Needs you and the badge still update.']);
  assert.equal(off.device, 'checks every 15 min until 6:00pm; notifications are off');
});

test("the hub page lists Boards and Pages apart with each site's health and links, and says what the hub runs, polls and holds", () => {
  const now = t(19);
  const ok = (link) => ({ link, ok: true, state: 'ok', detail: '' });
  const rows = [
    { route: 'alpha', title: 'Alpha', state: 'up' }, { route: 'beta', title: 'Beta', state: 'up' },
    { route: 'gone', title: 'Gone', state: 'down' }, { route: 'learn', title: 'Learn', state: 'up' }, { route: 'new', title: 'New', state: 'starting' },
  ];
  const links = {
    alpha: [ok('github'), ok('events'), ok('pushes')],
    beta: [ok('github'), { link: 'events', ok: false, state: 'broken', detail: 'no watcher since 6:00pm' }, { link: 'wakes', ok: false, state: 'settling', detail: 'missed 9:00am' }],
  };
  const sidebar = {
    total: 3, sites: rows.map((r) => ({ route: r.route, board: ['alpha', 'beta', 'gone', 'new'].includes(r.route) })),
    hub: { tone: 'down', word: '2 broken', detail: '3 of 5 sites up' }, notifications: { state: 'on', text: 'On' },
  };
  const v = hubView({ now, st: status(now, DEFAULTS, 1), poll: poll(now), sidebar, rows, links, code: { running: 'abc', onDisk: 'abc' }, host: 'mac.ts.net', rules: [{ text: 'a' }, { text: 'b' }] });
  assert.deepEqual(v.groups.map((g) => [g.label, g.sites.map((s) => [s.route, s.tone, s.word, s.href])]), [
    ['Boards', [['alpha', 'ok', 'Up · listening · every link passes', '/alpha/'], ['beta', 'down', '1 link broken · not listening', '/beta/'],
      ['gone', 'down', 'Down · restarting', '/gone/'], ['new', 'wait', 'Starting', '/new/']]],
    ['Pages', [['learn', 'ok', 'Up', '/learn/']]],
  ]);
  assert.deepEqual(plain(v.groups[0].sites[1].lines), [{ link: 'events', detail: 'no watcher since 6:00pm' }, { link: 'wakes', detail: 'settling: missed 9:00am' }]);
  assert.match(v.groups[0].sites[0].icon, /^<span class="icon/);
  assert.deepEqual(plain(v.hub), { tone: 'down', word: '2 broken', detail: '3 of 5 sites up · runs the code in its files (abc)' });
  assert.equal(hubView({ now, st: status(now, DEFAULTS), poll: poll(now), sidebar, rows, code: { running: 'old', onDisk: 'abc' } }).hub.detail, '3 of 5 sites up · runs older code than its files; restart it');
  assert.deepEqual(plain(v.polling), { title: 'Checks every 30 min until 10:00pm', lines: ['Next check 7:30pm', '1 push queued; next send 7:30pm.'], count: 1,
    summary: '3 windows, 58 checks a day · held overnight · wakes 8:00am, 9:00am' });
  assert.deepEqual(plain(v.notifications), { on: true, text: 'On', device: 'checks every 30 min until 10:00pm' });
  assert.deepEqual([v.rules, v.sites, v.host, v.total, v.empty], ['2 rules', '5 sites', 'mac.ts.net', 3, false]);
  const none = hubView({ now, st: status(now, DEFAULTS), poll: poll(now), sidebar: { ...sidebar, sites: [] }, rows: [] });
  assert.deepEqual([none.groups, none.empty, none.rules, none.sites], [[], true, 'None yet', '0 sites']);
  assert.deepEqual(plain(siteHealth({ state: 'stopped' })), { tone: 'wait', word: 'Stopped', lines: [] });
  assert.deepEqual(plain(siteHealth({ state: 'up' }, [ok('github'), { ...ok('events'), listen: 'asleep' }])), { tone: 'ok', word: 'Up · asleep · every link passes', lines: [] });
});

test('Send now says how many queued pushes went, or that none could', () => {
  assert.deepEqual(flushView(null), { sent: 0, count: 0, ok: true, message: 'Nothing was queued.' });
  assert.deepEqual(flushView({ count: 2, sent: 2, ok: true }), { sent: 2, count: 2, ok: true, message: 'Sent 2 queued pushes.' });
  assert.deepEqual(flushView({ count: 1, sent: 1, ok: true }).message, 'Sent 1 queued push.');
  assert.deepEqual(flushView({ count: 2, sent: 0, ok: false }), { sent: 0, count: 2, ok: false, message: 'Could not send the queue. It stays queued for the next check.' });
});
