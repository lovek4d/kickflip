// docs/adr/2026-11-26-2200-remind-me-to-is-a-hub-stored-one-shot-timed-push.md
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeDevice } from './fake-device.mjs';
import { tempDir } from '../shared/temp-dir.mjs';
import { addReminder, readReminders, sendDue, remindersFile } from './reminders.mjs';

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
