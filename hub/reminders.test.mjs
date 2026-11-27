// docs/adr/2026-11-26-2200-remind-me-to-is-a-hub-stored-one-shot-timed-push.md
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeDevice } from './fake-device.mjs';
import { tempDir } from '../shared/temp-dir.mjs';
import { addReminder, readReminders, sendDue, remindersFile, listReminders, cancelReminder } from './reminders.mjs';

let home, device;
const fetch = (url, init) => (String(url) === device.subscription.endpoint ? device.fetch(url, init) : Promise.reject(new TypeError('fetch failed')));
const NOON = new Date(2026, 10, 26, 12);
const at = (minutes) => new Date(NOON.getTime() + minutes * 60_000);
const settings = (s) => { const f = path.join(home, '.claude', 'kickflip', 'settings.json'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(s)); };
const subscribe = (...subs) => {
  const f = path.join(home, '.claude', 'kickflip', 'push', 'subs.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(subs));
};
const run = (now) => sendDue({ now, home, fetch });
const seen = () => device.received.map(({ title, body, kind }) => ({ title, body, kind }));

beforeEach(() => {
  home = tempDir('reminders-');
  device = fakeDevice('https://phone.push.test/device');
  subscribe(device.subscription);
});

test('a reminder fires at its time with only the owner\'s text, once, and never early', async () => {
  const r = await addReminder({ at: at(10).toISOString(), text: 'call the dentist' }, { now: NOON, home });
  assert.equal(r.reminder.text, 'call the dentist');
  await run(at(9));
  assert.deepEqual(device.received, []);
  await run(at(10));
  assert.deepEqual(seen().map(({ title, body }) => ({ title, body })), [{ title: 'call the dentist', body: '' }]);
  await run(at(20));
  assert.equal(device.received.length, 1);
  assert.deepEqual(readReminders(home), []);
});

test('a reminder is stored on disk, so a restarted hub still sends it', async () => {
  await addReminder({ at: '30m', text: 'stretch' }, { now: NOON, home });
  assert.equal(JSON.parse(fs.readFileSync(remindersFile(home), 'utf8')).length, 1);
  await run(at(31));
  assert.equal(device.received.length, 1);
});

test('a reminder rings through quiet hours and a snooze, but not while notifications are off', async () => {
  settings({ quiet: { start: '22:00', end: '08:00', hold: true }, notifications: { on: true, weekends_off: false, snoozed_until: at(600).toISOString() } });
  const night = new Date(2026, 10, 26, 23);
  await addReminder({ at: new Date(2026, 10, 26, 23, 5).toISOString(), text: 'lock up' }, { now: night, home });
  await run(new Date(2026, 10, 26, 23, 5));
  assert.equal(device.received.length, 1);
  settings({ notifications: { on: false } });
  await addReminder({ at: new Date(2026, 10, 26, 23, 30).toISOString(), text: 'dropped' }, { now: night, home });
  await run(new Date(2026, 10, 26, 23, 30));
  assert.equal(device.received.length, 1);
  assert.deepEqual(readReminders(home), []);
});

test('a reminder no device took stays for the next run', async () => {
  await addReminder({ at: '5m', text: 'later' }, { now: NOON, home });
  subscribe({ ...device.subscription, endpoint: 'https://gone.push.test/device' });
  await run(at(6));
  assert.equal(readReminders(home).length, 1);
  subscribe(device.subscription);
  await run(at(7));
  assert.equal(device.received.length, 1);
  assert.deepEqual(readReminders(home), []);
});

test('addReminder refuses empty text and a time that is not ahead or readable', async () => {
  assert.match((await addReminder({ at: '5m', text: '  ' }, { now: NOON, home })).error, /text/);
  assert.match((await addReminder({ at: 'soon', text: 'x' }, { now: NOON, home })).error, /--at/);
  assert.match((await addReminder({ at: at(-5).toISOString(), text: 'x' }, { now: NOON, home })).error, /--at/);
  assert.deepEqual(readReminders(home), []);
});

// docs/adr/2026-11-27-1500-hub-settings-lists-and-cancels-every-reminder.md
// A file board in the hub's own temp home: items.json holds the cards, board.json names it as the board's item file.
const fileBoard = (route, title, items, tickets) => {
  const dir = path.join(home, route);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'board.json'), JSON.stringify({ items: 'items.json', slug: route }));
  fs.writeFileSync(path.join(dir, 'items.json'), JSON.stringify({ items }));
  return { route, title, dir, tickets, files: [{ slug: route, itemFile: { items } }] };
};
const itemsOf = (board) => JSON.parse(fs.readFileSync(path.join(board.dir, 'items.json'), 'utf8')).items;

test('the list holds every board\'s bells and when-reminders by board, and the hub\'s timed ones soonest first', async () => {
  const alpha = fileBoard('alpha', 'Alpha', [
    { id: 'T-1', title: 'one', lane: 'progress', remind_when: 'every-stage' },
    { id: 'T-2', title: 'two', lane: 'todo', remind_when: 'done' },
    { id: 'T-3', title: 'no reminder', lane: 'todo' },
  ]);
  const beta = fileBoard('beta', 'Beta', [{ id: 'T-4', title: 'four', lane: 'progress', remind_when: 'needs-you' }]);
  const quiet = fileBoard('quiet', 'Quiet', [{ id: 'T-5', title: 'five', lane: 'todo' }]);
  await addReminder({ at: '2h', text: 'later' }, { now: NOON, home });
  await addReminder({ at: '30m', text: 'sooner' }, { now: NOON, home });
  const list = listReminders([alpha, beta, quiet], { home });
  assert.deepEqual(list.boards.map((b) => [b.route, b.title, b.rows.map((r) => [r.key, r.ref, r.title, r.when])]), [
    ['alpha', 'Alpha', [['alpha/T-1', 'T-1', 'one', 'every-stage'], ['alpha/T-2', 'T-2', 'two', 'done']]],
    ['beta', 'Beta', [['beta/T-4', 'T-4', 'four', 'needs-you']]],
  ]);
  assert.deepEqual(list.timed.map((r) => r.text), ['sooner', 'later']);
});

test('Cancel takes a board reminder off its card as the owner\'s Bell off, and a timed one out of the hub\'s file', async () => {
  const alpha = fileBoard('alpha', 'Alpha', [{ id: 'T-1', title: 'one', lane: 'progress', remind_when: 'done' }, { id: 'T-2', title: 'two', lane: 'progress', remind_when: 'every-stage' }]);
  const { reminder } = await addReminder({ at: '1h', text: 'call' }, { now: NOON, home });
  await addReminder({ at: '2h', text: 'stay' }, { now: NOON, home });
  assert.equal(await cancelReminder({ route: 'alpha', key: 'alpha/T-1' }, { boards: [alpha], home }), true);
  assert.deepEqual(itemsOf(alpha).map((it) => [it.id, it.remind_when]), [['T-1', undefined], ['T-2', 'every-stage']]);
  assert.equal(await cancelReminder({ id: reminder.id }, { boards: [alpha], home }), true);
  assert.deepEqual(readReminders(home).map((r) => r.text), ['stay']);
  assert.equal(await cancelReminder({ id: reminder.id }, { boards: [alpha], home }), false, 'already gone, nothing changes');
  assert.equal(await cancelReminder({ route: 'alpha', key: 'alpha/T-1' }, { boards: [alpha], home }), false, 'no reminder left on the card');
  assert.equal(await cancelReminder({ route: 'gone', key: 'gone/T-1' }, { boards: [alpha], home }), false, 'no such board');
});
