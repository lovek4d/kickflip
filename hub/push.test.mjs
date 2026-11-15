import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as push from './push.mjs';
import { fakeDevice } from './fake-device.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

let home, device, devices;
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const pushFile = (name) => path.join(home, '.claude', 'kickflip', 'push', name);
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const seen = () => device.received.map(({ title, body, url, tag }) => ({ title, body, url, tag }));
const orchWaits = (count, summary) => ({ total: count + 1, sites: { orch: { count, summary }, ios: null } });
const NOON = new Date(2026, 9, 14, 12);
const NIGHT = new Date(2026, 9, 14, 23);
const SATURDAY = new Date(2026, 9, 17, 12);
const settingsFile = () => path.join(home, '.claude', 'kickflip', 'settings.json');

// The network push.mjs sees: the hub's needs.json is device's, each endpoint is the device it names, and any other
// address refuses as a closed port does.
const fetch = (url, init) => {
  const to = new URL(url).pathname === '/_hub/needs.json' ? device : devices.find((d) => d.subscription.endpoint === String(url));
  return to ? to.fetch(url, init) : Promise.reject(new TypeError('fetch failed'));
};
const addDevice = (name) => {
  const d = fakeDevice(`https://${name}.push.test/device`);
  devices.push(d);
  return d;
};
const deliver = (message, opts) => push.deliver(message, { ...opts, home, fetch });
const flushQueue = () => push.flushQueue({ home, fetch });

beforeEach(() => {
  home = tempDir('push-');
  devices = [];
  device = addDevice('phone');
  write(pushFile('subs.json'), [device.subscription]);
});

test('deliver refuses a push with no kind or an info kind, sending and queueing nothing', async () => {
  for (const opts of [{}, { kind: 'info', immediate: true }, { kind: 'info', urgent: true }]) {
    await assert.rejects(deliver({ title: 'Answered: keep it?', url: '/orch/' }, { ...opts, at: NOON }), (e) => {
      assert.ok(e instanceof push.PushKindError, JSON.stringify(opts));
      assert.match(e.message, /^a push needs --kind action\|prompt\|fault/);
      return true;
    });
  }
  assert.deepEqual(device.received, []);
  assert.equal(fs.existsSync(pushFile('queue.json')), false);
});

test('an immediate push goes at once in the day, replacing a queued one with its tag, and queues while pushes are held', async () => {
  await deliver({ title: 'A1 asks: Which layout?', body: 'Queued', url: '/orch/#selectedCard=w%2FA1', tag: 'item-w/A1' }, { kind: 'action', at: NOON });
  await deliver({ title: 'A2 waits on Ready', url: '/orch/' }, { kind: 'action', at: NOON });
  assert.equal(read(pushFile('queue.json')).items.length, 2);

  const now = await deliver({ title: 'A1 asks: Which colour?', body: 'Blue · Red', url: '/orch/#selectedCard=w%2FA1', tag: 'item-w/A1' }, { kind: 'action', immediate: true, at: NOON });
  assert.ok(now.sent);
  assert.deepEqual(seen(), [{ title: 'A1 asks: Which colour?', body: 'Blue · Red', url: '/orch/#selectedCard=w%2FA1', tag: 'item-w/A1' }]);
  assert.deepEqual(read(pushFile('queue.json')).items.map((i) => i.title), ['A2 waits on Ready']);

  const held = await deliver({ title: 'One needs you', url: '/orch/', tag: 'item-w/A1' }, { kind: 'action', immediate: true, at: NIGHT });
  assert.ok(held.queued);
  assert.equal(device.received.length, 1);
  assert.deepEqual(read(pushFile('queue.json')).items.map((i) => i.tag), [undefined, 'item-w/A1']);
});

