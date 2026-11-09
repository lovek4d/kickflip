// docs/adr/2026-11-09-1500-a-task-is-a-card-with-no-ticket-keyed-t-n.md: a task's grill asks "Create a ticket for this
// task?" with ticket_gate: true, and the board makes the ticket on the owner's yes, at once, from the card's title and
// notes. Linear is faked in process.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeLinear, linearWorld } from '../shared/test-helpers.mjs';

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-gate-')));
process.env.HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));
const { addQuestions, settleAnswers, settleQuestion } = await import('./store.mjs');
const linearData = linearWorld();
const linear = fakeLinear(linearData);
fs.mkdirSync(path.join(home, '.claude', 'kickflip'), { recursive: true });
fs.writeFileSync(path.join(home, '.claude', 'kickflip', 'secrets.json'), JSON.stringify({ linear: { key: linearData.key, workspace: 'Acme', url_key: 'acme', viewer: linearData.viewer } }));

const LINEAR = { source: 'linear', workspace: 'acme', team: 'ENG', project: 'proj-audit' };
const yesNo = [{ id: 'yes', label: 'Yes', recommended: true }, { id: 'no', label: 'No' }];
const other = { id: 'q-other', topic: 'item:t/T-1', question: 'Which?', options: [{ id: 'a', label: 'A' }] };
const gate = { id: 'q-ticket', topic: 'item:t/T-1', question: 'Create a ticket for this task?', options: yesNo, ticket_gate: true };

function world({ tickets = LINEAR, item = {} } = {}) {
  const site = fs.mkdtempSync(path.join(home, 'gate-'));
  const data = path.join(site, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ items: 'data/items.json', slug: 't', ...(tickets ? { tickets } : {}) }));
  fs.writeFileSync(path.join(data, 'T-1-notes.md'), '# Bump the pins\n\nLands code in package.json.\n');
  fs.writeFileSync(path.join(data, 'items.json'), JSON.stringify({ items: [{ id: 'T-1', title: 'Bump the pins', phase: 'grilling', plan: 'T-1-notes.md', ...item }] }));
  fs.writeFileSync(path.join(data, 'owner.json'), JSON.stringify({ topics: [], items: [] }));
  fs.writeFileSync(path.join(data, 'events.jsonl'), '');
  const answer = (id, choice, note = '') => ({ id, choice, note });
  const card = () => JSON.parse(fs.readFileSync(path.join(data, 'items.json'), 'utf8')).items[0];
  const thread = () => fs.readFileSync(path.join(data, 'threads', 't__T-1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const resolved = (id) => JSON.parse(fs.readFileSync(path.join(data, 'owner.json'), 'utf8')).items.find((q) => q.id === id).resolved ?? null;
  return { site, answer, card, thread, resolved };
}

test('a ticket_gate question takes exactly yes and no, on a task on a board with a ticket source', async () => {
  const { site } = world();
  await assert.rejects(addQuestions(site, { ...gate, options: [{ id: 'no', label: 'No' }, { id: 'yes', label: 'Yes' }] }), /ticket_gate takes exactly the options yes and no/);
  await assert.rejects(addQuestions(site, { ...gate, ticket_gate: 'yes' }), /must be true or false/);
  await assert.rejects(addQuestions(world({ tickets: null }).site, gate), /ticket_gate needs a board with a ticket source/);
  await assert.rejects(addQuestions(world({ item: { ticket: 'ENG-9' } }).site, gate), /t\/T-1 already has ticket ENG-9/);
  await addQuestions(site, gate);
});

test("yes makes the ticket at once from the card's title and notes, while another question is still open, and keeps its key", async () => {
  const { site, answer, card, thread, resolved } = world();
  await addQuestions(site, [other, gate]);
  await settleAnswers(site, [answer('q-ticket', 'yes')], { linearFetch: linear.fetch });
  const made = card();
  assert.match(made.ticket, /^ENG-\d+$/);
  assert.deepEqual([made.id, made.ticket_created, made.phase], ['T-1', true, 'grilling']);
  assert.deepEqual(linearData.issues[made.ticket].input.title, 'Bump the pins');
  assert.match(linearData.issues[made.ticket].input.description, /Lands code in package\.json/);
  assert.match(resolved('q-ticket'), /^Ticket: yes/);
  assert.ok(thread().some((l) => l.text === `You asked for a ticket, so the board made ${made.ticket}.`));
});

test('no leaves the task without a ticket', async () => {
  const { site, answer, card, resolved } = world();
  await addQuestions(site, [gate]);
  await settleAnswers(site, [answer('q-ticket', 'no')], { linearFetch: linear.fetch });
  assert.equal(card().ticket, undefined);
  assert.match(resolved('q-ticket'), /^Ticket: no/);
});

test("a ticket the source can't make leaves the card a task, with a fault line saying why", async () => {
  const { site, answer, card, thread } = world();
  await addQuestions(site, [gate]);
  const keyFile = path.join(home, '.claude', 'kickflip', 'secrets.json');
  const key = fs.readFileSync(keyFile, 'utf8');
  fs.rmSync(keyFile);
  try { await settleAnswers(site, [answer('q-ticket', 'yes')], { linearFetch: linear.fetch }); } finally { fs.writeFileSync(keyFile, key); }
  assert.equal(card().ticket, undefined);
  assert.ok(thread().some((l) => l.line === 'answers-failed' && /making its ticket failed: Hub has no Linear key/.test(l.text)), JSON.stringify(thread()));
});

test("the ticket question is the owner's: the orchestrator can't settle it", async () => {
  const { site } = world();
  const staged = path.join(site, 'data', 'staged-questions.json');
  fs.writeFileSync(staged, JSON.stringify({ 't/T-1': [gate] }));
  fs.writeFileSync(path.join(site, 'data', 'screening.json'), JSON.stringify({ 't/T-1': new Date().toISOString() }));
  await assert.rejects(settleQuestion(site, 'q-ticket', 'No ticket.'), /is the card's ticket question, which is the owner's/);
});
