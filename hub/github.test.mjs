import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, changesBetween, carry } from './github.mjs';

const gh = (over = {}) => ({
  pr: 7, state: 'OPEN', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED',
  head: 'abc1234567', failing: [], pending: 0, events: [], ...over,
});
const sum = (over) => summarize(gh(over));

test('summarize keeps the state fields, sorted failing names and the newest event', () => {
  const s = sum({ failing: ['lint', 'build', 'lint'], pending: 2, reviewDecision: '', events: [{ id: 11, at: '2026-10-23T10:00:00Z' }, { id: 12, at: '2026-10-23T11:00:00Z' }] });
  assert.deepEqual(s, {
    state: 'OPEN', isDraft: false, reviewDecision: null, mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', head: 'abc1234567',
    failing: ['build', 'lint'], pending: 2, eventId: '12', eventAt: '2026-10-23T11:00:00Z',
  });
});

test('a PR seen for the first time reports only a merge or unhandled comments', () => {
  assert.deepEqual(changesBetween(undefined, sum()), []);
  assert.deepEqual(changesBetween(undefined, sum({ failing: ['x'], isDraft: true })), []);
  assert.deepEqual(changesBetween(undefined, sum({ state: 'MERGED', events: [{ id: 1, at: 't' }] })), ['comments', 'merged']);
});

test('changesBetween names each kind of change once, in order', () => {
  const prev = sum();
  assert.deepEqual(changesBetween(prev, sum()), []);
  assert.deepEqual(changesBetween(prev, sum({ failing: ['build'] })), ['ci']);
  assert.deepEqual(changesBetween(sum({ pending: 3 }), sum({ pending: 1 })), []);
  assert.deepEqual(changesBetween(sum({ pending: 3 }), sum({ pending: 0 })), ['ci']);
  assert.deepEqual(changesBetween(prev, sum({ head: 'def', pending: 4 })), []);
  assert.deepEqual(changesBetween(prev, sum({ head: 'def', pending: 0 })), ['ci']);
  assert.deepEqual(changesBetween(prev, sum({ reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' })), ['review', 'mergeable']);
  assert.deepEqual(changesBetween(prev, sum({ events: [{ id: 5, at: 't' }] })), ['comments']);
  assert.deepEqual(changesBetween(sum({ events: [{ id: 5, at: 't' }] }), sum({ events: [{ id: 5, at: 't' }] })), []);
  assert.deepEqual(changesBetween(sum({ events: [{ id: 5, at: 't' }] }), sum()), []);
  assert.deepEqual(changesBetween(prev, sum({ state: 'MERGED' })), ['merged']);
  assert.deepEqual(changesBetween(sum({ state: 'MERGED' }), sum({ state: 'MERGED' })), []);
  assert.deepEqual(changesBetween(prev, sum({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })), ['mergeable']);
  assert.deepEqual(changesBetween(prev, sum({ isDraft: true })), ['draft']);
});

test('an UNKNOWN mergeability is no change, and the last known one carries over it', () => {
  const prev = sum();
  const unknown = sum({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' });
  assert.deepEqual(changesBetween(prev, unknown), []);
  const kept = carry(prev, unknown);
  assert.equal(kept.mergeable, 'MERGEABLE');
  assert.equal(kept.mergeStateStatus, 'BLOCKED');
  assert.deepEqual(changesBetween(kept, sum()), []);
  assert.deepEqual(changesBetween(kept, sum({ mergeable: 'CONFLICTING' })), ['mergeable']);
  assert.equal(carry(undefined, unknown).mergeable, 'UNKNOWN');
});
