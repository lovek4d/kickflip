import { home as hubHome, web as hubWeb, bin as hubBin, write, inProcessHub, serverSignals } from './hub-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePorts } from '../shared/test-helpers.mjs';
import { SNOOZE_REFUSED } from './views.mjs';
import { ruleText, rulesOf, addRule, editRule, removeRule, applyRules, changed, ruleLines, RULE_MAX, RuleError } from './rules.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

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
  const home = tempDir('rules-');
  try {
    const file = path.join(home, '.claude', 'kickflip', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const other = { quiet: { start: '22:00', end: '08:00', hold: true }, notifications: { on: true }, other_key: 'kept' };
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
  const home = tempDir('codex-share-');
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
    assert.match(help.stdout, /off: Claude builds and reviews\. While Codex isn't installed or logged in, the setting reads off and a change is refused\./);
    assert.equal(cli().stdout, 'off\n');
    const notInstalled = cli('always');
    assert.deepEqual([notInstalled.status, notInstalled.stdout, notInstalled.stderr], [1, '', `kickflip: Codex isn't installed on the host. Run ${process.platform === 'darwin' ? 'brew install --cask codex' : 'npm i -g @openai/codex'}, then choose again.\n`]);
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
    const other = { quiet: { start: '23:59', end: '00:00', hold: false }, notifications: { on: false }, rules: saved, other_key: { keep: true } };
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
  const home = hubHome;
  const web = hubWeb;
  const bin = hubBin;
  fs.rmSync(web, { recursive: true, force: true });
  fs.rmSync(path.join(bin, 'codex'), { force: true });
  const [sitePort] = await freePorts(1);
  const siteDir = path.join(web, 'sites', 'orch');
  const signal = await serverSignals(t);
  write(path.join(siteDir, 'board.json'), { title: 'Orch', items: 'waves' });
  fs.mkdirSync(path.join(siteDir, 'data'), { recursive: true });
  write(path.join(web, 'settings.json'), { quiet: { start: '23:59', end: '00:00', hold: false }, notifications: { on: true, weekends_off: false, snoozed_until: null }, other_key: 'kept' });
  write(path.join(web, 'manifest.json'), { version: 1, sites: {
    orch: { dir: siteDir, port: sitePort, cmd: [process.execPath, ...signal.args, path.join(HUB_DIR, '..', 'board', 'server.mjs'), siteDir] },
  } });
  const hub = await inProcessHub(t);
  const base = hub.base;
  {
    await signal.up();
    await hub.reconcile();
    assert.ok((await fetch(`${base}/orch/_claude/health`)).ok, 'Orch server is healthy');
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
    assert.deepEqual(settings.quiet, { start: '23:59', end: '00:00', hold: false });
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
    const notInstalled = `Codex isn't installed on the host. Run ${process.platform === 'darwin' ? 'brew install --cask codex' : 'npm i -g @openai/codex'}, then choose again.`;
    assert.deepEqual(await codexNow(), [false, 'not installed', 'off']);
    const refusedInstall = await postCodex('value=always');
    assert.deepEqual([refusedInstall.status, await refusedInstall.json()], [409, { error: notInstalled }]);
    const refusedForm = await postCodex('value=always', false);
    assert.deepEqual([refusedForm.status, await refusedForm.text()], [409, notInstalled]);
    fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    assert.deepEqual(await codexNow(), [false, 'not installed', 'off']);
    const refusedLogin = await postCodex('value=always');
    assert.deepEqual([refusedLogin.status, await refusedLogin.json()], [409, { error: "Codex isn't logged in on the host. Run codex login, then choose again." }]);
    assert.deepEqual(await codexNow(), [false, 'not logged in', 'off']);
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
    await t.test('the Claude model route saves opus, auto or sonnet, refuses anything else and redirects forms', async () => {
      const postModel = (body, json = true) => fetch(`${base}/_hub/settings/claude-model`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(json ? { accept: 'application/json' } : {}) }, body, redirect: 'manual',
      });
      assert.equal((await getHub()).claude.model, 'auto');
      const settingsBefore = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const value of ['opus', 'sonnet', 'auto']) {
        const r = await postModel(`value=${value}`);
        assert.equal(r.status, 200);
        const out = await r.json();
        assert.equal(out.claude.model, value);
        assert.deepEqual(out.claude, (await getHub()).claude);
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ...settingsBefore, claudeModel: value });
      }
      const bad = await postModel('value=haiku');
      assert.deepEqual([bad.status, await bad.json()], [400, { error: 'claude-model takes opus, auto or sonnet' }]);
      const badForm = await postModel('value=', false);
      assert.deepEqual([badForm.status, await badForm.text()], [400, 'claude-model takes opus, auto or sonnet']);
      const redirect = await postModel('value=opus', false);
      assert.deepEqual([redirect.status, redirect.headers.get('location')], [303, '/_hub/']);
    });
    await t.test('the Orchestrators route saves opus or sonnet, refuses anything else and redirects forms', async () => {
      const post = (body, json = true) => fetch(`${base}/_hub/settings/orchestrator-model`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(json ? { accept: 'application/json' } : {}) }, body, redirect: 'manual',
      });
      const on = (hub) => hub.claude.orchestrators.choices.find((c) => c.on).value;
      assert.equal(on(await getHub()), 'opus');
      const settingsBefore = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const value of ['sonnet', 'opus']) {
        const r = await post(`value=${value}`);
        assert.equal(r.status, 200);
        assert.equal(on(await r.json()), value);
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ...settingsBefore, orchestratorModel: value });
      }
      const bad = await post('value=auto');
      assert.deepEqual([bad.status, await bad.json()], [400, { error: 'orchestrator-model takes opus or sonnet' }]);
      const redirect = await post('value=opus', false);
      assert.deepEqual([redirect.status, redirect.headers.get('location')], [303, '/_hub/']);
    });
    // docs/adr/2026-11-18-0800-models-and-land-tests-are-hub-settings-only.md
    await t.test('the land tests route saves 1 to 99, refuses anything else and redirects forms', async () => {
      const post = (body, json = true) => fetch(`${base}/_hub/settings/land-tests`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(json ? { accept: 'application/json' } : {}) }, body, redirect: 'manual',
      });
      assert.equal((await getHub()).claude.landTests, 1);
      const settingsBefore = JSON.parse(fs.readFileSync(file, 'utf8'));
      const r = await post('value=3');
      assert.equal(r.status, 200);
      assert.equal((await r.json()).claude.landTests, 3);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ...settingsBefore, landTests: 3 });
      for (const value of ['0', '100', '1.5']) {
        const refused = await post(`value=${value}`);
        assert.deepEqual([refused.status, await refused.json()], [400, { error: 'land-tests takes a whole number from 1 to 99' }]);
      }
      const redirect = await post('value=1', false);
      assert.deepEqual([redirect.status, redirect.headers.get('location')], [303, '/_hub/']);
    });
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
      await postGate('pause-at', 'value=95');
      assert.equal(resumed().length, count + 1);
      assert.deepEqual(resumed().at(-1).data, { window: 'five_hour' });
      fs.writeFileSync(stateFile, JSON.stringify({ state: 'going', window: 'five_hour' }));
      await postGate('pause-at', 'value=90');
      assert.equal(resumed().length, count + 1);
      assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).state, 'normal');
    });
    // docs/adr/2026-11-05-1849-pause-board-and-pause-hub-pause-new-work-by-hand.md
    await t.test('Pause hub pauses every board until its end, Resume wakes them, and Pause board shows on its own row', async () => {
      const post = (body, json = true) => fetch(`${base}/_hub/settings/hub-pause`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(json ? { accept: 'application/json' } : {}) }, body, redirect: 'manual',
      });
      const eventsFile = path.join(siteDir, 'data', 'events.jsonl');
      const resumed = () => fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((e) => e.kind === 'usage-resumed');
      const count = resumed().length;
      const paused = await post('pause=3h');
      assert.equal(paused.status, 200);
      const settings = await paused.json();
      assert.match(settings.pause.on.title, /^Paused until /);
      assert.equal(settings.pause.summary, settings.pause.on.title);
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).other_key, 'kept');
      const sidebar = await (await fetch(`${base}/_hub/sidebar.json`)).json();
      assert.deepEqual([sidebar.pause.state, sidebar.pause.manual], ['paused', 'hub']);
      const unchanged = fs.readFileSync(file, 'utf8');
      for (const body of ['pause=31d', '', 'pause=soon']) {
        const r = await post(body);
        assert.equal(r.status, 400);
        assert.ok((await r.json()).error);
        assert.equal(fs.readFileSync(file, 'utf8'), unchanged);
      }
      const forever = await (await post('pause=forever')).json();
      assert.deepEqual([forever.pause.on.title, forever.pause.summary], ['Paused until you resume', 'Paused · forever']);
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).paused_until, 'forever');
      const foreverSidebar = await (await fetch(`${base}/_hub/sidebar.json`)).json();
      assert.deepEqual([foreverSidebar.pause.state, foreverSidebar.pause.resets_at], ['paused', 'forever']);
      const resume = await post('pause=off');
      assert.equal((await resume.json()).pause.on, null);
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).paused_until, undefined);
      assert.deepEqual(resumed().slice(count).map((e) => e.data), [{ window: 'manual' }]);
      assert.deepEqual([(await post('pause=off', false)).headers.get('location')], ['/_hub/#pause']);
      const boardFile = path.join(siteDir, 'board.json');
      const board = JSON.parse(fs.readFileSync(boardFile, 'utf8'));
      fs.writeFileSync(boardFile, JSON.stringify({ ...board, paused_until: new Date(Date.now() + 3600_000).toISOString() }));
      const own = await (await fetch(`${base}/_hub/sidebar.json`)).json();
      assert.notEqual(own.pause.manual, 'board', "the hub's own gate is not the board's");
      assert.deepEqual([own.sites.find((s) => s.route === 'orch').pause.manual], ['board']);
      fs.writeFileSync(boardFile, JSON.stringify(board));
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
  }
});
