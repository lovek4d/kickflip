// The setup and helpers the board-*.test.mjs files share, split from one file by command: a scratch HOME per test
// with the orch and audit boards, and helpers that run board.mjs and its sibling scripts there. home is a live
// binding, reassigned before each test.
import { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFakeDevice } from '../hub/fake-device.mjs';
import { fakeLinear, linearWorld } from '../shared/test-helpers.mjs';

export const bin = (name) => path.join(path.dirname(fileURLToPath(import.meta.url)), 'bin', name);
export let home;
export const at = (...p) => path.join(home, '.claude', ...p);
export const site = (route, ...p) => at('kickflip', 'sites', route, ...p);
export const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
export const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
export const lines = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

export const pushStub = () => path.join(home, 'push-stub.mjs');
export function run(script, args, input, env = {}) {
  write(pushStub(), "import fs from 'node:fs'; fs.appendFileSync(process.env.STUB_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n'); console.log(process.env.STUB_SAY || 'sent'); process.exit(Number(process.env.STUB_EXIT || 0));");
  const pushEnv = { KICKFLIP_PUSH_CMD: JSON.stringify([process.execPath, pushStub(), 'push']), STUB_CALLS: path.join(home, 'push-calls.jsonl') };
  const r = spawnSync(process.execPath, [bin(script), ...args], { env: { ...process.env, HOME: home, KICKFLIP_HUB_PORT: '1', ...pushEnv, ...env }, input, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
export const board = (...args) => run('board.mjs', args);
export function runAsync(script, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin(script), ...args], { env: { ...process.env, HOME: home, KICKFLIP_HUB_PORT: '1', ...env } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}
export async function withDevice(fn) {
  const device = await startFakeDevice();
  write(at('kickflip', 'push', 'subs.json'), [device.subscription]);
  write(at('kickflip', 'settings.json'), { quiet: { start: '23:59', end: '00:00', hold: false } });
  const b = (...args) => runAsync('board.mjs', args, { KICKFLIP_HUB_PORT: String(device.port) });
  try { await fn(b, device.received); } finally { await device.close(); }
}

export const wave = () => ({ title: 'W', items: [{ id: 'A1', title: 'One', next: 'Old' }, { id: 'ENG-1', title: 'Later', created: '2026-10-22', parent: 'A1' }] });
export const question = (id, extra = {}) => ({ id, topic: 'site', question: 'Keep it?', options: [{ id: 'A', label: 'Keep', recommended: true }, { id: 'B', label: 'Drop' }], ...extra });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'board-'));
  write(at('waves', 'w', 'wave.json'), wave());
  write(site('orch', 'board.json'), { title: 'Orch', items: 'waves' });
  write(site('orch', 'data', 'owner.json'), { topics: [{ id: 'site', title: 'Site' }], items: [] });
  write(site('orch', 'data', 'events.jsonl'), JSON.stringify({ id: 'e1', ts: '2026-10-23T10:00:00Z', kind: 'ask', data: {} }) + '\n');
  write(site('audit', 'board.json'), { title: 'Audit', items: 'data/wave.json', slug: 'audit' });
  write(site('audit', 'data', 'wave.json'), wave());
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

export async function ticketCli(t) {
  const { saveBoardSettings } = await import('./store.mjs');
  const { main } = await import('./bin/board.mjs');
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; });
  const out = [], err = [];
  t.mock.method(console, 'log', (...args) => out.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => err.push(args.join(' ')));
  const world = linearWorld();
  const linear = fakeLinear(world);
  write(at('kickflip', 'secrets.json'), { linear: { key: world.key, workspace: 'Acme', url_key: 'acme', viewer: world.viewer } });
  const gh = [];
  const ghAnswers = { view: { state: 'OPEN', assignees: [{ login: 'someone' }] }, login: 'love' };
  const run = async (cmd, argv) => {
    gh.push(argv);
    const repo = argv[argv.indexOf('--repo') + 1];
    if (argv[0] === 'api') return { status: 0, stdout: `${ghAnswers.login}\n` };
    if (argv[1] === 'view' && argv.includes('state,assignees')) return { status: 0, stdout: JSON.stringify(ghAnswers.view) };
    if (argv[1] === 'view') return { status: 0, stdout: JSON.stringify({ number: Number(argv[2]), url: `https://github.com/${repo}/issues/${argv[2]}` }) };
    if (argv[1] === 'close') return { status: 0, stdout: '' };
    return { status: 0, stdout: `https://github.com/${repo}/issues/42\n` };
  };
  const cli = (...args) => main(['--site', 'audit', ...args], { linearFetch: linear.fetch, run });
  const item = (id) => read(site('audit', 'data', 'wave.json')).items.find((it) => it.id === id);
  return { saveBoardSettings, main, out, err, world, linear, gh, ghAnswers, cli, item };
}

