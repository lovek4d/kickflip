import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// The Tailscale GUI app keeps its CLI inside its bundle. The App Store build never puts it on PATH, and the standalone
// build does only after Settings › CLI integration (tailscale.com/kb/1080/cli). The bundle binary has to run from its
// own path, not through a plain symlink.
const APP_CLI = path.join('Tailscale.app', 'Contents', 'MacOS', 'Tailscale');

const isExecutable = (file) => {
  try { return fs.statSync(file).isFile() && (fs.accessSync(file, fs.constants.X_OK), true); } catch { return false; }
};

// Every tailscale CLI on this host, in the order kickflip tries them: each executable `tailscale` on env's PATH, then on
// macOS the GUI app's own binary in apps. → [path]
export function tailscaleCandidates({ env = process.env, platform = process.platform, apps = ['/Applications', path.join(os.homedir(), 'Applications')] } = {}) {
  const found = (env.PATH || '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, 'tailscale'));
  if (platform === 'darwin') found.push(...apps.map((dir) => path.join(dir, APP_CLI)));
  return [...new Set(found)].filter(isExecutable);
}

// Whether file's daemon is up: its `status --json` says Running.
export function daemonRunning(file) {
  const r = spawnSync(file, ['status', '--json'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
  try { return JSON.parse(r.stdout).BackendState === 'Running'; } catch { return false; }
}

// The tailscale CLI every kickflip call runs. A Mac can have brew's formula on PATH and the GUI app at once, each with
// its own daemon, so with more than one candidate it is the first whose daemon is Running, else the first found
// (docs/adr/2026-11-06-1530-kickflip-runs-the-tailscale-cli-whose-daemon-is-running.md). Looked up on every call,
// since installing, removing, starting or stopping Tailscale changes it. → its path, or null.
export function tailscaleBin({ running = daemonRunning, ...options } = {}) {
  const found = tailscaleCandidates(options);
  return found.length > 1 ? found.find(running) ?? found[0] : found[0] ?? null;
}

// The candidates passed over to reach bin, whose daemons aren't running. → [path]
export function tailscaleSkipped(bin, options = {}) {
  const found = tailscaleCandidates(options);
  return found.includes(bin) ? found.slice(0, found.indexOf(bin)) : [];
}

// The command that installs Tailscale (the cask is the standalone GUI app), and the hint that also names the download
// page, where the App Store build is.
export const tailscaleInstallCommand = (platform = process.platform) => platform === 'darwin'
  ? 'brew install --cask tailscale-app' : 'curl -fsSL https://tailscale.com/install.sh | sh';
export const tailscaleInstallHint = (platform = process.platform) => platform === 'darwin'
  ? `install Tailscale from https://tailscale.com/download, or ${tailscaleInstallCommand(platform)}` : tailscaleInstallCommand(platform);
