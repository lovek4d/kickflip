import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tailnetOn, setTailnet, localUrl, hubUrl, mapHub, turnOn, turnOff, tailnetStatus } from './tailnet.mjs';
import { tempDir } from './temp-dir.mjs';

const CLI = { kind: 'cli', cli: 'tailscale' };
const PORT = 19460;
const RUNNING = JSON.stringify({ BackendState: 'Running', Self: { ID: 'n1', DNSName: 'mac.tail.ts.net.' }, CertDomains: ['mac.tail.ts.net'] });

let home;
beforeEach(() => { home = fs.realpathSync(tempDir('kickflip-tailnet-')); });

const settingsFile = () => path.join(home, '.claude', 'kickflip', 'settings.json');
const settings = () => { try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; } };
const writeSettings = (value) => { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(value)); };
// A runner that answers `tailscale <args>` from outputs and records each call as one line.
function tailscale(outputs = {}) {
  const calls = [];
  const run = (command, argv) => {
    const key = argv.join(' ');
    calls.push(`${command} ${key}`);
    return { status: 0, stdout: outputs[key] ?? '{}' };
  };
  return { run, calls };
}

test('the tailnet is off until set on, read from settings.json on every call, and off removes the key', async () => {
  assert.equal(tailnetOn(home), false);
  writeSettings({ claudeModel: 'auto', tailnet: 'yes' });
  assert.equal(tailnetOn(home), false);
  await setTailnet(true, home);
  assert.equal(tailnetOn(home), true);
  assert.deepEqual(settings(), { claudeModel: 'auto', tailnet: true });
  await setTailnet(false, home);
  assert.equal(tailnetOn(home), false);
  assert.deepEqual(settings(), { claudeModel: 'auto' });
});

test('an install whose Tailscale / already serves the hub still reads off: nothing detects it', () => {
  writeSettings({ tailscale: { ...CLI, node: 'n1' } });
  assert.equal(tailnetOn(home), false);
});

test('off, the hub’s and a site’s address are on this host and no tailscale runs; on, they are the tailnet’s', async () => {
  assert.equal(localUrl(undefined, PORT), `http://127.0.0.1:${PORT}/`);
  assert.equal(localUrl('shop', PORT), `http://127.0.0.1:${PORT}/shop/`);
  const { run, calls } = tailscale({ 'status --json': RUNNING });
  assert.equal(hubUrl('shop', { home, port: PORT, run, tailscale: CLI }), `http://127.0.0.1:${PORT}/shop/`);
  assert.deepEqual(calls, []);
  await setTailnet(true, home);
  assert.equal(hubUrl('shop', { home, port: PORT, run, tailscale: CLI }), 'https://mac.tail.ts.net/shop/');
  assert.equal(hubUrl(undefined, { home, port: PORT, run, tailscale: CLI }), 'https://mac.tail.ts.net/');
});

test('mapping / serves the hub on the recorded daemon and removes old site mounts, and refuses when another daemon answers', () => {
  fs.mkdirSync(path.join(home, '.claude', 'kickflip'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'kickflip', 'manifest.json'), JSON.stringify({ sites: { shop: { port: 19461 } } }));
  const config = JSON.stringify({ Web: { 'mac.tail.ts.net:443': { Handlers: { '/': { Proxy: `http://127.0.0.1:${PORT}` }, '/shop/': { Proxy: 'http://127.0.0.1:19461' }, '/other/': { Proxy: 'http://127.0.0.1:9' } } } } });
  const { run, calls } = tailscale({ 'status --json': RUNNING, 'serve status --json': config });
  mapHub({ tailscale: { ...CLI, node: 'n1' }, port: PORT, home, run });
  assert.deepEqual(calls, ['tailscale status --json', `tailscale serve --bg ${PORT}`, 'tailscale serve status --json', 'tailscale serve --https=443 --set-path=/shop/ off']);
  const other = tailscale({ 'status --json': JSON.stringify({ BackendState: 'Running', Self: { ID: 'n2', HostName: 'brew-mac' } }) });
  assert.throws(() => mapHub({ tailscale: { ...CLI, node: 'n1' }, port: PORT, home, run: other.run }), /^Error: Tailscale's recorded daemon isn't running \(brew-mac answered in its place\)/);
  assert.deepEqual(other.calls, ['tailscale status --json']);
});

