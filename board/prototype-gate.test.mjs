import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addQuestions, resolveQuestion, settleAnswers } from './store.mjs';

// docs/adr/2026-11-06-0130-every-grill-ends-with-a-prototype-question-the-board-acts-on.md
const yesNo = [{ id: 'yes', label: 'Yes', recommended: true }, { id: 'no', label: 'No' }];
const other = { id: 'q-other', topic: 'item:t/A1', question: 'Which?', options: [{ id: 'a', label: 'A' }] };
const gate = { id: 'q-gate', topic: 'item:t/A1', question: 'Prototype round first?', options: yesNo, prototype_gate: true };

function world(phase = 'grilling') {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  const data = path.join(site, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ items: 'data/items.json', slug: 't' }));
  fs.writeFileSync(path.join(data, 'notes.md'), 'q-other: A\n');
  fs.writeFileSync(path.join(data, 'items.json'), JSON.stringify({ items: [{ id: 'A1', title: 'Card', phase, size: 'small', plan: 'notes.md' }] }));
  fs.writeFileSync(path.join(data, 'owner.json'), JSON.stringify({ topics: [], items: [] }));
  fs.writeFileSync(path.join(data, 'events.jsonl'), '');
  const answer = (id, choice, note = '') => {
    const a = { id, choice, note };
    fs.appendFileSync(path.join(data, 'events.jsonl'), JSON.stringify({ id: `e-${id}`, ts: new Date().toISOString(), kind: 'owner-answer', data: a }) + '\n');
    return a;
  };
  const read = () => JSON.parse(fs.readFileSync(path.join(data, 'items.json'), 'utf8')).items[0];
  const item = (fields) => fs.writeFileSync(path.join(data, 'items.json'), JSON.stringify({ items: [{ ...read(), ...fields }] }));
  const card = () => read().phase;
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
  await assert.rejects(addQuestions(site, { ...gate, options: [{ id: 'no', label: 'No' }, { id: 'yes', label: 'Yes' }] }), /takes exactly the options yes, no, in that order/);
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

// docs/adr/2026-11-07-1213-a-grill-waits-for-every-answer-before-it-changes-phase.md
test('yes waits for every question: the card stays grilling while another is open and moves to prototyping on the Send that answers the last, in either order', async () => {
  const first = world();
  await addQuestions(first.site, [other, gate]);
  assert.deepEqual(await settleAnswers(first.site, [first.answer('q-gate', 'yes')]), { prototype: [], staged: [] });
  assert.equal(first.card(), 'grilling', 'q-other is still open');
  assert.match(first.resolved('q-gate'), /^Prototype round: yes/);
  assert.equal(first.thread().at(-1).text, 'Prototype round asked: it moves to prototyping once every question is answered.');
  assert.deepEqual(await settleAnswers(first.site, [first.answer('q-other', 'a')]), { prototype: ['t/A1'], staged: [] });
  assert.equal(first.card(), 'prototyping');
  assert.equal(first.thread().at(-1).text, 'You asked for a prototype round, so the board moved the card to prototyping.');

  const last = world();
  await addQuestions(last.site, [other, gate]);
  await settleAnswers(last.site, [last.answer('q-other', 'a')]);
  assert.equal(last.card(), 'grilling');
  assert.deepEqual(await settleAnswers(last.site, [last.answer('q-gate', 'yes')]), { prototype: ['t/A1'], staged: [] });
  assert.equal(last.card(), 'prototyping');
});

