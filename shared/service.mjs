import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ghSync } from './gh.mjs';

export const LOGIN_LABEL = 'local.claude.kickflip-hub';
export const UNIT = 'kickflip-hub.service';

// gh runs through GitHub's limit gate (shared/gh.mjs).
export function runCommand(command, argv, { env = process.env, timeout = 10000 } = {}) {
  const r = command === 'gh' ? ghSync(argv, { env, timeout }) : spawnSync(command, argv, { encoding: 'utf8', env, timeout });
  return { status: r.status ?? 1, stdout: r.stdout || '', error: (r.error?.message || r.stderr || `exit ${r.status}`).trim().split('\n')[0] };
}

// The service that keeps the hub running on this host, picked by platform: a launchd login item on macOS, a systemd
// user unit on Linux (docs/adr/2026-11-01-1542-the-hub-runs-under-the-hosts-service-manager.md). Every launchctl or systemctl
// call goes through run(command, argv, {env, timeout}) → {status, stdout, error}. On any other platform, manager is
// null, install throws and restart returns why. restart() is for another process (kickflip update, kickflip restart):
// the manager's SIGTERM has the running hub stop through close() before it starts again. The hub restarts itself by
// exiting instead (docs/adr/2026-11-17-1357-the-hub-restarts-itself-through-close.md).
// → {manager, item, file, id, restartCommand, definition(), node(), install(), restart(), remove(), status(), notes()}
export function hubService({ platform = process.platform, home = os.homedir(), uid = process.getuid?.(), env = process.env, run = runCommand } = {}) {
  const exec = (command, argv, options = {}) => {
    try { return run(command, argv, { env, ...options }); } catch (e) { return { status: 1, stdout: '', error: e.message }; }
  };
  if (platform === 'darwin') return launchd({ home, uid, exec });
  if (platform === 'linux') return systemd({ home, uid, exec });
  const why = `kickflip keeps the hub running with launchd on macOS or systemd on Linux, not on ${platform}`;
  return {
    manager: null, item: 'hub service', file: null, id: null, restartCommand: 'node hub/hub.mjs from the kickflip folder',
    definition: () => null,
    node: () => null,
    install: async () => { throw new Error(why); },
    restart: () => why,
    remove: () => {},
    status: () => ({ installed: false, running: false, detail: why }),
    notes: () => [],
  };
}

const RESTART_TIMEOUT = 120_000;
const EXIT_WAIT_MS = 30_000;
const POLL_MS = 500;
const BOOTSTRAP_TRIES = 5;

// Whether the definition file already holds exactly these bytes.
const unchanged = (file, text) => { try { return fs.readFileSync(file, 'utf8') === text; } catch { return false; } };

function launchd({ home, uid, exec }) {
  const agents = path.join(home, 'Library', 'LaunchAgents');
  const domain = `gui/${uid}`;
  const file = path.join(agents, `${LOGIN_LABEL}.plist`);
  const launchctl = (argv, options) => exec('launchctl', argv, options);
  return {
    manager: 'launchd',
    item: 'hub login item',
    file,
    id: `${domain}/${LOGIN_LABEL}`,
    restartCommand: `launchctl kickstart -k gui/$(id -u)/${LOGIN_LABEL}`,
    definition({ node, entry, state, port, log }) {
      const xml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LOGIN_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(node)}</string><string>${xml(entry)}</string></array>
  <key>WorkingDirectory</key><string>${xml(state)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(path.dirname(node))}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string><key>KICKFLIP_HUB_PORT</key><string>${port}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
    },
    // The node the plist runs, ProgramArguments' first string. → path, or null with no plist.
    node() {
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
      const found = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(text)?.[1];
      return found ? found.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&') : null;
    },
    // Starts the login item in place of the running one: a running item whose plist is unchanged is left alone;
    // otherwise it boots the old one out, polls until launchd no longer lists it (the old hub has exited) for up to
    // 30 s, then bootstraps, retrying a failed bootstrap. → note lines.
    async install(plist, { wait = (ms) => new Promise((r) => setTimeout(r, ms)), dryRun = false } = {}) {
      if (dryRun) return [`would write ${file} and start ${domain}/${LOGIN_LABEL}`];
      if (unchanged(file, plist) && this.status().running) return [`left ${domain}/${LOGIN_LABEL} running: ${file} is unchanged`];
      fs.mkdirSync(agents, { recursive: true });
      fs.writeFileSync(file, plist);
      launchctl(['bootout', `${domain}/${LOGIN_LABEL}`]);
      let gone = launchctl(['print', `${domain}/${LOGIN_LABEL}`]).status !== 0;
      for (let waited = 0; !gone && waited < EXIT_WAIT_MS; waited += POLL_MS) {
        await wait(POLL_MS);
        gone = launchctl(['print', `${domain}/${LOGIN_LABEL}`]).status !== 0;
      }
      if (!gone) throw new Error(`the old hub did not exit within ${EXIT_WAIT_MS / 1000} s; run launchctl bootout ${domain}/${LOGIN_LABEL}, then kickflip doctor --fix again`);
      let started = launchctl(['bootstrap', domain, file]);
      for (let tries = 1; started.status !== 0 && tries < BOOTSTRAP_TRIES; tries++) {
        await wait(POLL_MS);
        started = launchctl(['bootstrap', domain, file]);
      }
      if (started.status === 0) return [`started ${domain}/${LOGIN_LABEL} from ${file}`];
      throw new Error(started.error);
    },
    restart() {
      const r = launchctl(['kickstart', '-k', `${domain}/${LOGIN_LABEL}`], { timeout: RESTART_TIMEOUT });
      return r.status === 0 ? null : r.error;
    },
    remove() {
      launchctl(['bootout', `${domain}/${LOGIN_LABEL}`]);
      fs.rmSync(file, { force: true });
    },
    status() {
      const printed = launchctl(['print', `${domain}/${LOGIN_LABEL}`]);
      const installed = fs.existsSync(file);
      const running = installed && printed.status === 0 && /\bstate = running\b/.test(printed.stdout || '');
      return { installed, running, detail: running ? 'running' : installed ? 'not running' : 'not installed' };
    },
    notes: () => [],
  };
}

