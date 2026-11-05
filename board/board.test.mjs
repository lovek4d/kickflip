import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFakeDevice } from '../hub/fake-device.mjs';
import { freePorts, fakeLinear, linearWorld, until } from '../shared/test-helpers.mjs';
import http from 'node:http';
import { land as landWorktree } from './worktree.mjs';
import { fakeGh, prView, writePR, writeIssueComments, writeReviews, writeMerge, writeUser, writeAccounts, calls, tokens } from '../shared/fake-gh.mjs';

const bin = (name) => path.join(path.dirname(fileURLToPath(import.meta.url)), 'bin', name);
let home;
const at = (...p) => path.join(home, '.claude', ...p);
const site = (route, ...p) => at('kickflip', 'sites', route, ...p);
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const lines = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

const pushStub = () => path.join(home, 'push-stub.mjs');
function run(script, args, input, env = {}) {
  write(pushStub(), "import fs from 'node:fs'; fs.appendFileSync(process.env.STUB_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n'); console.log(process.env.STUB_SAY || 'sent'); process.exit(Number(process.env.STUB_EXIT || 0));");
  const pushEnv = { KICKFLIP_PUSH_CMD: JSON.stringify([process.execPath, pushStub(), 'push']), STUB_CALLS: path.join(home, 'push-calls.jsonl') };
  const r = spawnSync(process.execPath, [bin(script), ...args], { env: { ...process.env, HOME: home, KICKFLIP_HUB_PORT: '1', ...pushEnv, ...env }, input, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const board = (...args) => run('board.mjs', args);
function runAsync(script, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin(script), ...args], { env: { ...process.env, HOME: home, KICKFLIP_HUB_PORT: '1', ...env } });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}
async function withDevice(fn) {
  const device = await startFakeDevice();
  write(at('kickflip', 'push', 'subs.json'), [device.subscription]);
  write(at('kickflip', 'settings.json'), { quiet: { start: '23:59', end: '00:00', hold: false } });
  const b = (...args) => runAsync('board.mjs', args, { KICKFLIP_HUB_PORT: String(device.port) });
  try { await fn(b, device.received); } finally { await device.close(); }
}

const wave = () => ({ title: 'W', items: [{ id: 'A1', title: 'One', next: 'Old' }, { id: 'ENG-1', title: 'Later', created: '2026-10-22', parent: 'A1' }] });
const question = (id, extra = {}) => ({ id, topic: 'site', question: 'Keep it?', options: [{ id: 'A', label: 'Keep', recommended: true }, { id: 'B', label: 'Drop' }], ...extra });

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

test('the fixed build script has no owner path setting or command override', () => {
  assert.notEqual(board('--site', 'orch', 'settings', 'set', 'install-script', '/tmp/script').code, 0);
  assert.notEqual(board('--site', 'orch', 'build', 'w/A1', '--script', '/tmp/script').code, 0);
  assert.match(board('build', 'w/A1').err, /needs --site/);
});

test('install posts only the route and key to the hub once it quotes the owner, prints started, and reports refusals plainly', async () => {
  fs.appendFileSync(site('orch', 'data', 'events.jsonl'), JSON.stringify({ id: 'e2', ts: '2026-10-23T11:00:00Z', kind: 'item-message', data: { key: 'w/A1', text: 'Please build A1 so I can\n try it' } }) + '\n');
  const seen = [];
  let refuse = false;
  const hub = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push([req.method, req.url, JSON.parse(body)]);
    res.writeHead(refuse ? 409 : 202, { 'content-type': 'application/json' });
    res.end(JSON.stringify(refuse ? { error: 'An install build is already running for this card.' } : { status: 'started' }));
  });
  await new Promise((resolve, reject) => hub.once('error', reject).listen(0, '127.0.0.1', resolve));
  try {
    const env = { KICKFLIP_HUB_PORT: String(hub.address().port) };
    const run = () => runAsync('board.mjs', ['--site', 'orch', 'install', 'w/A1', '--asked', 'build a1 so I can try'], env);
    for (const asked of [[], ['--asked', 'just build it']]) {
      const refused = await runAsync('board.mjs', ['--site', 'orch', 'build', 'w/A1', ...asked], env);
      assert.equal(refused.code, 1);
      assert.match(refused.err, asked.length ? /--asked must quote the owner's words/ : /pass --asked/);
    }
    assert.deepEqual(seen, []);
    assert.deepEqual(await run(), { code: 0, out: 'started\n', err: '' });
    assert.deepEqual(seen, [['POST', '/_hub/build', { route: 'orch', key: 'w/A1' }]]);
    assert.deepEqual(lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).map(({ who, text }) => [who, text]), [['claude', 'Running at the owner\'s ask: "build a1 so I can try"']]);
    refuse = true;
    assert.deepEqual(await run(), { code: 1, out: '', err: 'An install build is already running for this card.\n' });
  } finally { await new Promise((resolve) => { hub.closeAllConnections(); hub.close(resolve); }); }
});

test('reply answers a known event, naming its card, and refuses an unknown one', () => {
  assert.deepEqual(board('reply', 'e1', '--site', 'orch', '--html', '<p>Done.</p>'), { code: 0, err: '', out: 'reply written to task e1\n' });
  assert.equal(fs.readFileSync(site('orch', 'data', 'replies', 'e1.html'), 'utf8'), '<p>Done.</p>');
  assert.equal(run('board.mjs', ['reply', 'e1', '--site', 'orch', '--file', '-'], '<p>Again.</p>').code, 0);
  assert.equal(fs.readFileSync(site('orch', 'data', 'replies', 'e1.html'), 'utf8'), '<p>Again.</p>');
  write(at('waves', 'internal', 'wave.json'), { internal: true, items: [{ id: 'S80', title: 'Legacy' }] });
  fs.appendFileSync(site('orch', 'data', 'events.jsonl'), JSON.stringify({ id: 'e2', ts: '2026-10-23T11:00:00Z', kind: 'item-message', data: { key: 'internal/S80', text: 'Still on?' } }) + '\n');
  assert.deepEqual(board('reply', 'e2', '--site', 'orch', '--html', '<p>Yes.</p>'), { code: 0, err: '', out: 'reply written to INT-80\n' });
  const r = board('reply', 'e9', '--site', 'orch', '--html', 'x');
  assert.equal(r.code, 1);
  assert.match(r.err, /no event "e9"/);
  assert.equal(fs.existsSync(site('orch', 'data', 'replies', 'e9.html')), false);
  assert.deepEqual(read(at('waves', 'w', 'wave.json')), wave());
  assert.equal(lines(site('orch', 'data', 'events.jsonl')).some((e) => e.ticket), false);
});

test('reply refuses a file path passed as --html, which would post the path itself', () => {
  const r = board('reply', 'e1', '--site', 'orch', '--html', '/tmp/scratch/answer.html');
  assert.equal(r.code, 2);
  assert.match(r.err, /--file \/tmp\/scratch\/answer\.html/);
  assert.equal(fs.existsSync(site('orch', 'data', 'replies', 'e1.html')), false);
});

test('every text flag refuses a bare file path, and --file refuses a missing file', () => {
  const real = path.join(home, 'notes');
  write(real, 'hello');
  const thread = board('thread', 'w/A1', '--site', 'orch', '--text', real);
  assert.equal(thread.code, 2);
  assert.match(thread.err, /--text takes text, not a file path/);
  assert.doesNotMatch(thread.err, /for a file use/);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--next', './plan.md').code, 2);
  assert.equal(board('thread', 'w/A1', '--site', 'orch', '--text', `Wrote ${real} for you`).code, 0);
  const missing = board('reply', 'e1', '--site', 'orch', '--file', path.join(home, 'nope.html'));
  assert.equal(missing.code, 2);
  assert.match(missing.err, /no such file/);
});

test('item add records creation on a card with no status, waiting when it has deps, and refuses a taken id, an unknown dep, or a --summary', () => {
  const before = Date.now();
  const withoutCreated = (item) => {
    const { created, ...rest } = item;
    const ts = Date.parse(created);
    assert.ok(ts >= before && ts <= Date.now());
    assert.equal(created, new Date(ts).toISOString());
    return rest;
  };
  const summed = board('item', 'add', 'w/B2', '--site', 'orch', '--title', 'Two', '--notes', 'Why', '--summary', 'Asked why.');
  assert.equal(summed.code, 2);
  assert.match(summed.err, /item add does not take --summary/);
  assert.equal(board('item', 'add', 'w/B2', '--site', 'orch', '--title', 'Two', '--notes', 'Why').code, 0);
  assert.deepEqual(withoutCreated(read(at('waves', 'w', 'wave.json')).items.at(-1)), { id: 'B2', title: 'Two', notes: 'Why', unfiled: true, ticket: 'INT-1' });
  assert.equal(board('item', 'add', 'w/C3', '--site', 'orch', '--title', 'Three', '--deps', 'A1,B2').code, 0);
  assert.deepEqual(withoutCreated(read(at('waves', 'w', 'wave.json')).items.at(-1)), { id: 'C3', title: 'Three', deps: ['A1', 'B2'], status: 'waiting', unfiled: true, ticket: 'INT-2' });
  const taken = board('item', 'add', 'w/A1', '--site', 'orch', '--title', 'Again');
  assert.equal(taken.code, 1);
  assert.match(taken.err, /already has an item "A1"/);
  const dep = board('item', 'add', 'w/D4', '--site', 'orch', '--title', 'Four', '--deps', 'Z9');
  assert.equal(dep.code, 1);
  assert.match(dep.err, /no item "Z9"/);
  assert.equal(read(at('waves', 'w', 'wave.json')).items.length, 4);
  assert.equal(board('item', 'add', 'audit/E5', '--site', 'audit', '--title', 'Five').code, 0);
  assert.deepEqual(withoutCreated(read(site('audit', 'data', 'wave.json')).items.at(-1)), { id: 'E5', title: 'Five', unfiled: true, ticket: 'INT-1' });
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].created, undefined);
});

test('tickets validate prefixes and link or create in the board source through the CLI and an injected GitHub runner', async (t) => {
  const { saveBoardSettings } = await import('./store.mjs');
  const { main } = await import('./bin/board.mjs');
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; });
  const out = [], err = [], calls = [];
  t.mock.method(console, 'log', (...args) => out.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => err.push(args.join(' ')));
  const cfg = read(site('audit', 'board.json'));
  for (const prefix of ['I', 'TOOLONG', 'AB2', 'ab', ' AB', null]) await assert.rejects(async () => saveBoardSettings(site('audit'), { tickets: { source: 'internal', prefix } }), /2–6 uppercase letters/);
  assert.deepEqual(read(site('audit', 'board.json')), cfg);
  await saveBoardSettings(site('audit'), { tickets: { source: 'internal', prefix: '' } });
  assert.deepEqual(read(site('audit', 'board.json')).tickets, { source: 'internal', prefix: 'INT' });
  const cli = (...args) => main(['--site', 'audit', ...args], { run: async (cmd, argv) => {
    calls.push([cmd, argv]);
    const repo = argv[argv.indexOf('--repo') + 1];
    if (argv[1] === 'view') return { status: 0, stdout: JSON.stringify({ number: 41, url: `https://github.com/${repo}/issues/41` }) };
    return { status: 0, stdout: `https://github.com/${repo}/issues/42\n` };
  } });
  assert.equal(await cli('item', 'add', 'audit/B2', '--title', 'Two', '--ticket', 'INT-19'), 0);
  assert.equal(await cli('item', 'set', 'audit/A1', '--ticket', 'NO-20'), 1);
  assert.match(err.at(-1), /match INT/);
  assert.equal(await cli('item', 'set', 'audit/A1', '--ticket', 'INT-20'), 0);
  assert.equal(await cli('item', 'add', 'audit/C3', '--title', 'Three'), 0);
  assert.equal(read(site('audit', 'data', 'wave.json')).items.at(-1).ticket, 'INT-21');
  assert.equal(await cli('item', 'add', 'audit', '--title', 'Named by its ticket'), 0);
  assert.equal(out.at(-1), 'INT-22 added as audit/INT-22');
  assert.deepEqual(['id', 'ticket', 'title'].map((k) => read(site('audit', 'data', 'wave.json')).items.at(-1)[k]), ['INT-22', 'INT-22', 'Named by its ticket']);
  await saveBoardSettings(site('audit'), { tickets: { source: 'internal', prefix: 'OPS' } });
  assert.equal(await cli('item', 'add', 'audit/D4', '--title', 'Four'), 0);
  assert.equal(read(site('audit', 'data', 'wave.json')).items.at(-1).ticket, 'OPS-1');
  assert.equal(calls.length, 0);
  const waveFile = site('audit', 'data', 'wave.json');
  write(waveFile, { ...read(waveFile), repo: 'o/r' });
  await saveBoardSettings(site('audit'), { tickets: { source: 'github' } });
  assert.equal(await cli('item', 'add', 'audit/F6', '--title', 'Six', '--ticket', '#41'), 0);
  assert.equal(await cli('item', 'set', 'audit/F6', '--ticket', '41'), 0);
  assert.equal(await cli('item', 'add', 'audit/G7', '--title', 'Seven', '--notes', 'Why this matters'), 0);
  write(site('audit', 'data', 'notes.md'), '# Full notes');
  assert.equal(await cli('item', 'add', 'audit/H8', '--title', 'Eight', '--notes-file', 'notes.md'), 0);
  write(site('audit', 'data', 'events.jsonl'), JSON.stringify({ id: 'e1', kind: 'ask', data: { text: 'Ask' } }) + '\n');
  write(waveFile, { ...read(waveFile), items: [...read(waveFile).items, { id: 'I9', title: 'From ask', notes: 'Asked why' }] });
  assert.equal(await cli('item', 'set', 'audit/I9', '--from-ask', 'e1', '--state', 'grilling', '--text', 'On it.'), 0);
  assert.equal(await cli('item', 'add', 'audit/github-follow', '--title', 'Another follow', '--parent', 'audit/A1'), 0);
  assert.deepEqual(calls, [
    ['gh', ['issue', 'view', '41', '--repo', 'o/r', '--json', 'number,url']],
    ['gh', ['issue', 'view', '41', '--repo', 'o/r', '--json', 'number,url']],
    ['gh', ['issue', 'create', '--repo', 'o/r', '--title', 'Seven', '--body', 'Why this matters']],
    ['gh', ['issue', 'create', '--repo', 'o/r', '--title', 'Eight', '--body', '# Full notes']],
    ['gh', ['issue', 'create', '--repo', 'o/r', '--title', 'From ask', '--body', 'Asked why']],
    ['gh', ['issue', 'create', '--repo', 'o/r', '--title', 'Another follow', '--body', '']],
  ]);
  assert.equal(read(waveFile).items.at(-1).ticket, '#42');
  assert.equal(await cli('item', 'set', 'audit/F6', '--next', 'Then this'), 0);
  assert.equal(out.at(-1), '#41: next line set');
  assert.equal(await cli('item', 'add', 'audit', '--title', 'Ten', '--notes', 'From the source'), 0);
  assert.deepEqual(calls.at(-1), ['gh', ['issue', 'create', '--repo', 'o/r', '--title', 'Ten', '--body', 'From the source']]);
  assert.equal(out.at(-1), '#42 added as audit/GH-42');
  assert.deepEqual(['id', 'ticket', 'ticket_created'].map((k) => read(waveFile).items.at(-1)[k]), ['GH-42', '#42', true]);
  const items = read(waveFile).items.length;
  assert.equal(await cli('item', 'add', 'audit', '--title', 'Eleven'), 1);
  assert.equal(err.at(-1), 'wave "audit" already has an item "GH-42"; link #42 with item add audit/<id> --ticket #42');
  assert.equal(read(waveFile).items.length, items);
  const before = fs.readFileSync(waveFile, 'utf8');
  for (const response of [{ status: 1, stderr: 'No such issue' }, { status: 0, stdout: JSON.stringify({ number: 41, url: 'https://github.com/other/repo/issues/41' }) }]) {
    assert.equal(await main(['--site', 'audit', 'item', 'set', 'audit/F6', '--ticket', '#41'], { run: async () => response }), 1);
    assert.equal(fs.readFileSync(waveFile, 'utf8'), before);
  }
  write(at('kickflip', 'manifest.json'), { sites: { audit: { dir: site('audit'), cmd: [process.execPath, fileURLToPath(new URL('./server.mjs', import.meta.url))], github: 'board/chosen' } } });
  const script = `import assert from 'node:assert/strict';
    import { main } from ${JSON.stringify(new URL('./bin/board.mjs', import.meta.url).href)};
    process.exitCode = await main(['--site', 'audit', 'item', 'set', 'audit/F6', '--ticket', '#41'], { run: async (cmd, argv) => {
      assert.equal(cmd, 'gh');
      assert.deepEqual(argv, ['issue', 'view', '41', '--repo', 'board/chosen', '--json', 'number,url']);
      return { status: 0, stdout: JSON.stringify({ number: 41, url: 'https://github.com/board/chosen/issues/41' }) };
    } });`;
  const linked = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, HOME: home, KICKFLIP_CLAUDE: '/usr/bin/false' } });
  assert.equal(linked.status, 0, linked.stderr);
});

test('internal ticket creation uses the next number across all board waves, including legacy S ids and concurrent additions', async () => {
  write(at('waves', 'internal', 'wave.json'), { internal: true, items: [{ id: 'S80', title: 'Legacy' }, { id: 'INT-92', title: 'Later' }] });
  assert.equal(board('item', 'add', 'w/B2', '--site', 'orch', '--title', 'Two').code, 0);
  assert.equal(read(at('waves', 'w', 'wave.json')).items.at(-1).ticket, 'INT-93');
  const added = await Promise.all(['C3', 'D4'].map((id) => runAsync('board.mjs', ['item', 'add', `w/${id}`, '--site', 'orch', '--title', id])));
  assert.deepEqual(added.map((r) => r.code), [0, 0]);
  assert.deepEqual(read(at('waves', 'w', 'wave.json')).items.slice(-2).map((it) => it.ticket).sort(), ['INT-94', 'INT-95']);
  assert.equal(board('item', 'add', 'internal/INT-200', '--site', 'orch', '--title', 'Hub card').code, 0);
  assert.equal(board('item', 'add', 'internal/S201', '--site', 'orch', '--title', 'Legacy card').code, 0);
  assert.deepEqual(read(at('waves', 'internal', 'wave.json')).items.slice(-2).map((it) => it.ticket), ['INT-200', 'INT-201']);
  write(at('waves', 'w', 'wave.json'), { ...read(at('waves', 'w', 'wave.json')), items: [...read(at('waves', 'w', 'wave.json')).items, { id: 'P9', title: 'Linear', linear: ['ENG-900'] }] });
  assert.equal(board('item', 'add', 'w/E5', '--site', 'orch', '--title', 'Five').code, 0);
  assert.equal(read(at('waves', 'w', 'wave.json')).items.at(-1).ticket, 'INT-202');
});

