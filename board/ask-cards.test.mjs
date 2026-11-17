// docs/adr/2026-11-09-1900-every-ask-is-a-task-card-from-the-moment-it-arrives.md: an ask is a T-<n> card from
// arrival, answered on the card into In Review for the owner's Done, merged into another card's thread, or dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildBoard, movesOf } from './domain.mjs';
import { ITEM_SET_FLAGS, ITEM_SET_SAYS } from './bin/board.mjs';
import { board, home, site, read, write, lines } from './board-fixture.mjs';

const ask = { id: 'a1', ts: '2026-11-09T10:00:00Z', kind: 'ask', data: { text: 'Fix the header\nIt jumps on scroll' } };
function built({ item = {}, events = [], threads = {}, askLinks = {}, working = {}, extra = [] } = {}) {
  return buildBoard({
    now: Date.parse('2026-11-09T12:00:00Z'), threads, askLinks, working,
    files: [{ slug: 'hub', agents: {}, itemFile: { items: [{ id: 'T-1', title: 'Fix the header', created: '2026-11-09T10:00:01Z', lane: 'todo', from_ask: 'a1', ...item }, ...extra] } }],
    prs: {}, owner: {}, events: [ask, ...events],
  });
}
const card = (b, key = 'hub/T-1') => b.items.find((i) => i.key === key);

test('a card an ask became reads New with its ask state until it is sorted, and the ask has no row of its own', async () => {
  const b = built();
  const c = card(b);
  assert.deepEqual([c.lane, c.isNew, c.unsorted, c.ask.eventId, c.ask.state, c.ask.canEdit], ['todo', true, true, 'a1', 'waiting', true]);
  assert.equal(b.items.some((i) => i.kind === 'ask'), false);
  assert.equal(b.moved['ask:a1'], 'hub/T-1');
  // The intake wait is on the card, naming how to triage it, then investigate.
  assert.equal(c.orchestrator.kind, 'intake');
  assert.match(c.orchestrator.next, /item triage hub\/T-1 --title/);
  assert.match(c.orchestrator.next, /reply hub\/T-1/);
  // Picked up, it reads working; sorted, it reads as a task.
  assert.equal(card(built({ working: { a1: '2026-11-09T10:01:00Z' } })).ask.state, 'working');
  const sorted = card(built({ item: { phase: 'grilling' } }));
  assert.deepEqual([Boolean(sorted.isNew), sorted.ask ?? null, sorted.unsorted], [false, null, false]);
});

test('an ask the orchestrator filed reads asked on its New ask, and an owner ask does not', async () => {
  assert.equal(card(built()).ask.asked, undefined);
  const filed = buildBoard({
    now: Date.parse('2026-11-09T12:00:00Z'), threads: {}, askLinks: {}, working: {},
    files: [{ slug: 'hub', agents: {}, itemFile: { items: [{ id: 'T-1', title: 'Fix', created: '2026-11-09T10:00:01Z', lane: 'todo', from_ask: 'a1' }] } }],
    prs: {}, owner: {}, events: [{ ...ask, data: { ...ask.data, asked: { by: 'orchestrator' } } }],
  });
  assert.equal(card(filed).ask.asked, true);
});

test('an answered card waits in In Review for the owner\'s Done with no Action needed, a reply holds it on the orchestrator, and the answer shows in the banner', async () => {
  const threads = { 'hub/T-1': [{ ts: '2026-11-09T10:05:00Z', who: 'claude', text: 'It jumps because of the sticky bar.' }] };
  const answered = built({ item: { answered_at: '2026-11-09T10:05:00Z' }, threads });
  const c = card(answered);
  assert.deepEqual([c.lane, c.waitsOn, c.awaitsDone, c.action, c.next, Boolean(c.isNew), c.answered], ['review', 'owner', true, null, 'Tap Done', false, true]);
  assert.deepEqual(answered.answers.map((a) => [a.key, a.at]), [['hub/T-1', '2026-11-09T10:05:00Z']]);
  // The settle pass moves it to In Review saying why.
  assert.deepEqual(movesOf(answered).map((m) => [m.key, m.to, m.why]), [['hub/T-1', 'review', 'answered, it waits for your Done']]);

  const reply = { id: 'm1', ts: '2026-11-09T10:10:00Z', kind: 'item-message', data: { key: 'hub/T-1', text: 'And on mobile?' } };
  const replied = card(built({ item: { answered_at: '2026-11-09T10:05:00Z', lane: 'review' }, threads, events: [reply] }));
  assert.deepEqual([replied.lane, replied.awaitsDone, replied.next], ['review', false, 'Your reply waits on the orchestrator']);

  const done = { id: 'd1', ts: '2026-11-09T10:20:00Z', kind: 'card-done', data: { key: 'hub/T-1' } };
  assert.equal(card(built({ item: { answered_at: '2026-11-09T10:05:00Z', lane: 'review', lane_at: '2026-11-09T10:06:00Z' }, threads, events: [done] })).lane, 'done');
});

