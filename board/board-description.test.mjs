import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, site, write, read, board } from './board-fixture.mjs';

const manifestFile = () => at('kickflip', 'manifest.json');
const entry = (route) => read(manifestFile()).sites[route];

// docs/adr/2026-11-16-2100-overnight-triage-proposes-a-stale-board-description.md
test('description prints the board\'s description and description set writes an approved triage proposal to the manifest', async () => {
  write(manifestFile(), { sites: { orch: { dir: site('orch'), port: 1, cmd: [process.execPath, '/skill/board/server.mjs'], description: 'Old words', description_source: 'new-board', description_at: '2026-11-12T10:00:00.000Z' } } });
  const shown = await board('--site', 'orch', 'description');
  assert.equal(shown.code, 0, shown.err);
  assert.deepEqual(JSON.parse(shown.out), { description: 'Old words', source: 'new-board', at: '2026-11-12T10:00:00.000Z', checked: '', proposal: null });

  const set = await board('--site', 'orch', 'description', 'set', '  Builds the hub and its boards  ');
  assert.equal(set.code, 0, set.err);
  assert.deepEqual([entry('orch').description, entry('orch').description_source, entry('orch').port], ['Builds the hub and its boards', 'triage', 1]);
  assert.equal(JSON.parse(set.out).source, 'triage');

  for (const bad of ['   ', 'x'.repeat(241)]) assert.equal((await board('--site', 'orch', 'description', 'set', bad)).code, 1);
  assert.match((await board('--site', 'orch', 'description', 'set', ' ')).err, /A board needs a description/);
  assert.equal(entry('orch').description, 'Builds the hub and its boards');
  assert.notEqual((await board('description')).code, 0);

  const checked = await board('--site', 'orch', 'description', 'checked');
  assert.equal(checked.code, 0, checked.err);
  assert.equal(JSON.parse(checked.out).checked, entry('orch').description_checked_at);
  assert.ok(entry('orch').description_checked_at);
});

test('item add records a description proposal, refuses a second while it is open, and its close ends it', async () => {
  write(manifestFile(), { sites: { audit: { dir: site('audit'), port: 1, cmd: [process.execPath, '/skill/board/server.mjs'] } } });
  const propose = () => board('--site', 'audit', 'item', 'add', 'audit', '--phase', 'discussing', '--relate', 'audit/A1', '--title', 'chore(board): update /audit\'s description', '--notes', 'The description no longer says what the board is for.', '--text', 'A proposed description.');
  const first = await propose();
  assert.equal(first.code, 0, first.err);
  const key = entry('audit').description_proposal;
  assert.match(key, /^audit\//);
  assert.ok(entry('audit').description_checked_at);
  assert.equal(JSON.parse((await board('--site', 'audit', 'description')).out).proposal, key);

  const second = await propose();
  assert.equal(second.code, 1);
  assert.match(second.err, new RegExp(`/audit already has an open description proposal, ${key}`));

  const closed = await board('--site', 'audit', 'item', 'set', key, '--done', '--text', 'Kept the current description', '--force');
  assert.equal(closed.code, 0, closed.err);
  assert.equal(JSON.parse((await board('--site', 'audit', 'description')).out).proposal, null);
  const again = await propose();
  assert.equal(again.code, 0, again.err);
  assert.notEqual(entry('audit').description_proposal, key);
});
