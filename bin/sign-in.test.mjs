// docs/adr/2026-11-18-1200-the-owner-signs-in-with-a-link-that-sets-a-device-cookie.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../shared/temp-dir.mjs';
import { SIGN_IN_COOKIE, redeemSignIn, signedIn, tokenOf } from '../shared/owner-sign-in.mjs';

const KICKFLIP = fileURLToPath(new URL('./kickflip.mjs', import.meta.url));
const kickflip = (home, ...args) => spawnSync(process.execPath, [KICKFLIP, ...args], {
  cwd: home, encoding: 'utf8', env: { ...process.env, HOME: home, KICKFLIP_HUB_PORT: '4599', KICKFLIP_TAILSCALE: path.join(home, 'no-tailscale') },
});

test('kickflip sign-in prints a link on this host that signs in one device, and sign-out signs every device out', async () => {
  const home = tempDir('sign-in-cli-');
  const made = kickflip(home, 'sign-in');
  assert.equal(made.status, 0, made.stderr);
  const [line, link] = made.stdout.trim().split('\n');
  assert.equal(line, 'Open this link on the device to sign in, within 10 minutes. It signs in one device.');
  assert.match(link, /^http:\/\/127\.0\.0\.1:4599\/_hub\/sign-in\?t=[\w-]+$/);
  const device = await redeemSignIn(tokenOf(link), { home });
  assert.ok(device, 'the printed link signs a device in');
  assert.equal(signedIn({ headers: { cookie: `${SIGN_IN_COOKIE}=${device}` } }, home), true);

  const out = kickflip(home, 'sign-out');
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout.trim(), 'Signed out 1 device. Each needs kickflip sign-in again.');
  assert.equal(signedIn({ headers: { cookie: `${SIGN_IN_COOKIE}=${device}` } }, home), false);
});
