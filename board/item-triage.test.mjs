// docs/adr/2026-11-15-0730-a-new-task-is-triaged-in-one-command-before-it-is-investigated.md: item triage is the
// orchestrator's first move on a new task, from what it knows of the board, and the intake wait names the cards the
// task likely relates to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildBoard, orchestratorWaits, relatedCandidates } from './domain.mjs';
import { board, home, site, read, write, lines } from './board-fixture.mjs';

const audit = (...p) => site('audit', ...p);
const auditEvents = (...events) => fs.appendFileSync(audit('data', 'events.jsonl'), events.map((e) => JSON.stringify(e) + '\n').join(''));
const ask = (id, text = 'Fix the header\nIt jumps on scroll', data = {}) => ({ id, ts: '2026-11-15T07:00:00Z', kind: 'ask', data: { text, ...data } });
async function fileAsk(id) {
  process.env.HOME = home;
  const store = await import('./store.mjs');
  return store.fileAsk(audit(), id);
}
const item = (id) => read(audit('data', 'items.json')).items.find((i) => i.id === id);
const messages = (id) => (!fs.existsSync(audit('data', 'threads', `audit__${id}.jsonl`)) ? [] : lines(audit('data', 'threads', `audit__${id}.jsonl`))).filter((m) => !m.kind && !m.command).map((m) => m.text);

test('item triage sorts a New task in one call: its title, phase, links and ticket, and and nothing in its thread', async () => {
  auditEvents(ask('a1'));
  const key = await fileAsk('a1');
  const r = await board('item', 'triage', key, '--title', 'fix(board): the header jumps on scroll', '--phase', 'discussing', '--relate', 'A1', '--blocked-by', 'ENG-1', '--site', 'audit');
  assert.deepEqual([r.code, r.err], [0, '']);
  assert.match(r.out, /T-1: triaged discussing/);
  const t = item('T-1');
  assert.deepEqual([t.title, t.phase, t.related, t.deps, t.triaged.phase], ['fix(board): the header jumps on scroll', 'discussing', ['audit/A1'], ['ENG-1'], 'discussing']);
  assert.ok(t.sorted_at, 'the New strip reads it ingested');
  assert.deepEqual(messages('T-1'), [], 'the owner\'s message is alone in the thread');
  assert.match((await board('item', 'triage', key, '--title', 'fix: x', '--phase', 'grilling', '--text', 'hello', '--site', 'audit')).err, /sorted/);
  // Sorted, it reads as a task, and nothing waits on its intake.
  const b = buildBoard({ now: Date.parse('2026-11-15T07:01:00Z'), events: [ask('a1')], files: [{ slug: 'audit', agents: {}, itemFile: read(audit('data', 'items.json')) }], prs: {}, owner: {} });
  const card = b.items.find((i) => i.key === key);
  assert.deepEqual([Boolean(card.isNew), card.phase], [false, 'discussing']);
  assert.equal(orchestratorWaits(b).some((w) => w.kind === 'intake'), false);
  // A sorted task has nothing left to triage.
  assert.match((await board('item', 'triage', key, '--title', 'fix: x', '--phase', 'grilling', '--site', 'audit')).err, /audit\/T-1 is sorted \(discussing\)/);
});

test('item triage needs a title and a phase it can give, and --fold-into goes alone', async () => {
  auditEvents(ask('a1'));
  const key = await fileAsk('a1');
  assert.match((await board('item', 'triage', key, '--phase', 'discussing', '--site', 'audit')).err, /needs --title/);
  assert.match((await board('item', 'triage', key, '--title', 'fix: x', '--site', 'audit')).err, /needs --title/);
  assert.match((await board('item', 'triage', key, '--title', 'fix: x', '--phase', 'ready', '--site', 'audit')).err, /--phase takes discussing, grilling, prototyping, visual; ready follows the investigation/);
  assert.match((await board('item', 'triage', key, '--fold-into', 'audit/A1', '--phase', 'discussing', '--site', 'audit')).err, /--fold-into .* takes only --text/);
  assert.deepEqual([item('T-1').phase, fs.existsSync(audit('data', 'threads', 'audit__T-1.jsonl'))], [undefined, false], 'a refusal writes nothing');
});