async function ticketCli(t) {
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

test("a Linear board creates and checks issues through Hub's key, and each card moves only its owner's or kickflip's ticket, one way", async (t) => {
  const { saveBoardSettings, main, out, err, world, linear, gh, ghAnswers, cli, item } = await ticketCli(t);
  await saveBoardSettings(site('audit'), { tickets: { source: 'linear', workspace: 'acme', team: 'ENG', project: 'proj-audit' } });
  write(site('audit', 'data', 'notes.md'), '# Why it matters');
  assert.equal(await cli('item', 'add', 'audit/B2', '--title', 'Two', '--notes-file', 'notes.md'), 0);
  assert.deepEqual([item('B2').ticket, item('B2').ticket_created], ['ENG-101', true]);
  assert.deepEqual(world.issues['ENG-101'].input, { teamId: 'team-eng', projectId: 'proj-audit', title: 'Two', description: '# Why it matters' });
  world.issues['ENG-8'] = { team: 'OPS', assignee: 'user-me', state: 'o-todo' };
  world.issues['ENG-9'] = { team: 'ENG', assignee: 'someone', state: 's-todo' };
  world.issues['ENG-10'] = { team: 'ENG', assignee: 'user-me', state: 's-todo' };
  for (const [ticket, message] of [['ENG-50', 'Linear has no issue ENG-50.'], ['ENG-8', "ENG-8 is in Linear's OPS team, not ENG."], ['OPS-1', 'Ticket must match ENG-<number>.']]) {
    assert.equal(await cli('item', 'add', 'audit/C3', '--title', 'Three', '--ticket', ticket), 1);
    assert.equal(err.at(-1), message);
  }
  assert.equal(await cli('item', 'add', 'audit/C3', '--title', 'Three', '--ticket', 'ENG-9'), 0);
  assert.equal(await cli('item', 'add', 'audit/D4', '--title', 'Four', '--ticket', 'ENG-10'), 0);
  assert.deepEqual([item('C3').ticket, item('C3').ticket_created, item('D4').ticket], ['ENG-9', undefined, 'ENG-10']);
  const stateOf = (id) => world.teams[0].states.find((s) => s.id === world.issues[id].state).name;
  const moves = [
    ['B2', ['--status', 'building'], 'ENG-101', 'In Progress'], ['B2', ['--pr', '5'], 'ENG-101', 'In Review'], ['B2', ['--status', 'done', '--text', 'Done.'], 'ENG-101', 'Done'],
    ['D4', ['--status', 'fixing'], 'ENG-10', 'In Progress'], ['D4', ['--status', 'merged'], 'ENG-10', 'Done'],
  ];
  for (const [id, flags, ticket, state] of moves) {
    assert.equal(await cli('item', 'set', `audit/${id}`, ...flags), 0);
    assert.equal(out.at(-1), `ticket ${ticket}: moved to ${state}`);
    assert.equal(stateOf(ticket), state);
  }
  assert.equal(await cli('item', 'set', 'audit/B2', '--status', 'building'), 0);
  assert.equal(stateOf('ENG-101'), 'Done');
  assert.equal(await cli('item', 'set', 'audit/C3', '--status', 'building'), 0);
  assert.equal(out.at(-1), 'ticket ENG-9: left as it is, not assigned to you');
  assert.deepEqual([item('C3').status, stateOf('ENG-9')], ['building', 'Todo']);
  const before = linear.calls.length;
  for (const flags of [['--status', 'checking'],['--held'], ['--next', 'Then this']]) assert.equal(await cli('item', 'set', 'audit/C3', ...flags), 0);
  assert.equal(linear.calls.length, before);
  assert.equal(await cli('item', 'add', 'audit/E5', '--title', 'Five'), 0);
  assert.equal(await cli('item', 'add', 'audit', '--title', 'Named in Linear'), 0);
  assert.equal(out.at(-1), 'ENG-103 added as audit/ENG-103');
  assert.deepEqual([item('ENG-103').ticket, world.issues['ENG-103'].input.title], ['ENG-103', 'Named in Linear']);
  const offline = async () => { throw new Error('offline'); };
  assert.equal(await main(['--site', 'audit', 'item', 'set', 'audit/E5', '--status', 'building'], { linearFetch: offline }), 0);
  assert.equal(out.at(-1), 'ticket ENG-102: could not move to In Progress (Could not reach Linear: offline)');
  assert.equal(item('E5').status, 'building');

  const waveFile = site('audit', 'data', 'wave.json');
  write(waveFile, { ...read(waveFile), repo: 'o/r' });
  await saveBoardSettings(site('audit'), { tickets: { source: 'github' } });
  assert.equal(await cli('item', 'add', 'audit/F6', '--title', 'Six'), 0);
  assert.equal(await cli('item', 'add', 'audit/G7', '--title', 'Seven', '--ticket', '#41'), 0);
  assert.equal(await cli('item', 'add', 'audit/H8', '--title', 'Eight', '--ticket', '#43', '--deps', 'audit/F6'), 0);
  gh.length = 0;
  for (const id of ['F6', 'G7']) assert.equal(await cli('item', 'set', `audit/${id}`, '--status', 'building'), 0);
  assert.equal(await cli('item', 'set', 'audit/G7', '--pr', '7'), 0);
  assert.deepEqual(gh, []);
  assert.equal(await cli('item', 'set', 'audit/F6', '--status', 'done', '--text', 'Done.'), 0);
  assert.equal(out.at(-1), 'ticket #42: closed');
  assert.deepEqual(gh, [['issue', 'close', '42', '--repo', 'o/r']]);
  // The line on the card it unblocked names the finished card by its ticket, not its id.
  assert.deepEqual(lines(site('audit', 'data', 'threads', 'audit__H8.jsonl')).map((m) => m.text), ['Unblocked: #42 is done.']);
  assert.equal(await cli('item', 'set', 'audit/G7', '--status', 'merged'), 0);
  assert.equal(out.at(-1), 'ticket #41: left as it is, not assigned to you');
  assert.equal(gh.some((argv) => argv[1] === 'close' && argv[2] === '41'), false);
  ghAnswers.view = { state: 'OPEN', assignees: [{ login: 'Love' }] };
  assert.equal(await cli('item', 'set', 'audit/G7', '--status', 'done', '--text', 'Done.'), 0);
  assert.equal(out.at(-1), 'ticket #41: closed');
  assert.deepEqual(gh.at(-1), ['issue', 'close', '41', '--repo', 'o/r']);
});

test("a board still on Linear after Hub's key went refuses new tickets, links and backfills, never leaving a card without one, and its moves say the key is missing", async (t) => {
  const { saveBoardSettings, out, err, linear, cli, item } = await ticketCli(t);
  await saveBoardSettings(site('audit'), { tickets: { source: 'linear', workspace: 'acme', team: 'ENG', project: 'proj-audit' } });
  assert.equal(await cli('item', 'add', 'audit/B2', '--title', 'Two', '--notes', 'Why'), 0);
  assert.equal(item('B2').ticket, 'ENG-101');
  const calls = linear.calls.length;
  write(at('kickflip', 'secrets.json'), {});
  const noKey = 'Hub has no Linear key, so this board can’t create Linear tickets; add it in Hub settings › Linear, or pick another ticket source.';
  const waveFile = site('audit', 'data', 'wave.json');
  write(site('audit', 'data', 'events.jsonl'), JSON.stringify({ id: 'e1', kind: 'ask', data: { text: 'Ask' } }) + '\n');
  write(waveFile, { ...read(waveFile), items: [...read(waveFile).items, { id: 'D4', title: 'Asked' }] });
  const before = fs.readFileSync(waveFile, 'utf8');
  for (const args of [['item', 'add', 'audit/C3', '--title', 'Three'], ['item', 'add', 'audit', '--title', 'Unnamed'], ['item', 'add', 'audit/later', '--title', 'Later', '--parent', 'A1'],
    ['item', 'set', 'audit/B2', '--ticket', 'ENG-4'], ['item', 'set', 'audit/D4', '--from-ask', 'e1', '--state', 'grilling', '--text', 'On it.']]) {
    assert.equal(await cli(...args), 1, args.join(' '));
    assert.equal(err.at(-1), noKey);
  }
  assert.equal(fs.readFileSync(waveFile, 'utf8'), before);
  for (const flags of [['--status', 'building'], ['--pr', '9'], ['--status', 'done', '--text', 'Done.']]) {
    assert.equal(await cli('item', 'set', 'audit/B2', ...flags), 0);
    assert.equal(out.at(-1), 'ticket ENG-101: not moved, Hub has no Linear key');
  }
  write(waveFile, { ...read(waveFile), items: [{ id: 'E5', title: 'Fix login (ENG-2918)' }, { id: 'F6', title: 'No id yet' }, { id: 'G7', title: 'Done', status: 'done' }] });
  out.length = 0;
  assert.equal(await cli('tickets', 'backfill'), 0);
  assert.deepEqual(out, [`audit/E5 failed: ${noKey}`, `audit/F6 failed: ${noKey}`, 'backfill: linked 0, created 0, failed 2']);
  assert.deepEqual(['E5', 'F6', 'G7'].map((id) => item(id).ticket), [undefined, undefined, undefined]);
  assert.equal(linear.calls.length, calls);
});

test('tickets backfill links ids from open cards’ titles that belong to the source, creates the rest, leaves done cards, and changes nothing on a dry run', async (t) => {
  const { saveBoardSettings, out, world, linear, cli, item } = await ticketCli(t);
  world.issues['ENG-2918'] = { team: 'ENG', assignee: null, state: 's-todo' };
  world.issues['ENG-2919'] = { team: 'ENG', assignee: null, state: 's-todo' };
  const waveFile = site('audit', 'data', 'wave.json');
  write(waveFile, { ...read(waveFile), items: [
    { id: 'A1', title: 'Fix login (ENG-2918)' },
    { id: 'B2', title: 'Merged ENG-77', status: 'merged' },
    { id: 'C3', title: 'Watch OPS-3 too', status: 'building' },
    { id: 'D4', title: 'Has one', ticket: 'ENG-5' },
    { id: 'E5', title: 'Legacy', linear: ['ENG-2919'] },
    { id: 'F6', title: 'Gone ENG-4040' },
    { id: 'G7', title: 'Dropped', status: 'dropped' },
    { id: 'ENG-1', title: 'Later', parent: 'A1' },
  ] });
  assert.equal(await cli('tickets', 'backfill'), 1);
  await saveBoardSettings(site('audit'), { tickets: { source: 'linear', workspace: 'acme', team: 'ENG', project: 'Backend Audit' } });
  const before = fs.readFileSync(waveFile, 'utf8');
  out.length = 0;
  assert.equal(await cli('tickets', 'backfill', '--dry-run'), 0);
  assert.deepEqual(out, [
    'audit/A1 would link ENG-2918', 'audit/C3 would get a new ticket', 'audit/E5 would link ENG-2919', 'audit/F6 would link ENG-4040',
    'audit/ENG-1 would get a new ticket', 'backfill (dry run): would link 3, create 2',
  ]);
  assert.equal(fs.readFileSync(waveFile, 'utf8'), before);
  assert.equal(linear.calls.length, 0);
  out.length = 0;
  assert.equal(await cli('tickets', 'backfill'), 0);
  assert.deepEqual(out, [
    'audit/A1 linked ENG-2918', 'audit/C3 created ENG-101', 'audit/E5 linked ENG-2919', 'audit/F6 failed: Linear has no issue ENG-4040.',
    'audit/ENG-1 created ENG-102', 'backfill: linked 2, created 2, failed 1',
  ]);
  assert.deepEqual(['A1', 'B2', 'C3', 'D4', 'E5', 'F6', 'G7'].map((id) => [item(id).ticket, item(id).ticket_created]), [
    ['ENG-2918', undefined], [undefined, undefined], ['ENG-101', true], ['ENG-5', undefined], ['ENG-2919', undefined], [undefined, undefined], [undefined, undefined],
  ]);
  assert.equal(item('ENG-1').ticket, 'ENG-102');
  assert.equal(world.issues['ENG-101'].input.projectId, 'proj-audit');
});

test('an Internal ticket another card holds is refused, and backfill gives a card that only mentions one a new ticket', () => {
  assert.equal(board('item', 'add', 'w/B2', '--site', 'orch', '--title', 'Two').code, 0);
  assert.equal(read(at('waves', 'w', 'wave.json')).items.at(-1).ticket, 'INT-1');
  const refused = board('item', 'set', 'w/A1', '--site', 'orch', '--ticket', 'INT-1');
  assert.deepEqual([refused.code, refused.err], [1, 'INT-1 is already the ticket of w/B2\n']);
  assert.equal(board('item', 'add', 'w/C3', '--site', 'orch', '--title', 'Three', '--ticket', 'INT-1').code, 1);
  assert.equal(board('item', 'set', 'w/B2', '--site', 'orch', '--ticket', 'INT-1').code, 0);
  write(at('waves', 'w', 'wave.json'), { ...read(at('waves', 'w', 'wave.json')), items: [...read(at('waves', 'w', 'wave.json')).items, { id: 'D4', title: 'Follow-up to INT-1' }, { id: 'E5', title: 'Revisit INT-9' }] });
  const backfill = board('tickets', 'backfill', '--site', 'orch');
  assert.equal(backfill.code, 1);
  assert.match(backfill.err, /no ticket source/);
  fs.writeFileSync(site('orch', 'board.json'), JSON.stringify({ title: 'Orch', items: 'waves', tickets: { source: 'internal', prefix: 'INT' } }));
  const done = board('tickets', 'backfill', '--site', 'orch');
  assert.equal(done.code, 0, done.err);
  assert.deepEqual(done.out.trim().split('\n'), ['w/A1 created INT-2', 'w/ENG-1 created INT-3', 'w/D4 created INT-4', 'w/E5 linked INT-9', 'backfill: linked 1, created 3, failed 0']);
});

test("the hub board files its cards as issues in its entry's GitHub repo, as any local board does, as its Tickets gh account, PR calls stay on the active account, and a missing account fails clearly", () => {
  const dir = path.join(home, 'fake-gh');
  const env = { PATH: `${fakeGh(dir)}:${process.env.PATH}` };
  writeAccounts(dir, { lovek4d: 'token-lovek4d' });
  writePR(dir, 7, prView());
  write(at('kickflip', 'manifest.json'), { sites: { audit: { dir: site('audit'), hub: true, local: true, github: 'someone/fork', cmd: [process.execPath, bin('../server.mjs')] } } });
  write(site('audit', 'data', 'wave.json'), { ...wave(), internal: true, items: [{ id: 'A1', title: 'One', ticket: 'A1' }, { id: 'Z9', title: 'Shipped', ticket: 'Z9', status: 'done' }] });
  const cli = (...args) => run('board.mjs', ['--site', 'audit', ...args], undefined, env);
  const last = (...args) => cli(...args).out.trim().split('\n').at(-1);
  assert.equal(last('settings', 'set', 'tickets', '{"source":"github","account":"lovek4d"}'), 'setting tickets {"source":"github","account":"lovek4d"}');
  assert.equal(cli('settings', 'set', 'github-login', 'owner').code, 0);
  assert.equal(cli('item', 'add', 'audit/B2', '--title', 'Two').code, 0);
  assert.equal(cli('item', 'add', 'audit/C3', '--title', 'Three', '--ticket', '#9').code, 0);
  assert.deepEqual(cli('tickets', 'backfill').out.trim().split('\n').slice(-2), ['audit/A1 created #2', 'backfill: linked 0, created 1, failed 0']);
  assert.equal(read(site('audit', 'data', 'wave.json')).items.find((it) => it.id === 'Z9').ticket, 'Z9');
  assert.equal(last('item', 'set', 'audit/B2', '--status', 'done', '--text', 'Done.'), 'ticket #1: closed');
  assert.equal(cli('item', 'set', 'audit/C3', '--pr', '7').code, 0);
  const report = cli('pr', 'audit/C3');
  assert.equal(report.code, 0, report.err);
  const issues = tokens(dir).filter((c) => c.args[0] === 'issue').map(({ args, token }) => [args[1], args[args.indexOf('--repo') + 1], token]);
  assert.deepEqual(issues, [
    ['create', 'someone/fork', 'token-lovek4d'], ['view', 'someone/fork', 'token-lovek4d'], ['create', 'someone/fork', 'token-lovek4d'],
    ['close', 'someone/fork', 'token-lovek4d'],
  ]);
  const prs = tokens(dir).filter((c) => c.args[0] === 'pr');
  assert.deepEqual(prs.map((c) => c.args[4]), ['someone/fork']);
  assert.notEqual(prs[0].token, 'token-lovek4d');
  assert.equal(cli('settings', 'set', 'tickets', '{"source":"github","account":"nobody"}').code, 0);
  const issueCalls = () => calls(dir).filter((a) => a[0] === 'issue').length;
  const before = issueCalls();
  assert.deepEqual(cli('item', 'add', 'audit/D4', '--title', 'Four'), { code: 1, out: '', err: 'gh has no nobody account; run gh auth login\n' });
  assert.equal(last('item', 'set', 'audit/C3', '--status', 'done', '--text', 'Done.'), 'ticket #9: could not move to Done (gh has no nobody account; run gh auth login)');
  assert.equal(issueCalls(), before);
  assert.equal(cli('settings', 'set', 'tickets', '{"source":"github","account":"-bad"}').code, 1);
});

test("a card with an owner step keeps its GitHub issue open when the session closes it; the owner's Done closes it", async () => {
  const dir = path.join(home, 'fake-gh');
  const env = { PATH: `${fakeGh(dir)}:${process.env.PATH}` };
  writeAccounts(dir, { lovek4d: 'token-lovek4d' });
  write(at('kickflip', 'manifest.json'), { sites: { audit: { dir: site('audit'), hub: true, local: true, github: 'someone/fork', cmd: [process.execPath, bin('../server.mjs')] } } });
  write(site('audit', 'data', 'wave.json'), { ...wave(), internal: true, items: [] });
  const cli = (...args) => run('board.mjs', ['--site', 'audit', ...args], undefined, env);
  assert.equal(cli('settings', 'set', 'tickets', '{"source":"github","account":"lovek4d"}').code, 0);
  assert.equal(cli('item', 'add', 'audit/B2', '--title', 'Two').code, 0);
  const file = site('audit', 'data', 'wave.json');
  write(file, { ...read(file), items: read(file).items.map((it) => ({ ...it, owner_step: 'Tag the first release' })) });
  const closes = () => calls(dir).filter((a) => a[0] === 'issue' && a[1] === 'close').length;
  const session = cli('item', 'set', 'audit/B2', '--status', 'done', '--text', 'Landed.');
  assert.equal(session.code, 0, session.err);
  assert.equal(closes(), 0);
  assert.equal(read(file).items[0].owner_step, 'Tag the first release');
  const owner = spawnSync(process.execPath, ['--input-type=module', '-e', `import { recordOwnerTap } from ${JSON.stringify(path.join(path.dirname(bin('x')), '..', 'store.mjs'))}; await recordOwnerTap(${JSON.stringify(site('audit'))}, 'card-done', { key: 'audit/B2' });`],
    { encoding: 'utf8', env: { ...process.env, HOME: home, ...env } });
  assert.equal(owner.status, 0, owner.stderr);
  assert.equal(closes(), 1);
  assert.deepEqual([read(file).items[0].status, read(file).items[0].owner_step], ['done', undefined]);
});

test("pr comment and pr reply post Claude's words through gh with the robot prefix and the claude-bridge marker, as the board's github-login", () => {
  const dir = path.join(home, 'fake-gh');
  const env = { PATH: `${fakeGh(dir)}:${process.env.PATH}` };
  writeAccounts(dir, { owner: 'token-owner' });
  write(at('kickflip', 'manifest.json'), { sites: { orch: { dir: site('orch'), port: 1, github: 'o/r', cmd: [process.execPath, '/skill/board/server.mjs', site('orch')] } } });
  const cli = (...args) => run('board.mjs', ['--site', 'orch', ...args], undefined, env);
  const posts = () => tokens(dir).filter((c) => c.args[0] === 'api').map(({ args, token }) => [args[1], args[3], token]);

  const comment = cli('pr', 'comment', '7', '--body', 'Fixed in abc1234.');
  assert.equal(comment.code, 0, comment.err);
  assert.equal(comment.out, 'posted on PR #7: https://github.com/o/r/issues/7/comments\n');
  assert.equal(cli('settings', 'set', 'github-login', 'owner').code, 0);
  assert.equal(cli('pr', 'reply', '7', '901', '--body', 'Not changed: the owner kept it.').code, 0);
  const elsewhere = cli('pr', 'comment', 'o/site#1', '--body', 'Linked from #7.');
  assert.equal(elsewhere.out, 'posted on PR o/site#1: https://github.com/o/site/issues/1/comments\n');
  assert.deepEqual(posts(), [
    ['repos/o/r/issues/7/comments', 'body=🤖 Fixed in abc1234.\n\n<!-- claude-bridge -->', null],
    ['repos/o/r/pulls/7/comments/901/replies', 'body=🤖 Not changed: the owner kept it.\n\n<!-- claude-bridge -->', 'token-owner'],
    ['repos/o/site/issues/1/comments', 'body=🤖 Linked from #7.\n\n<!-- claude-bridge -->', 'token-owner'],
  ]);

  for (const [args, err] of [
    [['pr', 'comment', '7', '--body', '🤖 Fixed.'], 'pr comment adds the 🤖 prefix and the claude-bridge marker itself; pass only your words'],
    [['pr', 'comment', '7', '--body', 'Fixed.\n\n<!-- claude-bridge -->'], 'pr comment adds the 🤖 prefix and the claude-bridge marker itself; pass only your words'],
    [['pr', 'comment', 'x7', '--body', 'Fixed.'], 'pr comment takes a PR number or owner/repo#<n>'],
    [['pr', 'reply', '7', 'abc', '--body', 'Fixed.'], 'pr reply takes the id of the review comment it answers'],
    [['pr', 'comment', '7'], 'pr comment needs --body "<what Claude says>"'],
  ]) assert.deepEqual([cli(...args).code, cli(...args).err.split(' (node board')[0].trim()], [args.length === 3 ? 2 : 1, err]);
  assert.equal(posts().length, 3);
});

test("merge squashes a card's PR once GitHub would merge it, with no commit after the approval unexplained and manual steps on the owner's word, and leaves its refusal off the card's thread", () => {
  const dir = path.join(home, 'fake-gh');
  const env = { PATH: `${fakeGh(dir)}:${process.env.PATH}` };
  const merge = (...args) => run('board.mjs', ['--site', 'orch', 'merge', ...args], undefined, env);
  const thread = () => (fs.existsSync(site('orch', 'data', 'threads', 'w__A1.jsonl')) ? lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).map((m) => m.text) : []);
  const merges = () => calls(dir).filter((a) => a[1] === 'merge');
  const approved = (commit) => writeReviews(dir, 7, [{ id: 1, user: { login: 'ann' }, state: 'APPROVED', submitted_at: '2026-11-01T10:00:00Z', commit_id: commit }]);
  write(at('waves', 'w', 'wave.json'), { ...wave(), repo: 'o/r', items: [{ id: 'A1', title: 'One', pr: 7, status: 'building', manual_steps: ['Run the backfill'] }, { id: 'A2', title: 'Two', pr: 8 }, { id: 'A3', title: 'Three' }] });
  writePR(dir, 7, prView({ failing: ['build'], pending: 1 }));
  assert.deepEqual(merge('w/A1'), { code: 1, out: '', err: "Not merged: review: review required; failing: build; merge state: blocked; manual steps: merge only on the owner's word, with --confirmed \"<their words>\".\n" });
  assert.deepEqual(thread(), []);
  fs.appendFileSync(site('orch', 'data', 'events.jsonl'), [
    { id: 'e3', ts: '2026-11-01T11:01:00Z', kind: 'item-message', data: { key: 'w/A1', text: 'The backfill ran on prod.' } },
  ].map((e) => JSON.stringify(e) + '\n').join(''));
  writePR(dir, 7, prView({ reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', head: 'bbb' }));
  approved('aaa');
  const after = merge('w/A1', '--confirmed', 'the backfill ran on prod');
  assert.equal(after.code, 1);
  assert.match(after.err, /^Not merged: commits after the approval: pass --after-approval/);
  assert.deepEqual(thread(), []);
  assert.match(merge('w/A1', '--after-approval', 'Rebased.', '--confirmed', 'the backfill is done').err, /--confirmed must quote the owner's words/);
  approved('bbb');
  assert.match(merge('w/A1', '--after-approval', 'Rebased.', '--confirmed', 'the backfill ran on prod').err, /--after-approval: no commit came after the approval/);
  writePR(dir, 8, prView({ reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' }));
  assert.match(merge('w/A2', '--confirmed', 'the backfill ran on prod').err, /--confirmed: w\/A2 has no manual steps/);
  assert.match(merge('w/A3').err, /w\/A3 has no PR/);
  writeMerge(dir, 8, { error: 'Pull request is not mergeable: the base branch policy prohibits the merge.' });
  assert.deepEqual(merge('w/A2'), { code: 1, out: '', err: 'gh pr merge #8 failed: Pull request is not mergeable: the base branch policy prohibits the merge.\n' });
  assert.equal(read(at('waves', 'w', 'wave.json')).items[1].status, undefined);
  assert.equal(merges().length, 1);
  approved('aaa');
  const done = merge('w/A1', '--after-approval', 'Only a rebase onto main.', '--confirmed', 'the backfill ran on prod');
  assert.equal(done.code, 0, done.err);
  assert.equal(done.out.trim().split('\n').at(-1), 'A1: merged');
  assert.deepEqual(merges().at(-1), ['pr', 'merge', '7', '--repo', 'o/r', '--squash']);
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].status, 'merged');
  assert.equal(thread().at(-1), 'Merged PR #7. After the approval: Only a rebase onto main. The owner\'s word on the manual steps: "the backfill ran on prod"');
  writePR(dir, 8, prView({ state: 'MERGED' }));
  assert.equal(merge('w/A2').code, 0);
  assert.equal(lines(site('orch', 'data', 'threads', 'w__A2.jsonl')).at(-1).text, 'PR #8 was already merged.');
  assert.equal(merges().length, 2);
});

test("merge takes every PR on a card across repos in its order, refusing while any open one isn't ready and leaving a merged or closed one be", () => {
  const dir = path.join(home, 'fake-gh');
  const env = { PATH: `${fakeGh(dir)}:${process.env.PATH}` };
  const merge = (...args) => run('board.mjs', ['--site', 'orch', 'merge', ...args], undefined, env);
  const merges = () => calls(dir).filter((a) => a[1] === 'merge').map((a) => `${a[4]}#${a[2]}`);
  const thread = (id) => lines(site('orch', 'data', 'threads', `w__${id}.jsonl`)).map((m) => m.text);
  const ready = prView({ reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' });
  write(at('waves', 'w', 'wave.json'), { ...wave(), repo: 'o/r', items: [
    { id: 'A1', title: 'Two repos', prs: [{ number: 6 }, { repo: 'o/site', number: 1 }] },
    { id: 'A2', title: 'One left', prs: [{ repo: 'o/site', number: 2 }, { number: 9 }, { number: 10 }] },
    { id: 'A3', title: 'All in', prs: [{ number: 11 }, { repo: 'o/site', number: 3 }] },
  ] });
  writePR(dir, 'o/r#6', ready);
  writePR(dir, 'o/site#1', prView({ isDraft: true, failing: ['build'] }));
  const refused = merge('w/A1');
  assert.equal(refused.code, 1);
  assert.equal(refused.err, 'Not merged: o/site#1 it is a draft; o/site#1 review: review required; o/site#1 failing: build; o/site#1 merge state: blocked.\n');
  assert.deepEqual(merges(), []);
  writePR(dir, 'o/site#1', ready);
  const done = merge('w/A1');
  assert.equal(done.code, 0, done.err);
  assert.deepEqual(merges(), ['o/r#6', 'o/site#1']);
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].status, 'merged');
  assert.equal(thread('A1').at(-1), 'Merged PRs #6, o/site#1.');
  writePR(dir, 'o/site#2', prView({ state: 'MERGED' }));
  writePR(dir, 'o/r#9', prView({ state: 'CLOSED' }));
  writePR(dir, 'o/r#10', ready);
  assert.equal(merge('w/A2').code, 0);
  assert.deepEqual(merges().slice(2), ['o/r#10']);
  assert.equal(thread('A2').at(-1), 'Merged PR #10.');
  writePR(dir, 'o/r#11', ready);
  writePR(dir, 'o/site#3', ready);
  writeMerge(dir, 'o/site#3', { error: 'Base branch was modified.' });
  assert.deepEqual(merge('w/A3'), { code: 1, out: '', err: 'gh pr merge o/site#3 failed: Base branch was modified. (merged #11 before it)\n' });
  assert.equal(read(at('waves', 'w', 'wave.json')).items[2].status, undefined);
  writePR(dir, 'o/r#11', prView({ state: 'MERGED' }));
  writePR(dir, 'o/site#3', prView({ state: 'CLOSED' }));
  assert.equal(merge('w/A3').code, 0);
  assert.equal(thread('A3').at(-1), 'PR #11 was already merged.');
});

test("thread appends a line to an item's thread", () => {
  assert.equal(board('thread', 'w/A1', '--site', 'orch', '--text', 'Built.', '--who', 'Jamie', '--via', 'github', '--link', 'https://github.com/o/r/pull/1').code, 0);
  assert.equal(board('thread', 'w/A1', '--site', 'orch', '--text', 'Merged.').code, 0);
  const msgs = lines(site('orch', 'data', 'threads', 'w__A1.jsonl'));
  assert.deepEqual(msgs.map(({ ts, ...m }) => m), [
    { who: 'Jamie', text: 'Built.', link: 'https://github.com/o/r/pull/1', via: 'github' },
    { who: 'claude', text: 'Merged.' },
  ]);
  assert.ok(!Number.isNaN(Date.parse(msgs[0].ts)));
  const links = ['prototype-x.html', 'prototype-x.html?q=some-id', 'prototype-x.html#take-A', 'prototype-x.html?q=some-id#take-A', 'http://example.com/prototype'];
  for (const link of links) {
    const r = board('thread', 'w/A1', '--site', 'orch', '--text', 'Pick a take.', '--link', link);
    assert.equal(r.code, 0, r.err);
  }
  assert.deepEqual(lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).slice(msgs.length).map((m) => m.link), links);
});

test('thread refuses an unknown item, an empty text, an unknown channel and invalid links', () => {
  assert.equal(board('thread', 'w/Z9', '--site', 'orch', '--text', 'Hi').code, 1);
  assert.equal(board('thread', 'w/A1', '--site', 'orch', '--text', ' ').code, 1);
  assert.equal(board('thread', 'w/A1', '--site', 'orch', '--text', 'Hi', '--via', 'email').code, 1);
  assert.equal(board('thread', 'w/A1', '--text', 'Hi').code, 1);
  for (const link of ['javascript:alert(1)', 'data:text/html,Hi', 'file:///tmp/prototype-x.html', 'ftp://example.com/page', '//example.com/page', '/orch/prototype-x.html', 'notes.html', 'prototype-x.html?q=some id']) {
    const r = board('thread', 'w/A1', '--site', 'orch', '--text', 'Hi', '--link', link);
    assert.equal(r.code, 1, link);
    assert.match(r.err, /--link must be an http\(s\) URL or a site page/);
  }
  assert.equal(fs.existsSync(site('orch', 'data', 'threads')), false);
});

test('question add appends valid questions and rejects the whole file otherwise', () => {
  const drawn = (more = {}) => ({ id: 'A', label: 'Keep', diagram: [[{ text: 'Hub' }, { text: 'Board', tone: 'info', to: [0] }], [{ text: 'Owner', tone: 'success' }]], practice: ['One place to change.'], ...more });
  recordPrototype();
  write(path.join(home, 'q.json'), [question('q1', { url: 'prototype-site.html?q=q1' }), question('q2', { topic: 'item:w/A1', urgent: true, url: 'https://linear.app/x/issue/INT-1', options: [drawn(), { id: 'B', label: 'Drop' }] }), question('q4', { topic: 'item:ask:e1', suggested: { option: 'B', card: '#186', answer: 'Drop it.' } })]);
  assert.equal(board('question', 'add', '--site', 'orch', '--file', path.join(home, 'q.json')).code, 0);
  assert.deepEqual(read(site('orch', 'data', 'owner.json')).items.map((q) => [q.id, q.url]), [['q1', 'prototype-site.html?q=q1'], ['q2', 'https://linear.app/x/issue/INT-1'], ['q4', undefined]]);
  assert.deepEqual(read(site('orch', 'data', 'owner.json')).items[1].options[0], drawn());
  assert.deepEqual(read(site('orch', 'data', 'owner.json')).items[2].suggested, { option: 'B', card: '#186', answer: 'Drop it.' });

  const rejected = [
    [question('q1')],
    [question('q3', { topic: 'nowhere' })],
    [question('q3', { topic: 'item:w/Z9' })],
    [question('q3', { topic: 'item:ask:e9' })],
    [question('q3', { options: [] })],
    [question('q3', { options: [{ id: 'A', label: 'Keep', recommend: true }] })],
    [question('q3', { options: [{ id: 'A', label: 'X', recommended: true }, { id: 'B', label: 'Y', recommended: true }] })],
    [question('q3'), question('q3')],
    [question('q3', { suggested: { option: 'C', card: '#186', answer: 'Keep.' } })],
    [question('q3', { suggested: { option: 'A', answer: 'Keep.' } })],
    [question('q3', { suggested: { option: 'A', card: '#186' } })],
    [question('q3', { suggested: { option: 'A', card: '#186', answer: 'Keep.', why: 'x' } })],
    [question('q3', { url: '/orch/prototype-site.html' })],
    [question('q3', { url: 'notes.html' })],
    [question('q3', { options: [drawn({ practice: undefined })] })],
    [question('q3', { options: [drawn({ diagram: undefined })] })],
    [question('q3', { options: [drawn({ diagram: [] })] })],
    [question('q3', { options: [drawn({ diagram: [[{ text: 'A' }, { text: 'B' }, { text: 'C' }, { text: 'D' }, { text: 'E' }]] })] })],
    [question('q3', { options: [drawn({ diagram: [[{ text: ' ' }]] })] })],
    [question('q3', { options: [drawn({ diagram: [[{ text: 'A', tone: 'red' }]] })] })],
    [question('q3', { options: [drawn({ diagram: [[{ text: 'A', to: [1] }], [{ text: 'B' }]] })] })],
    [question('q3', { options: [drawn({ diagram: [[{ text: 'A', to: [0] }]] })] })],
    [question('q3', { options: [drawn({ diagram: [[{ text: 'A', shape: 'round' }]] })] })],
    [question('q3', { options: [drawn({ practice: [] })] })],
  ];
  for (const file of rejected) {
    write(path.join(home, 'bad.json'), file);
    assert.equal(board('question', 'add', '--site', 'orch', '--file', path.join(home, 'bad.json')).code, 1, JSON.stringify(file));
  }
  assert.deepEqual(read(site('orch', 'data', 'owner.json')).items.map((q) => q.id), ['q1', 'q2', 'q4']);

  const onCard = (id) => {
    write(path.join(home, 'card.json'), question(id, { topic: 'item:w/A1' }));
    return board('question', 'add', '--site', 'orch', '--file', path.join(home, 'card.json'));
  };
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--status', 'merged', '--force').code, 0);
  assert.equal(onCard('q-merged').code, 0);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--status', 'done', '--force', '--text', 'Done.').code, 0);
  assert.equal(onCard('q-done').code, 0);
  const added = read(site('orch', 'data', 'owner.json')).items;
  assert.deepEqual(added.map((q) => q.id), ['q1', 'q2', 'q4', 'q-merged', 'q-done']);
  assert.ok(added.every((q) => !Number.isNaN(Date.parse(q.asked_at))));
});

const takePath = (topic, key) => site('orch', 'public', 'prototypes', topic, `${key}.js`);
function recordPrototype(topic = 'site', takes = ['A:Keep', 'B:Drop'], files = true) {
  const r = board('prototype', 'add', topic, '--site', 'orch', '--title', 'Site', ...takes.flatMap((t) => ['--take', t]));
  assert.equal(r.code, 0, r.err);
  if (files) for (const t of takes) write(takePath(topic, t[0]), 'export function render(stage) {}');
}
const addPrototypeQuestion = (url = 'prototype-site.html?q=q1', extra = {}) => {
  write(path.join(home, 'q.json'), question('q1', { url, ...extra }));
  return board('question', 'add', '--site', 'orch', '--file', path.join(home, 'q.json'));
};
const confirmFor = (id, take = 'A') => ({ id: `${id}-confirm`, question: 'Is this it?', url: `prototype-site.html?q=${id}-confirm`, options: [{ id: take, label: 'Keep' }], round: 1, confirm_of: id });
function addConfirm(id, answered) {
  const file = site('orch', 'data', 'owner.json');
  const owner = read(file);
  owner.items.push({ ...confirmFor(id), topic: owner.items.find((q) => q.id === id).topic });
  write(file, owner);
  if (answered) addEvents({ id: `answer-${id}-confirm`, ts: '2026-10-23T12:00:00Z', kind: 'owner-answer', data: { id: `${id}-confirm`, choice: 'A' } });
}
const prototypeRefusal = (result, line) => {
  assert.deepEqual(result, { code: 1, out: '', err: line + '\n' });
  assert.deepEqual(read(site('orch', 'data', 'owner.json')).items, []);
};

test('prototype add records a topic and prints the take files to write; list shows it and rm drops it, keeping the files', () => {
  const r = board('prototype', 'add', 'hub-moon', '--site', 'orch', '--title', 'Hub moon', '--card', 'w/A1', '--take', 'A:Moon with hover text', '--take', 'B:Moon with tap bubble');
  assert.deepEqual(r, { code: 0, err: '', out: ['prototype hub-moon recorded for A1', 'page prototype-hub-moon.html', `take A ${takePath('hub-moon', 'A')}`, `take B ${takePath('hub-moon', 'B')}`, ''].join('\n') });
  const [record] = read(site('orch', 'data', 'prototypes.json')).prototypes;
  assert.deepEqual({ ...record, at: undefined }, { topic: 'hub-moon', title: 'Hub moon', card: 'w/A1', takes: [{ key: 'A', label: 'Moon with hover text' }, { key: 'B', label: 'Moon with tap bubble' }], at: undefined });
  assert.equal(board('prototype', 'list', '--site', 'orch').out, 'hub-moon · Hub moon · A: Moon with hover text, B: Moon with tap bubble · w/A1\n');
  write(takePath('hub-moon', 'A'), 'export function render() {}');
  assert.equal(board('prototype', 'rm', 'hub-moon', '--site', 'orch').code, 0);
  assert.equal(board('prototype', 'list', '--site', 'orch').out, 'no prototypes recorded\n');
  assert.ok(fs.existsSync(takePath('hub-moon', 'A')));
});

test('prototype add refuses a bad topic, key or label, no takes, a repeated key, an unknown card, a recorded topic and a hand-written page', () => {
  recordPrototype('taken');
  write(site('orch', 'public', 'prototype-old.html'), '<p>Hand-written</p>');
  const before = read(site('orch', 'data', 'prototypes.json'));
  const refusals = [
    [['Bad_Topic', '--take', 'A:Keep'], 'a prototype topic uses only a-z, 0-9 and "-", not "Bad_Topic"'],
    [['t', '--take', 'a:Keep'], '--take takes KEY:"Label" with KEY one capital letter, not "a:Keep"'],
    [['t', '--take', 'AB:Keep'], '--take takes KEY:"Label" with KEY one capital letter, not "AB:Keep"'],
    [['t', '--take', 'A:A. Keep'], '--take A\'s label starts with "A. "; the take pill shows the label alone, so drop the letter'],
    [['t', '--take', 'A: '], '--take A\'s label must be non-empty text'],
    [['t'], 'prototype add needs a --take KEY:"Label" for each take'],
    [['t', '--take', 'A:Keep', '--take', 'A:Drop'], '--take A is given twice'],
    [['t', '--take', 'A:Keep', '--card', 'w/Z9'], 'wave "w" has no item "Z9"'],
    [['taken', '--take', 'A:Keep'], 'prototype taken is already recorded; run prototype rm taken first, or pick another topic'],
    [['old', '--take', 'A:Keep'], 'public/prototype-old.html is a hand-written page that questions may link; pick another topic'],
  ];
  for (const [args, line] of refusals) {
    assert.deepEqual(board('prototype', 'add', ...args, '--site', 'orch', '--title', 'T'), { code: 1, out: '', err: line + '\n' }, line);
  }
  assert.deepEqual(read(site('orch', 'data', 'prototypes.json')), before);
});

test('prototype rm refuses while an open question links the prototype', () => {
  recordPrototype();
  assert.equal(addPrototypeQuestion().code, 0);
  assert.deepEqual(board('prototype', 'rm', 'site', '--site', 'orch'), { code: 1, out: '', err: 'prototype site backs open question q1; resolve it first\n' });
  addConfirm('q1', true);
  for (const id of ['q1', 'q1-confirm']) assert.equal(board('question', 'resolve', id, '--site', 'orch', '--note', 'Picked A.').code, 0);
  assert.equal(board('prototype', 'rm', 'site', '--site', 'orch').code, 0);
});

test("question resolve refuses a prototype question until a pick settles its round, a pick with a note included, and leaves one a note resolved as it is", () => {
  recordPrototype();
  assert.equal(addPrototypeQuestion().code, 0);
  const file = site('orch', 'data', 'owner.json');
  const fresh = read(file);
  const resolve = (id, ...more) => board('question', 'resolve', id, '--site', 'orch', '--note', 'Picked A.', ...more);
  assert.deepEqual(resolve('q1'), { code: 1, out: '', err: 'q1 is in prototype round 1, which no pick has settled yet; a pick settles it\n' });
  assert.equal(resolve('q1', '--no-change').code, 2);
  addEvents({ id: 'answer-q1-noted', ts: '2026-10-23T10:00:00Z', kind: 'owner-answer', data: { id: 'q1', choice: 'A', note: 'Bigger' } });
  assert.equal(resolve('q1').code, 0);
  assert.equal(read(file).items[0].resolved, 'Picked A.');
  addEvents({ id: 'answer-q1-note', ts: '2026-10-23T10:40:00Z', kind: 'owner-answer', data: { id: 'q1', choice: null, note: 'Make it blue' } });
  const noted = { ...fresh, items: [{ ...fresh.items[0], resolved: 'Answered with a note', resolved_at: '2026-10-23T10:40:01Z' }] };
  write(file, noted);
  assert.equal(resolve('q1').code, 0);
  assert.deepEqual(read(file), noted);
});

// docs/adr/2026-11-04-2130-a-prototype-request-waits-for-its-prototype.md
test('question resolve refuses a question the owner asked a prototype of; the round naming it in round_of resolves it', () => {
  recordPrototype();
  const add = (q) => { write(path.join(home, 'q.json'), q); return board('question', 'add', '--site', 'orch', '--file', path.join(home, 'q.json')); };
  assert.equal(add(question('asked', { topic: 'item:w/A1' })).code, 0);
  addEvents({ id: 'r-asked', ts: '2026-10-23T10:00:00Z', kind: 'prototype-request', data: { key: 'w/A1', question: 'asked', note: '' } });
  assert.deepEqual(board('question', 'resolve', 'asked', '--site', 'orch', '--note', 'Answered in the thread.'),
    { code: 1, out: '', err: 'asked waits on the prototype the owner asked for; question add with round_of asked resolves it\n' });
  assert.equal(add(question('r1', { topic: 'item:w/A1', url: 'prototype-site.html?q=r1', round_of: 'asked' })).code, 0);
  assert.equal(read(site('orch', 'data', 'owner.json')).items[0].resolved, 'Followed by prototype round 1');
});

test('question add with round_of starts the next prototype round on the question it answers, resolving that one as followed by the round', () => {
  recordPrototype();
  recordPrototype('next');
  const add = (q) => { write(path.join(home, 'q.json'), q); return board('question', 'add', '--site', 'orch', '--file', path.join(home, 'q.json')); };
  const on = (id, extra = {}) => question(id, { topic: 'item:w/A1', ...extra });
  assert.equal(add(on('plain')).code, 0);
  const file = site('orch', 'data', 'owner.json');
  for (const [q, err] of [
    [on('r1', { url: 'prototype-site.html?q=r1', round_of: 'nope' }), 'question r1.round_of names no question "nope" in owner.json'],
    [on('r1', { url: 'prototype-site.html?q=r1', round_of: 'plain', topic: 'site' }), 'question r1.round_of names plain on topic item:w/A1; a round stays on its question\'s topic, site'],
    [on('r1', { round_of: 'plain' }), 'question r1.round_of needs a url on a recorded prototype, prototype-<topic>.html?q=r1'],
  ]) assert.deepEqual(add(q), { code: 1, out: '', err: err + '\n' });
  assert.deepEqual(read(file).items.map((q) => q.id), ['plain']);

  const first = add(on('r1', { url: 'prototype-site.html?q=r1', round_of: 'plain' }));
  assert.deepEqual(first.out.split('\n').slice(1), ['resolved: plain', '']);
  addConfirm('r1', false);
  const second = add(on('r2', { url: 'prototype-next.html?q=r2', round_of: 'r1-confirm' }));
  assert.deepEqual(second.out.split('\n').slice(1), ['resolved: r1-confirm', '']);
  const items = read(file).items;
  assert.deepEqual(items.map((q) => [q.id, q.round ?? null, q.resolved ?? null]), [
    ['plain', null, 'Followed by prototype round 1'], ['r1', 1, null], ['r1-confirm', 1, 'Followed by prototype round 2'], ['r2', 2, null]]);
});

test('question add with reask_of asks a resolved question again on its topic, resolving the old one again as asked again', () => {
  const add = (q) => { write(path.join(home, 'q.json'), q); return board('question', 'add', '--site', 'orch', '--file', path.join(home, 'q.json')); };
  const on = (id, extra = {}) => question(id, { topic: 'item:w/A1', ...extra });
  assert.equal(add([on('old'), on('live')]).code, 0);
  const file = site('orch', 'data', 'owner.json');
  for (const [q, err] of [
    [on('new', { reask_of: 'nope' }), 'question new.reask_of names no question "nope" in owner.json'],
    [on('new', { reask_of: 'old', topic: 'site' }), 'question new.reask_of names old on topic item:w/A1; a re-ask stays on its question\'s topic, site'],
    [on('new', { reask_of: 'live' }), 'question new.reask_of names live, which is not resolved; only a resolved question is asked again'],
  ]) assert.deepEqual(add(q), { code: 1, out: '', err: err + '\n' });
  write(file, { ...read(file), items: read(file).items.map((q) => (q.id === 'old' ? { ...q, resolved: 'Picked A', resolved_at: '2026-10-23T10:00:00Z' } : q)) });
  const out = add(on('new', { reask_of: 'old' }));
  assert.equal(out.code, 0, out.err);
  assert.deepEqual(out.out.split('\n').slice(1), ['resolved: old', '']);
  const items = read(file).items;
  assert.deepEqual(items.map((q) => [q.id, q.resolved ?? null, q.reask_of ?? null]), [['old', 'Asked again as new', null], ['live', null, null], ['new', null, 'old']]);
  assert.ok(items[0].resolved_at > '2026-10-23T10:00:00Z');
});

test('question add follows a pick with a note as it follows any answered question on the card', () => {
  recordPrototype();
  const file = site('orch', 'data', 'owner.json');
  const add = (id) => addPrototypeQuestion(`prototype-site.html?q=${id}`, { id, topic: 'item:w/A1' });
  assert.equal(add('q1').code, 0);
  addEvents({ id: 'answer-q1', ts: '2026-10-23T10:00:00Z', kind: 'owner-answer', data: { id: 'q1', choice: 'A', note: 'Bigger' } });
  const second = add('q2');
  assert.equal(second.code, 0, second.err);
  assert.deepEqual(second.out.trim().split('\n').slice(1), ['resolved: q1']);
  assert.deepEqual(read(file).items.map((q) => q.resolved ?? null), ['Followed by q2', null]);
});

test('question add refuses a prototype url missing or with the wrong ?q=', () => {
  recordPrototype();
  prototypeRefusal(addPrototypeQuestion('prototype-site.html#q=q1'), 'question q1.url must be prototype-site.html?q=q1 so the pill can pick');
  prototypeRefusal(addPrototypeQuestion('prototype-site.html?q=other#q=q1'), 'question q1.url must be prototype-site.html?q=q1 so the pill can pick');
});

test('question add refuses a hand-written or unrecorded prototype page, naming prototype add', () => {
  write(site('orch', 'public', 'prototype-site.html'), '<script src="prototype-switcher.js"></script><script>PrototypeSwitcher.mount({takes: {A: "Keep", B: "Drop"}, render(take) {}});</script>');
  prototypeRefusal(addPrototypeQuestion(), 'question q1.url names prototype-site.html, which is not a recorded prototype; record it with board.mjs prototype add site --title "…" --take A:"…", then write its take files');
});

test('question add refuses options that are not the recorded takes in order, and a take with no file yet', () => {
  recordPrototype('site', ['A:Keep', 'B:Drop'], false);
  const swapped = [{ id: 'B', label: 'Drop' }, { id: 'A', label: 'Keep', recommended: true }];
  prototypeRefusal(addPrototypeQuestion(undefined, { options: swapped }), 'question q1.options ids B, A must be a non-empty subset of prototype-site.html\'s takes, in take order: A, B');
  prototypeRefusal(addPrototypeQuestion(undefined, { options: [{ id: 'C', label: 'Other' }] }), 'question q1.options ids C must be a non-empty subset of prototype-site.html\'s takes, in take order: A, B');
  prototypeRefusal(addPrototypeQuestion(undefined, { options: [{ id: 'A', label: 'Keep' }, { id: 'A', label: 'Again' }] }), 'question q1 has two options with id "A"');
  prototypeRefusal(addPrototypeQuestion(undefined, { options: [] }), 'question q1.options must be a non-empty array');
  write(takePath('site', 'A'), 'export function render() {}');
  prototypeRefusal(addPrototypeQuestion(undefined, { options: [{ id: 'A', label: 'Keep' }] }), `question q1.url take B has no file yet; write ${takePath('site', 'B')}`);
  write(takePath('site', 'B'), 'export function render() {}');
  const url = 'prototype-site.html?variant=B&q=q1#top';
  const result = addPrototypeQuestion(url);
  assert.equal(result.code, 0, result.err);
  assert.equal(read(site('orch', 'data', 'owner.json')).items[0].url, url);
});

test('a prototype question accepts a non-empty subset of takes in their recorded order', () => {
  recordPrototype('site', ['A:Keep', 'B:Drop', 'C:Change', 'D:Wait']);
  for (const [n, ids] of [['one', ['A']], ['last', ['D']], ['some', ['B', 'D']]]) {
    write(path.join(home, 'q.json'), question(n, { url: `prototype-site.html?q=${n}`, options: ids.map((id) => ({ id, label: `Take ${id}` })) }));
    const r = board('question', 'add', '--site', 'orch', '--file', path.join(home, 'q.json'));
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(read(site('orch', 'data', 'owner.json')).items.at(-1).options.map((o) => o.id), ids);
  }
});

test('question add checks absolute prototype urls against the recorded prototypes too', () => {
  prototypeRefusal(addPrototypeQuestion('https://example.com/orch/prototype-site.html?q=q1'), 'question q1.url names prototype-site.html, which is not a recorded prototype; record it with board.mjs prototype add site --title "…" --take A:"…", then write its take files');
  recordPrototype();
  const result = addPrototypeQuestion('https://example.com/orch/prototype-site.html?q=q1');
  assert.equal(result.code, 0, result.err);
});

test('a question re-asked on the same topic with the same prototype resolves the unresolved one it replaces', () => {
  recordPrototype();
  recordPrototype('other');
  const add = (q) => { write(path.join(home, 'q.json'), q); return board('question', 'add', '--site', 'orch', '--file', path.join(home, 'q.json')); };
  const on = (id, topic, page) => question(id, { topic, url: `prototype-${page}.html?q=${id}` });
  write(site('orch', 'data', 'owner.json'), { topics: [{ id: 'site', title: 'Site' }], items: [{ ...on('done', 'item:w/A1', 'site'), resolved: 'Picked A.', resolved_at: '2026-10-23T00:00:00Z' }] });
  for (const q of [on('moon', 'item:w/A1', 'site'), on('elsewhere', 'site', 'site'), on('different', 'item:w/A1', 'other')]) assert.deepEqual(add(q).out.split('\n').slice(1), ['']);
  const r = add(on('moon-2', 'item:w/A1', 'site'));
  assert.deepEqual(r, { code: 0, err: '', out: 'question moon-2 added on A1\nreplaced: moon\n' });
  const owner = read(site('orch', 'data', 'owner.json')).items;
  assert.deepEqual(owner.map((q) => [q.id, q.resolved ?? null]), [['done', 'Picked A.'], ['moon', 'Replaced by moon-2'], ['elsewhere', null], ['different', null], ['moon-2', null]]);
  assert.ok(!Number.isNaN(Date.parse(owner[1].resolved_at)));
});

test('question add leaves non-prototype urls unchanged', () => {
  const url = 'https://example.com/design.html?next=prototype-site.html#q=other';
  const result = addPrototypeQuestion(url);
  assert.equal(result.code, 0, result.err);
  assert.equal(read(site('orch', 'data', 'owner.json')).items[0].url, url);
});

test('question add saves none of a batch when a prototype question is invalid', () => {
  write(path.join(home, 'q.json'), [question('first'), question('q1', { url: 'prototype-site.html' })]);
  prototypeRefusal(board('question', 'add', '--site', 'orch', '--file', path.join(home, 'q.json')), 'question q1.url must be prototype-site.html?q=q1 so the pill can pick');
});

test('question add on a card follows answered questions with the first new question, preserving other states and topics', () => {
  recordPrototype();
  const on = (id, extra = {}) => question(id, { topic: 'item:w/A1', ...extra });
  const prototype = (id, extra = {}) => on(id, { url: `prototype-site.html?q=${id}`, ...extra });
  const file = site('orch', 'data', 'owner.json');
  write(file, { topics: [{ id: 'site', title: 'Site' }], items: [
    on('answered'), prototype('answered-prototype'), prototype('open-prototype'), on('open'),
    prototype('replied'), prototype('resolved', { resolved: 'Already settled', resolved_at: '2026-10-24T00:00:00Z' }),
    on('other-card', { topic: 'item:w/ENG-1' }), prototype('declared', { topic: 'site' }),
    on('ask', { topic: 'item:ask:e1' }),
    on('reopened', { resolved: 'Earlier answer', resolved_at: '2026-10-22T00:00:00Z' }),
  ] });
  addEvents(...['answered', 'answered-prototype', 'replied', 'resolved', 'other-card', 'declared', 'ask', 'reopened'].map((id) =>
    ({ id: `answer-${id}`, ts: '2026-10-23T11:00:00Z', kind: 'owner-answer', data: { id, choice: 'A' } })));
  assert.equal(board('reply', 'answer-replied', '--site', 'orch', '--html', '<p>Acted on it.</p>').code, 0);
  const before = fs.readFileSync(file, 'utf8');
  const add = (qs) => run('board.mjs', ['question', 'add', '--site', 'orch', '--file', '-'], JSON.stringify(qs));
  const refused = add([prototype('first'), question('invalid', { options: [] })]);
  assert.equal(refused.code, 1);
  assert.equal(refused.out, '');
  assert.equal(fs.readFileSync(file, 'utf8'), before);

  const r = add([prototype('first'), on('second')]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.out.trim().split('\n').slice(1), [
    'replaced: open-prototype', 'replaced: replied', 'resolved: answered', 'resolved: answered-prototype', 'resolved: reopened',
  ]);
  const items = read(file).items;
  for (const id of ['answered', 'answered-prototype', 'reopened']) {
    const q = items.find((q) => q.id === id);
    assert.equal(q.resolved, 'Followed by first');
    assert.ok(Date.parse(q.resolved_at) <= Date.now());
  }
  for (const id of ['open-prototype', 'replied']) assert.equal(items.find((q) => q.id === id).resolved, 'Replaced by first');
  const original = JSON.parse(before).items;
  for (const id of ['open', 'resolved', 'other-card', 'declared', 'ask']) {
    assert.deepEqual(items.find((q) => q.id === id), original.find((q) => q.id === id));
  }
  const declared = add(on('declared-next', { topic: 'site' }));
  assert.equal(declared.code, 0, declared.err);
  assert.deepEqual(declared.out.trim().split('\n').slice(1), []);
  assert.deepEqual(read(file).items.find((q) => q.id === 'declared'), original.find((q) => q.id === 'declared'));
  const ask = add(on('ask-next', { topic: 'item:ask:e1' }));
  assert.equal(ask.code, 0, ask.err);
  assert.deepEqual(ask.out.trim().split('\n').slice(1), ['resolved: ask']);
  assert.equal(read(file).items.find((q) => q.id === 'ask').resolved, 'Followed by ask-next');
});

test('a new topic takes questions, and resolving one records when', () => {
  assert.equal(board('topic', 'add', 'plan', '--site', 'orch', '--title', 'Plan', '--summary', 'The next wave.').code, 0);
  write(path.join(home, 'q.json'), question('q1', { topic: 'plan' }));
  assert.equal(board('question', 'add', '--site', 'orch', '--file', path.join(home, 'q.json')).code, 0);
  assert.equal(board('question', 'resolve', 'q1', '--site', 'orch', '--note', 'Kept it.').code, 0);
  const owner = read(site('orch', 'data', 'owner.json'));
  assert.deepEqual(owner.topics.at(-1), { id: 'plan', title: 'Plan', summary: 'The next wave.' });
  assert.equal(owner.items[0].resolved, 'Kept it.');
  assert.ok(Date.parse(owner.items[0].resolved_at) <= Date.now());
  assert.equal(board('question', 'resolve', 'q9', '--site', 'orch', '--note', 'x').code, 1);
});

test('resolving a question leaves a missing or empty push queue alone', () => {
  const queue = at('kickflip', 'push', 'queue.json');
  write(site('orch', 'data', 'owner.json'), { items: [question('q1')] });
  assert.equal(board('question', 'resolve', 'q1', '--site', 'orch', '--note', 'Settled').code, 0);
  assert.equal(fs.existsSync(queue), false);
  const empty = '{"items":[]}\n';
  write(queue, empty);
  assert.equal(board('question', 'resolve', 'q1', '--site', 'orch', '--note', 'Still settled').code, 0);
  assert.equal(fs.readFileSync(queue, 'utf8'), empty);
});

test('on a board whose repo is a plain git remote, item set --pushed records the branch In Review and closes the builder, settings refuse GitHub issues, and a GitHub board refuses --pushed', () => {
  const cmd = [process.execPath, fileURLToPath(new URL('./server.mjs', import.meta.url))];
  write(at('kickflip', 'manifest.json'), { sites: { audit: { dir: site('audit'), cmd, remote: 'git@gitlab.com:acme/audit.git', branch: 'main' }, orch: { dir: site('orch'), cmd, github: 'o/r' } } });
  assert.equal(board('builder', 'start', 'audit/A1', '--site', 'audit').code, 0);
  const r = board('item', 'set', 'audit/A1', '--site', 'audit', '--pushed', 'A1');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^A1: pushed A1\n/);
  const { pushed, ...item } = read(site('audit', 'data', 'wave.json')).items[0];
  assert.deepEqual([item.branch, item.status, typeof Date.parse(pushed.at)], ['A1', undefined, 'number']);
  assert.equal(pushed.branch, 'A1');
  assert.ok(read(site('audit', 'data', 'agents', 'A1.json')).done);
  assert.match(board('item', 'set', 'audit/A1', '--site', 'audit', '--pushed', 'bad..branch').err, /branch you pushed/);
  assert.match(board('item', 'set', 'w/A1', '--site', 'orch', '--pushed', 'A1').err, /plain git remote; on GitHub, open a PR and pass --pr/);
  const tickets = board('--site', 'audit', 'settings', 'set', 'tickets', '{"source":"github"}');
  assert.equal(tickets.code, 1);
  assert.match(tickets.err, /GitHub issues need the board’s repo on GitHub/);
  assert.equal(board('--site', 'orch', 'settings', 'set', 'tickets', '{"source":"github"}').code, 0);
});

test("item set --pr adds each PR, repeatable, in the board's repo or owner/repo#n, and never replaces one", () => {
  const file = at('waves', 'w', 'wave.json');
  write(file, { ...wave(), repo: 'o/r', items: [{ id: 'A1', title: 'One', pr: 6, status: 'building' }] });
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--pr', 'lovek4d/lovek4d.github.io#1').code, 0);
  assert.deepEqual(read(file).items[0].prs, [{ number: 6 }, { repo: 'lovek4d/lovek4d.github.io', number: 1 }]);
  assert.equal('pr' in read(file).items[0], false);
  assert.equal(read(file).items[0].status, undefined);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--pr', '6', '--pr', 'o/r#6', '--pr', 'o/api#9', '--pr', 'lovek4d/lovek4d.github.io#1').code, 0);
  assert.deepEqual(read(file).items[0].prs, [{ number: 6 }, { repo: 'lovek4d/lovek4d.github.io', number: 1 }, { repo: 'o/api', number: 9 }]);
  const before = fs.readFileSync(file, 'utf8');
  for (const bad of ['abc', 'o/r#x', 'https://github.com/o/r/pull/3']) {
    const r = board('item', 'set', 'w/A1', '--site', 'orch', '--pr', '7', '--pr', bad);
    assert.equal(r.code, 1, bad);
    assert.match(r.err, /--pr takes a PR number or owner\/repo#<n>/);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('item set edits the item in a waves board and in a file board', () => {
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--status', 'building', '--next', 'Run tests', '--pr', '42').code, 0);
  const { status_at: _w, review_since: arrived, ...edited } = read(at('waves', 'w', 'wave.json')).items[0];
  assert.equal(typeof arrived, 'string');
  assert.deepEqual(edited, { id: 'A1', title: 'One', next: 'Run tests', prs: [{ number: 42 }] });
  for (const [key, route, file] of [['w/A1', 'orch', at('waves', 'w', 'wave.json')], ['audit/A1', 'audit', site('audit', 'data', 'wave.json')]]) {
    for (const status of ['building', 'fixing', 'checking', 'held', 'done']) {
      assert.equal(board('item', 'set', key, '--site', route, '--status', status,...(status === 'done' ? ['--text', 'Done.'] : [])).code, 0);
      assert.equal(board('item', 'set', key, '--site', route, '--pr', '7').code, 0);
      assert.equal(read(file).items[0].status, ['building', 'fixing'].includes(status) ? undefined : status);
    }
  }
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--from-ask', 'e9', '--state', 'ready', '--text', 'On it.').code, 1);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--from-ask', 'e1', '--state', 'grilling', '--text', 'On it.').code, 0);
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].ticket, 'INT-1');
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--from-ask', 'e1', '--state', 'grilling', '--text', 'On it.').code, 0);
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].ticket, 'INT-1');
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].from_ask, 'e1');
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--status', 'checking', '--next', '').code, 0);
  assert.deepEqual([read(at('waves', 'w', 'wave.json')).items[0].status, 'next' in read(at('waves', 'w', 'wave.json')).items[0]], ['checking', false]);
  assert.equal(board('item', 'set', 'audit/A1', '--site', 'audit', '--clear-next', '--status', 'held').code, 0);
  const { status_at: _a, review_since: _r, ...audit } = read(site('audit', 'data', 'wave.json')).items[0];
  assert.deepEqual(audit, { id: 'A1', title: 'One', status: 'held', prs: [{ number: 7 }] });
  assert.equal(board('item', 'set', 'w/A1', '--site', 'audit', '--status', 'held').code, 1);
  assert.equal(board('item', 'set', 'audit/A1', '--site', 'audit', '--status', 'shipped').code, 1);
  assert.equal(board('item', 'set', 'audit/A1', '--site', 'audit', '--pr', 'abc').code, 1);
  assert.equal(board('item', 'set', 'audit/A1', '--site', 'audit').code, 1);
  assert.equal(board('item', 'set', 'audit/A1', '--site', 'audit', '--clear-status').code, 0);
  assert.equal(read(site('audit', 'data', 'wave.json')).items[0].status, undefined);
});

