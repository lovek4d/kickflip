// docs/adr/2026-11-12-0500-a-new-task-is-a-conversation.md: a Discuss task gets a reply, not a grill. The card stays in
// Todo reading discussing, whose turn it is shows on it, and grill, prototype, visual and Implement lead out of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildBoard, arrivalsOf, PHASES } from './domain.mjs';
import { board, home, site, read, write, lines } from './board-fixture.mjs';

const ask = { id: 'a1', ts: '2026-11-09T10:00:00Z', kind: 'ask', data: { text: 'Rethink the footer' } };
function built({ item = {}, events = [], threads = {}, working = {} } = {}) {
  return buildBoard({
    now: Date.parse('2026-11-09T12:00:00Z'), threads, working,
    files: [{ slug: 'hub', agents: {}, itemFile: { items: [{ id: 'T-1', title: 'Rethink the footer', created: '2026-11-09T10:00:01Z', lane: 'todo', from_ask: 'a1', ...item }] } }],
    prs: {}, owner: {}, events: [ask, ...events],
  });
}
const card = (b) => b.items.find((i) => i.key === 'hub/T-1');
const reply = { ts: '2026-11-09T10:05:00Z', who: 'claude', text: 'Here is what I understand…' };

test("discussing is Todo's phase after new, before grilling", () => {
  assert.deepEqual([...PHASES.todo], ['new', 'discussing', 'grilling', 'prototyping', 'staging', 'ready']);
});

test("a discussing card stays in Todo, never goes to In Review, and reads the owner's turn after the orchestrator's reply", () => {
  const b = built({ item: { phase: 'discussing' }, threads: { 'hub/T-1': [reply] } });
  const c = card(b);
  assert.deepEqual([c.lane, c.phase, c.turn, Boolean(c.isNew), c.awaitsDone, c.orchestrator], ['todo', 'discussing', 'owner', false, false, null]);
  assert.deepEqual(b.answers, []);
});

test("an owner's message on a discussing card makes it the orchestrator's turn, and waits on the orchestrator", () => {
  const said = { id: 'm1', ts: '2026-11-09T10:10:00Z', kind: 'item-message', data: { key: 'hub/T-1', text: 'And on mobile?' } };
  const c = card(built({ item: { phase: 'discussing' }, threads: { 'hub/T-1': [reply] }, events: [said] }));
  assert.deepEqual([c.lane, c.turn], ['todo', 'claude']);
  const answered = { ...reply, ts: '2026-11-09T10:12:00Z', text: 'On mobile it stacks.' };
  assert.equal(card(built({ item: { phase: 'discussing' }, threads: { 'hub/T-1': [reply, answered] }, events: [said] })).turn, 'owner');
});

test('only a discussing card has a turn', () => {
  assert.equal(card(built({ item: { phase: 'grilling' } })).turn, undefined);
});

test('a discussing card is not an arrival: the board launches it no grill', () => {
  const b = built({ item: { phase: 'discussing' }, threads: { 'hub/T-1': [reply] } });
  assert.deepEqual(arrivalsOf(b.items), []);
  assert.deepEqual(arrivalsOf(built({ item: { phase: 'grilling' } }).items), ['hub/T-1']);
});

test("a New task's intake wait says to discuss it by reply, file an Implement ask ready, grill or prototype only on its word, and link a ticket it names", () => {
  const next = card(built()).orchestrator.next;
  assert.match(next, /reply hub\/T-1/);
  assert.match(next, /discussing/);
  assert.match(next, /--phase ready, with --size, for an Implement ask/);
  assert.match(next, /--phase grilling or prototyping only when the ask asks for one/);
  assert.match(next, /--ticket/);
});

// The CLI, on the audit board (data/items.json).
const audit = (...p) => site('audit', ...p);
const auditEvents = (...events) => fs.appendFileSync(audit('data', 'events.jsonl'), events.map((e) => JSON.stringify(e) + '\n').join(''));
const t1 = () => read(audit('data', 'items.json')).items.find((i) => i.id === 'T-1');
async function store() {
  process.env.HOME = home;
  return import('./store.mjs');
}

