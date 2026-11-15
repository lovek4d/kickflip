// docs/adr/2026-11-14-2330-the-questions-page-is-one-queue-of-what-the-badge-counts.md: the board's queue is every
// Needs you line that waits on the owner on the ? page, oldest first, questions and taps together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBoard, withHub } from './domain.mjs';

const card = (id, more = {}) => ({ id, title: `Card ${id}`, created: '2026-11-09T10:00:00Z', lane: 'todo', phase: 'discussing', ...more });
const built = (items, owner = {}) => buildBoard({
  now: Date.parse('2026-11-10T12:00:00Z'), threads: {}, working: {},
  files: [{ slug: 'hub', agents: {}, itemFile: { items } }], prs: {}, owner, events: [],
});

test('the queue lists questions and taps together, oldest first by card, each tap with its word', () => {
  const b = built([
    card('T-4', { created: '2026-11-04T10:00:00Z', waits_on_owner: { on: 'close', at: '2026-11-09T11:00:00Z' } }),
    card('T-2', { created: '2026-11-02T10:00:00Z', waits_on_owner: { on: 'implement', at: '2026-11-09T11:00:00Z' } }),
    card('T-3', { created: '2026-11-03T10:00:00Z' }),
    card('T-5', { created: '2026-11-05T10:00:00Z', stalled: { reason: 'tests fail' } }),
  ], { items: [{ id: 'q1', topic: 'item:hub/T-3', question: 'Keep it?', asked_at: '2026-11-09T12:00:00Z' }] });
  assert.deepEqual(b.queue.map((e) => [e.kind, e.key || e.id, e.word, e.since]), [
    ['implement', 'hub/T-2', 'Implement', '2026-11-02T10:00:00Z'],
    ['question', 'item:hub/T-3', undefined, '2026-11-03T10:00:00Z'],
    ['done', 'hub/T-4', 'Done', '2026-11-04T10:00:00Z'],
    ['action', 'hub/T-5', 'Action', '2026-11-05T10:00:00Z'],
  ]);
  const [implement, , done, action] = b.queue;
  assert.deepEqual([implement.title, implement.label, implement.fault], ['T-2: Card T-2', 'Tap Implement', false]);
  assert.deepEqual([done.label, action.fault], ['Tap Close', true]);
});

test("the hub's summary names the actions needed", () => {
  const b = built([card('T-1', { waits_on_owner: { on: 'implement', at: '2026-11-09T11:00:00Z' } }), card('T-2', { waits_on_owner: { on: 'close', at: '2026-11-09T11:00:00Z' } })]);
  assert.equal(b.needsSummary, '2 actions needed');
});

test('a pending prompt counts at the hub but is not in the queue', () => {
  const b = withHub(built([card('T-1', { waits_on_owner: { on: 'implement', at: '2026-11-09T11:00:00Z' } })]), { prompts: [{ id: 'p1', tool: 'Bash', detail: 'npm test' }] });
  assert.deepEqual(b.needs.map((l) => l.kind), ['Prompt', 'Action needed']);
  assert.deepEqual(b.queue.map((e) => e.kind), ['implement']);
});

// docs/adr/2026-11-15-1200-waiting-on-you-is-one-list-of-rows-opening-the-questions-sheet.md
test('a held review is in the queue after the cards, by its PR number and title', () => {
  const b = buildBoard({
    autoReview: true, files: [{ slug: 'w', itemFile: { repo: 'o/r', items: [card('A1', { waits_on_owner: { on: 'implement', at: '2026-11-03T11:00:00Z' } })] } }],
    incoming: { at: '2026-11-03T11:56:00Z', repo: 'o/r', prs: [{ number: 437, title: 'One endpoint', author: 'quinn', url: 'u', head: 'h', touches: ['w/A1'], asked: false }] },
    reviewRecords: { 437: { number: 437, title: 'One endpoint', author: 'quinn', url: 'u', head: 'h', touches: ['w/A1'], state: 'needs', text: 'Clashes with A1.', at: '2026-11-03T11:58:00Z' } },
    now: Date.parse('2026-11-03T12:00:00Z'),
  });
  assert.deepEqual(b.queue.map((e) => e.kind), ['implement', 'review']);
  assert.deepEqual(b.queue[1], { kind: 'review', review: 437, title: 'PR #437 One endpoint', progress: false });
});
