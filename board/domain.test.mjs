import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBoard, threadOf, needsAnswer } from './domain.mjs';

const greenDraft = { state: 'OPEN', isDraft: true, checks: { state: 'pass' }, reviews: {} };
const runningBuilders = (...ids) => Object.fromEntries(ids.map((id) => [id, { main: { started: '2026-10-23T10:00:00Z' } }]));

function board({ agents = {}, pr = greenDraft, owner = {}, events = [], topicItems = {}, now, held = false, threads = {}, item = {}, fromWaves = true } = {}) {
  return buildBoard({
    now,
    topicItems,
    threads,
    fromWaves,
    watched: ['w'],
    waves: [{
      slug: 'w',
      agents,
      wave: {
        repo: 'o/r',
        reviewers: [{ name: 'Ann', github: 'ann' }],
        items: [{ id: 'A1', title: 'One', pr: 7, held, ...item }],
        followups: [{ id: 'ENG-1', title: 'Later', filed: '2026-10-22T00:00:00Z' }],
      },
    }],
    prs: { 'o/r#7': pr },
    owner,
    events,
  });
}

test('manifest github selects PR state and card links ahead of wave repo with a wave fallback', () => {
  const waves = [{ slug: 'w', wave: { repo: 'old/project', items: [{ id: 'A1', pr: 7 }], followups: [{ id: 'F1' }] } }];
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
  assert.deepEqual([ready.lane, ready.waitsOn, ready.next, ready.action], ['review', 'ready', 'Tap Ready on GitHub', { kind: 'ready', url: 'https://github.com/o/r/pull/7', label: 'Tap Ready on GitHub' }]);
  assert.deepEqual([ready.actionButton, ready.resolvedBy], ['grill', 'github']);
  const asked = board({ owner: { items: [{ id: 'q1', topic: 'item:w/A1', question: 'Ship it?' }] } }).items.find((i) => i.key === 'w/A1');
  assert.deepEqual([asked.lane, asked.waitsOn, asked.action.kind, asked.actionButton, asked.resolvedBy], ['review', 'ready', 'questions', 'openQuestions', 'openQuestions']);
  const record = { label: 'Opus builder', started: '2026-10-23T10:00:00Z', progress: 'Record line', progress_at: '2026-10-23T10:06:00Z' };
  const earlier = { ts: '2026-10-23T09:00:00Z', who: 'claude', kind: 'status', text: 'Previous run' };
  const fresh = board({ now: Date.parse(record.started), agents: { A1: { main: record } }, threads: { 'w/A1': [earlier] } }).items.find((i) => i.key === 'w/A1');
  assert.deepEqual(fresh.builder, { progress: null, at: record.started, kind: null, stalled: false, silentSince: record.started });
  const lines = [earlier, { ts: '2026-10-23T10:05:00Z', who: 'claude', kind: 'status', text: 'Running tests' }, { ts: '2026-10-23T10:07:00Z', who: 'claude', text: 'Halfway.' }];
  const busy = board({ now: Date.parse('2026-10-23T10:07:00Z'), agents: { A1: { main: record } }, threads: { 'w/A1': lines } });
  const item = busy.items.find((i) => i.key === 'w/A1');
  assert.deepEqual([item.lane, item.waitsOn, item.action], ['progress', 'builder', null]);
  assert.deepEqual(item.builder, { progress: 'Running tests', at: '2026-10-23T10:05:00Z', kind: null, stalled: false, silentSince: '2026-10-23T10:05:00Z' });
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

test('an unstarted card waiting on its questions stays in Todo with its action, a started one keeps its lane with it, and either shows Open questions', () => {
  const q = { id: 'q1', topic: 'item:w/A1', question: 'Which take?', options: [{ id: 'A', label: 'One' }], url: 'prototype-x.html?q=q1' };
  const card = (opts) => board({ pr: null, ...opts }).items.find((i) => i.key === 'w/A1');
  const waiting = card({ owner: { items: [q] } });
  assert.deepEqual([waiting.lane, waiting.waitsOn, waiting.next, waiting.bumpable, waiting.actionButton], ['todo', 'owner', 'Prototypes ready: pick a take', false, 'openQuestions']);
  assert.deepEqual([waiting.action, waiting.resolvedBy], [{ kind: 'pick', url: 'questions.html#q1', label: 'Prototypes ready: pick a take' }, 'openQuestions']);
  const picked = { id: 'e1', ts: '2026-10-23T10:00:00Z', kind: 'owner-answer', data: { id: 'q1', choice: 'A' }, reply: null };
  const answered = card({ owner: { items: [q] }, events: [picked] });
  assert.deepEqual([answered.lane, answered.action, answered.actionButton], ['progress', null, 'grill']);
  const grilled = card({ owner: { items: [{ ...q, url: 'https://example.com/doc' }] } });
  assert.deepEqual([grilled.lane, grilled.waitsOn, grilled.action, grilled.actionButton], ['todo', 'owner', { kind: 'questions', url: 'questions.html#q1', label: 'Answer 1 question' }, 'openQuestions']);
  const more = { ...q, id: 'q2', url: null };
  const regrilled = card({ owner: { items: [q, more] }, events: [picked] });
  assert.deepEqual([regrilled.lane, regrilled.waitsOn, regrilled.action?.kind, regrilled.actionButton], ['progress', 'owner', 'questions', 'openQuestions']);
  const building = card({ owner: { items: [q] }, agents: { A1: { main: { label: 'Opus builder', started: '2026-10-23T10:00:00Z' } } } });
  assert.deepEqual([building.lane, building.waitsOn, building.action?.kind, building.actionButton], ['progress', 'builder', 'pick', 'openQuestions']);
  const built = card({ owner: { items: [q] }, agents: { A1: { main: { label: 'Opus builder', started: '2026-10-23T10:00:00Z', done: '2026-10-23T10:30:00Z' } } } });
  assert.deepEqual([built.lane, built.action?.kind], ['progress', 'pick']);
  const held = card({ owner: { items: [q] }, held: true });
  assert.deepEqual([held.lane, held.action, held.actionButton, held.resolvedBy], ['todo', null, 'openQuestions', null]);
  assert.equal(card({ held: true }).actionButton, 'grill');
});

test('only Todo cards with a known creation time show their age from two full days, including held cards', () => {
  const now = Date.parse('2026-10-30T12:00:00Z');
  const day = 86400000;
  const created = (days) => new Date(now - days * day).toISOString();
  const card = (opts) => board({ now, pr: null, ...opts }).items.find((i) => i.key === 'w/A1');
  for (const [days, label] of [[1, null], [2 - 1 / day, null], [2, '2 days ago'], [3, '3 days ago'], [3.9, '3 days ago']]) {
    const it = card({ item: { created: created(days) } });
    assert.deepEqual([it.lane, it.todoAge], ['todo', label]);
  }
  for (const item of [{ held: true }, { status: 'held' }]) {
    const it = card({ item: { created: created(3), ...item } });
    assert.deepEqual([it.lane, it.held, it.todoAge], ['todo', true, '3 days ago']);
  }
  for (const [status, lane] of [['done', 'done'], ['building', 'progress']]) {
    const it = card({ item: { created: created(3), status }, agents: runningBuilders('A1') });
    assert.deepEqual([it.lane, it.todoAge], [lane, null]);
  }
  const reviewed = card({ item: { created: created(3) }, pr: greenDraft });
  assert.deepEqual([reviewed.lane, reviewed.todoAge], ['review', null]);
  const started = card({ item: { created: created(3) }, agents: { A1: { main: { started: created(2), done: created(1) } } } });
  assert.deepEqual([started.lane, started.todoAge], ['progress', null]);
  for (const value of [undefined, null, '', 'unknown', created(-1)]) {
    assert.equal(card({ item: { created: value }, threads: { 'w/A1': [{ ts: created(10), text: 'Waiting' }] } }).todoAge, null);
  }
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

test('a card with a working builder is In Progress whatever its status says', () => {
  const started = { label: 'Opus builder', started: '2026-10-23T10:00:00Z' };
  for (const status of [undefined, 'building', 'fixing']) {
    const card = (record) => board({ pr: null, item: { status }, agents: record ? { A1: { main: record } } : {} }).items.find((i) => i.key === 'w/A1');
    assert.deepEqual([card(null).lane, card(started).lane, card({ ...started, done: '2026-10-23T10:30:00Z' }).lane], ['todo', 'progress', 'progress']);
    assert.equal(card(null).waitsOn, null);
  }
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
  assert.equal(other.builder.kind, 'opus');
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
  assert.deepEqual(item.agents.map((a) => [a.name, a.kind, a.label]), [['main', 'opus', 'Opus builder'], ['bench', 'codex', null], ['lint', 'sonnet', null]]);
  assert.deepEqual([item.builder.progress, item.builder.at, item.eta], ['Codex: Running benchmarks', '2026-10-23T10:09:00Z', '2026-10-23T16:30:00Z']);
  const changing = board({ pr: { ...greenDraft, isDraft: false, reviewDecision: 'CHANGES_REQUESTED' }, agents: {} }).items.find((i) => i.key === 'w/A1');
  assert.deepEqual([changing.agents, changing.eta], [[], null]);
});

test('lanes follow the PR, with CI that is running on a draft or red on any PR in In Progress, and an open follow-up sits in Todo', () => {
  const lanes = (pr) => Object.fromEntries(board({ pr }).items.map((i) => [i.key, i.lane]));
  assert.deepEqual(lanes({ ...greenDraft, checks: { state: 'pending' } }), { 'w/A1': 'progress', 'w/ENG-1': 'todo' });
  assert.equal(lanes({ ...greenDraft, checks: { state: 'fail' } })['w/A1'], 'progress');
  assert.equal(lanes({ ...greenDraft, isDraft: false })['w/A1'], 'review');
  assert.equal(lanes({ ...greenDraft, isDraft: false, checks: { state: 'pending' } })['w/A1'], 'review');
  const red = board({ pr: { ...greenDraft, isDraft: false, checks: { state: 'fail' } } }).items.find((i) => i.key === 'w/A1');
  assert.deepEqual([red.lane, red.waitsOn, red.next, red.action], ['progress', null, 'Fix the failing CI', null]);
  assert.equal(lanes({ ...greenDraft, state: 'MERGED' })['w/A1'], 'done');
  const done = buildBoard({ fromWaves: false, waves: [{ slug: 's', wave: { items: [{ id: 'S1', title: 'One', status: 'done', next: 'Builds after S0' }] } }] }).items[0];
  assert.deepEqual([done.lane, done.next, done.actionButton], ['done', null, null]);
  assert.equal(board().items.find((i) => i.key === 'w/ENG-1').actionButton, 'grill');
});

test('a review waits with its age, and parks in Stale after a week', () => {
  const ready = { ...greenDraft, isDraft: false };
  const sent = { 'w/A1': { review_link_ts: { Ann: '1792800000.000100' } } };
  const sentAt = '2026-10-24T00:00:00.000Z';
  const at = (days) => Date.parse(sentAt) + days * 86400000;
  const item = (days) => board({ pr: ready, topicItems: sent, now: at(days) }).items.find((i) => i.key === 'w/A1');
  assert.deepEqual(item(2).review, { Ann: { state: 'sent', since: sentAt } });
  assert.equal(item(2).lane, 'review');
  assert.equal(item(8).lane, 'stale');
  assert.equal(item(8).waitsOn, 'reviewers');
  assert.equal(item(8).next, 'Waiting for PR reviewers');
  const approved = board({ pr: { ...ready, reviews: { ann: 'APPROVED' }, reviewDecision: 'APPROVED' }, topicItems: sent, now: at(2) }).items.find((i) => i.key === 'w/A1');
  assert.deepEqual(approved.review, { Ann: { state: 'approved', since: null } });
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
    waves: [{ slug: 'f', wave: { repo: 'o/r', items: [{ id: 'B1', title: 'Two', pr: 7, status: 'fixing', next: 'Reply to Codex', review_sent: { Ann: '1792800000.000100' } }] } }],
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
    fromWaves: true, watched: ['site'],
    waves: [
      { slug: 'site', agents: runningBuilders('S2'), wave: { internal: true, items: [{ id: 'S1', title: 'Shared script', status: 'done' }, { id: 'S2', title: 'Uploads', status: 'building' }] } },
      { slug: 'w', wave: { items: [{ id: 'A1', title: 'One' }] } },
    ],
  });
  const byKey = Object.fromEntries(b.items.map((i) => [i.key, [i.internal, i.lane]]));
  assert.deepEqual(byKey, { 'site/S1': [true, 'done'], 'site/S2': [true, 'progress'], 'w/A1': [false, 'todo'] });
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
  assert.deepEqual(lines(board({ owner, events: answered, held: true })), [{ kind: 'Question', text: 'Site · 1 question', url: 'questions.html#q1' }]);
  assert.deepEqual(lines(board()), [{ kind: 'Tap Ready', text: 'A1: One · Ready on GitHub', url: '#item=w%2FA1' }]);
  assert.deepEqual(lines(board({ pr: { ...greenDraft, isDraft: false } })), []);
  assert.equal(board({ pr: { ...greenDraft, isDraft: false } }).needsSummary, '');
  const settling = buildBoard({ fromWaves: false, waves: [], events: [askAt('a1', '2026-10-23T09:00:00Z', { reply: { html: 'Built.' } })], askProgress: { a1: { state: 'progress', at: '2026-10-23T09:10:00Z', next: 'Pick a take' } } });
  assert.deepEqual(lines(settling), [{ kind: 'Action needed', text: 'Task: a1 first line · Pick a take', url: '#item=ask%3Aa1' }]);
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
    return [i.lane, i.ref, i.isNew, i.bumpable, i.ask.canEdit, i.finishable, i.action?.kind ?? null, i.actionButton];
  };
  assert.deepEqual(card(), ['todo', 'Task', false, false, false, true, 'questions', 'openQuestions']);
  assert.deepEqual(buildBoard({ fromWaves: false, waves: [], events: [ask], owner }).needs.map((n) => [n.kind, n.text]), [['Question', 'Task: a1 first line · 1 question']]);
  assert.deepEqual(card([answer]), ['progress', 'Task', false, false, false, true, null, null]);
  assert.deepEqual(card([{ ...answer, reply: { html: 'Home it is.' } }]), ['done', 'Task', false, false, false, false, null, null]);
  assert.deepEqual(card([{ id: 'd1', ts: '2026-10-23T09:20:00Z', kind: 'ask-done', data: { id: 'a1' }, reply: null }]), ['done', 'Task', false, false, false, false, null, null]);
  assert.deepEqual(card([], { askProgress: { a1: { state: 'done', at: '2026-10-23T09:20:00Z' } } }), ['done', 'Task', false, false, false, false, null, null]);
  assert.deepEqual(card([], { askProgress: { a1: { state: 'progress', at: '2026-10-23T09:20:00Z', next: 'Pick one' } } }), ['review', 'Task', false, false, false, true, 'questions', 'openQuestions']);
});

test('a new task is a New card in Todo with no action while it waits or works, and a Done item with a Task ref once Claude replies or writes in its thread', () => {
  const asks = [askAt('a1', '2026-10-23T09:00:00Z'), askAt('a2', '2026-10-23T10:00:00Z'), askAt('a3', '2026-10-23T08:00:00Z', { reply: { html: 'Yes.' } }), askAt('a4', '2026-10-23T07:00:00Z')];
  const threads = { 'ask:a4': [{ ts: '2026-10-23T07:30:00Z', who: 'claude', text: 'Answered here.' }] };
  const b = buildBoard({ fromWaves: false, now: Date.parse('2026-10-23T12:00:00Z'), waves: [{ slug: 'w', wave: { items: [{ id: 'A1', title: 'One', status: 'building' }] } }], events: asks, threads, working: { a2: '2026-10-23T10:01:00Z' } });
  const cards = b.items.filter((i) => i.kind === 'ask').map((i) => [i.key, i.lane, i.ref, i.isNew, i.title, i.ask.state, i.working, i.fold, i.action]);
  assert.deepEqual(cards, [
    ['ask:a1', 'todo', 'New', true, 'a1 first line', 'waiting', false, null, null],
    ['ask:a2', 'todo', 'New', true, 'a2 first line', 'working', true, null, null],
    ['ask:a3', 'done', 'Task', false, 'a3 first line', 'answered', false, 'asks', null],
    ['ask:a4', 'done', 'Task', false, 'a4 first line', 'answered', false, 'asks', null],
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
  assert.deepEqual([moved.items[0].lane, moved.items[0].isNew, moved.answers], ['done', false, []]);
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
  assert.deepEqual([item.lane, item.working, item.threadCount, b.working], ['done', true, 2, 1]);
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
  assert.deepEqual(at([], {}), ['done', 'asks', null, false, null, null, null]);
  assert.deepEqual(at([], progress), ['review', null, 'Pick a take', true, action, 'markDone', 'markDone']);
  assert.deepEqual(at([done('2026-10-23T09:30:00Z')], progress), ['done', 'asks', null, false, null, null, null]);
  assert.deepEqual(at([done('2026-10-23T09:10:00Z')], progress), ['review', null, 'Pick a take', true, action, 'markDone', 'markDone']);
  const reply = { id: 'm1', ts: '2026-10-23T09:30:00Z', kind: 'item-message', data: { key: 'ask:a1', text: 'Take B' }, reply: null };
  assert.deepEqual(at([reply], progress), ['progress', null, 'Pick a take', true, null, null, null]);
  assert.deepEqual(at([], { a1: { state: 'done', at: '2026-10-23T09:40:00Z' } }), ['done', 'asks', null, false, null, null, null]);
  const waiting = buildBoard({ fromWaves: false, waves: [], events: [askAt('a2', '2026-10-23T09:00:00Z')], askProgress: { a2: { state: 'done', at: '2026-10-23T09:40:00Z' } } }).items[0];
  assert.deepEqual([waiting.lane, waiting.bumpable], ['done', false]);
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
  assert.equal(card({ item: { held: true } }).items[0].action, null);
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

test("every card not in Done can be closed, and a card-done reads closing until the card's status changes after it", () => {
  const close = (key, ts) => ({ id: 'c' + ts, ts, kind: 'card-done', data: { key }, reply: null });
  const items = [
    { id: 'A1', title: 'One', status: 'building' },
    { id: 'A2', title: 'Two', status: 'building', status_at: '2026-10-23T11:20:00Z' },
    { id: 'A3', title: 'Three' },
    { id: 'A4', title: 'Four', status: 'done', status_at: '2026-10-23T11:20:00Z' },
  ];
  const followups = [{ id: 'ENG-1', title: 'f', filed: '2026-10-22' }, { id: 'ENG-2', title: 'g', filed: '2026-10-22' }, { id: 'ENG-3', title: 'h', filed: '2026-10-22', done: true }];
  const events = [close('w/A1', '2026-10-23T11:00:00Z'), close('w/A2', '2026-10-23T11:10:00Z'), close('w/A4', '2026-10-23T11:10:00Z'), close('w/ENG-2', '2026-10-23T11:10:00Z')];
  const b = buildBoard({ fromWaves: false, now: Date.parse('2026-10-23T12:00:00Z'), waves: [{ slug: 'w', agents: runningBuilders('A1', 'A2'), wave: { items, followups } }], events });
  const cards = Object.fromEntries(b.items.map((i) => [i.id, [i.lane, i.finishable, i.closing]]));
  assert.deepEqual(cards, {
    A1: ['progress', true, true], A2: ['progress', true, false], A3: ['todo', true, false], A4: ['done', false, false],
    'ENG-1': ['todo', true, false], 'ENG-2': ['todo', true, true], 'ENG-3': ['done', false, false],
  });
});

test('a withdrawn ask leaves the board', () => {
  const b = askBoard([askAt('a1', '2026-10-23T09:00:00Z'), { id: 'w1', ts: '2026-10-23T09:10:00Z', kind: 'ask-withdrawn', data: { id: 'a1' }, reply: null }]);
  assert.deepEqual(b.items.map((i) => i.key), ['w/A1']);
});

test('a bumped card that has not started, or is running, tops its lane, the latest bump first, an open follow-up bumps like a Todo card, and a held card, a draft waiting on Ready or a done follow-up takes no bump', () => {
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
  assert.deepEqual(cards([]).map(([key, , bumpable]) => [key, bumpable]), [['w/A6', true], ['w/A5', true], ['w/A4', false], ['w/A3', true], ['w/A2', true], ['w/A1', true]]);
  const at1 = '2026-10-23T11:10:00Z';
  const at2 = '2026-10-23T11:20:00Z';
  assert.deepEqual(cards([bump('w/A1', at1), bump('w/A2', at2), bump('w/A5', at2), bump('w/A4', at2)]), [
    ['w/A5', 'progress', true, at2],
    ['w/A6', 'progress', true, null],
    ['w/A2', 'todo', true, at2],
    ['w/A1', 'todo', true, at1],
    ['w/A4', 'todo', false, null],
    ['w/A3', 'todo', true, null],
  ]);
  assert.deepEqual(cards([bump('w/A1', at1), bump('w/A2', at2), bump('w/A1', '2026-10-23T11:30:00Z')]).slice(2, 4).map(([key]) => key), ['w/A1', 'w/A2']);
  const draft = buildBoard({ fromWaves: false, prs: { 'o/r#7': greenDraft }, waves: [{ slug: 'w', wave: { repo: 'o/r', items: [{ id: 'D1', title: 'Draft', pr: 7 }] } }], events: [bump('w/D1', at1)] }).items[0];
  assert.deepEqual([draft.lane, draft.waitsOn, draft.bumpable, draft.bumpedAt], ['review', 'ready', false, null]);
  const followups = [{ id: 'ENG-1', title: 'f', filed: at1 }, { id: 'ENG-2', title: 'g', filed: at1 }, { id: 'ENG-3', title: 'h', filed: at1, done: true }];
  const fb = buildBoard({ fromWaves: false, waves: [{ slug: 'w', wave: { items: [{ id: 'A1', title: 'One' }], followups } }], events: [bump('w/ENG-2', at2), bump('w/ENG-3', at2)] });
  assert.deepEqual(fb.items.map((i) => [i.key, i.lane, i.bumpable, i.bumpedAt]), [
    ['w/ENG-2', 'todo', true, at2], ['w/A1', 'todo', true, null], ['w/ENG-1', 'todo', true, null], ['w/ENG-3', 'done', false, null],
  ]);
});

test('a card-hold waits until held_at is newer, and only cards that are not Done can be held', () => {
  const hold = (key, ts, value) => ({ id: 'h' + ts, ts, kind: 'card-hold', data: { key, hold: value }, reply: null });
  const items = [
    { id: 'A1', title: 'One', status: 'planned' },
    { id: 'A2', title: 'Two', status: 'planned', held: true, held_at: '2026-10-23T11:05:00Z' },
    { id: 'A3', title: 'Three', status: 'building', held: true, held_at: '2026-10-23T11:20:00Z' },
    { id: 'A4', title: 'Four', status: 'planned', held_at: '2026-10-23T11:20:00Z' },
    { id: 'A5', title: 'Five', status: 'done' },
  ];
  const events = [hold('w/A1', '2026-10-23T11:00:00Z', true), hold('w/A2', '2026-10-23T11:10:00Z', false), hold('w/A3', '2026-10-23T11:10:00Z', false), hold('w/A4', '2026-10-23T11:10:00Z', true)];
  const cards = Object.fromEntries(askBoard(events, { items }).items.filter((i) => i.kind === 'work').map((i) => [i.id, [i.held, i.holdable, i.holdPending]]));
  assert.deepEqual(cards, { A1: [false, true, true], A2: [true, true, false], A3: [true, true, null], A4: [false, true, null], A5: [false, false, null] });
});

test("every lane lists its newest card first, and a card with no activity after them, the last added on top, with Todo's follow-ups after its work", () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  const at = (d) => `2026-11-${String(d).padStart(2, '0')}T10:00:00Z`;
  const open = (d) => ({ state: 'OPEN', isDraft: false, checks: { state: 'pass' }, reviews: {}, updatedAt: at(d) });
  const merged = (d) => ({ state: 'MERGED', mergedAt: at(d), updatedAt: at(d) });
  const prs = { 'o/r#1': open(3), 'o/r#2': open(5), 'o/r#3': open(4), 'o/r#4': open(6), 'o/r#5': merged(2), 'o/r#6': merged(7) };
  const sent = { Ann: String(Date.parse(at(1)) / 1000) };
  const items = [
    { id: 'R1', title: 'r', pr: 1 }, { id: 'R2', title: 'r', pr: 2 },
    { id: 'S1', title: 's', pr: 3, review_sent: sent }, { id: 'S2', title: 's', pr: 4, review_sent: sent },
    { id: 'P1', title: 'p', status: 'building' }, { id: 'P2', title: 'p', status: 'building' },
    { id: 'T1', title: 't' }, { id: 'T2', title: 't', status: 'planned' },
    { id: 'D1', title: 'd', pr: 5 }, { id: 'D2', title: 'd', pr: 6 }, { id: 'D3', title: 'd', status: 'done', merged_at: at(8) },
  ];
  const followups = [{ id: 'ENG-1', title: 'f', filed: at(2) }, { id: 'ENG-2', title: 'f', filed: at(3) }];
  const agents = { P1: { main: { started: at(8), progress_at: at(9) } }, P2: { main: { started: at(1) } } };
  const events = [
    { id: 'a1', ts: at(7), kind: 'ask', data: { text: 'one' }, reply: null },
    { id: 'a2', ts: at(10), kind: 'ask', data: { text: 'two' }, reply: null },
    { id: 'a3', ts: at(9), kind: 'ask', data: { text: 'three' }, reply: { html: 'ok' } },
    { id: 'a4', ts: at(10), kind: 'ask', data: { text: 'four' }, reply: { html: 'ok' } },
  ];
  const b = buildBoard({ now, fromWaves: false, prs, events, waves: [{ slug: 'w', agents, wave: { repo: 'o/r', reviewers: [{ name: 'Ann', github: 'ann' }], items, followups } }] });
  const lanes = {};
  for (const i of b.items) (lanes[i.lane] ||= []).push(i.key.replace(/^w\//, ''));
  assert.deepEqual(lanes, {
    review: ['R2', 'R1'],
    stale: ['S2', 'S1'],
    progress: ['P1', 'P2'],
    todo: ['ask:a1', 'ask:a2', 'T2', 'T1', 'ENG-2', 'ENG-1'],
    done: ['ask:a4', 'ask:a3', 'D3', 'D2', 'D1'],
  });
});

test("an internal card's ref reads INT-<n> with no repo, and each card lists when others wrote in its thread, leaving out builder status lines", () => {
  const owner = { items: [{ id: 'q1', topic: 'item:site/S3', question: 'Keep it?' }] };
  const threads = { 'site/S3': [
    { ts: '2026-10-23T09:00:00Z', who: 'claude', text: 'Built.' },
    { ts: '2026-10-23T09:05:00Z', who: 'love', text: 'Thanks' },
    { ts: '2026-10-23T09:10:00Z', who: 'Jamie', via: 'github', text: 'Nit' },
    { ts: '2026-10-23T09:15:00Z', who: 'claude', kind: 'status', text: 'Codex: Fixing the nit' },
  ] };
  const events = [{ id: 'm1', ts: '2026-10-23T09:20:00Z', kind: 'item-message', data: { key: 'site/S3', text: 'Fix it' }, reply: { html: 'Fixed.', at: '2026-10-23T09:30:00Z' } }];
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
      { id: 'C5', title: 'Issue', ticket: '#5' }, { id: 'C6', title: 'Linear', ticket: 'ENG-6' }], followups: [{ id: 'F7', title: 'Follow', ticket: 'INT-7' }] } },
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
  assert.deepEqual(badges(build({ source: 'github' })), { S3: null, 'INT-14': null, C4: own('INT-4'), C5: ['#5', 'https://github.com/owner/repo/issues/5'], C6: own('ENG-6'), F7: own('INT-7'), P1: null });
  const linear = build({ source: 'linear', workspace: 'new-workspace', team: 'ENG', project: 'Audit' });
  assert.deepEqual(badges(linear), { S3: null, 'INT-14': null, C4: own('INT-4'), C5: own('#5'), C6: ['ENG-6', 'https://linear.app/new-workspace/issue/ENG-6'], F7: own('INT-7'), P1: null });
  assert.equal(linear.items.find((i) => i.kind === 'ask').ticket, undefined);
  assert.deepEqual([build(undefined), build({ source: 'github' }), linear].map((b) => b.items.find((i) => i.id === 'P1').linear),
    [[{ id: 'WEB-9', url: null }], [{ id: 'WEB-9', url: null }], [{ id: 'WEB-9', url: 'https://linear.app/new-workspace/issue/WEB-9' }]]);
  const legacy = buildBoard({ tickets: { source: 'linear', workspace: 'new-workspace', team: 'ENG', project: 'Audit' }, waves: [{ slug: 'w', wave: { items: [{ id: 'A1', title: 'Old', linear: ['ENG-9', 'ENG-10'] }] } }] });
  assert.deepEqual(legacy.items[0].linear.map((l) => l.url), ['https://linear.app/new-workspace/issue/ENG-9', 'https://linear.app/new-workspace/issue/ENG-10']);
});

test('a card lists each unfinished dep it is blocked by, a Done one none; an unstarted one sits in Todo, a started one stays In Progress unless held', () => {
  const items = [
    { id: 'S10', title: 'Ten', status: 'done' },
    { id: 'S11', title: 'Eleven', status: 'building' },
    { id: 'INT-14', title: 'Fourteen', status: 'planned' },
    { id: 'INT-15', title: 'Fifteen', status: 'building', deps: ['S10', 'S11', 'INT-14'] },
    { id: 'INT-16', title: 'Sixteen', status: 'waiting', deps: ['S10'] },
    { id: 'INT-17', title: 'Seventeen', status: 'waiting' },
    { id: 'INT-18', title: 'Grilled', deps: ['S11'] },
    { id: 'INT-19', title: 'Grilled, held', deps: ['S11'], held: true },
    { id: 'INT-20', title: 'Built before', status: 'planned' },
    { id: 'INT-21', title: 'Landed first', status: 'done', deps: ['S11'] },
  ];
  const owner = { items: ['INT-18', 'INT-19'].map((id) => ({ id: `q${id}`, topic: `item:site/${id}`, question: '?', options: [], resolved: 'Picked.', resolved_at: '2026-10-23T10:00:00Z' })) };
  const agents = { ...runningBuilders('S11', 'INT-15'), 'INT-20': { main: { label: 'Opus builder', started: '2026-10-23T09:00:00Z', done: '2026-10-23T09:30:00Z' } } };
  const b = buildBoard({ fromWaves: false, owner, waves: [{ slug: 'site', agents, wave: { internal: true, items } }] });
  const card = (id) => b.items.find((i) => i.id === id);
  assert.deepEqual(card('INT-15').blockedBy, [{ key: 'site/S11', ref: 'INT-11' }, { key: 'site/INT-14', ref: 'INT-14' }]);
  assert.equal(card('INT-15').lane, 'progress');
  assert.deepEqual([card('INT-16').blockedBy, card('INT-16').lane], [[], 'todo']);
  assert.deepEqual([card('INT-17').blockedBy, card('S11').lane], [[], 'progress']);
  assert.deepEqual([card('INT-18').blockedBy, card('INT-18').lane], [[{ key: 'site/S11', ref: 'INT-11' }], 'progress']);
  assert.deepEqual([card('INT-19').lane, card('INT-20').lane], ['todo', 'progress']);
  assert.deepEqual([card('INT-21').blockedBy, card('INT-21').lane], [[], 'done']);
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
  assert.deepEqual([one.lane, one.waitsOn, one.builder, one.next, one.bumpable], ['progress', 'checking', null, null, false]);
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

test('Done keeps the last 7 days open and folds older work cards and follow-ups under one row, and every answered ask under its own, newest first', () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  const at = (d) => new Date(now - d * 86400000).toISOString();
  const prs = { 'o/r#1': { state: 'MERGED', mergedAt: at(2) }, 'o/r#2': { state: 'MERGED', mergedAt: at(9) }, 'o/r#3': { state: 'MERGED', mergedAt: at(30) } };
  const items = [{ id: 'A1', title: 'a', pr: 1 }, { id: 'A2', title: 'b', pr: 2 }, { id: 'A3', title: 'c', pr: 3 }, { id: 'A4', title: 'd' }];
  const followups = [{ id: 'ENG-1', title: 'f', filed: at(12), done: true }, { id: 'ENG-2', title: 'g', filed: at(1), done: true }];
  const events = [{ id: 'a1', ts: at(1), kind: 'ask', data: { text: 'q' }, reply: { html: 'ok' } }, { id: 'a2', ts: at(10), kind: 'ask', data: { text: 'r' }, reply: { html: 'ok' } }];
  const b = buildBoard({ now, fromWaves: false, prs, events, waves: [{ slug: 'w', wave: { repo: 'o/r', items, followups } }] });
  assert.deepEqual(b.items.filter((i) => i.lane === 'done').map((i) => [i.key, i.fold]), [
    ['w/ENG-2', null], ['ask:a1', 'asks'], ['w/A1', null], ['w/A2', 'older'], ['ask:a2', 'asks'], ['w/ENG-1', 'older'], ['w/A3', 'older'],
  ]);
});

test('a wave whose every item and follow-up is merged, done or dropped is finished, and its Done cards fold under one wave row, newest first, until an open follow-up reopens it', () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  const at = (d) => new Date(now - d * 86400000).toISOString();
  const prs = { 'o/r#1': { state: 'MERGED', mergedAt: at(1) }, 'o/r#2': { state: 'CLOSED', updatedAt: at(3) }, 'o/r#3': { state: 'MERGED', mergedAt: at(20) } };
  const waves = (open) => [
    { slug: 'x', wave: { repo: 'o/r', items: [{ id: 'X1', title: 'a', pr: 1 }, { id: 'X2', title: 'b', pr: 2 }, { id: 'X3', title: 'c', status: 'dropped' }, { id: 'X4', title: 'd', pr: 3 }],
      followups: [{ id: 'ENG-1', title: 'f', filed: at(2), done: true }, { id: 'ENG-2', title: 'g', filed: at(2), done: !open }] } },
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
    ['x/X1', 'done', null], ['x/ENG-1', 'done', null], ['x/X2', 'done', null], ['x/X4', 'done', 'older'], ['x/X3', 'done', null],
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
    assert.deepEqual(item.try, { kind, state: 'ready', stale: false, sha: 'abcdef1', changes: true, script: true, url: kind === 'web' ? null : 'https://m/app.apk', port: kind === 'web' ? 8501 : null });
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
    assert.deepEqual(buildBoard(snapshot).main, { slug: run.slug, branch: 'develop', sha: 'abcdef1', at: run.at, kind, state: 'ready', url: kind === 'web' ? null : 'https://m/main.apk', port: kind === 'web' ? 8501 : null });
    assert.equal(buildBoard({ ...snapshot, try: { kind, main: { ...run, script: false } } }).main, null);
  }
  assert.equal(buildBoard({ waves: [] }).main, null);
});
