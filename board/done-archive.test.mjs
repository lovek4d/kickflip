// docs/adr/2026-11-04-0307-the-board-keeps-the-newest-100-done-cards.md
import '../shared/scratch-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startBoard } from '../shared/test-helpers.mjs';
import { buildBoard, archivedOf, slimDone, DONE_KEPT } from './domain.mjs';
import { archiveCards, readArchive, archiveReader, appendMessage, setItem, stripDeadFields, migrateStatuses, migratePhases, splitSharedNotes } from './store.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

const at = (n) => new Date(Date.parse('2026-11-04T10:00:00Z') - n * 60000).toISOString();
// count Done cards D0 (newest) … D<count-1>, then O1, an open card depending on D<count-2>, and O2, an open card
// Related to D<count-1>. D<count-3> still has a question open; D<count-4>, made from ask a1, has a resolved one and an answer.
function waveOf(count) {
  const done = Array.from({ length: count }, (_, n) => ({ id: `D${n}`, title: `Done ${n}`, lane: 'done', lane_at: at(n), closed_at: at(n), created: at(n + 500),
    ...(n === count - 4 ? { from_ask: 'a1' } : {}) }));
  return { title: 'T', items: [...done, { id: 'O1', title: 'Open', lane: 'todo', deps: [`D${count - 2}`] }, { id: 'O2', title: 'Lined up', lane: 'todo', related: [`t/D${count - 1}`] }] };
}
const ownerOf = (count) => ({ topics: [], items: [
  { id: 'q-open', topic: `item:t/D${count - 3}`, question: 'Still open?', options: [{ id: 'a', label: 'A' }] },
  { id: 'q-done', topic: `item:t/D${count - 4}`, question: 'Which badge?', options: [{ id: 'a', label: 'The dot' }], resolved: 'Answered', resolved_at: at(count) },
  { id: 'q-other', topic: 'item:t/D0', question: 'Newest?', options: [{ id: 'a', label: 'A' }], resolved: 'Answered', resolved_at: at(0) },
] });
const snapshotOf = (count) => ({ files: [{ slug: 't', itemFile: waveOf(count), agents: {} }], owner: ownerOf(count), threads: {}, events: [] });

test('the Done cards past the newest 100 leave the board, except the ones an open card names as a dep or Related to and one with a question open', () => {
  const built = buildBoard(snapshotOf(DONE_KEPT + 6));
  assert.deepEqual(archivedOf(built).map((c) => c.key), ['t/D100', 't/D101', 't/D102']);
  assert.deepEqual(archivedOf(buildBoard(snapshotOf(DONE_KEPT))), []);
});

test('a card made from an ask that the archive also linked to it counts the ask once', () => {
  const events = [{ id: 'a1', ts: at(9), kind: 'ask', data: { text: 'Make a badge' } }];
  const count = (askLinks) => buildBoard({ files: [{ slug: 't', itemFile: { items: [{ id: 'D1', title: 'D', lane: 'done', closed_at: at(1), from_ask: 'a1' }] }, agents: {} }], owner: { items: [] },
    threads: { 't/D1': [{ ts: at(1), who: 'claude', text: 'Landed.' }] }, events, askLinks }).items.find((i) => i.key === 't/D1').threadCount;
  assert.equal(count({ a1: 't/D1' }), count({}));
});

test('a slim Done card keeps what the page draws and leaves the rest out', () => {
  const built = buildBoard({ ...snapshotOf(3), files: [{ slug: 't', itemFile: waveOf(3), agents: { D0: { main: { started: at(30), done: at(5), kind: 'claude' } } } }] });
  const card = built.items.find((i) => i.key === 't/D0');
  assert.ok(card.agents.length);
  const slim = slimDone(card);
  assert.equal(slim.agents, undefined);
  assert.equal(slim.created, undefined);
  for (const field of ['key', 'ref', 'title', 'lane', 'sortAt', 'othersAt', 'hasNotes', 'questions', 'manualSteps']) assert.deepEqual(slim[field], card[field], field);
});

