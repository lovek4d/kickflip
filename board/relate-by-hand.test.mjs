// docs/adr/2026-11-25-0405-the-owner-links-and-unlinks-a-cards-related-to-by-hand.md: the owner links or unlinks a card
// from its Related to row (a card-relate tap), written to the item files with a line in both threads and no event.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tapPlan, TAP_KINDS } from './domain.mjs';

test("the owner's card-relate tap is written to the item files with no event, refused with why when it changes nothing", () => {
  assert.ok(TAP_KINDS.has('card-relate'));
  const tapCard = { key: 'w/A1', ref: '#1', kind: 'work', lane: 'done' };
  assert.deepEqual(tapPlan(tapCard, 'card-relate', { key: 'w/A1', other: 'w/T-9', on: true }), [{ do: 'record', nothing: '#1 is already related to T-9, so nothing changed.', stops: false }]);
  assert.deepEqual(tapPlan(tapCard, 'card-relate', { key: 'w/A1', other: 'w/T-9', on: false }), [{ do: 'record', nothing: '#1 isn’t related to T-9, so nothing changed.', stops: false }]);
});
