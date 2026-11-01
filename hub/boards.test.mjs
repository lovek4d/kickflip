import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { reposDir } from '../shared/repos.mjs';
import { startFakeDevice } from './fake-device.mjs';
import { freePorts } from '../shared/test-helpers.mjs';

const HUB_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.join(HUB_DIR, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'boards-'));
process.env.HOME = home;
const { listBoards, linksOf, hubLink, oldestUnheard, hubCode, HUB_CODE, listenState, checkListening, RESUME_STATE } = await import('./boards.mjs');

const claude = (...p) => path.join(home, '.claude', ...p);
const site = (route, ...p) => claude('web-ts', 'sites', route, ...p);
const write = (file, v) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v)); };
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const events = (route, kind) => { try { return fs.readFileSync(site(route, 'data', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.kind === kind); } catch { return []; } };
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
const gh = (over = {}) => ({ state: 'OPEN', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', head: 'abc', failing: [], pending: 0, events: [], ...over });
const sleeper = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'wait-events.mjs'], { stdio: 'ignore' });
const liveSession = (sessionId) => {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const procStart = execFileSync('ps', ['-o', 'lstart=', '-p', String(c.pid)], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } }).trim();
  write(claude('sessions', `${c.pid}.json`), { pid: c.pid, sessionId, cwd: home, procStart, kind: 'bg' });
  return c;
};

const [port, orchPort, shopPort, plainPort, stubbornPort, latePort, napPort, hubPort, hubBoardPort, devPort, closePort] = await freePorts(11);
process.env.WEB_TS_HUB_PORT = String(port);
const base = `http://127.0.0.1:${port}`;
const boardCmd = (route) => [process.execPath, path.join(SKILL, 'board', 'server.mjs'), site(route)];
const NOW_SINCE = ago(60);

write(claude('waves', 'w1', 'wave.json'), { repo: 'o/r', reviewers: [{ name: 'Bea' }], items: [
  { id: 'A1', pr: 11, gh_since: '2026-10-20T00:00:00Z' }, { id: 'A2', pr: 12, status: 'merged' }, { id: 'A3' }, { id: 'A4', pr: 13, status: 'dropped' },
] });
fs.mkdirSync(claude('waves', 'notes'), { recursive: true });
write(claude('waves', 'monitor.json'), { waves: [] });
write(site('orch', 'board.json'), { title: 'Orch', items: 'waves', reviewers: [{ name: 'Ann', slack_user: 'U1', dm: 'D1', github: 'ann' }] });
write(site('shop', 'board.json'), { title: 'Shop', items: 'data/wave.json', slug: 'shop' });
write(site('shop', 'data', 'wave.json'), { repo: 'o/r', items: [{ id: 'S1', pr: 722 }, { id: 'S2', pr: 11 }] });
write(site('bare', 'board.json'), { items: 'data/items.json' });
write(site('bare', 'data', 'items.json'), { items: [{ id: 'B1', pr: 5 }] });
write(claude('web-ts', 'manifest.json'), { version: 1, sites: {
  orch: { dir: site('orch'), port: orchPort, cmd: boardCmd('orch'), watch: ['data/events.jsonl'], owner: { session: 's-orch', since: NOW_SINCE } },
  shop: { dir: site('shop'), port: shopPort, cmd: boardCmd('shop'), watch: ['data/events.jsonl'], owner: { session: 's-shop', since: NOW_SINCE } },
  plain: { dir: site('plain'), port: plainPort, cmd: ['/bin/sleep', '600'] },
} });

test('the registry lists every board site, over the waves or its own file, with the open PRs on its cards and its reviewers', () => {
  const boards = listBoards();
  assert.deepEqual(boards.map((b) => [b.route, b.kind, b.title]), [['orch', 'waves', 'Orch'], ['shop', 'file', 'Shop']]);
  const [orch, shop] = boards;
  assert.deepEqual(orch.waves.map((w) => w.slug), ['w1']);
  assert.deepEqual(orch.prs, [{ wave: 'w1', id: 'A1', pr: 11, repo: 'o/r', since: '2026-10-20T00:00:00Z', install: false }]);
  assert.deepEqual(orch.reviewers, ['Ann']);
  assert.deepEqual(shop.prs.map((p) => [p.wave, p.id, p.pr, p.repo]), [['shop', 'S1', 722, 'o/r'], ['shop', 'S2', 11, 'o/r']]);
  assert.deepEqual(shop.reviewers, []);
  const bare = listBoards({ sites: { bare: { dir: site('bare'), port: 1, cmd: boardCmd('bare') } } });
  assert.deepEqual(bare.map((b) => [b.title, b.waves.map((w) => w.slug), b.prs]), [['bare', ['items'], []]]);
  assert.deepEqual(listBoards({}), []);
});

