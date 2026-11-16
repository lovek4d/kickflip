import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBoard } from './domain.mjs';

// docs/adr/2026-11-16-1100-a-thread-entry-that-starts-a-wait-reads-waiting-until-it-clears.md
const NOW = Date.parse('2026-11-16T03:00:00Z');
const board = ({ item, threads, working = {} }) => buildBoard({ now: NOW, owner: {}, events: [], threads: { 'w/A1': threads }, working,
  files: [{ slug: 'w', agents: {}, itemFile: { internal: true, items: [{ id: 'A1', title: 'One', ...item }] } }] });
const tap = (ts, command, text) => ({ ts, who: 'claude', command, text });
const foot = (b) => b.threadViews['w/A1'].filter((m) => m.command).map((m) => [m.command, m.state ?? null]);

test("a tap line whose moment starts an open wait reads waiting, and nothing once the wait clears", () => {
  const item = { phase: 'staging', staged_at: '2026-11-16T02:24:59.600Z' };
  const staged = tap('2026-11-16T02:24:59.600Z', 'staged', 'Marked as staged');
  assert.deepEqual(foot(board({ item, threads: [staged] })), [['staged', 'waiting']]);
  assert.deepEqual(foot(board({ item: { phase: 'ready' }, threads: [staged] })), [['staged', null]], 'the wait cleared');
});

test("a line that starts no wait reads nothing, and only the tap nearest the wait's start reads waiting", () => {
  const item = { phase: 'staging', staged_at: '2026-11-16T02:24:59.600Z' };
  const old = tap('2026-11-16T01:00:00Z', 'staged', 'Marked as staged');
  const related = tap('2026-11-16T02:25:09Z', 'related', 'Related to');
  const staged = tap('2026-11-16T02:24:59.600Z', 'staged', 'Marked as staged');
  const near = tap('2026-11-16T02:24:59.570Z', 'staged', 'Marked as staged');
  assert.deepEqual(foot(board({ item, threads: [near] })), [['staged', null]], 'a line a moment apart is not the wait\'s');
  assert.deepEqual(foot(board({ item, threads: [old, staged, related] })), [['staged', null], ['staged', 'waiting'], ['related', null]]);
});
