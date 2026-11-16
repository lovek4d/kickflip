import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { site, lines, board } from './board-fixture.mjs';

// docs/adr/2026-11-06-1130-linking-two-cards-posts-a-keyed-line-in-both-threads.md
const thread = (id) => lines(site('audit', 'data', 'threads', `audit__${id}.jsonl`)).map(({ ts, ...m }) => m);
const set = async (id, ...args) => assert.equal((await board('item', 'set', `audit/${id}`, '--site', 'audit', ...args)).code, 0, args.join(' '));
const add = async (id, ...args) => assert.equal((await board('item', 'add', `audit/${id}`, '--site', 'audit', '--title', `feat: ${id.toLowerCase()}`, '--phase', 'grilling', ...args)).code, 0, args.join(' '));
const line = (command, card) => ({ who: 'claude', text: { related: 'Related to', unrelated: 'Unrelated from', followup: 'Follow-up', 'followup-of': 'Follow-up of', created: 'Created ticket', 'created-from': 'Created from', 'blocked-by': 'Blocked by', unblocks: 'Unblocks' }[command], command, card });

test('a new link posts a keyed line naming the other card in both threads, once; an unlink posts an Unrelated line in both', async () => {
  await add('L1');
  await add('L2', '--relate', 'L1');
  assert.deepEqual(thread('L2'), [line('related', 'audit/L1')]);
  assert.deepEqual(thread('L1'), [line('related', 'audit/L2')]);
  // Re-relating a linked card posts nothing; a new one in the list posts for that link alone.
  await add('L3');
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

test('a Parent link posts Follow-up in the parent and Follow-up of in the child, once', async () => {
  await add('P1');
  const child = await askFrom('--parent', 'P1');
  assert.deepEqual(thread('P1'), [line('followup', `audit/${child}`)]);
  assert.deepEqual(thread(child), [line('followup-of', 'audit/P1')]);
  await set(child, '--parent', 'P1');
  assert.equal(thread('P1').length, 1);
  assert.equal(thread(child).length, 1);
});

test('item add --ask --from sets the Parent and posts Created ticket in the source and Created from in the new card, once; --from beside --parent is refused', async () => {
  await add('S1');
  const child = await askFrom('--from', 'S1');
  assert.deepEqual(thread('S1'), [line('created', `audit/${child}`)]);
  assert.deepEqual(thread(child), [line('created-from', 'audit/S1')]);
  await set(child, '--parent', 'S1');
  assert.equal(thread('S1').length, 1);
  assert.equal(thread(child).length, 1);
  const both = await board('item', 'add', 'audit', '--site', 'audit', '--ask', 'Another', '--from', 'S1', '--parent', 'S1');
  assert.match(both.err, /--from and --parent each set the Parent; pass one/);
});

test('item add --before blocks the other task on the new one, --after makes the new one wait, each with a line in both threads; neither links nothing', async () => {
  const deps = (id) => JSON.parse(fs.readFileSync(site('audit', 'data', 'items.json'), 'utf8')).items.find((it) => it.id === id)?.deps;
  await add('B1');
  await add('B2', '--before', 'B1');
  assert.deepEqual(deps('B1'), ['B2']);
  assert.equal(deps('B2'), undefined);
  assert.deepEqual(thread('B2'), [line('unblocks', 'audit/B1')]);
  assert.deepEqual(thread('B1'), [line('blocked-by', 'audit/B2')]);
  await add('B3', '--after', 'B1');
  assert.deepEqual(deps('B3'), ['B1']);
  assert.deepEqual(thread('B3'), [line('blocked-by', 'audit/B1')]);
  assert.deepEqual(thread('B1').at(-1), line('unblocks', 'audit/B3'));
  await add('B4', '--before', 'B1,B3', '--after', 'B2');
  assert.deepEqual([deps('B1'), deps('B3'), deps('B4')], [['B2', 'B4'], ['B1', 'B4'], ['B2']]);
  await add('B5');
  assert.deepEqual([deps('B5'), fs.existsSync(site('audit', 'data', 'threads', 'audit__B5.jsonl'))], [undefined, false]);
  const bad = await board('item', 'add', 'audit/B6', '--site', 'audit', '--title', 'feat: b6', '--phase', 'grilling', '--before', 'Z9');
  assert.notEqual(bad.code, 0);
  assert.equal(deps('B6'), undefined);
});