test('linksOf names each hub link that reaches a board and each that does not', () => {
  const orch = listBoards().find((b) => b.route === 'orch');
  const github = { lastCheck: { at: 'T', boards: ['orch'] }, prs: { 'o/r#11': { at: 'T', state: 'OPEN', isDraft: false } } };
  const ok = { github, settings: { wakes: ['08:00'] }, wakes: {}, devices: 2, listen: 'listening', topics: { 'w1/A1': { review_link_ts: { Ann: '1.1', Bea: '1.2' } } }, faults: {} };
  const state = (ctx) => Object.fromEntries(linksOf(orch, ctx).map((l) => [l.link, l.ok]));
  assert.deepEqual(linksOf(orch, ok).map((l) => l.link), ['github', 'events', 'wakes', 'push', 'slack']);
  assert.deepEqual(state(ok), { github: true, events: true, wakes: true, push: true, slack: true });
  const broken = (ctx) => Object.entries(state({ ...ok, ...ctx })).filter(([, v]) => !v).map(([k]) => k);
  assert.deepEqual(broken({ github: {} }), ['github']);
  assert.deepEqual(broken({ github: { ...github, prs: { 'o/r#11': { ...github.prs['o/r#11'], at: 'older' } } } }), ['github']);
  assert.deepEqual(broken({ github: { ...github, lastCheck: { at: 'T', boards: [] } } }), ['github']);
  assert.deepEqual(broken({ listen: 'deaf' }), ['events']);
  assert.deepEqual(broken({ listen: 'asleep' }), []);
  assert.deepEqual(broken({ settings: { wakes: [] } }), ['wakes']);
  assert.deepEqual(broken({ wakes: { last: { due: ['08:00'], failed: ['orch'] } } }), ['wakes']);
  assert.deepEqual(broken({ devices: 0 }), ['push']);
  assert.equal(hubLink({ running: 'h1', onDisk: 'h1' }).ok, true);
  assert.equal(hubLink({ running: undefined, onDisk: 'h1' }).ok, false);
  assert.deepEqual(hubLink({ running: 'h0', onDisk: 'h1' }), { link: 'hub', ok: false,
    detail: 'The hub runs older code than its files; restart it with launchctl kickstart -k gui/$(id -u)/local.claude.web-ts-hub' });
  const slack = linksOf(orch, { ...ok, topics: { 'w1/A1': { review_link_ts: { Ann: '1.1' } } } })[4];
  assert.deepEqual([slack.ok, slack.detail], [false, '#11 has no link for Bea.']);
  assert.equal(linksOf(orch, { ...ok, topics: {}, github: { ...github, prs: { 'o/r#11': { at: 'T', state: 'OPEN', isDraft: true } } } })[4].ok, true);
});

