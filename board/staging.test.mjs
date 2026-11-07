import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { home, at, site, write, read, lines, board, question, addEvents } from './board-fixture.mjs';

// docs/adr/2026-11-07-0700-staging-then-ready.md
const item = (id = 'A1') => read(at('waves', 'w', 'wave.json')).items.find((i) => i.id === id);
const setState = (fields, id = 'A1') => {
  const wave = read(at('waves', 'w', 'wave.json'));
  Object.assign(wave.items.find((i) => i.id === id), fields);
  write(at('waves', 'w', 'wave.json'), wave);
};

test('only the board stages a card: item set and item add refuse --state staging', () => {
  const refused = '--state staging is set by the board, on an owner action; pass ready, grilling or prototyping\n';
  assert.deepEqual(board('item', 'set', 'w/A1', '--site', 'orch', '--state', 'staging'), { code: 1, out: '', err: refused });
  assert.deepEqual(board('item', 'add', 'w/B1', '--site', 'orch', '--title', 'B', '--state', 'staging'), { code: 1, out: '', err: refused });
  assert.equal(item().state, undefined);
  assert.equal(item('B1'), undefined);
});

test('ready comes only from staging, or a card already ready; staging to ready clears when it was staged', () => {
  write(at('waves', 'w', 'a1.md'), '# A1\n');
  setState({ plan: 'a1.md' });
  const ready = () => board('item', 'set', 'w/A1', '--site', 'orch', '--state', 'ready', '--size', 'small');
  for (const from of [undefined, 'grilling', 'prototyping']) {
    setState({ state: from });
    assert.deepEqual(ready(), { code: 1, out: '', err: `w/A1 reads ${from || 'no state'}, not staging; a card goes ready only from staging, which the board sets on the owner's Send, Implement or Reply\n` });
    assert.equal(item().state, from);
  }
  setState({ state: 'staging', staged_at: '2026-11-06T10:00:00.000Z' });
  const r = ready();
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([item().state, item().staged_at], ['ready', undefined]);
  assert.equal(ready().code, 0, 'a ready card can be set ready again');
  // docs/adr/2026-11-08-0900-ready-and-staging-moves-are-bare-status-lines.md: only the move to ready writes the line.
  assert.deepEqual(lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).map((m) => [m.who, m.command, m.text]), [['claude', 'readied', 'Marked as ready']]);
});

test('item add files a card grilling or prototyping, never ready', () => {
  const r = board('item', 'add', 'w/Q1', '--site', 'orch', '--title', 'Quick', '--state', 'ready', '--size', 'small');
  assert.deepEqual(r, { code: 1, out: '', err: "item add files a card grilling or prototyping; it reaches ready through staging, on the owner's Send, Implement or Reply\n" });
  assert.equal(item('Q1'), undefined);
  assert.equal(board('item', 'add', 'w/Q1', '--site', 'orch', '--title', 'Quick', '--state', 'grilling').code, 0);
});

