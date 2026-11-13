// docs/adr/2026-11-12-0700-reply-implement-marks-a-card-ready-to-implement.md,
// docs/adr/2026-11-12-0800-reply-close-marks-a-card-waiting-to-be-closed.md: the orchestrator's `reply <card> --implement`
// or `--close` (also `thread <card> --implement` or `--close`) marks a card waiting on the owner (waits_on_owner: implement | close).
// The card reads Action needed, its thread's Implement or Done goes orange, and the owner's tap or any message of theirs clears it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildBoard } from './domain.mjs';
import { board, home, site, read } from './board-fixture.mjs';

function built(item = {}) {
  return buildBoard({
    now: Date.parse('2026-11-09T12:00:00Z'), threads: {}, working: {},
    files: [{ slug: 'hub', agents: {}, itemFile: { items: [{ id: 'T-1', title: 'Rethink the footer', created: '2026-11-09T10:00:01Z', lane: 'todo', phase: 'discussing', ...item }] } }],
    prs: {}, owner: {}, events: [],
  });
}
const card = (b) => b.items.find((i) => i.key === 'hub/T-1');

test('a card marked ready to implement reads Action needed in Todo, with the thread as its link, and counts as a need', async () => {
  const c = card(built({ waits_on_owner: { on: 'implement', at: '2026-11-09T11:00:00Z' } }));
  assert.deepEqual([c.lane, c.ownerWait], ['todo', 'implement']);
  assert.deepEqual(c.action, { kind: 'implement', url: '#selectedCard=hub%2FT-1&reply', label: 'Tap Implement' });
  assert.deepEqual(card(built()).action, null);
  assert.equal(card(built()).ownerWait, null);
});

test('a card marked waiting to be closed reads Action needed, Close or Done is its orange resolving button, and a closed card shows none', async () => {
  const mark = { on: 'close', at: '2026-11-09T11:00:00Z' };
  const c = card(built({ lane: 'todo', waits_on_owner: mark }));
  assert.deepEqual([c.lane, c.ownerWait, c.resolvedBy, c.awaitsDone], ['todo', 'close', 'done', false]);
  assert.deepEqual(c.action, { kind: 'close', url: '#selectedCard=hub%2FT-1&reply', label: 'Tap Close' });
  assert.equal(c.next, 'Tap Close');
  assert.equal(card(built({ lane: 'done', phase: undefined, done: '2026-11-09T11:30:00Z', waits_on_owner: mark })).action, null);
});

const audit = (...p) => site('audit', ...p);
const t1 = () => read(audit('data', 'items.json')).items.find((i) => i.id === 'T-1');
async function store() {
  process.env.HOME = home;
  return import('./store.mjs');
}
const ask = { id: 'a1', ts: '2026-11-09T10:00:00Z', kind: 'ask', data: { text: 'Rethink the footer' } };

test('reply --implement and --close post the message and store the mark; the owner\'s tap or any message clears it; a reply without a flag sets none', async () => {
  fs.appendFileSync(audit('data', 'events.jsonl'), JSON.stringify(ask) + '\n');
  const s = await store();
  await s.fileAsk(audit(), 'a1');
  assert.equal((await board('reply', 'audit/T-1', '--text', 'Plain.', '--site', 'audit')).code, 0);
  assert.equal(t1().waits_on_owner, undefined);
  const r = await board('reply', 'audit/T-1', '--text', 'Tap Implement.', '--implement', '--site', 'audit');
  assert.deepEqual([r.code, r.err], [0, '']);
  assert.equal(t1().waits_on_owner.on, 'implement');
  assert.match(t1().waits_on_owner.at, /^\d{4}-/);
  await s.clearOwnerWait(audit(), 'audit/T-1');
  assert.equal(t1().waits_on_owner, undefined);
  const c = await board('reply', 'audit/T-1', '--text', 'Only Done is left.', '--close', '--site', 'audit');
  assert.deepEqual([c.code, c.err], [0, '']);
  assert.equal(t1().waits_on_owner.on, 'close');
  await s.clearOwnerWait(audit(), 'audit/T-1');
  await board('reply', 'audit/T-1', '--text', 'Tap Implement.', '--implement', '--site', 'audit');
  await s.stageImplement(audit(), 'audit/T-1', {});
  assert.equal(t1().waits_on_owner, undefined);
  // The card is staged now, so it is a work card: thread --close marks it.
  const t = await board('thread', 'audit/T-1', '--text', 'Only Done is left.', '--close', '--site', 'audit');
  assert.deepEqual([t.code, t.err], [0, '']);
  assert.equal(t1().waits_on_owner.on, 'close');
  await s.clearOwnerWait(audit(), 'audit/T-1');
  assert.equal(t1().waits_on_owner, undefined);
});