test('a broken link reads settling until it has stayed broken past its grace period, then broken', () => {
  const orch = listBoards().find((b) => b.route === 'orch');
  const settings = { windows: [{ from: '08:00', every_minutes: 15 }, { from: '22:00', every_minutes: 60 }], wakes: ['08:00'] };
  const now = new Date(2026, 9, 29, 12, 0).getTime();
  const ago = (min) => new Date(now - min * 60_000).toISOString();
  const faulty = { github: {}, settings, wakes: {}, devices: 0, listen: 'deaf', topics: {}, now };
  const states = (faults, at = now) => Object.fromEntries(linksOf(orch, { ...faulty, faults, now: at }).filter((l) => !l.ok).map((l) => [l.link, l.state]));
  assert.deepEqual(states({}), { github: 'settling', events: 'settling', push: 'broken' });
  assert.deepEqual(states({ github: ago(24), events: ago(1.9) }), { github: 'settling', events: 'settling', push: 'broken' });
  assert.deepEqual(states({ github: ago(26), events: ago(2.1) }), { github: 'broken', events: 'broken', push: 'broken' });
  assert.equal(linksOf(orch, { ...faulty, faults: { github: ago(26) } })[0].since, ago(26));
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

let hub, device, orchWatcher, orchSession;
const poll = async () => (await fetch(`${base}/_hub/poll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
const api = async (route) => (await fetch(`${base}/${route}/api/board`)).json();
const linkState = (links) => Object.fromEntries(links.map((l) => [l.link, l.ok]));
const pushes = () => device.received.map(({ title, url, tag }) => ({ title, url, tag }));
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
  write(claude('skills', 'monitor', 'monitor-gh.sh'), 'echo "$1" >> "$HOME/gh/calls"\ncat "$HOME/gh/$1.json"\n');
  write(path.join(home, 'gh', '11.json'), gh());
  write(path.join(home, 'gh', '722.json'), gh());
  write(path.join(home, 'bin', 'gh'), '#!/bin/sh\nexit 1\n');
  write(path.join(home, 'bin', 'git'), '#!/bin/sh\nexit 1\n');
  fs.chmodSync(path.join(home, 'bin', 'gh'), 0o755);
  fs.chmodSync(path.join(home, 'bin', 'git'), 0o755);
  for (const route of ['orch', 'shop']) write(site(route, 'data', 'events.jsonl'), JSON.stringify({ id: `e-${route}`, ts: ago(30), kind: 'ask', data: {} }) + '\n');
  write(site('shop', 'data', '.watch-cursor-s-shop.json'), { 'data/events.jsonl': 0 });
  orchWatcher = sleeper();
  orchSession = liveSession('s-orch');
  write(site('orch', 'data', 'watcher.json'), { pid: orchWatcher.pid, since: ago(1) });

  hub = spawn(process.execPath, [path.join(HUB_DIR, 'hub.mjs')], { env: { ...process.env, HOME: home, WEB_TS_HUB_PORT: String(port), WEB_TS_CLAUDE: '/usr/bin/false', PATH: `${path.join(home, 'bin')}:${process.env.PATH}` } });
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
  orchSession?.kill();
  if (hub && hub.exitCode === null && hub.signalCode === null) {
    const exited = new Promise((resolve) => hub.once('exit', resolve));
    hub.kill('SIGTERM');
    await exited;
  }
  await device?.close();
  await new Promise((r) => setTimeout(r, 200));
  fs.rmSync(home, { recursive: true, force: true });
});

test('hub writes refuse cross-site requests before handling forms, JSON or deletes', async () => {
  const settings = claude('web-ts', 'settings.json');
  const before = fs.readFileSync(settings, 'utf8');
  for (const headers of [
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
    { origin: 'https://other.example' },
    { origin: 'null' },
    { origin: 'invalid' },
    { 'sec-fetch-site': 'same-origin', origin: 'https://other.example' },
  ]) {
    const r = await fetch(`${base}/_hub/settings/codex`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: 'value=auto',
    });
    assert.equal(r.status, 403, JSON.stringify(headers));
    assert.match(r.headers.get('content-type'), /^text\/plain/);
    assert.equal(fs.readFileSync(settings, 'utf8'), before);
  }
  for (const p of ['/_hub/settings/rules', '/_hub/prompts', '/_hub/prompts/missing/answer', '/_hub/poll', '/_hub/push/subscribe']) {
    for (const headers of [{ 'content-type': 'text/plain' }, { 'content-type': 'application/json', origin: 'https://other.example' }]) {
      const r = await fetch(base + p, { method: 'POST', headers, body: '{' });
      assert.equal(r.status, 403, p);
      assert.match(r.headers.get('content-type'), /^text\/plain/);
    }
  }
  for (const method of ['DELETE', 'PUT', 'PATCH', 'OPTIONS']) {
    assert.equal((await fetch(`${base}/_hub/new-board/missing`, { method, headers: { origin: 'https://other.example' } })).status, 403, method);
  }
  for (const headers of [{ 'sec-fetch-site': 'cross-site' }, { origin: 'https://other.example' }]) {
    assert.equal((await fetch(`${base}/_hub/push/test`, { method: 'POST', headers })).status, 403);
    assert.equal((await fetch(`${base}/_hub/push/flush`, { method: 'POST', headers })).status, 403);
    assert.equal((await fetch(`${base}/_hub/api/settings`, { method: 'HEAD', headers })).status, 200);
    assert.equal((await fetch(`${base}/_hub/api/settings`, { headers })).status, 200);
  }
  assert.equal(fs.readFileSync(settings, 'utf8'), before);
});

test('closing a board through the hub requires JSON, same-origin access and its exact name, retains its folder and stops its server after answering', async () => {
  const file = claude('web-ts', 'manifest.json');
  const original = read(file);
  const route = 'close-me';
  const dir = site(route);
  write(site(route, 'board.json'), { title: 'Close Me', items: 'data/items.json', slug: route });
  write(site(route, 'data', 'items.json'), { repo: 'o/r', items: [{ id: 'C1', pr: 99 }] });
  write(site(route, 'data', 'agents', 'C1.json'), { label: 'Builder', started: new Date().toISOString() });
  const entry = { dir, port: closePort, cmd: boardCmd(route), owner: { session: 's-close', repo: home } };
  write(file, { ...original, sites: { ...original.sites, [route]: entry } });
  const headers = { 'content-type': 'application/json', origin: base, 'sec-fetch-site': 'same-origin' };
  const post = (path, body, h = headers) => fetch(base + path, { method: 'POST', headers: h, body: JSON.stringify(body) });
  try {
    for (let i = 0; i < 80; i++) {
      if ((await fetch(`${base}/${route}/_claude/health`)).ok) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const pid = Number(fs.readFileSync(claude('web-ts', 'run', `${route}.pid`), 'utf8'));
    const body = { route, name: 'Close Me' };
    const before = read(file);
    for (const h of [{ ...headers, origin: 'https://other.example' }, { ...headers, 'sec-fetch-site': 'cross-site' }, { 'content-type': 'text/plain' }]) {
      assert.equal((await post('/_hub/close-board', body, h)).status, 403);
      assert.equal((await post('/_hub/reopen-board', { route }, h)).status, 403);
      assert.deepEqual(read(file), before);
    }
    assert.equal((await post('/_hub/close-board', { route, name: 'close me' })).status, 400);
    const flagged = read(file);
    flagged.sites[route].hub = true;
    write(file, flagged);
    assert.equal((await post('/_hub/close-board', body)).status, 409);
    write(file, before);
    const preview = await (await fetch(`${base}/_hub/close-board/${route}`)).json();
    assert.deepEqual([preview.title, preview.prs[0].pr, preview.builders.length], ['Close Me', 99, 1]);
    const response = await post('/_hub/close-board', body);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { route, filesKept: dir, buildersClosed: 1, next: '/_hub/' });
    assert.equal(read(file).sites[route], undefined);
    assert.deepEqual(read(file).closed[route].site, entry);
    const settings = await (await fetch(`${base}/_hub/api/settings`)).json();
    assert.equal(settings.closed.find((b) => b.route === route).title, 'Close Me');
    const sidebar = await (await fetch(`${base}/_hub/sidebar.json`)).json();
    assert.equal(sidebar.sites.some((b) => b.route === route), false);
    for (let i = 0; i < 80 && fs.existsSync(claude('web-ts', 'run', `${route}.pid`)); i++) await new Promise((r) => setTimeout(r, 100));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.ok(fs.existsSync(site(route, 'data', 'items.json')));
    const reopened = await post('/_hub/reopen-board', { route });
    assert.equal(reopened.status, 400);
    assert.match((await reopened.json()).error, /claude --resume failed/);
    assert.equal(read(file).sites[route], undefined);
    assert.deepEqual(read(file).closed[route].site, entry);
  } finally { write(file, original); }
});

test('the proxy preserves browser origin, fetch metadata and the external host for board writes', async () => {
  const post = (headers) => new Promise((resolve, reject) => {
    const req = http.request(`${base}/orch/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ kind: 'proxy-guard' }));
  });
  const host = 'mac.example.ts.net';
  for (const headers of [
    { host, origin: `https://${host}` },
    { 'x-forwarded-host': host, origin: `https://${host}` },
    { host, origin: `https://${host}`, 'sec-fetch-site': 'same-origin' },
    {},
  ]) assert.equal((await post(headers)).status, 200, JSON.stringify(headers));
  const before = events('orch', 'proxy-guard').length;
  for (const headers of [
    { host, origin: 'https://other.example' },
    { 'x-forwarded-host': host, origin: base },
    { host, origin: `https://${host}`, 'sec-fetch-site': 'same-site' },
  ]) assert.equal((await post(headers)).status, 403, JSON.stringify(headers));
  assert.equal(events('orch', 'proxy-guard').length, before);
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

