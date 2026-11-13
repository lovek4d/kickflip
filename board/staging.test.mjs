import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { home, at, site, write, read, lines, board, question, addEvents } from './board-fixture.mjs';

// docs/adr/2026-11-07-0700-staging-then-ready.md
const item = (id = 'A1') => read(at('waves', 'w', 'wave.json')).items.find((i) => i.id === id);
const setState = (fields, id = 'A1') => {
  const wave = read(at('waves', 'w', 'wave.json'));
  Object.assign(wave.items.find((i) => i.id === id), fields);
  write(at('waves', 'w', 'wave.json'), wave);
};

test('only the board stages a card: item set and item add refuse --phase staging', async () => {
  const refused = '--phase staging is set by the board, on an owner action; pass ready, discussing, grilling or prototyping\n';
  assert.deepEqual(await board('item', 'set', 'w/A1', '--site', 'orch', '--phase', 'staging'), { code: 1, out: '', err: refused });
  assert.deepEqual(await board('item', 'add', 'w/B1', '--site', 'orch', '--title', 'B', '--phase', 'staging'), { code: 1, out: '', err: refused });
  assert.equal(item().phase, undefined);
  assert.equal(item('B1'), undefined);
});

test('ready comes only from staging, or a card already ready; staging to ready clears when it was staged', async () => {
  write(at('waves', 'w', 'a1.md'), '# A1\n');
  setState({ plan: 'a1.md' });
  const ready = () => board('item', 'set', 'w/A1', '--site', 'orch', '--phase', 'ready', '--size', 'small', ...(item().phase === 'staging' ? ['--text', 'No other card covers it.'] : []));
  for (const from of [undefined, 'grilling', 'prototyping']) {
    setState({ phase: from });
    assert.deepEqual(await ready(), { code: 1, out: '', err: `w/A1 reads ${from || 'new'}, not staging; a card goes ready only from staging, which the board sets on the owner's Send, Implement or Reply\n` });
    assert.equal(item().phase, from);
  }
  setState({ phase: 'staging', staged_at: '2026-11-06T10:00:00.000Z' });
  const r = await ready();
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([item().phase, item().staged_at], ['ready', undefined]);
  assert.equal((await ready()).code, 0, 'a ready card can be set ready again');
  // docs/adr/2026-11-08-0900-ready-and-staging-moves-are-bare-status-lines.md: only the move to ready writes the line.
  assert.deepEqual(lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).map((m) => [m.who, m.command, m.text]), [['claude', 'readied', 'Marked as ready · No other card covers it.']]);
});

