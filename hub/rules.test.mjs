import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePorts } from '../shared/test-helpers.mjs';
import { SNOOZE_REFUSED } from './views.mjs';
import { ruleText, rulesOf, addRule, editRule, removeRule, applyRules, changed, ruleLines, RULE_MAX, RuleError } from './rules.mjs';

const HUB_DIR = path.dirname(fileURLToPath(import.meta.url));
const NOW = new Date('2026-10-24T12:00:00Z');
const saved = [
  { id: 'r1', text: 'Screenshots in every PR', by: 'owner', at: '2026-10-20T00:00:00Z' },
  { id: 'r2', text: 'Ask before touching main', by: 'claude', at: '2026-10-21T00:00:00Z' },
];

test('a rule is one line of text, at most RULE_MAX characters', () => {
  assert.equal(ruleText('  Keep\n it   short '), 'Keep it short');
  assert.throws(() => ruleText(' \n '), RuleError);
  assert.throws(() => ruleText(undefined), RuleError);
  assert.throws(() => ruleText('x'.repeat(RULE_MAX + 1)), /at most/);
  assert.equal(ruleText('x'.repeat(RULE_MAX)).length, RULE_MAX);
});

test('rulesOf skips hand-edited entries without an id or text', () => {
  assert.deepEqual(rulesOf({ rules: [saved[0], { text: 'no id' }, { id: 'r9', text: ' ' }, null] }), [saved[0]]);
  assert.deepEqual(rulesOf({}), []);
  assert.deepEqual(rulesOf(null), []);
});

test('add, edit and remove change one rule each, keep who added it, and refuse an unknown id or author', () => {
  const { rules, rule } = addRule(saved, { text: 'Codified', by: 'claude' }, NOW);
  assert.deepEqual(rules.slice(0, 2), saved);
  assert.deepEqual({ ...rule, id: undefined }, { id: undefined, text: 'Codified', by: 'claude', at: NOW.toISOString() });
  assert.match(rule.id, /^r[\w]+$/);
  assert.equal(addRule([], { text: 'Mine' }).rule.by, 'owner');
  assert.throws(() => addRule(saved, { text: 'x', by: 'bob' }), /--by takes owner or claude/);

  const edited = editRule(saved, 'r2', 'Ask first', NOW);
  assert.deepEqual(edited.rules[1], { id: 'r2', text: 'Ask first', by: 'claude', at: NOW.toISOString() });
  assert.throws(() => editRule(saved, 'r9', 'x'), /no rule "r9"/);
  assert.throws(() => editRule(saved, '../x', 'x'), /rule id/);

  assert.deepEqual(removeRule(saved, 'r1').rules, [saved[1]]);
  assert.throws(() => removeRule(saved, 'r9'), /no rule "r9"/);
});

test("a Settings save keeps unchanged rules, rewords edited ones, adds new ones as the owner's, and names each change", () => {
  const { rules, changes } = applyRules(saved, [{ id: 'r2', text: 'Ask before   touching main' }, { text: 'New one' }], ['r1', 'r2'], NOW);
  assert.deepEqual(rules[0], saved[1]);
  assert.deepEqual({ ...rules[1], id: 'x' }, { id: 'x', text: 'New one', by: 'owner', at: NOW.toISOString() });
  assert.deepEqual(changes, { added: ['New one'], edited: [], removed: ['Screenshots in every PR'] });
  assert.equal(changed(changes), true);

  const reworded = applyRules(saved, [{ id: 'r1', text: 'Screenshots in each PR' }, { id: 'r2', text: saved[1].text }], ['r1', 'r2'], NOW);
  assert.deepEqual(reworded.rules[0], { ...saved[0], text: 'Screenshots in each PR', at: NOW.toISOString() });
  assert.deepEqual(reworded.changes.edited, [{ from: 'Screenshots in every PR', to: 'Screenshots in each PR' }]);

  const same = applyRules(saved, saved.map(({ id, text }) => ({ id, text })), ['r1', 'r2']);
  assert.deepEqual(same.rules, saved);
  assert.equal(changed(same.changes), false);
});

