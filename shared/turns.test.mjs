import assert from 'node:assert/strict';
import test from 'node:test';
import { inTurns, turnAfter } from './turns.mjs';

const w = (site, key, first = null) => ({ site, key, first });
const keys = (list) => list.map((x) => x.key);

// docs/adr/2026-11-19-0800-every-hub-limit-takes-the-same-turns.md
test('waiters go round the boards one each, from the board after the last served, each board in its own order', () => {
  const waiters = [w('/a', 'a1'), w('/a', 'a2'), w('/a', 'a3'), w('/b', 'b1'), w('/c', 'c1'), w('/c', 'c2')];
  assert.deepEqual(keys(inTurns(waiters)), ['a1', 'b1', 'c1', 'a2', 'c2', 'a3'], 'a board with nothing left gives its turn up');
  assert.deepEqual(keys(inTurns(waiters, '/a')), ['b1', 'c1', 'a1', 'c2', 'a2', 'a3']);
  assert.deepEqual(keys(inTurns(waiters, '/bb')), ['c1', 'a1', 'b1', 'c2', 'a2', 'a3'], 'a last board gone hands the turn to the next by name');
});

test('bumped waiters go first, the earliest bump first whichever board, and move no turn', () => {
  const waiters = [w('/a', 'a1'), w('/b', 'b1'), w('/b', 'b2', '2026-11-19T02:00:00Z'), w('/c', 'c1', '2026-11-19T01:00:00.000Z')];
  const order = inTurns(waiters, '/c');
  assert.deepEqual(keys(order), ['c1', 'b2', 'a1', 'b1']);
  assert.equal(turnAfter(order.slice(0, 2), '/c'), '/c', 'only bumps taken: the turn stays');
  assert.equal(turnAfter(order.slice(0, 3), '/c'), '/a');
});

test('waiters with no board share one turn, in their own order', () => {
  assert.deepEqual(keys(inTurns([w(null, 'x1'), w(null, 'x2'), w('/a', 'a1')], '')), ['a1', 'x1', 'x2']);
  assert.equal(turnAfter([w(null, 'x1')], '/a'), '');
});
