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

test('a card marked waiting to be closed reads Action needed, Done is its orange resolving button, and a closed card shows none', async () => {
  const mark = { on: 'close', at: '2026-11-09T11:00:00Z' };
  const c = card(built({ lane: 'todo', waits_on_owner: mark }));
  assert.deepEqual([c.lane, c.ownerWait, c.resolvedBy, c.awaitsDone], ['todo', 'close', 'done', false]);
  assert.deepEqual(c.action, { kind: 'close', url: '#selectedCard=hub%2FT-1&reply', label: 'Tap Done' });
  assert.equal(c.next, 'Tap Done');
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

test('item set --done is refused on an ask only a planner ran on, and goes through once a build record exists', async () => {
  fs.appendFileSync(audit('data', 'events.jsonl'), JSON.stringify(ask) + '\n');
  const s = await store();
  await s.fileAsk(audit(), 'a1');
  const agent = audit('data', 'agents', 'T-1.json');
  fs.mkdirSync(path.dirname(agent), { recursive: true });
  fs.writeFileSync(agent, JSON.stringify({ kind: 'grill', started: '2026-11-09T10:05:00Z', done: '2026-11-09T10:10:00Z' }));
  const planned = await board('item', 'set', 'audit/T-1', '--done', '--text', 'Answered: yes.', '--site', 'audit');
  assert.notEqual(planned.code, 0);
  assert.match(planned.err, /reply .*--close/);
  fs.writeFileSync(agent, JSON.stringify({ kind: 'build', started: '2026-11-09T10:05:00Z', done: '2026-11-09T10:10:00Z' }));
  const built = await board('item', 'set', 'audit/T-1', '--done', '--text', 'Built.', '--site', 'audit');
  assert.doesNotMatch(built.err, /no build ran on/);
});

// docs/adr/2026-11-15-0800-owner-actions-follow-state-gone-pushes-close-stale-taps-refused.md
// Rule A: what the owner owes comes only from the card's state. The mark holds the phase and lane it was set in and
// stands only while both do; Implement is owed only from new or discussing.
test('a mark stands only while the card keeps the phase and lane it was set in, and Implement is owed only from new or discussing', () => {
  const mark = (on, phase, lane = 'todo') => ({ on, at: '2026-11-09T11:00:00Z', phase, lane });
  assert.equal(card(built({ waits_on_owner: mark('implement', 'discussing') })).action.kind, 'implement');
  assert.equal(card(built({ phase: undefined, waits_on_owner: mark('implement', 'new') })).action.kind, 'implement');
  for (const phase of ['staging', 'ready']) {
    const moved = card(built({ phase, waits_on_owner: mark('implement', 'discussing') }));
    assert.deepEqual([moved.ownerWait, moved.action], [null, null], `a ${phase} card owes nothing from a discussing mark`);
    const markedThere = card(built({ phase, waits_on_owner: mark('implement', phase) }));
    assert.deepEqual([markedThere.ownerWait, markedThere.action], ['implement', null], `Implement is never owed on a ${phase} card`);
  }
  assert.equal(card(built({ phase: 'staging', waits_on_owner: mark('close', 'staging') })).action.kind, 'close');
  assert.equal(card(built({ lane: 'review', phase: undefined, waits_on_owner: mark('close', 'new', 'todo') })).ownerWait, null, 'a lane change ends it too');
  // A mark from before marks held their phase reads as it always did, Implement still only from new or discussing.
  assert.equal(card(built({ waits_on_owner: { on: 'implement', at: '2026-11-09T11:00:00Z' } })).action.kind, 'implement');
  assert.equal(card(built({ phase: 'ready', waits_on_owner: { on: 'implement', at: '2026-11-09T11:00:00Z' } })).action, null);
});

const setT1 = (fields) => {
  const file = audit('data', 'items.json');
  const f = read(file);
  Object.assign(f.items.find((i) => i.id === 'T-1'), fields);
  fs.writeFileSync(file, JSON.stringify(f));
};

test('reply and thread --implement mark the phase and lane they were set in; thread --implement on a staged, ready or started card is refused and marks nothing', async () => {
  fs.appendFileSync(audit('data', 'events.jsonl'), JSON.stringify(ask) + '\n');
  const s = await store();
  await s.fileAsk(audit(), 'a1');
  await board('reply', 'audit/T-1', '--text', 'Tap Implement.', '--implement', '--site', 'audit');
  assert.deepEqual([t1().waits_on_owner.phase, t1().waits_on_owner.lane], ['discussing', t1().lane]);
  await s.clearOwnerWait(audit(), 'audit/T-1');
  for (const [phase, words] of [['staging', 'already staged'], ['ready', 'already ready']]) {
    setT1({ phase });
    const r = await board('thread', 'audit/T-1', '--text', 'Tap Implement.', '--implement', '--site', 'audit');
    assert.notEqual(r.code, 0);
    assert.match(r.err, new RegExp(words));
    assert.equal(t1().waits_on_owner, undefined);
  }
  setT1({ phase: undefined, lane: 'progress' });
  const started = await board('thread', 'audit/T-1', '--text', 'Tap Implement.', '--implement', '--site', 'audit');
  assert.notEqual(started.code, 0);
  assert.match(started.err, /already in progress/);
  const close = await board('thread', 'audit/T-1', '--text', 'Only Done is left.', '--close', '--site', 'audit');
  assert.deepEqual([close.code, t1().waits_on_owner.on, t1().waits_on_owner.lane], [0, 'close', 'progress']);
});

// Rule D: the words and the flag agree. A reply or thread line that asks the owner to tap Implement needs --implement,
// one that asks them to tap Done needs --close; the flag with no such words is fine.
test('a reply or thread line asking the owner to tap Implement or Done is refused without its flag, and posts nothing', async () => {
  fs.appendFileSync(audit('data', 'events.jsonl'), JSON.stringify(ask) + '\n');
  const s = await store();
  await s.fileAsk(audit(), 'a1');
  const file = audit('data', 'threads', 'audit__T-1.jsonl');
  const lines = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0);
  for (const [args, flag] of [[['reply', 'audit/T-1', '--text', 'Three parts. Tap Implement.'], '--implement'], [['thread', 'audit/T-1', '--text', 'Shipped; tap done.'], '--close'], [['thread', 'audit/T-1', '--text', 'Nothing to build, so Tap Done.'], '--close']]) {
    const before = lines();
    const r = await board(...args, '--site', 'audit');
    assert.notEqual(r.code, 0, args.join(' '));
    assert.match(r.err, new RegExp(flag));
    assert.equal(lines(), before, 'nothing is posted');
  }
  const flagged = await board('reply', 'audit/T-1', '--text', 'Three parts. Tap Implement.', '--implement', '--site', 'audit');
  assert.deepEqual([flagged.code, flagged.err], [0, '']);
  await s.clearOwnerWait(audit(), 'audit/T-1');
  const bare = await board('reply', 'audit/T-1', '--text', 'Three parts, ready when you are.', '--implement', '--site', 'audit');
  assert.deepEqual([bare.code, bare.err], [0, '']);
  const plain = await board('thread', 'audit/T-1', '--text', 'The tap target is the Done button in review.', '--site', 'audit');
  assert.equal(plain.code, 0, 'naming a button without asking for a tap is fine');
});
