import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tailscaleDaemons, tailscaleArgv, daemonStatus, pickDaemon, tailscaleDaemon, repickDaemon, otherDaemons, answeredBy, recordedFault, daemonLabel, tailscaleRoot, servesHub, DARWIN_SOCKET, tailscaleInstallCommand, tailscaleInstallHint } from './tailscale.mjs';
import { tempDir } from './temp-dir.mjs';

let home;
beforeEach(() => { home = fs.realpathSync(tempDir('kickflip-tailscale-')); });

const executable = (file, mode = 0o755) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\n', { mode });
  return file;
};
const bundle = (apps) => path.join(apps, 'Tailscale.app', 'Contents', 'MacOS', 'Tailscale');
const settings = () => { try { return JSON.parse(fs.readFileSync(path.join(home, '.claude', 'kickflip', 'settings.json'), 'utf8')); } catch { return {}; } };
const writeSettings = (value) => { fs.mkdirSync(path.join(home, '.claude', 'kickflip'), { recursive: true }); fs.writeFileSync(path.join(home, '.claude', 'kickflip', 'settings.json'), JSON.stringify(value)); };

// A Mac with brew's CLI on PATH and the GUI app installed.
function twoDaemons() {
  const apps = [path.join(home, 'Applications')];
  const brew = executable(path.join(home, 'bin', 'tailscale'));
  const app = executable(bundle(apps[0]));
  const options = { env: { PATH: path.join(home, 'bin') }, platform: 'darwin', apps, home };
  return { brew, app, options, tailscaled: { kind: 'tailscaled', cli: brew, socket: DARWIN_SOCKET }, gui: { kind: 'app', cli: app } };
}
const running = (id, host = id) => ({ BackendState: 'Running', Self: { ID: id, HostName: host } });

test('a Mac lists brew’s tailscaled, addressed by the first CLI on PATH with --socket, then the GUI app’s daemon by its bundle CLI; elsewhere the first CLI on PATH', () => {
  const apps = [path.join(home, 'Applications'), path.join(home, 'user', 'Applications')];
  const empty = path.join(home, 'empty');
  fs.mkdirSync(empty);
  const list = (PATH, platform = 'darwin') => tailscaleDaemons({ env: { PATH }, platform, apps });
  assert.deepEqual(list(empty), []);
  const userApp = executable(bundle(apps[1]));
  assert.deepEqual(list(empty), [{ kind: 'app', cli: userApp }]);
  const systemApp = executable(bundle(apps[0]));
  assert.deepEqual(list(empty), [{ kind: 'app', cli: systemApp }]);
  const first = executable(path.join(home, 'bin', 'tailscale'));
  executable(path.join(home, 'bin2', 'tailscale'));
  const PATH = [empty, path.join(home, 'bin'), path.join(home, 'bin2')].join(':');
  assert.deepEqual(list(PATH), [{ kind: 'tailscaled', cli: first, socket: '/var/run/tailscaled.socket' }, { kind: 'app', cli: systemApp }]);
  // Linux has no app bundle and one daemon, which its CLI reaches by default.
  assert.deepEqual(list(empty, 'linux'), []);
  assert.deepEqual(list(PATH, 'linux'), [{ kind: 'cli', cli: first }]);
});

test('a tailscale that isn’t an executable file isn’t listed, and PATH is read on every call', () => {
  const apps = [path.join(home, 'Applications')];
  const dir = path.join(home, 'bin');
  fs.mkdirSync(path.join(dir, 'tailscale'), { recursive: true });
  const list = () => tailscaleDaemons({ env: { PATH: dir }, platform: 'darwin', apps });
  assert.deepEqual(list(), []);
  executable(bundle(apps[0]), 0o644);
  assert.deepEqual(list(), []);
  fs.chmodSync(bundle(apps[0]), 0o755);
  assert.deepEqual(list(), [{ kind: 'app', cli: bundle(apps[0]) }]);
  fs.rmSync(path.join(dir, 'tailscale'), { recursive: true });
  executable(path.join(dir, 'tailscale'));
  assert.deepEqual(list().map((d) => d.kind), ['tailscaled', 'app']);
});

test('a daemon’s argv puts --socket before the command when it has one', () => {
  assert.deepEqual(tailscaleArgv({ kind: 'tailscaled', cli: '/opt/homebrew/bin/tailscale', socket: DARWIN_SOCKET }, ['status', '--json']),
    ['/opt/homebrew/bin/tailscale', ['--socket', DARWIN_SOCKET, 'status', '--json']]);
  assert.deepEqual(tailscaleArgv({ kind: 'app', cli: '/A/Tailscale', node: 'n1' }, ['version']), ['/A/Tailscale', ['version']]);
});