// docs/adr/2026-11-06-0204-intake-triage-sorts-new-tasks-on-sonnet.md
test('a Quick build ask files --from-ask --state staging, so the orchestrator judges it before ready; ready is refused on it, and staging on any other ask', () => {
  write(at('waves', 'w', 'a1.md'), '# A1\n');
  addEvents({ id: 'eq', ts: '2026-11-06T10:00:00Z', kind: 'ask', data: { text: 'Fix the header', quick: true } },
    { id: 'eb', ts: '2026-11-06T10:01:00Z', kind: 'ask', data: { text: 'Fix the footer' } },
    { id: 'ei', ts: '2026-11-06T10:02:00Z', kind: 'item-message', data: { key: 'ask:eb', text: '', intent: 'build' } },
    { id: 'ep', ts: '2026-11-06T10:03:00Z', kind: 'ask', data: { text: 'Fix the sidebar' } });
  const file = (id, ask, state) => board('item', 'set', `w/${id}`, '--site', 'orch', '--from-ask', ask, '--text', 'Filed.', '--state', state, '--size', 'small');
  write(at('waves', 'w', 'wave.json'), { items: [{ id: 'A1', title: 'Quick', plan: 'a1.md' }, { id: 'A2', title: 'Implement on New', plan: 'a1.md' }, { id: 'A3', title: 'Plain', plan: 'a1.md' }] });
  assert.deepEqual(file('A1', 'eq', 'ready'), { code: 1, out: '', err: 'w/A1 came from a Quick build ask: file it --state staging, and the orchestrator judges it before it goes ready\n' });
  assert.equal(item('A1').state, undefined);
  const quick = file('A1', 'eq', 'staging');
  assert.equal(quick.code, 0, quick.err);
  assert.equal(item('A1').state, 'staging');
  assert.ok(item('A1').staged_at);
  const implemented = file('A2', 'eb', 'staging');
  assert.equal(implemented.code, 0, implemented.err);
  assert.equal(item('A2').state, 'staging');
  assert.deepEqual(file('A3', 'ep', 'staging'), { code: 1, out: '', err: '--state staging is set by the board, on an owner action; pass ready, grilling or prototyping\n' });
  assert.deepEqual(file('A3', 'ep', 'ready'), { code: 1, out: '', err: "w/A3 reads no state, not staging; a card goes ready only from staging, which the board sets on the owner's Send, Implement or Reply\n" });
  assert.equal(item('A3').state, undefined);
});

test('leaving staging or ready for grilling or prototyping marks the round for the board to start', () => {
  setState({ state: 'staging', staged_at: '2026-11-06T10:00:00.000Z' });
  const before = new Date().toISOString();
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--state', 'grilling').code, 0);
  assert.deepEqual([item().state, item().staged_at, item().round_at >= before], ['grilling', undefined, true]);
  setState({ state: 'ready', round_at: undefined });
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--state', 'prototyping').code, 0);
  assert.deepEqual([item().state, Boolean(item().round_at)], ['prototyping', true]);
  setState({ state: 'grilling', round_at: undefined });
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--state', 'prototyping').code, 0);
  assert.equal(item().round_at, undefined, 'a grill handing on to its prototype starts no round of its own');
});

test('a question added on a staging or ready card moves it to grilling, where it waits on the answer', () => {
  for (const [n, from] of [[1, 'staging'], [2, 'ready']]) {
    setState({ state: from, staged_at: from === 'staging' ? '2026-11-06T10:00:00.000Z' : undefined });
    write(path.join(home, 'q.json'), question(`q${n}`, { topic: 'item:w/A1' }));
    const r = board('question', 'add', '--site', 'orch', '--file', path.join(home, 'q.json'));
    assert.equal(r.code, 0, r.err);
    assert.deepEqual([item().state, item().staged_at, item().round_at], ['grilling', undefined, undefined]);
    assert.match(lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).at(-1).text, /^A new question on it, so it is grilling until you answer\.$/);
  }
});

test('an Implement message waiting from before staging becomes staging, keeping its time; one already ready stays ready', async () => {
  const { stageImplementAsks } = await import('./store.mjs');
  write(site('audit', 'data', 'wave.json'), { items: [
    { id: 'A1', title: 'Asked', state: 'grilling', implement_at: '2026-11-05T10:00:00.000Z' },
    { id: 'A2', title: 'Released', state: 'ready', implement_at: '2026-11-05T11:00:00.000Z' },
    { id: 'A3', title: 'Plain', state: 'ready' },
  ] });
  assert.deepEqual(await stageImplementAsks(site('audit')), ['audit: 2 Implement asks moved to staging or ready']);
  assert.deepEqual(read(site('audit', 'data', 'wave.json')).items, [
    { id: 'A1', title: 'Asked', state: 'staging', staged_at: '2026-11-05T10:00:00.000Z' },
    { id: 'A2', title: 'Released', state: 'ready' },
    { id: 'A3', title: 'Plain', state: 'ready' },
  ]);
  assert.deepEqual(await stageImplementAsks(site('audit')), []);
});