test("a remaining question the orchestrator resolves counts as answered: the grilling card moves on as a Send would, and owes the orchestrator's prototype brief", async () => {
  const yes = world();
  await addQuestions(yes.site, [other, gate]);
  await settleAnswers(yes.site, [yes.answer('q-gate', 'yes', 'Show it as a badge, so Which? is settled')]);
  await resolveQuestion(yes.site, 'q-other', 'Settled by your note on q-gate');
  assert.equal(yes.card(), 'prototyping');
  // docs/adr/2026-11-12-0600-every-planner-launches-from-the-orchestrators-brief.md: the board launches its planner from the brief.
  assert.deepEqual(yes.read().briefs.map((b) => [b.kind, b.brief]), [['prototype', undefined]]);

  const no = world();
  await addQuestions(no.site, [other, gate]);
  await settleAnswers(no.site, [no.answer('q-gate', 'no')]);
  await resolveQuestion(no.site, 'q-other', 'Settled by your note');
  assert.equal(no.card(), 'staging');

  const prototyping = world('prototyping');
  await addQuestions(prototyping.site, other);
  await resolveQuestion(prototyping.site, 'q-other', 'Not needed');
  assert.equal(prototyping.card(), 'prototyping', 'a card not grilling keeps its phase');
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
  assert.deepEqual([last.thread().at(-1).command, last.thread().at(-1).text], ['staged', 'Marked as staging']);
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

test('a Send that leaves an unstarted card with nothing open stages it, a note-only answer included, and returns a prototyping card to discussing; no take picked, a running planner or a started card leaves it', async () => {
  const noted = world();
  await addQuestions(noted.site, other);
  await settleAnswers(noted.site, [noted.answer('q-other', null, 'Neither, follow quiet hours')]);
  assert.equal(noted.card(), 'staging', 'the orchestrator judges a note-only answer from staging');

  // docs/adr/2026-11-12-0500-a-new-task-is-a-conversation.md: a prototype round's answer goes back to the conversation.
  const talked = world('prototyping');
  await addQuestions(talked.site, other);
  assert.deepEqual(await settleAnswers(talked.site, [talked.answer('q-other', 'a')]), { prototype: [], staged: [] });
  assert.equal(talked.card(), 'discussing');
  assert.equal(talked.thread().at(-1).text, 'Marked as discussing');
  const discussing = world('discussing');
  await addQuestions(discussing.site, other);
  await settleAnswers(discussing.site, [discussing.answer('q-other', 'a')]);
  assert.equal(discussing.card(), 'discussing', "a discussion's own question keeps it discussing");

  const take = { id: 'q-take', topic: 'item:t/A1', question: 'Which take?', url: 'prototype-look.html?q=q-take', options: [{ id: 'A', label: 'Badge' }, { id: 'B', label: 'Dot' }] };
  const none = world('prototyping');
  none.put(take);
  assert.deepEqual(await settleAnswers(none.site, [none.answer('q-take', null, 'Neither')]), { prototype: [], staged: [] });
  assert.equal(none.card(), 'prototyping', 'no take picked, so it prototypes again');
  none.put({ ...take, id: 'q-take-2', url: 'prototype-look.html?q=q-take-2' });
  await settleAnswers(none.site, [none.answer('q-take-2', 'B')]);
  assert.equal(none.card(), 'discussing', 'a picked take goes back to the conversation');

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
  assert.ok(gone.thread().some((m) => /^Its notes file was missing, so the board started a new one\.$/.test(m.text)));
});

test('a follow-up that fails on one card posts its reason to that card and leaves the other cards settled', async () => {
  const w = world('grilling');
  const wave = JSON.parse(fs.readFileSync(path.join(w.site, 'data', 'items.json'), 'utf8'));
  fs.writeFileSync(path.join(w.site, 'data', 'items.json'), JSON.stringify({ items: [{ ...wave.items[0], plan: '../escaped.md' }, { id: 'A2', title: 'Second', phase: 'grilling', size: 'small', plan: 'notes.md' }] }));
  await addQuestions(w.site, other);
  await addQuestions(w.site, { ...other, id: 'q-second', topic: 'item:t/A2' });
  const result = await settleAnswers(w.site, [w.answer('q-other', 'a'), w.answer('q-second', 'a')]);
  assert.match(w.thread().at(-1).text, /^Answers recorded, but writing them into its notes failed: a notes file is/);
  assert.match(w.notes('notes.md'), /q-second/);
  assert.deepEqual(result.staged, ['t/A2']);
});
