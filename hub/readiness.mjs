// Integrations share their checks and words with the features that wait (docs/adr/0108-integrations-show-readiness-and-features-wait.md).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { githubLogin } from './pr-report.mjs';
import { codexStatusReader } from '../shared/codex.mjs';
import { linearStatus } from './linear.mjs';
import { readSettings, subscriptions } from './push.mjs';
import { tailscaleState, tailscaleInstallHint } from '../bin/install.mjs';

const INTEGRATIONS = [
  ['github', 'GitHub', 'GitHub polling and PR reports wait on this.'],
  ['codex', 'Codex', 'Codex implementing and reviewing wait on this; Codex share stays Off.'],
  ['linear', 'Linear', 'Linear moves and picking Linear for a board’s tickets wait on this.'],
  ['slack', 'Slack', 'Reviewer DMs and digests wait on this.'],
  ['tailscale', 'Tailscale', 'Try builds wait on this.'],
  ['notifications', 'Notifications', 'Pushes wait on this.'],
];
const reportFile = (home) => path.join(home, '.claude', 'kickflip', 'integrations.json');
export function readSlackReport(home = os.homedir()) {
  try { return JSON.parse(fs.readFileSync(reportFile(home), 'utf8')).slack || null; } catch { return null; }
}
export function reportSlack(ready, { home = os.homedir(), now = new Date(), route = null, title = 'Board' } = {}) {
  const file = reportFile(home);
  const report = { ready, at: now.toISOString(), route, title };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ slack: report }, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  return report;
}
const age = (at, now) => {
  const minutes = Math.floor((now - Date.parse(at)) / 60_000);
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.floor(minutes / 60)} h ago` : `${Math.floor(minutes / 1440)} days ago`;
};
const settingsFix = (settings, label, text) => ({ settings, label: `Hub settings › ${label}`, text });

export function readinessRows(checks, { now = Date.now(), platform = process.platform } = {}) {
  const row = (id, value) => {
    switch (id) {
      case 'github': return value ? { ready: true, detail: `gh logged in as ${value}` }
        : { ready: false, missing: "gh isn't logged in on the host", fix: { command: 'gh auth login' } };
      case 'codex': return value.usable ? { ready: true, detail: 'Installed and logged in' }
        : { ready: false, missing: value.words, fix: { command: value.fix } };
      case 'linear': return !value.set ? { ready: false, missing: 'No Linear key set', fix: settingsFix('linear', 'Linear', 'Add one in') }
        : value.refused ? { ready: false, missing: 'Linear refused the key', fix: settingsFix('linear', 'Linear', 'Paste a new one in') }
        : { ready: true, detail: `Key set · ${value.workspace} workspace` };
      case 'slack': {
        const words = value ? `${value.title}’s session reported ${value.ready ? 'a' : 'no'} Slack connector, ${age(value.at, now)}` : 'No board session has reported yet';
        return value?.ready ? { ready: true, detail: words }
          : { ready: false, missing: words, fix: { text: 'Add Slack to Claude’s connectors. The next board session to start reports it.' } };
      }
      case 'tailscale': {
        let missing, command;
        if (!value.installed) { missing = "Tailscale isn't installed on the host"; command = tailscaleInstallHint(platform); }
        else if (!value.signedIn) { missing = "Tailscale isn't signed in"; command = 'tailscale up'; }
        else if (!value.pointsAtHub) { missing = 'Tailscale / is not serving the hub'; command = 'kickflip doctor --fix'; }
        else if (value.operatorChecked && value.operator !== value.username) { missing = `Tailscale operator is ${value.operator || 'none'} (expected ${value.username})`; command = 'sudo tailscale set --operator=$USER'; }
        return missing ? { ready: false, missing, fix: { command } }
          : { ready: true, detail: `Serving ${value.dns}${value.operatorChecked ? ' · operator ' + value.operator : ''}` };
      }
      case 'notifications': return value.on && value.devices ? { ready: true, detail: `Pushes on · ${value.devices} device${value.devices === 1 ? '' : 's'}` }
        : { ready: false, missing: value.on ? 'No device has turned on notifications' : 'Pushes are off', fix: settingsFix('notifications', 'Notifications', 'Turn on notifications in') };
    }
  };
  return INTEGRATIONS.filter(([id]) => Object.hasOwn(checks, id)).map(([id, name, waits]) => ({ id, name, ...row(id, checks[id]), waits }));
}

const asyncRun = (env) => (command, args) => new Promise((resolve) => {
  execFile(command, args, { env, timeout: 3000 }, (error, stdout) => resolve({ status: error ? 1 : 0, stdout }));
});
export function readinessReader({ home = os.homedir(), env = process.env, now = Date.now, cacheMs = 60_000, probes = {} } = {}) {
  const codex = codexStatusReader({ home, env, now, cacheMs });
  const read = {
    github: () => githubLogin({ env }).catch(() => null),
    codex,
    linear: () => linearStatus(home),
    slack: () => readSlackReport(home),
    tailscale: () => tailscaleState({ run: asyncRun(env), port: Number(env.KICKFLIP_HUB_PORT || 4500) }),
    notifications: () => ({ on: readSettings(home).notifications.on, devices: subscriptions(home).length }),
    ...probes,
  };
  const cache = new Map();
  async function check(id, fresh) {
    if (!['github', 'tailscale'].includes(id)) return read[id]({ fresh });
    const saved = cache.get(id);
    if (!fresh && saved && now() - saved.at < cacheMs) return saved.value;
    const value = Promise.resolve().then(() => read[id]());
    cache.set(id, { at: now(), value });
    return value;
  }
  const rows = async ({ fresh = false } = {}) => readinessRows(Object.fromEntries(await Promise.all(INTEGRATIONS.map(async ([id]) => [id, await check(id, fresh)]))), { now: now() });
  async function waiting(id) {
    const [row] = readinessRows({ [id]: await check(id, false) }, { now: now() });
    return row.ready ? null : row.waits.replace('this', `${row.name}: ${row.missing.replace(/\.$/, '')}`);
  }
  return { rows, waiting };
}
export const readCodex = codexStatusReader();
export const readiness = readinessReader({ probes: { codex: readCodex } });
