// docs/adr/2026-11-22-2221-an-approved-tasks-splits-land-in-todo-as-staging.md: with "Automatically stage split
// tickets" on, a split of a staged task files straight into Todo as staging, with its Parent and copied gates; off, it
// comes in as an ask through New.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { addItem, askItem } from './store.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

function world(t, { board = {}, hub } = {}) {
  const home = tempDir('stage-splits-home-');
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; });
  if (hub) {
    fs.mkdirSync(path.join(home, '.claude', 'kickflip'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'kickflip', 'settings.json'), JSON.stringify({ boardDefaults: hub }));
  }
  const site = tempDir('stage-splits-');
  const data = path.join(site, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ items: 'data/items.json', slug: 't', ...board }));
  fs.writeFileSync(path.join(data, 'notes.md'), '# Task\n');
  fs.writeFileSync(path.join(data, 'items.json'), JSON.stringify({ items: [
    { id: 'A1', title: 'feat(board): the whole', lane: 'todo', phase: 'staging', staged_at: new Date().toISOString(), plan: 'notes.md', gates: { prototype: 'no' } },
    { id: 'B1', title: 'feat(board): still grilling', lane: 'todo', phase: 'grilling', plan: 'notes.md' },
  ] }));
  fs.writeFileSync(path.join(data, 'owner.json'), JSON.stringify({ topics: [], items: [] }));
  fs.writeFileSync(path.join(data, 'events.jsonl'), '');
  const read = (id) => JSON.parse(fs.readFileSync(path.join(data, 'items.json'), 'utf8')).items.find((it) => it.id === id);
  const thread = (id) => fs.readFileSync(path.join(data, 'threads', `t__${id}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { site, read, thread };
}
const slice = (fields = {}) => ({ title: 'feat(board): slice one', notes: 'Slice one of t/A1.', parent: 't/A1', split: true, phase: 'staging', intake: true, filed: true, ...fields });

test('with the hub default on, a split of a staged task files into Todo as staging with its Parent and gates, and needs no --relate', async (t) => {
  const w = world(t);
  const { key } = await addItem(w.site, 't', slice());
  const card = w.read(key.split('/')[1]);
  assert.deepEqual([card.lane, card.phase, card.parent, card.gates], ['todo', 'staging', 't/A1', { prototype: 'no' }]);
  assert.ok(card.staged_at);
  assert.deepEqual(w.thread(card.id).map((l) => [l.command, l.text]), [['created-from', 'Created from'], ['staged', 'Marked as staged']]);
  assert.equal(w.thread(card.id).at(-1).ts, card.staged_at, 'Marked as staged is its newest line, at the moment it staged');
  assert.deepEqual(w.thread('A1').map((l) => [l.command, l.card]), [['created', key]]);
});

test('a staged split is refused for a Parent not staging, without --split, or with no Parent', async (t) => {
  const w = world(t);
  await assert.rejects(addItem(w.site, 't', slice({ parent: 't/B1' })), /t\/B1 reads grilling, not staging/);
  await assert.rejects(addItem(w.site, 't', slice({ split: undefined })), /--phase staging is set by the board/);
  await assert.rejects(addItem(w.site, 't', slice({ parent: undefined, split: undefined, relate: 't/A1' })), /--phase staging is set by the board/);
});

test('with Automatically stage split tickets off, by the hub or by the board, a staged split is refused for the ask form', async (t) => {
  for (const setup of [{ hub: { stage_splits: false } }, { board: { stage_splits: false } }]) {
    const w = world(t, setup);
    await assert.rejects(addItem(w.site, 't', slice()), /Automatically stage split tickets is off on this board: item add t --ask "<its slice>" --parent t\/A1 --split/);
    const { key } = await askItem(w.site, 't', { text: 'Slice one', parent: 't/A1', split: true });
    assert.equal(w.read(key.split('/')[1]).phase, undefined, 'the ask form still files it in New');
  }
});

test('with the setting on, a split of a staged task through --ask is refused for the staged form; a split of an unstaged task still comes in as an ask', async (t) => {
  const w = world(t, { hub: { stage_splits: false }, board: { stage_splits: true } });
  await assert.rejects(askItem(w.site, 't', { text: 'Slice one', parent: 't/A1', split: true }),
    /Automatically stage split tickets is on: file it staged, item add t --title "<its title>" --notes-from <its slice\.md> --parent t\/A1 --split --phase staging/);
  const { key } = await askItem(w.site, 't', { text: 'Slice of a grilling task', parent: 't/B1', split: true });
  assert.equal(w.read(key.split('/')[1]).parent, 't/B1');
  const follow = await askItem(w.site, 't', { text: 'A follow-up', parent: 't/A1' });
  assert.equal(w.read(follow.key.split('/')[1]).parent, 't/A1', 'a follow-up, not a split, still comes in as an ask');
});
