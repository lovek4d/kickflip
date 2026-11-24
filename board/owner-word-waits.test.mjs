// docs/adr/2026-11-15-1600-a-card-owing-nobody-or-with-the-owners-word-last-waits-on-the-orchestrator.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBoard, orchestratorWaits, ownerWordEnds } from './domain.mjs';

const at = (minute) => `2026-11-15T10:${String(minute).padStart(2, '0')}:00.000Z`;
const built = ({ items, agents = {}, events = [], threads = {}, owner = {}, delivered = {} }) => buildBoard({ now: Date.parse(at(59)), owner, events, threads, working: {}, delivered,
  files: [{ slug: 'w', agents, itemFile: { internal: true, items } }] });
const waits = (snapshot) => orchestratorWaits(built(snapshot)).map(({ key, kind, since, next }) => [key, kind, since, next]);
const card = (item = {}) => ({ id: 'A1', title: 'One', created: at(0), phase: 'discussing', lane: 'todo', ...item });
const said = (minute, key = 'w/A1') => ({ id: `m${minute}`, ts: at(minute), kind: 'item-message', data: { key, text: 'One more thing' }, reply: null });
const line = (minute, rest = {}) => ({ ts: at(minute), who: 'claude', text: 'On it.', ...rest });
const LIMBO = 'A1 owes nobody anything: ask Implement (reply w/A1 --implement), ask questions, or close it';

test('a discussing card with no mark, no question and nothing running waits on the orchestrator at once, until a mark, a question, a planner or a phase change', () => {
  assert.deepEqual(waits({ items: [card()] }), [['w/A1', 'limbo', at(0), LIMBO]]);
  assert.deepEqual(waits({ items: [card({ phase: undefined, sorted_at: at(1) })] }).filter((w) => w[1] === 'limbo'), [['w/A1', 'limbo', at(1), LIMBO]], 'a sorted new card too');
  // thread --implement stores the mark; Implement and Close both end it.
  for (const on of ['implement', 'close']) {
    assert.deepEqual(waits({ items: [card({ waits_on_owner: { on, at: at(5), phase: 'discussing', lane: 'todo' } })] }), [], `a ${on} mark`);
  }
  // A mark the card's state left behind owes nothing, so the card waits again from when the mark was set.
  assert.deepEqual(waits({ items: [card({ waits_on_owner: { on: 'implement', at: at(5), phase: 'new', lane: 'todo' } })] }), [['w/A1', 'limbo', at(5), LIMBO]]);
  const question = { id: 'q1', topic: 'item:w/A1', question: 'Which?', options: [{ id: 'a', label: 'A' }], asked_at: at(3) };
  assert.deepEqual(waits({ items: [card()], owner: { items: [question] } }), [], 'an open question');
  assert.deepEqual(waits({ items: [card()], agents: { A1: { grill: { kind: 'grill', started: at(58) } } } }), [], 'a planner running');
  assert.deepEqual(waits({ items: [card({ briefs: [{ kind: 'grill', at: at(4) }] })] }).map((w) => w[1]), ['brief'], 'a brief owed is its own wait');
  for (const phase of ['grilling', 'prototyping', 'staging', 'ready']) assert.equal(waits({ items: [card({ phase })] }).some((w) => w[1] === 'limbo'), false, phase);
  assert.deepEqual(waits({ items: [card({ lane: 'done', closed_at: at(6) })] }), [], 'Done');
  // A planner that finished leaves the card owing nobody again, from its end.
  assert.deepEqual(waits({ items: [card()], agents: { A1: { grill: { kind: 'grill', started: at(4), done: at(8) } } } }), [['w/A1', 'limbo', at(8), LIMBO]]);
  // Chat on the card doesn't move it: the wait keeps its since.
  assert.deepEqual(waits({ items: [card()], threads: { 'w/A1': [line(9)] } }), [['w/A1', 'limbo', at(0), LIMBO]]);
});

