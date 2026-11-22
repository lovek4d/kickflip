import test from 'node:test';
import assert from 'node:assert/strict';
import { placeIn } from './cards.mjs';

test("a move to Done drops the briefs the card still owes and keeps the written ones", () => {
  const written = { kind: 'grill', at: 'a', brief: { heading: 'h', text: 't', at: 'b' } };
  const item = { lane: 'progress', briefs: [{ kind: 'prototype', at: 'c' }, written] };
  placeIn(item, 'done');
  assert.deepEqual(item.briefs, [written]);
  const owing = { lane: 'review', briefs: [{ kind: 'prototype', at: 'c' }] };
  placeIn(owing, 'done');
  assert.equal(owing.briefs, undefined);
});
