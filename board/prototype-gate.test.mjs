import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addQuestions, settleAnswers } from './store.mjs';

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
  const answer = (id, choice, note = '') => {
    const a = { id, choice, note };
    fs.appendFileSync(path.join(data, 'events.jsonl'), JSON.stringify({ id: `e-${id}`, ts: new Date().toISOString(), kind: 'owner-answer', data: a }) + '\n');
    return a;
  };
  const read = () => JSON.parse(fs.readFileSync(path.join(data, 'wave.json'), 'utf8')).items[0];
  const item = (fields) => fs.writeFileSync(path.join(data, 'wave.json'), JSON.stringify({ items: [{ ...read(), ...fields }] }));
  const card = () => read().state;
  const notes = (file) => fs.readFileSync(path.join(data, file), 'utf8');
  const thread = () => fs.readFileSync(path.join(data, 'threads', 't__A1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const resolved = (id) => JSON.parse(fs.readFileSync(path.join(data, 'owner.json'), 'utf8')).items.find((q) => q.id === id).resolved ?? null;
  // A question written straight into owner.json, as a prototype planner's would be once its prototype is recorded.
  const put = (q) => {
    const owner = JSON.parse(fs.readFileSync(path.join(data, 'owner.json'), 'utf8'));
    fs.writeFileSync(path.join(data, 'owner.json'), JSON.stringify({ ...owner, items: [...owner.items, q] }));
  };
  return { site, answer, read, item, card, notes, thread, resolved, put };
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
  assert.deepEqual(await settleAnswers(site, [answer('q-other', 'a'), answer('q-gate', 'yes')]), { prototype: ['t/A1'], staged: [] });
  assert.equal(card(), 'prototyping');
  assert.match(resolved('q-gate'), /^Prototype round: yes/);
});

// docs/adr/2026-11-07-0700-staging-then-ready.md
test('no stages the card once its other questions are answered, in either order', async () => {
  const first = world();
  await addQuestions(first.site, [other, gate]);
  assert.deepEqual(await settleAnswers(first.site, [first.answer('q-gate', 'no')]), { prototype: [], staged: [] });
  assert.equal(first.card(), 'grilling', 'q-other is still open');
  assert.deepEqual(await settleAnswers(first.site, [first.answer('q-other', 'a')]), { prototype: [], staged: ['t/A1'] });
  assert.equal(first.card(), 'staging');
  assert.ok(first.read().staged_at);

  const last = world();
  await addQuestions(last.site, [other, gate]);
  await settleAnswers(last.site, [last.answer('q-other', 'a')]);
  assert.equal(last.card(), 'grilling');
  await settleAnswers(last.site, [last.answer('q-gate', 'no')]);
  assert.equal(last.card(), 'staging');
  assert.equal(last.thread().at(-1).text, 'Staging: your answers are in its notes; the orchestrator judges them next.');
});

test('a gate asked alone, answered no, stages the card; yes leaves a card no longer grilling alone', async () => {
  const alone = world();
  await addQuestions(alone.site, gate);
  await settleAnswers(alone.site, [alone.answer('q-gate', 'no')]);
  assert.equal(alone.card(), 'staging');

  const moved = world('prototyping');
  await addQuestions(moved.site, [other, gate]);
  assert.deepEqual(await settleAnswers(moved.site, [moved.answer('q-gate', 'yes')]), { prototype: [], staged: [] });
  assert.equal(moved.card(), 'prototyping');
});

