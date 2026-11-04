// docs/adr/2026-11-04-0307-the-board-keeps-the-newest-100-done-cards.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePorts, until } from '../shared/test-helpers.mjs';
import { buildBoard, archivedOf, slimDone, DONE_KEPT } from './domain.mjs';
import { archiveCards, readArchive, appendThread, setItem } from './store.mjs';

const at = (n) => new Date(Date.parse('2026-11-04T10:00:00Z') - n * 60000).toISOString();
// count Done cards D0 (newest) … D<count-1>, then O1, an open card depending on D<count-2>, and O2, in an open
// lineup with D<count-1>. D<count-3> still has a question open; D<count-4>, made from ask a1, has a resolved one and an answer.
function waveOf(count) {
  const done = Array.from({ length: count }, (_, n) => ({ id: `D${n}`, title: `Done ${n}`, status: n === 7 ? 'dropped' : 'done', status_at: at(n), created: at(n + 500),
    ...(n === count - 4 ? { from_ask: 'a1' } : {}) }));
  return { title: 'T', items: [...done, { id: 'O1', title: 'Open', status: 'planned', deps: [`D${count - 2}`] }, { id: 'O2', title: 'Lined up', status: 'planned' }],
    lineups: [{ slug: 'lu', title: 'Lineup', phases: [[`D${count - 1}`], ['O2']] }] };
}
const ownerOf = (count) => ({ topics: [], items: [
  { id: 'q-open', topic: `item:t/D${count - 3}`, question: 'Still open?', options: [{ id: 'a', label: 'A' }] },
  { id: 'q-done', topic: `item:t/D${count - 4}`, question: 'Which badge?', options: [{ id: 'a', label: 'The dot' }], resolved: 'Answered', resolved_at: at(count) },
  { id: 'q-other', topic: 'item:t/D0', question: 'Newest?', options: [{ id: 'a', label: 'A' }], resolved: 'Answered', resolved_at: at(0) },
] });
const snapshotOf = (count) => ({ waves: [{ slug: 't', wave: waveOf(count), agents: {} }], owner: ownerOf(count), threads: {}, events: [] });

test('the Done cards past the newest 100 leave the board, except one in an open wave, one an open card names and one with a question open', () => {
  const built = buildBoard(snapshotOf(DONE_KEPT + 6));
  assert.equal(DONE_KEPT, 100);
  assert.deepEqual(archivedOf(built).map((c) => c.key), ['t/D100', 't/D101', 't/D102']);
  assert.deepEqual(archivedOf(buildBoard(snapshotOf(DONE_KEPT))), []);
});

test('a slim Done card keeps what the page draws and leaves the rest out', () => {
  const built = buildBoard({ ...snapshotOf(3), waves: [{ slug: 't', wave: waveOf(3), agents: { D0: { main: { started: at(30), done: at(5), kind: 'claude' } } } }] });
  const card = built.items.find((i) => i.key === 't/D0');
  assert.ok(card.agents.length);
  const slim = slimDone(card);
  assert.equal(slim.agents, undefined);
  assert.equal(slim.created, undefined);
  for (const field of ['key', 'ref', 'title', 'lane', 'status', 'sortAt', 'othersAt', 'hasNotes', 'questions', 'manualSteps']) assert.deepEqual(slim[field], card[field], field);
});

function siteOf(count) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'done-archive-'));
  const site = path.join(home, 'site');
  fs.mkdirSync(path.join(site, 'data', 'threads'), { recursive: true });
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'T', items: 'data/wave.json', slug: 't' }));
  fs.writeFileSync(path.join(site, 'data', 'wave.json'), JSON.stringify(waveOf(count)));
  fs.writeFileSync(path.join(site, 'data', 'owner.json'), JSON.stringify(ownerOf(count)));
  fs.writeFileSync(path.join(site, 'data', 'threads', `t__D${count - 4}.jsonl`), JSON.stringify({ ts: at(count + 1), who: 'claude', text: 'Landed.' }) + '\n');
  fs.writeFileSync(path.join(site, 'data', 'events.jsonl'), [{ id: 'a1', ts: at(count + 3), kind: 'ask', data: { text: 'Make a badge' } },
    { id: 'e1', ts: at(count + 2), kind: 'owner-answer', data: { id: 'q-done', choice: 'a', label: 'The dot' } }].map((e) => JSON.stringify(e) + '\n').join(''));
  return { home, site, read: (f) => JSON.parse(fs.readFileSync(path.join(site, 'data', f), 'utf8')) };
}

