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
  assert.deepEqual(await board('item', 'add', 'w/B1', '--site', 'orch', '--relate', 'w/A1', '--title', 'B', '--phase', 'staging'), { code: 1, out: '', err: refused });
  assert.equal(item().phase, undefined);
  assert.equal(item('B1'), undefined);
});

test('ready comes only from staging, or a card already ready; staging to ready clears when it was staged', async () => {
  write(at('waves', 'w', 'a1.md'), '# A1\n');
  setState({ plan: 'a1.md' });
  const ready = () => board('item', 'set', 'w/A1', '--site', 'orch', '--phase', 'ready', ...(item().phase === 'staging' ? [] : ['--size', 'small']), ...(item().phase === 'staging' ? ['--text', 'No other task covers it.'] : []));
  for (const from of [undefined, 'grilling', 'prototyping']) {
    setState({ phase: from });
    assert.deepEqual(await ready(), { code: 1, out: '', err: `w/A1 reads ${from || 'new'}, not staging; a task goes ready only from staging, which the board sets on the owner's Send, Implement or Reply\n` });
    assert.equal(item().phase, from);
  }
  setState({ phase: 'staging', staged_at: '2026-11-06T10:00:00.000Z', size: 'large' });
  const r = await ready();
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([item().phase, item().staged_at], ['ready', undefined]);
  assert.equal((await ready()).code, 0, 'a ready task can be set ready again');
  // docs/adr/2026-11-08-0900-ready-and-staging-moves-are-bare-status-lines.md: only the move to ready writes the line.
  assert.deepEqual(lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).map((m) => [m.who, m.command, m.text]), [['claude', 'readied', 'Marked as ready · No other task covers it.']]);
});

