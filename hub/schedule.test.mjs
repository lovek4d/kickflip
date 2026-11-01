import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, NEVER, validate, fromPush, pollingOf, windowAt, windowSpan, checksIn, checksADay, daySegments, splitPoint, editPolling, nextSlot, holdsPushes, heldUntil, hold, snoozeEnd, flushAt, wakesDue, localDay, notifications, clock } from './schedule.mjs';

const t = (h, m = 0, day = 14, s = 0) => new Date(2026, 9, day, h, m, s);
const ON = { on: true, weekends_off: false, snoozed_until: null };
const win = (...pairs) => ({ windows: pairs.map(([from, every_minutes]) => ({ from, every_minutes })), hold_overnight: true, wakes: ['08:00', '09:00'], notifications: ON });
const notify = (s, n) => ({ ...s, notifications: { ...ON, ...n } });
const noHold = (s) => ({ ...s, hold_overnight: false });
const oldPush = (start, end, until, every = 30) => ({ immediate: { start, end }, bundle: { until, every_minutes: every } });

test('validate accepts the defaults, sorts windows and rejects bad input', () => {
  assert.deepEqual(validate(DEFAULTS).settings, DEFAULTS);
  assert.deepEqual(validate(win(['22:00', '60'], ['08:00', 15])).settings, win(['08:00', 15], ['22:00', 60]));
  assert.match(validate(win(['8:00', 15])).error, /HH:MM/);
  assert.match(validate(win(['24:00', 15])).error, /HH:MM/);
  assert.match(validate(win(['08:00', 4])).error, /5 to 120/);
  assert.match(validate(win(['08:00', 121])).error, /5 to 120/);
  assert.match(validate(win(['08:00', 7.5])).error, /5 to 120/);
  assert.match(validate(win(['08:00', ''])).error, /5 to 120/);
  assert.match(validate(win(['08:00', 15], ['08:00', 30])).error, /own start/);
  assert.match(validate({ windows: [] }).error, /at least one/);
  assert.match(validate(undefined).error, /at least one/);
  assert.equal(validate({ windows: [{ from: '08:00', every_minutes: 15 }] }).settings.hold_overnight, true);
  assert.equal(validate(noHold(DEFAULTS)).settings.hold_overnight, false);
  assert.match(validate({ ...DEFAULTS, hold_overnight: 'yes' }).error, /on or off/);
});

test('an old push block migrates to windows that keep its times', () => {
  assert.deepEqual(fromPush(oldPush('08:00', '18:00', '22:00')), DEFAULTS);
  assert.deepEqual(fromPush(oldPush('07:30', '17:00', '23:00', 45)), win(['07:30', 15], ['17:00', 45], ['23:00', 60]));
  assert.deepEqual(fromPush(oldPush('08:00', '18:00', '08:00', 60)), noHold(win(['08:00', 15], ['18:00', 60])));
  assert.deepEqual(fromPush(oldPush('08:00', '18:00', '18:00')), win(['08:00', 15], ['18:00', 60]));
  assert.equal(fromPush({ immediate: { start: 'x' } }), null);
  assert.equal(fromPush(undefined), null);
});

test('pollingOf prefers polling, then a migrated push block, then the defaults', () => {
  assert.deepEqual(pollingOf({ polling: win(['09:00', 20]), push: oldPush('07:30', '17:00', '23:00') }), win(['09:00', 20]));
  assert.deepEqual(pollingOf({ push: oldPush('07:30', '17:00', '23:00', 45) }), win(['07:30', 15], ['17:00', 45], ['23:00', 60]));
  assert.deepEqual(pollingOf({ polling: { windows: [] }, push: oldPush('08:00', '18:00', '22:00') }), DEFAULTS);
  assert.deepEqual(pollingOf({}), DEFAULTS);
});

test('windowAt switches at each start and wraps past midnight', () => {
  const at = (d) => { const w = windowAt(d, DEFAULTS); return [w.from, w.every_minutes, w.startedAt, w.endsAt]; };
  assert.deepEqual(at(t(7, 59, 14, 59)), ['22:00', 60, t(22, 0, 13), t(8)]);
  assert.deepEqual(at(t(8)), ['08:00', 15, t(8), t(18)]);
  assert.deepEqual(at(t(17, 59)), ['08:00', 15, t(8), t(18)]);
  assert.deepEqual(at(t(18)), ['18:00', 30, t(18), t(22)]);
  assert.deepEqual(at(t(22)), ['22:00', 60, t(22), t(8, 0, 15)]);
  assert.deepEqual(at(t(0, 30)), ['22:00', 60, t(22, 0, 13), t(8)]);
  const one = windowAt(t(3), win(['09:00', 30]));
  assert.deepEqual([one.startedAt, one.endsAt], [t(9, 0, 13), t(9)]);
});

