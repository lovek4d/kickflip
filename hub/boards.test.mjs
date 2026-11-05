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
import { withFileLock } from './locks.mjs';
import { fakeGh, prView, writePR, writeUser, queried } from '../shared/fake-gh.mjs';
import { freePorts, until, ownSession } from '../shared/test-helpers.mjs';

const HUB_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.join(HUB_DIR, '..');
// Real, as a home is: the clone home sits under it, and repoPath refuses a clone home whose ancestors go through a symlink.
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'boards-')));
process.env.HOME = home;
const { listBoards, linksOf, hubLink, oldestUnheard, hubCode, boardCode, HUB_CODE, listenState, checkListening, RESUME_STATE, withManifestLock, saveJSON } = await import('./boards.mjs');

const claude = (...p) => path.join(home, '.claude', ...p);
const site = (route, ...p) => claude('kickflip', 'sites', route, ...p);
const write = (file, v) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v)); };
const writeManifestFile = (m) => withManifestLock(() => saveJSON(claude('kickflip', 'manifest.json'), m));
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const events = (route, kind) => { try { return fs.readFileSync(site(route, 'data', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.kind === kind); } catch { return []; } };
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
const sleeper = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'wait-events.mjs'], { stdio: 'ignore' });
const liveSession = (sessionId) => {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const procStart = execFileSync('ps', ['-o', 'lstart=', '-p', String(c.pid)], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } }).trim();
  write(claude('sessions', `${c.pid}.json`), { pid: c.pid, sessionId, cwd: home, procStart, kind: 'bg' });
  return c;
};

const [port, orchPort, shopPort, plainPort, stubbornPort, latePort, napPort, hubPort, hubBoardPort, devPort, closePort, freshPort, auditPort, ...namedPorts] = await freePorts(17);
process.env.KICKFLIP_HUB_PORT = String(port);
const base = `http://127.0.0.1:${port}`;
const boardCmd = (route) => [process.execPath, path.join(SKILL, 'board', 'server.mjs'), site(route)];
const NOW_SINCE = ago(60);