// docs/adr/2026-11-03-0516-a-new-card-is-ready-grilling-or-prototyping.md
test('item set --state sets ready, grilling or prototyping, with --from-ask too, and refuses any other state and ready while a question is open', () => {
  const state = () => read(at('waves', 'w', 'wave.json')).items[0].state;
  const r = board('item', 'set', 'w/A1', '--site', 'orch', '--from-ask', 'e1', '--text', 'On it.', '--state', 'grilling');
  assert.deepEqual([r.code, state()], [0, 'grilling']);
  assert.match(r.out, /grilling/);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--state', 'prototyping').code, 0);
  assert.equal(state(), 'prototyping');
  assert.deepEqual(board('item', 'set', 'w/A1', '--site', 'orch', '--state', 'done'), { code: 1, out: '', err: '--state takes ready, grilling or prototyping\n' });
  write(path.join(home, 'card.json'), question('q1', { topic: 'item:w/A1' }));
  assert.equal(board('question', 'add', '--site', 'orch', '--file', path.join(home, 'card.json')).code, 0);
  assert.deepEqual(board('item', 'set', 'w/A1', '--site', 'orch', '--state', 'ready'), { code: 1, out: '', err: 'w/A1 has an open question q1; it is ready once the owner has answered it\n' });
  assert.equal(state(), 'prototyping');
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--state', 'grilling').code, 0);
  assert.equal(board('question', 'resolve', 'q1', '--site', 'orch', '--note', 'Settled').code, 0);
  write(at('waves', 'w', 'a1.md'), '# A1\n');
  // docs/adr/2026-11-05-0410-a-card-status-word-comes-from-a-signal-the-board-checks.md: a ready card's Next never asks to mark it ready.
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--next', 'Mark ready').code, 0);
  const refused = board('item', 'set', 'w/A1', '--site', 'orch', '--state', 'ready', '--size', 'small', '--notes-file', 'a1.md');
  assert.deepEqual(refused, { code: 1, out: '', err: 'w/A1 would read ready with Next "Mark ready", which asks for the state it is already in; pass --next with what happens next, or --clear-next\n' });
  assert.equal(state(), 'grilling');
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--state', 'ready', '--size', 'small', '--notes-file', 'a1.md', '--clear-next').code, 0);
  assert.equal(state(), 'ready');
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--next', 'mark it ready').code, 1);
});

// docs/adr/2026-11-04-0306-builders-launch-headless-check-their-notes-and-land-on-their-own.md
// docs/adr/2026-11-04-2130-the-hub-launches-every-agent-from-the-card.md
test('ready refuses a card without a size, without a notes file, or whose notes leave out an answered question, and resolves the answered questions its notes carry', () => {
  const state = () => read(at('waves', 'w', 'wave.json')).items[0].state;
  assert.deepEqual(board('item', 'set', 'w/A1', '--site', 'orch', '--state', 'ready'), { code: 1, out: '', err: 'w/A1 has no size; a builder starts from it, so pass --size small or large with --state ready\n' });
  assert.deepEqual(board('item', 'set', 'w/A1', '--site', 'orch', '--state', 'ready', '--size', 'small'), { code: 1, out: '', err: 'w/A1 has no notes file; a builder starts from it, so pass --notes-file <file.md> with --state ready\n' });
  assert.equal(state(), undefined);
  write(path.join(home, 'card.json'), question('q1', { topic: 'item:w/A1' }));
  assert.equal(board('question', 'add', '--site', 'orch', '--file', path.join(home, 'card.json')).code, 0);
  fs.appendFileSync(site('orch', 'data', 'events.jsonl'), JSON.stringify({ id: 'e2', ts: '2026-10-23T11:00:00Z', kind: 'owner-answer', data: { id: 'q1', choice: 'A' } }) + '\n');
  write(at('waves', 'w', 'a1.md'), '# A1\n\nKeep it.\n');
  assert.deepEqual(board('item', 'set', 'w/A1', '--site', 'orch', '--state', 'ready', '--size', 'small', '--notes-file', 'a1.md'), { code: 1, out: '', err: "w/A1's notes leave out the answered question q1; record each answer in a1.md, naming its id, before it is ready\n" });
  write(at('waves', 'w', 'a1.md'), '# A1\n\n- q1: keep it.\n');
  // The notes file came in an earlier command, so ready alone resolves the answer the notes carry.
  const wave = read(at('waves', 'w', 'wave.json'));
  Object.assign(wave.items[0], { size: 'small', plan: 'a1.md' });
  write(at('waves', 'w', 'wave.json'), wave);
  const ready = board('item', 'set', 'w/A1', '--site', 'orch', '--state', 'ready');
  assert.equal(ready.code, 0);
  assert.match(ready.out, /resolved: q1/);
  assert.equal(state(), 'ready');
  assert.ok(read(site('orch', 'data', 'owner.json')).items.find((q) => q.id === 'q1').resolved);
  // There is no setting to turn the check off.
  assert.equal(board('settings', 'set', 'headless-builders', 'off', '--site', 'orch').code, 1);
});

test('item set --next requires unfinished card ids and refs to be deps, and allows finished cards', () => {
  write(site('audit', 'data', 'wave.json'), { internal: true, items: [
    { id: 'A1', title: 'One', next: 'Old' },
    { id: 'S133', title: 'Blocker', status: 'checking' },
    { id: 'INT-134', title: 'Other blocker', status: 'planned' },
    ...['done', 'merged', 'dropped'].map((status, i) => ({ id: `S${140 + i}`, title: 'Finished', status })),
  ] });
  const items = () => read(site('audit', 'data', 'wave.json')).items;
  for (const name of ['S133', 'INT-133', 'audit/S133', 'audit/INT-133', 'INT-134', 'audit/INT-134']) {
    const r = board('item', 'set', 'audit/A1', '--site', 'audit', '--next', `Wait for (${name}).`, '--title', 'Changed');
    assert.equal(r.code, 1, name);
    assert.match(r.err, /audit\/(S133|INT-134).*--deps/);
    assert.equal(r.err.trim().split('\n').length, 1);
    assert.deepEqual(items()[0], { id: 'A1', title: 'One', next: 'Old' });
  }
  for (const next of ['Follow INT-140, audit/S141 and INT-142.', 'Check INT-1330, other/INT-133 and A1.']) {
    assert.equal(board('item', 'set', 'audit/A1', '--site', 'audit', '--next', next).code, 0);
    assert.equal(items()[0].next, next);
  }
  assert.equal(board('item', 'set', 'audit/A1', '--site', 'audit', '--next', 'After INT-133', '--deps', 'S133').code, 0);
  assert.equal(board('item', 'set', 'audit/A1', '--site', 'audit', '--next', 'After audit/INT-133').code, 0);
  assert.equal(board('item', 'set', 'audit/A1', '--site', 'audit', '--next', 'After S133', '--deps', '').code, 1);
  assert.deepEqual(items()[0].deps, ['S133']);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--next', 'After audit/S133').code, 0);
  write(at('waves', 'x', 'wave.json'), { internal: true, items: [{ id: 'S133', title: 'Blocker', status: 'waiting' }] });
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--next', 'After x/INT-133').code, 1);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--next', 'After x/INT-133', '--deps', 'x/S133').code, 0);
});

test('item set --notes-file, or its alias --plan, names a notes file inside the wave folder and refuses a --summary, and --title renames the card', () => {
  write(at('waves', 'w', 'A1-notes.md'), '# So far');
  write(at('waves', 'w', 'A1-old.md'), '# Old');
  const item = () => read(at('waves', 'w', 'wave.json')).items[0];
  const summed = board('item', 'set', 'w/A1', '--site', 'orch', '--notes-file', 'A1-notes.md', '--summary', 'So far.');
  assert.equal(summed.code, 2);
  assert.match(summed.err, /item set does not take --summary/);
  assert.equal(item().plan, undefined);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--notes-file', 'A1-notes.md', '--title', 'One, renamed').code, 0);
  assert.deepEqual([item().plan, item().title], ['A1-notes.md', 'One, renamed']);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--plan', 'A1-old.md').code, 0);
  assert.equal(item().plan, 'A1-old.md');
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--plan', 'A1-old.md', '--notes-file', 'A1-notes.md').code, 2);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--notes-file', '../outside.md').code, 1);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--title', ' ').code, 1);
  assert.equal(board('item', 'add', 'w/B2', '--site', 'orch', '--title', 'Two', '--notes-file', 'A1-notes.md').code, 0);
  assert.equal(read(at('waves', 'w', 'wave.json')).items.at(-1).plan, 'A1-notes.md');
});

test("item set notes resolves a prototype pick with a note, whose note is the build's guidance", () => {
  recordPrototype();
  write(at('waves', 'w', 'notes.md'), '# Picked A');
  const file = site('orch', 'data', 'owner.json');
  assert.equal(addPrototypeQuestion('prototype-site.html?q=q1', { topic: 'item:w/A1' }).code, 0);
  addEvents({ id: 'answer-q1', ts: '2026-10-23T10:00:00Z', kind: 'owner-answer', data: { id: 'q1', choice: 'A', note: 'Bigger' } });
  const r = board('item', 'set', 'w/A1', '--site', 'orch', '--notes-file', 'notes.md');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.out.trim().split('\n').slice(1), ['resolved: q1']);
  assert.equal(read(file).items[0].resolved, "Recorded in the card's notes");
  assert.equal(board('question', 'confirm', 'q1', '--site', 'orch').code, 2);
});

test("item set notes resolves only answered questions, and closing in the same call resolves each question once", () => {
  write(at('waves', 'w', 'notes.md'), '# Settled');
  const file = site('orch', 'data', 'owner.json');
  const on = (id, extra = {}) => question(id, { topic: 'item:w/A1', ...extra });
  const original = [on('answered'), on('open'), on('replied'), on('resolved', { resolved: 'Settled', resolved_at: '2026-10-24T00:00:00Z' }), question('declared'), on('other-card', { topic: 'item:w/ENG-1' })];
  write(file, { topics: [{ id: 'site', title: 'Site' }], items: original });
  addEvents(...['answered', 'replied', 'resolved', 'declared', 'other-card'].map((id) =>
    ({ id: `answer-${id}`, ts: '2026-10-23T11:00:00Z', kind: 'owner-answer', data: { id, choice: 'A' } })));
  assert.equal(board('reply', 'answer-replied', '--site', 'orch', '--html', '<p>Acted on it.</p>').code, 0);
  const before = [fs.readFileSync(file, 'utf8'), fs.readFileSync(at('waves', 'w', 'wave.json'), 'utf8')];
  for (const args of [['--title', ' '], ['--status', 'done']]) {
    const refused = board('item', 'set', 'w/A1', '--site', 'orch', '--notes-file', 'notes.md', ...args);
    assert.equal(refused.code, 1, refused.err);
    assert.equal(refused.out, '');
    assert.deepEqual([fs.readFileSync(file, 'utf8'), fs.readFileSync(at('waves', 'w', 'wave.json'), 'utf8')], before);
  }
  for (const flag of ['--notes-file', '--plan']) {
    write(file, { topics: [{ id: 'site', title: 'Site' }], items: original });
    const r = board('item', 'set', 'w/A1', '--site', 'orch', flag, 'notes.md');
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.out.trim().split('\n').slice(1), ['resolved: answered']);
    const items = read(file).items;
    assert.equal(items[0].resolved, "Recorded in the card's notes");
    assert.ok(Date.parse(items[0].resolved_at) <= Date.now());
    assert.deepEqual(items.slice(1), original.slice(1));
  }
  write(file, { topics: [], items: original });
  const done = board('item', 'set', 'w/A1', '--site', 'orch', '--notes-file', 'notes.md', '--status', 'done', '--force', '--text', 'Done.');
  assert.equal(done.code, 0, done.err);
  assert.deepEqual(done.out.trim().split('\n').slice(1), ['resolved: answered', 'resolved: open', 'resolved: replied']);
  assert.deepEqual(read(file).items.slice(0, 3).map((q) => q.resolved), Array(3).fill('Closed with the card'));
  assert.deepEqual(read(file).items.slice(3), original.slice(3));
});

test('a reply, --status building and builder start each resolve the answered questions they act on, leaving the rest', () => {
  const on = (id, topic) => question(id, { topic });
  const answer = (id) => ({ id: `answer-${id}`, ts: '2026-10-23T11:00:00Z', kind: 'owner-answer', data: { id, choice: 'A' } });
  write(site('orch', 'data', 'owner.json'), { topics: [], items: [on('ask-q', 'item:ask:e1'), on('card-q', 'item:w/A1'), on('wave-q', 'wave:w'), on('open-q', 'item:w/A1')] });
  addEvents({ id: 'e2', ts: '2026-10-23T10:30:00Z', kind: 'wave-triage', data: { wave: 'w' } }, answer('ask-q'), answer('card-q'), answer('wave-q'));
  const notes = () => Object.fromEntries(read(site('orch', 'data', 'owner.json')).items.map((q) => [q.id, q.resolved ?? null]));
  assert.match(board('reply', 'e1', '--site', 'orch', '--html', '<p>Done.</p>').out, /^resolved: ask-q$/m);
  assert.match(board('reply', 'e2', '--site', 'orch', '--html', '<p>Lined up.</p>').out, /^resolved: wave-q$/m);
  const building = board('item', 'set', 'w/A1', '--status', 'building', '--site', 'orch');
  assert.equal(building.code, 0, building.err);
  assert.match(building.out, /^resolved: card-q$/m);
  assert.deepEqual(notes(), { 'ask-q': 'Acted on: replied', 'card-q': 'Acted on: build started', 'wave-q': 'Acted on: replied', 'open-q': null });
  addEvents(answer('open-q'));
  assert.match(board('builder', 'start', 'w/A1', '--site', 'orch').out, /^resolved: open-q$/m);
  assert.equal(notes()['open-q'], 'Acted on: builder started');
});

test('item set --install records a device build with when it was built, takes only https or an iOS manifest link, and --clear-install removes it', () => {
  const ios = 'itms-services://?action=download-manifest&url=https://mac.ts.net/orch/installs/w-A1/manifest.plist';
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--install', ios, '--install-sha', 'ABCDEF1234', '--install-label', 'Install beta').code, 0);
  const { built_at, ...install } = read(at('waves', 'w', 'wave.json')).items[0].install;
  assert.deepEqual(install, { url: ios, label: 'Install beta', sha: 'abcdef1234' });
  assert.ok(Math.abs(Date.parse(built_at) - Date.now()) < 60000);
  assert.equal(board('item', 'set', 'audit/A1', '--site', 'audit', '--install', 'https://mac.ts.net/audit/installs/audit-A1/app.apk').code, 0);
  assert.deepEqual(Object.keys(read(site('audit', 'data', 'wave.json')).items[0].install), ['url', 'built_at']);
  for (const [args, err] of [
    [['--install', 'http://mac.ts.net/app.apk'], /^--install takes an https:\/\/ or itms-services:\/\/ URL/],
    [['--install', 'javascript:alert(1)'], /^--install takes /],
    [['--install', 'itms-services://?action=download-manifest&url=http://x/manifest.plist'], /^--install: an itms-services/],
    [['--install', ios, '--install-sha', 'main'], /^--install-sha takes a commit sha/],
    [['--install-sha', 'abcdef1'], /^--install-sha and --install-label go with --install/],
    [['--install', ios, '--clear-install'], /^pass --install or --clear-install, not both/],
  ]) {
    const r = board('item', 'set', 'w/A1', '--site', 'orch', ...args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err, err, args.join(' '));
  }
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].install.url, ios);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--clear-install').code, 0);
  assert.equal('install' in read(at('waves', 'w', 'wave.json')).items[0], false);
});

// docs/adr/2026-11-03-0526-a-follow-up-is-a-work-card-with-a-parent.md
test('a follow-up is item add --parent; item set sets or clears a Parent and replaces Related to on both sides; the followup commands are gone', () => {
  const item = (id) => read(site('audit', 'data', 'wave.json')).items.find((i) => i.id === id);
  const added = board('item', 'add', 'audit/ENG-7', '--site', 'audit', '--title', 'Tidy', '--parent', 'A1');
  assert.deepEqual([added.code, added.err], [0, '']);
  assert.deepEqual([item('ENG-7').parent, item('ENG-7').status], ['audit/A1', undefined]);
  for (const [args, err] of [
    [['item', 'add', 'audit/X1', '--title', 'X', '--parent', 'NOPE'], /^wave "audit" has no item "NOPE"/],
    [['item', 'set', 'audit/ENG-7', '--parent', 'ENG-7'], /^--parent: a card can't be its own Parent/],
    [['item', 'set', 'audit/A1', '--parent', 'ENG-7'], /^--parent: audit\/ENG-7 is a child of audit\/A1, so it can't be its Parent/],
    [['item', 'set', 'audit/A1', '--related', 'A1'], /^--related: a card can't be related to itself/],
  ]) {
    const r = board(...args, '--site', 'audit');
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err, err, args.join(' '));
  }
  assert.equal(item('X1'), undefined);
  const gone = board('followup', 'add', 'audit', '--site', 'audit', '--id', 'F', '--title', 'F');
  assert.deepEqual([gone.code, /unknown command "followup add"/.test(gone.err)], [2, true]);
  const linked = board('item', 'set', 'audit/A1', '--site', 'audit', '--related', 'ENG-7,audit/ENG-1');
  assert.deepEqual([linked.code, linked.out], [0, 'A1: related to ENG-7, audit/ENG-1\n']);
  assert.deepEqual(item('A1').related, ['audit/ENG-7', 'audit/ENG-1']);
  // Clearing ENG-7's Related to takes it off A1 too, since a link shows on both cards.
  assert.equal(board('item', 'set', 'audit/ENG-7', '--site', 'audit', '--related', '').code, 0);
  assert.deepEqual(item('A1').related, ['audit/ENG-1']);
  assert.equal(board('item', 'set', 'audit/ENG-1', '--site', 'audit', '--related', '').code, 0);
  assert.equal('related' in item('A1'), false);
  const cleared = board('item', 'set', 'audit/ENG-7', '--site', 'audit', '--parent', '');
  assert.deepEqual([cleared.code, cleared.out, 'parent' in item('ENG-7')], [0, 'ENG-7: parent cleared\n', false]);
  assert.equal(board('item', 'set', 'audit/ENG-7', '--site', 'audit', '--parent', 'audit/ENG-1').out, 'ENG-7: parent audit/ENG-1\n');
});

// docs/adr/2026-11-05-0130-the-orchestrator-links-a-new-card-when-it-files-it.md
test('item set --relate adds links and --unrelate removes them on both sides, keeping the rest; neither goes with --related', () => {
  const item = (id) => read(site('audit', 'data', 'wave.json')).items.find((i) => i.id === id);
  for (const id of ['R1', 'R2', 'R3']) assert.equal(board('item', 'add', `audit/${id}`, '--site', 'audit', '--title', id, '--state', 'grilling').code, 0);
  assert.equal(board('item', 'set', 'audit/A1', '--site', 'audit', '--related', 'R1').code, 0);
  const added = board('item', 'set', 'audit/A1', '--site', 'audit', '--relate', 'R2,audit/R1');
  assert.deepEqual([added.code, added.out], [0, 'A1: related to R2, audit/R1 added\n']);
  assert.deepEqual(item('A1').related, ['audit/R1', 'audit/R2']);
  // R3 stores its own link to A1; --unrelate takes it off R3 as well as A1's own list.
  assert.equal(board('item', 'set', 'audit/R3', '--site', 'audit', '--relate', 'A1').code, 0);
  const removed = board('item', 'set', 'audit/A1', '--site', 'audit', '--unrelate', 'R1,R3');
  assert.deepEqual([removed.code, removed.out], [0, 'A1: unrelated from R1, R3\n']);
  assert.deepEqual([item('A1').related, 'related' in item('R3')], [['audit/R2'], false]);
  for (const [args, err] of [
    [['--relate', 'A1'], /^--relate: a card can't be related to itself/],
    [['--relate', 'NOPE'], /^wave "audit" has no item "NOPE"/],
    [['--relate', 'R1', '--related', 'R2'], /^pass --related, or --relate and --unrelate, not both/],
  ]) {
    const r = board('item', 'set', 'audit/A1', '--site', 'audit', ...args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err, err, args.join(' '));
  }
  assert.deepEqual(item('A1').related, ['audit/R2']);
});

test("an agent's item add files the card New and wakes the orchestrator with card-added; item add --state files it at once, linked with --relate", () => {
  const item = (id) => read(site('audit', 'data', 'wave.json')).items.find((i) => i.id === id);
  const events = () => fs.readFileSync(site('audit', 'data', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.kind === 'card-added');
  const before = fs.existsSync(site('audit', 'data', 'events.jsonl')) ? events().length : 0;
  const newCard = board('item', 'add', 'audit/F1', '--site', 'audit', '--title', 'Follow it up', '--parent', 'A1');
  assert.deepEqual([newCard.code, newCard.err], [0, '']);
  assert.deepEqual([item('F1').unfiled, item('F1').state], [true, undefined]);
  assert.deepEqual(events().slice(before).map((e) => e.data), [{ key: 'audit/F1', title: 'Follow it up' }]);
  // The orchestrator's filing turn: links, then the state, which files it.
  const filed = board('item', 'set', 'audit/F1', '--site', 'audit', '--relate', 'A1', '--state', 'grilling');
  assert.equal(filed.code, 0, filed.err);
  assert.deepEqual([item('F1').state, 'unfiled' in item('F1'), item('F1').related], ['grilling', false, ['audit/A1']]);
  const direct = board('item', 'add', 'audit/F2', '--site', 'audit', '--title', 'Filed', '--state', 'prototyping', '--relate', 'A1,F1');
  assert.deepEqual([direct.code, direct.err], [0, '']);
  assert.deepEqual([item('F2').state, 'unfiled' in item('F2'), item('F2').related], ['prototyping', false, ['audit/A1', 'audit/F1']]);
  assert.equal(events().length, before + 1, 'a card filed with its state wakes nobody');
  const bad = board('item', 'add', 'audit/F3', '--site', 'audit', '--title', 'X', '--state', 'done');
  assert.deepEqual([bad.code, /^--state takes ready, grilling or prototyping/.test(bad.err), item('F3')], [1, true, undefined]);
});

test('--parent works when an ancestor of the new Parent no longer exists', () => {
  const file = site('audit', 'data', 'wave.json');
  const data = read(file);
  data.items.push({ id: 'ORPHAN', title: 'Orphan', parent: 'audit/GONE' }, { id: 'KID', title: 'Kid', parent: 'audit/ORPHAN' }, { id: 'NEW', title: 'New' });
  write(file, data);
  const set = board('item', 'set', 'audit/NEW', '--site', 'audit', '--parent', 'audit/KID');
  assert.deepEqual([set.code, set.err, set.out], [0, '', 'NEW: parent audit/KID\n']);
  const cycle = board('item', 'set', 'audit/ORPHAN', '--site', 'audit', '--parent', 'audit/KID');
  assert.match(cycle.err, /^--parent: audit\/KID is a child of audit\/ORPHAN/);
});

// docs/adr/2026-11-03-0526-a-follow-up-is-a-work-card-with-a-parent.md
test("a wave file's follow-ups move into its items once: ids, titles, tickets and notes kept, done ones done, Filed from as the Parent", async (t) => {
  const { migrateFollowups } = await import('./store.mjs');
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; });
  const file = site('audit', 'data', 'wave.json');
  write(file, { title: 'W', items: [{ id: 'A1', title: 'One' }], followups: [
    { id: 'open-one', title: 'Open', from: 'A1', filed: '2026-11-03', ticket: '#51', ticket_created: true, notes: 'Why' },
    { id: 'closed-one', title: 'Closed', from: 'A1', filed: '2026-11-02', ticket: '#65', done: true },
    { id: 'no-from', title: 'Orphan', filed: '2026-11-01' },
  ] });
  write(site('audit', 'data', 'threads', 'audit__closed-one.jsonl'), [{ ts: '2026-11-03T10:00:00.000Z', who: 'claude', text: 'Filed.' }, { ts: '2026-11-03T12:00:00.000Z', who: 'claude', text: 'Done.' }].map((l) => JSON.stringify(l)).join('\n') + '\n');
  assert.deepEqual(await migrateFollowups(site('audit')), ['audit: 3 follow-ups moved to cards (1 done)']);
  const after = read(file);
  assert.equal('followups' in after, false);
  assert.deepEqual(after.items, [
    { id: 'A1', title: 'One' },
    { id: 'open-one', title: 'Open', created: '2026-11-03', parent: 'audit/A1', ticket: '#51', ticket_created: true, notes: 'Why' },
    { id: 'closed-one', title: 'Closed', created: '2026-11-02', parent: 'audit/A1', status: 'done', status_at: '2026-11-03T12:00:00.000Z', ticket: '#65' },
    { id: 'no-from', title: 'Orphan', created: '2026-11-01' },
  ]);
  const text = fs.readFileSync(file, 'utf8');
  assert.deepEqual(await migrateFollowups(site('audit')), []);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  // A follow-up whose id a card already has leaves the file as it is and names the clash.
  write(file, { items: [{ id: 'A1', title: 'One' }], followups: [{ id: 'A1', title: 'Clash', filed: '2026-11-01' }] });
  const clash = fs.readFileSync(file, 'utf8');
  await assert.rejects(migrateFollowups(site('audit')), /audit: follow-up A1 has the id of a card; rename one, then restart the board/);
  assert.equal(fs.readFileSync(file, 'utf8'), clash);
});

// docs/adr/2026-11-05-0226-a-grill-with-nothing-left-to-ask-ends-ready.md
test('status planned is gone: the board drops it from every card on load, and item set --status planned is refused', async (t) => {
  const { dropPlannedStatus } = await import('./store.mjs');
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; });
  const file = site('audit', 'data', 'wave.json');
  write(file, { title: 'W', items: [{ id: 'A1', title: 'One', status: 'planned', state: 'ready' }, { id: 'A2', title: 'Two', status: 'waiting' }, { id: 'A3', title: 'Three', status: 'done' }, { id: 'A4', title: 'Four' }] });
  assert.deepEqual(await dropPlannedStatus(site('audit')), ['audit: 1 planned cards now have no status']);
  assert.deepEqual(read(file).items, [{ id: 'A1', title: 'One', state: 'ready' }, { id: 'A2', title: 'Two', status: 'waiting' }, { id: 'A3', title: 'Three', status: 'done' }, { id: 'A4', title: 'Four' }]);
  assert.deepEqual(await dropPlannedStatus(site('audit')), []);
  const refused = board('item', 'set', 'audit/A2', '--site', 'audit', '--status', 'planned');
  assert.equal(refused.code, 1);
  assert.match(refused.err, /--status planned is gone: an unstarted card has no status/);
  assert.equal(read(file).items[1].status, 'waiting');
});

test("closing a card resolves its answered questions, refuses while one has no answer, changing nothing, and --force closes it anyway", () => {
  board('item', 'add', 'w/A2', '--title', 'Two', '--site', 'orch');
  const on = (key) => ({ topic: `item:${key}` });
  write(site('orch', 'data', 'owner.json'), { topics: [{ id: 'site', title: 'Site' }], items: [
    question('q1', on('w/A1')),
    question('q2', { ...on('w/A1'), resolved: 'Kept.', resolved_at: '2026-10-23T10:00:00Z' }),
    question('q3', { ...on('w/A1'), resolved: 'Old.', resolved_at: '2026-10-23T12:00:00Z' }),
    question('q4'),
    question('q5', on('w/A2')), question('q6', on('w/A2')), question('q7', on('w/A2')),
    question('q8', on('w/ENG-1')), question('q9', on('w/ENG-1')),
  ] });
  fs.appendFileSync(site('orch', 'data', 'events.jsonl'), ['q1', 'q2', 'q3', 'q4', 'q5', 'q8'].map((id) =>
    JSON.stringify({ id: `a-${id}`, ts: '2026-10-23T11:00:00Z', kind: 'owner-answer', data: { id, choice: 'A' } }) + '\n').join(''));
  const owner = () => Object.fromEntries(read(site('orch', 'data', 'owner.json')).items.map((q) => [q.id, q]));
  const notes = () => Object.fromEntries(Object.values(owner()).map((q) => [q.id, q.resolved ?? null]));

  const done = board('item', 'set', 'w/A1', '--status', 'done', '--site', 'orch', '--text', 'Done.');
  assert.equal(done.code, 0, done.err);
  assert.deepEqual(done.out.split('\n').filter((l) => l.startsWith('resolved')), ['resolved: q1', 'resolved: q2']);
  assert.deepEqual(notes(), { q1: 'Closed with the card', q2: 'Closed with the card', q3: 'Old.', q4: null, q5: null, q6: null, q7: null, q8: null, q9: null });
  assert.ok(owner().q2.resolved_at > '2026-10-23T11:00:00Z');

  const before = [fs.readFileSync(at('waves', 'w', 'wave.json'), 'utf8'), fs.readFileSync(site('orch', 'data', 'owner.json'), 'utf8')];
  const unchanged = () => assert.deepEqual([fs.readFileSync(at('waves', 'w', 'wave.json'), 'utf8'), fs.readFileSync(site('orch', 'data', 'owner.json'), 'utf8')], before);
  for (const [args, err] of [
    [['item', 'set', 'w/A2', '--status', 'dropped'], /^--status dropped: w\/A2 has open questions q6, q7 with no answer yet; pass --force/],
    [['item', 'set', 'w/ENG-1', '--status', 'done'], /^--status done: w\/ENG-1 has an open question q9 with no answer yet; pass --force/],
    [['item', 'set', 'w/A2', '--next', 'Later', '--force'], /^--force goes with --status done, merged, dropped/],
  ]) {
    const r = board(...args, '--site', 'orch');
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err, err, args.join(' '));
    assert.equal(r.err.trim().split('\n').length, 1, args.join(' '));
    unchanged();
  }

  assert.equal(board('item', 'set', 'w/A2', '--status', 'dropped', '--force', '--site', 'orch', '--text', 'Dropped.').code, 0);
  const forced = board('item', 'set', 'w/ENG-1', '--status', 'done', '--force', '--site', 'orch', '--text', 'Done.');
  assert.equal(forced.code, 0, forced.err);
  assert.deepEqual(forced.out.split('\n').filter((l) => l.startsWith('resolved')), ['resolved: q8', 'resolved: q9']);
  const wave = read(at('waves', 'w', 'wave.json'));
  assert.deepEqual(['A2', 'ENG-1'].map((id) => wave.items.find((i) => i.id === id).status), ['dropped', 'done']);
  assert.deepEqual(['q5', 'q6', 'q7', 'q8', 'q9'].map((id) => notes()[id]), Array(5).fill('Closed with the card'));
});

test('agent.mjs still writes builder records, beside the wave file it names', () => {
  assert.equal(run('agent.mjs', ['start', 'w/A1', '--label', 'Opus builder']).code, 0);
  assert.equal(read(at('waves', 'w', 'agents', 'A1.json')).label, 'Opus builder');
  assert.equal(run('agent.mjs', ['done', 'w/A1']).code, 0);
  assert.equal(Number.isNaN(Date.parse(read(at('waves', 'w', 'agents', 'A1.json')).done)), false);

  assert.equal(run('agent.mjs', ['start', 'audit/A1', '--dir', site('audit', 'data')]).code, 0);
  assert.equal(typeof read(site('audit', 'data', 'agents', 'A1.json')).started, 'string');
  assert.equal(board('builder', 'done', 'audit/A1', '--site', 'audit').code, 0);
  assert.equal(typeof read(site('audit', 'data', 'agents', 'A1.json')).done, 'string');
  assert.equal(run('agent.mjs', ['start', 'audit/A1', '--dir', site('audit', 'data')]).code, 0);
  assert.equal('done' in read(site('audit', 'data', 'agents', 'A1.json')), false);
  assert.equal(run('agent.mjs', ['start', 'w/Z9']).code, 1);
});