test('a card merged into another has no row, its ask opens the other card, and the merge feeds the New strip with the whole message until that card is read', async () => {
  const threads = { 'ask:a1': [{ ts: '2026-11-09T10:07:00Z', who: 'claude', kind: 'hub', line: 'card-merged', text: 'Merged into T-2.', into: 'hub/T-2' }] };
  const b = buildBoard({
    now: Date.parse('2026-11-09T12:00:00Z'), threads, askLinks: { a1: 'hub/T-2' },
    files: [{ slug: 'hub', agents: {}, itemFile: { items: [{ id: 'T-2', title: 'Header polish', lane: 'todo', phase: 'grilling' }] } }],
    prs: {}, owner: {}, events: [ask],
  });
  assert.equal(b.items.some((i) => i.kind === 'ask'), false);
  assert.equal(b.moved['ask:a1'], 'hub/T-2');
  assert.deepEqual(b.merges, [{ key: 'hub/T-2', ref: 'T-2', text: 'Fix the header', at: '2026-11-09T10:07:00Z', id: 'a1', askedAt: '2026-11-09T10:00:00Z', message: 'Fix the header\nIt jumps on scroll', files: [] }]);
});

// docs/adr/2026-11-15-0040-a-new-tasks-media-shows-as-thumbnails-and-sends-atomically.md: a Ticket created and an Added
// to row keep the ask's files, each edit's after the ask's own.
test("a merge and an ingest carry the ask's files, each edit's after the ask's own, for the New strip's Added to and Ticket created rows", async () => {
  const shot = { name: 'shot.png', url: 'uploads/1-shot.png', type: 'image/png' };
  const log = { name: 'run.log', url: 'uploads/2-run.log', type: 'text/plain' };
  const withFiles = { ...ask, data: { ...ask.data, files: [shot] } };
  const edited = { id: 'x1', ts: '2026-11-09T10:02:00Z', kind: 'ask-edited', data: { id: 'a1', text: 'Fix the footer', files: [log] } };
  const threads = { 'ask:a1': [{ ts: '2026-11-09T10:07:00Z', who: 'claude', kind: 'hub', line: 'card-merged', text: 'Merged into T-2.', into: 'hub/T-2' }] };
  const merged = buildBoard({
    now: Date.parse('2026-11-09T12:00:00Z'), threads, askLinks: { a1: 'hub/T-2' },
    files: [{ slug: 'hub', agents: {}, itemFile: { items: [{ id: 'T-2', title: 'Header polish', lane: 'todo', phase: 'grilling' }] } }],
    prs: {}, owner: {}, events: [withFiles, edited],
  });
  assert.deepEqual(merged.merges[0].files, [shot, log]);
  const made = buildBoard({
    now: Date.parse('2026-11-09T12:00:00Z'), threads: {}, askLinks: {}, working: {},
    files: [{ slug: 'hub', agents: {}, itemFile: { items: [{ id: 'T-1', title: 'Fix the header', created: '2026-11-09T10:00:01Z', lane: 'todo', from_ask: 'a1', phase: 'ready', sorted_at: '2026-11-09T10:04:00Z' }] } }],
    prs: {}, owner: {}, events: [withFiles, edited],
  });
  assert.deepEqual(card(made).ingested.files, [shot, log]);
});