test("a GitHub change goes to every board showing that PR, and a head move only to cards with an install", async () => {
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

  write(site('shop', 'data', 'wave.json'), { repo: 'o/r', items: [{ id: 'S1', pr: 722 }, { id: 'S2', pr: 11, install: { url: 'itms-services://x', sha: 'ABC' } }] });
  write(path.join(home, 'gh', '11.json'), gh({ reviewDecision: 'APPROVED', head: 'def', pending: 2 }));
  write(path.join(home, 'gh', '722.json'), gh({ failing: ['build'], head: 'fed', pending: 2 }));
  const pushed = await poll();
  assert.deepEqual(pushed.changes.map((c) => [c.pr, c.changes]), [[11, ['head']]]);
  assert.equal(events('orch', 'github-change').length, 1);
  assert.deepEqual(events('shop', 'github-change').at(-1).data.prs, [{ wave: 'shop', id: 'S2', pr: 11, changes: ['head'] }]);
  assert.equal(read(claude('web-ts', 'github-state.json')).prs['o/r#722'].head, 'fed');
  assert.deepEqual((await poll()).changes, [], 'a quiet poll does not repeat the head event');

  write(site('shop', 'data', 'wave.json'), { repo: 'o/r', items: [{ id: 'S1', pr: 722 },
    { id: 'S2', pr: 11, install: { url: 'itms-services://x', sha: 'new' } }, { id: 'S3', pr: 11 },
    { id: 'S4', pr: 11, install: { url: 'https://m/app.apk' } },
  ] });
  write(path.join(home, 'gh', '11.json'), gh({ reviewDecision: 'APPROVED', head: 'new', pending: 2 }));
  await poll();
  assert.deepEqual(events('shop', 'github-change').at(-1).data.prs, [
    { wave: 'shop', id: 'S2', pr: 11, changes: ['head'] },
    { wave: 'shop', id: 'S4', pr: 11, changes: ['head'] },
  ]);
});

test('a hub rules save reaches both boards', async () => {
  const r = await (await fetch(`${base}/_hub/settings/rules`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rules: [{ text: 'Be brief' }], base: [] }) })).json();
  assert.deepEqual(r.events.map((e) => e.route).sort(), ['orch', 'shop']);
  for (const route of ['orch', 'shop']) assert.deepEqual(events(route, 'rules').map((e) => e.data.added), [['Be brief']]);
});