test('builder keeps one record per agent on an item, with its kind and an ETA it can change or clear', () => {
  assert.equal(board('item', 'set', 'w/A1', '--status', 'building').code, 0);
  assert.equal(board('builder', 'start', 'w/A1', '--label', 'Opus builder', '--kind', 'claude').code, 0);
  assert.equal(board('builder', 'start', 'w/A1', '--agent', 'bench', '--kind', 'bench', '--eta', '2026-10-23T16:30:00-07:00').code, 0);
  assert.deepEqual([read(at('waves', 'w', 'agents', 'A1.json')).kind, read(at('waves', 'w', 'agents', 'A1@bench.json')).eta], ['claude', '2026-10-23T23:30:00.000Z']);
  assert.equal(board('builder', 'progress', 'w/A1', 'Still', 'running', '--phase', 'testing', '--site', 'orch', '--agent', 'bench', '--eta', '2026-10-24T01:00:00Z').code, 0);
  assert.equal(read(at('waves', 'w', 'agents', 'A1@bench.json')).eta, '2026-10-24T01:00:00.000Z');
  assert.equal(board('builder', 'progress', 'w/A1', 'Done soon', '--phase', 'testing', '--site', 'orch', '--agent', 'bench', '--clear-eta').code, 0);
  assert.equal('eta' in read(at('waves', 'w', 'agents', 'A1@bench.json')), false);
  assert.match(board('builder', 'progress', 'w/A1', 'x', '--phase', 'testing', '--site', 'orch', '--eta', 'soon').err, /--eta takes an ISO time/);
  assert.equal(board('builder', 'progress', 'w/A1', 'Benchmarking', '--phase', 'testing', '--site', 'orch', '--agent', 'bench', '--eta', '2026-10-24T01:00:00Z').code, 0);
  assert.equal(board('builder', 'done', 'w/A1', '--agent', 'bench').code, 0);
  const bench = read(at('waves', 'w', 'agents', 'A1@bench.json'));
  assert.deepEqual([typeof bench.done, 'eta' in bench, 'done' in read(at('waves', 'w', 'agents', 'A1.json'))], ['string', false, false]);
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].status, 'building');
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--next', 'Review').code, 0);
  assert.equal('done' in read(at('waves', 'w', 'agents', 'A1.json')), false);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--pr', '7').code, 0);
  assert.deepEqual([typeof read(at('waves', 'w', 'agents', 'A1.json')).done, read(at('waves', 'w', 'agents', 'A1@bench.json')).done], ['string', bench.done]);
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].status, undefined);
  for (const [key, flags, file] of [
    ['w/A1', [], at('waves', 'w', 'wave.json')],
    ['audit/A1', ['--site', 'audit'], site('audit', 'data', 'wave.json')],
    ['audit/A1', ['--dir', site('audit', 'data')], site('audit', 'data', 'wave.json')],
  ]) {
    const route = key.startsWith('audit/') ? ['--site', 'audit'] : [];
    for (const status of ['building', 'fixing', 'checking', 'held', 'done']) {
      assert.equal(board('item', 'set', key, ...route, '--status', status, ...(status === 'done' && route.length ? ['--text', 'Done.'] : [])).code, 0);
      const before = read(file).items[0];
      assert.equal(board('builder', 'start', key, ...flags).code, 0);
      assert.equal(board('builder', 'start', key, ...flags, '--agent', 'install', '--kind', 'install').code, 0);
      assert.equal(board('builder', 'done', key, ...flags).code, 0);
      assert.deepEqual(read(file).items[0], before);
      assert.equal(board('builder', 'done', key, ...flags, '--agent', 'install').code, 0);
      const after = read(file).items[0];
      assert.equal(after.status, ['building', 'fixing'].includes(status) ? undefined : status);
      if (!['building', 'fixing'].includes(status)) assert.deepEqual(after, before);
      assert.equal(board('builder', 'done', key, ...flags, '--agent', 'install').code, 0);
      assert.deepEqual(read(file).items[0], after);
    }
  }
});

// docs/adr/2026-11-03-0237-an-in-progress-card-always-has-a-builder-line-or-a-next.md
test('a write that would leave a built card In Progress with nothing building and no Next is refused, naming --next, and writes nothing', () => {
  write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One' }, { id: 'A2', title: 'Two' }] });
  const items = () => read(at('waves', 'w', 'wave.json')).items;
  const main = at('waves', 'w', 'agents', 'A1.json');
  assert.equal(board('builder', 'start', 'w/A1', '--label', 'Opus builder').code, 0);
  assert.equal(board('builder', 'start', 'w/A1', '--agent', 'bench', '--kind', 'bench').code, 0);
  assert.equal(board('builder', 'done', 'w/A1', '--agent', 'bench').code, 0);
  const refused = board('builder', 'done', 'w/A1', '--site', 'orch');
  assert.deepEqual([refused.code, refused.err.trim()], [1, 'builder done closes w/A1\'s last open builder, which leaves it In Progress with no Next; pass --next "<what happens next>", or hand it back with item set w/A1 --status checking or land']);
  assert.equal('done' in read(main), false);
  assert.equal(board('builder', 'done', 'w/A1', '--site', 'orch', '--next', 'Land it').code, 0);
  assert.deepEqual([typeof read(main).done, items()[0].next], ['string', 'Land it']);

  for (const args of [['--clear-next'], ['--next', '']]) {
    const r = board('item', 'set', 'w/A1', '--site', 'orch', ...args);
    assert.deepEqual([r.code, r.err.trim()], [1, 'that leaves w/A1 In Progress with nothing building and no Next; pass --next "<what happens next>"'], args.join(' '));
  }
  assert.equal(items()[0].next, 'Land it');
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--status', 'checking', '--clear-next').code, 0);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--clear-status').code, 1);
  assert.equal(items()[0].status, 'checking');
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--clear-status', '--next', 'Fix the review finding').code, 0);

  // A card only grilled stays in Todo, a checking card reads Orchestrator review, and a held one isn't In Progress.
  assert.equal(board('builder', 'start', 'w/A2', '--kind', 'grill').code, 0);
  assert.equal(board('builder', 'done', 'w/A2', '--site', 'orch').code, 0);
  for (const [flags, status] of [[['--held'], undefined], [['--unheld', '--status', 'checking'], 'checking']]) {
    assert.equal(board('builder', 'start', 'w/A2').code, 0);
    assert.equal(board('item', 'set', 'w/A2', '--site', 'orch', ...flags).code, 0);
    if (status) assert.equal(board('builder', 'start', 'w/A2').code, 0);
    assert.equal(board('builder', 'done', 'w/A2', '--site', 'orch').code, 0, flags.join(' '));
  }
});

test('a hand-back closes ordinary builders while an install survives until explicitly stopped or the card finishes', () => {
  const install = at('waves', 'w', 'agents', 'A1@install.json');
  assert.equal(board('builder', 'start', 'w/A1', '--agent', 'install', '--kind', 'install', '--eta', '2026-10-30T18:00:00Z').code, 0);
  const running = read(install);
  assert.equal(board('builder', 'start', 'w/A1').code, 0);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--pr', '7', '--clear-status').code, 0);
  assert.equal(typeof read(at('waves', 'w', 'agents', 'A1.json')).done, 'string');
  assert.deepEqual(read(install), running);
  assert.equal(board('builder', 'start', 'w/A1', '--agent', 'fix').code, 0);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--status', 'checking').code, 0);
  assert.equal(typeof read(at('waves', 'w', 'agents', 'A1@fix.json')).done, 'string');
  assert.deepEqual(read(install), running);
  assert.equal(board('builder', 'done', 'w/A1', '--agent', 'install').code, 0);
  assert.equal(typeof read(install).done, 'string');
  assert.equal('eta' in read(install), false);
  for (const status of ['done', 'merged', 'dropped']) {
    assert.equal(board('builder', 'start', 'w/A1', '--agent', 'install', '--kind', 'install').code, 0);
    assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--status', status, '--text', 'Closed.').code, 0);
    assert.equal(typeof read(install).done, 'string', status);
  }
});

test('builder start --model records the Claude model and prints it', () => {
  assert.equal(board('item', 'set', 'w/A1', '--status', 'building').code, 0);
  const r = board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'claude', '--model', 'sonnet', '--label', 'Sonnet builder');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^model: Claude Sonnet$/m);
  assert.deepEqual(['kind', 'model'].map((f) => read(at('waves', 'w', 'agents', 'A1.json'))[f]), ['claude', 'sonnet']);
  assert.equal(board('--site', 'orch', 'builder', 'start', 'w/A1', '--agent', 'x', '--kind', 'codex', '--model', 'opus').code, 1);
});

// docs/adr/2026-11-03-0514-a-builder-records-its-judgment-calls-and-the-session-verifies-them.md
test('builder call appends a one-line call to the open record, calls prints them, verified marks them checked, and a restart keeps the unverified ones', () => {
  const main = at('waves', 'w', 'agents', 'A1.json');
  const noRecord = board('builder', 'call', 'w/A1', 'Kept the old name');
  assert.deepEqual([noRecord.code, noRecord.err], [1, 'builder call needs an open builder record on w/A1; run builder start first\n']);
  assert.equal(board('builder', 'start', 'w/A1').code, 0);
  assert.deepEqual(board('builder', 'calls', 'w/A1'), { code: 0, err: '', out: 'no judgment calls recorded\n' });
  assert.match(board('builder', 'verified', 'w/A1').err, /no unverified judgment calls/);
  const said = board('--site', 'orch', 'builder', 'call', 'w/A1', 'Question: does the land check cover every agent?');
  assert.deepEqual([said.code, said.out], [0, 'judgment call recorded on A1\n']);
  assert.equal(board('builder', 'call', 'w/A1', 'Kept', 'the old name').code, 0);
  assert.match(board('builder', 'call', 'w/A1', 'two\nlines').err, /one line/);
  assert.deepEqual(read(main).calls.map((c) => c.text), ['Question: does the land check cover every agent?', 'Kept the old name']);
  assert.deepEqual(board('builder', 'calls', 'w/A1').out.trim().split('\n'), ['1. Question: does the land check cover every agent?', '2. Kept the old name', 'not verified yet']);

  // A hand-back closes the record; a restart of the same agent is that build resumed, its calls and worktree kept.
  write(main, { ...read(main), worktree: { path: '/wt/A1', branch: 'A1', repo: '/repo' } });
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--status', 'checking').code, 0);
  assert.match(board('builder', 'call', 'w/A1', 'Late').err, /needs an open builder record/);
  assert.equal(board('builder', 'start', 'w/A1').code, 0);
  assert.deepEqual([read(main).calls.length, read(main).worktree.path], [2, '/wt/A1']);
  assert.equal(board('builder', 'call', 'w/A1', 'Dropped the cap').code, 0);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--status', 'checking').code, 0);
  // A dispatch on that record, and the agent's own start taking the dispatch up, keep the calls too.
  assert.equal(board('--site', 'orch', 'builder', 'start', 'w/A1', '--dispatch', '--kind', 'claude').code, 0);
  assert.equal(board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'build').code, 0);
  assert.deepEqual([read(main).calls.length, 'dispatched' in read(main)], [3, false]);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--status', 'checking').code, 0);

  const verified = board('--site', 'orch', 'builder', 'verified', 'w/A1', '--note', 'All match the notes.');
  assert.deepEqual([verified.code, verified.out], [0, 'A1: judgment calls verified\n']);
  assert.equal(read(main).verified.note, 'All match the notes.');
  assert.match(board('builder', 'calls', 'w/A1').out, /^3\. Dropped the cap\nverified \S+: All match the notes\.$/m);
  assert.match(board('builder', 'verified', 'w/A1').err, /no unverified judgment calls/);

  // Once verified, a restart is a new build: its record starts with no calls.
  assert.equal(board('builder', 'start', 'w/A1').code, 0);
  assert.deepEqual(['calls' in read(main), 'verified' in read(main), 'worktree' in read(main)], [false, false, false]);
});

test('builder ask posts to the thread as the builder and wakes the orchestrator, which answers or defers to the owner', () => {
  const main = at('waves', 'w', 'agents', 'A1.json');
  const orch = (...args) => board('--site', 'orch', ...args);
  assert.match(orch('builder', 'ask', 'w/A1', 'Stay orange?').err, /needs an open builder record on w\/A1/);
  assert.equal(orch('builder', 'start', 'w/A1', '--kind', 'claude', '--model', 'opus').code, 0);
  assert.match(board('builder', 'ask', 'w/A1', 'Stay orange?').err, /needs --site/);
  const asked = orch('builder', 'ask', 'w/A1', 'Should Implement stay', 'orange?');
  assert.deepEqual([asked.code, asked.out], [0, 'A1: asked the orchestrator, ask1\n']);
  assert.match(orch('builder', 'ask', 'w/A1', 'two\nlines').err, /one line/);
  const [line] = lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).filter((m) => m.kind === 'builder-ask');
  assert.deepEqual([line.who, line.text, line.ask], ['Claude Opus builder', 'Should Implement stay orange?', 'ask1']);
  const event = lines(site('orch', 'data', 'events.jsonl')).at(-1);
  assert.deepEqual([event.kind, event.data], ['builder-ask', { key: 'w/A1', ask: 'ask1', agent: 'main', text: 'Should Implement stay orange?' }]);
  assert.deepEqual(orch('builder', 'asks', 'w/A1').out, 'ask1. Should Implement stay orange?\n  waiting on the orchestrator\n');

  const answered = orch('builder', 'answer', 'w/A1', 'ask1', '--text', 'Go quiet.');
  assert.deepEqual([answered.code, answered.out], [0, 'A1: ask1 answered\n']);
  assert.match(orch('builder', 'answer', 'w/A1', 'ask1', '--text', 'Again').err, /ask1 on w\/A1 is already answered/);
  assert.match(orch('builder', 'answer', 'w/A1', 'ask9', '--text', 'No').err, /no ask "ask9" on w\/A1; builder asks w\/A1 lists them/);
  const reply = lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).at(-1);
  assert.deepEqual([reply.who, reply.kind, reply.ask, reply.text], ['claude', 'builder-answer', 'ask1', 'Go quiet.']);
  assert.equal(orch('builder', 'ask', 'w/A1', 'Fold Done on a new device?').code, 0);
  const deferred = orch('builder', 'defer', 'w/A1', 'ask2', '--text', 'Not sure. Carry on with folded; I put it to the owner after review.');
  assert.deepEqual([deferred.code, deferred.out], [0, 'A1: ask2 deferred to the owner\n']);
  assert.deepEqual(orch('builder', 'asks', 'w/A1').out.trim().split('\n'), ['ask1. Should Implement stay orange?', '  answered: Go quiet.',
    'ask2. Fold Done on a new device?', '  deferred: Not sure. Carry on with folded; I put it to the owner after review.']);
  // A deferred ask is a question for the owner: the build hands back for it, and the review puts it to the owner.
  assert.deepEqual(read(main).calls.map((c) => c.text), ['Question: Fold Done on a new device? (deferred to the owner)']);
  assert.match(orch('builder', 'done', 'w/A1').out, /handed back: checking, Next "Answer the builder's questions"/);
  assert.match(orch('builder', 'verified', 'w/A1').err, /^ask2 on w\/A1 was deferred to the owner; add its question with "ask": "ask2" first\n$/);
  const q = (extra) => ({ id: 'gh-fold', topic: 'item:w/A1', question: 'Fold Done on a new device?', options: [{ id: 'yes', label: 'Folded', recommended: true }, { id: 'no', label: 'Open' }], ...extra });
  write(path.join(home, 'q.json'), q({ ask: 'ask1' }));
  assert.match(orch('question', 'add', '--file', path.join(home, 'q.json')).err, /question gh-fold\.ask names ask1, which the orchestrator answered; only a deferred ask goes to the owner/);
  write(path.join(home, 'q.json'), q({ ask: 'ask2' }));
  assert.equal(orch('question', 'add', '--file', path.join(home, 'q.json')).code, 0);
  assert.equal(orch('builder', 'verified', 'w/A1').code, 0);
});

test('builder pick names the kind that builds now, builder start refuses the other, and --kind build takes the pick', () => {
  const noCodex = (...args) => run('board.mjs', args, undefined, { PATH: path.join(home, 'bin') });
  assert.deepEqual(noCodex('builder', 'pick', 'w/A1', '--site', 'orch'), { code: 0, err: '', out: "claude opus: Codex isn't installed on the host. Claude model is Auto and the card isn't small.\n" });
  assert.equal(noCodex('builder', 'pick', 'w/Z9', '--site', 'orch').code, 1);
  const refused = noCodex('builder', 'start', 'w/A1', '--site', 'orch', '--kind', 'codex');
  assert.deepEqual([refused.code, refused.err], [1, "--kind codex: claude builds now. Codex isn't installed on the host. Claude model is Auto and the card isn't small. Pass --kind claude, or --kind build.\n"]);
  assert.equal(fs.existsSync(at('waves', 'w', 'agents', 'A1.json')), false);
  const picked = noCodex('builder', 'start', 'w/A1', '--site', 'orch', '--kind', 'build');
  assert.equal(picked.code, 0, picked.err);
  assert.match(picked.out, /^kind: claude\. Codex isn't installed on the host\. Claude model is Auto and the card isn't small\.\nmodel: Claude Opus$/m);
  assert.match(picked.out, /^ref: A1$/m);
  assert.equal(read(at('waves', 'w', 'agents', 'A1.json')).kind, 'claude');
  assert.equal(read(at('waves', 'w', 'agents', 'A1.json')).model, 'opus');
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].status, 'building');
  write(at('waves', 'w', 'wave.json'), { ...read(at('waves', 'w', 'wave.json')), items: [...read(at('waves', 'w', 'wave.json')).items, { id: 'A2', title: 'Two', deps: ['A1'] }] });
  const blocked = noCodex('builder', 'start', 'w/A2', '--site', 'orch', '--kind', 'claude');
  assert.equal(blocked.code, 1);
  assert.match(blocked.err, /A1/);
  assert.equal(fs.existsSync(at('waves', 'w', 'agents', 'A2.json')), false);
});

// docs/adr/2026-11-03-1526-usage-picks-opus-auto-or-sonnet-for-claude-builders.md
test("a card's --size and --model feed builder pick's Claude model, and builder start refuses a --model the hub's Claude model rules out", () => {
  const noCodex = (...args) => run('board.mjs', args, undefined, { PATH: path.join(home, 'bin') });
  const card = () => read(at('waves', 'w', 'wave.json')).items[0];
  const pick = () => noCodex('builder', 'pick', 'w/A1', '--site', 'orch').out;
  assert.deepEqual([board('item', 'set', 'w/A1', '--size', 'small').code, card().size], [0, 'small']);
  assert.equal(pick(), "claude sonnet: Codex isn't installed on the host. Claude model is Auto and the card is small.\n");
  assert.deepEqual([board('item', 'set', 'w/A1', '--model', 'opus').code, card().model], [0, 'opus']);
  assert.equal(pick(), "claude opus: Codex isn't installed on the host. Claude model is Auto and the card asks for Claude Opus.\n");
  assert.equal(board('item', 'set', 'w/A1', '--model', '', '--size', '').code, 0);
  assert.deepEqual(['size' in card(), 'model' in card()], [false, false]);
  assert.match(board('item', 'set', 'w/A1', '--size', 'tiny').err, /^--size takes small or large/);
  assert.match(board('item', 'set', 'w/A1', '--model', 'haiku').err, /^--model takes opus or sonnet/);
  const added = board('item', 'add', 'w/A9', '--title', 'Nine', '--size', 'small', '--model', 'sonnet');
  assert.equal(added.code, 0, added.err);
  assert.deepEqual([read(at('waves', 'w', 'wave.json')).items.at(-1).size, read(at('waves', 'w', 'wave.json')).items.at(-1).model], ['small', 'sonnet']);
  assert.equal('state' in read(at('waves', 'w', 'wave.json')).items.at(-1), false, 'a card added without --state gets its grill from the board');
  // docs/adr/2026-11-04-2359-every-card-arriving-in-todo-is-grilled-by-the-board.md: a Quick build is added ready, with
  // what a builder starts from, so the board never grills it.
  const count = () => read(at('waves', 'w', 'wave.json')).items.length;
  const before = count();
  assert.match(board('item', 'add', 'w/Q1', '--title', 'Quick', '--state', 'planned').err, /--state takes ready, grilling or prototyping/);
  write(at('waves', 'w', 'q1.md'), '# Quick\n');
  assert.match(board('item', 'add', 'w/Q1', '--title', 'Quick', '--state', 'ready', '--notes-file', 'q1.md').err, /w\/Q1 has no size; a builder starts from it/);
  assert.match(board('item', 'add', 'w/Q1', '--title', 'Quick', '--state', 'ready', '--size', 'small').err, /w\/Q1 has no notes file/);
  assert.equal(count(), before, 'a refused add writes no card');
  const quick = board('item', 'add', 'w/Q1', '--title', 'Quick', '--state', 'ready', '--size', 'small', '--notes-file', 'q1.md');
  assert.equal(quick.code, 0, quick.err);
  assert.equal(read(at('waves', 'w', 'wave.json')).items.at(-1).state, 'ready');

  write(at('kickflip', 'settings.json'), { claudeModel: 'sonnet' });
  assert.equal(pick(), "claude sonnet: Codex isn't installed on the host. Claude model is Sonnet.\n");
  const refused = noCodex('builder', 'start', 'w/A1', '--site', 'orch', '--kind', 'claude', '--model', 'opus');
  assert.deepEqual([refused.code, refused.err], [1, "--model opus: the hub's Claude model is Sonnet. Pass --model sonnet, or no --model.\n"]);
  assert.equal(fs.existsSync(at('waves', 'w', 'agents', 'A1.json')), false);
  assert.equal(noCodex('builder', 'start', 'w/A1', '--site', 'orch', '--kind', 'opus').code, 1);
  const started = noCodex('builder', 'start', 'w/A1', '--site', 'orch', '--kind', 'build');
  assert.equal(started.code, 0, started.err);
  assert.match(started.out, /^kind: claude\. Codex isn't installed on the host\. Claude model is Sonnet\.\nmodel: Claude Sonnet$/m);
  assert.equal(read(at('waves', 'w', 'agents', 'A1.json')).model, 'sonnet');
  // A kind other than a build keeps its own model.
  assert.equal(noCodex('builder', 'start', 'w/A1', '--site', 'orch', '--agent', 'p', '--kind', 'prototype', '--model', 'opus').code, 0);
});

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const commit = (dir, file, text, subject = `change ${file}`) => { write(path.join(dir, file), text); git(dir, 'add', '-A'); git(dir, 'commit', '--quiet', '-m', subject); };
function scratchRepo() {
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
const heldBoard = () => write(site('orch', 'board.json'), { ...read(site('orch', 'board.json')), auto_merge: false });
const worktree = () => at('kickflip', 'worktrees', 'A1');
const restarts = () => (fs.existsSync(path.join(home, 'restarts')) ? fs.readFileSync(path.join(home, 'restarts'), 'utf8').trim().split('\n') : []);
const land = () => run('board.mjs', ['land', 'w/A1'], undefined, {
  KICKFLIP_RESTART_CMD: JSON.stringify([process.execPath, '-e', "require('fs').appendFileSync(process.argv[1], process.argv.slice(2).join(' ') + '\\n')", path.join(home, 'restarts')]),
});
const branches = (repo) => git(repo, 'branch', '--format=%(refname:short)').split('\n');

test('builder start --worktree makes a worktree on a new branch from main, keeps it on the record and prints it, and refuses a taken path or branch', () => {
  const repo = scratchRepo();
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  commit(repo, 'landed.txt', 'locally landed');
  const r = board('builder', 'start', 'w/A1', '--worktree', '--repo', repo);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `A1: builder started\nworktree: ${worktree()}\n`);
  assert.deepEqual(read(at('waves', 'w', 'agents', 'A1.json')).worktree, { path: worktree(), branch: 'A1', repo });
  assert.equal(git(worktree(), 'rev-parse', '--abbrev-ref', 'HEAD'), 'A1');
  assert.equal(git(worktree(), 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'main'));
  const taken = board('builder', 'start', 'w/A1', '--agent', 'two', '--worktree', '--repo', repo);
  assert.deepEqual([taken.code, taken.err], [1, `--worktree: ${worktree()} already exists and another open builder record uses it; land or remove it first\n`]);
  assert.equal(fs.existsSync(at('waves', 'w', 'agents', 'A1@two.json')), false);
  git(repo, 'worktree', 'remove', worktree());
  const branch = board('builder', 'start', 'w/A1', '--agent', 'two', '--worktree', '--repo', repo);
  assert.deepEqual([branch.code, branch.err], [1, `--worktree: branch A1 already exists in ${repo}\n`]);
  assert.equal(fs.existsSync(worktree()), false);
  assert.equal(board('builder', 'start', 'w/A1', '--repo', repo).code, 2);
});

test("a build start on a board makes the card's worktree when its record keeps none, and the agent taking up a dispatched record keeps that one", () => {
  const repo = scratchRepo();
  write(at('kickflip', 'manifest.json'), { sites: { orch: { dir: site('orch'), port: 1, cmd: [process.execPath, '/skill/board/server.mjs', site('orch')], owner: { repo } } } });
  const dispatched = board('--site', 'orch', 'builder', 'start', 'w/A1', '--dispatch', '--kind', 'claude');
  assert.equal(dispatched.code, 0, dispatched.err);
  assert.ok(dispatched.out.includes(`worktree: ${worktree()}\n`), dispatched.out);
  assert.equal(git(worktree(), 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'main'));
  const taken = board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'build', '--label', 'Opus implementer');
  assert.equal(taken.code, 0, taken.err);
  assert.deepEqual(read(at('waves', 'w', 'agents', 'A1.json')).worktree, { path: worktree(), branch: 'A1', repo });
  assert.equal(board('--site', 'orch', 'builder', 'start', 'w/A1', '--agent', 'notes', '--label', 'Notes').code, 0);
  assert.equal(read(at('waves', 'w', 'agents', 'A1@notes.json')).worktree, undefined);
  assert.deepEqual(branches(repo), ['A1', 'main']);

  commit(worktree(), 'work.txt', 'built');
  assert.equal(board('--site', 'orch', 'builder', 'done', 'w/A1', '--next', 'Check the build').code, 0);
  const again = board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'build');
  assert.equal(again.code, 0, again.err);
  assert.deepEqual(read(at('waves', 'w', 'agents', 'A1.json')).worktree, { path: worktree(), branch: 'A1', repo });
  assert.equal(fs.readFileSync(path.join(worktree(), 'work.txt'), 'utf8'), 'built');
});

test('builder start --worktree remakes a leftover worktree that holds no work from current main, saying so, and refuses one holding commits or changes, naming them', () => {
  const repo = scratchRepo();
  const leftover = () => git(repo, 'worktree', 'add', '--quiet', '-b', 'A1', worktree(), 'main');
  leftover();
  write(path.join(worktree(), 'node_modules', 'x.js'), 'ignored\n');
  write(path.join(repo, '.git', 'info', 'exclude'), 'node_modules\n');
  commit(worktree(), 'ahead.txt', 'unlanded');
  const refused = board('builder', 'start', 'w/A1', '--worktree', '--repo', repo);
  assert.deepEqual([refused.code, refused.err], [1, `--worktree: ${worktree()} holds 1 commit beyond main; land or remove it first\n`]);
  write(path.join(worktree(), 'a.txt'), 'new\n');
  write(path.join(worktree(), 'shared', 'notes.md'), 'b\n');
  const both = board('builder', 'start', 'w/A1', '--worktree', '--repo', repo);
  assert.deepEqual([both.code, both.err], [1, `--worktree: ${worktree()} holds 1 commit beyond main and 2 changed files; land or remove it first\n`]);
  git(worktree(), 'reset', '--quiet', '--hard', 'main');
  const changed = board('builder', 'start', 'w/A1', '--worktree', '--repo', repo);
  assert.deepEqual([changed.code, changed.err], [1, `--worktree: ${worktree()} holds 1 changed file; land or remove it first\n`]);
  assert.equal(fs.existsSync(at('waves', 'w', 'agents', 'A1.json')), false);

  fs.rmSync(path.join(worktree(), 'a.txt'));
  commit(repo, 'landed.txt', 'main moved');
  const r = board('builder', 'start', 'w/A1', '--worktree', '--repo', repo);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `A1: builder started\nworktree: ${worktree()}\nRemade the leftover worktree ${worktree()} from main: it held no commits or changes.\n`);
  assert.equal(git(worktree(), 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'main'));
  assert.equal(fs.existsSync(path.join(worktree(), 'node_modules')), false);
  assert.deepEqual(read(at('waves', 'w', 'agents', 'A1.json')).worktree, { path: worktree(), branch: 'A1', repo });
});

test("builder start stores the installed link for the kickflip fallback repo, and the hub board builds from its own folder's local main like any local board", async () => {
  const clone = scratchRepo();
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const dir of ['bin', 'board', 'hub', 'shared', 'hooks-plugin']) fs.cpSync(path.join(source, dir), path.join(clone, dir), { recursive: true, filter: (file) => !file.endsWith('.test.mjs') });
  git(clone, 'add', '-A');
  git(clone, 'commit', '--quiet', '-m', 'kickflip fixture');
  const { installLinks } = await import('../bin/install.mjs');
  const [{ link }] = installLinks({ home, cloneRoot: clone });
  const [hubPort] = await freePorts();
  const start = (...args) => spawnSync(process.execPath, [path.join(link, 'board', 'bin', 'board.mjs'), ...args, 'builder', 'start', 'w/A1', '--worktree'], { env: { ...process.env, HOME: home, KICKFLIP_HUB_PORT: String(hubPort) }, encoding: 'utf8' });
  const result = start();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(read(at('waves', 'w', 'agents', 'A1.json')).worktree, { path: worktree(), branch: 'A1', repo: link });
  assert.equal(git(worktree(), 'rev-parse', 'HEAD'), git(clone, 'rev-parse', 'main'));

  git(clone, 'worktree', 'remove', worktree());
  git(clone, 'branch', '--quiet', '-D', 'A1');
  const project = path.join(home, 'project');
  fs.mkdirSync(project);
  git(project, 'init', '--quiet', '-b', 'main');
  git(project, 'config', 'user.name', 'Test');
  git(project, 'config', 'user.email', 'test@example.com');
  commit(project, 'project.txt', 'project');
  const manifest = read(at('kickflip', 'manifest.json'));
  Object.assign(manifest.sites.orch, { hub: true, local: true, github: 'owner/project', branch: 'main', owner: { repo: project } });
  write(at('kickflip', 'manifest.json'), manifest);
  const hub = start('--site', 'orch');
  assert.equal(hub.status, 0, hub.stderr);
  assert.deepEqual(read(at('waves', 'w', 'agents', 'A1.json')).worktree, { path: worktree(), branch: 'A1', repo: project });
  assert.equal(git(worktree(), 'rev-parse', 'HEAD'), git(project, 'rev-parse', 'main'));
  assert.deepEqual(branches(clone), ['main']);
});

test("item set --status building gives the card its worktree before any builder runs and a later build start keeps it", () => {
  const repo = scratchRepo();
  write(at('kickflip', 'manifest.json'), { sites: { orch: { dir: site('orch'), port: 1, cmd: [process.execPath, '/skill/board/server.mjs', site('orch')], owner: { repo } } } });
  const set = board('--site', 'orch', 'item', 'set', 'w/A1', '--status', 'building');
  assert.equal(set.code, 0, set.err);
  assert.equal(git(worktree(), 'rev-parse', '--abbrev-ref', 'HEAD'), 'A1');
  assert.deepEqual(read(at('waves', 'w', 'wave.json')).items.find((i) => i.id === 'A1').worktree, { path: worktree(), branch: 'A1', repo });
  assert.equal(fs.existsSync(at('waves', 'w', 'agents', 'A1.json')), false);
  commit(worktree(), 'work.txt', 'built');
  const started = board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'build');
  assert.equal(started.code, 0, started.err);
  assert.deepEqual(read(at('waves', 'w', 'agents', 'A1.json')).worktree, { path: worktree(), branch: 'A1', repo });
  assert.equal(fs.readFileSync(path.join(worktree(), 'work.txt'), 'utf8'), 'built');
});

test('a board builder uses its shared clone and selected remote branch without changing the clone checkout', () => {
  const origin = scratchRepo();
  git(origin, 'checkout', '--quiet', '-b', 'develop');
  commit(origin, 'develop.txt', 'develop');
  const repo = path.join(home, 'clone');
  git(home, 'clone', '--quiet', '--branch', 'main', origin, repo);
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'checkout', '--quiet', '-b', 'develop', 'origin/develop');
  commit(repo, 'local.txt', 'local only');
  git(repo, 'checkout', '--quiet', 'main');
  commit(origin, 'pushed.txt', 'pushed after the clone');
  const head = git(origin, 'rev-parse', 'HEAD');
  const manifest = read(at('kickflip', 'manifest.json'));
  Object.assign(manifest.sites.orch, { github: 'owner/project', branch: 'develop', owner: { repo } });
  write(at('kickflip', 'manifest.json'), manifest);
  const r = board('--site', 'orch', 'builder', 'start', 'w/A1', '--worktree');
  assert.equal(r.code, 0, r.err);
  assert.equal(git(worktree(), 'rev-parse', 'HEAD'), head);
  assert.equal(git(repo, 'branch', '--show-current'), 'main');
  assert.equal(read(at('waves', 'w', 'agents', 'A1.json')).worktree.repo, repo);
});

