import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { read as readSettingsFile, updateSync as updateSettings } from './hub-settings.mjs';

// The Tailscale daemon kickflip talks to, and how it reaches it
// (docs/adr/2026-11-17-0311-kickflip-records-the-tailscale-daemon-it-uses.md). A Mac can run two at once: brew's
// standalone tailscaled on DARWIN_SOCKET, and the GUI app's own. A daemon is {kind, cli, socket?, node?}:
// - tailscaled: brew's, reached by the first `tailscale` on PATH with `--socket`, which talks only to that socket. A CLI
//   without --socket asks the GUI app first and falls back to the socket.
// - app: the GUI app's, reached by the CLI inside its bundle. The App Store build never puts that CLI on PATH, and the
//   standalone build does only after Settings › CLI integration (tailscale.com/kb/1080/cli). It has to run from its own
//   path, not through a plain symlink. With the app quit it falls back to DARWIN_SOCKET and answers as brew's node.
// - cli: a lone CLI and the daemon it reaches by default, on Linux or when env KICKFLIP_TAILSCALE names it.
// node: the Self.ID the daemon answered as when it was picked, so a status read can tell a fall-through.
export const DARWIN_SOCKET = '/var/run/tailscaled.socket';
const APP_CLI = path.join('Tailscale.app', 'Contents', 'MacOS', 'Tailscale');
const APPS = ['/Applications', path.join(os.homedir(), 'Applications')];

const isExecutable = (file) => {
  try { return fs.statSync(file).isFile() && (fs.accessSync(file, fs.constants.X_OK), true); } catch { return false; }
};

