// The setup and helpers the board-*.test.mjs files share, split from one file by command: a scratch HOME per test
// with the orch and audit boards, and helpers that run board.mjs and its sibling scripts there. home is a live
// binding, reassigned before each test.
import { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import util from 'node:util';
import { fileURLToPath } from 'node:url';
import { main } from './bin/board.mjs';
import { startFakeDevice } from '../hub/fake-device.mjs';
import { fakeLinear, linearWorld } from '../shared/test-helpers.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

export const bin = (name) => path.join(path.dirname(fileURLToPath(import.meta.url)), 'bin', name);
export let home;
export const at = (...p) => path.join(home, '.claude', ...p);
export const site = (route, ...p) => at('kickflip', 'sites', route, ...p);
export const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
export const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
export const lines = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
// The launch claim the board takes when it launches the card's agent (headless.mjs launchLives), held by this test's
// process, so a build's builder start on the board at route has a launch to take up.
export const launched = (route, key, agent = 'main') => write(site(route, 'data', 'launches', encodeURIComponent(`${key}~${agent}`)), { owner: process.pid });

export const pushStub = () => path.join(home, 'push-stub.mjs');
const cliEnv = (env) => {
  write(pushStub(), "import fs from 'node:fs'; fs.appendFileSync(process.env.STUB_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n'); console.log(process.env.STUB_SAY || 'sent'); process.exit(Number(process.env.STUB_EXIT || 0));");
  const pushEnv = { KICKFLIP_PUSH_CMD: JSON.stringify([process.execPath, pushStub(), 'push']), STUB_CALLS: path.join(home, 'push-calls.jsonl') };
  return { HOME: home, KICKFLIP_HUB_PORT: '1', KICKFLIP_RENDER_CHECK: 'off', ...pushEnv, ...env };
};
// Runs a script in its own node process. The board's own commands go through boardWith, in-process; this is for a command
// that reads stdin, the CLI's exit codes and usage, and the board's sibling scripts.
export function run(script, args, input, env = {}) {
  const r = spawnSync(process.execPath, [bin(script), ...args], { env: { ...process.env, ...cliEnv(env) }, input, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
// Runs board.mjs's main in this process with the test's HOME and env, and returns what a node process of it would:
// its exit code and what it printed. A thrown error exits 1 with its stack, as node does.
export async function boardWith(args, env = {}) {
  return boardAs(withNotes(args), env);
}
// item add refuses a task with no notes, so the tests that file cards for another purpose get a stub; the refusal's own
// tests spawn the CLI with run, which adds nothing.
export const withNotes = (args) => {
  const i = args.findIndex((a, n) => a === 'item' && args[n + 1] === 'add');
  return i < 0 || args.some((a) => ['--notes', '--notes-from', '--from-ask', '--ask'].includes(a)) ? args : [...args, '--notes', 'Notes.'];
};
async function boardAs(args, env) {
  const set = cliEnv(env);
  const saved = Object.fromEntries(Object.keys(set).map((k) => [k, process.env[k]]));
  Object.assign(process.env, set);
  const out = [], err = [];
  const { log, error } = console;
  console.log = (...a) => out.push(util.format(...a) + '\n');
  console.error = (...a) => err.push(util.format(...a) + '\n');
  try {
    let code;
    try { code = await main(args); } catch (e) { err.push(util.inspect(e) + '\n'); code = 1; }
    return { code, out: out.join(''), err: err.join('') };
  } finally {
    Object.assign(console, { log, error });
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}
export const board = (...args) => boardWith(args);
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

export const wave = () => ({ title: 'W', items: [{ id: 'A1', title: 'feat: one', next: 'Old' }, { id: 'ENG-1', title: 'feat: later', created: '2026-10-22', parent: 'A1' }] });
export const question = (id, extra = {}) => ({ id, topic: 'site', question: 'Keep it?', options: [{ id: 'A', label: 'Keep', recommended: true }, { id: 'B', label: 'Drop' }], ...extra });

beforeEach(() => {
  home = tempDir('board-');
  write(at('waves', 'w', 'wave.json'), wave());
  write(site('orch', 'board.json'), { title: 'Orch', items: 'waves' });
  write(site('orch', 'data', 'owner.json'), { topics: [{ id: 'site', title: 'Site' }], items: [] });
  write(site('orch', 'data', 'events.jsonl'), JSON.stringify({ id: 'e1', ts: '2026-10-23T10:00:00Z', kind: 'ask', data: {} }) + '\n');
  write(site('audit', 'board.json'), { title: 'Audit', items: 'data/items.json', slug: 'audit' });
  write(site('audit', 'data', 'items.json'), wave());
});

export async function ticketCli(t) {
  const { saveBoardSettings } = await import('./store.mjs');
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
    if (argv[1] === 'close' || argv[1] === 'edit') return { status: 0, stdout: '' };
    return { status: 0, stdout: `https://github.com/${repo}/issues/42\n` };
  };
  const cli = (...args) => main(withNotes(['--site', 'audit', ...args]), { linearFetch: linear.fetch, run });
  const item = (id) => read(site('audit', 'data', 'items.json')).items.find((it) => it.id === id);
  return { saveBoardSettings, main, out, err, world, linear, gh, ghAnswers, cli, item };
}

export const takePath = (topic, key) => site('orch', 'public', 'prototypes', topic, `${key}.js`);
export async function recordPrototype(topic = 'site', takes = ['A:Keep', 'B:Drop'], files = true) {
  const r = await board('prototype', 'add', topic, '--site', 'orch', '--title', 'Site', ...takes.flatMap((t) => ['--take', t]));
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
// The scratch repo's one base commit, made once per test file and copied into each test that asks for it.
let baseRepo;
function makeBaseRepo() {
  const repo = path.join(tempDir('board-repo-'), 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '--quiet', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  // docs/adr/2026-11-16-1930-test-repos-run-no-background-git-maintenance.md: a commit otherwise starts a detached
  // git maintenance whose objects/maintenance.lock a copy of the repo can list and then miss.
  git(repo, 'config', 'maintenance.auto', 'false');
  write(path.join(repo, 'hub', 'hub.mjs'), "import { a } from '../shared/lib.mjs';\n");
  write(path.join(repo, 'shared', 'lib.mjs'), 'export const a = 1;\n');
  write(path.join(repo, 'shared', 'notes.md'), 'a\n');
  write(path.join(repo, 'board', 'server.mjs'), '1\n');
  write(path.join(repo, 'ok.test.mjs'), "import test from 'node:test';\ntest('ok', () => {});\n");
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', 'base');
  return repo;
}
export function scratchRepo() {
  const repo = path.join(home, 'repo');
  baseRepo ??= makeBaseRepo();
  fs.cpSync(baseRepo, repo, { recursive: true });
  write(at('kickflip', 'manifest.json'), { sites: {
    orch: { dir: site('orch'), port: 1, cmd: ['node', '/x/board/server.mjs'] },
    audit: { dir: site('audit'), port: 2, cmd: ['node', '/x/board/server.mjs'] },
  } });
  // A finish lands at once with Auto-merge on; heldBoard turns it off.
  write(site('orch', 'board.json'), { ...read(site('orch', 'board.json')), auto_merge: true, github_login: 'Me' });
  return repo;
}
// docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md: Auto-merge off holds a verified build for the owner's Merge.
export const heldBoard = () => write(site('orch', 'board.json'), { ...read(site('orch', 'board.json')), auto_merge: false });
export const worktree = () => at('kickflip', 'worktrees', 'A1');
export const land = () => boardWith(['land', 'w/A1']);
export const branches = (repo) => git(repo, 'branch', '--format=%(refname:short)').split('\n');

// docs/adr/2026-11-04-1611-finishing-a-build-is-one-step.md
export const onOrch = (...args) => boardWith(['--site', 'orch', ...args]);
export const record = (id = 'A1') => read(at('waves', 'w', 'agents', `${id}.json`));
export const itemOf = (id = 'A1') => read(at('waves', 'w', 'wave.json')).items.find((i) => i.id === id);
export const threadOf = (id = 'A1') => lines(site('orch', 'data', 'threads', `w__${id}.jsonl`));

// Points the store, called in process, at this test's HOME until the test ends.
export function onHome(t) {
  const old = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = old; });
}

// The poll loop of store.listAsks or store.waitHelper on the test's clock: t.mock.timers holds Date and the loop's
// setTimeout, and pass now to the call. The loop's first now() sets its deadline; each later one checks it, after the
// loop has read the files and right before it sets its timer, so checked() resolves when the loop is about to sleep
// and the test ticks from there. → {now, checked}
export function pollClock(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  let reads = 0;
  let wake = () => {};
  const now = () => {
    if (reads++) wake();
    return Date.now();
  };
  const checked = () => new Promise((resolve) => { wake = resolve; });
  return { now, checked };
}

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
  const urls = Object.fromEntries(['store', 'slack-store', 'domain', 'review', 'snapshot'].map((name) => [name, new URL(`./${name}.mjs`, import.meta.url).href]));
  const script = `import * as store from ${JSON.stringify(urls.store)};
    import { readPRSlack } from ${JSON.stringify(urls['slack-store'])};
    import { buildBoard } from ${JSON.stringify(urls.domain)};
    import { topicItems } from ${JSON.stringify(urls.review)};
    import { outsideData, readSnapshot } from ${JSON.stringify(urls.snapshot)};
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
    const itemFile = await store.readJSON(${JSON.stringify(at('waves', 'w', 'wave.json'))}, {});
    const prs = { 'o/r#7': { state: 'OPEN', isDraft: false } };
    const card = buildBoard({ ...await readSnapshot(site, await outsideData(site)), prs }).items.find((i) => i.key === 'w/A1');
    const board = { dir: site, reviewers: ['Ann', 'Bob'], files: [{slug: 'w', itemFile}], prs: [{file: 'w', id: 'A1', pr: 7, repo: 'o/r'}] };
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
