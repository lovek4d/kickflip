import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { site, lines, board, read, write } from './board-fixture.mjs';

// docs/adr/2026-11-16-0946-a-link-onto-a-card-awaiting-a-reply-needs-that-reply-first.md
const thread = (id) => (fs.existsSync(site('audit', 'data', 'threads', `audit__${id}.jsonl`)) ? lines(site('audit', 'data', 'threads', `audit__${id}.jsonl`)).map(({ ts, ...m }) => m) : []);
const card = (id) => {
  const file = site('audit', 'data', 'items.json');
  write(file, { ...read(file), items: [...read(file).items, { id, title: `feat: ${id.toLowerCase()}`, lane: 'todo', phase: 'discussing' }] });
};
// The owner's message on card id waits on the orchestrator's reply, as the board server lists it.
const awaiting = (id, since = '2026-11-16T09:00:00.000Z') => write(site('audit', 'data', 'orchestrator-waits.json'), { waits: [{ key: `audit/${id}`, ref: id, title: id, kind: 'reply', since }] });
const cli = (...args) => board(...args, '--site', 'audit');
const askFrom = async (...args) => {
  const r = await cli('item', 'add', 'audit', '--ask', 'A follow-up', ...args);
  assert.equal(r.code, 0, r.err);
  return /added as audit\/(T-\d+)/.exec(r.out)[1];
};
const said = (m) => (m.command ? `${m.command} ${m.card}` : m.text);

test('a link onto a card awaiting a reply is refused without --reply-on, naming the card and the flag; with it the reply comes first, then the link line', async () => {
  card('W1');
  awaiting('W1');
  const refused = await cli('item', 'add', 'audit', '--ask', 'A follow-up', '--parent', 'W1');
  assert.equal(refused.code, 1);
  assert.match(refused.err, /audit\/W1 waits on your reply to the owner: pass --reply-on "<your reply>"/);
  assert.deepEqual(thread('W1'), [], 'a refusal writes nothing');
  const child = await askFrom('--parent', 'W1', '--reply-on', 'Filed it as a follow-up.');
  assert.deepEqual(thread('W1').map(said), ['Filed it as a follow-up.', `created audit/${child}`]);
  assert.equal(thread('W1')[0].who, 'claude');
  // That reply answered the owner; their next message waits again, and --relate on item set and item triage, and
  // --blocked-by, refuse the same way.
  awaiting('W1', new Date().toISOString());
  card('W2');
  for (const args of [['item', 'set', 'audit/W2', '--relate', 'W1'], ['item', 'set', 'audit/W2', '--blocked-by', 'W1'], ['item', 'triage', `audit/${child}`, '--title', 'feat: child', '--phase', 'grilling', '--relate', 'W1']]) {
    const r = await cli(...args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err, /audit\/W1 waits on your reply to the owner: pass --reply-on/, args.join(' '));
  }
  // The orchestrator's message on the card since the owner's ends the wait, before the board's list catches up.
  assert.equal((await cli('thread', 'audit/W1', '--text', 'Answered.')).code, 0);
  assert.equal((await cli('item', 'set', 'audit/W2', '--relate', 'W1')).code, 0);
  assert.deepEqual(thread('W1').slice(-2).map(said), ['Answered.', 'related audit/W2']);
});

test('--reply-on with no linked card awaiting a reply is refused, as it would write nowhere', async () => {
  card('Q1'); card('Q2');
  const r = await cli('item', 'set', 'audit/Q2', '--relate', 'Q1', '--reply-on', 'Hi');
  assert.equal(r.code, 1);
  assert.match(r.err, /--reply-on writes your reply on a linked card the owner waits on, and none of the cards linked does/);
  // A link onto a card nobody awaits is as before.
  assert.equal((await cli('item', 'set', 'audit/Q2', '--relate', 'Q1')).code, 0);
  assert.deepEqual(thread('Q1').map(said), ['related audit/Q2']);
});

test("a task filed in New posts its Filed line, not Related to, on the other card at triage, not at item add, after the orchestrator's reply there", async () => {
  card('R1');
  const child = await askFrom('--relate', 'R1');
  assert.deepEqual(thread('R1'), [], 'the owner cannot open a New task yet');
  assert.deepEqual(thread(child).map(said), [], 'the new card draws its Filed from line from its ask, and stores none');
  assert.equal((await cli('thread', 'audit/R1', '--text', 'Filed a follow-up.')).code, 0);
  assert.equal((await cli('item', 'triage', `audit/${child}`, '--title', 'feat: child', '--phase', 'grilling')).code, 0);
  assert.deepEqual(thread('R1').map(said), ['Filed a follow-up.', `filed audit/${child}`]);
  assert.equal(thread(child).filter((m) => m.command === 'related').length, 0);
});

test("--from alone links the two cards: the filing card reads Filed, the new one reads Filed from, and a second related card keeps Related to", async () => {
  card('F1'); card('F2');
  const child = await askFrom('--from', 'F1', '--relate', 'F2');
  assert.equal((await cli('item', 'triage', `audit/${child}`, '--title', 'feat: child', '--phase', 'grilling')).code, 0);
  assert.deepEqual(thread('F1').map(said), [`filed audit/${child}`]);
  assert.deepEqual(thread('F2').map(said), [`related audit/${child}`]);
  assert.deepEqual(thread(child).map(said), [`related audit/F2`]);
});

test("thread, reply and item text naming a T-<n> this board hasn't made yet is refused, until item add makes it", async () => {
  card('N1');
  const next = Number(/T-(\d+)/.exec(await askFrom('--relate', 'N1'))[1]) + 1;
  for (const args of [['thread', 'audit/N1', '--text', `Filed it as T-${next}.`], ['reply', 'audit/N1', '--text', `See audit/T-${next + 3}.`]]) {
    const r = await cli(...args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err, /T-\d+ doesn't exist yet: file it first and name the key item add printed/);
  }
  // The owner's quoted words and the cards that exist are fine.
  assert.equal((await cli('thread', 'audit/N1', '--text', `You said "T-${next}", and T-${next - 1} has it.`)).code, 0);
  const made = await askFrom('--relate', 'N1');
  assert.equal(made, `T-${next}`);
  assert.equal((await cli('thread', 'audit/N1', '--text', `Filed it as T-${next}.`)).code, 0);
});
