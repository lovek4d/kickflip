import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
    const file = path.join(home, '.claude', 'web-ts', 'settings.json');
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

test("hub Settings edits the hub rules, and a save that changes them sends every board a rules event", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-rules-'));
  const port = 49000 + Math.floor(Math.random() * 900);
  const sitePort = port + 1000;
  const siteDir = path.join(home, '.claude', 'web-ts', 'sites', 'orch');
  const web = path.join(home, '.claude', 'web-ts');
  fs.mkdirSync(path.join(siteDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(siteDir, 'board.json'), JSON.stringify({ title: 'Orch', items: 'waves' }));
  fs.writeFileSync(path.join(web, 'settings.json'), JSON.stringify({ polling: { windows: [{ from: '00:00', every_minutes: 120 }], hold_overnight: false, wakes: [] }, other_key: 'kept' }));
  fs.writeFileSync(path.join(web, 'manifest.json'), JSON.stringify({ version: 1, sites: {
    orch: { dir: siteDir, port: sitePort, cmd: [process.execPath, path.join(HUB_DIR, '..', 'board', 'server.mjs'), siteDir] },
  } }));
  const hub = spawn(process.execPath, [path.join(HUB_DIR, 'hub.mjs')], { env: { ...process.env, HOME: home, WEB_TS_HUB_PORT: String(port) } });
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
  } finally {
    const exited = new Promise((resolve) => hub.once('exit', resolve));
    hub.kill('SIGTERM');
    await exited;
    await new Promise((r) => setTimeout(r, 200));
    fs.rmSync(home, { recursive: true, force: true });
  }
});