test('a Settings save keeps a rule added elsewhere after the page loaded, and refuses a malformed list', () => {
  const { rules, changes } = applyRules(saved, [{ id: 'r1', text: saved[0].text }], ['r1'], NOW);
  assert.deepEqual(rules, saved);
  assert.equal(changed(changes), false);
  for (const bad of [null, 'x', [{ text: '' }], [{ id: 'r1', text: 'x', by: 'claude' }], [{ id: 'bad id', text: 'x' }]]) assert.throws(() => applyRules(saved, bad, []), RuleError, JSON.stringify(bad));
  assert.throws(() => applyRules(saved, [], [1]), /base/);
});

test('the watcher lines put the hub rules first, each on one line', () => {
  assert.deepEqual(ruleLines([{ id: 'h', text: 'Hub\nrule' }], saved), ['hub Hub rule', 'board Screenshots in every PR', 'board Ask before touching main']);
  assert.deepEqual(ruleLines([], []), []);
});

function inHome(home, code) {
  const script = `const rules = await import(${JSON.stringify(path.join(HUB_DIR, 'rules.mjs'))}); ${code}`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
}

test('writing the hub rules keeps every other key of settings.json, and a settings.json that does not parse is refused', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-'));
  try {
    const file = path.join(home, '.claude', 'kickflip', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const other = { polling: { windows: [{ from: '08:00', every_minutes: 15 }], hold_overnight: true }, notifications: { on: true }, other_key: 'kept' };
    fs.writeFileSync(file, JSON.stringify(other));
    assert.equal(inHome(home, `rules.writeHubRules(${JSON.stringify(saved)});`).status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ...other, rules: saved });
    const r = inHome(home, 'console.log(JSON.stringify(rules.readHubRules()));');
    assert.deepEqual(JSON.parse(r.stdout), saved);
    fs.writeFileSync(file, '{ broken');
    assert.match(inHome(home, 'rules.writeHubRules([]);').stderr, /not valid JSON/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{ broken');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('codex-share prints the setting in effect, refuses a change while Codex is not installed or logged in, and sets values preserving the other hub settings', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-share-'));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const env = { ...process.env, HOME: home, PATH: bin };
  const cli = (...args) => spawnSync(process.execPath, [path.join(HUB_DIR, '..', 'bin', 'kickflip.mjs'), 'codex-share', ...args], { env, encoding: 'utf8' });
  const file = path.join(home, '.claude', 'kickflip', 'settings.json');
  const auth = path.join(home, '.codex', 'auth.json');
  try {
    const help = spawnSync(process.execPath, [path.join(HUB_DIR, '..', 'bin', 'kickflip.mjs')], { env, encoding: 'utf8' });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /prints the Codex setting in effect for every board; with a value, saves it and prints it\./);
    assert.match(help.stdout, /auto \(also when unset\): Codex builds and reviews; while Codex is past the pause line or out of usage, Opus\n\s+builders take over until it resets\./);
    assert.match(help.stdout, /always \(Always on\): the same past the pause line; while Codex is out of usage, that work pauses until a\n\s+usage-reset check succeeds\./);
    assert.match(help.stdout, /off: no Codex\. While Codex isn't installed or logged in, the setting reads off and a change is refused\./);
    assert.equal(cli().stdout, 'off\n');
    const notInstalled = cli('always');
    assert.deepEqual([notInstalled.status, notInstalled.stdout, notInstalled.stderr], [1, '', "kickflip: Codex isn't installed on the host. Run brew install --cask codex, then choose again.\n"]);
    fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    assert.equal(cli().stdout, 'off\n');
    const loggedOut = cli('always');
    assert.deepEqual([loggedOut.status, loggedOut.stdout, loggedOut.stderr], [1, '', "kickflip: Codex isn't logged in on the host. Run codex login, then choose again.\n"]);
    assert.equal(fs.existsSync(file), false);
    fs.mkdirSync(path.dirname(auth));
    fs.writeFileSync(auth, '{}');
    assert.equal(cli().stdout, 'auto\n');
    const first = cli('always');
    assert.deepEqual([first.status, first.stdout, first.stderr], [0, 'always\n', '']);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { codexShare: 'always' });
    const other = { polling: { windows: [{ from: '00:00', every_minutes: 120 }] }, notifications: { on: false }, rules: saved, other_key: { keep: true } };
    fs.writeFileSync(file, JSON.stringify(other));
    assert.deepEqual([cli().status, cli().stdout], [0, 'auto\n']);
    for (const value of ['off', 'auto', 'always']) {
      const r = cli(value);
      assert.deepEqual([r.status, r.stdout, r.stderr], [0, `${value}\n`, '']);
      assert.equal(cli().stdout, `${value}\n`);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ...other, codexShare: value });
    }
    const before = fs.readFileSync(file, 'utf8');
    for (const args of [['on'], [''], ['Auto'], ['toString'], ['--help'], ['auto', 'off'], ['auto', '--json']]) {
      const r = cli(...args);
      assert.deepEqual([r.status, r.stdout, r.stderr], [2, '', 'kickflip: codex-share takes auto, always, or off\n']);
      assert.equal(fs.readFileSync(file, 'utf8'), before);
    }
    fs.unlinkSync(auth);
    assert.equal(cli().stdout, 'off\n');
    fs.writeFileSync(auth, '{}');
    assert.equal(cli().stdout, 'always\n');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("hub Settings edits the hub rules, and a save that changes them sends every board a rules event", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-rules-'));
  const [port, sitePort] = await freePorts(2);
  const siteDir = path.join(home, '.claude', 'kickflip', 'sites', 'orch');
  const web = path.join(home, '.claude', 'kickflip');
  fs.mkdirSync(path.join(siteDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(siteDir, 'board.json'), JSON.stringify({ title: 'Orch', items: 'waves' }));
  fs.writeFileSync(path.join(web, 'settings.json'), JSON.stringify({ polling: { windows: [{ from: '00:00', every_minutes: 120 }], hold_overnight: false, wakes: [] }, notifications: { on: true, weekends_off: false, snoozed_until: null }, other_key: 'kept' }));
  fs.writeFileSync(path.join(web, 'manifest.json'), JSON.stringify({ version: 1, sites: {
    orch: { dir: siteDir, port: sitePort, cmd: [process.execPath, path.join(HUB_DIR, '..', 'board', 'server.mjs'), siteDir] },
  } }));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const hub = spawn(process.execPath, [path.join(HUB_DIR, 'hub.mjs')], { env: { ...process.env, HOME: home, KICKFLIP_HUB_PORT: String(port), KICKFLIP_CLAUDE: '/usr/bin/false', PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin` } });
  const base = `http://127.0.0.1:${port}`;
  try {
    await new Promise((resolve, reject) => {
      let out = '';
      hub.stdout.on('data', (d) => { out += d; if (out.includes('hub on')) resolve(); });
      hub.once('exit', reject);
    });
    for (let i = 0; i < 50 && !(await fetch(`${base}/orch/_claude/health`).then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 100));
    const page = await (await fetch(`${base}/_hub/settings`)).text();
    assert.match(page, /<script src="\/_hub\/app\/rules-editor\.js\?v=[^"]+"><\/script>/);
    assert.match(page, /<script src="\/_hub\/app\/view-hub-settings\.js\?v=[^"]+"><\/script>/);
    const hubRules = async () => (await (await fetch(`${base}/_hub/api/settings`)).json()).rules;
    assert.deepEqual(await hubRules(), []);

    const post = (body) => fetch(`${base}/_hub/settings/rules`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const r = await post({ rules: [{ text: 'Screenshots </script> in every PR' }], base: [] });
    assert.equal(r.status, 200);
    const out = await r.json();
    assert.deepEqual([out.changed, out.events.map((e) => e.route), out.failed], [true, ['orch'], []]);
    const settings = JSON.parse(fs.readFileSync(path.join(web, 'settings.json'), 'utf8'));
    assert.equal(settings.other_key, 'kept');
    assert.equal(settings.polling.windows[0].every_minutes, 120);
    assert.deepEqual(settings.rules.map((x) => [x.text, x.by]), [['Screenshots </script> in every PR', 'owner']]);
    const events = fs.readFileSync(path.join(siteDir, 'data', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.kind === 'rules');
    assert.deepEqual(events.map((e) => e.data), [{ scope: 'hub', added: ['Screenshots </script> in every PR'], edited: [], removed: [] }]);
    assert.deepEqual((await hubRules()).map((x) => x.text), ['Screenshots </script> in every PR']);

    const again = await (await post({ rules: settings.rules.map(({ id, text }) => ({ id, text })), base: settings.rules.map((x) => x.id) })).json();
    assert.deepEqual([again.changed, again.events], [false, []]);
    const bad = await post({ rules: [{ text: ' ' }], base: [] });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /non-empty/);

    const getHub = async () => (await fetch(`${base}/_hub/api/hub`)).json();
    const codexNow = async () => { const { codex } = await getHub(); return [codex.usable, codex.tag, codex.share]; };
    const postCodex = (body, json = true) => fetch(`${base}/_hub/settings/codex`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(json ? { accept: 'application/json' } : {}) }, body, redirect: 'manual',
    });
    const file = path.join(web, 'settings.json');
    const before = JSON.parse(fs.readFileSync(file, 'utf8'));
    const notInstalled = "Codex isn't installed on the host. Run brew install --cask codex, then choose again.";
    assert.deepEqual(await codexNow(), [false, 'Not installed', 'off']);
    const refusedInstall = await postCodex('value=always');
    assert.deepEqual([refusedInstall.status, await refusedInstall.json()], [409, { error: notInstalled }]);
    const refusedForm = await postCodex('value=always', false);
    assert.deepEqual([refusedForm.status, await refusedForm.text()], [409, notInstalled]);
    fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    assert.deepEqual(await codexNow(), [false, 'Not installed', 'off']);
    const refusedLogin = await postCodex('value=always');
    assert.deepEqual([refusedLogin.status, await refusedLogin.json()], [409, { error: "Codex isn't logged in on the host. Run codex login, then choose again." }]);
    assert.deepEqual(await codexNow(), [false, 'Not logged in', 'off']);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), before);
    fs.mkdirSync(path.join(home, '.codex'));
    fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{}');
    assert.deepEqual(await codexNow(), [true, null, 'auto']);
    for (const value of ['always', 'off', 'auto']) {
      const r = await postCodex(`value=${value}`);
      assert.equal(r.status, 200);
      const out = await r.json();
      assert.equal(out.codex.share, value);
      assert.equal(out.codex.choices.find((c) => c.on).value, value);
      assert.deepEqual(out.codex, (await getHub()).codex);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ...before, codexShare: value });
    }
    const unchanged = fs.readFileSync(file, 'utf8');
    for (const body of ['', 'value=', 'value=on', 'value=Auto', 'value=toString']) {
      const r = await postCodex(body);
      assert.equal(r.status, 400);
      assert.deepEqual(await r.json(), { error: 'codex-share takes auto, always, or off' });
      assert.equal(fs.readFileSync(file, 'utf8'), unchanged);
    }
    const redirect = await postCodex('value=always', false);
    assert.deepEqual([redirect.status, redirect.headers.get('location')], [303, '/_hub/']);
    const refused = await postCodex('value=bad', false);
    assert.equal(refused.status, 400);
    assert.equal(await refused.text(), 'codex-share takes auto, always, or off');
    await t.test('pause line routes save the gate, refuse bad values and redirect forms', async () => {
      const postGate = (name, body, json = true) => fetch(`${base}/_hub/settings/${name}`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(json ? { accept: 'application/json' } : {}) }, body, redirect: 'manual',
      });
      assert.equal((await getHub()).pause.pause_at, 90);
      const noPause = await postGate('keep-going', 'value=on');
      assert.deepEqual([noPause.status, await noPause.json()], [409, { error: 'Nothing is paused.' }]);
      const reset = new Date(Date.now() + 3600_000).toISOString();
      fs.writeFileSync(path.join(web, 'usage.json'), JSON.stringify({ claude: { at: new Date().toISOString(), five_hour: { used_percentage: 91, resets_at: reset } } }));
      for (const value of [50, 55, 90, 95, 100]) {
        const r = await postGate('pause-at', `value=${value}`);
        assert.equal(r.status, 200);
        const out = await r.json();
        assert.equal(out.pause.pause_at, value);
        assert.equal(out.pause.state, value <= 90 ? 'paused' : 'normal');
        const sidebar = await (await fetch(`${base}/_hub/sidebar.json`)).json();
        assert.deepEqual(sidebar.pause, out.pause);
        assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).other_key, 'kept');
      }
      await postGate('pause-at', 'value=90');
      const go = await postGate('keep-going', 'value=on');
      assert.equal((await go.json()).pause.state, 'going');
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).keepGoing, { window: 'five_hour', until: reset });
      const twice = await postGate('keep-going', 'value=on');
      assert.equal(twice.status, 409);
      const stop = await postGate('keep-going', 'value=off');
      assert.equal((await stop.json()).pause.state, 'paused');
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).keepGoing, undefined);
      const unchanged = fs.readFileSync(file, 'utf8');
      for (const [name, body] of [['pause-at', ''], ['pause-at', 'value=91'], ['pause-at', 'value=90.0'], ['pause-at', 'value=105'], ['keep-going', 'value=yes'], ['keep-going', '']]) {
        const r = await postGate(name, body);
        assert.equal(r.status, 400);
        assert.ok((await r.json()).error);
        assert.equal(fs.readFileSync(file, 'utf8'), unchanged);
      }
      for (const [name, body] of [['keep-going', 'value=on'], ['keep-going', 'value=off'], ['pause-at', 'value=95']]) {
        const r = await postGate(name, body, false);
        assert.deepEqual([r.status, r.headers.get('location')], [303, '/_hub/']);
      }
      const stateFile = path.join(web, 'usage-gate-state.json');
      const eventsFile = path.join(siteDir, 'data', 'events.jsonl');
      const resumed = () => fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((e) => e.kind === 'usage-resumed');
      const count = resumed().length;
      fs.writeFileSync(stateFile, JSON.stringify({ state: 'paused', window: 'five_hour' }));
      fs.writeFileSync(path.join(web, 'usage.json'), JSON.stringify({ claude: { at: new Date().toISOString(), five_hour: { used_percentage: 91, resets_at: new Date(Date.now() - 1000).toISOString() } } }));
      const deadline = Date.now() + 20000;
      while (resumed().length === count && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(resumed().length, count + 1);
      assert.deepEqual(resumed().at(-1).data, { window: 'five_hour' });
      fs.writeFileSync(stateFile, JSON.stringify({ state: 'going', window: 'five_hour' }));
      await postGate('pause-at', 'value=90');
      assert.equal(resumed().length, count + 1);
      assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).state, 'normal');
    });
    const notify = await fetch(`${base}/_hub/settings/notifications`, {
      method: 'POST', headers: { accept: 'application/json' }, body: 'set=weekends&value=on',
    });
    assert.equal(notify.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).codexShare, 'always');
    await t.test('custom snooze refuses past, invalid and over-30-day ends, saves a valid ISO end and ends it', async () => {
      const postNotification = (body, json = true) => fetch(`${base}/_hub/settings/notifications`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(json ? { accept: 'application/json' } : {}) },
        body: new URLSearchParams(body), redirect: 'manual',
      });
      await postNotification({ set: 'weekends' });
      const before = fs.readFileSync(file, 'utf8');
      const past = new Date(Date.now() - 60_000).toISOString();
      for (const snooze of [past, new Date(Date.now() + 31 * 86_400_000).toISOString(), 'invalid']) {
        const refused = await postNotification({ snooze });
        assert.equal(refused.status, 400);
        assert.deepEqual(await refused.json(), { error: SNOOZE_REFUSED });
        assert.equal(fs.readFileSync(file, 'utf8'), before);
      }
      const redirect = await postNotification({ snooze: past }, false);
      assert.deepEqual([redirect.status, redirect.headers.get('location')], [303, '/_hub/?refused=snooze#notifications']);
      const until = new Date(Date.now() + 3_600_000).toISOString();
      const valid = await postNotification({ snooze: until });
      assert.equal(valid.status, 200);
      const out = await valid.json();
      assert.equal(out.snooze, null);
      assert.match(out.snoozed.title, /^Snoozed until /);
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).notifications.snoozed_until, until);
      const sidebar = await (await fetch(`${base}/_hub/sidebar.json`)).json();
      assert.deepEqual(sidebar.notifications, { state: 'held', text: out.snoozed.title });
      const ended = await postNotification({ snooze: 'off' });
      assert.equal(ended.status, 200);
      assert.equal((await ended.json()).snoozed, null);
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).notifications.snoozed_until, null);
    });
  } finally {
    if (hub.exitCode === null && hub.signalCode === null) {
      const exited = new Promise((resolve) => hub.once('exit', resolve));
      hub.kill('SIGTERM');
      await exited;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