test('an archived card leaves the wave file with its resolved questions, its thread stays, and a command that names it brings it back', async () => {
  const { home, site, read } = siteOf(DONE_KEPT + 6);
  try {
    const threadBefore = fs.readFileSync(path.join(site, 'data', 'threads', 't__D102.jsonl'), 'utf8');
    const picks = [{ key: 't/D102', card: { key: 't/D102', title: 'Done 102', sortAt: at(102) } }, { key: 't/D101', card: { key: 't/D101', title: 'Done 101', sortAt: at(101) } }];
    await archiveCards(site, picks);
    assert.deepEqual(read('wave.json').items.filter((it) => /^D10[12]$/.test(it.id)), []);
    assert.equal(read('wave.json').items.length, DONE_KEPT + 6);
    assert.deepEqual(read('owner.json').items.map((q) => q.id), ['q-open', 'q-other']);
    const archive = await readArchive(site);
    assert.deepEqual(archive.map((a) => [a.key, a.wave, a.card.title, a.item.title, a.questions.map((q) => q.id)]),
      [['t/D101', 't', 'Done 101', 'Done 101', []], ['t/D102', 't', 'Done 102', 'Done 102', ['q-done']]], 'newest closed first');
    assert.equal(fs.readFileSync(path.join(site, 'data', 'threads', 't__D102.jsonl'), 'utf8'), threadBefore, 'the thread stays whole');
    await archiveCards(site, picks);
    assert.equal((await readArchive(site)).length, 2, 'archiving twice moves nothing twice');
    assert.deepEqual(read('ask-links.json').links, { a1: 't/D102' }, 'the ask it was made from goes with it');

    await appendThread(site, 't/D102', { text: 'Reopened by a reply.' });
    assert.deepEqual((await readArchive(site)).map((a) => a.key), ['t/D101']);
    assert.ok(read('wave.json').items.some((it) => it.id === 'D102' && it.title === 'Done 102'));
    assert.ok(read('owner.json').items.some((q) => q.id === 'q-done'));
    assert.match(fs.readFileSync(path.join(site, 'data', 'threads', 't__D102.jsonl'), 'utf8'), /Reopened by a reply/);
    assert.deepEqual(read('ask-links.json').links, {});
    await setItem(site, 't/D101', { next: 'Check it again' });
    assert.deepEqual(await readArchive(site), []);
    assert.equal(fs.existsSync(path.join(site, 'data', 'done-archive.json')), false, 'an empty archive is no file');
    assert.equal(read('wave.json').items.find((it) => it.id === 'D101').next, 'Check it again');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('the server archives Done cards past the newest 100 as it starts, sends the rest slim, and pages the archive in 100 at a time', async () => {
  const count = 2 * DONE_KEPT + 36;
  const { home, site, read } = siteOf(count);
  const [port] = await freePorts();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url)), site], { env: { ...process.env, HOME: home, PORT: String(port) } });
  try {
    await new Promise((resolve, reject) => { child.stdout.on('data', (d) => String(d).includes('site on') && resolve()); child.once('exit', reject); });
    await until(async () => (await readArchive(site)).length === count - DONE_KEPT - 3, 'the start archives every card past the newest 100 but the kept 3');
    const board = await (await fetch(`${base}/api/board`)).json();
    const done = board.items.filter((i) => i.lane === 'done');
    assert.equal(done.length, DONE_KEPT + 3);
    assert.equal(board.doneArchived, count - DONE_KEPT - 3);
    assert.ok(done.every((c) => !('agents' in c) && !('created' in c)), 'Done cards come slim');
    assert.ok(board.items.find((i) => i.key === 't/O1').created !== undefined, 'open cards come whole');
    assert.ok(!read('wave.json').items.some((it) => it.id === 'D100'));
    assert.ok(!board.items.some((i) => i.key === 'ask:a1'), 'an ask made into an archived card stays out of Todo');
    assert.equal(board.moved['ask:a1'], `t/D${count - 4}`);

    const first = await (await fetch(`${base}/api/done`)).json();
    assert.deepEqual([first.cards.length, first.cards[0].key, first.cards.at(-1).key, first.left], [DONE_KEPT, 't/D100', 't/D199', count - DONE_KEPT - 3 - DONE_KEPT]);
    assert.ok(first.cards.every((c) => c.lane === 'done' && !('agents' in c)));
    const last = first.cards.at(-1);
    const second = await (await fetch(`${base}/api/done?before=${encodeURIComponent(`${last.sortAt}|${last.key}`)}`)).json();
    assert.deepEqual([second.cards.map((c) => c.key), second.left], [Array.from({ length: count - 3 - 200 }, (_, n) => `t/D${200 + n}`), 0]);

    const archived = `t/D${count - 4}`;
    assert.ok((await readArchive(site)).some((a) => a.key === archived));
    const thread = await (await fetch(`${base}/api/thread?key=${encodeURIComponent(archived)}`)).json();
    assert.deepEqual(thread.map((m) => m.text), ['Make a badge', 'Which badge?\n→ The dot', 'Landed.'], "an archived card's thread reads whole, its ask and its answers with their questions");
  } finally {
    child.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
