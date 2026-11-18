// docs/adr/2026-11-18-1200-composer-drafts-live-on-the-server.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from '../shared/temp-dir.mjs';
import { draftOf, draftsFile, pruneDrafts, readDrafts, saveDraft } from './drafts.mjs';

const shot = { name: 'shot.png', url: 'uploads/1-shot.png', type: 'image/png', size: 3 };

test('draftOf takes a composer id, its text and its uploaded files, rebuilding each path from the site and refusing anything else', () => {
  const site = '/s';
  assert.deepEqual(draftOf(site, { id: 'item:w/T-1', text: 'Hi', files: [{ ...shot, path: '/etc/passwd', extra: 1 }] }),
    { id: 'item:w/T-1', text: 'Hi', files: [{ ...shot, path: path.join(site, 'data', shot.url) }] });
  assert.deepEqual(draftOf(site, { id: 'ask', text: '' }), { id: 'ask', text: '', files: [] });
  for (const bad of [{}, { id: 'edit:e1', text: '' }, { id: 'item:', text: '' }, { id: 'ask', text: 5 }, { id: 'ask', text: 'x'.repeat(100_001) },
    { id: 'ask', text: '', files: {} }, { id: 'ask', text: '', files: [{ ...shot, url: '../board.json' }] }]) {
    assert.throws(() => draftOf(site, bad), (e) => e.status === 400, JSON.stringify(bad).slice(0, 80));
  }
});

test('saveDraft stamps each save later than the one it replaces, an emptied draft staying with its time; pruneDrafts drops the ids refused and writes only on a change', async () => {
  const site = tempDir('drafts-');
  assert.deepEqual(await readDrafts(site), {});
  const one = await saveDraft(site, { id: 'item:w/T-1', text: 'Hi', files: [] });
  const two = await saveDraft(site, { id: 'item:w/T-1', text: 'Hi there', files: [shot] });
  assert.ok(two.at > one.at, `${two.at} after ${one.at}`);
  await saveDraft(site, { id: 'ask', text: 'New', files: [] });
  const cleared = await saveDraft(site, { id: 'ask', text: '', files: [] });
  assert.deepEqual(await readDrafts(site), { 'item:w/T-1': { text: 'Hi there', files: [shot], at: two.at }, ask: { text: '', files: [], at: cleared.at } });

  const written = fs.statSync(draftsFile(site)).mtimeMs;
  await pruneDrafts(site, () => true);
  assert.equal(fs.statSync(draftsFile(site)).mtimeMs, written, 'nothing to drop writes nothing');
  await pruneDrafts(site, (id) => id === 'ask');
  assert.deepEqual(Object.keys(await readDrafts(site)), ['ask']);
});