write(claude('waves', 'w1', 'wave.json'), { repo: 'o/r', reviewers: [{ name: 'Bea' }], items: [
  { id: 'A1', pr: 11, gh_since: '2026-10-20T00:00:00Z' }, { id: 'A2', pr: 12, status: 'merged' }, { id: 'A3' }, { id: 'A4', pr: 13, status: 'dropped' },
] });
fs.mkdirSync(claude('waves', 'notes'), { recursive: true });
write(site('orch', 'board.json'), { title: 'Orch', items: 'waves', reviewers: [{ name: 'Ann', slack_user: 'U1', dm: 'D1', github: 'ann' }] });
write(site('shop', 'board.json'), { title: 'Shop', items: 'data/wave.json', slug: 'shop' });
write(site('shop', 'data', 'wave.json'), { repo: 'o/r', items: [{ id: 'S1', pr: 722 }, { id: 'S2', pr: 11 }] });
write(site('bare', 'board.json'), { items: 'data/items.json' });
write(site('bare', 'data', 'items.json'), { items: [{ id: 'B1', pr: 5 }] });
await writeManifestFile({ version: 1, sites: {
  orch: { dir: site('orch'), port: orchPort, cmd: boardCmd('orch'), watch: ['data/events.jsonl'], owner: { session: 's-orch', since: NOW_SINCE } },
  shop: { dir: site('shop'), port: shopPort, cmd: boardCmd('shop'), watch: ['data/events.jsonl'], owner: { session: 's-shop', since: NOW_SINCE } },
  plain: { dir: site('plain'), port: plainPort, cmd: ['/bin/sleep', '600'] },
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
  const bare = listBoards({ sites: { bare: { dir: site('bare'), port: 1, cmd: boardCmd('bare') } } });
  assert.deepEqual(bare.map((b) => [b.title, b.waves.map((w) => w.slug), b.prs]), [['bare', ['items'], []]]);
  assert.deepEqual(listBoards({}), []);
});

test('linksOf names each hub link that reaches a board and each that does not', () => {
  const orch = listBoards().find((b) => b.route === 'orch');
  const github = { lastCheck: { at: 'T', boards: ['orch'] }, prs: { 'o/r#11': { at: 'T', state: 'OPEN', isDraft: false } } };
  const ok = { github, settings: { quiet: { start: '22:00', end: '08:00', hold: true } }, wakes: {}, listen: 'listening', topics: { 'w1/A1': { review_link_ts: { Ann: '1.1', Bea: '1.2' } } }, faults: {} };
  const state = (ctx) => Object.fromEntries(linksOf(orch, ctx).map((l) => [l.link, l.ok]));
  assert.deepEqual(linksOf(orch, ok).map((l) => l.link), ['github', 'events', 'wakes', 'slack']);
  assert.deepEqual(state(ok), { github: true, events: true, wakes: true, slack: true });
  const broken = (ctx) => Object.entries(state({ ...ok, ...ctx })).filter(([, v]) => !v).map(([k]) => k);
  assert.deepEqual(broken({ github: {} }), ['github']);
  assert.deepEqual(broken({ github: { ...github, prs: { 'o/r#11': { ...github.prs['o/r#11'], at: 'older' } } } }), ['github']);
  assert.deepEqual(broken({ github: { ...github, lastCheck: { at: 'T', boards: [] } } }), ['github']);
  assert.deepEqual(broken({ listen: 'deaf' }), ['events']);
  assert.deepEqual(broken({ listen: 'asleep' }), []);
  assert.deepEqual(broken({ wakes: { last: { due: ['08:00'], failed: ['orch'] } } }), ['wakes']);
  assert.deepEqual(linksOf(orch, { ...ok, fetches: { orch: { at: 'T', ok: true } } }).map((l) => l.link), ['github', 'repo-fetch', 'events', 'wakes', 'slack']);
  assert.deepEqual(broken({ fetches: { orch: { at: 'T', ok: false, error: 'fatal: unable to access origin', hint: 'run git fetch' } } }), ['repo-fetch']);
  assert.equal(hubLink({ running: 'h1', onDisk: 'h1' }).ok, true);
  assert.equal(hubLink({ running: undefined, onDisk: 'h1' }).ok, false);
  assert.deepEqual(hubLink({ running: 'h0', onDisk: 'h1' }), { link: 'hub', ok: false,
    detail: 'The hub runs older code than its files; restart it with ' + (process.platform === 'darwin' ? 'launchctl kickstart -k gui/$(id -u)/local.claude.kickflip-hub' : 'systemctl --user restart kickflip-hub.service') });
  const recorded = structuredClone(orch);
  recorded.waves[0].wave.items[0].review_link_ts = { Ann: { ts: '1.1', channel: 'D1' }, Bea: '1.2' };
  assert.equal(linksOf(recorded, { ...ok, topics: {} })[3].ok, true);
  const slack = linksOf(orch, { ...ok, topics: { 'w1/A1': { review_link_ts: { Ann: '1.1' } } } })[3];
  assert.deepEqual([slack.ok, slack.detail], [false, '#11 has no link for Bea.']);
  assert.equal(linksOf(orch, { ...ok, topics: {}, github: { ...github, prs: { 'o/r#11': { at: 'T', state: 'OPEN', isDraft: true } } } })[3].ok, true);
});

test('a broken link reads settling until it has stayed broken past its grace period, then broken', () => {
  const orch = listBoards().find((b) => b.route === 'orch');
  const settings = { quiet: { start: '22:00', end: '08:00', hold: true } };
  const now = new Date(2026, 9, 29, 12, 0).getTime();
  const ago = (min) => new Date(now - min * 60_000).toISOString();
  const fetches = { orch: { at: ago(1), ok: false, error: 'remote: Repository not found.', hint: 'run gh auth setup-git' } };
  const faulty = { github: {}, fetches, settings, wakes: {}, listen: 'deaf', topics: {}, now };
  const states = (faults, at = now) => Object.fromEntries(linksOf(orch, { ...faulty, faults, now: at }).filter((l) => !l.ok).map((l) => [l.link, l.state]));
  assert.deepEqual(states({}), { github: 'settling', 'repo-fetch': 'settling', events: 'settling' });
  assert.deepEqual(states({ github: ago(24), 'repo-fetch': ago(24), events: ago(1.9) }), { github: 'settling', 'repo-fetch': 'settling', events: 'settling' });
  assert.deepEqual(states({ github: ago(26), 'repo-fetch': ago(26), events: ago(2.1) }), { github: 'broken', 'repo-fetch': 'broken', events: 'broken' });
  assert.equal(linksOf(orch, { ...faulty, faults: { github: ago(26) } })[0].since, ago(26));
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

test("a board server's code hash covers its board/server.mjs entry, found in its cmd from its folder, and what it imports", () => {
  const root = fs.mkdtempSync(path.join(home, 'board-code-'));
  write(path.join(root, 'board', 'server.mjs'), "import './store.mjs';\n");
  write(path.join(root, 'board', 'store.mjs'), "export { b } from '../shared/b.mjs';\n");
  write(path.join(root, 'shared', 'b.mjs'), 'export const b = 1;\n');
  const absolute = { dir: root, cmd: [process.execPath, path.join(root, 'board', 'server.mjs'), root] };
  const relative = { dir: root, cmd: ['node', 'board/server.mjs', '.'] };
  const first = boardCode(absolute);
  assert.equal(boardCode(relative), first);
  write(path.join(root, 'shared', 'b.mjs'), 'export const b = 2;\n');
  assert.notEqual(boardCode(absolute), first);
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
  const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, HOME: home, KICKFLIP_HUB_PORT: String(port) } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});

before(async () => {
  fakeGh(home);
  writeUser(home, { login: 'owner' });
  device = await startFakeDevice();
  write(claude('kickflip', 'push', 'subs.json'), [device.subscription]);
  write(claude('kickflip', 'settings.json'), { quiet: { start: '23:59', end: '00:00', hold: false }, notifications: { on: true, weekends_off: false } });
  writePR(home, 11, prView());
  writePR(home, 722, prView());
  write(path.join(home, 'bin', 'git'), `#!/bin/sh
for a in "$@"; do
  if [ "$a" = fetch ]; then
    [ -e "$HOME/git-fetch-fails" ] || exit 0
    echo 'remote: Repository not found.' >&2
    echo "fatal: repository 'https://github.com/o/r.git/' not found" >&2
    exit 128
  fi
done
exit 1
`);
  write(path.join(home, 'bin', 'codex'), '#!/bin/sh\nexit 1\n');
  for (const bin of ['gh', 'git', 'codex']) fs.chmodSync(path.join(home, 'bin', bin), 0o755);
  for (const route of ['orch', 'shop']) write(site(route, 'data', 'events.jsonl'), JSON.stringify({ id: `e-${route}`, ts: ago(30), kind: 'ask', data: {} }) + '\n');
  write(site('shop', 'data', '.watch-cursor-s-shop.json'), { 'data/events.jsonl': 0 });
  orchWatcher = sleeper();
  orchSession = liveSession('s-orch');
  write(site('orch', 'data', 'watcher.json'), { pid: orchWatcher.pid, since: ago(1) });

  hub = spawn(process.execPath, [path.join(HUB_DIR, 'hub.mjs')], { env: { ...process.env, HOME: home, KICKFLIP_HUB_PORT: String(port), KICKFLIP_CLAUDE: '/usr/bin/false', KICKFLIP_TMUX: '/usr/bin/false', PATH: `${path.join(home, 'bin')}:${process.env.PATH}` } });
  await new Promise((resolve, reject) => {
    let out = '';
    hub.stdout.on('data', (d) => { out += d; if (out.includes('hub on')) resolve(); });
    hub.once('exit', reject);
  });
  for (const route of ['orch', 'shop']) {
    await until(() => fetch(`${base}/${route}/_claude/health`).then((r) => r.ok, () => false), `${route} server becomes healthy`);
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
  const settings = claude('kickflip', 'settings.json');
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
  for (const p of ['/_hub/settings/rules', '/_hub/prompts', '/_hub/prompts/missing/answer', '/_hub/poll', '/_hub/push/subscribe', '/_hub/push/unsubscribe']) {
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
  const file = claude('kickflip', 'manifest.json');
  const original = read(file);
  const route = 'close-me';
  const dir = site(route);
  write(site(route, 'board.json'), { title: 'Close Me', items: 'data/items.json', slug: route });
  write(site(route, 'data', 'items.json'), { repo: 'o/r', items: [{ id: 'C1', pr: 99 }] });
  write(site(route, 'data', 'agents', 'C1.json'), { label: 'Builder', started: new Date().toISOString() });
  const entry = { dir, port: closePort, cmd: boardCmd(route), owner: { session: 's-close', repo: home } };
  await writeManifestFile({ ...original, sites: { ...original.sites, [route]: entry } });
  const headers = { 'content-type': 'application/json', origin: base, 'sec-fetch-site': 'same-origin' };
  const post = (path, body, h = headers) => fetch(base + path, { method: 'POST', headers: h, body: JSON.stringify(body) });
  try {
    await until(() => fetch(`${base}/${route}/_claude/health`).then((r) => r.ok, () => false), `${route} server becomes healthy`);
    const pid = Number(fs.readFileSync(claude('kickflip', 'run', `${route}.pid`), 'utf8'));
    const body = { route, name: 'Close Me' };
    const before = read(file);
    for (const h of [{ ...headers, origin: 'https://other.example' }, { ...headers, 'sec-fetch-site': 'cross-site' }, { 'content-type': 'text/plain' }]) {
      assert.equal((await post('/_hub/close-board', body, h)).status, 403);
      assert.equal((await post('/_hub/reopen-board', { route }, h)).status, 403);
      assert.deepEqual(read(file), before);
    }
    assert.equal((await post('/_hub/close-board', { route, name: 'close me' })).status, 400);
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
    await until(() => !fs.existsSync(claude('kickflip', 'run', `${route}.pid`)), `${route} server pid file is removed`);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.ok(fs.existsSync(site(route, 'data', 'items.json')));
    const reopened = await post('/_hub/reopen-board', { route });
    assert.equal(reopened.status, 400);
    assert.match((await reopened.json()).error, /claude --resume failed/);
    assert.equal(read(file).sites[route], undefined);
    assert.deepEqual(read(file).closed[route].site, entry);
  } finally { await writeManifestFile(original); }
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
  assert.deepEqual(queried(home).map((prs) => prs.sort()), [['o/r#11', 'o/r#722']]);
  const state = read(claude('kickflip', 'github-state.json'));
  assert.deepEqual([state.prs['o/r#11'].at, state.prs['o/r#722'].at], [r.at, r.at]);
  assert.deepEqual([...state.lastCheck.boards].sort(), ['orch', 'shop']);
  for (const route of ['orch', 'shop']) assert.equal(read(site(route, 'data', 'checked.json')).every, 5);
  assert.deepEqual(r.deaf.pushed, ['shop']);
  assert.deepEqual(pushes(), [{ title: "Shop isn't listening", url: '/shop/', tag: 'deaf-shop' }]);
});

test("a GitHub change goes to every board showing that PR, and pushes alone never wake sessions to build", async () => {
  writePR(home, 11, prView({ reviewDecision: 'APPROVED' }));
  writePR(home, 722, prView({ failing: ['build'] }));
  const r = await poll();
  assert.deepEqual(r.changes.map((c) => [c.pr, c.changes]).sort(), [[11, ['review']], [722, ['ci']]]);
  assert.deepEqual(events('orch', 'github-change').map((e) => e.data.prs), [[{ wave: 'w1', id: 'A1', pr: 11, changes: ['review'] }]]);
  assert.deepEqual(events('shop', 'github-change').map((e) => e.data.prs), [[
    { wave: 'shop', id: 'S1', pr: 722, changes: ['ci'] }, { wave: 'shop', id: 'S2', pr: 11, changes: ['review'] },
  ]]);
  assert.deepEqual(r.deaf.pushed, [], 'one push per outage');
  assert.equal(device.received.length, 1);

  write(site('shop', 'data', 'wave.json'), { repo: 'o/r', items: [{ id: 'S1', pr: 722 }, { id: 'S2', pr: 11, install: { url: 'itms-services://x', sha: 'ABC' } }] });
  writePR(home, 11, prView({ reviewDecision: 'APPROVED', head: 'def', pending: 2 }));
  writePR(home, 722, prView({ failing: ['build'], head: 'fed', pending: 2 }));
  const pushed = await poll();
  assert.deepEqual(pushed.changes, []);
  assert.equal(events('orch', 'github-change').length, 1);
  assert.equal(events('shop', 'github-change').length, 1);
  assert.equal(read(claude('kickflip', 'github-state.json')).prs['o/r#722'].head, 'fed');
  assert.deepEqual((await poll()).changes, [], 'a quiet poll does not repeat the head event');

  write(site('shop', 'data', 'wave.json'), { repo: 'o/r', items: [{ id: 'S1', pr: 722 },
    { id: 'S2', pr: 11, install: { url: 'itms-services://x', sha: 'new' } }, { id: 'S3', pr: 11 },
    { id: 'S4', pr: 11, install: { url: 'https://m/app.apk' } },
  ] });
  writePR(home, 11, prView({ reviewDecision: 'APPROVED', head: 'new', pending: 2 }));
  await poll();
  assert.equal(events('shop', 'github-change').length, 1);
});

test('a device that lost its subscription is dropped from the hub, and Integrations counts the devices left', async () => {
  const subs = claude('kickflip', 'push', 'subs.json');
  const before = read(subs);
  const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const notifications = async () => (await (await fetch(`${base}/_hub/api/hub`)).json()).integrations.find((i) => i.id === 'notifications').detail;
  assert.deepEqual(await post('/_hub/push/subscribe', { endpoint: 'https://push.example/gone', keys: { p256dh: 'p', auth: 'a' } }), { count: 2 });
  assert.equal(await notifications(), 'Pushes on · 2 devices');
  assert.deepEqual(await post('/_hub/push/unsubscribe', { endpoint: 'https://push.example/gone' }), { count: 1 });
  assert.deepEqual(await post('/_hub/push/unsubscribe', { endpoint: 'https://push.example/gone' }), { count: 1 });
  assert.deepEqual(read(subs), before);
  assert.equal(await notifications(), 'Pushes on · 1 device');
});

test('a hub rules save reaches both boards', async () => {
  const r = await (await fetch(`${base}/_hub/settings/rules`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rules: [{ text: 'Be brief' }], base: [] }) })).json();
  assert.deepEqual(r.events.map((e) => e.route).sort(), ['orch', 'shop']);
  for (const route of ['orch', 'shop']) assert.deepEqual(events(route, 'rules').map((e) => e.data.added), [['Be brief']]);
});

test("each board serves its hub links, and the slack link passes once every reviewer has the PR's link", async () => {
  const orch = await api('orch');
  assert.deepEqual(linkState(orch.links), { github: true, events: true, wakes: true, slack: false });
  assert.equal(orch.links[3].state, 'settling');
  assert.match(orch.links[3].detail, /#11 has no link for Ann, Bea/);
  assert.equal(orch.setup, null);
  const shop = await api('shop');
  assert.deepEqual(linkState(shop.links), { github: true, events: false, wakes: true, slack: true });
  const sub = Object.fromEntries((await (await fetch(`${base}/_hub/sidebar.json`)).json()).sites.map((x) => [x.route, x.sub]));
  assert.match(sub.shop, /^<span class="dot t-down" aria-hidden="true"><\/span><span class="word t-down">not listening<\/span>/);
  assert.doesNotMatch(sub.orch, /not listening/);
  const wave = read(claude('waves', 'w1', 'wave.json'));
  write(claude('waves', 'w1', 'wave.json'), { ...wave, review_link_ts: { 11: { Ann: '1.1', Bea: '1.2' } } });
  assert.equal(linkState((await (await fetch(`${base}/orch/api/links`)).json()).links).slack, true);
});

test("sidebar and Hub page serve usage, the shell keeps it inside Hub, and Codex share is Off until Codex is logged in, then Auto or the choice made earlier", async () => {
  const settingsFile = claude('kickflip', 'settings.json');
  const settings = read(settingsFile);
  const usageFile = claude('kickflip', 'usage.json');
  const codexDir = path.join(home, '.codex');
  const now = Date.now();
  const at = new Date(now).toISOString();
  const resets = new Date(now + 3600_000).toISOString();
  const get = async (url) => (await fetch(base + url)).json();
  const codex = async () => {
    const [sidebar, hub] = [await get('/_hub/sidebar.json'), await get('/_hub/api/hub')];
    assert.deepEqual(hub.usage, sidebar.usage);
    return [sidebar.usage.codex, hub.codex.usable, hub.codex.tag, hub.codex.share];
  };
  const NO_READING = { at: null, five_hour: null, seven_day: null };
  try {
    assert.deepEqual((await get('/_hub/sidebar.json')).usage, { claude: null, codex: null });
    assert.deepEqual(await codex(), [null, false, 'not logged in', 'off']);
    write(usageFile, { claude: { at, five_hour: { used_percentage: 42, resets_at: resets } } });
    const expected = { claude: { at, five_hour: { used_percentage: 42, resets_at: resets, state: 'live' }, seven_day: null }, codex: null };
    assert.deepEqual((await get('/_hub/sidebar.json')).usage, expected);
    assert.deepEqual((await get('/_hub/api/hub')).usage, expected);
    const shell = await (await fetch(base + '/_hub/')).text();
    assert.match(shell, /<a class="sb-row on sb-hub-usage" href="\/_hub\/"[^>]*>[^]*?<span class="sb-usage">[^]*?Claude[^]*?42%[^]*?<\/a>/);
    write(path.join(codexDir, 'auth.json'), {});
    assert.deepEqual(await codex(), [NO_READING, true, null, 'auto']);
    write(settingsFile, { ...settings, codexShare: 'off' });
    assert.deepEqual(await codex(), [null, true, null, 'off']);
    write(settingsFile, { ...settings, codexShare: 'always' });
    assert.deepEqual(await codex(), [NO_READING, true, null, 'always']);
    fs.unlinkSync(path.join(codexDir, 'auth.json'));
    assert.deepEqual(await codex(), [null, false, 'not logged in', 'off']);
    write(path.join(codexDir, 'auth.json'), {});
    assert.deepEqual(await codex(), [NO_READING, true, null, 'always']);
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
    assert.notEqual(side.hub.word, 'healthy');
    assert.ok(side.sites.every((s) => !/older code|restart/i.test(s.sub)));
    const hub = await page();
    assert.equal(hub.hub.detail, side.hub.detail);
    assert.ok(hub.groups.flatMap((g) => g.sites).every((x) => x.lines.every((l) => l.link !== 'hub')));
  } finally { write(HUB_CODE, running); }
  assert.match((await page()).hub.detail, /runs the code in its files/);
});

test("a board whose repo fetch fails gets a Repo fetch link that settles, reads degraded on Health and shows on the watcher after its grace, and clears on the next fetch", async () => {
  const manifestFile = claude('kickflip', 'manifest.json');
  const manifest = read(manifestFile);
  const faultsFile = claude('kickflip', 'link-faults.json');
  const failing = path.join(home, 'git-fetch-fails');
  const cursor = site('shop', 'data', '.watch-cursor-s-shop.json');
  const watcherFile = site('shop', 'data', 'watcher.json');
  const kept = [cursor, watcherFile].map((f) => [f, fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null]);
  const repo = path.join(home, 'shop-repo');
  fs.mkdirSync(repo, { recursive: true });
  const detail = "remote: Repository not found. git's github.com login can't see o/r; run gh auth setup-git.";
  const repoFetch = async () => { try { return (await api('shop')).links.find((l) => l.link === 'repo-fetch'); } catch { return undefined; } };
  const hubPage = async () => (await fetch(`${base}/_hub/api/hub`)).json();
  const shopLines = async () => (await hubPage()).groups.flatMap((g) => g.sites).find((s) => s.route === 'shop').lines;
  write(failing, '');
  await writeManifestFile({ ...manifest, sites: { ...manifest.sites, shop: { ...manifest.sites.shop, github: 'o/r', owner: { ...manifest.sites.shop.owner, repo } } } });
  try {
    await until(async () => { await poll(); return (await repoFetch())?.ok === false; }, 'the failed fetch reaches the board');
    const settling = await repoFetch();
    assert.deepEqual([settling.state, settling.detail], ['settling', detail]);
    await until(async () => {
      write(faultsFile, { ...read(faultsFile), shop: { ...read(faultsFile).shop, 'repo-fetch': ago(200) } });
      return (await repoFetch())?.state === 'broken';
    }, 'the fetch fault turns broken past its grace');
    await until(async () => (await shopLines()).some((l) => l.link === 'repo-fetch' && l.detail === detail), 'Health lists the broken fetch');
    const health = (await (await fetch(`${base}/_hub/sidebar.json`)).json()).hub;
    assert.notEqual(health.word, 'healthy');
    assert.match(health.detail, /^\d+ of \d+ sites up · \d+ links? failing/);
    write(cursor, { 'data/events.jsonl': 0 });
    ownSession(home, 's-shop');
    kept.push([claude('sessions', `${process.pid}-s-shop.json`), null]);
    const watched = await cli(path.join(SKILL, 'bin', 'wait-events.mjs'), ['shop', 's-shop']);
    fs.rmSync(claude('sessions', `${process.pid}-s-shop.json`));
    assert.ok(watched.stdout.split('\n').includes(`link repo-fetch ${detail}`), watched.stdout);
    fs.rmSync(failing);
    await until(async () => { await poll(); return (await repoFetch())?.ok === true; }, 'the next good fetch clears the link');
    assert.equal((await repoFetch()).state, 'ok');
    assert.equal(read(faultsFile).shop?.['repo-fetch'], undefined);
    await until(async () => (await shopLines()).every((l) => l.link !== 'repo-fetch'), 'Health drops the fetch line');
  } finally {
    fs.rmSync(failing, { force: true });
    await writeManifestFile(manifest);
    for (const [f, text] of kept) { if (text === null) fs.rmSync(f, { force: true }); else write(f, text); }
    await until(() => fetch(`${base}/shop/_claude/health`).then((r) => r.ok, () => false), 'shop server is healthy again');
  }
});

test("the daily wake reaches both boards", async () => {
  await until(() => events('orch', 'check-github').length && events('shop', 'check-github').length && fs.existsSync(claude('kickflip', 'wake-state.json')), 'the daily wake reaches both boards and records its state');
  for (const route of ['orch', 'shop']) assert.deepEqual(events(route, 'check-github').map((e) => e.data), [{ reason: 'morning' }]);
  assert.deepEqual([...read(claude('kickflip', 'wake-state.json')).last.routes].sort(), ['orch', 'shop']);
});

test('listening again ends the outage, a watcher whose session is not running does not, and the next one pushes again', async () => {
  const w = sleeper();
  write(site('shop', 'data', 'watcher.json'), { pid: w.pid, since: ago(0) });
  try {
    assert.deepEqual((await poll()).deaf.pushed, []);
    assert.ok(read(claude('kickflip', 'deaf-state.json')).shop);
    const s = liveSession('s-shop');
    try { assert.deepEqual((await poll()).deaf.pushed, []); } finally { s.kill(); }
  } finally { w.kill(); }
  assert.deepEqual(read(claude('kickflip', 'deaf-state.json')), {});
  write(site('shop', 'data', 'watcher.json'), { pid: w.pid, since: ago(20), exited_at: ago(10) });
  assert.deepEqual((await poll()).deaf.pushed, ['shop']);
  assert.equal(device.received.filter((p) => p.tag === 'deaf-shop').length, 2);
});

test("the sidebar reads a board's listening fresh: a watcher starting or exiting shows on the very next read, with its events link", async () => {
  const sub = async () => (await (await fetch(`${base}/_hub/sidebar.json`)).json()).sites.find((x) => x.route === 'shop').sub;
  const watcherFile = site('shop', 'data', 'watcher.json');
  const kept = fs.existsSync(watcherFile) ? fs.readFileSync(watcherFile, 'utf8') : null;
  const w = sleeper();
  const s = liveSession('s-shop');
  try {
    write(watcherFile, { pid: w.pid, since: ago(20), exited_at: ago(10) });
    assert.match(await sub(), /not listening/);
    write(watcherFile, { pid: w.pid, since: ago(0) });
    assert.doesNotMatch(await sub(), /not listening/);
    assert.equal(linkState((await api('shop')).links).events, true);
    write(watcherFile, { pid: w.pid, since: ago(20), exited_at: ago(10) });
    assert.match(await sub(), /not listening/);
  } finally {
    w.kill();
    s.kill();
    if (kept === null) fs.rmSync(watcherFile, { force: true }); else write(watcherFile, kept);
  }
});

test('a board whose stopped session the hub can wake is asleep, then waking once the hub resumed it, and pushes nothing; one it cannot wake is deaf and pushes once', async () => {
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
    const resumed = { nap: { down_since: ago(1), resumed_at: ago(1) } };
    try {
      assert.equal(listenState(nap, { wakes: {} }), 'deaf');
      assert.equal(listenState(nap, { wakes: resumed }), 'waking');
    } finally { s.kill(); }
    assert.equal(listenState(nap, { wakes: resumed }), 'waking');
    write(RESUME_STATE, resumed);
    assert.deepEqual([linksOf(nap, { faults: {} }).find((l) => l.link === 'events').ok, (await checkListening({ manifest: manifest() })).pushed], [true, []]);
    assert.equal(listenState(nap, { wakes: { nap: { ...resumed.nap, pushed_at: ago(0) } } }), 'deaf');
    const failed = { nap: { down_since: ago(1), resumed_at: ago(1), error: 'claude --resume failed' } };
    assert.equal(listenState(nap, { wakes: failed }), 'deaf');
    write(RESUME_STATE, failed);
    assert.equal(linksOf(nap, { faults: {} }).find((l) => l.link === 'events').ok, false);
    assert.deepEqual((await checkListening({ manifest: manifest() })).pushed, ['nap']);
    assert.deepEqual(napPushes(), [{ title: "Nap isn't listening", url: '/nap/', tag: 'deaf-nap' }]);
  } finally { fs.rmSync(RESUME_STATE, { force: true }); }
  assert.equal(linksOf(nap, { faults: {} }).find((l) => l.link === 'events').ok, true);
});

test("the handshake sends a ping without a push; the board shows its checklist until the session's watcher answers the ping", async () => {
  const before = pushes().length;
  const r = await cli(path.join(SKILL, 'bin', 'kickflip.mjs'), ['handshake', 'shop']);
  assert.equal(r.status, 0, r.stderr);
  const { ping } = JSON.parse(r.stdout);
  assert.deepEqual(events('shop', 'ping').map((e) => [e.id, e.data.title]), [[ping, 'Shop']]);
  assert.equal(pushes().length, before);
  assert.deepEqual((await api('shop')).setup, { events: false, github: true });
  const { ackPing } = await import('../board/store.mjs');
  await assert.rejects(ackPing(site('shop'), 'e-shop'), /no ping event "e-shop"/);
  await ackPing(site('shop'), ping);
  assert.equal((await api('shop')).setup, null);
  assert.ok(read(site('shop', 'data', 'handshake.json')).done_at);
  assert.equal((await cli(path.join(SKILL, 'bin', 'kickflip.mjs'), ['handshake', 'plain'])).status, 2);
});

test("joining a board polls at once, so the new board's GitHub link passes without waiting for the next slot, and records when it joined, which a later join keeps and the sidebar serves", async () => {
  const before = Date.now();
  const r = await cli(path.join(SKILL, 'bin', 'kickflip.mjs'), ['join', '--name', 'Fresh', '--session', 's-fresh', '--template', 'board', '--port', String(freshPort)]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).poll, 'reached this board');
  assert.ok(read(claude('kickflip', 'github-state.json')).lastCheck.boards.includes('fresh'));
  const { created } = read(claude('kickflip', 'manifest.json')).sites.fresh;
  assert.ok(Date.parse(created) >= before - 1000 && Date.parse(created) <= Date.now(), created);
  assert.equal((await cli(path.join(SKILL, 'bin', 'kickflip.mjs'), ['join', '--name', 'fresh', '--session', 's-fresh'])).status, 0);
  assert.equal(read(claude('kickflip', 'manifest.json')).sites.fresh.created, created);
  const sites = (await (await fetch(`${base}/_hub/sidebar.json?fresh=1`)).json()).sites;
  assert.deepEqual(sites.map((s) => [s.route, s.created]), [['fresh', created], ['orch', null], ['plain', null], ['shop', null]]);
});

