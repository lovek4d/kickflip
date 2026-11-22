// docs/adr/2026-11-22-0200-a-card-carries-board-only-tags.md: a card carries several tags in its item file, set with
// item set --tag/--untag or the owner's Tag… picker (a card-tag tap), each change a line in its thread. Tags stay on
// the board.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { site, lines, read, write, board } from './board-fixture.mjs';
import { tapPlan, buildBoard, DONE_FIELDS } from './domain.mjs';
import { tagName, retagged } from './cards.mjs';

const items = () => read(site('audit', 'data', 'items.json')).items;
const item = (id) => items().find((it) => it.id === id);
const thread = (id) => {
  const file = site('audit', 'data', 'threads', `audit__${id}.jsonl`);
  return fs.existsSync(file) ? lines(file) : [];
};
const card = (id, extra = {}) => {
  const file = site('audit', 'data', 'items.json');
  write(file, { ...read(file), items: [...read(file).items, { id, title: `feat: ${id}`, lane: 'todo', phase: 'grilling', ...extra }] });
};
const set = (id, ...args) => board('item', 'set', `audit/${id}`, '--site', 'audit', ...args);

test('a tag name is trimmed with its spaces collapsed; an empty one, one with a comma or one past 48 characters is refused', () => {
  assert.equal(tagName('  dark   mode '), 'dark mode');
  assert.throws(() => tagName('  '), /a tag needs a name/);
  assert.throws(() => tagName('a,b'), /a tag takes no comma/);
  assert.equal(tagName('x'.repeat(48)), 'x'.repeat(48));
  assert.throws(() => tagName('x'.repeat(49)), /48 characters at most/);
});

test('retagged adds tags a card lacks and drops the ones named, matching a tag whatever its case, in the order added', () => {
  assert.deepEqual(retagged([], { add: ['phone', 'perf'] }), ['phone', 'perf']);
  assert.deepEqual(retagged(['phone'], { add: ['Phone', 'sidebar'] }), ['phone', 'sidebar'], 'a tag differing only in case is the same tag');
  assert.deepEqual(retagged(['phone', 'perf'], { drop: ['PERF', 'docs'] }), ['phone']);
  assert.deepEqual(retagged(undefined, {}), []);
});

test('item set --tag adds tags to a card and --untag takes them off, each with a Tagged or Untagged line in its thread', async () => {
  card('G1');
  const r = await set('G1', '--tag', 'phone, perf');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(item('G1').tags, ['phone', 'perf']);
  assert.deepEqual(thread('G1').filter((m) => m.command === 'tagged').map((m) => m.text), ['Tagged phone', 'Tagged perf']);
  assert.equal((await set('G1', '--untag', 'phone', '--tag', 'sidebar')).code, 0);
  assert.deepEqual(item('G1').tags, ['perf', 'sidebar']);
  assert.deepEqual(thread('G1').filter((m) => m.command === 'untagged').map((m) => m.text), ['Untagged phone']);
  // The last tag off leaves no tags field.
  assert.equal((await set('G1', '--untag', 'perf,sidebar')).code, 0);
  assert.equal('tags' in item('G1'), false);
});

test('item set --tag works on a Done card, refuses a bad name or a change that changes nothing, and goes with other flags', async () => {
  card('D1', { lane: 'done', closed_at: '2026-11-20T00:00:00.000Z' });
  assert.equal((await set('D1', '--tag', 'legacy')).code, 0);
  assert.deepEqual(item('D1').tags, ['legacy']);
  const same = await set('D1', '--tag', 'Legacy');
  assert.notEqual(same.code, 0);
  assert.match(same.err, /already carries every tag named/);
  const none = await set('D1', '--untag', 'docs');
  assert.notEqual(none.code, 0);
  assert.match(none.err, /carries none of the tags named/);
  assert.match((await set('D1', '--tag', 'x'.repeat(49))).err, /48 characters at most/);
  card('G2');
  const both = await set('G2', '--tag', 'phone', '--title', 'feat: renamed');
  assert.equal(both.code, 0, both.err);
  assert.deepEqual([item('G2').tags, item('G2').title], [['phone'], 'feat: renamed']);
});

test("the owner's card-tag tap is written to the item file with no event, refused with why when it changes nothing", () => {
  const tapCard = { key: 'w/A1', ref: '#1', kind: 'work', lane: 'done', tags: ['phone'] };
  assert.deepEqual(tapPlan(tapCard, 'card-tag', { key: 'w/A1', tag: 'perf', on: true }), [{ do: 'record', nothing: '#1 already carries the tag perf, so nothing changed.', stops: false }]);
  assert.deepEqual(tapPlan(tapCard, 'card-tag', { key: 'w/A1', tag: 'perf', on: false }), [{ do: 'record', nothing: '#1 doesn’t carry the tag perf, so nothing changed.', stops: false }]);
});

test("a built card carries its item file's tags, a Done one included, and none as an empty list", () => {
  const built = buildBoard({ fromWaves: false, files: [{ slug: 's', itemFile: { items: [
    { id: 'S1', title: 'One', tags: ['phone', 'perf'] }, { id: 'S2', title: 'Two' }] } }] });
  assert.deepEqual(built.items.map((i) => i.tags), [['phone', 'perf'], []]);
  assert.ok(DONE_FIELDS.includes('tags'), 'a slimmed Done card keeps its tags');
});
