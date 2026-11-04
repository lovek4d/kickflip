import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewLinks } from './review.mjs';
import { buildBoard, withHub, threadOf, ownerQuestion, needsAnswer, ownerActions, pullOf, MAX_IMPLEMENTERS, todoOf, triageOf, owesNext, startedByAnswer, lineupMoved, NO_NEXT, PROTOTYPE_AGAIN, strictlyIdle, idleStep, idleSummary, prototypeWaits } from './domain.mjs';

const greenDraft = { state: 'OPEN', isDraft: true, checks: { state: 'pass' }, reviews: {} };
const runningBuilders = (...ids) => Object.fromEntries(ids.map((id) => [id, { main: { started: '2026-10-23T10:00:00Z' } }]));

function board({ agents = {}, pr = greenDraft, owner = {}, events = [], topicItems = {}, now, held = false, threads = {}, item = {}, fromWaves = true, skipDraft } = {}) {
  return buildBoard({
    now,
    skipDraft,
    topicItems,
    threads,
    fromWaves,
    waves: [{
      slug: 'w',
      agents,
      wave: {
        repo: 'o/r',
        reviewers: [{ name: 'Ann', github: 'ann' }],
        items: [{ id: 'A1', title: 'One', pr: 7, held, ...item }, { id: 'ENG-1', title: 'Later', created: '2026-10-22T00:00:00Z', parent: 'A1' }],
      },
    }],
    prs: { 'o/r#7': pr },
    owner,
    events,
  });
}

test("a builder's ask and the orchestrator's answer leave the card quiet, and the question it defers waits on the owner with no Action needed", () => {
  const msg = { id: 'e9', ts: '2026-10-23T10:01:00Z', kind: 'item-message', data: { key: 'w/A1', text: 'How is it going?' } };
  const threads = { 'w/A1': [
    { ts: '2026-10-23T10:02:00Z', who: 'Claude Opus builder', kind: 'builder-ask', ask: 'ask1', text: 'Stay orange?' },
    { ts: '2026-10-23T10:03:00Z', who: 'claude', kind: 'builder-answer', ask: 'ask1', text: 'Go quiet.' },
  ] };
  const quiet = board({ pr: null, item: { pr: undefined, status: 'building' }, threads, events: [msg], agents: { A1: { main: { kind: 'claude', model: 'opus', started: '2026-10-23T10:00:00Z' } } } });
  const card = quiet.items.find((i) => i.key === 'w/A1');
  assert.deepEqual([card.othersAt, card.waitsOn, card.action], [[], 'builder', null]);
  const thread = threadOf('w/A1', { lines: threads['w/A1'], events: [msg] });
  assert.deepEqual(thread.map((m) => [m.kind, m.who, m.ask ?? null, m.state ?? null]), [
    ['item-message', 'love', null, 'waiting'], ['builder-ask', 'Claude Opus builder', 'ask1', null], ['builder-answer', 'claude', 'ask1', null]]);

  // At review: the deferred question waits on the owner from In Progress, with Open questions and no Action needed.
  const owner = { items: [{ id: 'q-ask', topic: 'item:w/A1', ask: 'ask2', question: 'Fold Done?', asked_at: '2026-10-23T11:00:00Z' }] };
  const asked = board({ pr: null, item: { pr: undefined, status: 'checking' }, owner }).items.find((i) => i.key === 'w/A1');
  assert.deepEqual([asked.lane, asked.waitsOn, asked.action, asked.actionButton, asked.next], ['progress', 'owner', null, 'openQuestions', 'Answer 1 question']);
  assert.deepEqual(asked.questions.askedAt, ['2026-10-23T11:00:00Z']);
  // Any other open question still needs the owner's action.
  const both = board({ pr: null, item: { pr: undefined, status: 'checking' }, owner: { items: [...owner.items, { id: 'q2', topic: 'item:w/A1', question: 'Ship it?', asked_at: '2026-10-23T11:05:00Z' }] } }).items.find((i) => i.key === 'w/A1');
  assert.deepEqual([both.waitsOn, both.action?.kind, both.questions.askedAt], ['checking', 'questions', ['2026-10-23T11:00:00Z', '2026-10-23T11:05:00Z']]);
});

test('manifest github selects PR state and card links ahead of wave repo with a wave fallback', () => {
  const waves = [{ slug: 'w', wave: { repo: 'old/project', items: [{ id: 'A1', pr: 7 }, { id: 'F1', parent: 'A1' }] } }];
  const prs = { 'new/project#7': { ...greenDraft, title: 'selected' }, 'old/project#7': { state: 'CLOSED', title: 'legacy' } };
  for (const github of ['new/project', undefined]) {
    const repo = github || 'old/project';
    const built = buildBoard({ github, waves, prs });
    assert.deepEqual(built.items.map((item) => item.repo), [repo, repo]);
    const card = built.items.find((item) => item.id === 'A1');
    assert.equal(card.pr.url, `https://github.com/${repo}/pull/7`);
    assert.equal(card.pr.title, github ? 'selected' : 'legacy');
    assert.equal(card.pr.state, github ? 'OPEN' : 'CLOSED');
  }
});

test('a green draft waits on Ready in In Review until a builder works on it', () => {
  const ready = board().items.find((i) => i.key === 'w/A1');
  assert.deepEqual([ready.lane, ready.waitsOn, ready.next, ready.action], ['review', 'ready', 'Review draft PR #7', { kind: 'ready', url: 'https://github.com/o/r/pull/7', label: 'Review draft PR #7' }]);
  assert.deepEqual([ready.actionButton, ready.resolvedBy], [null, 'github']);
  const asked = board({ owner: { items: [{ id: 'q1', topic: 'item:w/A1', question: 'Ship it?' }] } }).items.find((i) => i.key === 'w/A1');
  assert.deepEqual([asked.lane, asked.waitsOn, asked.action.kind, asked.actionButton, asked.resolvedBy], ['review', 'ready', 'questions', 'openQuestions', 'openQuestions']);
  const record = { label: 'Opus builder', started: '2026-10-23T10:00:00Z', progress: 'Record line', progress_at: '2026-10-23T10:06:00Z' };
  const earlier = { ts: '2026-10-23T09:00:00Z', who: 'claude', kind: 'status', text: 'Previous run' };
  const fresh = board({ now: Date.parse(record.started), agents: { A1: { main: record } }, threads: { 'w/A1': [earlier] } }).items.find((i) => i.key === 'w/A1');
  assert.deepEqual(fresh.builder, { progress: null, phase: null, at: record.started, kind: null, planner: false, stalled: false, silentSince: record.started });
  const lines = [earlier, { ts: '2026-10-23T10:05:00Z', who: 'claude', kind: 'status', text: 'Running tests' }, { ts: '2026-10-23T10:07:00Z', who: 'claude', text: 'Halfway.' }];
  const busy = board({ now: Date.parse('2026-10-23T10:07:00Z'), agents: { A1: { main: record } }, threads: { 'w/A1': lines } });
  const item = busy.items.find((i) => i.key === 'w/A1');
  assert.deepEqual([item.lane, item.waitsOn, item.action], ['progress', 'builder', null]);
  assert.deepEqual(item.builder, { progress: 'Running tests', phase: null, at: '2026-10-23T10:05:00Z', kind: null, planner: false, stalled: false, silentSince: '2026-10-23T10:05:00Z' });
  const finished = board({ agents: { A1: { main: { label: 'Opus builder', started: '2026-10-23T10:00:00Z', progress: 'Running tests', progress_at: '2026-10-23T10:05:00Z', eta: '2026-10-23T11:00:00Z', done: '2026-10-23T10:30:00Z' } } } });
  const after = finished.items.find((i) => i.key === 'w/A1');
  assert.deepEqual([after.lane, after.waitsOn, after.builder, after.eta], ['review', 'ready', null, null]);
  for (const fromWaves of [true, false]) {
    for (const status of ['building', 'fixing']) {
      for (const agents of [{}, { A2: { main: record } }, { A1: { main: { ...record, done: '2026-10-23T10:30:00Z' } } }]) {
        const idle = board({ fromWaves, item: { status }, agents });
        const card = idle.items.find((i) => i.key === 'w/A1');
        assert.deepEqual([card.lane, card.waitsOn, card.next, card.action, card.builder], [ready.lane, ready.waitsOn, ready.next, ready.action, null]);
        assert.equal(idle.needs.some((n) => n.kind === 'Tap Ready'), true);
      }
      const running = board({ fromWaves, item: { status }, agents: { A1: { main: record } } }).items.find((i) => i.key === 'w/A1');
      assert.deepEqual([running.lane, running.waitsOn, running.action], ['progress', 'builder', null]);
    }
  }
});

test('a card waiting on its questions stays in Todo with its action until building starts, a started one keeps its lane with it, and either shows Open questions', () => {
  const q = { id: 'q1', topic: 'item:w/A1', question: 'Which take?', options: [{ id: 'A', label: 'One' }], url: 'prototype-x.html?q=q1' };
  const card = (opts) => board({ pr: null, ...opts }).items.find((i) => i.key === 'w/A1');
  const waiting = card({ owner: { items: [q] } });
  assert.deepEqual([waiting.lane, waiting.waitsOn, waiting.next, waiting.bumpable, waiting.actionButton], ['todo', 'owner', 'Prototypes ready: pick a take', true, 'openQuestions']);
  assert.deepEqual([waiting.action, waiting.resolvedBy], [{ kind: 'pick', url: 'questions.html#q1', label: 'Prototypes ready: pick a take' }, 'openQuestions']);
  const picked = { id: 'e1', ts: '2026-10-23T10:00:00Z', kind: 'owner-answer', data: { id: 'q1', choice: 'A' }, reply: null };
  const answered = card({ owner: { items: [q] }, events: [picked] });
  assert.deepEqual([answered.lane, answered.action, answered.actionButton, answered.buildable], ['todo', null, null, true]);
  const grilled = card({ owner: { items: [{ ...q, url: 'https://example.com/doc' }] } });
  assert.deepEqual([grilled.lane, grilled.waitsOn, grilled.action, grilled.actionButton], ['todo', 'owner', { kind: 'questions', url: 'questions.html#q1', label: 'Answer 1 question' }, 'openQuestions']);
  const more = { ...q, id: 'q2', url: null };
  const regrilled = card({ owner: { items: [q, more] }, events: [picked] });
  assert.deepEqual([regrilled.lane, regrilled.waitsOn, regrilled.action?.kind, regrilled.actionButton], ['todo', 'owner', 'questions', 'openQuestions']);
  const building = card({ owner: { items: [q] }, agents: { A1: { main: { label: 'Opus builder', started: '2026-10-23T10:00:00Z' } } } });
  assert.deepEqual([building.lane, building.waitsOn, building.action?.kind, building.actionButton], ['progress', 'builder', 'pick', 'openQuestions']);
  const built = card({ owner: { items: [q] }, agents: { A1: { main: { label: 'Opus builder', started: '2026-10-23T10:00:00Z', done: '2026-10-23T10:30:00Z' } } } });
  assert.deepEqual([built.lane, built.action?.kind], ['progress', 'pick']);
  const held = card({ owner: { items: [q] }, held: true });
  assert.deepEqual([held.lane, held.action, held.actionButton, held.resolvedBy], ['todo', null, 'openQuestions', null]);
  assert.equal(card({ held: true }).actionButton, null);
});

test("a card's install shows until the card is Done, and reads older once the PR's head has moved past the commit it was built from", () => {
  const install = { url: 'itms-services://?action=download-manifest&url=https://m/x/manifest.plist', built_at: '2026-10-29T10:00:00Z', sha: 'abc1234' };
  const card = (opts) => board(opts).items.find((i) => i.key === 'w/A1').install;
  assert.deepEqual(card({ item: { install } }), { url: install.url, label: null, builtAt: '2026-10-29T10:00:00Z', sha: 'abc1234', older: false });
  assert.equal(card({ item: { install }, pr: { ...greenDraft, headRefOid: 'ABC1234def5678' } }).older, false);
  assert.equal(card({ item: { install }, pr: { ...greenDraft, headRefOid: 'fff0000def5678' } }).older, true);
  assert.equal(card({ item: { install: { ...install, sha: undefined } }, pr: { ...greenDraft, headRefOid: 'fff0000' } }).older, false);
  assert.equal(card({ item: { install }, pr: { ...greenDraft, state: 'MERGED' } }), null);
  assert.equal(card({ item: { install, status: 'done' }, pr: null }), null);
  assert.equal(card(), null);
});

test('a card a builder has built on, or whose status says it is building or fixing, is In Progress; a grill or prototype agent leaves it in Todo', () => {
  const started = { label: 'Opus builder', started: '2026-10-23T10:00:00Z' };
  for (const status of [undefined, 'building', 'fixing']) {
    const card = (record) => board({ pr: null, item: { status }, agents: record ? { A1: { main: record } } : {} }).items.find((i) => i.key === 'w/A1');
    assert.deepEqual([card(null).lane, card(started).lane, card({ ...started, done: '2026-10-23T10:30:00Z' }).lane], [status ? 'progress' : 'todo', 'progress', 'progress']);
    assert.equal(card(null).waitsOn, null);
  }
  const card = (record) => board({ pr: null, agents: { A1: { main: record } } }).items.find((i) => i.key === 'w/A1');
  for (const kind of ['build', 'opus', 'codex']) assert.equal(card({ ...started, kind }).lane, 'progress');
  for (const kind of ['grill', 'prototype']) {
    const running = card({ ...started, kind });
    assert.deepEqual([running.lane, running.buildable, running.builder?.kind], ['todo', true, kind]);
    assert.deepEqual([card({ ...started, kind, done: '2026-10-23T10:30:00Z' }).lane], ['todo']);
  }
});

test('a builder carries the phase of its newest status line, none before a phased line or from a line without one', () => {
  const started = '2026-10-23T10:00:00Z';
  const builder = (lines) => board({ now: Date.parse('2026-10-23T10:30:00Z'), agents: { A1: { main: { label: 'Opus builder', started } } }, threads: { 'w/A1': lines } }).items.find((i) => i.key === 'w/A1').builder;
  const status = (ts, text, phase) => ({ ts, who: 'claude', kind: 'status', text, ...(phase ? { phase } : {}) });
  assert.equal(builder([]).phase, null);
  assert.equal(builder([status('2026-10-23T09:00:00Z', 'Testing: last run', 'testing')]).phase, null);
  assert.equal(builder([status('2026-10-23T10:05:00Z', 'Reading: spec', 'reading'), status('2026-10-23T10:10:00Z', 'Testing: suite', 'testing')]).phase, 'testing');
  assert.equal(builder([status('2026-10-23T10:05:00Z', 'Reading: spec', 'reading'), status('2026-10-23T10:10:00Z', 'Done')]).phase, null);
});

// docs/adr/2026-11-03-2024-every-in-progress-card-shows-its-phase-bars.md
test("a card keeps the phase its latest build reached after the build ends, from that build's own phased lines, not a planner's or an earlier build's", () => {
  const status = (ts, text, extra = {}) => ({ ts, who: 'claude', kind: 'status', text, ...extra });
  const card = (agents, lines) => board({ now: Date.parse('2026-10-23T11:00:00Z'), agents: { A1: agents }, threads: { 'w/A1': lines } }).items.find((i) => i.key === 'w/A1');
  const done = { kind: 'claude', started: '2026-10-23T10:00:00Z', done: '2026-10-23T10:30:00Z' };
  const lines = [status('2026-10-23T09:00:00Z', 'Landing: old build', { phase: 'landing' }), status('2026-10-23T10:05:00Z', 'Reading: spec', { phase: 'reading' }),
    status('2026-10-23T10:10:00Z', 'Building: the page', { phase: 'building' }), status('2026-10-23T10:12:00Z', 'Asked two questions'), status('2026-10-23T10:15:00Z', 'Testing: takes', { phase: 'testing', planner: true })];
  assert.equal(card({ main: done }, lines).reachedPhase, 'building');
  assert.equal(card({ main: done }, lines.slice(0, 1)).reachedPhase, null);
  assert.equal(card({ main: { ...done, done: undefined } }, lines).reachedPhase, 'building');
  assert.equal(card({}, lines).reachedPhase, null);
});

test('an install builder exposes its kind and keeps drafts and ready PRs In Progress until the install lands', () => {
  const install = { url: 'https://m/app.apk', sha: 'old' };
  const record = { kind: 'install', started: '2026-10-30T10:00:00Z' };
  const card = (pr, records, item = {}) => board({ pr, agents: { A1: records }, item: { install, ...item } }).items.find((i) => i.key === 'w/A1');
  for (const isDraft of [true, false]) {
    const pr = { ...greenDraft, isDraft, headRefOid: 'new' };
    const running = card(pr, { install: record, review: { kind: 'codex', started: '2026-10-30T10:01:00Z' } });
    assert.equal(running.builder.kind, 'install');
    assert.deepEqual([running.lane, running.waitsOn, running.action, running.install.older], ['progress', 'builder', null, true]);
    assert.equal(card(pr, { install: record }, { install: null }).builder.kind, 'install');
    assert.equal(card(pr, { install: record }, { status: 'checking' }).builder.kind, 'install');
    const finished = card(pr, { install: { ...record, done: '2026-10-30T10:10:00Z' } }, { install: { ...install, sha: 'new' } });
    assert.deepEqual([finished.lane, finished.builder, finished.install.older], ['review', null, false]);
  }
  const other = card(greenDraft, { install: { ...record, done: '2026-10-30T10:10:00Z' }, main: { kind: 'opus', started: '2026-10-30T10:01:00Z' } });
  assert.equal(other.builder.kind, 'claude');
});

test('a builder stalls after 30 minutes without progress, clears on progress or done, and ignores ordinary thread lines', () => {
  const started = '2026-10-30T10:00:00Z';
  const record = { kind: 'codex', started };
  const card = (minutes, lines = [], agent = record) => board({
    now: Date.parse(started) + minutes * 60000,
    agents: { A1: { main: agent } }, threads: { 'w/A1': lines },
  }).items.find((i) => i.key === 'w/A1');
  for (const minutes of [29, 30, 31]) {
    const builder = card(minutes).builder;
    assert.deepEqual([builder.stalled, builder.silentSince, builder.at], [minutes >= 30, started, started]);
  }
  const progress = { ts: '2026-10-30T10:20:00Z', kind: 'status', text: 'Running tests' };
  assert.deepEqual([card(31, [progress]).builder.stalled, card(31, [progress]).builder.silentSince], [false, progress.ts]);
  assert.equal(card(49, [progress]).builder.stalled, false);
  assert.equal(card(51, [progress, { ts: '2026-10-30T10:50:00Z', who: 'claude', text: 'Checking.' }]).builder.stalled, true);
  assert.equal(card(31, [{ ...progress, ts: '2026-10-30T09:59:00Z' }]).builder.silentSince, started);
  assert.equal(card(31, [], { ...record, done: '2026-10-30T10:30:00Z' }).builder, null);
  assert.equal(card(31, [], { kind: 'codex' }).builder, null);
});

test("a card lists each agent oldest first, its line is the newest status line since a running agent started, and it shows the latest ETA", () => {
  const agents = { A1: {
    main: { label: 'Opus builder', kind: 'opus', started: '2026-10-23T10:00:00Z' },
    bench: { kind: 'codex', started: '2026-10-23T10:02:00Z', eta: '2026-10-23T16:30:00Z' },
    lint: { kind: 'sonnet', started: '2026-10-23T10:03:00Z', eta: '2026-10-23T12:00:00Z' },
  } };
  const threads = { 'w/A1': [
    { ts: '2026-10-23T10:01:00Z', who: 'claude', kind: 'status', text: 'Planning' },
    { ts: '2026-10-23T10:04:00Z', who: 'claude', kind: 'status', text: 'Sonnet: Linting' },
    { ts: '2026-10-23T10:09:00Z', who: 'claude', kind: 'status', text: 'Codex: Running benchmarks' },
  ] };
  const item = board({ agents, threads }).items.find((i) => i.key === 'w/A1');
  assert.deepEqual(item.agents.map((a) => [a.name, a.kind, a.label]), [['main', 'claude', 'Opus builder'], ['bench', 'codex', null], ['lint', 'claude', null]]);
  assert.deepEqual([item.builder.progress, item.builder.at, item.eta], ['Codex: Running benchmarks', '2026-10-23T10:09:00Z', '2026-10-23T16:30:00Z']);
  const changing = board({ pr: { ...greenDraft, isDraft: false, reviewDecision: 'CHANGES_REQUESTED' }, agents: {} }).items.find((i) => i.key === 'w/A1');
  assert.deepEqual([changing.agents, changing.eta], [[], null]);
});

test("a phased status line reads its phase first on the card, and a free-text line from before phases reads as written", () => {
  const agents = { A1: { main: { kind: 'opus', started: '2026-10-23T10:00:00Z' }, bench: { kind: 'codex', started: '2026-10-23T10:01:00Z' } } };
  const progress = (...lines) => board({ agents, threads: { 'w/A1': lines.map((l, i) => ({ ts: `2026-10-23T10:0${i + 2}:00Z`, who: 'claude', kind: 'status', ...l })) } }).items.find((i) => i.key === 'w/A1').builder.progress;
  assert.equal(progress({ phase: 'testing', text: 'Testing: fix for the scroll jump: red first' }), 'Testing · fix for the scroll jump: red first');
  assert.equal(progress({ phase: 'landing', text: 'Codex landing: rebasing on main' }), 'Codex landing · rebasing on main');
  assert.equal(progress({ phase: 'testing', text: 'Testing: x' }, { text: 'Cause: steady() anchored the card' }), 'Cause: steady() anchored the card');
});

test('lanes follow the PR, with a red ready PR in In Progress, and an open follow-up sits in Todo', () => {
  const lanes = (pr) => Object.fromEntries(board({ pr }).items.map((i) => [i.key, i.lane]));
  assert.deepEqual(lanes({ ...greenDraft, checks: { state: 'pending' } }), { 'w/A1': 'review', 'w/ENG-1': 'todo' });
  assert.equal(lanes({ ...greenDraft, checks: { state: 'fail' } })['w/A1'], 'review');
  assert.equal(lanes({ ...greenDraft, isDraft: false })['w/A1'], 'review');
  assert.equal(lanes({ ...greenDraft, isDraft: false, checks: { state: 'pending' } })['w/A1'], 'review');
  const red = board({ pr: { ...greenDraft, isDraft: false, checks: { state: 'fail' } } }).items.find((i) => i.key === 'w/A1');
  assert.deepEqual([red.lane, red.waitsOn, red.next, red.action], ['progress', null, 'Fix the failing CI', null]);
  assert.equal(lanes({ ...greenDraft, state: 'MERGED' })['w/A1'], 'done');
  const done = buildBoard({ fromWaves: false, waves: [{ slug: 's', wave: { items: [{ id: 'S1', title: 'One', status: 'done', next: 'Builds after S0' }] } }] }).items[0];
  assert.deepEqual([done.lane, done.next, done.actionButton], ['done', null, null]);
  assert.equal(board().items.find((i) => i.key === 'w/ENG-1').actionButton, null);
});