test('flushing the queue sends a board\'s one push as it is, its several as one summary of what waits now, and a failed send keeps them queued', async () => {
  await deliver({ title: '2 questions need you', body: 'Which layout?', url: '/orch/questions.html', tag: 'questions-orch' }, { kind: 'action', at: NOON });
  await deliver({ title: 'B5 needs you', body: 'Pick one', url: '/orch/#selectedCard=w%2FB5', tag: 'item-w/B5' }, { kind: 'action', at: NOON });
  await deliver({ title: 'A3 waits on Merge', url: '/orch/' }, { kind: 'action', at: NOON });
  await deliver({ title: 'I2 waits on Ready', url: '/ios/#selectedCard=w%2FI2', tag: 'item-w/I2' }, { kind: 'action', at: NOON });
  device.needs = orchWaits(4, '2 questions · 2 drafts waiting on Ready');
  const r = await flushQueue();
  assert.deepEqual([r.count, r.sent, r.ok], [4, 2, true]);
  assert.deepEqual(seen(), [
    { title: '4 need you on orch', body: '2 questions · 2 drafts waiting on Ready', url: '/orch/', tag: 'summary:orch' },
    { title: 'I2 waits on Ready', body: '', url: '/ios/#selectedCard=w%2FI2', tag: 'item-w/I2' },
  ]);
  assert.deepEqual(device.received.map((m) => m.badge), [5, 5]);
  assert.deepEqual(read(pushFile('queue.json')).items, []);

  await deliver({ title: 'A4 waits on Ready', url: '/orch/', tag: 'item-w/A4' }, { kind: 'action', at: NOON });
  await deliver({ title: 'A5 waits on Ready', url: '/orch/', tag: 'item-w/A5' }, { kind: 'action', at: NOON });
  device.needs = orchWaits(0, '');
  assert.deepEqual(await flushQueue(), { count: 2, sent: 0, ok: true, results: [] });
  assert.equal(device.received.length, 2);
  assert.deepEqual(read(pushFile('queue.json')).items, []);

  write(pushFile('subs.json'), [{ ...device.subscription, endpoint: 'https://gone.push.test/device' }]);
  await deliver({ title: 'A4 waits on Ready', url: '/orch/', tag: 'item-w/A4' }, { kind: 'action', at: NOON });
  await deliver({ title: 'A5 waits on Ready', url: '/orch/', tag: 'item-w/A5' }, { kind: 'action', at: NOON });
  device.needs = null;
  const failed = await flushQueue();
  assert.equal(failed.ok, false);
  assert.deepEqual(read(pushFile('queue.json')).items.map((i) => i.tag), ['item-w/A4', 'item-w/A5']);
});

test('a legacy queued push without a kind still reaches every device when flushed', async () => {
  const mac = addDevice('mac');
  write(pushFile('subs.json'), [{ ...device.subscription, agent: IPHONE }, { ...mac.subscription, agent: CHROME_MAC }]);
  write(pushFile('queue.json'), { items: [{ id: 'legacy-prompt', title: 'Allow Bash?', body: '', url: '/orch/', tag: 'prompt-legacy', queuedAt: NOON.toISOString() }] });

  const r = await flushQueue();
  assert.equal(r.count, 1);
  assert.equal(r.ok, true);
  assert.deepEqual(device.received.map((m) => m.title), ['Allow Bash?']);
  assert.deepEqual(mac.received.map((m) => m.title), ['Allow Bash?']);
  assert.deepEqual(read(pushFile('queue.json')).items, []);
});

test('with notifications off every push is dropped, urgent ones too, and turning them off drops the queue', async () => {
  await deliver({ title: 'A3 waits on Merge', url: '/orch/' }, { kind: 'action', at: NOON });
  const off = await push.setNotifications({ on: false }, new Date(), home);
  assert.equal(off.dropped, 1);
  assert.equal(off.notifications.on, false);
  assert.deepEqual(read(pushFile('queue.json')).items, []);
  const results = [
    await deliver({ title: 'A1 asks: Keep it?', url: '/orch/' }, { kind: 'action', immediate: true, at: NOON }),
    await deliver({ title: 'Orch is down', url: '/orch/' }, { kind: 'fault', urgent: true, at: NOON }),
    await deliver({ title: 'A3 waits on Merge', url: '/orch/' }, { kind: 'action', at: NOON }),
  ];
  assert.deepEqual(results, [{ dropped: true }, { dropped: true }, { dropped: true }]);
  assert.deepEqual(device.received, []);
  assert.deepEqual(read(pushFile('queue.json')).items, []);
  assert.deepEqual(read(settingsFile()).notifications, { on: false, weekends_off: false, snoozed_until: null });
});