test("New board validates through HTTP, reports a failed clone and preserves repo and branch through pending join/timeout transitions", async () => {
  const manifestFile = claude('kickflip', 'manifest.json');
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
    await writeManifestFile(manifest);
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
    await until(async () => {
      pending = (await sidebar()).starting.find((s) => s.route === 'backend-audit');
      return pending?.failed;
    }, 'backend-audit clone failure appears in the sidebar');
    assert.deepEqual(pending, { route: 'backend-audit', title: request.name, repo, step: 'cloning', stepAt: pending.askedAt, branch: 'main', tickets: { source: 'internal', prefix: 'INT' }, askedAt: read(manifestFile).starting['backend-audit'].asked_at, failed: true, error: 'git clone failed' });
    assert.equal(events('orch', 'ask').length, before);
    assert.equal((await sidebar()).sites.some((s) => s.route === pending.route), false);
    assert.equal((await post(request)).status, 400);
    const retry = (route, headers = sameOrigin) => fetch(`${base}/_hub/new-board/${route}/retry`, { method: 'POST', headers, body: '{}' });
    for (const headers of [{ ...sameOrigin, 'content-type': 'text/plain' }, { ...sameOrigin, origin: 'https://evil.example' }]) {
      assert.equal((await retry(pending.route, headers)).status, 403);
    }
    assert.equal(read(manifestFile).starting['backend-audit'].error, 'git clone failed');
    const missing = await retry('missing');
    assert.equal(missing.status, 400);
    assert.match(missing.headers.get('content-type'), /^text\/plain/);
    const retried = await retry(pending.route);
    assert.equal(retried.status, 200);
    assert.deepEqual(await retried.json(), { route: 'backend-audit' });
    let again;
    await until(async () => {
      again = (await sidebar()).starting.find((s) => s.route === 'backend-audit');
      return again?.failed && again.askedAt !== pending.askedAt;
    }, 'backend-audit retry fails again with a new asked time');
    const retriedAt = read(manifestFile).starting['backend-audit'].asked_at;
    assert.deepEqual(again, { ...pending, askedAt: retriedAt, stepAt: retriedAt });
    assert.equal(read(manifestFile).starting['backend-audit'].purpose, request.purpose);
    const dismiss = (route) => fetch(`${base}/_hub/new-board/${route}`, { method: 'DELETE' });
    const join = await cli(path.join(SKILL, 'bin', 'kickflip.mjs'), ['join', '--name', request.name, '--session', 's-backend', '--template', 'board', '--repo', repo, '--port', String(auditPort)]);
    assert.equal(join.status, 0, join.stderr);
    const joined = await sidebar();
    assert.deepEqual(joined.starting.filter((s) => s.route === pending.route).map((s) => [s.step, s.joined]), [['landing', true]], 'a joined board is landing until it listens');
    assert.equal(joined.sites.some((s) => s.route === pending.route), false, 'its board row waits behind the landing row');
    assert.equal(read(manifestFile).sites[pending.route].github, request.github);
    assert.equal(read(manifestFile).sites[pending.route].branch, request.branch);
    const timed = read(manifestFile);
    timed.starting.reserved.since = ago(16);
    await writeManifestFile(timed);
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
    await until(() => !Object.values(read(manifestFile).starting || {}).some((r) => r.github && !r.error && !r.session), 'all in-flight clones record an error or session');
  } finally { await writeManifestFile(original); fs.rmSync(path.join(reposDir(), 'int180-http-test'), { recursive: true, force: true }); }
});