// docs/adr/2026-11-07-0043-every-signal-that-wakes-the-orchestrator-says-what-to-do.md
test("staging to ready needs the orchestrator's judgment as --text, which goes into the card's notes; a ready card takes none", async () => {
  write(at('waves', 'w', 'a1.md'), '# A1\n');
  setState({ plan: 'a1.md', phase: 'staging', staged_at: '2026-11-06T10:00:00.000Z', size: 'small' });
  const set = (...more) => board('item', 'set', 'w/A1', '--site', 'orch', '--phase', 'ready', ...more);
  assert.deepEqual(await set(), { code: 1, out: '', err: 'w/A1 goes ready from staging on your judgment: pass --text "<what you checked it against on the board>", which goes into its notes\n' });
  assert.equal(item().phase, 'staging');
  const r = await set('--text', 'No open card overlaps it; #12 lands first and touches other files.');
  assert.equal(r.code, 0, r.err);
  assert.equal(item().phase, 'ready');
  assert.match(fs.readFileSync(at('waves', 'w', 'a1.md'), 'utf8'), /\n## Ready \(orchestrator, \d\d\/\d\d \d\d:\d\d\)\nNo open card overlaps it; #12 lands first and touches other files\.\n$/);
  assert.deepEqual(await set('--text', 'Again.'), { code: 1, out: '', err: 'w/A1 reads ready, not staging, so there is no judgment for --text to record\n' });
  assert.equal((await set()).code, 0);
  assert.match((await board('item', 'set', 'w/A1', '--site', 'orch', '--next', 'x', '--text', 'y')).err, /--text goes with --from-ask, --done, or --phase ready on a staging card/);
});

// The readied line is "Marked as ready · <--text>", a status line: a --text too long for it is refused, never cut.
test('staging to ready refuses a --text the readied line can\'t hold whole, naming the limit and the length, and changes nothing', async () => {
  write(at('waves', 'w', 'a1.md'), '# A1\n');
  setState({ plan: 'a1.md', phase: 'staging', staged_at: '2026-11-06T10:00:00.000Z', size: 'small' });
  const set = (said) => board('item', 'set', 'w/A1', '--site', 'orch', '--phase', 'ready', '--text', said);
  const room = 100 - 'Marked as ready · '.length;
  assert.deepEqual(await set('x'.repeat(room + 1)), { code: 1, out: '', err: `--text runs to ${room + 1} characters, past ${room}: it is the status line "Marked as ready · <text>", which holds 100; rewrite it to fit\n` });
  assert.deepEqual(await set('Checked.\nAnd more.'), { code: 1, out: '', err: '--text is the status line "Marked as ready · <text>", one line; rewrite it as one\n' });
  assert.deepEqual([item().phase, fs.readFileSync(at('waves', 'w', 'a1.md'), 'utf8')], ['staging', '# A1\n']);
  assert.equal((await set('x'.repeat(room))).code, 0);
  assert.equal(lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).at(-1).text, `Marked as ready · ${'x'.repeat(room)}`);
});

test('item add without --from-ask files a card grilling or prototyping, never ready', async () => {
  const r = await board('item', 'add', 'w/Q1', '--site', 'orch', '--title', 'fix: quick', '--phase', 'ready', '--size', 'small');
  assert.deepEqual(r, { code: 1, out: '', err: "item add files a card discussing, grilling or prototyping; ready is for a Quick build ask, filed with --from-ask\n" });
  assert.equal(item('Q1'), undefined);
  assert.equal((await board('item', 'add', 'w/Q1', '--site', 'orch', '--title', 'fix: quick', '--phase', 'grilling')).code, 0);
});

// docs/adr/2026-11-10-1100-item-add-files-an-ask-in-one-command.md
// docs/adr/2026-11-07-0115-the-orchestrator-sorts-new-tasks-itself.md: the orchestrator's filing is a Quick build's
// judgment, so it goes ready with its size and its notes, and nothing files a card in staging.
test('item add --from-ask files a Quick build ask ready and a Discuss ask grilling, with the ask as the card\'s first line, and a refusal writes nothing', async () => {
  addEvents({ id: 'eq', ts: '2026-11-06T10:00:00Z', kind: 'ask', data: { text: 'Fix the header', quick: true } },
    { id: 'ed', ts: '2026-11-06T10:01:00Z', kind: 'ask', data: { text: 'Rethink the footer' } });
  const add = (id, ask, ...more) => board('item', 'add', `w/${id}`, '--site', 'orch', '--title', `feat: ${id.toLowerCase()}`, '--from-ask', ask, '--text', 'Filed.', ...more);
  const refusals = [
    [await add('Q1', 'eq', '--phase', 'ready', '--notes', 'Fit the header.'), /no size/],
    [await add('Q1', 'eq', '--phase', 'ready', '--size', 'small'), /no notes; a builder starts from them, so pass --notes or --notes-from with --phase ready/],
    [await add('Q1', 'eq', '--phase', 'staging', '--size', 'small', '--notes', 'Fit the header.'), /--phase staging is set by the board/],
    [await add('Q1', 'ed', '--phase', 'ready', '--size', 'small', '--notes', 'Fit the header.'), /not a Quick build ask/],
    [await add('Q1', 'nope', '--phase', 'ready', '--size', 'small'), /ask/],
    [await add('Q1', 'ed', '--phase', 'staging'), /--phase staging is set by the board/],
    [await add('Q1', 'eq'), /pass --phase/],
    [await board('item', 'add', 'w/Q1', '--site', 'orch', '--title', 'feat: q1', '--from-ask', 'eq', '--phase', 'ready', '--size', 'small'), /--text/],
  ];
  for (const [r, why] of refusals) assert.ok(r.code === 1 && why.test(r.err), r.err);
  assert.equal(item('Q1'), undefined);
  const quick = await add('Q1', 'eq', '--phase', 'ready', '--size', 'small', '--notes', 'Fit the header.');
  assert.equal(quick.code, 0, quick.err);
  assert.deepEqual([item('Q1').phase, item('Q1').from_ask, item('Q1').size, item('Q1').unfiled], ['ready', 'eq', 'small', undefined]);
  assert.ok(lines(site('orch', 'data', 'threads', 'w__Q1.jsonl')).some((m) => m.text === 'Filed.'));
  const discuss = await add('D1', 'ed', '--phase', 'grilling');
  assert.equal(discuss.code, 0, discuss.err);
  assert.deepEqual([item('D1').phase, item('D1').from_ask], ['grilling', 'ed']);
});