// docs/adr/2026-11-07-0043-every-signal-that-wakes-the-orchestrator-says-what-to-do.md
test("staging to ready needs the orchestrator's judgment as --text, which goes into the card's notes; a ready card takes none", async () => {
  write(at('waves', 'w', 'a1.md'), '# A1\n');
  setState({ plan: 'a1.md', phase: 'staging', staged_at: '2026-11-06T10:00:00.000Z', size: 'small' });
  const set = (...more) => board('item', 'set', 'w/A1', '--site', 'orch', '--phase', 'ready', ...more);
  assert.deepEqual(await set(), { code: 1, out: '', err: 'w/A1 goes ready from staging on your judgment: pass --text "<what you checked it against on the board>", which goes into its notes\n' });
  assert.equal(item().phase, 'staging');
  const r = await set('--text', 'No open task overlaps it; #12 lands first and touches other files.');
  assert.equal(r.code, 0, r.err);
  assert.equal(item().phase, 'ready');
  assert.match(fs.readFileSync(at('waves', 'w', 'a1.md'), 'utf8'), /\n## Ready \(orchestrator, \d\d\/\d\d \d\d:\d\d\)\nNo open task overlaps it; #12 lands first and touches other files\.\n$/);
  assert.deepEqual(await set('--text', 'Again.'), { code: 1, out: '', err: 'w/A1 reads ready, not staging, so there is no judgment for --text to record\n' });
  assert.equal((await set()).code, 0);
  assert.match((await board('item', 'set', 'w/A1', '--site', 'orch', '--next', 'x', '--text', 'y')).err, /--text goes with --from-ask, --done, or --phase ready on a staging task/);
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

// docs/adr/2026-11-17-0543-a-quick-ask-is-triaged-into-staging.md: a filing goes ready from no phase, and a Quick build
// ask's card is staged by item triage alone.
test('item add files a card discussing, grilling or prototyping, never ready, with --from-ask too', async () => {
  addEvents({ id: 'ed', ts: '2026-11-06T10:01:00Z', kind: 'ask', data: { text: 'Rethink the footer' } });
  const refused = "item add files a task discussing, grilling or prototyping; a task goes ready only from staging, which the board sets on the owner's Send, Implement or Reply\n";
  assert.deepEqual(await board('item', 'add', 'w/Q1', '--site', 'orch', '--relate', 'w/A1', '--title', 'fix: quick', '--phase', 'ready', '--size', 'small'), { code: 1, out: '', err: refused });
  assert.deepEqual(await board('item', 'add', 'w/Q1', '--site', 'orch', '--title', 'fix: q1', '--from-ask', 'ed', '--text', 'Filed.', '--phase', 'ready', '--size', 'small', '--notes', 'Fit it.'), { code: 1, out: '', err: refused });
  assert.equal(item('Q1'), undefined);
  assert.equal((await board('item', 'add', 'w/Q1', '--site', 'orch', '--relate', 'w/A1', '--title', 'fix: quick', '--phase', 'grilling')).code, 0);
  const discuss = await board('item', 'add', 'w/D1', '--site', 'orch', '--title', 'feat: d1', '--from-ask', 'ed', '--text', 'Filed.', '--phase', 'grilling');
  assert.equal(discuss.code, 0, discuss.err);
  assert.deepEqual([item('D1').phase, item('D1').from_ask], ['grilling', 'ed']);
  assert.ok(lines(site('orch', 'data', 'threads', 'w__D1.jsonl')).some((m) => m.text === 'Filed.'));
});

test("item add and item set --from-ask refuse a Quick build ask, or one with an Implement on its New card, at any phase: item triage stages its card", async () => {
  write(at('waves', 'w', 'a1.md'), '# A1\n');
  addEvents({ id: 'eq', ts: '2026-11-06T10:00:00Z', kind: 'ask', data: { text: 'Fix the header', quick: true } },
    { id: 'eb', ts: '2026-11-06T10:01:00Z', kind: 'ask', data: { text: 'Fix the footer' } },
    { id: 'ei', ts: '2026-11-06T10:02:00Z', kind: 'item-message', data: { key: 'ask:eb', text: '', intent: 'build' } });
  const refused = (ask) => `ask "${ask}" came with the owner's Implement, which stages its task: item triage stages its New card, never a --from-ask filing\n`;
  for (const phase of ['ready', 'grilling']) {
    assert.deepEqual(await board('item', 'add', 'w/Q1', '--site', 'orch', '--title', 'fix: q1', '--from-ask', 'eq', '--text', 'Filed.', '--phase', phase, '--size', 'small', '--notes', 'Fit it.'), { code: 1, out: '', err: refused('eq') });
    assert.deepEqual(await board('item', 'set', 'w/A1', '--site', 'orch', '--from-ask', 'eb', '--text', 'Filed.', '--phase', phase, '--size', 'small'), { code: 1, out: '', err: refused('eb') });
  }
  assert.deepEqual([item('Q1'), item().phase, item().from_ask], [undefined, undefined, undefined]);
});

// docs/adr/2026-11-15-0130-an-at-kickflip-in-a-slack-dm-is-filed-as-a-routed-ask.md
test('an ask routed from a Slack @kickflip always discusses first, even with an Implement on it, until the owner stages it', async () => {
  write(at('waves', 'w', 'a1.md'), '# A1\n');
  const routed = { reason: 'the header is this board', via: 'slack', by: 'Ann', at: '2026-11-06T09:59:00Z', slack: { channel: 'D1', thread_ts: '1.1', ts: '1.1' } };
  addEvents({ id: 'es', ts: '2026-11-06T10:00:00Z', kind: 'ask', data: { text: 'Ann: @kickflip fix the header', routed } },
    { id: 'ei', ts: '2026-11-06T10:01:00Z', kind: 'item-message', data: { key: 'ask:es', text: '', intent: 'build' } });
  write(at('waves', 'w', 'wave.json'), { items: [{ id: 'A1', title: 'fix: header', plan: 'a1.md', from_ask: 'es' }] });
  // docs/adr/2026-11-16-0900-a-card-in-new-takes-no-writes-until-it-is-triaged.md: a New card takes item triage first.
  assert.match((await board('item', 'set', 'w/A1', '--site', 'orch', '--phase', 'ready', '--size', 'small')).err, /w\/A1 is still in New/);
  assert.equal(item().phase, undefined);
  assert.equal((await board('item', 'triage', 'w/A1', '--site', 'orch', '--title', 'fix(board): header', '--phase', 'discussing')).code, 0);
  assert.match((await board('item', 'set', 'w/A1', '--site', 'orch', '--phase', 'ready', '--size', 'small')).err, /reads discussing, not staging/);
  setState({ phase: 'staging', staged_at: '2026-11-06T10:05:00.000Z', size: 'small' });
  const r = await board('item', 'set', 'w/A1', '--site', 'orch', '--phase', 'ready', '--text', 'Discussed with Ann.');
  assert.equal(r.code, 0, r.err);
  assert.equal(item().phase, 'ready');
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

// docs/adr/2026-11-19-1500-a-staged-card-moves-only-by-the-orchestrators-review.md
test('a question added on a ready card moves it to grilling, where it waits on the answer; a staged card stays staged', async () => {
  for (const [n, from] of [[1, 'staging'], [2, 'ready']]) {
    setState({ phase: from, staged_at: from === 'staging' ? '2026-11-06T10:00:00.000Z' : undefined });
    write(path.join(home, 'q.json'), question(`q${n}`, { topic: 'item:w/A1' }));
    const r = await board('question', 'add', '--site', 'orch', '--file', path.join(home, 'q.json'));
    assert.equal(r.code, 0, r.err);
    assert.deepEqual([item().phase, item().staged_at, item().briefs], from === 'staging' ? ['staging', '2026-11-06T10:00:00.000Z', undefined] : ['grilling', undefined, undefined]);
    // Going back to grilling is silent: the thread holds only the questions-added line.
    assert.deepEqual(lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).map((m) => m.line).slice(-1), ['questions-added']);
  }
});

test('an Implement message waiting from before staging becomes staging, keeping its time; one already ready stays ready', async () => {
  const { stageImplementAsks } = await import('./migrations.mjs');
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

// docs/adr/2026-11-17-2028-a-wait-a-block-held-is-owed-from-the-blocks-end.md
test("a ready card waiting on a re-check from before goes to staging from the block's end; recheck_at elsewhere is dropped", async () => {
  const { restageRechecks } = await import('./migrations.mjs');
  write(site('audit', 'data', 'items.json'), { items: [
    { id: 'A1', title: 'Rechecking', phase: 'ready', recheck_at: '2026-11-05T10:00:00.000Z', ready_at: '2026-11-04T10:00:00.000Z', ready_main: 'abc' },
    { id: 'A2', title: 'Left', phase: 'grilling', recheck_at: '2026-11-05T11:00:00.000Z' },
    { id: 'A3', title: 'Plain', phase: 'ready' },
  ] });
  assert.deepEqual(await restageRechecks(site('audit')), ['audit: 1 ready task waiting on a re-check moved to staging']);
  assert.deepEqual(read(site('audit', 'data', 'items.json')).items, [
    { id: 'A1', title: 'Rechecking', phase: 'staging', staged_at: '2026-11-05T10:00:00.000Z', unblocked_at: '2026-11-05T10:00:00.000Z' },
    { id: 'A2', title: 'Left', phase: 'grilling' },
    { id: 'A3', title: 'Plain', phase: 'ready' },
  ]);
  assert.deepEqual(await restageRechecks(site('audit')), []);
});