test("a board session's permission prompt pushes, waits in that board's Needs you and the badge, and Always allow reaches its hook as a rule for the session", async () => {
  const input = { session_id: 's-orch', cwd: home, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run tests' } };
  const hook = new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HUB_DIR, 'permission-hook.mjs')], { env: { ...process.env, KICKFLIP_HUB_PORT: String(port) } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (status) => resolve({ status, out }));
    child.stdin.end(JSON.stringify(input));
  });
  const needs = async (route) => (await fetch(`${base}/${route}/_claude/needs`)).json();
  let mine;
  await until(async () => { mine = (await needs('orch')).items.find((x) => x.kind === 'Prompt'); return mine; }, 'the permission prompt appears in Orch Needs you');
  assert.deepEqual(mine, { kind: 'Prompt', text: 'Bash: npm test', url: '' });
  assert.match((await needs('orch')).summary, /^1 prompt/);
  assert.equal((await needs('shop')).items.some((x) => x.kind === 'Prompt'), false);
  const { prompt } = (await api('orch')).needs[0];
  assert.deepEqual([prompt.tool, prompt.detail, prompt.rule], ['Bash', 'npm test', 'Bash(npm test)']);
  const waiting = await (await fetch(`${base}/_hub/needs.json?fresh=1`)).json();
  assert.equal(waiting.total, waiting.sites.orch.count + waiting.sites.shop.count);
  assert.ok(waiting.sites.orch.count >= 1);
  await until(() => pushes().some((x) => x.tag === `prompt-${prompt.id}`), 'the permission prompt push arrives');
  assert.deepEqual(pushes().find((x) => x.tag === `prompt-${prompt.id}`), { title: 'Orch wants to run npm test', url: '/orch/', tag: `prompt-${prompt.id}` });

  const r = await fetch(`${base}/_hub/prompts/${prompt.id}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ choice: 'always' }) });
  assert.equal(r.status, 200);
  const { status, out } = await hook;
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(out).hookSpecificOutput.decision, { behavior: 'allow', updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'session' }] });
  assert.equal((await needs('orch')).items.some((x) => x.kind === 'Prompt'), false);
});

test("a command auto mode still refused, or the session still asked about, while its board's permission switch is on is noted under that switch", async () => {
  const manifestFile = claude('kickflip', 'manifest.json');
  const original = read(manifestFile);
  const folder = path.join(home, 'perm-shop');
  const refusals = site('shop', 'data', 'permission-refusals.json');
  write(path.join(folder, '.claude', 'settings.local.json'), { permissions: { allow: ['Bash(git push origin v*)', 'Bash(git push origin main)'] } });
  const changed = read(manifestFile);
  changed.sites.shop.owner = { ...changed.sites.shop.owner, repo: folder };
  const denied = (command, session = 's-shop') => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HUB_DIR, 'permission-denied-hook.mjs')], { env: { ...process.env, KICKFLIP_HUB_PORT: String(port) } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (status) => resolve({ status, out }));
    child.stdin.end(JSON.stringify({ session_id: session, cwd: folder, hook_event_name: 'PermissionDenied', tool_name: 'Bash', tool_input: { command }, reason: 'auto mode' }));
  });
  try {
    await writeManifestFile(changed);
    assert.deepEqual(await denied('git push origin v0.9.0', 's-nobody'), { status: 0, out: '' });
    assert.deepEqual(await denied('npm publish'), { status: 0, out: '' });
    assert.equal(fs.existsSync(refusals), false);
    assert.deepEqual(await denied('git push origin v0.9.0'), { status: 0, out: '' });
    assert.deepEqual(Object.entries(read(refusals)).map(([id, r]) => [id, r.command, r.how]), [['pushTags', 'git push origin v0.9.0', 'denied']]);
    const asked = await fetch(`${base}/_hub/prompts`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 's-shop', cwd: folder, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'git push origin main', description: 'Push' } }) });
    assert.equal(asked.status, 200);
    assert.deepEqual([read(refusals).pushMain.command, read(refusals).pushMain.how], ['git push origin main', 'asked']);
    assert.equal((await fetch(`${base}/_hub/prompts/${(await asked.json()).id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await fetch(`${base}/_hub/permission-denied`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"hook_event_name":"PreToolUse"}' })).status, 400);
  } finally {
    await writeManifestFile(original);
    fs.rmSync(refusals, { force: true });
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('object property names work as page routes and as new boards through HTTP and the CLI', async () => {
  const manifestFile = claude('kickflip', 'manifest.json');
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
    await writeManifestFile(pages);
    assert.equal((await get('/_hub/sidebar.json')).sites.filter((s) => routes.includes(s.route)).length, 4);
    const pageRows = (await get('/_hub/api/hub')).groups.flatMap((g) => g.sites).filter((s) => routes.includes(s.route));
    assert.equal(pageRows.length, 4);
    assert.ok(pageRows.every((s) => s.word && Array.isArray(s.remembered) && s.remembered.length === 0));
    await writeManifestFile(original);
    for (const [i, route] of routes.entries()) {
      const response = await fetch(`${base}/_hub/new-board`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: names[i], github: 'int180-http-test/project', branch: 'main', purpose: 'Review changes' }) });
      assert.equal(response.status, 200, await response.clone().text());
      assert.deepEqual(await response.json(), { route });
      const pending = (await get('/_hub/sidebar.json')).starting.find((s) => s.route === route);
      assert.equal(pending.title, names[i]);
      const joined = await cli(path.join(SKILL, 'bin', 'kickflip.mjs'), ['join', '--name', names[i], '--session', sessions[i], '--template', 'board', '--repo', repo, '--port', String(namedPorts[i])]);
      assert.equal(joined.status, 0, joined.stderr);
      write(site(route, 'board.json'), { title: names[i], slug: route, items: 'data/items.json' });
      write(site(route, 'data', 'items.json'), { items: [{ id: 'constructor', title: 'Review', status: 'planned' }] });
      await until(() => fetch(`${base}/${route}/_claude/health`).then((r) => r.ok, () => false), `${route} server becomes healthy`);
      const side = await get('/_hub/sidebar.json?fresh=1');
      assert.deepEqual(side.starting.filter((s) => s.route === route).map((s) => s.step), ['landing']);
      assert.equal(side.sites.some((s) => s.route === route), false);
      const data = await get(`/${route}/api/board`);
      assert.equal(data.items.find((it) => it.key === `${route}/constructor`).title, 'Review');
      assert.deepEqual(data.items.find((it) => it.key === `${route}/constructor`).agents, []);
      assert.equal((await get(`/${route}/api/thread?key=${route}%2Fconstructor`)).length, 0);
    }
    const checked = await poll();
    assert.ok(routes.every((route) => checked.checked.includes(route)));
    const downSince = () => {
      try { const state = read(claude('kickflip', 'resume-state.json')); return routes.filter((route) => Object.hasOwn(state, route) && Number.isFinite(Date.parse(state[route].down_since))); } catch { return []; }
    };
    await until(() => downSince().length === routes.length, 'all boards record down_since');
    assert.deepEqual(downSince(), routes);
    const rows = (await get('/_hub/api/hub')).groups.flatMap((g) => g.sites);
    for (const route of routes) assert.deepEqual(rows.find((s) => s.route === route).remembered, []);
    assert.equal((await get('/_hub/api/hub')).polling.lines.length, 2);
  } finally { await writeManifestFile(original); fs.rmSync(path.join(reposDir(), 'int180-http-test'), { recursive: true, force: true }); }
});

