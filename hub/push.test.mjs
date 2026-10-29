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
const pushFile = (name) => path.join(home, '.claude', 'web-ts', 'push', name);
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const seen = () => device.received.map(({ title, body, url, tag }) => ({ title, body, url, tag }));
const NOON = 'new Date(2026, 9, 14, 12)';
const NIGHT = 'new Date(2026, 9, 14, 23)';
const SATURDAY = 'new Date(2026, 9, 17, 12)';
const settingsFile = () => path.join(home, '.claude', 'web-ts', 'settings.json');

function inChild(code) {
  const script = `const push = await import(${JSON.stringify(PUSH)}); const out = await (async () => { ${code} })(); console.log(JSON.stringify(out ?? null));`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, HOME: home, WEB_TS_HUB_PORT: String(device.port) } });
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
  await device.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test('an immediate push goes at once in the day, replacing a queued one with its tag, and queues while pushes are held', async () => {
  await inChild(`return push.deliver({ title: 'Answered: keep it?', body: 'Queued', url: '/orch/#item=ask%3Ae1', tag: 'ask-e1' }, { at: ${NOON} });`);
  await inChild(`return push.deliver({ title: '2 PRs merged', url: '/orch/' }, { at: ${NOON} });`);
  assert.equal(read(pushFile('queue.json')).items.length, 2);

  const now = await inChild(`return push.deliver({ title: 'Answered: keep it?', body: 'Yes', url: '/orch/#item=ask%3Ae1', tag: 'ask-e1' }, { immediate: true, at: ${NOON} });`);
  assert.ok(now.sent);
  assert.deepEqual(seen(), [{ title: 'Answered: keep it?', body: 'Yes', url: '/orch/#item=ask%3Ae1', tag: 'ask-e1' }]);
  assert.deepEqual(read(pushFile('queue.json')).items.map((i) => i.title), ['2 PRs merged']);
  assert.deepEqual(await inChild(`const s = push.lastSent('ask-e1'); return { title: s.title, url: s.url };`), { title: 'Answered: keep it?', url: '/orch/#item=ask%3Ae1' });
  assert.equal(await inChild(`return push.lastSent('ask-e2');`), null);

  const held = await inChild(`return push.deliver({ title: 'One needs you', url: '/orch/', tag: 'item-w/A1' }, { immediate: true, at: ${NIGHT} });`);
  assert.ok(held.queued);
  assert.equal(device.received.length, 1);
  assert.deepEqual(read(pushFile('queue.json')).items.map((i) => i.tag), [undefined, 'item-w/A1']);
});

test('flushing the queue sends each push as its own notification, and a failed send keeps it queued', async () => {
  await inChild(`
    await push.deliver({ title: '2 questions need you', body: 'Which layout?', url: '/orch/questions.html', tag: 'questions-orch' }, { at: ${NOON} });
    await push.deliver({ title: 'B5 needs you', body: 'Pick one', url: '/orch/#item=w%2FB5', tag: 'item-w/B5' }, { at: ${NOON} });
    await push.deliver({ title: '1 PR merged', url: '/orch/' }, { at: ${NOON} });`);
  const r = await inChild('return push.flushQueue();');
  assert.equal(r.count, 3);
  assert.equal(r.ok, true);
  assert.deepEqual(seen(), [
    { title: '2 questions need you', body: 'Which layout?', url: '/orch/questions.html', tag: 'questions-orch' },
    { title: 'B5 needs you', body: 'Pick one', url: '/orch/#item=w%2FB5', tag: 'item-w/B5' },
    { title: '1 PR merged', body: '', url: '/orch/', tag: undefined },
  ]);
  assert.deepEqual(read(pushFile('queue.json')).items, []);
  assert.equal(await inChild(`return push.lastSent('item-w/B5').title;`), 'B5 needs you');

  write(pushFile('subs.json'), [{ ...device.subscription, endpoint: 'http://127.0.0.1:9/device' }]);
  await inChild(`return push.deliver({ title: 'Stale', url: '/orch/', tag: 'stale-A1' }, { at: ${NOON} });`);
  const failed = await inChild('return push.flushQueue();');
  assert.equal(failed.ok, false);
  assert.deepEqual(read(pushFile('queue.json')).items.map((i) => i.tag), ['stale-A1']);
});

test('with notifications off every push is dropped, urgent ones too, and turning them off drops the queue', async () => {
  await inChild(`return push.deliver({ title: '2 PRs merged', url: '/orch/' }, { at: ${NOON} });`);
  const off = await inChild('return push.setNotifications({ on: false });');
  assert.equal(off.dropped, 1);
  assert.equal(off.notifications.on, false);
  assert.deepEqual(read(pushFile('queue.json')).items, []);
  const results = await inChild(`return [
    await push.deliver({ title: 'Answered', url: '/orch/' }, { immediate: true, at: ${NOON} }),
    await push.deliver({ title: 'Prod down', url: '/orch/' }, { urgent: true, at: ${NOON} }),
    await push.deliver({ title: '1 PR merged', url: '/orch/' }, { at: ${NOON} }),
  ];`);
  assert.deepEqual(results, [{ dropped: true }, { dropped: true }, { dropped: true }]);
  assert.deepEqual(device.received, []);
  assert.deepEqual(read(pushFile('queue.json')).items, []);
  assert.deepEqual(read(settingsFile()).notifications, { on: false, weekends_off: false, snoozed_until: null });
});

test('a snooze or the weekend queues pushes until it ends, an urgent push still goes, and undo lets them go', async () => {
  const snoozed = await inChild(`return push.setNotifications({ snooze: '3h' }, ${NOON});`);
  assert.equal(snoozed.notifications.snoozed_until, new Date(2026, 9, 14, 15).toISOString());
  const held = await inChild(`return push.deliver({ title: 'Answered', url: '/orch/', tag: 'ask-e1' }, { immediate: true, at: ${NOON} });`);
  assert.equal(held.queued.held, true);
  assert.equal(held.queued.nextFlushAt, new Date(2026, 9, 14, 15).toISOString());
  const urgent = await inChild(`return push.deliver({ title: 'Prod down', url: '/orch/' }, { urgent: true, at: ${NOON} });`);
  assert.ok(urgent.sent);
  assert.deepEqual(seen().map((m) => m.title), ['Prod down']);

  await inChild(`return push.setNotifications({ snooze: 'off' }, ${NOON});`);
  const now = await inChild(`return push.deliver({ title: 'Answered', body: 'Again', url: '/orch/', tag: 'ask-e1' }, { immediate: true, at: ${NOON} });`);
  assert.ok(now.sent);
  assert.deepEqual(seen().map((m) => m.title), ['Prod down', 'Answered']);

  await inChild('return push.setNotifications({ weekends_off: true });');
  const weekend = await inChild(`return push.deliver({ title: 'B5 needs you', url: '/orch/', tag: 'item-w/B5' }, { immediate: true, at: ${SATURDAY} });`);
  assert.equal(weekend.queued.held, true);
  assert.equal(weekend.queued.nextFlushAt, new Date(2026, 9, 19, 8).toISOString());
  assert.deepEqual(read(pushFile('queue.json')).items.map((i) => i.tag), ['item-w/B5']);
  assert.equal(device.received.length, 2);
});