test("a card whose reviewer posted last waits to fold the findings into the notes, then reply", () => {
  const reviewer = { kind: 'reviewer', started: at(4), done: at(8) };
  assert.deepEqual(waits({ items: [card()], agents: { A1: { reviewer } } }), [['w/A1', 'limbo', at(8), "A1's reviewer posted its findings: fold them into the notes, then reply w/A1"]]);
  assert.deepEqual(waits({ items: [card()], agents: { A1: { reviewer, grill: { kind: 'grill', started: at(9), done: at(12) } } } }), [['w/A1', 'limbo', at(12), LIMBO]], 'a later planner end is the plain limbo');
});

test('the limbo waits come after every other wait, oldest first, so a deploy surfaces them once in one batch', () => {
  const items = [card({ id: 'A1', created: at(20) }), card({ id: 'A2', created: at(10) }), { id: 'A3', title: 'Three', lane: 'todo', phase: 'staging', staged_at: at(30) }];
  assert.deepEqual(waits({ items }).map(([key, kind]) => [key, kind]), [['w/A3', 'staging'], ['w/A2', 'limbo'], ['w/A1', 'limbo']]);
});

test("a card whose newest thread message is the owner's waits on the orchestrator in every lane but Done, whatever its marks, until any line of the orchestrator's", () => {
  const marked = card({ waits_on_owner: { on: 'implement', at: at(1), phase: 'discussing', lane: 'todo' } });
  assert.deepEqual(waits({ items: [marked], events: [said(5), said(7)] }), [['w/A1', 'reply', at(5), "Act on the owner's reply: answer it in the thread, or act and let the action's line answer it"]]);
  // Any line the orchestrator writes after it ends it, a status line too; a builder's progress line or ask doesn't.
  for (const answer of [line(8), line(8, { kind: 'move', text: 'Moved' }), line(8, { kind: 'hub', line: 'pulled', text: 'Moved to In Progress' })]) {
    assert.deepEqual(waits({ items: [marked], events: [said(5)], threads: { 'w/A1': [answer] } }), [], JSON.stringify(answer));
  }
  assert.deepEqual(waits({ items: [marked], events: [said(5)], threads: { 'w/A1': [line(8, { kind: 'status', text: 'Reading: x' })] } }).map((w) => w[1]), ['reply'], 'a progress line');
  // A builder's ask is a wait of its own, beside the owner's, which lists first.
  assert.deepEqual(waits({ items: [marked], events: [said(5)], threads: { 'w/A1': [line(8, { who: 'Claude Opus builder', kind: 'builder-ask', ask: 'x1', text: 'Which?' })] } }).map((w) => w[1]), ['reply', 'ask'], 'a builder ask');
  // A reply to the message's event answers it too.
  assert.deepEqual(waits({ items: [marked], events: [{ ...said(5), reply: { at: at(6), text: 'Done.' } }] }), []);
  // The owner writing after the orchestrator's line waits from that newer message.
  assert.deepEqual(waits({ items: [marked], events: [said(5), said(9)], threads: { 'w/A1': [line(8)] } }).map((w) => w[2]), [at(9)]);
  // In Progress, with a builder running.
  const building = { A1: { main: { kind: 'claude', started: at(2) } } };
  assert.deepEqual(waits({ items: [card({ lane: 'progress', phase: 'ready' })], agents: building, events: [said(5)], threads: { 'w/A1': [line(58, { kind: 'status', text: 'Reading: x' })] } }).map((w) => w[1]), ['reply']);
  // A message from before the card's close is over.
  assert.deepEqual(waits({ items: [card({ lane: 'done', closed_at: at(6) })], events: [said(5)] }), []);
});