test('reply on a New card starts its discussion: a message in its thread, the card discussing in Todo; a later reply goes on with it', async () => {
  auditEvents(ask);
  const s = await store();
  await s.fileAsk(audit(), 'a1');
  const r = board('reply', 'audit/T-1', '--text', 'The footer could fold into the sidebar.', '--title', 'feat: footer rethink', '--site', 'audit');
  assert.deepEqual([r.code, r.err], [0, '']);
  assert.deepEqual([t1().phase, t1().lane, t1().answered_at, t1().title], ['discussing', 'todo', undefined, 'feat: footer rethink']);
  const again = board('reply', 'audit/T-1', '--text', 'Or stay as it is on desktop.', '--site', 'audit');
  assert.deepEqual([again.code, again.err], [0, '']);
  assert.deepEqual(lines(audit('data', 'threads', 'audit__T-1.jsonl')).filter((m) => !m.kind).map((m) => m.text), ['The footer could fold into the sidebar.', 'Or stay as it is on desktop.']);
  assert.equal(board('item', 'set', 'audit/T-1', '--phase', 'grilling', '--site', 'audit').code, 0);
  assert.match(board('reply', 'audit/T-1', '--text', 'x', '--site', 'audit').err, /sorted \(grilling\)/);
});

test("item set --phase discussing files a card discussing, and leaving it for grilling or prototyping owes the orchestrator's brief for the round", async () => {
  auditEvents(ask);
  const s = await store();
  await s.fileAsk(audit(), 'a1');
  const r = board('item', 'set', 'audit/T-1', '--phase', 'discussing', '--site', 'audit');
  assert.deepEqual([r.code, r.err], [0, '']);
  assert.equal(t1().phase, 'discussing');
  const before = new Date().toISOString();
  assert.equal(board('item', 'set', 'audit/T-1', '--phase', 'prototyping', '--site', 'audit').code, 0);
  assert.deepEqual([t1().phase, t1().briefs.map((b) => b.kind), t1().briefs[0].at >= before, t1().round_at], ['prototyping', ['prototype'], true, undefined]);
  assert.equal(board('item', 'set', 'audit/T-1', '--phase', 'prototyping', '--site', 'audit').code, 0);
  assert.equal(t1().briefs.length, 1, 'staying in the phase owes no second brief');
});

test('item add --phase discussing files a card discussing; ready still comes only from staging', async () => {
  await store();
  const r = board('item', 'add', 'audit/D1', '--title', 'feat: talk it through', '--phase', 'discussing', '--site', 'audit');
  assert.deepEqual([r.code, r.err], [0, '']);
  assert.equal(read(audit('data', 'items.json')).items.find((i) => i.id === 'D1').phase, 'discussing');
  write(audit('data', 'D1.md'), '# D1\n');
  assert.match(board('item', 'set', 'audit/D1', '--phase', 'ready', '--size', 'small', '--site', 'audit').err, /reads discussing, not staging/);
});

