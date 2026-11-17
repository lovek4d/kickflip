import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readinessReader, readinessRows } from './readiness.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

const CLI = { kind: 'cli', cli: 'tailscale' };

const now = Date.parse('2026-11-02T17:00:00Z');
const tailscale = { installed: true, signedIn: true, pointsAtHub: true, dns: 'host.ts.net', operatorChecked: true, operator: 'love', username: 'love' };
const ready = () => ({ github: 'love', codex: { usable: true }, linear: { set: true, workspace: 'Work' }, slack: { set: true, team: 'Acme', user: 'love' }, tailscale, notifications: { on: true, devices: DEVICES } });
const off = () => ({ github: null, codex: { usable: false, words: "Codex isn't installed on the host.", fix: 'install codex' }, linear: { set: false }, slack: { set: false }, tailscale: { ...tailscale, installed: false }, notifications: { on: false, devices: [] } });
const DEVICES = [{ id: 'a1', kind: 'Mac', browser: 'Chrome', added: '2026-11-02T15:00:00Z', agent: 'x' }, { id: 'b2', kind: 'iPhone', browser: 'Safari', added: '2026-11-02T16:55:00Z' }];
const probesOf = (checks) => Object.fromEntries(Object.entries(checks).map(([id, value]) => [id, () => value]));

test('readiness shares fixed row order, ready details, fixes, waits and waiting sentences', async () => {
  const r = readinessReader({ now: () => now, tailnet: () => true, probes: probesOf(ready()) });
  const rows = await r.rows();
  assert.deepEqual(rows.map((r) => r.id), ['github', 'codex', 'linear', 'slack', 'tailscale', 'notifications']);
  assert.deepEqual(rows.map((r) => r.name), ['GitHub', 'Codex', 'Linear', 'Slack', 'Tailnet', 'Notifications']);
  assert.ok(rows.every((r) => r.ready));
  assert.deepEqual(rows.map((r) => r.detail), ['gh logged in as love', 'Installed and logged in', 'Key set · Work workspace', 'Token set · Acme workspace, sending as love', 'Serving host.ts.net · operator love', 'Pushes on · 2 devices']);
  assert.deepEqual(rows[5].devices, [{ id: 'a1', kind: 'Mac', browser: 'Chrome', added: '2026-11-02T15:00:00Z' }, { id: 'b2', kind: 'iPhone', browser: 'Safari', added: '2026-11-02T16:55:00Z' }]);
  for (const row of rows) assert.equal(await r.waiting(row.id), null);
  const reader = readinessReader({ now: () => now, tailnet: () => true, probes: probesOf(off()) });
  const missing = await reader.rows();
  assert.ok(missing.every((r) => !r.ready && r.missing && (r.fix || r.keyButton)));
  assert.deepEqual(missing.map((r) => r.waits), ['GitHub polling and PR reports wait on this.', 'Codex implementing and reviewing wait on this; Codex share stays Off.', null, null, 'Try builds wait on this.', 'Pushes wait on this.']);
  assert.equal(missing[0].fix.command, 'gh auth login');
  assert.equal(missing[1].fix.command, 'install codex');
  assert.deepEqual([missing[2].fix, missing[2].keyButton], [undefined, 'Add key']);
  assert.equal(missing[5].fix.settings, 'notifications');
  assert.equal(await reader.waiting('slack'), 'Reviewer DMs and digests wait on Slack: No Slack token set.');
  assert.equal(await reader.waiting('tailscale'), "Try builds wait on Tailnet: Tailscale isn't installed on the host.");
  for (const row of missing.filter((r) => r.waits)) assert.match(await reader.waiting(row.id), new RegExp(`wait on ${row.name}:`));
  assert.equal(await reader.waiting('linear'), null);
});

test('Slack is ready while Hub’s token is saved and Slack has not refused it, and its button opens its key modal: Add key or Change key', () => {
  const row = (slack) => readinessRows({ slack })[0];
  assert.deepEqual(row({ set: false }), { id: 'slack', name: 'Slack', ready: false, missing: 'No Slack token set', keyButton: 'Add key', waits: null });
  assert.deepEqual([row({ set: true, refused: true, team: 'Acme', user: 'love' }).missing, row({ set: true, refused: true }).keyButton], ['Slack refused the token', 'Change key']);
  assert.equal(row({ set: true, team: 'Acme', user: 'love' }).keyButton, 'Change key');
  assert.equal(row({ set: true, team: 'Acme', user: 'love' }).detail, 'Token set · Acme workspace, sending as love');
});

