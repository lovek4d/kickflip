import { test } from 'node:test';
import assert from 'node:assert/strict';
import { site, lines, board } from './board-fixture.mjs';

// docs/adr/2026-11-06-1130-linking-two-cards-posts-a-keyed-line-in-both-threads.md
const thread = (id) => lines(site('audit', 'data', 'threads', `audit__${id}.jsonl`)).map(({ ts, ...m }) => m);
const set = async (id, ...args) => assert.equal((await board('item', 'set', `audit/${id}`, '--site', 'audit', ...args)).code, 0, args.join(' '));
const add = async (id, ...args) => assert.equal((await board('item', 'add', `audit/${id}`, '--site', 'audit', '--title', `feat: ${id.toLowerCase()}`, '--phase', 'grilling', ...args)).code, 0, args.join(' '));
const line = (command, card) => ({ who: 'claude', text: { related: 'Related to', unrelated: 'Unrelated from', followup: 'Follow-up', 'followup-of': 'Follow-up of', created: 'Created ticket', 'created-from': 'Created from' }[command], command, card });

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

test('a Parent link posts Follow-up in the parent and Follow-up of in the child, once', async () => {
  await add('P1');
  await add('P2', '--parent', 'P1');
  assert.deepEqual(thread('P1'), [line('followup', 'audit/P2')]);
  assert.deepEqual(thread('P2'), [line('followup-of', 'audit/P1')]);
  await set('P2', '--parent', 'P1');
  assert.equal(thread('P1').length, 1);
  assert.equal(thread('P2').length, 1);
});

test('item add --from sets the Parent and posts Created ticket in the source and Created from in the new card, once; --from beside --parent is refused', async () => {
  await add('S1');
  await add('S2', '--from', 'S1');
  assert.deepEqual(thread('S1'), [line('created', 'audit/S2')]);
  assert.deepEqual(thread('S2'), [line('created-from', 'audit/S1')]);
  await set('S2', '--parent', 'S1');
  assert.equal(thread('S1').length, 1);
  assert.equal(thread('S2').length, 1);
  assert.notEqual((await board('item', 'add', 'audit/S3', '--site', 'audit', '--title', 'feat: s3', '--phase', 'grilling', '--from', 'S1', '--parent', 'S1')).code, 0);
});
