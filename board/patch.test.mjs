import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { freshSync, stamp, patchSince, TOMBSTONES_KEPT } from './sync.mjs';

const context = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('./public/ui-patch.js', import.meta.url), 'utf8'), context);
const { applyPatch } = context.BoardUI;
const plain = (v) => JSON.parse(JSON.stringify(v));

const card = (key, lane = 'todo', extra = {}) => ({ key, lane, title: `Card ${key}`, ...extra });
let clock = 0;
const board = (over = {}) => ({
  generatedAt: `2026-11-06T00:00:${String(clock++).padStart(2, '0')}Z`, title: 'T',
  items: [card('w/A', 'progress'), card('w/B'), card('ask:e1')],
  owner: [{ id: 'q1', topic: 'item:w/A', state: 'open' }, { id: 'q2', topic: 'plan', state: 'open' }],
  ownerTopics: [{ id: 'item:w/A', card: 'w/A', open: 1 }, { id: 'plan', title: 'Plan', open: 1 }],
  needs: [], settings: { autoReview: false },
  ...over,
});
const START = 1000;
const first = () => stamp(freshSync(START), board());

test('the first board stamps every card, question and topic with the one change number it brings, and the board carries it as its version', () => {
  const { sync, board: b } = first();
  assert.equal(sync.n, START + 1);
  assert.equal(b.version, START + 1);
  for (const r of [...b.items, ...b.owner, ...b.ownerTopics]) assert.equal(r.changed, START + 1);
  assert.equal(b.settings.changed, undefined, 'a part that comes whole carries no number of its own');
});

test('a board that reads the same moves no number, even when its records already carry their numbers', () => {
  const { sync, board: b } = first();
  const again = stamp(sync, board());
  assert.equal(again.sync.n, sync.n);
  assert.equal(stamp(sync, b).sync.n, sync.n, "a record's hash leaves out its own changed");
});

test('a changed card takes the next number alone, and since the last number the patch carries it whole and applies to the board the page holds', () => {
  const { sync, board: was } = first();
  const { sync: next, board: now } = stamp(sync, board({ items: [card('w/A', 'progress'), card('w/B', 'todo', { title: 'Renamed' }), card('ask:e1')] }));
  assert.equal(next.n, sync.n + 1);
  assert.deepEqual(now.items.map((i) => i.changed), [sync.n, sync.n + 1, sync.n]);
  const p = plain(patchSince(next, now, was.version));
  assert.deepEqual(p, { since: was.version, version: next.n, generatedAt: now.generatedAt, set: {}, unset: [], lists: { items: { set: [plain(now.items[1])], drop: [] } } });
  assert.deepEqual(plain(applyPatch(was, p)), plain(now));
});

test('a removed card leaves a tombstone the patch drops by key, a new card comes with the new order, and a card that comes back loses its tombstone', () => {
  const { sync, board: was } = first();
  const { sync: next, board: now } = stamp(sync, board({ items: [card('w/C'), card('w/A', 'progress'), card('w/B')] }));
  assert.deepEqual(next.tombstones, [{ id: 'items:ask:e1', n: next.n }]);
  const p = plain(patchSince(next, now, was.version));
  assert.deepEqual(p.lists.items, { set: [plain(now.items[0])], drop: ['ask:e1'], order: ['w/C', 'w/A', 'w/B'] });
  assert.deepEqual(plain(applyPatch(was, p)), plain(now));
  const back = stamp(next, board());
  assert.deepEqual(back.sync.tombstones, [{ id: 'items:w/C', n: back.sync.n }]);
  assert.deepEqual(plain(applyPatch(now, patchSince(back.sync, back.board, now.version))), plain(back.board));
});

test('questions and topics patch by id, and any other part comes whole when it changed since or unset when it went', () => {
  const { sync, board: was } = stamp(freshSync(START), board({ setup: { events: true } }));
  const { sync: next, board: now } = stamp(sync, board({
    owner: [{ id: 'q1', topic: 'item:w/A', state: 'answered' }, { id: 'q2', topic: 'plan', state: 'open' }, { id: 'q3', topic: 'plan', state: 'open' }],
    ownerTopics: [{ id: 'item:w/A', card: 'w/A', open: 0 }, { id: 'plan', title: 'Plan', open: 2 }],
    settings: { autoReview: true },
  }));
  const p = plain(patchSince(next, now, was.version));
  assert.deepEqual(p.set, { settings: { autoReview: true } });
  assert.deepEqual(p.unset, ['setup']);
  assert.deepEqual(p.lists.owner, { set: [plain(now.owner[0]), plain(now.owner[2])], drop: [], order: ['q1', 'q2', 'q3'] });
  assert.deepEqual(p.lists.ownerTopics, { set: plain(now.ownerTopics), drop: [] });
  assert.equal(p.lists.items, undefined);
  assert.deepEqual(plain(applyPatch(was, p)), plain(now));
});

test('a patch since any earlier number catches up across several changes from the current board alone', () => {
  let { sync, board: b } = first();
  const held = b;
  for (const title of ['One', 'Two', 'Three']) ({ sync, board: b } = stamp(sync, board({ items: [card('w/A', 'progress', { title }), card('w/B')] })));
  const p = plain(patchSince(sync, b, held.version));
  assert.deepEqual(p.lists.items.set.map((i) => [i.key, i.title, i.changed]), [['w/A', 'Three', sync.n]]);
  assert.deepEqual(p.lists.items.drop, ['ask:e1']);
  assert.deepEqual(plain(applyPatch(held, p)), plain(b));
});

test('a since older than the oldest tombstone kept, newer than the counter, or from before a fresh sync file gets no patch: the page takes the whole board', () => {
  let { sync, board: b } = first();
  const held = b.version;
  for (let i = 0; i <= TOMBSTONES_KEPT; i++) ({ sync, board: b } = stamp(sync, board({ items: [card(`w/T${i}`)] })));
  assert.equal(sync.tombstones.length, TOMBSTONES_KEPT);
  assert.ok(sync.floor > held);
  assert.equal(patchSince(sync, b, held), null);
  assert.ok(patchSince(sync, b, sync.floor));
  assert.equal(patchSince(sync, b, sync.n + 1), null);
  assert.equal(patchSince(sync, b, Number.NaN), null);
  const fresh = stamp(freshSync(Date.now()), board());
  assert.equal(patchSince(fresh.sync, fresh.board, b.version), null, 'a fresh file counts from the time it began, past any number a page could hold');
});

test("a patch carries the request's onHost beside the board, and applies only to the board it was made against, leaving that board as it was", () => {
  const { sync, board: was } = first();
  const { sync: next, board: now } = stamp(sync, board({ items: [card('w/B')] }));
  const p = { ...patchSince(next, now, was.version), onHost: false };
  const before = plain(was);
  assert.equal(applyPatch({ ...was, version: was.version - 1 }, p), null);
  assert.equal(applyPatch({ ...was, onHost: true }, p).onHost, false);
  assert.deepEqual(plain(was), before);
});
