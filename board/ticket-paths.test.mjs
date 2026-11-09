// Every new card is a task: no ticket, keyed T-<n>, until its grill's ticket question, the orchestrator's --new-ticket or
// --ticket <id> gives it one, and that ticket comes from the board's source at that moment
// (docs/adr/2026-11-09-1500-a-task-is-a-card-with-no-ticket-keyed-t-n.md). GitHub and Linear are faked: an injected gh
// runner and fakeLinear in process, fake-gh.mjs for the board server.
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
const created = [];
const run = async (cmd, argv) => {
  assert.equal(cmd, 'gh');
  const repo = argv[argv.indexOf('--repo') + 1];
  if (argv[1] === 'create') { created.push({ title: argv[argv.indexOf('--title') + 1], body: argv[argv.indexOf('--body') + 1] }); return { status: 0, stdout: `https://github.com/${repo}/issues/${++issues}\n` }; }
  if (argv[1] === 'view') return { status: 0, stdout: JSON.stringify({ number: Number(argv[2]), url: `https://github.com/${repo}/issues/${argv[2]}` }) };
  return { status: 1, stderr: `no fake for gh ${argv.join(' ')}` };
};
const cli = (route, ...args) => main(['--site', route, ...args], { run, linearFetch: linear.fetch });

// The sources a board moves through, each with the pattern a ticket it makes takes; none makes none.
const SOURCES = [
  ['none', { source: 'none' }, null],
  ['github', { source: 'github' }, /^#\d+$/],
  ['linear', { source: 'linear', workspace: 'acme', team: 'ENG', project: 'proj-audit' }, /^ENG-\d+$/],
];
const LINEAR = SOURCES[2][1];
const NEEDS_KEY = 'Linear needs Hub’s Linear key; add it in Hub settings › Linear first, or pick GitHub issues or None.';
const NO_KEY = 'Hub has no Linear key, so this board can’t create Linear tickets; add it in Hub settings › Linear, or pick another ticket source.';
const NO_SOURCE = 'this board has no ticket source, so its cards stay tasks; pick GitHub issues or Linear in Board settings first';
const OLD = { id: 'INT-1', title: 'Filed long ago', ticket: 'INT-1', lane: 'todo', lane_at: '2026-10-01T10:00:00.000Z' };

// A board at sites/<route> over data/items.json, on GitHub as o/<route>, holding one old card with an Internal ticket.
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
const errorsOf = (t) => { const errors = []; t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', (...args) => errors.push(args.join(' '))); return errors; };

test('item add files every new card as a task keyed T-<n> with no ticket, on every source, and old cards keep theirs', async (t) => {
  quiet(t);
  const b = board('add');
  for (const [name, source] of SOURCES) {
    await saveBoardSettings(b.site, { tickets: source });
    assert.equal(await cli('add', 'item', 'add', `add/${name}`, '--phase', 'grilling', '--title', `On ${name}`), 0);
    assert.equal(b.item(name).ticket, undefined);
    assert.equal(await cli('add', 'item', 'add', 'add', '--phase', 'grilling', '--title', `Unnamed on ${name}`), 0);
  }
  assert.deepEqual(b.items().filter((it) => it.id.startsWith('T-')).map((it) => [it.id, it.ticket]), [['T-1', undefined], ['T-2', undefined], ['T-3', undefined]]);
  assert.equal(created.length, 0);
  assert.deepEqual(b.item('INT-1'), OLD);
});

test('T-<n> counts every wave and the Done archive, so a key is never reused', async (t) => {
  quiet(t);
  const b = board('count');
  write(path.join(b.site, 'data', 'done-archive.json'), { cards: [{ key: 'count/T-7', file: 'count', item: { id: 'T-7', title: 'Archived', lane: 'done' } }] });
  write(path.join(b.site, 'board.json'), { ...read(path.join(b.site, 'board.json')), items: 'waves' });
  const waves = path.join(home, '.claude', 'waves');
  t.after(() => fs.rmSync(waves, { recursive: true, force: true }));
  write(path.join(waves, 'one', 'wave.json'), { title: 'One', items: [{ id: 'T-4', title: 'Four' }] });
  write(path.join(waves, 'two', 'wave.json'), { title: 'Two', items: [] });
  assert.equal(await cli('count', 'item', 'add', 'two', '--phase', 'grilling', '--title', 'Next'), 0);
  assert.equal(read(path.join(waves, 'two', 'wave.json')).items[0].id, 'T-8');
});

test('item add --ticket links a ticket up front and names the card from it; --new-ticket makes one from the title and notes', async (t) => {
  quiet(t);
  const b = board('linked');
  await saveBoardSettings(b.site, { tickets: { source: 'github' } });
  assert.equal(await cli('linked', 'item', 'add', 'linked', '--phase', 'grilling', '--title', 'Linked', '--ticket', '#41'), 0);
  assert.equal(b.item('GH-41').ticket, '#41');
  const before = created.length;
  assert.equal(await cli('linked', 'item', 'add', 'linked', '--phase', 'grilling', '--title', 'Made', '--notes', 'Lands code.', '--new-ticket'), 0);
  const made = b.items().at(-1);
  assert.deepEqual([made.id, made.ticket, made.ticket_created], [made.ticket.replace('#', 'GH-'), made.ticket, true]);
  assert.deepEqual(created.slice(before), [{ title: 'Made', body: 'Lands code.' }]);
  assert.equal(await cli('linked', 'item', 'add', 'linked', '--phase', 'grilling', '--title', 'Both', '--ticket', '#5', '--new-ticket'), 1);
});

test('item set --new-ticket gives a task a ticket in the source, keeping its key; refused on a card with one, and on a board with none', async (t) => {
  const errors = errorsOf(t);
  const b = board('later');
  assert.equal(await cli('later', 'item', 'add', 'later', '--phase', 'grilling', '--title', 'Task'), 0);
  assert.equal(await cli('later', 'item', 'set', 'later/T-1', '--new-ticket'), 1);
  assert.equal(errors.at(-1), NO_SOURCE);
  assert.equal(await cli('later', 'item', 'add', 'later', '--phase', 'grilling', '--title', 'Linked', '--ticket', 'ENG-3'), 1);
  assert.equal(errors.at(-1), NO_SOURCE);
  await saveBoardSettings(b.site, { tickets: LINEAR });
  assert.equal(await cli('later', 'item', 'set', 'later/T-1', '--new-ticket'), 0);
  assert.match(b.item('T-1').ticket, /^ENG-\d+$/);
  assert.equal(world.issues[b.item('T-1').ticket].input.title, 'Task');
  assert.equal(await cli('later', 'item', 'set', 'later/T-1', '--new-ticket'), 1);
  assert.match(errors.at(-1), /already has ticket ENG-\d+/);
});

test('a follow-up, item add --parent, is a task too', async (t) => {
  quiet(t);
  const b = board('follow');
  await saveBoardSettings(b.site, { tickets: { source: 'github' } });
  assert.equal(await cli('follow', 'item', 'add', 'follow', '--phase', 'grilling', '--title', 'Later', '--parent', 'INT-1'), 0);
  assert.deepEqual([b.item('T-1').parent, b.item('T-1').ticket], ['follow/INT-1', undefined]);
});

test('item set --from-ask leaves a task without a ticket, and a ticketed card with its own', async (t) => {
  quiet(t);
  const b = board('asked');
  await saveBoardSettings(b.site, { tickets: { source: 'github' } });
  const wave = read(path.join(b.site, 'data', 'items.json'));
  write(path.join(b.site, 'data', 'items.json'), { ...wave, items: [...wave.items, { id: 'A', title: 'Asked' }] });
  b.ask('e-a');
  assert.equal(await cli('asked', 'item', 'set', 'asked/A', '--from-ask', 'e-a', '--phase', 'grilling', '--text', 'On it.'), 0);
  assert.equal(b.item('A').ticket, undefined);
  b.ask('e-old');
  assert.equal(await cli('asked', 'item', 'set', 'asked/INT-1', '--from-ask', 'e-old', '--phase', 'grilling', '--text', 'On it.'), 0);
  assert.equal(b.item('INT-1').ticket, 'INT-1');
});

test("the board server's Run review route and arch file file their cards as tasks", async (t) => {
  quiet(t);
  const b = board('app');
  for (const name of REVIEW_SKILLS) write(path.join(home, '.claude', 'skills', name, 'SKILL.md'), `# ${name}\n`);
  const env = { ...process.env, HOME: home, PATH: `${fakeGh(path.join(home, 'gh'))}:${process.env.PATH}` };
  const [port] = await freePorts();
  const child = spawn(process.execPath, [path.join(here, 'server.mjs'), b.site], { env: { ...env, PORT: String(port) } });
  t.after(() => child.kill());
  await boardListening(child);
  const post = async (p, body) => { const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };

  assert.equal((await post('/api/settings', { tickets: { source: 'github' } })).status, 200);
  const review = await post('/api/arch-review', {});
  assert.equal(review.status, 200, JSON.stringify(review.body));
  assert.equal(review.body.key, 'app/T-1');
  assert.equal(b.item('T-1').ticket, undefined);
  write(path.join(b.site, 'data', 'owner.json'), { items: [{ id: 'f1', topic: 'item:app/T-1', question: 'Split it?', options: [{ id: 'A', label: 'Split the store' }, { id: 'skip', label: 'Skip' }] }] });
  fs.appendFileSync(path.join(b.site, 'data', 'events.jsonl'), JSON.stringify({ id: 'answer-f1', ts: new Date().toISOString(), kind: 'owner-answer', data: { id: 'f1', choice: 'A', note: '' } }) + '\n');
  assert.equal(await cli('app', 'arch', 'file', 'app/T-1'), 0);
  const finding = b.items().find((it) => it.title === 'Split the store');
  assert.deepEqual([finding.id, finding.ticket], ['T-2', undefined]);
  assert.deepEqual(b.item('INT-1'), OLD);
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

test('the Internal source is retired: settings refuse it, and a board.json still holding it reads as no source', async (t) => {
  quiet(t);
  const b = board('retired');
  await assert.rejects(async () => saveBoardSettings(b.site, { tickets: { source: 'internal', prefix: 'OPS' } }), { message: 'Ticket source must be none, github or linear.' });
  write(path.join(b.site, 'board.json'), { ...read(path.join(b.site, 'board.json')), tickets: { source: 'internal', prefix: 'OPS' } });
  const { readBoardSettings } = await import('./store.mjs');
  assert.equal((await readBoardSettings(b.site)).tickets, undefined);
  assert.equal(await cli('retired', 'item', 'add', 'retired', '--phase', 'grilling', '--title', 'A task'), 0);
  assert.equal(b.item('T-1').ticket, undefined);
  await saveBoardSettings(b.site, { tickets: { source: 'github' } });
  await saveBoardSettings(b.site, { tickets: { source: 'none' } });
  assert.equal(Object.hasOwn(read(path.join(b.site, 'board.json')), 'tickets'), false);
});

test("a ticket a board on Linear can't make after its key went is refused and writes nothing, while its tasks still file", async (t) => {
  const errors = errorsOf(t);
  const b = board('stale');
  const key = withoutKey(t);
  await saveBoardSettings(b.site, { tickets: LINEAR });
  key.remove();
  const waveFile = path.join(b.site, 'data', 'items.json');
  const before = fs.readFileSync(waveFile, 'utf8');
  assert.equal(await cli('stale', 'item', 'add', 'stale/X', '--phase', 'grilling', '--title', 'X', '--new-ticket'), 1);
  assert.deepEqual(errors, [NO_KEY]);
  assert.equal(fs.readFileSync(waveFile, 'utf8'), before);
  assert.equal(await cli('stale', 'item', 'add', 'stale', '--phase', 'grilling', '--title', 'Y'), 0);
  assert.equal(b.item('T-1').ticket, undefined);
});

test('once Hub has no Linear key, every board on Linear falls back to no ticket source, and its old cards keep their tickets', async (t) => {
  quiet(t);
  const { fallBackFromLinear } = await import('./store.mjs');
  const key = withoutKey(t);
  const onLinear = board('was-linear');
  const onGithub = board('on-github');
  await saveBoardSettings(onLinear.site, { tickets: LINEAR });
  await saveBoardSettings(onGithub.site, { tickets: { source: 'github' } });
  assert.equal(await cli('was-linear', 'item', 'add', 'was-linear/L1', '--phase', 'grilling', '--title', 'On Linear', '--new-ticket'), 0);
  const filed = onLinear.item('L1');
  assert.match(filed.ticket, /^ENG-\d+$/);
  assert.deepEqual(await fallBackFromLinear(), []);
  key.remove();
  const moved = await fallBackFromLinear();
  assert.ok(moved.includes('/was-linear fell back to no ticket source: Hub has no Linear key'), moved.join('\n'));
  assert.ok(!moved.some((line) => line.startsWith('/on-github ')));
  const told = fs.readFileSync(path.join(onLinear.site, 'data', 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).at(-1);
  assert.deepEqual([told.kind, told.data], ['settings', { tickets: null }]);
  assert.equal(Object.hasOwn(read(path.join(onLinear.site, 'board.json')), 'tickets'), false);
  assert.deepEqual(read(path.join(onGithub.site, 'board.json')).tickets, { source: 'github' });
  assert.deepEqual([onLinear.item('INT-1'), onLinear.item('L1')], [OLD, filed]);
  assert.deepEqual(await fallBackFromLinear(), []);
});

// The guard: every write that adds a card to a wave file is listed here with how it gets its key. A new one fails this
// test until it is listed; a ticket is made or linked only through assignTicket, the one caller of resolveTicket.
const SOURCE_DIRS = ['board', 'hub', 'bin', 'shared', 'scripts'];
const ADDS = [
  /\bitems\.(push|unshift|splice)\(/, /\bitems:\s*\[\s*\.\.\./, /\.items\s*=\s*\[/, /\bitems\.concat\(/,
];
const KNOWN = {
  'board/store.mjs createItem': 'a new card: a T-<n> task, or named from the ticket assignTicket links or makes',
  'board/store.mjs migrateFollowups': "old follow-ups moved into cards, keeping the tickets they had",
  'board/store.mjs askNotNew': 'a list of the cards an ask became, read only',
  'board/store.mjs changeWave': "a wave's list of card ids, which makes no card",
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

test('every write that adds to an items list is a known one, and a ticket comes from resolveTicket only through assignTicket', () => {
  const found = {};
  const callers = { resolveTicket: new Set(), assignTicket: new Set() };
  for (const file of sources()) {
    const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (ADDS.some((re) => re.test(line))) found[`${file} ${enclosing(lines, i)}`] = KNOWN[`${file} ${enclosing(lines, i)}`] ?? `unlisted, at line ${i + 1}: ${line.trim()}`;
      for (const name of Object.keys(callers)) if (new RegExp(`\\b${name}\\(`).test(line) && !TOP.test(line)) callers[name].add(`${file} ${enclosing(lines, i)}`);
    });
  }
  assert.deepEqual(found, KNOWN, 'a new write adds to an items list: if it makes a card, key it as createItem does (store.mjs), then list it in KNOWN');
  assert.deepEqual([...callers.resolveTicket], ['board/store.mjs assignTicket']);
  assert.deepEqual([...callers.assignTicket].sort(), ['board/store.mjs changeItem', 'board/store.mjs createItem']);
  const create = bodyOf(fs.readFileSync(path.join(root, 'board/store.mjs'), 'utf8'), 'createItem');
  assert.ok(create.indexOf('assignTicket(') >= 0 && create.indexOf('assignTicket(') < create.indexOf('itemFile.items.push('), 'createItem links or makes the ticket before it adds the card');
  assert.ok(create.indexOf('nextTaskId(') >= 0 && create.indexOf('nextTaskId(') < create.indexOf('itemFile.items.push('), 'createItem keys a task before it adds the card');
});