test('land refuses a new ADR named with a number instead of a timestamp, naming it and the name to use, and changes nothing; numbered ADRs already on main pass', () => {
  const repo = scratchRepo();
  commit(repo, 'docs/adr/0007-old.md', '# Old\n');
  assert.equal(board('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
  commit(worktree(), 'docs/adr/2026-11-03-1111-fine.md', '# Fine\n');
  commit(worktree(), 'docs/adr/0008-numbered-again.md', '# Numbered again\n');
  const main = git(repo, 'rev-parse', 'main');
  const r = land();
  assert.deepEqual([r.code, r.out, r.err], [1, '', 'land: docs/adr/0008-numbered-again.md is named with a number; name it docs/adr/YYYY-MM-DD-HHMM-numbered-again.md, the time you wrote it, and land again\n']);
  assert.equal(git(repo, 'rev-parse', 'main'), main);
  assert.equal(git(worktree(), 'status', '--porcelain'), '');
  assert.ok(fs.existsSync(worktree()));
  assert.ok(branches(repo).includes('A1'));

  git(worktree(), 'mv', 'docs/adr/0008-numbered-again.md', 'docs/adr/2026-11-03-1112-numbered-again.md');
  git(worktree(), 'commit', '--quiet', '-m', 'name it by time');
  const landed = land();
  assert.equal(landed.code, 0, landed.err);
  assert.deepEqual(fs.readdirSync(path.join(repo, 'docs', 'adr')).sort(), ['0007-old.md', '2026-11-03-1111-fine.md', '2026-11-03-1112-numbered-again.md']);
});

test("land --site refuses a commit whose subject doesn't start with the card's ref and a colon, and one whose message still holds a \"# Conflicts:\" note, naming the commit, and changes nothing", () => {
  const repo = scratchRepo();
  assert.equal(board('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
  const landOn = () => run('board.mjs', ['land', 'w/A1', '--site', 'orch', '--text', 'Checked.'], undefined, { KICKFLIP_RESTART_CMD: JSON.stringify([process.execPath, '-e', '0']) });
  const say = (message) => { write(path.join(worktree(), 'card.txt'), message); git(worktree(), 'add', '-A'); git(worktree(), '-c', 'core.commentChar=;', 'commit', '--quiet', '-m', message); return git(worktree(), 'rev-parse', '--short', 'HEAD'); };
  const main = git(repo, 'rev-parse', 'main');

  const bare = say('no ref here');
  assert.deepEqual([landOn().code, landOn().err], [1, `land: commit ${bare} "no ref here" doesn't start with "A1: "; reword it and land again\n`]);
  git(worktree(), 'reset', '--quiet', '--hard', 'main');

  const noSpace = say('A1:no space');
  assert.match(landOn().err, new RegExp(`^land: commit ${noSpace} "A1:no space" doesn't start with`));
  git(worktree(), 'reset', '--quiet', '--hard', 'main');

  const noted = say('A1: fine\n\nCo-Authored-By: X\n\n# Conflicts:\n#\tshared/notes.md');
  const r = landOn();
  assert.deepEqual([r.code, r.out, r.err], [1, '', `land: commit ${noted} "A1: fine" still holds a "# Conflicts:" note in its message; amend it out and land again\n`]);
  assert.equal(git(repo, 'rev-parse', 'main'), main);
  assert.ok(fs.existsSync(worktree()));

  git(worktree(), '-c', 'core.commentChar=;', 'commit', '--quiet', '--amend', '-m', 'A1: fine\n\nCo-Authored-By: X');
  const landed = landOn();
  assert.equal(landed.code, 0, landed.err);
  assert.equal(git(repo, 'log', '-1', '--format=%s', 'main'), 'A1: fine');
});

test('land refuses a worktree with uncommitted changes, with no commit beyond main, or whose suite fails, leaving main and the worktree as they were', () => {
  const repo = scratchRepo();
  assert.equal(board('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
  const main = git(repo, 'rev-parse', 'main');
  const lock = at('kickflip', 'land.lock');
  // A refusal while preparing never reaches the land lock (docs/adr/2026-11-04-2320-a-merge-tap-waits-its-turn-to-land.md).
  write(lock, { card: 'B2', pid: process.pid, at: '2026-11-02T10:00:00.000Z' });
  const none = land();
  assert.deepEqual([none.code, none.err], [1, 'A1 has no commits beyond main; nothing to land\n']);
  assert.equal(read(lock).card, 'B2');
  fs.rmSync(lock);
  write(path.join(worktree(), 'board', 'server.mjs'), '2\n');
  const dirty = land();
  assert.deepEqual([dirty.code, dirty.err], [1, `${worktree()} has uncommitted changes; commit them there first\n`]);
  git(worktree(), 'add', '-A');
  git(worktree(), 'commit', '--quiet', '-m', 'board');
  commit(worktree(), 'bad.test.mjs', "import test from 'node:test';\ntest('fixture suite', async (t) => {\n  await t.test('bad fixture', () => { throw new Error('fixture error\\nsecond error line\\nthird error line\\nfourth error line'); });\n});\n");
  commit(worktree(), 'other.test.mjs', "import test from 'node:test';\ntest('other failing fixture', () => { console.error('fixture stderr'); throw new Error('other fixture error'); });\n");
  commit(worktree(), 'crash.test.mjs', "throw new Error('fixture module crash');\n");
  const failing = land();
  assert.equal(failing.code, 1);
  assert.match(failing.err, /tests failed in .* \(4 failing\); nothing landed/);
  assert.match(failing.err, /fixture suite > bad fixture/);
  assert.match(failing.err, /other failing fixture/);
  assert.match(failing.err, /other fixture error/);
  assert.match(failing.err, /Error: fixture module crash/);
  assert.ok(failing.err.includes(path.join(worktree(), 'crash.test.mjs')));
  assert.ok(failing.err.includes(path.join(worktree(), 'other.test.mjs')));
  assert.ok(failing.err.includes(path.join(worktree(), 'bad.test.mjs')));
  assert.match(failing.err, /fixture error\n.*second error line\n.*third error line/);
  assert.doesNotMatch(failing.err, /fourth error line/);
  const log = failing.err.match(/Full test output: (.+)\n/)?.[1];
  assert.ok(log);
  assert.equal(path.dirname(log), at('kickflip', 'logs'));
  const tap = fs.readFileSync(log, 'utf8');
  assert.match(tap, /^TAP version 13\n/);
  assert.match(tap, /not ok .*bad fixture/);
  assert.match(tap, /fourth error line/);
  assert.match(tap, /fixture stderr/);
  assert.equal(git(worktree(), 'status', '--porcelain'), '');
  assert.equal(git(repo, 'rev-parse', 'main'), main);
  assert.ok(fs.existsSync(worktree()));
  assert.ok(branches(repo).includes('A1'));
  assert.deepEqual(restarts(), []);
});

test("a local board, or one with no GitHub repo or git remote, branches from its own folder's local branch and lands there, never kickflip's clone", () => {
  scratchRepo();
  const project = path.join(home, 'local-project');
  fs.mkdirSync(project);
  git(project, 'init', '--quiet', '-b', 'main');
  git(project, 'config', 'user.name', 'Test');
  git(project, 'config', 'user.email', 'test@example.com');
  commit(project, 'project.txt', 'pushed');
  git(project, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(project, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
  commit(project, 'landed.txt', 'only on local main');
  const setOrch = (fields) => {
    const manifest = read(at('kickflip', 'manifest.json'));
    manifest.sites.orch = { dir: manifest.sites.orch.dir, port: 1, cmd: manifest.sites.orch.cmd, ...fields };
    write(at('kickflip', 'manifest.json'), manifest);
  };
  const reset = () => { git(project, 'worktree', 'remove', '--force', worktree()); git(project, 'branch', '--quiet', '-D', 'A1'); };
  for (const fields of [{ owner: { repo: project } }, { github: 'owner/project', branch: 'main', local: true, owner: { repo: project } }]) {
    setOrch(fields);
    const r = board('--site', 'orch', 'builder', 'start', 'w/A1', '--worktree');
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(read(at('waves', 'w', 'agents', 'A1.json')).worktree, { path: worktree(), branch: 'A1', repo: project });
    assert.equal(git(worktree(), 'rev-parse', 'HEAD'), git(project, 'rev-parse', 'main'));
    reset();
  }

  setOrch({});
  const none = board('--site', 'orch', 'builder', 'start', 'w/A1', '--worktree');
  assert.deepEqual([none.code, none.err], [1, '/orch has no folder recorded for its session; rejoin it from its repo folder\n']);

  setOrch({ owner: { repo: project } });
  fs.rmSync(at('waves', 'w', 'agents'), { recursive: true });
  git(project, 'worktree', 'add', '--quiet', '-b', 'A1', worktree(), 'main');
  commit(worktree(), 'card.txt', 'card', 'A1: card');
  const landed = run('board.mjs', ['land', 'w/A1', '--site', 'orch', '--text', 'Checked.'], undefined, { KICKFLIP_RESTART_CMD: JSON.stringify([process.execPath, '-e', '0']) });
  assert.equal(landed.code, 0, landed.err);
  assert.match(landed.out, new RegExp(`main fast-forwarded to \\w+ in ${project}`));
  assert.equal(fs.readFileSync(path.join(project, 'card.txt'), 'utf8'), 'card');
});

test('a local board whose recorded branch is trunk branches from trunk and lands there, refusing while its folder is on another branch, naming trunk', () => {
  scratchRepo();
  const project = path.join(home, 'trunk-project');
  fs.mkdirSync(project);
  git(project, 'init', '--quiet', '-b', 'trunk');
  git(project, 'config', 'user.name', 'Test');
  git(project, 'config', 'user.email', 'test@example.com');
  commit(project, 'project.txt', 'trunk');
  const manifest = read(at('kickflip', 'manifest.json'));
  manifest.sites.orch = { dir: manifest.sites.orch.dir, port: 1, cmd: manifest.sites.orch.cmd, local: true, branch: 'trunk', owner: { repo: project } };
  write(at('kickflip', 'manifest.json'), manifest);
  const started = board('--site', 'orch', 'builder', 'start', 'w/A1', '--worktree');
  assert.equal(started.code, 0, started.err);
  assert.equal(git(worktree(), 'rev-parse', 'HEAD'), git(project, 'rev-parse', 'trunk'));
  commit(worktree(), 'card.txt', 'card', 'A1: card');

  git(project, 'switch', '--quiet', '-c', 'feature');
  const landTrunk = () => run('board.mjs', ['land', 'w/A1', '--site', 'orch', '--text', 'Checked.'], undefined, { KICKFLIP_RESTART_CMD: JSON.stringify([process.execPath, '-e', '0']) });
  const refused = landTrunk();
  assert.deepEqual([refused.code, refused.err], [1, `${project} is on feature, not trunk; switch it to trunk (git -C ${project} switch trunk) and land again\n`]);

  git(project, 'switch', '--quiet', 'trunk');
  commit(project, 'moved.txt', 'trunk moved');
  const moved = git(project, 'rev-parse', '--short', 'trunk');
  const landed = landTrunk();
  assert.equal(landed.code, 0, landed.err);
  const tip = git(project, 'rev-parse', '--short', 'trunk');
  assert.deepEqual(landed.out.trim().split('\n').slice(0, 3), [`rebased A1 onto trunk (${moved})`, 'tests passed: 0', `trunk fast-forwarded to ${tip} in ${project}`]);
  assert.equal(fs.readFileSync(path.join(project, 'card.txt'), 'utf8'), 'card');
  assert.equal(git(project, 'rev-parse', 'trunk~1'), git(project, 'rev-parse', moved));
});

test('land keeps a "#N: subject" commit through its rebase, and refuses a commit with an empty subject before fast-forwarding main', () => {
  const repo = scratchRepo();
  assert.equal(board('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
  write(path.join(worktree(), 'board', 'server.mjs'), '2\n');
  git(worktree(), 'add', '-A');
  git(worktree(), '-c', 'core.commentChar=;', 'commit', '--quiet', '-m', '#7: subject');
  commit(repo, 'shared/notes.md', 'b\n');
  const before = git(repo, 'rev-parse', 'main');
  const r = land();
  assert.equal(r.code, 0, r.err);
  assert.equal(git(repo, 'log', '-1', '--format=%s', 'main'), '#7: subject');
  assert.equal(git(repo, 'rev-parse', 'main~1'), before);
});

test('land refuses a commit with an empty subject, naming it, and leaves main as it was', () => {
  const repo = scratchRepo();
  assert.equal(board('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
  write(path.join(worktree(), 'board', 'server.mjs'), '2\n');
  git(worktree(), 'add', '-A');
  git(worktree(), 'commit', '--quiet', '--allow-empty-message', '--cleanup=verbatim', '-m', '');
  const sha = git(worktree(), 'rev-parse', '--short', 'HEAD');
  const main = git(repo, 'rev-parse', 'main');
  const r = land();
  assert.equal(r.code, 1);
  assert.match(r.err, new RegExp(`empty subject \\(${sha}\\)`));
  assert.equal(git(repo, 'rev-parse', 'main'), main);
});

test('land rebases onto a moved main, fast-forwards main, and removes the worktree and branch; a repo other than the running kickflip clone restarts nothing', () => {
  const repo = scratchRepo();
  assert.equal(board('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
  commit(worktree(), 'board/server.mjs', '2\n');
  commit(worktree(), 'hub/hub.mjs', "import { a } from '../shared/lib.mjs';\n// 2\n");
  commit(repo, 'shared/notes.md', 'b\n');
  const moved = git(repo, 'rev-parse', '--short', 'main');
  const r = land();
  assert.equal(r.code, 0, r.err);
  const main = git(repo, 'rev-parse', '--short', 'main');
  assert.deepEqual(r.out.trim().split('\n'), [
    `rebased A1 onto main (${moved})`, 'tests passed: 1', `main fast-forwarded to ${main} in ${repo}`,
    `worktree removed: ${worktree()}`, 'branch deleted: A1',
  ]);
  assert.equal(git(repo, 'rev-parse', 'main~2'), git(repo, 'rev-parse', moved));
  assert.equal(fs.readFileSync(path.join(repo, 'board', 'server.mjs'), 'utf8'), '2\n');
  assert.deepEqual(restarts(), []);
  assert.equal(fs.existsSync(worktree()), false);
  assert.deepEqual(branches(repo), ['main']);
});

test("land into the running kickflip clone restarts only the code that changed: the hub for its code, else every board for board/, nothing for tests or docs", async (t) => {
  // In process, so HOME is pointed at the test's home: the land's test slot is then not the host's.
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; });
  const repo = scratchRepo();
  const restarted = [];
  const landHere = async () => {
    const said = [];
    await landWorktree({ path: worktree(), branch: 'A1', repo, base: 'main' }, {
      clone: repo, say: (line) => said.push(line), runTests: () => ({ ok: true, pass: 1 }),
      restart: (what, route) => { restarted.push([what, route].filter(Boolean).join(' ')); return null; },
      boards: () => [{ route: 'orch' }, { route: 'audit' }],
    });
    return said;
  };
  const card = async (...files) => {
    assert.equal(board('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
    for (const [file, text] of files) commit(worktree(), file, text);
    return landHere();
  };
  assert.ok((await card(['board/server.mjs', '2\n'])).includes('board restarted: audit'));
  assert.deepEqual(restarted, ['board orch', 'board audit']);
  assert.ok((await card(['shared/lib.mjs', 'export const a = 2;\n'], ['board/server.mjs', '3\n'])).includes('hub restarted, with every site'));
  assert.deepEqual(restarted, ['board orch', 'board audit', 'hub']);
  const tests = await card(['hub/hub.test.mjs', '// t\n'], ['board/server.test.mjs', '// t\n'], ['shared/notes.md', 'c\n']);
  assert.equal(tests.some((line) => /restarted/.test(line)), false);
  assert.deepEqual(restarted, ['board orch', 'board audit', 'hub']);
});

test('land on --site needs --text, refuses before landing what closing would refuse, and closes the card as done once it lands', () => {
  const repo = scratchRepo();
  assert.equal(board('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
  commit(worktree(), 'shared/notes.md', 'b\n', 'A1: notes');
  const landOn = (...more) => run('board.mjs', ['land', 'w/A1', '--site', 'orch', ...more], undefined, {
    KICKFLIP_RESTART_CMD: JSON.stringify([process.execPath, '-e', '0']),
  });
  assert.equal(landOn().code, 2);
  write(site('orch', 'data', 'owner.json'), { topics: [], items: [question('q1', { topic: 'item:w/A1' })] });
  const main = git(repo, 'rev-parse', 'main');
  const open = landOn('--text', 'Checked on the phone.');
  assert.equal(open.code, 1);
  assert.match(open.err, /^land: w\/A1 has an open question q1 with no answer yet/);
  assert.equal(git(repo, 'rev-parse', 'main'), main);
  addEvents({ id: 'answer-q1', ts: '2026-10-23T11:00:00Z', kind: 'owner-answer', data: { id: 'q1', choice: 'A' } });
  const r = landOn('--text', 'Checked on the phone.');
  assert.equal(r.code, 0, r.err);
  assert.notEqual(git(repo, 'rev-parse', 'main'), main);
  assert.deepEqual(r.out.trim().split('\n').slice(-2), ['A1: landed and done', 'resolved: q1']);
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].status, 'done');
  assert.equal(lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).at(-1).text, 'Checked on the phone.');
  assert.ok(lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).some((m) => m.kind === 'status' && m.phase === 'landing'), 'the finish itself sets the landing phase');
});

test('land --owner-step lands the code and leaves the card open on its owner step and its check; a blank step or a bad check is refused before landing', () => {
  const repo = scratchRepo();
  assert.equal(board('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
  commit(worktree(), 'shared/notes.md', 'b\n', 'A1: notes');
  const landOn = (...more) => run('board.mjs', ['land', 'w/A1', '--site', 'orch', '--text', 'Checked on the phone.', ...more], undefined, {
    KICKFLIP_RESTART_CMD: JSON.stringify([process.execPath, '-e', '0']),
  });
  const main = git(repo, 'rev-parse', 'main');
  assert.deepEqual([landOn('--owner-step', ' ').code, landOn('--owner-step', ' ').err], [1, '--owner-step must be non-empty text\n']);
  assert.equal(git(repo, 'rev-parse', 'main'), main);
  const badCheck = landOn('--owner-step', 'Tag the first release', '--check', 'tag nowhere v*');
  assert.deepEqual([badCheck.code, badCheck.err], [1, `--check tag <owner/repo> <pattern>: "nowhere" isn't a GitHub repo such as owner/name\n`]);
  assert.equal(git(repo, 'rev-parse', 'main'), main);
  const r = landOn('--owner-step', 'Tag the first release', '--check', 'tag o/r v*');
  assert.equal(r.code, 0, r.err);
  assert.notEqual(git(repo, 'rev-parse', 'main'), main);
  assert.equal(r.out.trim().split('\n').at(-1), 'A1: landed; waits on the owner step "Tag the first release"');
  const item = read(at('waves', 'w', 'wave.json')).items[0];
  assert.deepEqual([item.status, item.owner_step, item.owner_check.check], ['done', 'Tag the first release', 'tag o/r v*']);
  assert.equal(lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).at(-1).text, 'Checked on the phone.');
});

test('builder done --owner-step records the step on the card, and refuses one on a card already closed, naming land', () => {
  const items = (extra) => write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One', pr: 7, ...extra }] });
  items({});
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch').code, 0);
  const done = board('builder', 'done', 'w/A1', '--site', 'orch', '--owner-step', 'Tag the first release');
  assert.equal(done.code, 0, done.err);
  assert.equal(done.out.trim(), 'A1: builder done; owner step "Tag the first release"');
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].owner_step, 'Tag the first release');
  items({ status: 'done' });
  const late = board('builder', 'done', 'w/A1', '--site', 'orch', '--owner-step', 'Tag it');
  assert.deepEqual([late.code, late.err], [1, 'w/A1 is already done, so its ticket closed; an owner step goes on the command that finishes the card: land --owner-step, or builder done before the merge\n']);
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].owner_step, undefined);
});

// docs/adr/2026-11-04-2308-an-owner-step-can-carry-a-code-check.md
test('builder done --check attaches a named check to the owner step, refusing one without the step or with bad arguments', () => {
  const items = (extra) => write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One', pr: 7, ...extra }] });
  const item = () => read(at('waves', 'w', 'wave.json')).items[0];
  items({});
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch').code, 0);
  const alone = board('builder', 'done', 'w/A1', '--site', 'orch', '--check', 'npm kickflip 0.3.*');
  assert.equal(alone.code, 2);
  assert.match(alone.err, /--check goes with --owner-step/);
  const shell = board('builder', 'done', 'w/A1', '--site', 'orch', '--owner-step', 'Tag a release', '--check', 'sh -c "rm -rf ~"');
  assert.equal(shell.code, 1);
  assert.match(shell.err, /^--check has no check "sh"; it takes tag <owner\/repo> <pattern>/);
  assert.equal(item().owner_step, undefined);
  const done = board('builder', 'done', 'w/A1', '--site', 'orch', '--owner-step', 'Tag a release', '--check', 'npm  kickflip 0.3.*');
  assert.equal(done.code, 0, done.err);
  assert.deepEqual([item().owner_step, item().owner_check.check], ['Tag a release', 'npm kickflip 0.3.*']);
  assert.ok(Date.parse(item().owner_check.since) <= Date.now());
});

test('item set --check changes or removes the check on a card waiting on its owner step, clearing a broken mark, and refuses a card with no step', () => {
  const items = (extra) => write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One', status: 'done', ...extra }] });
  const item = () => read(at('waves', 'w', 'wave.json')).items[0];
  items({});
  const none = board('item', 'set', 'w/A1', '--site', 'orch', '--check', 'npm kickflip 0.3.*');
  assert.deepEqual([none.code, none.err], [1, `--check goes with an owner step, which w/A1 doesn't have: pass --owner-step "<the step>" with it on builder done or land\n`]);
  const since = '2026-11-04T10:00:00.000Z';
  items({ owner_step: 'Publish it', owner_check: { check: 'npm kickflip 0.3.*', since, broken: 'npm view failed: E404' } });
  const again = board('item', 'set', 'w/A1', '--site', 'orch', '--check', 'npm kickflip 0.3.*');
  assert.equal(again.code, 0, again.err);
  assert.equal(again.out.trim(), 'A1: check npm kickflip 0.3.*');
  assert.deepEqual(item().owner_check, { check: 'npm kickflip 0.3.*', since });
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--check', 'tag o/r v0.3.*').code, 0);
  assert.equal(item().owner_check.check, 'tag o/r v0.3.*');
  assert.notEqual(item().owner_check.since, since);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--check', '').code, 0);
  assert.deepEqual([item().owner_step, item().owner_check], ['Publish it', undefined]);
});

test("land refuses while a builder record on the card has unverified judgment calls, naming builder verified, and lands once they're verified", () => {
  const repo = scratchRepo();
  assert.equal(board('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
  assert.equal(board('builder', 'start', 'w/A1', '--agent', 'fix').code, 0);
  assert.equal(board('builder', 'call', 'w/A1', '--agent', 'fix', 'Kept the old name').code, 0);
  commit(worktree(), 'shared/notes.md', 'b\n');
  const main = git(repo, 'rev-parse', 'main');
  const refused = land();
  assert.deepEqual([refused.code, refused.err], [1, 'land: w/A1 has judgment calls nobody verified yet; check them with builder calls w/A1 --agent fix, then run builder verified w/A1 --agent fix\n']);
  assert.equal(git(repo, 'rev-parse', 'main'), main);
  assert.equal(board('builder', 'verified', 'w/A1', '--agent', 'fix').code, 0);
  const r = land();
  assert.equal(r.code, 0, r.err);
  assert.notEqual(git(repo, 'rev-parse', 'main'), main);
});

test('land skips tests inside .repos and node_modules at every depth', () => {
  const repo = scratchRepo();
  assert.equal(board('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
  const ignored = "import test from 'node:test';\ntest('foreign test', () => { throw new Error('foreign suite ran'); });\n";
  for (const directory of ['.repos/owner/repo', 'node_modules/dependency', 'nested/.repos/owner/repo', 'nested/node_modules/dependency']) {
    write(path.join(worktree(), directory, 'foreign.test.mjs'), ignored);
  }
  git(worktree(), 'add', '-A');
  git(worktree(), 'commit', '--quiet', '-m', 'foreign repos');
  const result = land();
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /tests passed: 1/);
  assert.equal(fs.existsSync(worktree()), false);
});

test('land refuses a rebase that conflicts, naming the files, and leaves the branch, worktree and main as they were', () => {
  const repo = scratchRepo();
  assert.equal(board('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
  commit(worktree(), 'shared/notes.md', 'branch\n');
  commit(repo, 'shared/notes.md', 'main\n');
  const [main, head] = [git(repo, 'rev-parse', 'main'), git(worktree(), 'rev-parse', 'HEAD')];
  const r = land();
  assert.deepEqual([r.code, r.err], [1, `rebasing A1 onto main conflicts in shared/notes.md; resolve it in ${worktree()} and land again\n`]);
  assert.deepEqual([git(repo, 'rev-parse', 'main'), git(worktree(), 'rev-parse', 'HEAD'), git(worktree(), 'status', '--porcelain')], [main, head, '']);
  assert.equal(fs.readFileSync(path.join(worktree(), 'shared', 'notes.md'), 'utf8'), 'branch\n');
  assert.deepEqual(restarts(), []);
});

// docs/adr/2026-11-04-1611-finishing-a-build-is-one-step.md
const finishEnv = { KICKFLIP_RESTART_CMD: JSON.stringify([process.execPath, '-e', '0']) };
const onOrch = (...args) => run('board.mjs', ['--site', 'orch', ...args], undefined, finishEnv);
const record = (id = 'A1') => read(at('waves', 'w', 'agents', `${id}.json`));
const itemOf = (id = 'A1') => read(at('waves', 'w', 'wave.json')).items.find((i) => i.id === id);
const threadOf = (id = 'A1') => lines(site('orch', 'data', 'threads', `w__${id}.jsonl`));

test('builder done on a build that keeps a worktree finishes the card: it needs --text, lands it and closes the card and its record; a failed finish refuses with the reason and keeps the builder on', () => {
  const repo = scratchRepo();
  assert.equal(onOrch('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
  commit(worktree(), 'broken.test.mjs', "import test from 'node:test';\ntest('broken', () => { throw new Error('nope'); });\n", 'A1: work');
  const main = git(repo, 'rev-parse', 'main');
  const bare = onOrch('builder', 'done', 'w/A1');
  assert.deepEqual([bare.code, bare.err], [1, 'builder done finishes w/A1: pass --text "<what you checked>", or --next "<what happens next>" to stop without finishing\n']);
  const failed = onOrch('builder', 'done', 'w/A1', '--text', 'Checked it.');
  assert.equal(failed.code, 1);
  assert.match(failed.err, /^tests failed in .* \(1 failing\); nothing landed/);
  assert.deepEqual([git(repo, 'rev-parse', 'main'), record().done, itemOf().status], [main, undefined, undefined]);

  fs.rmSync(path.join(worktree(), 'broken.test.mjs'));
  git(worktree(), 'commit', '--quiet', '-am', 'A1: fixed');
  const r = onOrch('builder', 'done', 'w/A1', '--text', 'Checked it.');
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes('\nA1: landed and done\n'), r.out);
  assert.notEqual(git(repo, 'rev-parse', 'main'), main);
  assert.equal(itemOf().status, 'done');
  assert.equal(typeof record().done, 'string');
  assert.equal(threadOf().at(-1).text, 'Checked it.');
  assert.equal(fs.existsSync(worktree()), false);
});

test("builder done --next on a build stops it without finishing, an --agent helper's done only stops its own record, and the main build's done refuses while a helper is still open", () => {
  const repo = scratchRepo();
  assert.equal(onOrch('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
  assert.equal(onOrch('builder', 'start', 'w/A1', '--agent', 'lint').code, 0);
  commit(worktree(), 'work.txt', 'built\n', 'A1: work');
  const main = git(repo, 'rev-parse', 'main');
  const busy = onOrch('builder', 'done', 'w/A1', '--text', 'Checked it.');
  assert.deepEqual([busy.code, busy.err], [1, 'builder done would finish w/A1 while agent lint is still open; run builder done w/A1 --agent lint first\n']);
  assert.equal(onOrch('builder', 'done', 'w/A1', '--agent', 'lint').code, 0);
  const stopped = onOrch('builder', 'done', 'w/A1', '--next', 'Check the build');
  assert.equal(stopped.code, 0, stopped.err);
  assert.deepEqual([git(repo, 'rev-parse', 'main'), typeof record().done, itemOf().next], [main, 'string', 'Check the build']);
});

test("a finish on a local board pushes its branch to origin once it lands when the board's push switch is on; off, nothing is pushed, and a push that fails is said without undoing the land", () => {
  const repo = scratchRepo();
  write(at('waves', 'w', 'wave.json'), { title: 'W', items: [{ id: 'A1', title: 'One' }, { id: 'A2', title: 'Two' }, { id: 'A3', title: 'Three' }] });
  const origin = path.join(home, 'origin.git');
  git(home, 'init', '--quiet', '--bare', origin);
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '--quiet', 'origin', 'main');
  const manifest = read(at('kickflip', 'manifest.json'));
  manifest.sites.orch.owner = { repo };
  write(at('kickflip', 'manifest.json'), manifest);
  const finish = (id) => {
    assert.equal(onOrch('builder', 'start', `w/${id}`, '--kind', 'build').code, 0);
    commit(at('kickflip', 'worktrees', id), `${id}.txt`, 'built\n', `${id}: work`);
    const r = onOrch('builder', 'done', `w/${id}`, '--text', 'Checked it.');
    assert.equal(r.code, 0, r.err);
    return r;
  };
  const before = git(origin, 'rev-parse', 'main');
  assert.ok(!finish('A1').out.includes('origin'));
  assert.equal(git(origin, 'rev-parse', 'main'), before);

  write(path.join(repo, '.claude', 'settings.local.json'), { permissions: { allow: ['Bash(git push origin main)'] } });
  write(path.join(repo, '.git', 'info', 'exclude'), '.claude\n');
  assert.ok(finish('A2').out.includes('\npushed main to origin\n'));
  assert.equal(git(origin, 'rev-parse', 'main'), git(repo, 'rev-parse', 'main'));

  git(repo, 'remote', 'set-url', 'origin', path.join(home, 'gone.git'));
  const failed = finish('A3');
  assert.match(failed.out, /\nlanded, but main didn't reach origin: .+; push it with git -C .+ push origin main\n/);
  assert.equal(itemOf('A3').status, 'done');
  assert.match(threadOf('A3').at(-1).text, /^Landed, but main didn't reach origin: /);
});

test('builder verified on a handed-back build finishes the card in the same step, its note the closing line', () => {
  const repo = scratchRepo();
  assert.equal(onOrch('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
  commit(worktree(), 'work.txt', 'built\n', 'A1: work');
  assert.equal(onOrch('builder', 'call', 'w/A1', 'Kept the old name').code, 0);
  const main = git(repo, 'rev-parse', 'main');
  assert.equal(onOrch('builder', 'done', 'w/A1').code, 0);
  assert.deepEqual([itemOf().status, git(repo, 'rev-parse', 'main')], ['checking', main]);
  const r = onOrch('builder', 'verified', 'w/A1', '--note', 'The old name holds.');
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes('\nA1: judgment calls verified; landed and done\n'), r.out);
  assert.notEqual(git(repo, 'rev-parse', 'main'), main);
  assert.equal(itemOf().status, 'done');
  assert.equal(threadOf().at(-1).text, 'The old name holds.');
});

test("builder verified leaves a card checking while one of its questions is open, and a finish that fails keeps the stamp and says why", () => {
  const repo = scratchRepo();
  assert.equal(onOrch('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
  commit(worktree(), 'shared/notes.md', 'branch\n', 'A1: work');
  assert.equal(onOrch('builder', 'call', 'w/A1', 'Kept the old name').code, 0);
  assert.equal(onOrch('builder', 'done', 'w/A1').code, 0);
  write(site('orch', 'data', 'owner.json'), { topics: [], items: [question('q1', { topic: 'item:w/A1' })] });
  const waits = onOrch('builder', 'verified', 'w/A1');
  assert.deepEqual([waits.code, waits.err], [0, '']);
  assert.equal(waits.out, "A1: judgment calls verified\nA1 finishes once the owner answers q1\n");
  assert.deepEqual([itemOf().status, typeof record().verified.at], ['checking', 'string']);

  write(site('orch', 'data', 'owner.json'), { topics: [], items: [] });
  assert.equal(onOrch('builder', 'start', 'w/A1', '--kind', 'build').code, 0);
  assert.equal(onOrch('builder', 'call', 'w/A1', 'Kept the old colour').code, 0);
  assert.equal(onOrch('builder', 'done', 'w/A1').code, 0);
  commit(repo, 'shared/notes.md', 'main\n');
  const main = git(repo, 'rev-parse', 'main');
  const failed = onOrch('builder', 'verified', 'w/A1');
  assert.equal(failed.code, 1);
  assert.equal(failed.err, `judgment calls verified, but A1 didn't finish: rebasing A1 onto main conflicts in shared/notes.md; resolve it in ${worktree()} and land again\n`);
  assert.deepEqual([itemOf().status, git(repo, 'rev-parse', 'main'), onOrch('builder', 'calls', 'w/A1').out.includes('\nverified ')], ['checking', main, true]);
});

// A shared clone of origin (the scratch repo), on a board whose repo is origin's GitHub project, or a plain git remote.
function remoteBoard(fields) {
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

test('on a GitHub board, builder done sends the build for review: it pushes the branch, opens a draft PR, and the card moves to it with its record closed', () => {
  const ghDir = path.join(home, 'gh');
  const origin = remoteBoard(() => ({ github: 'owner/project' }));
  const env = { ...finishEnv, PATH: `${fakeGh(ghDir)}:${process.env.PATH}` };
  const b = (...args) => run('board.mjs', ['--site', 'orch', ...args], undefined, env);
  assert.equal(b('builder', 'start', 'w/A1', '--kind', 'build').code, 0);
  commit(worktree(), 'work.txt', 'built\n', 'A1: work');
  const main = git(origin, 'rev-parse', 'main');
  const r = b('builder', 'done', 'w/A1', '--text', 'Checked it on the phone.');
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes('\nA1: draft PR #100 opened\n'), r.out);
  assert.deepEqual([git(origin, 'rev-parse', 'A1'), git(origin, 'rev-parse', 'main')], [git(worktree(), 'rev-parse', 'HEAD'), main]);
  assert.deepEqual(calls(ghDir).find((a) => a[0] === 'pr'), ['pr', 'create', '--draft', '--repo', 'owner/project', '--base', 'main', '--head', 'A1', '--title', 'A1: One', '--body', 'Checked it on the phone.']);
  assert.deepEqual([itemOf().prs, itemOf().status, typeof record().done], [[{ number: 100 }], undefined, 'string']);
  assert.equal(threadOf().at(-1).text, 'Checked it on the phone.');
  assert.equal(fs.existsSync(worktree()), true);
});

test('on a plain git remote, builder done pushes the branch and the card waits on the merge', () => {
  const origin = remoteBoard((dir) => ({ remote: dir }));
  assert.equal(onOrch('builder', 'start', 'w/A1', '--kind', 'build').code, 0);
  commit(worktree(), 'work.txt', 'built\n', 'A1: work');
  const r = onOrch('builder', 'done', 'w/A1', '--text', 'Checked it.');
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes('\nA1: pushed A1 for its merge\n'), r.out);
  assert.equal(git(origin, 'rev-parse', 'A1'), git(worktree(), 'rev-parse', 'HEAD'));
  assert.deepEqual([itemOf().pushed.branch, typeof record().done], ['A1', 'string']);
  // docs/adr/2026-11-03-0223-each-lane-has-one-fixed-order.md: the first arrival in review is kept, however often the push is set again.
  const arrived = itemOf().review_since;
  assert.equal(typeof arrived, 'string');
  assert.equal(onOrch('item', 'set', 'w/A1', '--pushed', 'A1').code, 0);
  assert.equal(itemOf().review_since, arrived);
});

// docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md
const tapMerge = (id = 'A1') => {
  const wave = read(at('waves', 'w', 'wave.json'));
  wave.items.find((i) => i.id === id).merge_ready.tapped = new Date().toISOString();
  write(at('waves', 'w', 'wave.json'), wave);
};

test("with Auto-merge off, builder done on a local board verifies the build and holds it for the owner's Merge; merge after the tap rebases onto main as it is, lands it, closes the card and pushes main", () => {
  const repo = scratchRepo();
  heldBoard();
  const origin = path.join(home, 'origin.git');
  git(home, 'init', '--quiet', '--bare', origin);
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '--quiet', 'origin', 'main');
  write(path.join(repo, '.claude', 'settings.local.json'), { permissions: { allow: ['Bash(git push origin main)'] } });
  write(path.join(repo, '.git', 'info', 'exclude'), '.claude\n');
  assert.equal(onOrch('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
  commit(worktree(), 'work.txt', 'built\n', 'A1: work');
  const main = git(repo, 'rev-parse', 'main');
  const held = onOrch('builder', 'done', 'w/A1', '--text', 'Checked it.');
  assert.equal(held.code, 0, held.err);
  assert.ok(held.out.includes('\nA1: verified; waits for your Merge\n'), held.out);
  assert.deepEqual([git(repo, 'rev-parse', 'main'), itemOf().status, itemOf().merge_ready.branch, typeof record().done], [main, undefined, 'A1', 'string']);
  assert.equal(threadOf().at(-1).text, 'Checked it.');
  assert.equal(fs.existsSync(worktree()), true);

  const untapped = onOrch('merge', 'w/A1');
  assert.deepEqual([untapped.code, untapped.err], [1, "w/A1 isn't waiting on a Merge tap\n"]);
  commit(repo, 'later.txt', 'main moved\n');
  tapMerge();
  const merged = onOrch('merge', 'w/A1');
  assert.equal(merged.code, 0, merged.err);
  assert.ok(merged.out.includes('\nA1: landed and done\n'), merged.out);
  assert.ok(merged.out.includes('\npushed main to origin\n'), merged.out);
  assert.equal(git(repo, 'show', 'main:work.txt'), 'built');
  assert.equal(git(repo, 'show', 'main:later.txt'), 'main moved');
  assert.equal(git(origin, 'rev-parse', 'main'), git(repo, 'rev-parse', 'main'));
  assert.deepEqual([itemOf().status, itemOf().merge_ready], ['done', undefined]);
  assert.equal(threadOf().at(-1).text, 'Landed on main on your Merge.');
  assert.equal(fs.existsSync(worktree()), false);
});

// docs/adr/2026-11-04-2320-a-merge-tap-waits-its-turn-to-land.md
test('a Merge tap on a held build whose tested commit is still on top of main lands it without running the suite again; a main that moved is tested again', () => {
  const repo = scratchRepo();
  heldBoard();
  assert.equal(onOrch('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
  commit(worktree(), 'work.txt', 'built\n', 'A1: work');
  const held = onOrch('builder', 'done', 'w/A1', '--text', 'Checked it.');
  assert.ok(held.out.includes('tests passed: 1'), held.out);
  tapMerge();
  const merged = onOrch('merge', 'w/A1');
  assert.equal(merged.code, 0, merged.err);
  assert.ok(merged.out.includes('A1 was tested on main as it is now; not testing it again'), merged.out);
  assert.equal(merged.out.includes('tests passed'), false, merged.out);
  assert.equal(git(repo, 'show', 'main:work.txt'), 'built');
  assert.equal(git(repo, 'for-each-ref', 'refs/kickflip'), '');

  assert.equal(onOrch('builder', 'start', 'w/ENG-1', '--worktree', '--repo', repo).code, 0);
  const second = at('kickflip', 'worktrees', 'ENG-1');
  commit(second, 'more.txt', 'more\n', 'ENG-1: work');
  assert.equal(onOrch('builder', 'done', 'w/ENG-1', '--text', 'Checked it.').code, 0);
  commit(repo, 'later.txt', 'main moved\n');
  tapMerge('ENG-1');
  const retested = onOrch('merge', 'w/ENG-1');
  assert.equal(retested.code, 0, retested.err);
  assert.ok(retested.out.includes('rebased ENG-1 onto main'), retested.out);
  assert.ok(retested.out.includes('tests passed: 1'), retested.out);
});

test('a tapped Merge whose rebase conflicts launches a headless lander, and the lander finishes it onto main with no second tap', async () => {
  const repo = scratchRepo();
  heldBoard();
  const seen = path.join(home, 'claude-runs.jsonl');
  const fake = path.join(home, 'claude');
  fs.writeFileSync(fake, `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(seen)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`);
  fs.chmodSync(fake, 0o755);
  const env = { ...finishEnv, KICKFLIP_CLAUDE: fake };
  const b = (...args) => run('board.mjs', ['--site', 'orch', ...args], undefined, env);
  const manifest = read(at('kickflip', 'manifest.json'));
  manifest.sites.orch.owner = { repo };
  write(at('kickflip', 'manifest.json'), manifest);
  assert.equal(b('builder', 'start', 'w/A1', '--kind', 'build').code, 0);
  commit(worktree(), 'shared/notes.md', 'branch\n', 'A1: work');
  assert.equal(b('builder', 'done', 'w/A1', '--text', 'Checked it.').code, 0);
  commit(repo, 'shared/notes.md', 'main\n');
  const main = git(repo, 'rev-parse', 'main');
  tapMerge();
  const failed = b('merge', 'w/A1');
  assert.equal(failed.code, 1);
  assert.match(failed.err, /^rebasing A1 onto main conflicts in shared\/notes\.md/);
  assert.equal(git(repo, 'rev-parse', 'main'), main);
  assert.deepEqual(threadOf().slice(-2).map((m) => m.text), [
    `Not merged yet: rebasing A1 onto main conflicts in shared/notes.md; resolve it in ${worktree()} and land again. A lander fixes it and lands it.`,
    `Lander launched on Claude Opus in ${worktree()}.`,
  ]);
  await until(() => fs.existsSync(seen), 'the lander runs');
  assert.match(fs.readFileSync(seen, 'utf8'), /You are the headless lander for card A1/);

  // The lander resolves the conflict and finishes; the tap was the go.
  assert.equal(b('builder', 'start', 'w/A1', '--kind', 'build', '--label', 'Lander').code, 0);
  git(worktree(), 'reset', '--quiet', '--hard', 'main');
  commit(worktree(), 'work.txt', 'built on main\n', 'A1: work, kept main');
  const landed = b('builder', 'done', 'w/A1', '--text', 'Resolved it.');
  assert.equal(landed.code, 0, landed.err);
  assert.ok(landed.out.includes('\nA1: landed and done\n'), landed.out);
  assert.equal(itemOf().status, 'done');
});

test("a tapped Merge refused for a reason no lander fixes says why in the thread and leaves the card waiting for its Merge", () => {
  const repo = scratchRepo();
  heldBoard();
  assert.equal(onOrch('builder', 'start', 'w/A1', '--worktree', '--repo', repo).code, 0);
  commit(worktree(), 'work.txt', 'built\n', 'A1: work');
  assert.equal(onOrch('builder', 'done', 'w/A1', '--text', 'Checked it.').code, 0);
  git(repo, 'switch', '--quiet', '-c', 'elsewhere');
  tapMerge();
  const failed = onOrch('merge', 'w/A1');
  assert.equal(failed.code, 1);
  assert.equal(threadOf().at(-1).text, `Not merged: ${repo} is on elsewhere, not main; switch it to main (git -C ${repo} switch main) and land again. Tap Merge again.`);
  assert.deepEqual([itemOf().status, itemOf().merge_ready.branch], [undefined, 'A1']);
});

test('PRs off on a GitHub board needs Push main granted; then a finish lands in the shared clone on main as origin has it, and pushes main', () => {
  const origin = remoteBoard(() => ({ github: 'owner/project' }));
  git(origin, 'config', 'receive.denyCurrentBranch', 'updateInstead');
  const clone = path.join(home, 'clone');
  const refused = onOrch('settings', 'set', 'prs', 'off');
  assert.deepEqual([refused.code, refused.err], [1, 'Merge lands each card on main and pushes it, so turn on Push main after a land first\n']);
  write(path.join(clone, '.claude', 'settings.local.json'), { permissions: { allow: ['Bash(git push origin main)'] } });
  write(path.join(clone, '.git', 'info', 'exclude'), '.claude\n');
  assert.deepEqual(onOrch('settings', 'set', 'prs', 'off'), { code: 0, out: 'prs off\n', err: '' });
  assert.equal(onOrch('builder', 'start', 'w/A1', '--kind', 'build').code, 0);
  commit(worktree(), 'work.txt', 'built\n', 'A1: work');
  commit(origin, 'later.txt', 'origin moved\n');
  const r = onOrch('builder', 'done', 'w/A1', '--text', 'Checked it.');
  assert.equal(r.code, 0, r.err);
  assert.ok(r.out.includes('\nA1: landed and done\n'), r.out);
  assert.ok(r.out.includes('\npushed main to origin\n'), r.out);
  assert.equal(git(origin, 'show', 'main:work.txt'), 'built');
  assert.equal(git(origin, 'show', 'main:later.txt'), 'origin moved');
  assert.deepEqual([itemOf().status, itemOf().prs], ['done', undefined]);
});

test("builder start and progress on --site write each new status line to the item's thread as its phase and detail, named by a further agent's kind", () => {
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch', '--phase', 'reading', '--progress', 'the plan').code, 0);
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch', '--agent', 'bench', '--kind', 'claude', '--phase', 'testing', '--progress', 'the benchmark').code, 0);
  assert.equal(board('builder', 'progress', 'w/A1', 'the', 'benchmark', '--phase', 'testing', '--site', 'orch', '--agent', 'bench').code, 0);
  assert.equal(board('builder', 'progress', 'w/A1', '--phase', 'building', 'the', 'limiter', '--site', 'orch').code, 0);
  assert.equal(board('builder', 'progress', 'w/A1', '--site', 'orch', '--phase', 'checking', '--text', 'the page at phone width').code, 0);
  assert.equal(board('builder', 'progress', 'w/A1', 'Twice', '--phase', 'testing', '--site', 'orch', '--text', 'Twice').code, 2);
  assert.equal(board('builder', 'progress', 'w/A1', '--phase', 'testing', '--site', 'orch').code, 2);
  assert.equal(board('builder', 'done', 'w/A1', '--site', 'orch').code, 0);
  const unseen = board('builder', 'progress', 'w/A1', 'Unseen', '--phase', 'testing', '--agent', 'bench');
  assert.deepEqual([unseen.code, /needs --site/.test(unseen.err)], [1, true]);
  assert.equal(board('builder', 'start', 'w/A1', '--agent', 'lint', '--phase', 'testing', '--progress', 'Unseen').code, 1);
  const msgs = lines(site('orch', 'data', 'threads', 'w__A1.jsonl'));
  assert.deepEqual(msgs.map(({ who, kind, phase, text }) => [who, kind, phase, text]), [
    ['claude', 'status', 'reading', 'Reading: the plan'],
    ['claude', 'status', 'testing', 'Claude Opus testing: the benchmark'],
    ['claude', 'status', 'building', 'Building: the limiter'],
    ['claude', 'status', 'checking', 'Checking: the page at phone width'],
  ]);
  assert.deepEqual(['progress' in read(at('waves', 'w', 'agents', 'A1.json')), 'progress_at' in read(at('waves', 'w', 'agents', 'A1@bench.json'))], [false, false]);
  assert.ok(msgs.every((m) => !Number.isNaN(Date.parse(m.ts))));
});

test("a status line drops a detail's repeat of its own phase label", () => {
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch').code, 0);
  assert.equal(board('builder', 'progress', 'w/A1', '--phase', 'landing', '--site', 'orch', '--text', 'Landing: x').code, 0);
  assert.equal(board('builder', 'progress', 'w/A1', '--phase', 'landing', '--site', 'orch', '--text', 'landing rebase').code, 0);
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch', '--agent', 'bench', '--kind', 'claude', '--phase', 'landing', '--progress', 'Landing: y').code, 0);
  assert.deepEqual(lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).map((m) => m.text), ['Landing: x', 'Landing: rebase', 'Claude Opus landing: y']);
});

test('builder progress and start --progress refuse a missing or unknown phase and a detail over 80 characters, writing nothing', () => {
  const long = 'x'.repeat(81);
  for (const [args, err] of [
    [['builder', 'progress', 'w/A1', 'the plan', '--phase', 'waiting', '--site', 'orch'], /^--phase takes reading, building, testing, checking or landing, not "waiting"$/],
    [['builder', 'progress', 'w/A1', long, '--phase', 'testing', '--site', 'orch'], /^builder progress is 81 characters; the cap is 80\. Say it shorter\.$/],
    [['builder', 'start', 'w/A1', '--site', 'orch', '--progress', 'the plan'], /^--progress needs --phase reading, building, testing, checking or landing$/],
    [['builder', 'start', 'w/A1', '--site', 'orch', '--phase', 'reading'], /^--phase goes with --progress "<detail>"$/],
    [['builder', 'start', 'w/A1', '--site', 'orch', '--phase', 'reading', '--progress', long], /^--progress is 81 characters; the cap is 80\. Say it shorter\.$/],
  ]) {
    const r = board(...args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err.trim(), err, args.join(' '));
  }
  assert.equal(fs.existsSync(site('orch', 'data', 'threads', 'w__A1.jsonl')), false);
  assert.equal(fs.existsSync(at('waves', 'w', 'agents', 'A1.json')), false);
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch').code, 0);
  const bare = board('builder', 'progress', 'w/A1', 'the plan', '--site', 'orch');
  assert.deepEqual([bare.code, bare.err.trim()], [1, 'builder progress needs --phase reading, building, testing, checking or landing']);
  assert.equal(board('builder', 'progress', 'w/A1', 'x'.repeat(80), '--phase', 'landing', '--site', 'orch').code, 0);
});

const toolUse = (id, command, ts) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
const toolResult = (id, ts) => JSON.stringify({ type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const stopHook = (input) => run('builder-stop-hook.mjs', [], typeof input === 'string' ? input : JSON.stringify({ hook_event_name: 'SubagentStop', agent_id: 'a1', ...input }));
const ago = (ms) => new Date(Date.now() - ms).toISOString();

test('the SubagentStop hook closes the builder records its agent started and left open, quietly and any number of times', () => {
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch').code, 0);
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch', '--agent', 'bench').code, 0);
  assert.equal(board('builder', 'start', 'audit/A1', '--site', 'audit').code, 0);
  assert.equal(board('builder', 'done', 'audit/A1', '--site', 'audit').code, 0);
  const finished = read(site('audit', 'data', 'agents', 'A1.json')).done;
  const transcript = path.join(home, 'agent.jsonl');
  write(transcript, [
    'not json',
    toolUse('t1', 'node ~/.claude/skills/kickflip/board/bin/board.mjs --site orch builder start w/A1 --kind build --label "Opus builder"; ls', ago(5 * 60 * 1000)),
    toolResult('t1', ago(1000)),
    toolUse('t2', 'B="node ~/.claude/skills/kickflip/board/bin/board.mjs --site orch"; eval "$B builder start w/A1 --agent bench --kind codex"', ago(1000)),
    toolUse('t3', '$B builder start audit/A1 --site audit', ago(1000)),
  ].join('\n') + '\n');
  for (const _ of [1, 2]) {
    const r = stopHook({ agent_transcript_path: transcript });
    assert.deepEqual([r.code, r.out], [0, '']);
  }
  assert.equal(typeof read(at('waves', 'w', 'agents', 'A1.json')).done, 'string');
  assert.equal(typeof read(at('waves', 'w', 'agents', 'A1@bench.json')).done, 'string');
  assert.equal(read(site('audit', 'data', 'agents', 'A1.json')).done, finished);
});

test('the SubagentStop hook leaves a record another agent restarted on the card after its own start', () => {
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch', '--agent', 'fix').code, 0);
  const transcript = path.join(home, 'agent.jsonl');
  write(transcript, [toolUse('t1', 'node board.mjs --site orch builder start w/A1 --agent fix', ago(10 * 60 * 1000)), toolResult('t1', ago(10 * 60 * 1000 - 500))].join('\n'));
  assert.equal(stopHook({ agent_transcript_path: transcript }).code, 0);
  assert.equal('done' in read(at('waves', 'w', 'agents', 'A1@fix.json')), false);
});

test('the SubagentStop hook leaves the records open while background work the agent started still runs, and closes them on its real finish', () => {
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch').code, 0);
  const transcript = path.join(home, 'agent.jsonl');
  const launched = (id, toolUseResult) => JSON.stringify({ type: 'user', timestamp: ago(500), message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'started' }] }, toolUseResult });
  write(transcript, [
    toolUse('t1', 'node board.mjs --site orch builder start w/A1 --kind build', ago(1000)),
    toolResult('t1', ago(900)),
    launched('t2', { stdout: '', stderr: '', backgroundTaskId: 'bsuite' }),
    launched('t3', { taskId: 'bmonitor', timeoutMs: 1800000, persistent: false }),
    launched('t4', { isAsync: true, status: 'async_launched', agentId: 'ahelper' }),
  ].join('\n') + '\n');
  const task = (id, type) => ({ id, type, status: 'running', description: id });
  const watcher = task('bwatcher', 'shell');
  for (const own of [task('bsuite', 'shell'), task('bmonitor', 'monitor'), task('ahelper', 'subagent')]) {
    assert.deepEqual(stopHook({ agent_transcript_path: transcript, background_tasks: [watcher, own] }).out, '');
    assert.equal('done' in read(at('waves', 'w', 'agents', 'A1.json')), false, own.id);
  }
  assert.equal(stopHook({ agent_transcript_path: transcript, background_tasks: [watcher] }).code, 0);
  assert.equal(typeof read(at('waves', 'w', 'agents', 'A1.json')).done, 'string');
});

test('the SubagentStop hook exits 0 with nothing on stdout when its input or transcript is missing', () => {
  for (const input of [{ agent_transcript_path: path.join(home, 'gone.jsonl') }, {}, 'not json']) {
    const r = stopHook(input);
    assert.deepEqual([r.code, r.out, /builder-stop-hook: /.test(r.err)], [0, '', true]);
  }
});

test('a refusal exits non-zero with one line naming the bad flag, and changes nothing', () => {
  for (const [args, code, err] of [
    [['item', 'set', 'w/A1', '--site', 'orch', '--colour', 'red'], 2, /^item set does not take --colour\b/],
    [['item', 'set', 'w/A1', '--site', 'orch', '--status', 'shipped'], 1, /^--status takes /],
  ]) {
    const r = board(...args);
    assert.equal(r.code, code, args.join(' '));
    assert.match(r.err, err, args.join(' '));
    assert.equal(r.err.trim().split('\n').length, 1, args.join(' '));
  }
  assert.equal(board('frobnicate').code, 2);
  assert.deepEqual(read(at('waves', 'w', 'wave.json')), wave());
});

test('push adds the replies written since the last push to the body, and records the push only when kickflip push succeeds', () => {
  const stub = path.join(home, 'stub.mjs');
  const calls = path.join(home, 'calls.jsonl');
  write(stub, "import fs from 'node:fs'; fs.appendFileSync(process.env.STUB_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n'); process.exit(Number(process.env.STUB_EXIT || 0));");
  const push = (exit, ...args) => run('board.mjs', ['push', '--site', 'orch', ...args], undefined, { KICKFLIP_PUSH_CMD: JSON.stringify([process.execPath, stub, 'push']), STUB_CALLS: calls, STUB_EXIT: String(exit) });
  const state = site('orch', 'data', 'push-state.json');
  const reply = (id, msAgo) => {
    write(site('orch', 'data', 'replies', `${id}.html`), '<p>Done.</p>');
    const t = new Date(Date.now() - msAgo);
    fs.utimesSync(site('orch', 'data', 'replies', `${id}.html`), t, t);
  };

  reply('e1', 60_000);
  assert.equal(push(0, '--kind', 'fault', '--title', 'Question', '--body', 'Pick one', '--url', '/orch/questions.html').code, 0);
  assert.ok(!Number.isNaN(Date.parse(read(state).last_push)));

  write(state, { last_push: new Date(Date.now() - 30_000).toISOString() });
  reply('e2', 10_000);
  reply('e3', 5_000);
  const failed = push(3, '--kind', 'fault', '--title', 'Ready', '--body', 'A1 is green', '--tag', 'ready-A1', '--urgent');
  assert.equal(failed.code, 3);
  const kept = read(state).last_push;
  assert.equal(push(0, '--kind', 'fault', '--title', 'Ready', '--tag', 'ready-A1').code, 0);
  assert.ok(Date.parse(read(state).last_push) > Date.parse(kept));
  assert.equal(push(0, '--kind', 'fault', '--title', 'Orch is down').code, 0);
  assert.equal(push(0, '--kind', 'fault', '--title', 'e1 waits on your Done', '--tag', 'ask-e1', '--now').code, 0);
  assert.equal(push(0, '--kind', 'reminder', '--title', 'Everything is done', '--now').code, 0);

  assert.deepEqual(lines(calls), [
    ['push', '--kind', 'fault', '--title', 'Question', '--body', 'Pick one', '--url', '/orch/questions.html?from=push'],
    ['push', '--kind', 'fault', '--title', 'Ready', '--body', 'A1 is green · and 2 replies', '--tag', 'ready-A1', '--urgent'],
    ['push', '--kind', 'fault', '--title', 'Ready', '--body', 'and 2 replies', '--tag', 'ready-A1'],
    ['push', '--kind', 'fault', '--title', 'Orch is down'],
    ['push', '--kind', 'fault', '--title', 'e1 waits on your Done', '--tag', 'ask-e1', '--now'],
    ['push', '--kind', 'reminder', '--title', 'Everything is done', '--now'],
  ]);
  assert.equal(board('push', '--site', 'orch', '--kind', 'fault').code, 2);
  assert.equal(board('push', '--kind', 'fault', '--title', 'No site').code, 1);
});

test("a Claude thread line or reply rewrites its item's queued push to the latest message, and a sent push stays sent", () => {
  const board = (...args) => run('board.mjs', args, undefined, { KICKFLIP_PUSH_CMD: '' });
  write(at('kickflip', 'push', 'subs.json'), [{ endpoint: 'https://push.invalid/device', keys: { p256dh: 'x', auth: 'y' }, origin: 'https://hub.invalid' }]);
  const queueFile = at('kickflip', 'push', 'queue.json');
  const queue = () => Object.fromEntries(read(queueFile).items.map((i) => [i.tag, i.body]));
  fs.appendFileSync(site('orch', 'data', 'events.jsonl'), JSON.stringify({ id: 'm1', ts: '2026-10-23T10:05:00Z', kind: 'item-message', data: { key: 'w/A1' } }) + '\n');
  const lastPush = () => write(site('orch', 'data', 'push-state.json'), { last_push: new Date(Date.now() - 60_000).toISOString() });
  write(site('orch', 'data', 'replies', 'old.html'), '<p>Earlier.</p>');

  assert.equal(board('push', '--site', 'orch', '--kind', 'fault', '--title', 'e1 waits on your Done', '--body', 'Too early', '--tag', 'ask-e1').code, 0);
  lastPush();
  assert.equal(board('push', '--site', 'orch', '--kind', 'fault', '--title', 'e1 waits on your Done', '--body', 'First answer', '--tag', 'ask-e1').code, 0);
  assert.equal(board('push', '--site', 'orch', '--kind', 'fault', '--title', 'One needs you', '--body', 'Pick a layout', '--url', '/orch/prototype-layout.html?q=w-layout', '--tag', 'item-w/A1').code, 0);
  assert.deepEqual(queue(), { 'ask-e1': 'First answer · and 1 reply', 'item-w/A1': 'Pick a layout' });
  const urls = () => Object.fromEntries(read(queueFile).items.map((i) => [i.tag, i.url]));
  assert.equal(urls()['item-w/A1'], '/orch/prototype-layout.html?q=w-layout&from=push');

  assert.equal(board('thread', 'ask:e1', '--site', 'orch', '--text', 'Second answer\nwith more below').code, 0);
  assert.deepEqual(queue(), { 'ask-e1': 'Second answer · and 1 reply', 'item-w/A1': 'Pick a layout' });
  assert.equal(board('thread', 'ask:e1', '--site', 'orch', '--who', 'love', '--text', 'Thanks').code, 0);
  assert.equal(board('thread', 'w/A1', '--site', 'orch', '--who', 'Jamie', '--via', 'github', '--text', 'Looks good').code, 0);
  assert.deepEqual(queue(), { 'ask-e1': 'Second answer · and 1 reply', 'item-w/A1': 'Pick a layout' });

  assert.equal(board('reply', 'e1', '--site', 'orch', '--html', '<p>Third &amp; <b>final</b></p><details><summary>Why</summary>Long</details>').code, 0);
  const long = 'Layout B, because '.repeat(20);
  assert.equal(board('reply', 'm1', '--site', 'orch', '--html', `<p>${long}</p>`).code, 0);
  const bodies = queue();
  assert.equal(bodies['ask-e1'], 'Third & final · and 1 reply');
  assert.equal(urls()['item-w/A1'], '/orch/#item=w%2FA1&reply');
  assert.ok(bodies['item-w/A1'].length <= 160 && bodies['item-w/A1'].endsWith('…') && long.startsWith(bodies['item-w/A1'].slice(0, -1)));

  write(queueFile, { items: [] });
  assert.equal(board('thread', 'ask:e1', '--site', 'orch', '--text', 'After it went out').code, 0);
  assert.deepEqual(read(queueFile).items, []);
});

test('a push without an allowed kind is refused with one line, board.mjs allowing only a fault, and nothing goes', () => withDevice(async (b, received) => {
  const webTs = (...args) => runAsync(path.join('..', '..', 'bin', 'kickflip.mjs'), ['push', ...args], { KICKFLIP_HUB_PORT: '9' });
  for (const r of [
    await b('push', '--site', 'orch', '--title', 'Answered: keep it?', '--now'),
    await b('push', '--site', 'orch', '--kind', 'info', '--title', '2 PRs merged'),
    await b('push', '--site', 'orch', '--kind', 'action', '--title', 'A1 asks: Which layout?', '--tag', 'item-w/A1'),
    await b('push', '--site', 'orch', '--kind', 'prompt', '--title', 'Orch wants to run tests'),
  ]) {
    assert.equal(r.code, 2, r.err);
    assert.match(r.err, /a session pushes only --kind fault/);
    assert.equal(r.err.trim().split('\n').length, 1, r.err);
  }
  for (const r of [
    await webTs('--title', 'Orch board connected', '--now'),
    await webTs('--kind', 'info', '--title', 'Morning digest'),
  ]) {
    assert.equal(r.code, 2, r.err);
    assert.match(r.err, /a push needs --kind action\|prompt\|fault/);
    assert.equal(r.err.trim().split('\n').length, 1, r.err);
  }
  assert.deepEqual(received, []);
  assert.equal(fs.existsSync(at('kickflip', 'push', 'queue.json')), false);
  assert.equal(fs.existsSync(site('orch', 'data', 'push-state.json')), false);
}));

test("after a thread's push has gone, Claude's lines and replies there push nothing; a card whose action changes pushes again under its tag", () => withDevice(async (b, received) => {
  fs.appendFileSync(site('orch', 'data', 'events.jsonl'), JSON.stringify({ id: 'm1', ts: '2026-10-23T10:05:00Z', kind: 'item-message', data: { key: 'w/A1' } }) + '\n');
  const seen = () => received.map(({ title, body, url, tag }) => [tag, title, body, url]);
  const url = '/orch/#item=w%2FA1';

  assert.equal((await b('push', '--site', 'orch', '--kind', 'fault', '--now', '--title', 'A1 asks: Which layout?', '--body', 'Grid · List', '--url', url, '--tag', 'item-w/A1')).code, 0);
  assert.equal((await b('thread', 'w/A1', '--site', 'orch', '--text', 'Grid fits the phone')).code, 0);
  assert.equal((await b('reply', 'm1', '--site', 'orch', '--html', '<p>Filed as follow-up INT-56</p>')).code, 0);
  assert.equal((await b('reply', 'e1', '--site', 'orch', '--html', '<p>Yes, keep it</p>')).code, 0);
  assert.equal((await b('thread', 'w/A1', '--site', 'orch', '--text', 'Done', '--answer')).code, 2);
  assert.equal(received.length, 1);

  assert.equal((await b('push', '--site', 'orch', '--kind', 'fault', '--now', '--title', 'A1 asks: Which colour?', '--body', 'Blue · Red', '--url', url, '--tag', 'item-w/A1')).code, 0);
  assert.deepEqual(seen(), [
    ['item-w/A1', 'A1 asks: Which layout?', 'Grid · List', `${url}&reply`],
    ['item-w/A1', 'A1 asks: Which colour?', 'Blue · Red · and 2 replies', `${url}&reply`],
  ]);
  assert.deepEqual(read(at('kickflip', 'push', 'queue.json')).items, []);
}));

test('a reminder the owner asked for goes out as kickflip push sends a fault', () => withDevice(async (b, received) => {
  const r = await b('push', '--site', 'orch', '--kind', 'reminder', '--title', 'Everything is done', '--body', 'Orch has nothing in progress', '--url', '/orch/', '--now');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(received.map(({ title, body }) => [title, body]), [['Everything is done', 'Orch has nothing in progress']]);
}));

test('checked sends the queued pushes at the end of a tick, a board\'s several as one summary', () => withDevice(async (b, received) => {
  assert.equal((await b('push', '--site', 'orch', '--kind', 'fault', '--title', 'A2 waits on Merge', '--body', 'Green and approved', '--url', '/orch/')).code, 0);
  assert.equal((await b('push', '--site', 'orch', '--kind', 'fault', '--title', 'A1 waits on Ready', '--url', '/orch/#item=w%2FA1', '--tag', 'item-w/A1')).code, 0);
  assert.equal(received.length, 0);
  assert.equal((await b('checked', '--site', 'orch', '--every', '15')).code, 0);
  assert.deepEqual(received.map(({ title, body, tag, url }) => [title, body, tag, url]), [['2 updates on orch', 'A2 waits on Merge · A1 waits on Ready', 'summary:orch', '/orch/']]);
  assert.deepEqual(read(at('kickflip', 'push', 'queue.json')).items, []);
}));

test('item set refuses to start a blocked item, and finishing a dep prints, threads and emits each unblocking once', () => {
  write(at('waves', 'd', 'wave.json'), { items: [
    { id: 'A1', title: 'One', status: 'building' },
    { id: 'A2', title: 'Two', status: 'waiting', deps: ['A1'] },
    { id: 'A3', title: 'Three', status: 'waiting', deps: ['A1', 'A2'] },
    { id: 'A4', title: 'Four', status: 'done', deps: ['A1'] },
    { id: 'A5', title: 'Five', deps: ['d/A3'] },
  ] });
  const status = () => read(at('waves', 'd', 'wave.json')).items.map((it) => it.status);
  const events = () => lines(site('orch', 'data', 'events.jsonl')).filter((e) => e.kind === 'card-unblocked');
  const blocked = board('item', 'set', 'd/A3', '--status', 'building', '--site', 'orch');
  assert.equal(blocked.code, 1);
  assert.match(blocked.err, /d\/A1.*d\/A2|d\/A2.*d\/A1/);
  assert.deepEqual(status(), ['building', 'waiting', 'waiting', 'done', undefined]);
  assert.deepEqual(events(), []);
  const done = board('item', 'set', 'd/A1', '--status', 'done', '--site', 'orch', '--text', 'Done.');
  assert.equal(done.code, 0);
  assert.deepEqual(done.out.split('\n').filter((l) => l.startsWith('unblocked')), ['unblocked: d/A2']);
  assert.deepEqual(lines(site('orch', 'data', 'threads', 'd__A2.jsonl')).map(({ ts, ...m }) => m), [{ who: 'claude', text: 'Unblocked: A1 is done.' }]);
  assert.equal(fs.existsSync(site('orch', 'data', 'threads', 'd__A3.jsonl')), false);
  assert.deepEqual(events().map((e) => e.data), [{ key: 'd/A2' }]);
  assert.ok(events()[0].id);
  assert.ok(Date.parse(events()[0].ts));
  for (const status of ['done', 'merged', 'dropped']) {
    const repeated = board('item', 'set', 'd/A1', '--status', status, '--site', 'orch', '--text', 'Again.');
    assert.equal(repeated.code, 0);
    assert.doesNotMatch(repeated.out, /unblocked:/);
  }
  assert.equal(events().length, 1);
  assert.equal(lines(site('orch', 'data', 'threads', 'd__A2.jsonl')).length, 1);
  assert.equal(board('item', 'set', 'd/A2', '--status', 'building', '--site', 'orch').code, 0);
  const merged = board('item', 'set', 'd/A2', '--status', 'merged', '--site', 'orch');
  assert.deepEqual(merged.out.split('\n').filter((l) => l.startsWith('unblocked')), ['unblocked: d/A3']);
  assert.deepEqual(events().map((e) => e.data.key), ['d/A2', 'd/A3']);
  assert.deepEqual(lines(site('orch', 'data', 'threads', 'd__A2.jsonl')).map((m) => m.text), ['Unblocked: A1 is done.', 'Merged.']);
  const untold = board('item', 'set', 'd/A3', '--status', 'dropped', '--site', 'orch');
  assert.equal(untold.code, 1);
  assert.match(untold.err, /^--status dropped needs --text/);
  assert.equal(read(at('waves', 'd', 'wave.json')).items[2].status, 'waiting');
  const dropped = board('item', 'set', 'd/A3', '--status', 'dropped', '--site', 'orch', '--text', 'Dropped: A5 covers it.');
  assert.equal(dropped.code, 0);
  assert.match(dropped.out, /unblocked: d\/A5/);
  assert.equal(lines(site('orch', 'data', 'threads', 'd__A3.jsonl')).at(-1).text, 'Dropped: A5 covers it.');
  assert.deepEqual(events().map((e) => e.data.key), ['d/A2', 'd/A3', 'd/A5']);
  write(site('audit', 'data', 'wave.json'), { items: [
    { id: 'A1', status: 'building' }, { id: 'A2', status: 'checking' },
    { id: 'A3', status: 'waiting', deps: ['A1', 'audit/A2'] },
  ] });
  assert.equal(board('item', 'set', 'audit/A1', '--site', 'audit', '--status', 'done', '--text', 'Done.').code, 0);
  assert.equal(fs.existsSync(site('audit', 'data', 'events.jsonl')), false);
  assert.equal(board('item', 'set', 'audit/A2', '--site', 'audit', '--status', 'merged').code, 0);
  assert.deepEqual(lines(site('audit', 'data', 'events.jsonl')).map((e) => [e.kind, e.data]), [['card-unblocked', { key: 'audit/A3' }]]);
});

test('item set takes checking as a hand-back that unblocks nothing, and done from checking unblocks as usual', () => {
  write(at('waves', 'd', 'wave.json'), { items: [
    { id: 'A1', title: 'One', status: 'building' },
    { id: 'A2', title: 'Two', status: 'waiting', deps: ['A1'] },
  ] });
  const unblocked = (r) => r.out.split('\n').filter((l) => l.startsWith('unblocked'));
  const checking = board('item', 'set', 'd/A1', '--status', 'checking', '--site', 'orch');
  assert.equal(checking.code, 0);
  assert.deepEqual(unblocked(checking), []);
  assert.equal(lines(site('orch', 'data', 'events.jsonl')).some((e) => e.kind === 'card-unblocked'), false);
  assert.equal(read(at('waves', 'd', 'wave.json')).items[0].status, 'checking');
  assert.equal(board('item', 'set', 'd/A2', '--status', 'building', '--site', 'orch').code, 1);
  assert.deepEqual(unblocked(board('item', 'set', 'd/A1', '--status', 'done', '--site', 'orch', '--text', 'Done.')), ['unblocked: d/A2']);
});

// docs/adr/2026-11-05-0802-todo-has-no-queue.md
test("starting or closing a card ends the wait of an Implement message's card", () => {
  const askedAt = '2026-11-03T10:26:00.000Z';
  write(at('waves', 'd', 'wave.json'), { items: [{ id: 'A1', title: 'One', implement_at: askedAt }, { id: 'A2', title: 'Two', implement_at: askedAt }] });
  assert.equal(board('item', 'set', 'd/A1', '--status', 'building', '--site', 'orch').code, 0);
  assert.equal(board('item', 'set', 'd/A2', '--status', 'dropped', '--site', 'orch', '--text', 'Not needed.').code, 0);
  assert.deepEqual(read(at('waves', 'd', 'wave.json')).items.map((it) => it.implement_at), [undefined, undefined]);
});

// docs/adr/2026-11-05-0802-todo-has-no-queue.md
test("ready releases a card an Implement message asked for, which the board server starts at once; one a dep still blocks is bumped instead and stays in Todo", () => {
  const askedAt = '2026-11-05T10:00:00.000Z';
  write(at('waves', 'd', 'wave.json'), { items: [
    { id: 'A1', title: 'One', implement_at: askedAt },
    { id: 'A0', title: 'Blocker', status: 'building' },
    { id: 'A2', title: 'Two', deps: ['A0'], implement_at: askedAt },
  ] });
  write(at('waves', 'd', 'a1.md'), '# A1\n\nUse the blue.\n');
  write(at('waves', 'd', 'a2.md'), '# A2\n\nUse the red.\n');
  const r = board('item', 'set', 'd/A1', '--site', 'orch', '--state', 'ready', '--size', 'small', '--notes-file', 'a1.md');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^released: d\/A1 starts building now$/m);
  const blocked = board('item', 'set', 'd/A2', '--site', 'orch', '--state', 'ready', '--size', 'small', '--notes-file', 'a2.md');
  assert.equal(blocked.code, 0, blocked.err);
  assert.match(blocked.out, /^bumped: d\/A2 waits on A0, so it stays in Todo, bumped to the top$/m);
  const [one, , two] = read(at('waves', 'd', 'wave.json')).items;
  assert.deepEqual([one.state, one.implement_at, two.state, two.implement_at, 'queued_at' in one], ['ready', askedAt, 'ready', undefined, false]);
  assert.deepEqual(lines(site('orch', 'data', 'events.jsonl')).filter((e) => e.kind === 'card-bump').map((e) => e.data.key), ['d/A2']);
  assert.match(lines(site('orch', 'data', 'threads', 'd__A2.jsonl')).at(-1).text, /^Can’t start yet: waits on A0\. Bumped to the top of Todo\.$/);
});

test('a held item emits its unblocking but never starts until --unheld resumes it', () => {
  write(at('waves', 'd', 'wave.json'), { items: [
    { id: 'A1', title: 'One', status: 'building' },
    { id: 'A2', title: 'Two', status: 'waiting', deps: ['A1'] },
    { id: 'A3', title: 'Three', status: 'held', deps: ['A1'] },
  ] });
  const items = () => read(at('waves', 'd', 'wave.json')).items;
  assert.equal(board('item', 'set', 'd/A2', '--held', '--site', 'orch').code, 0);
  assert.equal(items()[1].held, true);
  assert.equal(board('item', 'set', 'd/A2', '--held', '--unheld', '--site', 'orch').code, 1);
  const done = board('item', 'set', 'd/A1', '--status', 'done', '--site', 'orch', '--text', 'Done.');
  assert.deepEqual(done.out.split('\n').filter((l) => l.startsWith('unblocked')), ['unblocked: d/A2', 'unblocked: d/A3']);
  assert.deepEqual(lines(site('orch', 'data', 'events.jsonl')).filter((e) => e.kind === 'card-unblocked').map((e) => e.data.key), ['d/A2', 'd/A3']);
  const refused = board('item', 'set', 'd/A2', '--status', 'building', '--site', 'orch');
  assert.equal(refused.code, 1);
  assert.match(refused.err, /d\/A2 is held.*--unheld/);
  assert.equal(items()[1].status, 'waiting');
  assert.equal(board('item', 'set', 'd/A3', '--status', 'building', '--site', 'orch').code, 1);
  assert.equal(board('item', 'set', 'd/A2', '--unheld', '--site', 'orch').code, 0);
  assert.equal(board('item', 'set', 'd/A3', '--unheld', '--site', 'orch').code, 0);
  assert.deepEqual(items().map((it) => [it.status, Boolean(it.held)]), [['done', false], ['waiting', false], [undefined, false]]);
  assert.equal(board('item', 'set', 'd/A2', '--status', 'building', '--site', 'orch').code, 0);
});

test('--pick-up-at holds a card until a time, read as local time without an offset and stored as UTC; a past time is refused, "" and --unheld resume it, and --held drops the time', () => {
  write(at('waves', 'd', 'wave.json'), { items: [{ id: 'A1', title: 'One', status: 'planned' }] });
  const item = (id = 'A1') => read(at('waves', 'd', 'wave.json')).items.find((it) => it.id === id);
  const later = new Date(Date.now() + 2 * 86_400_000);
  const pad = (n) => String(n).padStart(2, '0');
  const local = `${later.getFullYear()}-${pad(later.getMonth() + 1)}-${pad(later.getDate())}T09:00`;
  const nine = new Date(later.getFullYear(), later.getMonth(), later.getDate(), 9, 0).toISOString();
  assert.equal(board('item', 'set', 'd/A1', '--pick-up-at', local, '--site', 'orch').code, 0);
  assert.deepEqual([item().held, item().pick_up_at], [true, nine]);
  const refused = board('item', 'set', 'd/A1', '--status', 'building', '--site', 'orch');
  assert.equal(refused.code, 1);
  assert.match(refused.err, new RegExp(`d/A1 is held until ${nine}.*--unheld`));
  for (const bad of ['2020-01-01T09:00', '2026-11-04', 'Wed 9am']) {
    const r = board('item', 'set', 'd/A1', '--pick-up-at', bad, '--site', 'orch');
    assert.equal(r.code, 1, bad);
    assert.match(r.err, /--pick-up-at/);
  }
  assert.equal(board('item', 'set', 'd/A1', '--pick-up-at', local, '--held', '--site', 'orch').code, 1);
  assert.equal(board('item', 'set', 'd/A1', '--pick-up-at', later.toISOString(), '--site', 'orch').code, 0);
  assert.equal(item().pick_up_at, later.toISOString());
  assert.equal(board('item', 'set', 'd/A1', '--held', '--site', 'orch').code, 0);
  assert.deepEqual([item().held, item().pick_up_at], [true, undefined]);
  assert.equal(board('item', 'set', 'd/A1', '--pick-up-at', local, '--site', 'orch').code, 0);
  assert.equal(board('item', 'set', 'd/A1', '--pick-up-at', '', '--site', 'orch').code, 0);
  assert.deepEqual([item().held, item().pick_up_at], [undefined, undefined]);
  assert.equal(board('item', 'set', 'd/A1', '--pick-up-at', local, '--site', 'orch').code, 0);
  assert.equal(board('item', 'set', 'd/A1', '--unheld', '--site', 'orch').code, 0);
  assert.deepEqual([item().held, item().pick_up_at], [undefined, undefined]);
  assert.equal(board('item', 'add', 'd/A2', '--title', 'Two', '--pick-up-at', local, '--site', 'orch').code, 0);
  assert.deepEqual([item('A2').status, item('A2').held, item('A2').pick_up_at], [undefined, true, nine]);
});

test("item set --status building takes a prototype pick's note as guidance, and refuses while the newest answer to the card's prototypes picks no take", () => {
  const card = (id, url, extra = {}) => question(id, { topic: 'item:w/A1', ...(url ? { url: `${url}?q=${id}` } : {}), ...extra });
  write(site('orch', 'data', 'owner.json'), { topics: [{ id: 'site', title: 'Site' }], items: [
    card('q1', 'prototype-old.html'), card('q2', 'prototype-old.html'), card('q3', ''), card('q4', 'prototype-old.html', { topic: 'site' }),
  ] });
  let n = 0;
  const answer = (id, choice, note) => addEvents({ id: `a${++n}`, ts: `2026-11-01T10:${String(n).padStart(2, '0')}:00Z`, kind: 'owner-answer', data: { id, ...(choice ? { choice } : {}), ...(note === undefined ? {} : { note }) } });
  const start = (...extra) => board('item', 'set', 'w/A1', '--status', 'building', '--site', 'orch', ...extra);
  const status = () => read(at('waves', 'w', 'wave.json')).items[0].status;

  answer('q1', 'A', 'B, but with the moon on the left');
  answer('q3', null, 'Not this one');
  answer('q4', null, 'Nor this');
  assert.equal(start().code, 0);
  assert.equal(status(), 'building');
  assert.equal(fs.existsSync(site('orch', 'data', 'threads', 'w__A1.jsonl')), false);

  assert.equal(board('item', 'set', 'w/A1', '--clear-status', '--site', 'orch').code, 0);
  answer('q2', null, 'Neither: try a darker moon');
  assert.deepEqual(start(), { code: 1, out: '', err: 'w/A1 has no take picked: the owner\'s answer to q2 picks none ("Neither: try a darker moon"), so it prototypes again: draw the next round from that note, or grill when the note asks a question, and build once a take is picked\n' });
  assert.equal(status(), undefined);
  assert.equal(start('--confirmed', 'try a darker moon').code, 2);
  answer('q2', 'B');
  assert.equal(start().code, 0);
  assert.equal(status(), 'building');
});

test("thread writes in an ask's thread and refuses an unknown ask", () => {
  assert.equal(board('thread', 'ask:e1', '--site', 'orch', '--text', 'Answered here.').code, 0);
  assert.deepEqual(lines(site('orch', 'data', 'threads', 'ask__e1.jsonl')).map(({ ts, ...m }) => m), [{ who: 'claude', text: 'Answered here.' }]);
  assert.match(board('thread', 'ask:e9', '--site', 'orch', '--text', 'x').err, /no ask "e9"/);
});

test('item relate-ask folds an ask into an item with one summary line, ask unfold and item set --from-ask move it back out', () => {
  const r = board('item', 'relate-ask', 'e1', 'w/A1', '--summary', 'Asked to keep the header spacing', '--site', 'orch');
  assert.equal(r.code, 0);
  assert.deepEqual(read(site('orch', 'data', 'ask-links.json')), { links: { e1: 'w/A1' } });
  assert.deepEqual(lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).map(({ ts, ...m }) => m), [{ who: 'claude', text: 'Asked to keep the header spacing' }]);
  fs.appendFileSync(site('orch', 'data', 'events.jsonl'), JSON.stringify({ id: 'm1', ts: '2026-10-23T10:00:00Z', kind: 'item-message', data: { key: 'w/A1' } }) + '\n');
  assert.match(board('item', 'relate-ask', 'm1', 'w/A1', '--summary', 'x', '--site', 'orch').err, /no ask "m1"/);
  assert.match(board('item', 'relate-ask', 'e1', 'w/A9', '--summary', 'x', '--site', 'orch').err, /no item "A9"/);
  assert.equal(board('ask', 'unfold', 'e1', '--site', 'orch').code, 0);
  assert.deepEqual(read(site('orch', 'data', 'ask-links.json')), { links: {} });
  assert.match(board('ask', 'unfold', 'e1', '--site', 'orch').err, /ask "e1" is not folded into a card/);
  board('item', 'relate-ask', 'e1', 'w/A1', '--summary', 'Back in', '--site', 'orch');
  const stateless = board('item', 'set', 'w/A1', '--from-ask', 'e1', '--site', 'orch', '--text', 'Building it.');
  assert.deepEqual([stateless.code, stateless.err], [1, '--from-ask files a card, which reads New until it has a state: pass --state ready, grilling or prototyping\n']);
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].from_ask, undefined);
  assert.equal(board('item', 'set', 'w/A1', '--from-ask', 'e1', '--state', 'grilling', '--site', 'orch', '--text', 'Building it.').code, 0);
  assert.deepEqual([read(site('orch', 'data', 'ask-links.json')), read(at('waves', 'w', 'wave.json')).items[0].from_ask], [{ links: {} }, 'e1']);
  assert.equal(lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).at(-1).text, 'Building it.');
  assert.match(board('item', 'set', 'w/A1', '--from-ask', 'e1', '--state', 'ready', '--site', 'orch').err, /^--from-ask needs --text/);
});

function boardsManifest() {
  const entry = (route) => ({ dir: site(route), port: 1, cmd: [process.execPath, '/skill/board/server.mjs', site(route)] });
  write(at('kickflip', 'manifest.json'), { sites: { orch: entry('orch'), audit: entry('audit'), notes: { dir: site('notes'), port: 1, cmd: [process.execPath, 'server.mjs'] } } });
}
const addEvents = (...events) => fs.appendFileSync(site('orch', 'data', 'events.jsonl'), events.map((e) => JSON.stringify(e) + '\n').join(''));

test("ask move sends a New ask to another board with the owner's latest text, its attachments and its edits' and where it came from, and leaves it Done here with a line linking there", () => {
  boardsManifest();
  write(site('orch', 'data', 'uploads', '1700-shot.png'), 'png bytes');
  write(site('orch', 'data', 'uploads', '.meta', '1700-shot.png.json'), { name: 'shot.png', type: 'image/png', size: 9, at: '2026-10-23T09:00:00Z' });
  const shot = { name: 'shot.png', url: 'uploads/1700-shot.png', path: site('orch', 'data', 'uploads', '1700-shot.png'), type: 'image/png', size: 9 };
  write(site('orch', 'data', 'uploads', '1701-more.pdf'), 'pdf bytes');
  const more = { name: 'more.pdf', url: 'uploads/1701-more.pdf', path: site('orch', 'data', 'uploads', '1701-more.pdf'), type: 'application/pdf', size: 9 };
  addEvents({ id: 'e2', ts: '2026-10-23T11:00:00Z', kind: 'ask', data: { text: 'Fix the audit header', files: [shot] } },
    { id: 'e3', ts: '2026-10-23T11:05:00Z', kind: 'ask-edited', data: { id: 'e2', text: 'Fix the audit header spacing', files: [more] } });
  const r = board('ask', 'move', 'e2', '--to', 'audit', '--site', 'orch');
  assert.equal(r.code, 0, r.err);
  const [moved, ...others] = lines(site('audit', 'data', 'events.jsonl'));
  assert.equal(others.length, 0);
  const [file, edited] = moved.data.files;
  assert.deepEqual([edited.name, fs.readFileSync(site('audit', 'data', edited.url), 'utf8')], ['more.pdf', 'pdf bytes']);
  assert.deepEqual([moved.kind, moved.data.text, moved.data.from, file.name, file.type], ['ask', 'Fix the audit header spacing', { route: 'orch', title: 'Orch', id: 'e2' }, 'shot.png', 'image/png']);
  assert.match(file.url, /^uploads\/\d+-shot\.png$/);
  assert.equal(file.path, site('audit', 'data', file.url));
  assert.equal(fs.readFileSync(site('audit', 'data', file.url), 'utf8'), 'png bytes');
  assert.equal(read(site('audit', 'data', 'uploads', '.meta', `${file.url.slice(8)}.json`)).name, 'shot.png');
  const link = `/audit/#item=ask%3A${moved.id}`;
  assert.match(r.out, new RegExp(`moved to ${link.replace(/[/#%]/g, '\\$&')}`));
  const mark = read(site('orch', 'data', 'ask-progress.json')).asks.e2;
  assert.deepEqual([mark.state, mark.moved], ['done', { route: 'audit', title: 'Audit', id: moved.id }]);
  assert.deepEqual(lines(site('orch', 'data', 'threads', 'ask__e2.jsonl')).map(({ ts, ...m }) => m), [{ who: 'claude', text: 'Moved to Audit.', link }]);

  assert.match(board('ask', 'move', 'e2', '--to', 'audit', '--site', 'orch').err, /ask "e2" was already moved to \/audit/);
  assert.match(board('ask', 'progress', 'e2', '--site', 'orch').err, /ask "e2" was moved to \/audit/);
  assert.match(board('item', 'set', 'w/A1', '--from-ask', 'e2', '--state', 'ready', '--site', 'orch', '--text', 'On it.').err, /ask "e2" was moved to \/audit/);
  assert.equal(lines(site('audit', 'data', 'events.jsonl')).length, 1);
});

test('ask move refuses a route that is not another board, and an ask that is not New, changing nothing', () => {
  boardsManifest();
  addEvents({ id: 'e4', ts: '2026-10-23T11:00:00Z', kind: 'ask', data: { text: 'Folded' } }, { id: 'e5', ts: '2026-10-23T11:00:00Z', kind: 'ask', data: { text: 'Deleted' } },
    { id: 'e6', ts: '2026-10-23T11:01:00Z', kind: 'ask-withdrawn', data: { id: 'e5' } }, { id: 'e7', ts: '2026-10-23T11:00:00Z', kind: 'ask', data: { text: 'Talked' } },
    { id: 'm1', ts: '2026-10-23T11:00:00Z', kind: 'item-message', data: { key: 'w/A1', text: 'Not an ask' } });
  board('reply', 'e1', '--site', 'orch', '--html', '<p>Answered.</p>');
  board('item', 'relate-ask', 'e4', 'w/A1', '--summary', 'Folded in', '--site', 'orch');
  board('thread', 'ask:e7', '--site', 'orch', '--text', 'Answered in the thread.');
  const refusals = [
    [['e7', '--to', 'nope'], /--to nope: no board at \/nope in the hub's manifest; the boards are orch, audit/],
    [['e7', '--to', 'notes'], /no board at \/notes/],
    [['e7', '--to', 'orch'], /--to orch: that is this board/],
    [['e7'], /ask move needs --to <route>/],
    [['m1', '--to', 'audit'], /no ask "m1"/],
    [['e1', '--to', 'audit'], /ask "e1" is not New: Claude already answered it/],
    [['e7', '--to', 'audit'], /ask "e7" is not New/],
    [['e4', '--to', 'audit'], /ask "e4" is folded into w\/A1; run ask unfold e4 first/],
    [['e5', '--to', 'audit'], /ask "e5" was deleted by the owner/],
  ];
  for (const [args, err] of refusals) {
    const r = board('ask', 'move', ...args, '--site', 'orch');
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err, err);
    assert.equal(r.err.trim().split('\n').length, 1);
  }
  assert.equal(fs.existsSync(site('audit', 'data', 'events.jsonl')), false);
  assert.equal(fs.existsSync(site('orch', 'data', 'ask-progress.json')), false);
});

test('ask move drops the card an ask became when it has not started, and refuses one that has', () => {
  boardsManifest();
  // A card set to building gets a worktree from the board's repo.
  const manifest = read(at('kickflip', 'manifest.json'));
  manifest.sites.orch.owner = { repo: scratchRepo() };
  write(at('kickflip', 'manifest.json'), manifest);
  addEvents({ id: 'e2', ts: '2026-10-23T11:00:00Z', kind: 'ask', data: { text: 'Filed first' } }, { id: 'e3', ts: '2026-10-23T11:00:00Z', kind: 'ask', data: { text: 'Started' } });
  board('item', 'set', 'w/A1', '--from-ask', 'e2', '--state', 'grilling', '--site', 'orch', '--text', 'Filed.');
  board('item', 'add', 'w/A2', '--title', 'Two', '--site', 'orch');
  board('item', 'set', 'w/A2', '--from-ask', 'e3', '--state', 'grilling', '--status', 'building', '--site', 'orch', '--text', 'Building it.');
  assert.match(board('ask', 'move', 'e3', '--to', 'audit', '--site', 'orch').err, /ask "e3" became w\/A2, which has started/);
  const r = board('ask', 'move', 'e2', '--to', 'audit', '--site', 'orch');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /dropped: w\/A1/);
  assert.deepEqual(read(at('waves', 'w', 'wave.json')).items.filter((i) => i.id !== 'ENG-1').map((i) => [i.id, i.status]), [['A1', 'dropped'], ['A2', 'building']]);
  assert.deepEqual(lines(site('audit', 'data', 'events.jsonl')).map((e) => e.data.text), ['Filed first']);
  assert.equal(lines(site('orch', 'data', 'threads', 'ask__e2.jsonl'))[0].text, 'Moved to Audit.');
});

test('item set --from-ask on a card that came from another ask refuses and points to relate-ask; the same ask again stays fine', () => {
  addEvents({ id: 'e2', ts: '2026-10-23T11:00:00Z', kind: 'ask', data: { text: 'A second ask' } });
  assert.equal(board('item', 'set', 'w/A1', '--from-ask', 'e1', '--state', 'grilling', '--site', 'orch', '--text', 'On it.').code, 0);
  const r = board('item', 'set', 'w/A1', '--from-ask', 'e2', '--state', 'grilling', '--site', 'orch', '--text', 'Also this.');
  assert.equal(r.code, 1);
  assert.match(r.err, /w\/A1 came from ask "e1".*item relate-ask e2 w\/A1 --summary/);
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].from_ask, 'e1');
  assert.equal(board('item', 'set', 'w/A1', '--from-ask', 'e1', '--state', 'grilling', '--site', 'orch', '--text', 'Again.').code, 0);
});

test('item set records when the status last changed, and only then', () => {
  board('item', 'set', 'w/A1', '--status', 'building', '--site', 'orch');
  const first = read(at('waves', 'w', 'wave.json')).items[0].status_at;
  assert.ok(Date.parse(first));
  board('item', 'set', 'w/A1', '--next', 'Later', '--site', 'orch');
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].status_at, first);
  board('item', 'set', 'w/A1', '--status', 'done', '--site', 'orch', '--text', 'Done.');
  assert.ok(read(at('waves', 'w', 'wave.json')).items[0].status_at > first);
});

test('ask progress and ask done mark a known ask, keeping --next only while in progress, and refuse an unknown ask', () => {
  assert.equal(board('ask', 'progress', 'e1', '--next', 'Pick a take', '--site', 'orch').code, 0);
  const marked = read(site('orch', 'data', 'ask-progress.json')).asks.e1;
  assert.deepEqual([marked.state, marked.next, Boolean(Date.parse(marked.at))], ['progress', 'Pick a take', true]);
  assert.equal(board('ask', 'done', 'e1', '--site', 'orch').code, 0);
  const done = read(site('orch', 'data', 'ask-progress.json')).asks.e1;
  assert.deepEqual([done.state, done.next], ['done', undefined]);
  assert.match(board('ask', 'progress', 'e9', '--site', 'orch').err, /no ask "e9"/);
  assert.match(board('ask', 'done', 'e1', '--next', 'x', '--site', 'orch').err, /does not take --next/);
});

test('checked records when GitHub was last checked and the interval, idle while no card has an open PR, and refuses a bad interval', () => {
  assert.equal(board('checked', '--site', 'orch', '--every', '60').code, 0);
  const c = read(site('orch', 'data', 'checked.json'));
  assert.equal(c.every, 60);
  assert.ok(Date.now() - Date.parse(c.at) < 60000);
  assert.deepEqual(board('checked', '--site', 'orch'), { code: 0, err: '', out: 'GitHub checked; no open PR\n' });
  assert.deepEqual({ ...read(site('orch', 'data', 'checked.json')), at: null }, { at: null, every: null, idle: true });
  write(at('waves', 'w', 'wave.json'), { ...wave(), repo: 'o/r', items: [{ id: 'A1', title: 'One', pr: 5 }, { id: 'A2', title: 'Two', pr: 6, status: 'merged' }] });
  assert.deepEqual(board('checked', '--site', 'orch'), { code: 0, err: '', out: 'GitHub checked; next in 5 min\n' });
  assert.equal(read(site('orch', 'data', 'checked.json')).every, 5);
  const bad = board('checked', '--site', 'orch', '--every', '0');
  assert.equal(bad.code, 1);
  assert.match(bad.err, /--every/);
  assert.equal(board('checked', '--site', 'orch', '--idle').code, 0);
  assert.deepEqual({ ...read(site('orch', 'data', 'checked.json')), at: null }, { at: null, every: null, idle: true });
  assert.equal(board('checked', '--site', 'orch', '--every', '30').code, 0);
  assert.equal(read(site('orch', 'data', 'checked.json')).idle, undefined);
  assert.equal(board('checked', '--site', 'orch', '--idle', '--every', '30').code, 1);
});

test("reviewers set, add and remove keep the board's own reviewers in its board.json", () => {
  const ann = { name: 'Ann', slack_user: 'U01ANN', dm: 'D01ANN', github: 'ann' };
  const bob = { name: 'Bob', slack_user: 'U02BOB', dm: 'D02BOB', github: 'bob-b' };
  const cfg = () => read(site('orch', 'board.json'));
  write(at('waves', 'old', 'wave.json'), { title: 'Old', items: [{ id: 'O1', title: 'Shipped', status: 'merged' }] });
  write(path.join(home, 'r.json'), [ann]);
  assert.deepEqual(board('reviewers', 'set', '--site', 'orch', '--file', path.join(home, 'r.json')).out.trim().split('\n').slice(1), ['wave w: reviewers copied']);
  assert.deepEqual(cfg(), { title: 'Orch', items: 'waves', reviewers: [ann] });
  write(path.join(home, 'bob.json'), bob);
  assert.equal(board('reviewers', 'add', '--site', 'orch', '--file', path.join(home, 'bob.json')).code, 0);
  write(path.join(home, 'ann.json'), [{ ...ann, name: 'ann', github: 'ann-2' }]);
  assert.equal(board('reviewers', 'add', '--site', 'orch', '--file', path.join(home, 'ann.json')).code, 0);
  assert.deepEqual(cfg().reviewers, [{ ...ann, name: 'ann', github: 'ann-2' }, bob]);
  assert.equal(board('reviewers', 'remove', 'Ann', '--site', 'orch').code, 0);
  assert.deepEqual(cfg().reviewers, [bob]);

  const rejected = [[{ name: 'Cy' }], [{ ...ann, email: 'a@x' }], [{ ...ann, slack_user: 'ann' }], [ann, { ...ann, name: 'ANN' }], ann];
  for (const file of rejected) {
    write(path.join(home, 'bad.json'), file);
    assert.equal(board('reviewers', 'set', '--site', 'orch', '--file', path.join(home, 'bad.json')).code, 1, JSON.stringify(file));
  }
  assert.match(board('reviewers', 'remove', 'Bob', 'Zed', '--site', 'orch').err, /Zed/);
  assert.equal(board('reviewers', 'set', '--file', path.join(home, 'r.json')).code, 1);
  assert.deepEqual(cfg(), { title: 'Orch', items: 'waves', reviewers: [bob] });
  assert.deepEqual([read(at('waves', 'w', 'wave.json')).reviewers, read(at('waves', 'old', 'wave.json')).reviewers], [[bob], undefined]);
});

test("settings prints the board's settings as JSON, off when absent, and settings set auto-merge on|off writes board.json keeping its other keys", () => {
  const cfg = () => read(site('orch', 'board.json'));
  write(site('orch', 'board.json'), { title: 'Orch', items: 'waves', rules: [{ id: 'r1', text: 'Ask first', by: 'owner', at: 'x' }] });
  assert.deepEqual(board('settings', '--site', 'orch'), { code: 0, out: '{"auto_merge":false,"auto_build":false,"auto_pull":false,"max_implementers":10,"max_planners":3,"auto_triage":false,"auto_review":false,"idle_notification":false,"skip_draft":false,"prs":true}\n', err: '' });
  const on = board('settings', 'set', 'auto-merge', 'on', '--site', 'orch');
  assert.equal(on.code, 0);
  assert.match(on.out, /^auto-merge on$/m);
  assert.deepEqual(cfg(), { title: 'Orch', items: 'waves', rules: [{ id: 'r1', text: 'Ask first', by: 'owner', at: 'x' }], auto_merge: true });
  assert.equal(board('settings', '--site', 'orch').out, '{"auto_merge":true,"auto_build":false,"auto_pull":false,"max_implementers":10,"max_planners":3,"auto_triage":false,"auto_review":false,"idle_notification":false,"skip_draft":false,"prs":true}\n');
  assert.equal(board('settings', 'set', 'auto-merge', 'off', '--site', 'orch').code, 0);
  assert.equal(cfg().auto_merge, false);
  // docs/adr/2026-11-04-1913-a-board-can-skip-the-draft.md
  assert.deepEqual(board('settings', 'set', 'skip-draft', 'on', '--site', 'orch'), { code: 0, out: 'skip-draft on\n', err: '' });
  assert.equal(cfg().skip_draft, true);
  assert.equal(board('settings', 'set', 'skip-draft', 'off', '--site', 'orch').code, 0);
  assert.equal(cfg().skip_draft, false);
  assert.deepEqual(board('settings', 'set', 'idle-notification', 'on', '--site', 'orch'), { code: 0, out: 'idle-notification on\n', err: '' });
  assert.equal(cfg().idle_notification, true);
  assert.equal(board('settings', 'set', 'idle-notification', 'off', '--site', 'orch').code, 0);

  // docs/adr/2026-11-04-0057-auto-implement-fills-in-progress-up-to-a-cap.md
  const cap = board('settings', 'set', 'max-implementers', '4', '--site', 'orch');
  assert.deepEqual([cap.code, cap.out, cfg().max_implementers], [0, 'max-implementers 4\n', 4]);
  for (const invalid of ['0', '100', '2.5', 'on', '']) {
    assert.match(board('settings', 'set', 'max-implementers', invalid, '--site', 'orch').err, /max_implementers must be a whole number from 1 to 99/, invalid);
  }
  assert.equal(cfg().max_implementers, 4);
  assert.equal(board('settings', 'set', 'max-implementers', '10', '--site', 'orch').code, 0);
  // docs/adr/2026-11-04-2359-every-card-arriving-in-todo-is-grilled-by-the-board.md
  assert.deepEqual(board('settings', 'set', 'max-planners', '5', '--site', 'orch'), { code: 0, out: 'max-planners 5\n', err: '' });
  assert.equal(cfg().max_planners, 5);
  for (const invalid of ['0', '100', '2.5', 'on']) {
    assert.match(board('settings', 'set', 'max-planners', invalid, '--site', 'orch').err, /max_planners must be a whole number from 1 to 99/, invalid);
  }
  assert.equal(cfg().max_planners, 5);
  assert.equal(board('settings', 'set', 'max-planners', '3', '--site', 'orch').code, 0);

  const login = board('settings', 'set', 'github-login', 'owner', '--site', 'orch');
  assert.equal(login.code, 0);
  assert.match(login.out, /^github-login owner$/m);
  assert.equal(cfg().github_login, 'owner');
  assert.equal(JSON.parse(board('settings', '--site', 'orch').out).github_login, 'owner');
  assert.match(board('settings', 'set', 'github-login', '', '--site', 'orch').out, /^github-login unset$/m);
  assert.ok(!('github_login' in cfg()));
  for (const invalid of ['-owner', 'a_b', 'a'.repeat(40)]) {
    assert.equal(board('settings', 'set', 'github-login', invalid, '--site', 'orch').code, 1);
  }

  const bad = [
    [['settings'], 1, /needs --site/],
    [['settings', 'set', 'auto-merge', 'yes', '--site', 'orch'], 1, /takes on or off/],
    [['settings', 'set', 'auto-deploy', 'on', '--site', 'orch'], 1, /no board setting "auto-deploy"; settings are auto-merge/],
    [['settings', 'set', 'auto-merge', '--site', 'orch'], 2, /settings set takes <name> <value>/],
  ];
  for (const [args, code, err] of bad) {
    const r = board(...args);
    assert.equal(r.code, code, args.join(' '));
    assert.match(r.err, err, args.join(' '));
  }
  assert.equal(cfg().auto_merge, false);
});

test("rules add, edit and remove keep a board's rules in its board.json and the hub's in settings.json, and list prints both", () => {
  const settings = { quiet: { start: '22:00', end: '08:00', hold: true }, other_key: 'kept' };
  write(at('kickflip', 'settings.json'), settings);
  write(site('orch', 'board.json'), { title: 'Orch', items: 'waves', reviewers: [{ name: 'Ann', slack_user: 'U1', dm: 'D1', github: 'ann' }] });
  assert.deepEqual([board('rules', 'list', '--site', 'orch').out], ['']);
  const added = board('rules', 'add', '--site', 'orch', '--text', 'Ask before\n  touching main');
  assert.equal(added.code, 0);
  const boardId = /^id (\S+)$/m.exec(added.out)[1];
  const hubId = /^id (\S+)$/m.exec(board('rules', 'add', '--hub', '--by', 'claude', '--text', 'Screenshots in every PR').out)[1];
  const cfg = read(site('orch', 'board.json'));
  assert.deepEqual([cfg.title, cfg.reviewers.length, cfg.rules.map((r) => [r.id, r.text, r.by])], ['Orch', 1, [[boardId, 'Ask before touching main', 'owner']]]);
  assert.deepEqual({ ...read(at('kickflip', 'settings.json')), rules: undefined }, { ...settings, rules: undefined });
  const list = board('rules', 'list', '--site', 'orch');
  assert.equal(list.out, `hub ${hubId} claude Screenshots in every PR\nboard ${boardId} owner Ask before touching main\n`);
  assert.equal(board('rules', 'list').out, `hub ${hubId} claude Screenshots in every PR\n`);

  assert.equal(board('rules', 'edit', boardId, '--site', 'orch', '--text', 'Ask first').code, 0);
  assert.equal(board('rules', 'edit', hubId, '--hub', '--text', 'Screenshots always').code, 0);
  assert.deepEqual(read(at('kickflip', 'settings.json')).rules.map((r) => [r.text, r.by]), [['Screenshots always', 'claude']]);
  assert.match(board('rules', 'remove', hubId, '--site', 'orch').err, /it is a hub rule, so pass --hub/);
  assert.match(board('rules', 'remove', boardId, '--hub', '--site', 'orch').err, /it is a board rule, so drop --hub/);
  assert.equal(board('rules', 'remove', boardId, '--site', 'orch').code, 0);
  assert.equal(board('rules', 'remove', hubId, '--hub').code, 0);
  assert.equal(board('rules', 'list', '--site', 'orch').out, '');
  assert.deepEqual(read(site('orch', 'board.json')).rules, []);
});

test('rules refuse a board rule without --site, an empty text, an unknown author or id, and stray flags', () => {
  const bad = [
    [['rules', 'add', '--text', 'x'], 1, /needs --site/],
    [['rules', 'add', '--site', 'orch', '--text', '  '], 1, /non-empty/],
    [['rules', 'add', '--site', 'orch'], 1, /non-empty/],
    [['rules', 'add', '--site', 'orch', '--text', 'x', '--by', 'bob'], 1, /--by takes owner or claude/],
    [['rules', 'edit', 'r9', '--site', 'orch', '--text', 'x'], 1, /no board rule "r9"/],
    [['rules', 'remove', 'r9', '--hub'], 1, /no hub rule "r9"/],
    [['rules', 'remove', '--site', 'orch'], 2, /rules remove takes <id>/],
    [['rules', 'list', '--hub'], 2, /does not take --hub/],
    [['rules', 'edit', 'r9', '--site', 'orch', '--by', 'claude', '--text', 'x'], 2, /does not take --by/],
  ];
  for (const [args, code, err] of bad) {
    const r = board(...args);
    assert.equal(r.code, code, args.join(' '));
    assert.match(r.err, err, args.join(' '));
  }
  assert.equal(read(site('orch', 'board.json')).rules, undefined);
  assert.equal(fs.existsSync(at('kickflip', 'settings.json')), false);
});

test("a builder's builder start takes up the record the owner's Build tap started: same kind and worktree, its own start time, and no longer dispatched", () => {
  const tapped = { label: 'Codex builder', kind: 'codex', started: '2026-11-03T10:00:00.000Z', dispatched: 'tap', worktree: { path: '/w/A1', branch: 'A1', repo: '/r' } };
  write(at('waves', 'w', 'agents', 'A1.json'), tapped);
  write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One', status: 'building' }] });
  const r = board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'build', '--label', 'Codex builder');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^A1: builder started\nkind: codex\. The owner's Build tap picked it\.\nmodel: Codex\nref: A1\nworktree: \/w\/A1\n/);
  const { started, ...record } = read(at('waves', 'w', 'agents', 'A1.json'));
  assert.deepEqual(record, { label: 'Codex builder', kind: 'codex', worktree: tapped.worktree });
  assert.ok(started > tapped.started);
  assert.equal(board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'build').code, 0);
  assert.equal(read(at('waves', 'w', 'agents', 'A1.json')).worktree, undefined);
});

// docs/adr/2026-11-05-0128-one-adapter-launches-claude-or-codex.md
test("a builder's start keeps the session id its launch recorded since the record last started or closed, and drops an older one", () => {
  const file = at('waves', 'w', 'agents', 'A1.json');
  const session = { id: 'sess-1', at: '2026-11-03T10:00:01.000Z' };
  write(file, { label: 'Builder', kind: 'claude', model: 'opus', started: '2026-11-03T10:00:00.000Z', dispatched: 'hub', session, worktree: { path: '/w/A1', branch: 'A1', repo: '/r' } });
  write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One', status: 'building' }] });
  assert.equal(board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'build').code, 0);
  assert.deepEqual(read(file).session, session, 'the agent taking up its launch keeps its session');
  // A lander launched on a closed record: its session was written after the close.
  const lander = { id: 'sess-2', at: '2026-11-03T12:00:01.000Z' };
  write(file, { ...read(file), done: '2026-11-03T12:00:00.000Z', session: lander });
  assert.equal(board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'build', '--label', 'Lander').code, 0);
  assert.deepEqual(read(file).session, lander);
  // A start with no launch since the record started belongs to no session the record knows.
  assert.equal(board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'build').code, 0);
  assert.equal(read(file).session, undefined);
});

test("builder start --dispatch opens the record before the agent launches, for build, prototype and grill, and the agent's own start takes it up", () => {
  write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One', status: 'todo' }, { id: 'A2', title: 'Two', status: 'todo' }] });
  const dispatched = board('--site', 'orch', 'builder', 'start', 'w/A1', '--dispatch', '--kind', 'build', '--model', 'sonnet', '--label', 'Sonnet builder');
  assert.equal(dispatched.code, 0, dispatched.err);
  const open = read(at('waves', 'w', 'agents', 'A1.json'));
  assert.equal(open.dispatched, 'session');
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].status, 'building');
  const taken = board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'build', '--label', 'Sonnet builder');
  assert.equal(taken.code, 0, taken.err);
  assert.match(taken.out, new RegExp(`kind: ${open.kind}\\. The session's dispatch picked it\\.`));
  const { started, ...record } = read(at('waves', 'w', 'agents', 'A1.json'));
  assert.deepEqual(record, { label: 'Sonnet builder', kind: open.kind, ...(open.model ? { model: open.model } : {}) });
  assert.ok(started >= open.started);
  for (const kind of ['prototype', 'grill']) {
    const r = board('--site', 'orch', 'builder', 'start', 'w/A2', '--dispatch', '--kind', kind, '--model', 'opus', '--label', `${kind} agent`);
    assert.equal(r.code, 0, r.err);
    assert.equal(read(at('waves', 'w', 'agents', 'A2.json')).dispatched, 'session');
    assert.equal(read(at('waves', 'w', 'wave.json')).items[1].status, 'todo');
    const own = board('--site', 'orch', 'builder', 'start', 'w/A2', '--kind', kind, '--label', `${kind} agent`);
    assert.equal(own.code, 0, own.err);
    const after = read(at('waves', 'w', 'agents', 'A2.json'));
    assert.equal(after.dispatched, undefined);
    assert.equal(after.kind, kind);
  }
});

test('--dispatch on a record whose worktree the dispatch made keeps it through the agent\'s start, and a record already done is not taken up', () => {
  write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One', status: 'building' }] });
  const wt = { path: '/w/A1', branch: 'A1', repo: '/r' };
  write(at('waves', 'w', 'agents', 'A1.json'), { label: 'Prototype', kind: 'claude', model: 'opus', started: '2026-11-03T10:00:00.000Z', dispatched: 'session', worktree: wt });
  assert.equal(board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'prototype').code, 0);
  assert.deepEqual(read(at('waves', 'w', 'agents', 'A1.json')).worktree, wt);
  write(at('waves', 'w', 'agents', 'A1.json'), { label: 'Old', kind: 'claude', started: '2026-11-03T10:00:00.000Z', dispatched: 'session', worktree: wt, done: '2026-11-03T11:00:00.000Z' });
  assert.equal(board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'prototype').code, 0);
  assert.equal(read(at('waves', 'w', 'agents', 'A1.json')).worktree, undefined);
});

test("--dispatch on a record the Build tap opened leaves it alone and says it's already open", () => {
  const tapped = { label: 'Builder', kind: 'codex', started: '2026-11-03T10:00:00.000Z', dispatched: 'tap', worktree: { path: '/w/A1', branch: 'A1', repo: '/r' } };
  write(at('waves', 'w', 'agents', 'A1.json'), tapped);
  write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One', status: 'building' }] });
  const r = board('--site', 'orch', 'builder', 'start', 'w/A1', '--dispatch', '--kind', 'build', '--worktree');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "A1: already open: the Implement tap opened its record; launch the agent, whose own builder start takes it up\n");
  assert.deepEqual(read(at('waves', 'w', 'agents', 'A1.json')), tapped);
});