test("each board serves its hub links, and the slack link passes once every reviewer has the PR's link", async () => {
  const orch = await api('orch');
  assert.deepEqual(linkState(orch.links), { github: true, events: true, wakes: true, push: true, slack: false });
  assert.equal(orch.links[4].state, 'settling');
  assert.match(orch.links[4].detail, /#11 has no link for Ann, Bea/);
  assert.equal(orch.setup, null);
  const shop = await api('shop');
  assert.deepEqual(linkState(shop.links), { github: true, events: false, wakes: true, push: true, slack: true });
  const sub = Object.fromEntries((await (await fetch(`${base}/_hub/sidebar.json`)).json()).sites.map((x) => [x.route, x.sub]));
  assert.match(sub.shop, /^<span class="dot t-down" aria-hidden="true"><\/span><span class="word t-down">Not listening<\/span>/);
  assert.doesNotMatch(sub.orch, /Not listening/);
  const wave = read(claude('waves', 'w1', 'wave.json'));
  write(claude('waves', 'w1', 'wave.json'), { ...wave, review_link_ts: { 11: { Ann: '1.1', Bea: '1.2' } } });
  assert.equal(linkState((await (await fetch(`${base}/orch/api/links`)).json()).links).slack, true);
});

test('sidebar and Hub page serve usage, the shell keeps it inside Hub, and visibility follows login and share', async () => {
  const settingsFile = claude('web-ts', 'settings.json');
  const settings = read(settingsFile);
  const usageFile = claude('web-ts', 'usage.json');
  const codexDir = path.join(home, '.codex');
  const now = Date.now();
  const at = new Date(now).toISOString();
  const resets = new Date(now + 3600_000).toISOString();
  const get = async (url) => (await fetch(base + url)).json();
  try {
    assert.deepEqual((await get('/_hub/sidebar.json')).usage, { claude: null, codex: null });
    write(usageFile, { claude: { at, five_hour: { used_percentage: 42, resets_at: resets } } });
    const expected = { claude: { at, five_hour: { used_percentage: 42, resets_at: resets, state: 'live' }, seven_day: null }, codex: null };
    assert.deepEqual((await get('/_hub/sidebar.json')).usage, expected);
    assert.deepEqual((await get('/_hub/api/hub')).usage, expected);
    const shell = await (await fetch(base + '/_hub/')).text();
    assert.match(shell, /<a class="sb-row on sb-hub-usage" href="\/_hub\/"[^>]*>[^]*?<span class="sb-usage">[^]*?Claude[^]*?42%[^]*?<\/a>/);
    write(path.join(codexDir, 'auth.json'), {});
    write(settingsFile, { ...settings, codexShare: 'off' });
    assert.equal((await get('/_hub/sidebar.json')).usage.codex, null);
    write(settingsFile, { ...settings, codexShare: 'auto' });
    assert.deepEqual((await get('/_hub/sidebar.json')).usage.codex, { at: null, five_hour: null, seven_day: null });
    fs.unlinkSync(path.join(codexDir, 'auth.json'));
    assert.equal((await get('/_hub/sidebar.json')).usage.codex, null);
  } finally {
    write(settingsFile, settings);
    fs.rmSync(usageFile, { force: true });
    fs.rmSync(codexDir, { recursive: true, force: true });
  }
});

test('while the hub runs older code than its files, the Hub row and Health card say so once and no board shows it', async () => {
  const running = read(HUB_CODE);
  assert.equal(running.hash, hubCode().hash);
  const sidebar = async () => (await fetch(`${base}/_hub/sidebar.json`)).json();
  const page = async () => (await fetch(`${base}/_hub/api/hub`)).json();
  assert.doesNotMatch((await sidebar()).hub.detail, /older code/);
  write(HUB_CODE, { ...running, hash: 'older' });
  try {
    for (const route of ['orch', 'shop']) {
      assert.equal((await api(route)).links.some((l) => l.link === 'hub'), false);
      assert.equal((await (await fetch(`${base}/${route}/api/links`)).json()).links.some((l) => l.link === 'hub'), false);
    }
    const side = await sidebar();
    assert.match(side.hub.detail, /^\d+ of \d+ sites up · runs older code than its files; restart it$/);
    assert.notEqual(side.hub.word, 'Healthy');
    assert.ok(side.sites.every((s) => !/older code|restart/i.test(s.sub)));
    const hub = await page();
    assert.equal(hub.hub.detail, side.hub.detail);
    assert.ok(hub.groups.flatMap((g) => g.sites).every((x) => x.lines.every((l) => l.link !== 'hub')));
  } finally { write(HUB_CODE, running); }
  assert.match((await page()).hub.detail, /runs the code in its files/);
});

test("the daily wake reaches both boards", async () => {
  for (let i = 0; i < 100 && !(events('orch', 'check-github').length && events('shop', 'check-github').length); i++) await new Promise((r) => setTimeout(r, 200));
  for (const route of ['orch', 'shop']) assert.deepEqual(events(route, 'check-github').map((e) => e.data), [{ reason: 'morning' }]);
  assert.deepEqual([...read(claude('web-ts', 'wake-state.json')).last.routes].sort(), ['orch', 'shop']);
});

test('listening again ends the outage, a watcher whose session is not running does not, and the next one pushes again', async () => {
  const w = sleeper();
  write(site('shop', 'data', 'watcher.json'), { pid: w.pid, since: ago(0) });
  try {
    assert.deepEqual((await poll()).deaf.pushed, []);
    assert.ok(read(claude('web-ts', 'deaf-state.json')).shop);
    const s = liveSession('s-shop');
    try { assert.deepEqual((await poll()).deaf.pushed, []); } finally { s.kill(); }
  } finally { w.kill(); }
  assert.deepEqual(read(claude('web-ts', 'deaf-state.json')), {});
  write(site('shop', 'data', 'watcher.json'), { pid: w.pid, since: ago(20), exited_at: ago(10) });
  assert.deepEqual((await poll()).deaf.pushed, ['shop']);
  assert.equal(device.received.filter((p) => p.tag === 'deaf-shop').length, 2);
});

test('a board whose stopped session the hub can wake is asleep and pushes nothing; one it cannot wake is deaf and pushes once', async () => {
  write(site('nap', 'board.json'), { title: 'Nap', items: 'data/items.json' });
  write(site('nap', 'data', 'events.jsonl'), JSON.stringify({ id: 'e-nap', ts: ago(30), kind: 'ask', data: {} }) + '\n');
  const owner = { session: 's-nap', since: NOW_SINCE, repo: home };
  const manifest = (o = owner) => ({ sites: { nap: { dir: site('nap'), port: napPort, cmd: boardCmd('nap'), watch: ['data/events.jsonl'], owner: o } } });
  const [nap] = listBoards(manifest());
  const napPushes = () => pushes().filter((p) => p.tag === 'deaf-nap');
  try {
    assert.equal(listenState(nap, { wakes: {} }), 'asleep');
    assert.deepEqual((await checkListening({ manifest: manifest() })).pushed, []);
    assert.equal(listenState(listBoards(manifest({ ...owner, repo: undefined }))[0], { wakes: {} }), 'deaf');
    const s = liveSession('s-nap');
    try { assert.equal(listenState(nap, { wakes: {} }), 'deaf'); } finally { s.kill(); }
    const failed = { nap: { down_since: ago(1), resumed_at: ago(1), error: 'claude --resume failed' } };
    assert.equal(listenState(nap, { wakes: failed }), 'deaf');
    write(RESUME_STATE, failed);
    assert.equal(linksOf(nap, { faults: {} }).find((l) => l.link === 'events').ok, false);
    assert.deepEqual((await checkListening({ manifest: manifest() })).pushed, ['nap']);
    assert.deepEqual(napPushes(), [{ title: "Nap isn't listening", url: '/nap/', tag: 'deaf-nap' }]);
  } finally { fs.rmSync(RESUME_STATE, { force: true }); }
  assert.equal(linksOf(nap, { faults: {} }).find((l) => l.link === 'events').ok, true);
});

test('the handshake says hello without a push; the board shows its checklist until the session acks the hello', async () => {
  const before = pushes().length;
  const r = await cli(path.join(SKILL, 'bin', 'web-ts.mjs'), ['handshake', 'shop']);
  assert.equal(r.status, 0, r.stderr);
  const { hello } = JSON.parse(r.stdout);
  assert.deepEqual(events('shop', 'hello').map((e) => [e.id, e.data.title]), [[hello, 'Shop']]);
  assert.equal(pushes().length, before);
  assert.deepEqual((await api('shop')).setup, { events: false, github: true });
  const board = (...a) => cli(path.join(SKILL, 'board', 'bin', 'board.mjs'), a);
  assert.match((await board('--site', 'shop', 'hello-ack', 'e-shop')).stderr, /no hello event "e-shop"/);
  assert.equal((await board('--site', 'shop', 'hello-ack', hello)).status, 0);
  assert.equal((await api('shop')).setup, null);
  assert.ok(read(site('shop', 'data', 'handshake.json')).done_at);
  assert.equal((await cli(path.join(SKILL, 'bin', 'web-ts.mjs'), ['handshake', 'plain'])).status, 2);
});

test("joining a board polls at once, so the new board's GitHub link passes without waiting for the next slot, and records when it joined, which a later join keeps and the sidebar serves", async () => {
  const before = Date.now();
  const r = await cli(path.join(SKILL, 'bin', 'web-ts.mjs'), ['join', 'fresh', '--session', 's-fresh', '--template', 'board', '--title', 'Fresh']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).poll, 'reached this board');
  assert.ok(read(claude('web-ts', 'github-state.json')).lastCheck.boards.includes('fresh'));
  const { created } = read(claude('web-ts', 'manifest.json')).sites.fresh;
  assert.ok(Date.parse(created) >= before - 1000 && Date.parse(created) <= Date.now(), created);
  assert.equal((await cli(path.join(SKILL, 'bin', 'web-ts.mjs'), ['join', 'fresh', '--session', 's-fresh', '--title', 'Fresher'])).status, 0);
  assert.equal(read(claude('web-ts', 'manifest.json')).sites.fresh.created, created);
  const sites = (await (await fetch(`${base}/_hub/sidebar.json?fresh=1`)).json()).sites;
  assert.deepEqual(sites.map((s) => [s.route, s.created]), [['fresh', created], ['orch', null], ['plain', null], ['shop', null]]);
});