test('item triage --phase visual sorts the task discussing for the visual\'s brief, and grilling leaves it to arrive for its grill', async () => {
  auditEvents(ask('a1'), ask('a2', 'Try a darker header'));
  const k1 = await fileAsk('a1');
  const k2 = await fileAsk('a2');
  assert.equal((await board('item', 'triage', k1, '--title', 'feat(board): sketch the header', '--phase', 'visual', '--site', 'audit')).code, 0);
  assert.deepEqual([item('T-1').phase, messages('T-1')], ['discussing', []]);
  assert.equal((await board('item', 'triage', k2, '--title', 'feat(board): a darker header', '--phase', 'grilling', '--site', 'audit')).code, 0);
  assert.deepEqual([item('T-2').phase, messages('T-2')], ['grilling', []]);
});

test('item triage --parent --split sets the Parent and copies its gates', async () => {
  const items = read(audit('data', 'items.json'));
  items.items.find((i) => i.id === 'A1').gates = { prototype: 'Take B' };
  write(audit('data', 'items.json'), items);
  auditEvents(ask('a1'));
  const key = await fileAsk('a1');
  assert.equal((await board('item', 'triage', key, '--title', 'feat(board): the header half', '--phase', 'discussing', '--parent', 'A1', '--split', '--site', 'audit')).code, 0);
  assert.deepEqual([item('T-1').parent, item('T-1').gates], ['audit/A1', { prototype: 'Take B' }]);
  assert.deepEqual(messages('T-1'), []);
});

test('item triage --fold-into merges a duplicate New task into the other task, with a line on both', async () => {
  auditEvents(ask('a1'));
  const key = await fileAsk('a1');
  const r = await board('item', 'triage', key, '--fold-into', 'audit/A1', '--text', 'same as the header work', '--site', 'audit');
  assert.deepEqual([r.code, r.err], [0, '']);
  assert.equal(item('T-1'), undefined);
  assert.deepEqual(read(audit('data', 'ask-links.json')), { links: { a1: 'audit/A1' } });
  assert.deepEqual(lines(audit('data', 'threads', 'ask__a1.jsonl')).map((m) => [m.line, m.into]), [['card-merged', 'audit/A1']]);
  assert.deepEqual(messages('A1'), ['Triaged: folded in T-1 "Fix the header"; same as the header work']);
});

test('a Quick build ask triaged discussing still goes ready on item set once investigated, as its filing', async () => {
  auditEvents(ask('a1', 'Pin the header', { quick: true }));
  const key = await fileAsk('a1');
  assert.equal((await board('item', 'triage', key, '--title', 'fix(board): pin the header', '--phase', 'discussing', '--site', 'audit')).code, 0);
  const notes = path.join(home, 'n.md');
  fs.writeFileSync(notes, 'Pin the header with position sticky.');
  assert.equal((await board('item', 'notes', key, '--heading', 'Scope', '--file', notes, '--site', 'audit')).code, 0);
  const r = await board('item', 'set', key, '--phase', 'ready', '--size', 'small', '--site', 'audit');
  assert.deepEqual([r.code, r.err], [0, '']);
  assert.equal(item('T-1').phase, 'ready');
});

const card = (key, title, extra = {}) => ({ kind: 'work', key, title, lane: 'todo', ...extra });
test('the related candidates are open cards sharing two significant title words, or the scope, most shared first, at most five', () => {
  const it = card('w/T-9', 'Fix the header jumping on scroll');
  const items = [
    it,
    card('w/T-1', 'feat(board): the header stays pinned on scroll'),
    card('w/T-2', 'fix(hub): header colours'),
    card('w/T-3', 'fix(board): headers jump while scrolling', { lane: 'done' }),
    card('w/T-4', 'fix(board): a header that jumps on scroll'),
    card('w/T-5', 'fix(board): the header jumps on scroll', { unsorted: true }),
  ];
  assert.deepEqual(relatedCandidates(items, it).map((c) => c.key), ['w/T-4', 'w/T-1']);
  const scoped = card('w/T-10', 'feat(hub): a new integration');
  assert.deepEqual(relatedCandidates([...items, scoped], scoped).map((c) => c.key), ['w/T-2']);
  const many = Array.from({ length: 7 }, (_, n) => card(`w/M${n}`, `the header jumps ${n}`));
  assert.equal(relatedCandidates([it, ...many], it).length, 5);
});

