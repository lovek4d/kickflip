import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { site, lines, board, read, write } from './board-fixture.mjs';

// docs/adr/2026-11-06-1130-linking-two-cards-posts-a-keyed-line-in-both-threads.md
const thread = (id) => (fs.existsSync(site('audit', 'data', 'threads', `audit__${id}.jsonl`)) ? lines(site('audit', 'data', 'threads', `audit__${id}.jsonl`)).map(({ ts, ...m }) => m) : []);
const set = async (id, ...args) => assert.equal((await board('item', 'set', `audit/${id}`, '--site', 'audit', ...args)).code, 0, args.join(' '));
// docs/adr/2026-11-16-0900-a-card-in-new-takes-no-writes-until-it-is-triaged.md: an agent-added card is sorted by item triage.
const triage = async (id) => assert.equal((await board('item', 'triage', `audit/${id}`, '--site', 'audit', '--title', 'feat: child', '--phase', 'grilling')).code, 0);
const add = async (id, ...args) => assert.equal((await board('item', 'add', `audit/${id}`, '--site', 'audit', '--title', `feat: ${id.toLowerCase()}`, '--phase', 'grilling', ...args)).code, 0, args.join(' '));
// A card for the links to point at, written as it stands, so its thread starts empty.
const card = (id) => {
  const file = site('audit', 'data', 'items.json');
  write(file, { ...read(file), items: [...read(file).items, { id, title: `feat: ${id.toLowerCase()}`, lane: 'todo', phase: 'grilling' }] });
};
const line = (command, card) => ({ who: 'claude', text: { related: 'Related to', unrelated: 'Unrelated from', followup: 'Follow-up', 'followup-of': 'Follow-up of', created: 'Created ticket', 'created-from': 'Created from', 'blocked-by': 'Blocked by', unblocks: 'Unblocks' }[command], command, card });

test('a new link posts a keyed line naming the other card in both threads, once; an unlink posts an Unrelated line in both', async () => {
  card('L1');
  await add('L2', '--relate', 'L1');
  assert.deepEqual(thread('L2'), [line('related', 'audit/L1')]);
  assert.deepEqual(thread('L1'), [line('related', 'audit/L2')]);
  // Re-relating a linked card posts nothing; a new one in the list posts for that link alone.
  card('L3');
  await set('L2', '--relate', 'L1');
  await set('L2', '--related', 'L1,L3');
  assert.deepEqual(thread('L2').map((m) => m.card), ['audit/L1', 'audit/L3']);
  assert.deepEqual(thread('L3'), [line('related', 'audit/L2')]);
  assert.equal(thread('L1').length, 1);
  // A --related list leaving a card out unrelates it; --unrelate does the same.
  await set('L2', '--related', 'L3');
  assert.deepEqual(thread('L1').at(-1), line('unrelated', 'audit/L2'));
  assert.deepEqual(thread('L2').at(-1), line('unrelated', 'audit/L1'));
  await set('L2', '--unrelate', 'L3');
  assert.deepEqual(thread('L3').at(-1), line('unrelated', 'audit/L2'));
  assert.deepEqual(thread('L2').at(-1), line('unrelated', 'audit/L3'));
});

// docs/adr/2026-11-16-1100-a-task-the-orchestrator-files-comes-in-as-an-ask-through-new.md: a task filed from another
// comes in as an ask, born with its Parent. → the key's id.
const askFrom = async (...args) => {
  const r = await board('item', 'add', 'audit', '--site', 'audit', '--ask', 'A follow-up', ...args);
  assert.equal(r.code, 0, r.err);
  return /added as audit\/(T-\d+)/.exec(r.out)[1];
};

// docs/adr/2026-11-16-1700-a-filed-task-links-where-it-came-from-and-the-tasks-it-names.md
test('item add --ask --parent sets the Parent and posts Created ticket in the source and Created from in the new card, once', async () => {
  card('S1');
  const child = await askFrom('--parent', 'S1');
  assert.deepEqual(thread('S1'), [line('created', `audit/${child}`)]);
  assert.deepEqual(thread(child), [line('created-from', 'audit/S1')]);
  await triage(child);
  await set(child, '--parent', 'S1');
  assert.equal(thread('S1').length, 1);
  assert.equal(thread(child).length, 1);
});

test('a Parent set on a task that exists posts Follow-up in the parent and Follow-up of in the child, once', async () => {
  card('P1'); card('P2');
  await set('P2', '--parent', 'P1');
  assert.deepEqual(thread('P1'), [line('followup', 'audit/P2')]);
  assert.deepEqual(thread('P2'), [line('followup-of', 'audit/P1')]);
  await set('P2', '--parent', 'P1');
  assert.equal(thread('P1').length, 1);
});

test('item add --blocks blocks the other task on the new one, --blocked-by makes the new one wait, each with a line in both threads', async () => {
  const deps = (id) => JSON.parse(fs.readFileSync(site('audit', 'data', 'items.json'), 'utf8')).items.find((it) => it.id === id)?.deps;
  const order = (id) => thread(id).filter((m) => ['blocked-by', 'unblocks'].includes(m.command));
  card('B1');
  await add('B2', '--blocks', 'B1', '--relate', 'A1');
  assert.deepEqual(deps('B1'), ['B2']);
  assert.equal(deps('B2'), undefined);
  assert.deepEqual(order('B2'), [line('unblocks', 'audit/B1')]);
  assert.deepEqual(order('B1'), [line('blocked-by', 'audit/B2')]);
  await add('B3', '--blocked-by', 'B1', '--relate', 'A1');
  assert.deepEqual(deps('B3'), ['B1']);
  assert.deepEqual(order('B3'), [line('blocked-by', 'audit/B1')]);
  assert.deepEqual(order('B1').at(-1), line('unblocks', 'audit/B3'));
  await add('B4', '--blocks', 'B1,B3', '--blocked-by', 'B2', '--relate', 'A1');
  assert.deepEqual([deps('B1'), deps('B3'), deps('B4')], [['B2', 'B4'], ['B1', 'B4'], ['B2']]);
  const bad = await board('item', 'add', 'audit/B6', '--site', 'audit', '--title', 'feat: b6', '--phase', 'grilling', '--relate', 'A1', '--blocks', 'Z9');
  assert.notEqual(bad.code, 0);
  assert.equal(deps('B6'), undefined);
});
