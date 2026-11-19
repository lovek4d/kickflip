// docs/adr/2026-11-19-0130-a-device-signs-in-with-a-60-second-pin-and-three-misses-block-it.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../shared/temp-dir.mjs';
import { SIGN_IN_COOKIE, blockedClients, devicesOf, makePin, redeemPin, signInFile, signedIn } from '../shared/owner-sign-in.mjs';

const KICKFLIP = fileURLToPath(new URL('./kickflip.mjs', import.meta.url));
const envOf = (home, PATH = '/usr/bin:/bin') => ({ ...process.env, HOME: home, PATH, KICKFLIP_HUB_PORT: '4599', KICKFLIP_TAILSCALE: path.join(home, 'no-tailscale') });
const kickflip = (home, args, PATH) => spawnSync(process.execPath, [KICKFLIP, ...args], { cwd: home, encoding: 'utf8', env: envOf(home, PATH) });
const signIn = async (home, client) => (await redeemPin((await makePin({ home })).pin, client, { home })).device;
const phone = { key: 'node:pixel-8', name: 'pixel-8', ip: '100.64.0.31' };
const laptop = { key: 'ip:192.168.1.9', name: 'Safari on Mac', ip: '192.168.1.9' };
// An fzf on PATH that picks the line its FZF_PICK names (counting from 1) and logs its arguments, or picks none at 0.
function fakeFzf(home) {
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'fzf'), `#!/bin/sh\necho "$@" > "${home}/fzf.args"\n[ "$FZF_PICK" = 0 ] && cat > /dev/null && exit 130\nsed -n "\${FZF_PICK}p"\n`, { mode: 0o755 });
  return `${bin}:/usr/bin:/bin`;
}

// kickflip link run piped, its output read until its first PIN line. → {child, text(), pin}
async function link(home) {
  const child = spawn(process.execPath, [KICKFLIP, 'link'], { cwd: home, env: envOf(home) });
  let text = '';
  child.stdout.on('data', (c) => { text += c; });
  while (!/PIN: \d{4} \d{4}/.test(text)) await once(child.stdout, 'data');
  return { child, text: () => text, pin: /PIN: (\d{4}) (\d{4})/.exec(text).slice(1).join('') };
}

test('kickflip link prints just the address and the PIN line, and Ctrl-C voids the PIN', async () => {
  const home = tempDir('sign-in-cli-');
  const { child, text, pin } = await link(home);
  assert.deepEqual(text().trim().split('\n'), ['http://127.0.0.1:4599/', `PIN: ${pin.slice(0, 4)} ${pin.slice(4)} (expires in 60 s)`],
    'with the tailnet off, this host\'s address, then the PIN');
  assert.equal(JSON.parse(fs.readFileSync(signInFile(home), 'utf8')).pins.length, 1, 'the PIN is live');
  child.kill('SIGINT');
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  assert.equal(text().trim().split('\n').at(-1), `PIN: ${pin.slice(0, 4)} ${pin.slice(4)} (voided)`);
  assert.deepEqual(await redeemPin(pin, phone, { home }), { left: 2 }, 'a stopped kickflip link voids its PIN');
});

test('kickflip link exits once its PIN signs a device in, naming the device', async () => {
  const home = tempDir('sign-in-cli-');
  const { child, text, pin } = await link(home);
  assert.ok((await redeemPin(pin, phone, { home })).device);
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  assert.equal(text().trim().split('\n').at(-1), `PIN: ${pin.slice(0, 4)} ${pin.slice(4)} (used by pixel-8)`);
  assert.doesNotMatch(text(), /fresh PIN/);
});

test('kickflip devices lists the signed-in devices; unlink signs one out, named or picked with fzf; sign-out signs every one out', async () => {
  const home = tempDir('sign-in-cli-');
  assert.equal(kickflip(home, ['devices']).stdout.trim(), 'No device is signed in. Sign one in with kickflip link.');
  const first = await signIn(home, phone);
  const second = await signIn(home, laptop);
  const third = await signIn(home, { key: 'ip:x', name: 'Chrome on Android', ip: '100.64.0.44' });
  const listed = kickflip(home, ['devices']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.deepEqual(listed.stdout.trim().split('\n').sort(), [
    'Chrome on Android  100.64.0.44  signed in just now · seen just now',
    'Safari on Mac  192.168.1.9  signed in just now · seen just now',
    'pixel-8  100.64.0.31  signed in just now · seen just now',
  ]);

  const named = kickflip(home, ['unlink', 'pixel-8']);
  assert.deepEqual([named.status, named.stdout.trim()], [0, 'Removed pixel-8.'], named.stderr);
  assert.equal(signedIn({ headers: { cookie: `${SIGN_IN_COOKIE}=${first}` } }, home), false);
  assert.equal(kickflip(home, ['unlink', 'nobody']).status, 2);

  const PATH = fakeFzf(home);
  const pick = devicesOf(home).findIndex((d) => d.name === 'Safari on Mac') + 1;
  const picked = spawnSync(process.execPath, [KICKFLIP, 'unlink'], { cwd: home, encoding: 'utf8', env: { ...envOf(home, PATH), FZF_PICK: String(pick) } });
  assert.deepEqual([picked.status, picked.stdout.trim()], [0, 'Removed Safari on Mac.'], picked.stderr);
  assert.match(fs.readFileSync(path.join(home, 'fzf.args'), 'utf8'), /--with-nth 2\.\. --prompt unlink >  --header enter removes the device · esc cancels/);
  assert.equal(signedIn({ headers: { cookie: `${SIGN_IN_COOKIE}=${second}` } }, home), false);
  const cancelled = spawnSync(process.execPath, [KICKFLIP, 'unlink'], { cwd: home, encoding: 'utf8', env: { ...envOf(home, PATH), FZF_PICK: '0' } });
  assert.equal(cancelled.stdout.trim(), 'Nothing removed.');
  assert.equal(signedIn({ headers: { cookie: `${SIGN_IN_COOKIE}=${third}` } }, home), true);

  const out = kickflip(home, ['sign-out']);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout.trim(), 'Signed out 1 device. Each needs a new PIN from kickflip link.');
  assert.equal(signedIn({ headers: { cookie: `${SIGN_IN_COOKIE}=${third}` } }, home), false);
});

test('kickflip unblock lets a blocked device in again, named or picked with fzf', async () => {
  const home = tempDir('sign-in-cli-');
  assert.equal(kickflip(home, ['unblock']).stdout.trim(), 'No device is blocked.');
  for (const client of [phone, laptop]) for (let i = 0; i < 3; i++) await redeemPin('nope', client, { home });
  assert.equal(blockedClients(home).length, 2);
  const noFzf = kickflip(home, ['unblock']);
  assert.equal(noFzf.status, 2);
  assert.match(noFzf.stderr, /fzf isn't installed: name one, such as kickflip unblock /);
  const named = kickflip(home, ['unblock', '100.64.0.31']);
  assert.deepEqual([named.status, named.stdout.trim()], [0, 'Unblocked pixel-8 (100.64.0.31).'], named.stderr);
  const picked = spawnSync(process.execPath, [KICKFLIP, 'unblock'], { cwd: home, encoding: 'utf8', env: { ...envOf(home, fakeFzf(home)), FZF_PICK: '1' } });
  assert.deepEqual([picked.status, picked.stdout.trim()], [0, 'Unblocked Safari on Mac (192.168.1.9).'], picked.stderr);
  assert.deepEqual(blockedClients(home), []);
  assert.deepEqual(await redeemPin('nope', phone, { home }), { left: 2 });
});
