// docs/adr/2026-11-16-1900-every-pending-thread-message-reads-its-state-from-one-seam.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBoard, pendingState, ANSWERED } from './domain.mjs';

const at = (minute) => `2026-11-16T10:${String(minute).padStart(2, '0')}:00.000Z`;
const card = { id: 'A1', title: 'One', created: at(0), phase: 'discussing', lane: 'todo' };
// Two questions on the card; Send resolved both, noting Answered, a moment after the owner's submit at minute 5
// (store.mjs resolveSentAnswers).
const sent = { resolved: ANSWERED, resolved_at: '2026-11-16T10:05:00.300Z' };
const owner = (resolution = sent) => ({ items: ['q1', 'q2'].map((id) => ({ id, topic: 'item:w/A1', question: `${id}?`, ...resolution })) });
const answer = (id) => ({ id: `a-${id}`, ts: at(5), kind: 'owner-answer', data: { id, choice: 'A', label: 'A. Yes', note: '', sendId: 's1' }, reply: null });
const reply = { id: 'm5', ts: at(5), kind: 'item-message', data: { key: 'w/A1', text: 'One more thing' }, reply: null };
const request = { id: 'p5', ts: at(5), kind: 'prototype-request', data: { key: 'w/A1' }, reply: null };
const line = (minute) => ({ ts: at(minute), who: 'claude', text: 'On it.' });
const stamps = (ids, minute) => ({ since: at(1), events: Object.fromEntries(ids.map((id) => [id, at(minute)])) });
const thread = ({ events, delivered = { since: at(1), events: {} }, threads = [], resolution }) =>
  buildBoard({ now: Date.parse(at(59)), owner: owner(resolution), events, threads: { 'w/A1': threads }, working: {}, delivered,
    files: [{ slug: 'w', agents: {}, itemFile: { internal: true, items: [card] } }] }).threadViews['w/A1'];
// Each message of the owner's on the card: [kind, state], a folded submit once.
const states = (snapshot) => thread(snapshot).filter((m) => m.eventId).map((m) => [m.kind, m.state]);

test("a submitted set of answers Send resolved reads waiting, then thinking once handed over, then clears at the orchestrator's next line", () => {
  const events = [answer('q1'), answer('q2')];
  const ids = events.map((e) => e.id);
  assert.deepEqual(states({ events }), [['owner-answer', 'waiting']], 'one message for the set, waiting');
  assert.deepEqual(states({ events, delivered: stamps(ids, 6) }), [['owner-answer', 'working']], 'thinking once handed over');
  assert.equal(thread({ events, delivered: stamps(ids, 6) })[0].since, at(6), 'thinking since the handover');
  assert.deepEqual(states({ events, delivered: stamps(ids, 6), threads: [line(7)] }), [['owner-answer', 'answered']], 'cleared by the line after it');
});

test("an answer the orchestrator resolved itself is acted on, while Send's Answered resolution leaves it pending", () => {
  const events = [answer('q1')];
  assert.deepEqual(states({ events, resolution: { resolved: 'Going with A', resolved_at: at(6) } }), [['owner-answer', 'answered']]);
  assert.deepEqual(states({ events, resolution: sent }), [['owner-answer', 'waiting']]);
});

test('a reply and a request line read the same as a submit: waiting, thinking, then cleared', () => {
  for (const e of [reply, request]) {
    assert.deepEqual(states({ events: [e] }), [[e.kind, 'waiting']], e.kind);
    assert.deepEqual(states({ events: [e], delivered: stamps([e.id], 6) }), [[e.kind, 'working']], e.kind);
    assert.deepEqual(states({ events: [e], delivered: stamps([e.id], 6), threads: [line(7)] }), [[e.kind, 'answered']], e.kind);
  }
});

test('the seam decides every pending state from the same inputs', () => {
  assert.deepEqual(pendingState({}), { state: 'waiting' });
  assert.deepEqual(pendingState({ picked: at(6) }), { state: 'working', since: at(6) });
  assert.deepEqual(pendingState({ picked: at(6), listening: false }), { state: 'waiting' }, 'nobody listening: waiting');
  assert.deepEqual(pendingState({ picked: at(6), handed: at(6), answeredAt: at(7) }), { state: 'answered' });
  assert.deepEqual(pendingState({ picked: at(6), handed: at(6), answeredAt: at(5) }), { state: 'working', since: at(6) }, 'a line before the handover answers nothing');
  assert.deepEqual(pendingState({ picked: at(6), cleared: true }), { state: 'answered' });
  assert.deepEqual(pendingState({ replied: true, cleared: true }), { state: 'replied' });
});