// docs/adr/2026-11-12-0228-new-asks-sit-in-a-new-strip-above-the-lanes.md
test('a card an ask became carries when it was ingested and the full message it came from; a New card and one sorted before the stamp carry none', async () => {
  const ingested = card(built({ item: { phase: 'discussing', sorted_at: '2026-11-09T10:04:00Z' } }));
  assert.deepEqual(ingested.ingested, { at: '2026-11-09T10:04:00Z', text: 'Fix the header\nIt jumps on scroll', files: [] });
  const edited = { id: 'x1', ts: '2026-11-09T10:02:00Z', kind: 'ask-edited', data: { id: 'a1', text: 'Fix the footer' } };
  assert.equal(card(built({ item: { phase: 'ready', sorted_at: '2026-11-09T10:04:00Z' }, events: [edited] })).ingested.text, 'Fix the footer');
  assert.equal(card(built()).ingested, null);
  assert.equal(card(built({ item: { phase: 'grilling' } })).ingested, null);
});

// The CLI and the board server's filing, on the audit board (data/items.json).
const audit = (...p) => site('audit', ...p);
const auditEvents = (...events) => fs.appendFileSync(audit('data', 'events.jsonl'), events.map((e) => JSON.stringify(e) + '\n').join(''));
async function store() {
  process.env.HOME = home;
  return import('./store.mjs');
}
// docs/adr/2026-11-16-0900-a-card-in-new-takes-no-writes-until-it-is-triaged.md: a New card is sorted by item triage.
const triage = (key, phase = 'discussing') => board('item', 'triage', key, '--title', 'fix(board): the header', '--phase', phase, '--site', 'audit');

test('the board files a New ask as a T-<n> card once, titled by its first line with no phase, and never reuses a number a dropped card had', async () => {
  auditEvents(ask, { id: 'a2', ts: '2026-11-09T10:01:00Z', kind: 'ask', data: { text: '', files: [{ name: 'shot.png' }] } });
  const s = await store();
  assert.deepEqual(await s.fileAsk(audit(), 'a1'), 'audit/T-1');
  assert.equal(await s.fileAsk(audit(), 'a1'), null);
  const items = read(audit('data', 'items.json')).items;
  const t1 = items.find((i) => i.id === 'T-1');
  assert.deepEqual([t1.title, t1.from_ask, t1.phase, t1.lane], ['Fix the header', 'a1', undefined, 'todo']);
  // Withdrawn while New, the card goes with no Done row; the next task takes a new number.
  assert.equal(await s.dropAskCard(audit(), 'a1'), 'audit/T-1');
  assert.equal(read(audit('data', 'items.json')).items.some((i) => i.id === 'T-1'), false);
  assert.equal(await s.fileAsk(audit(), 'a2'), 'audit/T-2');
  assert.equal(read(audit('data', 'items.json')).items.find((i) => i.id === 'T-2').title, 'shot.png');
  // A sorted card is not dropped by a withdrawal.
  assert.equal((await triage('audit/T-2', 'grilling')).code, 0);
  assert.equal(await s.dropAskCard(audit(), 'a2'), null);
});

// docs/adr/2026-11-12-0228-new-asks-sit-in-a-new-strip-above-the-lanes.md
test('the first phase a New card gets stamps when it was ingested, by item triage, and a later phase keeps that stamp', async () => {
  auditEvents(ask, { id: 'a2', ts: '2026-11-09T10:01:00Z', kind: 'ask', data: { text: 'Second' } });
  const s = await store();
  await s.fileAsk(audit(), 'a1');
  await s.fileAsk(audit(), 'a2');
  const item = (id) => read(audit('data', 'items.json')).items.find((i) => i.id === id);
  assert.equal(item('T-1').sorted_at, undefined);
  assert.equal((await triage('audit/T-1', 'grilling')).code, 0);
  const first = item('T-1').sorted_at;
  assert.ok(Date.parse(first) > Date.parse('2026-11-09T10:00:00Z'));
  assert.equal((await board('item', 'set', 'audit/T-1', '--phase', 'discussing', '--site', 'audit')).code, 0);
  assert.equal(item('T-1').sorted_at, first);
  assert.equal((await triage('audit/T-2')).code, 0);
  assert.ok(item('T-2').sorted_at);
});

