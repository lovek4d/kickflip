// docs/adr/2026-11-07-1400-a-card-stores-its-lane-and-facts-replace-statuses.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, site, write, read, lines, board, wave } from './board-fixture.mjs';
import { moveCard, migrateStatuses } from './store.mjs';
import { buildBoard, movesOf } from './domain.mjs';
import { withFileLock } from '../hub/locks.mjs';

const auditItem = (id = 'A1') => read(site('audit', 'data', 'items.json')).items.find((i) => i.id === id);
const auditThread = (id = 'A1') => { try { return lines(site('audit', 'data', 'threads', `audit__${id}.jsonl`)); } catch { return []; } };
const moveLines = (id) => auditThread(id).filter((m) => m.kind === 'move').map((m) => m.text);

test('item set refuses --status and --clear-status, and --done closes the card in Done with its line last', async () => {
  for (const args of [['--status', 'done'], ['--clear-status']]) {
    const r = await board('item', 'set', 'audit/A1', '--site', 'audit', ...args);
    assert.equal(r.code, 1);
    assert.match(r.err, /--(clear-)?status (and --clear-status )?(is|are) gone: .* Close it with --done --text/);
  }
  assert.match((await board('item', 'set', 'audit/A1', '--site', 'audit', '--done')).err, /--text/);
  const r = await board('item', 'set', 'audit/A1', '--site', 'audit', '--done', '--text', 'Dropped: superseded by A2.');
  assert.equal(r.code, 0, r.err);
  const item = auditItem();
  assert.equal(item.lane, 'done');
  assert.equal(item.closed_at, item.lane_at);
  assert.equal(item.status, undefined);
  assert.equal(auditThread().at(-1).text, 'Dropped: superseded by A2.');
  assert.deepEqual(moveLines('A1'), []);
});

test('a new card starts in Todo; a build start moves it to In Progress and a PR to In Review, each with a move line', async () => {
  assert.equal((await board('item', 'add', 'audit/B2', '--site', 'audit', '--title', 'feat: two', '--phase', 'grilling')).code, 0);
  const added = auditItem('B2');
  assert.equal(added.lane, 'todo');
  assert.equal(added.lane_at, added.created);
  const started = await board('builder', 'start', 'audit/B2', '--site', 'audit', '--kind', 'claude');
  assert.equal(started.code, 0, started.err);
  assert.equal(auditItem('B2').lane, 'progress');
  assert.equal((await board('item', 'set', 'audit/B2', '--site', 'audit', '--pr', '5')).code, 0);
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
  write(site('audit', 'data', 'items.json'), { ...wave(), items: [
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
  const items = Object.fromEntries(read(site('audit', 'data', 'items.json')).items.map((i) => [i.id, i]));
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

const built = (items, agents = {}, prs = {}) => buildBoard({ fromWaves: true, files: [{ slug: 'w', agents, itemFile: { repo: 'o/r', items } }], prs, owner: {}, events: [] });

test('the settle pass moves a card to where the board places it, never to Done, and leaves a stored Done card alone unless it reopened', async () => {
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

// docs/adr/2026-11-09-1804-in-progress-means-a-builder-runs.md
test('the settle pass moves a Done card a message reopened, and a ready PR gone red with no builder, to In Review', async () => {
  const msg = { id: 'm1', ts: '2026-11-04T09:00:00Z', kind: 'item-message', data: { key: 'w/D1', text: 'One more thing' }, reply: null };
  const board = buildBoard({ fromWaves: true, owner: {}, events: [msg], prs: { 'o/r#7': { state: 'OPEN', isDraft: false, checks: { state: 'fail' }, reviews: {} } },
    files: [{ slug: 'w', agents: {}, itemFile: { repo: 'o/r', items: [
      { id: 'D1', title: 'Done', lane: 'done', closed_at: '2026-11-04T08:00:00Z' },
      { id: 'R1', title: 'Red', lane: 'progress', phase: 'reading', pr: 7 },
    ] } }] });
  assert.deepEqual(movesOf(board).map((m) => [m.key, m.to, m.why]).sort(), [
    ['w/D1', 'review', 'a message or question reopened it'],
    ['w/R1', 'review', 'Fix the failing CI'],
  ]);
});

// docs/adr/2026-11-09-2100-a-settle-move-never-undoes-a-tap-made-after-its-snapshot.md
test("a settle move made from a snapshot is skipped once the card's file reads another lane or phase than the snapshot did, so a tap in between stands", async () => {
  const dir = site('audit');
  write(site('audit', 'data', 'items.json'), { ...wave(), items: [{ id: 'T1', title: 'Ready', phase: 'ready' }, { id: 'T2', title: 'Ready too', phase: 'ready' }] });
  const [first, second] = movesOf(buildBoard({ fromWaves: true, files: [{ slug: 'audit', agents: {}, itemFile: read(site('audit', 'data', 'items.json')) }], prs: {}, owner: {}, events: [] }));
  assert.deepEqual([first.key, first.to, first.phase, first.from], ['audit/T1', 'todo', 'ready', { lane: null, phase: 'ready' }]);
  // The owner's Grill tap lands on T1 after the snapshot, so its move is skipped; T2's file still matches, so it moves.
  write(site('audit', 'data', 'items.json'), { ...wave(), items: [{ id: 'T1', title: 'Ready', phase: 'grilling' }, { id: 'T2', title: 'Ready too', phase: 'ready' }] });
  assert.equal(await moveCard(dir, first.key, first.to, first.why, first.phase, first.from), null);
  assert.equal(await moveCard(dir, second.key, second.to, second.why, second.phase, second.from), null);
  const items = read(site('audit', 'data', 'items.json')).items;
  assert.deepEqual([items[0].phase, items[0].lane], ['grilling', undefined]);
  assert.deepEqual([items[1].phase, items[1].lane], ['ready', 'todo']);
});

// A tap that holds the item file's lock while the settle move waits for it lands after the move started: the move checks
// its snapshot against the file it writes, under that lock, so the tap stands.
test("a settle move checks its snapshot under the item file's lock, so a tap written while it waited for the lock stands", async () => {
  const dir = site('audit');
  const file = site('audit', 'data', 'items.json');
  write(file, { ...wave(), items: [{ id: 'T3', title: 'New', held: true }] });
  const [move] = movesOf(buildBoard({ fromWaves: true, files: [{ slug: 'audit', agents: {}, itemFile: read(file) }], prs: {}, owner: {}, events: [] }));
  assert.deepEqual([move.key, move.to, move.phase, move.from], ['audit/T3', 'todo', 'new', { lane: null, phase: null }]);
  let moved;
  await withFileLock(file, async () => {
    moved = moveCard(dir, move.key, move.to, move.why, move.phase, move.from);
    await new Promise((r) => setTimeout(r, 300));
    // The owner's Implement, as store.mjs stage writes it.
    write(file, { ...wave(), items: [{ id: 'T3', title: 'New', phase: 'staging', staged_at: '2026-11-09T22:11:49.491Z' }] });
  });
  assert.equal(await moved, null);
  const [item] = read(file).items;
  assert.deepEqual([item.lane, item.phase, item.staged_at], [undefined, 'staging', '2026-11-09T22:11:49.491Z']);
});