const getJSON = async (url) => (await fetch(base + url)).json();

test('a no-JS Quiet hours edit saves and redirects to Hub with Quiet hours open; a bad time is refused', async () => {
  const file = claude('kickflip', 'settings.json');
  const original = fs.readFileSync(file);
  const post = (body) => fetch(`${base}/_hub/settings/quiet`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, redirect: 'manual' });
  try {
    const r = await post('start=23%3A30');
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/_hub/#quiet');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).quiet, { start: '23:30', end: '00:00', hold: false });
    const quiet = (await getJSON('/_hub/api/settings')).quiet;
    assert.equal(quiet.hint, "checks every minute while you're here, every 5 when away");
    assert.equal((await post('end=25%3A00')).status, 400);
    assert.equal((await post('set=hold&value=on')).status, 303);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).quiet.hold, true);
  } finally { fs.writeFileSync(file, original); }
});

test("a page's presence beat makes the owner present, which the sidebar and the hub page read", async () => {
  const r = await fetch(`${base}/_hub/presence`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 204);
  assert.equal((await getJSON('/_hub/sidebar.json')).away, false);
  assert.match((await getJSON('/_hub/api/hub')).polling.title, /^Checks every minute while you’re here/);
});

test("a board page's wake asks the hub for one session check now, from the app's own pages only, and answers with the board's listen state", async () => {
  const wake = (body, headers = { 'content-type': 'application/json' }) => fetch(`${base}/_hub/wake`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await wake({ route: 'shop' }, { 'content-type': 'application/json', origin: 'https://other.example' })).status, 403);
  assert.equal((await wake({ route: 'nope' })).status, 404);
  const r = await wake({ route: 'shop' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { route: 'shop', listen: 'deaf' });
});

