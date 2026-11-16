// docs/adr/2026-11-16-0900-a-card-in-new-takes-no-writes-until-it-is-triaged.md: every command that writes to a card
// still in New refuses until item triage sorts it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { board, home, site, read, write } from './board-fixture.mjs';

const audit = (...p) => site('audit', ...p);
async function newCard() {
  fs.appendFileSync(audit('data', 'events.jsonl'), JSON.stringify({ id: 'a1', ts: '2026-11-15T07:00:00Z', kind: 'ask', data: { text: 'Fix the header\nIt jumps' } }) + '\n');
  process.env.HOME = home;
  return (await import('./store.mjs')).fileAsk(audit(), 'a1');
}
const questions = (key) => { const f = `${home}/q.json`; write(f, [{ id: 'q-one', topic: `item:${key}`, title: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }]); return f; };

test('every write to a card still in New refuses, and works once item triage has sorted it', async () => {
  const key = await newCard();
  const text = `${home}/t.md`;
  write(text, 'hello');
  const commands = () => [
    ['reply', key, '--text', 'hello'],
    ['thread', key, '--text', 'hello'],
    ['item', 'brief', key, '--kind', 'grill', '--file', text],
    ['item', 'set', key, '--size', 'S'],
    ['question', 'add', '--file', questions(key)],
  ];
  for (const c of commands()) {
    const r = await board(...c, '--site', 'audit');
    assert.match(r.err, /audit\/T-1 is still in New: sort it first with item triage audit\/T-1/, c.join(' '));
    assert.notEqual(r.code, 0);
  }
  assert.equal((await board('thread', key, '--text', 'hi', '--who', 'love', '--site', 'audit')).code, 0, 'the owner\'s own line is what a New card is made of');
  assert.equal((await board('item', 'triage', key, '--title', 'fix(board): the header jumps', '--phase', 'discussing', '--site', 'audit')).code, 0);
  for (const c of [commands()[1], commands()[3], commands()[4]]) {
    const r = await board(...c, '--site', 'audit');
    assert.doesNotMatch(r.err, /still in New/, c.join(' '));
  }
  assert.equal(read(audit('data', 'items.json')).items.find((i) => i.id === 'T-1').phase, 'discussing');
});
