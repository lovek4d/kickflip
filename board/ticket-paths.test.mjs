// Every path that makes a card gets its ticket from resolveTicket in the board's source at that moment, and the cards
// filed before a source change keep theirs (docs/adr/2026-11-04-0227-every-new-card-gets-a-ticket-in-the-boards-current-source.md).
// GitHub and Linear are faked: an injected gh runner and fakeLinear in process, fake-gh.mjs and a served fakeLinear
// for the board server and the spawned CLI.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fakeLinear, freePorts, linearWorld, boardListening } from '../shared/test-helpers.mjs';
import { fakeGh } from '../shared/fake-gh.mjs';
import { REVIEW_SKILLS } from '../shared/skills.mjs';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-paths-')));
process.env.HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));
const { main } = await import('./bin/board.mjs');
const { saveBoardSettings } = await import('./store.mjs');

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const kickflip = path.join(home, '.claude', 'kickflip');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const world = linearWorld();
const linear = fakeLinear(world);
write(path.join(kickflip, 'secrets.json'), { linear: { key: world.key, workspace: 'Acme', url_key: 'acme', viewer: world.viewer } });

let issues = 0;
const run = async (cmd, argv) => {
  assert.equal(cmd, 'gh');
  const repo = argv[argv.indexOf('--repo') + 1];
  if (argv[1] === 'create') return { status: 0, stdout: `https://github.com/${repo}/issues/${++issues}\n` };
  return { status: 1, stderr: `no fake for gh ${argv.join(' ')}` };
};
const cli = (route, ...args) => main(['--site', route, ...args], { run, linearFetch: linear.fetch });

// The sources a board moves through, each with the pattern its new tickets take.
const SOURCES = [
  ['internal', { source: 'internal' }, /^INT-\d+$/],
  ['github', { source: 'github' }, /^#\d+$/],
  ['linear', { source: 'linear', workspace: 'acme', team: 'ENG', project: 'proj-audit' }, /^ENG-\d+$/],
];
const LINEAR = SOURCES[2][1];
const NEEDS_KEY = 'Linear needs Hub’s Linear key; add it in Hub settings › Linear first, or pick Internal or GitHub issues.';
const NO_KEY = 'Hub has no Linear key, so this board can’t create Linear tickets; add it in Hub settings › Linear, or pick another ticket source.';
const OLD = { id: 'OLD', title: 'Filed long ago', ticket: 'INT-1', lane: 'todo', lane_at: '2026-10-01T10:00:00.000Z' };

// A board at sites/<route> over data/items.json, on GitHub as o/<route>, holding one old card.
function board(route) {
  const site = path.join(kickflip, 'sites', route);
  write(path.join(site, 'board.json'), { title: route, items: 'data/items.json', slug: route });
  write(path.join(site, 'data', 'items.json'), { title: route, repo: `o/${route}`, items: [OLD] });
  write(path.join(site, 'data', 'owner.json'), { topics: [], items: [] });
  write(path.join(site, 'data', 'events.jsonl'), '');
  const manifest = fs.existsSync(path.join(kickflip, 'manifest.json')) ? read(path.join(kickflip, 'manifest.json')) : { sites: {} };
  manifest.sites[route] = { dir: site, cmd: ['node', path.join(here, 'server.mjs')], github: `o/${route}`, branch: 'main' };
  write(path.join(kickflip, 'manifest.json'), manifest);
  const items = () => read(path.join(site, 'data', 'items.json')).items;
  return { site, items, item: (id) => items().find((it) => it.id === id), ask: (id) => fs.appendFileSync(path.join(site, 'data', 'events.jsonl'), JSON.stringify({ id, ts: new Date().toISOString(), kind: 'ask', data: { text: `Ask ${id}` } }) + '\n') };
}
const quiet = (t) => { t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {}); };