export const takePath = (topic, key) => site('orch', 'public', 'prototypes', topic, `${key}.js`);
export function recordPrototype(topic = 'site', takes = ['A:Keep', 'B:Drop'], files = true) {
  const r = board('prototype', 'add', topic, '--site', 'orch', '--title', 'Site', ...takes.flatMap((t) => ['--take', t]));
  assert.equal(r.code, 0, r.err);
  if (files) for (const t of takes) write(takePath(topic, t[0]), 'export function render(stage) {}');
}
export const addPrototypeQuestion = (url = 'prototype-site.html?q=q1', extra = {}) => {
  write(path.join(home, 'q.json'), question('q1', { url, ...extra }));
  return board('question', 'add', '--site', 'orch', '--file', path.join(home, 'q.json'));
};
export const confirmFor = (id, take = 'A') => ({ id: `${id}-confirm`, question: 'Is this it?', url: `prototype-site.html?q=${id}-confirm`, options: [{ id: take, label: 'Keep' }], round: 1, confirm_of: id });
export function addConfirm(id, answered) {
  const file = site('orch', 'data', 'owner.json');
  const owner = read(file);
  owner.items.push({ ...confirmFor(id), topic: owner.items.find((q) => q.id === id).topic });
  write(file, owner);
  if (answered) addEvents({ id: `answer-${id}-confirm`, ts: '2026-10-23T12:00:00Z', kind: 'owner-answer', data: { id: `${id}-confirm`, choice: 'A' } });
}
export const prototypeRefusal = (result, line) => {
  assert.deepEqual(result, { code: 1, out: '', err: line + '\n' });
  assert.deepEqual(read(site('orch', 'data', 'owner.json')).items, []);
};

export const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
export const commit = (dir, file, text, subject = `change ${file}`) => { write(path.join(dir, file), text); git(dir, 'add', '-A'); git(dir, 'commit', '--quiet', '-m', subject); };
export function scratchRepo() {
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '--quiet', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  write(path.join(repo, 'hub', 'hub.mjs'), "import { a } from '../shared/lib.mjs';\n");
  write(path.join(repo, 'shared', 'lib.mjs'), 'export const a = 1;\n');
  write(path.join(repo, 'shared', 'notes.md'), 'a\n');
  write(path.join(repo, 'board', 'server.mjs'), '1\n');
  write(path.join(repo, 'ok.test.mjs'), "import test from 'node:test';\ntest('ok', () => {});\n");
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', 'base');
  write(at('kickflip', 'manifest.json'), { sites: {
    orch: { dir: site('orch'), port: 1, cmd: ['node', '/x/board/server.mjs'] },
    audit: { dir: site('audit'), port: 2, cmd: ['node', '/x/board/server.mjs'] },
  } });
  // A finish lands at once with Auto-merge on; heldBoard turns it off.
  write(site('orch', 'board.json'), { ...read(site('orch', 'board.json')), auto_merge: true });
  return repo;
}
// docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md: Auto-merge off holds a verified build for the owner's Merge.
export const heldBoard = () => write(site('orch', 'board.json'), { ...read(site('orch', 'board.json')), auto_merge: false });
export const worktree = () => at('kickflip', 'worktrees', 'A1');
export const restarts = () => (fs.existsSync(path.join(home, 'restarts')) ? fs.readFileSync(path.join(home, 'restarts'), 'utf8').trim().split('\n') : []);
export const land = () => run('board.mjs', ['land', 'w/A1'], undefined, {
  KICKFLIP_RESTART_CMD: JSON.stringify([process.execPath, '-e', "require('fs').appendFileSync(process.argv[1], process.argv.slice(2).join(' ') + '\\n')", path.join(home, 'restarts')]),
});
export const branches = (repo) => git(repo, 'branch', '--format=%(refname:short)').split('\n');

// docs/adr/2026-11-04-1611-finishing-a-build-is-one-step.md
export const finishEnv = { KICKFLIP_RESTART_CMD: JSON.stringify([process.execPath, '-e', '0']) };
export const onOrch = (...args) => run('board.mjs', ['--site', 'orch', ...args], undefined, finishEnv);
export const record = (id = 'A1') => read(at('waves', 'w', 'agents', `${id}.json`));
export const itemOf = (id = 'A1') => read(at('waves', 'w', 'wave.json')).items.find((i) => i.id === id);
export const threadOf = (id = 'A1') => lines(site('orch', 'data', 'threads', `w__${id}.jsonl`));

