// docs/adr/2026-11-15-1700-a-card-reads-thinking-from-its-events-delivery-until-the-orchestrator-writes.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBoard, orchestratorWaits, ownerWordEnds, threadOf } from './domain.mjs';

const at = (minute) => `2026-11-15T10:${String(minute).padStart(2, '0')}:00.000Z`;
// The board keeps delivery stamps from minute 1: a message sent before then counts as handed when it was sent.
const stamps = (events = {}) => ({ since: at(1), events });
const built = ({ items = [card()], events = [], threads = {}, owner = {}, delivered = stamps(), actedOn = {} }) => buildBoard({ now: Date.parse(at(59)), owner, events, threads, working: {}, delivered, actedOn,
  files: [{ slug: 'w', agents: {}, itemFile: { internal: true, items } }] });
const card = (item = {}) => ({ id: 'A1', title: 'One', created: at(0), phase: 'discussing', lane: 'todo', waits_on_owner: { on: 'implement', at: at(0), phase: 'discussing', lane: 'todo' }, ...item });
const said = (minute, id = `m${minute}`) => ({ id, ts: at(minute), kind: 'item-message', data: { key: 'w/A1', text: 'One more thing' }, reply: null });
const line = (minute, rest = {}) => ({ ts: at(minute), who: 'claude', text: 'On it.', ...rest });
const stateOf = (snapshot, id) => built(snapshot).threadViews['w/A1'].find((m) => m.eventId === id)?.state;
const replyWaits = (snapshot) => orchestratorWaits(built(snapshot)).filter((w) => w.kind === 'reply').map(({ since, picked }) => [since, picked]);
const cardOf = (snapshot) => built(snapshot).items.find((i) => i.key === 'w/A1');

test("a line the orchestrator wrote before the owner's message reached it doesn't answer the message", () => {
  // Sent at 5, the orchestrator's line at 6, handed over at 7: the line answers nothing, and the message reads thinking.
  assert.equal(stateOf({ events: [said(5)], threads: { 'w/A1': [line(6)] }, delivered: stamps({ m5: at(7) }) }, 'm5'), 'working');
  // A line after the handover answers it.
  assert.equal(stateOf({ events: [said(5)], threads: { 'w/A1': [line(8)] }, delivered: stamps({ m5: at(7) }) }, 'm5'), 'answered');
  // Not handed over yet: waiting, whatever the orchestrator writes meanwhile.
  assert.equal(stateOf({ events: [said(5)], threads: { 'w/A1': [line(6)] } }, 'm5'), 'waiting');
  // A message from before the board kept stamps is answered by any later line, as before.
  assert.equal(stateOf({ events: [said(0)], threads: { 'w/A1': [line(6)] } }, 'm0'), 'answered');
  assert.equal(stateOf({ events: [said(0)], threads: { 'w/A1': [line(6)] }, delivered: {} }, 'm0'), 'answered', 'a board with no stamps yet');
  // The orchestrator's command on the card before the handover answers nothing either; the card's close does.
  assert.equal(stateOf({ events: [said(5)], actedOn: { 'w/A1': at(6) }, delivered: stamps({ m5: at(7) }) }, 'm5'), 'working');
  assert.equal(stateOf({ items: [card({ lane: 'done', closed_at: at(6) })], events: [said(5)] }, 'm5'), 'answered');
});

test("the owner's last word stays owed past a line written before it was handed over, and is picked up at the handover", () => {
  assert.deepEqual(replyWaits({ events: [said(5)], threads: { 'w/A1': [line(6)] }, delivered: stamps({ m5: at(7) }) }), [[at(5), at(7)]]);
  assert.deepEqual(replyWaits({ events: [said(5)], threads: { 'w/A1': [line(6)] } }), [[at(5), null]], 'not handed over: waiting, not picked');
  assert.deepEqual(replyWaits({ events: [said(5)], threads: { 'w/A1': [line(6), line(8)] }, delivered: stamps({ m5: at(7) }) }), []);
  // The ended wait logs the line after the handover, not the earlier one.
  const previous = [{ key: 'w/A1', ref: 'A1', kind: 'reply', since: at(5) }];
  const answered = built({ events: [said(5)], threads: { 'w/A1': [line(6, { text: 'Early' }), line(8, { text: 'Late' })] }, delivered: stamps({ m5: at(7) }) });
  assert.deepEqual(ownerWordEnds(previous, orchestratorWaits(answered), answered, new Date(at(21))).map((e) => [e.endedAt, e.endedBy.text]), [[at(8), 'Late']]);
});

