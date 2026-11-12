import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, NEVER, validate, fromPolling, quietOf, editQuiet, quietAt, quietMiddleOf, holdsPushes, heldUntil, hold, snoozeEnd, flushAt, wakesDue, localDay, notifications, clock, checkEvery, nextCheckAt, LOW_POINTS } from './schedule.mjs';

const t = (h, m = 0, day = 14, s = 0) => new Date(2026, 9, day, h, m, s);
const ON = { on: true, weekends_off: false, snoozed_until: null };
const quiet = (start, end, hold = true) => ({ quiet: { start, end, hold }, notifications: ON });
const notify = (s, n) => ({ ...s, notifications: { ...ON, ...n } });
const noHold = (s) => ({ ...s, quiet: { ...s.quiet, hold: false } });
const win = (...pairs) => ({ windows: pairs.map(([from, every_minutes]) => ({ from, every_minutes })), hold_overnight: true, wakes: ['08:00', '09:00'] });

test('validate accepts the defaults and rejects bad quiet hours', () => {
  assert.deepEqual(validate(DEFAULTS).settings, DEFAULTS);
  assert.deepEqual(DEFAULTS.quiet, { start: '22:00', end: '08:00', hold: true });
  assert.deepEqual(validate(quiet('23:30', '07:15', false)).settings, quiet('23:30', '07:15', false));
  assert.deepEqual(validate({ quiet: { start: '21:00', end: '06:00' } }).settings.quiet, { start: '21:00', end: '06:00', hold: true });
  assert.match(validate(quiet('8:00', '07:00')).error, /start.*HH:MM/);
  assert.match(validate(quiet('22:00', '24:00')).error, /end.*HH:MM/);
  assert.match(validate(quiet('22:00', '22:00')).error, /different times/);
  assert.match(validate({ quiet: { start: '22:00', end: '08:00', hold: 'yes' } }).error, /Hold pushes/);
});

test('the old polling windows become quiet hours from the last window to the first, keeping the hold', () => {
  assert.deepEqual(fromPolling(win(['08:00', 15], ['18:00', 30], ['22:00', 60])), { start: '22:00', end: '08:00', hold: true });
  assert.deepEqual(fromPolling({ ...win(['09:00', 15], ['21:30', 60]), hold_overnight: false }), { start: '21:30', end: '09:00', hold: false });
  assert.equal(fromPolling(win(['08:00', 15])), null);
  assert.equal(fromPolling(undefined), null);
  assert.deepEqual(quietOf({ polling: win(['07:00', 15], ['23:00', 60]), notifications: { on: false } }), notify(quiet('23:00', '07:00'), { on: false }));
  assert.deepEqual(quietOf({ quiet: { start: '21:00', end: '06:00', hold: false }, polling: win(['07:00', 15], ['23:00', 60]) }), quiet('21:00', '06:00', false));
  assert.deepEqual(quietOf({}), DEFAULTS);
  assert.deepEqual(quietOf({ quiet: { start: 'x' } }), DEFAULTS);
  assert.deepEqual(quietOf({ notifications: { on: 'x' } }), DEFAULTS);
  assert.deepEqual(quietOf({ notifications: { weekends_off: true } }).notifications, { ...ON, weekends_off: true });
});

test('editQuiet turns one Quiet hours change into settings to save', () => {
  const s = DEFAULTS;
  assert.deepEqual(editQuiet(s, { start: '21:00' }), { quiet: { start: '21:00', end: '08:00', hold: true }, notifications: ON });
  assert.deepEqual(editQuiet(s, { end: '07:30' }).quiet, { start: '22:00', end: '07:30', hold: true });
  assert.deepEqual(editQuiet(s, { hold: 'off' }).quiet.hold, false);
  assert.deepEqual(editQuiet(noHold(s), { hold: 'on' }).quiet.hold, true);
});

test('quietAt reads the night past midnight, from its start up to its end', () => {
  const s = DEFAULTS;
  assert.equal(quietAt(t(21, 59), s), false);
  assert.equal(quietAt(t(22), s), true);
  assert.equal(quietAt(t(3), s), true);
  assert.equal(quietAt(t(8), s), false);
  const day = quiet('01:00', '06:00');
  assert.equal(quietAt(t(0, 30), day), false);
  assert.equal(quietAt(t(2), day), true);
  assert.equal(quietAt(t(6), day), false);
});

