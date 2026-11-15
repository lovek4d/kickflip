// docs/adr/2026-11-15-0200-a-board-asks-another-board-and-its-orchestrator-answers.md: ask <route> files a question on
// another board in the hub, whose orchestrator answers it; the answer comes back as a thread message on the asking card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { board, boardsManifest, home, lines, read, site, write, at } from './board-fixture.mjs';
import { boardAskWaits, boardAsksOf, buildBoard, withHub } from './domain.mjs';
import { listBoardAsks, siteDir } from './store.mjs';
import { builderBrief, plannerBrief } from './headless.mjs';

const QUESTION = 'Why does land rebase first?';
const setUp = () => {
  boardsManifest();
  write(at('waves', 'w', 'wave.json'), { title: 'W', items: [{ id: 'A1', title: 'feat: shared header', lane: 'progress' }] });
};
const asked = async (...extra) => {
  const r = await board('ask', 'audit', QUESTION, '--site', 'orch', ...extra);
  assert.equal(r.code, 0, r.err);
  return { r, id: lines(site('audit', 'data', 'events.jsonl')).find((e) => e.kind === 'board-ask').id };
};
const thread = () => lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).map(({ ts, ...m }) => m);
const events = (route) => lines(site(route, 'data', 'events.jsonl'));

test('ask files the question on the other board as a board-ask event and writes the asker\'s quiet line on its card', async () => {
  setUp();
  const { r, id } = await asked('--from', 'w/A1');
  const [e] = events('audit');
  assert.deepEqual([e.kind, e.data], ['board-ask', { text: QUESTION, from: { route: 'orch', title: 'Orch', key: 'w/A1', ref: 'A1' } }]);
  assert.deepEqual(thread(), [{ who: 'claude', kind: 'hub', line: 'board-asked', text: `Asked audit: ${QUESTION}` }]);
  assert.equal(r.out, `asked /audit: ${id}\nqueued: /audit's orchestrator isn't listening, so it answers once it is\n`);
  // The asking board keeps its own record of what it asked, which asks lists.
  assert.deepEqual(lines(site('orch', 'data', 'board-asks.jsonl')).map(({ at: _, ...a }) => a), [{ id, to: 'audit', text: QUESTION, key: 'w/A1' }]);
});

test('ask refuses before sending anything: no such board, this board, an unknown card, an empty or multi-line question', async () => {
  setUp();
  for (const [args, err] of [
    [['nope', QUESTION], /ask nope: no board at \/nope in the hub's manifest; the boards are orch, audit$/m],
    [['orch', QUESTION], /ask orch: that is this board/],
    [['audit', QUESTION, '--from', 'w/A9'], /no item "A9"/],
    [['audit', '  '], /ask must be non-empty text/],
    [['audit', 'One?\nTwo?'], /ask takes one line; ask each question on its own/],
  ]) {
    const r = await board('ask', ...args, '--site', 'orch');
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err, err);
  }
  assert.equal(fs.existsSync(site('audit', 'data', 'events.jsonl')), false);
  assert.equal(fs.existsSync(site('orch', 'data', 'board-asks.jsonl')), false);
});

test('answer clears the wait, posts the answer on the asking card as the answering board\'s message, and wakes the asker', async () => {
  setUp();
  const { id } = await asked('--from', 'w/A1');
  const waits = (route) => boardAskWaits(events(route));
  assert.deepEqual(waits('audit').map(({ key, ref, kind, picked }) => ({ key, ref, kind, picked })), [{ key: id, ref: '/orch · A1', kind: 'ask', picked: null }]);
  assert.match(waits('audit')[0].next, new RegExp(`^Answer /orch's question: ${QUESTION.replace('?', '\\?')}: answer ${id} --text`));
  const answer = 'It rebases so the tests run on what lands: https://example.com/adr';
  const r = await board('answer', id, '--text', answer, '--site', 'audit');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `answered /orch's question ${id}\n`);
  assert.deepEqual(waits('audit'), []);
  assert.deepEqual(thread().at(-1), { who: 'audit', text: answer, via: 'board' });
  const woke = events('orch').at(-1);
  assert.deepEqual([woke.kind, woke.data], ['board-answer', { id, from: { route: 'audit', title: 'Audit' }, key: 'w/A1', question: QUESTION, text: answer }]);
  assert.match((await board('answer', id, '--text', 'Again', '--site', 'audit')).err, new RegExp(`question ${id} is already answered`));
  assert.match((await board('answer', 'e-none', '--text', 'Hi', '--site', 'audit')).err, /no question "e-none" from another board on this board/);
});

