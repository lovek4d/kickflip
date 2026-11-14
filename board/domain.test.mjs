import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewLinks } from './review.mjs';
import { buildBoard, stateEntries, withHub, threadOf, COMMANDS, ownerQuestion, needsAnswer, ownerActions, pullOf, rebasesDue, arrivalsOf, todoOf, triageOf, owesNext, briefsDue, NO_NEXT, PROTOTYPE_AGAIN, strictlyIdle, idleStep, idleSummary, pauseWork, prototypeWaits, orchestratorWaits, waitsStep, waitsAgainLine, REWAKE_AFTER, PICKED_REWAKE_AFTER, DAILY_REWAKE_AFTER, landStep } from './domain.mjs';

// docs/adr/2026-11-14-0725-one-land-step-decides-a-verified-cards-land.md
test("landStep gives a verified card's land one step for every way its lander can end", () => {
  const v = '2026-11-14T03:54:50.052Z';
  const step = (entry, more = {}) => landStep({ verified: v, entry, ...more });
  // Never launched for this verification: the first launch resumes the builder.
  assert.deepEqual(step(undefined), { step: 'launch', fresh: false, relaunched: 0 });
  assert.deepEqual(step({ verified: 'an older one', pid: 7, relaunched: 1, handedBack: true }), { step: 'launch', fresh: false, relaunched: 0 }, 'a new verification starts afresh');
  assert.deepEqual(step(undefined, { held: 'host busy' }), { step: 'held', held: 'host busy', relaunched: 0 });
  // Its lander lives.
  assert.deepEqual(step({ verified: v, pid: 7 }, { alive: true, held: 'host busy' }), { step: 'running', relaunched: 0 });
  // Gone without landing, the first time, however it ended: refused by builder start on a busy host, died partway (its
  // record then handed back again), a resumed builder that never took the land up, or a launch that failed (pid null).
  for (const entry of [{ verified: v, pid: 7 }, { verified: v, pid: null }, { verified: v, pid: 7, resumed: true }]) {
    assert.deepEqual(step(entry), { step: 'launch', fresh: true, relaunched: 1 }, JSON.stringify(entry));
    assert.deepEqual(step(entry, { held: 'host busy' }), { step: 'held', held: 'host busy', relaunched: 0 }, 'held until the host eases, still due');
  }
  // Gone again after its relaunch: a fault, whatever holds; once said (handedBack), it stays one.
  assert.deepEqual(step({ verified: v, pid: 8, relaunched: 1 }), { step: 'fault', relaunched: 1 });
  assert.deepEqual(step({ verified: v, pid: 8, relaunched: 1 }, { held: 'host busy' }), { step: 'fault', relaunched: 1 });
  assert.deepEqual(step({ verified: v, pid: 8, relaunched: 1, handedBack: true }), { step: 'fault', relaunched: 1 });
  // A run that ended on the usage limit spends no relaunch.
  assert.deepEqual(step({ verified: v, pid: 8, relaunched: 1 }, { limited: true }), { step: 'launch', fresh: true, relaunched: 1 });
  assert.deepEqual(step({ verified: v, pid: 8, relaunched: 1 }, { limited: true, held: 'usage paused' }), { step: 'held', held: 'usage paused', relaunched: 1 });
  // A card store.mjs landable skips takes the skip as its step, over a hold: no lander starts while it stands.
  assert.deepEqual(step(undefined, { skip: { step: 'blocked', blocked: 'by #12' }, held: 'host busy' }), { step: 'blocked', blocked: 'by #12', relaunched: 0 });
  assert.deepEqual(step({ verified: v, pid: 7 }, { skip: { step: 'worktree-gone' } }), { step: 'worktree-gone', relaunched: 0 });
  assert.deepEqual(step(undefined, { skip: { step: 'asking' } }), { step: 'asking', relaunched: 0 });
  // A lander already running keeps its step, and a fault stays one.
  assert.deepEqual(step({ verified: v, pid: 7 }, { alive: true, skip: { step: 'blocked', blocked: 'by #12' } }), { step: 'running', relaunched: 0 });
  assert.deepEqual(step({ verified: v, pid: 8, relaunched: 1 }, { skip: { step: 'worktree-gone' } }), { step: 'fault', relaunched: 1 });
  // A fault ends once the task has a dep: its block is the step.
  assert.deepEqual(step({ verified: v, pid: 8, relaunched: 1, handedBack: true }, { skip: { step: 'blocked', blocked: 'by #12' } }), { step: 'blocked', blocked: 'by #12', relaunched: 1 });
});

test("a verified card's status line and its wait on the orchestrator print its land step", () => {
  const at = '2026-11-14T03:00:00Z';
  const v = '2026-11-14T03:54:50Z';
  const agents = { A1: { main: { kind: 'claude', started: '2026-11-14T02:00:00Z', done: at, handed_back: at, calls: [{ at: '2026-11-14T02:30:00Z', text: 'x' }], verified: { at: v } } } };
  const built = (more) => buildBoard({ now: Date.parse('2026-11-14T06:00:00Z'), owner: {}, events: [], threads: {}, working: {}, ...more,
    files: [{ slug: 'w', agents, itemFile: { internal: true, items: [{ id: 'A1', title: 'One', lane: 'progress', next: 'A lander relaunches to land the verified build' }] } }] });
  const read = (more) => {
    const board = built(more);
    const card = board.items[0];
    return { land: card.land?.step, words: card.land?.words, waits: orchestratorWaits(board).map((w) => [w.kind, w.next]) };
  };
  assert.deepEqual(read({}), { land: 'launch', words: 'Lander starting', waits: [['checking', 'The board launches a lander within a minute to land the verified build']] });
  const dead = { 'w/A1': { verified: v, pid: 7, alive: false, limited: false } };
  assert.deepEqual(read({ landers: dead, landHeld: { claude: 'host busy' } }),
    { land: 'held', words: 'Landing held: host busy', waits: [['checking', 'Landing held: host busy; the board launches a lander once that clears']] }, 'the stale "relaunches" Next no longer speaks');
  assert.deepEqual(read({ landers: { 'w/A1': { ...dead['w/A1'], alive: true } } }).land, 'running');
  const faulted = read({ landers: { 'w/A1': { ...dead['w/A1'], relaunched: 1 } } });
  assert.equal(faulted.land, 'fault');
  assert.equal(faulted.waits[0][0], 'stale', 'a faulted land is a stale wait');
  assert.match(faulted.waits[0][1], /board\.mjs lander w\/A1/);
  // What landable skips reads in both lines, never "Lander starting".
  assert.deepEqual(read({ landSkips: { 'w/A1': { step: 'blocked', blocked: 'by #12' } } }),
    { land: 'blocked', words: 'Landing blocked by #12', waits: [['checking', 'Landing blocked by #12; the board launches a lander once nothing blocks it']] });
  assert.deepEqual(read({ landSkips: { 'w/A1': { step: 'asking' } } }),
    { land: 'asking', words: 'Landing waits on its open question', waits: [['checking', 'Landing waits on its open question; the board launches a lander once it is answered']] });
  const gone = read({ landSkips: { 'w/A1': { step: 'worktree-gone' } } });
  assert.deepEqual([gone.land, gone.words, gone.waits[0][0]], ['worktree-gone', "Lander can't start: its worktree is gone", 'stale']);
  assert.match(gone.waits[0][1], /^Its worktree is gone, so no lander can start/);
  // Calls still to verify: no land step yet.
  const unverified = buildBoard({ now: Date.parse('2026-11-14T06:00:00Z'), owner: {}, events: [], threads: {}, working: {},
    files: [{ slug: 'w', agents: { A1: { main: { ...agents.A1.main, verified: null } } }, itemFile: { internal: true, items: [{ id: 'A1', title: 'One', lane: 'progress' }] } }] });
  assert.equal(unverified.items[0].land, null);
});

const greenDraft = { state: 'OPEN', isDraft: true, checks: { state: 'pass' }, reviews: {} };
const runningBuilders = (...ids) => Object.fromEntries(ids.map((id) => [id, { main: { started: '2026-10-23T10:00:00Z' } }]));