test('daemonStatus is the daemon’s status --json, run with its socket, else null', () => {
  const log = path.join(home, 'argv');
  const cli = (body) => { const file = path.join(home, `cli-${Math.random()}`); fs.writeFileSync(file, `#!/bin/sh\necho "$@" > ${log}\n${body}\n`, { mode: 0o755 }); return file; };
  assert.deepEqual(daemonStatus({ kind: 'tailscaled', cli: cli(`echo '{"BackendState":"Running"}'`), socket: '/tmp/s' }), { BackendState: 'Running' });
  assert.equal(fs.readFileSync(log, 'utf8').trim(), '--socket /tmp/s status --json');
  assert.deepEqual(daemonStatus({ kind: 'app', cli: cli(`echo '{"BackendState":"Stopped"}'; exit 1`) }), { BackendState: 'Stopped' });
  assert.equal(daemonStatus({ kind: 'app', cli: cli('echo "failed to connect to local tailscaled" >&2; exit 1') }), null);
  assert.equal(daemonStatus({ kind: 'app', cli: path.join(home, 'missing') }), null);
});

test('with both daemons running, the pick is the one serving / to the hub, else the app; it carries the node it answered as', () => {
  const { tailscaled, gui } = twoDaemons();
  const status = (up) => (d) => up[d.kind] ?? null;
  const both = status({ tailscaled: running('nBrew'), app: running('nApp') });
  assert.deepEqual(pickDaemon([tailscaled, gui], { status: both, serves: (d) => d.kind === 'tailscaled' }), { ...tailscaled, node: 'nBrew' });
  assert.deepEqual(pickDaemon([tailscaled, gui], { status: both, serves: () => false }), { ...gui, node: 'nApp' });
  assert.deepEqual(pickDaemon([tailscaled, gui], { status: status({ tailscaled: running('nBrew') }), serves: () => false }), { ...tailscaled, node: 'nBrew' });
  // A Stopped daemon isn't running.
  assert.deepEqual(pickDaemon([tailscaled, gui], { status: status({ tailscaled: running('nBrew'), app: { BackendState: 'Stopped' } }), serves: () => false }), { ...tailscaled, node: 'nBrew' });
  // With the app quit, its bundle CLI falls through to /var/run/tailscaled.socket and answers as brew's node: the app isn't running.
  assert.deepEqual(pickDaemon([tailscaled, gui], { status: status({ tailscaled: running('nBrew'), app: running('nBrew') }), serves: () => false }), { ...tailscaled, node: 'nBrew' });
  // None running: the app, else the first, with no node.
  assert.deepEqual(pickDaemon([tailscaled, gui], { status: () => null, serves: () => false }), gui);
  assert.deepEqual(pickDaemon([tailscaled], { status: () => null, serves: () => false }), tailscaled);
  assert.equal(pickDaemon([], { status: () => null, serves: () => false }), null);
});

test('a serve config serves the hub when its / proxies to the hub’s loopback port', () => {
  const config = (proxy, host = 'mac.ts.net:443') => ({ Web: { [host]: { Handlers: { '/': { Proxy: proxy }, '/x': { Proxy: 'http://127.0.0.1:9' } } } } });
  assert.deepEqual(tailscaleRoot(config('http://127.0.0.1:4500')), { root: 'http://127.0.0.1:4500', paths: ['/', '/x'] });
  assert.equal(servesHub(config('http://127.0.0.1:4500'), 4500), true);
  assert.equal(servesHub(config('http://localhost:4500/'), 4500), true);
  assert.equal(servesHub(config('http://127.0.0.1:4501'), 4500), false);
  assert.equal(servesHub(config('http://127.0.0.1:4500', 'mac.ts.net:8443'), 4500), false);
  assert.equal(servesHub(null, 4500), false);
});

test('with no daemon recorded, the first call picks by the rule and records it in the hub’s settings, keeping other keys', () => {
  const { tailscaled, gui, options } = twoDaemons();
  writeSettings({ claudeModel: 'auto' });
  const asked = [];
  const status = (d) => { asked.push(d.kind); return running(d.kind === 'app' ? 'nApp' : 'nBrew'); };
  assert.deepEqual(tailscaleDaemon({ ...options, status, serves: () => false }), { ...gui, node: 'nApp' });
  assert.deepEqual(settings(), { claudeModel: 'auto', tailscale: { ...gui, node: 'nApp' } });
  // Recorded, it is used as it stands: nothing is asked, even with brew’s daemon now serving the hub.
  asked.length = 0;
  assert.deepEqual(tailscaleDaemon({ ...options, status, serves: (d) => d.kind === 'tailscaled' }), { ...gui, node: 'nApp' });
  assert.deepEqual(asked, []);
  // A re-pick (doctor --fix, init) picks again and records the new one.
  assert.deepEqual(repickDaemon({ ...options, status, serves: (d) => d.kind === 'tailscaled' }), { ...tailscaled, node: 'nBrew' });
  assert.deepEqual(settings().tailscale, { ...tailscaled, node: 'nBrew' });
});

test('a pick with no daemon running isn’t recorded, so the next call picks again', () => {
  const { gui, options } = twoDaemons();
  assert.deepEqual(tailscaleDaemon({ ...options, status: () => null, serves: () => false }), gui);
  assert.equal(settings().tailscale, undefined);
  assert.deepEqual(repickDaemon({ ...options, status: () => null, serves: () => false }), gui);
  assert.equal(settings().tailscale, undefined);
});

