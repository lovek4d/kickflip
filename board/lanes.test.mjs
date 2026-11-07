// docs/adr/2026-11-07-1400-a-card-stores-its-lane-and-facts-replace-statuses.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, site, write, read, lines, board, wave } from './board-fixture.mjs';
import { moveCard, migrateStatuses } from './store.mjs';
import { buildBoard, movesOf } from './domain.mjs';

const auditItem = (id = 'A1') => read(site('audit', 'data', 'wave.json')).items.find((i) => i.id === id);
const auditThread = (id = 'A1') => { try { return lines(site('audit', 'data', 'threads', `audit__${id}.jsonl`)); } catch { return []; } };
const moveLines = (id) => auditThread(id).filter((m) => m.kind === 'move').map((m) => m.text);

test('item set refuses --status and --clear-status, and --done closes the card in Done with its line last', () => {
  for (const args of [['--status', 'done'], ['--clear-status']]) {
    const r = board('item', 'set', 'audit/A1', '--site', 'audit', ...args);
    assert.equal(r.code, 1);
    assert.match(r.err, /--(clear-)?status (and --clear-status )?(is|are) gone: .* Close it with --done --text/);
  }
  assert.match(board('item', 'set', 'audit/A1', '--site', 'audit', '--done').err, /--text/);
  const r = board('item', 'set', 'audit/A1', '--site', 'audit', '--done', '--text', 'Dropped: superseded by A2.');
  assert.equal(r.code, 0, r.err);
  const item = auditItem();
  assert.equal(item.lane, 'done');
  assert.equal(item.closed_at, item.lane_at);
  assert.equal(item.status, undefined);
  assert.equal(auditThread().at(-1).text, 'Dropped: superseded by A2.');
  assert.deepEqual(moveLines('A1'), []);
});

test('a new card starts in Todo; a build start moves it to In Progress and a PR to In Review, each with a move line', () => {
  assert.equal(board('item', 'add', 'audit/B2', '--site', 'audit', '--title', 'Two', '--phase', 'grilling').code, 0);
  const added = auditItem('B2');
  assert.equal(added.lane, 'todo');
  assert.equal(added.lane_at, added.created);
  const started = board('builder', 'start', 'audit/B2', '--site', 'audit', '--kind', 'claude');
  assert.equal(started.code, 0, started.err);
  assert.equal(auditItem('B2').lane, 'progress');
  assert.equal(board('item', 'set', 'audit/B2', '--site', 'audit', '--pr', '5').code, 0);
  assert.equal(auditItem('B2').lane, 'review');
  assert.deepEqual(moveLines('B2'), ['Moved to In Progress: a build started', 'Moved to In Review: PR #5 opened']);
});

test("moveCard places a card silently the first time, writes a move line after, and keeps a Done card's close and reopen times", async () => {
  const dir = site('audit');
  assert.equal(await moveCard(dir, 'audit/A1', 'todo', 'nothing builds it'), null);
  assert.equal(auditItem().lane, 'todo');
  assert.deepEqual(moveLines('A1'), []);
  assert.equal(await moveCard(dir, 'audit/A1', 'todo', 'again'), null);
  assert.equal(await moveCard(dir, 'audit/A1', 'review', 'it waits on review'), 'Moved to In Review: it waits on review');
  await moveCard(dir, 'audit/A1', 'done', 'its PR merged');
  const closed = auditItem();
  assert.equal(closed.closed_at, closed.lane_at);
  await moveCard(dir, 'audit/A1', 'progress', 'a message or question reopened it');
  const reopened = auditItem();
  assert.equal(reopened.reopened_at, reopened.lane_at);
  assert.equal(reopened.closed_at, closed.closed_at);
  await moveCard(dir, 'audit/A1', 'done', 'the owner tapped Done');
  assert.equal(auditItem().reopened_at, undefined);
  assert.deepEqual(moveLines('A1'), ['Moved to In Review: it waits on review', 'Moved to Done: its PR merged', 'Moved to In Progress: a message or question reopened it', 'Moved to Done: the owner tapped Done']);
  await assert.rejects(moveCard(dir, 'audit/A1', 'stale', 'x'), /no lane "stale"/);
});

