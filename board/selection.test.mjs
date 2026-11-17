import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('./public/ui-selection.js', import.meta.url), 'utf8'), context);
const { cardOfQuestion } = context.BoardUI;

const board = {
  ownerTopics: [
    { id: 'item:w/A', card: 'w/A', state: 'open', open: 1, questions: ['qa'] },
    { id: 'item:w/B', state: 'resolved', open: 0, questions: ['qb'] },
    { id: 'plan', state: 'open', open: 1, questions: ['qp'] },
  ],
};

// docs/adr/2026-11-17-2000-one-board-filter-replaces-waiting-on-you.md
test("a question or topic id names its topic's card, resolved or not; a topic of no card, an id gone or none names none", () => {
  assert.equal(cardOfQuestion(board, 'qa'), 'w/A');
  assert.equal(cardOfQuestion(board, 'item:w/A'), 'w/A');
  assert.equal(cardOfQuestion(board, 'qb'), 'w/B', 'a card topic the board names by id alone');
  assert.equal(cardOfQuestion(board, 'qp'), null);
  assert.equal(cardOfQuestion(board, 'gone'), null);
  assert.equal(cardOfQuestion(board, null), null);
  assert.equal(cardOfQuestion(null, 'qa'), null);
});