test('a review waits with its age, and parks in Stale after a week', () => {
  const ready = { ...greenDraft, isDraft: false };
  const sent = { 'w/A1': { review_link_ts: { Ann: '1792800000.000100' } } };
  const sentAt = '2026-10-24T00:00:00.000Z';
  const at = (days) => Date.parse(sentAt) + days * 86400000;
  const item = (days) => board({ pr: ready, topicItems: sent, now: at(days) }).items.find((i) => i.key === 'w/A1');
  assert.deepEqual(item(2).review, { Ann: { state: 'sent', since: sentAt, github: 'ann' } });
  assert.equal(item(2).lane, 'review');
  assert.equal(item(8).lane, 'stale');
  assert.equal(item(8).waitsOn, 'reviewers');
  assert.equal(item(8).next, 'Waiting for PR reviewers');
  const approved = board({ pr: { ...ready, reviews: { ann: 'APPROVED' }, reviewDecision: 'APPROVED' }, topicItems: sent, now: at(2) }).items.find((i) => i.key === 'w/A1');
  assert.deepEqual(approved.review, { Ann: { state: 'approved', since: null, github: 'ann' } });
  assert.equal(approved.waitsOn, 'merge');
  const fileBoard = buildBoard({
    now: at(8), fromWaves: false, prs: { 'o/r#7': ready },
    waves: [{ slug: 'f', wave: { repo: 'o/r', reviewers: [{ name: 'Ann', github: 'ann' }], items: [{ id: 'B1', title: 'Two', pr: 7, review_sent: { Ann: '1792800000.000100' } }] } }],
  }).items[0];
  assert.deepEqual([fileBoard.lane, fileBoard.review.Ann.since], ['stale', sentAt]);
  assert.match(approved.next, /^Approved/);
  const steps = buildBoard({
    now: at(2), fromWaves: false, prs: { 'o/r#7': { ...ready, reviewDecision: 'APPROVED' } },
    waves: [{ slug: 'f', wave: { repo: 'o/r', items: [{ id: 'B1', title: 'Two', pr: 7, manual_steps: ['Run the backfill'] }] } }],
  }).items[0];
  assert.deepEqual([steps.lane, steps.waitsOn, steps.action, steps.resolvedBy], ['review', 'merge', { kind: 'steps', url: '#item=f%2FB1', label: 'Run the manual steps, then merge' }, 'github']);
  const fixing = buildBoard({
    now: at(2), fromWaves: false, prs: { 'o/r#7': ready },
    waves: [{ slug: 'f', wave: { repo: 'o/r', reviewers: [{ name: 'Ann', github: 'ann' }], items: [{ id: 'B1', title: 'Two', pr: 7, status: 'fixing', next: 'Reply to Codex', review_sent: { Ann: '1792800000.000100' } }] } }],
  }).items[0];
  assert.deepEqual([fixing.lane, fixing.waitsOn, fixing.builder, fixing.next], ['review', 'reviewers', null, 'Waiting for PR reviewers']);
  const changing = board({ pr: ready, item: { status: 'fixing' }, agents: runningBuilders('A1') }).items.find((i) => i.key === 'w/A1');
  assert.deepEqual([changing.lane, changing.waitsOn, changing.builder.progress, changing.next], ['progress', 'builder', null, null]);
});

test("an answer after a question was resolved reopens it, but a Done card's topic with no open question is resolved", () => {
  const owner = { items: [{ id: 'q1', topic: 'item:w/A1', question: '?', options: [], resolved: 'Kept.', resolved_at: '2026-10-23T10:00:00Z' }] };
  const answer = (ts) => ({ id: 'e' + ts, ts, kind: 'owner-answer', data: { id: 'q1', choice: 'A' }, reply: null });
  assert.equal(board({ owner, events: [answer('2026-10-23T09:00:00Z')] }).owner[0].state, 'resolved');
  const reopened = board({ owner, events: [answer('2026-10-23T11:00:00Z')] });
  assert.equal(reopened.owner[0].state, 'answered');
  assert.equal(reopened.items.find((i) => i.key === 'w/A1').questions.answered, 1);
  const closed = board({ owner, events: [answer('2026-10-23T11:00:00Z')], item: { status: 'done' } });
  assert.deepEqual([closed.owner[0].state, closed.ownerTopics.find((t) => t.id === 'item:w/A1').state, closed.items.find((i) => i.key === 'w/A1').questions.state], ['answered', 'resolved', 'resolved']);
});

// docs/adr/2026-11-04-2130-a-prototype-request-waits-for-its-prototype.md
test("a prototype request is its question's input until the round arrives: the question reads requested until a round names it, the topic's round reads making, back, then closed with the take of a pick, with a note or none, or of a confirm already on the board", () => {
  const plain = { id: 'plain', topic: 'item:w/A1', question: 'Where does search sit?', options: [{ id: 'A', label: 'Above' }, { id: 'B', label: 'Behind an icon' }] };
  const takes = { id: 'takes', topic: 'item:w/A1', question: 'Which take?', url: 'prototype-search.html?q=takes', options: [{ id: 'A', label: 'Above' }, { id: 'B', label: 'Icon' }], round: 1, round_of: 'plain' };
  const confirm = { id: 'takes-confirm', topic: 'item:w/A1', question: 'Is this it?', url: 'prototype-search.html?q=takes-confirm', options: [{ id: 'B', label: 'Icon' }], round: 1, confirm_of: 'takes' };
  const resolved = (q, note, at) => ({ ...q, resolved: note, resolved_at: at });
  const request = (question, ts, choice) => ({ id: `r-${question}`, ts, kind: 'prototype-request', data: { key: 'w/A1', question, note: 'show it on a phone', ...(choice ? { choice } : {}) }, reply: null });
  const answer = (id, choice, ts, note = '') => ({ id: `a-${id}`, ts, kind: 'owner-answer', data: { id, choice, note }, reply: null });
  const view = (items, events) => {
    const b = board({ owner: { items }, events });
    const t = b.ownerTopics.find((x) => x.id === 'item:w/A1');
    return { states: b.owner.map((q) => [q.id, q.state]), round: t.round, open: t.open, needs: b.needs.filter((l) => l.questions).length };
  };

  assert.deepEqual(view([plain], []), { states: [['plain', 'open']], round: null, open: 1, needs: 1 });
  const asked = plain;
  assert.deepEqual(board({ owner: { items: [asked] }, events: [request('plain', '2026-10-23T10:00:00Z')] }).owner[0].request, { id: 'r-plain', ts: '2026-10-23T10:00:00Z', note: 'show it on a phone', choice: null });
  assert.equal(board({ owner: { items: [asked] }, events: [request('plain', '2026-10-23T10:00:00Z', 'B')] }).owner[0].request.choice, 'B');
  assert.deepEqual(view([asked], [request('plain', '2026-10-23T10:00:00Z')]), { states: [['plain', 'requested']], round: { n: 1, state: 'making' }, open: 0, needs: 0 });
  assert.deepEqual(view([asked], [answer('plain', 'A', '2026-10-23T09:00:00Z'), request('plain', '2026-10-23T10:00:00Z')]), { states: [['plain', 'requested']], round: { n: 1, state: 'making' }, open: 0, needs: 0 });
  // A question resolved some other way stays resolved.
  assert.deepEqual(view([resolved(plain, 'Asked in the thread', '2026-10-23T10:00:01Z')], [request('plain', '2026-10-23T10:00:00Z')]).states, [['plain', 'resolved']]);
  const reopened = view([asked], [request('plain', '2026-10-23T10:00:00Z'), answer('plain', 'A', '2026-10-23T11:00:00Z')]);
  assert.deepEqual([reopened.states, reopened.round], [[['plain', 'answered']], null]);

  const back = [resolved(plain, 'Followed by prototype round 1', '2026-10-23T11:00:00Z'), takes];
  assert.deepEqual(view(back, [request('plain', '2026-10-23T10:00:00Z')]),
    { states: [['plain', 'resolved'], ['takes', 'open']], round: { n: 1, state: 'back' }, open: 1, needs: 1 });
  assert.deepEqual(view(back, [answer('takes', 'A', '2026-10-23T12:00:00Z')]).round, { n: 1, state: 'closed', take: 'A' });
  assert.deepEqual(view(back, [answer('takes', null, '2026-10-23T12:00:00Z', 'Neither')]).round, { n: 1, state: 'back' });
  const confirming = [back[0], resolved(takes, 'Followed by Is this it?', '2026-10-23T12:00:01Z'), confirm];
  const picked = [answer('takes', 'B', '2026-10-23T12:00:00Z', 'Bigger icon')];
  assert.deepEqual(view(back, picked), { states: [['plain', 'resolved'], ['takes', 'answered']], round: { n: 1, state: 'closed', take: 'B' }, open: 0, needs: 0 });
  assert.deepEqual(view(confirming, []).round, { n: 1, state: 'back' });
  assert.deepEqual(view(confirming, [...picked, answer('takes-confirm', 'B', '2026-10-23T13:00:00Z')]).round, { n: 1, state: 'closed', take: 'B' });
  assert.deepEqual(view(confirming, [...picked, request('takes-confirm', '2026-10-23T13:00:00Z')]).round, { n: 2, state: 'making' });
  assert.deepEqual(view([{ ...plain, url: 'prototype-search.html?q=plain', resolved: 'Picked A', resolved_at: '2026-10-23T11:00:00Z' }], []).round, null);

  const thread = threadOf('w/A1', { events: [request('plain', '2026-10-23T10:00:00Z')], owner: { items: [plain] } });
  assert.deepEqual(thread.map((m) => [m.kind, m.text, m.status, Boolean(m.request)]), [['prototype-request', 'Where does search sit?\n→ show it on a phone', 'prototype requested', false]]);
  const leaning = threadOf('w/A1', { events: [request('plain', '2026-10-23T10:00:00Z', 'B')], owner: { items: [plain] } });
  assert.deepEqual(leaning.map((m) => m.text), ['Where does search sit?\n→ B. Behind an icon\n→ show it on a phone']);
});

test("an answer to an item's question joins that item's thread", () => {
  const shot = { name: 'shot.png', url: 'uploads/1-shot.png', path: '/s/data/uploads/1-shot.png', type: 'image/png', size: 3 };
  const owner = { items: [{ id: 'q1', topic: 'item:w/A1', question: 'Keep it?' }, { id: 'q2', topic: 'site', question: 'Other?' }] };
  const events = [
    { id: 'e2', ts: '2026-10-23T11:00:00Z', kind: 'owner-answer', data: { id: 'q1', label: 'A. Keep it', note: 'and file one', files: [shot] }, reply: { html: 'Kept.' } },
    { id: 'e3', ts: '2026-10-23T11:05:00Z', kind: 'owner-answer', data: { id: 'q2', label: 'B' }, reply: null },
    { id: 'e1', ts: '2026-10-23T10:00:00Z', kind: 'item-message', data: { key: 'w/A1', text: '', files: [shot] }, reply: null },
  ];
  const lines = [{ ts: '2026-10-23T09:00:00Z', who: 'claude', text: 'Built.' }];
  const msgs = threadOf('w/A1', { lines, events, owner });
  assert.deepEqual(msgs.map((m) => m.text), ['Built.', '', 'Keep it?\n→ A. Keep it · and file one']);
  assert.deepEqual(msgs.map((m) => m.files), [undefined, [shot], [shot]]);
  assert.deepEqual(msgs[2].reply, { html: 'Kept.' });
});

test('an internal wave marks its items, and one without a PR reaches Done by status', () => {
  const b = buildBoard({
    fromWaves: true,
    waves: [
      { slug: 'site', agents: runningBuilders('S2'), wave: { internal: true, items: [{ id: 'S1', title: 'Shared script', status: 'done' }, { id: 'S2', title: 'Uploads', status: 'building' }] } },
      { slug: 'w', wave: { items: [{ id: 'A1', title: 'One' }] } },
    ],
  });
  const byKey = Object.fromEntries(b.items.map((i) => [i.key, [i.internal, i.lane]]));
  assert.deepEqual(byKey, { 'site/S1': [true, 'done'], 'site/S2': [true, 'progress'], 'w/A1': [false, 'todo'] });
});

test("a card pushed to a plain git remote waits In Review on the owner's merge with no action, goes back to In Progress while a builder fixes it, and is Done once merged", () => {
  const pushed = { branch: 'INT-12', at: '2026-11-02T10:00:00Z' };
  const built = (item, agents = {}) => buildBoard({ remote: 'git@gitlab.com:acme/firmware.git', branch: 'trunk', fromWaves: true,
    waves: [{ slug: 'fw', agents, wave: { internal: true, items: [{ id: 'S12', title: 'OTA retry', branch: 'INT-12', pushed, ...item }] } }] });
  const open = built({});
  assert.deepEqual(open.remote, { host: 'gitlab.com', name: 'gitlab.com/acme/firmware' });
  const card = open.items[0];
  assert.deepEqual([card.lane, card.waitsOn, card.next, card.action, card.pr, card.branch], ['review', 'owner', 'merge INT-12 into trunk', null, null, 'INT-12']);
  assert.deepEqual(card.pushed, { branch: 'INT-12', at: pushed.at, host: 'gitlab.com' });
  assert.deepEqual(open.needs, []);
  const fixing = built({}, runningBuilders('S12')).items[0];
  assert.deepEqual([fixing.lane, fixing.waitsOn], ['progress', 'builder']);
  const merged = built({ status: 'merged' }).items[0];
  assert.deepEqual([merged.lane, merged.next, merged.pushed], ['done', null, null]);
  assert.equal(buildBoard({ github: 'o/r', remote: 'git@gitlab.com:acme/firmware.git', waves: [] }).remote, null);
});

test('needs lists each Needs you line: open topics apart from items, then items asking a question or waiting on Ready', () => {
  const owner = {
    topics: [{ id: 'site', title: 'Site' }],
    items: [
      { id: 'q3', topic: 'site', question: 'Answered?' },
      { id: 'q1', topic: 'site', question: 'Open?' },
      { id: 'q2', topic: 'item:w/A1', question: 'Keep it?' },
    ],
  };
  const answered = [{ id: 'e1', ts: '2026-10-23T10:00:00Z', kind: 'owner-answer', data: { id: 'q3', choice: 'A' }, reply: null }];
  const lines = (b) => b.needs.map(({ kind, text, url }) => ({ kind, text, url }));
  assert.deepEqual(lines(board({ owner, events: answered })), [
    { kind: 'Question', text: 'Site · 1 question', url: 'questions.html#q1' },
    { kind: 'Question', text: 'A1: One · 1 question · Ready on GitHub', url: '#item=w%2FA1' },
  ]);
  assert.equal(board({ owner, events: answered }).needsSummary, '2 questions · 1 draft waiting on Ready');
  assert.deepEqual(lines(board({ owner, events: answered, held: true, item: { pr: undefined } })), [{ kind: 'Question', text: 'Site · 1 question', url: 'questions.html#q1' }]);
  assert.deepEqual(lines(board()), [{ kind: 'Tap Ready', text: 'A1: One · Ready on GitHub', url: '#item=w%2FA1' }]);
  assert.deepEqual(lines(board({ pr: { ...greenDraft, isDraft: false } })), []);
  assert.equal(board({ pr: { ...greenDraft, isDraft: false } }).needsSummary, '');
  const settling = buildBoard({ fromWaves: false, waves: [], events: [askAt('a1', '2026-10-23T09:00:00Z', { reply: { html: 'Built.' } })], askProgress: { a1: { state: 'progress', at: '2026-10-23T09:10:00Z', next: 'Pick a take' } } });
  assert.deepEqual(lines(settling).map((n) => ({ ...n, text: refKind(n.text.split(': ')[0]) + n.text.slice(n.text.indexOf(': ')) })), [{ kind: 'Action needed', text: 'asked: a1 first line · Pick a take', url: '#item=ask%3Aa1' }]);
});

test("the board session's pending prompts lead Needs you, each a Prompt line carrying its details, and the summary and the hub's needs count them", () => {
  const perm = { id: 'p1', tool: 'Bash', action: 'run npm test', detail: 'npm test', rule: 'Bash(npm test)', questions: null, cwd: '~/r', at: '2026-10-30T10:00:00Z' };
  const ask = { id: 'p2', tool: 'AskUserQuestion', action: null, detail: '', rule: null, cwd: '~/r', at: '2026-10-30T10:01:00Z', questions: [{ question: 'Colour?', options: [{ label: 'Red' }] }, { question: 'Size?', options: [{ label: 'S' }] }] };
  const b = buildBoard({ fromWaves: false, waves: [], events: [], prompts: [perm, ask] });
  assert.deepEqual(b.needs.map(({ kind, text, url, prompt }) => [kind, text, url, prompt.id]), [['Prompt', 'Bash: npm test', '', 'p1'], ['Prompt', 'Question: Colour? · Size?', '', 'p2']]);
  assert.equal(b.needsSummary, '2 prompts');
  assert.deepEqual(needsAnswer(b).items, [{ kind: 'Prompt', text: 'Bash: npm test', url: '' }, { kind: 'Prompt', text: 'Question: Colour? · Size?', url: '' }]);
  assert.deepEqual(board({ owner: {}, events: [] }).needs.map((l) => l.kind), ['Tap Ready']);
});

test('the needs answer counts open cards by lane and says when a builder works on one', () => {
  const quiet = needsAnswer(board());
  assert.deepEqual(quiet, {
    items: [{ kind: 'Tap Ready', text: 'A1: One · Ready on GitHub', url: '#item=w%2FA1' }], working: 0, summary: '1 draft waiting on Ready',
    lanes: { review: 1, progress: 0, todo: 1 }, building: false,
  });
  const started = { label: 'Opus builder', started: '2026-10-23T10:00:00Z' };
  const fixing = needsAnswer(board({ pr: { ...greenDraft, isDraft: false }, agents: { A1: { main: started } } }));
  assert.deepEqual([fixing.lanes, fixing.building], [{ review: 0, progress: 1, todo: 1 }, true]);
  const finished = needsAnswer(board({ agents: { A1: { main: { ...started, done: '2026-10-23T10:30:00Z' } } } }));
  assert.equal(finished.building, false);
  assert.deepEqual(needsAnswer(board({ pr: { ...greenDraft, state: 'MERGED' } })).lanes, { review: 0, progress: 0, todo: 1 });
});

test('a message marked working shows on its thread and card until Claude replies or writes after it, and counts as working', () => {
  const msg = (id, ts, extra = {}) => ({ id, ts, kind: 'item-message', data: { key: 'w/A1', text: id }, reply: null, ...extra });
  const ask = { id: 'a1', ts: '2026-10-23T08:00:00Z', kind: 'ask', data: { text: 'Hi' }, reply: null };
  const working = { m1: '2026-10-23T10:01:00Z', a1: '2026-10-23T08:01:00Z' };
  const at = (events, lines = {}) => {
    const b = buildBoard({ fromWaves: false, waves: [{ slug: 'w', wave: { items: [{ id: 'A1', title: 'One' }] } }], events, threads: lines, working });
    return { card: b.items.find((i) => i.key === 'w/A1').working, count: b.working, msgs: threadOf('w/A1', { lines: lines['w/A1'] || [], events, working }) };
  };
  const marked = at([ask, msg('m1', '2026-10-23T10:00:00Z'), msg('m2', '2026-10-23T10:05:00Z')]);
  assert.deepEqual(marked.msgs.map(({ text, state, canDelete }) => [text, state, canDelete]), [['m1', 'working', true], ['m2', 'waiting', true]]);
  assert.deepEqual([marked.card, marked.count], [true, 2]);
  const status = at([ask, msg('m1', '2026-10-23T10:00:00Z')], { 'w/A1': [{ ts: '2026-10-23T10:03:00Z', who: 'claude', kind: 'status', text: 'Running tests' }] });
  assert.deepEqual(status.msgs.map(({ kind, state }) => [kind, state]), [['item-message', 'working'], ['status', undefined]]);
  assert.equal(status.card, true);
  const later = at([ask, msg('m1', '2026-10-23T10:00:00Z')], { 'w/A1': [{ ts: '2026-10-23T10:03:00Z', who: 'claude', text: 'Done.' }] });
  assert.deepEqual([later.msgs[0].state, later.msgs[0].canDelete, later.card, later.count], ['answered', false, false, 1]);
  const replied = at([{ ...ask, reply: { html: 'Hello' } }, msg('m1', '2026-10-23T10:00:00Z', { reply: { html: 'On it' } })]);
  assert.deepEqual([replied.msgs[0].state, replied.card, replied.count], ['replied', false, 0]);
  const count = (events, extra = {}) => buildBoard({ fromWaves: false, waves: [{ slug: 'w', wave: { items: [{ id: 'A1', title: 'One' }] } }], events, working: { ...working, g1: '2026-10-23T10:01:00Z', q1: '2026-10-23T10:01:00Z' }, ...extra }).working;
  assert.equal(count([msg('g1', '2026-10-23T10:00:00Z', { data: { key: 'gone/G1', text: 'g1' } })]), 0);
  assert.equal(count([{ id: 'q1', ts: '2026-10-23T10:00:00Z', kind: 'owner-answer', data: { id: 'gone-q' }, reply: null }]), 0);
  assert.equal(count([ask], { askProgress: { a1: { state: 'done', at: '2026-10-23T09:00:00Z' } } }), 0);
  assert.equal(count([ask, { id: 'd1', ts: '2026-10-23T09:00:00Z', kind: 'ask-done', data: { id: 'a1' } }]), 0);
  assert.equal(count([ask, { id: 'd1', ts: '2026-10-23T07:00:00Z', kind: 'ask-done', data: { id: 'a1' } }], { now: Date.parse('2026-10-23T12:00:00Z') }), 1);
  const agents = { main: { label: 'Opus builder', started: '2026-10-23T10:06:00Z', done: '2026-10-23T10:07:00Z' } };
  assert.deepEqual(threadOf('w/A1', { events: [msg('m2', '2026-10-23T10:05:00Z')], agents }).map(({ kind, state }) => [kind, state]), [['item-message', 'waiting'], ['agent', undefined], ['agent', undefined]]);
});

test("a builder's judgment calls follow its lines in the thread, as one entry with its verification, and an agent with none adds nothing", () => {
  const calls = [{ at: '2026-10-23T10:08:00Z', text: 'Question: every agent?' }, { at: '2026-10-23T10:09:00Z', text: 'Kept the old name' }];
  const agents = {
    main: { label: 'Builder', kind: 'claude', model: 'opus', started: '2026-10-23T10:06:00Z', done: '2026-10-23T10:10:00Z', calls, verified: { at: '2026-10-23T10:12:00Z', note: 'Fine.' } },
    fix: { label: 'Builder', kind: 'codex', started: '2026-10-23T10:07:00Z', calls: [{ at: '2026-10-23T10:11:00Z', text: 'Left the cap' }] },
    bench: { label: 'Bench', started: '2026-10-23T10:07:30Z' },
  };
  const lines = [{ ts: '2026-10-23T10:10:30Z', who: 'claude', text: 'Handed back.' }];
  const msgs = threadOf('w/A1', { lines, agents });
  assert.deepEqual(msgs.map((m) => [m.kind ?? m.text, m.ts]), [
    ['agent', '2026-10-23T10:06:00Z'], ['agent', '2026-10-23T10:07:00Z'], ['agent', '2026-10-23T10:07:30Z'],
    ['agent', '2026-10-23T10:10:00Z'], ['calls', '2026-10-23T10:10:00Z'], ['Handed back.', '2026-10-23T10:10:30Z'], ['calls', '2026-10-23T10:11:00Z'],
  ]);
  const [mine, theirs] = msgs.filter((m) => m.kind === 'calls');
  assert.deepEqual([mine.text, mine.calls, mine.verified], ['Claude Opus implementer', ['Question: every agent?', 'Kept the old name'], { at: '2026-10-23T10:12:00Z', note: 'Fine.' }]);
  assert.deepEqual([theirs.calls, theirs.verified], [['Left the cap'], null]);
});

const refKind = (ref) => (/^(\d+\/\d+ )?\d\d:\d\d$/.test(ref) ? 'asked' : ref);
const askAt = (id, ts, extra = {}) => ({ id, ts, kind: 'ask', data: { text: `${id} first line\nmore` }, reply: null, ...extra });
function askBoard(events, { working = {}, items = [{ id: 'A1', title: 'One', status: 'building' }], agents = {}, now = Date.parse('2026-10-23T12:00:00Z') } = {}) {
  return buildBoard({ fromWaves: false, now, waves: [{ slug: 'w', agents, wave: { items } }], events, working });
}