test('tailnet on maps / and records on, printing the hub’s tailnet address; with no Tailscale it refuses and stays off', async () => {
  const { run, calls } = tailscale({ 'status --json': RUNNING });
  assert.equal(await turnOn({ home, port: PORT, run, tailscale: CLI }), 'tailnet on: the hub is at https://mac.tail.ts.net/');
  assert.deepEqual(calls.slice(0, 2), [`tailscale serve --bg ${PORT}`, 'tailscale serve status --json']);
  assert.equal(tailnetOn(home), true);
  await setTailnet(false, home);
  await assert.rejects(turnOn({ home, port: PORT, run, platform: 'linux', tailscale: null }), /^Error: Tailscale isn't installed on this host; curl -fsSL https:\/\/tailscale.com\/install.sh \| sh$/);
  assert.equal(tailnetOn(home), false);
});

test('tailnet on with HTTPS off still maps and records on, and says what the address waits on', async () => {
  const { run } = tailscale({ 'status --json': JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'mac.tail.ts.net.' } }) });
  assert.equal(await turnOn({ home, port: PORT, run, tailscale: CLI }), "tailnet on; HTTPS isn't on for this tailnet; turn on HTTPS Certificates on the DNS page of the Tailscale admin console");
  assert.equal(tailnetOn(home), true);
});

test('tailnet off unmaps / and the try ports, records off and names the local address', async () => {
  await setTailnet(true, home);
  const config = JSON.stringify({ TCP: { 443: { HTTPS: true }, 8501: { HTTPS: true }, 9000: { HTTPS: true } } });
  const { run, calls } = tailscale({ 'status --json': RUNNING, 'serve status --json': config });
  assert.equal(await turnOff({ home, port: PORT, run, tailscale: { ...CLI, node: 'n1' } }), `tailnet off; tailscale / and try port 8501 unmapped. The hub serves this host at http://127.0.0.1:${PORT}/`);
  assert.deepEqual(calls, ['tailscale status --json', 'tailscale serve --https=443 --set-path=/ off', 'tailscale serve status --json', 'tailscale serve --https=8501 off']);
  assert.equal(tailnetOn(home), false);
});

test('tailnet off records off when another daemon answers, leaving / mapped with the fault, and with no Tailscale runs nothing', async () => {
  await setTailnet(true, home);
  const other = tailscale({ 'status --json': JSON.stringify({ BackendState: 'Running', Self: { ID: 'n2', HostName: 'brew-mac' } }) });
  assert.match(await turnOff({ home, port: PORT, run: other.run, tailscale: { ...CLI, node: 'n1' } }), /^tailnet off; tailscale \/ left mapped: Tailscale's recorded daemon isn't running \(brew-mac answered in its place\)/);
  assert.deepEqual(other.calls, ['tailscale status --json']);
  assert.equal(tailnetOn(home), false);
  assert.equal(await turnOff({ home, port: PORT, run: other.run, tailscale: null }), `tailnet off. The hub serves this host at http://127.0.0.1:${PORT}/`);
});

test('tailnet status says off with the local address and the command, and on with the tailnet address or why it has none', async () => {
  const { run, calls } = tailscale({ 'status --json': RUNNING });
  assert.equal(tailnetStatus({ home, port: PORT, run, tailscale: CLI }), `off: the hub serves this host only, at http://127.0.0.1:${PORT}/; kickflip tailnet on adds it to your tailnet`);
  assert.deepEqual(calls, []);
  await setTailnet(true, home);
  assert.equal(tailnetStatus({ home, port: PORT, run, tailscale: CLI }), 'on: the hub is at https://mac.tail.ts.net/');
  assert.throws(() => tailnetStatus({ home, port: PORT, run: tailscale({ 'status --json': '{"BackendState":"Stopped"}' }).run, tailscale: CLI }), /^Error: on, but Tailscale isn't running on this host; start it, or run tailscale up$/);
});
