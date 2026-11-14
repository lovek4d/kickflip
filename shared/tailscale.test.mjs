import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tailscaleBin, tailscaleSkipped, daemonRunning, tailscaleInstallCommand, tailscaleInstallHint } from './tailscale.mjs';
import { tempDir } from './temp-dir.mjs';

let home;
beforeEach(() => { home = fs.realpathSync(tempDir('kickflip-tailscale-')); });

const executable = (file, mode = 0o755) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\n', { mode });
  return file;
};
const bundle = (apps) => path.join(apps, 'Tailscale.app', 'Contents', 'MacOS', 'Tailscale');

test('tailscaleBin finds tailscale on PATH first, then on macOS the GUI app’s own binary, else null', () => {
  const apps = [path.join(home, 'Applications'), path.join(home, 'user', 'Applications')];
  const empty = path.join(home, 'empty');
  fs.mkdirSync(empty);
  const resolve = (PATH, platform = 'darwin') => tailscaleBin({ env: { PATH }, platform, apps });
  assert.equal(resolve(empty), null);
  const userApp = executable(bundle(apps[1]));
  assert.equal(resolve(empty), userApp);
  const systemApp = executable(bundle(apps[0]));
  assert.equal(resolve(empty), systemApp);
  const onPath = executable(path.join(home, 'bin', 'tailscale'));
  assert.equal(resolve(`${empty}:${path.join(home, 'bin')}`), onPath);
  // Linux has no app bundle to fall back to.
  assert.equal(resolve(empty, 'linux'), null);
  assert.equal(resolve(path.join(home, 'bin'), 'linux'), onPath);
});

test('tailscaleBin skips a tailscale that isn’t an executable file, and reads PATH on every call', () => {
  const apps = [path.join(home, 'Applications')];
  const dir = path.join(home, 'bin');
  fs.mkdirSync(path.join(dir, 'tailscale'), { recursive: true });
  const resolve = () => tailscaleBin({ env: { PATH: dir }, platform: 'darwin', apps });
  assert.equal(resolve(), null);
  executable(bundle(apps[0]), 0o644);
  assert.equal(resolve(), null);
  fs.chmodSync(bundle(apps[0]), 0o755);
  assert.equal(resolve(), bundle(apps[0]));
  fs.rmSync(path.join(dir, 'tailscale'), { recursive: true });
  executable(path.join(dir, 'tailscale'));
  assert.equal(resolve(), path.join(dir, 'tailscale'));
});

test('with brew’s tailscale on PATH and the GUI app both installed, kickflip runs the first whose daemon is Running, and names the one it skipped', () => {
  const apps = [path.join(home, 'Applications')];
  const brew = executable(path.join(home, 'bin', 'tailscale'));
  const app = executable(bundle(apps[0]));
  const options = { env: { PATH: path.join(home, 'bin') }, platform: 'darwin', apps };
  const asked = [];
  const pick = (up) => tailscaleBin({ ...options, running: (file) => { asked.push(file); return up.includes(file); } });
  assert.equal(pick([app]), app);
  assert.deepEqual(tailscaleSkipped(app, options), [brew]);
  assert.equal(pick([brew, app]), brew);
  assert.deepEqual(tailscaleSkipped(brew, options), []);
  // With no daemon running, the first found, so doctor's fix names that one.
  assert.equal(pick([]), brew);
  // A lone CLI is never asked.
  asked.length = 0;
  fs.rmSync(app);
  assert.equal(pick([]), brew);
  assert.deepEqual(asked, []);
  assert.deepEqual(tailscaleSkipped(null, options), []);
});

test('a daemon counts as running only when its CLI’s status --json says Running', () => {
  const cli = (body) => { const file = path.join(home, `cli-${Math.random()}`); fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return file; };
  assert.equal(daemonRunning(cli(`echo '{"BackendState":"Running"}'`)), true);
  assert.equal(daemonRunning(cli(`echo '{"BackendState":"Stopped"}'; exit 1`)), false);
  assert.equal(daemonRunning(cli('echo "failed to connect to local tailscaled" >&2; exit 1')), false);
  assert.equal(daemonRunning(path.join(home, 'missing')), false);
});

test('the install hint names the download page and the cask on macOS, the install script elsewhere', () => {
  assert.equal(tailscaleInstallHint('darwin'), 'install Tailscale from https://tailscale.com/download, or brew install --cask tailscale-app');
  assert.equal(tailscaleInstallHint('linux'), 'curl -fsSL https://tailscale.com/install.sh | sh');
  assert.equal(tailscaleInstallCommand('darwin'), 'brew install --cask tailscale-app');
  assert.equal(tailscaleInstallCommand('linux'), 'curl -fsSL https://tailscale.com/install.sh | sh');
});

test('KICKFLIP_TAILSCALE names the one tailscale CLI kickflip runs, over a Running daemon elsewhere on PATH or in the app', () => {
  const apps = [path.join(home, 'Applications')];
  const brew = executable(path.join(home, 'bin', 'tailscale'));
  executable(bundle(apps[0]));
  const stub = executable(path.join(home, 'stub', 'tailscale'));
  const options = { env: { PATH: path.join(home, 'bin'), KICKFLIP_TAILSCALE: stub }, platform: 'darwin', apps };
  const asked = [];
  assert.equal(tailscaleBin({ ...options, running: (file) => { asked.push(file); return file === brew; } }), stub);
  assert.deepEqual(asked, []);
  assert.deepEqual(tailscaleSkipped(stub, options), []);
});
