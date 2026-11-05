import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addQuestions, settleGates } from './store.mjs';

// docs/adr/2026-11-06-0130-every-grill-ends-with-a-prototype-question-the-board-acts-on.md
const yesNo = [{ id: 'yes', label: 'Yes', recommended: true }, { id: 'no', label: 'No' }];
const other = { id: 'q-other', topic: 'item:t/A1', question: 'Which?', options: [{ id: 'a', label: 'A' }] };
const gate = { id: 'q-gate', topic: 'item:t/A1', question: 'Prototype round first?', options: yesNo, prototype_gate: true };

function world(state = 'grilling') {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  const data = path.join(site, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ items: 'data/wave.json', slug: 't' }));
  fs.writeFileSync(path.join(data, 'notes.md'), 'q-other: A\n');
  fs.writeFileSync(path.join(data, 'wave.json'), JSON.stringify({ items: [{ id: 'A1', title: 'Card', state, size: 'small', plan: 'notes.md' }] }));
  fs.writeFileSync(path.join(data, 'owner.json'), JSON.stringify({ topics: [], items: [] }));
  fs.writeFileSync(path.join(data, 'events.jsonl'), '');
  const answer = (id, choice) => {
    const a = { id, choice };
    fs.appendFileSync(path.join(data, 'events.jsonl'), JSON.stringify({ id: `e-${id}`, ts: new Date().toISOString(), kind: 'owner-answer', data: a }) + '\n');
    return a;
  };
  const card = () => JSON.parse(fs.readFileSync(path.join(data, 'wave.json'), 'utf8')).items[0].state;
  const resolved = (id) => JSON.parse(fs.readFileSync(path.join(data, 'owner.json'), 'utf8')).items.find((q) => q.id === id).resolved ?? null;
  return { site, answer, card, resolved };
}

test('a prototype_gate question takes exactly yes and no, on a card', async () => {
  const { site } = world();
  await assert.rejects(addQuestions(site, { ...gate, options: [{ id: 'no', label: 'No' }, { id: 'yes', label: 'Yes' }] }), /takes exactly the options yes and no/);
  fs.writeFileSync(path.join(site, 'data', 'owner.json'), JSON.stringify({ topics: [{ id: 'general', title: 'General' }], items: [] }));
  await assert.rejects(addQuestions(site, { ...gate, topic: 'general' }), /goes on a card's topic/);
  await assert.rejects(addQuestions(site, { ...gate, prototype_gate: 'yes' }), /must be true or false/);
  await addQuestions(site, gate);
});

test('yes moves a grilling card to prototyping and asks for its prototype planner, resolving the question', async () => {
  const { site, answer, card, resolved } = world();
  await addQuestions(site, [other, gate]);
  assert.deepEqual(await settleGates(site, [answer('q-gate', 'yes')]), { prototype: ['t/A1'] });
  assert.equal(card(), 'prototyping');
  assert.match(resolved('q-gate'), /^Prototype round: yes/);
});

test('no moves the card to ready once its other questions are answered, in either order', async () => {
  const first = world();
  await addQuestions(first.site, [other, gate]);
  assert.deepEqual(await settleGates(first.site, [first.answer('q-gate', 'no')]), { prototype: [] });
  assert.equal(first.card(), 'grilling', 'q-other is still open');
  await settleGates(first.site, [first.answer('q-other', 'a')]);
  assert.equal(first.card(), 'ready');

  const last = world();
  await addQuestions(last.site, [other, gate]);
  await settleGates(last.site, [last.answer('q-other', 'a')]);
  assert.equal(last.card(), 'grilling');
  await settleGates(last.site, [last.answer('q-gate', 'no')]);
  assert.equal(last.card(), 'ready');
});

test('a gate asked alone, answered no, readies the card; a card no longer grilling is left alone', async () => {
  const alone = world();
  await addQuestions(alone.site, gate);
  await settleGates(alone.site, [alone.answer('q-gate', 'no')]);
  assert.equal(alone.card(), 'ready');

  const moved = world('prototyping');
  await addQuestions(moved.site, gate);
  assert.deepEqual(await settleGates(moved.site, [moved.answer('q-gate', 'yes')]), { prototype: [] });
  assert.equal(moved.card(), 'prototyping');
});