test('a snooze or the weekend queues pushes until it ends, an urgent push still goes, and undo lets them go', async () => {
  const snoozed = await push.setNotifications({ snooze: '3h' }, NOON, home);
  assert.equal(snoozed.notifications.snoozed_until, new Date(2026, 9, 14, 15).toISOString());
  const held = await deliver({ title: 'A1 asks: Keep it?', url: '/orch/', tag: 'ask-e1' }, { kind: 'action', immediate: true, at: NOON });
  assert.equal(held.queued.held, true);
  assert.equal(held.queued.nextFlushAt.toISOString(), new Date(2026, 9, 14, 15).toISOString());
  const urgent = await deliver({ title: 'Orch is down', url: '/orch/' }, { kind: 'fault', urgent: true, at: NOON });
  assert.ok(urgent.sent);
  assert.deepEqual(seen().map((m) => m.title), ['Orch is down']);

  await push.setNotifications({ snooze: 'off' }, NOON, home);
  const now = await deliver({ title: 'A1 asks: Keep it?', body: 'Again', url: '/orch/', tag: 'ask-e1' }, { kind: 'action', immediate: true, at: NOON });
  assert.ok(now.sent);
  assert.deepEqual(seen().map((m) => m.title), ['Orch is down', 'A1 asks: Keep it?']);

  await push.setNotifications({ weekends_off: true }, new Date(), home);
  const weekend = await deliver({ title: 'B5 needs you', url: '/orch/', tag: 'item-w/B5' }, { kind: 'action', immediate: true, at: SATURDAY });
  assert.equal(weekend.queued.held, true);
  assert.equal(weekend.queued.nextFlushAt.toISOString(), new Date(2026, 9, 19, 8).toISOString());
  assert.deepEqual(read(pushFile('queue.json')).items.map((i) => i.tag), ['item-w/B5']);
  assert.equal(device.received.length, 2);
});

test('every push reaches every subscribed device, now or from the queue, whatever kind', async () => {
  const mac = addDevice('mac');
  const titles = (d) => d.received.map((m) => m.title);
  write(pushFile('subs.json'), [{ ...device.subscription, agent: IPHONE }, { ...mac.subscription, agent: CHROME_MAC }]);
  await deliver({ title: 'A1 asks: Keep it?', url: '/orch/' }, { kind: 'action', immediate: true, at: NOON });
  await deliver({ title: 'Allow Bash?', url: '/orch/' }, { kind: 'prompt', immediate: true, at: NOON });
  await deliver({ title: 'B2 blocks the release', url: '/orch/' }, { kind: 'action', urgent: true, at: NIGHT });
  assert.deepEqual(titles(device), ['A1 asks: Keep it?', 'Allow Bash?', 'B2 blocks the release']);
  assert.deepEqual(titles(mac), titles(device));

  await deliver({ title: 'A3 waits on Merge', url: '/orch/' }, { kind: 'action', at: NOON });
  assert.equal((await flushQueue()).ok, true);
  assert.equal(titles(device).at(-1), 'A3 waits on Merge');
  assert.equal(titles(mac).at(-1), 'A3 waits on Merge');
});

test('removing a subscription forgets that device alone, and one the hub never had changes nothing', () => {
  push.addSubscription({ endpoint: 'https://push.example/b', keys: { p256dh: 'p', auth: 'a' } }, 'https://hub.example/', '', home);
  assert.deepEqual([push.removeSubscription('https://push.example/b', home), push.removeSubscription('https://push.example/missing', home)], [1, 1]);
  assert.deepEqual(read(pushFile('subs.json')).map((s) => s.endpoint), [device.subscription.endpoint]);
});

