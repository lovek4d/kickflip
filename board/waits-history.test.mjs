// docs/adr/2026-11-16-1400-orchestrator-waits-keep-a-history-and-waits-history-audits-it.md: each wait on the
// orchestrator logs its open and its clear in events.jsonl, waits history audits them, and once a day is over the board
// names that day's waits that sat over 15 minutes unpicked to the orchestrator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { board, site, write } from './board-fixture.mjs';
import { waitsStep, waitsHistory, waitsHistoryLines, longWaitsLine } from './domain.mjs';

const t0 = Date.parse('2026-11-15T10:00:00Z');
const at = (minutes) => new Date(t0 + minutes * 60000).toISOString();
const wait = (key, kind, since, extra = {}) => ({ key, ref: key.split('/')[1], title: `Title ${key}`, kind, since, picked: null, next: 'Do it', ...extra });

test('a check reports each wait that opens, picked or not, and each that clears with when it was picked and cleared', () => {
  const previous = [{ ...wait('w/A1', 'calls', at(0), { picked: at(5) }), bumped: at(0) }, { ...wait('w/A2', 'answer', at(0)), bumped: at(0) }];
  const current = [wait('w/A2', 'answer', at(0)), wait('w/A3', 'intake', at(10)), wait('w/A4', 'reply', at(10), { picked: at(10) })];
  const step = waitsStep(previous, current, new Date(at(10)));
  const entry = (w) => ({ key: w.key, ref: w.ref, title: w.title, kind: w.kind, since: w.since, picked: w.picked });
  assert.deepEqual(step.opened, [entry(current[1]), entry(current[2])]);
  assert.deepEqual(step.cleared, [{ ...entry(previous[0]), cleared: at(10) }]);
  // A wait whose since moves clears the old and opens the new: each since is its own wait.
  const moved = waitsStep(step.waits, [wait('w/A2', 'answer', at(12)), current[1], current[2]], new Date(at(12)));
  assert.deepEqual([moved.opened.map((w) => w.since), moved.cleared.map((w) => [w.since, w.cleared])], [[at(12)], [[at(0), at(12)]]]);
});

// The log a day of waits leaves: the waking event names the unpicked opens, waits-history the picked opens and clears.
const opened = (ts, ...ws) => ({ ts, kind: 'orchestrator-waits', data: { opened: ws, again: [] } });
const history = (ts, data) => ({ ts, kind: 'waits-history', data });
const rec = (key, kind, since, extra = {}) => ({ key, ref: key.split('/')[1], title: `Title ${key}`, kind, since, ...extra });
const LOG = [
  { ts: at(-60), kind: 'orchestrator-waits', data: { added: ['w/OLD'], again: [] } },
  opened(at(0), rec('w/T5', 'intake', at(0)), rec('w/A1', 'calls', at(0))),
  history(at(5), { opened: [], cleared: [] }),
  history(at(30), { cleared: [rec('w/T5', 'intake', at(0), { picked: at(20), cleared: at(30) })] }),
  opened(at(60), rec('w/T6', 'intake', at(60))),
  history(at(60), { cleared: [rec('w/A1', 'calls', at(0), { picked: at(5), cleared: at(60) })] }),
  history(at(65), { cleared: [rec('w/T6', 'intake', at(60), { picked: at(62), cleared: at(65) })] }),
  opened(at(120), rec('w/A2', 'calls', at(120))),
  history(at(121), { opened: [rec('w/A3', 'reply', at(121), { picked: at(121) })], cleared: [] }),
];