// docs/adr/2026-11-12-0500-a-new-task-is-a-conversation.md
test('reply on a New card is refused until it is triaged; then it is a message in its thread; on a card sorted otherwise it is refused, and --phase takes an answered card back to Todo', async () => {
  auditEvents(ask);
  const s = await store();
  await s.fileAsk(audit(), 'a1');
  assert.match((await board('reply', 'audit/T-1', '--text', 'x', '--site', 'audit')).err, /still in New/);
  assert.equal((await triage('audit/T-1')).code, 0);
  const r =await board('reply', 'audit/T-1', '--text', 'It jumps because of the sticky bar.', '--title', 'fix: header jumps on scroll', '--site', 'audit');
  assert.deepEqual([r.code, r.err], [0, '']);
  const t1 = read(audit('data', 'items.json')).items.find((i) => i.id === 'T-1');
  assert.deepEqual([t1.answered_at, t1.phase, t1.title], [undefined, 'discussing', 'fix: header jumps on scroll']);
  assert.deepEqual(lines(audit('data', 'threads', 'audit__T-1.jsonl')).map((m) => m.text), ['It jumps because of the sticky bar.']);
  assert.equal((await board('item', 'set', 'audit/T-1', '--phase', 'grilling', '--site', 'audit')).code, 0);
  assert.match((await board('reply', 'audit/T-1', '--text', 'x', '--site', 'audit')).err, /sorted/);
  assert.match((await board('reply', 'audit/A1', '--text', 'x', '--site', 'audit')).err, /not a task an ask became/);
  // A card answered before discussing existed waits In Review; a phase takes it back to Todo.
  const items = read(audit('data', 'items.json'));
  Object.assign(items.items.find((i) => i.id === 'T-1'), { phase: undefined, answered_at: '2026-11-09T10:05:00Z', lane: 'review' });
  write(audit('data', 'items.json'), items);
  assert.equal((await board('item', 'set', 'audit/T-1', '--phase', 'discussing', '--site', 'audit')).code, 0);
  const back = read(audit('data', 'items.json')).items.find((i) => i.id === 'T-1');
  assert.deepEqual([back.answered_at, back.phase, back.lane], [undefined, 'discussing', 'todo']);
});

test('reply to an ask whose card is New is refused; once the card is triaged it writes the reply', async () => {
  auditEvents(ask);
  const s = await store();
  await s.fileAsk(audit(), 'a1');
  assert.match((await board('reply', 'a1', '--text', 'Yes.', '--site', 'audit')).err, /still in New/);
  await triage('audit/T-1');
  assert.equal((await board('reply', 'a1', '--text', 'Yes.', '--site', 'audit')).code, 0);
  assert.equal(read(audit('data', 'items.json')).items.find((i) => i.id === 'T-1').phase, 'discussing');
});

test('item relate-ask on an ask whose card is New merges it: the card goes, its thread lines move to the ask\'s thread, and a card-merged line names the card it went into', async () => {
  auditEvents(ask);
  const s = await store();
  await s.fileAsk(audit(), 'a1');
  write(audit('data', 'threads', 'audit__T-1.jsonl'), JSON.stringify({ ts: '2026-11-09T10:02:00Z', who: 'love', text: 'Also the footer' }) + '\n');
  const r = await board('item', 'relate-ask', 'a1', 'audit/A1', '--summary', 'Same as the header work', '--site', 'audit');
  assert.deepEqual([r.code, r.err], [0, '']);
  assert.equal(read(audit('data', 'items.json')).items.some((i) => i.id === 'T-1'), false);
  assert.equal(fs.existsSync(audit('data', 'threads', 'audit__T-1.jsonl')), false);
  const askThread = lines(audit('data', 'threads', 'ask__a1.jsonl'));
  assert.deepEqual(askThread.map((m) => m.text), ['Also the footer', 'Merged into A1.']);
  assert.deepEqual([askThread[1].line, askThread[1].into], ['card-merged', 'audit/A1']);
  assert.deepEqual(read(audit('data', 'ask-links.json')), { links: { a1: 'audit/A1' } });
  // A sorted card is filed work: relate-ask refuses rather than dropping it.
  auditEvents({ ...ask, id: 'a3' });
  await s.fileAsk(audit(), 'a3');
  await triage('audit/T-2', 'grilling');
  assert.match((await board('item', 'relate-ask', 'a3', 'audit/A1', '--summary', 'x', '--site', 'audit')).err, /became audit\/T-2/);
});