test("a task Claude replied to with an open question is a Todo task carrying Open questions, never Done, until its questions are settled or it is closed", () => {
  const ask = askAt('a1', '2026-10-23T09:00:00Z', { reply: { html: 'One question first.', at: '2026-10-23T09:10:00Z' } });
  const owner = { items: [{ id: 'q1', topic: 'item:ask:a1', question: 'Which screen?', options: [{ id: 'A', label: 'Home' }] }] };
  const answer = { id: 'ans', ts: '2026-10-23T09:30:00Z', kind: 'owner-answer', data: { id: 'q1', choice: 'A' }, reply: null };
  const card = (events = [], extra = {}) => {
    const i = buildBoard({ fromWaves: false, now: Date.parse('2026-10-23T12:00:00Z'), waves: [], events: [ask, ...events], owner, ...extra }).items.find((x) => x.key === 'ask:a1');
    return [i.lane, refKind(i.ref), i.isNew, i.bumpable, i.ask.canEdit, i.finishable, i.action?.kind ?? null, i.actionButton];
  };
  assert.deepEqual(card(), ['todo', 'asked', false, false, false, true, 'questions', 'openQuestions']);
  assert.deepEqual(buildBoard({ fromWaves: false, waves: [], events: [ask], owner }).needs.map((n) => [n.kind, refKind(n.text.split(': ')[0]) + n.text.slice(n.text.indexOf(': '))]), [['Question', 'asked: a1 first line · 1 question']]);
  assert.deepEqual(card([answer]), ['todo', 'asked', false, false, false, true, null, null]);
  assert.deepEqual(card([{ ...answer, reply: { html: 'Home it is.' } }]), ['asks', 'asked', false, false, false, false, null, null]);
  assert.deepEqual(card([{ id: 'd1', ts: '2026-10-23T09:20:00Z', kind: 'ask-done', data: { id: 'a1' }, reply: null }]), ['asks', 'asked', false, false, false, false, null, null]);
  assert.deepEqual(card([], { askProgress: { a1: { state: 'done', at: '2026-10-23T09:20:00Z' } } }), ['asks', 'asked', false, false, false, false, null, null]);
  assert.deepEqual(card([], { askProgress: { a1: { state: 'progress', at: '2026-10-23T09:20:00Z', next: 'Pick one' } } }), ['review', 'asked', false, false, false, true, 'questions', 'openQuestions']);
});

test('an ask topic carries when it was asked, for the question pill', () => {
  const owner = { items: [{ id: 'q1', topic: 'item:ask:a1', question: 'Which screen?', options: [{ id: 'A', label: 'Home' }] }] };
  const b = buildBoard({ fromWaves: false, now: Date.parse('2026-10-23T12:00:00Z'), waves: [], events: [askAt('a1', '2026-10-23T09:00:00Z')], owner });
  assert.equal(b.ownerTopics.find((t) => t.id === 'item:ask:a1').askedAt, '2026-10-23T09:00:00Z');
});

test('a new task is a New card in Todo with no action while it waits or works, and a Done item named by its time once Claude replies or writes in its thread', () => {
  const asks = [askAt('a1', '2026-10-23T09:00:00Z'), askAt('a2', '2026-10-23T10:00:00Z'), askAt('a3', '2026-10-23T08:00:00Z', { reply: { html: 'Yes.' } }), askAt('a4', '2026-10-23T07:00:00Z')];
  const threads = { 'ask:a4': [{ ts: '2026-10-23T07:30:00Z', who: 'claude', text: 'Answered here.' }, { ts: '2026-10-23T07:40:00Z', who: 'Sam', via: 'slack', text: 'Agreed' }] };
  const b = buildBoard({ fromWaves: false, now: Date.parse('2026-10-23T12:00:00Z'), waves: [{ slug: 'w', wave: { items: [{ id: 'A1', title: 'One', status: 'building' }] } }], events: asks, threads, working: { a2: '2026-10-23T10:01:00Z' } });
  const cards = b.items.filter((i) => i.kind === 'ask').map((i) => [i.key, i.lane, refKind(i.ref), i.isNew, i.title, i.ask.state, i.working, i.fold, i.action]);
  assert.deepEqual(cards, [
    ['ask:a1', 'todo', 'New', true, 'a1 first line', 'waiting', false, null, null],
    ['ask:a2', 'todo', 'New', true, 'a2 first line', 'working', true, null, null],
    ['ask:a3', 'asks', 'asked', false, 'a3 first line', 'answered', false, null, null],
    ['ask:a4', 'asks', 'asked', false, 'a4 first line', 'answered', false, null, null],
  ]);
  assert.deepEqual(b.items.find((i) => i.key === 'ask:a4').othersAt, ['2026-10-23T07:30:00Z']);
  assert.equal(b.working, 1);
  assert.deepEqual(b.needs, []);
  const msgs = threadOf('ask:a3', { events: [askAt('a3', '2026-10-23T08:00:00Z', { reply: { html: 'Yes.' } })] });
  assert.deepEqual(msgs.map(({ who, text, state, reply }) => [who, text, state, reply]), [['love', 'a3 first line\nmore', 'replied', { html: 'Yes.' }]]);
});

test('New cards lead Todo above bumped work, bumped ones first, the latest bump on top, then the rest oldest first', () => {
  const bump = (id, ts) => ({ id: 'b' + ts, ts, kind: 'ask-bump', data: { id }, reply: null });
  const cardBump = { id: 'cb', ts: '2026-10-23T11:50:00Z', kind: 'card-bump', data: { key: 'w/T1' }, reply: null };
  const order = (events) => askBoard([...events, cardBump], { items: [{ id: 'T1', title: 'Planned' }] }).items.filter((i) => i.lane === 'todo').map((i) => i.key);
  const asks = [askAt('a1', '2026-10-23T09:00:00Z'), askAt('a2', '2026-10-23T10:00:00Z'), askAt('a3', '2026-10-23T11:00:00Z')];
  assert.deepEqual(order(asks), ['ask:a1', 'ask:a2', 'ask:a3', 'w/T1']);
  assert.deepEqual(order([...asks, bump('a3', '2026-10-23T11:10:00Z'), bump('a2', '2026-10-23T11:20:00Z')]), ['ask:a2', 'ask:a3', 'ask:a1', 'w/T1']);
  assert.deepEqual(order([...asks, bump('a3', '2026-10-23T11:30:00Z'), bump('a2', '2026-10-23T11:20:00Z')]), ['ask:a3', 'ask:a2', 'ask:a1', 'w/T1']);
});

test("an ask that became work or was folded into a card has no card of its own: that card's thread holds it and its thread, a folded one marked Moved, and its old links open that card", () => {
  const shot = { name: 'shot.png', url: 'uploads/1-shot.png', type: 'image/png' };
  const ask = askAt('a1', '2026-10-23T09:00:00Z', { data: { text: 'Fix the header', files: [shot] } });
  const items = [{ id: 'A1', title: 'Header spacing', status: 'building', from_ask: 'a1' }];
  const b = askBoard([ask, askAt('a2', '2026-10-23T10:00:00Z')], { items, agents: runningBuilders('A1'), working: { a1: '2026-10-23T09:01:00Z' } });
  assert.deepEqual(b.items.map((i) => [i.key, i.lane, i.title, i.working]), [['w/A1', 'progress', 'Header spacing', true], ['ask:a2', 'todo', 'a2 first line', false]]);
  assert.deepEqual(b.moved, { 'ask:a1': 'w/A1' });
  assert.equal(b.working, 1);
  const linked = threadOf('ask:a1', { events: [ask], working: { a1: '2026-10-23T09:01:00Z' }, links: [{ key: 'site/S21', ref: 'INT-21', became: true }, { key: 'w/B5', ref: 'B5', became: false }] });
  assert.deepEqual(linked.map(({ who, kind, text, link, state }) => [who, kind, text, link, state]), [
    ['love', 'ask', 'Fix the header', undefined, 'answered'], ['claude', 'ask-link', 'Became INT-21', '#item=site%2FS21', undefined], ['claude', 'ask-link', 'Added to B5', '#item=w%2FB5', undefined],
  ]);
  const folded = askAt('a3', '2026-10-23T09:00:00Z');
  const later = { id: 'm3', ts: '2026-10-23T09:10:00Z', kind: 'item-message', data: { key: 'ask:a3', text: 'And the footer' }, reply: null };
  const related = buildBoard({ fromWaves: false, askLinks: { a3: 'site/S4' }, events: [folded, later], working: { a3: '2026-10-23T09:01:00Z' },
    waves: [{ slug: 'site', agents: runningBuilders('S4'), wave: { internal: true, items: [{ id: 'S4', title: 'Four', status: 'building' }] } }] });
  assert.deepEqual([related.items.map((i) => [i.key, i.lane, i.threadCount]), related.moved, related.working], [[['site/S4', 'progress', 2]], { 'ask:a3': 'site/S4' }, 0]);
  const movedIn = threadOf('site/S4', { events: [folded, later], moved: ['a3'], lines: [{ ts: '2026-10-23T09:20:00Z', who: 'claude', text: 'Folded in.' }] });
  assert.deepEqual(movedIn.map(({ kind, text, moved, state }) => [kind, text, moved, state]), [['ask', 'a3 first line\nmore', true, 'answered'], ['item-message', 'And the footer', undefined, 'answered'], [undefined, 'Folded in.', undefined, undefined]]);
  const lines = [{ ts: '2026-10-23T09:05:00Z', who: 'claude', text: 'Building it.' }];
  const msgs = threadOf('w/A1', { lines, events: [ask], working: { a1: '2026-10-23T09:01:00Z' }, fromAsk: 'a1' });
  assert.deepEqual(msgs.map(({ who, text, files, state, moved }) => [who, text, files, state, moved]), [['love', 'Fix the header', [shot], 'answered', undefined], ['claude', 'Building it.', undefined, undefined, undefined]]);
});

test("a New card asked whether to move waits on the owner in Todo, then a move leaves it Done, never an answer, with a line linking to its card on the other board, where it reads as moved from here", () => {
  const ask = askAt('a1', '2026-10-23T09:00:00Z');
  const owner = { items: [{ id: 'mv', topic: 'item:ask:a1', question: 'Move it?', options: [{ id: 'move', label: 'Move to Audit', recommended: true }, { id: 'keep', label: 'Keep here' }] }] };
  const asked = buildBoard({ fromWaves: false, now: Date.parse('2026-10-23T12:00:00Z'), waves: [], events: [ask], owner });
  const card = asked.items[0];
  assert.deepEqual([card.key, card.lane, card.isNew, card.action, card.next, card.actionButton], ['ask:a1', 'todo', true, { kind: 'questions', url: 'questions.html#mv', label: 'Answer 1 question' }, 'Answer 1 question', 'openQuestions']);
  assert.deepEqual(asked.needs.map((n) => [n.kind, n.url]), [['Question', '#item=ask%3Aa1']]);
  const answer = { id: 'ans', ts: '2026-10-23T09:30:00Z', kind: 'owner-answer', data: { id: 'mv', choice: 'move' }, reply: null };
  const back = buildBoard({ fromWaves: false, now: Date.parse('2026-10-23T12:00:00Z'), waves: [], events: [ask, answer], owner }).items[0];
  assert.deepEqual([back.lane, back.isNew, back.action, back.actionButton], ['todo', true, null, null]);
  const link = '/audit/#item=ask%3Ab1';
  const line = { ts: '2026-10-23T09:40:00Z', who: 'claude', text: 'Moved to Audit.', link };
  const moved = buildBoard({ fromWaves: false, now: Date.parse('2026-10-23T12:00:00Z'), waves: [], events: [ask, answer], owner, threads: { 'ask:a1': [line] },
    askProgress: { a1: { state: 'done', at: '2026-10-23T09:40:00Z', moved: { route: 'audit', title: 'Audit', id: 'b1' } } } });
  assert.deepEqual([moved.items[0].lane, moved.items[0].isNew, moved.answers], ['asks', false, []]);
  assert.deepEqual(threadOf('ask:a1', { events: [ask], lines: [line] }).map(({ who, text, link: l }) => [who, text, l]), [['love', 'a1 first line\nmore', undefined], ['claude', 'Moved to Audit.', link]]);
  const arrived = askAt('b1', '2026-10-23T09:40:00Z', { data: { text: 'Fix the header', from: { route: 'orch', title: 'Orch', id: 'a1' } } });
  const there = buildBoard({ fromWaves: false, waves: [], events: [arrived] }).items[0];
  assert.deepEqual([there.lane, there.isNew, there.title, there.ask.from], ['todo', true, 'Fix the header', 'Orch']);
  assert.equal(threadOf('ask:b1', { events: [arrived] })[0].from, 'Orch');
});

test("the owner's reply in a Done ask's thread waits, works and takes edit and delete like a work item's thread message", () => {
  const ask = askAt('a1', '2026-10-23T09:00:00Z', { reply: { html: 'Yes.' } });
  const msg = { id: 'm1', ts: '2026-10-23T10:00:00Z', kind: 'item-message', data: { key: 'ask:a1', text: 'One more thing' }, reply: null };
  const working = { m1: '2026-10-23T10:01:00Z' };
  const msgs = threadOf('ask:a1', { events: [ask, msg], working });
  assert.deepEqual(msgs.map(({ eventId, state, canEdit, canDelete }) => [eventId, state, canEdit, canDelete]), [['a1', 'replied', false, false], ['m1', 'working', true, true]]);
  const b = askBoard([ask, msg], { working });
  const item = b.items.find((i) => i.key === 'ask:a1');
  assert.deepEqual([item.lane, item.working, item.threadCount, b.working], ['asks', true, 2, 1]);
});

test("the board lists asks answered without becoming work, newest Claude line first, leaving out waiting and linked asks", () => {
  const events = [
    askAt('a1', '2026-10-23T08:00:00Z', { reply: { html: 'No.', at: '2026-10-23T08:10:00Z' } }),
    askAt('a2', '2026-10-23T09:00:00Z'),
    askAt('a3', '2026-10-23T09:30:00Z', { reply: { html: 'Building it.', at: '2026-10-23T09:40:00Z' } }),
    askAt('a4', '2026-10-23T10:00:00Z', { reply: { html: 'On it.', at: '2026-10-23T10:05:00Z' } }),
    askAt('a5', '2026-10-23T10:30:00Z'),
    askAt('a6', '2026-10-23T11:00:00Z'),
  ];
  const threads = {
    'ask:a1': [{ ts: '2026-10-23T11:20:00Z', who: 'claude', text: 'More on that.' }, { ts: '2026-10-23T11:30:00Z', who: 'claude', kind: 'status', text: 'Checking' }],
    'ask:a5': [{ ts: '2026-10-23T10:40:00Z', who: 'claude', text: 'Yes, it is.' }],
  };
  const b = buildBoard({
    fromWaves: false, now: Date.parse('2026-10-23T12:00:00Z'), events, threads, askLinks: { a4: 'w/A1' },
    waves: [{ slug: 'w', wave: { items: [{ id: 'A1', title: 'One', status: 'building' }, { id: 'A2', title: 'Two', status: 'building', from_ask: 'a3' }] } }],
  });
  assert.deepEqual(b.answers, [
    { key: 'ask:a1', id: 'a1', text: 'a1 first line', at: '2026-10-23T11:20:00Z' },
    { key: 'ask:a5', id: 'a5', text: 'a5 first line', at: '2026-10-23T10:40:00Z' },
  ]);
});

test("an ask Claude marks in progress waits on the owner in In Review with its next line, an action and a Done button until the newer of the owner's ask-done and Claude's marks says done", () => {
  const ask = askAt('a1', '2026-10-23T09:00:00Z', { reply: { html: 'Two takes.', at: '2026-10-23T09:10:00Z' } });
  const done = (ts) => ({ id: 'd' + ts, ts, kind: 'ask-done', data: { id: 'a1' }, reply: null });
  const at = (events, askProgress) => {
    const i = buildBoard({ fromWaves: false, now: Date.parse('2026-10-23T12:00:00Z'), waves: [], events: [ask, ...events], askProgress }).items.find((x) => x.key === 'ask:a1');
    return [i.lane, i.fold, i.next, i.finishable, i.action, i.actionButton, i.resolvedBy];
  };
  const progress = { a1: { state: 'progress', at: '2026-10-23T09:20:00Z', next: 'Pick a take' } };
  const action = { kind: 'done', url: '#item=ask%3Aa1', label: 'Pick a take' };
  assert.deepEqual(at([], {}), ['asks', null, null, false, null, null, null]);
  assert.deepEqual(at([], progress), ['review', null, 'Pick a take', true, action, 'markDone', 'markDone']);
  assert.deepEqual(at([done('2026-10-23T09:30:00Z')], progress), ['asks', null, null, false, null, null, null]);
  assert.deepEqual(at([done('2026-10-23T09:10:00Z')], progress), ['review', null, 'Pick a take', true, action, 'markDone', 'markDone']);
  const reply = { id: 'm1', ts: '2026-10-23T09:30:00Z', kind: 'item-message', data: { key: 'ask:a1', text: 'Take B' }, reply: null };
  assert.deepEqual(at([reply], progress), ['progress', null, 'Pick a take', true, null, null, null]);
  assert.deepEqual(at([], { a1: { state: 'done', at: '2026-10-23T09:40:00Z' } }), ['asks', null, null, false, null, null, null]);
  const waiting = buildBoard({ fromWaves: false, waves: [], events: [askAt('a2', '2026-10-23T09:00:00Z')], askProgress: { a2: { state: 'done', at: '2026-10-23T09:40:00Z' } } }).items[0];
  assert.deepEqual([waiting.lane, waiting.bumpable], ['asks', false]);
});

