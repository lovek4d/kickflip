// docs/adr/2026-11-12-0500-a-new-task-is-a-conversation.md: a Discuss task gets a reply, not a grill. The card stays in
// Todo reading discussing, whose turn it is shows on it, and grill, prototype, visual and Implement lead out of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildBoard, PHASES } from './domain.mjs';
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

test("discussing is Todo's phase after new, before grilling", async () => {
  assert.deepEqual([...PHASES.todo], ['new', 'discussing', 'grilling', 'prototyping', 'staging', 'ready']);
});

test("a discussing card stays in Todo, never goes to In Review, and reads the owner's turn after the orchestrator's reply", async () => {
  const b = built({ item: { phase: 'discussing' }, threads: { 'hub/T-1': [reply] } });
  const c = card(b);
  // docs/adr/2026-11-15-1600-a-card-owing-nobody-or-with-the-owners-word-last-waits-on-the-orchestrator.md: with no
  // Implement mark or question after the reply, it owes nobody anything, so it waits on the orchestrator as limbo.
  assert.deepEqual([c.lane, c.phase, c.turn, Boolean(c.isNew), c.awaitsDone, c.orchestrator?.kind], ['todo', 'discussing', 'owner', false, false, 'limbo']);
  assert.deepEqual(b.answers, []);
});

test("an owner's message on a discussing card makes it the orchestrator's turn, and waits on the orchestrator", async () => {
  const said = { id: 'm1', ts: '2026-11-09T10:10:00Z', kind: 'item-message', data: { key: 'hub/T-1', text: 'And on mobile?' } };
  const c = card(built({ item: { phase: 'discussing' }, threads: { 'hub/T-1': [reply] }, events: [said] }));
  assert.deepEqual([c.lane, c.turn], ['todo', 'claude']);
  const answered = { ...reply, ts: '2026-11-09T10:12:00Z', text: 'On mobile it stacks.' };
  assert.equal(card(built({ item: { phase: 'discussing' }, threads: { 'hub/T-1': [reply, answered] }, events: [said] })).turn, 'owner');
});

test('only a discussing card has a turn', async () => {
  assert.equal(card(built({ item: { phase: 'grilling' } })).turn, undefined);
});


// docs/adr/2026-11-15-0730-a-new-task-is-triaged-in-one-command-before-it-is-investigated.md
test("a New task's intake wait says to triage it first into discussing, a grill, a prototype or a visual, linking a ticket it names, then to discuss it by reply and file an Implement ask ready", async () => {
  const next = card(built()).orchestrator.next;
  assert.match(next, /^Triage the new task first/);
  assert.match(next, /item triage hub\/T-1 .*--phase discussing\|grilling\|prototyping\|visual/);
  assert.match(next, /--ticket/);
  assert.match(next, /reply hub\/T-1/);
  assert.match(next, /for an Implement ask, the checks a staged task gets \(check that no open or merged task already covers it .*\), then item set hub\/T-1 --phase ready with --size/);
});

// The CLI, on the audit board (data/items.json).
const audit = (...p) => site('audit', ...p);
const auditEvents = (...events) => fs.appendFileSync(audit('data', 'events.jsonl'), events.map((e) => JSON.stringify(e) + '\n').join(''));
const t1 = () => read(audit('data', 'items.json')).items.find((i) => i.id === 'T-1');
async function store() {
  process.env.HOME = home;
  return import('./store.mjs');
}
// docs/adr/2026-11-16-0900-a-card-in-new-takes-no-writes-until-it-is-triaged.md: a New card is sorted by item triage.
const triage = (key, phase = 'discussing') => board('item', 'triage', key, '--title', 'fix(board): the footer', '--phase', phase, '--site', 'audit');

test('reply on a triaged card is a message in its thread, the card discussing in Todo; a later reply goes on with it', async () => {
  auditEvents(ask);
  const s = await store();
  await s.fileAsk(audit(), 'a1');
  await triage('audit/T-1');
  const r =await board('reply', 'audit/T-1', '--text', 'The footer could fold into the sidebar.', '--title', 'feat: footer rethink', '--site', 'audit');
  assert.deepEqual([r.code, r.err], [0, '']);
  assert.deepEqual([t1().phase, t1().lane, t1().answered_at, t1().title], ['discussing', 'todo', undefined, 'feat: footer rethink']);
  const again = await board('reply', 'audit/T-1', '--text', 'Or stay as it is on desktop.', '--site', 'audit');
  assert.deepEqual([again.code, again.err], [0, '']);
  assert.deepEqual(lines(audit('data', 'threads', 'audit__T-1.jsonl')).filter((m) => !m.kind).map((m) => m.text), ['The footer could fold into the sidebar.', 'Or stay as it is on desktop.']);
  assert.equal((await board('item', 'set', 'audit/T-1', '--phase', 'grilling', '--site', 'audit')).code, 0);
  assert.match((await board('reply', 'audit/T-1', '--text', 'x', '--site', 'audit')).err, /sorted \(grilling\)/);
});

