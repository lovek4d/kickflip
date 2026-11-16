import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { site, lines, read, write, board, run } from './board-fixture.mjs';
import { buildBoard, threadOf } from './domain.mjs';
import { askedGate } from './store.mjs';
import { ON_CARD, ownerWords } from '../bin/event-lines.mjs';

// docs/adr/2026-11-16-1100-a-task-the-orchestrator-files-comes-in-as-an-ask-through-new.md
const items = () => read(site('audit', 'data', 'items.json')).items;
const thread = (id) => lines(site('audit', 'data', 'threads', `audit__${id}.jsonl`)).map(({ ts, ...m }) => m);
const asks = () => (fs.existsSync(site('audit', 'data', 'events.jsonl')) ? lines(site('audit', 'data', 'events.jsonl')).filter((e) => e.kind === 'ask') : []);
const ask = (...args) => board('item', 'add', 'audit', '--site', 'audit', ...args);
const grilling = (id) => board('item', 'add', `audit/${id}`, '--site', 'audit', '--relate', 'audit/A1', '--title', `feat: ${id.toLowerCase()}`, '--phase', 'grilling', '--notes', 'Notes.');

test('item add --ask files an ask in New carrying its relations, so its card is born with them and reads New', async () => {
  for (const id of ['S1', 'S2', 'S3']) assert.equal((await grilling(id)).code, 0);
  const r = await ask('--ask', 'Cache the board config\nIt is read on every request.', '--parent', 'S1', '--relate', 'S2', '--blocked-by', 'S2', '--blocks', 'S3');
  assert.equal(r.code, 0, r.err);
  const [event] = asks();
  assert.deepEqual([event.data.text, event.data.asked], ['Cache the board config\nIt is read on every request.', { by: 'orchestrator' }]);
  const card = items().find((it) => it.from_ask === event.id);
  assert.match(r.out, new RegExp(`added as audit/${card.id}: an ask in New`));
  // Born with its relations, and still New: no phase, so the orchestrator triages it as it does the owner's.
  assert.deepEqual([card.title, card.parent, card.related, card.deps, card.phase], ['Cache the board config', 'audit/S1', ['audit/S2'], ['S2'], undefined]);
  assert.ok(items().find((it) => it.id === 'S3').deps.includes(card.id));
  const named = (command, other) => thread(card.id).some((m) => m.command === command && m.card === other);
  assert.ok(named('created-from', 'audit/S1') && named('related', 'audit/S2') && named('blocked-by', 'audit/S2') && named('unblocks', 'audit/S3'));
  assert.ok(thread('S1').some((m) => m.command === 'created' && m.card === `audit/${card.id}`));
  // Triage sorts it like any New task.
  const t = await board('item', 'triage', `audit/${card.id}`, '--site', 'audit', '--title', 'perf(board): cache the board config', '--phase', 'discussing');
  assert.equal(t.code, 0, t.err);
  assert.equal(items().find((it) => it.id === card.id).phase, 'discussing');
});

test('item add --ask --by builder names the task whose builder asked; --parent --split carries the parent\'s gates', async () => {
  const file = site('audit', 'data', 'items.json');
  write(file, { ...read(file), items: [...read(file).items, { id: 'G1', title: 'feat: gated', lane: 'todo', phase: 'grilling', gates: { prototype: 'no' } }] });
  assert.equal((await ask('--ask', 'Split off the header', '--parent', 'G1', '--split', '--by', 'builder')).code, 0);
  const [event] = asks();
  assert.deepEqual(event.data.asked, { by: 'builder', key: 'audit/G1', ref: 'G1' });
  const card = items().find((it) => it.from_ask === event.id);
  assert.deepEqual([card.parent, card.gates], ['audit/G1', { prototype: 'no' }]);
  assert.ok(thread(card.id).some((m) => m.command === 'created-from' && m.card === 'audit/G1'));
});