test('a starting hub makes the hub board a local board of its own folder once, recording its origin and branch, and flags no board by its route', async () => {
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'boards-migrate-')));
  const file = path.join(other, '.claude', 'kickflip', 'manifest.json');
  const writeManifestFile = (m) => withFileLock(file, () => saveJSON(file, m));
  const board = (name, at) => ({ dir: path.join(other, name), port: at, cmd: [process.execPath, path.join(SKILL, 'board', 'server.mjs'), path.join(other, name)] });
  const startHub = async () => {
    const h = spawn(process.execPath, [path.join(HUB_DIR, 'hub.mjs')], { env: { ...process.env, HOME: other, KICKFLIP_HUB_PORT: String(hubPort), KICKFLIP_CLAUDE: '/usr/bin/false', KICKFLIP_TMUX: '/usr/bin/false' } });
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
  const folder = path.join(other, 'kickflip-clone');
  fs.mkdirSync(folder, { recursive: true });
  execFileSync('git', ['-C', folder, 'init', '--quiet', '-b', 'main']);
  execFileSync('git', ['-C', folder, 'remote', 'add', 'origin', 'git@github.com:owner/kickflip.git']);
  try {
    await startHub();
    assert.equal(fs.existsSync(file), false);
    await writeManifestFile({ sites: { 'hub-orchestrator': board('hub', hubBoardPort), dev: { ...board('dev', devPort), hub: true, owner: { session: 's-dev', repo: folder } } } });
    await startHub();
    const dev = read(file).sites.dev;
    assert.deepEqual([flagged(), dev.local, dev.github, dev.branch, dev.owner, read(file).migrated], [['dev'], true, 'owner/kickflip', 'main', { session: 's-dev', repo: folder }, ['board-github', 'hub-local']]);
    const cleared = read(file);
    delete cleared.sites.dev.local;
    delete cleared.sites.dev.hub;
    await writeManifestFile(cleared);
    await startHub();
    assert.deepEqual([flagged(), read(file).sites.dev.local], [[], undefined]);
  } finally { fs.rmSync(other, { recursive: true, force: true }); }
});