// docs/adr/2026-11-07-0115-the-orchestrator-sorts-new-tasks-itself.md
test('item set --from-ask files a Quick build ask ready, from any phase, with its size and notes; staging is refused on every ask, and ready on any other', async () => {
  write(at('waves', 'w', 'a1.md'), '# A1\n');
  addEvents({ id: 'eq', ts: '2026-11-06T10:00:00Z', kind: 'ask', data: { text: 'Fix the header', quick: true } },
    { id: 'eb', ts: '2026-11-06T10:01:00Z', kind: 'ask', data: { text: 'Fix the footer' } },
    { id: 'ei', ts: '2026-11-06T10:02:00Z', kind: 'item-message', data: { key: 'ask:eb', text: '', intent: 'build' } },
    { id: 'ep', ts: '2026-11-06T10:03:00Z', kind: 'ask', data: { text: 'Fix the sidebar' } });
  const file = (id, ask, phase) => board('item', 'set', `w/${id}`, '--site', 'orch', '--from-ask', ask, '--text', 'Filed.', '--phase', phase, '--size', 'small');
  write(at('waves', 'w', 'wave.json'), { items: [{ id: 'A1', title: 'fix: quick', plan: 'a1.md' }, { id: 'A2', title: 'fix: implement on new', plan: 'a1.md', phase: 'grilling' }, { id: 'A3', title: 'Plain', plan: 'a1.md' }] });
  assert.deepEqual(await file('A1', 'eq', 'staging'), { code: 1, out: '', err: '--phase staging is set by the board, on an owner action; pass ready, discussing, grilling or prototyping\n' });
  const quick = await file('A1', 'eq', 'ready');
  assert.equal(quick.code, 0, quick.err);
  assert.deepEqual([item('A1').phase, item('A1').staged_at], ['ready', undefined]);
  const implemented = await file('A2', 'eb', 'ready');
  assert.equal(implemented.code, 0, implemented.err);
  assert.equal(item('A2').phase, 'ready');
  assert.deepEqual(await file('A3', 'ep', 'ready'), { code: 1, out: '', err: "w/A3 reads new, not staging; a card goes ready only from staging, which the board sets on the owner's Send, Implement or Reply\n" });
  assert.equal(item('A3').phase, undefined);
});