test("item triage --phase discussing files a card discussing, and leaving it for grilling or prototyping owes the orchestrator's brief for the round", async () => {
  auditEvents(ask);
  const s = await store();
  await s.fileAsk(audit(), 'a1');
  const r = await triage('audit/T-1');
  assert.deepEqual([r.code, r.err], [0, '']);
  assert.equal(t1().phase, 'discussing');
  const before = new Date().toISOString();
  assert.equal((await board('item', 'set', 'audit/T-1', '--phase', 'prototyping', '--site', 'audit')).code, 0);
  assert.deepEqual([t1().phase, t1().briefs.map((b) => b.kind), t1().briefs[0].at >= before, t1().round_at], ['prototyping', ['prototype'], true, undefined]);
  assert.equal((await board('item', 'set', 'audit/T-1', '--phase', 'prototyping', '--site', 'audit')).code, 0);
  assert.equal(t1().briefs.length, 1, 'staying in the phase owes no second brief');
});

test('item add --phase discussing files a card discussing; ready still comes only from staging', async () => {
  await store();
  const r = await board('item', 'add', 'audit/D1', '--relate', 'audit/A1', '--title', 'feat: talk it through', '--phase', 'discussing', '--text', 'First message.', '--site', 'audit');
  assert.deepEqual([r.code, r.err], [0, '']);
  assert.equal(read(audit('data', 'items.json')).items.find((i) => i.id === 'D1').phase, 'discussing');
  write(audit('data', 'D1.md'), '# D1\n');
  assert.match((await board('item', 'set', 'audit/D1', '--phase', 'ready', '--size', 'small', '--site', 'audit')).err, /reads discussing, not staging/);
});