test('nextSlot counts from the window start and lands on the next start', () => {
  assert.deepEqual(nextSlot(t(8), DEFAULTS), t(8, 15));
  assert.deepEqual(nextSlot(t(8, 14, 14, 59), DEFAULTS), t(8, 15));
  assert.deepEqual(nextSlot(t(12, 7), DEFAULTS), t(12, 15));
  assert.deepEqual(nextSlot(t(17, 50), DEFAULTS), t(18));
  assert.deepEqual(nextSlot(t(18, 5), DEFAULTS), t(18, 30));
  assert.deepEqual(nextSlot(t(21, 45), DEFAULTS), t(22));
  assert.deepEqual(nextSlot(t(23, 30), DEFAULTS), t(0, 0, 15));
  assert.deepEqual(nextSlot(t(7, 30), DEFAULTS), t(8));
  const odd = win(['08:00', 45], ['09:00', 60]);
  assert.deepEqual(nextSlot(t(8, 50), odd), t(9));
  assert.deepEqual(nextSlot(t(8, 10), odd), t(8, 45));
});

test('windowSpan, checksIn and checksADay count each window to the next start, wrapping past midnight', () => {
  assert.deepEqual(DEFAULTS.windows.map((_, i) => windowSpan(DEFAULTS, i)), [600, 240, 600]);
  assert.deepEqual(DEFAULTS.windows.map((_, i) => checksIn(DEFAULTS, i)), [40, 8, 10]);
  assert.equal(checksADay(DEFAULTS), 58);
  assert.equal(windowSpan(win(['09:00', 30]), 0), 1440);
  assert.equal(checksADay(win(['09:00', 30])), 48);
  assert.equal(checksIn(win(['08:00', 45], ['09:00', 60]), 0), 2);
});

test('daySegments covers the day once, splitting the window that runs past midnight', () => {
  assert.deepEqual(daySegments(DEFAULTS), [
    { window: 0, start: 480, end: 1080, held: false },
    { window: 1, start: 1080, end: 1320, held: false },
    { window: 2, start: 1320, end: 1440, held: true },
    { window: 2, start: 0, end: 480, held: true },
  ]);
  assert.ok(daySegments(noHold(DEFAULTS)).every((g) => !g.held));
  assert.deepEqual(daySegments(win(['09:00', 30])), [{ window: 0, start: 0, end: 1440, held: false }]);
  assert.deepEqual(daySegments(win(['00:00', 15], ['12:00', 30])).map((g) => [g.start, g.end]), [[0, 720], [720, 1440]]);
});

test('splitPoint halves a window on a quarter hour, past midnight too, and refuses one too short', () => {
  assert.equal(splitPoint(DEFAULTS, 0), '13:00');
  assert.equal(splitPoint(DEFAULTS, 2), '03:00');
  assert.equal(splitPoint(win(['09:00', 30]), 0), '21:00');
  assert.equal(splitPoint(win(['08:00', 15], ['08:20', 15]), 0), '08:15');
  assert.equal(splitPoint(win(['08:00', 15], ['08:05', 15]), 0), null);
  const eight = win(...Array.from({ length: 8 }, (_, h) => [`${String(h * 3).padStart(2, '0')}:00`, 15]));
  assert.equal(splitPoint(eight, 0), null);
});

test('editPolling turns each Polling modal change into settings to save and the window to show', () => {
  const edit = (op, w, value, s = DEFAULTS) => editPolling(s, { op, w, value });
  const starts = (r) => validate(r.input).settings.windows.map((w) => `${w.from}/${w.every_minutes}`);
  assert.deepEqual(starts(edit('from', '18:00', '19:00')), ['08:00/15', '19:00/30', '22:00/60']);
  assert.equal(edit('from', '18:00', '19:00').select, '19:00');
  assert.match(validate(edit('from', '18:00', '22:00').input).error, /own start/);
  assert.deepEqual(starts(edit('every', '08:00', '30')), ['08:00/30', '18:00/30', '22:00/60']);
  assert.deepEqual([starts(edit('split', '22:00')), edit('split', '22:00').select], [['03:00/60', '08:00/15', '18:00/30', '22:00/60'], '03:00']);
  assert.deepEqual([starts(edit('remove', '08:00')), edit('remove', '08:00').select], [['18:00/30', '22:00/60'], '22:00']);
  assert.match(edit('remove', '09:00', '', win(['09:00', 30])).error, /at least one/);
  assert.match(edit('every', '07:00', '30').error, /changed/);
  assert.deepEqual([edit('hold', '18:00', '').input.hold_overnight, edit('hold', '18:00', '').select], [false, '18:00']);
  assert.equal(edit('hold', '18:00', 'on', noHold(DEFAULTS)).input.hold_overnight, true);
  assert.deepEqual(validate(edit('wake-add', '08:00', '07:30').input).settings.wakes, ['07:30', '08:00', '09:00']);
  assert.match(validate(edit('wake-add', '08:00', '09:00').input).error, /09:00/);
  assert.deepEqual(edit('wake-remove', '08:00', '08:00').input.wakes, ['09:00']);
  assert.match(edit('nope', '08:00').error, /not one/);
  assert.deepEqual(DEFAULTS.windows.map((w) => w.from), ['08:00', '18:00', '22:00']);
});