function board({ agents = {}, pr = greenDraft, owner = {}, events = [], topicItems = {}, now, held = false, threads = {}, item = {}, fromWaves = true, skipDraft, moved, alive } = {}) {
  return buildBoard({
    now,
    moved,
    alive,
    skipDraft,
    topicItems,
    threads,
    fromWaves,
    files: [{
      slug: 'w',
      agents,
      itemFile: {
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
  const quiet = board({ pr: null, item: { pr: undefined, lane: 'progress' }, threads, events: [msg], agents: { A1: { main: { kind: 'claude', model: 'opus', started: '2026-10-23T10:00:00Z' } } } });
  const card = quiet.items.find((i) => i.key === 'w/A1');
  assert.deepEqual([card.othersAt, card.waitsOn, card.action], [[], 'builder', null]);
  const thread = threadOf('w/A1', { lines: threads['w/A1'], events: [msg] });
  assert.deepEqual(thread.map((m) => [m.kind, m.who, m.ask ?? null, m.state ?? null]), [
    ['item-message', 'love', null, 'waiting'], ['builder-ask', 'Claude Opus builder', 'ask1', null], ['builder-answer', 'claude', 'ask1', null]]);

  // At review: the deferred question waits on the owner from In Progress, with Open questions and no Action needed.
  const owner = { items: [{ id: 'q-ask', topic: 'item:w/A1', ask: 'ask2', question: 'Fold Done?', asked_at: '2026-10-23T11:00:00Z' }] };
  const handedBack = { A1: { main: { kind: 'claude', started: '2026-10-23T10:00:00Z', done: '2026-10-23T10:30:00Z', handed_back: '2026-10-23T10:30:00Z' } } };
  const asked = board({ pr: null, item: { pr: undefined, lane: 'progress' }, agents: handedBack, owner }).items.find((i) => i.key === 'w/A1');
  assert.deepEqual([asked.lane, asked.waitsOn, asked.action, asked.actionButton, asked.next], ['progress', 'owner', null, 'openQuestions', 'Answer 1 question']);
  assert.deepEqual(asked.questions.askedAt, ['2026-10-23T11:00:00Z']);
  // Any other open question still needs the owner's action.
  const both = board({ pr: null, item: { pr: undefined, lane: 'progress' }, agents: handedBack, owner: { items: [...owner.items, { id: 'q2', topic: 'item:w/A1', question: 'Ship it?', asked_at: '2026-10-23T11:05:00Z' }] } }).items.find((i) => i.key === 'w/A1');
  assert.deepEqual([both.waitsOn, both.action?.kind, both.questions.askedAt], ['checking', 'questions', ['2026-10-23T11:00:00Z', '2026-10-23T11:05:00Z']]);
});

test('manifest github selects PR state and card links ahead of wave repo with a wave fallback', () => {
  const files = [{ slug: 'w', itemFile: { repo: 'old/project', items: [{ id: 'A1', pr: 7 }, { id: 'F1', parent: 'A1' }] } }];
  const prs = { 'new/project#7': { ...greenDraft, title: 'selected' }, 'old/project#7': { state: 'CLOSED', title: 'legacy' } };
  for (const github of ['new/project', undefined]) {
    const repo = github || 'old/project';
    const built = buildBoard({ github, files, prs });
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
  assert.deepEqual(fresh.builder, { progress: null, phase: null, at: record.started, kind: null, planner: false, stale: false, silentSince: record.started, alive: null, held: false, stopped: null });
  const lines = [earlier, { ts: '2026-10-23T10:05:00Z', who: 'claude', kind: 'status', text: 'Running tests' }, { ts: '2026-10-23T10:07:00Z', who: 'claude', text: 'Halfway.' }];
  const busy = board({ now: Date.parse('2026-10-23T10:07:00Z'), agents: { A1: { main: record } }, threads: { 'w/A1': lines } });
  const item = busy.items.find((i) => i.key === 'w/A1');
  assert.deepEqual([item.lane, item.waitsOn, item.action], ['progress', 'builder', null]);
  assert.deepEqual(item.builder, { progress: 'Running tests', phase: null, at: '2026-10-23T10:05:00Z', kind: null, planner: false, stale: false, silentSince: '2026-10-23T10:05:00Z', alive: null, held: false, stopped: null });
  const finished = board({ agents: { A1: { main: { label: 'Opus builder', started: '2026-10-23T10:00:00Z', progress: 'Running tests', progress_at: '2026-10-23T10:05:00Z', eta: '2026-10-23T11:00:00Z', done: '2026-10-23T10:30:00Z' } } } });
  const after = finished.items.find((i) => i.key === 'w/A1');
  assert.deepEqual([after.lane, after.waitsOn, after.builder, after.eta], ['review', 'ready', null, null]);
  for (const fromWaves of [true, false]) {
    for (const lane of ['progress', undefined]) {
      for (const agents of [{}, { A2: { main: record } }, { A1: { main: { ...record, done: '2026-10-23T10:30:00Z' } } }]) {
        const idle = board({ fromWaves, item: { lane }, agents });
        const card = idle.items.find((i) => i.key === 'w/A1');
        assert.deepEqual([card.lane, card.waitsOn, card.next, card.action, card.builder], [ready.lane, ready.waitsOn, ready.next, ready.action, null]);
        assert.equal(idle.needs.some((n) => n.kind === 'Tap Ready'), true);
      }
      const running = board({ fromWaves, item: { lane }, agents: { A1: { main: record } } }).items.find((i) => i.key === 'w/A1');
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
  assert.deepEqual([answered.lane, answered.action, answered.actionButton, answered.resolvedBy, answered.buildable], ['todo', null, 'openQuestions', null, true], 'every question answered: the button stays, quiet');
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
  assert.deepEqual([held.lane, held.held, held.action?.kind, held.actionButton], ['todo', true, 'pick', 'openQuestions']);
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
  assert.equal(card({ item: { install, lane: 'done' }, pr: null }), null);
  assert.equal(card(), null);
});

test('a card a builder has built on, or whose stored lane is In Progress, is In Progress, one stored back in Todo only while a build runs; a grill or prototype agent leaves it in Todo', () => {
  const started = { label: 'Opus builder', started: '2026-10-23T10:00:00Z' };
  for (const [lane, unbuilt, built] of [[undefined, 'todo', 'progress'], ['progress', 'progress', 'progress'], ['todo', 'todo', 'todo']]) {
    const card = (record) => board({ pr: null, item: { lane }, agents: record ? { A1: { main: record } } : {} }).items.find((i) => i.key === 'w/A1');
    assert.deepEqual([card(null).lane, card(started).lane, card({ ...started, done: '2026-10-23T10:30:00Z' }).lane], [unbuilt, 'progress', built]);
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

test('an install builder exposes its kind and leaves drafts and ready PRs In Review while the install runs', () => {
  const install = { url: 'https://m/app.apk', sha: 'old' };
  const record = { kind: 'install', started: '2026-10-30T10:00:00Z' };
  const card = (pr, records, item = {}) => board({ pr, agents: { A1: records }, item: { install, ...item } }).items.find((i) => i.key === 'w/A1');
  for (const isDraft of [true, false]) {
    const pr = { ...greenDraft, isDraft, headRefOid: 'new' };
    const running = card(pr, { install: record, review: { kind: 'codex', started: '2026-10-30T10:01:00Z' } });
    assert.equal(running.builder.kind, 'install');
    assert.deepEqual([running.lane, running.waitsOn, running.action, running.install.older], ['progress', 'builder', null, true], 'the other agent can change code');
    const alone = card(pr, { install: record });
    assert.deepEqual([alone.lane, alone.waitsOn, alone.action], ['review', 'builder', null]);
    assert.equal(card(pr, { install: record }, { install: null }).builder.kind, 'install');
    assert.equal(card(pr, { install: record, main: { started: '2026-10-30T09:00:00Z', done: '2026-10-30T09:30:00Z', handed_back: '2026-10-30T09:30:00Z' } }).builder.kind, 'install');
    const finished = card(pr, { install: { ...record, done: '2026-10-30T10:10:00Z' } }, { install: { ...install, sha: 'new' } });
    assert.deepEqual([finished.lane, finished.builder, finished.install.older], ['review', null, false]);
  }
  const other = card(greenDraft, { install: { ...record, done: '2026-10-30T10:10:00Z' }, main: { kind: 'opus', started: '2026-10-30T10:01:00Z' } });
  assert.equal(other.builder.kind, 'claude');
});

// docs/adr/2026-11-06-1546-only-a-run-that-changes-code-moves-an-in-review-card.md
test('only a run that can change its code moves an In Review card to In Progress: an install run or a lander, running or handed back, leaves it there', () => {
  const ready = { ...greenDraft, isDraft: false, reviewDecision: 'REVIEW_REQUIRED' };
  const lane = (records, pr = ready, item = {}) => board({ pr, agents: { A1: records }, item }).items.find((i) => i.key === 'w/A1').lane;
  const built = { kind: 'claude', started: '2026-11-06T09:00:00Z', done: '2026-11-06T09:30:00Z' };
  const at = '2026-11-06T10:00:00Z';
  assert.equal(lane({ main: built }), 'review');
  assert.equal(lane({ main: built, install: { kind: 'install', started: at } }), 'review');
  assert.equal(lane({ main: { kind: 'claude', label: 'Lander', started: at } }), 'review');
  assert.equal(lane({ main: { kind: 'claude', label: 'Lander', started: at, done: '2026-11-06T10:10:00Z', handed_back: '2026-11-06T10:10:00Z', calls: [{ at, text: 'main moved' }] } }), 'review');
  // A fix builder sent back after review changes code.
  assert.equal(lane({ main: { kind: 'claude', started: at } }), 'progress');
  assert.equal(lane({ main: { kind: 'claude', started: at, done: '2026-11-06T10:10:00Z', handed_back: '2026-11-06T10:10:00Z', calls: [{ at, text: 'a call' }] } }), 'progress');
  // A card with no PR or held branch is In Progress while any run works on it.
  assert.equal(lane({ install: { kind: 'install', started: at } }, null, { lane: 'progress' }), 'progress');
  assert.equal(lane({ main: { kind: 'claude', label: 'Lander', started: at } }, null, { lane: 'progress' }), 'progress');
});

// docs/adr/2026-11-13-2030-a-test-run-reports-live-lines-the-thread-does-not-show.md
test('a live status line sets the card line and keeps a running build from reading stale, but the thread does not show it', () => {
  const started = '2026-10-30T10:00:00Z';
  const start = { ts: '2026-10-30T10:01:00Z', who: 'claude', kind: 'status', phase: 'testing', text: 'Testing: 12 affected test files' };
  const update = { ts: '2026-10-30T10:08:00Z', who: 'claude', kind: 'status', phase: 'testing', live: true, text: 'Testing: 5 tests run, 0 failing' };
  const card = board({ now: Date.parse('2026-10-30T10:15:00Z'), agents: { A1: { main: { kind: 'codex', started } } }, threads: { 'w/A1': [start, update] } }).items.find((i) => i.key === 'w/A1');
  assert.deepEqual([card.builder.progress, card.builder.phase, card.builder.stale], ['Testing · 5 tests run, 0 failing', 'testing', false]);
  const shown = threadOf('w/A1', { lines: [start, update] }).filter((m) => m.kind === 'status').map((m) => m.text);
  assert.deepEqual(shown, [start.text]);
});

test('a builder goes stale after 15 minutes without progress or transcript movement, clears on either or done, and ignores ordinary thread lines', () => {
  const started = '2026-10-30T10:00:00Z';
  const record = { kind: 'codex', started };
  const card = (minutes, lines = [], agent = record, moved) => board({
    now: Date.parse(started) + minutes * 60000,
    agents: { A1: { main: agent } }, threads: { 'w/A1': lines }, moved,
  }).items.find((i) => i.key === 'w/A1');
  for (const minutes of [14, 15, 16]) {
    const builder = card(minutes).builder;
    assert.deepEqual([builder.stale, builder.silentSince, builder.at], [minutes >= 15, started, started]);
  }
  const progress = { ts: '2026-10-30T10:20:00Z', kind: 'status', text: 'Running tests' };
  assert.deepEqual([card(36, [progress]).builder.stale, card(36, [progress]).builder.silentSince], [true, progress.ts]);
  assert.equal(card(34, [progress]).builder.stale, false);
  assert.equal(card(36, [progress, { ts: '2026-10-30T10:30:00Z', who: 'claude', text: 'Checking.' }]).builder.stale, true);
  assert.equal(card(31, [{ ...progress, ts: '2026-10-30T09:59:00Z' }]).builder.silentSince, started);
  assert.equal(card(31, [], { ...record, done: '2026-10-30T10:30:00Z' }).builder, null);
  assert.equal(card(31, [], { kind: 'codex' }).builder, null);
});

test("a headless builder's transcript changing within 15 minutes keeps it from reading Stalled, and an unread transcript falls back to progress lines", () => {
  const worktree = { path: '/w/GH-1' };
  const record = { kind: 'claude', started: '2026-10-30T10:00:00Z', worktree };
  const card = (minutes, moved) => board({ now: Date.parse(record.started) + minutes * 60000, agents: { A1: { main: record } }, moved }).items.find((i) => i.key === 'w/A1').builder;
  const at = (minutes) => Date.parse(record.started) + minutes * 60000;
  assert.deepEqual([card(40, { '/w/GH-1': at(35) }).stale, card(40, { '/w/GH-1': at(35) }).silentSince], [false, new Date(at(35)).toISOString()]);
  assert.equal(card(50, { '/w/GH-1': at(35) }).stale, true);
  assert.equal(card(40, { '/w/GH-1': at(1) }).stale, true);
  assert.equal(card(40, {}).stale, true);
  assert.equal(card(40, undefined).stale, true);
  assert.equal(card(40, { '/w/other': at(39) }).stale, true);
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
  assert.equal(progress({ phase: 'testing', text: 'Testing: x' }, { text: 'Cause: steady() anchored the task' }), 'Cause: steady() anchored the task');
});

test('lanes follow the PR, with a red ready PR in In Review until a fix builder starts, and an open follow-up sits in Todo', () => {
  const lanes = (pr) => Object.fromEntries(board({ pr }).items.map((i) => [i.key, i.lane]));
  assert.deepEqual(lanes({ ...greenDraft, checks: { state: 'pending' } }), { 'w/A1': 'review', 'w/ENG-1': 'todo' });
  assert.equal(lanes({ ...greenDraft, checks: { state: 'fail' } })['w/A1'], 'review');
  assert.equal(lanes({ ...greenDraft, isDraft: false })['w/A1'], 'review');
  assert.equal(lanes({ ...greenDraft, isDraft: false, checks: { state: 'pending' } })['w/A1'], 'review');
  const red = board({ pr: { ...greenDraft, isDraft: false, checks: { state: 'fail' } } }).items.find((i) => i.key === 'w/A1');
  assert.deepEqual([red.lane, red.waitsOn, red.phase, red.next, red.action], ['review', null, null, 'Fix the failing CI', null]);
  const fixing = board({ pr: { ...greenDraft, isDraft: false, checks: { state: 'fail' } }, agents: runningBuilders('A1') }).items.find((i) => i.key === 'w/A1');
  assert.deepEqual([fixing.lane, fixing.waitsOn], ['progress', 'builder'], 'a fix builder takes it to In Progress');
  assert.equal(lanes({ ...greenDraft, state: 'MERGED' })['w/A1'], 'done');
  const done = buildBoard({ fromWaves: false, files: [{ slug: 's', itemFile: { items: [{ id: 'S1', title: 'One', lane: 'done', next: 'Builds after S0' }] } }] }).items[0];
  assert.deepEqual([done.lane, done.next, done.actionButton], ['done', null, null]);
  assert.equal(board().items.find((i) => i.key === 'w/ENG-1').actionButton, null);
});

// docs/adr/2026-11-05-0200-a-stale-review-and-a-silent-builder-join-the-orchestrator-list.md
test('a review gone stale waits on the orchestrator from the day it crossed seven days, and a thread line picks it up', () => {
  const ready = { ...greenDraft, isDraft: false };
  const sent = { 'w/A1': { review_link_ts: { Ann: '1792800000.000100' } } };
  const sentAt = '2026-10-24T00:00:00.000Z';
  const staleAt = '2026-10-31T00:00:00.000Z';
  const at = (days) => Date.parse(sentAt) + days * 86400000;
  const waits = (days, threads = {}) => orchestratorWaits(board({ pr: ready, topicItems: sent, now: at(days), threads }));
  assert.deepEqual(waits(6), [], 'still in Review');
  const [wait] = waits(8);
  assert.deepEqual([wait.key, wait.kind, wait.since, wait.picked], ['w/A1', 'stale', staleAt, null]);
  assert.match(wait.next, /stale/i);
  const said = { 'w/A1': [{ ts: '2026-11-01T00:00:00Z', who: 'claude', text: 'Pinged Ann.' }] };
  assert.equal(waits(8, said)[0].picked, '2026-11-01T00:00:00Z');
  // docs/adr/2026-11-06-1653-the-orchestrator-reviews-every-lane-on-a-schedule.md: a stale review re-wakes daily once picked up.
  assert.deepEqual([wait.daily, waits(8, said)[0].daily], [true, true]);
});

test("a card reads each reviewer's latest review, commented too, and every other GitHub login that approved, asked for changes or commented", () => {
  const reviews = { ann: 'COMMENTED', 'chatgpt-codex-connector': 'COMMENTED', bea: 'APPROVED', cy: 'CHANGES_REQUESTED', dee: 'DISMISSED', eve: 'PENDING' };
  const card = board({ pr: { ...greenDraft, isDraft: false, reviews } }).items.find((i) => i.key === 'w/A1');
  assert.deepEqual(card.review, { Ann: { state: 'commented', since: null, github: 'ann' } });
  assert.deepEqual(card.otherReviews, [{ github: 'chatgpt-codex-connector', state: 'commented' }, { github: 'bea', state: 'approved' }, { github: 'cy', state: 'changes' }]);
  assert.deepEqual(board({ pr: { ...greenDraft, reviews: { ann: 'APPROVED' } } }).items.find((i) => i.key === 'w/A1').otherReviews, []);
});

test('a review waits with its age, and reads stale in In Review after a week', () => {
  const ready = { ...greenDraft, isDraft: false };
  const sent = { 'w/A1': { review_link_ts: { Ann: '1792800000.000100' } } };
  const sentAt = '2026-10-24T00:00:00.000Z';
  const at = (days) => Date.parse(sentAt) + days * 86400000;
  const item = (days) => board({ pr: ready, topicItems: sent, now: at(days) }).items.find((i) => i.key === 'w/A1');
  assert.deepEqual(item(2).review, { Ann: { state: 'sent', since: sentAt, github: 'ann' } });
  assert.deepEqual([item(2).lane, item(2).stale], ['review', false]);
  assert.deepEqual([item(8).lane, item(8).stale], ['review', true]);
  assert.equal(item(8).waitsOn, 'reviewers');
  assert.equal(item(8).next, 'Waiting for PR reviewers');
  const approved = board({ pr: { ...ready, reviews: { ann: 'APPROVED' }, reviewDecision: 'APPROVED' }, topicItems: sent, now: at(2) }).items.find((i) => i.key === 'w/A1');
  assert.deepEqual(approved.review, { Ann: { state: 'approved', since: null, github: 'ann' } });
  assert.equal(approved.waitsOn, 'merge');
  const fileBoard = buildBoard({
    now: at(8), fromWaves: false, prs: { 'o/r#7': ready },
    files: [{ slug: 'f', itemFile: { repo: 'o/r', reviewers: [{ name: 'Ann', github: 'ann' }], items: [{ id: 'B1', title: 'Two', pr: 7, review_sent: { Ann: '1792800000.000100' } }] } }],
  }).items[0];
  assert.deepEqual([fileBoard.lane, fileBoard.stale, fileBoard.review.Ann.since], ['review', true, sentAt]);
  assert.match(approved.next, /^Approved/);
  const steps = buildBoard({
    now: at(2), fromWaves: false, prs: { 'o/r#7': { ...ready, reviewDecision: 'APPROVED' } },
    files: [{ slug: 'f', itemFile: { repo: 'o/r', items: [{ id: 'B1', title: 'Two', pr: 7, manual_steps: ['Run the backfill'] }] } }],
  }).items[0];
  assert.deepEqual([steps.lane, steps.waitsOn, steps.action, steps.resolvedBy], ['review', 'merge', { kind: 'steps', url: '#selectedCard=f%2FB1', label: 'Run the manual steps, then merge' }, 'github']);
  const fixing = buildBoard({
    now: at(2), fromWaves: false, prs: { 'o/r#7': ready },
    files: [{ slug: 'f', itemFile: { repo: 'o/r', reviewers: [{ name: 'Ann', github: 'ann' }], items: [{ id: 'B1', title: 'Two', pr: 7, lane: 'progress', next: 'Reply to Codex', review_sent: { Ann: '1792800000.000100' } }] } }],
  }).items[0];
  assert.deepEqual([fixing.lane, fixing.waitsOn, fixing.builder, fixing.next], ['review', 'reviewers', null, 'Waiting for PR reviewers']);
  const changing = board({ pr: ready, item: { lane: 'progress' }, agents: runningBuilders('A1') }).items.find((i) => i.key === 'w/A1');
  assert.deepEqual([changing.lane, changing.waitsOn, changing.builder.progress, changing.next], ['progress', 'builder', null, null]);
});

test("an answer after a question was resolved reopens it, but a Done card's topic with no open question is resolved", () => {
  const owner = { items: [{ id: 'q1', topic: 'item:w/A1', question: '?', options: [], resolved: 'Kept.', resolved_at: '2026-10-23T10:00:00Z' }] };
  const answer = (ts) => ({ id: 'e' + ts, ts, kind: 'owner-answer', data: { id: 'q1', choice: 'A' }, reply: null });
  assert.equal(board({ owner, events: [answer('2026-10-23T09:00:00Z')] }).owner[0].state, 'resolved');
  const reopened = board({ owner, events: [answer('2026-10-23T11:00:00Z')] });
  assert.equal(reopened.owner[0].state, 'answered');
  assert.equal(reopened.items.find((i) => i.key === 'w/A1').questions.answered, 1);
  const closed = board({ owner, events: [answer('2026-10-23T11:00:00Z')], item: { lane: 'done' } });
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
  assert.deepEqual(thread.map((m) => [m.kind, m.text, m.status, Boolean(m.request)]), [['prototype-request', 'Question 1 · Where does search sit?\n→ show it on a phone', 'Prototype requested', false]]);
  const leaning = threadOf('w/A1', { events: [request('plain', '2026-10-23T10:00:00Z', 'B')], owner: { items: [plain] } });
  assert.deepEqual(leaning.map((m) => m.text), ['Question 1 · Where does search sit?\n→ B. Behind an icon\n→ show it on a phone']);
});

// docs/adr/2026-11-07-0300-prototypes-have-their-own-button-and-viewer.md
test("a card's prototypes are its questions on prototype pages, oldest round first, open while one of them waits on the owner's pick", () => {
  const plain = { id: 'plain', topic: 'item:w/A1', question: 'Where does search sit?', options: [{ id: 'A', label: 'Above' }] };
  const takes = { id: 'takes', topic: 'item:w/A1', question: 'Which take?', url: 'prototype-search.html?q=takes', options: [{ id: 'A', label: 'Above' }, { id: 'B', label: 'Icon' }], round: 1, round_of: 'plain' };
  const confirm = { id: 'takes-confirm', topic: 'item:w/A1', question: 'Is this it?', url: 'prototype-search.html?q=takes-confirm', options: [{ id: 'B', label: 'Icon' }], round: 1, confirm_of: 'takes' };
  const again = { id: 'takes-2', topic: 'item:w/A1', question: 'Which now?', url: 'prototype-search-2.html?q=takes-2', options: [{ id: 'A', label: 'Big' }], round: 2, round_of: 'takes' };
  const resolved = (q, at) => ({ ...q, resolved: 'Followed by the next round', resolved_at: at });
  const answer = (id, choice, ts) => ({ id: `a-${id}`, ts, kind: 'owner-answer', data: { id, choice, note: '' }, reply: null });
  const card = (items, events = []) => board({ owner: { items }, events }).items.find((i) => i.key === 'w/A1').prototypes;

  assert.equal(card([plain]), null);
  assert.equal(board({}).items.find((i) => i.key === 'w/A1').prototypes, null);
  assert.deepEqual(card([resolved(plain, '2026-10-23T11:00:00Z'), takes]),
    { open: true, rounds: [{ n: 1, q: 'takes', url: 'prototype-search.html?q=takes', confirm: false, state: 'open' }] });
  assert.deepEqual(card([resolved(plain, '2026-10-23T11:00:00Z'), takes], [answer('takes', 'B', '2026-10-23T12:00:00Z')]).open, false);
  const later = card([again, resolved(plain, '2026-10-23T11:00:00Z'), resolved(takes, '2026-10-23T12:00:01Z'), resolved(confirm, '2026-10-23T13:00:01Z')]);
  assert.deepEqual(later.rounds.map((r) => [r.n, r.q, r.confirm, r.state]), [[1, 'takes', false, 'resolved'], [1, 'takes-confirm', true, 'resolved'], [2, 'takes-2', false, 'open']]);
  assert.equal(later.open, true);
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
  assert.deepEqual(msgs.map((m) => m.text), ['Built.', '', 'Question 1 · Keep it?\n→ A. Keep it · and file one']);
  assert.deepEqual(msgs.map((m) => m.files), [undefined, [shot], [shot]]);
  assert.deepEqual(msgs[2].reply, { html: 'Kept.' });
});

test('an internal wave marks its items, and one without a PR reaches Done by its stored lane', () => {
  const b = buildBoard({
    fromWaves: true,
    files: [
      { slug: 'site', agents: runningBuilders('S2'), itemFile: { internal: true, items: [{ id: 'S1', title: 'Shared script', lane: 'done' }, { id: 'S2', title: 'Uploads', lane: 'progress' }] } },
      { slug: 'w', itemFile: { items: [{ id: 'A1', title: 'One' }] } },
    ],
  });
  const byKey = Object.fromEntries(b.items.map((i) => [i.key, [i.internal, i.lane]]));
  assert.deepEqual(byKey, { 'site/S1': [true, 'done'], 'site/S2': [true, 'progress'], 'w/A1': [false, 'todo'] });
});

test("a card pushed to a plain git remote waits In Review on the owner's merge with no action, goes back to In Progress while a builder fixes it, and is Done once merged", () => {
  const pushed = { branch: 'INT-12', at: '2026-11-02T10:00:00Z' };
  const built = (item, agents = {}) => buildBoard({ remote: 'git@gitlab.com:acme/firmware.git', branch: 'trunk', fromWaves: true,
    files: [{ slug: 'fw', agents, itemFile: { internal: true, items: [{ id: 'S12', title: 'OTA retry', branch: 'INT-12', pushed, ...item }] } }] });
  const open = built({});
  assert.deepEqual(open.remote, { host: 'gitlab.com', name: 'gitlab.com/acme/firmware' });
  const card = open.items[0];
  assert.deepEqual([card.lane, card.waitsOn, card.next, card.action, card.pr, card.branch], ['review', 'owner', 'merge INT-12 into trunk', null, null, 'INT-12']);
  assert.deepEqual(card.pushed, { branch: 'INT-12', at: pushed.at, host: 'gitlab.com' });
  assert.deepEqual(open.needs, []);
  const fixing = built({}, runningBuilders('S12')).items[0];
  assert.deepEqual([fixing.lane, fixing.waitsOn], ['progress', 'builder']);
  const merged = built({ lane: 'done' }).items[0];
  assert.deepEqual([merged.lane, merged.next, merged.pushed], ['done', null, null]);
  assert.equal(buildBoard({ github: 'o/r', remote: 'git@gitlab.com:acme/firmware.git', files: [] }).remote, null);
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
    { kind: 'Question', text: 'A1: One · 1 question · Ready on GitHub', url: '#selectedCard=w%2FA1' },
  ]);
  assert.equal(board({ owner, events: answered }).needsSummary, '2 questions · 1 draft waiting on Ready');
  // docs/adr/2026-11-05-0500-held-only-stops-the-automatic-pull.md: a held card's open question is a Needs you line too.
  assert.deepEqual(lines(board({ owner, events: answered, held: true, item: { pr: undefined } })), [
    { kind: 'Question', text: 'Site · 1 question', url: 'questions.html#q1' },
    { kind: 'Question', text: 'A1: One · 1 question', url: '#selectedCard=w%2FA1' },
  ]);
  assert.deepEqual(lines(board()), [{ kind: 'Tap Ready', text: 'A1: One · Ready on GitHub', url: '#selectedCard=w%2FA1' }]);
  assert.deepEqual(lines(board({ pr: { ...greenDraft, isDraft: false } })), []);
  assert.equal(board({ pr: { ...greenDraft, isDraft: false } }).needsSummary, '');
});

test("needs sorts each card's line by its card's created time, and a topic with no card by its oldest open question", () => {
  const owner = {
    topics: [{ id: 'site', title: 'Site' }],
    items: [
      { id: 'q1', topic: 'site', question: 'Open?', asked_at: '2026-10-23T12:00:00Z' },
      { id: 'q2', topic: 'item:w/A1', question: 'Keep it?', asked_at: '2026-10-23T20:00:00Z' },
    ],
  };
  const names = (b) => b.needs.map((l) => l.text.split(' · ')[0]);
  assert.deepEqual(names(board({ owner, item: { created: '2026-10-23T10:00:00Z' } })), ['A1: One', 'Site'], 'the task was created first, though asked last');
  assert.deepEqual(board({ owner, item: { created: '2026-10-23T10:00:00Z' } }).needs.map((l) => l.since), ['2026-10-23T10:00:00Z', '2026-10-23T12:00:00Z']);
  const newer = board({ owner, item: { created: '2026-10-23T13:00:00Z' } });
  assert.deepEqual(names(newer), ['Site', 'A1: One']);
  const pills = (b) => b.ownerTopics.filter((t) => t.open > 0).map((t) => t.id);
  assert.deepEqual(pills(board({ owner, item: { created: '2026-10-23T10:00:00Z' } })), ['item:w/A1', 'site'], "Waiting on you's topics follow Needs you");
  assert.deepEqual(pills(newer), ['site', 'item:w/A1']);
});

test("questions on In Progress cards come first, oldest card first, then the other cards the same way, and their pills carry progress", () => {
  const card = (id, created, lane) => ({ id, title: id, created, lane, branch: id });
  const q = (id, topic) => ({ id: `q-${id}`, topic: `item:w/${id}`, question: 'Keep it?', asked_at: '2026-10-23T20:00:00Z' });
  const ids = ['P-old', 'P-new', 'T-old', 'T-new'];
  const b = buildBoard({ fromWaves: true, github: 'o/r', files: [{ slug: 'w', agents: {}, itemFile: { repo: 'o/r', items: [
    card('T-old', '2026-10-01T00:00:00Z'), card('P-new', '2026-10-05T00:00:00Z', 'progress'), card('T-new', '2026-10-06T00:00:00Z'), card('P-old', '2026-10-03T00:00:00Z', 'progress')] } }],
  owner: { items: ids.map((id) => q(id)) } });
  const lanes = Object.fromEntries(b.items.map((i) => [i.id, i.lane]));
  assert.deepEqual([lanes['P-old'], lanes['P-new']], ['progress', 'progress']);
  assert.notEqual(lanes['T-old'], 'progress');
  assert.deepEqual(b.needs.map((l) => l.title.split(':')[1].trim()), ['P-old', 'P-new', 'T-old', 'T-new']);
  const pills = b.ownerTopics.filter((t) => t.open > 0);
  assert.deepEqual(pills.map((t) => t.id), ['P-old', 'P-new', 'T-old', 'T-new'].map((id) => `item:w/${id}`));
  assert.deepEqual(pills.map((t) => Boolean(t.progress)), [true, true, false, false]);
});

test("the board session's pending prompts lead Needs you, each a Prompt line carrying its details, and the summary and the hub's needs count them", () => {
  const perm = { id: 'p1', tool: 'Bash', action: 'run npm test', detail: 'npm test', rule: 'Bash(npm test)', questions: null, cwd: '~/r', at: '2026-10-30T10:00:00Z' };
  const ask = { id: 'p2', tool: 'AskUserQuestion', action: null, detail: '', rule: null, cwd: '~/r', at: '2026-10-30T10:01:00Z', questions: [{ question: 'Colour?', options: [{ label: 'Red' }] }, { question: 'Size?', options: [{ label: 'S' }] }] };
  const b = buildBoard({ fromWaves: false, files: [], events: [], prompts: [perm, ask] });
  assert.deepEqual(b.needs.map(({ kind, text, url, prompt }) => [kind, text, url, prompt.id]), [['Prompt', 'Bash: npm test', '', 'p1'], ['Prompt', 'Question: Colour? · Size?', '', 'p2']]);
  assert.equal(b.needsSummary, '2 prompts');
  assert.deepEqual(needsAnswer(b).items, [{ kind: 'Prompt', text: 'Bash: npm test', url: '' }, { kind: 'Prompt', text: 'Question: Colour? · Size?', url: '' }]);
  assert.deepEqual(board({ owner: {}, events: [] }).needs.map((l) => l.kind), ['Tap Ready']);
});

test('the needs answer counts open cards by lane and says when a builder works on one', () => {
  const quiet = needsAnswer(board());
  assert.deepEqual(quiet, {
    items: [{ kind: 'Tap Ready', text: 'A1: One · Ready on GitHub', url: '#selectedCard=w%2FA1' }], working: 0, summary: '1 draft waiting on Ready',
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
  // The ask is its own card, T-1, which counts its working mark.
  const files = [{ slug: 'w', itemFile: { items: [{ id: 'A1', title: 'One' }, { id: 'T-1', title: 'Hi', from_ask: 'a1' }] } }];
  const at = (events, lines = {}) => {
    const b = buildBoard({ fromWaves: false, files, events, threads: lines, working });
    return { card: b.items.find((i) => i.key === 'w/A1').working, count: b.working, msgs: threadOf('w/A1', { lines: lines['w/A1'] || [], events, working }) };
  };
  const marked = at([ask, msg('m1', '2026-10-23T10:00:00Z'), msg('m2', '2026-10-23T10:05:00Z')]);
  assert.deepEqual(marked.msgs.map(({ text, state }) => [text, state]), [['m1', 'working'], ['m2', 'waiting']]);
  assert.deepEqual([marked.card, marked.count], [true, 2]);
  const status = at([ask, msg('m1', '2026-10-23T10:00:00Z')], { 'w/A1': [{ ts: '2026-10-23T10:03:00Z', who: 'claude', kind: 'status', text: 'Running tests' }] });
  assert.deepEqual(status.msgs.map(({ kind, state }) => [kind, state]), [['item-message', 'working'], ['status', undefined]]);
  assert.equal(status.card, true);
  const later = at([ask, msg('m1', '2026-10-23T10:00:00Z')], { 'w/A1': [{ ts: '2026-10-23T10:03:00Z', who: 'claude', text: 'Done.' }] });
  assert.deepEqual([later.msgs[0].state, later.card, later.count], ['answered', false, 1]);
  const replied = at([{ ...ask, reply: { html: 'Hello' } }, msg('m1', '2026-10-23T10:00:00Z', { reply: { html: 'On it' } })]);
  assert.deepEqual([replied.msgs[0].state, replied.card, replied.count], ['replied', false, 0]);
  const count = (events, extra = {}) => buildBoard({ fromWaves: false, files, events, working: { ...working, g1: '2026-10-23T10:01:00Z', q1: '2026-10-23T10:01:00Z' }, ...extra }).working;
  assert.equal(count([msg('g1', '2026-10-23T10:00:00Z', { data: { key: 'gone/G1', text: 'g1' } })]), 0);
  assert.equal(count([{ id: 'q1', ts: '2026-10-23T10:00:00Z', kind: 'owner-answer', data: { id: 'gone-q' }, reply: null }]), 0);
  // The ask's card closing after the mark answers it; a close before the mark doesn't.
  assert.equal(count([ask, { id: 'd1', ts: '2026-10-23T09:00:00Z', kind: 'card-done', data: { key: 'w/T-1' } }]), 0);
  assert.equal(count([ask, { id: 'd1', ts: '2026-10-23T07:00:00Z', kind: 'card-done', data: { key: 'w/T-1' } }], { now: Date.parse('2026-10-23T12:00:00Z') }), 1);
  const agents = { main: { label: 'Opus builder', started: '2026-10-23T10:06:00Z', done: '2026-10-23T10:07:00Z' } };
  assert.deepEqual(threadOf('w/A1', { events: [msg('m2', '2026-10-23T10:05:00Z')], agents }).map(({ kind, state }) => [kind, state]), [['item-message', 'waiting'], ['agent', undefined], ['agent', undefined]]);
});

// docs/adr/2026-11-13-1800-every-wait-is-listed-and-working-is-display-only.md
// A working mark reads working only while the session that picked it up listens; a session that stops listening and
// doesn't come back leaves the message and the New ask reading waiting, and the mark comes back with the session.
test('a message marked working reads waiting while its session does not listen, and carries when it was marked', () => {
  const msg = { id: 'm1', ts: '2026-10-23T10:00:00Z', kind: 'item-message', data: { key: 'w/A1', text: 'm1' }, reply: null };
  const working = { m1: '2026-10-23T10:01:00Z' };
  assert.deepEqual(threadOf('w/A1', { events: [msg], working }).map(({ state, since }) => [state, since]), [['working', '2026-10-23T10:01:00Z']]);
  assert.deepEqual(threadOf('w/A1', { events: [msg], working, listening: true }).map(({ state }) => state), ['working']);
  assert.deepEqual(threadOf('w/A1', { events: [msg], working, listening: false }).map(({ state, since }) => [state, since]), [['waiting', undefined]]);
  const answered = threadOf('w/A1', { events: [msg], working, listening: false, clearedAt: '2026-10-23T10:05:00Z' });
  assert.equal(answered[0].state, 'answered');
});

test("withHub reads a card and its New ask waiting once the session stops listening, and leaves the shared build's pulls alone", () => {
  const ask = { id: 'a1', ts: '2026-10-23T08:00:00Z', kind: 'ask', data: { text: 'Hi' }, reply: null };
  const files = [{ slug: 'w', itemFile: { items: [{ id: 'T-1', title: 'Hi', from_ask: 'a1' }] } }];
  const built = buildBoard({ fromWaves: false, files, events: [ask], working: { a1: '2026-10-23T08:01:00Z' } });
  const card = (b) => b.items.find((i) => i.key === 'w/T-1');
  assert.deepEqual([card(built).working, card(built).ask.state, card(built).ask.since], [true, 'working', '2026-10-23T08:01:00Z']);
  assert.deepEqual([card(withHub(built, { listen: 'listening' })).working, card(withHub(built, { listen: 'listening' })).ask.state], [true, 'working']);
  for (const listen of ['asleep', 'waking', 'deaf']) {
    const shown = card(withHub(built, { listen }));
    assert.deepEqual([shown.working, shown.ask.state, shown.ask.since], [false, 'waiting', undefined], listen);
  }
  assert.equal(card(built).ask.state, 'working', 'the shared build is not changed');
  assert.deepEqual(built.workingOn.map((w) => w.id), ['a1']);
});

// docs/adr/2026-11-12-0200-sorting-a-card-answers-its-own-ask.md
test("a card's own ask reads answered once the card has a phase, so a readied Quick build pulls; the owner's other messages stay working, and a ready card working still pulls", () => {
  const ask = { id: 'a1', ts: '2026-10-23T08:00:00Z', kind: 'ask', data: { text: 'Hi' }, reply: null };
  const msg = { id: 'm1', ts: '2026-10-23T08:30:00Z', kind: 'item-message', data: { key: 'w/T-1', text: 'more' }, reply: null };
  const working = { a1: '2026-10-23T08:01:00Z', m1: '2026-10-23T08:31:00Z' };
  const built = (events, phase) => buildBoard({ fromWaves: false, events, working, files: [{ slug: 'w', itemFile: { items: [{ id: 'T-1', title: 'feat: hi', from_ask: 'a1', ...(phase ? { phase } : {}) }] } }] });
  const card = (b) => b.items.find((i) => i.key === 'w/T-1');
  const unsorted = built([ask]);
  assert.equal(card(unsorted).working, true, 'a New task keeps working');
  const ready = built([ask], 'ready');
  assert.deepEqual([card(ready).working, pullOf(ready.items).pullable.includes('w/T-1')], [false, true]);
  assert.equal(card(built([ask], 'grilling')).working, false);
  const both = built([ask, msg], 'ready');
  // docs/adr/2026-11-13-1800-every-wait-is-listed-and-working-is-display-only.md: T-175 sat ready behind a working mark.
  assert.deepEqual([card(both).working, pullOf(both.items).pullable.includes('w/T-1')], [true, true], 'a later message still works, and the ready card pulls');
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

const askAt = (id, ts, extra = {}) => ({ id, ts, kind: 'ask', data: { text: `${id} first line\nmore` }, reply: null, ...extra });
function askBoard(events, { working = {}, items = [{ id: 'A1', title: 'One', lane: 'progress' }], agents = {}, now = Date.parse('2026-10-23T12:00:00Z') } = {}) {
  return buildBoard({ fromWaves: false, now, files: [{ slug: 'w', agents, itemFile: { items } }], events, working });
}

test("a task Claude answered with an open question waits in In Review on its Open questions, never Done, until its questions are settled and it is closed", () => {
  const ask = askAt('a1', '2026-10-23T09:00:00Z');
  const owner = { items: [{ id: 'q1', topic: 'item:w/T-1', question: 'Which screen?', options: [{ id: 'A', label: 'Home' }] }] };
  const answer = { id: 'ans', ts: '2026-10-23T09:30:00Z', kind: 'owner-answer', data: { id: 'q1', choice: 'A' }, reply: null };
  const threads = { 'w/T-1': [{ ts: '2026-10-23T09:10:00Z', who: 'claude', text: 'One question first.' }] };
  const build = (events = []) => buildBoard({ fromWaves: false, now: Date.parse('2026-10-23T12:00:00Z'), threads, owner, events: [ask, ...events],
    files: [{ slug: 'w', itemFile: { items: [{ id: 'T-1', title: 'a1 first line', from_ask: 'a1', answered_at: '2026-10-23T09:10:00Z' }] } }] });
  const card = (events) => {
    const i = build(events).items.find((x) => x.key === 'w/T-1');
    return [i.lane, i.waitsOn, Boolean(i.isNew), i.awaitsDone, i.action?.kind ?? null, i.actionButton];
  };
  assert.deepEqual(card(), ['review', 'owner', false, false, 'questions', 'openQuestions']);
  assert.deepEqual(build().needs.map((n) => [n.kind, n.text]), [['Question', 'T-1: a1 first line · 1 question']]);
  assert.deepEqual(card([answer]), ['review', null, false, false, null, 'openQuestions']);
  assert.deepEqual(card([{ ...answer, reply: { html: 'Home it is.' } }]), ['review', 'owner', false, true, null, 'openQuestions']);
  assert.deepEqual(card([{ id: 'd1', ts: '2026-10-23T09:40:00Z', kind: 'card-done', data: { key: 'w/T-1' } }]), ['done', null, false, false, null, 'openQuestions']);
});

test('a new task is a New card in Todo with no action while it waits or works, waits for the owner\'s Done in In Review once Claude answers it, and is Done once closed', () => {
  const asks = [askAt('a1', '2026-10-23T09:00:00Z'), askAt('a2', '2026-10-23T10:00:00Z'), askAt('a3', '2026-10-23T08:00:00Z', { reply: { html: 'Yes.' } }), askAt('a4', '2026-10-23T07:00:00Z')];
  const threads = { 'ask:a4': [{ ts: '2026-10-23T07:30:00Z', who: 'claude', text: 'Answered here.' }, { ts: '2026-10-23T07:40:00Z', who: 'Sam', via: 'slack', text: 'Agreed' }] };
  const items = [{ id: 'A1', title: 'One', lane: 'progress' },
    { id: 'T-1', title: 'a1 first line', from_ask: 'a1' }, { id: 'T-2', title: 'a2 first line', from_ask: 'a2' },
    { id: 'T-3', title: 'a3 first line', from_ask: 'a3', answered_at: '2026-10-23T08:05:00Z' },
    { id: 'T-4', title: 'a4 first line', from_ask: 'a4', answered_at: '2026-10-23T07:30:00Z', lane: 'done', closed_at: '2026-10-23T07:50:00Z' }];
  const b = buildBoard({ fromWaves: false, now: Date.parse('2026-10-23T12:00:00Z'), files: [{ slug: 'w', itemFile: { items } }], events: asks, threads, working: { a2: '2026-10-23T10:01:00Z' } });
  const cards = b.items.filter((i) => i.fromAsk).map((i) => [i.key, i.lane, i.ref, Boolean(i.isNew), i.ask?.state ?? null, i.working, i.awaitsDone, i.action]);
  assert.deepEqual(cards, [
    ['w/T-3', 'review', 'T-3', false, null, false, true, null],
    ['w/T-1', 'todo', 'T-1', true, 'waiting', false, false, null],
    ['w/T-2', 'todo', 'T-2', true, 'working', true, false, null],
    ['w/T-4', 'done', 'T-4', false, null, false, false, null],
  ]);
  assert.equal(b.items.some((i) => i.kind === 'ask'), false);
  assert.deepEqual(b.items.find((i) => i.key === 'w/T-4').othersAt, ['2026-10-23T07:30:00Z']);
  assert.equal(b.working, 1);
  assert.deepEqual(b.needs, []);
  const msgs = threadOf('w/T-3', { events: [askAt('a3', '2026-10-23T08:00:00Z', { reply: { html: 'Yes.' } })], fromAsk: 'a3' });
  assert.deepEqual(msgs.map(({ who, text, state, reply }) => [who, text, state, reply]), [['love', 'a3 first line\nmore', 'replied', { html: 'Yes.' }]]);
});

test('Todo lists bumped cards first, the earliest bump on top, then the rest oldest first, so a New ask\'s card sits below the older work', () => {
  const bump = (key, ts) => ({ id: 'b' + ts, ts, kind: 'card-bump', data: { key }, reply: null });
  const asks = [askAt('a1', '2026-10-23T09:00:00Z'), askAt('a2', '2026-10-23T10:00:00Z'), askAt('a3', '2026-10-23T11:00:00Z')];
  const items = [{ id: 'T1', title: 'Planned' }, ...['a1', 'a2', 'a3'].map((id, n) => ({ id: `T-${n + 1}`, title: id, created: '2026-10-23T11:59:00Z', from_ask: id }))];
  const order = (events) => askBoard([...asks, ...events, bump('w/T1', '2026-10-23T11:50:00Z')], { items }).items.filter((i) => i.lane === 'todo').map((i) => i.key);
  assert.deepEqual(order([]), ['w/T1', 'w/T-1', 'w/T-2', 'w/T-3']);
  assert.deepEqual(order([bump('w/T-3', '2026-10-23T11:10:00Z'), bump('w/T-2', '2026-10-23T11:20:00Z')]), ['w/T-3', 'w/T-2', 'w/T1', 'w/T-1']);
  assert.deepEqual(order([bump('w/T-3', '2026-10-23T11:30:00Z'), bump('w/T-2', '2026-10-23T11:20:00Z')]), ['w/T-2', 'w/T-3', 'w/T1', 'w/T-1']);
});

// docs/adr/2026-11-10-1200-an-ask-is-titled-in-place-and-wears-an-ask-badge.md
test("a card filed from an ask takes the ask's place in Todo, by when it was sent", () => {
  const asks = [askAt('a2', '2026-10-23T09:00:00Z'), askAt('a3', '2026-10-23T10:00:00Z')];
  const items = [{ id: 'T1', title: 'Sent between', created: '2026-10-23T09:30:00Z' }, { id: 'F1', title: 'Filed from a2', created: '2026-10-23T11:00:00Z', from_ask: 'a2' },
    { id: 'F2', title: 'Filed from a3', created: '2026-10-23T10:00:01Z', from_ask: 'a3' }];
  const b = buildBoard({ fromWaves: false, now: Date.parse('2026-10-23T12:00:00Z'), files: [{ slug: 'w', itemFile: { items } }], events: asks });
  const of = (key) => b.items.find((i) => i.key === key);
  assert.deepEqual([of('w/F1').created, of('w/F1').sortAt], ['2026-10-23T09:00:00Z', '2026-10-23T09:00:00Z']);
  assert.deepEqual(b.items.filter((i) => i.lane === 'todo').map((i) => i.key), ['w/F1', 'w/T1', 'w/F2']);
});

test("an ask that became work or was folded into a card has no row of its own: that card's thread holds it and its thread, a folded one marked Moved, its old links open that card, and one with no card yet is unfiled", () => {
  const shot = { name: 'shot.png', url: 'uploads/1-shot.png', type: 'image/png' };
  const ask = askAt('a1', '2026-10-23T09:00:00Z', { data: { text: 'Fix the header', files: [shot] } });
  const items = [{ id: 'A1', title: 'Header spacing', lane: 'progress', from_ask: 'a1' }];
  const b = askBoard([ask, askAt('a2', '2026-10-23T10:00:00Z')], { items, agents: runningBuilders('A1'), working: { a1: '2026-10-23T09:01:00Z' } });
  assert.deepEqual(b.items.map((i) => [i.key, i.lane, i.title, i.working]), [['w/A1', 'progress', 'Header spacing', true]]);
  assert.deepEqual([b.moved, b.unfiled], [{ 'ask:a1': 'w/A1' }, ['a2']]);
  assert.equal(b.working, 1);
  const linked = threadOf('ask:a1', { events: [ask], working: { a1: '2026-10-23T09:01:00Z' }, links: [{ key: 'site/S21', ref: 'INT-21', became: true }, { key: 'w/B5', ref: 'B5', became: false }] });
  assert.deepEqual(linked.map(({ who, kind, text, link, state }) => [who, kind, text, link, state]), [
    ['love', 'ask', 'Fix the header', undefined, 'answered'], ['claude', 'ask-link', 'Became INT-21', '#selectedCard=site%2FS21', undefined], ['claude', 'ask-link', 'Added to B5', '#selectedCard=w%2FB5', undefined],
  ]);
  const folded = askAt('a3', '2026-10-23T09:00:00Z');
  const later = { id: 'm3', ts: '2026-10-23T09:10:00Z', kind: 'item-message', data: { key: 'ask:a3', text: 'And the footer' }, reply: null };
  const related = buildBoard({ fromWaves: false, askLinks: { a3: 'site/S4' }, events: [folded, later], working: { a3: '2026-10-23T09:01:00Z' },
    files: [{ slug: 'site', agents: runningBuilders('S4'), itemFile: { internal: true, items: [{ id: 'S4', title: 'Four', lane: 'progress' }] } }] });
  assert.deepEqual([related.items.map((i) => [i.key, i.lane, i.threadCount]), related.moved, related.unfiled, related.working], [[['site/S4', 'progress', 2]], { 'ask:a3': 'site/S4' }, [], 0]);
  assert.deepEqual(threadOf('ask:a3', { events: [folded, later], links: [{ key: 'site/S4', ref: 'S4', title: 'Four', became: false, folded: true }] })
    .filter((m) => m.kind === 'ask-link').map((m) => [m.text, m.link]), [['Moved to S4', '#selectedCard=site%2FS4']]);
  const movedIn = threadOf('site/S4', { events: [folded, later], moved: ['a3'], lines: [{ ts: '2026-10-23T09:20:00Z', who: 'claude', text: 'Folded in.' }] });
  assert.deepEqual(movedIn.map(({ kind, text, moved, state }) => [kind, text, moved, state]), [['ask', 'a3 first line\nmore', true, 'answered'], ['item-message', 'And the footer', undefined, 'answered'], [undefined, 'Folded in.', undefined, undefined]]);
  const lines = [{ ts: '2026-10-23T09:05:00Z', who: 'claude', text: 'Building it.' }];
  const msgs = threadOf('w/A1', { lines, events: [ask], working: { a1: '2026-10-23T09:01:00Z' }, fromAsk: 'a1' });
  assert.deepEqual(msgs.map(({ who, text, files, state, moved }) => [who, text, files, state, moved]), [['love', 'Fix the header', [shot], 'answered', undefined], ['claude', 'Building it.', undefined, undefined, undefined]]);
});

test("a New card asked whether to move waits on the owner in Todo, then a move drops its card, leaving the ask neither unfiled nor an answer, with a line linking to its card on the other board, where it reads as moved from here", () => {
  const ask = askAt('a1', '2026-10-23T09:00:00Z');
  const owner = { items: [{ id: 'mv', topic: 'item:w/T-1', question: 'Move it?', options: [{ id: 'move', label: 'Move to Audit', recommended: true }, { id: 'keep', label: 'Keep here' }] }] };
  const files = [{ slug: 'w', itemFile: { items: [{ id: 'T-1', title: 'a1 first line', from_ask: 'a1' }] } }];
  const asked = buildBoard({ fromWaves: false, now: Date.parse('2026-10-23T12:00:00Z'), files, events: [ask], owner });
  const card = asked.items[0];
  assert.deepEqual([card.key, card.lane, card.isNew, card.action, card.next, card.actionButton], ['w/T-1', 'todo', true, { kind: 'questions', url: 'questions.html#mv', label: 'Answer 1 question' }, 'Answer 1 question', 'openQuestions']);
  assert.deepEqual(asked.needs.map((n) => [n.kind, n.url]), [['Question', '#selectedCard=w%2FT-1']]);
  const answer = { id: 'ans', ts: '2026-10-23T09:30:00Z', kind: 'owner-answer', data: { id: 'mv', choice: 'move' }, reply: null };
  const back = buildBoard({ fromWaves: false, now: Date.parse('2026-10-23T12:00:00Z'), files, events: [ask, answer], owner }).items[0];
  assert.deepEqual([back.lane, back.isNew, back.action, back.actionButton], ['todo', true, null, 'openQuestions']);
  // The move drops the unstarted card and writes the ask-moved line in the ask's thread.
  const link = '/audit/#selectedCard=ask%3Ab1';
  const line = { ts: '2026-10-23T09:40:00Z', who: 'claude', kind: 'hub', line: 'ask-moved', text: 'Moved to Audit.', link };
  const moved = buildBoard({ fromWaves: false, now: Date.parse('2026-10-23T12:00:00Z'), files: [], events: [ask, answer], owner, threads: { 'ask:a1': [line] } });
  assert.deepEqual([moved.items, moved.unfiled, moved.answers], [[], [], []]);
  assert.deepEqual(threadOf('ask:a1', { events: [ask], lines: [line] }).map(({ who, text, link: l }) => [who, text, l]), [['love', 'a1 first line\nmore', undefined], ['claude', 'Moved to Audit.', link]]);
  const arrived = askAt('b1', '2026-10-23T09:40:00Z', { data: { text: 'Fix the header', from: { route: 'orch', title: 'Orch', id: 'a1' } } });
  const there = buildBoard({ fromWaves: false, files: [{ slug: 'w', itemFile: { items: [{ id: 'T-1', title: 'Fix the header', from_ask: 'b1' }] } }], events: [arrived] }).items[0];
  assert.deepEqual([there.lane, there.isNew, there.title, there.ask.from], ['todo', true, 'Fix the header', 'Orch']);
  assert.equal(threadOf('w/T-1', { events: [arrived], fromAsk: 'b1' })[0].from, 'Orch');
});

// docs/adr/2026-11-12-2345-a-haiku-router-files-each-incoming-request-on-a-board.md
test("a routed ask's thread opens with a blue status line naming where it came from and the router's reason, above the ask", () => {
  const routed = { reason: 'checkout is the shop', via: 'slack', by: 'Maya', link: 'https://slack.com/archives/D1/p1', at: '2026-10-23T09:39:59Z' };
  const arrived = askAt('b1', '2026-10-23T09:40:00Z', { data: { text: 'The checkout 500s', routed } });
  const msgs = threadOf('w/T-1', { events: [arrived], fromAsk: 'b1' });
  assert.deepEqual(msgs.map(({ who, kind, line, text, link, ts }) => [who, kind, line, text, link, ts]), [
    ['claude', 'hub', 'ask-routed', 'Routed here from Slack: checkout is the shop', 'https://slack.com/archives/D1/p1', '2026-10-23T09:39:59Z'],
    ['love', 'ask', undefined, 'The checkout 500s', undefined, '2026-10-23T09:40:00Z'],
  ]);
  assert.equal(msgs[0].mark, 'ask-link');
  assert.equal(threadOf('w/T-1', { events: [askAt('b2', '2026-10-23T09:40:00Z')], fromAsk: 'b2' }).length, 1, 'an ask the router never saw has no routed line');
});

test("the owner's reply on a Done ask's card, sent on the card or the ask's old key, waits and works like a work item's thread message, and reopens the card", () => {
  const ask = askAt('a1', '2026-10-23T09:00:00Z', { reply: { html: 'Yes.' } });
  const working = { m1: '2026-10-23T10:01:00Z' };
  const items = [{ id: 'T-1', title: 'a1 first line', from_ask: 'a1', answered_at: '2026-10-23T09:05:00Z', lane: 'done', closed_at: '2026-10-23T09:30:00Z' }];
  for (const key of ['w/T-1', 'ask:a1']) {
    const msg = { id: 'm1', ts: '2026-10-23T10:00:00Z', kind: 'item-message', data: { key, text: 'One more thing' }, reply: null };
    const msgs = threadOf('w/T-1', { events: [ask, msg], working, fromAsk: 'a1' });
    assert.deepEqual(msgs.map(({ eventId, state }) => [eventId, state]), [['a1', 'replied'], ['m1', 'working']]);
    const b = askBoard([ask, msg], { working, items });
    const item = b.items.find((i) => i.key === 'w/T-1');
    assert.deepEqual([item.lane, item.reopened, item.working, item.threadCount, b.working], ['review', true, true, 2, 1]);
  }
});

test("the board lists the cards Claude answered before they were sorted, newest Claude line first, leaving out New, sorted and folded asks' cards", () => {
  const events = [
    askAt('a1', '2026-10-23T08:00:00Z', { reply: { html: 'No.', at: '2026-10-23T08:10:00Z' } }),
    askAt('a2', '2026-10-23T09:00:00Z'),
    askAt('a3', '2026-10-23T09:30:00Z', { reply: { html: 'Building it.', at: '2026-10-23T09:40:00Z' } }),
    askAt('a4', '2026-10-23T10:00:00Z', { reply: { html: 'On it.', at: '2026-10-23T10:05:00Z' } }),
    askAt('a5', '2026-10-23T10:30:00Z'),
  ];
  const threads = {
    'ask:a1': [{ ts: '2026-10-23T11:20:00Z', who: 'claude', text: 'More on that.' }, { ts: '2026-10-23T11:30:00Z', who: 'claude', kind: 'status', text: 'Checking' }],
    'w/T-5': [{ ts: '2026-10-23T10:40:00Z', who: 'claude', text: 'Yes, it is.' }],
  };
  const b = buildBoard({
    fromWaves: false, now: Date.parse('2026-10-23T12:00:00Z'), events, threads, askLinks: { a4: 'w/A1' },
    files: [{ slug: 'w', itemFile: { items: [{ id: 'A1', title: 'One', lane: 'progress' },
      { id: 'T-1', title: 'a1 first line', from_ask: 'a1', answered_at: '2026-10-23T08:10:00Z' }, { id: 'T-2', title: 'a2 first line', from_ask: 'a2' },
      { id: 'A2', title: 'Two', lane: 'progress', from_ask: 'a3', phase: 'grilling' }, { id: 'T-5', title: 'a5 first line', from_ask: 'a5', answered_at: '2026-10-23T10:40:00Z' }] } }],
  });
  assert.deepEqual(b.answers, [
    { key: 'w/T-1', id: 'T-1', text: 'a1 first line', at: '2026-10-23T11:20:00Z' },
    { key: 'w/T-5', id: 'T-5', text: 'a5 first line', at: '2026-10-23T10:40:00Z' },
  ]);
});

test("with auto-merge off an approved, green, clean PR waits on the owner's Merge, reads merging until Claude writes after it, and with it on waits on monitor", () => {
  const clean = { state: 'OPEN', isDraft: false, reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', checks: { state: 'pass' }, reviews: {} };
  const card = ({ pr = clean, autoMerge, events = [], threads = {}, item = {} } = {}) => buildBoard({
    fromWaves: false, autoMerge, events, threads, prs: { 'o/r#7': pr },
    files: [{ slug: 'w', itemFile: { repo: 'o/r', items: [{ id: 'A1', title: 'One', pr: 7, ...item }] } }],
  });
  const off = card();
  const it = off.items[0];
  assert.deepEqual([it.lane, it.waitsOn, it.merging, it.next, it.action, it.resolvedBy], ['review', 'merge', false, 'Approved and green: tap Merge', { kind: 'merge', url: '#selectedCard=w%2FA1', label: 'Merge' }, 'merge']);
  assert.deepEqual(needsAnswer(off).items, [{ kind: 'Action needed', text: 'A1: One · Merge', url: '#selectedCard=w%2FA1' }]);
  for (const pr of [{ ...clean, mergeStateStatus: 'BLOCKED' }, { ...clean, checks: { state: 'pending' } }, { ...clean, reviewDecision: 'REVIEW_REQUIRED' }]) {
    assert.equal(card({ pr }).items[0].action, null, JSON.stringify(pr));
  }
  assert.equal(card({ pr: { ...clean, mergeStateStatus: 'BLOCKED' } }).items[0].next, 'Approved, Merge shows once CI and the merge state allow');
  assert.equal(card({ item: { held: true, pr: undefined } }).items[0].action, null);
  // docs: a card that left Todo never reads held, whatever old data says.
  const leftTodo = card({ item: { held: true, pick_up_at: '2026-11-05T17:00:00.000Z' } }).items[0];
  assert.deepEqual([leftTodo.lane, leftTodo.held, leftTodo.heldUntil], ['review', false, null]);
  const doneHeld = card({ item: { held: true, lane: 'done', pr: undefined } }).items[0];
  assert.deepEqual([doneHeld.lane, doneHeld.held], ['done', false]);
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
    files: [{ slug: 'w', itemFile: { repo: 'o/r', items: [{ id: 'A1', title: 'One', pr: 7 }] } }],
  }).items[0];
  const off = card();
  assert.deepEqual([off.lane, off.waitsOn, off.next, off.action], ['review', 'merge', 'Ready and green: tap Merge', { kind: 'merge', url: '#selectedCard=w%2FA1', label: 'Merge' }]);
  const pending = card({ pr: { ...ready, checks: { state: 'pending' } } });
  assert.deepEqual([pending.waitsOn, pending.next, pending.action], ['merge', 'Ready, Merge shows once CI and the merge state allow', null]);
  assert.equal(card({ pr: { ...ready, reviewDecision: 'CHANGES_REQUESTED' } }).action, null);
  const auto = card({ autoMerge: true });
  assert.deepEqual([auto.waitsOn, auto.next, auto.action], ['merge', 'Ready, merges once CI and the merge state allow', null]);
  const reviewed = card({ reviewers: [{ name: 'Ann', github: 'ann' }] });
  assert.deepEqual([reviewed.waitsOn, reviewed.next, reviewed.action], ['reviewers', 'Waiting for PR reviewers', null]);
});

// docs/adr/2026-11-06-0102-a-block-past-todo-bumps-a-build-and-holds-a-land.md
test('a blocked card waiting on its Merge stays In Review with no Action needed, its Merge disabled and naming what blocks it', () => {
  const clean = { state: 'OPEN', isDraft: false, reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', checks: { state: 'pass' }, reviews: {} };
  const card = (item, { autoMerge } = {}) => buildBoard({
    fromWaves: true, autoMerge, branch: 'trunk', prs: { 'o/r#7': clean },
    files: [{ slug: 'w', itemFile: { repo: 'o/r', items: [{ id: 'A1', title: 'One', ...item }, { id: 'B2', title: 'Two' }] } }],
  }).items.find((i) => i.id === 'A1');
  const byDep = card({ pr: 7, deps: ['B2'] });
  assert.deepEqual([byDep.lane, byDep.waitsOn, byDep.action, byDep.mergeBlocked, byDep.next], ['review', 'merge', null, 'Blocked by B2', 'Merges once unblocked']);
  const held = card({ branch: 'A1', merge_ready: { branch: 'A1', at: '2026-11-04T10:00:00Z' }, deps: ['B2'], blocked_until: 'the API ships' }, { autoMerge: true });
  assert.deepEqual([held.lane, held.action, held.mergeBlocked], ['review', null, 'Blocked by B2 and until the API ships']);
  const free = card({ pr: 7 });
  assert.deepEqual([free.action?.kind, free.mergeBlocked], ['merge', null]);
});

test("a verified branch held for the owner's Merge waits In Review on it with Merge, Auto-merge on or not, reads merging from the tap until Claude writes, and is Done once it lands", () => {
  const heldAt = '2026-11-04T10:00:00Z';
  const card = ({ item = {}, autoMerge, threads = {}, agents = {} } = {}) => buildBoard({
    fromWaves: true, autoMerge, threads, branch: 'trunk',
    files: [{ slug: 'w', agents, itemFile: { items: [{ id: 'A1', title: 'One', branch: 'A1', merge_ready: { branch: 'A1', at: heldAt }, ...item }] } }],
  }).items[0];
  for (const autoMerge of [false, true]) {
    const it = card({ autoMerge });
    assert.deepEqual([it.lane, it.waitsOn, it.next, it.action, it.resolvedBy, it.pr], ['review', 'merge', 'Verified: tap Merge to land it on trunk', { kind: 'merge', url: '#selectedCard=w%2FA1', label: 'Merge' }, 'merge', null]);
    assert.deepEqual(it.mergeReady, { branch: 'A1', at: heldAt, base: 'trunk' });
  }
  assert.equal(card({ item: { manual_steps: ['Run the backfill'] } }).action.kind, 'merge');
  const tapped = { branch: 'A1', at: heldAt, tapped: '2026-11-04T11:00:00Z' };
  const merging = card({ item: { merge_ready: tapped } });
  assert.deepEqual([merging.merging, merging.action, merging.next], [true, null, 'Merging']);
  const queued = card({ item: { merge_ready: tapped }, threads: { 'w/A1': [{ ts: '2026-11-04T11:00:30Z', who: 'claude', kind: 'hub', line: 'land-waiting', text: 'Waiting for #210 to land' }] } });
  assert.deepEqual([queued.merging, queued.action, queued.next], [true, null, 'Merging · waiting for #210 to land']);
  const refused = card({ item: { merge_ready: tapped }, threads: { 'w/A1': [{ ts: '2026-11-04T11:01:00Z', who: 'claude', kind: 'hub', line: 'land-failed', text: 'Not merged: main moved. Tap Merge again.' }] } });
  assert.deepEqual([refused.merging, refused.action?.kind], [false, 'merge']);
  const handedOff = card({ item: { merge_ready: tapped }, threads: { 'w/A1': [
    { ts: '2026-11-04T11:01:00Z', who: 'claude', kind: 'hub', line: 'lander-handoff', text: 'Not merged yet: rebasing A1 onto main conflicts in a.txt. Its builder resumes to fix it and land it.' },
  ] } });
  assert.deepEqual([handedOff.merging, handedOff.action], [true, null]);
  // docs/adr/2026-11-06-1546-only-a-run-that-changes-code-moves-an-in-review-card.md: the lander stays In Review; a
  // builder changing the branch's code moves it.
  const landing = card({ item: { merge_ready: tapped }, agents: { A1: { main: { kind: 'claude', label: 'Lander', started: '2026-11-04T11:02:00Z' } } } });
  assert.deepEqual([landing.lane, landing.waitsOn, landing.action], ['review', 'builder', null]);
  const fixing = card({ item: { merge_ready: tapped }, agents: runningBuilders('A1') });
  assert.deepEqual([fixing.lane, fixing.waitsOn, fixing.action], ['progress', 'builder', null]);
  const done = card({ item: { lane: 'done' } });
  assert.deepEqual([done.lane, done.mergeReady, done.action], ['done', null, null]);
});

test("a merge-ready card keeps its place in In Review through a Merge tap, a Waiting line, a lander and a thread message", () => {
  const held = (id, arrived) => ({ id, title: id, branch: id, review_since: arrived, merge_ready: { branch: id, at: '2026-11-04T20:00:00Z' } });
  const build = (a = {}, threads = {}, agents = {}) => buildBoard({
    fromWaves: true, branch: 'trunk', threads, now: Date.parse('2026-11-05T00:00:00Z'),
    files: [{ slug: 'w', agents, itemFile: { items: [{ ...held('A', '2026-11-04T08:00:00.000Z'), ...a }, held('B', '2026-11-04T09:00:00.000Z')] } }],
  });
  const order = (b) => b.items.map((i) => i.id);
  const before = build();
  assert.deepEqual(order(before), ['B', 'A']);
  const after = build(
    { merge_ready: { branch: 'A', at: '2026-11-04T22:00:00Z', tapped: '2026-11-04T22:30:00Z' } },
    { 'w/A': [
      { ts: '2026-11-04T22:30:10Z', who: 'claude', kind: 'hub', line: 'land-waiting', text: 'Waiting for #210 to land' },
      { ts: '2026-11-04T23:00:00Z', who: 'owner', text: 'one more thing' },
    ] },
    { lander: { kind: 'lander', started: '2026-11-04T23:10:00Z' } },
  );
  assert.deepEqual(order(after), ['B', 'A']);
  const sortAt = (b) => b.items.find((i) => i.id === 'A').sortAt;
  assert.equal(sortAt(after), sortAt(before));
  assert.equal(sortAt(after), '2026-11-04T08:00:00.000Z');
});

test("an unstarted Todo card that waits on nothing from the owner can Build, a blocked one too, which the idle pull skips", () => {
  const q = { id: 'q1', topic: 'item:w/A1', question: 'Which way?', options: [{ id: 'A', label: 'One' }] };
  const card = ({ item = {}, events = [], threads = {}, owner = {}, agents = {}, dep } = {}) => buildBoard({
    fromWaves: false, events, threads, owner, prs: {},
    files: [{ slug: 'w', agents, itemFile: { repo: 'o/r', items: [{ id: 'A1', title: 'One', ...item }, ...(dep ? [{ id: 'A2', title: 'Two', status: dep }] : []), { id: 'ENG-1', title: 'Later', created: '2026-10-22T00:00:00Z', parent: 'A1' }] } }],
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
  assert.equal(one(card({ item: { lane: 'done' } })).buildable, false);

  // A prototype answer with no take picked leaves the card unready to build and prototyping again; a pick, note or not, makes it ready (docs/adr/2026-11-03-1646-a-prototype-answer-with-no-pick-prototypes-again.md).
  const takes = { id: 'p1', topic: 'item:w/A1', question: 'Which take?', url: 'prototype-x.html?q=p1', options: [{ id: 'A', label: 'One' }, { id: 'B', label: 'Two' }] };
  const answer = (n, choice, note) => ({ id: `a${n}`, ts: `2026-10-23T10:0${n}:00Z`, kind: 'owner-answer', data: { id: 'p1', choice, note }, reply: null });
  const unpicked = card({ owner: { items: [takes] }, events: [answer(1, 'A', ''), answer(2, null, 'Neither: try a darker moon')] });
  assert.deepEqual([one(unpicked).lane, one(unpicked).buildable, one(unpicked).next, one(unpicked).action, one(unpicked).phase], ['todo', false, PROTOTYPE_AGAIN, null, 'prototyping']);
  // A card prototyping again has had its questions, so it is no arrival for the board to grill.
  assert.deepEqual(arrivalsOf(unpicked.items), ['w/ENG-1'], 'its fresh follow-up arrives, the task itself does not');
  const picked = card({ owner: { items: [takes] }, events: [answer(2, null, 'Neither'), answer(3, 'B', 'but with the moon on the left')] });
  assert.deepEqual([one(picked).buildable, one(picked).next, one(picked).phase], [true, null, 'new']);
  // A prototype request on any of the card's questions is its newest input the same way, until the next round's pick
  // (docs/adr/2026-11-03-1803-a-question-asked-for-a-prototype-is-resolved.md).
  const plain = { id: 'q0', topic: 'item:w/A1', question: 'Where?', options: [{ id: 'A', label: 'Top' }], resolved: 'Prototype requested', resolved_at: '2026-10-23T10:04:01Z' };
  const request = { id: 'r4', ts: '2026-10-23T10:04:00Z', kind: 'prototype-request', data: { key: 'w/A1', question: 'q0', note: 'on a phone', choice: 'A' }, reply: null };
  const asked = card({ owner: { items: [plain, takes] }, events: [answer(3, 'B', ''), request] });
  assert.deepEqual([one(asked).buildable, one(asked).next, one(asked).phase], [false, PROTOTYPE_AGAIN, 'prototyping']);
  const next = card({ owner: { items: [plain, takes] }, events: [request, answer(5, 'B', '')] });
  assert.deepEqual([one(next).buildable, one(next).phase], [true, 'new']);
});

test("a Build the board started is In Progress reading starting until its builder's first status line, and a refused one stays in Todo with its reason while that is the card's newest line", () => {
  const card = ({ item = {}, threads = {}, agents = {} } = {}) => buildBoard({
    fromWaves: false, events: [], threads, owner: {}, prs: {}, now: Date.parse('2026-10-29T10:05:00Z'),
    files: [{ slug: 'w', agents, itemFile: { repo: 'o/r', items: [{ id: 'A1', title: 'One', ...item }] } }],
  }).items[0];
  const tapped = { A1: { main: { label: 'Opus builder', kind: 'opus', started: '2026-10-29T10:00:00Z', dispatched: 'tap' } } };
  const starting = card({ item: { lane: 'progress' }, agents: tapped });
  assert.deepEqual([starting.lane, starting.buildable, starting.builder.progress, starting.builder.at], ['progress', false, null, '2026-10-29T10:00:00Z']);
  assert.equal('waiting' in starting.builder, false);
  const line = { ts: '2026-10-29T10:01:00Z', who: 'claude', kind: 'status', phase: 'reading', text: 'Reading: the notes' };
  const going = card({ item: { lane: 'progress' }, agents: tapped, threads: { 'w/A1': [line] } });
  assert.equal(going.builder.progress, 'Reading · the notes');
  // A tap-opened main record and an agent started under another name read the same: starting, then the first line.
  const other = { A1: { ...tapped.A1, codex: { kind: 'codex', started: '2026-10-29T10:02:00Z' } } };
  assert.equal(card({ item: { lane: 'progress' }, agents: other }).builder.progress, null);

  const refused = { ts: '2026-10-29T10:00:00Z', who: 'claude', kind: 'hub', line: 'build-refused', text: "Couldn't start the build: it's held. Resume it, then tap Build." };
  const held = card({ item: { held: true }, threads: { 'w/A1': [refused] } });
  assert.deepEqual([held.lane, held.refusal], ['todo', refused.text]);
  const after = card({ threads: { 'w/A1': [refused, { ts: '2026-10-29T10:03:00Z', who: 'love', text: 'Resumed.' }] } });
  assert.deepEqual([after.lane, after.refusal, after.buildable], ['todo', null, true]);
  const status = card({ threads: { 'w/A1': [refused, { ...line, ts: '2026-10-29T10:03:00Z' }] } });
  assert.equal(status.refusal, refused.text);
  assert.equal(card({ item: { lane: 'progress' }, agents: tapped, threads: { 'w/A1': [refused] } }).refusal, null);
});

test("a card-done moves a card to Done and unblocks dependents at once, unless the card moved lanes after it, and an owner message or question after it reopens it, a merged card too", () => {
  const close = (key, ts) => ({ id: 'c' + ts, ts, kind: 'card-done', data: { key }, reply: null });
  const doneAt = '2026-10-23T11:20:00Z';
  const items = [
    { id: 'A1', title: 'One', lane: 'progress' },
    { id: 'A2', title: 'Two', lane: 'progress', lane_at: doneAt },
    { id: 'A3', title: 'Three' },
    { id: 'A4', title: 'Four', lane: 'done', lane_at: doneAt, closed_at: doneAt },
    { id: 'A5', title: 'Five', deps: ['A1'] },
    { id: 'A6', title: 'Six', deps: ['A4'] },
    { id: 'A7', title: 'Seven', lane: 'done', lane_at: doneAt, closed_at: doneAt, prs: [{ repo: 'o/r', number: 9, merged_at: doneAt }] },
    { id: 'A8', title: 'Eight', lane: 'done', lane_at: doneAt, closed_at: doneAt },
  ];
  const events = [close('w/A1', '2026-10-23T11:00:00Z'), close('w/A2', '2026-10-23T11:10:00Z'), close('w/A4', '2026-10-23T11:10:00Z')];
  const snapshot = { fromWaves: false, now: Date.parse('2026-10-23T12:00:00Z'), files: [{ slug: 'w', agents: runningBuilders('A1', 'A2'), itemFile: { items } }] };
  assert.deepEqual(buildBoard(snapshot).items.find((i) => i.id === 'A5').blockedBy, [{ key: 'w/A1', ref: 'A1', lane: 'progress' }]);
  const b = buildBoard({ ...snapshot, events });
  const cards = Object.fromEntries(b.items.map((i) => [i.id, [i.lane, i.finishable]]));
  assert.deepEqual(cards, {
    A1: ['done', false], A2: ['progress', true], A3: ['todo', true], A4: ['done', false], A5: ['todo', true], A6: ['todo', true], A7: ['done', false], A8: ['done', false],
  });
  const closed = b.items.find((i) => i.id === 'A1');
  assert.deepEqual([closed.closedAt, closed.action, closed.actionButton, closed.next, closed.holdable], ['2026-10-23T11:00:00Z', null, null, null, false]);
  assert.equal(b.items.find((i) => i.id === 'A2').storedLane, 'progress');
  assert.deepEqual(b.items.find((i) => i.id === 'A5').blockedBy, []);

  const msg = (key, ts) => ({ id: `m-${key}-${ts}`, ts, kind: 'item-message', data: { key, text: 'One more thing' }, reply: null });
  const said = { ...snapshot, events: [...events, msg('w/A4', '2026-10-23T11:15:00Z'), msg('w/A4', '2026-10-23T11:30:00Z'), msg('w/A7', '2026-10-23T11:30:00Z')],
    owner: { items: [{ id: 'q1', topic: 'item:w/A8', question: 'Which?', options: [{ id: 'a', label: 'A' }], asked_at: '2026-10-23T11:30:00Z' }] } };
  const card = (s, id) => buildBoard(s).items.find((i) => i.id === id);
  const state = (s, id) => (({ lane, waitsOn, closedAt, action, actionButton, next }) => [lane, waitsOn, closedAt, action?.kind ?? null, actionButton, next])(card(s, id));
  // docs/adr/2026-11-09-1804-in-progress-means-a-builder-runs.md: the reply waits on the orchestrator in In Review.
  assert.deepEqual(state(said, 'A4'), ['review', null, null, null, null, 'Your reply waits on the orchestrator']);
  assert.deepEqual(orchestratorWaits(buildBoard(said)).filter((w) => w.key === 'w/A4').map((w) => [w.kind, w.since, w.next]), [['reply', '2026-10-23T11:30:00Z', "Act on the owner's reply"]]);
  assert.deepEqual(card(said, 'A6').blockedBy, []);
  assert.deepEqual(state(said, 'A7'), ['review', null, null, null, null, 'Your reply waits on the orchestrator']);
  assert.equal(card(said, 'A7').reopened, true);
  assert.deepEqual(state(said, 'A8'), ['review', 'owner', null, 'questions', 'openQuestions', 'Answer 1 question']);
  const answered = { ...said, threads: { 'w/A4': [{ ts: '2026-10-23T11:40:00Z', who: 'claude', text: 'Done that.' }] } };
  assert.deepEqual(state(answered, 'A4'), ['review', 'owner', null, null, null, 'Tap Done']);
  assert.deepEqual((({ awaitsDone, bumpable, resolvedBy }) => [awaitsDone, bumpable, resolvedBy])(card(answered, 'A4')), [true, false, null]);
  const followUp = (next_at) => ({ ...answered, files: [{ ...answered.files[0], itemFile: { items: items.map((i) => (i.id === 'A4' ? { ...i, next: 'Build the fix', next_at } : i)) } }] });
  assert.deepEqual(state(followUp('2026-10-23T11:35:00Z'), 'A4'), ['review', null, null, null, null, 'Build the fix'], 'a Next set after the reopen waits in In Review for its builder');
  const building = { ...followUp('2026-10-23T11:35:00Z'), files: [{ ...followUp('2026-10-23T11:35:00Z').files[0], agents: { A4: { main: { started: '2026-10-23T11:45:00Z' } } } }] };
  assert.deepEqual(state(building, 'A4').slice(0, 2), ['progress', 'builder'], 'its builder takes it to In Progress');
  const built = { ...building, files: [{ ...building.files[0], agents: { A4: { main: { started: '2026-10-23T11:45:00Z', done: '2026-10-23T11:55:00Z' } } } }] };
  assert.equal(state(built, 'A4')[0], 'progress', 'and it stays there once that run ends');
  assert.equal(card(followUp('2026-10-23T11:35:00Z'), 'A4').awaitsDone, false);
  assert.deepEqual(state(followUp('2026-10-23T11:05:00Z'), 'A4'), ['review', 'owner', null, null, null, 'Tap Done'], 'a Next from before the reopen does not');
  assert.deepEqual(needsAnswer(buildBoard(answered)).items.filter((l) => l.url === '#selectedCard=w%2FA4'), []);
  assert.deepEqual(state({ ...answered, events: [...answered.events, close('w/A4', '2026-10-23T11:50:00Z')] }, 'A4'), ['done', null, '2026-10-23T11:50:00Z', null, null, null]);
  const mergedAnswered = { ...said, threads: { 'w/A7': [{ ts: '2026-10-23T11:40:00Z', who: 'claude', text: 'Done that.' }] } };
  assert.deepEqual(state(mergedAnswered, 'A7'), ['review', 'owner', null, null, null, 'Tap Done']);
  assert.deepEqual(state({ ...mergedAnswered, events: [...mergedAnswered.events, close('w/A7', '2026-10-23T11:50:00Z')] }, 'A7'), ['done', null, '2026-10-23T11:50:00Z', null, null, null]);
  assert.equal(card({ ...mergedAnswered, events: [...mergedAnswered.events, close('w/A7', '2026-10-23T11:50:00Z')] }, 'A7').pr.status, 'merged');
});

test('a message on a card whose PR merged reopens it after the merge, not before, and its PR still reads merged; a Done card whose PR closed unmerged stays Done', () => {
  const msg = (ts) => ({ id: `m-${ts}`, ts, kind: 'item-message', data: { key: 'w/A1', text: 'One more thing' }, reply: null });
  const merged = { ...greenDraft, isDraft: false, state: 'MERGED', mergedAt: '2026-10-23T11:00:00Z' };
  const card = (events, item = {}) => board({ pr: merged, events, item: { lane: 'progress', lane_at: '2026-10-23T10:00:00Z', ...item } }).items.find((i) => i.key === 'w/A1');
  assert.deepEqual([card([msg('2026-10-23T10:30:00Z')]).lane, card([]).pr.status], ['done', 'merged']);
  const reopened = card([msg('2026-10-23T11:30:00Z')]);
  assert.deepEqual([reopened.lane, reopened.reopened, reopened.pr.status, reopened.closedAt], ['review', true, 'merged', null]);
  const unlanded = board({ pr: { ...merged, state: 'CLOSED', mergedAt: null }, events: [msg('2026-10-23T11:30:00Z')], item: { lane: 'done', closed_at: '2026-10-23T11:00:00Z' } }).items.find((i) => i.key === 'w/A1');
  assert.deepEqual([unlanded.lane, unlanded.reopened], ['done', false]);
});

test("a card's PR carries one state: open, draft, merged once GitHub or the PR's merge mark on the card says so, closed, or none before GitHub is read", () => {
  const status = (pr, item = {}) => board({ pr, item }).items.find((i) => i.key === 'w/A1').pr.status;
  assert.deepEqual([
    status({ ...greenDraft, isDraft: false }), status(greenDraft), status({ ...greenDraft, state: 'MERGED' }), status({ ...greenDraft, state: 'CLOSED' }),
    status(null), status(null, { lane: 'done', prs: [{ number: 7, merged_at: '2026-10-23T11:00:00Z' }] }), status(null, { prs: [{ number: 7, merged_at: '2026-10-23T11:00:00Z' }] }),
  ], ['open', 'draft', 'merged', 'closed', null, 'merged', 'merged']);
});

test("a card's PRs across repos each carry their own state and link, and the least-ready one decides its lane, Next and Merge", () => {
  const open = { state: 'OPEN', isDraft: false, checks: { state: 'pass' }, reviews: {}, reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED' };
  const approved = { ...open, reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' };
  const card = (prs, item = {}) => buildBoard({
    fromWaves: false, events: [], owner: {}, prs,
    files: [{ slug: 'w', itemFile: { repo: 'o/r', items: [{ id: 'A1', title: 'One', prs: [{ number: 6 }, { repo: 'o/site', number: 1 }], ...item }] } }],
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
  assert.deepEqual([landed.lane, landed.storedLane, landed.pr.status, landed.prs.map((p) => p.status), landed.closedAt], ['done', null, 'merged', ['closed', 'merged'], '2026-11-03T10:00:00Z']);
  const closed = card({ 'o/r#6': { state: 'CLOSED' }, 'o/site#1': { state: 'CLOSED' } });
  assert.deepEqual([closed.lane, closed.pr.status], ['done', 'closed']);
  const older = buildBoard({ fromWaves: false, events: [], owner: {}, prs: { 'o/r#7': greenDraft }, files: [{ slug: 'w', itemFile: { repo: 'o/r', items: [{ id: 'A1', title: 'One', pr: 7 }] } }] }).items[0];
  assert.deepEqual([older.prs.length, older.pr.number, older.pr.repo, older.waitsOn], [1, 7, 'o/r', 'ready']);
});

test('a withdrawn ask leaves the board', () => {
  const b = askBoard([askAt('a1', '2026-10-23T09:00:00Z'), { id: 'w1', ts: '2026-10-23T09:10:00Z', kind: 'ask-withdrawn', data: { id: 'a1' }, reply: null }]);
  assert.deepEqual(b.items.map((i) => i.key), ['w/A1']);
});

// docs/adr/2026-11-06-1700-a-bump-marks-the-priority-through-every-lane.md
test('a bumped card tops its lane, the earliest bump first, a held Todo card bumps too, and so does a draft waiting on Ready', () => {
  const bump = (key, ts) => ({ id: 'c' + ts, ts, kind: 'card-bump', data: { key }, reply: null });
  const items = [
    { id: 'A1', title: 'One' },
    { id: 'A2', title: 'Two' },
    { id: 'A3', title: 'Three' },
    { id: 'A4', title: 'Four', held: true },
    { id: 'A5', title: 'Five', lane: 'progress' },
    { id: 'A6', title: 'Six', lane: 'progress' },
  ];
  const cards = (events) => askBoard(events, { items, agents: runningBuilders('A5', 'A6') }).items.filter((i) => i.kind === 'work').map((i) => [i.key, i.lane, i.bumpable, i.bumpedAt]);
  assert.deepEqual(cards([]).map(([key, , bumpable]) => [key, bumpable]), [['w/A6', true], ['w/A5', true], ['w/A1', true], ['w/A2', true], ['w/A3', true], ['w/A4', true]]);
  const at1 = '2026-10-23T11:10:00Z';
  const at2 = '2026-10-23T11:20:00Z';
  assert.deepEqual(cards([bump('w/A1', at1), bump('w/A2', at2), bump('w/A5', at2), bump('w/A4', at2)]), [
    ['w/A5', 'progress', true, at2],
    ['w/A6', 'progress', true, null],
    ['w/A1', 'todo', true, at1],
    ['w/A2', 'todo', true, at2],
    ['w/A4', 'todo', true, at2],
    ['w/A3', 'todo', true, null],
  ]);
  assert.deepEqual(cards([bump('w/A1', at1), bump('w/A2', at2), bump('w/A1', '2026-10-23T11:30:00Z')]).slice(2, 4).map(([key]) => key), ['w/A2', 'w/A1'], 'a bump again goes behind the earlier bumps');
  const draft = buildBoard({ fromWaves: false, prs: { 'o/r#7': greenDraft }, files: [{ slug: 'w', itemFile: { repo: 'o/r', items: [{ id: 'D1', title: 'Draft', pr: 7 }] } }], events: [bump('w/D1', at1)] }).items[0];
  assert.deepEqual([draft.lane, draft.waitsOn, draft.bumpable, draft.bumpedAt], ['review', 'ready', true, at1]);
});

test('every In Progress card bumps, held or waiting on checking included, and a bump made before the build started stays on the card', () => {
  const bump = (key, ts) => ({ id: 'c' + ts, ts, kind: 'card-bump', data: { key }, reply: null });
  const early = '2026-10-23T09:00:00Z';
  const late = '2026-10-23T11:00:00Z';
  const items = [{ id: 'A1', title: 'Running', lane: 'progress' }, { id: 'A2', title: 'Checking', lane: 'progress' }];
  const handedBack = { main: { started: '2026-10-23T10:00:00Z', done: '2026-10-23T10:30:00Z', handed_back: '2026-10-23T10:30:00Z' } };
  const b = askBoard([bump('w/A1', early), bump('w/A2', late)], { items, agents: { ...runningBuilders('A1'), A2: handedBack } });
  const card = (id) => b.items.find((i) => i.id === id);
  assert.deepEqual(['A1', 'A2'].map((id) => [card(id).lane, card(id).bumpable, card(id).bumpedAt]), [['progress', true, early], ['progress', true, late]]);
  const again = askBoard([bump('w/A1', early), bump('w/A1', late)], { items, agents: runningBuilders('A1') }).items.find((i) => i.id === 'A1');
  assert.equal(again.bumpedAt, late);
});

test('a card-hold applies at once unless held_at is newer, and only cards outside Done can be held; a held card ends at the newest hold time', () => {
  const hold = (key, ts, value) => ({ id: 'h' + ts, ts, kind: 'card-hold', data: { key, hold: value }, reply: null });
  const items = [
    { id: 'A1', title: 'One' },
    { id: 'A2', title: 'Two', held: true, held_at: '2026-10-23T11:05:00Z' },
    { id: 'A3', title: 'Three', lane: 'progress', held: true, held_at: '2026-10-23T11:20:00Z' },
    { id: 'A4', title: 'Four', held_at: '2026-10-23T11:20:00Z' },
    { id: 'A5', title: 'Five', lane: 'done' },
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
test("each lane has one fixed order, each card carrying the time it sorts by: Todo its bumped cards, then oldest made, a card from an ask by when the ask was sent; In Progress and In Review newest arrival first; Done most recently closed first", () => {
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
    { id: 'P3', title: 'p', lane: 'progress', lane_at: at(5), created: made(2) },
    { id: 'P4', title: 'p', lane: 'done', lane_at: at(3), closed_at: at(3), created: made(3) },
    { id: 'T1', title: 't', created: made(8) }, { id: 'T2', title: 't', created: made(4) },
    { id: 'D1', title: 'd', pr: 5, created: made(9) }, { id: 'D2', title: 'd', pr: 6, created: made(1) }, { id: 'D3', title: 'd', lane: 'done', lane_at: at(8), closed_at: at(8), created: made(3) },
    { id: 'D4', title: 'd', created: made(1) },
    { id: 'ENG-1', title: 'f', created: at(2), parent: 'T1' }, { id: 'ENG-2', title: 'f', created: at(6), parent: 'T1' },
    // Cards from asks: New ones, and answered ones closed at their answer.
    { id: 'Q1', title: 'one', from_ask: 'a1', created: at(10) }, { id: 'Q2', title: 'two', from_ask: 'a2', created: at(10) },
    { id: 'Q3', title: 'three', from_ask: 'a3', lane: 'done', closed_at: at(9), created: at(9) }, { id: 'Q4', title: 'four', from_ask: 'a4', lane: 'done', closed_at: at(10), created: at(8) },
  ];
  // P1 entered In Progress when its build began; a later grill doesn't move it, nor does its latest activity.
  const agents = {
    P1: { main: { kind: 'build', started: at(1), progress_at: at(9) }, grill: { kind: 'grill', started: at(9) } },
    P2: { first: { kind: 'build', started: at(2), done: at(3) }, fix: { kind: 'build', started: at(8) } },
    P3: { main: { kind: 'build', started: at(5), done: at(6) } },
  };
  const events = [
    { id: 'a1', ts: at(7), kind: 'ask', data: { text: 'one' }, reply: null },
    { id: 'a2', ts: at(10), kind: 'ask', data: { text: 'two' }, reply: null },
    { id: 'a3', ts: at(9), kind: 'ask', data: { text: 'three' }, reply: { html: 'ok', at: at(9) } },
    { id: 'a4', ts: at(8), kind: 'ask', data: { text: 'four' }, reply: { html: 'ok', at: at(10) } },
    { id: 'm1', ts: at(7), kind: 'item-message', data: { key: 'w/P4', text: 'One more thing' }, reply: null },
    { id: 'c1', ts: tapped, kind: 'card-done', data: { key: 'w/D4' }, reply: null },
  ];
  const built = (more = []) => buildBoard({ now, fromWaves: false, prs, events: [...events, ...more], files: [{ slug: 'w', agents, itemFile: { repo: 'o/r', reviewers: [{ name: 'Ann', github: 'ann' }], items } }] });
  const lanesOf = (b) => {
    const lanes = {};
    for (const i of b.items) (lanes[i.lane] ||= []).push(i.key.replace(/^w\//, ''));
    return lanes;
  };
  const b = built();
  assert.deepEqual(lanesOf(b), {
    review: ['R1', 'R2', 'P4', 'S1', 'S2'],
    progress: ['P2', 'P3', 'P1'],
    todo: ['ENG-1', 'T2', 'ENG-2', 'Q1', 'T1', 'Q2'],
    done: ['Q4', 'D4', 'Q3', 'D3', 'D2', 'D1'],
  });
  const sortAt = Object.fromEntries(b.items.map((i) => [i.key.replace(/^w\//, ''), i.sortAt]));
  assert.deepEqual(sortAt, {
    R1: at(9).replace('Z', '.000Z'), R2: at(8).replace('Z', '.000Z'), S1: at(2).replace('Z', '.000Z'), S2: at(1).replace('Z', '.000Z'),
    P1: at(1), P2: at(8), P3: at(5), P4: at(7),
    Q1: at(7), Q2: at(10), T1: made(8), T2: made(4), 'ENG-1': at(2), 'ENG-2': at(6),
    Q3: at(9), Q4: at(10), D1: at(2), D2: at(7), D3: at(8), D4: tapped,
  });
  const bumped = built([{ id: 'cb', ts: at(10), kind: 'card-bump', data: { key: 'w/ENG-2' }, reply: null }]);
  assert.deepEqual(lanesOf(bumped).todo, ['ENG-2', 'ENG-1', 'T2', 'Q1', 'T1', 'Q2']);
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
    files: [
      { slug: 'site', itemFile: { internal: true, items: [{ id: 'S3', title: 'Three' }, { id: 'INT-14', title: 'Fourteen' }] } },
      { slug: 'w', itemFile: { items: [{ id: 'B5', title: 'Five', pr: 5 }] } },
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
  const files = [
    { slug: 'w', itemFile: { internal: true, items: [{ id: 'S3', title: 'Legacy' }, { id: 'INT-14', title: 'Hub task' }, { id: 'C4', title: 'Internal', ticket: 'INT-4' },
      { id: 'C5', title: 'Issue', ticket: '#5' }, { id: 'C6', title: 'Linear', ticket: 'ENG-6' }, { id: 'F7', title: 'Follow', ticket: 'INT-7', parent: 'C4' }] } },
    { slug: 'web', itemFile: { items: [{ id: 'P1', title: 'Audit', linear: ['WEB-9'] }] } },
  ];
  const build = (tickets) => buildBoard({ tickets, github: 'owner/repo', files });
  const badges = (board) => Object.fromEntries(board.items.map((i) => [i.id, i.ticket && [i.ticket.id, i.ticket.url]]));
  const own = (id) => [id, null];
  // docs/adr/2026-11-09-1500-a-task-is-a-card-with-no-ticket-keyed-t-n.md: with no source, an INT-<n> reads as stored, unlinked.
  assert.deepEqual(badges(build(undefined)), { S3: null, 'INT-14': null, C4: own('INT-4'), C5: own('#5'), C6: own('ENG-6'), F7: own('INT-7'), P1: null });
  const refs = (board) => Object.fromEntries(board.items.map((i) => [i.id, i.ref]));
  const stored = { S3: 'INT-3', 'INT-14': 'INT-14', C4: 'C4', C5: 'C5', C6: 'C6', F7: 'F7', P1: 'P1' };
  assert.deepEqual(refs(build(undefined)), stored);
  assert.deepEqual(refs(build({ source: 'github' })), { ...stored, C5: '#5' });
  assert.deepEqual(refs(build({ source: 'linear', workspace: 'acme', team: 'ENG', project: 'Audit' })), { ...stored, C6: 'ENG-6' });
  assert.deepEqual(badges(build({ source: 'github' })), { S3: null, 'INT-14': null, C4: own('INT-4'), C5: ['#5', 'https://github.com/owner/repo/issues/5'], C6: own('ENG-6'), F7: own('INT-7'), P1: null });
  const linear = build({ source: 'linear', workspace: 'new-workspace', team: 'ENG', project: 'Audit' });
  assert.deepEqual(badges(linear), { S3: null, 'INT-14': null, C4: own('INT-4'), C5: own('#5'), C6: ['ENG-6', 'https://linear.app/new-workspace/issue/ENG-6'], F7: own('INT-7'), P1: null });
  assert.deepEqual([build(undefined), build({ source: 'github' }), linear].map((b) => b.items.find((i) => i.id === 'P1').linear),
    [[{ id: 'WEB-9', url: null }], [{ id: 'WEB-9', url: null }], [{ id: 'WEB-9', url: 'https://linear.app/new-workspace/issue/WEB-9' }]]);
  const legacy = buildBoard({ tickets: { source: 'linear', workspace: 'new-workspace', team: 'ENG', project: 'Audit' }, files: [{ slug: 'w', itemFile: { items: [{ id: 'A1', title: 'Old', linear: ['ENG-9', 'ENG-10'] }] } }] });
  assert.deepEqual(legacy.items[0].linear.map((l) => l.url), ['https://linear.app/new-workspace/issue/ENG-9', 'https://linear.app/new-workspace/issue/ENG-10']);
});

test('a card lists each unfinished dep it is blocked by, a Done one none; one only grilled, prototyped or with a message marked working sits in Todo, one built stays In Progress unless held', () => {
  const items = [
    { id: 'S10', title: 'Ten', lane: 'done' },
    { id: 'S11', title: 'Eleven', lane: 'progress' },
    { id: 'INT-14', title: 'Fourteen' },
    { id: 'INT-15', title: 'Fifteen', lane: 'progress', deps: ['S10', 'S11', 'INT-14'] },
    { id: 'INT-16', title: 'Sixteen', deps: ['S10'] },
    { id: 'INT-17', title: 'Seventeen' },
    { id: 'INT-18', title: 'Grilled', deps: ['S11'] },
    { id: 'INT-19', title: 'Grilled, held', deps: ['S11'], held: true },
    { id: 'INT-20', title: 'Prototyped by an agent' },
    { id: 'INT-27', title: 'Built before', deps: ['S11'] },
    { id: 'INT-28', title: 'Built before, held', held: true },
    { id: 'INT-21', title: 'Landed first', lane: 'done', deps: ['S11'] },
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
  const b = buildBoard({ fromWaves: false, owner, events, working, prototypes, files: [{ slug: 'site', agents, itemFile: { internal: true, items } }] });
  const card = (id) => b.items.find((i) => i.id === id);
  assert.deepEqual(card('INT-15').blockedBy, [{ key: 'site/S11', ref: 'INT-11', lane: 'progress' }, { key: 'site/INT-14', ref: 'INT-14', lane: 'todo' }]);
  assert.equal(card('INT-15').lane, 'progress');
  assert.deepEqual([card('INT-16').blockedBy, card('INT-16').lane], [[], 'todo']);
  assert.deepEqual([card('INT-17').blockedBy, card('S11').lane], [[], 'progress']);
  assert.deepEqual([card('INT-18').blockedBy, card('INT-18').lane], [[{ key: 'site/S11', ref: 'INT-11', lane: 'progress' }], 'todo']);
  assert.deepEqual([card('INT-19').lane, card('INT-20').lane], ['todo', 'todo']);
  assert.deepEqual([card('INT-27').blockedBy, card('INT-27').lane, card('INT-28').lane], [[{ key: 'site/S11', ref: 'INT-11', lane: 'progress' }], 'progress', 'todo']);
  assert.deepEqual([card('INT-21').blockedBy, card('INT-21').lane], [[], 'done']);
  assert.deepEqual(['INT-22', 'INT-23', 'INT-24', 'INT-25', 'INT-26'].map((id) => card(id).lane), ['todo', 'todo', 'todo', 'todo', 'todo']);
  assert.deepEqual([card('INT-22').working, card('INT-23').buildable], [true, true]);
  // The idle pull skips a Todo card a session is working on (docs/adr/2026-11-02-1754-an-idle-board-pulls-in-its-top-todo-card.md).
  assert.equal(pullOf(b.items).pullable.includes('site/INT-22'), false);
  assert.equal(pullOf(b.items).pullable.includes('site/INT-23'), false, 'no state: planned, not pulled');
});

test("a checking card sits in In Progress waiting on Claude's check, with no builder line or next step, and still blocks its dependents", () => {
  const record = { main: { label: 'Opus builder', started: '2026-10-23T10:00:00Z', progress: 'Running tests', progress_at: '2026-10-23T10:05:00Z', done: '2026-10-23T10:30:00Z', handed_back: '2026-10-23T10:30:00Z' } };
  const b = buildBoard({ fromWaves: false, files: [
    { slug: 'site', agents: { S1: record }, itemFile: { internal: true, items: [
      { id: 'S1', title: 'One', lane: 'progress', next: 'Verify it' },
      { id: 'S2', title: 'Two', deps: ['S1'] },
    ] } },
    { slug: 'w', agents: { A1: record, A2: record }, itemFile: { repo: 'o/r', items: [{ id: 'A1', title: 'Draft', lane: 'progress', pr: 7 }, { id: 'A2', title: 'No PR', lane: 'progress' }] } },
  ], prs: { 'o/r#7': greenDraft } });
  const card = (key) => b.items.find((i) => i.key === key);
  const one = card('site/S1');
  assert.deepEqual([one.lane, one.waitsOn, one.builder, one.next, one.bumpable], ['progress', 'checking', null, null, true]);
  assert.deepEqual(card('site/S2').blockedBy, [{ key: 'site/S1', ref: 'INT-1', lane: 'progress' }]);
  assert.deepEqual([card('w/A1').lane, card('w/A1').waitsOn, card('w/A2').lane], ['progress', 'checking', 'progress']);
  assert.equal(b.itemFiles[0].finished, false);
});

test('an edited ask, or a thread message edited before thread edits went, shows its latest text marked Edited and keeps its files', () => {
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
  // The board server retitles a New card on an edit (store.mjs); the card carries the edited ask, which an answered card no longer offers to edit.
  const b = askBoard(events, { items: [{ id: 'A1', title: 'One', lane: 'progress' }, { id: 'T-1', title: 'Newest title', from_ask: 'a1' },
    { id: 'T-2', title: 'a2 first line', from_ask: 'a2', answered_at: '2026-10-23T09:15:00Z' }] });
  const t1 = b.items.find((i) => i.key === 'w/T-1');
  assert.deepEqual([t1.ask.text, t1.ask.edited, t1.ask.canEdit, t1.ask.files], ['Newest title\nmore', true, true, [shot]]);
  assert.equal(b.items.find((i) => i.key === 'w/T-2').ask, null);
  const [m] = threadOf('w/A1', { events });
  assert.deepEqual([m.text, m.edited, m.files], ['Fix it well', true, [shot]]);
  const [ask] = threadOf('ask:a1', { events });
  assert.deepEqual([ask.text, ask.edited, ask.files], ['Newest title\nmore', true, [shot]]);
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
  assert.deepEqual(askBoard(events, { items: [{ id: 'T-1', title: 'Fix it now', from_ask: 'a1' }] }).items.find((i) => i.key === 'w/T-1').ask.files, [shot, more, last]);
  assert.deepEqual(threadOf('w/A1', { events })[0].files, [last]);
});

// docs/adr/2026-11-09-1900-every-ask-is-a-task-card-from-the-moment-it-arrives.md
test('Done holds every closed work card, however old, with no Older fold, and cards from answered asks sit among them by when they closed', () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  const at = (d) => new Date(now - d * 86400000).toISOString();
  const prs = { 'o/r#1': { state: 'MERGED', mergedAt: at(2) }, 'o/r#2': { state: 'MERGED', mergedAt: at(9) }, 'o/r#3': { state: 'MERGED', mergedAt: at(30) } };
  const asked = (id, ask, sent, closed) => ({ id, title: id, from_ask: ask, answered_at: at(closed), lane: 'done', closed_at: at(closed), created: at(sent) });
  const items = [{ id: 'A1', title: 'a', pr: 1 }, { id: 'A2', title: 'b', pr: 2 }, { id: 'A3', title: 'c', pr: 3 }, { id: 'A4', title: 'd' },
    { id: 'ENG-1', title: 'f', lane: 'done', closed_at: at(12), parent: 'A4' }, { id: 'ENG-2', title: 'g', lane: 'done', closed_at: at(1), parent: 'A4' },
    asked('T-1', 'a1', 1, 0.5), asked('T-2', 'a2', 10, 0.2), asked('T-3', 'a3', 3, 2.5)];
  const events = [
    { id: 'a1', ts: at(1), kind: 'ask', data: { text: 'q' }, reply: { html: 'ok', at: at(0.5) } },
    { id: 'a2', ts: at(10), kind: 'ask', data: { text: 'r' }, reply: { html: 'ok', at: at(0.2) } },
    { id: 'a3', ts: at(3), kind: 'ask', data: { text: 's' }, reply: { html: 'ok', at: at(2.5) } },
  ];
  const b = buildBoard({ now, fromWaves: false, prs, events, files: [{ slug: 'w', itemFile: { repo: 'o/r', items } }] });
  assert.deepEqual(b.items.filter((i) => i.lane === 'done').map((i) => i.key), ['w/T-2', 'w/T-1', 'w/ENG-2', 'w/A1', 'w/T-3', 'w/A2', 'w/ENG-1', 'w/A3']);
  assert.deepEqual(b.items.filter((i) => i.fromAsk).map((i) => [i.lane, i.sortAt]), [['done', at(0.2)], ['done', at(0.5)], ['done', at(2.5)]]);
  assert.deepEqual(b.items.map((i) => i.lane).slice(-8), Array(8).fill('done'));
});

test('an item file whose every work item is in Done, landed or not, is finished, until an open card reopens it, and its Done cards stay in the one newest-first Done list with no fold', () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  const at = (d) => new Date(now - d * 86400000).toISOString();
  const prs = { 'o/r#1': { state: 'MERGED', mergedAt: at(1) }, 'o/r#2': { state: 'CLOSED', updatedAt: at(3) }, 'o/r#3': { state: 'MERGED', mergedAt: at(20) } };
  const files = (open) => [
    { slug: 'x', itemFile: { repo: 'o/r', items: [{ id: 'X1', title: 'a', pr: 1 }, { id: 'X2', title: 'b', pr: 2 }, { id: 'X3', title: 'c', lane: 'done' }, { id: 'X4', title: 'd', pr: 3 },
      { id: 'ENG-1', title: 'f', lane: 'done', closed_at: at(2), parent: 'X1' }, { id: 'ENG-2', title: 'g', ...(open ? {} : { lane: 'done', closed_at: at(2) }), parent: 'X1' }] } },
    { slug: 'site', itemFile: { internal: true, items: [{ id: 'S1', title: 's', lane: 'done' }] } },
    { slug: 'open', agents: runningBuilders('O2'), itemFile: { items: [{ id: 'O1', title: 'o', lane: 'done' }, { id: 'O2', title: 'p', lane: 'progress' }] } },
    { slug: 'empty', itemFile: { items: [] } },
  ];
  const b = buildBoard({ now, fromWaves: false, prs, files: files(false) });
  assert.deepEqual(b.itemFiles.map((w) => [w.slug, w.finished]), [['x', true], ['site', true], ['open', false], ['empty', false]]);
  assert.deepEqual(b.items.map((i) => [i.key, i.lane]), [
    ['open/O2', 'progress'],
    ['x/X1', 'done'], ['x/ENG-2', 'done'], ['x/ENG-1', 'done'], ['x/X2', 'done'], ['x/X4', 'done'],
    ['x/X3', 'done'], ['open/O1', 'done'], ['site/S1', 'done'],
  ]);
  assert.ok(b.items.every((i) => !('fold' in i)));
  const reopened = buildBoard({ now, fromWaves: false, prs, files: files(true) });
  assert.deepEqual(reopened.itemFiles.map((w) => [w.slug, w.finished]), [['x', false], ['site', true], ['open', false], ['empty', false]]);
  assert.deepEqual(reopened.items.filter((i) => i.file === 'x').map((i) => [i.key, i.lane]), [
    ['x/ENG-2', 'todo'],
    ['x/X1', 'done'], ['x/ENG-1', 'done'], ['x/X2', 'done'], ['x/X4', 'done'], ['x/X3', 'done'],
  ]);
});

test('the board says when GitHub was last checked, late past twice the interval but never while idle, and whether it is listening', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  const checks = (checked, listening) => buildBoard({ now, fromWaves: false, files: [], checked, listen: listening === true ? 'listening' : listening === false ? 'deaf' : listening }).checks;
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
  const claudeAt = (extra) => buildBoard({ now, fromWaves: false, checked: { at: at(1) }, watcher: { running: true, since: at(40) }, files: [{ slug: 'w', agents: {}, itemFile: { items: [{ id: 'A1', title: 'One' }] } }], ...extra }).checks.claudeAt;
  assert.equal(claudeAt({}), at(40));
  assert.equal(claudeAt({ replyAt: at(30) }), at(30));
  assert.equal(claudeAt({ threads: { 'w/A1': [{ ts: at(20), who: 'claude', text: 'x' }, { ts: at(1), who: 'love', text: 'y' }] } }), at(20));
  assert.equal(claudeAt({ working: { e1: at(10) } }), at(10));
  assert.equal(claudeAt({ files: [{ slug: 'w', agents: { A1: { main: { started: at(5) } } }, itemFile: { items: [{ id: 'A1', title: 'One' }] } }] }), at(5));
  assert.equal(claudeAt({ files: [{ slug: 'w', agents: { A1: { main: { started: at(30), done: at(2) } } }, itemFile: { items: [{ id: 'A1', title: 'One' }] } }] }), at(2));
});

test('try state maps web and app badges using current worktree heads, keeps lanes and installs, and omits Done', () => {
  const files = [{ slug: 'w', itemFile: { repo: 'o/r', items: [{ id: 'INT-41', pr: 7, install: { url: 'https://m/app.apk', sha: 'abcdef1' } }] } }];
  const snapshot = { route: 'orch', files, prs: { 'o/r#7': { ...greenDraft, headRefOid: 'abcdef123' } } };
  assert.equal(buildBoard(snapshot).kind, 'app');
  for (const kind of ['web', 'app']) {
    const current = { sha: 'abcdef1', head: 'abcdef123', ahead: 2, script: true, state: 'ready', https: 8501 };
    const result = buildBoard({ ...snapshot, try: { kind, cards: { 'w/INT-41': current } } });
    const item = result.items[0];
    assert.equal(item.lane, 'review');
    assert.deepEqual(item.try, { kind, state: 'ready', stale: false, sha: 'abcdef1', changes: true, script: true, autoBuild: false, hostBusy: false, url: kind === 'web' ? null : 'https://m/app.apk', port: kind === 'web' ? 8501 : null });
    assert.equal(buildBoard({ ...snapshot, autoBuild: true, try: { kind, cards: { 'w/INT-41': current } } }).items[0].try.autoBuild, true);
    assert.equal(buildBoard({ ...snapshot, hostBusy: true, try: { kind, cards: { 'w/INT-41': current } } }).items[0].try.hostBusy, true);
    assert.equal(item.install.url, 'https://m/app.apk');
    const stale = buildBoard({ ...snapshot, try: { kind, cards: { 'w/INT-41': { ...current, head: 'fedcba1', state: 'running' } } } }).items[0];
    assert.equal(stale.try.stale, true);
    assert.equal(stale.try.state, 'running');
    assert.equal(stale.try.url, kind === 'web' ? null : 'https://m/app.apk');
    assert.equal(stale.try.port, null);
    const done = buildBoard({ ...snapshot, prs: { 'o/r#7': { state: 'MERGED' } }, try: { kind, cards: { 'w/INT-41': current } } }).items[0];
    assert.equal(done.try, undefined);
  }
  assert.equal(buildBoard({ files: [] }).kind, 'web');
});

test('main maps the recorded branch, commit time and short sha to its web or published app URL', () => {
  const run = { slug: 'o/r', branch: 'develop', sha: 'abcdef123456', at: '2026-11-01T00:00:00Z', script: true, state: 'ready', https: 8501 };
  for (const kind of ['web', 'app']) {
    const snapshot = { files: [], route: 'orch', try: { kind, main: run }, main: { install: { url: 'https://m/main.apk' } } };
    assert.deepEqual(buildBoard(snapshot).main, { slug: run.slug, branch: 'develop', sha: 'abcdef1', at: run.at, kind, state: 'ready', url: kind === 'web' ? null : 'https://m/main.apk', port: kind === 'web' ? 8501 : null, serving: null, pull: null, script: '.kickflip/build' });
    assert.equal(buildBoard({ ...snapshot, try: { kind, main: { ...run, target: 'ios' } } }).main.script, '.kickflip/build-ios');
    assert.deepEqual(buildBoard({ ...snapshot, try: { kind, main: run, pull: { at: 'now' } } }).main.pull, { running: false, error: null });
    assert.deepEqual(buildBoard({ ...snapshot, try: { kind, main: run, pull: { at: 'now', running: true, error: 'can’t pull: local changes' } } }).main.pull, { running: true, error: 'can’t pull: local changes' });
    assert.equal(buildBoard({ ...snapshot, try: { kind, main: { ...run, script: false } } }).main, null);
    // A web Main rebuilding, or whose new build failed, still serves its old server's commit on its port.
    for (const state of ['running', 'failed']) {
      const overlap = buildBoard({ ...snapshot, try: { kind, main: { ...run, state, https: undefined, serving: { sha: '54837cd0123', at: '2026-10-31T00:00:00Z', https: 8501 } } } }).main;
      assert.deepEqual([overlap.sha, overlap.state, overlap.port, overlap.serving], kind === 'web' ? ['abcdef1', state, 8501, { sha: '54837cd', at: '2026-10-31T00:00:00Z' }] : ['abcdef1', state, null, null]);
    }
  }
  assert.equal(buildBoard({ files: [] }).main, null);
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
  assert.deepEqual([card.lane, card.stale], ['review', true]);
  assert.equal(Object.hasOwn(card, 'slack'), false);
  assert.equal(Object.hasOwn(board().itemFiles[0], 'watched'), false);
});

// docs/adr/2026-11-03-1840-waves-are-bands-in-todo.md
test("each open wave is a band with its cards in order, its next unstarted card ready or why not, progress and triage, its cards carry its slug; an item file is a band only on a board over the waves, with triage from wave-triage {file} and topic file:<slug>", () => {
  const items = [
    { id: 'INT-1', title: 'One', lane: 'done' }, { id: 'INT-2', title: 'Two', lane: 'progress' }, { id: 'INT-3', title: 'Three', deps: ['INT-2'], phase: 'ready' },
    { id: 'INT-4', title: 'Four', lane: 'done', prs: [{ repo: 'o/r', number: 4 }] }, { id: 'INT-5', title: 'Five' }, { id: 'INT-6', title: 'Six', lane: 'done' }, { id: 'INT-7', title: 'Loose' },
    { id: 'INT-8', title: 'Eight', phase: 'ready' }, { id: 'INT-9', title: 'Nine', phase: 'grilling', deps: ['INT-8'] }, { id: 'INT-10', title: 'Ten', held: true },
  ];
  const waves = [
    { slug: 'mon', title: 'Monitor', goal: 'The monitor runs in kickflip.', items: ['INT-1', 'INT-2', 'INT-3', 'INT-4'] },
    { slug: 'old', title: 'Old', goal: 'Gone.', items: ['INT-5'], finished_at: '2026-11-01T00:00:00Z' },
    { slug: 'all-done', title: 'All done', goal: 'Shipped.', items: ['INT-6'] },
    { slug: 'go', title: 'Go', goal: 'Ready to go.', items: ['INT-8', 'INT-9'] },
    { slug: 'hold', title: 'Hold', goal: 'Held.', items: ['INT-10'] },
  ];
  const question = (id, topic) => ({ id, topic, question: 'Split it?', options: [{ id: 'yes', label: 'Yes' }] });
  const triage = (id, ts, reply = null) => ({ id, ts, kind: 'wave-triage', data: { wave: 'mon' }, reply });
  const build = (events, owner = {}, fromWaves = false) => buildBoard({ fromWaves, now: Date.parse('2026-11-02T12:00:00Z'), events, owner, prs: { 'o/r#4': { state: 'CLOSED' } },
    files: [{ slug: 'hub', itemFile: { internal: true, items, waves } }, { slug: 'other', itemFile: { items: [{ id: 'X1', title: 'Elsewhere' }] } }] });

  const idle = build([]);
  const keys = (...ids) => ids.map((id) => `hub/${id}`);
  assert.deepEqual(idle.waveBands[0], { kind: 'wave', slug: 'mon', title: 'Monitor', goal: 'The monitor runs in kickflip.', merged: 1, total: 4,
    keys: keys('INT-1', 'INT-2', 'INT-3', 'INT-4'), next: { key: 'hub/INT-3', ref: 'INT-3', ready: false, word: 'blocked by INT-2' }, triage: { running: false, questions: 0 } });
  assert.deepEqual(idle.waveBands.map((b) => [b.slug, b.next]), [
    ['mon', { key: 'hub/INT-3', ref: 'INT-3', ready: false, word: 'blocked by INT-2' }],
    ['go', { key: 'hub/INT-8', ref: 'INT-8', ready: true, word: 'ready' }],
    ['hold', { key: 'hub/INT-10', ref: 'INT-10', ready: false, word: 'held' }],
  ]);
  const chip = (id) => idle.items.find((i) => i.id === id).wave;
  assert.deepEqual([chip('INT-3'), chip('INT-5'), chip('INT-7')], [{ slug: 'mon', title: 'Monitor' }, { slug: 'old', title: 'Old' }, null]);

  assert.deepEqual(build([triage('t1', '2026-11-02T10:00:00Z')]).waveBands[0].triage, { running: true, questions: 0 });
  const asked = build([triage('t1', '2026-11-02T10:00:00Z', { html: '2 questions' }), { id: 'a1', ts: '2026-11-02T10:05:00Z', kind: 'owner-answer', data: { id: 'q2', choice: 'yes' } }],
    { items: [question('q1', 'wave:mon'), question('q2', 'wave:mon'), { ...question('q3', 'wave:mon'), resolved: 'Done', resolved_at: '2026-11-02T09:00:00Z' }] });
  assert.deepEqual(asked.waveBands[0].triage, { running: false, questions: 2 });
  assert.deepEqual(asked.needs.map((n) => [n.text, n.band, n.url]), [['Monitor · 1 question', 'mon', 'questions.html#q1']]);

  const idleRow = { running: false, questions: 0 };
  const fileBands = build([], {}, true).waveBands.filter((b) => b.kind === 'file');
  assert.deepEqual(fileBands.map((b) => [b.slug, b.goal, b.next, b.triage, `${b.merged}/${b.total}`]), [['hub', null, null, idleRow, '2/10'], ['other', null, null, idleRow, '0/1']]);
  assert.deepEqual(fileBands[1].keys, ['other/X1']);
  const waveTriage = (id, ts, reply = null) => ({ id, ts, kind: 'wave-triage', data: { file: 'other' }, reply });
  const triaged = (events, owner) => Object.fromEntries(build(events, owner, true).waveBands.map((r) => [`${r.kind}:${r.slug}`, r.triage]));
  assert.deepEqual(triaged([waveTriage('t2', '2026-11-02T10:00:00Z')]), { 'wave:mon': idleRow, 'wave:go': idleRow, 'wave:hold': idleRow, 'file:hub': idleRow, 'file:other': { running: true, questions: 0 } });
  const fileAsked = build([waveTriage('t2', '2026-11-02T10:00:00Z', { html: '1 question' })], { items: [question('q4', 'file:other'), question('q5', 'wave:mon')] }, true);
  assert.deepEqual(fileAsked.waveBands.map((r) => r.triage.questions), [1, 0, 0, 0, 1]);
  assert.deepEqual(fileAsked.needs.map((n) => [n.text, n.topic, n.band]), [['Monitor · 1 question', 'wave:mon', 'mon'], ['other · 1 question', 'file:other', 'other']]);
});

// docs/adr/2026-11-09-1321-a-waves-cards-wait-only-on-the-earlier-cards-they-conflict-with.md
test("a wave's band lists its cards in order, and Implement goes to its first ready card, so free cards are offered in turn and a card waits only on the cards it links to; a wave made in steps reads its steps in order", () => {
  const items = [
    { id: 'P1', title: 'One', lane: 'done' }, { id: 'P2', title: 'Two', phase: 'ready' }, { id: 'P3', title: 'Three', phase: 'ready', deps: ['P1'] },
    { id: 'P4', title: 'Four', phase: 'ready', deps: ['P2'] },
  ];
  const build = (over = {}, waves = [{ slug: 'cw', title: 'Conflicts', goal: 'G', items: ['P1', 'P2', 'P3', 'P4'] }]) => buildBoard({ now: Date.parse('2026-11-04T12:00:00Z'), events: [], owner: {},
    files: [{ slug: 'w', itemFile: { internal: true, items: items.map((it) => ({ ...it, ...over[it.id] })), waves } }] });
  const [band] = build().waveBands;
  assert.deepEqual([band.keys, 'phases' in band], [['w/P1', 'w/P2', 'w/P3', 'w/P4'], false]);
  assert.deepEqual(band.next, { key: 'w/P2', ref: 'P2', ready: true, word: 'ready' });
  assert.deepEqual(build({ P2: { lane: 'progress' } }).waveBands[0].next, { key: 'w/P3', ref: 'P3', ready: true, word: 'ready' });
  assert.deepEqual(build({ P2: { lane: 'progress' }, P3: { lane: 'progress' } }).waveBands[0].next, { key: 'w/P4', ref: 'P4', ready: false, word: 'blocked by P2' });
  assert.deepEqual(build({}, [{ slug: 'old', title: 'Old', goal: 'G', phases: [['P1'], ['P3', 'P2'], ['P4']] }]).waveBands[0].keys, ['w/P1', 'w/P3', 'w/P2', 'w/P4']);
});

// docs/adr/2026-11-03-0526-a-follow-up-is-a-work-card-with-a-parent.md
test('a card links to its Parent, lists its Children and its Related to cards on both sides, and a blocker lists what Waits on it; a card whose Parent left the board still links to its stored id', () => {
  const itemFile = { items: [
    { id: 'GH-53', title: 'Parent', ticket: '#53', related: ['w/GH-75'] },
    { id: 'GH-93', title: 'Second child', ticket: '#93', parent: 'w/GH-53', deps: ['GH-80'] },
    { id: 'GH-87', title: 'First child', ticket: '#87', parent: 'w/GH-53', lane: 'done' },
    { id: 'GH-80', title: 'Blocker', ticket: '#80' },
    { id: 'GH-75', title: 'Similar', ticket: '#75', related: ['w/GH-93'] },
    { id: 'GH-9', title: 'Orphan', ticket: '#9', parent: 'w/GH-404' },
  ] };
  const b = buildBoard({ fromWaves: false, now: Date.parse('2026-11-03T12:00:00Z'), tickets: { source: 'github' }, files: [{ slug: 'w', itemFile }] });
  const card = (id) => b.items.find((i) => i.id === id);
  const refs = (list) => list.map((l) => l.ref);
  assert.deepEqual(card('GH-93').parent, { key: 'w/GH-53', ref: '#53', lane: 'todo' });
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
  for (const built of [card({}, finished), card({ lane: 'progress' })]) {
    assert.deepEqual([built.lane, built.builder, built.next], ['progress', null, NO_NEXT]);
  }
  assert.deepEqual([card({}, running).next, card({}, running).builder.progress], [null, null]);
  assert.equal(card({ next: 'Land it' }, finished).next, 'Land it');
  assert.equal(card({}, { main: { ...finished.main, handed_back: finished.main.done } }).next, null);
  assert.deepEqual([card({}).lane, card({}).next], ['todo', null]);
});

// docs/adr/2026-11-05-0802-todo-has-no-queue.md
test('Todo has no queue: every Todo card keeps its place, bumped first and the rest oldest first', () => {
  const at = (m) => `2026-11-04T10:${String(m).padStart(2, '0')}:00.000Z`;
  const items = [
    { id: 'A1', title: 'Blocker', lane: 'progress' },
    { id: 'R1', title: 'feat: ready old', phase: 'ready', created: at(1) },
    { id: 'R2', title: 'feat: ready new', phase: 'ready', created: at(2) },
    { id: 'B1', title: 'Blocked', deps: ['A1'], created: at(3) },
    { id: 'T1', title: 'Not ready', created: at(5) },
    { id: 'H1', title: 'Held ready', phase: 'ready', held: true, created: at(6) },
  ];
  const built = ({ events = [] } = {}) => buildBoard({ fromWaves: false, events, now: Date.parse(at(30)),
    files: [{ slug: 'w', agents: runningBuilders('A1'), itemFile: { internal: true, items } }] });
  const lanes = (b) => b.items.filter((i) => i.kind === 'work').map((i) => `${i.id}:${i.lane}`);
  const order = ['A1:progress', 'R1:todo', 'R2:todo', 'B1:todo', 'T1:todo', 'H1:todo'];
  assert.deepEqual(lanes(built()), order);
  assert.equal(built().items.some((i) => 'queued' in i || 'queuedAt' in i), false);

  const bump = (kind, key, m) => ({ id: `${kind}${m}`, ts: at(m), kind, data: { key } });
  assert.deepEqual(lanes(built({ events: [bump('card-bump', 'w/R1', 10)] })).slice(1, 3), ['R1:todo', 'R2:todo'], 'a bump puts its task on top');
  assert.deepEqual(pullOf(built().items).pulls, ['w/R1', 'w/R2'], 'the pull takes the oldest ready task first');
  assert.deepEqual(pullOf(built({ events: [bump('card-bump', 'w/R2', 10)] }).items).pulls, ['w/R2', 'w/R1'], 'and a bump orders the ready tasks');
  assert.deepEqual(pullOf(built({ events: [bump('card-bump', 'w/R2', 10), bump('card-unbump', 'w/R2', 11)] }).items).pulls, ['w/R1', 'w/R2'], 'an unbump returns it to its place by time');
});

// docs/adr/2026-11-07-0700-staging-then-ready.md
test('a staging card stays in Todo waiting on the orchestrator, and is neither pulled, an arrival nor a gap; ready cards are pulled on their state alone', () => {
  const at = (m) => `2026-11-07T10:${String(m).padStart(2, '0')}:00.000Z`;
  const items = [
    { id: 'S1', title: 'Staged', phase: 'staging', staged_at: at(1) },
    { id: 'R1', title: 'feat: ready', phase: 'ready', created: at(2) },
  ];
  const b = buildBoard({ fromWaves: false, now: Date.parse(at(30)), files: [{ slug: 'w', itemFile: { internal: true, items } }] });
  const card = (id) => b.items.find((i) => i.id === id);
  assert.deepEqual([card('S1').lane, card('S1').staging, card('S1').ready, card('S1').next, card('S1').stagedAt], ['todo', true, false, null, at(1)]);
  assert.deepEqual(card('S1').orchestrator, { kind: 'staging', since: at(1), picked: null, next: 'Judge the staged task against the whole board: for a discussed task first fold what was agreed into a Build notes section with item notes; then item set --phase ready --text "<what you checked>", or --phase grilling or prototyping for another round; where its notes answer a split question Split as proposed, file the split instead' });
  assert.deepEqual([card('R1').staging, card('R1').ready, card('R1').orchestrator], [false, true, null]);
  assert.deepEqual(pullOf(b.items).pullable, ['w/R1']);
  assert.equal('starts' in pullOf(b.items), false);
  assert.deepEqual(arrivalsOf(b.items), []);
  assert.equal(owesNext(items[0], []), false);
});

// docs/adr/2026-11-12-0600-every-planner-launches-from-the-orchestrators-brief.md
test("briefsDue names each open card's agent due from a written brief: a grill or prototype on a Todo card nothing but a visual runs on, a visual beside anything but another visual, and nothing from an owed brief", () => {
  const at = (m) => `2026-11-12T10:${String(m).padStart(2, '0')}:00.000Z`;
  const briefed = (kind) => ({ kind, at: at(1), brief: { heading: `Brief for ${kind} round 1`, text: 'What to cover', at: at(2) } });
  const card = (key, briefs, more = {}) => ({ key, lane: 'todo', kind: 'work', phase: 'grilling', agents: [], briefs, ...more });
  const running = (kind) => ({ kind, started: at(3), done: null });
  const items = [
    card('w/G1', [briefed('grill')]),
    card('w/P1', [briefed('prototype')], { phase: 'prototyping', agents: [running('visual')] }),
    card('w/O1', [{ kind: 'grill', at: at(1) }]),
    card('w/B1', [briefed('grill')], { agents: [running('grill')] }),
    card('w/B2', [briefed('prototype')], { agents: [running('claude')] }),
    card('w/X1', [briefed('grill')], { lane: 'progress' }),
    card('w/V1', [briefed('visual')], { lane: 'progress', agents: [running('claude')] }),
    card('w/V2', [briefed('visual')], { agents: [running('visual')] }),
    card('w/D1', [briefed('visual')], { lane: 'done' }),
  ];
  assert.deepEqual(briefsDue(items), [{ key: 'w/G1', kind: 'grill' }, { key: 'w/P1', kind: 'prototype' }, { key: 'w/V1', kind: 'visual' }]);
});

test("a card owing a brief reads the brief's word, blue, and waits on the orchestrator to write it, whatever it asks of the owner; a written one or a drawing visual reads its agent's word", () => {
  const at = (m) => `2026-11-12T10:${String(m).padStart(2, '0')}:00.000Z`;
  const board = (items, agents = {}) => buildBoard({ fromWaves: false, events: [], owner: {}, prs: {}, now: Date.parse(at(30)), files: [{ slug: 'w', agents, itemFile: { internal: true, items } }] });
  const one = (item, agents) => board([{ id: 'A1', title: 'One', lane: 'todo', ...item }], agents ? { A1: agents } : {}).items[0];
  const owed = (kind) => one({ phase: kind === 'visual' ? 'discussing' : `${kind === 'grill' ? 'grill' : 'prototyp'}ing`, briefs: [{ kind, at: at(5), ask: { text: 'Show me' } }] });
  for (const [kind, word, output] of [['grill', 'preheating', 'questions'], ['prototype', 'planning prototype', 'takes'], ['visual', 'planning visual', 'page']]) {
    const it = owed(kind);
    assert.deepEqual([it.briefing, it.planning], [kind, word], kind);
    assert.deepEqual(it.orchestrator, { kind: 'brief', since: at(5), picked: null, next: `Write the ${kind} brief: item brief w/A1 --kind ${kind} --file <draft.md>, with what the discussion settled, what is still open, what the ${output} should cover and the files that matter` }, kind);
  }
  assert.equal(owed('grill').builder, null);
  const written = one({ phase: 'grilling', briefs: [{ kind: 'grill', at: at(5), brief: { heading: 'Brief for grill round 1', text: 'x', at: at(6) } }] });
  assert.deepEqual([written.briefing, written.planning, written.orchestrator?.kind], [null, null, undefined]);
  const drawing = one({ phase: 'discussing' }, { 'visual-1': { kind: 'visual', model: 'sonnet', started: at(7) } });
  assert.deepEqual([drawing.planning, drawing.builder], ['generating visual', null]);
  assert.equal(one({ lane: 'done', briefs: [{ kind: 'grill', at: at(5) }] }).planning, null, 'a closed task owes nothing');
  // An owed grill keeps an arrival off the arrivals: it waits on its brief, not a launch.
  assert.deepEqual(arrivalsOf(board([{ id: 'A1', title: 'One', lane: 'todo', briefs: [{ kind: 'grill', at: at(5) }] }]).items), []);
  // and takes a planner slot, so the cap counts cards owing briefs as it counts running planners.
  const two = board([{ id: 'A1', title: 'One', lane: 'todo', briefs: [{ kind: 'grill', at: at(5) }] }, { id: 'A2', title: 'Two', lane: 'todo' }]).items;
  assert.deepEqual([arrivalsOf(two, { cap: 1 }), arrivalsOf(two, { cap: 2 })], [[], ['w/A2']]);
});

test('a card-unbump after a card-bump unbumps the card, and a later bump bumps it again', () => {
  const bump = (kind, ts) => ({ id: `${kind}${ts}`, ts: `2026-11-03T10:0${ts}:00.000Z`, kind, data: { key: 'w/A1' } });
  const bumpedAt = (events) => board({ pr: null, item: { pr: undefined }, events }).items.find((i) => i.key === 'w/A1').bumpedAt;
  assert.equal(bumpedAt([bump('card-bump', 1)]), '2026-11-03T10:01:00.000Z');
  assert.equal(bumpedAt([bump('card-bump', 1), bump('card-unbump', 2)]), null);
  assert.equal(bumpedAt([bump('card-bump', 1), bump('card-unbump', 2), bump('card-bump', 3)]), '2026-11-03T10:03:00.000Z');
});

// docs/adr/2026-11-06-1700-a-bump-marks-the-priority-through-every-lane.md
test('a bump stays through In Review and ends when the card closes, merged or Done; a reopened card needs a new bump', () => {
  const bump = (m) => ({ id: `b${m}`, ts: `2026-11-03T10:0${m}:00.000Z`, kind: 'card-bump', data: { key: 'w/A1' } });
  const card = (opts) => board(opts).items.find((i) => i.key === 'w/A1');
  const open = card({ pr: { ...greenDraft, isDraft: false }, events: [bump(1)] });
  assert.deepEqual([open.lane, open.bumpable, open.bumpedAt], ['review', true, '2026-11-03T10:01:00.000Z']);
  const merged = card({ pr: { ...greenDraft, isDraft: false, state: 'MERGED', mergedAt: '2026-11-03T10:05:00.000Z' }, events: [bump(1)] });
  assert.deepEqual([merged.lane, merged.bumpable, merged.bumpedAt], ['done', false, null]);
  const done = { pr: null, item: { pr: undefined, lane: 'done', lane_at: '2026-11-03T10:05:00.000Z', closed_at: '2026-11-03T10:05:00.000Z' } };
  assert.equal(card({ ...done, events: [bump(1)] }).bumpedAt, null);
  const msg = { id: 'm1', ts: '2026-11-03T10:06:00.000Z', kind: 'item-message', data: { key: 'w/A1', text: 'One more thing' }, reply: null };
  const reopened = card({ ...done, events: [bump(1), msg] });
  assert.deepEqual([reopened.lane, reopened.reopened, reopened.bumpedAt], ['review', true, null], 'a bump from before the close is over');
  assert.equal(card({ ...done, events: [bump(1), msg, bump(7)] }).bumpedAt, '2026-11-03T10:07:00.000Z');
});

// docs/adr/2026-11-13-1126-the-implementer-limit-counts-cards-in-progress.md
test('a bumped ready card goes first in the pull but waits for a slot like any other, and bumps no build out', () => {
  const card = (key, more = {}) => ({ key, title: 'feat: task', lane: 'todo', kind: 'work', buildable: true, phase: 'ready', blockedBy: [], questions: null, grilling: false, working: false, held: false, agents: [], bumpedAt: null, ...more });
  const running = card('w/P1', { lane: 'progress', buildable: false, state: null, agents: [{ name: 'main', kind: 'claude', pid: 1, started: '2026-11-06T10:00:00Z', done: null }] });
  const plain = card('w/T1');
  const top = card('w/T2', { bumpedAt: '2026-11-06T11:00:00Z' });
  const full = pullOf([running, plain, top], { cap: 1 });
  assert.deepEqual([full.pulls, full.free], [[], 0], 'a full In Progress starts nothing, bumped or not');
  assert.deepEqual(Object.keys(full).filter((k) => ['bumpOuts', 'pastCap'].includes(k)), [], 'nothing is bumped out');
  assert.deepEqual(pullOf([running, plain, top], { cap: 2 }).pulls, ['w/T2'], 'one free slot takes the bump first');
  assert.deepEqual(pullOf([running, plain, top], { cap: 3 }).pulls, ['w/T2', 'w/T1']);
});

// docs/adr/2026-11-06-1700-a-bump-marks-the-priority-through-every-lane.md
test('a bumped arrival gets its grill past max_planners', () => {
  const card = (key, more = {}) => ({ key, lane: 'todo', kind: 'work', buildable: true, state: null, blockedBy: [], questions: null, grilling: false, prototyping: false, working: false, held: false, agents: [], ...more });
  const planning = card('w/G0', { phase: 'grilling', agents: [{ kind: 'grill', started: '2026-11-06T10:00:00Z', done: null }] });
  const items = [card('w/B1', { bumpedAt: '2026-11-06T10:00:00Z' }), card('w/A1'), card('w/A2')];
  assert.deepEqual(arrivalsOf([planning, ...items], { cap: 1 }), ['w/B1']);
  assert.deepEqual(arrivalsOf([planning, ...items], { cap: 2 }), ['w/B1'], 'the bump takes the free planner slot first');
  assert.deepEqual(arrivalsOf([planning, ...items], { cap: 3 }), ['w/B1', 'w/A1']);
});

// docs/adr/2026-11-06-1700-a-bump-marks-the-priority-through-every-lane.md
test("the orchestrator's waits list bumped cards first across lanes, the earliest bump first, each carrying its bump", () => {
  const wait = (key, lane, bumpedAt = null) => ({ key, ref: key, title: key, lane, bumpedAt, orchestrator: { kind: 'calls', since: '2026-11-06T10:00:00Z', picked: null, next: 'Verify' } });
  const items = [wait('w/R1', 'review'), wait('w/P1', 'progress'), wait('w/P2', 'progress', '2026-11-06T09:30:00Z'), wait('w/T1', 'todo', '2026-11-06T09:00:00Z'), { key: 'w/X', orchestrator: null }];
  const waits = orchestratorWaits({ items });
  assert.deepEqual(waits.map((w) => [w.key, w.bumpedAt]), [['w/T1', '2026-11-06T09:00:00Z'], ['w/P2', '2026-11-06T09:30:00Z'], ['w/R1', null], ['w/P1', null]]);
});

// docs/adr/2026-11-06-1700-a-bump-marks-the-priority-through-every-lane.md
test('a bumped ready card the host holds reads so, and only the bump', () => {
  const at = (m) => `2026-11-06T10:${String(m).padStart(2, '0')}:00.000Z`;
  const items = [
    { id: 'B1', title: 'Bump', phase: 'ready', created: at(5), lane: 'progress' },
    { id: 'O1', title: 'Older', phase: 'ready', created: at(1) },
    { id: 'T1', title: 'Bumped', phase: 'ready', created: at(4) },
  ];
  const built = (more = {}) => buildBoard({ fromWaves: false, now: Date.parse(at(30)), events: [{ id: 'cb', ts: at(10), kind: 'card-bump', data: { key: 'w/T1' } }],
    files: [{ slug: 'w', agents: runningBuilders('B1'), itemFile: { internal: true, items } }], ...more });
  assert.deepEqual(built().items.filter((i) => i.lane === 'todo').map((i) => [i.id, i.hostHeld]), [['T1', false], ['O1', false]]);
  assert.deepEqual(built({ hostBusy: true }).items.filter((i) => i.lane === 'todo').map((i) => i.hostHeld), [true, false], 'only the bump reads held: the rest wait their turn anyway');
});

// docs/adr/2026-11-09-1300-a-card-pause-stops-its-builder-at-its-next-stopping-point.md
test('a paused build reads its pause, neither live nor stale once paused', () => {
  const now = Date.parse('2026-11-09T12:00:00.000Z');
  const record = (pause) => ({ A1: { main: { label: 'Builder', kind: 'claude', started: '2026-11-09T10:00:00.000Z', session: { pid: 4, at: '2026-11-09T10:00:00.000Z' }, pause } } });
  const build = (pause, alive) => buildBoard({ fromWaves: false, now, events: [], alive: { 'w/A1': alive },
    files: [{ slug: 'w', agents: record(pause), itemFile: { internal: true, items: [{ id: 'A1', title: 'One', lane: 'progress' }] } }] }).items[0];
  const paused = build({ cause: 'blocked', words: 'blocked by #61', at: '2026-11-09T11:00:00.000Z', paused: '2026-11-09T11:02:00.000Z' }, false);
  assert.deepEqual([paused.lane, paused.builder.pause, paused.builder.stale, paused.builder.alive, paused.stale], ['progress', { cause: 'blocked', words: 'blocked by #61', paused: true }, false, null, false]);
  const pausing = build({ cause: 'held', words: 'held', at: '2026-11-09T11:59:00.000Z' }, true);
  assert.deepEqual([pausing.builder.pause.paused, pausing.builder.alive], [false, true]);
});

// docs/adr/2026-11-03-0516-a-new-card-is-ready-grilling-or-prototyping.md
test("a card made from an ask reads New until its session sets ready, grilling or prototyping, and only a Ready card the owner owes nothing reads ready and is pullable", () => {
  const q = { id: 'q1', topic: 'item:w/A1', question: 'Which way?', options: [{ id: 'A', label: 'One' }] };
  const card = ({ item = {}, owner = {}, agents = {}, dep, events = [] } = {}) => buildBoard({
    fromWaves: false, events, owner, prs: {},
    files: [{ slug: 'w', agents, itemFile: { repo: 'o/r', items: [{ id: 'A1', title: 'feat: one', from_ask: 'e1', ...item }, ...(dep ? [{ id: 'A2', title: 'Two', status: dep }] : [])] } }],
  }).items.find((i) => i.id === 'A1');
  const fields = (c) => [c.unsorted, c.ready, c.grilling];
  const fresh = card();
  assert.deepEqual(fields(fresh), [true, false, false]);
  assert.deepEqual(pullOf([fresh]).pullable, []);
  assert.equal(card({ item: { from_ask: undefined } }).unsorted, false);
  // docs/adr/2026-11-07-1300-a-card-filed-held-stays-new-until-unheld.md: a card filed held reads New but is sorted, so its unhold arrives it.
  const filedHeld = card({ item: { filed_held: true, held: true } });
  assert.deepEqual([filedHeld.phase, filedHeld.unsorted], ['new', false]);
  assert.deepEqual(arrivalsOf([card({ item: { filed_held: true } })]), ['w/A1']);
  // docs/adr/2026-11-05-0130-the-orchestrator-links-a-new-card-when-it-files-it.md: an agent's item add reads New too.
  assert.equal(card({ item: { from_ask: undefined, unfiled: true } }).unsorted, true);
  assert.deepEqual(pullOf([card({ item: { from_ask: undefined, unfiled: true } })]).pullable, []);
  const ready = card({ item: { phase: 'ready' } });
  assert.deepEqual(fields(ready), [false, true, false]);
  assert.deepEqual(pullOf([ready]).pullable, ['w/A1']);
  assert.equal(card({ item: { phase: 'ready', held: true } }).ready, true);
  assert.equal(card({ item: { phase: 'ready', deps: ['A2'] }, dep: 'building' }).ready, false);
  assert.equal(card({ item: { phase: 'ready' }, owner: { items: [q] } }).ready, false);
  assert.equal(card({ item: { phase: 'ready', lane: 'progress' } }).ready, false);
  for (const state of ['grilling', 'prototyping']) {
    const c = card({ item: { phase: state } });
    assert.deepEqual([c.unsorted, c.ready], [false, false]);
    assert.deepEqual(pullOf([c]).pullable, []);
  }
  // A grill is under way while a grill agent runs and while a Grill tap waits on its reply, not because the card says grilling.
  assert.deepEqual([card({ item: { phase: 'grilling' } }).grilling, card({ item: { phase: 'grilling' }, owner: { items: [q] } }).grilling], [false, false]);
  const grill = { kind: 'grill', started: '2026-10-23T10:00:00Z' };
  assert.equal(card({ item: { state: 'ready' }, agents: { A1: { main: grill } } }).grilling, true);
  assert.equal(card({ item: { state: 'ready' }, agents: { A1: { main: { ...grill, done: '2026-10-23T10:30:00Z' } } } }).grilling, false);
  assert.equal(card({ item: { phase: 'ready' }, events: [{ id: 'g1', ts: '2026-10-23T10:00:00Z', kind: 'grill-more', data: { key: 'w/A1' } }] }).grilling, true);
  // A grill-more event is handled by a reply, by questions posted on the card after it, or by a grill agent that started after it and finished.
  const event = { id: 'g1', ts: '2026-10-23T10:00:00Z', kind: 'grill-more', data: { key: 'w/A1' } };
  const grilling = (extra) => card({ item: { phase: 'ready' }, events: [event], ...extra }).grilling;
  const posted = (asked_at) => ({ items: [{ id: 'q1', topic: 'item:w/A1', question: 'Which?', asked_at }] });
  assert.deepEqual([grilling({ owner: posted('2026-10-23T10:05:00Z') }), grilling({ owner: posted('2026-10-23T09:00:00Z') })], [false, true]);
  const ran = (started, done) => ({ agents: { A1: { main: { kind: 'grill', started, done } } } });
  assert.deepEqual([
    grilling(ran('2026-10-23T10:01:00Z', '2026-10-23T10:30:00Z')), grilling(ran('2026-10-23T10:01:00Z')), grilling(ran('2026-10-23T09:00:00Z', '2026-10-23T09:30:00Z')),
  ], [false, true, true]);
  // The board server opens the grill in the request's own millisecond.
  assert.equal(grilling(ran('2026-10-23T10:00:00Z', '2026-10-23T10:30:00Z')), false);
  // A card's Prototype tap is under way the same way, until questions post, a reply comes or a prototype agent that started after it finishes.
  const tap = { id: 'p1', ts: '2026-10-23T10:00:00Z', kind: 'prototype-request', data: { key: 'w/A1' } };
  const prototyping = (extra) => card({ item: { phase: 'ready' }, events: [tap], ...extra });
  assert.deepEqual([prototyping().prototyping, prototyping().grilling], [true, false]);
  const drew = (started, done) => ({ agents: { A1: { main: { kind: 'prototype', started, done } } } });
  assert.deepEqual([
    prototyping({ owner: posted('2026-10-23T10:05:00Z') }).prototyping, prototyping({ owner: posted('2026-10-23T09:00:00Z') }).prototyping,
    prototyping({ events: [{ ...tap, reply: { at: '2026-10-23T10:02:00Z' } }] }).prototyping,
    prototyping(drew('2026-10-23T10:01:00Z', '2026-10-23T10:30:00Z')).prototyping, prototyping(drew('2026-10-23T10:01:00Z')).prototyping,
  ], [false, true, false, false, true]);
  assert.equal(card({ item: { phase: 'ready' }, ...drew('2026-10-23T09:00:00Z') }).prototyping, true);
  // A prototype request on one question is the questions page's eye, not the card's tap.
  assert.equal(card({ item: { phase: 'ready' }, events: [{ ...tap, data: { key: 'w/A1', question: 'q1' } }] }).prototyping, false);
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
  // Answers sharing a ts are one message; each answer's own state is read from its event id.
  const states = (a) => Object.fromEntries(threadOf('w/A1', { events, owner, agents: a }).flatMap(stateEntries).map(([id, state]) => [id.replace(/^a-/, ''), state]));
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
  const todo = (items) => todoOf(buildBoard({ fromWaves: false, events: [], owner: {}, prs: {}, files: [{ slug: 'w', itemFile: { repo: 'o/r', items } }] }).items);
  const base = [{ id: 'A1', title: 'One' }, { id: 'A2', title: 'Two', deps: ['A1'] }, { id: 'A3', title: 'Running', lane: 'progress' }];
  const seen = todo(base);
  assert.equal(todo([...base]), seen);
  assert.notEqual(todo([...base, { id: 'A4', title: 'New' }]), seen);
  assert.notEqual(todo([{ ...base[0], title: 'One, renamed' }, ...base.slice(1)]), seen);
  assert.notEqual(todo([base[0], { ...base[1], deps: [] }, base[2]]), seen);
  assert.equal(todo([base[0], base[1], { ...base[2], title: 'Running, renamed' }]), seen);
  assert.equal(todo([base[0], base[1], { ...base[2], lane: 'done' }]), seen);
  assert.equal(todo([{ id: 'A3', title: 'Running', lane: 'progress' }]), '');
});

// docs/adr/2026-11-04-0307-the-board-keeps-the-newest-100-done-cards.md
// docs/adr/2026-11-04-1900-triage-runs-once-overnight-on-cards-waiting-on-your-answers.md
test("triageOf names the open cards waiting on unanswered questions, and what it saw changes with them or with Todo", () => {
  const card = (key, lane, open = 0, askedAt = []) => ({ key, kind: 'work', lane, title: key, deps: [], questions: open ? { open, askedAt } : null });
  const base = [card('w/T1', 'todo', 2, ['2026-11-04T10:00:00Z']), card('w/T2', 'todo'), card('w/P1', 'progress', 1, ['2026-11-04T11:00:00Z'])];
  const seen = triageOf(base);
  assert.deepEqual(seen.waiting, ['w/T1', 'w/P1']);
  assert.deepEqual(triageOf([...base, card('w/D1', 'done', 1)]), seen, 'a Done task waits on nothing');
  assert.deepEqual(triageOf([...base, { ...card('w/N1', 'new', 1), kind: 'note' }]).waiting, seen.waiting, 'only work tasks');
  assert.deepEqual(triageOf([card('w/T1', 'todo', 0), ...base.slice(1)]).waiting, ['w/P1'], 'answered questions wait on nothing');
  assert.notEqual(triageOf([card('w/T1', 'todo', 3, ['2026-11-04T10:00:00Z', '2026-11-04T12:00:00Z']), ...base.slice(1)]).seen, seen.seen, 'a new question');
  assert.notEqual(triageOf([...base, card('w/T3', 'todo')]).seen, seen.seen, 'a Todo change');
});

test('a triage sees stale reviews beside Todo, and never Done ones, which leave the board by the archive rule', () => {
  const card = (key, lane, stale = false) => ({ key, lane, stale, title: key, deps: [] });
  const todo = todoOf([card('w/T1', 'todo')]);
  assert.notEqual(todoOf([card('w/T1', 'todo'), card('w/S1', 'review', true)]), todo);
  assert.match(todoOf([card('w/S1', 'review', true)]), /w\/S1/);
  assert.equal(todoOf([card('w/T1', 'todo'), card('w/R1', 'review')]), todo);
  assert.equal(todoOf([card('w/T1', 'todo'), card('w/D1', 'done')]), todo);
});

// docs/adr/2026-11-03-1551-planners-and-implementers-are-two-kinds-of-agent.md
// docs/adr/2026-11-05-0410-a-card-status-word-comes-from-a-signal-the-board-checks.md
test("a headless builder whose process lives is never stale however long it is silent, and stopped the moment its process is gone without done; one with no known process goes stale after 15 minutes", () => {
  const worktree = { path: '/w/GH-1' };
  const record = { kind: 'claude', started: '2026-10-30T10:00:00Z', worktree };
  const at = (minutes) => Date.parse(record.started) + minutes * 60000;
  const card = (minutes, { moved, alive } = {}) => board({ now: at(minutes), agents: { A1: { main: record } }, moved, alive }).items.find((i) => i.key === 'w/A1').builder;
  assert.equal('quiet' in card(5, { alive: { 'w/A1': true } }), false);
  // A live process is never stale, however long it is silent.
  assert.deepEqual([card(90, { alive: { 'w/A1': true } }).alive, card(90, { alive: { 'w/A1': true } }).stale], [true, false]);
  const stopped = card(1, { alive: { 'w/A1': false } });
  assert.deepEqual([stopped.alive, stopped.stale], [false, true]);
  const untracked = card(14, { alive: {} });
  assert.deepEqual([untracked.alive, untracked.stale], [null, false]);
  assert.equal(card(15, { alive: {} }).stale, true);
  assert.equal(card(30, { alive: {}, moved: { '/w/GH-1': at(20) } }).stale, false, 'transcript movement is a sign of life');
});

test("a running planner's line is the card's builder line, marked planner, until a build runs, whose line wins; before its first line a planner reads its kind's word, grilling for a grill and prototyping for a prototype", () => {
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
  assert.equal(card({ main: { ...proto, kind: 'grill', model: 'opus' } }, {}).builder.progress, 'grilling');
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

// docs/adr/2026-11-07-0700-one-agents-status-lines-fold-into-one-line.md
test("a thread's status line names the agent it belongs to: the newest started of its kind of work that was running at its time; a line no agent covers names none", () => {
  const agents = {
    old: { kind: 'claude', model: 'opus', label: 'Builder', started: '2026-10-23T10:00:00Z', done: '2026-10-23T10:10:00Z' },
    build: { kind: 'claude', model: 'opus', label: 'Builder', started: '2026-10-23T10:20:00Z' },
    proto: { kind: 'prototype', model: 'sonnet', label: 'Prototype', started: '2026-10-23T10:15:00Z' },
  };
  const status = (ts, planner) => ({ ts, who: 'claude', kind: 'status', text: `at ${ts}`, ...(planner ? { planner: true } : {}) });
  const lines = [status('2026-10-23T09:00:00Z'), status('2026-10-23T10:05:00Z'), status('2026-10-23T10:16:00Z', true), status('2026-10-23T10:25:00Z'), status('2026-10-23T10:26:00Z', true)];
  const got = threadOf('w/A1', { lines, agents }).filter((m) => m.kind === 'status').map((m) => [m.ts.slice(11, 16), m.run || null, m.running ?? null]);
  assert.deepEqual(got, [['09:00', null, null], ['10:05', '2026-10-23T10:00:00Z', false], ['10:16', '2026-10-23T10:15:00Z', true], ['10:25', '2026-10-23T10:20:00Z', true], ['10:26', '2026-10-23T10:15:00Z', true]]);
  const ends = threadOf('w/A1', { lines, agents }).filter((m) => m.kind === 'agent').map((m) => [m.text.split(' ').pop(), m.run, m.agent]);
  assert.deepEqual(ends.filter(([, run]) => run === '2026-10-23T10:00:00Z'), [['started', '2026-10-23T10:00:00Z', 'Claude Opus implementer'], ['finished', '2026-10-23T10:00:00Z', 'Claude Opus implementer']]);
  // A line's own run id wins over the time guess: this one falls in both runs' time but names the older.
  const tagged = threadOf('w/A1', { lines: [{ ...status('2026-10-23T10:25:00Z'), run: '2026-10-23T10:00:00Z' }], agents }).find((m) => m.kind === 'status');
  assert.deepEqual([tagged.run, tagged.running], ['2026-10-23T10:00:00Z', false]);
});

test("a run's started line carries the log its launch recorded on the agent's session, and a record with none carries none", () => {
  const agents = {
    main: { kind: 'claude', model: 'opus', label: 'Builder', started: '2026-10-23T10:00:00Z', session: { id: 's1', pid: 1, log: 'builder-A1-x.log', at: '2026-10-23T10:00:01Z' } },
    bare: { kind: 'claude', model: 'opus', label: 'Builder', started: '2026-10-23T10:05:00Z' },
  };
  const started = threadOf('w/A1', { agents }).filter((m) => m.kind === 'agent' && !m.finished).map((m) => [m.run, m.log ?? null]);
  assert.deepEqual(started, [['2026-10-23T10:00:00Z', 'builder-A1-x.log'], ['2026-10-23T10:05:00Z', null]]);
});

// docs/adr/2026-11-04-2130-a-button-tap-is-a-status-line-or-a-message-footer.md
// docs/adr/2026-11-06-0021-a-button-without-a-text-box-posts-a-keyed-status-line.md
test("a card's bare Grill and Prototype taps are muted request entries in its thread carrying their command key, one with text is the owner's message with the request as its footer status, an answer's status is answers submitted, and an ask sent with Implement reads Implementation requested under it", () => {
  const ev = (id, kind, data, ts) => ({ id, ts, kind, data: { key: 'w/A1', ...data }, reply: null });
  const events = [
    { id: 'a1', ts: '2026-10-23T09:00:00Z', kind: 'ask', data: { text: 'Add a badge', quick: true }, reply: null },
    ev('g1', 'grill-more', {}, '2026-10-23T10:00:00Z'), ev('p1', 'prototype-request', {}, '2026-10-23T10:01:00Z'),
    ev('g2', 'grill-more', { text: 'Ask about the colours' }, '2026-10-23T10:02:00Z'), ev('p2', 'prototype-request', { text: 'Phone width first' }, '2026-10-23T10:03:00Z'),
    { id: 'q1a', ts: '2026-10-23T10:04:00Z', kind: 'owner-answer', data: { id: 'q1', label: 'A. Keep it', note: 'yes' }, reply: null },
  ];
  const msgs = threadOf('w/A1', { events, fromAsk: 'a1', owner: { items: [{ id: 'q1', topic: 'item:w/A1', question: 'Keep it?' }] } });
  assert.deepEqual(msgs.map((m) => [m.kind, m.text, Boolean(m.request), m.status || null, m.command || null]), [
    ['ask', 'Add a badge', false, null, null], ['command', 'Implementation requested', true, null, 'implement'],
    ['grill-more', 'Grill requested', true, null, 'grill'], ['prototype-request', 'Prototype requested', true, null, 'prototype'],
    ['grill-more', 'Ask about the colours', false, 'Grill requested', null], ['prototype-request', 'Phone width first', false, 'Prototype requested', null],
    ['owner-answer', 'Question 1 · Keep it?\n→ A. Keep it · yes', false, 'answers submitted', null],
  ]);
  assert.deepEqual(msgs.filter((m) => m.status).map((m) => m.state), ['waiting', 'waiting', 'waiting']);
  assert.equal(threadOf('w/A1', { events: [{ ...events[0], data: { text: 'Add a badge' } }], fromAsk: 'a1' }).length, 1);
});

// docs/adr/2026-11-05-0300-implement-in-the-thread-queues-the-card-for-the-orchestrator.md
test("a thread message's footer names Implement when that sent it; a Reply, being the default message, and a one-button box's message have none", () => {
  const ev = (id, data) => ({ id, ts: `2026-10-23T10:0${id.slice(1)}:00Z`, kind: 'item-message', data: { key: 'w/A1', ...data }, reply: null });
  const events = [ev('m1', { text: 'Use the blue', intent: 'build' }), ev('m2', { text: 'Just a reply', intent: 'reply' }), ev('m3', { text: 'Sent' })];
  const shown = (opts) => threadOf('w/A1', { events, ...opts }).map((m) => [m.text, m.status || null, Boolean(m.request)]);
  assert.deepEqual(shown({}), [['Use the blue', 'Implement', false], ['Just a reply', null, false], ['Sent', null, false]]);
});

// docs/adr/2026-11-06-0021-a-button-without-a-text-box-posts-a-keyed-status-line.md
test("a thread-file line a button wrote is a request line carrying its command key, naming its mark when its words vary", () => {
  const lines = [
    { ts: '2026-10-23T10:00:00Z', who: 'love', text: 'Implementation requested', command: 'implement' },
    { ts: '2026-10-23T10:01:00Z', who: 'love', text: 'Held until Fri 10/24, 9:00 AM', command: 'hold', by: 'Dana Reyes' },
    { ts: '2026-10-23T10:02:00Z', who: 'love', text: 'Earlier hand-typed line' },
  ];
  assert.deepEqual(threadOf('w/A1', { lines }).map((m) => [m.kind ?? null, m.command ?? null, Boolean(m.request), m.mark ?? null, m.by ?? null]), [
    ['command', 'implement', true, 'Implementation requested', null], ['command', 'hold', true, 'Held', 'Dana Reyes'], [null, null, false, null, null],
  ]);
  // A link's line names the other card by key, drawn with its ref as it stands, and links to it.
  const cards = new Map([['w/A2', { ref: '#12' }]]);
  const linked = threadOf('w/A1', { lines: [{ ts: '2026-11-06T10:00:00Z', who: 'claude', text: 'Related to', command: 'related', card: 'w/A2' }], cards });
  assert.deepEqual(linked.map((m) => [m.text, m.words, m.link, m.card, m.mark]), [['Related to #12', 'Related to', '#selectedCard=w%2FA2', 'w/A2', 'Related to']]);
  assert.deepEqual(Object.keys(COMMANDS), ['implement', 'prototype', 'grill', 'visual', 'reask', 'hold', 'resume', 'done', 'reopened', 'discussing', 'staged', 'readied', 'related', 'unrelated', 'followup', 'followup-of', 'created', 'created-from', 'blocked-by', 'unblocks']);
});

test('only a running build keeps the board from being idle: a running planner leaves Pull free to start the next ready card', () => {
  const card = (agents) => ({ key: 'w/A1', lane: 'todo', buildable: true, phase: 'ready', blockedBy: [], agents });
  for (const kind of ['prototype', 'grill']) assert.equal(pullOf([card([{ kind, started: '2026-10-23T10:00:00Z', done: null }])]).idle, true, kind);
  assert.equal(pullOf([card([{ kind: 'claude', started: '2026-10-23T10:00:00Z', done: null }])]).idle, false);
});

// docs/adr/2026-11-13-1126-the-implementer-limit-counts-cards-in-progress.md
test('every card In Progress takes one implementer slot until it lands, whatever runs on it; the pull fills the rest, bumped first, and a card pulled but not started keeps its slot', () => {
  const at = '2026-11-13T10:00:00Z';
  const run = (kind, more = {}) => ({ name: 'main', kind, started: at, done: null, ...more });
  const card = (key, more = {}) => ({ key, title: 'feat: task', lane: 'todo', kind: 'work', buildable: true, phase: 'ready', blockedBy: [], questions: null, grilling: false, working: false, held: false, agents: [], ...more });
  const progress = (key, more) => card(key, { lane: 'progress', buildable: false, state: null, ...more });
  const todo = ['w/T1', 'w/T2', 'w/T3'].map((k) => card(k));
  const bumped = card('w/T4', { bumpedAt: at });
  const lane = [
    progress('w/P1', { agents: [run('claude')] }),
    progress('w/P2', { waitsOn: 'checking', agents: [run('claude', { done: at })] }),
    progress('w/P3', { builder: { phase: 'landing' }, agents: [run('claude', { label: 'Lander' })] }),
    progress('w/P4', { waitsOn: 'owner' }),
    progress('w/P5', { agents: [run('claude', { pause: { cause: 'usage', at, paused: at } })] }),
    progress('w/P6', { stalled: 'Crashed twice', agents: [run('claude', { stopped: { run: 'build', at } })] }),
    progress('w/P7', { agents: [run('claude', { waits: 'tests' }), { name: 'tests', kind: 'helper', writes: true, started: at, done: null }] }),
  ];
  const others = [card('w/R1', { lane: 'review', buildable: false, agents: [run('claude', { label: 'Rebase' })] }), card('w/G1', { phase: 'grilling', grilling: true, agents: [{ kind: 'grill', started: at, done: null }] })];
  const full = pullOf([...lane, ...others, ...todo, bumped], { cap: 7 });
  assert.deepEqual([full.free, full.pulls], [0, []], 'building, checking, landing, waiting on the owner, paused, stalled or helped: each task In Progress is one slot');
  assert.deepEqual(pullOf([...lane, ...others, ...todo, bumped], { cap: 9 }).pulls, ['w/T4', 'w/T1'], 'a task In Review or Todo takes none, and the bumped task goes first');
  const landed = pullOf([...lane.filter((i) => i.key !== 'w/P2'), { ...lane[1], lane: 'done' }, ...todo, bumped], { cap: 7 });
  assert.deepEqual(landed.pulls, ['w/T4'], 'once one lands, the next starts, bumped first');
  assert.deepEqual(pullOf([...lane, ...todo]).pulls, ['w/T1', 'w/T2', 'w/T3'], 'the default cap leaves room for every ready task');
  assert.equal(pullOf([lane[1]]).idle, false, 'a task in Orchestrator review keeps the board from idle');
  assert.equal(pullOf([lane[3]]).idle, true, 'a task waiting on the owner leaves it idle');

  const sent = pullOf([lane[0], ...todo], { cap: 3, pulled: ['w/T1'] });
  assert.deepEqual([sent.waiting, sent.pulls], [['w/T1'], ['w/T2']], 'a pulled task not yet started keeps its slot and is not pulled again');
  const working = pullOf([lane[0], card('w/T1', { working: true }), ...todo.slice(1)], { cap: 3, pulled: ['w/T1'] });
  assert.deepEqual([working.waiting, working.pulls], [['w/T1'], ['w/T2']], 'while the session works on the pull the task keeps its slot');
  const started = pullOf([progress('w/T1', { agents: [run('claude')] }), ...todo.slice(1)], { cap: 2, pulled: ['w/T1'] });
  assert.deepEqual([started.waiting, started.pulls], [[], ['w/T2']], 'once it is In Progress it counts as a task in the lane instead');
  const asked = pullOf([card('w/T1', { phase: 'staging' }), ...todo.slice(1)], { cap: 1, pulled: ['w/T1'] });
  assert.deepEqual([asked.waiting, asked.pulls], [[], ['w/T2']], 'a pulled task that stops being pullable frees its slot');
});

// docs/adr/2026-11-13-1126-the-implementer-limit-counts-cards-in-progress.md
test('every helper a card asks for launches at once, whatever the cap, and a read-only helper alone leaves the board idle', () => {
  const at = '2026-11-06T10:00:00Z';
  const card = (key, more = {}) => ({ key, title: 'feat: task', lane: 'todo', kind: 'work', buildable: true, phase: 'ready', blockedBy: [], questions: null, grilling: false, working: false, held: false, agents: [], ...more });
  const progress = (key, agents) => card(key, { lane: 'progress', buildable: false, state: null, agents });
  const main = (more = {}) => ({ name: 'main', kind: 'claude', started: at, done: null, ...more });
  const helper = (name, more = {}) => ({ name, kind: 'helper', writes: true, started: at, done: null, ...more });
  const asked = (name, writes = true) => helper(name, { started: null, requested: at, writes });
  const top = progress('w/P1', [main(), asked('a'), asked('look', false)]);
  const out = pullOf([top, card('w/T1')], { cap: 1 });
  assert.deepEqual([out.helpers, out.pulls], [[{ key: 'w/P1', name: 'a' }, { key: 'w/P1', name: 'look' }], []]);
  assert.deepEqual(pullOf([{ ...top, lane: 'done' }], { cap: 5 }).helpers, [], 'a closed task launches none');
  assert.equal(pullOf([progress('w/P1', [main(), helper('survey', { writes: false })])]).idle, false);
  assert.equal(pullOf([progress('w/P1', [helper('survey', { writes: false })])]).idle, true, 'a read-only helper alone leaves the board idle, as a planner does');
});

// docs/adr/2026-11-03-1631-the-idle-pull-takes-ready-cards-first.md
test('the pull takes only ready cards in board order, never a card with no state', () => {
  const card = (key, more = {}) => ({ key, title: 'feat: task', lane: 'todo', kind: 'work', buildable: true, state: null, blockedBy: [], questions: null, grilling: false, working: false, held: false, agents: [], ...more });
  const items = [card('w/A1'), card('w/A2', { phase: 'ready' }), card('w/A3'), card('w/A4', { phase: 'ready' }), card('w/A5', { phase: 'ready', blockedBy: [{ key: 'w/X' }], blocked: true })];
  assert.deepEqual(pullOf(items).pullable, ['w/A2', 'w/A4']);
});

// docs/adr/2026-11-04-2359-every-card-arriving-in-todo-is-grilled-by-the-board.md
test('a card arrives in Todo however it was filed, until something picks it up, and the planner cap takes arrivals from the top', () => {
  const card = (key, more = {}) => ({ key, lane: 'todo', kind: 'work', buildable: true, state: null, blockedBy: [], questions: null, grilling: false, prototyping: false, working: false, held: false, agents: [], ...more });
  const at = '2026-11-04T10:00:00Z';
  const arrived = [
    card('w/A1'),
    card('w/A2', { phase: 'grilling', fromAsk: 'e1' }),
    card('w/A3', { phase: 'prototyping' }),
  ];
  const pickedUp = [
    card('w/B1', { phase: 'ready' }),
    card('w/B2', { held: true }),
    card('w/B5', { grilling: true }),
    card('w/B6', { prototyping: true }),
    card('w/B7', { questions: { topic: 'item:w/B7', open: 0, answered: 0, resolved: 2 } }),
    card('w/B8', { agents: [{ kind: 'grill', started: at, done: at }] }),
    card('w/B9', { buildable: false, action: { kind: 'questions' } }),
    card('w/C1', { lane: 'progress', buildable: false }),
    card('w/C2', { lane: 'done', buildable: false }),
  ];
  assert.deepEqual(arrivalsOf([...pickedUp, ...arrived], { cap: 99 }), ['w/A1', 'w/A2', 'w/A3']);
  // docs/adr/2026-11-13-1800-every-wait-is-listed-and-working-is-display-only.md: a working mark doesn't pick a card up.
  assert.deepEqual(arrivalsOf([card('w/W1', { working: true })]), ['w/W1'], 'a card a session works on still arrives');
  // docs/adr/2026-11-09-1939-a-block-only-keeps-a-card-from-in-progress.md: a block stops a build, not a plan.
  assert.deepEqual(arrivalsOf([card('w/B0', { blockedBy: [{ key: 'w/X' }], blocked: true })]), ['w/B0'], 'a blocked task arrives and is grilled');
  const blockedOrNot = [card('w/K1', { blocked: true }), card('w/K2'), card('w/K3', { blocked: true }), card('w/K4')];
  assert.deepEqual(arrivalsOf(blockedOrNot, { cap: 3 }), ['w/K2', 'w/K4', 'w/K1'], 'unblocked arrivals take the planner slots first, then blocked ones, each in board order');
  assert.deepEqual(arrivalsOf([...blockedOrNot, card('w/K5', { blocked: true, bumpedAt: at })], { cap: 2 }), ['w/K5', 'w/K2'], 'a bump still comes first');
  // docs/adr/2026-11-05-0130-the-orchestrator-links-a-new-card-when-it-files-it.md: filed and linked before its grill.
  assert.deepEqual(arrivalsOf([card('w/U0', { unsorted: true })]), [], 'a task that reads New arrives once its session files it');
  assert.deepEqual(arrivalsOf([...pickedUp, ...arrived]), ['w/A1', 'w/A2', 'w/A3'], 'the default cap takes three');
  const running = card('w/R1', { buildable: false, agents: [{ kind: 'grill', started: at, done: null }] });
  const drawing = card('w/R2', { lane: 'progress', buildable: false, agents: [{ kind: 'prototype', started: at, done: null }] });
  assert.deepEqual(arrivalsOf([running, drawing, ...arrived], { cap: 3 }), ['w/A1'], 'each running planner takes a slot');
  assert.deepEqual(arrivalsOf([running, drawing, ...arrived], { cap: 2 }), [], 'a cap already reached launches nothing');
  const building = card('w/R3', { lane: 'progress', buildable: false, agents: [{ kind: 'claude', started: at, done: null }] });
  assert.deepEqual(arrivalsOf([building, ...arrived], { cap: 1 }), ['w/A1'], 'a running build takes no planner slot');
});

// docs/adr/2026-11-03-1731-each-board-reviews-incoming-prs-that-touch-its-work.md
test("a held incoming-PR review is in the Auto Review lane, in Needs you and among the owner's pushes", () => {
  const built = buildBoard({
    autoReview: true, files: [{ slug: 'w', itemFile: { repo: 'o/r', items: [{ id: 'A1', title: 'One' }] } }],
    incoming: { at: '2026-11-03T11:56:00Z', repo: 'o/r', prs: [{ number: 437, title: 'One endpoint', author: 'quinn', url: 'u', head: 'h', touches: ['w/A1'], asked: false }] },
    reviewRecords: { 437: { number: 437, title: 'One endpoint', author: 'quinn', url: 'u', head: 'h', touches: ['w/A1'], state: 'needs', text: 'Clashes with A1.', at: '2026-11-03T11:58:00Z' } },
    now: Date.parse('2026-11-03T12:00:00Z'),
  });
  assert.deepEqual(built.reviews.cards.map((c) => [c.number, c.state, c.touches.map((t) => t.key)]), [[437, 'needs', ['w/A1']]]);
  assert.deepEqual(needsAnswer(built).items.at(-1), { kind: 'Review', text: 'PR #437 One endpoint · review held for you', url: '#review=437' });
  assert.match(built.needsSummary, /1 review held/);
  assert.deepEqual(ownerActions(built).map((a) => a.tag), ['review-437']);
});

test("a card whose code landed stays in In Review on its owner step, the step as its Next with no bump, until the owner's Done; an open PR, a Done card whose PR closed unmerged and a reopening go as before", () => {
  const step = 'Add the npm trusted publisher and tag a release';
  const close = (ts) => ({ id: 'c' + ts, ts, kind: 'card-done', data: { key: 'w/A1' }, reply: null });
  const merged = { ...greenDraft, isDraft: false, state: 'MERGED', mergedAt: '2026-10-23T11:00:00Z' };
  const card = (item, { pr = merged, events = [], threads = {} } = {}) => board({ pr, events, threads, item: { lane_at: '2026-10-23T11:00:00Z', closed_at: '2026-10-23T11:00:00Z', owner_step: step, ...item } }).items.find((i) => i.key === 'w/A1');
  const look = (c) => [c.lane, c.waitsOn, c.next, c.ownerStep, c.awaitsDone, c.bumpable, c.action, c.finishable];
  const waiting = ['review', 'owner', step, step, true, false, null, true];
  assert.deepEqual(look(card({})), waiting);
  assert.deepEqual(look(card({ lane: 'done' }, { pr: null })), waiting);
  assert.deepEqual(look(card({ lane: 'done', prs: [{ number: 7, merged_at: '2026-10-23T11:00:00Z' }] }, { pr: null })), waiting);
  // The owner's Done closes it at once; a Done older than the landing doesn't.
  assert.deepEqual(look(card({ lane: 'done' }, { events: [close('2026-10-23T11:30:00Z')] })).slice(0, 4), ['done', null, null, null]);
  assert.deepEqual(look(card({ lane: 'done', lane_at: '2026-10-23T11:40:00Z', closed_at: '2026-10-23T11:40:00Z' }, { events: [close('2026-10-23T11:30:00Z')] })), waiting);
  // Before the code lands the card waits on its PR as ever.
  const open = card({}, { pr: { ...greenDraft, isDraft: false, checks: { state: 'pass' } } });
  assert.deepEqual([open.lane, open.next, open.ownerStep], ['review', 'Waiting for PR reviewers', null]);
  // A Done card whose PR closed unmerged never landed: its step doesn't hold it.
  assert.deepEqual(look(card({ lane: 'done' }, { pr: { ...merged, state: 'CLOSED', mergedAt: null } })).slice(0, 4), ['done', null, null, null]);
  // A reopened card Claude has answered waits on the same Done, reading its step.
  const msg = { id: 'm1', ts: '2026-10-23T11:30:00Z', kind: 'item-message', data: { key: 'w/A1', text: 'One more thing' }, reply: null };
  const answered = card({ lane: 'done' }, { events: [msg], threads: { 'w/A1': [{ ts: '2026-10-23T11:40:00Z', who: 'claude', text: 'Done that.' }] } });
  assert.deepEqual(look(answered), waiting);
  // Until Claude answers, the reply keeps it in In Review waiting on the orchestrator
  // (docs/adr/2026-11-09-1804-in-progress-means-a-builder-runs.md).
  assert.deepEqual(look(card({ lane: 'done' }, { events: [msg] })), ['review', null, 'Your reply waits on the orchestrator', null, false, true, null, true]);
});

// docs/adr/2026-11-04-2308-an-owner-step-can-carry-a-code-check.md
test("a card waiting on its owner step reads what its code check waits for, or that the check can't run", () => {
  const step = 'Publish kickflip to npm';
  const card = (item) => board({ pr: null, item: { lane: 'done', lane_at: '2026-10-23T11:00:00Z', closed_at: '2026-10-23T11:00:00Z', owner_step: step, ...item } }).items.find((i) => i.key === 'w/A1');
  assert.deepEqual(card({ owner_check: { check: 'npm kickflip 0.3.*', since: '2026-10-23T11:00:00Z' } }).ownerCheck, { words: 'kickflip@0.3.* on npm', broken: null });
  assert.deepEqual(card({ owner_check: { check: 'npm kickflip 0.3.*', since: '2026-10-23T11:00:00Z', broken: 'npm view failed: E404' } }).ownerCheck,
    { words: 'kickflip@0.3.* on npm', broken: 'npm view failed: E404' });
  assert.equal(card({}).ownerCheck, null);
  // Before the code lands, the card waits on its build and reads no check.
  assert.equal(card({ lane: 'progress', owner_check: { check: 'npm kickflip 0.3.*', since: '2026-10-23T11:00:00Z' } }).ownerCheck, null);
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

test('with Skip the draft on, a draft waits on its CI in In Review with no Action needed, reads Fix the failing CI there once red, and a ready PR reads as before', () => {
  const card = (pr) => board({ pr, skipDraft: true }).items.find((i) => i.key === 'w/A1');
  for (const checks of ['pending', 'pass', 'none']) {
    const c = card({ ...greenDraft, checks: { state: checks } });
    assert.deepEqual([c.lane, c.waitsOn, c.next, c.action, c.resolvedBy], ['review', 'ci', 'Marked ready for review once CI passes', null, null], checks);
  }
  const red = card({ ...greenDraft, checks: { state: 'fail' } });
  assert.deepEqual([red.lane, red.waitsOn, red.next, red.action], ['review', null, 'Fix the failing CI', null]);
  const ready = card({ ...greenDraft, isDraft: false });
  assert.deepEqual([ready.lane, ready.waitsOn, ready.next, ready.action], ['review', 'reviewers', 'Waiting for PR reviewers', null]);
  assert.deepEqual(board({ skipDraft: true }).needs, []);
});

// docs/adr/2026-11-04-0257-an-idle-board-pushes-once-when-it-has-gone-idle.md
test('a board is strictly idle only with nothing building, grilling, prototyping, landing or pulled', () => {
  const at = '2026-11-04T10:00:00Z';
  const built = (item = {}, agents = {}, events = []) => buildBoard({ now: Date.parse(at), owner: {}, events,
    files: [{ slug: 'w', agents, itemFile: { internal: true, items: [{ id: 'A1', title: 'feat: one', ...item }, { id: 'A2', title: 'Two', lane: 'done', closed_at: at }] } }] });
  assert.equal(strictlyIdle(built()), true, 'a ready task with nothing running is idle');
  assert.equal(strictlyIdle(built({}, { A1: { main: { kind: 'claude', started: at } } })), false, 'a builder runs');
  assert.equal(strictlyIdle(built({}, { A1: { main: { kind: 'claude', started: at, done: at } } })), true, 'a finished builder');
  assert.equal(strictlyIdle(built({}, { A1: { main: { kind: 'grill', started: at } } })), false, 'a grill runs');
  assert.equal(strictlyIdle(built({}, {}, [{ id: 'e1', ts: at, kind: 'prototype-request', data: { key: 'w/A1' }, reply: null }])), false, 'a prototype is under way');
  assert.equal(strictlyIdle(built({ lane: 'progress' }, { A1: { main: { kind: 'claude', started: at, done: at, handed_back: at } } })), false, 'a task waits to land');
  assert.equal(strictlyIdle(built({ phase: 'ready' }), { pulled: ['w/A1'] }), false, 'a pulled task waits to start');
  assert.equal(strictlyIdle(built({ phase: 'ready' })), true, 'a ready task nobody pulled');
  assert.equal(strictlyIdle({ ...built(), working: 1 }), true, 'a working mark is display only');
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
    { id: 'A1', title: 'Old', lane: 'done', closed_at: '2026-11-04T09:00:00Z' },
    { id: 'A2', title: 'Two', lane: 'done', closed_at: '2026-11-04T10:10:00Z' },
    { id: 'A3', title: 'Three', lane: 'done', closed_at: '2026-11-04T10:20:00Z', prs: [{ repo: 'o/r', number: 3, merged_at: '2026-11-04T10:20:00Z' }] },
    { id: 'A4', title: 'Unlanded', lane: 'done', closed_at: '2026-11-04T10:20:00Z', prs: [{ repo: 'o/r', number: 4 }] },
    { id: 'B1', title: 'Open' },
  ];
  const waves = [{ slug: 'mon', title: 'Monitor', items: ['A1', 'A2', 'A3'] }, { slug: 'open', title: 'Still open', items: ['A4', 'B1'] }];
  const built = buildBoard({ now: Date.parse('2026-11-04T11:00:00Z'), events: [], owner: {}, prs: { 'o/r#4': { state: 'CLOSED' } }, files: [{ slug: 'w', itemFile: { internal: true, items, waves } }] });
  const ref = (id) => built.items.find((i) => i.id === id).ref;
  assert.equal(idleSummary(built.items, '2026-11-04T10:00:00Z'), `2 tasks landed: ${ref('A3')}, ${ref('A2')} · Monitor finished`);
  assert.equal(idleSummary(built.items, '2026-11-04T10:15:00Z'), `1 task landed: ${ref('A3')} · Monitor finished`);
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
  // The two answers share a ts, so they fold into one message in log order.
  const thread = threadOf('w/A1', { events, owner, fromAsk: 'k0' });
  assert.deepEqual(thread.map((m) => m.eventId), ['k0', 'm1', 'm2', 'm3', 'a2']);
  assert.deepEqual(thread.at(-1).answers.map((a) => a.eventId), ['a2', 'a1']);
  assert.deepEqual(threadOf('w/A1', { events, owner, fromAsk: 'k0', moved: ['k0'] }).map((m) => m.eventId), ['k0', 'm1', 'm2', 'm3', 'a2']);
});

// docs/adr/2026-11-04-0349-the-board-is-built-once-per-data-version.md: the server shares one build of its data and adds
// the hub's side, the session's pending prompts and whether it listens, to each board it serves.
test("the hub's side added to a shared build gives the board built with it", () => {
  const perm = { id: 'p1', tool: 'Bash', action: 'run npm test', detail: 'npm test', rule: 'Bash(npm test)', questions: null, cwd: '~/r', at: '2026-10-30T10:00:00Z' };
  const snapshot = { now: Date.parse('2026-10-30T11:00:00Z'), fromWaves: false, files: [], events: [], checked: { at: '2026-10-30T10:59:00Z', every: 30 } };
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
  assert.deepEqual(msgs.map((m) => [m.kind, m.text, Boolean(m.request)]), [['reask-request', 'Re-ask requested', true]]);
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
  assert.deepEqual(waits({ events: [card, asked], item: { lane: 'done' }, pr: { ...greenDraft, state: 'MERGED' } }), []);
  // The round naming the question resolves it, and a question posted after the card's request answers that.
  const round = { id: 'q1', topic: 'item:w/A1', question: 'Which?', url: 'prototype-x.html?q=q1', options: [{ id: 'A', label: 'Top' }], round_of: 'q0', asked_at: '2026-10-23T11:00:00Z' };
  assert.deepEqual(prototypeWaits(board({ owner: { items: [{ ...plain, resolved: 'Followed by prototype round 1', resolved_at: '2026-10-23T11:00:00Z' }, round] }, events: [card, asked] }), [card, asked]), []);
});

// docs/adr/2026-11-07-0115-the-orchestrator-sorts-new-tasks-itself.md
test("every unsorted new task's card or agent-added card is an intake wait from its event, picked up once the watcher marks it working, until it is sorted", () => {
  const at = (m) => `2026-11-06T10:${String(m).padStart(2, '0')}:00Z`;
  const ask = (id, m, extra = {}) => ({ id, ts: at(m), kind: 'ask', data: { text: `Task ${id}` }, reply: null, ...extra });
  const added = { id: 'c1', ts: at(3), kind: 'card-added', data: { key: 'w/A2', title: 'Follow-up' }, reply: null };
  const items = [{ id: 'A1', title: 'Filed', phase: 'grilling' }, { id: 'A2', title: 'Follow-up', unfiled: true }];
  const asked = (id, extra = {}) => ({ id: `T-${id.slice(1)}`, title: `Task ${id}`, from_ask: id, ...extra });
  const built = (events, { waveItems = items, working = {} } = {}) => buildBoard({ now: Date.parse(at(59)), events, working, files: [{ slug: 'w', agents: {}, itemFile: { internal: true, items: waveItems } }] });
  const waits = (events, options) => orchestratorWaits(built(events, options)).map(({ key, kind, since, picked, next }) => [key, kind, since, picked, next]);
  const sort = (id) => {
    const key = `w/T-${id.slice(1)}`;
    return `Sort the new task: link a ticket it names with item set ${key} --ticket <id>; discuss it with reply ${key}, which reads it discussing; item notes, then item set ${key} --phase ready, with --size, for an Implement ask, or --phase grilling or prototyping only when the ask asks for one; or merge it into a task with item relate-ask ${id} <task> --summary`;
  };
  const cards = [asked('e1'), asked('e2')];

  // An ask with no card yet waits on no one: it is unfiled, for the board server to file.
  assert.deepEqual(waits([ask('e1', 1)]), []);
  assert.deepEqual(built([ask('e1', 1)]).unfiled, ['e1']);
  assert.deepEqual(waits([ask('e1', 1), ask('e2', 2)], { waveItems: cards }), [['w/T-1', 'intake', at(1), null, sort('e1')], ['w/T-2', 'intake', at(2), null, sort('e2')]]);
  assert.deepEqual(waits([ask('e1', 1)], { waveItems: cards, working: { e1: at(4) } }), [['w/T-1', 'intake', at(1), at(4), sort('e1')]], 'picked up when the watcher marks it working');
  assert.deepEqual(waits([ask('e1', 1)], { waveItems: [asked('e1', { phase: 'grilling' })] }), [], 'a sorted task is sorted');
  assert.deepEqual(waits([ask('e1', 1, { reply: { at: at(2) } })], { waveItems: [asked('e1', { answered_at: at(2) })] }).filter((w) => w[1] === 'intake'), [], 'an answered task is sorted');
  assert.deepEqual(waits([added]), [['w/A2', 'intake', at(3), null, 'Link and file the task an agent added: item notes, then item set --relate and --phase']]);
  assert.deepEqual(waits([added], { waveItems: [{ id: 'A2', title: 'Follow-up', phase: 'grilling' }] }), [], 'a filed task is sorted');
  // A message on a work card's thread is no intake.
  const message = { id: 'm1', ts: at(4), kind: 'item-message', data: { key: 'w/A1', text: 'x' }, reply: null };
  assert.deepEqual(waits([message]).filter((w) => w[1] === 'intake'), []);
});

// docs/adr/2026-11-11-1300-a-planner-that-ends-without-its-question-waits-on-the-orchestrator.md
test("a planner's unasked line is an orchestrator wait on a card still in its phase, held until a question, a planner of its kind, or a new phase", () => {
  const at = '2026-11-04T10:00:00Z';
  const line = (kind) => ({ ts: at, who: 'claude', kind: 'hub', line: 'planner-unasked', text: `Its ${kind} planner ended without posting a question, so it waits on the orchestrator.`, detail: kind });
  const waits = ({ phase, kind, agents = {}, owner = {} }) => orchestratorWaits(buildBoard({ now: Date.parse('2026-11-04T11:00:00Z'), owner, events: [], threads: { 'w/A1': [line(kind)] }, working: {},
    files: [{ slug: 'w', agents, itemFile: { internal: true, items: [{ id: 'A1', title: 'One', lane: 'todo', phase }] } }] })).map(({ kind: k, since, next }) => [k, since, next]);
  for (const [kind, phase] of [['grill', 'grilling'], ['prototype', 'prototyping']]) {
    const ended = { A1: { planner: { kind, started: '2026-11-04T09:00:00Z', done: '2026-11-04T09:59:00Z' } } };
    assert.deepEqual(waits({ phase, kind, agents: ended }), [['unasked', at, `Its ${kind} planner ended without its question: read its log, then post the question, start the planner again, or move the task's phase`]]);
    assert.deepEqual(waits({ phase: 'ready', kind, agents: ended }), [], 'a new phase clears it');
    assert.equal(waits({ phase, kind, agents: { A1: { planner: { ...ended.A1.planner, started: '2026-11-04T10:30:00Z', done: undefined } } } }).some((w) => w[0] === 'unasked'), false, 'a planner running again clears it');
  }
  assert.deepEqual(waits({ phase: 'prototyping', kind: 'grill' }), [], 'another phase than its planner kind');
});

// docs/adr/2026-11-04-2300-each-lane-is-a-queue-for-the-orchestrator.md
test('the board lists each card idle on the orchestrator, In Progress then Todo, with since and when it was picked up', () => {
  const at = '2026-11-04T10:00:00Z';
  const later = '2026-11-04T10:20:00Z';
  const built = ({ items, agents = {}, events = [], threads = {}, owner = {}, working = {} }) => buildBoard({ now: Date.parse('2026-11-04T11:00:00Z'), owner, events, threads, working,
    files: [{ slug: 'w', agents, itemFile: { internal: true, items } }] });
  const one = (item, rest = {}) => orchestratorWaits(built({ items: [{ id: 'A1', title: 'One', ...item }], ...rest }));
  const shape = (list) => list.map(({ key, kind, since, picked }) => [key, kind, since, picked]);

  // A hand-back with unverified calls waits from when it reached checking; the session's verify picks it up.
  const handed = { A1: { main: { kind: 'claude', started: '2026-11-04T09:00:00Z', done: at, handed_back: at, calls: [{ at: '2026-11-04T09:30:00Z', text: 'x' }] } } };
  const calls = one({ lane: 'progress', next: "Verify the builder's judgment calls" }, { agents: handed });
  assert.deepEqual(shape(calls), [['w/A1', 'calls', at, null]]);
  assert.equal(calls[0].next, "Verify the builder's judgment calls");
  assert.equal(calls[0].ref, 'A1');
  const verified = { A1: { main: { ...handed.A1.main, verified: { at: later } } } };
  assert.deepEqual(shape(one({ lane: 'progress' }, { agents: verified })), [['w/A1', 'checking', at, later]], 'verified: under orchestrator review');
  const said = { 'w/A1': [{ ts: later, who: 'claude', text: 'Looking at the calls.' }] };
  assert.deepEqual(shape(one({ lane: 'progress' }, { agents: handed, threads: said })), [['w/A1', 'calls', at, later]], 'a thread line picks it up');
  const progress = { 'w/A1': [{ ts: later, who: 'claude', kind: 'status', text: 'Testing: x' }] };
  assert.deepEqual(shape(one({ lane: 'progress' }, { agents: handed, threads: progress })), [['w/A1', 'calls', at, null]], 'a status line is no pick-up');
  // The board writes command lines (staged, related, followup) on a card; none is the session's pickup.
  const staged = { phase: 'staging', staged_at: at };
  const stagedLine = { 'w/A1': [{ ts: later, who: 'claude', command: 'staged', text: 'Marked as staging' }, { ts: later, who: 'claude', command: 'related', text: 'Related to', card: 'w/A2' }] };
  assert.deepEqual(shape(one(staged, { threads: stagedLine })), [['w/A1', 'staging', at, null]], 'a board command line is no pick-up');
  assert.deepEqual(waitsStep([], orchestratorWaits(built({ items: [{ id: 'A1', title: 'One', ...staged }], threads: stagedLine })), new Date(later)).added, ['w/A1'], 'an Implement tap wakes the orchestrator');

  // An open builder ask, until it is answered.
  const ask = { ts: at, who: 'Claude Opus builder', kind: 'builder-ask', ask: 'ask1', agent: 'main', text: 'Which file?' };
  const building = { A1: { main: { kind: 'claude', started: '2026-11-04T09:00:00Z' } } };
  const fresh = { ts: '2026-11-04T10:55:00Z', who: 'claude', kind: 'status', text: 'Testing: x' };
  const quiet = { A1: { main: { kind: 'claude', started: '2026-11-04T09:00:00Z' } } };
  const asked = one({ lane: 'progress' }, { agents: building, threads: { 'w/A1': [fresh, ask] } });
  assert.deepEqual(shape(asked), [['w/A1', 'ask', at, null]]);
  assert.match(asked[0].next, /Which file\?/);
  assert.deepEqual(one({ lane: 'progress' }, { agents: building, threads: { 'w/A1': [ask, { ts: later, who: 'claude', kind: 'builder-answer', ask: 'ask1', text: 'a' }, { ...fresh, ts: '2026-11-04T10:56:00Z' }] } }), []);

  // An owner answer not acted on; the watcher's working mark picks it up.
  const q = { id: 'q1', topic: 'item:w/A1', question: 'Which?', asked_at: '2026-11-04T09:00:00Z' };
  const answer = { id: 'e1', ts: at, kind: 'owner-answer', data: { id: 'q1', note: 'this' }, reply: null };
  assert.deepEqual(shape(one({}, { owner: { items: [q] }, events: [answer] })), [['w/A1', 'answer', at, null]]);
  assert.deepEqual(one({}, { owner: { items: [q] }, events: [{ ...answer, reply: { at: later } }] }), [], 'replied');

  // A grill or prototype asked for with no planner running.
  const grill = { id: 'g1', ts: at, kind: 'grill-more', data: { key: 'w/A1' }, reply: null };
  assert.deepEqual(shape(one({}, { events: [grill] })), [['w/A1', 'grill', at, null]]);
  assert.deepEqual(one({}, { events: [grill], agents: { A1: { g: { kind: 'grill', started: '2026-11-04T10:55:00Z' } } } }), [], 'a grill runs');
  const proto = { id: 'p1', ts: at, kind: 'prototype-request', data: { key: 'w/A1' }, reply: null };
  assert.deepEqual(shape(one({}, { events: [proto] })), [['w/A1', 'prototype', at, null]]);

  // A builder silent past the stale limit waits from its last sign of life; a progress line ends it.
  const silent = one({ lane: 'progress' }, { agents: quiet });
  assert.deepEqual(shape(silent), [['w/A1', 'stale', '2026-11-04T09:00:00Z', null]]);
  assert.match(silent[0].next, /silent/);
  assert.deepEqual(one({ lane: 'progress' }, { agents: quiet, threads: { 'w/A1': [{ ts: '2026-11-04T10:55:00Z', who: 'claude', kind: 'status', text: 'Testing: x' }] } }), [], 'recent progress');

  // A ready card the pull refused.
  const refused = { 'w/A1': [{ ts: at, who: 'claude', kind: 'hub', line: 'build-refused', text: "Couldn't start implementing: no repo" }] };
  const refusal = one({ phase: 'ready' }, { threads: refused });
  assert.deepEqual(shape(refusal), [['w/A1', 'refused', at, null]]);
  assert.equal(refusal[0].next, "Couldn't start implementing: no repo");

  // A card past Todo whose block ended waits until the session writes on it.
  const unblocked = { lane: 'review', unblocked_at: at };
  assert.deepEqual(shape(one(unblocked)), [['w/A1', 'unblocked', at, null]]);
  assert.deepEqual(one({ ...unblocked, lane: 'todo' }), [], 'a Todo task is the pull\'s');

  // docs/adr/2026-11-09-1939-a-block-only-keeps-a-card-from-in-progress.md: a ready Todo card whose block ended waits
  // for the orchestrator's re-check of its notes before the pull takes it.
  const recheck = one({ phase: 'ready', recheck_at: at });
  assert.deepEqual(shape(recheck), [['w/A1', 'recheck', at, null]]);
  assert.match(recheck[0].next, /question settle <id> --note/);
  assert.match(recheck[0].next, /item set --phase ready --text/);
  assert.deepEqual(one({ phase: 'ready', recheck_at: at, blocked_until: 'the API ships' }), [], 'blocked again, it waits on its block');
  const rechecking = built({ items: [{ id: 'A1', title: 'One', phase: 'ready', recheck_at: at }] });
  assert.deepEqual([rechecking.items[0].ready, pullOf(rechecking.items).pullable], [false, []], 'the pull leaves it until the re-check releases it');
  assert.deepEqual(one({ ...unblocked, blocked_until: 'the API ships' }), [], 'blocked again');
  assert.equal(one(unblocked, { threads: { 'w/A1': [{ ts: later, who: 'claude', text: 'On it.' }] } }).length, 0, 'the session wrote on it');

  // A started card with no live builder and nothing placing it waits from its last build's end.
  assert.deepEqual(shape(one({ lane: 'progress', lane_at: '2026-11-04T09:00:00Z' }, { agents: { A1: { main: { kind: 'claude', started: '2026-11-04T09:00:00Z', done: at } } } })),
    [['w/A1', 'unowned', at, null]]);
  assert.deepEqual(one({ lane: 'progress' }, { agents: building, threads: { 'w/A1': [fresh] } }), [], 'a live builder owns it');
  assert.deepEqual(one({ phase: 'ready' }), [], 'a ready task nobody refused');
  assert.deepEqual(one({ lane: 'done', closed_at: at }), [], 'a Done task');

  // In Progress first, then Todo, each in the board's order; a card's item carries its wait.
  const both = built({ items: [{ id: 'T1', title: 'Todo', phase: 'ready' }, { id: 'P1', title: 'Building', lane: 'progress' }], threads: { 'w/T1': refused['w/A1'] },
    agents: { P1: handed.A1 } });
  assert.deepEqual(orchestratorWaits(both).map((w) => w.key), ['w/P1', 'w/T1']);
  assert.deepEqual(both.items.find((i) => i.key === 'w/P1').orchestrator, { kind: 'calls', since: at, picked: null, next: "Verify the builder's judgment calls" });
  assert.equal(both.items.find((i) => i.key === 'w/P1').waitFacts, undefined, 'the facts stay off the task');
});

// docs/adr/2026-11-06-0200-the-board-rebases-a-conflicting-pr-with-a-headless-run.md
test("a card whose PR a rebase run fixes stays in In Review with the run's line, keeps the board from idle, and reads done or handed to the orchestrator after it", () => {
  const conflicting = { ...greenDraft, isDraft: false, reviewDecision: 'REVIEW_REQUIRED', mergeable: 'CONFLICTING', headRefOid: 'aaaaaaaaaa1111' };
  const run = { pr: 7, base: 'main', conflict: 'aaaaaaaaaa1111@main', at: '2026-11-05T10:00:00Z' };
  const rebasing = { kind: 'claude', model: 'opus', label: 'Rebase', started: '2026-11-05T10:00:00Z' };
  const line = { ts: '2026-11-05T10:01:00Z', who: 'claude', kind: 'status', text: 'Rebasing onto main · resolving 2 files' };
  const running = board({ pr: conflicting, now: Date.parse('2026-11-05T10:05:00Z'), item: { lane: 'progress', rebase_run: run }, agents: { A1: { main: rebasing } }, threads: { 'w/A1': [line] } });
  const card = running.items.find((i) => i.key === 'w/A1');
  assert.deepEqual([card.lane, card.waitsOn, card.builder.progress, card.next], ['review', 'builder', 'Rebasing onto main · resolving 2 files', null]);
  assert.equal(pullOf(running.items, { cap: 1 }).idle, false, 'the run keeps the board from idle');
  assert.equal(card.orchestrator, null);
  // A run gone silent past the stale limit waits on the orchestrator, the card still In Review.
  const silent = board({ pr: conflicting, now: Date.parse('2026-11-05T10:30:00Z'), item: { lane: 'progress', rebase_run: run }, agents: { A1: { main: rebasing } }, threads: { 'w/A1': [line] } });
  assert.deepEqual(orchestratorWaits(silent).map((w) => [w.key, w.kind]), [['w/A1', 'stale']]);
  assert.equal(silent.items.find((i) => i.key === 'w/A1').lane, 'review');

  // Failed: its call hands the card back, still In Review, waiting on the orchestrator with the run's own line.
  const handed = { ...rebasing, done: '2026-11-05T10:20:00Z', handed_back: '2026-11-05T10:20:00Z', calls: [{ at: '2026-11-05T10:19:00Z', text: 'Rebase failed in 2 files · both sides rewrote the send bar' }] };
  const failed = board({ pr: conflicting, item: { lane: 'progress', next: "Verify the builder's judgment calls", rebase_run: run }, agents: { A1: { main: handed } } });
  const stuck = failed.items.find((i) => i.key === 'w/A1');
  assert.deepEqual([stuck.lane, stuck.waitsOn, stuck.rebaseFailed, stuck.orchestrator?.kind], ['review', 'checking', 'Rebase failed in 2 files · both sides rewrote the send bar', 'calls']);
  assert.deepEqual(orchestratorWaits(failed).map((w) => w.key), ['w/A1']);
  assert.equal(running.items.find((i) => i.key === 'w/A1').rebaseFailed, null);

  // Done: while the PR's head is the run's push, Next says so, and that the PR is clean once GitHub reads it so.
  const pushed = { rebased: [{ from: 'aaaaaaaaaa1111', to: 'bbbbbbbbbb2222', base: 'main', at: '2026-11-05T10:30:00Z' }] };
  const done = { ...rebasing, done: '2026-11-05T10:30:00Z' };
  const next = (pr) => board({ pr, item: pushed, agents: { A1: { main: done } } }).items.find((i) => i.key === 'w/A1');
  const clean = next({ ...conflicting, headRefOid: 'bbbbbbbbbb2222', mergeable: 'MERGEABLE' });
  assert.deepEqual([clean.lane, clean.next], ['review', 'Rebased onto main, pushed · PR is clean again']);
  assert.equal(next({ ...conflicting, headRefOid: 'bbbbbbbbbb2222', mergeable: 'UNKNOWN' }).next, 'Rebased onto main, pushed');
  assert.equal(next({ ...conflicting, headRefOid: 'cccccccccc3333', mergeable: 'MERGEABLE' }).next, 'Waiting for PR reviewers', 'a later push leaves the run behind');
});

test('rebasesDue lists each open card whose PR, draft or ready, conflicts, once per head and base, while nothing runs on it', () => {
  const pr = (extra) => ({ ...greenDraft, mergeable: 'CONFLICTING', headRefOid: 'aaaaaaaaaa', headRefName: 'by-hand', ...extra });
  const items = (p, extra = {}) => board({ pr: p, ...extra }).items;
  assert.deepEqual(rebasesDue(items(pr()), {}, 'main'), [{ key: 'w/A1', pr: 7, branch: 'by-hand', conflict: 'aaaaaaaaaa@main' }], 'a draft too');
  assert.deepEqual(rebasesDue(items(pr({ isDraft: false })), {}, 'main').map((d) => d.key), ['w/A1']);
  assert.deepEqual(rebasesDue(items(pr()), { 'w/A1': 'aaaaaaaaaa@main' }, 'main'), [], 'one run per conflict');
  assert.deepEqual(rebasesDue(items(pr({ headRefOid: 'bbbbbbbbbb' })), { 'w/A1': 'aaaaaaaaaa@main' }, 'main').map((d) => d.conflict), ['bbbbbbbbbb@main'], 'a new head conflicting again');
  for (const [why, p, extra] of [
    ['mergeable', pr({ mergeable: 'MERGEABLE' })],
    ['unknown', pr({ mergeable: 'UNKNOWN' })],
    ['merged', pr({ state: 'MERGED' })],
    ['running', pr(), { agents: { A1: { main: { kind: 'claude', started: '2026-11-05T10:00:00Z' } } } }],
    ['checking', pr(), { agents: { A1: { main: { kind: 'claude', started: '2026-11-05T10:00:00Z', done: '2026-11-05T10:20:00Z', handed_back: '2026-11-05T10:20:00Z' } } } }],
    ['done', pr(), { item: { lane: 'done' } }],
  ]) assert.deepEqual(rebasesDue(items(p, extra), {}, 'main'), [], why);
});

// docs/adr/2026-11-05-1921-a-visual-is-a-page-an-agent-draws-for-a-thread.md
test("a visual request is a request line, or the owner's message with visual requested under it, and the agent's page is a visual link line that answers it", () => {
  const ev = (id, data, ts) => ({ id, ts, kind: 'visual-request', data: { key: 'w/A1', ...data }, reply: null });
  const events = [ev('v1', {}, '2026-10-23T10:00:00Z'), ev('v2', { text: 'Draw the land queue' }, '2026-10-23T10:01:00Z')];
  const lines = [{ ts: '2026-10-23T10:05:00Z', who: 'claude', kind: 'visual', text: 'How a land moves', link: 'visuals/A1/how-a-land-moves.html' }];
  const msgs = threadOf('w/A1', { events, lines });
  assert.deepEqual(msgs.map((m) => [m.kind, m.text, Boolean(m.request), m.status || null, m.link || null]), [
    ['visual-request', 'Visual requested', true, null, null], ['visual-request', 'Draw the land queue', false, 'Visual requested', null],
    ['visual', 'How a land moves', false, null, 'visuals/A1/how-a-land-moves.html'],
  ]);
  assert.equal(msgs[1].state, 'answered', 'the page answers the request');
});

test("a visual agent is a planner beside the card's work: its card shows the build, not the visual, it never stops a card arriving for its grill, and it counts toward the planner cap", () => {
  const visual = { kind: 'visual', model: 'sonnet', started: '2026-10-23T10:00:00Z' };
  const build = { kind: 'claude', model: 'opus', started: '2026-10-23T09:00:00Z' };
  const board = (agents, items = [{ id: 'A1', title: 'One', phase: 'grilling' }]) => buildBoard({ fromWaves: false, events: [], owner: {}, prs: {}, now: Date.parse('2026-10-23T10:01:00Z'), files: [{ slug: 'w', agents, itemFile: { repo: 'o/r', items } }] });
  const one = (b) => b.items.find((i) => i.id === 'A1');
  assert.equal(one(board({ A1: { 'visual-v1': visual } })).builder, null, 'a visual alone gives the task no status');
  const both = one(board({ A1: { main: build, 'visual-v1': visual } }, [{ id: 'A1', title: 'One', lane: 'progress' }]));
  assert.deepEqual([both.builder.kind, both.builder.planner], ['claude', false]);
  const thread = threadOf('w/A1', { agents: { 'visual-v1': visual } });
  assert.deepEqual(thread.map((m) => [m.text, m.planner]), [['Claude Sonnet visual started', true]]);
  // A card in Todo with only a visual on it still arrives; the running visual takes one of the cap's planners.
  const todo = [{ id: 'A1', title: 'One', phase: 'grilling' }, { id: 'B1', title: 'Two', phase: 'grilling' }];
  assert.deepEqual(arrivalsOf(board({ B1: { 'visual-v1': { ...visual, done: '2026-10-23T10:00:30Z' } } }, todo).items), ['w/A1', 'w/B1']);
  assert.deepEqual(arrivalsOf(board({ B1: { 'visual-v1': visual } }, todo).items, { cap: 1 }), []);
});

// docs/adr/2026-11-05-2331-a-sent-answer-is-resolved-in-place-until-the-page-reloads.md
test("a sent question's reopen opens it again until a new answer, a prototype request or a later resolve, and its card's thread reads 'Question N was reopened' with its mark", () => {
  const q = { id: 'q2', topic: 'item:w/A1', question: 'Two?', options: [{ id: 'A', label: 'Yes' }, { id: 'B', label: 'No' }] };
  const answer = (ts, choice = 'A') => ({ id: `a-${ts}`, ts, kind: 'owner-answer', data: { id: 'q2', choice, label: choice }, reply: null });
  const reopen = (ts, question = 'q2') => ({ id: `o-${ts}`, ts, kind: 'question-reopen', data: { key: 'w/A1', question }, reply: null });
  const request = (ts) => ({ id: `r-${ts}`, ts, kind: 'prototype-request', data: { key: 'w/A1', question: 'q2', note: '', choice: 'A' }, reply: null });
  const state = (extra, answers, reopens, requests = []) => (({ state, reopened }) => [state, reopened])(ownerQuestion({ ...q, ...extra }, answers, requests, [], reopens));
  assert.deepEqual(state({}, [answer('2026-10-23T10:00:00Z')], []), ['answered', false]);
  assert.deepEqual(state({}, [answer('2026-10-23T10:00:00Z')], [reopen('2026-10-23T11:00:00Z')]), ['open', true]);
  assert.deepEqual(state({}, [answer('2026-10-23T10:00:00Z'), answer('2026-10-23T12:00:00Z', 'B')], [reopen('2026-10-23T11:00:00Z')]), ['answered', false], 'a new answer sends it again');
  assert.deepEqual(state({}, [answer('2026-10-23T10:00:00Z')], [reopen('2026-10-23T11:00:00Z')], [request('2026-10-23T12:00:00Z')]), ['requested', false]);
  assert.deepEqual(state({}, [answer('2026-10-23T10:00:00Z')], [reopen('2026-10-23T11:00:00Z', 'other')]), ['answered', false]);
  const resolved = { resolved: 'Kept it', resolved_at: '2026-10-23T10:30:00Z' };
  assert.deepEqual(state(resolved, [answer('2026-10-23T10:00:00Z')], [reopen('2026-10-23T11:00:00Z')]), ['open', true], 'a resolved question reopens');
  assert.deepEqual(state({ ...resolved, resolved_at: '2026-10-23T12:00:00Z' }, [answer('2026-10-23T10:00:00Z')], [reopen('2026-10-23T11:00:00Z')]), ['resolved', false], 'resolved again after the reopen');
  assert.deepEqual(state({ resolved: 'Replaced' }, [], [reopen('2026-10-23T11:00:00Z')]), ['open', true]);

  const owner = { items: [{ ...q, id: 'q1', question: 'One?' }, q] };
  const msgs = threadOf('w/A1', { events: [answer('2026-10-23T10:00:00Z'), reopen('2026-10-23T11:00:00Z'), answer('2026-10-23T12:00:00Z', 'B')], owner });
  assert.deepEqual(msgs.map((m) => [m.kind, m.text, Boolean(m.request), m.mark || null]), [
    ['owner-answer', 'Question 2 · Two?\n→ A', false, null],
    ['question-reopen', 'Question 2 was reopened', true, 'question reopened'],
    ['owner-answer', 'Question 2 · Two?\n→ B', false, null],
  ]);
  const card = board({ owner, events: [answer('2026-10-23T10:00:00Z'), reopen('2026-10-23T11:00:00Z')] }).items.find((i) => i.key === 'w/A1');
  assert.deepEqual([card.questions.open, card.action?.kind, card.actionButton, card.resolvedBy], [2, 'questions', 'openQuestions', 'openQuestions'], 'a reopened question turns the Questions button orange again');
});

test("a card's questions keep their numbers in its thread: a later round's questions number on after the earlier ones", () => {
  const q = (id, n) => ({ id, topic: 'item:w/A1', question: `Q${n}?`, options: [{ id: 'A', label: 'Yes' }] });
  const owner = { items: [q('a', 1), { id: 'x', topic: 'item:w/OTHER', question: 'Elsewhere?' }, q('b', 2), q('c', 3), q('d', 4), q('e', 5)] };
  const answer = (id, ts) => ({ id: `a-${id}`, ts, kind: 'owner-answer', data: { id, choice: 'A', label: 'A. Yes' }, reply: null });
  const msgs = threadOf('w/A1', { events: [answer('a', '2026-10-23T10:00:00Z'), answer('c', '2026-10-23T10:01:00Z'), answer('e', '2026-10-24T10:00:00Z')], owner });
  assert.deepEqual(msgs.map((m) => m.text), ['Question 1 · Q1?\n→ A. Yes', 'Question 3 · Q3?\n→ A. Yes', 'Question 5 · Q5?\n→ A. Yes']);
});

test("a Done card that had questions keeps its quiet Questions button, and a card that never had any has none", () => {
  const q = { id: 'q1', topic: 'item:w/A1', question: 'Which?', options: [{ id: 'A', label: 'One' }] };
  const picked = { id: 'e1', ts: '2026-10-23T10:00:00Z', kind: 'owner-answer', data: { id: 'q1', choice: 'A' }, reply: null };
  const done = board({ owner: { items: [q] }, events: [picked], pr: { ...greenDraft, state: 'MERGED' } }).items.find((i) => i.key === 'w/A1');
  assert.deepEqual([done.lane, done.actionButton, done.resolvedBy], ['done', 'openQuestions', null]);
  assert.equal(board().items.find((i) => i.key === 'w/A1').actionButton, null);
});

// docs/adr/2026-11-05-2358-nothing-waiting-on-the-orchestrator-is-missed.md
test('a wait still open re-wakes the session every 15 minutes until picked up, then hourly from an hour after pickup (daily for a stale review), in one batch per check', () => {
  assert.equal(REWAKE_AFTER, 15 * 60000);
  assert.equal(PICKED_REWAKE_AFTER, 60 * 60000);
  assert.equal(DAILY_REWAKE_AFTER, 24 * 60 * 60000);
  const base = Date.parse('2026-11-05T10:00:00Z');
  const at = (min) => new Date(base + min * 60000);
  const iso = (min) => at(min).toISOString();
  const wait = (o = {}) => ({ key: 'w/A1', ref: 'A1', title: 'One', kind: 'calls', since: iso(0), picked: null, next: 'Verify', ...o });
  const keys = (list) => list.map((w) => w.key);

  const joined = waitsStep([], [wait()], at(1));
  assert.deepEqual([joined.added, keys(joined.again)], [['w/A1'], []]);
  assert.equal(joined.waits[0].bumped, iso(1), 'joining counts as its wake');
  const early = waitsStep(joined.waits, [wait()], at(15));
  assert.deepEqual([early.added, early.again], [[], []]);
  assert.equal(early.waits[0].bumped, iso(1));
  const due = waitsStep(early.waits, [wait()], at(16));
  assert.deepEqual([due.added, due.again], [[], [{ key: 'w/A1', ref: 'A1', kind: 'calls', since: iso(0), next: 'Verify' }]]);
  assert.equal(due.waits[0].bumped, iso(16));
  assert.deepEqual(waitsStep(due.waits, [wait()], at(30)).again, []);
  assert.deepEqual(keys(waitsStep(due.waits, [wait()], at(31)).again), ['w/A1']);

  // Picked up at 20: quiet until an hour after the pickup, then hourly while the wait lasts.
  const picked = wait({ picked: iso(20) });
  assert.deepEqual(waitsStep(due.waits, [picked], at(79)).again, []);
  const hour = waitsStep(due.waits, [picked], at(80));
  assert.deepEqual(keys(hour.again), ['w/A1']);
  assert.deepEqual(waitsStep(hour.waits, [picked], at(139)).again, []);
  assert.deepEqual(keys(waitsStep(hour.waits, [picked], at(140)).again), ['w/A1']);
  assert.deepEqual(waitsStep([], [picked], at(21)), { waits: [{ ...picked, bumped: iso(21) }], added: [], again: [], againAt: null }, 'one that joins picked up wakes nothing');

  // docs/adr/2026-11-06-1653-the-orchestrator-reviews-every-lane-on-a-schedule.md: a daily wait (a stale review) re-wakes
  // every 15 minutes until picked up, then once a day from its pickup; a change on its PR wakes the session by github-change.
  const review = wait({ kind: 'stale', daily: true });
  const reviewJoined = waitsStep([], [review], at(1)).waits;
  assert.deepEqual(keys(waitsStep(reviewJoined, [review], at(16)).again), ['w/A1']);
  const reviewPicked = wait({ kind: 'stale', daily: true, picked: iso(20) });
  assert.deepEqual(waitsStep(reviewJoined, [reviewPicked], at(80)).again, [], 'not hourly');
  assert.deepEqual(waitsStep(reviewJoined, [reviewPicked], at(20 + 1439)).again, []);
  assert.deepEqual(keys(waitsStep(reviewJoined, [reviewPicked], at(20 + 1440)).again), ['w/A1']);

  // A new kind or since is a new wait: it joins, it doesn't re-wake.
  const anew = waitsStep(due.waits, [wait({ kind: 'ask', since: iso(40) })], at(41));
  assert.deepEqual([anew.added, anew.again], [['w/A1'], []]);
  // Several due at once ride one batch; a stored entry from before re-wakes kept its push and counts from its since.
  const two = waitsStep([{ ...wait(), pushed: true }, wait({ key: 'w/A2', ref: 'A2' })], [wait(), wait({ key: 'w/A2', ref: 'A2' })], at(20));
  assert.deepEqual([two.added, keys(two.again)], [[], ['w/A1', 'w/A2']]);
  assert.equal(two.waits[0].pushed, true);
  // A wait that closes leaves the list.
  assert.deepEqual(waitsStep(due.waits, [], at(60)), { waits: [], added: [], again: [], againAt: null });
});

test('reminders share one board-wide clock: a wait that falls due within 15 minutes of the last reminder waits for the next one, which carries every due wait', () => {
  const base = Date.parse('2026-11-05T10:00:00Z');
  const at = (min) => new Date(base + min * 60000);
  const iso = (min) => at(min).toISOString();
  const wait = (key, since) => ({ key, ref: key, title: key, kind: 'calls', since: iso(since), picked: null, next: 'Verify' });
  const keys = (step) => step.again.map((w) => w.key);
  const list = [wait('w/A', 0), wait('w/B', 1)];
  const joined = waitsStep(waitsStep([], [list[0]], at(2)).waits, list, at(3));
  const first = waitsStep(joined.waits, list, at(17));
  assert.deepEqual([keys(first), first.againAt], [['w/A'], iso(17)], 'A is due at 17, B a minute later');
  const blocked = waitsStep(first.waits, list, at(18), first.againAt);
  assert.deepEqual([keys(blocked), blocked.againAt], [[], iso(17)], 'B is due at 18 but the clock was used at 17');
  assert.equal(blocked.waits[1].bumped, iso(3), 'a held reminder keeps its wake time');
  assert.deepEqual(keys(waitsStep(blocked.waits, list, at(31), blocked.againAt)), []);
  const next = waitsStep(blocked.waits, list, at(32), blocked.againAt);
  assert.deepEqual([keys(next), next.againAt], [['w/A', 'w/B'], iso(32)], 'one reminder carries both');
  const added = waitsStep(first.waits, [...list, wait('w/C', 19)], at(20), first.againAt);
  assert.deepEqual([added.added, keys(added)], [['w/C'], []], 'a new wait still wakes at once');
});

test("a re-wake's plain line names each card still waiting with its kind, how long and its next step", () => {
  const at = Date.parse('2026-11-05T12:00:00Z');
  assert.equal(waitsAgainLine([
    { key: 'w/A1', ref: '#263', kind: 'calls', since: '2026-11-05T10:00:00Z', next: "Verify the builder's judgment calls" },
    { key: 'w/A2', ref: '#266', kind: 'ask', since: '2026-11-05T11:35:00Z', next: 'Answer the builder' },
  ], at), "still waiting on you: #263 calls for 2h: Verify the builder's judgment calls; #266 ask for 25m: Answer the builder");
  assert.equal(waitsAgainLine([{ key: 'w/A1', ref: '#1', kind: 'stale', since: '2026-11-05T09:10:00Z', next: 'x' }], at), 'still waiting on you: #1 stale for 2h 50m: x');
});

test('a builder whose launch the board holds for a usage pause is no wait on the orchestrator: the board launches it once the pause lifts', () => {
  const quiet = { A1: { main: { kind: 'claude', started: '2026-11-04T09:00:00Z' } } };
  const built = (alive) => buildBoard({ now: Date.parse('2026-11-04T11:00:00Z'), alive, files: [{ slug: 'w', agents: quiet, itemFile: { internal: true, items: [{ id: 'A1', title: 'One', lane: 'progress' }] } }] });
  assert.deepEqual(orchestratorWaits(built()).map((w) => w.kind), ['stale']);
  // docs/adr/2026-11-06-1653-the-orchestrator-reviews-every-lane-on-a-schedule.md: a stale run gets one restart, then a stall.
  assert.match(orchestratorWaits(built())[0].next, /restart it once from its worktree with a thread line; if the restarted run goes stale too, item stall it/);
  assert.equal(orchestratorWaits(built())[0].daily, undefined);
  const held = built({ 'w/A1': 'held' });
  assert.deepEqual(orchestratorWaits(held), []);
  const card = held.items.find((i) => i.key === 'w/A1');
  assert.deepEqual([card.builder.stale, card.builder.alive, card.builder.held], [false, null, true]);
});

// docs/adr/2026-11-05-2358-nothing-waiting-on-the-orchestrator-is-missed.md
test('a card blocked until a condition, with a reason, is blocked as a dep blocks it: not ready and not pulled until the condition clears, but grilled', () => {
  const built = (item) => buildBoard({ now: Date.parse('2026-11-04T11:00:00Z'), files: [{ slug: 'w', agents: {}, itemFile: { internal: true, items: [
    { id: 'A1', title: 'feat: one', phase: 'ready', ...item }, { id: 'A2', title: 'Two', lane: 'progress' }] } }] });
  const card = (b) => b.items.find((i) => i.key === 'w/A1');
  const blocked = built({ blocked_until: 'the CI run on main is green', block_reason: 'the suite is red on main' });
  assert.deepEqual([card(blocked).blockedUntil, card(blocked).blockReason, card(blocked).blocked, card(blocked).ready], ['the CI run on main is green', 'the suite is red on main', true, false]);
  assert.deepEqual(pullOf(blocked.items).pullable, []);
  assert.deepEqual(arrivalsOf(built({ phase: undefined, blocked_until: 'x' }).items), ['w/A1'], 'it is grilled all the same');
  assert.deepEqual(arrivalsOf(built({ phase: undefined }).items), ['w/A1']);
  const free = built({});
  assert.deepEqual([card(free).blockedUntil, card(free).blockReason, card(free).blocked, card(free).ready], [null, null, false, true]);
  assert.deepEqual(pullOf(free.items).pullable, ['w/A1']);
  // A reason rides a dep block too, and a Done card is blocked by nothing.
  const dep = built({ deps: ['A2'], block_reason: 'shares the send bar' });
  assert.deepEqual([card(dep).blocked, card(dep).blockReason, card(dep).blockedBy.map((d) => d.ref)], [true, 'shares the send bar', ['A2']]);
  const done = built({ lane: 'done', blocked_until: 'x', block_reason: 'y' });
  assert.deepEqual([card(done).blockedUntil, card(done).blockReason, card(done).blocked], [null, null, false]);
});

// docs/adr/2026-11-04-2130-a-button-tap-is-a-status-line-or-a-message-footer.md
test("answers written together (one ts) are one thread message with one status; the message is as pending as its most pending answer", () => {
  const qs = ['q1', 'q2'].map((id) => ({ id, topic: 'item:w/A1', question: `${id}?`, options: [{ id: 'A', label: 'Yes' }, { id: 'B', label: 'No' }] }));
  const answer = (id, choice, ts) => ({ id: `a-${id}-${ts}`, ts, kind: 'owner-answer', data: { id, choice, note: id === 'q2' ? 'because' : '' }, reply: null });
  const at = '2026-11-05T01:00:55.627Z';
  const together = threadOf('w/A1', { events: [answer('q1', 'A', at), answer('q2', 'B', at)], owner: { items: qs } });
  assert.equal(together.length, 1);
  assert.equal(together[0].text, 'Question 1 · q1?\n→ A\n\nQuestion 2 · q2?\n→ B · because');
  assert.equal(together[0].status, 'answers submitted');
  assert.equal(together[0].eventId, `a-q1-${at}`);
  assert.deepEqual(together[0].answers.map((a) => a.eventId), [`a-q1-${at}`, `a-q2-${at}`]);
  const apart = threadOf('w/A1', { events: [answer('q1', 'A', at), answer('q2', 'B', '2026-11-05T01:05:00.000Z')], owner: { items: qs } });
  assert.equal(apart.length, 2);
  // q1 is resolved after the submit, q2 is not: the message still waits, each answer keeps its own state.
  const half = threadOf('w/A1', { events: [answer('q1', 'A', at), answer('q2', 'B', at)], owner: { items: [{ ...qs[0], resolved: 'Done', resolved_at: '2026-11-05T02:00:00Z' }, qs[1]] } });
  assert.equal(half[0].state, 'waiting');
  assert.deepEqual(stateEntries(half[0]).map(([, s]) => s), ['answered', 'waiting']);
  const lone = threadOf('w/A1', { events: [answer('q1', 'A', at)], owner: { items: qs } });
  assert.equal(lone[0].text, 'Question 1 · q1?\n→ A');
});

// docs/adr/2026-11-06-1252-stale-is-automatic-stalled-is-the-orchestrators-flag.md
test("a run gone silent reads stale and waits on the orchestrator; one the orchestrator stalls stays in its lane, reads stalled as an Action needed with one push, waits on nobody else and keeps its slot", () => {
  const now = Date.parse('2026-11-06T12:00:00Z');
  const open = { A1: { main: { kind: 'claude', started: '2026-11-06T10:00:00Z' } } };
  const stopped = { A1: { main: { kind: 'claude', started: '2026-11-06T10:00:00Z', stopped: { run: 'build', at: '2026-11-06T11:00:00Z' } } } };
  const built = (agents, a1 = {}) => buildBoard({ now, files: [{ slug: 'w', agents, itemFile: { internal: true, items: [
    { id: 'A1', title: 'One', lane: 'progress', ...a1 }, { id: 'T1', title: 'feat: next', phase: 'ready', created: '2026-11-06T09:00:00Z' }] } }] });
  const card = (b) => b.items.find((i) => i.key === 'w/A1');

  const stale = built(open);
  assert.deepEqual([card(stale).stale, card(stale).builder.stale, card(stale).stalled, card(stale).action], [true, true, null, null]);
  assert.deepEqual(orchestratorWaits(stale).map((w) => [w.key, w.kind]), [['w/A1', 'stale']]);
  assert.deepEqual(pullOf(stale.items, { cap: 1 }).pulls, [], 'a stale run still holds its slot');

  const stalled = built(stopped, { stalled: { reason: 'Crashed twice on the same test', at: '2026-11-06T11:00:00Z' } });
  const it = card(stalled);
  assert.deepEqual([it.lane, it.stalled, it.waitsOn], ['progress', 'Crashed twice on the same test', 'builder']);
  assert.deepEqual(it.action, { kind: 'stalled', url: '#selectedCard=w%2FA1', label: 'stalled: Crashed twice on the same test' });
  assert.equal(it.orchestrator, null);
  assert.deepEqual(orchestratorWaits(stalled), []);
  assert.deepEqual(pullOf(stalled.items, { cap: 1 }).pulls, [], 'a stalled task In Progress keeps its slot');
  const [push] = ownerActions(stalled).filter((a) => a.tag === 'item-w/A1');
  assert.deepEqual([push.kind, push.title.endsWith(': stalled: Crashed twice on the same test'), push.now], ['stalled', true, true]);
  assert.ok(stalled.needs.some((line) => line.key === 'w/A1' && line.text.endsWith('stalled: Crashed twice on the same test')));

  // A stalled review stays In Review; stalled wins over its stale age.
  const sent = { 'w/A1': { review_link_ts: { Ann: '1792800000.000100' } } };
  const review = buildBoard({ now: Date.parse('2026-11-06T00:00:00Z'), topicItems: sent, prs: { 'o/r#7': { ...greenDraft, isDraft: false } }, files: [{ slug: 'w', itemFile: { repo: 'o/r', reviewers: [{ name: 'Ann', github: 'ann' }],
    items: [{ id: 'A1', title: 'One', pr: 7, lane: 'review', stalled: { reason: 'Ann left', at: '2026-11-05T00:00:00Z' } }] } }] });
  assert.deepEqual([card(review).lane, card(review).stalled, card(review).action.kind, card(review).orchestrator], ['review', 'Ann left', 'stalled', null]);
});

// docs/adr/2026-11-07-0043-every-signal-that-wakes-the-orchestrator-says-what-to-do.md
test("a finished grill's screened questions are the card's screen wait, ahead of any other, and a card with none has no screen wait", () => {
  const since = '2026-11-07T10:00:00.000Z';
  const items = [{ id: 'A1', title: 'One', state: 'grilling' }, { id: 'A2', title: 'Two', state: 'grilling' }];
  const built = (screening) => buildBoard({ fromWaves: false, now: Date.parse('2026-11-07T10:05:00Z'), files: [{ slug: 'w', agents: {}, itemFile: { items } }], events: [], screening });
  assert.deepEqual(orchestratorWaits(built({ 'w/A1': { since, ids: ['q1', 'q-gate'] } })).map(({ key, kind, since: s, picked, next }) => [key, kind, s, picked, next]),
    [['w/A1', 'screen', since, null, "Screen the grill's questions q1, q-gate: question settle <id> --note for each the board already answers, then question publish w/A1; left 15 minutes unscreened, they reach the owner as they are"]]);
  assert.deepEqual(orchestratorWaits(built({})), []);
  assert.deepEqual(orchestratorWaits(built(undefined)), []);
});

// docs/adr/2026-11-07-2100-a-cards-past-runs-keep-their-records-so-they-fold.md
test("a lander's started, status and finished lines carry the run of the build it lands, and a landing line with that run joins it, so the build and its landing are one section", () => {
  const agents = {
    main: { kind: 'claude', model: 'opus', label: 'Lander', started: '2026-11-07T11:00:00Z' },
    'past-1': { kind: 'claude', model: 'opus', label: 'Builder', started: '2026-11-07T10:00:00Z', done: '2026-11-07T10:30:00Z' },
    'past-0': { kind: 'grill', model: 'opus', label: 'Grill', started: '2026-11-07T09:00:00Z', done: '2026-11-07T09:30:00Z' },
  };
  const lines = [
    { ts: '2026-11-07T10:10:00Z', who: 'claude', kind: 'status', text: 'Building: x', run: '2026-11-07T10:00:00Z' },
    { ts: '2026-11-07T10:40:00Z', who: 'claude', kind: 'status', text: 'Landing: rebasing onto main and landing', run: '2026-11-07T10:00:00Z' },
    { ts: '2026-11-07T11:05:00Z', who: 'claude', kind: 'status', text: 'Landing: rebasing', run: '2026-11-07T11:00:00Z' },
    { ts: '2026-11-07T09:10:00Z', who: 'claude', kind: 'status', text: 'Grilling: y', run: '2026-11-07T09:00:00Z', planner: true },
  ];
  const got = threadOf('w/A1', { lines, agents }).filter((m) => m.kind === 'status' || m.kind === 'agent').map((m) => [m.text, m.run]);
  const build = '2026-11-07T10:00:00Z';
  assert.deepEqual(got, [
    ['Claude Opus grill started', '2026-11-07T09:00:00Z'], ['Grilling: y', '2026-11-07T09:00:00Z'], ['Claude Opus grill finished', '2026-11-07T09:00:00Z'],
    ['Claude Opus implementer started', build], ['Building: x', build], ['Claude Opus implementer finished', build],
    ['Landing: rebasing onto main and landing', build],
    ['Claude Opus lander started', build], ['Landing: rebasing', build],
  ]);
});

// docs/adr/2026-11-07-2100-a-cards-past-runs-keep-their-records-so-they-fold.md
test("a card with a past run's record shows only its live agents, while the thread still folds the past run's lines", () => {
  const agents = { A1: {
    main: { kind: 'claude', label: 'Lander', started: '2026-11-07T11:00:00Z' },
    'past-1': { kind: 'claude', label: 'Builder', started: '2026-11-07T10:00:00Z', done: '2026-11-07T10:30:00Z' },
  } };
  const item = board({ agents }).items.find((i) => i.key === 'w/A1');
  assert.deepEqual(item.agents.map((a) => a.name), ['main']);
});

// docs/adr/2026-11-09-1200-the-board-writes-status-lines-and-only-the-orchestrator-writes-messages.md
test("the board's status lines carry their kind's mark; only a fault is unread, and none answers like a message is drawn", () => {
  const threads = { 'w/A1': [
    { ts: '2026-10-23T10:02:00Z', who: 'claude', kind: 'hub', line: 'pulled', text: 'Pulled in: an implementer slot was free.' },
    { ts: '2026-10-23T10:03:00Z', who: 'claude', kind: 'hub', line: 'host-busy', text: 'Host is busy, work will resume when the host recovers' },
    { ts: '2026-10-23T10:04:00Z', who: 'claude', kind: 'hub', line: 'relaunch-failed', text: "Couldn't relaunch the builder headless: spawn ENOENT" },
  ] };
  const card = board({ pr: null, item: { pr: undefined, lane: 'progress' }, threads }).items.find((i) => i.key === 'w/A1');
  assert.deepEqual(card.othersAt, ['2026-10-23T10:04:00Z']);
  assert.deepEqual(threadOf('w/A1', { lines: threads['w/A1'] }).map((m) => [m.kind, m.line, m.mark, m.fault]), [
    ['hub', 'pulled', 'Implementation requested', false], ['hub', 'host-busy', 'Held', false], ['hub', 'relaunch-failed', 'Fault', true]]);
});

test("a wave:<slug> dep waits on every card the wave holds now until each is Done, and those cards list the card as waiting on them", () => {
  const items = [
    { id: 'A1', title: 'One', lane: 'done', closed_at: '2026-10-23T11:00:00Z' },
    { id: 'A2', title: 'Two' },
    { id: 'A3', title: 'Three', deps: ['A2'] },
    { id: 'B1', title: 'Waiter', deps: ['wave:mon'] },
    { id: 'B2', title: 'Also', deps: ['wave:mon', 'A2'] },
  ];
  const snapshot = (waveCards) => ({ fromWaves: false, now: Date.parse('2026-10-23T12:00:00Z'), files: [{ slug: 'w', agents: {}, itemFile: { items, waves: [{ slug: 'mon', title: 'Monitor', goal: 'G', items: waveCards }] } }] });
  const card = (s, id) => buildBoard(s).items.find((i) => i.id === id);
  assert.deepEqual(card(snapshot(['A1', 'A2', 'A3']), 'B1').blockedBy, [{ key: 'w/A2', ref: 'A2', lane: 'todo' }, { key: 'w/A3', ref: 'A3', lane: 'todo' }]);
  assert.deepEqual(card(snapshot(['A1', 'A2', 'A3']), 'B2').blockedBy, [{ key: 'w/A2', ref: 'A2', lane: 'todo' }, { key: 'w/A3', ref: 'A3', lane: 'todo' }]);
  assert.deepEqual(card(snapshot(['A1', 'A2', 'A3']), 'A3').waitsOnIt.map((c) => c.ref), ['B1', 'B2']);
  assert.deepEqual(card(snapshot(['A1']), 'B1').blockedBy, []);
  assert.equal(card(snapshot(['A1']), 'B1').blocked, false);
});

test("a PR whose hub record has no url still links to it, by its repo and number, so the card's chips draw", () => {
  const item = board({ pr: { state: 'MERGED', isDraft: false, reviewDecision: 'APPROVED', url: undefined } }).items.find((i) => i.key === 'w/A1');
  assert.deepEqual(item.prs.map((p) => p.url), ['https://github.com/o/r/pull/7']);
  assert.equal(item.pr.url, 'https://github.com/o/r/pull/7');
});

// docs/adr/2026-11-12-1300-threads-say-reply-with-hold-resume-and-reopen-beside-it.md
test("a Done card the owner reopened reads Todo, discussing, its PR merged or not, still counting as finished for its dependents; a message there wakes no reopen, and a build takes it to In Progress", () => {
  const merged = { ...greenDraft, isDraft: false, state: 'MERGED', mergedAt: '2026-10-23T11:00:00Z' };
  const back = { lane: 'todo', phase: 'discussing', lane_at: '2026-10-23T12:00:00Z', closed_at: '2026-10-23T11:00:00Z', reopened_at: '2026-10-23T12:00:00Z' };
  const msg = { id: 'm1', ts: '2026-10-23T12:30:00Z', kind: 'item-message', data: { key: 'w/A1', text: 'Try the blue' }, reply: null };
  const card = (opts) => board(opts).items.find((i) => i.key === 'w/A1');
  for (const opts of [{ pr: null, item: { pr: undefined, ...back } }, { pr: merged, item: back }, { pr: null, item: { pr: undefined, ...back }, events: [msg] }]) {
    const it = card(opts);
    assert.deepEqual([it.lane, it.phase, it.reopened, it.closedAt, it.awaitsDone], ['todo', 'discussing', true, null, false]);
  }
  const deps = buildBoard({ fromWaves: false, files: [{ slug: 'w', agents: {}, itemFile: { items: [{ id: 'A1', title: 'One', ...back }, { id: 'A5', title: 'Five', deps: ['A1'] }] } }] });
  assert.deepEqual(deps.items.find((i) => i.id === 'A5').blockedBy, []);
  const building = card({ pr: null, item: { pr: undefined, ...back }, agents: { A1: { main: { kind: 'claude', model: 'opus', started: '2026-10-23T12:40:00Z' } } } });
  assert.equal(building.lane, 'progress');
});

// docs/adr/2026-11-12-1300-threads-say-reply-with-hold-resume-and-reopen-beside-it.md
test("an In Progress card the owner held reads held, so its paused build stays paused until the Resume; a usage pause alone doesn't read held", () => {
  const build = (pause) => ({ A1: { main: { kind: 'claude', started: '2026-11-09T11:00:00Z', pause } } });
  const paused = { cause: 'held', words: 'held', at: '2026-11-09T11:50:00Z', paused: '2026-11-09T11:55:00Z' };
  const of = (item, pause = paused) => buildBoard({ fromWaves: false, files: [{ slug: 'w', agents: build(pause), itemFile: { items: [{ id: 'A1', title: 'One', lane: 'progress', ...item }] } }] });
  const held = of({ held: true, held_at: '2026-11-09T11:50:00Z' });
  assert.deepEqual([held.items[0].lane, held.items[0].held], ['progress', true]);
  assert.deepEqual(pauseWork(held.items, { usageHeld: () => false }).resume, []);
  const asked = of({ held: true, held_at: '2026-11-09T11:50:00Z' }, { ...paused, paused: undefined });
  assert.deepEqual(pauseWork(asked.items, { usageHeld: () => false }).drop, []);
  assert.deepEqual(pauseWork(of({}).items, { usageHeld: () => false }).resume, ['w/A1']);
  const usage = of({}, { cause: 'usage', words: 'usage limit', at: '2026-11-09T11:50:00Z', paused: '2026-11-09T11:55:00Z' });
  assert.equal(usage.items[0].held, false);
});

// docs/adr/2026-11-12-1300-builder-done-posts-no-line-to-the-thread.md
test("a card's builder line is its still-running runs' newest line: a finished helper's last line no longer stands while main runs", () => {
  const status = (ts, text, run) => ({ ts, who: 'claude', kind: 'status', run, text });
  const main = { kind: 'claude', started: '2026-10-23T10:00:00Z' };
  const helper = { kind: 'helper', started: '2026-10-23T10:10:00Z', done: '2026-10-23T10:20:00Z' };
  const lines = [status('2026-10-23T10:05:00Z', 'Building: the page', main.started), status('2026-10-23T10:15:00Z', 'Lint testing: running', helper.started)];
  const card = board({ now: Date.parse('2026-10-23T10:30:00Z'), agents: { A1: { main, lint: helper } }, threads: { 'w/A1': lines } }).items.find((i) => i.key === 'w/A1');
  assert.equal(card.builder.progress, 'Building: the page');
});

test('on a tie a message sorts above the status line it causes', () => {
  const ts = '2026-11-12T19:35:05.149Z';
  const msg = { id: 'e1', ts, kind: 'item-message', data: { key: 'w/A1', text: 'Go build it', intent: 'build' } };
  const lines = [{ ts, who: 'claude', command: 'staged', text: 'Marked as staging' }, { ts, who: 'claude', kind: 'move', text: 'Moved to In Progress' }];
  const thread = threadOf('w/A1', { lines, events: [msg] });
  assert.deepEqual(thread.map((m) => m.text), ['Go build it', 'Marked as staging', 'Moved to In Progress']);
});

test('a card in no wave carries its item file title on a board with more than one item file, and none on a one-file board', () => {
  const file = (slug, title) => ({ slug, itemFile: { title, items: [{ id: `${slug}1`, title: 'a' }] } });
  const two = buildBoard({ now: Date.now(), fromWaves: false, files: [file('x', 'Search'), file('y', 'Billing')] });
  assert.deepEqual(two.items.map((i) => i.fileLabel), ['Search', 'Billing']);
  const one = buildBoard({ now: Date.now(), fromWaves: false, files: [file('x', 'Search')] });
  assert.deepEqual(one.items.map((i) => i.fileLabel), [null]);
});

// docs/adr/2026-11-13-0130-a-questions-added-line-is-stored-and-stays-in-the-thread.md
test("a Questions added line stays in the thread, open while any of its own batch's questions is open and not once each is answered or resolved", () => {
  const q = (id, extra = {}) => ({ id, topic: 'item:w/A1', question: `${id}?`, asked_at: '2026-11-12T10:00:00Z', ...extra });
  const added = (ts, ids) => ({ ts, who: 'claude', kind: 'hub', line: 'questions-added', text: `${ids.length} question${ids.length === 1 ? '' : 's'} added`, link: `questions.html#${ids[0]}`, questions: ids });
  const answer = (id) => ({ id: `ans-${id}`, ts: '2026-11-12T11:00:00Z', kind: 'owner-answer', data: { id, choice: 'A' }, reply: null });
  const lines = [added('2026-11-12T10:00:00Z', ['qa', 'qb']), added('2026-11-12T10:30:00Z', ['qc'])];
  const opens = (items, events = []) => threadOf('w/A1', { lines, events, owner: { items } }).filter((m) => m.line === 'questions-added').map((m) => [m.text, m.link, m.open]);
  assert.deepEqual(opens([q('qa'), q('qb'), q('qc')]), [['2 questions added', 'questions.html#qa', true], ['1 question added', 'questions.html#qc', true]]);
  // One of the first batch answered leaves it open; the other resolved closes it, while the second batch stays open.
  assert.deepEqual(opens([q('qa'), q('qb'), q('qc')], [answer('qa')]).map((m) => m[2]), [true, true]);
  assert.deepEqual(opens([q('qa'), q('qb', { resolved: 'Settled', resolved_at: '2026-11-12T11:30:00Z' }), q('qc')], [answer('qa')]).map((m) => m[2]), [false, true]);
  assert.deepEqual(opens([q('qa'), q('qb'), q('qc')], [answer('qa'), answer('qb'), answer('qc')]).map((m) => m[2]), [false, false]);
});

// docs/adr/2026-11-13-1800-every-wait-is-listed-and-working-is-display-only.md
test('a card lists every wait it has on the orchestrator, so one never hides another, and a brief is owed only in Todo', () => {
  const at = '2026-11-04T10:00:00Z';
  const built = ({ items, agents = {}, events = [], owner = {} }) => buildBoard({ now: Date.parse('2026-11-04T11:00:00Z'), owner, events, threads: {}, working: {},
    files: [{ slug: 'w', agents, itemFile: { internal: true, items } }] });
  const kinds = (b) => orchestratorWaits(b).map((w) => [w.key, w.kind, w.since]);
  const handed = { A1: { main: { kind: 'claude', started: '2026-11-04T09:00:00Z', done: at, handed_back: at, calls: [{ at: '2026-11-04T09:30:00Z', text: 'x' }] } } };
  const stray = [{ kind: 'grill', at: '2026-11-04T08:00:00Z' }];
  // T-182: a hand-back's calls with a stray owed brief past Todo read as calls.
  const calls = built({ items: [{ id: 'A1', title: 'One', lane: 'progress', briefs: stray }], agents: handed });
  assert.deepEqual(kinds(calls), [['w/A1', 'calls', at]]);
  assert.equal(calls.items[0].orchestrator.kind, 'calls');
  // An owner answer not acted on and the calls both wait, the answer first on the card.
  const q = { id: 'q1', topic: 'item:w/A1', question: 'Which?', asked_at: '2026-11-04T08:30:00Z' };
  const answer = { id: 'e1', ts: '2026-11-04T09:45:00Z', kind: 'owner-answer', data: { id: 'q1', note: 'this' }, reply: null };
  const both = built({ items: [{ id: 'A1', title: 'One', lane: 'progress' }], agents: handed, owner: { items: [q] }, events: [answer] });
  assert.deepEqual(kinds(both), [['w/A1', 'answer', '2026-11-04T09:45:00Z'], ['w/A1', 'calls', at]]);
  assert.deepEqual([both.items[0].orchestrator.kind, both.items[0].moreWaits.map((w) => w.kind)], ['answer', ['calls']]);
  // In Todo the brief is owed, and a refusal beside it still lists.
  const refused = { 'w/A1': [{ ts: at, who: 'claude', kind: 'hub', line: 'build-refused', text: "Couldn't start implementing: no repo" }] };
  const todo = buildBoard({ now: Date.parse('2026-11-04T11:00:00Z'), owner: {}, events: [], threads: refused, working: {},
    files: [{ slug: 'w', agents: {}, itemFile: { internal: true, items: [{ id: 'A1', title: 'One', phase: 'ready', briefs: stray }] } }] });
  assert.deepEqual(kinds(todo), [['w/A1', 'brief', '2026-11-04T08:00:00Z'], ['w/A1', 'refused', at]]);
  // Each wait joins the stored list and wakes the session once.
  assert.deepEqual(waitsStep([], orchestratorWaits(both), new Date('2026-11-04T11:00:00Z')).added, ['w/A1']);
});

test("a message's working ends at the orchestrator's next command on its card or the card's close, as at a Claude line, and an earlier one leaves it", () => {
  const msg = { id: 'm1', ts: '2026-10-23T10:00:00Z', kind: 'item-message', data: { key: 'w/A1', text: 'Send it' }, reply: null };
  const working = { m1: '2026-10-23T10:01:00Z' };
  const card = (item = {}, actedOn = {}, events = [msg]) => buildBoard({ fromWaves: false, now: Date.parse('2026-10-23T12:00:00Z'), events, working, actedOn,
    files: [{ slug: 'w', itemFile: { items: [{ id: 'A1', title: 'feat: one', ...item }] } }] }).items[0];
  assert.equal(card().working, true);
  // T-175: item set --phase ready after the owner's "Send it".
  assert.equal(card({ phase: 'ready' }, { 'w/A1': '2026-10-23T10:05:00Z' }).working, false, 'a command after it');
  assert.equal(card({ phase: 'ready' }, { 'w/A1': '2026-10-23T09:00:00Z' }).working, true, 'a command before it');
  assert.equal(threadOf('w/A1', { events: [msg], working, clearedAt: '2026-10-23T10:05:00Z' })[0].state, 'answered');
  // T-115: the owner's own close after their message.
  assert.equal(card({ lane: 'done', closed_at: '2026-10-23T10:10:00Z' }).working, false, 'a close after it');
  assert.equal(card({}, {}, [msg, { id: 'd1', ts: '2026-10-23T10:10:00Z', kind: 'card-done', data: { key: 'w/A1' } }]).working, false, "the owner's Done tap after it");
});

// docs/adr/2026-11-13-0230-a-card-reference-is-drawn-by-one-helper-with-its-lane-ring.md
test("every thread line that names a card carries its key and words, reads its current ref, never its <file>/T-n key, and links to it", () => {
  const itemFile = { items: [
    { id: 'T-1', title: 'Parent', ticket: '#620', lane: 'todo' },
    { id: 'T-2', title: 'Child', ticket: '#631', lane: 'progress', parent: 'T-1' },
    { id: 'T-3', title: 'No ticket yet', lane: 'todo' },
  ] };
  const at = (n) => `2026-11-12T22:0${n}:00Z`;
  const named = (command, card, n) => ({ ts: at(n), who: 'claude', text: COMMANDS[command], command, card });
  const threads = {
    'hub/T-2': [named('created-from', 'hub/T-1', 1), named('related', 'hub/T-3', 2), named('unrelated', 'hub/T-3', 3), named('followup-of', 'hub/T-1', 4),
      // A card that left the board reads by its id.
      named('related', 'hub/T-9', 5),
      { ts: at(6), who: 'claude', kind: 'hub', line: 'ticket-made', text: 'Created ticket #631' }],
    'hub/T-1': [named('created', 'hub/T-2', 1), named('followup', 'hub/T-2', 2)],
  };
  const b = buildBoard({ fromWaves: false, tickets: { source: 'github' }, threads, files: [{ slug: 'hub', itemFile }] });
  const cards = new Map(b.items.map((i) => [i.key, { ref: i.ref }]));
  const naming = (key) => threadOf(key, { lines: threads[key] || [], cards }).filter((m) => m.card);
  assert.deepEqual(naming('hub/T-2').map((m) => [m.words, m.card, m.text, m.link]), [
    ['Created from', 'hub/T-1', 'Created from #620', '#selectedCard=hub%2FT-1'],
    ['Related to', 'hub/T-3', 'Related to T-3', '#selectedCard=hub%2FT-3'],
    ['Unrelated from', 'hub/T-3', 'Unrelated from T-3', '#selectedCard=hub%2FT-3'],
    ['Follow-up of', 'hub/T-1', 'Follow-up of #620', '#selectedCard=hub%2FT-1'],
    ['Related to', 'hub/T-9', 'Related to T-9', '#selectedCard=hub%2FT-9'],
    // The card's own Created ticket line names the card itself, so it reads the ticket the card has now.
    ['Created ticket', 'hub/T-2', 'Created ticket #631', '#selectedCard=hub%2FT-2'],
  ]);
  assert.deepEqual(naming('hub/T-1').map((m) => m.text), ['Created ticket #631', 'Follow-up #631']);
  // An ask's links name their cards the same way.
  const ask = { id: 'a1', ts: at(0), kind: 'ask', data: { text: 'Fix it' }, reply: null };
  const asked = threadOf('ask:a1', { events: [ask], links: [{ key: 'hub/T-2', ref: '#631', became: true }, { key: 'hub/T-3', ref: 'T-3', title: 'No ticket yet', became: false, folded: true }] }).filter((m) => m.card);
  assert.deepEqual(asked.map((m) => [m.words, m.card, m.text]), [['Became', 'hub/T-2', 'Became #631'], ['Moved to', 'hub/T-3', 'Moved to T-3']]);
  // No line the board draws, in any thread, names a card by its key.
  for (const m of [...b.items.flatMap((i) => threadOf(i.key, { lines: threads[i.key] || [], cards })), ...asked]) assert.doesNotMatch(m.text, /\b[\w-]+\/[A-Z]+-\d+\b/, m.text);
});

test("an owner event's thread line carries the sendId of the tap that wrote it, so the page can match its own copy", () => {
  const events = [
    { id: 'e1', ts: '2026-10-23T10:01:00Z', kind: 'item-message', data: { key: 'w/A1', text: 'Hi', sendId: 's-1' }, reply: null },
    { id: 'e2', ts: '2026-10-23T10:02:00Z', kind: 'prototype-request', data: { key: 'w/A1', sendId: 'p-1' }, reply: null },
    { id: 'e3', ts: '2026-10-23T10:03:00Z', kind: 'item-message', data: { key: 'w/A1', text: 'No id' }, reply: null },
  ];
  assert.deepEqual(threadOf('w/A1', { events }).map((m) => m.sendId), ['s-1', 'p-1', undefined]);
});
