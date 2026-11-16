// docs/adr/2026-11-16-1700-a-filed-task-links-where-it-came-from-and-the-tasks-it-names.md: a task carries the links the
// card shows (Parent, Related to, Blocked by, Blocks), one flag each; one the orchestrator files names where it came
// from, and every task its words name is linked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { site, home, lines, read, write, board, run } from './board-fixture.mjs';

const items = () => read(site('audit', 'data', 'items.json')).items;
const item = (id) => items().find((it) => it.id === id);
const thread = (id) => (fs.existsSync(site('audit', 'data', 'threads', `audit__${id}.jsonl`)) ? lines(site('audit', 'data', 'threads', `audit__${id}.jsonl`)) : []);
const named = (id, command, other) => thread(id).some((m) => m.command === command && m.card === other);
const asks = () => (fs.existsSync(site('audit', 'data', 'events.jsonl')) ? lines(site('audit', 'data', 'events.jsonl')).filter((e) => e.kind === 'ask') : []);
const ask = (...args) => board('item', 'add', 'audit', '--site', 'audit', '--ask', ...args);
const own = (...args) => board('item', 'add', 'audit', '--site', 'audit', '--title', 'feat: mine', '--phase', 'grilling', ...args);
const card = (id, extra = {}) => {
  const file = site('audit', 'data', 'items.json');
  write(file, { ...read(file), items: [...read(file).items, { id, title: `feat: ${id}`, lane: 'todo', phase: 'grilling', ...extra }] });
};
const born = () => items().find((it) => it.from_ask === asks().at(-1).id);

test('item add --ask takes the four links the card shows: --parent, --relate, --blocked-by and --blocks', async () => {
  card('T-2'); card('T-3');
  const r = await ask('Cache the board config', '--parent', 'A1', '--relate', 'T-2', '--blocked-by', 'T-2', '--blocks', 'T-3');
  assert.equal(r.code, 0, r.err);
  const t = born();
  assert.deepEqual([t.parent, t.related, t.deps], ['audit/A1', ['audit/T-2'], ['T-2']]);
  assert.ok(item('T-3').deps.includes(t.id));
  // A task filed with a Parent is born from it: Created from in its thread, Created ticket in the Parent's.
  assert.ok(named(t.id, 'created-from', 'audit/A1') && named('A1', 'created', `audit/${t.id}`));
  assert.ok(named(t.id, 'blocked-by', 'audit/T-2') && named(t.id, 'unblocks', 'audit/T-3'));
});