test('hold_overnight holds pushes through the last window and sends them at the first start', () => {
  assert.equal(holdsPushes(t(23), DEFAULTS), true);
  assert.equal(holdsPushes(t(3), DEFAULTS), true);
  assert.equal(holdsPushes(t(22, 0, 14, 15), DEFAULTS), false);
  assert.equal(holdsPushes(t(8, 0, 15, 10), DEFAULTS), false);
  assert.equal(holdsPushes(t(19), DEFAULTS), false);
  assert.equal(holdsPushes(t(23), noHold(DEFAULTS)), false);
  assert.equal(holdsPushes(t(23), win(['09:00', 30])), false);
  assert.deepEqual(flushAt(t(21, 50), DEFAULTS), t(22));
  assert.deepEqual(flushAt(t(22, 30), DEFAULTS), t(8, 0, 15));
  assert.deepEqual(flushAt(t(2), DEFAULTS), t(8));
  assert.deepEqual(flushAt(t(12, 7), DEFAULTS), t(12, 15));
  assert.deepEqual(flushAt(t(22, 30), noHold(DEFAULTS)), t(23));
  assert.deepEqual(nextSlot(t(22, 30), DEFAULTS), t(23));
});

test('validate defaults the wake times, sorts them and rejects bad ones', () => {
  assert.deepEqual(DEFAULTS.wakes, ['08:00', '09:00']);
  assert.deepEqual(validate({ windows: DEFAULTS.windows }).settings.wakes, ['08:00', '09:00']);
  assert.deepEqual(validate({ ...DEFAULTS, wakes: ['09:30', '07:15'] }).settings.wakes, ['07:15', '09:30']);
  assert.deepEqual(validate({ ...DEFAULTS, wakes: [] }).settings.wakes, []);
  assert.match(validate({ ...DEFAULTS, wakes: ['8:00'] }).error, /Wake 1.*HH:MM/);
  assert.match(validate({ ...DEFAULTS, wakes: ['08:00', '25:00'] }).error, /Wake 2.*HH:MM/);
  assert.match(validate({ ...DEFAULTS, wakes: ['08:00', '08:00'] }).error, /08:00/);
  assert.match(validate({ ...DEFAULTS, wakes: '08:00' }).error, /list/);
  assert.deepEqual(pollingOf({ polling: { windows: DEFAULTS.windows, hold_overnight: true } }).wakes, ['08:00', '09:00']);
  assert.deepEqual(pollingOf({ push: oldPush('08:00', '18:00', '22:00') }).wakes, ['08:00', '09:00']);
});

test('wakesDue names each wake time passed today that has not gone out today', () => {
  assert.equal(localDay(t(23, 59)), '2026-10-14');
  assert.deepEqual(wakesDue(t(7, 59, 14, 59), DEFAULTS, {}), []);
  assert.deepEqual(wakesDue(t(8), DEFAULTS, {}), ['08:00']);
  assert.deepEqual(wakesDue(t(8, 40), DEFAULTS, { '08:00': '2026-10-13', '09:00': '2026-10-13' }), ['08:00']);
  assert.deepEqual(wakesDue(t(8, 41), DEFAULTS, { '08:00': '2026-10-14', '09:00': '2026-10-13' }), []);
  assert.deepEqual(wakesDue(t(9), DEFAULTS, { '08:00': '2026-10-14', '09:00': '2026-10-13' }), ['09:00']);
  assert.deepEqual(wakesDue(t(9, 30), DEFAULTS, {}), ['08:00', '09:00']);
  assert.deepEqual(wakesDue(t(23), DEFAULTS, { '08:00': '2026-10-14', '09:00': '2026-10-14' }), []);
  assert.deepEqual(wakesDue(t(7, 0, 16), DEFAULTS, { '08:00': '2026-10-14', '09:00': '2026-10-14' }), []);
  assert.deepEqual(wakesDue(t(12), { ...DEFAULTS, wakes: [] }, {}), []);
  assert.deepEqual(wakesDue(t(12), DEFAULTS, undefined), ['08:00', '09:00']);
});

