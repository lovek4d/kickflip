import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('./public/ui-patch.js', import.meta.url), 'utf8'), context);
const { boardPatch, applyPatch } = context.BoardUI;
const plain = (v) => JSON.parse(JSON.stringify(v));

const card = (key, lane = 'todo', extra = {}) => ({ key, lane, title: `Card ${key}`, ...extra });
const board = (version, over = {}) => ({
  version, generatedAt: `2026-11-04T00:00:0${version.length}Z`, title: 'T',
  items: [card('w/A', 'progress'), card('w/B'), card('w/C')],
  owner: [{ id: 'q1', topic: 'item:w/A', state: 'open' }, { id: 'q2', topic: 'plan', state: 'open' }],
  ownerTopics: [{ id: 'item:w/A', card: 'w/A', open: 1 }, { id: 'plan', title: 'Plan', open: 1 }],
  needs: [], settings: { autoPull: false },
  ...over,
});

test('a patch carries only the cards that changed, whole, and applying it gives the new board', () => {
  const from = board('v1');
  const to = board('v2', { items: [card('w/A', 'progress'), card('w/B', 'todo', { title: 'Renamed' }), card('w/C')] });
  const p = plain(boardPatch(from, to));
  assert.deepEqual(p, { since: 'v1', version: 'v2', generatedAt: to.generatedAt, set: {}, unset: [], lists: { items: { set: [to.items[1]], drop: [] } } });
  assert.deepEqual(plain(applyPatch(from, p)), plain(to));
});

test('a removed card is dropped by key, a new one set, and a card that moves lane brings the new order', () => {
  const from = board('v1');
  const to = board('v2', { items: [card('w/C', 'progress'), card('w/A', 'progress'), card('w/D')] });
  const p = plain(boardPatch(from, to));
  assert.deepEqual(p.lists.items, { set: [to.items[0], to.items[2]], drop: ['w/B'], order: ['w/C', 'w/A', 'w/D'] });
  assert.deepEqual(plain(applyPatch(from, p)), plain(to));
});

test('questions and topics patch by id, and any other part of the board comes whole when it changes or goes', () => {
  const from = board('v1', { setup: { events: true } });
  const to = board('v2', {
    owner: [{ id: 'q1', topic: 'item:w/A', state: 'answered' }, { id: 'q2', topic: 'plan', state: 'open' }, { id: 'q3', topic: 'plan', state: 'open' }],
    ownerTopics: [{ id: 'item:w/A', card: 'w/A', open: 0 }, { id: 'plan', title: 'Plan', open: 2 }],
    settings: { autoPull: true },
  });
  delete to.setup;
  const p = plain(boardPatch(from, to));
  assert.deepEqual(p.set, { settings: { autoPull: true } });
  assert.deepEqual(p.unset, ['setup']);
  assert.deepEqual(p.lists.owner, { set: [to.owner[0], to.owner[2]], drop: [] });
  assert.deepEqual(p.lists.ownerTopics, { set: to.ownerTopics, drop: [] });
  assert.equal(p.lists.items, undefined);
  assert.deepEqual(plain(applyPatch(from, p)), plain(to));
});

test('a patch applies only to the board it was made against, and leaves that board as it was', () => {
  const from = board('v1');
  const to = board('v2', { items: [card('w/B')] });
  const p = boardPatch(from, to);
  const before = plain(from);
  assert.equal(applyPatch(board('v0'), p), null);
  applyPatch(from, p);
  assert.deepEqual(plain(from), before);
});
