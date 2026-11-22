import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hubService } from './service.mjs';
import { tempDir } from './temp-dir.mjs';

let home;
let bin;
let log;
beforeEach(() => {
  home = fs.realpathSync(tempDir('kickflip-service-'));
  bin = path.join(home, 'bin');
  log = path.join(home, 'calls.log');
  fs.mkdirSync(bin);
});

const stub = (name, cases = '') => fs.writeFileSync(path.join(bin, name),
  `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "${log}"\ncase "$*" in\n${cases}\nesac\nexit 0\n`, { mode: 0o755 });
const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
const service = (platform) => hubService({ platform, home, uid: 501, env: { PATH: bin } });
const flag = (name) => fs.writeFileSync(path.join(home, name), '');

test('on macOS the hub is a launchd login item that install, restart, status and remove drive through launchctl', async () => {
  stub('launchctl', [
    `  'print gui/501/local.claude.kickflip-hub') [ -f "${home}/loaded" ] && echo 'state = running' || exit 113 ;;`,
    `  'bootout gui/501/local.claude.kickflip-hub') /bin/rm -f "${home}/loaded" ;;`,
    `  'bootstrap gui/501 '*) : > "${home}/loaded" ;;`,
    `  'kickstart -k gui/501/local.claude.kickflip-hub') [ -f "${home}/fail" ] && { echo 'Could not kickstart' >&2; exit 113; } ;;`,
  ].join('\n'));
  const s = service('darwin');
  const plist = path.join(home, 'Library', 'LaunchAgents', 'local.claude.kickflip-hub.plist');
  assert.deepEqual([s.manager, s.item, s.file, s.restartCommand], ['launchd', 'hub login item', plist, 'launchctl kickstart -k gui/$(id -u)/local.claude.kickflip-hub']);
  assert.deepEqual(s.status(), { installed: false, running: false, detail: 'not installed' });

  const definition = s.definition({ node: '/opt/node', entry: '/k&co/hub/hub.mjs', state: '/s', port: 4555, log: '/s/hub.log' });
  assert.match(definition, /<array><string>\/opt\/node<\/string><string>\/k&amp;co\/hub\/hub.mjs<\/string><\/array>/);
  assert.match(definition, /<key>KICKFLIP_HUB_PORT<\/key><string>4555<\/string>/);
  assert.deepEqual(await s.install(definition, { wait: async () => {} }), [`started gui/501/local.claude.kickflip-hub from ${plist}`]);
  assert.equal(fs.readFileSync(plist, 'utf8'), definition);
  assert.deepEqual(s.status(), { installed: true, running: true, detail: 'running' });
  assert.equal(s.restart(), null);
  flag('fail');
  assert.equal(s.restart(), 'Could not kickstart');
  s.remove();
  assert.equal(fs.existsSync(plist), false);
  assert.deepEqual(s.notes(), []);
  assert.deepEqual(calls(), [
    'launchctl print gui/501/local.claude.kickflip-hub',
    'launchctl bootout gui/501/local.claude.kickflip-hub',
    'launchctl print gui/501/local.claude.kickflip-hub',
    `launchctl bootstrap gui/501 ${plist}`,
    'launchctl print gui/501/local.claude.kickflip-hub',
    'launchctl kickstart -k gui/501/local.claude.kickflip-hub',
    'launchctl kickstart -k gui/501/local.claude.kickflip-hub',
    'launchctl bootout gui/501/local.claude.kickflip-hub',
  ]);
});