// docs/adr/2026-11-12-0600-every-planner-launches-from-the-orchestrators-brief.md
test("leaving staging or ready for grilling or prototyping owes the orchestrator the round's brief", async () => {
  setState({ phase: 'staging', staged_at: '2026-11-06T10:00:00.000Z' });
  const before = new Date().toISOString();
  assert.equal((await board('item', 'set', 'w/A1', '--site', 'orch', '--phase', 'grilling')).code, 0);
  assert.deepEqual([item().phase, item().staged_at, item().briefs.map((b) => [b.kind, b.at >= before, b.brief])], ['grilling', undefined, [['grill', true, undefined]]]);
  setState({ phase: 'ready', briefs: undefined });
  assert.equal((await board('item', 'set', 'w/A1', '--site', 'orch', '--phase', 'prototyping')).code, 0);
  assert.deepEqual([item().phase, item().briefs.map((b) => b.kind)], ['prototyping', ['prototype']]);
  setState({ phase: 'grilling', briefs: undefined });
  assert.equal((await board('item', 'set', 'w/A1', '--site', 'orch', '--phase', 'prototyping')).code, 0);
  assert.equal(item().briefs, undefined, 'a grill handing on to its prototype owes no round of its own');
});

test('a question added on a staging or ready card moves it to grilling, where it waits on the answer', async () => {
  for (const [n, from] of [[1, 'staging'], [2, 'ready']]) {
    setState({ phase: from, staged_at: from === 'staging' ? '2026-11-06T10:00:00.000Z' : undefined });
    write(path.join(home, 'q.json'), question(`q${n}`, { topic: 'item:w/A1' }));
    const r = await board('question', 'add', '--site', 'orch', '--file', path.join(home, 'q.json'));
    assert.equal(r.code, 0, r.err);
    assert.deepEqual([item().phase, item().staged_at, item().briefs], ['grilling', undefined, undefined]);
    assert.match(lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).at(-1).text, /^A new question on it, so it is grilling until you answer\.$/);
  }
});

test('an Implement message waiting from before staging becomes staging, keeping its time; one already ready stays ready', async () => {
  const { stageImplementAsks } = await import('./store.mjs');
  write(site('audit', 'data', 'items.json'), { items: [
    { id: 'A1', title: 'Asked', phase: 'grilling', implement_at: '2026-11-05T10:00:00.000Z' },
    { id: 'A2', title: 'Released', phase: 'ready', implement_at: '2026-11-05T11:00:00.000Z' },
    { id: 'A3', title: 'Plain', phase: 'ready' },
  ] });
  assert.deepEqual(await stageImplementAsks(site('audit')), ['audit: 2 Implement asks moved to staging or ready']);
  assert.deepEqual(read(site('audit', 'data', 'items.json')).items, [
    { id: 'A1', title: 'Asked', phase: 'staging', staged_at: '2026-11-05T10:00:00.000Z' },
    { id: 'A2', title: 'Released', phase: 'ready' },
    { id: 'A3', title: 'Plain', phase: 'ready' },
  ]);
  assert.deepEqual(await stageImplementAsks(site('audit')), []);
});

// docs/adr/2026-11-06-1700-a-boards-lessons-live-in-the-product.md: item add needs a phase on a board, so a Quick build
// ask filed held and grilling goes ready and unholds in its --from-ask.
test('a Quick build ask filed held and grilling goes ready and unholds in one item set --from-ask', async () => {
  addEvents({ id: 'eq', ts: '2026-11-06T10:00:00Z', kind: 'ask', data: { text: 'Fix the header', quick: true } });
  write(`${home}/draft.md`, '# Quick\n');
  const added = await board('item', 'add', 'w/Q1', '--site', 'orch', '--title', 'fix: quick', '--notes-from', `${home}/draft.md`, '--held');
  assert.equal(added.code, 0, added.err);
  assert.deepEqual([item('Q1').phase, item('Q1').held], [undefined, true]);
  const filed = await board('item', 'set', 'w/Q1', '--site', 'orch', '--from-ask', 'eq', '--text', 'Filed.', '--phase', 'ready', '--unheld', '--size', 'small');
  assert.equal(filed.code, 0, filed.err);
  assert.deepEqual([item('Q1').phase, 'held' in item('Q1'), item('Q1').from_ask], ['ready', false, 'eq']);
});
