import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const LOGIN_LABEL = 'local.claude.kickflip-hub';
const OLD_LOGIN_LABEL = 'local.claude.web-ts-hub';
export const UNIT = 'kickflip-hub.service';

export function runCommand(command, argv, { env = process.env, timeout = 10000 } = {}) {
  const r = spawnSync(command, argv, { encoding: 'utf8', env, timeout });
  return { status: r.status ?? 1, stdout: r.stdout || '', error: (r.error?.message || r.stderr || `exit ${r.status}`).trim().split('\n')[0] };
}

// The service that keeps the hub running on this host, picked by platform: a launchd login item on macOS, a systemd
// user unit on Linux (docs/adr/0093-the-hub-runs-under-the-hosts-service-manager.md). Every launchctl or systemctl
// call goes through run(command, argv, {env, timeout}) → {status, stdout, error}. On any other platform, manager is
// null, install throws and restart returns why.
// → {manager, item, file, id, restartCommand, definition(), install(), restart(), remove(), status(), notes()}
export function hubService({ platform = process.platform, home = os.homedir(), uid = process.getuid?.(), env = process.env, run = runCommand } = {}) {
  const exec = (command, argv, options = {}) => {
    try { return run(command, argv, { env, ...options }); } catch (e) { return { status: 1, stdout: '', error: e.message }; }
  };
  if (platform === 'darwin') return launchd({ home, uid, exec });
  if (platform === 'linux') return systemd({ home, uid, exec });
  const why = `kickflip keeps the hub running with launchd on macOS or systemd on Linux, not on ${platform}`;
  return {
    manager: null, item: 'hub service', file: null, id: null, restartCommand: 'node hub/hub.mjs from the kickflip clone',
    definition: () => null,
    install: async () => { throw new Error(why); },
    restart: () => why,
    remove: () => {},
    status: () => ({ installed: false, running: false, detail: why }),
    notes: () => [],
  };
}

const RESTART_TIMEOUT = 120_000;

function launchd({ home, uid, exec }) {
  const agents = path.join(home, 'Library', 'LaunchAgents');
  const domain = `gui/${uid}`;
  const file = path.join(agents, `${LOGIN_LABEL}.plist`);
  const old = path.join(agents, `${OLD_LOGIN_LABEL}.plist`);
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
    // Starts the login item in place of the running one, including one under the old label. When the new one won't
    // start, the old one is put back and started. → note lines.
    async install(plist, { wait = (ms) => new Promise((r) => setTimeout(r, ms)), dryRun = false } = {}) {
      let oldPlist = null;
      try { oldPlist = fs.readFileSync(old, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const notes = [];
      if (dryRun) {
        if (oldPlist !== null) notes.push(`would stop ${domain}/${OLD_LOGIN_LABEL} and remove ${old}`);
        return [...notes, `would write ${file} and start ${domain}/${LOGIN_LABEL}`];
      }
      fs.mkdirSync(agents, { recursive: true });
      fs.writeFileSync(file, plist);
      if (oldPlist !== null) {
        launchctl(['bootout', `${domain}/${OLD_LOGIN_LABEL}`]);
        fs.unlinkSync(old);
        notes.push(`stopped ${domain}/${OLD_LOGIN_LABEL} and removed ${old}`);
      }
      launchctl(['bootout', `${domain}/${LOGIN_LABEL}`]);
      await wait(500);
      const started = launchctl(['bootstrap', domain, file]);
      if (started.status === 0) return [...notes, `started ${domain}/${LOGIN_LABEL} from ${file}`];
      if (oldPlist === null) throw new Error(started.error);
      fs.writeFileSync(old, oldPlist);
      fs.rmSync(file, { force: true });
      const restored = launchctl(['bootstrap', domain, old]);
      throw new Error(`${started.error}; ${restored.status === 0 ? `restarted ${domain}/${OLD_LOGIN_LABEL} from ${old}` : `could not restart ${domain}/${OLD_LOGIN_LABEL} either (${restored.error})`}`);
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
StandardOutput=append:${unitValue(log)}
StandardError=append:${unitValue(log)}

[Install]
WantedBy=default.target
`;
    },
    // Writes the unit, enables it for the user's manager and restarts it, so a rerun replaces the running hub. → notes.
    async install(unit, { dryRun = false } = {}) {
      if (dryRun) return [`would write ${file}, enable and start ${UNIT}`];
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
        { item: 'macOS-only parts', state: 'note', detail: 'At the host always reads away, since presence comes from macOS ioreg, so pushes reach every device' },
      ];
    },
  };
}