// docs/adr/2026-11-04-1900-triage-runs-once-overnight-on-cards-waiting-on-your-answers.md
test('quietMiddleOf is the middle of the night `t` falls in, from that middle until quiet hours end', () => {
  const s = DEFAULTS;
  assert.equal(quietMiddleOf(t(23), s), null);
  assert.equal(quietMiddleOf(t(2, 59, 15), s), null);
  assert.deepEqual(quietMiddleOf(t(3, 0, 15), s), t(3, 0, 15));
  assert.deepEqual(quietMiddleOf(t(7, 59, 15), s), t(3, 0, 15));
  assert.equal(quietMiddleOf(t(8, 0, 15), s), null);
  assert.equal(quietMiddleOf(t(12), s), null);
  const late = quiet('23:30', '06:00');
  assert.deepEqual(quietMiddleOf(t(2, 45, 15), late), t(2, 45, 15));
  assert.equal(quietMiddleOf(t(2, 44, 15), late), null);
  const day = quiet('01:00', '06:00');
  assert.deepEqual(quietMiddleOf(t(4), day), t(3, 30));
  assert.equal(quietMiddleOf(t(3), day), null);
});

test('checks run every minute while the owner is here and every 5 when away, slowing to 5 and 15 on a low GitHub budget', () => {
  assert.equal(checkEvery({ present: true }), 1);
  assert.equal(checkEvery({ present: false }), 5);
  assert.equal(checkEvery({ present: true, remaining: LOW_POINTS }), 1);
  assert.equal(checkEvery({ present: true, remaining: LOW_POINTS - 1 }), 5);
  assert.equal(checkEvery({ present: false, remaining: 12 }), 15);
  assert.equal(checkEvery({ present: false, remaining: null }), 5);
});

test('the next check follows the last one by the cadence now, and coming back checks at once', () => {
  const last = t(12, 0);
  assert.deepEqual(nextCheckAt({ last, present: true }), t(12, 1));
  assert.deepEqual(nextCheckAt({ last, present: false }), t(12, 5));
  assert.deepEqual(nextCheckAt({ last, present: false, remaining: 10 }), t(12, 15));
  assert.deepEqual(nextCheckAt({ last, present: true, backAt: t(12, 3) }), t(12, 3));
  assert.deepEqual(nextCheckAt({ last, present: true, backAt: t(11, 59) }), t(12, 1));
});

test('holdsPushes holds the quiet hours a few minutes past their start, until their end', () => {
  assert.equal(holdsPushes(t(21), DEFAULTS), false);
  assert.equal(holdsPushes(t(22, 4), DEFAULTS), false);
  assert.equal(holdsPushes(t(22, 6), DEFAULTS), true);
  assert.equal(holdsPushes(t(7, 59), DEFAULTS), true);
  assert.equal(holdsPushes(t(8), DEFAULTS), false);
  assert.equal(holdsPushes(t(23), noHold(DEFAULTS)), false);
});

test('wakesDue names the one daily wake at the end of quiet hours', () => {
  assert.equal(localDay(t(23, 59)), '2026-10-14');
  assert.deepEqual(wakesDue(t(7, 59, 14, 59), DEFAULTS, {}), []);
  assert.deepEqual(wakesDue(t(8), DEFAULTS, {}), ['08:00']);
  assert.deepEqual(wakesDue(t(8, 40), DEFAULTS, { '08:00': '2026-10-13' }), ['08:00']);
  assert.deepEqual(wakesDue(t(9), DEFAULTS, { '08:00': '2026-10-14' }), []);
  assert.deepEqual(wakesDue(t(7, 0, 16), DEFAULTS, { '08:00': '2026-10-14' }), []);
  assert.deepEqual(wakesDue(t(12), quiet('23:00', '06:30'), undefined), ['06:30']);
});

test('notifications sends a board\'s one push as it is, keeping the newest of a tag', () => {
  const queue = [
    { id: '1', title: 'Answered: keep it?', body: 'First', url: '/x/#selectedCard=ask%3Ae1', tag: 'ask-e1', kind: 'action' },
    { id: '2', title: 'Allow Bash?', url: '/y/', kind: 'prompt' },
    { id: '3', title: 'Answered: keep it?', body: 'Latest', url: '/x/#selectedCard=ask%3Ae1', tag: 'ask-e1', kind: 'action' },
    { id: '4', title: 'Hub is down', kind: 'fault' },
  ];
  assert.deepEqual(notifications(queue, { x: { count: 0, summary: '' } }), [
    { title: 'Allow Bash?', body: '', url: '/y/', tag: undefined, kind: 'prompt', members: ['2'] },
    { title: 'Answered: keep it?', body: 'Latest', url: '/x/#selectedCard=ask%3Ae1', tag: 'ask-e1', kind: 'action', members: ['3'] },
    { title: 'Hub is down', body: '', url: '/', tag: undefined, kind: 'fault', members: ['4'] },
  ]);
  assert.deepEqual(notifications([]), []);
});

test('notifications leaves a held question push out, alone or beside others', () => {
  const question = { id: 'q', title: 'Needs you', url: '/x/questions.html?from=push#q1', tag: 'a', kind: 'action' };
  assert.deepEqual(notifications([question]), []);
  const other = { id: 'o', title: 'Allow Bash?', url: '/x/', kind: 'prompt' };
  assert.deepEqual(notifications([question, other]).map((n) => n.members), [['o']]);
});