test('notifications sends each queued push on its own, in queue order, keeping the newest of a tag', () => {
  const queue = [
    { id: '1', title: 'Answered: keep it?', body: 'First', url: '/x/#item=ask%3Ae1', tag: 'ask-e1', queuedAt: 1 },
    { id: '2', title: '2 PRs merged', url: '/x/' },
    { id: '3', title: 'Answered: keep it?', body: 'Latest', url: '/x/#item=ask%3Ae1', tag: 'ask-e1' },
    { id: '4', title: '2 questions need you', body: 'Which layout?', url: '/x/questions.html', tag: 'questions-x' },
  ];
  assert.deepEqual(notifications(queue), [
    { id: '2', title: '2 PRs merged', body: '', url: '/x/', tag: undefined },
    { id: '3', title: 'Answered: keep it?', body: 'Latest', url: '/x/#item=ask%3Ae1', tag: 'ask-e1' },
    { id: '4', title: '2 questions need you', body: 'Which layout?', url: '/x/questions.html', tag: 'questions-x' },
  ]);
  assert.deepEqual(notifications([]), []);
});

test('heldUntil lets pushes go except while held overnight, and then names when they go', () => {
  assert.equal(heldUntil(t(12), DEFAULTS), null);
  assert.equal(heldUntil(t(19), DEFAULTS), null);
  assert.equal(heldUntil(t(22, 1), DEFAULTS), null);
  assert.deepEqual(heldUntil(t(23), DEFAULTS), t(8, 0, 15));
  assert.deepEqual(heldUntil(t(3), DEFAULTS), t(8));
  assert.equal(heldUntil(t(23), noHold(DEFAULTS)), null);
  assert.equal(heldUntil(t(3), win(['09:00', 30])), null);
});

test('heldUntil holds for off, a snooze and the weekend, carrying a hold into the next one', () => {
  const [fri, sat, sun, mon] = [16, 17, 18, 19];
  const off = notify(DEFAULTS, { on: false });
  assert.equal(heldUntil(t(12), off), NEVER);
  assert.equal(heldUntil(t(3), off), NEVER);
  assert.equal(flushAt(t(12), off), NEVER);
  const snoozed = notify(DEFAULTS, { snoozed_until: t(15).toISOString() });
  assert.deepEqual(heldUntil(t(12), snoozed), t(15));
  assert.equal(heldUntil(t(15), snoozed), null);
  assert.deepEqual(heldUntil(t(21), notify(DEFAULTS, { snoozed_until: t(23).toISOString() })), t(8, 0, 15));
  assert.deepEqual(flushAt(t(12, 7), notify(DEFAULTS, { snoozed_until: t(13, 5).toISOString() })), t(13, 15));
  const weekends = notify(DEFAULTS, { weekends_off: true });
  assert.equal(heldUntil(t(21, 0, fri), weekends), null);
  assert.equal(heldUntil(t(22, 1, fri), noHold(weekends)), null);
  assert.deepEqual(heldUntil(t(23, 0, fri), noHold(weekends)), t(8, 0, mon));
  assert.deepEqual(heldUntil(t(23, 0, fri), weekends), t(8, 0, mon));
  assert.deepEqual(heldUntil(t(12, 0, sat), weekends), t(8, 0, mon));
  assert.deepEqual(heldUntil(t(23, 0, sun), weekends), t(8, 0, mon));
  assert.equal(heldUntil(t(8, 0, mon), weekends), null);
  assert.equal(heldUntil(t(12, 0, sat), DEFAULTS), null);
  assert.deepEqual(heldUntil(t(12, 0, sat), notify(win(['09:00', 30]), { weekends_off: true })), t(9, 0, mon));
  assert.deepEqual(hold(t(12), snoozed), { until: t(15), why: 'snoozed' });
  assert.deepEqual(hold(t(12), off), { until: NEVER, why: 'off' });
  assert.equal(hold(t(12, 0, sat), weekends).why, 'weekend');
  assert.equal(hold(t(23), DEFAULTS).why, 'overnight');
  assert.equal(hold(t(12), DEFAULTS), null);
});