test("New board validates through HTTP, reports a failed clone and preserves repo and branch through pending join/timeout transitions", async () => {
  const manifestFile = claude('web-ts', 'manifest.json');
  const original = read(manifestFile);
  const canonicalHome = fs.realpathSync(home);
  const repo = path.join(reposDir(), 'int180-http-test/project');
  const sameOrigin = { 'content-type': 'application/json', origin: base, 'sec-fetch-site': 'same-origin' };
  const post = (input, headers = sameOrigin) => fetch(`${base}/_hub/new-board`, { method: 'POST', headers, body: JSON.stringify(input) });
  const sidebar = async () => (await fetch(`${base}/_hub/sidebar.json`)).json();
  const request = { name: 'Backend audit', github: 'int180-http-test/project', branch: 'main', purpose: 'Review backend changes' };
  const before = events('orch', 'ask').length;
  try {
    const manifest = structuredClone(original);
    for (const s of Object.values(manifest.sites)) delete s.owner?.repo;
    manifest.sites.orch.owner.repo = canonicalHome;
    manifest.sites.shop.owner.repo = repo;
    manifest.sites.plain.owner = { repo: '/not-a-board' };
    manifest.starting = { reserved: { session: 's-reserved', since: ago(1), repo } };
    write(manifestFile, manifest);
    const sidebarData = await sidebar();
    assert.equal(sidebarData.home, canonicalHome);
    assert.equal(sidebarData.repos, undefined);
    assert.deepEqual(await (await fetch(`${base}/_hub/repos`)).json(), { signedIn: false, repos: [] });
    const missingRepo = await fetch(`${base}/_hub/repo?github=outside/missing`);
    assert.equal(missingRepo.status, 404);
    assert.deepEqual(await missingRepo.json(), { error: "Not found, or you don't have access." });
    for (const input of [
      { ...request, extra: true }, { ...request, name: '' }, { ...request, name: '   ' }, { ...request, name: 'n'.repeat(61) },
      { ...request, name: null }, { ...request, name: '!!!' }, { ...request, name: 'ORCH' }, { ...request, name: 'Reserved' },
      { ...request, github: '../escape' }, { ...request, github: 'o/../../escape' }, { ...request, github: '/tmp' },
      { ...request, branch: '-main' }, { ...request, branch: 'a..b' }, { ...request, branch: 'bad branch' },
      { ...request, purpose: 'p'.repeat(241) }, { ...request, purpose: null }, [], null,
    ]) {
      const response = await post(input);
      assert.equal(response.status, 400, JSON.stringify(input));
      assert.match(response.headers.get('content-type'), /^text\/plain/);
      assert.equal((await response.text()).split('\n').length, 1);
    }
    const invalidJSON = await fetch(`${base}/_hub/new-board`, { method: 'POST', headers: sameOrigin, body: '{' });
    assert.equal(invalidJSON.status, 400);
    for (const headers of [
      { ...sameOrigin, 'sec-fetch-site': 'cross-site' },
      { 'content-type': 'application/json', origin: 'https://evil.example' },
      { ...sameOrigin, 'content-type': 'text/plain' },
    ]) {
      const refused = await post(request, headers);
      assert.equal(refused.status, 403, JSON.stringify(headers));
      assert.match(refused.headers.get('content-type'), /^text\/plain/);
    }
    for (const headers of [{ ...sameOrigin, origin: 'https://evil.example' }, { ...sameOrigin, 'content-type': 'text/plain' }]) {
      const refused = await fetch(`${base}/_hub/board-repo/orch`, { method: 'POST', headers, body: JSON.stringify({ github: request.github, branch: 'main' }) });
      assert.equal(refused.status, 403);
    }
    assert.equal(read(manifestFile).starting['backend-audit'], undefined);
    assert.equal(events('orch', 'ask').length, before);
    const response = await post(request);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { route: 'backend-audit' });
    let pending;
    for (let i = 0; i < 50 && !pending?.failed; i++) {
      pending = (await sidebar()).starting.find((s) => s.route === 'backend-audit');
      if (!pending?.failed) await new Promise((r) => setTimeout(r, 100));
    }
    assert.deepEqual(pending, { route: 'backend-audit', title: request.name, repo, phase: 'cloning', askedAt: read(manifestFile).starting['backend-audit'].asked_at, failed: true, error: 'gh failed' });
    assert.equal(events('orch', 'ask').length, before);
    assert.equal((await sidebar()).sites.some((s) => s.route === pending.route), false);
    assert.equal((await post(request)).status, 400);
    const dismiss = (route) => fetch(`${base}/_hub/new-board/${route}`, { method: 'DELETE' });
    const join = await cli(path.join(SKILL, 'bin', 'web-ts.mjs'), ['join', pending.route, '--session', 's-backend', '--template', 'board', '--title', request.name, '--repo', repo]);
    assert.equal(join.status, 0, join.stderr);
    const joined = await sidebar();
    assert.equal(joined.starting.some((s) => s.route === pending.route), false);
    assert.equal(joined.sites.find((s) => s.route === pending.route).board, true);
    assert.equal(read(manifestFile).sites[pending.route].github, request.github);
    assert.equal(read(manifestFile).sites[pending.route].branch, request.branch);
    const timed = read(manifestFile);
    timed.starting.reserved.since = ago(16);
    write(manifestFile, timed);
    assert.equal((await sidebar()).starting.find((s) => s.route === 'reserved').failed, true);
    assert.equal((await dismiss('reserved')).status, 200);
    assert.equal((await sidebar()).starting.some((s) => s.route === 'reserved'), false);
    const boundary = await post({ ...request, name: 'N'.repeat(60), purpose: 'p'.repeat(240) },
      { 'content-type': 'application/json; charset=utf-8', origin: 'https://mac.example.ts.net', 'x-forwarded-host': 'mac.example.ts.net' });
    assert.equal(boundary.status, 200);
    assert.deepEqual(await boundary.json(), { route: 'n'.repeat(41) });
    const race = await Promise.all([post({ ...request, name: 'One race' }), post({ ...request, name: 'One race' })]);
    assert.deepEqual(race.map((r) => r.status).sort(), [200, 400]);
    assert.ok(read(manifestFile).starting['one-race']);
    assert.equal(events('orch', 'ask').length, before);
    for (let n = 0; n < 50 && Object.values(read(manifestFile).starting || {}).some((r) => r.github && !r.error && !r.session); n++) await new Promise((resolve) => setTimeout(resolve, 20));
  } finally { write(manifestFile, original); fs.rmSync(path.join(reposDir(), 'int180-http-test'), { recursive: true, force: true }); }
});