test("the status migration turns each card's status into its lane and facts, in the wave files and the archive", async () => {
  write(site('audit', 'data', 'wave.json'), { ...wave(), items: [
    { id: 'M1', title: 'Merged', status: 'merged', status_at: '2026-11-01T10:00:00Z', merged_at: '2026-11-01T09:00:00Z', pr: 5 },
    { id: 'D1', title: 'Done', status: 'done', status_at: '2026-11-02T10:00:00Z' },
    { id: 'X1', title: 'Dropped', status: 'dropped', status_at: '2026-11-03T10:00:00Z', prs: [{ number: 6 }] },
    { id: 'H1', title: 'Held', status: 'held' },
    { id: 'C1', title: 'Checking', status: 'checking', status_at: '2026-11-04T10:00:00Z' },
    { id: 'B1', title: 'Building', status: 'building', status_at: '2026-11-04T11:00:00Z' },
    { id: 'T1', title: 'Untouched' },
  ] });
  write(site('audit', 'data', 'agents', 'C1.json'), { kind: 'claude', started: '2026-11-04T09:00:00Z', done: '2026-11-04T10:00:00Z' });
  write(site('audit', 'data', 'done-archive.json'), { cards: [{ key: 'audit/Z1', closed_at: '2026-10-01T00:00:00Z', item: { id: 'Z1', title: 'Old', status: 'merged', status_at: '2026-10-01T00:00:00Z', prs: [{ number: 2 }] } }] });
  const said = await migrateStatuses(site('audit'));
  assert.equal(said.length, 2);
  const items = Object.fromEntries(read(site('audit', 'data', 'wave.json')).items.map((i) => [i.id, i]));
  assert.deepEqual(items.M1, { id: 'M1', title: 'Merged', lane: 'done', lane_at: '2026-11-01T09:00:00Z', closed_at: '2026-11-01T09:00:00Z', prs: [{ number: 5, merged_at: '2026-11-01T09:00:00Z' }] });
  assert.deepEqual(items.D1, { id: 'D1', title: 'Done', lane: 'done', lane_at: '2026-11-02T10:00:00Z', closed_at: '2026-11-02T10:00:00Z' });
  assert.deepEqual(items.X1, { id: 'X1', title: 'Dropped', lane: 'done', lane_at: '2026-11-03T10:00:00Z', closed_at: '2026-11-03T10:00:00Z', prs: [{ number: 6 }] });
  assert.deepEqual(items.H1, { id: 'H1', title: 'Held', held: true });
  assert.deepEqual(items.C1, { id: 'C1', title: 'Checking' });
  assert.deepEqual(items.B1, { id: 'B1', title: 'Building' });
  assert.deepEqual(items.T1, { id: 'T1', title: 'Untouched' });
  assert.equal(read(site('audit', 'data', 'agents', 'C1.json')).handed_back, '2026-11-04T10:00:00Z');
  const archived = read(site('audit', 'data', 'done-archive.json')).cards[0].item;
  assert.deepEqual([archived.lane, archived.status, archived.prs], ['done', undefined, [{ number: 2, merged_at: '2026-10-01T00:00:00Z' }]]);
  assert.deepEqual(await migrateStatuses(site('audit')), []);
});

const built = (items, agents = {}, prs = {}) => buildBoard({ fromWaves: true, waves: [{ slug: 'w', agents, wave: { repo: 'o/r', items } }], prs, owner: {}, events: [] });

test('the settle pass moves a card to where the board places it, never to Done, and leaves a stored Done card alone unless it reopened', () => {
  const open = { started: '2026-11-04T09:00:00Z', kind: 'claude' };
  const board = built([
    { id: 'P1', title: 'Building', lane: 'todo' },
    { id: 'R1', title: 'PR open', lane: 'progress', pr: 7 },
    { id: 'H1', title: 'Held', lane: 'progress', held: true },
    { id: 'M1', title: 'Merged', lane: 'review', pr: 8 },
    { id: 'D1', title: 'Done', lane: 'done', closed_at: '2026-11-04T08:00:00Z' },
    { id: 'S1', title: 'Settled', lane: 'todo' },
  ], { P1: { main: open } }, { 'o/r#7': { state: 'OPEN', isDraft: false, checks: { state: 'pass' }, reviews: {} }, 'o/r#8': { state: 'MERGED' } });
  assert.deepEqual(movesOf(board).map((m) => [m.key, m.to, m.why]).sort(), [
    ['w/H1', 'todo', 'it is held'],
    ['w/P1', 'progress', 'a build started'],
    ['w/R1', 'review', 'Ready, Merge shows once CI and the merge state allow'],
  ]);
});
