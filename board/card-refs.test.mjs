// docs/adr/2026-11-25-1616-a-key-reads-by-its-ref-live-or-archived.md: every text that names a card to the owner names
// it by its ref, its ticket from the board's source once it has one, whether the card is on the board or archived.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { board, home, site, write } from './board-fixture.mjs';
import { startBoard } from '../shared/test-helpers.mjs';
import { ownerActions } from './domain.mjs';

const thread = (key, ...lines) => write(site('audit', 'data', 'threads', `${key.replace('/', '__')}.jsonl`), lines.map((l) => JSON.stringify({ ts: '2026-11-25T10:00:00Z', who: 'claude', ...l }) + '\n').join(''));
const ARCHIVED = { key: 'audit/T-3', file: 'audit', closed_at: '2026-11-20T10:00:00Z', item: { id: 'T-3', title: 'fix: three', created: '2026-11-19T10:00:00Z', lane: 'done', closed_at: '2026-11-20T10:00:00Z', ticket: '#9' }, questions: [] };

// The audit board on GitHub tickets: T-1 live with ticket #7 and made from ask a1, T-2 live with none and T-3 as its
// Parent, and T-3 archived with ticket #9. T-2's thread names both; T-1's and T-3's say they made their tickets.
async function ticketedBoard() {
  process.env.HOME = home;
  const { saveBoardSettings } = await import('./store.mjs');
  await saveBoardSettings(site('audit'), { tickets: { source: 'github' } });
  write(site('audit', 'data', 'items.json'), { title: 'Audit', items: [
    { id: 'T-1', title: 'feat: one', created: '2026-11-24T10:00:00Z', lane: 'todo', ticket: '#7', from_ask: 'a1' },
    { id: 'T-2', title: 'feat: two', created: '2026-11-24T11:00:00Z', lane: 'todo', parent: 'T-3' },
  ] });
  write(site('audit', 'data', 'done-archive.json'), { cards: [ARCHIVED] });
  write(site('audit', 'data', 'events.jsonl'), JSON.stringify({ id: 'a1', ts: '2026-11-24T09:59:00Z', kind: 'ask', data: { text: 'One' } }) + '\n');
  write(site('audit', 'data', 'owner.json'), { topics: [], items: [
    { id: 'q1', topic: 'item:audit/T-2', question: 'Should T-2 wait for T-1 and T-3, as audit/T-3 did?', options: [{ id: 'A', label: 'Wait' }, { id: 'B', label: 'Go' }], asked_at: '2026-11-25T10:00:00Z' },
  ] });
  thread('audit/T-1', { kind: 'hub', line: 'ticket-made', text: 'Created ticket #7' });
  thread('audit/T-2', { command: 'related', text: 'Related to', card: 'audit/T-1' }, { command: 'blocked-by', text: 'Blocked by', card: 'audit/T-3' });
  thread('audit/T-3', { kind: 'hub', line: 'ticket-made', text: 'Created ticket #9' }, { command: 'unblocks', text: 'Unblocks', card: 'audit/T-2' });
}

test("item thread names each card by its ticket, a live one's and an archived one's, in the lines that name another card and in Created ticket", async () => {
  await ticketedBoard();
  const two = await board('--site', 'audit', 'item', 'thread', 'audit/T-2');
  assert.equal(two.code, 0, two.err);
  assert.deepEqual(two.out.trim().split('\n').map((l) => l.slice(l.indexOf(': ') + 2)), ['Related to #7', 'Blocked by #9']);
  const one = await board('--site', 'audit', 'item', 'thread', 'audit/T-1');
  assert.match(one.out, /claude: Created ticket #7\n/);
});

test("cardName reads an archived card by its ticket, and a key on neither the board nor the archive by its id", async () => {
  await ticketedBoard();
  const { cardName } = await import('./store.mjs');
  assert.equal(await cardName(site('audit'), 'audit/T-3'), '#9');
  assert.equal(await cardName(site('audit'), 'audit/T-1'), '#7');
  assert.equal(await cardName(site('audit'), 'audit/T-404'), 'T-404');
});

test("the withdraw refusal and report timing's first line name the card by its ticket", async () => {
  await ticketedBoard();
  write(site('audit', 'data', 'agents', 'T-1.json'), { kind: 'claude', started: '2026-11-25T10:05:00Z' });
  const { withdrawRefused } = await import('./store.mjs');
  assert.equal(await withdrawRefused(site('audit'), 'a1'), 'A build has already started on #7. Block it to stop the build.');
  const live = await board('--site', 'audit', 'report', 'timing', 'audit/T-1');
  assert.equal(live.code, 0, live.err);
  assert.match(live.out, /^#7 feat: one: open, /);
  const archived = await board('--site', 'audit', 'report', 'timing', 'audit/T-3');
  assert.match(archived.out, /^#9 fix: three: closed /);
});

test("the board names an archived card by its ticket: a thread line on the board, a Parent, an archived card's own thread, and a question's push body", async (t) => {
  await ticketedBoard();
  const { base, settled } = await startBoard(t, { site: site('audit'), home });
  await settled();
  const built = await (await fetch(`${base}/api/board`)).json();
  const two = built.items.find((i) => i.key === 'audit/T-2');
  assert.deepEqual(two.parent, { key: 'audit/T-3', ref: '#9' });
  const twoThread = await (await fetch(`${base}/api/thread?key=${encodeURIComponent('audit/T-2')}`)).json();
  assert.deepEqual(twoThread.filter((m) => m.card).map((m) => [m.text, m.ref]), [['Related to #7', '#7'], ['Blocked by #9', '#9']]);
  const threeThread = await (await fetch(`${base}/api/thread?key=${encodeURIComponent('audit/T-3')}`)).json();
  assert.deepEqual(threeThread.map((m) => m.text), ['Created ticket #9', 'Unblocks T-2']);
  const { builtBoard } = await import('./snapshot.mjs');
  const push = ownerActions(await builtBoard(site('audit'))).find((a) => a.tag === 'item-audit/T-2');
  assert.equal(push.body, 'Should T-2 wait for #7 and #9, as #9 did?');
});