test('an ask with no card gets its answer in asks and the board-answer event alone', async () => {
  setUp();
  const { id } = await asked();
  assert.equal(fs.existsSync(site('orch', 'data', 'threads', 'w__A1.jsonl')), false);
  assert.equal((await board('answer', id, '--text', 'Because CI', '--site', 'audit')).code, 0);
  assert.deepEqual(events('orch').at(-1).data, { id, from: { route: 'audit', title: 'Audit' }, question: QUESTION, text: 'Because CI' });
  const r = await board('asks', '--site', 'orch');
  assert.equal(r.out, `${id} /audit: ${QUESTION}\n  answered: Because CI\n`);
});

test('an ask stays queued while no orchestrator listens on the other board, and its wait carries over until answered', async () => {
  setUp();
  assert.equal((await board('asks', '--site', 'orch')).out, 'no asks yet\n');
  const { id } = await asked('--from', 'w/A1');
  assert.equal((await board('asks', '--site', 'orch')).out, `${id} /audit: ${QUESTION}\n  queued: /audit's orchestrator isn't listening\n`);
  // The event sits in the other board's log, so its orchestrator's first wake lists the wait.
  assert.equal(boardAskWaits(events('audit')).length, 1);
  // The watcher's working mark on the event is the wait's pickup.
  write(site('audit', 'data', 'working.json'), { events: { [id]: '2026-11-15T01:00:00.000Z' } });
  assert.equal(boardAskWaits(events('audit'), read(site('audit', 'data', 'working.json')).events)[0].picked, '2026-11-15T01:00:00.000Z');
});

test('asks --wait returns once the other board answers', async (t) => {
  setUp();
  const { id } = await asked('--from', 'w/A1');
  const saved = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = saved; });
  // The wait reads its clock once to set its deadline and again each time it finds a question waiting: the second read
  // is the wait under way, which is when the other board answers.
  let reads = 0;
  let answered;
  const clock = () => {
    if (++reads === 2) answered = board('answer', id, '--text', 'Because CI', '--site', 'audit');
    return 0;
  };
  const lines = (await listBoardAsks(await siteDir('orch'), { wait: true, every: 1, now: clock })).lines;
  assert.equal((await answered).code, 0);
  assert.deepEqual(lines, [`${id} /audit: ${QUESTION}`, '  answered: Because CI']);
  let now = 0;
  await board('ask', 'audit', 'And the push?', '--site', 'orch');
  await assert.rejects(listBoardAsks(await siteDir('orch'), { wait: true, every: 1, now: () => (now += 10 * 60_000) }),
    /still waiting on \/audit after 9 minutes; run asks --wait again/);
});