test('builder start under another agent name refuses while the Build tap opened the main record and nobody took it up', () => {
  write(at('waves', 'w', 'agents', 'A1.json'), { label: 'Builder', kind: 'codex', started: '2026-11-03T10:00:00.000Z', dispatched: 'tap' });
  write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One', status: 'building' }] });
  const r = board('--site', 'orch', 'builder', 'start', 'w/A1', '--agent', 'bench', '--kind', 'bench');
  assert.equal(r.code, 1);
  assert.match(r.err, /the Implement tap opened w\/A1's main builder record and no agent has taken it up; run builder start w\/A1 without --agent first/);
  assert.equal(fs.existsSync(at('waves', 'w', 'agents', 'A1@bench.json')), false);
  assert.equal(board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'build').code, 0);
  assert.equal(board('--site', 'orch', 'builder', 'start', 'w/A1', '--agent', 'bench', '--kind', 'bench').code, 0);
});

test('starting a build clears the card\'s Next; a planner\'s start keeps it', () => {
  write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One', status: 'todo', next: 'Implement' }, { id: 'A2', title: 'Two', status: 'todo', next: 'Answer the questions' }] });
  assert.equal(board('--site', 'orch', 'builder', 'start', 'w/A2', '--kind', 'grill').code, 0);
  assert.equal(read(at('waves', 'w', 'wave.json')).items[1].next, 'Answer the questions');
  assert.equal(board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'claude').code, 0);
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].next, undefined);
});

