import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readinessReader, readinessRows, reportSlack } from './readiness.mjs';

const now = Date.parse('2026-11-02T17:00:00Z');
const tailscale = { installed: true, signedIn: true, pointsAtHub: true, dns: 'host.ts.net', operatorChecked: true, operator: 'love', username: 'love' };
const ready = () => ({ github: 'love', codex: { usable: true }, linear: { set: true, workspace: 'Work' }, slack: { ready: true, title: 'Board', at: new Date(now).toISOString() }, tailscale, notifications: { on: true, devices: 2 } });
const off = () => ({ github: null, codex: { usable: false, words: "Codex isn't installed on the host.", fix: 'install codex' }, linear: { set: false }, slack: null, tailscale: { ...tailscale, installed: false }, notifications: { on: false, devices: 0 } });
const probesOf = (checks) => Object.fromEntries(Object.entries(checks).map(([id, value]) => [id, () => value]));

test('readiness shares fixed row order, ready details, fixes, waits and waiting sentences', async () => {
  const r = readinessReader({ now: () => now, probes: probesOf(ready()) });
  const rows = await r.rows();
  assert.deepEqual(rows.map((r) => r.id), ['github', 'codex', 'linear', 'slack', 'tailscale', 'notifications']);
  assert.deepEqual(rows.map((r) => r.name), ['GitHub', 'Codex', 'Linear', 'Slack', 'Tailscale', 'Notifications']);
  assert.ok(rows.every((r) => r.ready));
  assert.deepEqual(rows.map((r) => r.detail), ['gh logged in as love', 'Installed and logged in', 'Key set · Work workspace', 'Board’s session reported a Slack connector, just now', 'Serving host.ts.net · operator love', 'Pushes on · 2 devices']);
  for (const row of rows) assert.equal(await r.waiting(row.id), null);
  const reader = readinessReader({ now: () => now, probes: probesOf(off()) });
  const missing = await reader.rows();
  assert.ok(missing.every((r) => !r.ready && r.missing && r.fix));
  assert.deepEqual(missing.map((r) => r.waits), ['GitHub polling and PR reports wait on this.', 'Codex builds and reviews wait on this; Codex share stays Off.', 'Linear moves wait on this.', 'Reviewer DMs and digests wait on this.', 'Try builds wait on this.', 'Pushes wait on this.']);
  assert.equal(missing[0].fix.command, 'gh auth login');
  assert.equal(missing[1].fix.command, 'install codex');
  assert.deepEqual(missing[2].fix, { settings: 'linear', label: 'Hub settings › Linear', text: 'Add one in' });
  assert.equal(missing[5].fix.settings, 'notifications');
  assert.equal(await reader.waiting('slack'), 'Reviewer DMs and digests wait on Slack: No board session has reported yet.');
  assert.equal(await reader.waiting('tailscale'), "Try builds wait on Tailscale: Tailscale isn't installed on the host.");
  for (const row of missing) assert.match(await reader.waiting(row.id), new RegExp(`wait on ${row.name}:`));
});

test('Slack reports yes, no and no report, with the reporting site and age', async () => {
  for (const [minutes, age] of [[0, 'just now'], [40, '40 min ago'], [120, '2 h ago'], [4320, '3 days ago']]) {
    for (const yes of [false, true]) {
      const checks = { ...ready(), slack: { ready: yes, title: 'Hub', at: new Date(now - minutes * 60_000).toISOString() } };
      const row = (await readinessReader({ now: () => now, probes: probesOf(checks) }).rows())[3];
      assert.equal(row.ready, yes);
      assert.equal(row.detail || row.missing, `Hub’s session reported ${yes ? 'a' : 'no'} Slack connector, ${age}`);
      if (!yes) assert.equal(row.fix.text, 'Add Slack to Claude’s connectors. The next board session to start reports it.');
    }
  }
  assert.equal(readinessRows(off())[3].missing, 'No board session has reported yet');
});

test('Tailscale uses the first failing check and doctor fixes; Notifications ignore holds', () => {
  const row = (value, platform) => readinessRows({ tailscale: value }, { platform })[0];
  assert.equal(row({ ...tailscale, installed: false }, 'darwin').fix.command, 'brew install --cask tailscale');
  assert.equal(row({ ...tailscale, installed: false }, 'linux').fix.command, 'curl -fsSL https://tailscale.com/install.sh | sh');
  assert.equal(row({ ...tailscale, signedIn: false, pointsAtHub: false }).fix.command, 'tailscale up');
  assert.equal(row({ ...tailscale, pointsAtHub: false, operator: 'other' }).fix.command, 'kickflip doctor --fix');
  assert.equal(row({ ...tailscale, operator: 'other' }).fix.command, 'sudo tailscale set --operator=$USER');
  assert.equal(row({ ...tailscale, operatorChecked: false }).detail, 'Serving host.ts.net');
  assert.equal(readinessRows({ notifications: { on: true, devices: 0 } })[0].missing, 'No device has turned on notifications');
  assert.equal(readinessRows({ notifications: { on: true, devices: 1, snoozed_until: '2099-01-01', weekends_off: true } })[0].detail, 'Pushes on · 1 device');
  const codex = readinessRows({ codex: { usable: false, words: "Codex isn't logged in on the host.", fix: 'codex login' } })[0];
  assert.equal(codex.missing, "Codex isn't logged in on the host.");
  assert.equal(codex.fix.command, 'codex login');
});

test('only process probes are cached, fresh bypasses them, and concurrent reads share probes', async () => {
  let time = now;
  const counts = {};
  const probes = Object.fromEntries(Object.entries(ready()).map(([id, value]) => [id, () => { counts[id] = (counts[id] || 0) + 1; return value; }]));
  const r = readinessReader({ probes, now: () => time, cacheMs: 100 });
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); };
  const state = path.join(home, '.claude', 'kickflip');
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const r = readinessReader({ home, env: { PATH: bin }, now: () => now, probes: { github: () => 'love', tailscale: () => tailscale } });
  assert.deepEqual((await r.rows()).map((r) => r.ready), [true, false, false, false, true, false]);
  write(path.join(home, '.codex', 'auth.json'), {});
  write(path.join(state, 'linear.json'), { key: 'secret', workspace: 'Office' });
  reportSlack(true, { home, title: 'Other board', route: 'other', now: new Date(now) });
  write(path.join(state, 'settings.json'), { notifications: { on: true, weekends_off: true, snoozed_until: '2099-01-01T00:00:00Z' } });
  write(path.join(state, 'push', 'subs.json'), [{ endpoint: 'https://push.example/device' }]);
  assert.ok((await r.rows()).every((r) => r.ready));
  fs.rmSync(path.join(home, '.codex', 'auth.json'));
  fs.rmSync(path.join(state, 'linear.json'));
  reportSlack(false, { home, now: new Date(now) });
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
  const options = { run, platform: 'linux', uid: 1000, username: 'love', port: 4501 };
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
