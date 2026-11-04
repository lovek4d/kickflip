import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tailscaleBin, tailscaleInstallCommand, tailscaleInstallHint } from './tailscale.mjs';

let home;
beforeEach(() => { home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kickflip-tailscale-'))); });
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

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

test('the install hint names the download page and the cask on macOS, the install script elsewhere', () => {
  assert.equal(tailscaleInstallHint('darwin'), 'install Tailscale from https://tailscale.com/download, or brew install --cask tailscale-app');
  assert.equal(tailscaleInstallHint('linux'), 'curl -fsSL https://tailscale.com/install.sh | sh');
  assert.equal(tailscaleInstallCommand('darwin'), 'brew install --cask tailscale-app');
  assert.equal(tailscaleInstallCommand('linux'), 'curl -fsSL https://tailscale.com/install.sh | sh');
});
