// docs/adr/2026-11-24-2300-every-slack-message-on-a-task-waits-on-a-reply.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBoard, orchestratorWaits } from './domain.mjs';

const at = (minute) => `2026-11-24T10:${String(minute).padStart(2, '0')}:00.000Z`;
const built = ({ items, events = [], threads = {}, working = {} }) => buildBoard({ now: Date.parse(at(59)), owner: {}, events, threads, working, delivered: {},
  files: [{ slug: 'w', agents: {}, itemFile: { internal: true, items } }] });
const waits = (snapshot) => orchestratorWaits(built(snapshot)).map(({ key, kind, since, next }) => [key, kind, since, next]);
const kinds = (snapshot) => waits(snapshot).map((w) => [w[1], w[2]]);
const stateOf = (snapshot, id) => built(snapshot).threadViews['w/A1'].find((m) => m.eventId === id)?.state;
// The @kickflip ask a teammate sent in Slack, and the card it became.
const ask = { id: 'ea', ts: at(1), kind: 'ask', data: { text: 'can you take a look at https://github.com/o/r/pull/7', routed: { via: 'slack', at: at(1), by: 'Sam', link: 'https://acme.slack.com/a', slack: { channel: 'D1', ts: '1.1' } } } };
const card = (item = {}) => ({ id: 'A1', title: 'Review PR 7', created: at(1), from_ask: 'ea', phase: 'discussing', sorted_at: at(2), lane: 'todo', waits_on_owner: { on: 'implement', at: at(3), phase: 'discussing', lane: 'todo' }, ...item });
// A later Slack reply the hub copied onto the task.
const copied = (minute, rest = {}) => ({ id: `s${minute}`, ts: at(minute), kind: 'item-message', data: { key: 'w/A1', text: 'thanks!', sendId: `slack:D1:${minute}.0`, slack: { by: 'Sam', link: 'https://acme.slack.com/b', thread: { channel: 'D1', thread_ts: '1.1' } } }, reply: null, ...rest });
const line = (minute) => ({ ts: at(minute), who: 'claude', text: 'Posted the review on the PR.' });
const NEXT = (id) => `Answer Sam in Slack: reply ${id} --text "<the outcome: the answer, the review link, the task filed>", which posts to its Slack thread; a message that needs no words (a thanks) takes reply ${id} --no-reply`;

test('each Slack message on a task opens its own slack wait, which no thread line ends: only its reply, its no-reply mark or the card closing', () => {
  assert.deepEqual(waits({ items: [card()], events: [ask, copied(5)] }), [['w/A1', 'slack', at(1), NEXT('ea')], ['w/A1', 'slack', at(5), NEXT('s5')]]);
  // A thread line, a status line or a later reply to the other message leaves each open.
  assert.deepEqual(kinds({ items: [card()], events: [ask, copied(5)], threads: { 'w/A1': [line(8)] } }), [['slack', at(1)], ['slack', at(5)]]);
  assert.deepEqual(kinds({ items: [card()], events: [{ ...ask, reply: { at: at(6), md: 'Posted: https://github.com/o/r/pull/7#pullrequestreview-1' } }, copied(5)] }), [['slack', at(5)]], 'a reply ends its own');
  assert.deepEqual(kinds({ items: [card({ no_reply: { s5: at(9) } })], events: [ask, copied(5)] }), [['slack', at(1)]], 'a no-reply mark ends its own');
  assert.deepEqual(kinds({ items: [card({ lane: 'done', phase: 'closed', closed_at: at(9) })], events: [ask, copied(5)] }), [], 'Done');
  // In every open lane, In Review too.
  assert.deepEqual(kinds({ items: [card({ lane: 'review', phase: 'ready' })], events: [ask] }), [['slack', at(1)]]);
});

test("a Slack message opens no owner's reply wait, and the owner's own board message still does beside it", () => {
  const board = { id: 'm7', ts: at(7), kind: 'item-message', data: { key: 'w/A1', text: 'Hold off' }, reply: null };
  assert.deepEqual(kinds({ items: [card()], events: [ask, copied(5), board] }), [['slack', at(1)], ['slack', at(5)], ['reply', at(7)]]);
  assert.deepEqual(kinds({ items: [card()], events: [ask, copied(5), board], threads: { 'w/A1': [line(8)] } }), [['slack', at(1)], ['slack', at(5)]], "a line answers the owner's alone");
});

test("the owner's own Slack message is the owner's word as well: it opens their reply wait beside its slack wait, which a line ends alone", () => {
  const own = copied(5, { data: { ...copied(5).data, slack: { link: 'https://acme.slack.com/b' } } });
  assert.deepEqual(kinds({ items: [card()], events: [ask, own] }), [['slack', at(1)], ['reply', at(5)], ['slack', at(5)]]);
  assert.deepEqual(kinds({ items: [card()], events: [ask, own], threads: { 'w/A1': [line(8)] } }), [['slack', at(1)], ['slack', at(5)]]);
});

test('a slack wait is picked up from its working mark, and lists with the owner\'s words, ahead of the lanes\' waits', () => {
  const picked = orchestratorWaits(built({ items: [card()], events: [ask], working: { ea: at(4) } })).find((w) => w.kind === 'slack');
  assert.equal(picked.picked, at(4));
  const staged = { id: 'A2', title: 'Two', lane: 'todo', phase: 'staging', staged_at: at(0) };
  assert.deepEqual(waits({ items: [staged, card()], events: [ask] }).map((w) => [w[0], w[1]]), [['w/A1', 'slack'], ['w/A2', 'staging']]);
});

test('a Slack message in the thread reads waiting, or thinking once picked up, until its reply, whatever the orchestrator writes after it', () => {
  assert.equal(stateOf({ items: [card()], events: [ask], threads: { 'w/A1': [line(8)] } }, 'ea'), 'waiting');
  assert.equal(stateOf({ items: [card()], events: [ask], working: { ea: at(4) }, threads: { 'w/A1': [line(8)] } }, 'ea'), 'working');
  assert.equal(stateOf({ items: [card()], events: [{ ...ask, reply: { at: at(6), md: 'Done.' } }] }, 'ea'), 'replied');
  assert.equal(stateOf({ items: [card({ no_reply: { s5: at(9) } })], events: [ask, copied(5)] }, 's5'), 'answered');
  // The owner's board message still reads answered once a line follows it.
  const board = { id: 'm7', ts: at(7), kind: 'item-message', data: { key: 'w/A1', text: 'Hold off' }, reply: null };
  assert.equal(stateOf({ items: [card()], events: [ask, board], threads: { 'w/A1': [line(8)] } }, 'm7'), 'answered');
});