test("with auto-merge off an approved, green, clean PR waits on the owner's Merge, reads merging until Claude writes after it, and with it on waits on monitor", () => {
  const clean = { state: 'OPEN', isDraft: false, reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', checks: { state: 'pass' }, reviews: {} };
  const card = ({ pr = clean, autoMerge, events = [], threads = {}, item = {} } = {}) => buildBoard({
    fromWaves: false, autoMerge, events, threads, prs: { 'o/r#7': pr },
    waves: [{ slug: 'w', wave: { repo: 'o/r', items: [{ id: 'A1', title: 'One', pr: 7, ...item }] } }],
  });
  const off = card();
  const it = off.items[0];
  assert.deepEqual([it.lane, it.waitsOn, it.merging, it.next, it.action, it.resolvedBy], ['review', 'merge', false, 'Approved and green: tap Merge', { kind: 'merge', url: '#item=w%2FA1', label: 'Merge' }, 'merge']);
  assert.deepEqual(needsAnswer(off).items, [{ kind: 'Action needed', text: 'A1: One · Merge', url: '#item=w%2FA1' }]);
  for (const pr of [{ ...clean, mergeStateStatus: 'BLOCKED' }, { ...clean, checks: { state: 'pending' } }, { ...clean, reviewDecision: 'REVIEW_REQUIRED' }]) {
    assert.equal(card({ pr }).items[0].action, null, JSON.stringify(pr));
  }
  assert.equal(card({ pr: { ...clean, mergeStateStatus: 'BLOCKED' } }).items[0].next, 'Approved, Merge shows once CI and the merge state allow');
  assert.equal(card({ item: { held: true, pr: undefined } }).items[0].action, null);
  // docs: a card that left Todo never reads held, whatever old data says.
  const leftTodo = card({ item: { held: true, pick_up_at: '2026-11-05T17:00:00.000Z' } }).items[0];
  assert.deepEqual([leftTodo.lane, leftTodo.held, leftTodo.heldUntil], ['review', false, null]);
  const droppedHeld = card({ item: { held: true, status: 'dropped', pr: undefined } }).items[0];
  assert.deepEqual([droppedHeld.lane, droppedHeld.held], ['done', false]);
  assert.equal(card({ item: { manual_steps: ['Run the backfill'] } }).items[0].action.kind, 'steps');

  const tapped = [{ id: 'm1', ts: '2026-10-29T10:00:00Z', kind: 'card-merge', data: { key: 'w/A1' } }];
  const merging = card({ events: tapped, threads: { 'w/A1': [{ ts: '2026-10-29T10:01:00Z', who: 'claude', kind: 'status', text: 'Merging' }] } }).items[0];
  assert.deepEqual([merging.lane, merging.merging, merging.action, merging.next, merging.resolvedBy], ['review', true, null, 'Merging', null]);
  const declined = card({ events: tapped, threads: { 'w/A1': [{ ts: '2026-10-29T10:02:00Z', who: 'claude', text: 'Not merged: a commit after the approval changes behaviour' }] } }).items[0];
  assert.deepEqual([declined.merging, declined.action?.kind], [false, 'merge']);
  const merged = card({ events: tapped, pr: { ...clean, state: 'MERGED' } }).items[0];
  assert.deepEqual([merged.lane, merged.merging, merged.action], ['done', false, null]);

  const on = card({ autoMerge: true }).items[0];
  assert.deepEqual([on.lane, on.waitsOn, on.merging, on.action, on.next], ['review', 'merge', false, null, 'Approved, merges once CI and the merge state allow']);
  assert.equal(card({ autoMerge: true, item: { manual_steps: ['Run the backfill'] } }).items[0].action.kind, 'steps');
});

// docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md
test("a ready PR on a card no reviewer is on waits on the merge with no approval: Merge once green and clean, or Auto-merge's; a reviewer on the board waits for their approval", () => {
  const ready = { state: 'OPEN', isDraft: false, reviewDecision: null, mergeStateStatus: 'CLEAN', checks: { state: 'pass' }, reviews: {} };
  const card = ({ pr = ready, autoMerge, reviewers } = {}) => buildBoard({
    fromWaves: false, autoMerge, reviewers, prs: { 'o/r#7': pr },
    waves: [{ slug: 'w', wave: { repo: 'o/r', items: [{ id: 'A1', title: 'One', pr: 7 }] } }],
  }).items[0];
  const off = card();
  assert.deepEqual([off.lane, off.waitsOn, off.next, off.action], ['review', 'merge', 'Ready and green: tap Merge', { kind: 'merge', url: '#item=w%2FA1', label: 'Merge' }]);
  const pending = card({ pr: { ...ready, checks: { state: 'pending' } } });
  assert.deepEqual([pending.waitsOn, pending.next, pending.action], ['merge', 'Ready, Merge shows once CI and the merge state allow', null]);
  assert.equal(card({ pr: { ...ready, reviewDecision: 'CHANGES_REQUESTED' } }).action, null);
  const auto = card({ autoMerge: true });
  assert.deepEqual([auto.waitsOn, auto.next, auto.action], ['merge', 'Ready, merges once CI and the merge state allow', null]);
  const reviewed = card({ reviewers: [{ name: 'Ann', github: 'ann' }] });
  assert.deepEqual([reviewed.waitsOn, reviewed.next, reviewed.action], ['reviewers', 'Waiting for PR reviewers', null]);
});

test("a verified branch held for the owner's Merge waits In Review on it with Merge, Auto-merge on or not, reads merging from the tap until Claude writes, and is Done once it lands", () => {
  const heldAt = '2026-11-04T10:00:00Z';
  const card = ({ item = {}, autoMerge, threads = {}, agents = {} } = {}) => buildBoard({
    fromWaves: true, autoMerge, threads, branch: 'trunk',
    waves: [{ slug: 'w', agents, wave: { items: [{ id: 'A1', title: 'One', branch: 'A1', merge_ready: { branch: 'A1', at: heldAt }, ...item }] } }],
  }).items[0];
  for (const autoMerge of [false, true]) {
    const it = card({ autoMerge });
    assert.deepEqual([it.lane, it.waitsOn, it.next, it.action, it.resolvedBy, it.pr], ['review', 'merge', 'Verified: tap Merge to land it on trunk', { kind: 'merge', url: '#item=w%2FA1', label: 'Merge' }, 'merge', null]);
    assert.deepEqual(it.mergeReady, { branch: 'A1', at: heldAt, base: 'trunk' });
  }
  assert.equal(card({ item: { manual_steps: ['Run the backfill'] } }).action.kind, 'merge');
  const tapped = { branch: 'A1', at: heldAt, tapped: '2026-11-04T11:00:00Z' };
  const merging = card({ item: { merge_ready: tapped } });
  assert.deepEqual([merging.merging, merging.action, merging.next], [true, null, 'Merging']);
  const queued = card({ item: { merge_ready: tapped }, threads: { 'w/A1': [{ ts: '2026-11-04T11:00:30Z', who: 'claude', kind: 'status', text: 'Waiting for #210 to land' }] } });
  assert.deepEqual([queued.merging, queued.action, queued.next], [true, null, 'Merging · waiting for #210 to land']);
  const refused = card({ item: { merge_ready: tapped }, threads: { 'w/A1': [{ ts: '2026-11-04T11:01:00Z', who: 'claude', text: 'Not merged: main moved. Tap Merge again.' }] } });
  assert.deepEqual([refused.merging, refused.action?.kind], [false, 'merge']);
  const landing = card({ item: { merge_ready: tapped }, agents: runningBuilders('A1') });
  assert.deepEqual([landing.lane, landing.waitsOn, landing.action], ['progress', 'builder', null]);
  const done = card({ item: { status: 'done' } });
  assert.deepEqual([done.lane, done.mergeReady, done.action], ['done', null, null]);
});

test("an unstarted Todo card that waits on nothing from the owner can Build, a blocked one too, which the idle pull skips", () => {
  const q = { id: 'q1', topic: 'item:w/A1', question: 'Which way?', options: [{ id: 'A', label: 'One' }] };
  const card = ({ item = {}, events = [], threads = {}, owner = {}, agents = {}, dep } = {}) => buildBoard({
    fromWaves: false, events, threads, owner, prs: {},
    waves: [{ slug: 'w', agents, wave: { repo: 'o/r', items: [{ id: 'A1', title: 'One', ...item }, ...(dep ? [{ id: 'A2', title: 'Two', status: dep }] : []), { id: 'ENG-1', title: 'Later', created: '2026-10-22T00:00:00Z', parent: 'A1' }] } }],
  });
  const one = (b) => b.items.find((i) => i.id === 'A1');
  const fresh = card();
  assert.deepEqual([one(fresh).lane, one(fresh).buildable, one(fresh).action, one(fresh).refusal], ['todo', true, null, null]);
  // A follow-up builds like any card (docs/adr/2026-11-03-0526-a-follow-up-is-a-work-card-with-a-parent.md).
  assert.equal(fresh.items.find((i) => i.id === 'ENG-1').buildable, true);
  assert.deepEqual(needsAnswer(fresh).items, []);
  const blocked = card({ item: { deps: ['A2'] }, dep: 'building' });
  assert.equal(one(blocked).buildable, true);
  assert.equal(pullOf(blocked.items).pullable.includes('w/A1'), false);
  assert.equal(one(card({ item: { deps: ['A2'] }, dep: 'done' })).buildable, true);
  const asking = one(card({ owner: { items: [q] } }));
  assert.deepEqual([asking.lane, asking.action.kind, asking.buildable], ['todo', 'questions', false]);
  assert.equal(one(card({ item: { held: true } })).buildable, true);
  assert.equal(one(card({ agents: runningBuilders('A1') })).buildable, false);
  assert.equal(one(card({ item: { status: 'done' } })).buildable, false);

  // A prototype answer with no take picked leaves the card unready to build and prototyping again, which the idle board
  // can plan; a pick, note or not, makes it ready (docs/adr/2026-11-03-1646-a-prototype-answer-with-no-pick-prototypes-again.md).
  const takes = { id: 'p1', topic: 'item:w/A1', question: 'Which take?', url: 'prototype-x.html?q=p1', options: [{ id: 'A', label: 'One' }, { id: 'B', label: 'Two' }] };
  const answer = (n, choice, note) => ({ id: `a${n}`, ts: `2026-10-23T10:0${n}:00Z`, kind: 'owner-answer', data: { id: 'p1', choice, note }, reply: null });
  const unpicked = card({ owner: { items: [takes] }, events: [answer(1, 'A', ''), answer(2, null, 'Neither: try a darker moon')] });
  assert.deepEqual([one(unpicked).lane, one(unpicked).buildable, one(unpicked).next, one(unpicked).action, one(unpicked).state], ['todo', false, PROTOTYPE_AGAIN, null, 'prototyping']);
  assert.equal(PROTOTYPE_AGAIN, 'Prototype again');
  assert.equal(startedByAnswer(unpicked, 'p1'), null);
  // The board resolves a note with no take (store.mjs resolveNoteAnswers), which leaves the card for the idle board to plan.
  const noted = card({ owner: { items: [{ ...takes, resolved: 'Answered with a note' }] }, events: [answer(2, null, 'Neither: try a darker moon')] });
  assert.deepEqual([pullOf(noted.items).plannable.includes('w/A1'), pullOf(unpicked.items).plannable.includes('w/A1')], [true, false]);
  const picked = card({ owner: { items: [takes] }, events: [answer(2, null, 'Neither'), answer(3, 'B', 'but with the moon on the left')] });
  assert.deepEqual([one(picked).buildable, one(picked).next, one(picked).state], [true, null, null]);
  assert.equal(startedByAnswer(picked, 'p1'), 'w/A1');
  // A prototype request on any of the card's questions is its newest input the same way, until the next round's pick
  // (docs/adr/2026-11-03-1803-a-question-asked-for-a-prototype-is-resolved.md).
  const plain = { id: 'q0', topic: 'item:w/A1', question: 'Where?', options: [{ id: 'A', label: 'Top' }], resolved: 'Prototype requested', resolved_at: '2026-10-23T10:04:01Z' };
  const request = { id: 'r4', ts: '2026-10-23T10:04:00Z', kind: 'prototype-request', data: { key: 'w/A1', question: 'q0', note: 'on a phone', choice: 'A' }, reply: null };
  const asked = card({ owner: { items: [plain, takes] }, events: [answer(3, 'B', ''), request] });
  assert.deepEqual([one(asked).buildable, one(asked).next, one(asked).state], [false, PROTOTYPE_AGAIN, 'prototyping']);
  const next = card({ owner: { items: [plain, takes] }, events: [request, answer(5, 'B', '')] });
  assert.deepEqual([one(next).buildable, one(next).state], [true, null]);
});

test("a Build the board started is In Progress reading preheating until its builder's first status line, and a refused one stays in Todo with its reason while that is the card's newest line", () => {
  const card = ({ item = {}, threads = {}, agents = {} } = {}) => buildBoard({
    fromWaves: false, events: [], threads, owner: {}, prs: {}, now: Date.parse('2026-10-29T10:05:00Z'),
    waves: [{ slug: 'w', agents, wave: { repo: 'o/r', items: [{ id: 'A1', title: 'One', ...item }] } }],
  }).items[0];
  const tapped = { A1: { main: { label: 'Opus builder', kind: 'opus', started: '2026-10-29T10:00:00Z', dispatched: 'tap' } } };
  const starting = card({ item: { status: 'building' }, agents: tapped });
  assert.deepEqual([starting.lane, starting.buildable, starting.builder.progress, starting.builder.at], ['progress', false, null, '2026-10-29T10:00:00Z']);
  assert.equal('waiting' in starting.builder, false);
  const line = { ts: '2026-10-29T10:01:00Z', who: 'claude', kind: 'status', phase: 'reading', text: 'Reading: the notes' };
  const going = card({ item: { status: 'building' }, agents: tapped, threads: { 'w/A1': [line] } });
  assert.equal(going.builder.progress, 'Reading · the notes');
  // A tap-opened main record and an agent started under another name read the same: preheating, then the first line.
  const other = { A1: { ...tapped.A1, codex: { kind: 'codex', started: '2026-10-29T10:02:00Z' } } };
  assert.equal(card({ item: { status: 'building' }, agents: other }).builder.progress, null);

  const refused = { ts: '2026-10-29T10:00:00Z', who: 'claude', kind: 'build-refused', text: "Couldn't start the build: it's held. Resume it, then tap Build." };
  const held = card({ item: { held: true }, threads: { 'w/A1': [refused] } });
  assert.deepEqual([held.lane, held.refusal], ['todo', refused.text]);
  const after = card({ threads: { 'w/A1': [refused, { ts: '2026-10-29T10:03:00Z', who: 'love', text: 'Resumed.' }] } });
  assert.deepEqual([after.lane, after.refusal, after.buildable], ['todo', null, true]);
  const status = card({ threads: { 'w/A1': [refused, { ...line, ts: '2026-10-29T10:03:00Z' }] } });
  assert.equal(status.refusal, refused.text);
  assert.equal(card({ item: { status: 'building' }, agents: tapped, threads: { 'w/A1': [refused] } }).refusal, null);
});

test("a card-done moves a card to Done and unblocks dependents at once, unless a newer status overrides it, and an owner message or question after it reopens it, a merged card too", () => {
  const close = (key, ts) => ({ id: 'c' + ts, ts, kind: 'card-done', data: { key }, reply: null });
  const items = [
    { id: 'A1', title: 'One', status: 'building' },
    { id: 'A2', title: 'Two', status: 'building', status_at: '2026-10-23T11:20:00Z' },
    { id: 'A3', title: 'Three' },
    { id: 'A4', title: 'Four', status: 'done', status_at: '2026-10-23T11:20:00Z' },
    { id: 'A5', title: 'Five', deps: ['A1'] },
    { id: 'A6', title: 'Six', deps: ['A4'] },
    { id: 'A7', title: 'Seven', status: 'merged', status_at: '2026-10-23T11:20:00Z' },
    { id: 'A8', title: 'Eight', status: 'done', status_at: '2026-10-23T11:20:00Z' },
  ];
  const events = [close('w/A1', '2026-10-23T11:00:00Z'), close('w/A2', '2026-10-23T11:10:00Z'), close('w/A4', '2026-10-23T11:10:00Z')];
  const snapshot = { fromWaves: false, now: Date.parse('2026-10-23T12:00:00Z'), waves: [{ slug: 'w', agents: runningBuilders('A1', 'A2'), wave: { items } }] };
  assert.deepEqual(buildBoard(snapshot).items.find((i) => i.id === 'A5').blockedBy, [{ key: 'w/A1', ref: 'A1' }]);
  const b = buildBoard({ ...snapshot, events });
  const cards = Object.fromEntries(b.items.map((i) => [i.id, [i.lane, i.finishable]]));
  assert.deepEqual(cards, {
    A1: ['done', false], A2: ['progress', true], A3: ['todo', true], A4: ['done', false], A5: ['todo', true], A6: ['todo', true], A7: ['done', false], A8: ['done', false],
  });
  const closed = b.items.find((i) => i.id === 'A1');
  assert.deepEqual([closed.status, closed.action, closed.actionButton, closed.next, closed.holdable], ['done', null, null, null, false]);
  assert.equal(b.items.find((i) => i.id === 'A2').status, 'building');
  assert.deepEqual(b.items.find((i) => i.id === 'A5').blockedBy, []);

  const msg = (key, ts) => ({ id: `m-${key}-${ts}`, ts, kind: 'item-message', data: { key, text: 'One more thing' }, reply: null });
  const said = { ...snapshot, events: [...events, msg('w/A4', '2026-10-23T11:15:00Z'), msg('w/A4', '2026-10-23T11:30:00Z'), msg('w/A7', '2026-10-23T11:30:00Z')],
    owner: { items: [{ id: 'q1', topic: 'item:w/A8', question: 'Which?', options: [{ id: 'a', label: 'A' }], asked_at: '2026-10-23T11:30:00Z' }] } };
  const card = (s, id) => buildBoard(s).items.find((i) => i.id === id);
  const state = (s, id) => (({ lane, waitsOn, status, action, actionButton, next }) => [lane, waitsOn, status, action?.kind ?? null, actionButton, next])(card(s, id));
  assert.deepEqual(state(said, 'A4'), ['progress', null, null, null, null, NO_NEXT]);
  assert.deepEqual(card(said, 'A6').blockedBy, []);
  assert.deepEqual(state(said, 'A7'), ['progress', null, null, null, null, NO_NEXT]);
  assert.equal(card(said, 'A7').reopened, true);
  assert.deepEqual(state(said, 'A8'), ['review', 'owner', null, 'questions', 'openQuestions', 'Answer 1 question']);
  const answered = { ...said, threads: { 'w/A4': [{ ts: '2026-10-23T11:40:00Z', who: 'claude', text: 'Done that.' }] } };
  assert.deepEqual(state(answered, 'A4'), ['review', 'owner', null, null, null, 'Tap Done once it is settled']);
  assert.deepEqual((({ awaitsDone, bumpable, resolvedBy }) => [awaitsDone, bumpable, resolvedBy])(card(answered, 'A4')), [true, false, null]);
  assert.deepEqual(needsAnswer(buildBoard(answered)).items.filter((l) => l.url === '#item=w%2FA4'), []);
  assert.deepEqual(state({ ...answered, events: [...answered.events, close('w/A4', '2026-10-23T11:50:00Z')] }, 'A4'), ['done', null, 'done', null, null, null]);
  const mergedAnswered = { ...said, threads: { 'w/A7': [{ ts: '2026-10-23T11:40:00Z', who: 'claude', text: 'Done that.' }] } };
  assert.deepEqual(state(mergedAnswered, 'A7'), ['review', 'owner', null, null, null, 'Tap Done once it is settled']);
  assert.deepEqual(state({ ...mergedAnswered, events: [...mergedAnswered.events, close('w/A7', '2026-10-23T11:50:00Z')] }, 'A7'), ['done', null, 'merged', null, null, null]);
});

test('a message on a card whose PR merged reopens it after the merge, not before, and its PR still reads merged', () => {
  const msg = (ts) => ({ id: `m-${ts}`, ts, kind: 'item-message', data: { key: 'w/A1', text: 'One more thing' }, reply: null });
  const merged = { ...greenDraft, isDraft: false, state: 'MERGED', mergedAt: '2026-10-23T11:00:00Z' };
  const card = (events, item = {}) => board({ pr: merged, events, item: { status: 'building', status_at: '2026-10-23T10:00:00Z', ...item } }).items.find((i) => i.key === 'w/A1');
  assert.deepEqual([card([msg('2026-10-23T10:30:00Z')]).lane, card([]).pr.status], ['done', 'merged']);
  const reopened = card([msg('2026-10-23T11:30:00Z')]);
  assert.deepEqual([reopened.lane, reopened.reopened, reopened.pr.status, reopened.closedAt], ['progress', true, 'merged', null]);
  assert.equal(card([msg('2026-10-23T11:30:00Z')], { status: 'dropped' }).lane, 'done');
});

test("a card's PR carries one state: open, draft, merged once GitHub or the card says so, closed, or none before GitHub is read", () => {
  const status = (pr, item = {}) => board({ pr, item }).items.find((i) => i.key === 'w/A1').pr.status;
  assert.deepEqual([
    status({ ...greenDraft, isDraft: false }), status(greenDraft), status({ ...greenDraft, state: 'MERGED' }), status({ ...greenDraft, state: 'CLOSED' }),
    status(null), status(null, { status: 'merged' }), status(null, { merged_at: '2026-10-23T11:00:00Z' }),
  ], ['open', 'draft', 'merged', 'closed', null, 'merged', 'merged']);
});

test("a card's PRs across repos each carry their own state and link, and the least-ready one decides its lane, Next and Merge", () => {
  const open = { state: 'OPEN', isDraft: false, checks: { state: 'pass' }, reviews: {}, reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED' };
  const approved = { ...open, reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' };
  const card = (prs, item = {}) => buildBoard({
    fromWaves: false, events: [], owner: {}, prs,
    waves: [{ slug: 'w', wave: { repo: 'o/r', items: [{ id: 'A1', title: 'One', prs: [{ number: 6 }, { repo: 'o/site', number: 1 }], ...item }] } }],
  }).items[0];
  const both = card({ 'o/r#6': approved, 'o/site#1': greenDraft });
  assert.deepEqual(both.prs.map((p) => [p.repo, p.number, p.url, p.status]), [
    ['o/r', 6, 'https://github.com/o/r/pull/6', 'open'], ['o/site', 1, 'https://github.com/o/site/pull/1', 'draft'],
  ]);
  assert.deepEqual([both.lane, both.waitsOn, both.pr.number, both.action?.url], ['review', 'ready', 1, 'https://github.com/o/site/pull/1']);
  const reviewing = card({ 'o/r#6': approved, 'o/site#1': open });
  assert.deepEqual([reviewing.lane, reviewing.waitsOn, reviewing.action], ['review', 'reviewers', null]);
  const pending = card({ 'o/r#6': approved, 'o/site#1': { ...approved, checks: { state: 'pending', pending: 1 } } });
  assert.deepEqual([pending.lane, pending.waitsOn, pending.action], ['review', 'merge', null]);
  const ready = card({ 'o/r#6': approved, 'o/site#1': approved });
  assert.deepEqual([ready.lane, ready.waitsOn, ready.action?.kind], ['review', 'merge', 'merge']);
  const half = card({ 'o/r#6': { state: 'MERGED' }, 'o/site#1': approved });
  assert.deepEqual([half.lane, half.prs.map((p) => p.status), half.action?.kind], ['review', ['merged', 'open'], 'merge']);
  const unread = card({ 'o/r#6': { state: 'MERGED' } });
  assert.deepEqual([unread.lane, unread.prs.map((p) => p.status)], ['todo', ['merged', null]]);
  const landed = card({ 'o/r#6': { state: 'CLOSED' }, 'o/site#1': { state: 'MERGED', mergedAt: '2026-11-03T10:00:00Z' } });
  assert.deepEqual([landed.lane, landed.status, landed.pr.status, landed.prs.map((p) => p.status), landed.closedAt], ['done', null, 'merged', ['closed', 'merged'], '2026-11-03T10:00:00Z']);
  const closed = card({ 'o/r#6': { state: 'CLOSED' }, 'o/site#1': { state: 'CLOSED' } });
  assert.deepEqual([closed.lane, closed.pr.status], ['done', 'closed']);
  const older = buildBoard({ fromWaves: false, events: [], owner: {}, prs: { 'o/r#7': greenDraft }, waves: [{ slug: 'w', wave: { repo: 'o/r', items: [{ id: 'A1', title: 'One', pr: 7 }] } }] }).items[0];
  assert.deepEqual([older.prs.length, older.pr.number, older.pr.repo, older.waitsOn], [1, 7, 'o/r', 'ready']);
});

test('a withdrawn ask leaves the board', () => {
  const b = askBoard([askAt('a1', '2026-10-23T09:00:00Z'), { id: 'w1', ts: '2026-10-23T09:10:00Z', kind: 'ask-withdrawn', data: { id: 'a1' }, reply: null }]);
  assert.deepEqual(b.items.map((i) => i.key), ['w/A1']);
});

test('a bumped card that has not started, or is running, tops its lane, the latest bump first, a held Todo card bumps too, and a draft waiting on Ready takes no bump', () => {
  const bump = (key, ts) => ({ id: 'c' + ts, ts, kind: 'card-bump', data: { key }, reply: null });
  const items = [
    { id: 'A1', title: 'One', status: 'planned' },
    { id: 'A2', title: 'Two', status: 'waiting' },
    { id: 'A3', title: 'Three' },
    { id: 'A4', title: 'Four', status: 'held' },
    { id: 'A5', title: 'Five', status: 'building' },
    { id: 'A6', title: 'Six', status: 'fixing' },
  ];
  const cards = (events) => askBoard(events, { items, agents: runningBuilders('A5', 'A6') }).items.filter((i) => i.kind === 'work').map((i) => [i.key, i.lane, i.bumpable, i.bumpedAt]);
  assert.deepEqual(cards([]).map(([key, , bumpable]) => [key, bumpable]), [['w/A6', true], ['w/A5', true], ['w/A4', true], ['w/A3', true], ['w/A2', true], ['w/A1', true]]);
  const at1 = '2026-10-23T11:10:00Z';
  const at2 = '2026-10-23T11:20:00Z';
  assert.deepEqual(cards([bump('w/A1', at1), bump('w/A2', at2), bump('w/A5', at2), bump('w/A4', at2)]), [
    ['w/A5', 'progress', true, at2],
    ['w/A6', 'progress', true, null],
    ['w/A4', 'todo', true, at2],
    ['w/A2', 'todo', true, at2],
    ['w/A1', 'todo', true, at1],
    ['w/A3', 'todo', true, null],
  ]);
  assert.deepEqual(cards([bump('w/A1', at1), bump('w/A2', at2), bump('w/A1', '2026-10-23T11:30:00Z')]).slice(2, 4).map(([key]) => key), ['w/A1', 'w/A2']);
  const draft = buildBoard({ fromWaves: false, prs: { 'o/r#7': greenDraft }, waves: [{ slug: 'w', wave: { repo: 'o/r', items: [{ id: 'D1', title: 'Draft', pr: 7 }] } }], events: [bump('w/D1', at1)] }).items[0];
  assert.deepEqual([draft.lane, draft.waitsOn, draft.bumpable, draft.bumpedAt], ['review', 'ready', false, null]);
});

test('every In Progress card bumps, held or waiting on checking included, and a bump made before the build started clears when it starts', () => {
  const bump = (key, ts) => ({ id: 'c' + ts, ts, kind: 'card-bump', data: { key }, reply: null });
  const early = '2026-10-23T09:00:00Z';
  const late = '2026-10-23T11:00:00Z';
  const items = [{ id: 'A1', title: 'Running', status: 'building' }, { id: 'A2', title: 'Checking', status: 'checking' }, { id: 'A3', title: 'Queued', queued_at: early }];
  const b = askBoard([bump('w/A1', early), bump('w/A2', late), bump('w/A3', late)], { items, agents: runningBuilders('A1') });
  const card = (id) => b.items.find((i) => i.id === id);
  assert.deepEqual(['A1', 'A2', 'A3'].map((id) => [card(id).lane, card(id).bumpable, card(id).bumpedAt]), [['progress', true, null], ['progress', true, late], ['todo', true, late]]);
  const again = askBoard([bump('w/A1', early), bump('w/A1', late)], { items, agents: runningBuilders('A1') }).items.find((i) => i.id === 'A1');
  assert.equal(again.bumpedAt, late);
});

test('a card-hold applies at once unless held_at is newer, including a legacy held status, and only cards outside Done can be held; a held card ends at the newest hold time', () => {
  const hold = (key, ts, value) => ({ id: 'h' + ts, ts, kind: 'card-hold', data: { key, hold: value }, reply: null });
  const items = [
    { id: 'A1', title: 'One', status: 'planned' },
    { id: 'A2', title: 'Two', status: 'held', held: true, held_at: '2026-10-23T11:05:00Z' },
    { id: 'A3', title: 'Three', status: 'building', held: true, held_at: '2026-10-23T11:20:00Z' },
    { id: 'A4', title: 'Four', status: 'planned', held_at: '2026-10-23T11:20:00Z' },
    { id: 'A5', title: 'Five', status: 'done' },
  ];
  const events = [hold('w/A1', '2026-10-23T11:00:00Z', true), hold('w/A2', '2026-10-23T11:10:00Z', false), hold('w/A3', '2026-10-23T11:10:00Z', false), hold('w/A4', '2026-10-23T11:10:00Z', true), hold('w/A1', '2026-10-23T10:00:00Z', false)];
  const cards = Object.fromEntries(askBoard(events, { items }).items.filter((i) => i.kind === 'work').map((i) => [i.id, [i.held, i.holdable]]));
  assert.deepEqual(cards, { A1: [true, true], A2: [false, true], A3: [true, true], A4: [false, true], A5: [false, false] });

  const until = (key, ts, at) => ({ ...hold(key, ts, true), data: { key, hold: true, until: at } });
  const timed = [
    { id: 'T1', title: 'Tapped', held: true, pick_up_at: '2026-11-05T17:00:00.000Z', held_at: '2026-10-23T11:00:00Z' },
    { id: 'T2', title: 'Recorded', held: true, pick_up_at: '2026-11-05T17:00:00.000Z', held_at: '2026-10-23T11:20:00Z' },
    { id: 'T3', title: 'Forever', held: true, pick_up_at: '2026-11-05T17:00:00.000Z', held_at: '2026-10-23T11:00:00Z' },
    { id: 'T4', title: 'Resumed', held: true, pick_up_at: '2026-11-05T17:00:00.000Z', held_at: '2026-10-23T11:00:00Z' },
  ];
  const taps = [until('w/T1', '2026-10-23T11:10:00Z', '2026-11-04T17:00:00.000Z'), until('w/T2', '2026-10-23T11:10:00Z', '2026-11-04T17:00:00.000Z'),
    hold('w/T3', '2026-10-23T11:10:00Z', true), hold('w/T4', '2026-10-23T11:10:00Z', false)];
  const ends = Object.fromEntries(askBoard(taps, { items: timed }).items.map((i) => [i.id, [i.held, i.heldUntil]]));
  assert.deepEqual(ends, { T1: [true, '2026-11-04T17:00:00.000Z'], T2: [true, '2026-11-05T17:00:00.000Z'], T3: [true, null], T4: [false, null] });
});

// docs/adr/2026-11-03-0223-each-lane-has-one-fixed-order.md
test("each lane has one fixed order, each card carrying the time it sorts by: Todo its New cards, then bumped cards, then newest made; In Progress and In Review newest arrival first; Done most recently closed first; Asks newest answer first", () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  const at = (d) => `2026-11-${String(d).padStart(2, '0')}T10:00:00Z`;
  const made = (d) => `2026-11-${String(d).padStart(2, '0')}T08:00:00Z`;
  const open = (d) => ({ state: 'OPEN', isDraft: false, checks: { state: 'pass' }, reviews: {}, updatedAt: at(d) });
  const merged = (d) => ({ state: 'MERGED', mergedAt: at(d), updatedAt: at(d) });
  const prs = { 'o/r#1': open(3), 'o/r#2': open(5), 'o/r#3': open(6), 'o/r#4': open(4), 'o/r#5': merged(2), 'o/r#6': merged(7) };
  const sent = (d) => ({ Ann: String(Date.parse(at(d)) / 1000) });
  const tapped = '2026-11-09T12:00:00Z';
  const items = [
    { id: 'R1', title: 'r', pr: 1, review_sent: sent(9), created: made(1) }, { id: 'R2', title: 'r', pr: 2, review_sent: sent(8), created: made(2) },
    { id: 'S1', title: 's', pr: 3, review_sent: sent(2), created: made(1) }, { id: 'S2', title: 's', pr: 4, review_sent: sent(1), created: made(2) },
    { id: 'P1', title: 'p', created: made(9) }, { id: 'P2', title: 'p', created: made(1) },
    { id: 'P3', title: 'p', status: 'building', status_at: at(5), created: made(2) },
    { id: 'P4', title: 'p', status: 'done', status_at: at(3), created: made(3) },
    { id: 'T1', title: 't', created: made(8) }, { id: 'T2', title: 't', status: 'planned', created: made(4) },
    { id: 'D1', title: 'd', pr: 5, created: made(9) }, { id: 'D2', title: 'd', pr: 6, created: made(1) }, { id: 'D3', title: 'd', status: 'done', merged_at: at(8), created: made(3) },
    { id: 'D4', title: 'd', status: 'planned', created: made(1) },
    { id: 'ENG-1', title: 'f', created: at(2), parent: 'T1' }, { id: 'ENG-2', title: 'f', created: at(6), parent: 'T1' },
  ];
  // P1 entered In Progress when its build began; a later grill doesn't move it, nor does its latest activity.
  const agents = {
    P1: { main: { kind: 'build', started: at(1), progress_at: at(9) }, grill: { kind: 'grill', started: at(9) } },
    P2: { first: { kind: 'build', started: at(2), done: at(3) }, fix: { kind: 'build', started: at(8) } },
  };
  const events = [
    { id: 'a1', ts: at(7), kind: 'ask', data: { text: 'one' }, reply: null },
    { id: 'a2', ts: at(10), kind: 'ask', data: { text: 'two' }, reply: null },
    { id: 'a3', ts: at(9), kind: 'ask', data: { text: 'three' }, reply: { html: 'ok', at: at(9) } },
    { id: 'a4', ts: at(8), kind: 'ask', data: { text: 'four' }, reply: { html: 'ok', at: at(10) } },
    { id: 'm1', ts: at(7), kind: 'item-message', data: { key: 'w/P4', text: 'One more thing' }, reply: null },
    { id: 'c1', ts: tapped, kind: 'card-done', data: { key: 'w/D4' }, reply: null },
  ];
  const built = (more = []) => buildBoard({ now, fromWaves: false, prs, events: [...events, ...more], waves: [{ slug: 'w', agents, wave: { repo: 'o/r', reviewers: [{ name: 'Ann', github: 'ann' }], items } }] });
  const lanesOf = (b) => {
    const lanes = {};
    for (const i of b.items) (lanes[i.lane] ||= []).push(i.key.replace(/^w\//, ''));
    return lanes;
  };
  const b = built();
  assert.deepEqual(lanesOf(b), {
    review: ['R1', 'R2'],
    stale: ['S1', 'S2'],
    progress: ['P2', 'P4', 'P3', 'P1'],
    todo: ['ask:a1', 'ask:a2', 'T1', 'ENG-2', 'T2', 'ENG-1'],
    done: ['D4', 'D3', 'D2', 'D1'],
    asks: ['ask:a4', 'ask:a3'],
  });
  const sortAt = Object.fromEntries(b.items.map((i) => [i.key.replace(/^w\//, ''), i.sortAt]));
  assert.deepEqual(sortAt, {
    R1: at(9).replace('Z', '.000Z'), R2: at(8).replace('Z', '.000Z'), S1: at(2).replace('Z', '.000Z'), S2: at(1).replace('Z', '.000Z'),
    P1: at(1), P2: at(8), P3: at(5), P4: at(7),
    'ask:a1': at(7), 'ask:a2': at(10), T1: made(8), T2: made(4), 'ENG-1': at(2), 'ENG-2': at(6),
    'ask:a3': at(9), 'ask:a4': at(10), D1: at(2), D2: at(7), D3: at(8), D4: tapped,
  });
  const bumped = built([{ id: 'cb', ts: at(10), kind: 'card-bump', data: { key: 'w/ENG-1' }, reply: null }]);
  assert.deepEqual(lanesOf(bumped).todo, ['ask:a1', 'ask:a2', 'ENG-1', 'T1', 'ENG-2', 'T2']);
});

test("an internal card's ref reads INT-<n> with no repo, and each card lists when Claude or GitHub wrote in its thread, leaving out builder status lines and the owner's answers", () => {
  const owner = { items: [{ id: 'q1', topic: 'item:site/S3', question: 'Keep it?' }, { id: 'q2', topic: 'item:site/S3', question: 'Ship it?', state: 'resolved' }] };
  const threads = { 'site/S3': [
    { ts: '2026-10-23T09:00:00Z', who: 'claude', text: 'Built.' },
    { ts: '2026-10-23T09:05:00Z', who: 'love', text: 'Thanks' },
    { ts: '2026-10-23T09:10:00Z', who: 'Jamie', via: 'github', text: 'Nit' },
    { ts: '2026-10-23T09:12:00Z', who: 'Sam', via: 'slack', text: 'Saw it' },
    { ts: '2026-10-23T09:13:00Z', who: 'love', via: 'slack', text: 'Same' },
    { ts: '2026-10-23T09:15:00Z', who: 'claude', kind: 'status', text: 'Codex: Fixing the nit' },
  ] };
  const events = [{ id: 'm1', ts: '2026-10-23T09:20:00Z', kind: 'item-message', data: { key: 'site/S3', text: 'Fix it' }, reply: { html: 'Fixed.', at: '2026-10-23T09:30:00Z' } },
    { id: 'o1', ts: '2026-10-23T09:40:00Z', kind: 'owner-answer', data: { id: 'q2', choice: 'A', note: 'Ship' }, reply: null }];
  const b = buildBoard({
    fromWaves: false, owner, threads, events,
    waves: [
      { slug: 'site', wave: { internal: true, items: [{ id: 'S3', title: 'Three' }, { id: 'INT-14', title: 'Fourteen' }] } },
      { slug: 'w', wave: { items: [{ id: 'B5', title: 'Five', pr: 5 }] } },
    ],
  });
  const byKey = Object.fromEntries(b.items.map((i) => [i.key, [i.ref, i.othersAt, i.repo, i.pr]]));
  assert.deepEqual(byKey, {
    'site/S3': ['INT-3', ['2026-10-23T09:00:00Z', '2026-10-23T09:10:00Z', '2026-10-23T09:30:00Z'], null, null],
    'site/INT-14': ['INT-14', [], null, null],
    'w/B5': ['B5', [], null, null],
  });
  assert.deepEqual(b.needs.map((n) => n.title), ['INT-3: Three']);
  assert.equal(b.ownerTopics.find((t) => t.id === 'item:site/S3').title, 'INT-3: Three');
});

test('a card badges only a ticket from its board source, keeps another source\'s id unlinked, and links Linear in its workspace', () => {
  const waves = [
    { slug: 'w', wave: { internal: true, items: [{ id: 'S3', title: 'Legacy' }, { id: 'INT-14', title: 'Hub card' }, { id: 'C4', title: 'Internal', ticket: 'INT-4' },
      { id: 'C5', title: 'Issue', ticket: '#5' }, { id: 'C6', title: 'Linear', ticket: 'ENG-6' }, { id: 'F7', title: 'Follow', ticket: 'INT-7', parent: 'C4' }] } },
    { slug: 'web', wave: { items: [{ id: 'P1', title: 'Audit', linear: ['WEB-9'] }] } },
  ];
  const build = (tickets) => buildBoard({ tickets, github: 'owner/repo', waves, events: [askAt('a1', '2026-10-23T09:00:00Z')] });
  const badges = (board) => Object.fromEntries(board.items.filter((i) => i.kind !== 'ask').map((i) => [i.id, i.ticket && [i.ticket.id, i.ticket.url]]));
  const own = (id) => [id, null];
  const card = (id) => [`#item=${encodeURIComponent(id)}`];
  assert.deepEqual(badges(build(undefined)), { S3: null, 'INT-14': null, C4: ['INT-4', ...card('w/C4')], C5: own('#5'), C6: own('ENG-6'), F7: ['INT-7', ...card('w/F7')], P1: null });
  assert.deepEqual(badges(build({ source: 'internal', prefix: 'INT' })),
    { S3: ['INT-3', ...card('w/S3')], 'INT-14': ['INT-14', ...card('w/INT-14')], C4: ['INT-4', ...card('w/C4')], C5: own('#5'), C6: own('ENG-6'), F7: ['INT-7', ...card('w/F7')], P1: null });
  const ops = build({ source: 'internal', prefix: 'OPS' });
  assert.deepEqual(badges(ops), { S3: ['OPS-3', ...card('w/S3')], 'INT-14': null, C4: own('INT-4'), C5: own('#5'), C6: own('ENG-6'), F7: own('INT-7'), P1: null });
  assert.deepEqual(['S3', 'INT-14'].map((id) => ops.items.find((i) => i.id === id).ref), ['OPS-3', 'INT-14']);
  const refs = (board) => Object.fromEntries(board.items.filter((i) => i.kind !== 'ask').map((i) => [i.id, i.ref]));
  const stored = { S3: 'INT-3', 'INT-14': 'INT-14', C4: 'C4', C5: 'C5', C6: 'C6', F7: 'F7', P1: 'P1' };
  assert.deepEqual(refs(build(undefined)), stored);
  assert.deepEqual(refs(build({ source: 'internal', prefix: 'INT' })), { ...stored, C4: 'INT-4', F7: 'INT-7' });
  assert.deepEqual(refs(build({ source: 'github' })), { ...stored, C5: '#5' });
  assert.deepEqual(refs(build({ source: 'linear', workspace: 'acme', team: 'ENG', project: 'Audit' })), { ...stored, C6: 'ENG-6' });
  assert.deepEqual(badges(build({ source: 'github' })), { S3: null, 'INT-14': null, C4: own('INT-4'), C5: ['#5', 'https://github.com/owner/repo/issues/5'], C6: own('ENG-6'), F7: own('INT-7'), P1: null });
  const linear = build({ source: 'linear', workspace: 'new-workspace', team: 'ENG', project: 'Audit' });
  assert.deepEqual(badges(linear), { S3: null, 'INT-14': null, C4: own('INT-4'), C5: own('#5'), C6: ['ENG-6', 'https://linear.app/new-workspace/issue/ENG-6'], F7: own('INT-7'), P1: null });
  assert.equal(linear.items.find((i) => i.kind === 'ask').ticket, undefined);
  assert.deepEqual([build(undefined), build({ source: 'github' }), linear].map((b) => b.items.find((i) => i.id === 'P1').linear),
    [[{ id: 'WEB-9', url: null }], [{ id: 'WEB-9', url: null }], [{ id: 'WEB-9', url: 'https://linear.app/new-workspace/issue/WEB-9' }]]);
  const legacy = buildBoard({ tickets: { source: 'linear', workspace: 'new-workspace', team: 'ENG', project: 'Audit' }, waves: [{ slug: 'w', wave: { items: [{ id: 'A1', title: 'Old', linear: ['ENG-9', 'ENG-10'] }] } }] });
  assert.deepEqual(legacy.items[0].linear.map((l) => l.url), ['https://linear.app/new-workspace/issue/ENG-9', 'https://linear.app/new-workspace/issue/ENG-10']);
});

test('a card lists each unfinished dep it is blocked by, a Done one none; one only grilled, prototyped or with a message marked working sits in Todo, one built stays In Progress unless held', () => {
  const items = [
    { id: 'S10', title: 'Ten', status: 'done' },
    { id: 'S11', title: 'Eleven', status: 'building' },
    { id: 'INT-14', title: 'Fourteen', status: 'planned' },
    { id: 'INT-15', title: 'Fifteen', status: 'building', deps: ['S10', 'S11', 'INT-14'] },
    { id: 'INT-16', title: 'Sixteen', status: 'waiting', deps: ['S10'] },
    { id: 'INT-17', title: 'Seventeen', status: 'waiting' },
    { id: 'INT-18', title: 'Grilled', deps: ['S11'] },
    { id: 'INT-19', title: 'Grilled, held', deps: ['S11'], held: true },
    { id: 'INT-20', title: 'Prototyped by an agent', status: 'planned' },
    { id: 'INT-27', title: 'Built before', status: 'planned', deps: ['S11'] },
    { id: 'INT-28', title: 'Built before, held', status: 'planned', held: true },
    { id: 'INT-21', title: 'Landed first', status: 'done', deps: ['S11'] },
    { id: 'INT-22', title: 'Message worked on', deps: ['S11'] },
    { id: 'INT-23', title: 'Prototyped' },
    { id: 'INT-24', title: 'Message waiting' },
    { id: 'INT-25', title: 'Made from a worked ask', from_ask: 'a1' },
    { id: 'INT-26', title: 'Worked on, held', held: true },
  ];
  const message = (id, key) => ({ id, ts: '2026-10-23T09:00:00Z', kind: 'item-message', data: { key, text: 'Look at this' }, reply: null });
  const events = [message('m22', 'site/INT-22'), message('m24', 'site/INT-24'), message('m26', 'site/INT-26'), { id: 'a1', ts: '2026-10-23T08:00:00Z', kind: 'ask', data: { text: 'Make it' }, reply: null }];
  const working = { m22: '2026-10-23T09:01:00Z', m26: '2026-10-23T09:01:00Z', a1: '2026-10-23T08:01:00Z' };
  const prototypes = [{ topic: 'shape', title: 'Shape', card: 'site/INT-23', takes: [{ key: 'A', label: 'One' }] }];
  const owner = { items: ['INT-18', 'INT-19'].map((id) => ({ id: `q${id}`, topic: `item:site/${id}`, question: '?', options: [], resolved: 'Picked.', resolved_at: '2026-10-23T10:00:00Z' })) };
  const finished = (kind) => ({ main: { label: 'Opus', kind, started: '2026-10-23T09:00:00Z', done: '2026-10-23T09:30:00Z' } });
  const agents = { ...runningBuilders('S11', 'INT-15'), 'INT-20': finished('prototype'), 'INT-27': finished('opus'), 'INT-28': finished('opus') };
  const b = buildBoard({ fromWaves: false, owner, events, working, prototypes, waves: [{ slug: 'site', agents, wave: { internal: true, items } }] });
  const card = (id) => b.items.find((i) => i.id === id);
  assert.deepEqual(card('INT-15').blockedBy, [{ key: 'site/S11', ref: 'INT-11' }, { key: 'site/INT-14', ref: 'INT-14' }]);
  assert.equal(card('INT-15').lane, 'progress');
  assert.deepEqual([card('INT-16').blockedBy, card('INT-16').lane], [[], 'todo']);
  assert.deepEqual([card('INT-17').blockedBy, card('S11').lane], [[], 'progress']);
  assert.deepEqual([card('INT-18').blockedBy, card('INT-18').lane], [[{ key: 'site/S11', ref: 'INT-11' }], 'todo']);
  assert.deepEqual([card('INT-19').lane, card('INT-20').lane], ['todo', 'todo']);
  assert.deepEqual([card('INT-27').blockedBy, card('INT-27').lane, card('INT-28').lane], [[{ key: 'site/S11', ref: 'INT-11' }], 'progress', 'todo']);
  assert.deepEqual([card('INT-21').blockedBy, card('INT-21').lane], [[], 'done']);
  assert.deepEqual(['INT-22', 'INT-23', 'INT-24', 'INT-25', 'INT-26'].map((id) => card(id).lane), ['todo', 'todo', 'todo', 'todo', 'todo']);
  assert.deepEqual([card('INT-22').working, card('INT-23').buildable], [true, true]);
  // The idle pull skips a Todo card a session is working on (docs/adr/2026-11-02-1754-an-idle-board-pulls-in-its-top-todo-card.md).
  assert.equal(pullOf(b.items).pullable.includes('site/INT-22'), false);
  assert.equal(pullOf(b.items).pullable.includes('site/INT-23'), false, 'no state: planned, not pulled');
});

test("a checking card sits in In Progress waiting on Claude's check, with no builder line or next step, and still blocks its dependents", () => {
  const record = { main: { label: 'Opus builder', started: '2026-10-23T10:00:00Z', progress: 'Running tests', progress_at: '2026-10-23T10:05:00Z' } };
  const b = buildBoard({ fromWaves: false, waves: [
    { slug: 'site', agents: { S1: record }, wave: { internal: true, items: [
      { id: 'S1', title: 'One', status: 'checking', next: 'Verify it' },
      { id: 'S2', title: 'Two', status: 'waiting', deps: ['S1'] },
    ] } },
    { slug: 'w', wave: { repo: 'o/r', items: [{ id: 'A1', title: 'Draft', status: 'checking', pr: 7 }, { id: 'A2', title: 'No PR', status: 'checking' }] } },
  ], prs: { 'o/r#7': greenDraft } });
  const card = (key) => b.items.find((i) => i.key === key);
  const one = card('site/S1');
  assert.deepEqual([one.lane, one.waitsOn, one.builder, one.next, one.bumpable], ['progress', 'checking', null, null, true]);
  assert.deepEqual(card('site/S2').blockedBy, [{ key: 'site/S1', ref: 'INT-1' }]);
  assert.deepEqual([card('w/A1').lane, card('w/A1').waitsOn, card('w/A2').lane], ['progress', 'checking', 'progress']);
  assert.equal(b.waves[0].finished, null);
});

test('an edited pending message shows its latest text marked Edited, keeps its files, and a replied one takes no edit', () => {
  const shot = { name: 'shot.png', url: 'uploads/1-shot.png', type: 'image/png' };
  const edit = (id, ts, text, key) => ({ id: 'x' + ts, ts, kind: 'ask-edited', data: { id, text, ...(key ? { key } : {}) }, reply: null });
  const events = [
    askAt('a1', '2026-10-23T09:00:00Z', { data: { text: 'Old title\nmore', files: [shot] } }),
    edit('a1', '2026-10-23T09:05:00Z', 'Newer title\nmore'),
    edit('a1', '2026-10-23T09:06:00Z', 'Newest title\nmore'),
    askAt('a2', '2026-10-23T09:10:00Z', { reply: { html: 'Done.' } }),
    { id: 'm1', ts: '2026-10-23T10:00:00Z', kind: 'item-message', data: { key: 'w/A1', text: 'Fix it', files: [shot] }, reply: null },
    edit('m1', '2026-10-23T10:01:00Z', 'Fix it well', 'w/A1'),
  ];
  const b = askBoard(events);
  const a1 = b.items.find((i) => i.key === 'ask:a1');
  assert.deepEqual([a1.title, a1.ask.edited, a1.ask.canEdit], ['Newest title', true, true]);
  assert.equal(b.items.find((i) => i.key === 'ask:a2').ask.canEdit, false);
  const [m] = threadOf('w/A1', { events });
  assert.deepEqual([m.text, m.edited, m.files, m.canEdit], ['Fix it well', true, [shot], true]);
  const [ask] = threadOf('ask:a1', { events });
  assert.deepEqual([ask.text, ask.edited, ask.files], ['Newest title\nmore', true, [shot]]);
  const lines = [{ ts: '2026-10-23T10:05:00Z', who: 'claude', text: 'Done.' }];
  const [answered] = threadOf('w/A1', { lines, events });
  assert.deepEqual([answered.canEdit, answered.canDelete], [false, false]);
});

test("files sent with an edit join the message's files, after the ones it was sent with, on the thread and on the New card", () => {
  const shot = { name: 'shot.png', url: 'uploads/1-shot.png', type: 'image/png' };
  const more = { name: 'more.pdf', url: 'uploads/2-more.pdf', type: 'application/pdf' };
  const last = { name: 'last.png', url: 'uploads/3-last.png', type: 'image/png' };
  const edit = (id, ts, text, files, key) => ({ id: 'x' + ts, ts, kind: 'ask-edited', data: { id, text, files, ...(key ? { key } : {}) }, reply: null });
  const events = [
    askAt('a1', '2026-10-23T09:00:00Z', { data: { text: 'Fix it', files: [shot] } }),
    edit('a1', '2026-10-23T09:06:00Z', 'Fix it now', [last]),
    edit('a1', '2026-10-23T09:05:00Z', 'Fix it well', [more]),
    { id: 'm1', ts: '2026-10-23T10:00:00Z', kind: 'item-message', data: { key: 'w/A1', text: 'Look' }, reply: null },
    edit('m1', '2026-10-23T10:01:00Z', 'Look here', [last], 'w/A1'),
  ];
  const [ask] = threadOf('ask:a1', { events });
  assert.deepEqual([ask.text, ask.files], ['Fix it now', [shot, more, last]]);
  assert.deepEqual(askBoard(events).items.find((i) => i.key === 'ask:a1').ask.files, [shot, more, last]);
  assert.deepEqual(threadOf('w/A1', { events })[0].files, [last]);
});

// docs/adr/2026-11-03-0259-answered-asks-have-their-own-section-below-done.md
test('Done holds every closed work card, however old, with no Older fold, and answered asks sit in Asks, the newest answer first', () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  const at = (d) => new Date(now - d * 86400000).toISOString();
  const prs = { 'o/r#1': { state: 'MERGED', mergedAt: at(2) }, 'o/r#2': { state: 'MERGED', mergedAt: at(9) }, 'o/r#3': { state: 'MERGED', mergedAt: at(30) } };
  const items = [{ id: 'A1', title: 'a', pr: 1 }, { id: 'A2', title: 'b', pr: 2 }, { id: 'A3', title: 'c', pr: 3 }, { id: 'A4', title: 'd' },
    { id: 'ENG-1', title: 'f', status: 'done', status_at: at(12), parent: 'A4' }, { id: 'ENG-2', title: 'g', status: 'done', status_at: at(1), parent: 'A4' }];
  const events = [
    { id: 'a1', ts: at(1), kind: 'ask', data: { text: 'q' }, reply: { html: 'ok', at: at(0.5) } },
    { id: 'a2', ts: at(10), kind: 'ask', data: { text: 'r' }, reply: { html: 'ok', at: at(0.2) } },
    { id: 'a3', ts: at(3), kind: 'ask', data: { text: 's' }, reply: { html: 'ok', at: at(2) } },
  ];
  const b = buildBoard({ now, fromWaves: false, prs, events, waves: [{ slug: 'w', wave: { repo: 'o/r', items } }] });
  assert.deepEqual(b.items.filter((i) => i.lane === 'done').map((i) => [i.key, i.fold]), [
    ['w/ENG-2', null], ['w/A1', null], ['w/A2', null], ['w/ENG-1', null], ['w/A3', null],
  ]);
  assert.deepEqual(b.items.filter((i) => i.lane === 'asks').map((i) => [i.key, i.fold, i.sortAt]), [['ask:a2', null, at(0.2)], ['ask:a1', null, at(0.5)], ['ask:a3', null, at(2)]]);
  assert.deepEqual(b.items.map((i) => i.lane).slice(-3), ['asks', 'asks', 'asks']);
});

test('a wave whose every item is merged, done or dropped is finished, and its Done cards fold under one wave row, newest first, until an open card reopens it', () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  const at = (d) => new Date(now - d * 86400000).toISOString();
  const prs = { 'o/r#1': { state: 'MERGED', mergedAt: at(1) }, 'o/r#2': { state: 'CLOSED', updatedAt: at(3) }, 'o/r#3': { state: 'MERGED', mergedAt: at(20) } };
  const waves = (open) => [
    { slug: 'x', wave: { repo: 'o/r', items: [{ id: 'X1', title: 'a', pr: 1 }, { id: 'X2', title: 'b', pr: 2 }, { id: 'X3', title: 'c', status: 'dropped' }, { id: 'X4', title: 'd', pr: 3 },
      { id: 'ENG-1', title: 'f', status: 'done', status_at: at(2), parent: 'X1' }, { id: 'ENG-2', title: 'g', status: open ? 'planned' : 'done', status_at: at(2), parent: 'X1' }] } },
    { slug: 'site', wave: { internal: true, items: [{ id: 'S1', title: 's', status: 'done' }] } },
    { slug: 'open', agents: runningBuilders('O2'), wave: { items: [{ id: 'O1', title: 'o', status: 'merged' }, { id: 'O2', title: 'p', status: 'building' }] } },
    { slug: 'empty', wave: { items: [] } },
  ];
  const b = buildBoard({ now, fromWaves: false, prs, waves: waves(false) });
  assert.deepEqual(b.waves.map((w) => [w.slug, w.finished]), [['x', { merged: 4, dropped: 2 }], ['site', { merged: 1, dropped: 0 }], ['open', null], ['empty', null]]);
  assert.deepEqual(b.items.map((i) => [i.key, i.lane, i.fold]), [
    ['open/O2', 'progress', null],
    ['x/X1', 'done', 'wave:x'], ['x/ENG-2', 'done', 'wave:x'], ['x/ENG-1', 'done', 'wave:x'], ['x/X2', 'done', 'wave:x'], ['x/X4', 'done', 'wave:x'],
    ['x/X3', 'done', 'wave:x'], ['open/O1', 'done', null], ['site/S1', 'done', 'wave:site'],
  ]);
  const reopened = buildBoard({ now, fromWaves: false, prs, waves: waves(true) });
  assert.deepEqual(reopened.waves.map((w) => [w.slug, w.finished]), [['x', null], ['site', { merged: 1, dropped: 0 }], ['open', null], ['empty', null]]);
  assert.deepEqual(reopened.items.filter((i) => i.wave === 'x').map((i) => [i.key, i.lane, i.fold]), [
    ['x/ENG-2', 'todo', null],
    ['x/X1', 'done', null], ['x/ENG-1', 'done', null], ['x/X2', 'done', null], ['x/X4', 'done', null], ['x/X3', 'done', null],
  ]);
});

test('the board says when GitHub was last checked, late past twice the interval but never while idle, and whether it is listening', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  const checks = (checked, listening) => buildBoard({ now, fromWaves: false, waves: [], checked, listen: listening === true ? 'listening' : listening === false ? 'deaf' : listening }).checks;
  const at = (min) => new Date(now - min * 60000).toISOString();
  assert.deepEqual(checks(null, true), { at: null, every: 30, idle: false, late: false, watcher: 'running', claudeAt: null });
  assert.deepEqual(checks({ at: at(12), every: 30 }, true), { at: at(12), every: 30, idle: false, late: false, watcher: 'running', claudeAt: null });
  assert.deepEqual(checks({ at: at(61), every: 30 }, true), { at: at(61), every: 30, idle: false, late: true, watcher: 'running', claudeAt: null });
  assert.deepEqual(checks({ at: at(61), every: 60 }, false), { at: at(61), every: 60, idle: false, late: false, watcher: 'stopped', claudeAt: null });
  assert.equal(checks({ at: at(12), every: 30 }, 'asleep').watcher, 'asleep');
  assert.equal(checks({ at: at(12), every: 30 }, 'waking').watcher, 'waking');
  assert.deepEqual(checks({ at: at(300), every: null, idle: true }, true), { at: at(300), every: null, idle: true, late: false, watcher: 'running', claudeAt: null });
});

test("the board dates Claude's newest write it can see: a reply, a Claude thread line, a working mark, a builder record or a watcher start, not the hub's check", () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  const at = (min) => new Date(now - min * 60000).toISOString();
  const claudeAt = (extra) => buildBoard({ now, fromWaves: false, checked: { at: at(1) }, watcher: { running: true, since: at(40) }, waves: [{ slug: 'w', agents: {}, wave: { items: [{ id: 'A1', title: 'One' }] } }], ...extra }).checks.claudeAt;
  assert.equal(claudeAt({}), at(40));
  assert.equal(claudeAt({ replyAt: at(30) }), at(30));
  assert.equal(claudeAt({ threads: { 'w/A1': [{ ts: at(20), who: 'claude', text: 'x' }, { ts: at(1), who: 'love', text: 'y' }] } }), at(20));
  assert.equal(claudeAt({ working: { e1: at(10) } }), at(10));
  assert.equal(claudeAt({ waves: [{ slug: 'w', agents: { A1: { main: { started: at(5) } } }, wave: { items: [{ id: 'A1', title: 'One' }] } }] }), at(5));
  assert.equal(claudeAt({ waves: [{ slug: 'w', agents: { A1: { main: { started: at(30), done: at(2) } } }, wave: { items: [{ id: 'A1', title: 'One' }] } }] }), at(2));
});

test('try state maps web and app badges using current worktree heads, keeps lanes and installs, and omits Done', () => {
  const waves = [{ slug: 'w', wave: { repo: 'o/r', items: [{ id: 'INT-41', pr: 7, install: { url: 'https://m/app.apk', sha: 'abcdef1' } }] } }];
  const snapshot = { route: 'orch', waves, prs: { 'o/r#7': { ...greenDraft, headRefOid: 'abcdef123' } } };
  assert.equal(buildBoard(snapshot).kind, 'app');
  for (const kind of ['web', 'app']) {
    const current = { sha: 'abcdef1', head: 'abcdef123', ahead: 2, script: true, state: 'ready', https: 8501 };
    const result = buildBoard({ ...snapshot, try: { kind, cards: { 'w/INT-41': current } } });
    const item = result.items[0];
    assert.equal(item.lane, 'review');
    assert.deepEqual(item.try, { kind, state: 'ready', stale: false, sha: 'abcdef1', changes: true, script: true, autoBuild: false, url: kind === 'web' ? null : 'https://m/app.apk', port: kind === 'web' ? 8501 : null });
    assert.equal(buildBoard({ ...snapshot, autoBuild: true, try: { kind, cards: { 'w/INT-41': current } } }).items[0].try.autoBuild, true);
    assert.equal(item.install.url, 'https://m/app.apk');
    const stale = buildBoard({ ...snapshot, try: { kind, cards: { 'w/INT-41': { ...current, head: 'fedcba1', state: 'running' } } } }).items[0];
    assert.equal(stale.try.stale, true);
    assert.equal(stale.try.state, 'running');
    assert.equal(stale.try.url, kind === 'web' ? null : 'https://m/app.apk');
    assert.equal(stale.try.port, null);
    const done = buildBoard({ ...snapshot, prs: { 'o/r#7': { state: 'MERGED' } }, try: { kind, cards: { 'w/INT-41': current } } }).items[0];
    assert.equal(done.try, undefined);
  }
  assert.equal(buildBoard({ waves: [] }).kind, 'web');
});

test('main maps the recorded branch, commit time and short sha to its web or published app URL', () => {
  const run = { slug: 'o/r', branch: 'develop', sha: 'abcdef123456', at: '2026-11-01T00:00:00Z', script: true, state: 'ready', https: 8501 };
  for (const kind of ['web', 'app']) {
    const snapshot = { waves: [], route: 'orch', try: { kind, main: run }, main: { install: { url: 'https://m/main.apk' } } };
    assert.deepEqual(buildBoard(snapshot).main, { slug: run.slug, branch: 'develop', sha: 'abcdef1', at: run.at, kind, state: 'ready', url: kind === 'web' ? null : 'https://m/main.apk', port: kind === 'web' ? 8501 : null, pull: null });
    assert.deepEqual(buildBoard({ ...snapshot, try: { kind, main: run, pull: { at: 'now' } } }).main.pull, { running: false, error: null });
    assert.deepEqual(buildBoard({ ...snapshot, try: { kind, main: run, pull: { at: 'now', running: true, error: 'can’t pull: local changes' } } }).main.pull, { running: true, error: 'can’t pull: local changes' });
    assert.equal(buildBoard({ ...snapshot, try: { kind, main: { ...run, script: false } } }).main, null);
  }
  assert.equal(buildBoard({ waves: [] }).main, null);
});

test('review records use one precedence order and date the card from the item record', () => {
  const wave = { review_link_ts: { 7: { Ann: '2.0', Bob: '3.0' }, 'w/A1': { Cy: '4.0' } } };
  const topicItems = { 'w/A1': { review_link_ts: { Ann: '1.0', Dee: '5.0' } } };
  const item = { pr: 7, review_link_ts: { Ann: { ts: '1792800000.000100', channel: 'D1', reactions: ['git_merged'] } }, review_sent: { Ann: '6.0', Eve: '7.0' } };
  assert.deepEqual({ ...reviewLinks(wave, item, 'w/A1', topicItems) }, {
    Ann: { ts: '1792800000.000100', channel: 'D1' }, Eve: { ts: '7.0' }, Bob: { ts: '3.0' }, Cy: { ts: '4.0' }, Dee: { ts: '5.0' },
  });
  assert.deepEqual({ ...reviewLinks({}, { review_sent: ['Ann'] }, 'w/A1') }, { Ann: { ts: null } });
  assert.deepEqual({ ...reviewLinks({}, { review_link_ts: { Ann: '8.0' } }, 'w/A1') }, { Ann: { ts: '8.0' } });
  const card = board({ item: { review_link_ts: item.review_link_ts }, topicItems: { 'w/A1': { review_link_ts: { Ann: '1.0' } } }, pr: { ...greenDraft, isDraft: false }, now: Date.parse('2026-11-01T00:00:00Z') }).items[0];
  assert.deepEqual(card.review.Ann, { state: 'sent', since: '2026-10-24T00:00:00.000Z', github: 'ann' });
  assert.equal(card.inReviewSince, '2026-10-24T00:00:00.000Z');
  assert.equal(card.lane, 'stale');
  assert.equal(Object.hasOwn(card, 'slack'), false);
  assert.equal(Object.hasOwn(board().waves[0], 'watched'), false);
});

// docs/adr/2026-11-03-1840-waves-are-bands-in-todo.md
test("each open lineup is a wave band with its cards in order, its next unstarted card ready or why not, progress and triage, its cards carry its slug; a wave file is a band only on a board over the waves, with triage from wave-triage {wave} and topic wave:<slug>", () => {
  const items = [
    { id: 'INT-1', title: 'One', status: 'done' }, { id: 'INT-2', title: 'Two', status: 'building' }, { id: 'INT-3', title: 'Three', deps: ['INT-2'], state: 'ready' },
    { id: 'INT-4', title: 'Four', status: 'dropped' }, { id: 'INT-5', title: 'Five' }, { id: 'INT-6', title: 'Six', status: 'done' }, { id: 'INT-7', title: 'Loose' },
    { id: 'INT-8', title: 'Eight', state: 'ready' }, { id: 'INT-9', title: 'Nine', state: 'grilling', deps: ['INT-8'] }, { id: 'INT-10', title: 'Ten', held: true },
  ];
  const lineups = [
    { slug: 'mon', title: 'Monitor', goal: 'The monitor runs in kickflip.', items: ['INT-1', 'INT-2', 'INT-3', 'INT-4'] },
    { slug: 'old', title: 'Old', goal: 'Gone.', items: ['INT-5'], finished_at: '2026-11-01T00:00:00Z' },
    { slug: 'all-done', title: 'All done', goal: 'Shipped.', items: ['INT-6'] },
    { slug: 'go', title: 'Go', goal: 'Ready to go.', items: ['INT-8', 'INT-9'] },
    { slug: 'hold', title: 'Hold', goal: 'Held.', items: ['INT-10'] },
  ];
  const question = (id, topic) => ({ id, topic, question: 'Split it?', options: [{ id: 'yes', label: 'Yes' }] });
  const triage = (id, ts, reply = null) => ({ id, ts, kind: 'wave-triage', data: { lineup: 'mon' }, reply });
  const build = (events, owner = {}, fromWaves = false) => buildBoard({ fromWaves, now: Date.parse('2026-11-02T12:00:00Z'), events, owner,
    waves: [{ slug: 'hub', wave: { internal: true, items, lineups } }, { slug: 'other', wave: { items: [{ id: 'X1', title: 'Elsewhere' }] } }] });

  const idle = build([]);
  const keys = (...ids) => ids.map((id) => `hub/${id}`);
  assert.deepEqual(idle.waveBands[0], { kind: 'lineup', slug: 'mon', title: 'Monitor', goal: 'The monitor runs in kickflip.', merged: 1, total: 4,
    keys: keys('INT-1', 'INT-2', 'INT-3', 'INT-4'), phases: keys('INT-1', 'INT-2', 'INT-3', 'INT-4').map((k) => [k]), next: { key: 'hub/INT-3', ref: 'INT-3', ready: false, word: 'waits on INT-2' }, triage: { running: false, questions: 0 } });
  assert.deepEqual(idle.waveBands.map((b) => [b.slug, b.next]), [
    ['mon', { key: 'hub/INT-3', ref: 'INT-3', ready: false, word: 'waits on INT-2' }],
    ['go', { key: 'hub/INT-8', ref: 'INT-8', ready: true, word: 'ready' }],
    ['hold', { key: 'hub/INT-10', ref: 'INT-10', ready: false, word: 'held' }],
  ]);
  const chip = (id) => idle.items.find((i) => i.id === id).lineup;
  assert.deepEqual([chip('INT-3'), chip('INT-5'), chip('INT-7')], [{ slug: 'mon', title: 'Monitor' }, { slug: 'old', title: 'Old' }, null]);

  assert.deepEqual(build([triage('t1', '2026-11-02T10:00:00Z')]).waveBands[0].triage, { running: true, questions: 0 });
  const asked = build([triage('t1', '2026-11-02T10:00:00Z', { html: '2 questions' }), { id: 'a1', ts: '2026-11-02T10:05:00Z', kind: 'owner-answer', data: { id: 'q2', choice: 'yes' } }],
    { items: [question('q1', 'lineup:mon'), question('q2', 'lineup:mon'), { ...question('q3', 'lineup:mon'), resolved: 'Done', resolved_at: '2026-11-02T09:00:00Z' }] });
  assert.deepEqual(asked.waveBands[0].triage, { running: false, questions: 2 });
  assert.deepEqual(asked.needs.map((n) => [n.text, n.band, n.url]), [['Monitor · 1 question', 'mon', 'questions.html#q1']]);

  const idleRow = { running: false, questions: 0 };
  const files = build([], {}, true).waveBands.filter((b) => b.kind === 'wave');
  assert.deepEqual(files.map((b) => [b.slug, b.goal, b.next, b.phases, b.triage, `${b.merged}/${b.total}`]), [['hub', null, null, null, idleRow, '2/10'], ['other', null, null, null, idleRow, '0/1']]);
  assert.deepEqual(files[1].keys, ['other/X1']);
  const waveTriage = (id, ts, reply = null) => ({ id, ts, kind: 'wave-triage', data: { wave: 'other' }, reply });
  const triaged = (events, owner) => Object.fromEntries(build(events, owner, true).waveBands.map((r) => [`${r.kind}:${r.slug}`, r.triage]));
  assert.deepEqual(triaged([waveTriage('t2', '2026-11-02T10:00:00Z')]), { 'lineup:mon': idleRow, 'lineup:go': idleRow, 'lineup:hold': idleRow, 'wave:hub': idleRow, 'wave:other': { running: true, questions: 0 } });
  const fileAsked = build([waveTriage('t2', '2026-11-02T10:00:00Z', { html: '1 question' })], { items: [question('q4', 'wave:other'), question('q5', 'lineup:mon')] }, true);
  assert.deepEqual(fileAsked.waveBands.map((r) => r.triage.questions), [1, 0, 0, 0, 1]);
  assert.deepEqual(fileAsked.needs.map((n) => [n.text, n.topic, n.band]), [['Monitor · 1 question', 'lineup:mon', 'mon'], ['other · 1 question', 'wave:other', 'other']]);
});

// docs/adr/2026-11-03-1840-waves-are-bands-in-todo.md
test("a wave's card moves up or down among its unstarted cards, past any started or done card between them, and not past either end", () => {
  const items = [
    { id: 'A1', title: 'One', status: 'done' }, { id: 'A2', title: 'Two' }, { id: 'A3', title: 'Three', status: 'building' },
    { id: 'A4', title: 'Four' }, { id: 'A5', title: 'Five' },
  ];
  const built = buildBoard({ now: Date.parse('2026-11-02T12:00:00Z'), events: [], owner: {},
    waves: [{ slug: 'w', wave: { internal: true, items, lineups: [{ slug: 'mon', title: 'Monitor', goal: 'G', items: ['A1', 'A2', 'A3', 'A4', 'A5'] }] } }] });
  const order = (key, by) => lineupMoved(built, 'mon', key, by)?.flat().map((k) => k.slice(2)).join(' ');
  assert.equal(order('w/A2', 1), 'A1 A4 A3 A2 A5');
  assert.equal(order('w/A4', -1), 'A1 A4 A3 A2 A5');
  assert.equal(order('w/A4', 1), 'A1 A2 A3 A5 A4');
  assert.equal(order('w/A2', -1), undefined);
  assert.equal(order('w/A5', 1), undefined);
  assert.equal(order('w/A3', -1), undefined);
  assert.equal(order('w/A1', 1), undefined);
  assert.equal(lineupMoved(built, 'nope', 'w/A2', 1), null);
});

// docs/adr/2026-11-04-0238-a-wave-builds-in-phases.md
test("a phased wave's band gives its phases, Implement goes to its first ready card, so a phase with several ready cards offers the next once one starts, and a move swaps two unstarted cards' places, each taking the other's phase", () => {
  const items = [
    { id: 'P1', title: 'One', status: 'done' }, { id: 'P2', title: 'Two', state: 'ready', deps: ['P1'] }, { id: 'P3', title: 'Three', state: 'ready', deps: ['P1'] },
    { id: 'P4', title: 'Four', state: 'ready', deps: ['P2', 'P3'] },
  ];
  const lineups = [{ slug: 'ph', title: 'Phased', goal: 'G', phases: [['P1'], ['P2', 'P3'], ['P4']] }];
  const build = (over = {}) => buildBoard({ now: Date.parse('2026-11-04T12:00:00Z'), events: [], owner: {},
    waves: [{ slug: 'w', wave: { internal: true, items: items.map((it) => ({ ...it, ...over[it.id] })), lineups } }] });
  const idle = build();
  const [band] = idle.waveBands;
  assert.deepEqual([band.keys, band.phases], [['w/P1', 'w/P2', 'w/P3', 'w/P4'], [['w/P1'], ['w/P2', 'w/P3'], ['w/P4']]]);
  assert.deepEqual(band.next, { key: 'w/P2', ref: 'P2', ready: true, word: 'ready' });
  assert.deepEqual(build({ P2: { status: 'building' } }).waveBands[0].next, { key: 'w/P3', ref: 'P3', ready: true, word: 'ready' });
  assert.deepEqual(build({ P2: { status: 'building' }, P3: { status: 'building' } }).waveBands[0].next, { key: 'w/P4', ref: 'P4', ready: false, word: 'waits on P2, P3' });

  const moved = (key, by) => lineupMoved(idle, 'ph', key, by)?.map((p) => p.map((k) => k.slice(2)).join(',')).join(' → ');
  assert.equal(moved('w/P3', 1), 'P1 → P2,P4 → P3');
  assert.equal(moved('w/P3', -1), 'P1 → P3,P2 → P4');
  assert.equal(moved('w/P2', -1), undefined);
});

// docs/adr/2026-11-03-0526-a-follow-up-is-a-work-card-with-a-parent.md
test('a card links to its Parent, lists its Children and its Related to cards on both sides, and a blocker lists what Waits on it; a card whose Parent left the board still links to its stored id', () => {
  const wave = { items: [
    { id: 'GH-53', title: 'Parent', ticket: '#53', related: ['w/GH-75'] },
    { id: 'GH-93', title: 'Second child', ticket: '#93', parent: 'w/GH-53', deps: ['GH-80'] },
    { id: 'GH-87', title: 'First child', ticket: '#87', parent: 'w/GH-53', status: 'done' },
    { id: 'GH-80', title: 'Blocker', ticket: '#80' },
    { id: 'GH-75', title: 'Similar', ticket: '#75', related: ['w/GH-93'] },
    { id: 'GH-9', title: 'Orphan', ticket: '#9', parent: 'w/GH-404' },
  ] };
  const b = buildBoard({ fromWaves: false, now: Date.parse('2026-11-03T12:00:00Z'), tickets: { source: 'github' }, waves: [{ slug: 'w', wave }] });
  const card = (id) => b.items.find((i) => i.id === id);
  const refs = (list) => list.map((l) => l.ref);
  assert.deepEqual(card('GH-93').parent, { key: 'w/GH-53', ref: '#53' });
  assert.deepEqual(refs(card('GH-53').children), ['#87', '#93']);
  assert.deepEqual(refs(card('GH-53').related), ['#75']);
  assert.deepEqual(refs(card('GH-75').related), ['#53', '#93']);
  assert.deepEqual(refs(card('GH-93').related), ['#75']);
  assert.deepEqual(refs(card('GH-80').waitsOnIt), ['#93']);
  assert.deepEqual(refs(card('GH-93').blockedBy), ['#80']);
  // A Parent no longer on the board reads as its stored id.
  assert.deepEqual([card('GH-9').parent, card('GH-53').parent], [{ key: 'w/GH-404', ref: 'GH-404' }, null]);
  assert.equal(b.items.every((i) => i.kind === 'work'), true);
});

// docs/adr/2026-11-03-0237-an-in-progress-card-always-has-a-builder-line-or-a-next.md
test('an In Progress card with nothing building and no next step reads a gap as its Next, never nothing; a builder line, a check or its own Next fills the place', () => {
  const finished = { main: { label: 'Opus builder', kind: 'opus', started: '2026-10-23T10:00:00Z', done: '2026-10-23T10:30:00Z' } };
  const running = { main: { label: 'Opus builder', kind: 'opus', started: '2026-10-23T10:00:00Z' } };
  const card = (item, agents = {}) => board({ pr: null, item: { pr: undefined, ...item }, agents: { A1: agents } }).items.find((i) => i.key === 'w/A1');
  for (const built of [card({}, finished), card({ status: 'building' }), card({ status: 'fixing' })]) {
    assert.deepEqual([built.lane, built.builder, built.next], ['progress', null, NO_NEXT]);
  }
  assert.deepEqual([card({}, running).next, card({}, running).builder.progress], [null, null]);
  assert.equal(card({ next: 'Land it' }, finished).next, 'Land it');
  assert.equal(card({ status: 'checking' }, finished).next, null);
  assert.deepEqual([card({}).lane, card({}).next], ['todo', null]);
});

// docs/adr/2026-11-03-0301-build-on-a-blocked-card-queues-it.md
test('a queued build puts its card in the Queued section of Todo, blocked, from when it was queued, with no Build, no gap Next and no pull; held it stays out of the section', () => {
  const queuedAt = '2026-11-03T10:26:00.000Z';
  const items = [
    { id: 'A1', title: 'Blocker', status: 'building' },
    { id: 'A2', title: 'Queued', deps: ['A1'], queued_at: queuedAt },
    { id: 'A3', title: 'Queued, held', deps: ['A1'], queued_at: queuedAt, held: true },
  ];
  const b = buildBoard({ fromWaves: false, now: Date.parse('2026-11-03T11:00:00Z'), waves: [{ slug: 'w', agents: runningBuilders('A1'), wave: { internal: true, items } }] });
  const card = (id) => b.items.find((i) => i.id === id);
  const q = card('A2');
  assert.deepEqual([q.lane, q.queued, q.buildable, q.next, q.builder, q.sortAt, q.blockedBy.length], ['todo', true, false, null, null, queuedAt, 1]);
  assert.deepEqual([card('A3').lane, card('A3').queued], ['todo', false]);
  assert.equal(pullOf(b.items).pullable.includes('w/A2'), false);
  assert.equal(owesNext(items[1], []), false);
  assert.equal(owesNext({ ...items[1], queued_at: undefined, status: 'building' }, []), true);
});

// docs/adr/2026-11-04-0150-queued-sits-at-the-top-of-todo.md
test('the Queued section holds tapped cards, and with Auto implement on every ready card; bumped first, the rest oldest first, owing no Next', () => {
  const at = (m) => `2026-11-04T10:${String(m).padStart(2, '0')}:00.000Z`;
  const items = [
    { id: 'A1', title: 'Blocker', status: 'building' },
    { id: 'R1', title: 'Ready old', state: 'ready', created: at(1) },
    { id: 'R2', title: 'Ready new', state: 'ready', created: at(2) },
    { id: 'Q1', title: 'Tapped', deps: ['A1'], queued_at: at(3) },
    { id: 'G1', title: 'Grilled', state: 'ready', created: at(4) },
    { id: 'T1', title: 'Not ready', created: at(5) },
    { id: 'H1', title: 'Held ready', state: 'ready', held: true, created: at(6) },
  ];
  const resolved = { id: 'q1', topic: 'item:w/G1', question: 'Which?', resolved: true, resolved_at: at(0), options: [{ id: 'A', label: 'A' }] };
  const built = ({ autoPull, events = [] }) => buildBoard({ fromWaves: false, autoPull, events, owner: { items: [resolved] }, now: Date.parse(at(30)),
    waves: [{ slug: 'w', agents: runningBuilders('A1'), wave: { internal: true, items } }] });
  const lanes = (b) => b.items.filter((i) => i.kind === 'work').map((i) => `${i.id}:${i.lane}${i.queued ? ':queued' : ''}`);
  const on = built({ autoPull: true });
  assert.deepEqual(lanes(on), ['A1:progress', 'R1:todo:queued', 'R2:todo:queued', 'Q1:todo:queued', 'G1:todo:queued', 'H1:todo', 'T1:todo']);
  const card = (b, id) => b.items.find((i) => i.id === id);
  assert.deepEqual(['R1', 'Q1'].map((id) => [card(on, id).next, card(on, id).sortAt, card(on, id).bumpable]), [[null, at(1), true], [null, at(3), true]]);
  assert.deepEqual(lanes(built({ autoPull: false })), ['A1:progress', 'Q1:todo:queued', 'H1:todo', 'T1:todo', 'G1:todo', 'R2:todo', 'R1:todo'], 'with Auto implement off the queue holds only tapped cards');

  const bump = (kind, key, m) => ({ id: `${kind}${m}`, ts: at(m), kind, data: { key } });
  const queue = (b) => b.items.filter((i) => i.queued).map((i) => i.id);
  assert.deepEqual(queue(built({ autoPull: true, events: [bump('card-bump', 'w/Q1', 10), bump('card-bump', 'w/R2', 11)] })), ['R2', 'Q1', 'R1', 'G1'], 'the latest bump is on top');
  assert.deepEqual(queue(built({ autoPull: true, events: [bump('card-bump', 'w/G1', 10), bump('card-unbump', 'w/G1', 11)] })), ['R1', 'R2', 'Q1', 'G1'], 'an unbump returns the card to its place by time');
  assert.deepEqual(lanes(built({ autoPull: false, events: [bump('card-bump', 'w/R1', 10)] })).slice(0, 3), ['A1:progress', 'Q1:todo:queued', 'R1:todo'], 'with Auto implement off a bump orders Todo');
});

test("the queue drains from its top while In Progress is under the cap: a tapped card starts once nothing blocks it, a ready one is pulled, and queued cards hold no slot", () => {
  const at = (m) => `2026-11-04T10:${String(m).padStart(2, '0')}:00.000Z`;
  const items = (blocker) => [
    { id: 'A1', title: 'Running', status: 'building' },
    { id: 'A2', title: 'Blocker', status: blocker },
    { id: 'Q1', title: 'Tapped', deps: ['A2'], queued_at: at(1) },
    { id: 'R1', title: 'Ready', state: 'ready', created: at(2) },
    { id: 'R2', title: 'Ready too', state: 'ready', created: at(3) },
  ];
  const built = (blocker) => buildBoard({ fromWaves: false, autoPull: true, now: Date.parse(at(30)),
    waves: [{ slug: 'w', agents: runningBuilders('A1'), wave: { internal: true, items: items(blocker) } }] }).items;
  const free = built('done');
  assert.deepEqual(pick(pullOf(free, { cap: 1 })), [[], []], 'a full In Progress takes nothing; the queued cards do not count');
  assert.deepEqual(pick(pullOf(free, { cap: 2 })), [['w/Q1'], []]);
  assert.deepEqual(pick(pullOf(free, { cap: 3 })), [['w/Q1'], ['w/R1']]);
  assert.deepEqual(pick(pullOf(free, { cap: 3, pulled: ['w/R1'] })), [['w/Q1'], []], 'a pulled card not started keeps its slot');
  assert.deepEqual(pick(pullOf(built('building'), { cap: 2 })), [[], ['w/R1']], 'a blocked tapped card at the top lets the next card go');
  function pick({ starts, pulls }) { return [starts, pulls]; }
});

test('a ready card whose questions are all resolved is pullable; an answer that reopens one waits on Claude', () => {
  const owner = { items: [{ id: 'q1', topic: 'item:w/A1', question: 'Which?', resolved: true, resolved_at: '2026-11-04T09:00:00.000Z', options: [{ id: 'A', label: 'A' }] }] };
  const answer = { id: 'e1', ts: '2026-11-04T08:00:00.000Z', kind: 'owner-answer', data: { id: 'q1', choice: 'A' } };
  const card = (events) => buildBoard({ fromWaves: false, owner, events, waves: [{ slug: 'w', wave: { internal: true, items: [{ id: 'A1', title: 'One', state: 'ready' }] } }] }).items;
  assert.deepEqual(pullOf(card([answer])).pullable, ['w/A1']);
  assert.deepEqual(pullOf(card([{ ...answer, ts: '2026-11-04T10:00:00.000Z' }])).pullable, [], 'an answer after the resolve reopens it, waiting on Claude');
});

test('a card-unbump after a card-bump unbumps the card, and a later bump bumps it again', () => {
  const bump = (kind, ts) => ({ id: `${kind}${ts}`, ts: `2026-11-03T10:0${ts}:00.000Z`, kind, data: { key: 'w/A1' } });
  const bumpedAt = (events) => board({ pr: null, item: { pr: undefined }, events }).items.find((i) => i.key === 'w/A1').bumpedAt;
  assert.equal(bumpedAt([bump('card-bump', 1)]), '2026-11-03T10:01:00.000Z');
  assert.equal(bumpedAt([bump('card-bump', 1), bump('card-unbump', 2)]), null);
  assert.equal(bumpedAt([bump('card-bump', 1), bump('card-unbump', 2), bump('card-bump', 3)]), '2026-11-03T10:03:00.000Z');
});

// docs/adr/2026-11-03-0516-a-new-card-is-ready-grilling-or-prototyping.md
test("a card made from an ask reads New until its session sets ready, grilling or prototyping, and only a Ready card the owner owes nothing reads ready and is pullable", () => {
  const q = { id: 'q1', topic: 'item:w/A1', question: 'Which way?', options: [{ id: 'A', label: 'One' }] };
  const card = ({ item = {}, owner = {}, agents = {}, dep, events = [] } = {}) => buildBoard({
    fromWaves: false, events, owner, prs: {},
    waves: [{ slug: 'w', agents, wave: { repo: 'o/r', items: [{ id: 'A1', title: 'One', from_ask: 'e1', ...item }, ...(dep ? [{ id: 'A2', title: 'Two', status: dep }] : [])] } }],
  }).items.find((i) => i.id === 'A1');
  const fields = (c) => [c.unsorted, c.ready, c.grilling];
  const fresh = card();
  assert.deepEqual(fields(fresh), [true, false, false]);
  assert.deepEqual(pullOf([fresh]).pullable, []);
  assert.equal(card({ item: { from_ask: undefined } }).unsorted, false);
  const ready = card({ item: { state: 'ready' } });
  assert.deepEqual(fields(ready), [false, true, false]);
  assert.deepEqual(pullOf([ready]).pullable, ['w/A1']);
  assert.equal(card({ item: { state: 'ready', held: true } }).ready, true);
  assert.equal(card({ item: { state: 'ready', deps: ['A2'] }, dep: 'building' }).ready, false);
  assert.equal(card({ item: { state: 'ready' }, owner: { items: [q] } }).ready, false);
  assert.equal(card({ item: { state: 'ready', status: 'building' } }).ready, false);
  for (const state of ['grilling', 'prototyping']) {
    const c = card({ item: { state } });
    assert.deepEqual([c.unsorted, c.ready], [false, false]);
    assert.deepEqual(pullOf([c]).pullable, []);
  }
  // A grill is under way while a grill agent runs and while a Grill tap waits on its reply, not because the card says grilling.
  assert.deepEqual([card({ item: { state: 'grilling' } }).grilling, card({ item: { state: 'grilling' }, owner: { items: [q] } }).grilling], [false, false]);
  const grill = { kind: 'grill', started: '2026-10-23T10:00:00Z' };
  assert.equal(card({ item: { state: 'ready' }, agents: { A1: { main: grill } } }).grilling, true);
  assert.equal(card({ item: { state: 'ready' }, agents: { A1: { main: { ...grill, done: '2026-10-23T10:30:00Z' } } } }).grilling, false);
  assert.equal(card({ item: { state: 'ready' }, events: [{ id: 'g1', ts: '2026-10-23T10:00:00Z', kind: 'grill-more', data: { key: 'w/A1' } }] }).grilling, true);
  // A grill-more event is handled by a reply, by questions posted on the card after it, or by a grill agent that started after it and finished.
  const event = { id: 'g1', ts: '2026-10-23T10:00:00Z', kind: 'grill-more', data: { key: 'w/A1' } };
  const grilling = (extra) => card({ item: { state: 'ready' }, events: [event], ...extra }).grilling;
  const posted = (asked_at) => ({ items: [{ id: 'q1', topic: 'item:w/A1', question: 'Which?', asked_at }] });
  assert.deepEqual([grilling({ owner: posted('2026-10-23T10:05:00Z') }), grilling({ owner: posted('2026-10-23T09:00:00Z') })], [false, true]);
  const ran = (started, done) => ({ agents: { A1: { main: { kind: 'grill', started, done } } } });
  assert.deepEqual([
    grilling(ran('2026-10-23T10:01:00Z', '2026-10-23T10:30:00Z')), grilling(ran('2026-10-23T10:01:00Z')), grilling(ran('2026-10-23T09:00:00Z', '2026-10-23T09:30:00Z')),
  ], [false, true, true]);
  // A card's Prototype tap is under way the same way, until questions post, a reply comes or a prototype agent that started after it finishes.
  const tap = { id: 'p1', ts: '2026-10-23T10:00:00Z', kind: 'prototype-request', data: { key: 'w/A1' } };
  const prototyping = (extra) => card({ item: { state: 'ready' }, events: [tap], ...extra });
  assert.deepEqual([prototyping().prototyping, prototyping().grilling], [true, false]);
  assert.deepEqual(pullOf([prototyping()]).pullable, []);
  const drew = (started, done) => ({ agents: { A1: { main: { kind: 'prototype', started, done } } } });
  assert.deepEqual([
    prototyping({ owner: posted('2026-10-23T10:05:00Z') }).prototyping, prototyping({ owner: posted('2026-10-23T09:00:00Z') }).prototyping,
    prototyping({ events: [{ ...tap, reply: { at: '2026-10-23T10:02:00Z' } }] }).prototyping,
    prototyping(drew('2026-10-23T10:01:00Z', '2026-10-23T10:30:00Z')).prototyping, prototyping(drew('2026-10-23T10:01:00Z')).prototyping,
  ], [false, true, false, false, true]);
  assert.equal(card({ item: { state: 'ready' }, ...drew('2026-10-23T09:00:00Z') }).prototyping, true);
  // A prototype request on one question is the questions page's eye, not the card's tap.
  assert.equal(card({ item: { state: 'ready' }, events: [{ ...tap, data: { key: 'w/A1', question: 'q1' } }] }).prototyping, false);
});

test("an owner answer stops waiting on Claude once its question is resolved after it, a later round names it, or a build starts after it", () => {
  const q = (id, extra = {}) => ({ id, topic: 'item:w/A1', question: `${id}?`, ...extra });
  const owner = { items: [
    q('resolved', { resolved: 'Acted on: replied', resolved_at: '2026-10-23T12:00:00Z' }),
    q('reopened', { resolved: 'Earlier', resolved_at: '2026-10-23T10:30:00Z' }),
    q('rounded'), q('round2', { round_of: 'rounded', round: 2 }),
    q('before-build'), q('after-build'), q('before-grill'),
  ] };
  const answer = (id, ts) => ({ id: `a-${id}`, ts, kind: 'owner-answer', data: { id, choice: 'A' }, reply: null });
  const events = [answer('resolved', '2026-10-23T11:00:00Z'), answer('reopened', '2026-10-23T11:20:00Z'), answer('rounded', '2026-10-23T11:00:00Z'),
    answer('before-build', '2026-10-23T11:10:00Z'), answer('before-grill', '2026-10-23T11:20:00Z'), answer('after-build', '2026-10-23T13:30:00Z')];
  const agents = { grill: { kind: 'grill', started: '2026-10-23T12:30:00Z', done: '2026-10-23T12:40:00Z' }, main: { kind: 'claude', started: '2026-10-23T11:15:00Z' } };
  const states = (a) => Object.fromEntries(threadOf('w/A1', { events, owner, agents: a }).filter((m) => m.kind === 'owner-answer').map((m) => [m.text.split('?')[0], m.state]));
  assert.deepEqual(states(agents), { resolved: 'answered', reopened: 'waiting', rounded: 'answered', 'before-build': 'answered', 'before-grill': 'waiting', 'after-build': 'waiting' });
  assert.equal(states({ grill: agents.grill })['before-build'], 'waiting');
  // The questions page reads the same resolution from ownerQuestion.
  assert.deepEqual(['resolved', 'reopened'].map((id) => ownerQuestion(owner.items.find((x) => x.id === id), events).answers.map((a) => a.acted)), [[true], [false]]);
});

test("a card's worktree is the path its newest builder record keeps, done or running, and null with none", () => {
  const card = (agents) => board({ agents }).items.find((i) => i.key === 'w/A1');
  const old = { label: 'Opus builder', started: '2026-10-23T09:00:00Z', done: '2026-10-23T09:30:00Z', worktree: { path: '/wt/old', branch: 'A1', repo: '/r' } };
  const done = { label: 'Opus builder', started: '2026-10-23T10:00:00Z', done: '2026-10-23T10:30:00Z', worktree: { path: '/wt/A1', branch: 'A1', repo: '/r' } };
  assert.equal(card({ A1: { main: old, second: done } }).worktree, '/wt/A1');
  assert.equal(card({ A1: { main: { label: 'Grill', started: '2026-10-23T11:00:00Z' }, second: done } }).worktree, '/wt/A1');
  assert.equal(card({ A1: { main: { label: 'Opus builder', started: '2026-10-23T10:00:00Z' } } }).worktree, null);
  assert.equal(card({}).worktree, null);
});

// docs/adr/2026-11-03-1551-an-idle-board-triages-its-todo-once-a-day.md
test("todoOf reads the Todo a triage sees: its cards' keys, titles and deps, and nothing outside Todo", () => {
  const todo = (items) => todoOf(buildBoard({ fromWaves: false, events: [], owner: {}, prs: {}, waves: [{ slug: 'w', wave: { repo: 'o/r', items } }] }).items);
  const base = [{ id: 'A1', title: 'One' }, { id: 'A2', title: 'Two', deps: ['A1'] }, { id: 'A3', title: 'Running', status: 'building' }];
  const seen = todo(base);
  assert.equal(todo([...base]), seen);
  assert.notEqual(todo([...base, { id: 'A4', title: 'New' }]), seen);
  assert.notEqual(todo([{ ...base[0], title: 'One, renamed' }, ...base.slice(1)]), seen);
  assert.notEqual(todo([base[0], { ...base[1], deps: [] }, base[2]]), seen);
  assert.equal(todo([base[0], base[1], { ...base[2], title: 'Running, renamed' }]), seen);
  assert.equal(todo([base[0], base[1], { ...base[2], status: 'done' }]), seen);
  assert.equal(todo([{ id: 'A3', title: 'Running', status: 'building' }]), '');
});

// docs/adr/2026-11-04-0307-the-board-keeps-the-newest-100-done-cards.md
// docs/adr/2026-11-04-1900-triage-runs-once-overnight-on-cards-waiting-on-your-answers.md
test("triageOf names the open cards waiting on unanswered questions, and what it saw changes with them or with Todo", () => {
  const card = (key, lane, open = 0, askedAt = []) => ({ key, kind: 'work', lane, title: key, deps: [], questions: open ? { open, askedAt } : null });
  const base = [card('w/T1', 'todo', 2, ['2026-11-04T10:00:00Z']), card('w/T2', 'todo'), card('w/P1', 'progress', 1, ['2026-11-04T11:00:00Z'])];
  const seen = triageOf(base);
  assert.deepEqual(seen.waiting, ['w/T1', 'w/P1']);
  assert.deepEqual(triageOf([...base, card('w/D1', 'done', 1)]), seen, 'a Done card waits on nothing');
  assert.deepEqual(triageOf([...base, { ...card('w/N1', 'new', 1), kind: 'note' }]).waiting, seen.waiting, 'only work cards');
  assert.deepEqual(triageOf([card('w/T1', 'todo', 0), ...base.slice(1)]).waiting, ['w/P1'], 'answered questions wait on nothing');
  assert.notEqual(triageOf([card('w/T1', 'todo', 3, ['2026-11-04T10:00:00Z', '2026-11-04T12:00:00Z']), ...base.slice(1)]).seen, seen.seen, 'a new question');
  assert.notEqual(triageOf([...base, card('w/T3', 'todo')]).seen, seen.seen, 'a Todo change');
});

test('a triage sees Stale cards beside Todo, and never Done ones, which leave the board by the archive rule', () => {
  const card = (key, lane) => ({ key, lane, title: key, deps: [] });
  const todo = todoOf([card('w/T1', 'todo')]);
  assert.notEqual(todoOf([card('w/T1', 'todo'), card('w/S1', 'stale')]), todo);
  assert.match(todoOf([card('w/S1', 'stale')]), /w\/S1/);
  assert.equal(todoOf([card('w/T1', 'todo'), card('w/D1', 'done')]), todo);
});

// docs/adr/2026-11-03-1551-planners-and-implementers-are-two-kinds-of-agent.md
test("a running planner's line is the card's builder line, marked planner, until a build runs, whose line wins; before its first line a planner reads its kind's word, preheating for a grill and prototyping for a prototype", () => {
  const status = (ts, text, extra = {}) => ({ ts, who: 'claude', kind: 'status', text, ...extra });
  const proto = { kind: 'prototype', model: 'sonnet', label: 'Prototype', started: '2026-10-23T10:00:00Z' };
  const build = { kind: 'claude', model: 'opus', label: 'Builder', started: '2026-10-23T10:10:00Z' };
  const threads = { 'w/A1': [status('2026-10-23T10:05:00Z', 'Prototyping: the notes', { planner: true }), status('2026-10-23T10:12:00Z', 'Building: the page', { phase: 'building' }), status('2026-10-23T10:15:00Z', 'Prototyping: the takes', { planner: true })] };
  const card = (agents, lines = threads) => board({ pr: null, now: Date.parse('2026-10-23T10:20:00Z'), agents: { A1: agents }, threads: lines }).items.find((i) => i.key === 'w/A1');
  const alone = card({ main: proto });
  assert.deepEqual([alone.lane, alone.builder.planner, alone.builder.kind, alone.builder.progress, alone.builder.phase], ['todo', true, 'prototype', 'Prototyping · the takes', null]);
  const both = card({ main: proto, fix: build });
  assert.deepEqual([both.lane, both.builder.planner, both.builder.kind, both.builder.progress, both.builder.phase], ['progress', false, 'claude', 'Building · the page', 'building']);
  assert.equal(card({ main: build }).builder.planner, false);
  assert.equal(card({ main: proto }, {}).builder.progress, 'prototyping');
  assert.equal(card({ main: { ...proto, kind: 'grill', model: 'opus' } }, {}).builder.progress, 'preheating');
  assert.equal(card({ main: build }, {}).builder.progress, null);
});

test('a planner\'s agent and status lines in the thread are marked planner and name its model and kind; an implementer\'s are not', () => {
  const agents = {
    main: { kind: 'prototype', model: 'sonnet', label: 'Prototype', started: '2026-10-23T10:00:00Z', done: '2026-10-23T10:30:00Z' },
    grill: { kind: 'grill', model: 'opus', label: 'Grill agent', started: '2026-10-23T10:01:00Z' },
    build: { kind: 'claude', model: 'opus', label: 'Builder', started: '2026-10-23T10:02:00Z' },
  };
  const lines = [{ ts: '2026-10-23T10:05:00Z', who: 'claude', kind: 'status', text: 'Reading: the notes', planner: true }, { ts: '2026-10-23T10:06:00Z', who: 'claude', kind: 'status', text: 'Building: the page' }];
  const msgs = threadOf('w/A1', { lines, agents });
  assert.deepEqual(msgs.map((m) => [m.text, Boolean(m.planner)]), [
    ['Claude Sonnet prototype started', true], ['Claude Opus grill started', true], ['Claude Opus implementer started', false],
    ['Reading: the notes', true], ['Building: the page', false], ['Claude Sonnet prototype finished', true],
  ]);
});

// docs/adr/2026-11-04-2130-a-button-tap-is-a-status-line-or-a-message-footer.md
test("a card's bare Grill and Prototype taps are muted request entries in its thread, one with text is the owner's message with the request as its footer status, an answer's status is answers submitted, and an ask sent as a Quick build says so under it", () => {
  const ev = (id, kind, data, ts) => ({ id, ts, kind, data: { key: 'w/A1', ...data }, reply: null });
  const events = [
    { id: 'a1', ts: '2026-10-23T09:00:00Z', kind: 'ask', data: { text: 'Add a badge', quick: true }, reply: null },
    ev('g1', 'grill-more', {}, '2026-10-23T10:00:00Z'), ev('p1', 'prototype-request', {}, '2026-10-23T10:01:00Z'),
    ev('g2', 'grill-more', { text: 'Ask about the colours' }, '2026-10-23T10:02:00Z'), ev('p2', 'prototype-request', { text: 'Phone width first' }, '2026-10-23T10:03:00Z'),
    { id: 'q1a', ts: '2026-10-23T10:04:00Z', kind: 'owner-answer', data: { id: 'q1', label: 'A. Keep it', note: 'yes' }, reply: null },
  ];
  const msgs = threadOf('w/A1', { events, fromAsk: 'a1', owner: { items: [{ id: 'q1', topic: 'item:w/A1', question: 'Keep it?' }] } });
  assert.deepEqual(msgs.map((m) => [m.kind, m.text, Boolean(m.request), m.status || null]), [
    ['ask', 'Add a badge', false, null], ['quick-build', 'quick build: no grill, as you asked', true, null],
    ['grill-more', 'grill requested', true, null], ['prototype-request', 'prototype requested', true, null],
    ['grill-more', 'Ask about the colours', false, 'grill requested'], ['prototype-request', 'Phone width first', false, 'prototype requested'],
    ['owner-answer', 'Keep it?\n→ A. Keep it · yes', false, 'answers submitted'],
  ]);
  assert.deepEqual(msgs.filter((m) => m.status).map((m) => m.state), ['waiting', 'waiting', 'waiting']);
  assert.equal(threadOf('w/A1', { events: [{ ...events[0], data: { text: 'Add a badge' } }], fromAsk: 'a1' }).length, 1);
});

test('only a running build keeps the board from being idle: a running planner leaves Pull free to start the next ready card', () => {
  const card = (agents) => ({ key: 'w/A1', lane: 'todo', buildable: true, state: 'ready', blockedBy: [], agents });
  for (const kind of ['prototype', 'grill']) assert.equal(pullOf([card([{ kind, started: '2026-10-23T10:00:00Z', done: null }])]).idle, true, kind);
  assert.equal(pullOf([card([{ kind: 'claude', started: '2026-10-23T10:00:00Z', done: null }])]).idle, false);
});

// docs/adr/2026-11-04-0057-auto-implement-fills-in-progress-up-to-a-cap.md
test('the pull fills every free implementer slot with the top ready cards; builds and Orchestrator review take a slot, planners and owner waits do not, and a card pulled but not started keeps its slot', () => {
  const run = (kind) => [{ kind, started: '2026-11-04T10:00:00Z', done: null }];
  const card = (key, more = {}) => ({ key, lane: 'todo', kind: 'work', buildable: true, state: 'ready', blockedBy: [], questions: null, grilling: false, working: false, held: false, agents: [], ...more });
  const progress = (key, more) => card(key, { lane: 'progress', buildable: false, state: null, ...more });
  const todo = ['w/T1', 'w/T2', 'w/T3', 'w/T4'].map((k) => card(k));
  const busy = [progress('w/P1', { agents: run('claude') }), progress('w/P2', { waitsOn: 'checking' }), progress('w/P3', { waitsOn: 'owner' }), progress('w/P4', { agents: run('grill') })];
  assert.equal(MAX_IMPLEMENTERS, 10);
  assert.deepEqual(pullOf([...busy, ...todo]).pulls, ['w/T1', 'w/T2', 'w/T3', 'w/T4'], 'the default cap leaves room for every ready card');
  assert.deepEqual(pullOf([...busy, ...todo], { cap: 3 }).pulls, ['w/T1'], 'a build and a review take two of three slots');
  assert.deepEqual(pullOf([...busy, ...todo], { cap: 2 }).pulls, []);
  assert.deepEqual(pullOf([...busy, ...todo], { cap: 1 }).pulls, [], 'a cap already passed pulls nothing');
  assert.equal(pullOf([...busy, ...todo]).idle, false, 'the pull no longer waits for idle, but idle still means nothing building');

  const sent = pullOf([...busy, ...todo], { cap: 4, pulled: ['w/T1'] });
  assert.deepEqual([sent.waiting, sent.pulls], [['w/T1'], ['w/T2']], 'a pulled card not yet started keeps its slot and is not pulled again');
  const working = pullOf([busy[0], card('w/T1', { working: true }), ...todo.slice(1)], { cap: 3, pulled: ['w/T1'] });
  assert.deepEqual([working.waiting, working.pulls], [['w/T1'], ['w/T2']], 'while the session works on the pull the card keeps its slot');
  const started = pullOf([progress('w/T1', { agents: run('claude') }), ...todo.slice(1)], { cap: 2, pulled: ['w/T1'] });
  assert.deepEqual([started.waiting, started.pulls], [[], ['w/T2']], 'once it builds it counts as an implementer instead');
  const asked = pullOf([card('w/T1', { questions: { topic: 'item:w/T1', open: 1 } }), ...todo.slice(1)], { cap: 1, pulled: ['w/T1'] });
  assert.deepEqual([asked.waiting, asked.pulls], [[], ['w/T2']], 'a pulled card that stops being pullable frees its slot');
});

// docs/adr/2026-11-03-1631-the-idle-pull-takes-ready-cards-first.md
test('the pull takes only ready cards in board order, never a card with no state; with none pullable it plans the top unready card while nothing is being planned', () => {
  const card = (key, more = {}) => ({ key, lane: 'todo', kind: 'work', buildable: true, state: null, blockedBy: [], questions: null, grilling: false, working: false, held: false, agents: [], ...more });
  const items = [card('w/A1'), card('w/A2', { state: 'ready' }), card('w/A3'), card('w/A4', { state: 'ready' })];
  assert.deepEqual(pullOf(items).pullable, ['w/A2', 'w/A4']);
  assert.deepEqual(pullOf(items).plannable, ['w/A1', 'w/A3']);

  const asked = { topic: 'item:w/B2', open: 1, answered: 0 };
  const unready = [
    card('w/B0', { state: 'ready', blockedBy: [{ key: 'w/X' }] }),
    card('w/B1', { state: 'grilling', held: true }),
    card('w/B2', { state: 'grilling', questions: asked, buildable: false }),
    card('w/B3', { state: 'prototyping', questions: { topic: 'item:w/B3', open: 0, answered: 1 } }),
    card('w/B4', { state: 'grilling', questions: { topic: 'item:w/B4', open: 0, answered: 0 } }),
    card('w/B5', { blockedBy: [{ key: 'w/X' }] }),
  ];
  assert.deepEqual(pullOf(unready).pullable, []);
  assert.deepEqual(pullOf(unready).plannable, ['w/B4', 'w/B5']);
  const planning = [
    [card('w/C1', { state: 'grilling', grilling: true })],
    [card('w/C1', { state: 'prototyping', prototyping: true })],
    [card('w/C1', { state: 'prototyping', agents: [{ kind: 'prototype', started: '2026-11-03T10:00:00Z', done: null }] })],
  ];
  for (const extra of planning) assert.deepEqual(pullOf([...unready, ...extra]).plannable, [], JSON.stringify(extra));
  assert.deepEqual(pullOf([...unready, card('w/C1', { state: 'grilling', agents: [{ kind: 'grill', started: '2026-11-03T10:00:00Z', done: '2026-11-03T10:30:00Z' }] })]).plannable, ['w/B4', 'w/B5', 'w/C1']);
  // A card left at grilling with no agent, dispatch or Grill tap does not stop planning.
  assert.deepEqual(pullOf([card('w/B4', { state: 'grilling' })]).plannable, ['w/B4']);
});

// docs/adr/2026-11-03-1731-each-board-reviews-incoming-prs-that-touch-its-work.md
test("a held incoming-PR review is in the Auto Review lane, in Needs you and among the owner's pushes", () => {
  const built = buildBoard({
    autoReview: true, waves: [{ slug: 'w', wave: { repo: 'o/r', items: [{ id: 'A1', title: 'One' }] } }],
    incoming: { at: '2026-11-03T11:56:00Z', repo: 'o/r', prs: [{ number: 437, title: 'One endpoint', author: 'quinn', url: 'u', head: 'h', touches: ['w/A1'], asked: false }] },
    reviewRecords: { 437: { number: 437, title: 'One endpoint', author: 'quinn', url: 'u', head: 'h', touches: ['w/A1'], state: 'needs', text: 'Clashes with A1.', at: '2026-11-03T11:58:00Z' } },
    now: Date.parse('2026-11-03T12:00:00Z'),
  });
  assert.deepEqual(built.reviews.cards.map((c) => [c.number, c.state, c.touches.map((t) => t.key)]), [[437, 'needs', ['w/A1']]]);
  assert.deepEqual(needsAnswer(built).items.at(-1), { kind: 'Review', text: 'PR #437 One endpoint · review held for you', url: '#review=437' });
  assert.match(built.needsSummary, /1 review held/);
  assert.deepEqual(ownerActions(built).map((a) => a.tag), ['review-437']);
});

test("a card whose code landed stays in In Review on its owner step, the step as its Next with no bump, until the owner's Done; an open PR, a dropped card and a reopening go as before", () => {
  const step = 'Add the npm trusted publisher and tag a release';
  const close = (ts) => ({ id: 'c' + ts, ts, kind: 'card-done', data: { key: 'w/A1' }, reply: null });
  const merged = { ...greenDraft, isDraft: false, state: 'MERGED', mergedAt: '2026-10-23T11:00:00Z' };
  const card = (item, { pr = merged, events = [], threads = {} } = {}) => board({ pr, events, threads, item: { status_at: '2026-10-23T11:00:00Z', owner_step: step, ...item } }).items.find((i) => i.key === 'w/A1');
  const look = (c) => [c.lane, c.waitsOn, c.next, c.ownerStep, c.awaitsDone, c.bumpable, c.action, c.finishable];
  const waiting = ['review', 'owner', step, step, true, false, null, true];
  assert.deepEqual(look(card({})), waiting);
  assert.deepEqual(look(card({ status: 'done' }, { pr: null })), waiting);
  assert.deepEqual(look(card({ status: 'merged' }, { pr: null })), waiting);
  // The owner's Done closes it at once; a Done older than the landing doesn't.
  assert.deepEqual(look(card({ status: 'done' }, { events: [close('2026-10-23T11:30:00Z')] })).slice(0, 4), ['done', null, null, null]);
  assert.deepEqual(look(card({ status: 'done', status_at: '2026-10-23T11:40:00Z' }, { events: [close('2026-10-23T11:30:00Z')] })), waiting);
  // Before the code lands the card waits on its PR as ever.
  const open = card({}, { pr: { ...greenDraft, isDraft: false, checks: { state: 'pass' } } });
  assert.deepEqual([open.lane, open.next, open.ownerStep], ['review', 'Waiting for PR reviewers', null]);
  assert.deepEqual(look(card({ status: 'dropped' })).slice(0, 4), ['done', null, null, null]);
  // A reopened card Claude has answered waits on the same Done, reading its step.
  const msg = { id: 'm1', ts: '2026-10-23T11:30:00Z', kind: 'item-message', data: { key: 'w/A1', text: 'One more thing' }, reply: null };
  const answered = card({ status: 'done' }, { events: [msg], threads: { 'w/A1': [{ ts: '2026-10-23T11:40:00Z', who: 'claude', text: 'Done that.' }] } });
  assert.deepEqual(look(answered), waiting);
});

// docs/adr/2026-11-04-2308-an-owner-step-can-carry-a-code-check.md
test("a card waiting on its owner step reads what its code check waits for, or that the check can't run", () => {
  const step = 'Publish kickflip to npm';
  const card = (item) => board({ pr: null, item: { status: 'done', status_at: '2026-10-23T11:00:00Z', owner_step: step, ...item } }).items.find((i) => i.key === 'w/A1');
  assert.deepEqual(card({ owner_check: { check: 'npm kickflip 0.3.*', since: '2026-10-23T11:00:00Z' } }).ownerCheck, { words: 'kickflip@0.3.* on npm', broken: null });
  assert.deepEqual(card({ owner_check: { check: 'npm kickflip 0.3.*', since: '2026-10-23T11:00:00Z', broken: 'npm view failed: E404' } }).ownerCheck,
    { words: 'kickflip@0.3.* on npm', broken: 'npm view failed: E404' });
  assert.equal(card({}).ownerCheck, null);
  // Before the code lands, the card waits on its build and reads no check.
  assert.equal(card({ status: 'building', owner_check: { check: 'npm kickflip 0.3.*', since: '2026-10-23T11:00:00Z' } }).ownerCheck, null);
});

// docs/adr/2026-11-04-1913-a-board-can-skip-the-draft.md
test('a draft PR waits in In Review with Action needed "Review draft PR #N" from the moment it opens, whatever its CI, which still shows', () => {
  const card = (checks, item = {}) => board({ pr: { ...greenDraft, checks: { state: checks } }, item }).items.find((i) => i.key === 'w/A1');
  for (const checks of ['pending', 'fail', 'pass', 'none']) {
    const c = card(checks);
    assert.deepEqual([c.lane, c.waitsOn, c.next, c.action, c.resolvedBy, c.pr.checks.state],
      ['review', 'ready', 'Review draft PR #7', { kind: 'ready', url: 'https://github.com/o/r/pull/7', label: 'Review draft PR #7' }, 'github', checks], checks);
  }
  assert.equal(card('pending', { next: 'Wait for the design pass' }).next, 'Review draft PR #7');
  // A builder fixing the draft takes it back to In Progress.
  const fixing = board({ pr: { ...greenDraft, checks: { state: 'fail' } }, agents: { A1: { main: { started: '2026-10-23T10:00:00Z' } } } }).items.find((i) => i.key === 'w/A1');
  assert.deepEqual([fixing.lane, fixing.waitsOn, fixing.action], ['progress', 'builder', null]);
});

test('with Skip the draft on, a draft waits on its CI in In Review with no Action needed, goes red to In Progress, and a ready PR reads as before', () => {
  const card = (pr) => board({ pr, skipDraft: true }).items.find((i) => i.key === 'w/A1');
  for (const checks of ['pending', 'pass', 'none']) {
    const c = card({ ...greenDraft, checks: { state: checks } });
    assert.deepEqual([c.lane, c.waitsOn, c.next, c.action, c.resolvedBy], ['review', 'ci', 'Marked ready for review once CI passes', null, null], checks);
  }
  const red = card({ ...greenDraft, checks: { state: 'fail' } });
  assert.deepEqual([red.lane, red.waitsOn, red.next, red.action], ['progress', null, 'Fix the failing CI', null]);
  const ready = card({ ...greenDraft, isDraft: false });
  assert.deepEqual([ready.lane, ready.waitsOn, ready.next, ready.action], ['review', 'reviewers', 'Waiting for PR reviewers', null]);
  assert.deepEqual(board({ skipDraft: true }).needs, []);
});

// docs/adr/2026-11-04-0257-an-idle-board-pushes-once-when-it-has-gone-idle.md
test('a board is strictly idle only with nothing building, grilling, prototyping, landing, pulled or worked on', () => {
  const at = '2026-11-04T10:00:00Z';
  const built = (item = {}, agents = {}, events = []) => buildBoard({ now: Date.parse(at), owner: {}, events,
    waves: [{ slug: 'w', agents, wave: { internal: true, items: [{ id: 'A1', title: 'One', ...item }, { id: 'A2', title: 'Two', status: 'done', status_at: at }] } }] });
  assert.equal(strictlyIdle(built()), true, 'a ready card with nothing running is idle');
  assert.equal(strictlyIdle(built({}, { A1: { main: { kind: 'claude', started: at } } })), false, 'a builder runs');
  assert.equal(strictlyIdle(built({}, { A1: { main: { kind: 'claude', started: at, done: at } } })), true, 'a finished builder');
  assert.equal(strictlyIdle(built({}, { A1: { main: { kind: 'grill', started: at } } })), false, 'a grill runs');
  assert.equal(strictlyIdle(built({}, {}, [{ id: 'e1', ts: at, kind: 'prototype-request', data: { key: 'w/A1' }, reply: null }])), false, 'a prototype is under way');
  assert.equal(strictlyIdle(built({ status: 'checking', status_at: at })), false, 'a card waits to land');
  assert.equal(strictlyIdle(built({ state: 'ready' }), { pulled: ['w/A1'] }), false, 'a pulled card waits to start');
  assert.equal(strictlyIdle(built({ state: 'ready' })), true, 'a ready card nobody pulled');
  assert.equal(strictlyIdle({ ...built(), working: 1 }), false, 'a session turn runs');
});

test('the idle notification pushes once 15 minutes into an idle stretch, and again only after the board was busy', () => {
  let now = Date.parse('2026-11-04T10:00:00Z');
  const tick = (minutes) => { now += minutes * 60000; };
  let state = {};
  const step = (idle) => {
    const r = idleStep(state, { idle, now: new Date(now) });
    state = r.state;
    return r.push;
  };
  assert.equal(step(true), false);
  const turnedOn = state.last;
  tick(14);
  assert.equal(step(true), false, '14 minutes is not yet idle');
  tick(1);
  assert.equal(step(true), true, '15 minutes idle pushes');
  assert.equal(state.last, new Date(now).toISOString());
  assert.notEqual(state.last, turnedOn);
  tick(30);
  assert.equal(step(true), false, 'one push per idle stretch');
  tick(1);
  assert.equal(step(false), false);
  assert.deepEqual(state, { last: new Date(now - 31 * 60000).toISOString() }, 'busy ends the stretch and keeps the last push');
  tick(1);
  assert.equal(step(true), false);
  tick(10);
  assert.equal(step(false), false, 'busy again inside 15 minutes');
  tick(1);
  assert.equal(step(true), false);
  tick(15);
  assert.equal(step(true), true, 'a new stretch pushes again');
});

test("the idle push sums up the cards landed and waves finished since the last idle push", () => {
  const items = [
    { id: 'A1', title: 'Old', status: 'done', status_at: '2026-11-04T09:00:00Z' },
    { id: 'A2', title: 'Two', status: 'done', status_at: '2026-11-04T10:10:00Z' },
    { id: 'A3', title: 'Three', status: 'merged', status_at: '2026-11-04T10:20:00Z' },
    { id: 'A4', title: 'Dropped', status: 'dropped', status_at: '2026-11-04T10:20:00Z' },
    { id: 'B1', title: 'Open' },
  ];
  const lineups = [{ slug: 'mon', title: 'Monitor', items: ['A1', 'A2', 'A3'] }, { slug: 'open', title: 'Still open', items: ['A4', 'B1'] }];
  const built = buildBoard({ now: Date.parse('2026-11-04T11:00:00Z'), events: [], owner: {}, waves: [{ slug: 'w', wave: { internal: true, items, lineups } }] });
  const ref = (id) => built.items.find((i) => i.id === id).ref;
  assert.equal(idleSummary(built.items, '2026-11-04T10:00:00Z'), `2 cards landed: ${ref('A3')}, ${ref('A2')} · Monitor finished`);
  assert.equal(idleSummary(built.items, '2026-11-04T10:15:00Z'), `1 card landed: ${ref('A3')} · Monitor finished`);
  assert.equal(idleSummary(built.items, '2026-11-04T10:30:00Z'), 'Nothing closed since the last idle notification.');
});

// docs/adr/2026-11-04-0349-the-board-is-built-once-per-data-version.md: the board groups events by card once per build,
// and lines at the same moment keep the event log's order.
test("a card's thread keeps the event log's order across its own key, its ask's and its questions, and shows its ask once", () => {
  const ts = '2026-10-23T10:00:00Z';
  const ask = { id: 'k0', ts: '2026-10-23T09:00:00Z', kind: 'ask', data: { text: 'Make one' }, reply: null };
  const msg = (id, key) => ({ id, ts, kind: 'item-message', data: { key, text: id }, reply: null });
  const answer = (id, q) => ({ id, ts, kind: 'owner-answer', data: { id: q, choice: 'A' }, reply: null });
  const events = [ask, msg('m1', 'w/A1'), answer('a2', 'q2'), msg('m2', 'ask:k0'), answer('a1', 'q1'), msg('m3', 'w/A1')];
  const owner = { items: [{ id: 'q1', topic: 'item:w/A1', question: 'One?' }, { id: 'q2', topic: 'item:w/A1', question: 'Two?' }] };
  assert.deepEqual(threadOf('w/A1', { events, owner, fromAsk: 'k0' }).map((m) => m.eventId), ['k0', 'm1', 'm2', 'm3', 'a2', 'a1']);
  assert.deepEqual(threadOf('w/A1', { events, owner, fromAsk: 'k0', moved: ['k0'] }).map((m) => m.eventId), ['k0', 'm1', 'm2', 'm3', 'a2', 'a1']);
});

// docs/adr/2026-11-04-0349-the-board-is-built-once-per-data-version.md: the server shares one build of its data and adds
// the hub's side, the session's pending prompts and whether it listens, to each board it serves.
test("the hub's side added to a shared build gives the board built with it", () => {
  const perm = { id: 'p1', tool: 'Bash', action: 'run npm test', detail: 'npm test', rule: 'Bash(npm test)', questions: null, cwd: '~/r', at: '2026-10-30T10:00:00Z' };
  const snapshot = { now: Date.parse('2026-10-30T11:00:00Z'), fromWaves: false, waves: [], events: [], checked: { at: '2026-10-30T10:59:00Z', every: 30 } };
  assert.deepEqual(withHub(buildBoard(snapshot), { listen: 'asleep', prompts: [perm] }), buildBoard({ ...snapshot, listen: 'asleep', prompts: [perm] }));
  assert.deepEqual(withHub(buildBoard(snapshot), {}), buildBoard(snapshot));
});

test('a thread line stores its log, and an old launch line naming a log under the logs folder gets the same log field', () => {
  const at = (text, log) => threadOf('w/A1', { lines: [{ ts: '2026-11-04T19:10:00Z', text, ...(log ? { log } : {}) }] })[0];
  const kept = at('Builder launched headless on Claude Sonnet in /wt/GH-222.', 'builder-GH-222-x.log');
  assert.deepEqual([kept.text, kept.log], ['Builder launched headless on Claude Sonnet in /wt/GH-222.', 'builder-GH-222-x.log']);
  const old = at('Lander launched headless on Claude Sonnet in /wt/GH-222; its log is /Users/lovek4d/.claude/kickflip/logs/lander-GH-222-2026-11-04T19-10-31-120Z.log.');
  assert.deepEqual([old.text, old.log], ['Lander launched headless on Claude Sonnet in /wt/GH-222.', 'lander-GH-222-2026-11-04T19-10-31-120Z.log']);
  const elsewhere = at('Builder launched headless on Claude Sonnet in /wt/A; its log is /tmp/x.log.');
  assert.equal(elsewhere.log, undefined);
  assert.match(elsewhere.text, /its log is \/tmp/);
});

test("a re-ask of a resolved question is pending while its reask-request is newer than the question's resolved_at, and reads as a muted 're-ask requested' entry in the card's thread", () => {
  const q = { id: 'q1', topic: 'item:w/A1', question: 'Which?', options: [{ id: 'A', label: 'Yes' }], resolved: 'Picked A', resolved_at: '2026-10-23T11:00:00Z' };
  const reask = (ts) => ({ id: `r-${ts}`, ts, kind: 'reask-request', data: { key: 'w/A1', question: 'q1' }, reply: null });
  assert.equal(ownerQuestion(q, [], [], []).reask, null);
  assert.equal(ownerQuestion(q, [], [], [reask('2026-10-23T10:00:00Z')]).reask, null, 'one the question was resolved after is done');
  assert.deepEqual(ownerQuestion(q, [], [], [reask('2026-10-23T10:00:00Z'), reask('2026-10-23T12:00:00Z')]).reask, { id: 'r-2026-10-23T12:00:00Z', ts: '2026-10-23T12:00:00Z' });
  const msgs = threadOf('w/A1', { events: [reask('2026-10-23T12:00:00Z')], owner: { items: [q] } });
  assert.deepEqual(msgs.map((m) => [m.kind, m.text, Boolean(m.request)]), [['reask-request', 're-ask requested', true]]);
});

// docs/adr/2026-11-04-2130-a-prototype-request-waits-for-its-prototype.md
test("a prototype request waits on its prototype: the card's own while it is under way and each question reading requested, none while a prototype agent runs or once the card is Done", () => {
  const plain = { id: 'q0', topic: 'item:w/A1', question: 'Where?', options: [{ id: 'A', label: 'Top' }] };
  const card = { id: 'p1', ts: '2026-10-23T10:00:00Z', kind: 'prototype-request', data: { key: 'w/A1' }, reply: null };
  const asked = { id: 'p2', ts: '2026-10-23T10:05:00Z', kind: 'prototype-request', data: { key: 'w/A1', question: 'q0', note: '' }, reply: null };
  const waits = (opts) => { const b = board({ owner: { items: [plain] }, ...opts }); return prototypeWaits(b, opts.events); };
  assert.deepEqual(waits({ events: [card, asked] }), [
    { key: 'w/A1', request: 'p1', since: '2026-10-23T10:00:00Z' },
    { key: 'w/A1', request: 'p2', question: 'q0', since: '2026-10-23T10:05:00Z' },
  ]);
  assert.deepEqual(waits({ events: [] }), []);
  assert.deepEqual(waits({ events: [card, asked], agents: { A1: { p: { kind: 'prototype', started: '2026-10-23T10:10:00Z' } } } }), []);
  assert.deepEqual(waits({ events: [card, asked], item: { status: 'done' }, pr: { ...greenDraft, state: 'MERGED' } }), []);
  // The round naming the question resolves it, and a question posted after the card's request answers that.
  const round = { id: 'q1', topic: 'item:w/A1', question: 'Which?', url: 'prototype-x.html?q=q1', options: [{ id: 'A', label: 'Top' }], round_of: 'q0', asked_at: '2026-10-23T11:00:00Z' };
  assert.deepEqual(prototypeWaits(board({ owner: { items: [{ ...plain, resolved: 'Followed by prototype round 1', resolved_at: '2026-10-23T11:00:00Z' }, round] }, events: [card, asked] }), [card, asked]), []);
});