test('stopping the hub stops every site it started, one that ignores SIGTERM and one that joined just before, and starts none', async () => {
  const sitesDir = claude('kickflip', 'sites');
  const siteProcs = () => execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').filter((l) => l.includes(sitesDir)).map((l) => Number(l.trim().split(' ')[0]));
  const node = (route, script) => [process.execPath, '-e', script, site(route)];
  const manifest = read(claude('kickflip', 'manifest.json'));
  manifest.sites.stubborn = { dir: home, port: stubbornPort, cmd: node('stubborn', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)") };
  await writeManifestFile(manifest);
  const log = claude('kickflip', 'logs', 'stubborn.log');
  await until(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('ready'), 'the stubborn server logs ready');
  assert.match(fs.readFileSync(log, 'utf8'), /ready/);
  manifest.sites.late = { dir: home, port: latePort, cmd: node('late', 'setInterval(() => {}, 1000)') };
  await writeManifestFile(manifest);
  const exited = new Promise((resolve) => hub.once('exit', resolve));
  hub.kill('SIGTERM');
  await exited;
  try {
    await until(() => siteProcs().length === 0, 'all site processes stop after the hub exits');
    assert.deepEqual(siteProcs(), []);
  } finally { for (const pid of siteProcs()) { try { process.kill(pid, 'SIGKILL'); } catch {} } }
});
