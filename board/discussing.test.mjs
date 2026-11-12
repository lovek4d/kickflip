// docs/adr/2026-11-12-0500-a-new-task-is-a-conversation.md: a Discuss task gets a reply, not a grill. The card stays in
// Todo reading discussing, whose turn it is shows on it, and grill, prototype, visual and Implement lead out of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildBoard, arrivalsOf, roundsDue, threadOf, PHASES } from './domain.mjs';
import { board, home, site, read, write, lines } from './board-fixture.mjs';

const ask = { id: 'a1', ts: '2026-11-09T10:00:00Z', kind: 'ask', data: { text: 'Rethink the footer' } };
function built({ item = {}, events = [], threads = {}, working = {} } = {}) {
  return buildBoard({
    now: Date.parse('2026-11-09T12:00:00Z'), threads, working,
    files: [{ slug: 'hub', agents: {}, itemFile: { items: [{ id: 'T-1', title: 'Rethink the footer', created: '2026-11-09T10:00:01Z', lane: 'todo', from_ask: 'a1', ...item }] } }],
    prs: {}, owner: {}, events: [ask, ...events],
  });
}
const card = (b) => b.items.find((i) => i.key === 'hub/T-1');
const reply = { ts: '2026-11-09T10:05:00Z', who: 'claude', text: 'Here is what I understand…' };

test("discussing is Todo's phase after new, before grilling", () => {
  assert.deepEqual([...PHASES.todo], ['new', 'discussing', 'grilling', 'prototyping', 'staging', 'ready']);
});

test("a discussing card stays in Todo, never goes to In Review, and reads the owner's turn after the orchestrator's reply", () => {
  const b = built({ item: { phase: 'discussing' }, threads: { 'hub/T-1': [reply] } });
  const c = card(b);
  assert.deepEqual([c.lane, c.phase, c.turn, Boolean(c.isNew), c.awaitsDone, c.orchestrator], ['todo', 'discussing', 'owner', false, false, null]);
  assert.deepEqual(b.answers, []);
});

test("an owner's message on a discussing card makes it the orchestrator's turn, and waits on the orchestrator", () => {
  const said = { id: 'm1', ts: '2026-11-09T10:10:00Z', kind: 'item-message', data: { key: 'hub/T-1', text: 'And on mobile?' } };
  const c = card(built({ item: { phase: 'discussing' }, threads: { 'hub/T-1': [reply] }, events: [said] }));
  assert.deepEqual([c.lane, c.turn], ['todo', 'claude']);
  const answered = { ...reply, ts: '2026-11-09T10:12:00Z', text: 'On mobile it stacks.' };
  assert.equal(card(built({ item: { phase: 'discussing' }, threads: { 'hub/T-1': [reply, answered] }, events: [said] })).turn, 'owner');
});

test('only a discussing card has a turn', () => {
  assert.equal(card(built({ item: { phase: 'grilling' } })).turn, undefined);
});

test('a discussing card is not an arrival: the board launches it no grill', () => {
  const b = built({ item: { phase: 'discussing' }, threads: { 'hub/T-1': [reply] } });
  assert.deepEqual(arrivalsOf(b.items), []);
  assert.deepEqual(arrivalsOf(built({ item: { phase: 'grilling' } }).items), ['hub/T-1']);
});

test('a discussing card the orchestrator sends to grilling or prototyping gets its round from the board', () => {
  const b = built({ item: { phase: 'grilling', round_at: '2026-11-09T11:00:00Z' } });
  assert.deepEqual(roundsDue(b.items), [{ key: 'hub/T-1', kind: 'grill' }]);
});

test("a New task's intake wait says to discuss it by reply, file an Implement ask ready, grill or prototype only on its word, and link a ticket it names", () => {
  const next = card(built()).orchestrator.next;
  assert.match(next, /reply hub\/T-1/);
  assert.match(next, /discussing/);
  assert.match(next, /--phase ready, with --size, for an Implement ask/);
  assert.match(next, /--phase grilling or prototyping only when the ask asks for one/);
  assert.match(next, /--ticket/);
});

// The CLI, on the audit board (data/items.json).
const audit = (...p) => site('audit', ...p);
const auditEvents = (...events) => fs.appendFileSync(audit('data', 'events.jsonl'), events.map((e) => JSON.stringify(e) + '\n').join(''));
const t1 = () => read(audit('data', 'items.json')).items.find((i) => i.id === 'T-1');
async function store() {
  process.env.HOME = home;
  return import('./store.mjs');
}