test('Tailscale uses the first failing check and doctor fixes; Notifications ignore holds', () => {
  const row = (value, platform) => readinessRows({ tailscale: value }, { platform })[0];
  assert.equal(row({ ...tailscale, installed: false }, 'darwin').fix.command, 'brew install --cask tailscale-app');
  assert.equal(row({ ...tailscale, installed: false }, 'linux').fix.command, 'curl -fsSL https://tailscale.com/install.sh | sh');
  assert.equal(row({ ...tailscale, signedIn: false, pointsAtHub: false }).fix.command, 'tailscale up');
  const elsewhere = row({ ...tailscale, signedIn: false, elsewhere: 'brew-mac', pointsAtHub: false });
  assert.deepEqual([elsewhere.missing, elsewhere.fix.command], ["Tailscale's recorded daemon isn't running; brew-mac answered in its place", 'kickflip doctor --fix']);
  assert.equal(row({ ...tailscale, pointsAtHub: false, operator: 'other' }).fix.command, 'kickflip doctor --fix');
  assert.equal(row({ ...tailscale, operator: 'other' }).fix.command, 'sudo tailscale set --operator=$USER');
  assert.equal(row({ ...tailscale, operatorChecked: false }).detail, 'Serving host.ts.net');
  assert.equal(readinessRows({ notifications: { on: true, devices: [] } })[0].missing, 'No device has turned on notifications');
  assert.equal(readinessRows({ notifications: { on: true, devices: DEVICES.slice(0, 1), snoozed_until: '2099-01-01', weekends_off: true } })[0].detail, 'Pushes on · 1 device');
  const codex = readinessRows({ codex: { usable: false, words: "Codex isn't logged in on the host.", fix: 'codex login' } })[0];
  assert.equal(codex.missing, "Codex isn't logged in on the host.");
  assert.equal(codex.fix.command, 'codex login');
});

test('only process probes are cached, fresh bypasses them, and concurrent reads share probes', async () => {
  let time = now;
  const counts = {};
  const probes = Object.fromEntries(Object.entries(ready()).map(([id, value]) => [id, () => { counts[id] = (counts[id] || 0) + 1; return value; }]));
  const r = readinessReader({ probes, tailnet: () => true, now: () => time, cacheMs: 100 });
  await Promise.all([r.rows(), r.rows()]);
  assert.deepEqual(counts, { github: 1, codex: 2, linear: 2, slack: 2, tailscale: 1, notifications: 2 });
  time += 99;
  await r.rows();
  assert.equal(counts.github, 1);
  assert.equal(counts.tailscale, 1);
  time++;
  await r.rows();
  assert.equal(counts.github, 2);
  assert.equal(counts.tailscale, 2);
  await r.rows({ fresh: true });
  assert.equal(counts.github, 3);
  assert.equal(counts.tailscale, 3);
  await r.waiting('slack');
  assert.equal(counts.github, 3);
  assert.equal(counts.slack, 6);
});

test('file-backed checks see changes immediately while gh and tailscale stay cached', async (t) => {
  const home = tempDir('readiness-');
  const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); };
  const state = path.join(home, '.claude', 'kickflip');
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const r = readinessReader({ home, env: { PATH: bin }, now: () => now, tailnet: () => true, probes: { github: () => 'love', tailscale: () => tailscale } });
  assert.deepEqual((await r.rows()).map((r) => r.ready), [true, false, false, false, true, false]);
  write(path.join(home, '.codex', 'auth.json'), {});
  const slack = { token: 'xoxp-secret', team: 'Acme', user: 'love' };
  write(path.join(state, 'secrets.json'), { linear: { key: 'secret', workspace: 'Office' }, slack });
  write(path.join(state, 'settings.json'), { notifications: { on: true, weekends_off: true, snoozed_until: '2099-01-01T00:00:00Z' } });
  write(path.join(state, 'push', 'subs.json'), [{ endpoint: 'https://push.example/device' }]);
  assert.ok((await r.rows()).every((r) => r.ready));
  write(path.join(state, 'secrets.json'), { linear: { key: 'secret', workspace: 'Office', refused_at: new Date(now).toISOString() }, slack });
  const refused = (await r.rows())[2];
  assert.deepEqual([refused.ready, refused.refused, refused.missing, refused.keyButton], [false, true, 'Linear refused the key', 'Change key']);
  fs.rmSync(path.join(home, '.codex', 'auth.json'));
  write(path.join(state, 'secrets.json'), {});
  write(path.join(state, 'push', 'subs.json'), []);
  const rows = await r.rows();
  assert.deepEqual(rows.map((r) => r.ready), [true, false, false, false, true, false]);
  assert.ok(!JSON.stringify(rows).includes('secret'));
});