test('item add --ask --parent --split copies the Parent\'s gates; --split goes only with --parent', async () => {
  card('G1', { gates: { prototype: 'no' } });
  assert.equal((await ask('Split off the header', '--parent', 'G1', '--split', '--by', 'builder')).code, 0);
  assert.deepEqual([born().parent, born().gates], ['audit/G1', { prototype: 'no' }]);
  const lone = await ask('Split off the footer', '--relate', 'G1', '--split');
  assert.notEqual(lone.code, 0);
  assert.match(lone.err, /--split copies the Parent's gates, so it goes with --parent <the task split>/);
});

test('a task the orchestrator files names where it came from: --ask and --title refuse one with no --parent or --relate', async () => {
  const before = items().length;
  const r = await ask('Cache the board config');
  assert.notEqual(r.code, 0);
  assert.match(r.err, /a task you file names where it came from: pass --parent <the task it came from> or --relate <the tasks it touches>/);
  const direct = await own('--notes', 'Notes.');
  assert.notEqual(direct.code, 0);
  assert.match(direct.err, /a task you file names where it came from: pass --relate <the tasks it touches>/);
  assert.deepEqual([asks().length, items().length], [0, before]);
  // --blocked-by and --blocks order it; they don't say where it came from.
  assert.match((await ask('Cache it', '--blocked-by', 'A1')).err, /names where it came from/);
  assert.equal((await own('--notes', 'Notes.', '--relate', 'A1')).code, 0);
});

test("the owner's own tasks need no link: an ask through New, its --from-ask filing, and an imported ticket", async () => {
  const events = site('audit', 'data', 'events.jsonl');
  fs.appendFileSync(events, JSON.stringify({ id: 'o1', ts: '2026-11-16T09:00:00Z', kind: 'ask', data: { text: 'Fix the header' } }) + '\n');
  const filed = await board('item', 'add', 'audit/T-7', '--site', 'audit', '--title', 'fix: the header', '--phase', 'discussing', '--from-ask', 'o1', '--text', 'On it');
  assert.equal(filed.code, 0, filed.err);
  const imported = await board('item', 'add', 'audit/T-8', '--site', 'audit', '--title', 'feat: imported', '--phase', 'grilling', '--ticket', 'T-8', '--notes', 'N.');
  assert.doesNotMatch(imported.err, /names where it came from/);
});

test('a request or notes naming a task must link it; the refusal names each one and --relate', async () => {
  card('T-2'); card('T-3', { ticket: '#43' });
  const r = await ask('Like T-2 and #43, cache the config', '--parent', 'A1');
  assert.notEqual(r.code, 0);
  assert.match(r.err, /names T-2 \(audit\/T-2\) and #43 \(audit\/T-3\) without linking them: add --relate audit\/T-2,audit\/T-3, or link each as --parent, --blocked-by or --blocks/);
  assert.equal(asks().length, 0);
  // Any link counts, and a name in quotes is the owner's words, which name nothing for you to link.
  assert.equal((await ask('Like T-2 and audit/T-3, after "the T-9 thing"', '--parent', 'A1', '--blocked-by', 'T-2', '--relate', 'T-3')).code, 0);
  const notes = path.join(home, 'draft.md');
  fs.writeFileSync(notes, '# feat: mine\n\nFound while building ENG-1.\n');
  assert.match((await own('--notes-from', notes, '--relate', 'A1')).err, /names ENG-1 \(audit\/ENG-1\) without linking it: add --relate audit\/ENG-1/);
  assert.equal((await own('--notes-from', notes, '--relate', 'A1,ENG-1')).code, 0);
});

test('item notes on a task links the tasks a new section names as Related, with a line in both threads', async () => {
  card('T-2'); card('T-3'); card('T-4', { parent: 'A1' });
  const draft = path.join(home, 'more.md');
  fs.writeFileSync(draft, 'Overlaps T-2 and its child T-4; "see T-3" is the owner\'s.\n');
  const r = await board('item', 'notes', 'audit/A1', '--site', 'audit', '--heading', 'Found', '--file', draft);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /related: audit\/T-2/);
  assert.deepEqual(item('A1').related, ['audit/T-2']);
  assert.ok(named('A1', 'related', 'audit/T-2') && named('T-2', 'related', 'audit/A1'));
  assert.ok(!named('A1', 'related', 'audit/T-4'), 'its child is linked already');
});

test('item set and item triage take --blocked-by, and triage --parent with --split; the old flags are refused naming the new', async () => {
  assert.equal((await board('item', 'set', 'audit/A1', '--site', 'audit', '--blocked-by', 'ENG-1')).code, 0);
  assert.deepEqual(item('A1').deps, ['ENG-1']);
  card('G1', { gates: { prototype: 'no' } });
  fs.appendFileSync(site('audit', 'data', 'events.jsonl'), JSON.stringify({ id: 'a1', ts: '2026-11-16T09:00:00Z', kind: 'ask', data: { text: 'Split the header' } }) + '\n');
  process.env.HOME = home;
  const key = await (await import('./store.mjs')).fileAsk(site('audit'), 'a1');
  const t = await board('item', 'triage', key, '--site', 'audit', '--title', 'feat(board): the header half', '--phase', 'discussing', '--parent', 'G1', '--split', '--blocked-by', 'A1');
  assert.equal(t.code, 0, t.err);
  assert.deepEqual([item(key.split('/')[1]).parent, item(key.split('/')[1]).gates, item(key.split('/')[1]).deps], ['audit/G1', { prototype: 'no' }, ['A1']]);
  for (const [args, said] of [
    [['item', 'add', 'audit', '--ask', 'x', '--from', 'A1'], /--from is now --parent/],
    [['item', 'add', 'audit', '--ask', 'x', '--split-of', 'A1'], /--split-of is now --parent <task> --split/],
    [['item', 'add', 'audit', '--ask', 'x', '--after', 'A1'], /--after is now --blocked-by/],
    [['item', 'add', 'audit', '--ask', 'x', '--before', 'A1'], /--before is now --blocks/],
    [['item', 'set', 'audit/A1', '--deps', 'A1'], /--deps is now --blocked-by/],
  ]) {
    const r = run('board.mjs', ['--site', 'audit', ...args]);
    assert.notEqual(r.code, 0, args.join(' '));
    assert.match(r.err, said);
  }
});