test('notifications sends a board with several pushes as one summary of what waits on it now, and nothing when nothing waits', () => {
  const queue = [
    { id: '1', title: 'A1 asks: Which layout?', url: '/x/#selectedCard=w%2FA1', tag: 'item-w/A1', kind: 'action' },
    { id: '2', title: 'B5 waits on Ready', url: '/y/#selectedCard=w%2FB5', tag: 'item-w/B5', kind: 'action' },
    { id: '3', title: 'A2 waits on Merge', url: '/x/#selectedCard=w%2FA2', tag: 'item-w/A2', kind: 'action' },
    { id: '4', title: 'Allow Bash?', url: '/y/', tag: 'prompt-p1', kind: 'prompt' },
    { id: '5', title: 'C1 waits on Ready', url: '/z/#selectedCard=w%2FC1', kind: 'action' },
    { id: '6', title: 'C2 waits on Ready', url: '/z/#selectedCard=w%2FC2', kind: 'action' },
    { id: '7', title: 'D1 asks: Keep it?', url: '/w/#selectedCard=w%2FD1', kind: 'action' },
    { id: '8', title: 'D2 waits on Ready', url: '/w/', kind: 'action' },
    { id: '9', title: 'D3 waits on Merge', url: '/w/', kind: 'action' },
    { id: '10', title: 'A1 asks: Which colour?', url: '/x/#selectedCard=w%2FA1', tag: 'item-w/A1', kind: 'action' },
  ];
  const sites = {
    x: { count: 3, summary: '1 question · 2 drafts waiting on Ready' },
    y: { count: 1, summary: '1 prompt' },
    z: { count: 0, summary: '' },
    w: null,
  };
  assert.deepEqual(notifications(queue, sites), [
    { title: '1 needs you on y', body: '1 prompt', url: '/y/', tag: 'summary:y', kind: 'prompt', members: ['2', '4'] },
    { title: '3 need you on x', body: '1 question · 2 drafts waiting on Ready', url: '/x/', tag: 'summary:x', kind: 'action', members: ['3', '10'] },
    { title: '3 updates on w', body: 'D1 asks: Keep it? · D2 waits on Ready · and 1 more', url: '/w/', tag: 'summary:w', kind: 'action', members: ['7', '8', '9'] },
  ]);
  assert.deepEqual(notifications(queue.slice(0, 4)).map((n) => [n.title, n.body, n.tag]), [
    ['2 updates on x', 'A1 asks: Which layout? · A2 waits on Merge', 'summary:x'],
    ['2 updates on y', 'B5 waits on Ready · Allow Bash?', 'summary:y'],
  ]);
});

test('heldUntil lets pushes go except in quiet hours with the hold on, and then names when they go', () => {
  assert.equal(heldUntil(t(12), DEFAULTS), null);
  assert.equal(heldUntil(t(21), DEFAULTS), null);
  assert.equal(heldUntil(t(22, 1), DEFAULTS), null);
  assert.deepEqual(heldUntil(t(23), DEFAULTS), t(8, 0, 15));
  assert.deepEqual(heldUntil(t(3), DEFAULTS), t(8));
  assert.equal(heldUntil(t(23), noHold(DEFAULTS)), null);
});

test('flushAt sends a queued push by the next away check, or once its hold ends', () => {
  assert.deepEqual(flushAt(t(12), DEFAULTS), t(12, 5));
  assert.deepEqual(flushAt(t(23), DEFAULTS), t(8, 0, 15));
  assert.deepEqual(flushAt(t(12, 7), notify(DEFAULTS, { snoozed_until: t(13, 5).toISOString() })), t(13, 5));
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
  const forever = notify(DEFAULTS, { snoozed_until: 'forever', weekends_off: true });
  assert.deepEqual([t(12), t(23), t(12, 0, sat)].map((at) => hold(at, forever)), Array(3).fill({ until: 'forever', why: 'snoozed' }));
  assert.equal(flushAt(t(12), forever), 'forever');
  const weekends = notify(DEFAULTS, { weekends_off: true });
  assert.equal(heldUntil(t(21, 0, fri), weekends), null);
  assert.equal(heldUntil(t(22, 1, fri), noHold(weekends)), null);
  assert.deepEqual(heldUntil(t(23, 0, fri), noHold(weekends)), t(8, 0, mon));
  assert.deepEqual(heldUntil(t(23, 0, fri), weekends), t(8, 0, mon));
  assert.deepEqual(heldUntil(t(12, 0, sat), weekends), t(8, 0, mon));
  assert.deepEqual(heldUntil(t(23, 0, sun), weekends), t(8, 0, mon));
  assert.equal(heldUntil(t(8, 0, mon), weekends), null);
  assert.equal(heldUntil(t(12, 0, sat), DEFAULTS), null);
  assert.deepEqual(heldUntil(t(12, 0, sat), notify(quiet('23:00', '09:00'), { weekends_off: true })), t(9, 0, mon));
  assert.deepEqual(hold(t(12), snoozed), { until: t(15), why: 'snoozed' });
  assert.deepEqual(hold(t(12), off), { until: NEVER, why: 'off' });
  assert.equal(hold(t(12, 0, sat), weekends).why, 'weekend');
  assert.equal(hold(t(23), DEFAULTS).why, 'overnight');
  assert.equal(hold(t(12), DEFAULTS), null);
});