test('a re-pick with no daemon running keeps the old record, so kickflip stays on it', () => {
  const { tailscaled, options } = twoDaemons();
  writeSettings({ tailscale: { ...tailscaled, node: 'nBrew' } });
  repickDaemon({ ...options, status: () => null, serves: () => false });
  assert.deepEqual(settings().tailscale, { ...tailscaled, node: 'nBrew' });
});

test('KICKFLIP_TAILSCALE names the only CLI kickflip runs, with no record read or written', () => {
  const { options, gui } = twoDaemons();
  writeSettings({ tailscale: { ...gui, node: 'nApp' } });
  const stub = executable(path.join(home, 'stub', 'tailscale'));
  const env = { ...options.env, KICKFLIP_TAILSCALE: stub };
  const asked = [];
  const status = (d) => { asked.push(d); return running('n'); };
  assert.deepEqual(tailscaleDaemons({ ...options, env }), [{ kind: 'cli', cli: stub }]);
  assert.deepEqual(tailscaleDaemon({ ...options, env, status }), { kind: 'cli', cli: stub });
  assert.deepEqual(repickDaemon({ ...options, env, status }), { kind: 'cli', cli: stub });
  assert.deepEqual(asked, []);
  assert.deepEqual(settings().tailscale, { ...gui, node: 'nApp' });
});

test('a status answers for a recorded daemon only when its node is the recorded one', () => {
  assert.equal(answeredBy({ kind: 'app', cli: 'a', node: 'nApp' }, running('nApp')), null);
  assert.equal(answeredBy({ kind: 'app', cli: 'a' }, running('nBrew')), null);
  assert.equal(answeredBy({ kind: 'app', cli: 'a', node: 'nApp' }, running('nBrew', 'other-mac')), 'other-mac');
  assert.equal(answeredBy({ kind: 'app', cli: 'a', node: 'nApp' }, null), null);
});

test('the recorded-daemon fault names the machine that answered in its place, from a status --json output', () => {
  const app = { kind: 'app', cli: 'a', node: 'nApp' };
  assert.equal(recordedFault(app, JSON.stringify(running('nBrew', 'brew-mac'))),
    "Tailscale's recorded daemon isn't running (brew-mac answered in its place); start it, or run kickflip doctor --fix to pick again");
  assert.equal(recordedFault(app, JSON.stringify(running('nApp'))), null);
  assert.equal(recordedFault(app, ''), null);
  assert.equal(recordedFault({ kind: 'cli', cli: 'tailscale' }, JSON.stringify(running('nBrew'))), null);
});

test('the other running daemons are every running one but the chosen, a fall-through to the chosen’s node not counted', () => {
  const { tailscaled, gui, options } = twoDaemons();
  const status = (up) => (d) => up[d.kind] ?? null;
  assert.deepEqual(otherDaemons({ ...gui, node: 'nApp' }, { ...options, status: status({ tailscaled: running('nBrew', 'brew-mac'), app: running('nApp') }) }), [{ daemon: tailscaled, machine: 'brew-mac' }]);
  assert.deepEqual(otherDaemons({ ...tailscaled, node: 'nBrew' }, { ...options, status: status({ tailscaled: running('nBrew'), app: running('nBrew') }) }), []);
  assert.deepEqual(otherDaemons({ ...tailscaled, node: 'nBrew' }, { ...options, status: status({ tailscaled: running('nBrew') }) }), []);
  assert.deepEqual(otherDaemons(null, { ...options, status: status({ app: running('nApp', 'app-mac') }) }), [{ daemon: gui, machine: 'app-mac' }]);
});

test('a daemon’s label names its kind and how kickflip reaches it', () => {
  assert.equal(daemonLabel({ kind: 'app', cli: '/Applications/Tailscale.app/Contents/MacOS/Tailscale' }), 'the Tailscale app, /Applications/Tailscale.app/Contents/MacOS/Tailscale');
  assert.equal(daemonLabel({ kind: 'tailscaled', cli: '/opt/homebrew/bin/tailscale', socket: DARWIN_SOCKET }), 'tailscaled, /opt/homebrew/bin/tailscale --socket /var/run/tailscaled.socket');
  assert.equal(daemonLabel({ kind: 'cli', cli: 'tailscale' }), 'tailscale');
});

test('the install hint names the download page and the cask on macOS, the install script elsewhere', () => {
  assert.equal(tailscaleInstallHint('darwin'), 'install Tailscale from https://tailscale.com/download, or brew install --cask tailscale-app');
  assert.equal(tailscaleInstallHint('linux'), 'curl -fsSL https://tailscale.com/install.sh | sh');
  assert.equal(tailscaleInstallCommand('darwin'), 'brew install --cask tailscale-app');
  assert.equal(tailscaleInstallCommand('linux'), 'curl -fsSL https://tailscale.com/install.sh | sh');
});
