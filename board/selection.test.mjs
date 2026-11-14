import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('./public/ui-selection.js', import.meta.url), 'utf8'), context);
const { nextSelection, questionsHref } = context.BoardUI;
const plain = (v) => JSON.parse(JSON.stringify(v));

const board = {
  ownerTopics: [
    { id: 'item:w/A', card: 'w/A', state: 'open', open: 1, questions: ['qa'] },
    { id: 'item:w/B', card: 'w/B', state: 'open', open: 2, questions: ['qb1', 'qb2'] },
    { id: 'item:w/C', card: 'w/C', state: 'resolved', open: 0, questions: ['qc'] },
    { id: 'plan', state: 'open', open: 1, questions: ['qp'] },
  ],
};

// docs/adr/2026-11-14-2359-one-owner-of-the-open-selection.md
test('a question resolves to its topic and its topic\'s card, and both are written to the fragment in one write', () => {
  const r = nextSelection({ board, event: { question: 'qb2' }, generation: 4 });
  assert.deepEqual(plain(r), { card: 'w/B', topic: 'item:w/B', changes: { selectedCard: 'w/B', openItemsCard: 'item:w/B' }, generation: 5 });
});

test('Questions on B while A is selected targets B, so a replay of the URL lands on B and not on A', () => {
  const onA = nextSelection({ board, event: { question: 'qa' }, generation: 0 });
  const onB = nextSelection({ board, event: { question: 'qb1' }, generation: onA.generation });
  assert.equal(onA.card, 'w/A');
  assert.deepEqual([onB.card, onB.changes.selectedCard, onB.changes.openItemsCard], ['w/B', 'w/B', 'item:w/B']);
  assert.ok(onB.generation > onA.generation, 'each pick is a newer generation, so the older pick\'s retry is dropped');
});

test('a topic of no card moves the pane only, and a topic that has gone or none opens the pane\'s own pick', () => {
  assert.deepEqual(plain(nextSelection({ board, event: { topic: 'plan' }, generation: 0 })), { card: null, topic: 'plan', changes: { openItemsCard: 'plan' }, generation: 1 });
  assert.deepEqual(plain(nextSelection({ board, event: { question: null }, generation: 0 })), { card: null, topic: null, changes: { openItemsCard: null }, generation: 1 });
  assert.equal(nextSelection({ board, event: { question: 'gone' }, generation: 0 }).topic, 'gone');
});

test('a card with open questions selects its topic in the pane; one with none leaves the pane as it is', () => {
  assert.deepEqual(plain(nextSelection({ board, event: { card: 'w/B' }, generation: 0 })), { card: 'w/B', topic: 'item:w/B', changes: { selectedCard: 'w/B', openItemsCard: 'item:w/B' }, generation: 1 });
  for (const card of ['w/C', 'w/none']) {
    const r = nextSelection({ board, event: { card }, generation: 0 });
    assert.deepEqual([r.card, r.topic, plain(r.changes)], [card, undefined, { selectedCard: card }]);
  }
});

test('the phone\'s ? opens the selected card\'s topic when it has open questions, else the page as it opens', () => {
  assert.equal(questionsHref(board, 'w/B'), 'questions.html#item%3Aw%2FB');
  assert.equal(questionsHref(board, 'w/C'), 'questions.html');
  assert.equal(questionsHref(board, null), 'questions.html');
  assert.equal(questionsHref(null, 'w/B'), 'questions.html');
});