test('validate defaults the notifications and rejects bad ones', () => {
  assert.deepEqual(DEFAULTS.notifications, ON);
  assert.deepEqual(validate({ quiet: DEFAULTS.quiet }).settings.notifications, ON);
  const set = { on: false, weekends_off: true, snoozed_until: '2026-10-14T20:00:00.000Z' };
  assert.deepEqual(validate(notify(DEFAULTS, set)).settings.notifications, set);
  assert.equal(validate(notify(DEFAULTS, { snoozed_until: 'forever' })).settings.notifications.snoozed_until, 'forever');
  assert.match(validate(notify(DEFAULTS, { on: 'no' })).error, /Notifications/);
  assert.match(validate(notify(DEFAULTS, { weekends_off: 1 })).error, /weekends/);
  assert.match(validate(notify(DEFAULTS, { snoozed_until: 'soon' })).error, /Snooze/);
});

test('snoozeEnd turns a snooze choice into when it ends', () => {
  assert.deepEqual(snoozeEnd(t(12), '1h', DEFAULTS), t(13));
  assert.deepEqual(snoozeEnd(t(12), '90m', DEFAULTS), t(13, 30));
  assert.deepEqual(snoozeEnd(t(12), '1d', DEFAULTS), t(12, 0, 15));
  assert.deepEqual(snoozeEnd(t(12), 'morning', DEFAULTS), t(8, 0, 15));
  assert.deepEqual(snoozeEnd(t(3), 'morning', DEFAULTS), t(8));
  assert.equal(snoozeEnd(t(12), 'forever', DEFAULTS), 'forever');
  assert.equal(snoozeEnd(t(12), 'soon', DEFAULTS), null);
  assert.equal(snoozeEnd(t(12), '0h', DEFAULTS), null);
  assert.equal(snoozeEnd(t(12), '31d', DEFAULTS), null);
});

test('snoozeEnd ends tonight at the start of quiet hours, Monday at their end, in weeks or at a chosen time', () => {
  assert.deepEqual(snoozeEnd(t(12), 'tonight', DEFAULTS), t(22));
  assert.deepEqual(snoozeEnd(t(23), 'tonight', DEFAULTS), t(22, 0, 15));
  assert.deepEqual(snoozeEnd(t(12), 'tonight', quiet('21:00', '07:00')), t(21));
  assert.deepEqual(snoozeEnd(t(12), 'monday', DEFAULTS), t(8, 0, 19));
  assert.deepEqual(snoozeEnd(t(7, 0, 19), 'monday', DEFAULTS), t(8, 0, 19));
  assert.deepEqual(snoozeEnd(t(9, 0, 19), 'monday', DEFAULTS), t(8, 0, 26));
  assert.deepEqual(snoozeEnd(t(12), 'monday', quiet('23:00', '07:00')), t(7, 0, 19));
  assert.deepEqual(snoozeEnd(t(12), '1w', DEFAULTS), t(12, 0, 21));
  assert.equal(snoozeEnd(t(12), '5w', DEFAULTS), null);
  assert.deepEqual(snoozeEnd(t(12), '2026-10-15T09:30', DEFAULTS), t(9, 30, 15));
  assert.equal(snoozeEnd(t(12), '2026-10-14T11:00', DEFAULTS), null);
  assert.equal(snoozeEnd(t(12), '2026-10-15', DEFAULTS), null);
});

test('a day snooze is exactly 24 hours across daylight saving changes', () => {
  const before = process.env.TZ;
  try {
    process.env.TZ = 'America/Los_Angeles';
    for (const now of [new Date(2026, 2, 7, 12, 10, 0, 123), new Date(2026, 9, 31, 12, 10, 0, 123)]) {
      assert.equal(snoozeEnd(now, '1d', DEFAULTS) - now, 86_400_000);
    }
  } finally {
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  }
});

test('clock formats local times relative to today', () => {
  assert.equal(clock(t(18), t(9)), '6:00pm');
  assert.equal(clock(t(8, 5, 15), t(23)), '8:05am tomorrow');
  assert.equal(clock(t(0, 0), t(0, 0)), '12:00am');
});
