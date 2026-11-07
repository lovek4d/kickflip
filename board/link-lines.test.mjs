import { test } from 'node:test';
import assert from 'node:assert/strict';
import { site, lines, board } from './board-fixture.mjs';

// docs/adr/2026-11-06-1130-linking-two-cards-posts-a-keyed-line-in-both-threads.md
const thread = (id) => lines(site('audit', 'data', 'threads', `audit__${id}.jsonl`)).map(({ ts, ...m }) => m);
const set = (id, ...args) => assert.equal(board('item', 'set', `audit/${id}`, '--site', 'audit', ...args).code, 0, args.join(' '));
const add = (id, ...args) => assert.equal(board('item', 'add', `audit/${id}`, '--site', 'audit', '--title', id, '--phase', 'grilling', ...args).code, 0, args.join(' '));
const line = (command, card) => ({ who: 'claude', text: { related: 'Related to', unrelated: 'Unrelated from', followup: 'Follow-up', 'followup-of': 'Follow-up of' }[command], command, card });

test('a new link posts a keyed line naming the other card in both threads, once; an unlink posts an Unrelated line in both', () => {
  add('L1');
  add('L2', '--relate', 'L1');
  assert.deepEqual(thread('L2'), [line('related', 'audit/L1')]);
  assert.deepEqual(thread('L1'), [line('related', 'audit/L2')]);
  // Re-relating a linked card posts nothing; a new one in the list posts for that link alone.
  add('L3');
  set('L2', '--relate', 'L1');
  set('L2', '--related', 'L1,L3');
  assert.deepEqual(thread('L2').map((m) => m.card), ['audit/L1', 'audit/L3']);
  assert.deepEqual(thread('L3'), [line('related', 'audit/L2')]);
  assert.equal(thread('L1').length, 1);
  // A --related list leaving a card out unrelates it; --unrelate does the same.
  set('L2', '--related', 'L3');
  assert.deepEqual(thread('L1').at(-1), line('unrelated', 'audit/L2'));
  assert.deepEqual(thread('L2').at(-1), line('unrelated', 'audit/L1'));
  set('L2', '--unrelate', 'L3');
  assert.deepEqual(thread('L3').at(-1), line('unrelated', 'audit/L2'));
  assert.deepEqual(thread('L2').at(-1), line('unrelated', 'audit/L3'));
});

test('a Parent link posts Follow-up in the parent and Follow-up of in the child, once', () => {
  add('P1');
  add('P2', '--parent', 'P1');
  assert.deepEqual(thread('P1'), [line('followup', 'audit/P2')]);
  assert.deepEqual(thread('P2'), [line('followup-of', 'audit/P1')]);
  set('P2', '--parent', 'P1');
  assert.equal(thread('P1').length, 1);
  assert.equal(thread('P2').length, 1);
});