test("a reply answers its message whatever its handed stamp, a line or action only after it, and a board command line never", () => {
  const marked = card({ waits_on_owner: { on: 'implement', at: at(1), phase: 'discussing', lane: 'todo' } });
  const handedAt10 = { since: at(1), events: { m5: at(10) } };
  const open = (extra) => waits({ items: [marked], events: [said(5)], delivered: handedAt10, ...extra }).map((w) => w[1]);
  assert.deepEqual(open({}), ['reply']);
  assert.deepEqual(open({ events: [{ ...said(5), reply: { at: at(7), md: 'Done.' } }] }), [], 'a reply before the handed stamp');
  assert.deepEqual(open({ threads: { 'w/A1': [line(7)] } }), ['reply'], 'a thread line before the handed stamp');
  assert.deepEqual(open({ threads: { 'w/A1': [line(12)] } }), [], 'a thread line after it');
  for (const command of ['related', 'staged']) assert.deepEqual(open({ threads: { 'w/A1': [line(12, { command, text: 'Related to T-1' })] } }), ['reply'], `a ${command} command line`);
});

test("a reply's body ends the wait in the log as its text", () => {
  const previous = [{ key: 'w/A1', ref: 'A1', kind: 'reply', since: at(5) }];
  const b = built({ items: [card()], events: [{ ...said(5), reply: { at: at(8), md: 'Done.' } }] });
  b.threadViews = { 'w/A1': [{ ts: at(5), who: 'love', handed: at(5) }, { ts: at(5), who: 'love', handed: at(5), reply: { at: at(8), md: 'Done.' } }] };
  assert.equal(ownerWordEnds(previous, [], b, new Date(at(21)))[0].endedBy.text, 'Done.');
});

test("each owner's-last-word wait that ends is logged with the line that ended it and how long it waited", () => {
  const previous = [{ key: 'w/A1', ref: 'A1', kind: 'reply', since: at(5) }, { key: 'w/A2', ref: 'A2', kind: 'limbo', since: at(0) }];
  const answered = built({ items: [card()], events: [said(5)], threads: { 'w/A1': [line(20)] } });
  assert.deepEqual(ownerWordEnds(previous, orchestratorWaits(answered), answered, new Date(at(21))),
    [{ key: 'w/A1', ref: 'A1', messageAt: at(5), endedAt: at(20), endedBy: { who: 'claude', text: 'On it.' }, minutes: 15 }]);
  // Still waiting: nothing is logged.
  const still = built({ items: [card()], events: [said(5)] });
  assert.deepEqual(ownerWordEnds(previous, orchestratorWaits(still), still, new Date(at(21))), []);
  // A card gone from the board, or closed, ends it with no line.
  const gone = built({ items: [card({ id: 'A3' })] });
  assert.deepEqual(ownerWordEnds(previous, orchestratorWaits(gone), gone, new Date(at(21))),
    [{ key: 'w/A1', ref: 'A1', messageAt: at(5), endedAt: at(21), endedBy: null, minutes: 16 }]);
});

// docs/adr/2026-11-16-0856-the-waits-sheet-lists-one-row-per-card-for-what-the-orchestrator-owes-now.md
test('limbo goes only on a card nothing else waits on: not beside an investigate or a reply, not on a blocked card, not while a planner or visual agent runs', () => {
  // A freshly triaged card waits on its investigation alone.
  const triaged = card({ phase: 'new', sorted_at: at(2), triaged: { at: at(2), phase: 'new' } });
  assert.deepEqual(waits({ items: [triaged] }).map((w) => w[1]), ['investigate']);
  assert.deepEqual(waits({ items: [card()], events: [said(5)] }).map((w) => w[1]), ['reply']);
  // A card blocked by another task owes its blocker.
  const blocker = { id: 'B1', title: 'Blocker', created: at(0), lane: 'progress', phase: 'ready' };
  assert.equal(waits({ items: [card({ deps: ['B1'] }), blocker] }).some((w) => w[0] === 'w/A1'), false, 'blocked by a task');
  assert.equal(waits({ items: [card({ blocked_until: '2026-12-01' })] }).some((w) => w[1] === 'limbo'), false, 'blocked until a date');
  for (const kind of ['grill', 'prototype', 'visual']) {
    assert.deepEqual(waits({ items: [card()], agents: { A1: { [kind]: { kind, started: at(58) } } } }), [], `a ${kind} agent running`);
  }
});