test('reply on a New card starts its discussion: a message in its thread, the card discussing in Todo; a later reply goes on with it', async () => {
  auditEvents(ask);
  const s = await store();
  await s.fileAsk(audit(), 'a1');
  const r = board('reply', 'audit/T-1', '--text', 'The footer could fold into the sidebar.', '--title', 'Footer rethink', '--site', 'audit');
  assert.deepEqual([r.code, r.err], [0, '']);
  assert.deepEqual([t1().phase, t1().lane, t1().answered_at, t1().title], ['discussing', 'todo', undefined, 'Footer rethink']);
  const again = board('reply', 'audit/T-1', '--text', 'Or stay as it is on desktop.', '--site', 'audit');
  assert.deepEqual([again.code, again.err], [0, '']);
  assert.deepEqual(lines(audit('data', 'threads', 'audit__T-1.jsonl')).filter((m) => !m.kind).map((m) => m.text), ['The footer could fold into the sidebar.', 'Or stay as it is on desktop.']);
  assert.equal(board('item', 'set', 'audit/T-1', '--phase', 'grilling', '--site', 'audit').code, 0);
  assert.match(board('reply', 'audit/T-1', '--text', 'x', '--site', 'audit').err, /sorted \(grilling\)/);
});

test('item set --phase discussing files a card discussing, and leaving it for grilling or prototyping marks the round', async () => {
  auditEvents(ask);
  const s = await store();
  await s.fileAsk(audit(), 'a1');
  const r = board('item', 'set', 'audit/T-1', '--phase', 'discussing', '--site', 'audit');
  assert.deepEqual([r.code, r.err], [0, '']);
  assert.equal(t1().phase, 'discussing');
  const before = new Date().toISOString();
  assert.equal(board('item', 'set', 'audit/T-1', '--phase', 'prototyping', '--site', 'audit').code, 0);
  assert.deepEqual([t1().phase, t1().round_at >= before], ['prototyping', true]);
});

test('item add --phase discussing files a card discussing; ready still comes only from staging', async () => {
  await store();
  const r = board('item', 'add', 'audit/D1', '--title', 'Talk it through', '--phase', 'discussing', '--site', 'audit');
  assert.deepEqual([r.code, r.err], [0, '']);
  assert.equal(read(audit('data', 'items.json')).items.find((i) => i.id === 'D1').phase, 'discussing');
  write(audit('data', 'D1.md'), '# D1\n');
  assert.match(board('item', 'set', 'audit/D1', '--phase', 'ready', '--size', 'small', '--site', 'audit').err, /reads discussing, not staging/);
});

test("item visual asks the board for a visual on a card, a request line of Claude's that answers none of the owner's messages", async () => {
  auditEvents(ask);
  const s = await store();
  await s.fileAsk(audit(), 'a1');
  const r = board('item', 'visual', 'audit/T-1', '--text', 'The footer folded into the sidebar, phone and desktop', '--site', 'audit');
  assert.deepEqual([r.code, r.err], [0, '']);
  assert.match(r.out, /visual asked on/);
  const request = lines(audit('data', 'events.jsonl')).at(-1);
  assert.deepEqual([request.kind, request.data], ['visual-request', { key: 'audit/T-1', text: 'The footer folded into the sidebar, phone and desktop', who: 'claude' }]);
  assert.match(board('item', 'visual', 'audit/T-1', '--site', 'audit').err, /--text/);
  assert.match(board('item', 'visual', 'audit/T-9', '--text', 'x', '--site', 'audit').err, /T-9/);

  const said = { id: 'm1', ts: '2026-11-09T10:10:00Z', kind: 'item-message', data: { key: 'hub/T-1', text: 'Show me?' } };
  const drawn = { id: 'v1', ts: '2026-11-09T10:11:00Z', kind: 'visual-request', data: { key: 'hub/T-1', text: 'The footer, folded', who: 'claude' } };
  const line = threadOf('hub/T-1', { lines: [reply], events: [said, drawn] }).find((m) => m.eventId === 'v1');
  assert.deepEqual([line.who, line.text], ['claude', 'The footer, folded']);
  const b = built({ item: { phase: 'discussing' }, threads: { 'hub/T-1': [reply] }, events: [said, drawn] });
  assert.equal(card(b).turn, 'claude', 'a visual request answers no message');
});

test("the owner's Grill or Prototype tap on a discussing card moves it to that planner's phase; an Implement stages it", async () => {
  auditEvents(ask);
  const s = await store();
  await s.fileAsk(audit(), 'a1');
  board('item', 'set', 'audit/T-1', '--phase', 'discussing', '--site', 'audit');
  await s.planAgain(audit(), 'audit/T-1', 'grill');
  assert.equal(t1().phase, 'grilling');
  board('item', 'set', 'audit/T-1', '--phase', 'discussing', '--site', 'audit');
  await s.stageImplement(audit(), 'audit/T-1', { text: 'Go with the sidebar.' });
  assert.equal(t1().phase, 'staging');
  assert.match(fs.readFileSync(path.join(audit('data'), t1().plan), 'utf8'), /Go with the sidebar\./);
});