test('a Send that leaves an unstarted card with nothing open stages it, a note-only answer included; no take picked, a running planner or a started card leaves it', async () => {
  const noted = world('prototyping');
  await addQuestions(noted.site, other);
  await settleAnswers(noted.site, [noted.answer('q-other', null, 'Neither, follow quiet hours')]);
  assert.equal(noted.card(), 'staging', 'the orchestrator judges a note-only answer from staging');

  const take = { id: 'q-take', topic: 'item:t/A1', question: 'Which take?', url: 'prototype-look.html?q=q-take', options: [{ id: 'A', label: 'Badge' }, { id: 'B', label: 'Dot' }] };
  const none = world('prototyping');
  none.put(take);
  assert.deepEqual(await settleAnswers(none.site, [none.answer('q-take', null, 'Neither')]), { prototype: [], staged: [] });
  assert.equal(none.card(), 'prototyping', 'no take picked, so it prototypes again');
  none.put({ ...take, id: 'q-take-2', url: 'prototype-look.html?q=q-take-2' });
  await settleAnswers(none.site, [none.answer('q-take-2', 'B')]);
  assert.equal(none.card(), 'staging');

  const running = world();
  await addQuestions(running.site, other);
  fs.mkdirSync(path.join(running.site, 'data', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(running.site, 'data', 'agents', 'A1.json'), JSON.stringify({ kind: 'prototype', started: new Date().toISOString() }));
  await settleAnswers(running.site, [running.answer('q-other', 'a')]);
  assert.equal(running.card(), 'grilling', 'a planner still runs on it');

  const started = world();
  await addQuestions(started.site, other);
  started.item({ lane: 'progress' });
  await settleAnswers(started.site, [started.answer('q-other', 'a')]);
  assert.equal(started.card(), 'grilling');
});

test('every answer on a card goes into its notes verbatim, in a file the board makes when the card has none', async () => {
  const { site, answer, notes } = world();
  await addQuestions(site, [other, gate]);
  await settleAnswers(site, [answer('q-other', 'a', 'Bigger, "please"'), answer('q-gate', 'no')]);
  const added = notes('notes.md').split('\n## ')[1];
  assert.match(added, /^Answers \(owner, \d\d\/\d\d \d\d:\d\d\)\n/);
  assert.deepEqual(added.split('\n').slice(1).filter(Boolean), ['- q-other (Which?): A. Note, verbatim: "Bigger, "please""', '- q-gate (Prototype round first?): No.']);

  const bare = world();
  bare.item({ plan: undefined });
  await addQuestions(bare.site, other);
  await settleAnswers(bare.site, [bare.answer('q-other', null, 'Only a note')]);
  assert.equal(bare.read().plan, 'a1-notes.md');
  assert.match(bare.notes('a1-notes.md'), /^# Card\n\n## Answers \(owner, .*\)\n- q-other \(Which\?\): no option picked\. Note, verbatim: "Only a note"\n$/);
});

// docs/adr/2026-11-08-0900-send-records-once-and-follow-ups-fail-on-their-own.md
test('a card whose notes file is gone gets a fresh one at the same path with its answers, and a thread line says so', async () => {
  const gone = world('grilling');
  fs.rmSync(path.join(gone.site, 'data', 'notes.md'));
  await settleAnswers(gone.site, [(await addQuestions(gone.site, other), gone.answer('q-other', 'a', 'Bigger'))]);
  assert.equal(gone.read().plan, 'notes.md');
  assert.match(gone.notes('notes.md'), /^# Card\n[\s\S]*## Answers \(owner, [^)]*\)\n- q-other \(Which\?\): A\. Note, verbatim: "Bigger"/);
  assert.ok(gone.thread().some((m) => /notes file notes.md was missing/.test(m.text)));
});

test('a follow-up that fails on one card posts its reason to that card and leaves the other cards settled', async () => {
  const w = world('grilling');
  const wave = JSON.parse(fs.readFileSync(path.join(w.site, 'data', 'wave.json'), 'utf8'));
  fs.writeFileSync(path.join(w.site, 'data', 'wave.json'), JSON.stringify({ items: [{ ...wave.items[0], plan: '../escaped.md' }, { id: 'A2', title: 'Second', state: 'grilling', size: 'small', plan: 'notes.md' }] }));
  await addQuestions(w.site, other);
  await addQuestions(w.site, { ...other, id: 'q-second', topic: 'item:t/A2' });
  const result = await settleAnswers(w.site, [w.answer('q-other', 'a'), w.answer('q-second', 'a')]);
  assert.match(w.thread().at(-1).text, /Your answers were recorded.*leaves the folder/);
  assert.match(w.notes('notes.md'), /q-second/);
  assert.deepEqual(result.staged, ['t/A2']);
});
