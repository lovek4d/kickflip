import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The Tailscale GUI app keeps its CLI inside its bundle. The App Store build never puts it on PATH, and the standalone
// build does only after Settings › CLI integration (tailscale.com/kb/1080/cli). The bundle binary has to run from its
// own path, not through a plain symlink.
const APP_CLI = path.join('Tailscale.app', 'Contents', 'MacOS', 'Tailscale');

const isExecutable = (file) => {
  try { return fs.statSync(file).isFile() && (fs.accessSync(file, fs.constants.X_OK), true); } catch { return false; }
};

// The tailscale CLI every kickflip call runs: the first `tailscale` on env's PATH, else on macOS the GUI app's own
// binary in apps. Looked up on every call, since installing or removing Tailscale changes it. → its path, or null.
export function tailscaleBin({ env = process.env, platform = process.platform, apps = ['/Applications', path.join(os.homedir(), 'Applications')] } = {}) {
  for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const file = path.join(dir, 'tailscale');
    if (isExecutable(file)) return file;
  }
  if (platform !== 'darwin') return null;
  return apps.map((dir) => path.join(dir, APP_CLI)).find(isExecutable) ?? null;
}

// The command that installs Tailscale (the cask is the standalone GUI app), and the hint that also names the download
// page, where the App Store build is.
export const tailscaleInstallCommand = (platform = process.platform) => platform === 'darwin'
  ? 'brew install --cask tailscale-app' : 'curl -fsSL https://tailscale.com/install.sh | sh';
export const tailscaleInstallHint = (platform = process.platform) => platform === 'darwin'
  ? `install Tailscale from https://tailscale.com/download, or ${tailscaleInstallCommand(platform)}` : tailscaleInstallCommand(platform);
