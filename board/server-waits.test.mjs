import { home } from '../shared/scratch-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startBoard } from '../shared/test-helpers.mjs';

// docs/adr/2026-11-15-0930-the-board-header-counts-what-waits-on-the-orchestrator.md
test('/api/board carries what waits on the orchestrator, in the waits file\'s order, as the header chip draws it', async (t) => {
  const site = path.join(home, 'site');
  const data = path.join(site, 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'T', items: 'data/items.json', slug: 't' }));
  fs.writeFileSync(path.join(data, 'items.json'), JSON.stringify({ items: [
    { id: 'A1', title: 'One', lane: 'todo', phase: 'staging', staged_at: '2026-11-15T08:00:00.000Z' },
    { id: 'A2', title: 'Two', lane: 'todo', phase: 'staging', staged_at: '2026-11-15T07:00:00.000Z' },
  ] }));
  fs.writeFileSync(path.join(data, 'owner.json'), '{"items":[]}');
  const { base, settled } = await startBoard(t, { site });
  // The start's waits pass has written the file once its passes settle.
  await settled();

  const stored = JSON.parse(fs.readFileSync(path.join(data, 'orchestrator-waits.json'), 'utf8')).waits;
  const board = await (await fetch(`${base}/api/board`)).json();
  assert.deepEqual(board.orchestratorWaits, stored.map(({ key, ref, title, kind, since, tone }) => ({ key, ref, title, kind, since, tone })));
  assert.deepEqual(board.orchestratorWaits.map((w) => [w.key, w.kind]), [['t/A2', 'staging'], ['t/A1', 'staging']], 'oldest first');
  assert.ok(board.orchestratorWaits.every((w) => ['grey', 'orange', 'red'].includes(w.tone)), "each wait carries the server's tone");
});
