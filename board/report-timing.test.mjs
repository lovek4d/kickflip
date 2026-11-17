// docs/adr/2026-11-17-0600-report-timing-splits-a-tasks-life-by-who-it-waited-on.md: board.mjs report timing works out,
// from the thread lines and events the board already stores, who each task waited on, moment by moment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { board, site, write } from './board-fixture.mjs';
import { cardTiming, cardTimingLines, timingDays, timingDaysLines } from './timing.mjs';

const t0 = Date.parse('2026-11-15T10:00:00Z');
const at = (minutes) => new Date(t0 + minutes * 60000).toISOString();
const m = 60000;
const KEY = 'w/T1';
const said = (minutes, extra = {}) => ({ ts: at(minutes), who: 'claude', text: 'A line', ...extra });
const event = (minutes, kind, data) => ({ id: `e${minutes}${kind}`, ts: at(minutes), kind, data });

// A whole life: replies, a question and its answer, a pause, the ready tap and one builder run.
const LINES = [
  said(0),
  said(15, { kind: 'hub', line: 'questions-added', text: '1 question added' }),
  said(45, { command: 'readied', text: 'Marked as ready' }),
  said(46, { kind: 'hub', line: 'pulled', text: 'Moved to In Progress' }),
  said(52, { kind: 'status', run: at(50), text: 'Reading: notes' }),
  said(80, { kind: 'status', run: at(50), text: 'Checking: diff' }),
];
const EVENTS = [
  event(10, 'item-message', { key: KEY, text: 'why?' }),
  event(20, 'card-hold', { key: KEY, hold: true }),
  event(30, 'card-hold', { key: KEY, hold: false }),
  event(40, 'owner-answer', { id: 'q1', choice: 'A' }),
  event(40, 'owner-answer', { id: 'q-elsewhere', choice: 'A' }),
  event(41, 'item-message', { key: 'w/T2', text: 'not this card' }),
];
const ITEM = { id: 'T1', title: 'feat(board): a timed task', created: at(0), lane: 'done', closed_at: at(100) };

test("a task's life splits by who it waited on, a builder's run over a hold over whose turn it is, to the minute", () => {
  const t = cardTiming({ key: KEY, item: ITEM, lines: LINES, events: EVENTS, questions: new Set(['q1']), now: new Date(at(500)) });
  assert.deepEqual(t.spans.map((s) => [s.label, (Date.parse(s.to) - Date.parse(s.from)) / m]), [
    ['you', 10], ['orchestrator', 5], ['you', 5], ['held', 10], ['you', 10], ['orchestrator', 5], ['queued', 5], ['builder', 30], ['idle', 20],
  ]);
  assert.deepEqual(Object.fromEntries(Object.entries(t.totals).map(([k, v]) => [k, v / m])), { you: 25, orchestrator: 10, builder: 30, held: 15, idle: 20 });
  assert.equal(t.closed, at(100));
  assert.equal(t.built, true);
  assert.deepEqual(cardTimingLines(t), [
    `T1 feat(board): a timed task: closed ${at(100)}, 1h 40m after it was filed`,
    'on you 25m · on the orchestrator 10m · on a builder or planner 30m · held or queued 15m · idle 20m',
    `${at(0)} on you 10m`,
    `${at(10)} on the orchestrator 5m`,
    `${at(15)} on you 5m`,
    `${at(20)} held 10m`,
    `${at(30)} on you 10m`,
    `${at(40)} on the orchestrator 5m`,
    `${at(45)} queued 5m`,
    `${at(50)} builder run 30m`,
    `${at(80)} idle 20m`,
  ]);
});

test("an orchestrator wait opens on its event and ends at the orchestrator's next write, a planner's run is no build, and an open task counts to now", () => {
  const lines = [
    said(0, { kind: 'status', run: at(0), planner: true, text: 'Grilling: notes' }),
    said(10, { kind: 'status', run: at(0), planner: true, text: 'Grilling: asked' }),
    said(30, { command: 'related', text: 'Related to' }),
    { ts: at(39.5), who: 'love', text: 'and?' },
    said(40),
    said(50, { command: 'related', text: 'Related to' }),
    // Status lines without a run are one span while each comes within 10 minutes of the last.
    said(60, { kind: 'status', text: 'Landing: tests' }),
    said(68, { kind: 'status', text: 'Landing: passed' }),
    said(90, { kind: 'status', text: 'Building: fix' }),
    said(91, { kind: 'move', text: 'Moved to In Review' }),
  ];
  const events = [event(20, 'orchestrator-waits', { opened: [{ key: KEY, kind: 'brief', since: at(20) }], again: [] }), event(55, 'card-unblocked', { key: KEY })];
  const t = cardTiming({ key: KEY, item: { id: 'T1', title: 'Open task', created: at(0), lane: 'progress' }, lines, events, questions: new Set(), now: new Date(at(120)) });
  assert.deepEqual(t.spans.map((s) => [s.label, (Date.parse(s.to) - Date.parse(s.from)) / m]), [
    ['planner', 10], ['idle', 10], ['orchestrator', 10], ['idle', 9.5], ['orchestrator', 0.5], ['you', 20], ['builder', 8], ['you', 52],
  ]);
  assert.equal(t.closed, null);
  assert.equal(t.built, true, 'a status line without a run is a builder\'s');
  // The totals count a span under a minute; the list leaves it out.
  assert.deepEqual(cardTimingLines(t).slice(0, 2), ['T1 Open task: open, 2h so far', 'on you 1h 12m · on the orchestrator 10m · on a builder or planner 18m · held or queued 0m · idle 19m']);
  assert.deepEqual(cardTimingLines(t).slice(2).map((l) => l.slice(25)), ['planner run 10m', 'idle 10m', 'on the orchestrator 10m', 'idle 9m', 'on you 20m', 'builder run 8m', 'on you 52m']);
  const planned = cardTiming({ key: KEY, item: { id: 'T1', title: 'Grilled', created: at(0) }, lines: lines.slice(0, 2), events: [], questions: new Set(), now: new Date(at(20)) });
  assert.equal(planned.built, false);
  // A hold tap from either side holds the task until its resume.
  const holds = [said(0), { ts: at(5), who: 'love', command: 'hold', text: 'Held' }, said(10, { command: 'resume', text: 'Resumed' })];
  assert.deepEqual(cardTiming({ key: KEY, item: { id: 'T1', title: 'Held', created: at(0) }, lines: holds, events: [], questions: new Set(), now: new Date(at(20)) })
    .spans.map((s) => s.label), ['you', 'held', 'orchestrator']);
  const bare = cardTiming({ key: KEY, item: { id: 'T1', title: 'Bare', created: at(0) }, lines: [], events: [], questions: new Set(), now: new Date(at(20)) });
  assert.deepEqual(bare.gaps, ['no thread lines: only its events time it']);
  assert.equal(cardTimingLines(bare).at(-1), 'gap: no thread lines: only its events time it');
});

