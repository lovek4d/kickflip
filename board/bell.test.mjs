// docs/adr/2026-11-26-2300-a-bell-on-a-card-pushes-at-every-stage-of-its-task.md: the owner's bell on a card
// (a card-bell tap) stores a bell as the task's reminder, remind_when every-stage, each set and cancel the owner's line in
// its thread; the board server pushes at each stage change (domain.mjs bellStep; server.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { site, lines, read, write } from './board-fixture.mjs';
import { tapPlan, bellStep } from './domain.mjs';
import { recordOwnerTap } from './cards.mjs';

const items = () => read(site('audit', 'data', 'items.json')).items;
const item = (id) => items().find((it) => it.id === id);
const thread = (id) => {
  const file = site('audit', 'data', 'threads', `audit__${id}.jsonl`);
  return fs.existsSync(file) ? lines(file) : [];
};
const card = (id, extra = {}) => {
  const file = site('audit', 'data', 'items.json');
  write(file, { ...read(file), items: [...read(file).items, { id, title: `feat: ${id}`, lane: 'progress', ...extra }] });
};
const bell = (id, on) => recordOwnerTap(site('audit'), 'card-bell', { key: `audit/${id}`, on, sendId: `s-${id}-${on}` });
const bellLines = (id) => thread(id).filter((m) => m.command === 'belled' || m.command === 'unbelled').map((m) => [m.who, m.text, m.sendId]);

test("the owner's bell sets a reminder on the task, replacing a reminder it has, and the lit bell's tap takes off either, each the owner's line", async () => {
  card('B1');
  assert.ok(await bell('B1', true));
  assert.equal(item('B1').remind_when, 'every-stage');
  assert.equal(await bell('B1', true), null, 'a second bell changes nothing');
  assert.ok(await bell('B1', false));
  assert.equal('remind_when' in item('B1'), false);
  assert.equal(await bell('B1', false), null, 'no reminder, nothing to take off');
  card('B2', { remind_when: 'done' });
  assert.ok(await bell('B2', false), "the lit bell cancels the orchestrator's one-event reminder too");
  assert.equal('remind_when' in item('B2'), false);
  card('B3', { remind_when: 'needs-you' });
  assert.ok(await bell('B3', true));
  assert.equal(item('B3').remind_when, 'every-stage', 'a bell replaces a one-event reminder');
  assert.deepEqual(bellLines('B1'), [['love', 'Bell on', 's-B1-true'], ['love', 'Bell off', 's-B1-false']]);
  assert.deepEqual(bellLines('B2'), [['love', 'Bell off', 's-B2-false']]);
});

test('a bell on a Done task changes nothing', async () => {
  card('B4', { lane: 'done', closed_at: '2026-11-20T00:00:00.000Z' });
  assert.equal(await bell('B4', true), null);
  assert.equal('remind_when' in item('B4'), false);
  assert.deepEqual(bellLines('B4'), []);
});

test("a card-bell tap is written to the item file with no event, refused with why when it changes nothing", () => {
  const tapCard = { key: 'w/A1', ref: '#1', kind: 'work', lane: 'progress' };
  assert.deepEqual(tapPlan(tapCard, 'card-bell', { key: 'w/A1', on: true }), [{ do: 'record', nothing: '#1 already has its bell or is done, so nothing changed.', stops: false }]);
  assert.deepEqual(tapPlan(tapCard, 'card-bell', { key: 'w/A1', on: false }), [{ do: 'record', nothing: '#1 has no bell or reminder, so nothing changed.', stops: false }]);
});

// A built card with its bell and its action as domain.mjs ownerActions reads it.
const belled = (over = {}) => ({ key: 'w/A1', ref: '#7', title: 'Ship the bell', lane: 'progress', remindWhen: 'every-stage', ...over });
const implement = { tag: 'item-w/A1', kind: 'implement', title: '#7: Implement', body: 'Ship the bell', url: '#selectedCard=w%2FA1', questions: [] };
const asking = (...ids) => ({ tag: 'item-w/A1', kind: 'questions', title: `#7: Answer ${ids.length} question`, body: 'Which colour?', url: '#questions=w%2FA1',
  questions: ids.map((id) => ({ id, question: `Question ${id}?` })) });

test('bellStep records a newly belled task without a push, and pushes nothing while its stage stands', () => {
  const first = bellStep([belled()], [], {});
  assert.deepEqual(first.pushes, []);
  assert.deepEqual(first.seen, { 'w/A1': { lane: 'progress', action: null, questions: [] } });
  const again = bellStep([belled()], [], first.seen);
  assert.deepEqual(again.pushes, []);
  assert.deepEqual(again.seen, first.seen);
  assert.deepEqual(bellStep([belled({ remindWhen: 'done' }), belled({ key: 'w/A2', remindWhen: null })], [], {}), { pushes: [], seen: {} }, 'only a bell is diffed');
});

test('bellStep pushes once at each stage change: a lane move, needs you, a question asked, landed', () => {
  let seen = bellStep([belled({ lane: 'todo' })], [], {}).seen;
  const step = (it, actions = []) => {
    const r = bellStep([it], actions, seen);
    seen = r.seen;
    return r.pushes.map(({ title, body, url, last }) => [title, body, url, Boolean(last)]);
  };
  assert.deepEqual(step(belled()), [['#7 moved to In Progress', 'Ship the bell', '#selectedCard=w%2FA1', false]]);
  assert.deepEqual(step(belled()), [], 'unchanged');
  assert.deepEqual(step(belled(), [implement]), [['#7 needs you', 'Implement · Ship the bell', '#selectedCard=w%2FA1', false]]);
  assert.deepEqual(step(belled(), [implement]), [], 'the same wait');
  assert.deepEqual(step(belled(), [asking('q1')]), [['#7 asked a question', 'Question q1?', '#questions=w%2FA1', false]]);
  assert.deepEqual(step(belled(), [asking('q1', 'q2')]), [['#7 asked a question', 'Question q2?', '#questions=w%2FA1', false]], 'each new question');
  assert.deepEqual(step(belled(), [asking('q2')]), [], 'an answer is no stage');
  assert.deepEqual(step(belled(), []), [], 'a wait ending is no stage');
  assert.deepEqual(step(belled({ lane: 'review' }), [implement]), [['#7 needs you', 'Implement · Ship the bell', '#selectedCard=w%2FA1', false]], 'several changes at once push the one that asks most of the owner');
  assert.deepEqual(step(belled({ lane: 'done', commit: { sha: 'abc1234' } })), [['#7 landed', 'Ship the bell', '#selectedCard=w%2FA1', true]]);
  assert.deepEqual(seen, {}, "a done task's bell is gone");
});

test('bellStep reads a task closed without a commit as done, and pushes it even on its first check', () => {
  const r = bellStep([belled({ lane: 'done' })], [], {});
  assert.deepEqual(r.pushes.map((p) => [p.key, p.title, p.last]), [['w/A1', '#7 is done', true]]);
  assert.deepEqual(r.seen, {});
});
