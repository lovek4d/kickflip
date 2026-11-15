// Integrations share their checks and words with the features that wait (docs/adr/2026-11-02-1118-integrations-show-readiness-and-features-wait.md).
import os from 'node:os';
import { execFile } from 'node:child_process';
import { githubLogin } from './pr-report.mjs';
import { clock } from './schedule.mjs';
import { gateFile, limitedUntil } from '../shared/gh.mjs';
import { codexStatusReader } from '../shared/codex.mjs';
import { linearStatus } from './linear.mjs';
import { slackStatus } from './slack.mjs';
import { readSettings, subscriptions } from './push.mjs';
import { tailscaleState } from '../bin/install.mjs';
import { tailscaleBin, tailscaleInstallCommand } from '../shared/tailscale.mjs';

// The third entry is the sentence a missing integration shows, or null for a row that shows none. Linear and Slack rows carry keyButton, the words of the
// button that opens their key modal on the Hub page, in every state (docs/adr/2026-11-09-2230-linear-and-slack-keys-open-in-modals-from-their-integrations-rows.md).
// Slack's row shows no waits line, but its sends still wait on it.
const GATES = { slack: 'Reviewer DMs and digests wait on this.' };
const INTEGRATIONS = [
  ['github', 'GitHub', 'GitHub polling and PR reports wait on this.'],
  ['codex', 'Codex', 'Codex implementing and reviewing wait on this; Codex share stays Off.'],
  ['linear', 'Linear', null],
  ['slack', 'Slack', null],
  ['tailscale', 'Tailscale', 'Try builds wait on this.'],
  ['notifications', 'Notifications', 'Pushes wait on this.'],
];
// A ready integration can still lack a permission a feature needs: its row carries permissions, {missing: [{scope, effect}], fix},
// which the hub page draws as amber degraded with a sheet saying what stops working and the one fix
// (docs/adr/2026-11-15-0730-an-integration-missing-a-permission-reads-degraded.md). Each entry maps a flag its status
// sets to the scope and what stops working without it. Slack's token sends on without these: without im:history
// reviewers' replies in the day threads wait unheard (docs/adr/2026-11-12-0000-reviewers-ask-the-board-in-the-day-thread.md),
// and without search:read @kickflip DMs wait unfiled (docs/adr/2026-11-15-0130-an-at-kickflip-in-a-slack-dm-is-filed-as-a-routed-ask.md).
const PERMISSIONS = {
  slack: {
    scopes: [['unheard', 'im:history', "Review-thread replies aren't heard"], ['unsearched', 'search:read', "@kickflip in your DMs isn't found"]],
    fix: 'Add these scopes to the Slack app, reinstall it, paste the new token',
  },
};
function permissionsOf(id, value) {
  const missing = (PERMISSIONS[id]?.scopes ?? []).filter(([flag]) => value[flag]).map(([, scope, effect]) => ({ scope, effect }));
  return missing.length ? { permissions: { missing, fix: PERMISSIONS[id].fix } } : {};
}
const settingsFix =(settings, label, text) => ({ settings, label: `Hub settings › ${label}`, text });

export function readinessRows(checks, { now = Date.now(), platform = process.platform } = {}) {
  const row = (id, value) => {
    switch (id) {
      // value: gh's login, null when gh has none, or {limited: the reset} while GitHub's limit holds gh's account
      // (docs/adr/2026-11-09-1626-gh-refuses-while-githubs-hourly-limit-holds.md).
      case 'github': return value?.limited ? { ready: false, limited: true, missing: `resets at ${clock(new Date(value.limited), new Date(now))}` }
        : value ? { ready: true, detail: `gh logged in as ${value}` }
        : { ready: false, missing: "gh isn't logged in on the host", fix: { command: 'gh auth login' } };
      case 'codex': return value.usable ? { ready: true, detail: 'Installed and logged in' }
        : { ready: false, missing: value.words, fix: { command: value.fix } };
      case 'linear': return !value.set ? { ready: false, missing: 'No Linear key set', keyButton: 'Add key' }
        : value.refused ? { ready: false, missing: 'Linear refused the key', keyButton: 'Change key' }
        : { ready: true, detail: `Key set · ${value.workspace} workspace`, keyButton: 'Change key' };
      case 'slack': return !value.set ? { ready: false, missing: 'No Slack token set', keyButton: 'Add key' }
        : value.refused ? { ready: false, missing: 'Slack refused the token', keyButton: 'Change key' }
        : { ready: true, detail: `Token set · ${value.team} workspace, sending as ${value.user}`, keyButton: 'Change key' };
      case 'tailscale': {
        let missing, command;
        if (!value.installed) { missing = "Tailscale isn't installed on the host"; command = tailscaleInstallCommand(platform); }
        else if (!value.signedIn) { missing = "Tailscale isn't signed in"; command = 'tailscale up'; }
        else if (!value.pointsAtHub) { missing = 'Tailscale / is not serving the hub'; command = 'kickflip doctor --fix'; }
        else if (value.operatorChecked && value.operator !== value.username) { missing = `Tailscale operator is ${value.operator || 'none'} (expected ${value.username})`; command = 'sudo tailscale set --operator=$USER'; }
        return missing ? { ready: false, missing, fix: { command } }
          : { ready: true, detail: `Serving ${value.dns}${value.operatorChecked ? ' · operator ' + value.operator : ''}` };
      }
      case 'notifications': return value.on && value.devices.length ? { ready: true, detail: `Pushes on · ${value.devices.length} device${value.devices.length === 1 ? '' : 's'}`, devices: value.devices.map(({ id, kind, browser, added }) => ({ id, kind, browser, added })) }
        : { ready: false, missing: value.on ? 'No device has turned on notifications' : 'Pushes are off', fix: settingsFix('notifications', 'Notifications', 'Turn on notifications in') };
    }
  };
  return INTEGRATIONS.filter(([id]) => Object.hasOwn(checks, id)).map(([id, name, waits]) => {
    const r = row(id, checks[id]);
    return { id, name, ...r, ...(r.ready ? permissionsOf(id, checks[id]) : {}), waits };
  });
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
    slack: () => slackStatus(home),
    tailscale: () => tailscaleState({ run: asyncRun(env), port: Number(env.KICKFLIP_HUB_PORT || 4500), tailscale: tailscaleBin({ env }) }),
    notifications: () => ({ on: readSettings(home).notifications.on, devices: subscriptions(home) }),
    ...probes,
  };
  const cache = new Map();
  async function check(id, fresh) {
    if (!['github', 'tailscale'].includes(id)) return read[id]({ fresh });
    const limited = id === 'github' && limitedUntil({ file: gateFile(home), now: now() });
    if (limited) return { limited };
    const saved = cache.get(id);
    if (!fresh && saved && now() - saved.at < cacheMs) return saved.value;
    const value = Promise.resolve().then(() => read[id]());
    cache.set(id, { at: now(), value });
    return value;
  }
  const rows = async ({ fresh = false } = {}) => readinessRows(Object.fromEntries(await Promise.all(INTEGRATIONS.map(async ([id]) => [id, await check(id, fresh)]))), { now: now() });
  async function waiting(id) {
    const [row] = readinessRows({ [id]: await check(id, false) }, { now: now() });
    const waits = row.waits ?? GATES[id];
    return row.ready || !waits ? null : waits.replace('this', `${row.name}: ${row.missing.replace(/\.$/, '')}`);
  }
  return { rows, waiting };
}
export const readCodex = codexStatusReader();
export const readiness = readinessReader({ probes: { codex: readCodex } });