test('on Linux the hub is a systemd user unit that install, restart, status and remove drive through systemctl --user', async () => {
  const unit = path.join(home, '.config', 'systemd', 'user', 'kickflip-hub.service');
  stub('systemctl', [
    `  '--user is-active kickflip-hub.service') [ -f "${unit}" ] && echo active || { echo inactive; exit 3; } ;;`,
    `  '--user restart kickflip-hub.service') [ -f "${home}/fail" ] && { echo 'Job for kickflip-hub.service failed.' >&2; exit 1; } ;;`,
  ].join('\n'));
  stub('loginctl', `  'show-user 501 --property=Linger') [ -f "${home}/linger" ] && echo Linger=yes || echo Linger=no ;;`);
  const s = service('linux');
  assert.deepEqual([s.manager, s.item, s.file, s.restartCommand], ['systemd', 'hub service', unit, 'systemctl --user restart kickflip-hub.service']);
  assert.deepEqual(await s.install('unit', { dryRun: true }), [`would write ${unit}, enable and start kickflip-hub.service`]);
  assert.deepEqual([calls(), fs.existsSync(unit)], [[], false]);
  assert.deepEqual(s.status(), { installed: false, running: false, detail: 'not installed' });

  const definition = s.definition({ node: '/opt/node 24/bin/node', entry: '/home/me/kick"flip$/hub/hub.mjs', state: '/home/me/.claude/kickflip', port: 4555, log: '/home/me/50%/hub.log' });
  assert.match(definition, /^ExecStart="\/opt\/node 24\/bin\/node" "\/home\/me\/kick\\"flip\$\$\/hub\/hub\.mjs"$/m);
  assert.match(definition, /^Environment="PATH=\/opt\/node 24\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin"$/m);
  assert.match(definition, /^Environment=KICKFLIP_HUB_PORT=4555$/m);
  assert.match(definition, /^WorkingDirectory=\/home\/me\/\.claude\/kickflip$/m);
  assert.match(definition, /^StandardOutput=append:\/home\/me\/50%%\/hub\.log$/m);
  assert.match(definition, /^Restart=always$/m);
  assert.match(definition, /^KillMode=process$/m);
  assert.match(definition, /^WantedBy=default\.target$/m);
  assert.deepEqual(await s.install(definition), [`enabled and started kickflip-hub.service from ${unit}`]);
  assert.equal(fs.readFileSync(unit, 'utf8'), definition);
  assert.deepEqual(s.status(), { installed: true, running: true, detail: 'running' });
  assert.equal(s.restart(), null);
  flag('fail');
  assert.equal(s.restart(), 'Job for kickflip-hub.service failed.');
  await assert.rejects(s.install(`${definition}# changed\n`), { message: 'systemctl --user restart kickflip-hub.service: Job for kickflip-hub.service failed.' });
  s.remove();
  assert.equal(fs.existsSync(unit), false);
  assert.deepEqual(calls(), [
    'systemctl --user is-active kickflip-hub.service',
    'systemctl --user daemon-reload',
    'systemctl --user enable kickflip-hub.service',
    'systemctl --user restart kickflip-hub.service',
    'systemctl --user is-active kickflip-hub.service',
    'systemctl --user restart kickflip-hub.service',
    'systemctl --user restart kickflip-hub.service',
    'systemctl --user daemon-reload',
    'systemctl --user enable kickflip-hub.service',
    'systemctl --user restart kickflip-hub.service',
    'systemctl --user disable --now kickflip-hub.service',
    'systemctl --user daemon-reload',
  ]);

  const [linger, macOnly] = s.notes();
  assert.deepEqual([linger.item, linger.state, linger.fix], ['hub without a login', 'optional', 'sudo loginctl enable-linger "$USER"']);
  assert.equal(macOnly.state, 'note');
  flag('linger');
  assert.equal(s.notes()[0].state, 'ok');
});

test('a service manager missing from PATH fails each step with its error, and another platform has no service', async () => {
  for (const platform of ['darwin', 'linux']) {
    const s = service(platform);
    assert.match(s.restart(), /spawnSync (launchctl|systemctl) ENOENT/);
    assert.equal(s.status().running, false);
    s.remove();
  }
  await assert.rejects(service('linux').install('unit'), { message: 'systemctl --user daemon-reload: spawnSync systemctl ENOENT' });
  const other = service('freebsd');
  assert.equal(other.manager, null);
  assert.equal(other.restartCommand, 'node hub/hub.mjs from the kickflip folder');
  await assert.rejects(other.install('x'), /launchd on macOS or systemd on Linux, not on freebsd/);
  assert.match(other.restart(), /not on freebsd/);
  assert.equal(other.status().running, false);
});

test('a running login item whose plist is unchanged is left alone, and a changed one is replaced', async () => {
  stub('launchctl', [
    `  'print gui/501/local.claude.kickflip-hub') [ -f "${home}/loaded" ] && echo 'state = running' || exit 113 ;;`,
    `  'bootout gui/501/local.claude.kickflip-hub') /bin/rm -f "${home}/loaded" ;;`,
    `  'bootstrap gui/501 '*) : > "${home}/loaded" ;;`,
  ].join('\n'));
  const s = service('darwin');
  await s.install('plist', { wait: async () => {} });
  fs.rmSync(log);
  const [note] = await s.install('plist', { wait: async () => {} });
  assert.match(note, /left gui\/501\/local\.claude\.kickflip-hub running/);
  assert.deepEqual(calls(), ['launchctl print gui/501/local.claude.kickflip-hub']);
  assert.match((await s.install('plist 2', { wait: async () => {} }))[0], /^started /);
  assert.equal(fs.readFileSync(s.file, 'utf8'), 'plist 2');
});

test('install polls until the old hub is gone and errors naming the command after 30 s', async () => {
  stub('launchctl', `  'print gui/501/local.claude.kickflip-hub') echo 'state = running' ;;`);
  const waits = [];
  await assert.rejects(service('darwin').install('plist', { wait: async (ms) => { waits.push(ms); } }), {
    message: 'the old hub did not exit within 30 s; run launchctl bootout gui/501/local.claude.kickflip-hub, then kickflip doctor --fix again',
  });
  assert.equal(waits.reduce((a, b) => a + b, 0), 30_000);
  assert.equal(calls().includes(`launchctl bootstrap gui/501 ${service('darwin').file}`), false);
});

test('install retries a failed bootstrap until it succeeds', async () => {
  stub('launchctl', [
    `  'print gui/501/local.claude.kickflip-hub') exit 113 ;;`,
    `  'bootstrap gui/501 '*) n=0; [ -f "${home}/n" ] && read n < "${home}/n"; echo $((n+1)) > "${home}/n"; [ $n -lt 2 ] && { echo 'Bootstrap failed: 5' >&2; exit 5; } ;;`,
  ].join('\n'));
  assert.match((await service('darwin').install('plist', { wait: async () => {} }))[0], /^started /);
  assert.equal(calls().filter((c) => c.includes('bootstrap')).length, 3);
});

test('an active unit whose file is unchanged is not restarted', async () => {
  const unit = path.join(home, '.config', 'systemd', 'user', 'kickflip-hub.service');
  stub('systemctl', `  '--user is-active kickflip-hub.service') [ -f "${unit}" ] && echo active || { echo inactive; exit 3; } ;;`);
  const s = service('linux');
  await s.install('unit');
  fs.rmSync(log);
  assert.match((await s.install('unit'))[0], /^left kickflip-hub\.service running/);
  assert.deepEqual(calls(), ['systemctl --user is-active kickflip-hub.service']);
});

test('status says stopping while launchd shows the job exiting or systemd shows the unit deactivating', () => {
  const file = path.join(home, 'Library', 'LaunchAgents', 'local.claude.kickflip-hub.plist');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'plist');
  stub('launchctl', `  'print gui/501/local.claude.kickflip-hub') echo 'state = exiting' ;;`);
  assert.deepEqual(service('darwin').status(), { installed: true, running: false, stopping: true, detail: 'stopping' });

  const unit = path.join(home, '.config', 'systemd', 'user', 'kickflip-hub.service');
  fs.mkdirSync(path.dirname(unit), { recursive: true });
  fs.writeFileSync(unit, 'unit');
  stub('systemctl', `  '--user is-active kickflip-hub.service') echo deactivating; exit 3 ;;`);
  assert.deepEqual(service('linux').status(), { installed: true, running: false, stopping: true, detail: 'stopping' });
});
