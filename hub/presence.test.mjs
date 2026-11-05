import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPresence, ownerTracker, IDLE_LIMIT_MS } from './presence.mjs';

const SECOND_NS = 1e9;
const ioreg = ({ locked, idle }) => async (args) => {
  if (args.includes('Root')) return locked === undefined ? '"IOConsoleLocked" = No\n' : `"IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"CGSSessionScreenIsLocked"=${locked ? 'Yes' : 'No'}})\n`;
  return idle === undefined ? '"IOClass" = "IOHIDSystem"\n' : `"HIDIdleTime" = ${idle}\n`;
};

test('the owner is at the Mac only while it is unlocked and used in the last 3 minutes, and away when ioreg fails', async () => {
  assert.deepEqual(await readPresence(ioreg({ idle: 30 * SECOND_NS })), { atMac: true, locked: false, idleMs: 30_000 });
  assert.deepEqual(await readPresence(ioreg({ locked: false, idle: 179 * SECOND_NS })), { atMac: true, locked: false, idleMs: 179_000 });
  assert.deepEqual(await readPresence(ioreg({ locked: true, idle: SECOND_NS })), { atMac: false, locked: true, idleMs: 1000 });
  assert.deepEqual(await readPresence(ioreg({ idle: 180 * SECOND_NS })), { atMac: false, locked: false, idleMs: 180_000 });
  assert.equal((await readPresence(ioreg({}))).atMac, false);

  const failing = await readPresence(async () => { throw new Error('spawn ioreg ENOENT'); });
  assert.deepEqual(failing, { atMac: false, error: 'spawn ioreg ENOENT' });
});

test('the owner is present while at the Mac or within 3 minutes of a page beat, and coming back is noted once', async () => {
  let now = 1_000_000;
  let atMac = false;
  const owner = ownerTracker({ read: async () => ({ atMac }), clock: () => now });
  assert.deepEqual(owner.state(), { present: false, backAt: null });
  assert.deepEqual(await owner.check(), { present: false, changed: false, back: false });
  assert.deepEqual(owner.beat(), { present: true, changed: true, back: true });
  assert.deepEqual(owner.state(), { present: true, backAt: now });
  now += 60_000;
  assert.deepEqual(owner.beat(), { present: true, changed: false, back: false });
  now += IDLE_LIMIT_MS - 1;
  assert.deepEqual(await owner.check(), { present: true, changed: false, back: false });
  now += 1;
  assert.deepEqual(await owner.check(), { present: false, changed: true, back: false });
  atMac = true;
  now += 5_000;
  assert.deepEqual(await owner.check(), { present: true, changed: true, back: true });
  assert.equal(owner.state().backAt, now);
  assert.deepEqual(owner.beat(), { present: true, changed: false, back: false });
});