test('builder progress refuses without an open builder record, as builder call does', () => {
  write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One', status: 'todo' }] });
  const none = board('--site', 'orch', 'builder', 'progress', 'w/A1', '--phase', 'reading', 'the notes');
  assert.equal(none.code, 1);
  assert.match(none.err, /builder progress needs an open builder record on w\/A1; run builder start first/);
  assert.equal(fs.existsSync(at('waves', 'w', 'agents', 'A1.json')), false);
  write(at('waves', 'w', 'agents', 'A1.json'), { label: 'Builder', started: '2026-11-03T10:00:00.000Z', done: '2026-11-03T11:00:00.000Z' });
  assert.match(board('--site', 'orch', 'builder', 'progress', 'w/A1', '--phase', 'reading', 'the notes').err, /needs an open builder record/);
  assert.equal(read(at('waves', 'w', 'agents', 'A1.json')).done, '2026-11-03T11:00:00.000Z');
});

test('builder start refuses a Claude pause before making records or a worktree, and runs while going or Off', () => {
  const until = new Date(Date.now() + 3600_000).toISOString();
  const usage = { at: new Date().toISOString(), five_hour: { used_percentage: 91, resets_at: until }, seven_day: { used_percentage: 96, resets_at: until } };
  write(at('kickflip', 'usage.json'), { claude: usage });
  const r = board('--site', 'orch', 'builder', 'start', 'w/A1', '--worktree');
  assert.equal(r.code, 1);
  assert.match(r.err, new RegExp(`Work is paused: Claude's 5-hour usage is at 91%. Resumes at ${until}. The owner can tap Keep going on the Hub page.`));
  assert.equal(fs.existsSync(at('waves', 'w', 'agents')), false);
  write(at('kickflip', 'settings.json'), { keepGoing: { window: 'five_hour', until } });
  assert.equal(board('--site', 'orch', 'builder', 'start', 'w/A1').code, 0);
  write(at('kickflip', 'settings.json'), { pauseAt: 100 });
  assert.equal(board('--site', 'orch', 'builder', 'start', 'w/A1', '--agent', 'two').code, 0);
  write(at('kickflip', 'settings.json'), {});
  write(at('kickflip', 'usage.json'), { claude: { ...usage, five_hour: { ...usage.five_hour, used_percentage: 40 } } });
  assert.match(board('--site', 'orch', 'builder', 'start', 'w/A1').err, /Claude's weekly usage is at 96%/);
});

test('settings set auto-build, auto-pull, auto-triage and auto-review default off, change on and off, and preserve all other board keys', () => {
  for (const name of ['auto-build', 'auto-pull', 'auto-triage', 'auto-review']) {
    const key = name.replace('-', '_');
    const cfg = read(site('orch', 'board.json'));
    assert.equal(JSON.parse(board('--site', 'orch', 'settings').out)[key], false);
    for (const value of ['on', 'off']) {
      assert.equal(board('--site', 'orch', 'settings', 'set', name, value).code, 0);
      assert.deepEqual(read(site('orch', 'board.json')), { ...cfg, [key]: value === 'on' });
    }
    assert.match(board('--site', 'orch', 'settings', 'set', name, 'yes').err, /takes on or off/);
  }
});

// docs/adr/2026-11-03-1731-each-board-reviews-incoming-prs-that-touch-its-work.md
test("review record writes the session's review of a listed incoming PR, keeping the PR's details after it leaves the list", () => {
  const pr = { number: 437, title: 'One endpoint', author: 'quinn', url: 'https://github.com/o/r/pull/437', head: 'abc', touches: ['w/A1'], asked: true };
  write(site('orch', 'data', 'incoming.json'), { at: 'x', repo: 'o/r', prs: [pr] });
  write(site('orch', 'data', 'reviews.json'), {});
  const held = board('--site', 'orch', 'review', 'record', '437', '--state', 'needs', '--text', 'Clashes with #47.');
  assert.deepEqual([held.code, held.out], [0, 'review of PR #437 recorded: needs you\n']);
  const { at: heldAt, ...rec } = read(site('orch', 'data', 'reviews.json'))['437'];
  assert.ok(Date.parse(heldAt));
  assert.deepEqual(rec, { ...pr, state: 'needs', text: 'Clashes with #47.' });
  write(site('orch', 'data', 'incoming.json'), { at: 'y', repo: 'o/r', prs: [] });
  write(path.join(home, 'review.md'), 'Posted.\n\n- one point');
  assert.equal(board('--site', 'orch', 'review', 'record', '437', '--state', 'posted', '--file', path.join(home, 'review.md')).out, 'review of PR #437 recorded: posted\n');
  assert.deepEqual([read(site('orch', 'data', 'reviews.json'))['437'].text, read(site('orch', 'data', 'reviews.json'))['437'].review_url, read(site('orch', 'data', 'reviews.json'))['437'].head], ['Posted.\n\n- one point', undefined, 'abc']);
  for (const [args, err] of [
    [['438', '--state', 'posted', '--text', 'x'], /not an incoming PR/],
    [['437', '--state', 'approved', '--text', 'x'], /--state posted or --state needs/],
    [['437', '--state', 'posted'], /--text or --file/],
    [['437', '--state', 'posted', '--text', 'x', '--url', 'https://github.com/o/r/pull/437#pullrequestreview-1'], /--url/],
    [['seven', '--state', 'posted', '--text', 'x'], /PR number/],
  ]) assert.match(board('--site', 'orch', 'review', 'record', ...args).err, err, args.join(' '));
});

// docs/adr/2026-11-05-0930-review-post-posts-an-incoming-pr-review.md
test("review post posts the session's words as one Comment review on a listed incoming PR at its head, then records it posted with the review's link", () => {
  const dir = path.join(home, 'fake-gh');
  const env = { PATH: `${fakeGh(dir)}:${process.env.PATH}` };
  writeAccounts(dir, { owner: 'token-owner' });
  write(at('kickflip', 'manifest.json'), { sites: { orch: { dir: site('orch'), port: 1, github: 'o/r', cmd: [process.execPath, '/skill/board/server.mjs', site('orch')] } } });
  const cli = (...args) => run('board.mjs', ['--site', 'orch', ...args], undefined, env);
  const pr = { number: 437, title: 'One endpoint', author: 'quinn', url: 'https://github.com/o/r/pull/437', head: 'abc', touches: ['w/A1'], asked: true };
  write(site('orch', 'data', 'incoming.json'), { at: 'x', repo: 'o/incoming', prs: [pr] });
  write(site('orch', 'data', 'reviews.json'), {});
  write(path.join(home, 'review.md'), 'One point: the retry loops.\n');
  const file = path.join(home, 'review.md');
  const posts = () => tokens(dir).filter((c) => c.args[0] === 'api' && c.args[1].endsWith('/reviews') && c.args.includes('-f')).map(({ args, token }) => [args.slice(1), token]);
  assert.equal(cli('settings', 'set', 'github-login', 'owner').code, 0);
  const title = JSON.parse(fs.readFileSync(site('orch', 'board.json'), 'utf8')).title;

  const done = cli('review', 'post', '437', '--file', file);
  assert.equal(done.code, 0, done.err);
  assert.equal(done.out, 'posted review on PR #437: https://github.com/o/incoming/pull/437#pullrequestreview-1\n');
  assert.deepEqual(posts(), [[['repos/o/incoming/pulls/437/reviews', '-f', `body=🤖 Claude review from the ${title} board\n\nOne point: the retry loops.\n\n<!-- claude-bridge -->`, '-f', 'event=COMMENT', '-f', 'commit_id=abc'], 'token-owner']]);
  const { at: postedAt, ...rec } = read(site('orch', 'data', 'reviews.json'))['437'];
  assert.ok(Date.parse(postedAt));
  assert.deepEqual(rec, { ...pr, state: 'posted', text: 'One point: the retry loops.', review_url: 'https://github.com/o/incoming/pull/437#pullrequestreview-1' });

  // Another review after --read-at is refused, nothing posted; one before it is not.
  writeReviews(dir, 437, [{ id: 5, user: { login: 'ann' }, submitted_at: '2026-11-05T10:00:00Z', body: '', state: 'COMMENTED' }]);
  const stale = cli('review', 'post', '437', '--file', file, '--read-at', '2026-11-05T09:00:00Z');
  assert.match(stale.err, /PR #437 got a review after 2026-11-05T09:00:00Z \(ann at 2026-11-05T10:00:00Z\)/);
  assert.equal(posts().length, 1);
  assert.equal(cli('review', 'post', '437', '--file', file, '--read-at', '2026-11-05T10:30:00Z').code, 0);
  assert.equal(posts().length, 2);

  for (const [name, words, err] of [
    ['robot', '🤖 Fine.', /adds the 🤖 header and the claude-bridge marker itself/],
    ['header', 'Claude review from me\n\nFine.', /adds the 🤖 header/],
    ['marker', 'Fine.\n<!-- claude-bridge -->', /adds the 🤖 header/],
  ]) {
    write(path.join(home, `${name}.md`), words);
    assert.match(cli('review', 'post', '437', '--file', path.join(home, `${name}.md`)).err, err, name);
  }
  assert.match(cli('review', 'post', '438', '--file', file).err, /not an incoming PR/);
  assert.match(cli('review', 'post', 'seven', '--file', file).err, /review post takes the PR number/);
  assert.match(cli('review', 'post', '437').err, /review post needs --file/);
  assert.match(cli('review', 'post', '437', '--file', file, '--read-at', 'noon').err, /--read-at takes the time/);
  assert.equal(posts().length, 2);
});

test('main set publishes an install with the same URL and sha checks as card installs', () => {
  for (const url of ['https://example.com/main.apk', 'itms-services://?action=download-manifest&url=https://m/main.plist']) {
    assert.equal(board('--site', 'orch', 'main', 'set', '--install', url, '--install-sha', 'ABCDEF1').code, 0);
    const { built_at, ...install } = read(site('orch', 'data', 'main.json')).install;
    assert.ok(Date.parse(built_at));
    assert.deepEqual(install, { url, sha: 'abcdef1' });
  }
  assert.equal(board('--site', 'orch', 'main', 'set', '--install', 'http://m/app.apk').code, 1);
  assert.equal(board('--site', 'orch', 'main', 'set', '--install', 'https://m/app.apk', '--install-sha', 'main').code, 1);
  assert.equal(board('--site', 'orch', 'main', 'set').code, 1);
  assert.equal(board('main', 'set', '--install', 'https://m/app.apk').code, 1);
});


test('github-login settings lines and API validation support set and clear', async () => {
  const { settingsOf, settingsLines, saveBoardSettings } = await import('./store.mjs');
  assert.deepEqual(settingsLines(settingsOf({ github_login: 'owner' })), ['setting auto-merge off', 'setting auto-build off', 'setting auto-pull off', 'setting max-implementers 10', 'setting max-planners 3', 'setting auto-triage off', 'setting auto-review off', 'setting idle-notification off', 'setting skip-draft off', 'setting prs on', 'setting github-login owner']);
  assert.ok(!('github_login' in settingsOf({ github_login: 'bad login' })));
  await saveBoardSettings(site('orch'), { github_login: 'owner' });
  await saveBoardSettings(site('orch'), { github_login: null });
  assert.ok(!('github_login' in read(site('orch', 'board.json'))));
});

test('item set records a UTC gh-since and pr prints the board report through gh', () => {
  const since = '2026-10-23T11:00:00Z';
  assert.equal(board('item', 'set', 'w/A1', '--gh-since', since).code, 0);
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].gh_since, since);
  for (const invalid of ['tomorrow', '2026-10-23', '2026-10-23T11:00:00+00:00', '2026-99-23T11:00:00Z']) {
    assert.match(board('item', 'set', 'w/A1', '--gh-since', invalid).err, /ISO-8601 UTC/);
  }
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].gh_since, since);
  const dir = path.join(home, 'fake-gh');
  const env = { PATH: `${fakeGh(dir)}:${process.env.PATH}` };
  writePR(dir, 7, prView());
  writeUser(dir, { login: 'owner' });
  writeIssueComments(dir, 7, [{ id: 1, user: { login: 'owner' }, created_at: '2026-10-23T12:00:00Z', body: 'Please fix', html_url: 'https://github.com/o/r/issues/7#issuecomment-1' }]);
  const pr = () => run('board.mjs', ['--site', 'orch', 'pr', 'w/A1'], undefined, env);
  assert.match(pr().err, /has no PR/);
  const w = read(at('waves', 'w', 'wave.json'));
  w.items[0].pr = 7;
  write(at('waves', 'w', 'wave.json'), w);
  assert.match(pr().err, /has no repo/);
  w.repo = 'wave/repo';
  write(at('waves', 'w', 'wave.json'), w);
  write(at('kickflip', 'manifest.json'), { sites: { orch: { dir: site('orch'), github: 'board/repo', cmd: [process.execPath, bin('../server.mjs')] } } });
  assert.equal(board('--site', 'orch', 'settings', 'set', 'github-login', 'owner').code, 0);
  const result = pr();
  assert.equal(result.code, 0, result.err);
  assert.equal(result.out.trim().split('\n').length, 1);
  assert.equal(JSON.parse(result.out).events[0].who, 'user');
  assert.equal(JSON.parse(result.out).pr, 7);
  assert.ok(calls(dir).some((a) => a[0] === 'pr' && a[4] === 'board/repo'));
  assert.ok(calls(dir).some((a) => a[3]?.endsWith(`comments?since=${encodeURIComponent(since)}`)));
  assert.ok(!calls(dir).some((a) => a[1] === 'user'));
  assert.equal(board('--site', 'orch', 'settings', 'set', 'github-login', '').code, 0);
  assert.equal(pr().code, 0);
  assert.equal(calls(dir).filter((a) => a[1] === 'user').length, 1);
  fs.rmSync(at('kickflip', 'manifest.json'));
  const fallback = pr();
  assert.equal(fallback.code, 0, fallback.err);
  assert.equal(calls(dir).filter((a) => a[0] === 'pr').at(-1)[4], 'wave/repo');
  writePR(dir, 'o/site#1', prView({ isDraft: true }));
  assert.equal(board('item', 'set', 'w/A1', '--pr', 'o/site#1').code, 0);
  const both = pr();
  assert.equal(both.code, 0, both.err);
  assert.deepEqual(both.out.trim().split('\n').map((l) => JSON.parse(l)).map((r) => [r.repo, r.pr, r.isDraft]), [['wave/repo', 7, false], ['o/site', 1, true]]);
});