// docs/adr/2026-11-12-0600-every-planner-launches-from-the-orchestrators-brief.md
test("item brief writes the orchestrator's brief into the notes as \"Brief for <kind> round N\" and onto what the card owes; a grill or prototype brief moves the card to that phase, a visual's leaves it", async () => {
  auditEvents(ask);
  const s = await store();
  await s.fileAsk(audit(), 'a1');
  await triage('audit/T-1');
  await s.planAgain(audit(), 'audit/T-1', 'grill', { text: 'Ask about mobile' });
  assert.equal(t1().phase, 'grilling');
  assert.deepEqual(t1().briefs.map(({ kind, ask: asked, brief }) => [kind, asked, brief]), [['grill', { text: 'Ask about mobile' }, undefined]]);
  const draft = path.join(home, 'brief.md');
  fs.writeFileSync(draft, 'Settled: the footer folds into the sidebar.\nOpen: how it reads on a phone.\n');
  const r = await board('item', 'brief', 'audit/T-1', '--kind', 'grill', '--file', draft, '--site', 'audit');
  assert.deepEqual([r.code, r.err], [0, '']);
  assert.match(r.out, /"Brief for grill round 1" added to its notes; the board launches its grill planner from it/);
  const notes = () => fs.readFileSync(path.join(audit('data'), t1().plan), 'utf8');
  assert.match(notes(), /## Brief for grill round 1\nSettled: the footer folds into the sidebar\.\nOpen: how it reads on a phone\.\n/);
  const [grill] = t1().briefs;
  assert.deepEqual([grill.kind, grill.ask, grill.brief.heading, grill.brief.text], ['grill', { text: 'Ask about mobile' }, 'Brief for grill round 1', 'Settled: the footer folds into the sidebar.\nOpen: how it reads on a phone.']);

  // A brief nobody asked for: the orchestrator's own visual, the phase left as it is; the next of a kind is its round 2.
  assert.equal((await board('item', 'brief', 'audit/T-1', '--kind', 'visual', '--file', draft, '--site', 'audit')).code, 0);
  assert.equal((await board('item', 'brief', 'audit/T-1', '--kind', 'visual', '--file', draft, '--site', 'audit')).code, 0);
  assert.deepEqual(t1().briefs.map((b) => [b.kind, b.brief.heading, 'ask' in b]), [['grill', 'Brief for grill round 1', true], ['visual', 'Brief for visual round 1', false], ['visual', 'Brief for visual round 2', false]]);
  assert.equal(t1().phase, 'grilling');
  await board('item', 'set', 'audit/T-1', '--phase', 'discussing', '--site', 'audit');
  assert.equal((await board('item', 'brief', 'audit/T-1', '--kind', 'prototype', '--file', draft, '--site', 'audit')).code, 0);
  assert.equal(t1().phase, 'prototyping');

  assert.match((await board('item', 'brief', 'audit/T-1', '--kind', 'build', '--file', draft, '--site', 'audit')).err, /--kind grill, prototype, visual or reviewer/);
  assert.match((await board('item', 'brief', 'audit/T-1', '--kind', 'grill', '--site', 'audit')).err, /--file <draft.md>/);
  assert.match((await board('item', 'brief', 'audit/T-9', '--kind', 'grill', '--file', draft, '--site', 'audit')).err, /T-9/);
  assert.match((await board('item', 'brief', 'audit/T-1', '--kind', 'grill', '--file', path.join(audit('data'), t1().plan), '--site', 'audit')).err, /notes file of/);
  assert.match((await board('item', 'visual', 'audit/T-1', '--text', 'x', '--site', 'audit')).err, /unknown|item visual/i, 'item visual is gone: item brief --kind visual replaces it');
});

test("the board's start of a planner or visual agent takes the oldest written brief of its kind off the card onto its record, and refuses a card with none", async () => {
  auditEvents(ask);
  const s = await store();
  await s.fileAsk(audit(), 'a1');
  await triage('audit/T-1');
  await s.planAgain(audit(), 'audit/T-1', 'grill', { text: 'Ask about mobile' });
  await assert.rejects(s.startPlanner(audit(), 'audit/T-1', 'grill'), /has no grill brief; the orchestrator writes it with item brief audit\/T-1 --kind grill --file <draft.md>/);
  await assert.rejects(s.startVisual(audit(), 'audit/T-1'), /has no visual brief/);
  assert.equal(fs.existsSync(audit('data', 'agents', 'T-1.json')), false, 'a refused start opens no record');
  const draft = path.join(home, 'brief.md');
  fs.writeFileSync(draft, 'Cover the phone layout.');
  await board('item', 'brief', 'audit/T-1', '--kind', 'grill', '--file', draft, '--site', 'audit');
  const started = await s.startPlanner(audit(), 'audit/T-1', 'grill');
  assert.deepEqual([started.kind, started.text, started.brief.heading, started.brief.text], ['grill', 'Ask about mobile', 'Brief for grill round 1', 'Cover the phone layout.']);
  assert.equal(t1().briefs, undefined, 'the brief left the task');
  const record = read(audit('data', 'agents', 'T-1.json'));
  assert.deepEqual([record.kind, record.dispatched, record.brief.brief.heading, record.brief.ask], ['grill', 'hub', 'Brief for grill round 1', { text: 'Ask about mobile' }]);
  // The planner's own builder start keeps the brief on its record, for a Resume after a Hold.
  assert.equal((await board('builder', 'start', 'audit/T-1', '--kind', 'grill', '--site', 'audit')).code, 0);
  assert.equal(read(audit('data', 'agents', 'T-1.json')).brief.brief.text, 'Cover the phone layout.');

  await board('item', 'brief', 'audit/T-1', '--kind', 'visual', '--file', draft, '--site', 'audit');
  const visual = await s.startVisual(audit(), 'audit/T-1');
  assert.match(visual.agent, /^visual-\d+$/);
  assert.equal(read(audit('data', 'agents', `T-1@${visual.agent}.json`)).brief.brief.heading, 'Brief for visual round 1');
});

test("a planner's or visual agent's record is written once, so no read of it shows a kind without its brief", async () => {
  auditEvents(ask);
  const s = await store();
  await s.fileAsk(audit(), 'a1');
  await triage('audit/T-1');
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
  await board('item', 'brief', 'audit/T-1', '--kind', 'grill', '--file', draft, '--site', 'audit');
  const grill = await watch(() => s.startPlanner(audit(), 'audit/T-1', 'grill'));
  assert.ok(grill.length && grill.every(Boolean), 'the planner record always has its brief');
  await board('item', 'brief', 'audit/T-1', '--kind', 'visual', '--file', draft, '--site', 'audit');
  const visual = await watch(() => s.startVisual(audit(), 'audit/T-1'));
  assert.ok(visual.every(Boolean), 'the visual record always has its brief');
});

test("the owner's Grill or Prototype tap on a discussing card moves it to that planner's phase; an Implement stages it", async () => {
  auditEvents(ask);
  const s = await store();
  await s.fileAsk(audit(), 'a1');
  await triage('audit/T-1');
  await s.planAgain(audit(), 'audit/T-1', 'grill');
  assert.equal(t1().phase, 'grilling');
  await board('item', 'set', 'audit/T-1', '--phase', 'discussing', '--site', 'audit');
  await s.stageImplement(audit(), 'audit/T-1', { text: 'Go with the sidebar.' });
  assert.equal(t1().phase, 'staging');
  assert.match(fs.readFileSync(path.join(audit('data'), t1().plan), 'utf8'), /Go with the sidebar\./);
});

// docs/adr/2026-11-12-0800-a-written-brief-wakes-the-board-and-going-discussing-drops-owed-briefs.md
test('item brief appends a brief-written event and posts "<Kind> started" for a brief nobody tapped for; one answering a tap posts no line', async () => {
  auditEvents(ask);
  const s = await store();
  await s.fileAsk(audit(), 'a1');
  await triage('audit/T-1');
  const draft = path.join(home, 'brief.md');
  fs.writeFileSync(draft, 'Settled: a phone layout.');
  const thread = () => lines(audit('data', 'threads', 'audit__T-1.jsonl')).filter((l) => l.command);
  const events = () => lines(audit('data', 'events.jsonl')).filter((e) => e.kind === 'brief-written');
  assert.equal((await board('item', 'brief', 'audit/T-1', '--kind', 'prototype', '--file', draft, '--site', 'audit')).code, 0);
  assert.deepEqual(events().map((e) => e.data), [{ key: 'audit/T-1', kind: 'prototype' }]);
  assert.deepEqual(thread().filter((l) => l.command === 'prototype-started').map((l) => [l.who, l.text]), [['claude', 'Prototype started']]);
  await s.planAgain(audit(), 'audit/T-1', 'grill', { text: 'Ask about mobile' });
  assert.equal((await board('item', 'brief', 'audit/T-1', '--kind', 'grill', '--file', draft, '--site', 'audit')).code, 0);
  assert.equal(events().length, 2);
  assert.equal(thread().filter((l) => l.command === 'grill-started').length, 0, "the owner's tap wrote that line, so the brief adds no started line");
  // A bare Visual tap (no text) is the owner's request too: its brief adds no second line.
  await s.planAgain(audit(), 'audit/T-1', 'visual');
  assert.equal((await board('item', 'brief', 'audit/T-1', '--kind', 'visual', '--file', draft, '--site', 'audit')).code, 0);
  assert.equal(thread().filter((l) => l.command === 'visual-started').length, 0, "a bare tap's brief posts no line");
});

test('a card set to discussing, by item set or a reply, drops its unwritten briefs and keeps the written ones', async () => {
  auditEvents(ask);
  const s = await store();
  await s.fileAsk(audit(), 'a1');
  await s.oweBrief(audit(), 'audit/T-1', 'grill');
  assert.equal(t1().briefs.length, 1);
  assert.equal((await triage('audit/T-1')).code, 0);
  assert.deepEqual([t1().phase, t1().briefs], ['discussing', undefined]);
  await s.oweBrief(audit(), 'audit/T-1', 'grill');
  const draft = path.join(home, 'brief.md');
  fs.writeFileSync(draft, 'Settled.');
  assert.equal((await board('item', 'brief', 'audit/T-1', '--kind', 'visual', '--file', draft, '--site', 'audit')).code, 0);
  assert.equal((await board('item', 'set', 'audit/T-1', '--phase', 'discussing', '--site', 'audit')).code, 0);
  assert.deepEqual(t1().briefs.map((b) => b.kind), ['visual'], 'the unwritten grill goes, the written visual stays');
});

// docs/adr/2026-11-13-2050-a-task-filed-by-the-orchestrator-opens-with-its-first-message.md
test("item add --phase discussing writes --text as the card's first thread line, and without it is refused and writes nothing", async () => {
  await store();
  const refused = await board('item', 'add', 'audit/D2', '--relate', 'audit/A1', '--title', 'feat: talk it', '--phase', 'discussing', '--site', 'audit');
  assert.equal(refused.code, 2);
  assert.match(refused.err, /needs --text/);
  assert.equal(read(audit('data', 'items.json')).items.some((i) => i.id === 'D2'), false);
  const r = await board('item', 'add', 'audit/D2', '--relate', 'audit/A1', '--title', 'feat: talk it', '--phase', 'discussing', '--text', 'Opening message.', '--site', 'audit');
  assert.deepEqual([r.code, r.err], [0, '']);
  assert.deepEqual(lines(audit('data', 'threads', 'audit__D2.jsonl')).filter((l) => !l.command).map((l) => [l.who, l.text]), [['claude', 'Opening message.']]);
  assert.match((await board('item', 'add', 'audit/D3', '--relate', 'audit/A1', '--title', 'feat: grill', '--phase', 'grilling', '--text', 'x', '--site', 'audit')).err, /--text goes with/);
});
