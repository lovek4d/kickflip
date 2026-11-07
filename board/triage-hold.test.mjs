import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pullOf, triageWaitOf } from './domain.mjs';

// docs/adr/2026-11-06-1634-an-unanswered-triage-holds-only-its-cards-until-quiet-hours-end.md
test('the pull skips the cards a triage holds and takes the next ready one', () => {
  const items = [1, 2].map((n) => ({ key: `w/R${n}`, kind: 'work', lane: 'todo', ready: true, buildable: true, phase: 'ready', agents: [] }));
  assert.deepEqual(pullOf(items, { cap: 1 }).pulls, ['w/R1']);
  assert.deepEqual(pullOf(items, { cap: 1, hold: ['w/R1'] }).pulls, ['w/R2']);
});

test('an unanswered overnight triage is an orchestrator wait naming the reply command', () => {
  const event = { id: 'tt1', ts: '2026-11-06T13:17:00.000Z', data: { date: '2026-11-06' } };
  const w = triageWaitOf(event);
  assert.deepEqual({ kind: w.kind, ref: w.ref, key: w.key, since: w.since, picked: w.picked }, { kind: 'triage', ref: '2026-11-06', key: 'tt1', since: event.ts, picked: null });
  assert.match(w.next, /reply tt1/);
  assert.equal(triageWaitOf(event, '2026-11-06T14:00:00.000Z').picked, '2026-11-06T14:00:00.000Z');
});