test('item add --ask refuses what triage decides, a builder with no task, and a missing link, writing nothing', async () => {
  const before = items().length;
  for (const [args, why] of [
    [['--ask', 'x', '--title', 'feat: x'], /--ask files the orchestrator's request as an ask; triage titles, notes and sorts it, so drop --title/],
    [['--ask', 'x', '--phase', 'grilling'], /drop --phase/],
    [['--ask', 'x', '--notes', 'n'], /drop --notes/],
    [['--ask', 'x', '--by', 'builder'], /--by builder names the task whose builder asked: pass --parent <that task>/],
    [['--ask', 'x', '--by', 'owner'], /--by takes orchestrator, builder or planner/],
    [['--ask', 'x', '--parent', 'NOPE'], /NOPE/],
    [['--ask', ' '], /--ask/],
  ]) {
    const r = await ask(...args);
    assert.notEqual(r.code, 0, args.join(' '));
    assert.match(r.err, why);
  }
  assert.deepEqual([asks().length, items().length], [0, before]);
});

test('item add without --ask refuses a task filed from another on a board, pointing at --ask', async () => {
  for (const [flags, said] of [[['--parent', 'A1'], '--parent A1'], [['--parent', 'A1', '--split'], '--parent A1 --split']]) {
    const r = run('board.mjs', ['item', 'add', 'audit', '--site', 'audit', '--relate', 'audit/A1', '--title', 'feat: child', '--phase', 'grilling', '--notes', 'N.', ...flags]);
    assert.notEqual(r.code, 0, said);
    assert.match(r.err, new RegExp(`a task filed from another comes in as an ask: item add audit --ask "<the request>" ${said},`));
  }
});

test("an ask the orchestrator filed opens with a blue line naming who asked, and its message is theirs, not the owner's", () => {
  const at = (id, asked) => ({ id, ts: '2026-11-16T10:00:00Z', kind: 'ask', data: { text: 'Cache the config', asked }, reply: null });
  const view = (e) => threadOf('w/T-9', { events: [e], fromAsk: e.id }).map(({ who, line, text, link, by, tone }) => [who, line, text, link, by, tone]);
  assert.deepEqual(view(at('a1', { by: 'orchestrator' })), [
    ['claude', 'asked-from', 'From the orchestrator', null, undefined, 'blue'],
    ['love', undefined, 'Cache the config', undefined, 'Orchestrator', undefined],
  ]);
  assert.deepEqual(view(at('a2', { by: 'builder', key: 'w/T-4', ref: 'T-4' })), [
    ['claude', 'asked-from', "From T-4's builder", '#selectedCard=w%2FT-4', undefined, 'blue'],
    ['love', undefined, 'Cache the config', undefined, "T-4's builder", undefined],
  ]);
});

// An asked ask is not the owner's: where the board quotes an ask to the orchestrator, it names who asked, and its words
// never stand in for the owner's.
test("the watcher's line and the intake wait name an asked ask's asker, the hook shows only the owner's words, and --asked refuses its text", async () => {
  const asked = { id: 'b1', ts: '2026-11-16T10:00:00Z', kind: 'ask', data: { text: 'Ship the cache now', asked: { by: 'builder', key: 'w/T-4', ref: 'T-4' } }, reply: null };
  const owners = { id: 'b2', ts: '2026-11-16T10:00:00Z', kind: 'ask', data: { text: 'Mine' }, reply: null };
  assert.match(ON_CARD.ask('T-9', asked), /^new task b1, asked by T-4's builder, not the owner, so its words approve nothing, received as T-9: triage it first/);
  assert.match(ON_CARD.ask('T-9', owners), /^new task b2 received as T-9: triage it first/);
  assert.deepEqual([asked, owners, { kind: 'item-message', data: {} }, { kind: 'card-bump', data: {} }].map(ownerWords), [false, true, true, false]);
  const next = (e) => buildBoard({ fromWaves: false, files: [{ slug: 'w', itemFile: { items: [{ id: 'T-9', title: 'x', from_ask: e.id }] } }], events: [e] }).items[0].orchestrator.next;
  assert.match(next(asked), /^Triage the new task T-4's builder asked, not the owner, so its words approve nothing, from what you know of the board/);
  assert.match(next(owners), /^Triage the new task first, from what you know of the board/);
  assert.equal((await ask('--ask', 'Ship the cache now, all of it', '--relate', 'A1')).code, 0);
  await assert.rejects(askedGate(site('audit'), 'audit/A1', 'ship the cache now'), /--asked must quote the owner's words/);
});