test("item add gives a new card a ticket in the board's current source, named or not, and old cards keep theirs", async (t) => {
  quiet(t);
  const b = board('add');
  for (const [name, source, pattern] of SOURCES) {
    await saveBoardSettings(b.site, { tickets: source });
    assert.equal(await cli('add', 'item', 'add', `add/${name}`, '--phase', 'grilling', '--title', `On ${name}`), 0);
    assert.match(b.item(name).ticket, pattern);
    const count = b.items().length;
    assert.equal(await cli('add', 'item', 'add', 'add', '--phase', 'grilling', '--title', `Named on ${name}`), 0);
    const named = b.items().at(-1);
    assert.equal(b.items().length, count + 1);
    assert.match(named.ticket, pattern);
    assert.equal(named.id, named.ticket.replace(/^#/, 'GH-'));
  }
  assert.deepEqual(b.item('OLD'), OLD);
});

test("a follow-up, item add --parent, gets a ticket in the board's current source", async (t) => {
  quiet(t);
  const b = board('follow');
  for (const [name, source, pattern] of SOURCES) {
    await saveBoardSettings(b.site, { tickets: source });
    assert.equal(await cli('follow', 'item', 'add', `follow/${name}`, '--phase', 'grilling', '--title', `Later on ${name}`, '--parent', 'OLD'), 0);
    assert.deepEqual([b.item(name).parent, pattern.test(b.item(name).ticket)], ['follow/OLD', true]);
  }
  assert.deepEqual(b.item('OLD'), OLD);
});

test("item set --from-ask gives a card with no ticket one in the board's current source, and leaves a ticketed card's", async (t) => {
  quiet(t);
  const b = board('asked');
  for (const [name, source, pattern] of SOURCES) {
    await saveBoardSettings(b.site, { tickets: source });
    const wave = read(path.join(b.site, 'data', 'items.json'));
    write(path.join(b.site, 'data', 'items.json'), { ...wave, items: [...wave.items, { id: name, title: `Asked on ${name}` }] });
    b.ask(`e-${name}`);
    assert.equal(await cli('asked', 'item', 'set', `asked/${name}`, '--from-ask', `e-${name}`, '--phase', 'grilling', '--text', 'On it.'), 0);
    assert.match(b.item(name).ticket, pattern);
  }
  b.ask('e-old');
  assert.equal(await cli('asked', 'item', 'set', 'asked/OLD', '--from-ask', 'e-old', '--phase', 'grilling', '--text', 'On it.'), 0);
  assert.equal(b.item('OLD').ticket, 'INT-1');
});

test("ask move makes no card, and the card the moved ask becomes gets a ticket in the receiving board's current source", async (t) => {
  quiet(t);
  const from = board('origin');
  const to = board('target');
  await saveBoardSettings(from.site, { tickets: { source: 'internal', prefix: 'OPS' } });
  for (const [name, source, pattern] of SOURCES) {
    await saveBoardSettings(to.site, { tickets: source });
    from.ask(`m-${name}`);
    assert.equal(await cli('origin', 'ask', 'move', `m-${name}`, '--to', 'target'), 0);
    assert.deepEqual([from.items().length, to.items().length], [1, SOURCES.findIndex(([n]) => n === name) + 1]);
    const moved = fs.readFileSync(path.join(to.site, 'data', 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).at(-1);
    assert.equal(moved.data.from.id, `m-${name}`);
    assert.equal(await cli('target', 'item', 'add', `target/${name}`, '--phase', 'grilling', '--title', `Moved on ${name}`), 0);
    assert.equal(await cli('target', 'item', 'set', `target/${name}`, '--from-ask', moved.id, '--phase', 'grilling', '--text', 'On it.'), 0);
    assert.match(to.item(name).ticket, pattern);
  }
  assert.deepEqual([from.item('OLD'), to.item('OLD')], [OLD, OLD]);
});

test("the board server's Run review route and arch file give their cards tickets in the board's current source, after a change made through the server", async (t) => {
  const b = board('app');
  for (const name of REVIEW_SKILLS) write(path.join(home, '.claude', 'skills', name, 'SKILL.md'), `# ${name}\n`);
  const ghDir = path.join(home, 'gh');
  const served = await linear.serve();
  const env = { ...process.env, HOME: home, PATH: `${fakeGh(ghDir)}:${process.env.PATH}`, KICKFLIP_LINEAR_URL: served.url };
  const [port] = await freePorts();
  const child = spawn(process.execPath, [path.join(here, 'server.mjs'), b.site], { env: { ...env, PORT: String(port) } });
  t.after(async () => { child.kill(); await served.close(); });
  await boardListening(child);
  const post = async (p, body) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

  assert.equal((await post('/api/settings', { tickets: { source: 'github' } })).status, 200);
  const first = await post('/api/arch-review', {});
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.key, 'app/GH-1');
  assert.equal(b.item('GH-1').ticket, '#1');
  const waveFile = path.join(b.site, 'data', 'items.json');
  write(waveFile, { ...read(waveFile), items: read(waveFile).items.map((it) => (it.id === 'GH-1' ? { ...it, lane: 'done', lane_at: new Date().toISOString(), closed_at: new Date().toISOString() } : it)) });

  const keyFile = path.join(kickflip, 'secrets.json');
  const key = fs.readFileSync(keyFile, 'utf8');
  fs.rmSync(keyFile);
  assert.deepEqual(await post('/api/settings', { tickets: SOURCES[2][1] }), { status: 400, body: { error: NEEDS_KEY } });
  write(keyFile, key);
  assert.equal((await post('/api/settings', { tickets: SOURCES[2][1] })).status, 200);
  const second = await post('/api/arch-review', {});
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const audit = second.body.key.split('/')[1];
  assert.match(b.item(audit).ticket, /^ENG-\d+$/);
  write(path.join(b.site, 'data', 'owner.json'), { items: [{ id: 'f1', topic: `item:app/${audit}`, question: 'Split it?', options: [{ id: 'A', label: 'Split the store' }, { id: 'skip', label: 'Skip' }] }] });
  fs.appendFileSync(path.join(b.site, 'data', 'events.jsonl'), JSON.stringify({ id: 'answer-f1', ts: new Date().toISOString(), kind: 'owner-answer', data: { id: 'f1', choice: 'A', note: '' } }) + '\n');
  // Spawned, not spawnSync: this process serves the fake Linear the CLI calls.
  const filer = spawn(process.execPath, [path.join(here, 'bin', 'board.mjs'), '--site', 'app', 'arch', 'file', `app/${audit}`], { env });
  let stderr = '';
  filer.stderr.on('data', (d) => { stderr += d; });
  assert.equal(await new Promise((resolve) => filer.once('close', resolve)), 0, stderr);
  const finding = b.items().find((it) => it.title === 'Split the store');
  assert.match(finding.ticket, /^ENG-\d+$/);
  assert.equal(world.issues[finding.ticket].input.title, 'Split the store');
  assert.deepEqual(b.item('OLD'), OLD);
});

// Hub's key moved aside for one test: gone, or refused by Linear.
function withoutKey(t) {
  const keyFile = path.join(kickflip, 'secrets.json');
  const saved = fs.readFileSync(keyFile, 'utf8');
  t.after(() => write(keyFile, saved));
  return { remove: () => fs.rmSync(keyFile, { force: true }), refuse: () => write(keyFile, { linear: { ...JSON.parse(saved).linear, refused_at: '2026-11-04T00:00:00Z' } }), restore: () => write(keyFile, saved) };
}

test("Linear can't be picked as a board's ticket source while Hub has no working Linear key, by the store or the CLI", async (t) => {
  quiet(t);
  const b = board('gate');
  const key = withoutKey(t);
  const config = () => read(path.join(b.site, 'board.json'));
  const before = config();
  key.remove();
  await assert.rejects(async () => saveBoardSettings(b.site, { tickets: LINEAR }), { message: NEEDS_KEY });
  assert.equal(await cli('gate', 'settings', 'set', 'tickets', JSON.stringify(LINEAR)), 1);
  key.refuse();
  await assert.rejects(async () => saveBoardSettings(b.site, { tickets: LINEAR }), { message: NEEDS_KEY });
  assert.deepEqual(config(), before);
  key.restore();
  await saveBoardSettings(b.site, { tickets: LINEAR });
  assert.deepEqual(config().tickets, LINEAR);
});

test('a card on a board still on Linear after its key went is refused, never left without a ticket', async (t) => {
  quiet(t);
  const b = board('stale');
  const key = withoutKey(t);
  await saveBoardSettings(b.site, { tickets: LINEAR });
  key.remove();
  const waveFile = path.join(b.site, 'data', 'items.json');
  const before = fs.readFileSync(waveFile, 'utf8');
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  assert.equal(await cli('stale', 'item', 'add', 'stale/X', '--phase', 'grilling', '--title', 'X'), 1);
  assert.equal(await cli('stale', 'item', 'add', 'stale', '--phase', 'grilling', '--title', 'Y'), 1);
  assert.deepEqual(errors, [NO_KEY, NO_KEY]);
  assert.equal(fs.readFileSync(waveFile, 'utf8'), before);
});

test('once Hub has no Linear key, every board on Linear falls back to internal tickets: its old cards keep theirs and its new cards get INT ones', async (t) => {
  quiet(t);
  const { fallBackFromLinear } = await import('./store.mjs');
  const key = withoutKey(t);
  const onLinear = board('was-linear');
  const onGithub = board('on-github');
  await saveBoardSettings(onLinear.site, { tickets: LINEAR });
  await saveBoardSettings(onGithub.site, { tickets: { source: 'github' } });
  assert.equal(await cli('was-linear', 'item', 'add', 'was-linear/L1', '--phase', 'grilling', '--title', 'On Linear'), 0);
  const filed = onLinear.item('L1');
  assert.match(filed.ticket, /^ENG-\d+$/);
  assert.deepEqual(await fallBackFromLinear(), []);
  key.remove();
  const moved = await fallBackFromLinear();
  assert.ok(moved.includes('/was-linear fell back to internal tickets: Hub has no Linear key'), moved.join('\n'));
  assert.ok(!moved.some((line) => line.startsWith('/on-github ')));
  const told = fs.readFileSync(path.join(onLinear.site, 'data', 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).at(-1);
  assert.deepEqual([told.kind, told.data], ['settings', { tickets: { source: 'internal', prefix: 'INT' } }]);
  assert.deepEqual(read(path.join(onLinear.site, 'board.json')).tickets, { source: 'internal', prefix: 'INT' });
  assert.deepEqual(read(path.join(onGithub.site, 'board.json')).tickets, { source: 'github' });
  assert.deepEqual([onLinear.item('OLD'), onLinear.item('L1')], [OLD, filed]);
  assert.equal(await cli('was-linear', 'item', 'add', 'was-linear/I1', '--phase', 'grilling', '--title', 'After'), 0);
  assert.equal(onLinear.item('I1').ticket, 'INT-2');
  assert.deepEqual(await fallBackFromLinear(), []);
});

// The guard: every write that adds a card to a wave file is listed here with how it gets its ticket. A new one fails
// this test until it is listed, and the listed card-makers must reach resolveTicket through assignTicket.
const SOURCE_DIRS = ['board', 'hub', 'bin', 'shared', 'scripts'];
const ADDS = [
  /\bitems\.(push|unshift|splice)\(/, /\bitems:\s*\[\s*\.\.\./, /\.items\s*=\s*\[/, /\bitems\.concat\(/,
];
const KNOWN = {
  'board/store.mjs createItem': 'a new card: assignTicket',
  'board/store.mjs migrateFollowups': "old follow-ups moved into cards, keeping the tickets they had",
  'board/store.mjs askNotNew': 'a list of the cards an ask became, read only',
  'board/store.mjs reviewDigest': "a reviewer's list of PRs",
  'board/store.mjs publishQuestions': "owner.json's questions",
  'board/store.mjs settleQuestion': "owner.json's questions: a screened one, settled",
  'board/store.mjs restoreArchived': 'an archived card and its questions back, with the ticket they had',
  'board/domain.mjs buildBoard': 'the board view, read only',
  'board/server.mjs thread': "an archived card's questions read beside owner.json's, read only",
  'board/server.mjs withArchived': 'archived cards read beside their wave files to build a Done page, read only',
  'board/server.mjs snapshot': "archived cards' questions read beside owner.json's to build a Done page, read only",
  'bin/doctor.mjs doctorReport': "doctor's report rows",
  'hub/push.mjs deliver': 'the push queue',
  'hub/push.mjs flushQueue': 'the push queue',
};
// The shipped modules: test files, and the test-only modules package.json leaves out of the package, are skipped.
function sources() {
  const testOnly = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).files.filter((f) => f.startsWith('!') && !f.includes('*')).map((f) => f.slice(1));
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) { if (!['public', 'node_modules'].includes(e.name)) walk(rel); } else if (e.name.endsWith('.mjs') && !e.name.endsWith('.test.mjs') && !testOnly.includes(rel)) files.push(rel);
    }
  };
  SOURCE_DIRS.filter((d) => fs.existsSync(path.join(root, d))).forEach(walk);
  return files;
}
// The top-level function or const a line sits in.
const TOP = /^(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|(?:const|let)\s+(\w+)\s*=)/;
const enclosing = (lines, i) => { for (let j = i; j >= 0; j--) { const m = TOP.exec(lines[j]); if (m) return m[1] || m[2]; } return '(top)'; };
const bodyOf = (text, name) => {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => TOP.exec(l)?.slice(1).includes(name));
  const end = lines.findIndex((l, i) => i > start && TOP.test(l));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
};

test('every write that adds to an items list is a known one, and the ones that make cards get their ticket from resolveTicket through assignTicket', () => {
  const found = {};
  const callers = { resolveTicket: new Set(), assignTicket: new Set() };
  for (const file of sources()) {
    const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (ADDS.some((re) => re.test(line))) found[`${file} ${enclosing(lines, i)}`] = KNOWN[`${file} ${enclosing(lines, i)}`] ?? `unlisted, at line ${i + 1}: ${line.trim()}`;
      for (const name of Object.keys(callers)) if (new RegExp(`\\b${name}\\(`).test(line) && !TOP.test(line)) callers[name].add(`${file} ${enclosing(lines, i)}`);
    });
  }
  assert.deepEqual(found, KNOWN, 'a new write adds to an items list: if it makes a card, give it its ticket through assignTicket (store.mjs), then list it in KNOWN');
  assert.deepEqual([...callers.resolveTicket], ['board/store.mjs assignTicket']);
  assert.deepEqual([...callers.assignTicket].sort(), ['board/store.mjs backfill', 'board/store.mjs changeItem', 'board/store.mjs createItem']);
  const create = bodyOf(fs.readFileSync(path.join(root, 'board/store.mjs'), 'utf8'), 'createItem');
  assert.ok(create.indexOf('assignTicket(') >= 0 && create.indexOf('assignTicket(') < create.indexOf('itemFile.items.push('), 'createItem assigns the ticket before it adds the card');
});