test('the answering board draws each unanswered question as a New strip entry from the asking board, processing once picked up', async () => {
  const e = { id: 'q1', ts: '2026-11-15T00:30:00.000Z', kind: 'board-ask', data: { text: QUESTION, from: { route: 'orch', title: 'Orch', key: 'w/A1', ref: 'A1' } } };
  const answered = { id: 'q2', ts: '2026-11-15T00:31:00.000Z', kind: 'board-ask', data: { text: 'Old?', from: { route: 'orch', title: 'Orch' } } };
  const all = [e, answered, { id: 'x', ts: '2026-11-15T00:32:00.000Z', kind: 'board-ask-answered', data: { id: 'q2', text: 'Yes' } }];
  assert.deepEqual(boardAsksOf(all).map((a) => [a.id, a.answer?.text ?? null]), [['q1', null], ['q2', 'Yes']]);
  const built = buildBoard({ files: [], events: all, working: { q1: '2026-11-15T00:40:00.000Z' } });
  assert.deepEqual(built.boardAsks, [{ id: 'q1', sent: e.ts, text: QUESTION, from: { words: '/orch · A1', link: '/orch/#selectedCard=w%2FA1' }, state: 'working', since: '2026-11-15T00:40:00.000Z' }]);
  // A session that isn't listening reads it waiting, as a New task's ask does.
  assert.equal(withHub(built, { listen: 'asleep' }).boardAsks[0].state, 'waiting');

  const context = vm.createContext({ Date, location: { hostname: 'mac.ts.net', host: 'mac.ts.net:443' }, navigator: { onLine: true }, setTimeout, clearTimeout });
  for (const file of ['ui.js', 'ui-links.js', 'ui-enums.js', 'ui-cards.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), context);
  const ui = context.BoardUI;
  const entries = ui.newEntries({ items: [], merges: [], boardAsks: withHub(built, { listen: 'asleep' }).boardAsks }, {});
  assert.deepEqual([...entries.map((x) => x.id)], ['q1']);
  const html = ui.newStrip(entries, new Map());
  assert.match(html, /<div class="new-msg">Why does land rebase first\?<\/div>/);
  assert.match(html, /<a class="new-source" href="\/orch\/#selectedCard=w%2FA1">Asked from \/orch · A1<\/a>/);
  assert.match(html, /waiting…/);
  // The orchestrator answers it; the owner neither edits nor deletes another board's question.
  assert.doesNotMatch(html, /data-edit=|data-withdraw=/);
});

test("a builder's and a planner's brief say to ask another board when the repo doesn't explain why", () => {
  const card = { route: 'orch', key: 'w/A1', ref: 'A1', title: 'feat: one', thread: '/t.jsonl', worktree: '/wt', base: 'main', repo: '/repo', brief: { heading: 'Brief', text: 'Grill it.' } };
  for (const brief of [builderBrief(card), plannerBrief({ ...card, kind: 'grill' }), plannerBrief({ ...card, kind: 'prototype' })]) {
    assert.match(brief, /When this repo doesn't explain why .* ask that board's orchestrator with `node \S+ --site orch ask <route> "<question>" --from w\/A1` and carry on/);
  }
});

test("the asking card draws the answer as an ordinary message named for the answering board, its links rendered", () => {
  const context = vm.createContext({ Date, location: { hostname: 'mac.ts.net', host: 'mac.ts.net:443' }, navigator: { onLine: true }, setTimeout, clearTimeout });
  for (const file of ['ui.js', 'ui-links.js', 'ui-enums.js', 'ui-cards.js', 'ui-threads.js', 'ui-markdown.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), context);
  const html = context.BoardUI.threadMessages([
    { ts: '2026-11-15T00:30:00.000Z', who: 'claude', kind: 'hub', line: 'board-asked', text: `Asked audit: ${QUESTION}`, mark: 'ask-link', tone: 'grey' },
    { ts: '2026-11-15T00:40:00.000Z', who: 'audit', via: 'board', text: 'So the tests run on what lands: [the ADR](https://example.com/adr)' },
  ]);
  assert.match(html, /<div class="msg other">\s*<div class="who">audit<\/div>/);
  assert.match(html, /<a [^>]*href="https:\/\/example.com\/adr"[^>]*>the ADR<\/a>/);
});

// docs/adr/2026-11-15-1500-a-new-tasks-thread-starts-with-the-owners-message-alone.md
test('an owner\'s unanswered message reads thinking only while the session is busy, and waiting while it is idle', () => {
  const built = buildBoard({ files: [], events: [{ id: 'q1', ts: '2026-11-15T00:30:00Z', kind: 'board-ask', data: { text: QUESTION, from: { route: 'orch', title: 'Orch', key: 'w/A1', ref: 'A1' } } }], working: { q1: '2026-11-15T00:40:00.000Z' } });
  assert.equal(withHub(built, { listen: 'listening', busy: true }).boardAsks[0].state, 'working');
  assert.equal(withHub(built, { listen: 'listening', busy: false }).boardAsks[0].state, 'waiting');
  assert.equal(withHub(built, { listen: 'listening' }).boardAsks[0].state, 'working', 'a build that names no busy is left as built');
});