test('subscriptions name each device by kind and browser with an id that is not its endpoint, and forget one by that id', () => {
  push.addSubscription({ endpoint: 'https://push.example/phone', keys: { p256dh: 'p', auth: 'a' } }, 'https://hub.example/', IPHONE, home);
  push.addSubscription({ endpoint: 'https://push.example/mac', keys: { p256dh: 'p', auth: 'a' } }, 'https://hub.example/', CHROME_MAC, home);
  const all = push.subscriptions(home);
  const mac = all.find((s) => s.kind === 'Mac');
  assert.deepEqual(all.slice(1).map((s) => [s.kind, s.browser]), [['iPhone', 'Safari'], ['Mac', 'Chrome']]);
  assert.ok(all.every((s) => /^[0-9a-f]{16}$/.test(s.id)));
  assert.deepEqual([push.removeSubscriptionById(mac.id, home), push.removeSubscriptionById(mac.id, home)], [2, 2]);
  assert.deepEqual(push.deviceNames('Mozilla/5.0 (Windows NT 10.0) Chrome/141 Safari/537.36 Edg/141'), { kind: 'Windows', browser: 'Edge' });
  assert.deepEqual(push.deviceNames(''), { kind: '', browser: '' });
});

test('old polling windows migrate to quiet hours once, keeping the other settings, and a save writes quiet alone', () => {
  write(settingsFile(), { polling: { windows: [{ from: '07:00', every_minutes: 15 }, { from: '23:00', every_minutes: 60 }], hold_overnight: false, wakes: ['07:00'] }, notifications: { on: true, weekends_off: true }, codexShare: 'auto' });
  assert.deepEqual(push.migrateSettings(home), { start: '23:00', end: '07:00', hold: false });
  assert.deepEqual(read(settingsFile()), { notifications: { on: true, weekends_off: true }, codexShare: 'auto', quiet: { start: '23:00', end: '07:00', hold: false } });
  assert.equal(push.migrateSettings(home), null);
  const saved = push.saveSettings({ quiet: { start: '22:30', end: '07:00', hold: true } }, home);
  assert.deepEqual(saved.quiet, { start: '22:30', end: '07:00', hold: true });
  assert.deepEqual(read(settingsFile()).quiet, saved.quiet);
  assert.equal(read(settingsFile()).codexShare, 'auto');
  assert.throws(() => push.saveSettings({ quiet: { start: '22:30', end: '22:30' } }, home), /different times/);
});

// docs/adr/2026-11-15-0800-owner-actions-follow-state-gone-pushes-close-stale-taps-refused.md
test("withdrawing a gone push drops its queued copy on that board, and closes one already sent on every device, through quiet hours, never while notifications are off", async () => {
  const mac = addDevice('mac');
  write(pushFile('subs.json'), [device.subscription, mac.subscription]);
  await deliver({ title: 'A1: Tap Implement', url: '/orch/#selectedCard=w%2FA1', tag: 'item-w/A1' }, { kind: 'action', at: NOON });
  await deliver({ title: 'Other board', url: '/learn/', tag: 'item-w/A2' }, { kind: 'action', at: NOON });
  const queued = await push.withdraw(['item-w/A1', 'item-w/A2'], 'orch', { home, fetch, at: NIGHT });
  assert.deepEqual(queued, { dropped: ['item-w/A1'], closed: ['item-w/A2'] }, 'the queued one drops; the one not queued went out, so it is closed');
  assert.deepEqual(read(pushFile('queue.json')).items.map((i) => i.title), ['Other board']);
  for (const d of [device, mac]) assert.deepEqual(d.received.map(({ close, title }) => ({ close, title })), [{ close: 'item-w/A2', title: undefined }]);

  await push.setNotifications({ on: false }, NOON, home);
  const off = await push.withdraw(['item-w/A3'], 'orch', { home, fetch, at: NOON });
  assert.deepEqual(off, { dropped: [], closed: [] });
  assert.equal(device.received.length, 1);
});