test("a board session's permission prompt pushes, waits in that board's Needs you and the badge, and Always allow reaches its hook as a rule for the session", async () => {
  const input = { session_id: 's-orch', cwd: home, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run tests' } };
  const hook = new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HUB_DIR, 'permission-hook.mjs')], { env: { ...process.env, WEB_TS_HUB_PORT: String(port) } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (status) => resolve({ status, out }));
    child.stdin.end(JSON.stringify(input));
  });
  const needs = async (route) => (await fetch(`${base}/${route}/_claude/needs`)).json();
  let mine;
  for (let i = 0; i < 50 && !mine; i++) { mine = (await needs('orch')).items.find((x) => x.kind === 'Prompt'); if (!mine) await new Promise((r) => setTimeout(r, 100)); }
  assert.deepEqual(mine, { kind: 'Prompt', text: 'Bash: npm test', url: '' });
  assert.match((await needs('orch')).summary, /^1 prompt/);
  assert.equal((await needs('shop')).items.some((x) => x.kind === 'Prompt'), false);
  const { prompt } = (await api('orch')).needs[0];
  assert.deepEqual([prompt.tool, prompt.detail, prompt.rule], ['Bash', 'npm test', 'Bash(npm test)']);
  const waiting = await (await fetch(`${base}/_hub/needs.json?fresh=1`)).json();
  assert.equal(waiting.total, waiting.sites.orch.count + waiting.sites.shop.count);
  assert.ok(waiting.sites.orch.count >= 1);
  for (let i = 0; i < 50 && !pushes().some((x) => x.tag === `prompt-${prompt.id}`); i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(pushes().find((x) => x.tag === `prompt-${prompt.id}`), { title: 'Orch wants to run npm test', url: '/orch/', tag: `prompt-${prompt.id}` });

  const r = await fetch(`${base}/_hub/prompts/${prompt.id}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ choice: 'always' }) });
  assert.equal(r.status, 200);
  const { status, out } = await hook;
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(out).hookSpecificOutput.decision, { behavior: 'allow', updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'session' }] });
  assert.equal((await needs('orch')).items.some((x) => x.kind === 'Prompt'), false);
});

test('object property names work as page routes and as new boards through HTTP and the CLI', async () => {
  const manifestFile = claude('web-ts', 'manifest.json');
  const original = read(manifestFile);
  const routes = ['constructor', 'tostring', 'hasownproperty', 'valueof'];
  const names = ['Constructor', 'toString', 'hasOwnProperty', 'valueOf'];
  const sessions = ['constructor', 'toString', 'hasOwnProperty', 'valueOf'];
  const repo = fs.realpathSync(home);
  const get = async (url) => {
    const response = await fetch(base + url);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  try {
    const pages = structuredClone(original);
    for (const route of routes) pages.sites[route] = { ...pages.sites.plain, title: route };
    write(manifestFile, pages);
    assert.equal((await get('/_hub/sidebar.json')).sites.filter((s) => routes.includes(s.route)).length, 4);
    const pageRows = (await get('/_hub/api/hub')).groups.flatMap((g) => g.sites).filter((s) => routes.includes(s.route));
    assert.equal(pageRows.length, 4);
    assert.ok(pageRows.every((s) => s.word && Array.isArray(s.remembered) && s.remembered.length === 0));
    write(manifestFile, original);
    for (const [i, route] of routes.entries()) {
      const response = await fetch(`${base}/_hub/new-board`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: names[i], github: 'int180-http-test/project', branch: 'main', purpose: 'Review changes' }) });
      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual(await response.json(), { route });
      const pending = (await get('/_hub/sidebar.json')).starting.find((s) => s.route === route);
      assert.equal(pending.title, names[i]);
      const joined = await cli(path.join(SKILL, 'bin', 'web-ts.mjs'), ['join', route, '--session', sessions[i], '--template', 'board', '--title', names[i], '--repo', repo]);
      assert.equal(joined.status, 0, joined.stderr);
      write(site(route, 'board.json'), { title: names[i], slug: route, items: 'data/items.json' });
      write(site(route, 'data', 'items.json'), { items: [{ id: 'constructor', title: 'Review', status: 'planned' }] });
      for (let n = 0; n < 80 && !(await fetch(`${base}/${route}/_claude/health`).then((r) => r.ok, () => false)); n++) await new Promise((r) => setTimeout(r, 100));
      const side = await get('/_hub/sidebar.json?fresh=1');
      assert.equal(side.starting.some((s) => s.route === route), false);
      assert.equal(side.sites.find((s) => s.route === route).board, true);
      const data = await get(`/${route}/api/board`);
      assert.equal(data.items.find((it) => it.key === `${route}/constructor`).title, 'Review');
      assert.deepEqual(data.items.find((it) => it.key === `${route}/constructor`).agents, []);
      assert.equal((await get(`/${route}/api/thread?key=${route}%2Fconstructor`)).length, 0);
    }
    const checked = await poll();
    assert.ok(routes.every((route) => checked.checked.includes(route)));
    const downSince = () => {
      try { const state = read(claude('web-ts', 'resume-state.json')); return routes.filter((route) => Object.hasOwn(state, route) && Number.isFinite(Date.parse(state[route].down_since))); } catch { return []; }
    };
    for (let n = 0; n < 200 && downSince().length < routes.length; n++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(downSince(), routes);
    const rows = (await get('/_hub/api/hub')).groups.flatMap((g) => g.sites);
    for (const route of routes) assert.deepEqual(rows.find((s) => s.route === route).remembered, []);
    assert.equal((await get('/_hub/api/polling')).now.lines.length, 2);
  } finally { write(manifestFile, original); fs.rmSync(path.join(reposDir(), 'int180-http-test'), { recursive: true, force: true }); }
});

test('a no-JS Polling edit redirects to Hub with Polling open and the edited window selected', async () => {
  const file = claude('web-ts', 'settings.json');
  const original = fs.readFileSync(file);
  try {
    const r = await fetch(`${base}/_hub/settings/polling`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'op=every&w=00%3A00&value=60', redirect: 'manual',
    });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/_hub/?w=00%3A00#polling');
    const landing = await fetch(base + r.headers.get('location'));
    assert.equal(landing.status, 200);
    assert.equal(landing.headers.get('x-app-shell'), '1');
    const data = await (await fetch(`${base}/_hub/api/polling?w=00%3A00`)).json();
    assert.equal(data.select, '00:00');
    assert.equal(data.windows.find((w) => w.from === '00:00').every.find((c) => c.on).minutes, 60);
  } finally { fs.writeFileSync(file, original); }
});

test('a starting hub flags hub-orchestrator as the hub board once, only while no site has the flag', async () => {
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'boards-migrate-')));
  const file = path.join(other, '.claude', 'web-ts', 'manifest.json');
  const board = (name, at) => ({ dir: path.join(other, name), port: at, cmd: [process.execPath, path.join(SKILL, 'board', 'server.mjs'), path.join(other, name)] });
  const startHub = async () => {
    const h = spawn(process.execPath, [path.join(HUB_DIR, 'hub.mjs')], { env: { ...process.env, HOME: other, WEB_TS_HUB_PORT: String(hubPort), WEB_TS_CLAUDE: '/usr/bin/false' } });
    await new Promise((resolve, reject) => {
      let out = '';
      h.stdout.on('data', (d) => { out += d; if (out.includes('hub on')) resolve(); });
      h.once('exit', reject);
    });
    const exited = new Promise((resolve) => h.once('exit', resolve));
    h.kill('SIGTERM');
    await exited;
  };
  const flagged = () => Object.entries(read(file).sites).filter(([, s]) => s.hub).map(([route]) => route);
  try {
    await startHub();
    assert.equal(fs.existsSync(file), false);
    write(file, { sites: { 'hub-orchestrator': board('hub', hubBoardPort), dev: { ...board('dev', devPort), hub: true } } });
    await startHub();
    assert.deepEqual([flagged(), read(file).migrated], [['dev'], ['hub-flag', 'board-github']]);
    write(file, { sites: { 'hub-orchestrator': board('hub', hubBoardPort), dev: board('dev', devPort) } });
    await startHub();
    assert.deepEqual([flagged(), read(file).migrated], [['hub-orchestrator'], ['hub-flag', 'board-github']]);
    const cleared = read(file);
    delete cleared.sites['hub-orchestrator'].hub;
    write(file, cleared);
    await startHub();
    assert.deepEqual(flagged(), []);
  } finally { fs.rmSync(other, { recursive: true, force: true }); }
});

test('stopping the hub stops every site it started, one that ignores SIGTERM and one that joined just before, and starts none', async () => {
  const sitesDir = claude('web-ts', 'sites');
  const siteProcs = () => execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').filter((l) => l.includes(sitesDir)).map((l) => Number(l.trim().split(' ')[0]));
  const node = (route, script) => [process.execPath, '-e', script, site(route)];
  const manifest = read(claude('web-ts', 'manifest.json'));
  manifest.sites.stubborn = { dir: home, port: stubbornPort, cmd: node('stubborn', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)") };
  write(claude('web-ts', 'manifest.json'), manifest);
  const log = claude('web-ts', 'logs', 'stubborn.log');
  for (let i = 0; i < 100 && !(fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('ready')); i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(fs.readFileSync(log, 'utf8'), /ready/);
  manifest.sites.late = { dir: home, port: latePort, cmd: node('late', 'setInterval(() => {}, 1000)') };
  write(claude('web-ts', 'manifest.json'), manifest);
  const exited = new Promise((resolve) => hub.once('exit', resolve));
  hub.kill('SIGTERM');
  await exited;
  await new Promise((r) => setTimeout(r, 500));
  const left = siteProcs();
  try { assert.deepEqual(left, []); } finally { for (const pid of left) { try { process.kill(pid, 'SIGKILL'); } catch {} } }
});