test("a card reads thinking from when any of its events reaches the orchestrator until the orchestrator writes on it", () => {
  // An owner's answer is no working kind; its handover alone makes the card think.
  const question = { id: 'q1', topic: 'item:w/A1', question: 'Which?', options: [{ id: 'a', label: 'A' }], asked_at: at(2) };
  const answer = { id: 'e1', ts: at(4), kind: 'owner-answer', data: { id: 'q1', choice: 'a', label: 'A' }, reply: null };
  const owner = { items: [question] };
  assert.deepEqual(((it) => [it.working, it.workingSince])(cardOf({ events: [answer], owner, delivered: stamps({ e1: at(6) }) })), [true, at(6)]);
  assert.equal(cardOf({ events: [answer], owner }).working, false, 'not handed over yet');
  // Its next write ends it: a thread line, or a command such as item notes or item set (acted-on.json).
  assert.equal(cardOf({ events: [answer], owner, threads: { 'w/A1': [line(8)] }, delivered: stamps({ e1: at(6) }) }).working, false);
  assert.equal(cardOf({ events: [answer], owner, actedOn: { 'w/A1': at(8) }, delivered: stamps({ e1: at(6) }) }).working, false);
  // A write before the handover doesn't.
  assert.equal(cardOf({ events: [answer], owner, threads: { 'w/A1': [line(5)] }, delivered: stamps({ e1: at(6) }) }).working, true);
  // A card event that is no owner message, such as an unblock, thinks too, from its handover.
  const unblocked = { id: 'u1', ts: at(3), kind: 'card-unblocked', data: { key: 'w/A1' } };
  assert.deepEqual(((it) => [it.working, it.workingSince])(cardOf({ events: [unblocked], delivered: stamps({ u1: at(9) }) })), [true, at(9)]);
  // A bump or a script run asks for no write (bin/event-lines.mjs: "with none, leave it", "nothing to do until then"), so its handover doesn't.
  for (const kind of ['card-bump', 'script-run']) {
    assert.equal(cardOf({ events: [{ id: 'k1', ts: at(3), kind, data: { key: 'w/A1' } }], delivered: stamps({ k1: at(9) }) }).working, false, kind);
  }
  // A Done card thinks no more.
  assert.equal(cardOf({ items: [card({ lane: 'done', closed_at: at(10) })], events: [unblocked], delivered: stamps({ u1: at(9) }) }).working, false);
});

test("an owner message's thread view keeps its handover time while it is thinking", () => {
  const msgs = threadOf('w/A1', { events: [said(5)], delivered: stamps({ m5: at(7) }) });
  assert.deepEqual(msgs.map((m) => [m.state, m.since]), [['working', at(7)]]);
  assert.deepEqual(threadOf('w/A1', { events: [said(5)], delivered: stamps({ m5: at(7) }), listening: false }).map((m) => m.state), ['waiting'], 'a session not listening');
});

test("a card stops reading thinking when the orchestrator's next handover brings no write on it", () => {
  const unblocked = { id: 'u1', ts: at(3), kind: 'card-unblocked', data: { key: 'w/A1' } };
  const other = { id: 'o1', ts: at(4), kind: 'item-message', data: { key: 'w/B1', text: 'Elsewhere' }, reply: null };
  const second = { id: 'u2', ts: at(5), kind: 'card-unblocked', data: { key: 'w/A1' } };
  // Nothing handed over since: the orchestrator is still on it.
  assert.equal(cardOf({ events: [unblocked], delivered: stamps({ u1: at(9) }) }).working, true);
  // A later handover, of another card's event, without a write on this card: it moved on.
  assert.equal(cardOf({ events: [unblocked, other], delivered: stamps({ u1: at(9), o1: at(12) }) }).working, false);
  // Handed in the same batch: still on it.
  assert.equal(cardOf({ events: [unblocked, other], delivered: stamps({ u1: at(9), o1: at(9) }) }).working, true);
  // A new event on the card in the latest handover starts it again, from that handover.
  const again = cardOf({ events: [unblocked, other, second], delivered: stamps({ u1: at(9), o1: at(12), u2: at(15) }) });
  assert.deepEqual([again.working, again.workingSince], [true, at(15)]);
});