// docs/adr/2026-11-12-0600-every-planner-launches-from-the-orchestrators-brief.md
test("item brief writes the orchestrator's brief into the notes as \"Brief for <kind> round N\" and onto what the card owes; a grill or prototype brief moves the card to that phase, a visual's leaves it", async () => {
  auditEvents(ask);
  const s = await store();
  await s.fileAsk(audit(), 'a1');
  board('item', 'set', 'audit/T-1', '--phase', 'discussing', '--site', 'audit');
  await s.planAgain(audit(), 'audit/T-1', 'grill', { text: 'Ask about mobile' });
  assert.equal(t1().phase, 'grilling');
  assert.deepEqual(t1().briefs.map(({ kind, ask: asked, brief }) => [kind, asked, brief]), [['grill', { text: 'Ask about mobile' }, undefined]]);
  const draft = path.join(home, 'brief.md');
  fs.writeFileSync(draft, 'Settled: the footer folds into the sidebar.\nOpen: how it reads on a phone.\n');
  const r = board('item', 'brief', 'audit/T-1', '--kind', 'grill', '--file', draft, '--site', 'audit');
  assert.deepEqual([r.code, r.err], [0, '']);
  assert.match(r.out, /"Brief for grill round 1" added to its notes; the board launches its grill planner from it/);
  const notes = () => fs.readFileSync(path.join(audit('data'), t1().plan), 'utf8');
  assert.match(notes(), /## Brief for grill round 1\nSettled: the footer folds into the sidebar\.\nOpen: how it reads on a phone\.\n/);
  const [grill] = t1().briefs;
  assert.deepEqual([grill.kind, grill.ask, grill.brief.heading, grill.brief.text], ['grill', { text: 'Ask about mobile' }, 'Brief for grill round 1', 'Settled: the footer folds into the sidebar.\nOpen: how it reads on a phone.']);

  // A brief nobody asked for: the orchestrator's own visual, the phase left as it is; the next of a kind is its round 2.
  assert.equal(board('item', 'brief', 'audit/T-1', '--kind', 'visual', '--file', draft, '--site', 'audit').code, 0);
  assert.equal(board('item', 'brief', 'audit/T-1', '--kind', 'visual', '--file', draft, '--site', 'audit').code, 0);
  assert.deepEqual(t1().briefs.map((b) => [b.kind, b.brief.heading, 'ask' in b]), [['grill', 'Brief for grill round 1', true], ['visual', 'Brief for visual round 1', false], ['visual', 'Brief for visual round 2', false]]);
  assert.equal(t1().phase, 'grilling');
  board('item', 'set', 'audit/T-1', '--phase', 'discussing', '--site', 'audit');
  assert.equal(board('item', 'brief', 'audit/T-1', '--kind', 'prototype', '--file', draft, '--site', 'audit').code, 0);
  assert.equal(t1().phase, 'prototyping');

  assert.match(board('item', 'brief', 'audit/T-1', '--kind', 'build', '--file', draft, '--site', 'audit').err, /--kind grill, prototype or visual/);
  assert.match(board('item', 'brief', 'audit/T-1', '--kind', 'grill', '--site', 'audit').err, /--file <draft.md>/);
  assert.match(board('item', 'brief', 'audit/T-9', '--kind', 'grill', '--file', draft, '--site', 'audit').err, /T-9/);
  assert.match(board('item', 'brief', 'audit/T-1', '--kind', 'grill', '--file', path.join(audit('data'), t1().plan), '--site', 'audit').err, /notes file of/);
  assert.match(board('item', 'visual', 'audit/T-1', '--text', 'x', '--site', 'audit').err, /unknown|item visual/i, 'item visual is gone: item brief --kind visual replaces it');
});

test("the board's start of a planner or visual agent takes the oldest written brief of its kind off the card onto its record, and refuses a card with none", async () => {
  auditEvents(ask);
  const s = await store();
  await s.fileAsk(audit(), 'a1');
  board('item', 'set', 'audit/T-1', '--phase', 'discussing', '--site', 'audit');
  await s.planAgain(audit(), 'audit/T-1', 'grill', { text: 'Ask about mobile' });
  await assert.rejects(s.startPlanner(audit(), 'audit/T-1', 'grill'), /has no grill brief; the orchestrator writes it with item brief audit\/T-1 --kind grill --file <draft.md>/);
  await assert.rejects(s.startVisual(audit(), 'audit/T-1'), /has no visual brief/);
  assert.equal(fs.existsSync(audit('data', 'agents', 'T-1.json')), false, 'a refused start opens no record');
  const draft = path.join(home, 'brief.md');
  fs.writeFileSync(draft, 'Cover the phone layout.');
  board('item', 'brief', 'audit/T-1', '--kind', 'grill', '--file', draft, '--site', 'audit');
  const started = await s.startPlanner(audit(), 'audit/T-1', 'grill');
  assert.deepEqual([started.kind, started.text, started.brief.heading, started.brief.text], ['grill', 'Ask about mobile', 'Brief for grill round 1', 'Cover the phone layout.']);
  assert.equal(t1().briefs, undefined, 'the brief left the card');
  const record = read(audit('data', 'agents', 'T-1.json'));
  assert.deepEqual([record.kind, record.dispatched, record.brief.brief.heading, record.brief.ask], ['grill', 'hub', 'Brief for grill round 1', { text: 'Ask about mobile' }]);
  // The planner's own builder start keeps the brief on its record, for a Resume after a Hold.
  assert.equal(board('builder', 'start', 'audit/T-1', '--kind', 'grill', '--site', 'audit').code, 0);
  assert.equal(read(audit('data', 'agents', 'T-1.json')).brief.brief.text, 'Cover the phone layout.');

  board('item', 'brief', 'audit/T-1', '--kind', 'visual', '--file', draft, '--site', 'audit');
  const visual = await s.startVisual(audit(), 'audit/T-1');
  assert.match(visual.agent, /^visual-\d+$/);
  assert.equal(read(audit('data', 'agents', `T-1@${visual.agent}.json`)).brief.brief.heading, 'Brief for visual round 1');
});

test("a planner's or visual agent's record is written once, so no read of it shows a kind without its brief", async () => {
  auditEvents(ask);
  const s = await store();
  await s.fileAsk(audit(), 'a1');
  board('item', 'set', 'audit/T-1', '--phase', 'discussing', '--site', 'audit');
  const draft = path.join(home, 'brief.md');
  fs.writeFileSync(draft, 'Cover the phone layout.');
  const agents = audit('data', 'agents');
  // Reads every record under agents/ as often as the event loop allows while start runs; true per read that has a kind.
  const watch = async (start) => {
    const reads = [];
    let running = true;
    const poll = (async () => {
      while (running) {
        for (const f of fs.existsSync(agents) ? fs.readdirSync(agents) : []) {
          try { const r = JSON.parse(fs.readFileSync(path.join(agents, f), 'utf8')); if (r.kind) reads.push(Boolean(r.brief)); } catch { /* a file mid-write */ }
        }
        await new Promise((r) => setImmediate(r));
      }
    })();
    try { await start(); } finally { running = false; await poll; }
    return reads;
  };
  await s.planAgain(audit(), 'audit/T-1', 'grill', { text: 'Ask about mobile' });
  board('item', 'brief', 'audit/T-1', '--kind', 'grill', '--file', draft, '--site', 'audit');
  const grill = await watch(() => s.startPlanner(audit(), 'audit/T-1', 'grill'));
  assert.ok(grill.length && grill.every(Boolean), 'the planner record always has its brief');
  board('item', 'brief', 'audit/T-1', '--kind', 'visual', '--file', draft, '--site', 'audit');
  const visual = await watch(() => s.startVisual(audit(), 'audit/T-1'));
  assert.ok(visual.every(Boolean), 'the visual record always has its brief');
});

test("the owner's Grill or Prototype tap on a discussing card moves it to that planner's phase; an Implement stages it", async () => {
  auditEvents(ask);
  const s = await store();
  await s.fileAsk(audit(), 'a1');
  board('item', 'set', 'audit/T-1', '--phase', 'discussing', '--site', 'audit');
  await s.planAgain(audit(), 'audit/T-1', 'grill');
  assert.equal(t1().phase, 'grilling');
  board('item', 'set', 'audit/T-1', '--phase', 'discussing', '--site', 'audit');
  await s.stageImplement(audit(), 'audit/T-1', { text: 'Go with the sidebar.' });
  assert.equal(t1().phase, 'staging');
  assert.match(fs.readFileSync(path.join(audit('data'), t1().plan), 'utf8'), /Go with the sidebar\./);
});

// docs/adr/2026-11-12-0800-a-written-brief-wakes-the-board-and-going-discussing-drops-owed-briefs.md
test('item brief appends a brief-written event and posts "<Kind> requested" for a brief nobody tapped for; one answering a tap posts no line', async () => {
  auditEvents(ask);
  const s = await store();
  await s.fileAsk(audit(), 'a1');
  board('item', 'set', 'audit/T-1', '--phase', 'discussing', '--site', 'audit');
  const draft = path.join(home, 'brief.md');
  fs.writeFileSync(draft, 'Settled: a phone layout.');
  const thread = () => lines(audit('data', 'threads', 'audit__T-1.jsonl')).filter((l) => l.command);
  const events = () => lines(audit('data', 'events.jsonl')).filter((e) => e.kind === 'brief-written');
  assert.equal(board('item', 'brief', 'audit/T-1', '--kind', 'prototype', '--file', draft, '--site', 'audit').code, 0);
  assert.deepEqual(events().map((e) => e.data), [{ key: 'audit/T-1', kind: 'prototype' }]);
  assert.deepEqual(thread().filter((l) => l.command === 'prototype').map((l) => [l.who, l.text]), [['claude', 'Prototype requested']]);
  await s.planAgain(audit(), 'audit/T-1', 'grill', { text: 'Ask about mobile' });
  assert.equal(board('item', 'brief', 'audit/T-1', '--kind', 'grill', '--file', draft, '--site', 'audit').code, 0);
  assert.equal(events().length, 2);
  assert.equal(thread().filter((l) => l.command === 'grill').length, 0, "the owner's tap wrote that line");
  // A bare Visual tap (no text) is the owner's request too: its brief adds no second line.
  await s.planAgain(audit(), 'audit/T-1', 'visual');
  assert.equal(board('item', 'brief', 'audit/T-1', '--kind', 'visual', '--file', draft, '--site', 'audit').code, 0);
  assert.equal(thread().filter((l) => l.command === 'visual').length, 0, "a bare tap's brief posts no line");
});

test('a card set to discussing, by item set or a reply, drops its unwritten briefs and keeps the written ones', async () => {
  auditEvents(ask);
  const s = await store();
  await s.fileAsk(audit(), 'a1');
  await s.oweBrief(audit(), 'audit/T-1', 'grill');
  assert.equal(t1().briefs.length, 1);
  assert.equal(board('reply', 'audit/T-1', '--text', 'Talk first.', '--site', 'audit').code, 0);
  assert.deepEqual([t1().phase, t1().briefs], ['discussing', undefined]);
  await s.oweBrief(audit(), 'audit/T-1', 'grill');
  const draft = path.join(home, 'brief.md');
  fs.writeFileSync(draft, 'Settled.');
  assert.equal(board('item', 'brief', 'audit/T-1', '--kind', 'visual', '--file', draft, '--site', 'audit').code, 0);
  assert.equal(board('item', 'set', 'audit/T-1', '--phase', 'discussing', '--site', 'audit').code, 0);
  assert.deepEqual(t1().briefs.map((b) => b.kind), ['visual'], 'the unwritten grill goes, the written visual stays');
});