// A shared clone of origin (the scratch repo), on a board whose repo is origin's GitHub project, or a plain git remote.
export function remoteBoard(fields) {
  const origin = scratchRepo();
  const clone = path.join(home, 'clone');
  git(home, 'clone', '--quiet', origin, clone);
  // HOME is the test's own, so no global identity: without these git guesses one from the hostname, which fails on Linux.
  git(clone, 'config', 'user.name', 'Test');
  git(clone, 'config', 'user.email', 'test@example.com');
  const manifest = read(at('kickflip', 'manifest.json'));
  Object.assign(manifest.sites.orch, { branch: 'main', owner: { repo: clone }, ...fields(origin) });
  write(at('kickflip', 'manifest.json'), manifest);
  return origin;
}

// docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md
export const tapMerge = (id = 'A1') => {
  const wave = read(at('waves', 'w', 'wave.json'));
  wave.items.find((i) => i.id === id).merge_ready.tapped = new Date().toISOString();
  write(at('waves', 'w', 'wave.json'), wave);
};

export const toolUse = (id, command, ts) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
export const toolResult = (id, ts) => JSON.stringify({ type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
export const stopHook = (input) => run('builder-stop-hook.mjs', [], typeof input === 'string' ? input : JSON.stringify({ hook_event_name: 'SubagentStop', agent_id: 'a1', ...input }));
export const ago = (ms) => new Date(Date.now() - ms).toISOString();

export function boardsManifest() {
  const entry = (route) => ({ dir: site(route), port: 1, cmd: [process.execPath, '/skill/board/server.mjs', site(route)] });
  write(at('kickflip', 'manifest.json'), { sites: { orch: entry('orch'), audit: entry('audit'), notes: { dir: site('notes'), port: 1, cmd: [process.execPath, 'server.mjs'] } } });
}
export const addEvents = (...events) => fs.appendFileSync(site('orch', 'data', 'events.jsonl'), events.map((e) => JSON.stringify(e) + '\n').join(''));

export function reviewProbe(source) {
  const urls = Object.fromEntries(['store', 'domain', 'review'].map((name) => [name, new URL(`./${name}.mjs`, import.meta.url).href]));
  const script = `import * as store from ${JSON.stringify(urls.store)};
    import { buildBoard } from ${JSON.stringify(urls.domain)};
    import { topicItems } from ${JSON.stringify(urls.review)};
    import { linksOf } from ${JSON.stringify(new URL('../hub/boards.mjs', import.meta.url).href)};
    const site = ${JSON.stringify(site('orch'))};
    ${source}`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
export const annReviewer = { name: 'Ann', slack_user: 'U1', dm: 'D1', github: 'ann' };
export const bobReviewer = { name: 'Bob', slack_user: 'U2', dm: 'D2', github: 'bob' };

export function reviewState() {
  return reviewProbe(`
    const wave = await store.readJSON(${JSON.stringify(at('waves', 'w', 'wave.json'))}, {});
    const prs = { 'o/r#7': { state: 'OPEN', isDraft: false } };
    const card = buildBoard({ waves: [{slug: 'w', wave}], prs, topicItems: topicItems(), prSlack: await store.readPRSlack(site) }).items[0];
    const board = { dir: site, reviewers: ['Ann', 'Bob'], waves: [{slug: 'w', wave}], prs: [{wave: 'w', id: 'A1', pr: 7, repo: 'o/r'}] };
    console.log(JSON.stringify({ card, slack: linksOf(board, { github: {prs}, listen: 'listening', settings: { quiet: { start: '22:00', end: '08:00', hold: true } }, wakes: {}, faults: {} }).find((l) => l.link === 'slack') }));
  `);
}

export const slackToken = (extra = {}) => write(at('kickflip', 'secrets.json'), { slack: { token: 'xoxp-test-token', team: 'Acme', user: 'love', ...extra } });

export function digestCommand(args, now) {
  const script = `import {main} from ${JSON.stringify(new URL('./bin/board.mjs', import.meta.url).href)};
    process.exitCode = await main(${JSON.stringify(['--site', 'orch', 'review', 'digest', ...args])}, {now: new Date(${JSON.stringify(now)})});`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return args.length ? r.stdout : JSON.parse(r.stdout);
}