test('validate defaults the notifications and rejects bad ones', () => {
  assert.deepEqual(DEFAULTS.notifications, ON);
  assert.deepEqual(validate({ windows: DEFAULTS.windows }).settings.notifications, ON);
  const set = { on: false, weekends_off: true, snoozed_until: '2026-10-14T20:00:00.000Z' };
  assert.deepEqual(validate(notify(DEFAULTS, set)).settings.notifications, set);
  assert.match(validate(notify(DEFAULTS, { on: 'no' })).error, /Notifications/);
  assert.match(validate(notify(DEFAULTS, { weekends_off: 1 })).error, /weekends/);
  assert.match(validate(notify(DEFAULTS, { snoozed_until: 'soon' })).error, /Snooze/);
  assert.deepEqual(pollingOf({ polling: win(['09:00', 20]), notifications: { on: false } }), notify(win(['09:00', 20]), { on: false }));
  assert.deepEqual(pollingOf({ polling: win(['09:00', 20]), notifications: { on: 'x' } }), win(['09:00', 20]));
  assert.deepEqual(pollingOf({ notifications: { weekends_off: true } }).notifications, { ...ON, weekends_off: true });
});

test('snoozeEnd turns a snooze choice into when it ends', () => {
  assert.deepEqual(snoozeEnd(t(12), '1h', DEFAULTS), t(13));
  assert.deepEqual(snoozeEnd(t(12), '3h', DEFAULTS), t(15));
  assert.deepEqual(snoozeEnd(t(12), '90m', DEFAULTS), t(13, 30));
  assert.deepEqual(snoozeEnd(t(12), '1d', DEFAULTS), t(12, 0, 15));
  assert.deepEqual(snoozeEnd(t(12), '3d', DEFAULTS), t(12, 0, 17));
  assert.deepEqual(snoozeEnd(t(12), 'morning', DEFAULTS), t(8, 0, 15));
  assert.deepEqual(snoozeEnd(t(3), 'morning', DEFAULTS), t(8));
  assert.equal(snoozeEnd(t(12), 'soon', DEFAULTS), null);
  assert.equal(snoozeEnd(t(12), '0h', DEFAULTS), null);
  assert.equal(snoozeEnd(t(12), '31d', DEFAULTS), null);
});

test('snoozeEnd ends tonight, Monday, in weeks or at a chosen time, within 30 days', () => {
  const four = win(['07:00', 15], ['12:00', 15], ['17:00', 30], ['21:00', 60]);
  assert.deepEqual(snoozeEnd(t(12), 'tonight', DEFAULTS), t(18));
  assert.deepEqual(snoozeEnd(t(19), 'tonight', DEFAULTS), t(18, 0, 15));
  assert.deepEqual(snoozeEnd(t(12), 'tonight', four), t(17));
  assert.deepEqual(snoozeEnd(t(12), 'tonight', win(['08:00', 15], ['18:00', 30])), t(18));
  assert.equal(snoozeEnd(t(12), 'tonight', win(['08:00', 15])), null);
  assert.deepEqual(snoozeEnd(t(12), 'monday', DEFAULTS), t(8, 0, 19));
  assert.deepEqual(snoozeEnd(t(7, 0, 19), 'monday', DEFAULTS), t(8, 0, 19));
  assert.deepEqual(snoozeEnd(t(9, 0, 19), 'monday', DEFAULTS), t(8, 0, 26));
  assert.deepEqual(snoozeEnd(t(12), 'monday', four), t(7, 0, 19));
  assert.deepEqual(snoozeEnd(t(12), '1w', DEFAULTS), t(12, 0, 21));
  assert.deepEqual(snoozeEnd(t(12), '4w', DEFAULTS), t(12, 0, 42));
  assert.equal(snoozeEnd(t(12), '5w', DEFAULTS), null);
  assert.deepEqual(snoozeEnd(t(12), '2026-10-15T09:30', DEFAULTS), t(9, 30, 15));
  assert.deepEqual(snoozeEnd(t(12), t(15).toISOString(), DEFAULTS), t(15));
  assert.equal(snoozeEnd(t(12), '2026-10-14T11:00', DEFAULTS), null);
  assert.equal(snoozeEnd(t(12), '2026-10-14T12:00', DEFAULTS), null);
  assert.equal(snoozeEnd(t(12), '2026-11-20T12:00', DEFAULTS), null);
  assert.equal(snoozeEnd(t(12), '2026-13-01T09:00', DEFAULTS), null);
  assert.equal(snoozeEnd(t(12), '2026-10-15', DEFAULTS), null);
});

test('clock formats local times relative to today', () => {
  assert.equal(clock(t(18), t(9)), '6:00pm');
  assert.equal(clock(t(8, 5, 15), t(23)), '8:05am tomorrow');
  assert.equal(clock(t(0, 0), t(0, 0)), '12:00am');
});