// systemd reads specifiers after % and variables after $ in a unit's values; a quoted ExecStart word also takes
// backslash escapes.
const unitValue = (value) => String(value).replaceAll('%', '%%').replaceAll('$', '$$$$').replace(/[\r\n]/g, ' ');
const execWord = (value) => `"${unitValue(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

function systemd({ home, uid, exec }) {
  const file = path.join(home, '.config', 'systemd', 'user', UNIT);
  const systemctl = (argv, options) => exec('systemctl', ['--user', ...argv], options);
  const step = (argv) => {
    const r = systemctl(argv);
    if (r.status !== 0) throw new Error(`systemctl --user ${argv.join(' ')}: ${r.error}`);
  };
  return {
    manager: 'systemd',
    item: 'hub service',
    file,
    id: UNIT,
    restartCommand: `systemctl --user restart ${UNIT}`,
    definition({ node, entry, state, port, log }) {
      return `[Unit]
Description=kickflip hub

[Service]
ExecStart=${execWord(node)} ${execWord(entry)}
WorkingDirectory=${unitValue(state)}
Environment=${execWord(`PATH=${path.dirname(node)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`)}
Environment=KICKFLIP_HUB_PORT=${port}
Restart=always
RestartSec=2
KillMode=process
StandardOutput=append:${unitValue(log)}
StandardError=append:${unitValue(log)}

[Install]
WantedBy=default.target
`;
    },
    // The node the unit runs, ExecStart's first word. → path, or null with no unit.
    node() {
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
      const found = /^ExecStart="((?:[^"\\]|\\.)*)"/m.exec(text)?.[1];
      return found ? found.replace(/\\(.)/g, '$1').replaceAll('%%', '%').replaceAll('$$', '$') : null;
    },
    // Writes the unit, enables it for the user's manager and restarts it, so a rerun replaces the running hub; an
    // active unit whose file is unchanged is left alone. KillMode=process makes a restart stop only the hub, not a
    // detached Run-card script. → notes.
    async install(unit, { dryRun = false } = {}) {
      if (dryRun) return [`would write ${file}, enable and start ${UNIT}`];
      if (unchanged(file, unit) && this.status().running) return [`left ${UNIT} running: ${file} is unchanged`];
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, unit);
      step(['daemon-reload']);
      step(['enable', UNIT]);
      step(['restart', UNIT]);
      return [`enabled and started ${UNIT} from ${file}`];
    },
    restart() {
      const r = systemctl(['restart', UNIT], { timeout: RESTART_TIMEOUT });
      return r.status === 0 ? null : r.error;
    },
    remove() {
      systemctl(['disable', '--now', UNIT]);
      fs.rmSync(file, { force: true });
      systemctl(['daemon-reload']);
    },
    status() {
      const active = systemctl(['is-active', UNIT]);
      const installed = fs.existsSync(file);
      const running = installed && active.status === 0 && (active.stdout || '').trim() === 'active';
      return { installed, running, detail: running ? 'running' : installed ? 'not running' : 'not installed' };
    },
    // A user unit stops with the owner's last login session unless the user lingers.
    notes() {
      const linger = exec('loginctl', ['show-user', String(uid), '--property=Linger']);
      const lingering = linger.status === 0 && /^Linger=yes$/m.test(linger.stdout || '');
      return [
        { item: 'hub without a login', state: lingering ? 'ok' : 'optional', detail: lingering ? 'the user lingers, so the hub runs with nobody logged in' : 'the hub stops when your last login session ends', fix: 'sudo loginctl enable-linger "$USER"' },
        { item: 'macOS-only parts', state: 'note', detail: 'The owner reads away from the host, since presence comes from macOS ioreg, so only a page tap makes the hub check every minute' },
      ];
    },
  };
}
