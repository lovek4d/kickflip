// The board registry's contract (docs/adr/0040-one-board-registry-for-every-hub-feature.md): one board over the waves and
// one over its own file, each with an open PR, and every hub feature that serves boards must reach both. The registry's
// paths come from HOME, so this file points HOME at a temp dir before importing it, and the hub it starts shares it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFakeDevice } from './fake-device.mjs';

const HUB_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.join(HUB_DIR, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'boards-'));
process.env.HOME = home;
const { listBoards, linksOf, oldestUnheard, hubCode, HUB_CODE } = await import('./boards.mjs');

const claude = (...p) => path.join(home, '.claude', ...p);
const site = (route, ...p) => claude('web-ts', 'sites', route, ...p);
const write = (file, v) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v)); };
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const events = (route, kind) => { try { return fs.readFileSync(site(route, 'data', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.kind === kind); } catch { return []; } };
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
const gh = (over = {}) => ({ state: 'OPEN', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', head: 'abc', failing: [], pending: 0, events: [], ...over });
const sleeper = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'wait-events.mjs'], { stdio: 'ignore' });

const port = 50000 + Math.floor(Math.random() * 900);
const base = `http://127.0.0.1:${port}`;
const boardCmd = (route) => [process.execPath, path.join(SKILL, 'board', 'server.mjs'), site(route)];
const NOW_SINCE = ago(60);

write(claude('waves', 'w1', 'wave.json'), { repo: 'o/r', reviewers: [{ name: 'Bea' }], items: [
  { id: 'A1', pr: 11, gh_since: '2026-10-20T00:00:00Z' }, { id: 'A2', pr: 12, status: 'merged' }, { id: 'A3' }, { id: 'A4', pr: 13, status: 'dropped' },
] });
fs.mkdirSync(claude('waves', 'notes'), { recursive: true });
// Nothing is watched here, so a PR reaches the check only by sitting on a card.
write(claude('waves', 'monitor.json'), { waves: [] });
write(site('orch', 'board.json'), { title: 'Orch', items: 'waves', reviewers: [{ name: 'Ann', slack_user: 'U1', dm: 'D1', github: 'ann' }] });
write(site('shop', 'board.json'), { title: 'Shop', items: 'data/wave.json', slug: 'shop' });
write(site('shop', 'data', 'wave.json'), { repo: 'o/r', items: [{ id: 'S1', pr: 722 }, { id: 'S2', pr: 11 }] });
write(site('bare', 'board.json'), { items: 'data/items.json' });
write(site('bare', 'data', 'items.json'), { items: [{ id: 'B1', pr: 5 }] });
write(claude('web-ts', 'manifest.json'), { version: 1, sites: {
  orch: { dir: site('orch'), port: port + 1, cmd: boardCmd('orch'), watch: ['data/events.jsonl'], owner: { session: 's-orch', since: NOW_SINCE } },
  shop: { dir: site('shop'), port: port + 2, cmd: boardCmd('shop'), watch: ['data/events.jsonl'], owner: { session: 's-shop', since: NOW_SINCE } },
  plain: { dir: site('plain'), port: port + 3, cmd: ['/bin/sleep', '600'] },
} });

test('the registry lists every board site, over the waves or its own file, with the open PRs on its cards and its reviewers', () => {
  const boards = listBoards();
  assert.deepEqual(boards.map((b) => [b.route, b.kind, b.title]), [['orch', 'waves', 'Orch'], ['shop', 'file', 'Shop']]);
  const [orch, shop] = boards;
  assert.deepEqual(orch.waves.map((w) => w.slug), ['w1']);
  assert.deepEqual(orch.prs, [{ wave: 'w1', id: 'A1', pr: 11, repo: 'o/r', since: '2026-10-20T00:00:00Z' }]);
  assert.deepEqual(orch.reviewers, ['Ann']);
  assert.deepEqual(shop.prs.map((p) => [p.wave, p.id, p.pr, p.repo]), [['shop', 'S1', 722, 'o/r'], ['shop', 'S2', 11, 'o/r']]);
  assert.deepEqual(shop.reviewers, []);
  // A file board without a slug keys its cards by the file's name, as the board itself does (board/store.mjs itemSources).
  const bare = listBoards({ sites: { bare: { dir: site('bare'), port: 1, cmd: boardCmd('bare') } } });
  assert.deepEqual(bare.map((b) => [b.title, b.prs[0].wave, b.prs[0].repo]), [['bare', 'items', 'acme/app']]);
  assert.deepEqual(listBoards({}), []);
});

test('linksOf names each hub link that reaches a board and each that does not', () => {
  const orch = listBoards().find((b) => b.route === 'orch');
  const github = { lastCheck: { at: 'T', boards: ['orch'] }, prs: { 'o/r#11': { at: 'T', state: 'OPEN', isDraft: false } } };
  const ok = { github, settings: { wakes: ['08:00'] }, wakes: {}, devices: 2, listening: true, topics: { 'w1/A1': { review_link_ts: { Ann: '1.1', Bea: '1.2' } } }, code: { running: 'h1', onDisk: 'h1' }, faults: {} };
  const state = (ctx) => Object.fromEntries(linksOf(orch, ctx).map((l) => [l.link, l.ok]));
  assert.deepEqual(linksOf(orch, ok).map((l) => l.link), ['github', 'events', 'wakes', 'push', 'slack', 'hub']);
  assert.deepEqual(state(ok), { github: true, events: true, wakes: true, push: true, slack: true, hub: true });
  const broken = (ctx) => Object.entries(state({ ...ok, ...ctx })).filter(([, v]) => !v).map(([k]) => k);
  assert.deepEqual(broken({ github: {} }), ['github']);
  assert.deepEqual(broken({ github: { ...github, prs: { 'o/r#11': { ...github.prs['o/r#11'], at: 'older' } } } }), ['github']);
  assert.deepEqual(broken({ github: { ...github, lastCheck: { at: 'T', boards: [] } } }), ['github']);
  assert.deepEqual(broken({ listening: false }), ['events']);
  assert.deepEqual(broken({ settings: { wakes: [] } }), ['wakes']);
  assert.deepEqual(broken({ wakes: { last: { due: ['08:00'], failed: ['orch'] } } }), ['wakes']);
  assert.deepEqual(broken({ devices: 0 }), ['push']);
  assert.deepEqual(broken({ code: { running: 'h0', onDisk: 'h1' } }), ['hub']);
  assert.deepEqual(broken({ code: { running: undefined, onDisk: 'h1' } }), ['hub']);
  assert.equal(linksOf(orch, { ...ok, code: { running: 'h0', onDisk: 'h1' } })[5].detail,
    'The hub runs older code than its files; restart it with launchctl kickstart -k gui/$(id -u)/local.claude.web-ts-hub');
  const slack = linksOf(orch, { ...ok, topics: { 'w1/A1': { review_link_ts: { Ann: '1.1' } } } })[4];
  assert.deepEqual([slack.ok, slack.detail], [false, '#11 has no link for Bea.']);
  // A draft isn't in review yet, so it needs no links.
  assert.equal(linksOf(orch, { ...ok, topics: {}, github: { ...github, prs: { 'o/r#11': { at: 'T', state: 'OPEN', isDraft: true } } } })[4].ok, true);
});

test('a broken link reads settling until it has stayed broken past its grace period, then broken', () => {
  const orch = listBoards().find((b) => b.route === 'orch');
  const settings = { windows: [{ from: '08:00', every_minutes: 15 }, { from: '22:00', every_minutes: 60 }], wakes: ['08:00'] };
  const now = new Date(2026, 9, 29, 12, 0).getTime();
  const ago = (min) => new Date(now - min * 60_000).toISOString();
  const faulty = { github: {}, settings, wakes: {}, devices: 0, listening: false, topics: {}, code: { running: 'h0', onDisk: 'h1' }, now };
  const states = (faults, at = now) => Object.fromEntries(linksOf(orch, { ...faulty, faults, now: at }).filter((l) => !l.ok).map((l) => [l.link, l.state]));
  assert.deepEqual(states({}), { github: 'settling', events: 'settling', push: 'broken', hub: 'settling' });
  assert.deepEqual(states({ github: ago(24), events: ago(1.9), hub: ago(4.9) }), { github: 'settling', events: 'settling', push: 'broken', hub: 'settling' });
  assert.deepEqual(states({ github: ago(26), events: ago(2.1), hub: ago(5.1) }), { github: 'broken', events: 'broken', push: 'broken', hub: 'broken' });
  assert.equal(linksOf(orch, { ...faulty, faults: { github: ago(26) } })[0].since, ago(26));
  // A fault from the hourly window keeps its hour once the 15-minute window starts, until a check could have fixed it.
  const eight = new Date(2026, 9, 29, 8, 5).getTime();
  assert.equal(states({ github: new Date(eight - 35 * 60_000).toISOString() }, eight).github, 'settling');
  assert.equal(states({ github: new Date(eight - 71 * 60_000).toISOString() }, eight).github, 'broken');
});

test('the hub code hash covers hub.mjs and what it imports through the skill, and nothing else', () => {
  const root = fs.mkdtempSync(path.join(home, 'code-'));
  write(path.join(root, 'hub', 'hub.mjs'), "import fs from 'node:fs';\nimport { a } from './a.mjs';\n");
  write(path.join(root, 'hub', 'a.mjs'), "export { b as a } from '../shared/b.mjs';\n");
  write(path.join(root, 'shared', 'b.mjs'), 'export const b = 1;\n');
  write(path.join(root, 'hub', 'unused.mjs'), 'export const c = 1;\n');
  const first = hubCode(path.join(root, 'hub', 'hub.mjs'));
  assert.deepEqual(first.files, ['hub/a.mjs', 'hub/hub.mjs', 'shared/b.mjs']);
  write(path.join(root, 'hub', 'unused.mjs'), 'export const c = 2;\n');
  assert.equal(hubCode(path.join(root, 'hub', 'hub.mjs')).hash, first.hash);
  write(path.join(root, 'shared', 'b.mjs'), 'export const b = 2;\n');
  assert.notEqual(hubCode(path.join(root, 'hub', 'hub.mjs')).hash, first.hash);
  assert.ok(['hub/boards.mjs', 'hub/github.mjs', 'hub/push.mjs', 'hub/schedule.mjs'].every((f) => hubCode().files.includes(f)));
});

test("oldestUnheard finds the oldest line past the owner's watcher cursor, or past when the session took the site without one", () => {
  const dir = fs.mkdtempSync(path.join(home, 'unheard-'));
  const board = { dir, owner: { session: 's1', since: '2026-10-24T10:00:00Z' }, watch: ['data/events.jsonl'], filter: null };
  const line = (id, ts, kind = 'ask') => JSON.stringify({ id, ts, kind });
  write(path.join(dir, 'data', 'events.jsonl'), [line('a', '2026-10-24T09:00:00Z'), line('b', '2026-10-24T11:00:00Z'), line('c', '2026-10-24T12:00:00Z', 'rules')].join('\n') + '\n');
  assert.equal(oldestUnheard(board), '2026-10-24T11:00:00Z');
  write(path.join(dir, 'data', '.watch-cursor-s1.json'), { 'data/events.jsonl': 2 });
  assert.equal(oldestUnheard(board), '2026-10-24T12:00:00Z');
  assert.equal(oldestUnheard({ ...board, filter: '"kind":"ask"' }), null);
  write(path.join(dir, 'data', '.watch-cursor-s1.json'), { 'data/events.jsonl': 3 });
  assert.equal(oldestUnheard(board), null);
  assert.equal(oldestUnheard({ ...board, owner: null }), null);
});

// ---------- one hub over both boards ----------
let hub, device, orchWatcher;
const poll = async () => (await fetch(`${base}/_hub/poll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
const api = async (route) => (await fetch(`${base}/${route}/api/board`)).json();
const linkState = (links) => Object.fromEntries(links.map((l) => [l.link, l.ok]));
const pushes = () => device.received.map(({ title, url, tag }) => ({ title, url, tag }));
// Not spawnSync: the fake device answers pushes from this process, so it must keep running meanwhile.
const cli = (script, args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, HOME: home, WEB_TS_HUB_PORT: String(port) } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});

before(async () => {
  device = await startFakeDevice();
  write(claude('web-ts', 'push', 'subs.json'), [device.subscription]);
  write(claude('web-ts', 'settings.json'), { polling: { windows: [{ from: '00:00', every_minutes: 120 }], hold_overnight: false, wakes: ['00:00'] }, notifications: { on: true, weekends_off: false } });
  // monitor-gh.sh answers from gh/<pr>.json and logs each call; the board servers' own gh always fails fast.
  write(claude('skills', 'monitor', 'monitor-gh.sh'), 'echo "$1" >> "$HOME/gh/calls"\ncat "$HOME/gh/$1.json"\n');
  write(path.join(home, 'gh', '11.json'), gh());
  write(path.join(home, 'gh', '722.json'), gh());
  write(path.join(home, 'bin', 'gh'), '#!/bin/sh\nexit 1\n');
  fs.chmodSync(path.join(home, 'bin', 'gh'), 0o755);
  // Both boards hold an event that has waited half an hour; only orch has a watcher running.
  for (const route of ['orch', 'shop']) write(site(route, 'data', 'events.jsonl'), JSON.stringify({ id: `e-${route}`, ts: ago(30), kind: 'ask', data: {} }) + '\n');
  write(site('shop', 'data', '.watch-cursor-s-shop.json'), { 'data/events.jsonl': 0 });
  orchWatcher = sleeper();
  write(site('orch', 'data', 'watcher.json'), { pid: orchWatcher.pid, since: ago(1) });

  hub = spawn(process.execPath, [path.join(HUB_DIR, 'hub.mjs')], { env: { ...process.env, HOME: home, WEB_TS_HUB_PORT: String(port), PATH: `${path.join(home, 'bin')}:${process.env.PATH}` } });
  await new Promise((resolve, reject) => {
    let out = '';
    hub.stdout.on('data', (d) => { out += d; if (out.includes('hub on')) resolve(); });
    hub.once('exit', reject);
  });
  for (const route of ['orch', 'shop']) {
    for (let i = 0; i < 80 && !(await fetch(`${base}/${route}/_claude/health`).then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 100));
  }
});

after(async () => {
  orchWatcher?.kill();
  if (hub) {
    const exited = new Promise((resolve) => hub.once('exit', resolve));
    hub.kill('SIGTERM');
    await exited;
  }
  await device?.close();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(home, { recursive: true, force: true });
});

test('one check polls each open PR on either board once, writes both checked.json, and pushes once for the board not listening', async () => {
  const r = await poll();
  assert.deepEqual([r.watched, r.failed, r.changes], [2, [], []]);
  assert.deepEqual([...r.checked].sort(), ['orch', 'shop']);
  assert.deepEqual(fs.readFileSync(path.join(home, 'gh', 'calls'), 'utf8').trim().split('\n').sort(), ['11', '722']);
  const state = read(claude('web-ts', 'github-state.json'));
  assert.deepEqual([state.prs['o/r#11'].at, state.prs['o/r#722'].at], [r.at, r.at]);
  assert.deepEqual([...state.lastCheck.boards].sort(), ['orch', 'shop']);
  for (const route of ['orch', 'shop']) assert.equal(read(site(route, 'data', 'checked.json')).every, 120);
  assert.deepEqual(r.deaf.pushed, ['shop']);
  assert.deepEqual(pushes(), [{ title: "Shop isn't listening", url: '/shop/', tag: 'deaf-shop' }]);
});

test("a GitHub change goes to every board showing that PR, each event naming that board's own cards", async () => {
  write(path.join(home, 'gh', '11.json'), gh({ reviewDecision: 'APPROVED' }));
  write(path.join(home, 'gh', '722.json'), gh({ failing: ['build'] }));
  const r = await poll();
  assert.deepEqual(r.changes.map((c) => [c.pr, c.changes]).sort(), [[11, ['review']], [722, ['ci']]]);
  assert.deepEqual(events('orch', 'github-change').map((e) => e.data.prs), [[{ wave: 'w1', id: 'A1', pr: 11, changes: ['review'] }]]);
  assert.deepEqual(events('shop', 'github-change').map((e) => e.data.prs), [[
    { wave: 'shop', id: 'S1', pr: 722, changes: ['ci'] }, { wave: 'shop', id: 'S2', pr: 11, changes: ['review'] },
  ]]);
  assert.deepEqual(r.deaf.pushed, [], 'one push per outage');
  assert.equal(device.received.length, 1);
});

test('a hub rules save reaches both boards', async () => {
  const r = await (await fetch(`${base}/_hub/settings/rules`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rules: [{ text: 'Be brief' }], base: [] }) })).json();
  assert.deepEqual(r.events.map((e) => e.route).sort(), ['orch', 'shop']);
  for (const route of ['orch', 'shop']) assert.deepEqual(events(route, 'rules').map((e) => e.data.added), [['Be brief']]);
});

test("each board serves its hub links, and the slack link passes once every reviewer has the PR's link", async () => {
  const orch = await api('orch');
  assert.deepEqual(linkState(orch.links), { github: true, events: true, wakes: true, push: true, slack: false, hub: true });
  assert.equal(orch.links[4].state, 'settling');
  assert.match(orch.links[4].detail, /#11 has no link for Ann, Bea/);
  assert.equal(orch.setup, null);
  const shop = await api('shop');
  assert.deepEqual(linkState(shop.links), { github: true, events: false, wakes: true, push: true, slack: true, hub: true });
  const wave = read(claude('waves', 'w1', 'wave.json'));
  write(claude('waves', 'w1', 'wave.json'), { ...wave, review_link_ts: { 11: { Ann: '1.1', Bea: '1.2' } } });
  assert.equal(linkState((await (await fetch(`${base}/orch/api/links`)).json()).links).slack, true);
});

test('the hub link breaks while the hub runs older code than its files', async () => {
  const running = read(HUB_CODE);
  assert.equal(running.hash, hubCode().hash);
  write(HUB_CODE, { ...running, hash: 'older' });
  try {
    const hub = (await (await fetch(`${base}/orch/api/links`)).json()).links.find((l) => l.link === 'hub');
    assert.deepEqual([hub.ok, hub.state], [false, 'settling']);
  } finally { write(HUB_CODE, running); }
});

test("the daily wake reaches both boards", async () => {
  for (let i = 0; i < 100 && !(events('orch', 'check-github').length && events('shop', 'check-github').length); i++) await new Promise((r) => setTimeout(r, 200));
  for (const route of ['orch', 'shop']) assert.deepEqual(events(route, 'check-github').map((e) => e.data), [{ reason: 'morning' }]);
  assert.deepEqual([...read(claude('web-ts', 'wake-state.json')).last.routes].sort(), ['orch', 'shop']);
});

test('a running watcher ends the outage, and the next one pushes again', async () => {
  const w = sleeper();
  write(site('shop', 'data', 'watcher.json'), { pid: w.pid, since: ago(0) });
  try { assert.deepEqual((await poll()).deaf.pushed, []); } finally { w.kill(); }
  assert.deepEqual(read(claude('web-ts', 'deaf-state.json')), {});
  write(site('shop', 'data', 'watcher.json'), { pid: w.pid, since: ago(20), exited_at: ago(10) });
  assert.deepEqual((await poll()).deaf.pushed, ['shop']);
  assert.equal(device.received.filter((p) => p.tag === 'deaf-shop').length, 2);
});

test('the handshake says hello and sends a test push; the board shows its checklist until the session acks the hello', async () => {
  const r = await cli(path.join(SKILL, 'bin', 'web-ts.mjs'), ['handshake', 'shop']);
  assert.equal(r.status, 0, r.stderr);
  const { hello, push } = JSON.parse(r.stdout);
  assert.equal(push, 'sent');
  assert.deepEqual(events('shop', 'hello').map((e) => [e.id, e.data.title]), [[hello, 'Shop']]);
  assert.deepEqual(pushes().at(-1), { title: 'Shop board connected', url: '/shop/', tag: 'hello-shop' });
  assert.deepEqual((await api('shop')).setup, { events: false, github: true, push: 'sent' });
  const board = (...a) => cli(path.join(SKILL, 'board', 'bin', 'board.mjs'), a);
  assert.match((await board('--site', 'shop', 'hello-ack', 'e-shop')).stderr, /no hello event "e-shop"/);
  assert.equal((await board('--site', 'shop', 'hello-ack', hello)).status, 0);
  assert.equal((await api('shop')).setup, null);
  assert.ok(read(site('shop', 'data', 'handshake.json')).done_at);
  assert.equal((await cli(path.join(SKILL, 'bin', 'web-ts.mjs'), ['handshake', 'plain'])).status, 2);
});

test("joining a board polls at once, so the new board's GitHub link passes without waiting for the next slot", async () => {
  const r = await cli(path.join(SKILL, 'bin', 'web-ts.mjs'), ['join', 'fresh', '--session', 's-fresh', '--template', 'board', '--title', 'Fresh']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).poll, 'reached this board');
  assert.ok(read(claude('web-ts', 'github-state.json')).lastCheck.boards.includes('fresh'));
});