test("a New task's intake wait asks for item triage first, then investigation, and names its likely related cards", () => {
  const b = buildBoard({
    now: Date.parse('2026-11-15T07:01:00Z'), events: [ask('a1')], prs: {}, owner: {},
    files: [{ slug: 'w', agents: {}, itemFile: { items: [
      { id: 'T-1', title: 'Fix the header jumping on scroll', created: '2026-11-15T07:00:01Z', lane: 'todo', from_ask: 'a1' },
      { id: 'T-2', title: 'feat(board): the header stays pinned on scroll', lane: 'todo', phase: 'discussing' },
    ] } }],
  });
  const wait = orchestratorWaits(b).find((w) => w.kind === 'intake');
  assert.equal(wait.key, 'w/T-1');
  assert.match(wait.next, /^Triage the new task first, from what you know of the board, reading no code: item triage w\/T-1 --title "<type>\(<scope>\): <summary>" --phase discussing\|grilling\|prototyping\|visual .*--fold-into <task> for a duplicate\. Then investigate/);
  assert.match(wait.next, /Likely related \(check them, don't hunt\): w\/T-2 "feat\(board\): the header stays pinned on scroll"\.$/);
});

const investigate = (key = 'audit/T-1') => {
  process.env.HOME = home;
  const b = buildBoard({ now: Date.now(), events: [ask('a1')], files: [{ slug: 'audit', agents: {}, itemFile: read(audit('data', 'items.json')) }], threads: { 'audit/T-1': fs.existsSync(audit('data', 'threads', 'audit__T-1.jsonl')) ? lines(audit('data', 'threads', 'audit__T-1.jsonl')) : [] }, prs: {}, owner: {} });
  return orchestratorWaits(b).find((w) => w.kind === 'investigate' && w.key === key);
};
const triage = async (phase = 'discussing') => {
  auditEvents(ask('a1'));
  const key = await fileAsk('a1');
  assert.equal((await board('item', 'triage', key, '--title', 'fix(board): the header jumps on scroll', '--phase', phase, '--site', 'audit')).code, 0);
  return key;
};

// docs/adr/2026-11-15-1030-a-triaged-task-owes-an-investigate-wait-until-its-notes-are-written.md
test('a triaged task owes an investigate wait that item notes ends', async () => {
  const key = await triage();
  assert.match(investigate(key).next, /^Investigate audit\/T-1: write its notes \(item notes\), then reply$/);
  const notes = path.join(home, 'n.md');
  fs.writeFileSync(notes, 'The header is sticky.');
  assert.equal((await board('item', 'notes', key, '--heading', 'Scope', '--file', notes, '--site', 'audit')).code, 0);
  assert.equal(investigate(key), undefined);
});

test('a reply in the thread ends the investigate wait, the Triaged line does not', async () => {
  const key = await triage();
  assert.ok(investigate(key));
  assert.equal((await board('reply', key, '--site', 'audit', '--text', 'It is the sticky header.')).code, 0);
  assert.equal(investigate(key), undefined);
});

test('a fold owes no investigate wait, and a task sorted past its triage phase owes none', async () => {
  auditEvents(ask('a1'));
  const key = await fileAsk('a1');
  assert.equal((await board('item', 'triage', key, '--fold-into', 'audit/A1', '--site', 'audit')).code, 0);
  assert.equal(investigate(key), undefined);
  auditEvents(ask('a2'));
  const k2 = await fileAsk('a2');
  assert.equal((await board('item', 'triage', k2, '--title', 'fix(board): x y', '--phase', 'discussing', '--site', 'audit')).code, 0);
  assert.ok(investigate(k2));
  assert.equal((await board('item', 'set', k2, '--phase', 'grilling', '--site', 'audit')).code, 0);
  assert.equal(investigate(k2), undefined);
});

test('item triage --text is refused unless it folds, and the refusal writes nothing', async () => {
  auditEvents(ask('a1'));
  const key = await fileAsk('a1');
  assert.match((await board('item', 'triage', key, '--title', 'fix: x', '--phase', 'grilling', '--text', 'hello', '--site', 'audit')).err, /--text goes only with --fold-into/);
  assert.deepEqual([item('T-1').phase, fs.existsSync(audit('data', 'threads', 'audit__T-1.jsonl'))], [undefined, false]);
});