test('--implement and --close are refused on a reply to an event, which has no card to mark, and together', async () => {
  for (const flag of ['--implement', '--close']) {
    const r = await board('reply', 'e1', '--text', 'x', flag, '--site', 'audit');
    assert.notEqual(r.code, 0);
    assert.match(r.err, /--implement and --close/);
  }
  const both = await board('reply', 'audit/T-1', '--text', 'x', '--implement', '--close', '--site', 'audit');
  assert.notEqual(both.code, 0);
  assert.match(both.err, /not both/);
});

test('thread --implement marks any ticket ready to implement, and is refused with --close or for a message that is not the orchestrator\'s', async () => {
  fs.appendFileSync(audit('data', 'events.jsonl'), JSON.stringify(ask) + '\n');
  const s = await store();
  await s.fileAsk(audit(), 'a1');
  const t = await board('thread', 'audit/T-1', '--text', 'Tap Implement.', '--implement', '--site', 'audit');
  assert.deepEqual([t.code, t.err], [0, '']);
  assert.equal(t1().waits_on_owner.on, 'implement');
  await s.clearOwnerWait(audit(), 'audit/T-1');
  const both = await board('thread', 'audit/T-1', '--text', 'x', '--implement', '--close', '--site', 'audit');
  assert.notEqual(both.code, 0);
  assert.match(both.err, /not both/);
  const love = await board('thread', 'audit/T-1', '--text', 'x', '--implement', '--who', 'love', '--site', 'audit');
  assert.notEqual(love.code, 0);
  assert.match(love.err, /--implement/);
  assert.equal(t1().waits_on_owner, undefined);
});

test('thread --close is refused for a message that is not the orchestrator\'s', async () => {
  const r = await board('thread', 'audit/T-1', '--text', 'x', '--close', '--who', 'love', '--site', 'audit');
  assert.notEqual(r.code, 0);
  assert.match(r.err, /--close/);
});

// docs/adr/2026-11-12-2300-a-finished-ask-waits-in-todo-with-an-orange-close.md: an ask already stored In Review stays there until Done.
test('a finished ask card (stored In Review, close mark, no build) reads Action needed in In Review with no phase and no builder', async () => {
  const c = card(built({ lane: 'review', phase: undefined, waits_on_owner: { on: 'close', at: '2026-11-09T11:00:00Z' } }));
  assert.deepEqual([c.lane, c.waitsOn, c.phase, c.builder, c.resolvedBy, c.next], ['review', 'owner', null, null, 'done', 'Tap Done']);
  assert.equal(c.action.kind, 'close');
});

test('item set --done on an ask card no build ran on is refused, pointing at reply --close; reply --close keeps it in Todo until the owner\'s Done closes it', async () => {
  fs.appendFileSync(audit('data', 'events.jsonl'), JSON.stringify(ask) + '\n');
  const s = await store();
  await s.fileAsk(audit(), 'a1');
  const r = await board('item', 'set', 'audit/T-1', '--done', '--text', 'Answered: yes.', '--site', 'audit');
  assert.notEqual(r.code, 0);
  assert.match(r.err, /reply .*--close/);
  assert.deepEqual([t1().waits_on_owner, t1().closed_at], [undefined, undefined]);
  await board('reply', 'audit/T-1', '--text', 'Answered: yes.', '--close', '--site', 'audit');
  assert.deepEqual([t1().lane, t1().waits_on_owner.on, t1().closed_at], [t1().lane, 'close', undefined]);
  assert.notEqual(t1().lane, 'review');
  await s.recordOwnerTap(audit(), 'card-done', { key: 'audit/T-1' });
  assert.deepEqual([t1().lane, t1().waits_on_owner], ['done', undefined]);
});