// docs/adr/2026-11-17-0543-a-quick-ask-is-triaged-into-staging.md
test("a Quick build ask's New card is staged by item triage, then goes ready from staging on the orchestrator's judgment", async () => {
  auditEvents({ ...ask, data: { ...ask.data, quick: true } });
  const s = await store();
  await s.fileAsk(audit(), 'a1');
  const notes = path.join(home, 'n.md');
  fs.writeFileSync(notes, 'Pin the header.');
  // docs/adr/2026-11-16-0900-a-card-in-new-takes-no-writes-until-it-is-triaged.md: triage sorts a New card; a reply does not.
  assert.match((await board('reply', 'audit/T-1', '--text', 'x', '--site', 'audit')).err, /still in New: sort it first with item triage audit\/T-1 .*; the owner's Implement \(a Quick build ask\) takes item triage audit\/T-1 --title with no --phase, which stages it/);
  assert.equal((await board('item', 'triage', 'audit/T-1', '--title', 'fix(board): pin the header', '--site', 'audit')).code, 0);
  assert.equal(read(audit('data', 'items.json')).items.find((i) => i.id === 'T-1').phase, 'staging');
  assert.equal((await board('item', 'notes', 'audit/T-1', '--heading', 'Scope', '--file', notes, '--site', 'audit')).code, 0);
  const r = await board('item', 'set', 'audit/T-1', '--phase', 'ready', '--size', 'small', '--text', 'No other task covers it.', '--site', 'audit');
  assert.deepEqual([r.code, r.err], [0, '']);
  assert.equal(read(audit('data', 'items.json')).items.find((i) => i.id === 'T-1').phase, 'ready');
  // item add --from-ask on an ask that already has its card points at the card.
  assert.match((await board('item', 'add', 'audit', '--from-ask', 'a1', '--text', 'x', '--title', 'X', '--phase', 'grilling', '--site', 'audit')).err, /already task audit\/T-1/);
});

test('item set --phase ready with --blocked-by sets Blocked by, bare or prefixed, and the card waits', async () => {
  auditEvents({ ...ask, data: { ...ask.data, quick: true } });
  const s = await store();
  await s.fileAsk(audit(), 'a1');
  const notes = path.join(home, 'n.md');
  fs.writeFileSync(notes, 'Pin the header.');
  for (const id of ['B1', 'B2']) { const a = await board('item', 'add', 'audit', '--site', 'audit', '--title', 'fix(board): ' + id, '--notes', 'x', '--phase', 'grilling', '--relate', 'audit/T-1'); assert.equal(a.code, 0, a.err); }
  assert.equal((await board('item', 'triage', 'audit/T-1', '--title', 'fix(board): pin the header', '--site', 'audit')).code, 0);
  assert.equal((await board('item', 'notes', 'audit/T-1', '--heading', 'Scope', '--file', notes, '--site', 'audit')).code, 0);
  const r = await board('item', 'set', 'audit/T-1', '--phase', 'ready', '--text', 'No other task covers it.', '--size', 'small', '--blocked-by', 'audit/T-2,audit/T-3', '--site', 'audit');
  assert.deepEqual([r.code, r.err], [0, '']);
  const item = read(audit('data', 'items.json')).items.find((i) => i.id === 'T-1');
  assert.deepEqual(item.deps, ['audit/T-2', 'audit/T-3']);
  // The command's one line names the Blocked by it set, as it names every other change.
  assert.match(r.out, /blocked by audit\/T-2,audit\/T-3/);
  const bare = await board('item', 'set', 'audit/T-1', '--blocked-by', 'T-2', '--site', 'audit');
  assert.deepEqual([bare.code, bare.err], [0, '']);
  assert.match(bare.out, /blocked by T-2/);
  assert.deepEqual(read(audit('data', 'items.json')).items.find((i) => i.id === 'T-1').deps, ['T-2']);
});

test('every flag item set takes is named in the line it prints, or is one that only shapes another', () => {
  for (const flag of ITEM_SET_FLAGS.map((f) => f.replace('...', ''))) assert.ok(flag in ITEM_SET_SAYS, `item set --${flag} is neither reported nor listed as a modifier`);
});

// docs/adr/2026-11-12-1300-sorting-an-ask-refuses-an-edit-the-orchestrator-hasnt-read.md
test('every sorting command refuses an ask edited after its working mark, printing the new text, and the rerun goes through', async () => {
  const s = await store();
  const notes = path.join(home, 'n.md');
  fs.writeFileSync(notes, 'Pin the header.');
  const commands = [
    ['item relate-ask', (key, id) => ['item', 'relate-ask', id, 'audit/A1', '--summary', 'Same as the header work'], (item) => item === undefined],
    ['item triage', (key) => ['item', 'triage', key, '--title', 'fix(board): header jumps', '--phase', 'discussing'], (item) => item.phase === 'discussing'],
  ];
  for (const [n, [name, args, sorted]] of commands.entries()) {
    const id = `r${n}`;
    auditEvents({ id, ts: '2026-11-12T09:38:00.000Z', kind: 'ask', data: { text: 'Completed asks go straight to Done' } });
    const key = await s.fileAsk(audit(), id);
    write(audit('data', 'working.json'), { events: { ...(fs.existsSync(audit('data', 'working.json')) ? read(audit('data', 'working.json')).events : {}), [id]: '2026-11-12T09:38:03.000Z' } });
    auditEvents({ id: `x${n}`, ts: '2026-11-12T09:38:14.000Z', kind: 'ask-edited', data: { id, key, text: 'Completed asks wait in In Review for my Done' } });
    const item = () => read(audit('data', 'items.json')).items.find((i) => i.from_ask === id);
    const refused = await board(...args(key, id), '--site', 'audit');
    assert.equal(refused.code, 1, name);
    assert.match(refused.err, new RegExp(`task ${id} was edited at 2026-11-12T09:38:14.000Z, after you read it\\. Its text now:\\nCompleted asks wait in In Review for my Done\\nRead it, then run this again, or change the command if the edit changes the plan\\.`), name);
    assert.deepEqual([item().phase, item().title], [undefined, 'Completed asks go straight to Done'], name);
    // The refusal printed the new text, so the ask's mark moves to now and the rerun goes through.
    assert.ok(Date.parse(read(audit('data', 'working.json')).events[id]) > Date.parse('2026-11-12T09:38:14.000Z'), name);
    const rerun = await board(...args(key, id), '--site', 'audit');
    assert.deepEqual([rerun.code, rerun.err], [0, ''], name);
    assert.ok(sorted(item()), name);
  }
});

test('an ask edited before its hand-over sorts at once; an edited ask never handed over refuses, as do --ticket and --new-ticket; a later owner message does not', async () => {
  const s = await store();
  auditEvents(ask, { id: 'x1', ts: '2026-11-09T10:00:30Z', kind: 'ask-edited', data: { id: 'a1', text: 'Fix the header, edited' } });
  await s.fileAsk(audit(), 'a1');
  write(audit('data', 'working.json'), { events: { a1: '2026-11-09T10:01:00Z' } });
  auditEvents({ id: 'm1', ts: '2026-11-09T10:02:00Z', kind: 'item-message', data: { key: 'audit/T-1', text: 'Also the footer' } });
  assert.deepEqual((await triage('audit/T-1', 'grilling')).code, 0);

  auditEvents({ ...ask, id: 'a2' }, { id: 'x2', ts: '2026-11-09T10:00:30Z', kind: 'ask-edited', data: { id: 'a2', text: 'Fix the footer' } });
  await s.fileAsk(audit(), 'a2');
  for (const flags of [['--ticket', '41'], []]) {
    write(audit('data', 'working.json'), { events: { a1: '2026-11-09T10:01:00Z' } });
    assert.match((await board('item', 'triage', 'audit/T-2', '--title', 'fix(board): the footer', '--phase', 'discussing', ...flags, '--site', 'audit')).err, /task a2 was edited at 2026-11-09T10:00:30Z, after you read it\. Its text now:\nFix the footer\n/, flags[0]);
  }
  // Asks with no edit are untouched.
  write(audit('data', 'working.json'), { events: {} });
  auditEvents({ ...ask, id: 'a3' });
  await s.fileAsk(audit(), 'a3');
  assert.equal((await triage('audit/T-3', 'grilling')).code, 0);
});