test('waits history counts each kind, with the median and longest wait to pickup and to clear, intake first, and lists the waits over 15 minutes unpicked worst first', () => {
  const h = waitsHistory(LOG, { now: new Date(at(160)) });
  const m = 60000;
  assert.deepEqual(h.kinds, [
    { kind: 'intake', count: 2, picked: { median: 11 * m, longest: 20 * m }, cleared: { median: 17.5 * m, longest: 30 * m } },
    { kind: 'calls', count: 2, picked: { median: 5 * m, longest: 5 * m }, cleared: { median: 60 * m, longest: 60 * m } },
    { kind: 'reply', count: 1, picked: { median: 0, longest: 0 }, cleared: null },
  ]);
  // Intake first, then worst first; a wait still open counts to now.
  assert.deepEqual(h.over.map((w) => [w.ref, w.unpicked / m, w.cleared ?? null]), [['T5', 20, at(30)], ['A2', 40, null]]);
  assert.deepEqual(waitsHistoryLines(h), [
    'intake: 2 waits · picked up in 11m median, 20m longest · cleared in 17m median, 30m longest',
    'calls: 2 waits · picked up in 5m median, 5m longest · cleared in 1h median, 1h longest',
    'reply: 1 wait · picked up in 0m median, 0m longest · none cleared',
    'over 15m unpicked, worst first:',
    `intake T5 20m unpicked, since ${at(0)}: Title w/T5`,
    `calls A2 40m unpicked, still open, since ${at(120)}: Title w/A2`,
  ]);
});

test('waits history keeps the waits from a time, before another, or of one kind, and says so when there are none', () => {
  const now = new Date(at(160));
  assert.deepEqual(waitsHistory(LOG, { now, kind: 'calls' }).kinds.map((k) => [k.kind, k.count]), [['calls', 2]]);
  assert.deepEqual(waitsHistory(LOG, { now, from: Date.parse(at(30)) }).kinds.map((k) => [k.kind, k.count]), [['intake', 1], ['calls', 1], ['reply', 1]]);
  assert.deepEqual(waitsHistory(LOG, { now, to: Date.parse(at(30)) }).over.map((w) => w.ref), ['T5']);
  assert.deepEqual(waitsHistoryLines(waitsHistory([], { now })), ['no waits recorded']);
});

test('a wait still open takes its pickup from the current waits, since its log has it only once it clears', () => {
  const open = [wait('w/A2', 'calls', at(120), { picked: at(122) })];
  const h = waitsHistory(LOG, { now: new Date(at(160)), open });
  assert.deepEqual(h.over.map((w) => w.ref), ['T5']);
  assert.deepEqual(h.kinds.find((k) => k.kind === 'calls').picked, { median: 3.5 * 60000, longest: 5 * 60000 });
});

test("the day's long-waits line names each wait that sat over 15 minutes unpicked for the orchestrator", () => {
  const { over } = waitsHistory(LOG, { now: new Date(at(160)) });
  const waits = over.map(({ key, ref, kind, since, unpicked }) => ({ key, ref, kind, since, unpicked }));
  assert.equal(longWaitsLine({ day: '2026-11-15', waits }),
    'waits that sat 15m or more unpicked on 2026-11-15: intake T5 20m · calls A2 40m (the owner audits them with waits history; act on any still in your waits lines)');
});

test('board waits history prints the audit from the board\'s events, and refuses a --since it cannot read', async () => {
  write(site('orch', 'data', 'events.jsonl'), LOG.slice(0, 7).map((e) => JSON.stringify(e) + '\n').join(''));
  const r = await board('--site', 'orch', 'waits', 'history', '--kind', 'intake');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `intake: 2 waits · picked up in 11m median, 20m longest · cleared in 17m median, 30m longest\nover 15m unpicked, worst first:\nintake T5 20m unpicked, since ${at(0)}: Title w/T5\n`);
  const since = await board('--site', 'orch', 'waits', 'history', '--since', '2026-11-16T00:00:00Z');
  assert.equal(since.out, 'no waits recorded\n');
  const bad = await board('--site', 'orch', 'waits', 'history', '--since', 'yesterday');
  assert.equal(bad.code, 2);
  assert.match(bad.err, /^waits history --since takes a date or an ISO time, not "yesterday"/);
});
