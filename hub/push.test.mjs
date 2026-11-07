import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFakeDevice } from './fake-device.mjs';

const PUSH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'push.mjs');
let home, device;
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const pushFile = (name) => path.join(home, '.claude', 'kickflip', 'push', name);
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const seen = () => device.received.map(({ title, body, url, tag }) => ({ title, body, url, tag }));
const orchWaits = (count, summary) => ({ total: count + 1, sites: { orch: { count, summary }, ios: null } });
const NOON = 'new Date(2026, 9, 14, 12)';
const NIGHT = 'new Date(2026, 9, 14, 23)';
const SATURDAY = 'new Date(2026, 9, 17, 12)';
const settingsFile = () => path.join(home, '.claude', 'kickflip', 'settings.json');

function inChild(code) {
  const script = `const push = await import(${JSON.stringify(PUSH)}); const out = await (async () => { ${code} })(); console.log(JSON.stringify(out ?? null));`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, HOME: home, KICKFLIP_HUB_PORT: String(device.port) } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out.trim().split('\n').pop())) : reject(new Error(err))));
  });
}

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'push-'));
  device = await startFakeDevice();
  write(pushFile('subs.json'), [device.subscription]);
});
afterEach(async () => {
  await device?.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('deliver refuses a push with no kind or an info kind, sending and queueing nothing', async () => {
  for (const opts of ['{}', "{ kind: 'info', immediate: true }", "{ kind: 'info', urgent: true }"]) {
    const r = await inChild(`try { await push.deliver({ title: 'Answered: keep it?', url: '/orch/' }, { ...${opts}, at: ${NOON} }); return 'sent'; } catch (e) { return [e.constructor.name, e.message]; }`);
    assert.equal(r[0], 'PushKindError', opts);
    assert.match(r[1], /^a push needs --kind action\|prompt\|fault/);
  }
  assert.deepEqual(device.received, []);
  assert.equal(fs.existsSync(pushFile('queue.json')), false);
});

test('an immediate push goes at once in the day, replacing a queued one with its tag, and queues while pushes are held', async () => {
  await inChild(`return push.deliver({ title: 'A1 asks: Which layout?', body: 'Queued', url: '/orch/#selectedCard=w%2FA1', tag: 'item-w/A1' }, { kind: 'action', at: ${NOON} });`);
  await inChild(`return push.deliver({ title: 'A2 waits on Ready', url: '/orch/' }, { kind: 'action', at: ${NOON} });`);
  assert.equal(read(pushFile('queue.json')).items.length, 2);

  const now = await inChild(`return push.deliver({ title: 'A1 asks: Which colour?', body: 'Blue · Red', url: '/orch/#selectedCard=w%2FA1', tag: 'item-w/A1' }, { kind: 'action', immediate: true, at: ${NOON} });`);
  assert.ok(now.sent);
  assert.deepEqual(seen(), [{ title: 'A1 asks: Which colour?', body: 'Blue · Red', url: '/orch/#selectedCard=w%2FA1', tag: 'item-w/A1' }]);
  assert.deepEqual(read(pushFile('queue.json')).items.map((i) => i.title), ['A2 waits on Ready']);

  const held = await inChild(`return push.deliver({ title: 'One needs you', url: '/orch/', tag: 'item-w/A1' }, { kind: 'action', immediate: true, at: ${NIGHT} });`);
  assert.ok(held.queued);
  assert.equal(device.received.length, 1);
  assert.deepEqual(read(pushFile('queue.json')).items.map((i) => i.tag), [undefined, 'item-w/A1']);
});

test('flushing the queue sends a board\'s one push as it is, its several as one summary of what waits now, and a failed send keeps them queued', async () => {
  await inChild(`
    await push.deliver({ title: '2 questions need you', body: 'Which layout?', url: '/orch/questions.html', tag: 'questions-orch' }, { kind: 'action', at: ${NOON} });
    await push.deliver({ title: 'B5 needs you', body: 'Pick one', url: '/orch/#selectedCard=w%2FB5', tag: 'item-w/B5' }, { kind: 'action', at: ${NOON} });
    await push.deliver({ title: 'A3 waits on Merge', url: '/orch/' }, { kind: 'action', at: ${NOON} });
    await push.deliver({ title: 'I2 waits on Ready', url: '/ios/#selectedCard=w%2FI2', tag: 'item-w/I2' }, { kind: 'action', at: ${NOON} });`);
  device.needs = orchWaits(4, '2 questions · 2 drafts waiting on Ready');
  const r = await inChild('return push.flushQueue();');
  assert.deepEqual([r.count, r.sent, r.ok], [4, 2, true]);
  assert.deepEqual(seen(), [
    { title: '4 need you on orch', body: '2 questions · 2 drafts waiting on Ready', url: '/orch/', tag: 'summary:orch' },
    { title: 'I2 waits on Ready', body: '', url: '/ios/#selectedCard=w%2FI2', tag: 'item-w/I2' },
  ]);
  assert.deepEqual(device.received.map((m) => m.badge), [5, 5]);
  assert.deepEqual(read(pushFile('queue.json')).items, []);

  await inChild(`
    await push.deliver({ title: 'A4 waits on Ready', url: '/orch/', tag: 'item-w/A4' }, { kind: 'action', at: ${NOON} });
    await push.deliver({ title: 'A5 waits on Ready', url: '/orch/', tag: 'item-w/A5' }, { kind: 'action', at: ${NOON} });`);
  device.needs = orchWaits(0, '');
  assert.deepEqual(await inChild('return push.flushQueue();'), { count: 2, sent: 0, ok: true, results: [] });
  assert.equal(device.received.length, 2);
  assert.deepEqual(read(pushFile('queue.json')).items, []);

  write(pushFile('subs.json'), [{ ...device.subscription, endpoint: 'http://127.0.0.1:9/device' }]);
  await inChild(`
    await push.deliver({ title: 'A4 waits on Ready', url: '/orch/', tag: 'item-w/A4' }, { kind: 'action', at: ${NOON} });
    await push.deliver({ title: 'A5 waits on Ready', url: '/orch/', tag: 'item-w/A5' }, { kind: 'action', at: ${NOON} });`);
  device.needs = null;
  const failed = await inChild('return push.flushQueue();');
  assert.equal(failed.ok, false);
  assert.deepEqual(read(pushFile('queue.json')).items.map((i) => i.tag), ['item-w/A4', 'item-w/A5']);
});

test('a legacy queued push without a kind still reaches every device when flushed', async () => {
  const mac = await startFakeDevice();
  try {
    write(pushFile('subs.json'), [{ ...device.subscription, agent: IPHONE }, { ...mac.subscription, agent: CHROME_MAC }]);
    write(pushFile('queue.json'), { items: [{ id: 'legacy-prompt', title: 'Allow Bash?', body: '', url: '/orch/', tag: 'prompt-legacy', queuedAt: new Date(2026, 9, 14, 12).toISOString() }] });

    const r = await inChild('return push.flushQueue();');
    assert.equal(r.count, 1);
    assert.equal(r.ok, true);
    assert.deepEqual(device.received.map((m) => m.title), ['Allow Bash?']);
    assert.deepEqual(mac.received.map((m) => m.title), ['Allow Bash?']);
    assert.deepEqual(read(pushFile('queue.json')).items, []);
  } finally {
    await mac.close();
  }
});

test('with notifications off every push is dropped, urgent ones too, and turning them off drops the queue', async () => {
  await inChild(`return push.deliver({ title: 'A3 waits on Merge', url: '/orch/' }, { kind: 'action', at: ${NOON} });`);
  const off = await inChild('return push.setNotifications({ on: false });');
  assert.equal(off.dropped, 1);
  assert.equal(off.notifications.on, false);
  assert.deepEqual(read(pushFile('queue.json')).items, []);
  const results = await inChild(`return [
    await push.deliver({ title: 'A1 asks: Keep it?', url: '/orch/' }, { kind: 'action', immediate: true, at: ${NOON} }),
    await push.deliver({ title: 'Orch is down', url: '/orch/' }, { kind: 'fault', urgent: true, at: ${NOON} }),
    await push.deliver({ title: 'A3 waits on Merge', url: '/orch/' }, { kind: 'action', at: ${NOON} }),
  ];`);
  assert.deepEqual(results, [{ dropped: true }, { dropped: true }, { dropped: true }]);
  assert.deepEqual(device.received, []);
  assert.deepEqual(read(pushFile('queue.json')).items, []);
  assert.deepEqual(read(settingsFile()).notifications, { on: false, weekends_off: false, snoozed_until: null });
});

test('a snooze or the weekend queues pushes until it ends, an urgent push still goes, and undo lets them go', async () => {
  const snoozed = await inChild(`return push.setNotifications({ snooze: '3h' }, ${NOON});`);
  assert.equal(snoozed.notifications.snoozed_until, new Date(2026, 9, 14, 15).toISOString());
  const held = await inChild(`return push.deliver({ title: 'A1 asks: Keep it?', url: '/orch/', tag: 'ask-e1' }, { kind: 'action', immediate: true, at: ${NOON} });`);
  assert.equal(held.queued.held, true);
  assert.equal(held.queued.nextFlushAt, new Date(2026, 9, 14, 15).toISOString());
  const urgent = await inChild(`return push.deliver({ title: 'Orch is down', url: '/orch/' }, { kind: 'fault', urgent: true, at: ${NOON} });`);
  assert.ok(urgent.sent);
  assert.deepEqual(seen().map((m) => m.title), ['Orch is down']);

  await inChild(`return push.setNotifications({ snooze: 'off' }, ${NOON});`);
  const now = await inChild(`return push.deliver({ title: 'A1 asks: Keep it?', body: 'Again', url: '/orch/', tag: 'ask-e1' }, { kind: 'action', immediate: true, at: ${NOON} });`);
  assert.ok(now.sent);
  assert.deepEqual(seen().map((m) => m.title), ['Orch is down', 'A1 asks: Keep it?']);

  await inChild('return push.setNotifications({ weekends_off: true });');
  const weekend = await inChild(`return push.deliver({ title: 'B5 needs you', url: '/orch/', tag: 'item-w/B5' }, { kind: 'action', immediate: true, at: ${SATURDAY} });`);
  assert.equal(weekend.queued.held, true);
  assert.equal(weekend.queued.nextFlushAt, new Date(2026, 9, 19, 8).toISOString());
  assert.deepEqual(read(pushFile('queue.json')).items.map((i) => i.tag), ['item-w/B5']);
  assert.equal(device.received.length, 2);
});

test('every push reaches every subscribed device, now or from the queue, whatever kind', async () => {
  const mac = await startFakeDevice();
  const titles = (d) => d.received.map((m) => m.title);
  try {
    write(pushFile('subs.json'), [{ ...device.subscription, agent: IPHONE }, { ...mac.subscription, agent: CHROME_MAC }]);
    await inChild(`return [
      await push.deliver({ title: 'A1 asks: Keep it?', url: '/orch/' }, { kind: 'action', immediate: true, at: ${NOON} }),
      await push.deliver({ title: 'Allow Bash?', url: '/orch/' }, { kind: 'prompt', immediate: true, at: ${NOON} }),
      await push.deliver({ title: 'B2 blocks the release', url: '/orch/' }, { kind: 'action', urgent: true, at: ${NIGHT} }),
    ];`);
    assert.deepEqual(titles(device), ['A1 asks: Keep it?', 'Allow Bash?', 'B2 blocks the release']);
    assert.deepEqual(titles(mac), titles(device));

    await inChild(`return push.deliver({ title: 'A3 waits on Merge', url: '/orch/' }, { kind: 'action', at: ${NOON} });`);
    assert.equal((await inChild('return push.flushQueue();')).ok, true);
    assert.equal(titles(device).at(-1), 'A3 waits on Merge');
    assert.equal(titles(mac).at(-1), 'A3 waits on Merge');
  } finally {
    await mac.close();
  }
});

test('removing a subscription forgets that device alone, and one the hub never had changes nothing', async () => {
  const r = await inChild(`push.addSubscription({ endpoint: 'https://push.example/b', keys: { p256dh: 'p', auth: 'a' } }, 'https://hub.example/');
    return [push.removeSubscription('https://push.example/b'), push.removeSubscription('https://push.example/missing')];`);
  assert.deepEqual(r, [1, 1]);
  assert.deepEqual(read(pushFile('subs.json')).map((s) => s.endpoint), [device.subscription.endpoint]);
});

test('subscriptions name each device by kind and browser with an id that is not its endpoint, and forget one by that id', async () => {
  const r = await inChild(`push.addSubscription({ endpoint: 'https://push.example/phone', keys: { p256dh: 'p', auth: 'a' } }, 'https://hub.example/', ${JSON.stringify(IPHONE)});
    push.addSubscription({ endpoint: 'https://push.example/mac', keys: { p256dh: 'p', auth: 'a' } }, 'https://hub.example/', ${JSON.stringify(CHROME_MAC)});
    const all = push.subscriptions();
    const mac = all.find((s) => s.kind === 'Mac');
    return { names: all.map((s) => [s.kind, s.browser]), ids: all.map((s) => s.id), left: push.removeSubscriptionById(mac.id), again: push.removeSubscriptionById(mac.id), edge: push.deviceNames('Mozilla/5.0 (Windows NT 10.0) Chrome/141 Safari/537.36 Edg/141'), none: push.deviceNames('') };`);
  assert.deepEqual(r.names.slice(1), [['iPhone', 'Safari'], ['Mac', 'Chrome']]);
  assert.ok(r.ids.every((id) => /^[0-9a-f]{16}$/.test(id)));
  assert.deepEqual([r.left, r.again], [2, 2]);
  assert.deepEqual(r.edge, { kind: 'Windows', browser: 'Edge' });
  assert.deepEqual(r.none, { kind: '', browser: '' });
});

test('old polling windows migrate to quiet hours once, keeping the other settings, and a save writes quiet alone', async () => {
  write(settingsFile(), { polling: { windows: [{ from: '07:00', every_minutes: 15 }, { from: '23:00', every_minutes: 60 }], hold_overnight: false, wakes: ['07:00'] }, notifications: { on: true, weekends_off: true }, codexShare: 'auto' });
  assert.deepEqual(await inChild('return push.migrateSettings();'), { start: '23:00', end: '07:00', hold: false });
  assert.deepEqual(read(settingsFile()), { notifications: { on: true, weekends_off: true }, codexShare: 'auto', quiet: { start: '23:00', end: '07:00', hold: false } });
  assert.equal(await inChild('return push.migrateSettings();'), null);
  const saved = await inChild("return push.saveSettings({ quiet: { start: '22:30', end: '07:00', hold: true } });");
  assert.deepEqual(saved.quiet, { start: '22:30', end: '07:00', hold: true });
  assert.deepEqual(read(settingsFile()).quiet, saved.quiet);
  assert.equal(read(settingsFile()).codexShare, 'auto');
  await assert.rejects(inChild("return push.saveSettings({ quiet: { start: '22:30', end: '22:30' } });"), /different times/);
});