// Every daemon kickflip can reach on this host, brew's before the app's. env KICKFLIP_TAILSCALE names the only one, as a
// try run's demo hub is given its failing stub so it never touches the host's Tailscale. → [daemon]
export function tailscaleDaemons({ env = process.env, platform = process.platform, apps = APPS } = {}) {
  if (env.KICKFLIP_TAILSCALE) return [{ kind: 'cli', cli: env.KICKFLIP_TAILSCALE }];
  const cli = (env.PATH || '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, 'tailscale')).find(isExecutable);
  if (platform !== 'darwin') return cli ? [{ kind: 'cli', cli }] : [];
  const app = apps.map((dir) => path.join(dir, APP_CLI)).find(isExecutable);
  return [...(cli ? [{ kind: 'tailscaled', cli, socket: DARWIN_SOCKET }] : []), ...(app ? [{ kind: 'app', cli: app }] : [])];
}

// → [file, argv] that runs `tailscale <args>` against daemon.
export const tailscaleArgv = (daemon, args) => [daemon.cli, [...(daemon.socket ? ['--socket', daemon.socket] : []), ...args]];

const readJson = (daemon, args) => {
  const r = spawnSync(...tailscaleArgv(daemon, args), { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
  try { return JSON.parse(r.stdout); } catch { return null; }
};
// → daemon's `status --json`, or null when it doesn't answer.
export const daemonStatus = (daemon) => readJson(daemon, ['status', '--json']);

const isRunning = (status) => status?.BackendState === 'Running';

// The `/` proxy of a `serve status --json` config and every path it serves on 443.
export function tailscaleRoot(config) {
  const handlers = Object.entries(config?.Web || {}).filter(([host]) => !/:\d+$/.test(host) || host.endsWith(':443')).flatMap(([, web]) => Object.entries(web.Handlers || {}));
  return { root: handlers.find(([route]) => route === '/')?.[1]?.Proxy || null, paths: [...new Set(handlers.map(([route]) => route))] };
}
// Whether a serve config maps / to the hub on this host's port.
export function servesHub(config, port) {
  try {
    const url = new URL(tailscaleRoot(config).root);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && Number(url.port) === port && url.pathname === '/' && !url.search && !url.hash;
  } catch { return false; }
}
const hubPort = (env) => Number(env.KICKFLIP_HUB_PORT || 4500);

// The running daemons, each with its status. One that answers as an earlier one's node is that daemon reached by a
// fall-through (the app quit), so it isn't running. → [{daemon, status}]
function runningDaemons(daemons, status) {
  const seen = new Set();
  return daemons.map((daemon) => ({ daemon, status: status(daemon) })).filter(({ status: s }) => {
    if (!isRunning(s)) return false;
    const fresh = !seen.has(s.Self?.ID);
    seen.add(s.Self?.ID);
    return fresh;
  });
}

// Init's rule (owner, gh481-pick-rule): of the running daemons, the one serving / to the hub, else the app's, else the
// first. With none running, the app's, else the first, with no node. serves(daemon) → whether it serves the hub.
// → daemon with its node, or null.
export function pickDaemon(daemons, { status = daemonStatus, serves }) {
  const up = runningDaemons(daemons, status);
  const chosen = up.find(({ daemon }) => serves(daemon)) ?? up.find(({ daemon }) => daemon.kind === 'app') ?? up[0];
  if (chosen) return { ...chosen.daemon, node: chosen.status.Self?.ID };
  return daemons.find((daemon) => daemon.kind === 'app') ?? daemons[0] ?? null;
}

const defaults = ({ env = process.env, home = os.homedir(), port = hubPort(env), status = daemonStatus, serves = (daemon) => servesHub(readJson(daemon, ['serve', 'status', '--json']), port), ...options } = {}) => ({ env, home, status, serves, ...options });

// Picks by init's rule and records the pick in the hub's settings.json as `tailscale`, for doctor --fix and init. A pick
// with no daemon running has no node and isn't recorded, so a recorded daemon stays until another runs.
// → the pick, or null.
export function repickDaemon(options) {
  const { env, home, status, serves, ...rest } = defaults(options);
  if (env.KICKFLIP_TAILSCALE) return tailscaleDaemons({ env, ...rest })[0];
  const daemon = pickDaemon(tailscaleDaemons({ env, ...rest }), { status, serves });
  if (daemon?.node) updateSettings((settings) => ({ ...settings, tailscale: daemon }), home);
  return daemon;
}

// The daemon every kickflip call runs: the recorded one, down or not (owner, gh481-recorded-down), else a pick made and
// recorded now (gh481-no-record). Read on every call, since doctor --fix can record another. → daemon, or null.
export function tailscaleDaemon(options) {
  const { env, home } = defaults(options);
  const recorded = readSettingsFile(home).tailscale;
  if (!env.KICKFLIP_TAILSCALE && recorded?.cli && recorded.node) return recorded;
  return repickDaemon(options);
}

// When status came from another daemon than the recorded one (its Self.ID isn't daemon.node), that daemon's machine;
// else null.
export function answeredBy(daemon, status) {
  if (!daemon?.node || !status?.Self?.ID || status.Self.ID === daemon.node) return null;
  return machineOf(status) || status.Self.ID;
}

// The recorded-daemon fault when stdout, a `status --json` output, came from another daemon than the recorded one; else
// null. Every read of status and every write checks it, so nothing lands on another daemon (owner, gh481-recorded-down).
export function recordedFault(daemon, stdout) {
  let status = null;
  try { status = JSON.parse(stdout); } catch {}
  const machine = answeredBy(daemon, status);
  return machine ? `Tailscale's recorded daemon isn't running (${machine} answered in its place); start it, or run kickflip doctor --fix to pick again` : null;
}

// The running daemons other than chosen, for doctor's line; one answering as chosen's node is chosen reached by a
// fall-through. → [{daemon, machine}]
export function otherDaemons(chosen, { status = daemonStatus, ...options } = {}) {
  const own = chosen && (chosen.node ?? status(chosen)?.Self?.ID);
  return runningDaemons(tailscaleDaemons(options).filter((daemon) => !sameDaemon(daemon, chosen)), status)
    .filter(({ status: s }) => !own || s.Self?.ID !== own)
    .map(({ daemon, status: s }) => ({ daemon, machine: machineOf(s) }));
}
const sameDaemon = (a, b) => Boolean(a && b) && a.kind === b.kind && a.cli === b.cli && a.socket === b.socket;
const machineOf = (status) => status?.Self?.HostName || status?.Self?.DNSName?.split('.')[0] || '';

// How doctor names a daemon.
export function daemonLabel(daemon) {
  if (daemon.kind === 'app') return `the Tailscale app, ${daemon.cli}`;
  if (daemon.kind === 'tailscaled') return `tailscaled, ${daemon.cli} --socket ${daemon.socket}`;
  return daemon.cli;
}

// The command that installs Tailscale (the cask is the standalone GUI app), and the hint that also names the download
// page, where the App Store build is.
export const tailscaleInstallCommand = (platform = process.platform) => platform === 'darwin'
  ? 'brew install --cask tailscale-app' : 'curl -fsSL https://tailscale.com/install.sh | sh';
export const tailscaleInstallHint = (platform = process.platform) => platform === 'darwin'
  ? `install Tailscale from https://tailscale.com/download, or ${tailscaleInstallCommand(platform)}` : tailscaleInstallCommand(platform);