function siteOf(count) {
  const home = tempDir('done-archive-');
  const site = path.join(home, 'site');
  fs.mkdirSync(path.join(site, 'data', 'threads'), { recursive: true });
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'T', items: 'data/items.json', slug: 't' }));
  fs.writeFileSync(path.join(site, 'data', 'items.json'), JSON.stringify(waveOf(count)));
  fs.writeFileSync(path.join(site, 'data', 'owner.json'), JSON.stringify(ownerOf(count)));
  fs.writeFileSync(path.join(site, 'data', 'threads', `t__D${count - 4}.jsonl`), JSON.stringify({ ts: at(count + 1), who: 'claude', text: 'Landed.' }) + '\n');
  fs.writeFileSync(path.join(site, 'data', 'events.jsonl'), [{ id: 'a1', ts: at(count + 3), kind: 'ask', data: { text: 'Make a badge' } },
    { id: 'e1', ts: at(count + 2), kind: 'owner-answer', data: { id: 'q-done', choice: 'a', label: 'The dot' } }].map((e) => JSON.stringify(e) + '\n').join(''));
  return { home, site, read: (f) => JSON.parse(fs.readFileSync(path.join(site, 'data', f), 'utf8')) };
}

test('an archived card leaves the item file with its resolved questions, its thread stays, and a command that names it brings it back', async () => {
  const { home, site, read } = siteOf(DONE_KEPT + 6);
  try {
    const threadBefore = fs.readFileSync(path.join(site, 'data', 'threads', 't__D102.jsonl'), 'utf8');
    const picks = [{ key: 't/D102', closed_at: at(102) }, { key: 't/D101', closed_at: at(101) }];
    await archiveCards(site, picks);
    assert.deepEqual(read('items.json').items.filter((it) => /^D10[12]$/.test(it.id)), []);
    assert.equal(read('items.json').items.length, DONE_KEPT + 6);
    assert.deepEqual(read('owner.json').items.map((q) => q.id), ['q-open', 'q-other']);
    const archive = await readArchive(site);
    assert.deepEqual(archive.map((a) => [a.key, a.file, a.closed_at, a.item.title, a.questions.map((q) => q.id)]),
      [['t/D101', 't', at(101), 'Done 101', []], ['t/D102', 't', at(102), 'Done 102', ['q-done']]], 'newest closed first');
    assert.ok(archive.every((a) => !('card' in a)), 'an entry keeps no page task');
    assert.equal(fs.readFileSync(path.join(site, 'data', 'threads', 't__D102.jsonl'), 'utf8'), threadBefore, 'the thread stays whole');
    await archiveCards(site, picks);
    assert.equal((await readArchive(site)).length, 2, 'archiving twice moves nothing twice');
    assert.deepEqual(read('ask-links.json').links, { a1: 't/D102' }, 'the ask it was made from goes with it');

    await appendMessage(site, 't/D102', { text: 'Reopened by a reply.' });
    assert.deepEqual((await readArchive(site)).map((a) => a.key), ['t/D101']);
    assert.ok(read('items.json').items.some((it) => it.id === 'D102' && it.title === 'Done 102'));
    assert.ok(read('owner.json').items.some((q) => q.id === 'q-done'));
    assert.match(fs.readFileSync(path.join(site, 'data', 'threads', 't__D102.jsonl'), 'utf8'), /Reopened by a reply/);
    assert.deepEqual(read('ask-links.json').links, {});
    await setItem(site, 't/D101', { next: 'Check it again' });
    assert.deepEqual(await readArchive(site), []);
    assert.equal(fs.existsSync(path.join(site, 'data', 'done-archive.json')), false, 'an empty archive is no file');
    assert.equal(read('items.json').items.find((it) => it.id === 'D101').next, 'Check it again');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// docs/adr/2026-11-06-1547-a-cards-pr-badges-stay-once-added.md
test("an archived card keeps each PR's last CI, reviews and Codex count, and draws them with no GitHub state", async () => {
  const { home, site, read } = siteOf(DONE_KEPT + 6);
  try {
    const wave = read('items.json');
    wave.items.find((it) => it.id === 'D102').prs = [{ number: 7, merged_at: at(102) }, { repo: 'o/site', number: 1 }];
    fs.writeFileSync(path.join(site, 'data', 'items.json'), JSON.stringify(wave));
    const view = { number: 7, url: 'https://github.com/o/repo/pull/7', state: 'MERGED', status: 'merged', checks: { state: 'fail', fail: 1 }, reviews: { 'jamie-gh': 'APPROVED', ben: 'COMMENTED' }, title: 'T' };
    await archiveCards(site, [{ key: 't/D102', closed_at: at(102), prs: [view, { repo: 'o/site', number: 1, status: null }] }]);
    const [entry] = await readArchive(site);
    assert.deepEqual(entry.item.prs, [
      { number: 7, merged_at: at(102), kept: { checks: { state: 'fail', fail: 1 }, reviews: { 'jamie-gh': 'APPROVED', ben: 'COMMENTED' } } },
      { repo: 'o/site', number: 1 },
    ], 'a PR GitHub was never read for keeps nothing');
    const card = buildBoard({ files: [{ slug: 't', itemFile: { items: [entry.item] }, agents: {} }], owner: { items: [] }, threads: {}, events: [], github: 'o/repo',
      reviewers: [{ name: 'Jamie', github: 'jamie-gh' }] }).items[0];
    assert.deepEqual([card.lane, card.pr.status, card.pr.checks.state, card.review.Jamie.state, card.otherReviews], ['done', 'merged', 'fail', 'approved', [{ github: 'ben', state: 'commented' }]]);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("the strip drops what nothing reads: an archive entry's page card for its closing time, an item's summary, a question's push_tag and no_change", async () => {
  const { home, site, read } = siteOf(3);
  const write = (f, v) => fs.writeFileSync(path.join(site, 'data', f), JSON.stringify(v));
  try {
    const q = { id: 'q-old', topic: 'item:t/X1', question: 'Old?', resolved: 'Answered', resolved_at: at(9), push_tag: 'item-t/X1', no_change: true };
    write('done-archive.json', { cards: [
      { key: 't/X1', file: 't', archived_at: at(1), card: { key: 't/X1', title: 'Old', sortAt: at(8) }, item: { id: 'X1', title: 'Old', lane: 'done', summary: 'Gone' }, questions: [q], asks: [] },
      { key: 't/X2', file: 't', archived_at: at(1), closed_at: at(9), item: { id: 'X2', title: 'Kept', lane: 'done', closed_at: at(9) }, questions: [], asks: [] }] });
    const wave = read('items.json');
    wave.items[1].summary = 'Gone too';
    wave.internal = true;
    write('items.json', wave);
    const owner = read('owner.json');
    Object.assign(owner.items[2], { push_tag: 'item-t/D0', no_change: false });
    write('owner.json', owner);

    await stripDeadFields(site);
    assert.deepEqual(read('done-archive.json').cards, [
      { key: 't/X1', file: 't', archived_at: at(1), closed_at: at(8), item: { id: 'X1', title: 'Old', lane: 'done' }, questions: [{ id: 'q-old', topic: 'item:t/X1', question: 'Old?', resolved: 'Answered', resolved_at: at(9) }], asks: [] },
      { key: 't/X2', file: 't', archived_at: at(1), closed_at: at(9), item: { id: 'X2', title: 'Kept', lane: 'done', closed_at: at(9) }, questions: [], asks: [] }]);
    assert.ok(read('items.json').items.every((it) => !('summary' in it)));
    assert.ok(!('internal' in read('items.json')), "the item file's internal flag is dropped");
    assert.deepEqual(read('owner.json').items[2], ownerOf(3).items[2]);
    const before = ['items.json', 'owner.json', 'done-archive.json'].map((f) => fs.statSync(path.join(site, 'data', f)).mtimeMs);
    await stripDeadFields(site);
    assert.deepEqual(['items.json', 'owner.json', 'done-archive.json'].map((f) => fs.statSync(path.join(site, 'data', f)).mtimeMs), before, 'a stripped board writes nothing');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('the start-up passes share one read of the archive: a reader reads the file once and each pass takes its cards', async () => {
  const { home, site, read } = siteOf(3);
  const file = path.join(site, 'data', 'done-archive.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ cards: [{ key: 't/X1', file: 't', closed_at: at(8), item: { id: 'X1', title: 'Old', lane: 'done', state: 'x', summary: 'Gone' }, questions: [], asks: [] }] }));
    const cards = archiveReader(site);
    const first = await cards();
    fs.rmSync(file);
    assert.equal(await cards(), first, 'the second ask is the first read, not another');
    await migrateStatuses(site, cards);
    await migratePhases(site, cards);
    await splitSharedNotes(site, cards);
    await stripDeadFields(site, cards);
    assert.deepEqual(read('done-archive.json').cards.map((c) => c.item), [{ id: 'X1', title: 'Old', lane: 'done', phase: 'closed' }], 'the passes worked on the cards the reader held, as the file no longer did');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('the server archives Done cards past the newest 100 as it starts, sends the rest slim, and pages the archive in 100 at a time', async (t) => {
  const count = 2 * DONE_KEPT + 36;
  const { home, site, read } = siteOf(count);
  const write = (f, v) => fs.writeFileSync(path.join(site, 'data', f), JSON.stringify(v));
  const wave = read('items.json');
  wave.items[0].summary = 'Nothing reads this.';
  wave.items[0].parent = `t/D${count - 5}`;
  write('items.json', wave);
  const owner = read('owner.json');
  Object.assign(owner.items.find((q) => q.id === 'q-other'), { push_tag: 'item-t/D0', no_change: true });
  write('owner.json', owner);
  const { base, changed, settled } = await startBoard(t, { site, home });
  await settled();
  assert.equal((await readArchive(site)).length, count - DONE_KEPT - 3, 'the start archives every task past the newest 100 but the kept 3');
  // The server sees its archive's writes to the item file once it is told of them.
  changed('data/items.json');
  await settled();
  const board = await (await fetch(`${base}/api/board`)).json();
  assert.equal(board.items.filter((i) => i.lane === 'done').length, DONE_KEPT + 3, 'the board leaves the archived tasks out');
  const done = board.items.filter((i) => i.lane === 'done');
  assert.equal(board.doneArchived, count - DONE_KEPT - 3);
  assert.ok(done.every((c) => !('agents' in c) && !('created' in c)), 'Done tasks come slim');
  assert.ok(board.items.find((i) => i.key === 't/O1').created !== undefined, 'open tasks come whole');
  assert.ok(!read('items.json').items.some((it) => it.id === 'D100'));
  assert.ok(!board.items.some((i) => i.key === 'ask:a1'), 'an ask made into an archived task stays out of Todo');
  assert.equal(board.moved['ask:a1'], `t/D${count - 4}`);

  const first = await (await fetch(`${base}/api/done`)).json();
  assert.deepEqual([first.cards.length, first.cards[0].key, first.cards.at(-1).key, first.left], [DONE_KEPT, 't/D100', 't/D199', count - DONE_KEPT - 3 - DONE_KEPT]);
  assert.ok(first.cards.every((c) => c.lane === 'done' && !('agents' in c) && !('created' in c)), 'paged tasks come slim');
  assert.deepEqual([first.cards[0].title, first.cards[0].lane, first.cards[0].sortAt, first.cards[0].file], ['Done 100', 'done', at(100), 't'], 'a paged task is built as it pages in');
  const found = await (await fetch(`${base}/api/done?q=${encodeURIComponent('DONE  150')}`)).json();
  assert.deepEqual([found.cards.map((c) => c.key), found.left], [['t/D150'], 0], 'q keeps the archived tasks holding every word, any case');
  const wide = await (await fetch(`${base}/api/done?q=done`)).json();
  assert.deepEqual([wide.cards.length, wide.cards[0].key, wide.left], [DONE_KEPT, 't/D100', count - DONE_KEPT - 3 - DONE_KEPT], 'matches page 100 at a time, newest first');
  const wideNext = await (await fetch(`${base}/api/done?q=done&before=${encodeURIComponent(`${wide.cards.at(-1).sortAt}|${wide.cards.at(-1).key}`)}`)).json();
  assert.equal(wideNext.cards[0].key, 't/D200', 'a page of matches follows the cursor');
  const last = first.cards.at(-1);
  const second = await (await fetch(`${base}/api/done?before=${encodeURIComponent(`${last.sortAt}|${last.key}`)}`)).json();
  assert.deepEqual([second.cards.map((c) => c.key), second.left], [Array.from({ length: count - 3 - 200 }, (_, n) => `t/D${200 + n}`), 0]);
  const answered = second.cards.find((c) => c.key === `t/D${count - 4}`);
  assert.equal(answered.questions?.state, 'resolved', "a paged task reads its archived questions");
  assert.ok(answered.threadCount >= 1, 'and its thread');
  assert.deepEqual(second.cards.find((c) => c.key === `t/D${count - 5}`).children.map((c) => c.key), ['t/D0'], 'a paged task links the board tasks that name it');
  assert.ok((await readArchive(site)).every((a) => !('card' in a) && a.closed_at));
  assert.equal(read('items.json').items.find((it) => it.id === 'D0').summary, undefined, 'the start strips an item summary');
  assert.deepEqual(Object.keys(read('owner.json').items.find((q) => q.id === 'q-other')).filter((k) => ['push_tag', 'no_change', 'resolved_at'].includes(k)), ['resolved_at'],
    "the start strips a question's push_tag and no_change and keeps resolved_at");

  const archived = `t/D${count - 4}`;
  assert.ok((await readArchive(site)).some((a) => a.key === archived));
  const thread = await (await fetch(`${base}/api/thread?key=${encodeURIComponent(archived)}`)).json();
  assert.deepEqual(thread.map((m) => m.text), ['Make a badge', 'Question 1 · Which badge?\n→ The dot', 'Landed.'], "an archived task's thread reads whole, its ask and its answers with their questions");
});

test("the strip renames a question's suggested.card to suggested.task, in owner.json and in the archive, and then writes nothing", async () => {
  const { home, site, read } = siteOf(3);
  const write = (f, v) => fs.writeFileSync(path.join(site, 'data', f), JSON.stringify(v));
  try {
    const owner = read('owner.json');
    owner.items[2].options = [{ id: 'A', label: 'Keep' }];
    owner.items[2].suggested = { option: 'A', card: '#186', answer: 'Keep.' };
    write('owner.json', owner);
    write('done-archive.json', { cards: [{ key: 't/X1', file: 't', archived_at: at(1), closed_at: at(8), item: { id: 'X1', title: 'Old', lane: 'done' },
      questions: [{ id: 'q-old', topic: 'item:t/X1', question: 'Old?', suggested: { option: 'A', card: '#7', answer: 'Yes.', reason: 'Same.' } }], asks: [] }] });
    await stripDeadFields(site);
    assert.deepEqual(read('owner.json').items[2].suggested, { option: 'A', answer: 'Keep.', task: '#186' });
    assert.deepEqual(read('done-archive.json').cards[0].questions[0].suggested, { option: 'A', answer: 'Yes.', reason: 'Same.', task: '#7' });
    const before = ['owner.json', 'done-archive.json'].map((f) => fs.statSync(path.join(site, 'data', f)).mtimeMs);
    await stripDeadFields(site);
    assert.deepEqual(['owner.json', 'done-archive.json'].map((f) => fs.statSync(path.join(site, 'data', f)).mtimeMs), before);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