function reviewProbe(source) {
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
const annReviewer = { name: 'Ann', slack_user: 'U1', dm: 'D1', github: 'ann' };
const bobReviewer = { name: 'Bob', slack_user: 'U2', dm: 'D2', github: 'bob' };

function reviewState() {
  return reviewProbe(`
    const wave = await store.readJSON(${JSON.stringify(at('waves', 'w', 'wave.json'))}, {});
    const prs = { 'o/r#7': { state: 'OPEN', isDraft: false } };
    const card = buildBoard({ waves: [{slug: 'w', wave}], prs, topicItems: topicItems() }).items[0];
    const board = { reviewers: ['Ann', 'Bob'], waves: [{slug: 'w', wave}], prs: [{wave: 'w', id: 'A1', pr: 7, repo: 'o/r'}] };
    console.log(JSON.stringify({ card, slack: linksOf(board, { github: {prs}, listen: 'listening', settings: { quiet: { start: '22:00', end: '08:00', hold: true } }, wakes: {}, faults: {} }).find((l) => l.link === 'slack') }));
  `);
}

test('review sent and the topic fallback drive the same card age, Stale lane and hub Slack link', () => {
  const sent = String(Math.floor((Date.now() - 8 * 86400000) / 1000)) + '.000100';
  const w = { ...wave(), repo: 'o/r', reviewers: [annReviewer, bobReviewer] };
  w.items[0].pr = 7;
  write(at('waves', 'w', 'wave.json'), w);
  write(at('slack-bridge', 'topics', 'one.json'), { items: { 'w/A1': { review_link_ts: { Ann: sent, Bob: sent } } } });
  const fallback = reviewState();
  assert.equal(fallback.card.review.Ann.state, 'sent');
  assert.equal(fallback.slack.ok, true);
  assert.equal(fallback.card.lane, 'stale');
  fs.rmSync(at('slack-bridge'), { recursive: true });
  assert.equal(board('review', 'sent', 'w/A1', 'Unknown', '--ts', sent, '--channel', 'D1', '--site', 'orch').code, 1);
  assert.equal(board('review', 'sent', 'w/A1', 'Ann', '--ts', sent, '--site', 'orch').code, 1);
  for (const r of w.reviewers) {
    const result = board('review', 'sent', 'w/A1', r.name, '--ts', sent, '--channel', r.dm, '--site', 'orch');
    assert.equal(result.code, 0, result.err);
  }
  assert.deepEqual(read(at('waves', 'w', 'wave.json')).items[0].review_link_ts.Ann, { ts: sent, channel: 'D1' });
  const recorded = reviewState();
  assert.deepEqual(recorded.card.review, fallback.card.review);
  assert.equal(recorded.card.inReviewSince, fallback.card.inReviewSince);
  assert.equal(recorded.card.lane, 'stale');
  assert.equal(recorded.slack.ok, true);
  for (let i = 0; i < 2; i++) assert.equal(board('review', 'react', 'w/A1', 'Ann', 'git_merged', '--site', 'orch').code, 0);
  assert.deepEqual(read(at('waves', 'w', 'wave.json')).items[0].review_link_ts.Ann.reactions, ['git_merged']);
  assert.equal(board('review', 'react', 'w/A1', 'Ann', 'bad emoji', '--site', 'orch').code, 1);
  assert.equal(board('review', 'react', 'w/A1', 'Nobody', 'git_merged', '--site', 'orch').code, 1);
  write(at('waves', 'w', 'wave.json'), w);
  assert.equal(board('review', 'react', 'w/A1', 'Ann', 'git_merged', '--site', 'orch').code, 1);
});

test('review sent accepts board reviewers on a file board and concurrent writes keep both links', async () => {
  write(site('audit', 'board.json'), { items: 'data/wave.json', slug: 'audit', reviewers: [annReviewer, bobReviewer] });
  const results = await Promise.all([annReviewer, bobReviewer].map((r) => runAsync('board.mjs', ['--site', 'audit', 'review', 'sent', 'audit/A1', r.name, '--ts', '1792800000.1', '--channel', r.dm])));
  for (const r of results) assert.equal(r.code, 0, r.err);
  assert.deepEqual(read(site('audit', 'data', 'wave.json')).items[0].review_link_ts, { Ann: { ts: '1792800000.1', channel: 'D1' }, Bob: { ts: '1792800000.1', channel: 'D2' } });
});

test('slack identity imports config once, protects the saved file and lets the session override it', () => {
  const config = { self_dm: 'DOLD', owner_slack_user: 'UOLD', slack_domain: 'old', timezone: 'America/Los_Angeles', ignored: 'secret' };
  write(at('slack-bridge', 'state.json'), { config });
  const expected = { self_dm: 'DOLD', owner_slack_user: 'UOLD', slack_domain: 'old', timezone: 'America/Los_Angeles' };
  assert.deepEqual(JSON.parse(board('slack').out), expected);
  assert.equal(fs.statSync(at('kickflip', 'slack.json')).mode & 0o777, 0o600);
  write(at('slack-bridge', 'state.json'), { config: { ...config, slack_domain: 'changed' } });
  assert.deepEqual(JSON.parse(board('slack').out), expected);
  const updated = board('slack', 'set', '--self-dm', 'DNEW', '--user', 'UNEW', '--domain', 'new', '--timezone', 'Asia/Tokyo');
  assert.equal(updated.code, 0, updated.err);
  assert.deepEqual(JSON.parse(updated.out), { self_dm: 'DNEW', owner_slack_user: 'UNEW', slack_domain: 'new', timezone: 'Asia/Tokyo' });
  assert.equal(board('slack', 'set', '--timezone', 'Not/AZone').code, 1);
  assert.equal(board('slack', 'set', '--self-dm', 'UWRONG').code, 1);
});

const slackToken = (extra = {}) => write(at('kickflip', 'secrets.json'), { slack: { token: 'xoxp-test-token', team: 'Acme', user: 'love', ...extra } });

function digestCommand(args, now) {
  const script = `import {main} from ${JSON.stringify(new URL('./bin/board.mjs', import.meta.url).href)};
    process.exitCode = await main(${JSON.stringify(['--site', 'orch', 'review', 'digest', ...args])}, {now: new Date(${JSON.stringify(now)})});`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return args.length ? r.stdout : JSON.parse(r.stdout);
}

test('review digest lists the hub-checked PRs awaiting review, dates old links and turns due off after a sent digest', () => {
  const now = '2026-11-02T17:00:00Z';
  slackToken();
  assert.equal(board('slack', 'set', '--timezone', 'America/Los_Angeles').code, 0);
  const ts = (hours) => String((Date.parse(now) - hours * 3600000) / 1000);
  write(site('orch', 'board.json'), { items: 'waves', reviewers: [bobReviewer] });
  const item = (id, pr, extra = {}) => ({ id, title: id, pr, ...extra });
  write(at('waves', 'w', 'wave.json'), { repo: 'o/r', reviewers: [annReviewer], items: [
    item('old', 1, { review_link_ts: { Ann: { ts: ts(73), channel: 'D1' } } }),
    item('edge', 2, { review_link_ts: { Ann: ts(48) } }),
    item('recent', 3, { review_sent: { Ann: ts(47) } }),
    item('approved', 4), item('draft', 5), item('closed', 6), item('unknown', 7), item('done', 10, { status: 'merged' }), item('ci', 13),
  ] });
  write(at('waves', 'empty', 'wave.json'), { reviewers: [{ name: 'Cy', slack_user: 'U3', dm: 'D3' }], items: [] });
  write(at('kickflip', 'github-state.json'), { prs: Object.fromEntries([1, 2, 3, 4, 5, 6, 10, 13].map((pr) => [`o/r#${pr}`, { state: pr === 6 ? 'CLOSED' : 'OPEN', isDraft: pr === 5, reviewDecision: pr === 4 ? 'APPROVED' : 'REVIEW_REQUIRED', ...(pr === 13 ? { failing: ['lint'] } : {}) }])) });
  const digest = digestCommand([], now);
  assert.deepEqual([digest.date, digest.due, digest.reviewers.map((r) => r.name)], ['2026-11-02', true, ['Bob', 'Ann']]);
  assert.deepEqual(digest.reviewers[0].items.map((i) => i.key), ['w/old', 'w/edge', 'w/recent']);
  const ann = digest.reviewers.find((r) => r.name === 'Ann');
  assert.deepEqual([ann.slack_user, ann.dm, ann.items.map((i) => i.key)], ['U1', 'D1', ['w/old', 'w/edge', 'w/recent']]);
  assert.deepEqual(ann.items[0], { key: 'w/old', title: 'old', pr: 1, url: 'https://github.com/o/r/pull/1', sent_ts: ts(73), days_old: 3 });
  for (const item of ann.items.slice(1)) assert.equal(Object.hasOwn(item, 'days_old'), false);
  assert.equal(digestCommand([], '2026-11-02T16:59:00Z').due, false);
  assert.equal(digestCommand([], '2026-11-01T17:00:00Z').due, false);
  assert.equal(digestCommand([], '2026-11-03T07:30:00Z').date, '2026-11-02');
  digestCommand(['sent', 'Ann', '--ts', ts(0), '--channel', 'D1', '--items', 'w/old,w/edge,w/recent'], now);
  assert.deepEqual(read(site('orch', 'data', 'review-digests.json')), { last_date: '2026-11-02', digests: [{ reviewer: 'Ann', dm: 'D1', ts: ts(0), items: ['w/old', 'w/edge', 'w/recent'], reactions: [] }] });
  assert.equal(digestCommand([], now).due, false);
  assert.equal(digestCommand([], '2026-11-03T17:00:00Z').due, true);
  const realClock = board('review', 'digest', '--site', 'orch');
  assert.equal(realClock.code, 0, realClock.err);
  assert.ok(Array.isArray(JSON.parse(realClock.out).reviewers));
});

test('review due lists the reviewer DMs, git_merged reactions and digest still owed, each with the command that records it, and waits while Slack is not ready', () => {
  const now = '2026-11-02T17:00:00Z';
  const due = () => {
    const script = `import {main} from ${JSON.stringify(new URL('./bin/board.mjs', import.meta.url).href)};
      process.exitCode = await main(['--site', 'orch', 'review', 'due'], {now: new Date('${now}')});`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  slackToken();
  assert.equal(board('slack', 'set', '--timezone', 'America/Los_Angeles').code, 0);
  write(at('waves', 'w', 'wave.json'), { repo: 'o/r', reviewers: [annReviewer, bobReviewer], items: [
    { id: 'A1', title: 'Open', pr: 1, review_link_ts: { Ann: { ts: '1.1', channel: 'D1' } } },
    { id: 'A2', title: 'Draft', pr: 2 },
    { id: 'A3', title: 'Merged', pr: 3, status: 'merged', review_link_ts: { Ann: { ts: '3.1', channel: 'D1', reactions: ['git_merged'] }, Bob: { ts: '3.2', channel: 'D2' } } },
    { id: 'A4', title: 'Done', pr: 4, status: 'done', review_link_ts: { Bob: { ts: '4.2', channel: 'D2' } } },
  ] });
  write(at('kickflip', 'github-state.json'), { prs: { 'o/r#1': { state: 'OPEN', isDraft: false }, 'o/r#2': { state: 'OPEN', isDraft: true }, 'o/r#3': { state: 'MERGED' } } });
  const owed = due();
  assert.deepEqual(owed.dms, [{ key: 'w/A1', reviewer: 'Bob', slack_user: 'U2', channel: 'D2', text: 'https://github.com/o/r/pull/1', record: 'board.mjs --site orch review sent w/A1 Bob --ts <ts> --channel D2' }]);
  assert.deepEqual(owed.reactions, [{ key: 'w/A3', reviewer: 'Bob', channel: 'D2', ts: '3.2', emoji: 'git_merged', record: 'board.mjs --site orch review react w/A3 Bob git_merged' }]);
  assert.deepEqual([owed.digest.due, owed.digest.reviewers.map((r) => r.name), owed.digest.record], [true, ['Ann', 'Bob'], 'board.mjs --site orch review digest sent <reviewer> --ts <ts> --channel <dm> --items <key,key>']);
  assert.equal(board('--site', 'orch', 'review', 'sent', 'w/A1', 'Bob', '--ts', '1.2', '--channel', 'D2').code, 0);
  assert.equal(board('--site', 'orch', 'review', 'react', 'w/A3', 'Bob', 'git_merged').code, 0);
  assert.deepEqual([due().dms, due().reactions], [[], []]);
  slackToken({ refused_at: '2026-11-02T00:00:00Z' });
  assert.deepEqual(due(), { waiting: 'Reviewer DMs and digests wait on Slack: Slack refused the token.', dms: [], reactions: [], digest: null });
});

test('review digest waits without changing the record while Slack is not ready', () => {
  const now = '2026-11-02T17:00:00Z';
  board('slack', 'set', '--timezone', 'America/Los_Angeles');
  const file = site('orch', 'data', 'review-digests.json');
  const record = { last_date: '2026-10-30', digests: [] };
  write(file, record);
  const digest = digestCommand([], now);
  assert.equal(digest.due, false);
  assert.equal(digest.waiting, 'Reviewer DMs and digests wait on Slack: No Slack token set.');
  assert.equal(digest.date, '2026-11-02');
  assert.deepEqual(digest.reviewers, []);
  assert.deepEqual(read(file), record);
  slackToken({ refused_at: '2026-11-02T00:00:00Z' });
  assert.match(digestCommand([], now).waiting, /Slack refused the token/);
  slackToken();
  assert.equal(digestCommand([], now).due, true);
  assert.deepEqual(read(file), record);
});

// docs/adr/2026-11-04-0238-a-wave-builds-in-phases.md
test('lineup create links each phase\'s cards to every card of the phase before and writes the wave note; add, remove, set and finish keep the phases and set --phase rewrites them; a wave topic takes triage questions, as a wave file\'s does on a board over ~/.claude/waves', () => {
  const file = site('audit', 'data', 'wave.json');
  write(file, { title: 'W', items: [{ id: 'A1', title: 'One' }, { id: 'A2', title: 'Two', deps: ['A9'] }, { id: 'A3', title: 'Three' }, { id: 'A4', title: 'Four' }, { id: 'A5', title: 'Five' }, { id: 'A9', title: 'Elsewhere' }] });
  const b = (...args) => board('--site', 'audit', 'lineup', ...args);
  const deps = () => Object.fromEntries(read(file).items.map((it) => [it.id, it.deps || []]));
  const made = b('create', 'mon', '--title', 'Monitor', '--goal', 'The monitor runs in kickflip.', '--phase', 'audit/A1,audit/A2', '--phase', 'audit/A3', '--note', 'Why: one PR each.');
  assert.equal(made.code, 0, made.err);
  assert.match(made.out, /order: A1, A2 → A3/);
  assert.deepEqual(deps(), { A1: [], A2: ['A9'], A3: ['A1', 'A2'], A4: [], A5: [], A9: [] });
  assert.deepEqual(read(file).lineups.map(({ created, ...l }) => l), [{ slug: 'mon', title: 'Monitor', goal: 'The monitor runs in kickflip.', phases: [['A1', 'A2'], ['A3']] }]);
  assert.equal(fs.readFileSync(site('audit', 'data', 'lineup-mon.md'), 'utf8'), 'Why: one PR each.\n');

  assert.match(b('create', 'mon', '--title', 'Again', '--goal', 'G', '--phase', 'audit/A4', '--note', 'N').err, /already has a wave "mon"/);
  assert.match(b('create', 'audit', '--title', 'File', '--goal', 'G', '--phase', 'audit/A4', '--note', 'N').err, /is a wave file/);
  assert.match(b('create', 'two', '--title', 'Two', '--goal', 'G', '--phase', 'audit/A3,audit/A4', '--note', 'N').err, /already in the wave "mon"/);
  assert.match(b('create', 'two', '--title', 'Two', '--goal', 'G', '--phase', 'audit/A4').err, /needs the wave note/);
  assert.match(b('create', 'two', '--title', 'Two', '--goal', 'G', '--note', 'N').err, /--phase takes/);
  assert.match(b('create', 'two', '--title', 'Two', '--goal', 'G', '--phase', 'audit/A4', '--phase', 'audit/A4', '--note', 'N').err, /names a card twice/);

  assert.equal(b('add', 'mon', 'audit/A4', '--after', 'audit/A2').code, 0);
  assert.deepEqual(read(file).lineups[0].phases, [['A1', 'A2'], ['A4'], ['A3']]);
  assert.deepEqual(deps(), { A1: [], A2: ['A9'], A3: ['A4'], A4: ['A1', 'A2'], A5: [], A9: [] });
  assert.equal(b('remove', 'mon', 'audit/A4').code, 0);
  assert.deepEqual(read(file).lineups[0].phases, [['A1', 'A2'], ['A3']]);
  assert.deepEqual(deps(), { A1: [], A2: ['A9'], A3: ['A1', 'A2'], A4: [], A5: [], A9: [] });
  assert.equal(b('remove', 'mon', 'audit/A1').code, 0);
  assert.deepEqual(deps(), { A1: [], A2: ['A9'], A3: ['A2'], A4: [], A5: [], A9: [] });
  assert.equal(b('add', 'mon', 'audit/A4').code, 0);
  assert.equal(b('set', 'mon', '--title', 'Monitor in kickflip', '--note', 'Why: smaller.').code, 0);
  assert.deepEqual(read(file).lineups[0].phases, [['A2'], ['A3'], ['A4']]);
  assert.equal(read(file).lineups[0].title, 'Monitor in kickflip');
  assert.equal(fs.readFileSync(site('audit', 'data', 'lineup-mon.md'), 'utf8'), 'Why: smaller.\n');
  const phased = b('set', 'mon', '--phase', 'audit/A3', '--phase', 'audit/A2,audit/A4');
  assert.equal(phased.code, 0, phased.err);
  assert.match(phased.out, /order: A3 → A2, A4/);
  assert.deepEqual(read(file).lineups[0].phases, [['A3'], ['A2', 'A4']]);
  assert.deepEqual(deps(), { A1: [], A2: ['A9', 'A3'], A3: [], A4: ['A3'], A5: [], A9: [] });
  assert.match(b('set', 'mon', '--phase', 'audit/A3,audit/A2').err, /--phase lists each of the wave's cards once/);
  assert.match(b('set', 'mon', '--phase', 'audit/A3', '--phase', 'audit/A2,audit/A4,audit/A2').err, /--phase lists each of the wave's cards once/);
  assert.match(b('set', 'mon', '--phase', 'audit/A3', '--phase', ',').err, /--phase takes/);

  // A wave made before phases keeps its chain; its first change writes it as one card per phase.
  const legacy = read(file);
  legacy.lineups.push({ slug: 'old', title: 'Old', goal: 'G', items: ['A5', 'A1'], created: '2026-11-01T00:00:00Z' });
  write(file, legacy);
  assert.equal(b('set', 'old', '--goal', 'Still a chain.').code, 0);
  assert.deepEqual(read(file).lineups[1].phases, [['A5'], ['A1']]);
  assert.equal(read(file).lineups[1].items, undefined);
  assert.deepEqual(deps().A1, ['A5']);

  const q = path.join(home, 'q.json');
  write(q, question('t1', { topic: 'lineup:mon' }));
  assert.equal(board('--site', 'audit', 'question', 'add', '--file', q).code, 0);
  write(q, question('t2', { topic: 'lineup:nope' }));
  assert.match(board('--site', 'audit', 'question', 'add', '--file', q).err, /no wave "nope"/);
  write(q, question('t3', { topic: 'wave:audit' }));
  assert.match(board('--site', 'audit', 'question', 'add', '--file', q).err, /board over ~\/\.claude\/waves/);
  write(q, question('t4', { topic: 'wave:w' }));
  assert.equal(board('--site', 'orch', 'question', 'add', '--file', q).code, 0);
  write(q, question('t5', { topic: 'wave:nope' }));
  assert.match(board('--site', 'orch', 'question', 'add', '--file', q).err, /no wave "nope"/);

  assert.equal(b('finish', 'mon').code, 0);
  assert.ok(read(file).lineups[0].finished_at);
  assert.match(b('add', 'mon', 'audit/A2').err, /is finished/);
});

test('a write that takes a card out of Todo clears its hold and pick-up time', () => {
  const nine = new Date(Date.now() + 864e5).toISOString();
  write(at('waves', 'd', 'wave.json'), { items: ['A1', 'A2', 'A3', 'A4', 'A5'].map((id) => ({ id, title: id, held: true, pick_up_at: nine })) });
  const items = () => read(at('waves', 'd', 'wave.json')).items;
  assert.equal(board('item', 'set', 'd/A1', '--status', 'dropped', '--site', 'orch', '--text', 'Dropped.').code, 0);
  assert.equal(board('item', 'set', 'd/A2', '--status', 'checking', '--site', 'orch', '--next', 'Review').code, 0);
  assert.equal(board('item', 'set', 'd/A3', '--pr', '7', '--site', 'orch').code, 0);
  assert.equal(board('item', 'set', 'd/A4', '--status', 'done', '--site', 'orch', '--text', 'Done.').code, 0);
  assert.deepEqual(items().slice(0, 4).map((it) => [it.held, it.pick_up_at]), Array(4).fill([undefined, undefined]));
  assert.deepEqual([items()[4].held, items()[4].pick_up_at], [true, nine]);
});

test("a Next set while the card has an open question clears once its questions are all acted on, and any Next clears once a build starts", () => {
  const item = (id) => read(at('waves', 'w', 'wave.json')).items.find((it) => it.id === id);
  const ownerFile = site('orch', 'data', 'owner.json');
  const ok = (...args) => { const r = board(...args, '--site', 'orch'); assert.equal(r.code, 0, r.err); return r; };
  ok('item', 'set', 'w/ENG-1', '--next', 'Merge when CI is green');
  ok('builder', 'start', 'w/ENG-1', '--kind', 'claude');
  assert.deepEqual([item('ENG-1').next, item('ENG-1').next_on_questions], [undefined, undefined]);

  write(ownerFile, { topics: [], items: [question('pick', { topic: 'item:w/A1' })] });
  ok('builder', 'start', 'w/A1', '--kind', 'claude');
  ok('builder', 'done', 'w/A1', '--next', 'Owner picks a tagline on #1');
  assert.equal(item('A1').next_on_questions, true);
  addEvents({ id: 'answer-pick', ts: new Date().toISOString(), kind: 'owner-answer', data: { id: 'pick', choice: 'A' } });
  assert.equal(item('A1').next, 'Owner picks a tagline on #1');
  ok('question', 'resolve', 'pick', '--note', 'Took A');
  assert.deepEqual([item('A1').next, item('A1').next_on_questions], [undefined, undefined]);

  write(ownerFile, { ...read(ownerFile), items: [...read(ownerFile).items, question('tone', { topic: 'item:w/A1' })] });
  ok('item', 'set', 'w/A1', '--next', 'Owner picks a tone');
  ok('builder', 'start', 'w/A1', '--agent', 'grill', '--kind', 'grill');
  assert.equal(item('A1').next, 'Owner picks a tone');
  ok('builder', 'start', 'w/A1', '--kind', 'claude');
  assert.deepEqual([item('A1').next, item('A1').next_on_questions], [undefined, undefined]);
});

// docs/adr/2026-11-03-1551-planners-and-implementers-are-two-kinds-of-agent.md
test('builder start saves a planner\'s model, Sonnet for a prototype and Opus for a grill by default, and its status lines are marked planner, read its kind\'s word and keep no builder phase', () => {
  const record = (agent) => read(at('waves', 'w', 'agents', agent === 'main' ? 'A1.json' : `A1@${agent}.json`));
  for (const [kind, model] of [['prototype', 'sonnet'], ['grill', 'opus']]) {
    const r = board('builder', 'start', 'w/A1', '--site', 'orch', '--agent', kind, '--kind', kind);
    assert.equal(r.code, 0, r.err);
    assert.equal(record(kind).model, model);
    assert.match(r.out, new RegExp(`^model: Claude ${model === 'opus' ? 'Opus' : 'Sonnet'}$`, 'm'));
  }
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch', '--agent', 'prototype', '--kind', 'prototype', '--model', 'opus').code, 0);
  assert.equal(record('prototype').model, 'opus');
  // A dispatched planner's model stays through the agent's own start.
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch', '--dispatch', '--kind', 'grill', '--model', 'sonnet').code, 0);
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch', '--kind', 'grill', '--phase', 'reading', '--progress', 'the notes').code, 0);
  assert.equal(record('main').model, 'sonnet');
  assert.equal(board('builder', 'progress', 'w/A1', '--site', 'orch', '--agent', 'prototype', '--phase', 'building', 'the takes').code, 0);
  // A planner needs no --phase.
  const bare = board('builder', 'progress', 'w/A1', '--site', 'orch', '--agent', 'prototype', 'take B');
  assert.equal(bare.code, 0, bare.err);
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch', '--agent', 'fix', '--kind', 'claude', '--phase', 'testing', '--progress', 'the fix').code, 0);
  assert.equal(board('builder', 'progress', 'w/A1', '--site', 'orch', '--agent', 'fix', 'no phase').code, 1);
  assert.deepEqual(lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).map(({ text, planner, phase }) => [text, planner, phase]), [
    ['Grilling: the notes', true, undefined], ['Prototyping: the takes', true, undefined], ['Prototyping: take B', true, undefined], ['Claude Opus testing: the fix', undefined, 'testing'],
  ]);
});

test('builder done on a record with judgment calls hands the card back as checking, with the Next its calls ask for', () => {
  const item = () => read(at('waves', 'w', 'wave.json')).items[0];
  const record = () => read(at('waves', 'w', 'agents', 'A1.json'));
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch', '--label', 'Builder').code, 0);
  assert.equal(board('builder', 'call', 'w/A1', '--site', 'orch', 'Kept the old label').code, 0);
  const refused = board('builder', 'done', 'w/A1', '--site', 'orch', '--next', 'Land it');
  assert.deepEqual([refused.code, refused.err], [1, "builder done sets w/A1's Next itself while its record has judgment calls; run it without --next\n"]);
  const done = board('builder', 'done', 'w/A1', '--site', 'orch');
  assert.equal(done.code, 0, done.err);
  assert.equal(done.out, "A1: builder done\nhanded back: checking, Next \"Verify the builder's judgment calls\"\n");
  assert.deepEqual([item().status, item().next, Boolean(record().done)], ['checking', "Verify the builder's judgment calls", true]);

  assert.equal(board('builder', 'verified', 'w/A1', '--site', 'orch').code, 0);
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch', '--label', 'Builder').code, 0);
  assert.equal(board('builder', 'call', 'w/A1', '--site', 'orch', 'Question: keep the old label?').code, 0);
  assert.equal(board('builder', 'call', 'w/A1', '--site', 'orch', 'Kept the old colour').code, 0);
  assert.equal(board('builder', 'done', 'w/A1', '--site', 'orch').code, 0);
  assert.deepEqual([item().status, item().next], ['checking', "Answer the builder's questions"]);
});

test('item set --status done refuses a done card the owner reopened with a message; it closes on their Done', () => {
  write(at('waves', 'w', 'wave.json'), { title: 'W', items: [{ id: 'A1', title: 'One', status: 'done', status_at: '2026-10-23T10:00:00Z' }] });
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--status', 'done', '--text', 'Still done.').code, 0);
  fs.appendFileSync(site('orch', 'data', 'events.jsonl'), JSON.stringify({ id: 'm1', ts: new Date(Date.now() + 1000).toISOString(), kind: 'item-message', data: { key: 'w/A1', text: 'One more thing' } }) + '\n');
  const closed = read(at('waves', 'w', 'wave.json')).items[0].status_at;
  const r = board('item', 'set', 'w/A1', '--site', 'orch', '--status', 'done', '--text', 'Answered.');
  assert.deepEqual([r.code, r.err], [1, "the owner reopened A1 with a message; it closes on the owner's Done\n"]);
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].status_at, closed);
});