test('readiness uses the extracted Tailscale checks with an asynchronous runner', async () => {
  const { tailscaleState } = await import('../bin/install.mjs');
  const seen = [];
  let root = 'http://127.0.0.1:4501/';
  const run = async (command, args) => {
    await Promise.resolve();
    seen.push([command, args.join(' ')]);
    const output = {
      version: '1.0', 'status --json': { BackendState: 'Running', Self: { DNSName: 'host.ts.net.' } },
      'debug prefs': { OperatorUser: 'love' },
      'serve status --json': { Web: { 'host.ts.net:443': { Handlers: { '/': { Proxy: root } } } } },
    }[args.join(' ')];
    return { status: 0, stdout: typeof output === 'string' ? output : JSON.stringify(output) };
  };
  const options = { run, platform: 'linux', uid: 1000, username: 'love', port: 4501, tailscale: CLI };
  const state = await tailscaleState(options);
  const row = readinessRows({ tailscale: state })[0];
  assert.equal(row.ready, true);
  assert.equal(row.detail, 'Serving host.ts.net · operator love');
  assert.deepEqual(seen, [['tailscale', 'version'], ['tailscale', 'status --json'], ['tailscale', 'debug prefs'], ['tailscale', 'serve status --json']]);
  root = 'http://127.0.0.1:4500/';
  const missing = readinessRows({ tailscale: await tailscaleState(options) })[0];
  assert.equal(missing.ready, false);
  assert.equal(missing.fix.command, 'kickflip doctor --fix');
});

// docs/adr/2026-11-09-1626-gh-refuses-while-githubs-hourly-limit-holds.md
test("while GitHub's limit holds gh's account, the GitHub row reads rate limited with its reset, read fresh each time", async (t) => {
  const home = tempDir('readiness-');
  const gate = path.join(home, '.claude', 'kickflip', 'gh-limit.json');
  fs.mkdirSync(path.dirname(gate), { recursive: true });
  const reset = new Date(now + 41 * 60_000);
  let logins = 0;
  const r = readinessReader({ home, now: () => now, probes: { ...probesOf(ready()), github: () => { logins++; return 'love'; } } });
  assert.equal((await r.rows())[0].ready, true);
  fs.writeFileSync(gate, JSON.stringify({ octo: { core: reset.toISOString() } }));
  assert.equal((await r.rows())[0].ready, true, "another account's limit leaves the row ready");
  fs.writeFileSync(gate, JSON.stringify({ primary: { core: new Date(now + 60_000).toISOString(), graphql: reset.toISOString() } }));
  const [row] = await r.rows();
  const at = `${reset.getHours() % 12 || 12}:${String(reset.getMinutes()).padStart(2, '0')}${reset.getHours() < 12 ? 'am' : 'pm'}`;
  assert.deepEqual(row, { id: 'github', name: 'GitHub', ready: false, limited: true, missing: `resets at ${at}`, waits: 'GitHub polling and PR reports wait on this.' });
  fs.writeFileSync(gate, JSON.stringify({ primary: { graphql: new Date(now - 1000).toISOString() } }));
  assert.equal((await r.rows())[0].ready, true, 'the row is ready again once the limit resets');
  assert.equal(logins, 1, 'gh is asked only when the cache runs out, the gate on every read');
});