test('the day summary counts the tasks closed each local day and splits each wait\'s median and slowest quarter between built and unbuilt tasks', () => {
  const card = (closedAt, built, you, orchestrator, builder = 0, held = 0) => ({ closed: closedAt, built, totals: { you: you * m, orchestrator: orchestrator * m, builder: builder * m, held: held * m, idle: 0 } });
  const cards = [
    card('2026-11-15T12:00:00', true, 10, 4, 60, 1),
    card('2026-11-15T13:00:00', true, 20, 8, 30, 3),
    card('2026-11-15T14:00:00', true, 30, 12, 90, 5),
    card('2026-11-15T15:00:00', true, 40, 16, 120, 7),
    card('2026-11-15T16:00:00', false, 5, 2),
    card('2026-11-16T09:00:00', false, 0, 1),
    { closed: null, built: false, totals: card('', false, 1000, 1000).totals },
  ];
  const days = timingDays(cards);
  assert.deepEqual(days.map((d) => [d.day, d.closed, d.built.count, d.unbuilt.count]), [['2026-11-15', 5, 4, 1], ['2026-11-16', 1, 0, 1]]);
  assert.deepEqual(days[0].built.waits.you, { median: 25 * m, quarter: 30 * m });
  assert.deepEqual(timingDaysLines(days), [
    '2026-11-15: 5 closed, 4 with a builder',
    '  with a builder: on you 25m median, 30m slowest quarter · on the orchestrator 10m, 12m · on a builder or planner 1h 15m, 1h 30m · held or queued 4m, 5m',
    '  without: on you 5m median, 5m slowest quarter · on the orchestrator 2m, 2m · on a builder or planner 0m, 0m · held or queued 0m, 0m',
    '2026-11-16: 1 closed, 0 with a builder',
    '  without: on you 0m median, 0m slowest quarter · on the orchestrator 1m, 1m · on a builder or planner 0m, 0m · held or queued 0m, 0m',
  ]);
  assert.deepEqual(timingDays(cards, { from: Date.parse('2026-11-16T00:00:00') }).map((d) => d.day), ['2026-11-16']);
  assert.deepEqual(timingDaysLines([]), ['no tasks closed']);
});

test('board report timing prints one task\'s split, or the day summary from the items, the archive, the threads and the events', async () => {
  write(site('audit', 'data', 'items.json'), { items: [ITEM, { id: 'T3', title: 'Still open', created: at(0), lane: 'todo' }] });
  write(site('audit', 'data', 'done-archive.json'), { cards: [{ key: 'audit/T9', file: 'audit', closed_at: at(30), item: { id: 'T9', title: 'Archived', created: at(0), lane: 'done', closed_at: at(30) }, questions: [] }] });
  write(site('audit', 'data', 'owner.json'), { items: [{ id: 'q1', topic: 'item:audit/T1' }] });
  write(site('audit', 'data', 'threads', 'audit__T1.jsonl'), LINES.map((l) => JSON.stringify(l) + '\n').join(''));
  write(site('audit', 'data', 'threads', 'audit__T9.jsonl'), JSON.stringify(said(0)) + '\n');
  write(site('audit', 'data', 'events.jsonl'), EVENTS.map((e) => JSON.stringify({ ...e, data: e.data.key === KEY ? { ...e.data, key: 'audit/T1' } : e.data }) + '\n').join(''));
  const one = await board('--site', 'audit', 'report', 'timing', 'audit/T1');
  assert.equal(one.code, 0, one.err);
  assert.equal(one.out.split('\n')[1], 'on you 25m · on the orchestrator 10m · on a builder or planner 30m · held or queued 15m · idle 20m');
  const day = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const all = await board('--site', 'audit', 'report', 'timing');
  assert.equal(all.code, 0, all.err);
  assert.equal(all.out.split('\n')[0], `${day(at(100))}: 2 closed, 1 with a builder`);
  const none = await board('--site', 'audit', 'report', 'timing', '--since', '2026-12-01');
  assert.equal(none.out, 'no tasks closed\n');
  const missing = await board('--site', 'audit', 'report', 'timing', 'audit/T404');
  assert.equal(missing.code, 1);
  assert.match(missing.err, /no task audit\/T404/);
  const bad = await board('--site', 'audit', 'report', 'timing', '--since', 'yesterday');
  assert.equal(bad.code, 2);
});