// docs/adr/2026-11-15-0730-an-integration-missing-a-permission-reads-degraded.md
test('a ready integration missing a permission carries each missing scope with what stops working and one shared fix; none missing or refused carries none', async () => {
  const row = (slack) => readinessRows({ slack: { set: true, team: 'Acme', user: 'love', ...slack } })[0];
  const fix = 'Add these scopes to the Slack app, reinstall it, paste the new token';
  const unheard = { scope: 'im:history', effect: "Review-thread replies aren't heard" };
  const unsearched = { scope: 'search:read', effect: "@kickflip in your DMs isn't found" };
  assert.equal(row({}).permissions, undefined);
  assert.deepEqual(row({ unheard: true }).permissions, { missing: [unheard], fix });
  assert.deepEqual(row({ unsearched: true }).permissions, { missing: [unsearched], fix });
  assert.deepEqual(row({ unheard: true, unsearched: true }).permissions, { missing: [unheard, unsearched], fix });
  assert.equal(row({ unheard: true }).ready, true);
  assert.equal(row({ unheard: true }).note, undefined);
  const refused = row({ refused: true, unheard: true, unsearched: true });
  assert.deepEqual([refused.ready, refused.refused, refused.missing, refused.permissions], [false, true, 'Slack refused the token', undefined]);
  // Sends go on while a permission is missing, so nothing waits on Slack.
  const reader = readinessReader({ now: () => now, probes: probesOf({ ...ready(), slack: { set: true, team: 'Acme', user: 'love', unheard: true, unsearched: true } }) });
  assert.equal(await reader.waiting('slack'), null);
  for (const r of await reader.rows()) if (r.id !== 'slack') assert.equal(r.permissions, undefined);
});

test('Tailscale is checked against the port the hub listens on, not the env', async () => {
  const bin = tempDir('readiness-ts-');
  const script = path.join(bin, 'tailscale');
  const status = JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'host.ts.net.' } });
  const serve = JSON.stringify({ Web: { 'host.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:4777/' } } } } });
  fs.writeFileSync(script, `#!/bin/sh\ncase "$*" in\n  version) echo 1.0;;\n  "status --json") echo '${status}';;\n  "debug prefs") echo '{"OperatorUser":"x"}';;\n  "serve status --json") echo '${serve}';;\nesac\n`, { mode: 0o700 });
  fs.mkdirSync(path.join(bin, '.claude', 'kickflip'), { recursive: true });
  fs.writeFileSync(path.join(bin, '.claude', 'kickflip', 'settings.json'), JSON.stringify({ tailnet: true }));
  const r = readinessReader({ home: bin, env: { PATH: bin, KICKFLIP_TAILSCALE: script, KICKFLIP_HUB_PORT: '4500' }, now: () => now, probes: { github: () => 'love' } });
  const pointing = async () => (await r.rows()).find((row) => row.id === 'tailscale').missing;
  assert.equal(await pointing(), 'Tailscale / is not serving the hub');
  r.listenOn(4777);
  assert.notEqual(await pointing(), 'Tailscale / is not serving the hub');
});

test('with the tailnet off, its row is one grey Tailnet: off with the command, nothing waits on it, no tailscale runs, and the setting is read on every call', async () => {
  const home = tempDir('readiness-off-');
  const bin = path.join(home, 'bin');
  const calls = path.join(home, 'ts-calls');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'tailscale'), `#!/bin/sh\necho "$@" >> '${calls}'\necho '{}'\n`, { mode: 0o700 });
  const r = readinessReader({ home, env: { PATH: bin, KICKFLIP_TAILSCALE: path.join(bin, 'tailscale') }, now: () => now, probes: { github: () => 'love' } });
  const row = async () => (await r.rows()).find((it) => it.id === 'tailscale');
  assert.deepEqual(await row(), { id: 'tailscale', name: 'Tailnet', ready: false, off: true, detail: 'The hub serves this host only', fix: { command: 'kickflip tailnet on' }, waits: null });
  assert.equal(await r.waiting('tailscale'), null);
  assert.equal(fs.existsSync(calls), false);
  fs.mkdirSync(path.join(home, '.claude', 'kickflip'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'kickflip', 'settings.json'), JSON.stringify({ tailnet: true }));
  assert.equal((await row()).off, undefined);
  assert.ok(fs.existsSync(calls));
});
