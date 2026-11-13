import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boardWith, home, at, site, write, read, lines, run, runAsync, board, onOrch, threadOf, wave, question, git, commit, scratchRepo, worktree, land, branches, record, toolUse, toolResult, stopHook, ago, onHome, pollClock } from './board-fixture.mjs';
import * as store from './store.mjs';

test('agent.mjs still writes builder records, beside the wave file it names', async () => {
  assert.equal(run('agent.mjs', ['start', 'w/A1', '--label', 'Opus builder']).code, 0);
  assert.equal(read(at('waves', 'w', 'agents', 'A1.json')).label, 'Opus builder');
  assert.equal(run('agent.mjs', ['done', 'w/A1']).code, 0);
  assert.equal(Number.isNaN(Date.parse(read(at('waves', 'w', 'agents', 'A1.json')).done)), false);

  assert.equal(run('agent.mjs', ['start', 'audit/A1', '--dir', site('audit', 'data')]).code, 0);
  assert.equal(typeof read(site('audit', 'data', 'agents', 'A1.json')).started, 'string');
  assert.equal((await board('builder', 'done', 'audit/A1', '--site', 'audit')).code, 0);
  assert.equal(typeof read(site('audit', 'data', 'agents', 'A1.json')).done, 'string');
  assert.equal(run('agent.mjs', ['start', 'audit/A1', '--dir', site('audit', 'data')]).code, 0);
  assert.equal('done' in read(site('audit', 'data', 'agents', 'A1.json')), false);
  assert.equal(run('agent.mjs', ['start', 'w/Z9']).code, 1);
});

test('builder keeps one record per agent on an item, with its kind and an ETA it can change or clear', async () => {
  write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One', lane: 'progress' }] });
  assert.equal((await board('builder', 'start', 'w/A1', '--label', 'Opus builder', '--kind', 'claude')).code, 0);
  assert.equal((await board('builder', 'start', 'w/A1', '--agent', 'bench', '--kind', 'bench', '--eta', '2026-10-23T16:30:00-07:00')).code, 0);
  assert.deepEqual([read(at('waves', 'w', 'agents', 'A1.json')).kind, read(at('waves', 'w', 'agents', 'A1@bench.json')).eta], ['claude', '2026-10-23T23:30:00.000Z']);
  assert.equal((await board('builder', 'progress', 'w/A1', 'Still', 'running', '--phase', 'testing', '--site', 'orch', '--agent', 'bench', '--eta', '2026-10-24T01:00:00Z')).code, 0);
  assert.equal(read(at('waves', 'w', 'agents', 'A1@bench.json')).eta, '2026-10-24T01:00:00.000Z');
  assert.equal((await board('builder', 'progress', 'w/A1', 'Done soon', '--phase', 'testing', '--site', 'orch', '--agent', 'bench', '--clear-eta')).code, 0);
  assert.equal('eta' in read(at('waves', 'w', 'agents', 'A1@bench.json')), false);
  assert.match((await board('builder', 'progress', 'w/A1', 'x', '--phase', 'testing', '--site', 'orch', '--eta', 'soon')).err, /--eta takes an ISO time/);
  assert.equal((await board('builder', 'progress', 'w/A1', 'Benchmarking', '--phase', 'testing', '--site', 'orch', '--agent', 'bench', '--eta', '2026-10-24T01:00:00Z')).code, 0);
  assert.equal((await board('builder', 'done', 'w/A1', '--agent', 'bench')).code, 0);
  const bench = read(at('waves', 'w', 'agents', 'A1@bench.json'));
  assert.deepEqual([typeof bench.done, 'eta' in bench, 'done' in read(at('waves', 'w', 'agents', 'A1.json'))], ['string', false, false]);
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].lane, 'progress');
  assert.equal((await board('item', 'set', 'w/A1', '--site', 'orch', '--next', 'Review')).code, 0);
  assert.equal('done' in read(at('waves', 'w', 'agents', 'A1.json')), false);
  assert.equal((await board('item', 'set', 'w/A1', '--site', 'orch', '--pr', '7')).code, 0);
  assert.deepEqual([typeof read(at('waves', 'w', 'agents', 'A1.json')).done, read(at('waves', 'w', 'agents', 'A1@bench.json')).done], ['string', bench.done]);
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].lane, 'review');
  // A builder's own start and done, a build's start aside, leave the card's wave entry as it is, in any lane.
  for (const [key, flags, file] of [
    ['w/A1', [], at('waves', 'w', 'wave.json')],
    ['audit/A1', ['--site', 'audit'], site('audit', 'data', 'items.json')],
    ['audit/A1', ['--dir', site('audit', 'data')], site('audit', 'data', 'items.json')],
  ]) {
    for (const fields of [{ lane: 'progress' }, { lane: 'todo', held: true }, { lane: 'review', prs: [{ number: 7 }] }, { lane: 'done', closed_at: '2026-10-23T10:00:00Z' }]) {
      const w = read(file);
      w.items[0] = { id: 'A1', title: 'One', next: 'Review', ...fields };
      write(file, w);
      const before = read(file).items[0];
      assert.equal((await board('builder', 'start', key, ...flags)).code, 0);
      assert.equal((await board('builder', 'start', key, ...flags, '--agent', 'install', '--kind', 'install')).code, 0);
      assert.equal((await board('builder', 'done', key, ...flags)).code, 0);
      assert.deepEqual(read(file).items[0], before, fields.lane);
      assert.equal((await board('builder', 'done', key, ...flags, '--agent', 'install')).code, 0);
      assert.deepEqual(read(file).items[0], before, fields.lane);
      assert.equal((await board('builder', 'done', key, ...flags, '--agent', 'install')).code, 0);
      assert.deepEqual(read(file).items[0], before, fields.lane);
    }
  }
});

test('a hand-back closes ordinary builders while an install survives until explicitly stopped or the card finishes', async () => {
  const install = at('waves', 'w', 'agents', 'A1@install.json');
  assert.equal((await board('builder', 'start', 'w/A1', '--agent', 'install', '--kind', 'install', '--eta', '2026-10-30T18:00:00Z')).code, 0);
  const running = read(install);
  assert.equal((await board('builder', 'start', 'w/A1')).code, 0);
  assert.equal((await board('item', 'set', 'w/A1', '--site', 'orch', '--pr', '7')).code, 0);
  assert.equal(typeof read(at('waves', 'w', 'agents', 'A1.json')).done, 'string');
  assert.deepEqual(read(install), running);
  assert.equal((await board('builder', 'start', 'w/A1')).code, 0);
  assert.equal((await board('builder', 'start', 'w/A1', '--agent', 'fix')).code, 0);
  assert.equal((await board('builder', 'call', 'w/A1', '--agent', 'fix', 'Kept the old header')).code, 0);
  assert.match((await board('builder', 'done', 'w/A1', '--site', 'orch', '--agent', 'fix')).out, /^handed back: Next/m);
  for (const agent of ['A1', 'A1@fix']) {
    const closed = read(at('waves', 'w', 'agents', `${agent}.json`));
    assert.deepEqual([typeof closed.done, typeof closed.handed_back], ['string', 'string'], agent);
  }
  assert.deepEqual(read(install), running);
  assert.equal((await board('builder', 'done', 'w/A1', '--agent', 'install')).code, 0);
  assert.equal(typeof read(install).done, 'string');
  assert.equal('eta' in read(install), false);
  assert.equal((await board('builder', 'start', 'w/A1', '--agent', 'install', '--kind', 'install')).code, 0);
  assert.equal((await board('item', 'set', 'w/A1', '--site', 'orch', '--done', '--text', 'Closed.')).code, 0);
  assert.equal(typeof read(install).done, 'string');
});

test('builder start --model records the Claude model and prints it', async () => {
  const r = await board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'claude', '--model', 'sonnet', '--label', 'Sonnet builder');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^model: Claude Sonnet$/m);
  assert.deepEqual(['kind', 'model'].map((f) => read(at('waves', 'w', 'agents', 'A1.json'))[f]), ['claude', 'sonnet']);
  assert.equal((await board('--site', 'orch', 'builder', 'start', 'w/A1', '--agent', 'x', '--kind', 'codex', '--model', 'opus')).code, 1);
});

// docs/adr/2026-11-03-0514-a-builder-records-its-judgment-calls-and-the-session-verifies-them.md
test('builder call appends a one-line call to the open record, calls prints them, verified marks them checked, and a restart keeps the unverified ones', async () => {
  const main = at('waves', 'w', 'agents', 'A1.json');
  const noRecord = await board('builder', 'call', 'w/A1', 'Kept the old name');
  assert.deepEqual([noRecord.code, noRecord.err], [1, 'builder call needs an open builder record on w/A1; run builder start first\n']);
  assert.equal((await board('builder', 'start', 'w/A1')).code, 0);
  assert.deepEqual(await board('builder', 'calls', 'w/A1'), { code: 0, err: '', out: 'no judgment calls recorded\n' });
  assert.match((await board('builder', 'verified', 'w/A1')).err, /no unverified judgment calls/);
  const said = await board('--site', 'orch', 'builder', 'call', 'w/A1', 'Question: does the land check cover every agent?');
  assert.deepEqual([said.code, said.out], [0, 'judgment call recorded on A1\n']);
  assert.equal((await board('builder', 'call', 'w/A1', 'Kept', 'the old name')).code, 0);
  assert.match((await board('builder', 'call', 'w/A1', 'two\nlines')).err, /one line/);
  assert.deepEqual(read(main).calls.map((c) => c.text), ['Question: does the land check cover every agent?', 'Kept the old name']);
  assert.deepEqual((await board('builder', 'calls', 'w/A1')).out.trim().split('\n'), ['1. Question: does the land check cover every agent?', '2. Kept the old name', 'not verified yet']);

  // A hand-back closes the record; a restart of the same agent is that build resumed, its calls and worktree kept.
  write(main, { ...read(main), worktree: { path: '/wt/A1', branch: 'A1', repo: '/repo' } });
  assert.match((await board('builder', 'done', 'w/A1', '--site', 'orch')).out, /^handed back: Next "Answer the builder's questions"$/m);
  assert.match((await board('builder', 'call', 'w/A1', 'Late')).err, /needs an open builder record/);
  assert.equal((await board('builder', 'start', 'w/A1')).code, 0);
  assert.deepEqual([read(main).calls.length, read(main).worktree.path], [2, '/wt/A1']);
  assert.equal((await board('builder', 'call', 'w/A1', 'Dropped the cap')).code, 0);
  assert.match((await board('builder', 'done', 'w/A1', '--site', 'orch')).out, /^handed back: /m);
  // A dispatch on that record, and the agent's own start taking the dispatch up, keep the calls too.
  assert.equal((await board('--site', 'orch', 'builder', 'start', 'w/A1', '--dispatch', '--kind', 'claude')).code, 0);
  assert.equal((await board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'build')).code, 0);
  assert.deepEqual([read(main).calls.length, 'dispatched' in read(main)], [3, false]);
  assert.match((await board('builder', 'done', 'w/A1', '--site', 'orch')).out, /^handed back: /m);

  const verified = await board('--site', 'orch', 'builder', 'verified', 'w/A1', '--note', 'All match the notes.');
  assert.deepEqual([verified.code, verified.out], [0, "A1: judgment calls verified; A1 didn't land: the build's worktree is gone\n"]);
  assert.equal(read(main).verified.note, 'All match the notes.');
  assert.match((await board('builder', 'calls', 'w/A1')).out, /^3\. Dropped the cap\nverified \S+: All match the notes\.$/m);
  assert.match((await board('builder', 'verified', 'w/A1')).err, /no unverified judgment calls/);

  // Once verified, a restart is a new build: its record starts with no calls.
  assert.equal((await board('builder', 'start', 'w/A1')).code, 0);
  assert.deepEqual(['calls' in read(main), 'verified' in read(main), 'worktree' in read(main)], [false, false, false]);
});

test('builder asks --wait returns once every ask is answered and fails after its timeout while one waits', async (t) => {
  onHome(t);
  const orch = (...args) => board('--site', 'orch', ...args);
  assert.equal((await orch('builder', 'start', 'w/A1', '--kind', 'claude', '--model', 'opus')).code, 0);
  assert.equal((await orch('builder', 'ask', 'w/A1', 'Spec contradicts the probe?')).code, 0);
  const { now, checked } = pollClock(t);
  const waiting = store.listAsks(site('orch'), 'w/A1', { wait: true, now });
  await checked();
  t.mock.timers.tick(9 * 60_000);
  await assert.rejects(waiting, { message: 'ask1 still waiting on the orchestrator after 9 minutes; run builder asks w/A1 --wait again' });
  t.mock.timers.reset();
  assert.equal((await orch('builder', 'answer', 'w/A1', 'ask1', '--text', 'Follow the probe.')).code, 0);
  assert.deepEqual((await orch('builder', 'asks', 'w/A1', '--wait')).out.trim().split('\n'), ['ask1. Spec contradicts the probe?', '  answered: Follow the probe.']);
});

test('builder ask posts to the thread as the builder and wakes the orchestrator, which answers or defers to the owner', async () => {
  const main = at('waves', 'w', 'agents', 'A1.json');
  const orch = (...args) => board('--site', 'orch', ...args);
  assert.match((await orch('builder', 'ask', 'w/A1', 'Stay orange?')).err, /needs an open builder record on w\/A1/);
  assert.equal((await orch('builder', 'start', 'w/A1', '--kind', 'claude', '--model', 'opus')).code, 0);
  assert.match((await board('builder', 'ask', 'w/A1', 'Stay orange?')).err, /needs --site/);
  const asked = await orch('builder', 'ask', 'w/A1', 'Should Implement stay', 'orange?');
  assert.deepEqual([asked.code, asked.out], [0, 'A1: asked the orchestrator, ask1\n']);
  assert.match((await orch('builder', 'ask', 'w/A1', 'two\nlines')).err, /one line/);
  const [line] = lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).filter((m) => m.kind === 'builder-ask');
  assert.deepEqual([line.who, line.text, line.ask], ['Claude Opus builder', 'Should Implement stay orange?', 'ask1']);
  const event = lines(site('orch', 'data', 'events.jsonl')).at(-1);
  assert.deepEqual([event.kind, event.data], ['builder-ask', { key: 'w/A1', ask: 'ask1', agent: 'main', text: 'Should Implement stay orange?' }]);
  assert.deepEqual((await orch('builder', 'asks', 'w/A1')).out, 'ask1. Should Implement stay orange?\n  waiting on the orchestrator\n');

  const answered = await orch('builder', 'answer', 'w/A1', 'ask1', '--text', 'Go quiet.');
  assert.deepEqual([answered.code, answered.out], [0, 'A1: ask1 answered\n']);
  assert.match((await orch('builder', 'answer', 'w/A1', 'ask1', '--text', 'Again')).err, /ask1 on w\/A1 is already answered/);
  assert.match((await orch('builder', 'answer', 'w/A1', 'ask9', '--text', 'No')).err, /no ask "ask9" on w\/A1; builder asks w\/A1 lists them/);
  const reply = lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).at(-1);
  assert.deepEqual([reply.who, reply.kind, reply.ask, reply.text], ['claude', 'builder-answer', 'ask1', 'Go quiet.']);
  assert.equal((await orch('builder', 'ask', 'w/A1', 'Fold Done on a new device?')).code, 0);
  const deferred = await orch('builder', 'defer', 'w/A1', 'ask2', '--text', 'Not sure. Carry on with folded; I put it to the owner after review.');
  assert.deepEqual([deferred.code, deferred.out], [0, 'A1: ask2 deferred to the owner\n']);
  assert.deepEqual((await orch('builder', 'asks', 'w/A1')).out.trim().split('\n'), ['ask1. Should Implement stay orange?', '  answered: Go quiet.',
    'ask2. Fold Done on a new device?', '  deferred: Not sure. Carry on with folded; I put it to the owner after review.']);
  // A deferred ask is a question for the owner: the build hands back for it, and the review puts it to the owner.
  assert.deepEqual(read(main).calls.map((c) => c.text), ['Question: Fold Done on a new device? (deferred to the owner)']);
  assert.match((await orch('builder', 'done', 'w/A1')).out, /handed back: Next "Answer the builder's questions"/);
  assert.match((await orch('builder', 'verified', 'w/A1')).err, /^ask2 on w\/A1 was deferred to the owner; add its question with "ask": "ask2" first\n$/);
  const q = (extra) => ({ id: 'gh-fold', topic: 'item:w/A1', question: 'Fold Done on a new device?', options: [{ id: 'yes', label: 'Folded', recommended: true }, { id: 'no', label: 'Open' }], ...extra });
  write(path.join(home, 'q.json'), q({ ask: 'ask1' }));
  assert.match((await orch('question', 'add', '--file', path.join(home, 'q.json'))).err, /question gh-fold\.ask names ask1, which the orchestrator answered; only a deferred ask goes to the owner/);
  write(path.join(home, 'q.json'), q({ ask: 'ask2' }));
  assert.equal((await orch('question', 'add', '--file', path.join(home, 'q.json'))).code, 0);
  assert.equal((await orch('builder', 'verified', 'w/A1')).code, 0);
});

test('builder pick names the kind that builds now, builder start refuses the other, and --kind build takes the pick', async () => {
  const noCodex = (...args) => boardWith(args, { PATH: path.join(home, 'bin') });
  assert.deepEqual(await noCodex('builder', 'pick', 'w/A1', '--site', 'orch'), { code: 0, err: '', out: "claude opus: Codex isn't installed on the host. Claude model is Auto and the card isn't small.\n" });
  assert.equal((await noCodex('builder', 'pick', 'w/Z9', '--site', 'orch')).code, 1);
  const refused = await noCodex('builder', 'start', 'w/A1', '--site', 'orch', '--kind', 'codex');
  assert.deepEqual([refused.code, refused.err], [1, "--kind codex: claude builds now. Codex isn't installed on the host. Claude model is Auto and the card isn't small. Pass --kind claude, or --kind build.\n"]);
  assert.equal(fs.existsSync(at('waves', 'w', 'agents', 'A1.json')), false);
  const picked = await noCodex('builder', 'start', 'w/A1', '--site', 'orch', '--kind', 'build');
  assert.equal(picked.code, 0, picked.err);
  assert.match(picked.out, /^kind: claude\. Codex isn't installed on the host\. Claude model is Auto and the card isn't small\.\nmodel: Claude Opus$/m);
  assert.match(picked.out, /^ref: A1$/m);
  assert.equal(read(at('waves', 'w', 'agents', 'A1.json')).kind, 'claude');
  assert.equal(read(at('waves', 'w', 'agents', 'A1.json')).model, 'opus');
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].lane, 'progress');
  write(at('waves', 'w', 'wave.json'), { ...read(at('waves', 'w', 'wave.json')), items: [...read(at('waves', 'w', 'wave.json')).items, { id: 'A2', title: 'feat: two', deps: ['A1'] }] });
  const blocked = await noCodex('builder', 'start', 'w/A2', '--site', 'orch', '--kind', 'claude');
  assert.equal(blocked.code, 1);
  assert.match(blocked.err, /A1/);
  assert.equal(fs.existsSync(at('waves', 'w', 'agents', 'A2.json')), false);
});

// docs/adr/2026-11-05-0913-the-hub-and-each-board-keep-an-audit-log-of-the-calls-their-code-makes.md
test("a build start records builder pick's choice, reason and inputs in the board's audit log, which board.mjs audit prints", async () => {
  const noCodex = (...args) => boardWith(args, { PATH: path.join(home, 'bin') });
  assert.equal((await board('--site', 'orch', 'audit')).out, 'No calls in the last 30 days.\n');
  assert.equal((await noCodex('builder', 'pick', 'w/A1', '--site', 'orch')).code, 0);
  assert.equal(fs.existsSync(site('orch', 'data', 'audit.jsonl')), false, 'a pick that starts nothing records nothing');
  const started = await noCodex('builder', 'start', 'w/A1', '--site', 'orch', '--kind', 'build');
  assert.equal(started.code, 0, started.err);
  const [entry, ...more] = fs.readFileSync(site('orch', 'data', 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const reason = "Codex isn't installed on the host. Claude model is Auto and the card isn't small.";
  assert.deepEqual([{ ...entry, at: typeof entry.at }, more], [{ at: 'string', call: 'builder-pick', key: 'w/A1', result: 'claude opus', reason, inputs: { codex: 'not installed', claudeModel: 'auto', size: null, cardModel: null } }, []]);
  const printed = await board('--site', 'orch', 'audit');
  assert.equal(printed.code, 0, printed.err);
  assert.equal(printed.out, `${entry.at} builder-pick w/A1: claude opus. ${reason}\n  inputs: {"codex":"not installed","claudeModel":"auto","size":null,"cardModel":null}\n`);
  assert.equal((await board('--site', 'orch', 'audit', 'w/A1')).out, printed.out);
  assert.equal((await board('--site', 'orch', 'audit', 'w/B7')).out, 'No calls in the last 30 days.\n');
  assert.equal((await board('audit')).code, 1, 'audit reads a board, so it needs --site');
});

// docs/adr/2026-11-03-1526-usage-picks-opus-auto-or-sonnet-for-claude-builders.md
test("a card's --size and --model feed builder pick's Claude model, and builder start refuses a --model the hub's Claude model rules out", async () => {
  const noCodex = (...args) => boardWith(args, { PATH: path.join(home, 'bin') });
  const card = () => read(at('waves', 'w', 'wave.json')).items[0];
  const pick = async () => (await noCodex('builder', 'pick', 'w/A1', '--site', 'orch')).out;
  assert.deepEqual([(await board('item', 'set', 'w/A1', '--size', 'small')).code, card().size], [0, 'small']);
  assert.equal(await pick(), "claude sonnet: Codex isn't installed on the host. Claude model is Auto and the card is small.\n");
  assert.deepEqual([(await board('item', 'set', 'w/A1', '--model', 'opus')).code, card().model], [0, 'opus']);
  assert.equal(await pick(), "claude opus: Codex isn't installed on the host. Claude model is Auto and the card asks for Claude Opus.\n");
  assert.equal((await board('item', 'set', 'w/A1', '--model', '', '--size', '')).code, 0);
  assert.deepEqual(['size' in card(), 'model' in card()], [false, false]);
  assert.match((await board('item', 'set', 'w/A1', '--size', 'tiny')).err, /^--size takes small or large/);
  assert.match((await board('item', 'set', 'w/A1', '--model', 'haiku')).err, /^--model takes opus or sonnet/);
  const added = await board('item', 'add', 'w/A9', '--title', 'feat: nine', '--size', 'small', '--model', 'sonnet');
  assert.equal(added.code, 0, added.err);
  assert.deepEqual([read(at('waves', 'w', 'wave.json')).items.at(-1).size, read(at('waves', 'w', 'wave.json')).items.at(-1).model], ['small', 'sonnet']);
  assert.equal('phase' in read(at('waves', 'w', 'wave.json')).items.at(-1), false, 'a card added without --phase gets its grill from the board');
  // docs/adr/2026-11-07-0700-staging-then-ready.md: item add never files a card ready; it reaches ready through staging.
  const count = () => read(at('waves', 'w', 'wave.json')).items.length;
  const before = count();
  assert.match((await board('item', 'add', 'w/Q1', '--title', 'feat: quick', '--phase', 'planned')).err, /--phase takes ready, discussing, grilling or prototyping/);
  write(at('waves', 'w', 'q1.md'), '# Quick\n');
  assert.match((await board('item', 'add', 'w/Q1', '--title', 'feat: quick', '--phase', 'ready', '--size', 'small')).err, /item add files a card discussing, grilling or prototyping/);
  assert.equal(count(), before, 'a refused add writes no card');

  write(at('kickflip', 'settings.json'), { claudeModel: 'sonnet' });
  assert.equal(await pick(), "claude sonnet: Codex isn't installed on the host. Claude model is Sonnet.\n");
  const refused = await noCodex('builder', 'start', 'w/A1', '--site', 'orch', '--kind', 'claude', '--model', 'opus');
  assert.deepEqual([refused.code, refused.err], [1, "--model opus: the hub's Claude model is Sonnet. Pass --model sonnet, or no --model.\n"]);
  assert.equal(fs.existsSync(at('waves', 'w', 'agents', 'A1.json')), false);
  assert.equal((await noCodex('builder', 'start', 'w/A1', '--site', 'orch', '--kind', 'opus')).code, 1);
  const started = await noCodex('builder', 'start', 'w/A1', '--site', 'orch', '--kind', 'build');
  assert.equal(started.code, 0, started.err);
  assert.match(started.out, /^kind: claude\. Codex isn't installed on the host\. Claude model is Sonnet\.\nmodel: Claude Sonnet$/m);
  assert.equal(read(at('waves', 'w', 'agents', 'A1.json')).model, 'sonnet');
  // A kind other than a build keeps its own model.
  assert.equal((await noCodex('builder', 'start', 'w/A1', '--site', 'orch', '--agent', 'p', '--kind', 'prototype', '--model', 'opus')).code, 0);
});

test('builder start --worktree makes a worktree on a new branch from main, keeps it on the record and prints it, and refuses a taken path or branch', async () => {
  const repo = scratchRepo();
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  commit(repo, 'landed.txt', 'locally landed');
  const r = await board('builder', 'start', 'w/A1', '--worktree', '--repo', repo);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `A1: builder started\nworktree: ${worktree()}\n`);
  assert.deepEqual(read(at('waves', 'w', 'agents', 'A1.json')).worktree, { path: worktree(), branch: 'A1', repo });
  assert.equal(git(worktree(), 'rev-parse', '--abbrev-ref', 'HEAD'), 'A1');
  assert.equal(git(worktree(), 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'main'));
  const taken = await board('builder', 'start', 'w/A1', '--agent', 'two', '--worktree', '--repo', repo);
  assert.deepEqual([taken.code, taken.err], [1, `--worktree: ${worktree()} already exists and another open builder record uses it; land or remove it first\n`]);
  assert.equal(fs.existsSync(at('waves', 'w', 'agents', 'A1@two.json')), false);
  git(repo, 'worktree', 'remove', worktree());
  const branch = await board('builder', 'start', 'w/A1', '--agent', 'two', '--worktree', '--repo', repo);
  assert.deepEqual([branch.code, branch.err], [1, `--worktree: branch A1 already exists in ${repo}\n`]);
  assert.equal(fs.existsSync(worktree()), false);
  assert.equal((await board('builder', 'start', 'w/A1', '--repo', repo)).code, 2);
});

test("a build start on a board makes the card's worktree when its record keeps none, and the agent taking up a dispatched record keeps that one", async () => {
  const repo = scratchRepo();
  write(at('kickflip', 'manifest.json'), { sites: { orch: { dir: site('orch'), port: 1, cmd: [process.execPath, '/skill/board/server.mjs', site('orch')], owner: { repo } } } });
  const dispatched = await board('--site', 'orch', 'builder', 'start', 'w/A1', '--dispatch', '--kind', 'claude');
  assert.equal(dispatched.code, 0, dispatched.err);
  assert.ok(dispatched.out.includes(`worktree: ${worktree()}\n`), dispatched.out);
  assert.equal(git(worktree(), 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'main'));
  const taken = await board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'build', '--label', 'Opus implementer');
  assert.equal(taken.code, 0, taken.err);
  assert.deepEqual(read(at('waves', 'w', 'agents', 'A1.json')).worktree, { path: worktree(), branch: 'A1', repo });
  assert.equal((await board('--site', 'orch', 'builder', 'start', 'w/A1', '--agent', 'notes', '--label', 'Notes')).code, 0);
  assert.equal(read(at('waves', 'w', 'agents', 'A1@notes.json')).worktree, undefined);
  assert.deepEqual(branches(repo), ['A1', 'main']);

  commit(worktree(), 'work.txt', 'built');
  assert.equal((await board('--site', 'orch', 'builder', 'done', 'w/A1', '--next', 'Check the build')).code, 0);
  const again = await board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'build');
  assert.equal(again.code, 0, again.err);
  assert.deepEqual(read(at('waves', 'w', 'agents', 'A1.json')).worktree, { path: worktree(), branch: 'A1', repo });
  assert.equal(fs.readFileSync(path.join(worktree(), 'work.txt'), 'utf8'), 'built');
});

test('builder start --worktree remakes a leftover worktree that holds no work from current main, saying so, and refuses one holding commits or changes, naming them', async () => {
  const repo = scratchRepo();
  const leftover = () => git(repo, 'worktree', 'add', '--quiet', '-b', 'A1', worktree(), 'main');
  leftover();
  write(path.join(worktree(), 'node_modules', 'x.js'), 'ignored\n');
  write(path.join(repo, '.git', 'info', 'exclude'), 'node_modules\n');
  commit(worktree(), 'ahead.txt', 'unlanded');
  const refused = await board('builder', 'start', 'w/A1', '--worktree', '--repo', repo);
  assert.deepEqual([refused.code, refused.err], [1, `--worktree: ${worktree()} holds 1 commit beyond main; land or remove it first\n`]);
  write(path.join(worktree(), 'a.txt'), 'new\n');
  write(path.join(worktree(), 'shared', 'notes.md'), 'b\n');
  const both = await board('builder', 'start', 'w/A1', '--worktree', '--repo', repo);
  assert.deepEqual([both.code, both.err], [1, `--worktree: ${worktree()} holds 1 commit beyond main and 2 changed files; land or remove it first\n`]);
  git(worktree(), 'reset', '--quiet', '--hard', 'main');
  const changed = await board('builder', 'start', 'w/A1', '--worktree', '--repo', repo);
  assert.deepEqual([changed.code, changed.err], [1, `--worktree: ${worktree()} holds 1 changed file; land or remove it first\n`]);
  assert.equal(fs.existsSync(at('waves', 'w', 'agents', 'A1.json')), false);

  fs.rmSync(path.join(worktree(), 'a.txt'));
  commit(repo, 'landed.txt', 'main moved');
  const r = await board('builder', 'start', 'w/A1', '--worktree', '--repo', repo);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `A1: builder started\nworktree: ${worktree()}\nRemade the leftover worktree ${worktree()} from main: it held no commits or changes.\n`);
  assert.equal(git(worktree(), 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'main'));
  assert.equal(fs.existsSync(path.join(worktree(), 'node_modules')), false);
  assert.deepEqual(read(at('waves', 'w', 'agents', 'A1.json')).worktree, { path: worktree(), branch: 'A1', repo });
});

test("builder start stores the installed link for the kickflip fallback repo, and the hub board builds from its own folder's local main like any local board", async () => {
  const clone = scratchRepo();
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const dir of ['bin', 'board', 'hub', 'shared', 'hooks-plugin']) fs.cpSync(path.join(source, dir), path.join(clone, dir), { recursive: true, filter: (file) => !file.endsWith('.test.mjs') });
  git(clone, 'add', '-A');
  git(clone, 'commit', '--quiet', '-m', 'kickflip fixture');
  const { installLinks } = await import('../bin/install.mjs');
  const [{ link }] = installLinks({ home, cloneRoot: clone });
  const start = (...args) => spawnSync(process.execPath, [path.join(link, 'board', 'bin', 'board.mjs'), ...args, 'builder', 'start', 'w/A1', '--worktree'], { env: { ...process.env, HOME: home, KICKFLIP_HUB_PORT: '1' }, encoding: 'utf8' });
  const result = start();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(read(at('waves', 'w', 'agents', 'A1.json')).worktree, { path: worktree(), branch: 'A1', repo: link });
  assert.equal(git(worktree(), 'rev-parse', 'HEAD'), git(clone, 'rev-parse', 'main'));

  git(clone, 'worktree', 'remove', worktree());
  git(clone, 'branch', '--quiet', '-D', 'A1');
  const project = path.join(home, 'project');
  fs.mkdirSync(project);
  git(project, 'init', '--quiet', '-b', 'main');
  git(project, 'config', 'user.name', 'Test');
  git(project, 'config', 'user.email', 'test@example.com');
  commit(project, 'project.txt', 'project');
  const manifest = read(at('kickflip', 'manifest.json'));
  Object.assign(manifest.sites.orch, { hub: true, local: true, github: 'owner/project', branch: 'main', owner: { repo: project } });
  write(at('kickflip', 'manifest.json'), manifest);
  const hub = start('--site', 'orch');
  assert.equal(hub.status, 0, hub.stderr);
  assert.deepEqual(read(at('waves', 'w', 'agents', 'A1.json')).worktree, { path: worktree(), branch: 'A1', repo: project });
  assert.equal(git(worktree(), 'rev-parse', 'HEAD'), git(project, 'rev-parse', 'main'));
  assert.deepEqual(branches(clone), ['main']);
});

test('a build start on a board gives the card its worktree, and a later build start keeps it', async () => {
  const repo = scratchRepo();
  write(at('kickflip', 'manifest.json'), { sites: { orch: { dir: site('orch'), port: 1, cmd: [process.execPath, '/skill/board/server.mjs', site('orch')], owner: { repo } } } });
  const first = await board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'build');
  assert.equal(first.code, 0, first.err);
  assert.equal(git(worktree(), 'rev-parse', '--abbrev-ref', 'HEAD'), 'A1');
  assert.deepEqual(read(at('waves', 'w', 'agents', 'A1.json')).worktree, { path: worktree(), branch: 'A1', repo });
  assert.equal(read(at('waves', 'w', 'wave.json')).items.find((i) => i.id === 'A1').lane, 'progress');
  commit(worktree(), 'work.txt', 'built');
  const started = await board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'build');
  assert.equal(started.code, 0, started.err);
  assert.deepEqual(read(at('waves', 'w', 'agents', 'A1.json')).worktree, { path: worktree(), branch: 'A1', repo });
  assert.equal(fs.readFileSync(path.join(worktree(), 'work.txt'), 'utf8'), 'built');
});

test('a board builder uses its shared clone and selected remote branch without changing the clone checkout', async () => {
  const origin = scratchRepo();
  git(origin, 'checkout', '--quiet', '-b', 'develop');
  commit(origin, 'develop.txt', 'develop');
  const repo = path.join(home, 'clone');
  git(home, 'clone', '--quiet', '--branch', 'main', origin, repo);
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'checkout', '--quiet', '-b', 'develop', 'origin/develop');
  commit(repo, 'local.txt', 'local only');
  git(repo, 'checkout', '--quiet', 'main');
  commit(origin, 'pushed.txt', 'pushed after the clone');
  const head = git(origin, 'rev-parse', 'HEAD');
  const manifest = read(at('kickflip', 'manifest.json'));
  Object.assign(manifest.sites.orch, { github: 'owner/project', branch: 'develop', owner: { repo } });
  write(at('kickflip', 'manifest.json'), manifest);
  const r = await board('--site', 'orch', 'builder', 'start', 'w/A1', '--worktree');
  assert.equal(r.code, 0, r.err);
  assert.equal(git(worktree(), 'rev-parse', 'HEAD'), head);
  assert.equal(git(repo, 'branch', '--show-current'), 'main');
  assert.equal(read(at('waves', 'w', 'agents', 'A1.json')).worktree.repo, repo);
});

test("builder start and progress on --site write each new status line to the item's thread as its phase and detail, named by a further agent's kind", async () => {
  assert.equal((await board('builder', 'start', 'w/A1', '--site', 'orch', '--phase', 'reading', '--progress', 'the plan')).code, 0);
  assert.equal((await board('builder', 'start', 'w/A1', '--site', 'orch', '--agent', 'bench', '--kind', 'claude', '--phase', 'testing', '--progress', 'the benchmark')).code, 0);
  assert.equal((await board('builder', 'progress', 'w/A1', 'the', 'benchmark', '--phase', 'testing', '--site', 'orch', '--agent', 'bench')).code, 0);
  assert.equal((await board('builder', 'progress', 'w/A1', '--phase', 'building', 'the', 'limiter', '--site', 'orch')).code, 0);
  assert.equal((await board('builder', 'progress', 'w/A1', '--site', 'orch', '--phase', 'checking', '--text', 'the page at phone width')).code, 0);
  assert.equal((await board('builder', 'progress', 'w/A1', 'Twice', '--phase', 'testing', '--site', 'orch', '--text', 'Twice')).code, 2);
  assert.equal((await board('builder', 'progress', 'w/A1', '--phase', 'testing', '--site', 'orch')).code, 2);
  assert.equal((await board('builder', 'done', 'w/A1', '--site', 'orch')).code, 0);
  const unseen = await board('builder', 'progress', 'w/A1', 'Unseen', '--phase', 'testing', '--agent', 'bench');
  assert.deepEqual([unseen.code, /needs --site/.test(unseen.err)], [1, true]);
  assert.equal((await board('builder', 'start', 'w/A1', '--agent', 'lint', '--phase', 'testing', '--progress', 'Unseen')).code, 1);
  const msgs = lines(site('orch', 'data', 'threads', 'w__A1.jsonl'));
  assert.deepEqual(msgs.map(({ who, kind, phase, text }) => [who, kind, phase, text]), [
    ['claude', 'status', 'reading', 'Reading: the plan'],
    ['claude', 'status', 'testing', 'Claude Opus testing: the benchmark'],
    ['claude', 'status', 'building', 'Building: the limiter'],
    ['claude', 'status', 'checking', 'Checking: the page at phone width'],
  ]);
  assert.deepEqual(['progress' in read(at('waves', 'w', 'agents', 'A1.json')), 'progress_at' in read(at('waves', 'w', 'agents', 'A1@bench.json'))], [false, false]);
  assert.ok(msgs.every((m) => !Number.isNaN(Date.parse(m.ts))));
});

test("a status line drops a detail's repeat of its own phase label", async () => {
  assert.equal((await board('builder', 'start', 'w/A1', '--site', 'orch')).code, 0);
  assert.equal((await board('builder', 'progress', 'w/A1', '--phase', 'landing', '--site', 'orch', '--text', 'Landing: x')).code, 0);
  assert.equal((await board('builder', 'progress', 'w/A1', '--phase', 'landing', '--site', 'orch', '--text', 'landing rebase')).code, 0);
  assert.equal((await board('builder', 'start', 'w/A1', '--site', 'orch', '--agent', 'bench', '--kind', 'claude', '--phase', 'landing', '--progress', 'Landing: y')).code, 0);
  assert.deepEqual(lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).map((m) => m.text), ['Landing: x', 'Landing: rebase', 'Claude Opus landing: y']);
});

test('builder progress and start --progress refuse a missing or unknown phase and a detail over 80 characters, writing nothing', async () => {
  const long = 'x'.repeat(81);
  for (const [args, err] of [
    [['builder', 'progress', 'w/A1', 'the plan', '--phase', 'waiting', '--site', 'orch'], /^--phase takes reading, building, testing, checking or landing, not "waiting"$/],
    [['builder', 'progress', 'w/A1', long, '--phase', 'testing', '--site', 'orch'], /^builder progress runs to 81 characters, past 80\. Say it shorter\.$/],
    [['builder', 'start', 'w/A1', '--site', 'orch', '--progress', 'the plan'], /^--progress needs --phase reading, building, testing, checking or landing$/],
    [['builder', 'start', 'w/A1', '--site', 'orch', '--phase', 'reading'], /^--phase goes with --progress "<detail>"$/],
    [['builder', 'start', 'w/A1', '--site', 'orch', '--phase', 'reading', '--progress', long], /^--progress runs to 81 characters, past 80\. Say it shorter\.$/],
  ]) {
    const r = await board(...args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err.trim(), err, args.join(' '));
  }
  assert.equal(fs.existsSync(site('orch', 'data', 'threads', 'w__A1.jsonl')), false);
  assert.equal(fs.existsSync(at('waves', 'w', 'agents', 'A1.json')), false);
  assert.equal((await board('builder', 'start', 'w/A1', '--site', 'orch')).code, 0);
  const bare = await board('builder', 'progress', 'w/A1', 'the plan', '--site', 'orch');
  assert.deepEqual([bare.code, bare.err.trim()], [1, 'builder progress needs --phase reading, building, testing, checking or landing']);
  assert.equal((await board('builder', 'progress', 'w/A1', 'x'.repeat(80), '--phase', 'landing', '--site', 'orch')).code, 0);
});

test('the SubagentStop hook closes the builder records its agent started and left open, quietly and any number of times', async () => {
  assert.equal((await board('builder', 'start', 'w/A1', '--site', 'orch')).code, 0);
  assert.equal((await board('builder', 'start', 'w/A1', '--site', 'orch', '--agent', 'bench')).code, 0);
  assert.equal((await board('builder', 'start', 'audit/A1', '--site', 'audit')).code, 0);
  assert.equal((await board('builder', 'done', 'audit/A1', '--site', 'audit')).code, 0);
  const audit = read(site('audit', 'data', 'agents', 'A1.json'));
  // The transcript's times come from the records' own starts, so how long the commands above took can't move a start
  // out of its command's window. t1's result, not its command, is what reaches its record.
  const main = record('A1').started;
  const minutesBefore = (iso, min) => new Date(Date.parse(iso) - min * 60_000).toISOString();
  const transcript = path.join(home, 'agent.jsonl');
  write(transcript, [
    'not json',
    toolUse('t1', 'node ~/.claude/skills/kickflip/board/bin/board.mjs --site orch builder start w/A1 --kind build --label "Opus builder"; ls', minutesBefore(main, 5)),
    toolResult('t1', main),
    toolUse('t2', 'B="node ~/.claude/skills/kickflip/board/bin/board.mjs --site orch"; eval "$B builder start w/A1 --agent bench --kind codex"', record('A1@bench').started),
    toolUse('t3', '$B builder start audit/A1 --site audit', audit.started),
  ].join('\n') + '\n');
  for (const _ of [1, 2]) {
    const r = stopHook({ agent_transcript_path: transcript });
    assert.deepEqual([r.code, r.out], [0, '']);
  }
  assert.equal(typeof read(at('waves', 'w', 'agents', 'A1.json')).done, 'string');
  assert.equal(typeof read(at('waves', 'w', 'agents', 'A1@bench.json')).done, 'string');
  assert.equal(read(site('audit', 'data', 'agents', 'A1.json')).done, audit.done);
});

test('the SubagentStop hook leaves a record another agent restarted on the card after its own start', async () => {
  assert.equal((await board('builder', 'start', 'w/A1', '--site', 'orch', '--agent', 'fix')).code, 0);
  const transcript = path.join(home, 'agent.jsonl');
  write(transcript, [toolUse('t1', 'node board.mjs --site orch builder start w/A1 --agent fix', ago(10 * 60 * 1000)), toolResult('t1', ago(10 * 60 * 1000 - 500))].join('\n'));
  assert.equal(stopHook({ agent_transcript_path: transcript }).code, 0);
  assert.equal('done' in read(at('waves', 'w', 'agents', 'A1@fix.json')), false);
});

test('the SubagentStop hook leaves the records open while background work the agent started still runs, and closes them on its real finish', async () => {
  assert.equal((await board('builder', 'start', 'w/A1', '--site', 'orch')).code, 0);
  const transcript = path.join(home, 'agent.jsonl');
  // The transcript's times come from the record's own start, so how long builder start took can't move it out of the window.
  const started = Date.parse(record().started);
  const after = (ms) => new Date(started + ms).toISOString();
  const launched = (id, toolUseResult) => JSON.stringify({ type: 'user', timestamp: after(500), message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'started' }] }, toolUseResult });
  write(transcript, [
    toolUse('t1', 'node board.mjs --site orch builder start w/A1 --kind build', after(0)),
    toolResult('t1', after(100)),
    launched('t2', { stdout: '', stderr: '', backgroundTaskId: 'bsuite' }),
    launched('t3', { taskId: 'bmonitor', timeoutMs: 1800000, persistent: false }),
    launched('t4', { isAsync: true, status: 'async_launched', agentId: 'ahelper' }),
  ].join('\n') + '\n');
  const task = (id, type) => ({ id, type, status: 'running', description: id });
  const watcher = task('bwatcher', 'shell');
  for (const own of [task('bsuite', 'shell'), task('bmonitor', 'monitor'), task('ahelper', 'subagent')]) {
    assert.deepEqual(stopHook({ agent_transcript_path: transcript, background_tasks: [watcher, own] }).out, '');
    assert.equal('done' in read(at('waves', 'w', 'agents', 'A1.json')), false, own.id);
  }
  assert.equal(stopHook({ agent_transcript_path: transcript, background_tasks: [watcher] }).code, 0);
  assert.equal(typeof read(at('waves', 'w', 'agents', 'A1.json')).done, 'string');
});

test('the SubagentStop hook exits 0 with nothing on stdout when its input or transcript is missing', async () => {
  for (const input of [{ agent_transcript_path: path.join(home, 'gone.jsonl') }, {}, 'not json']) {
    const r = stopHook(input);
    assert.deepEqual([r.code, r.out, /builder-stop-hook: /.test(r.err)], [0, '', true]);
  }
});

test("a builder's builder start takes up the record the owner's Build tap started: same kind and worktree, its own start time, and no longer dispatched", async () => {
  const tapped = { label: 'Codex builder', kind: 'codex', started: '2026-11-03T10:00:00.000Z', dispatched: 'tap', worktree: { path: '/w/A1', branch: 'A1', repo: '/r' } };
  write(at('waves', 'w', 'agents', 'A1.json'), tapped);
  write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One', lane: 'progress' }] });
  const r = await board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'build', '--label', 'Codex builder');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^A1: builder started\nkind: codex\. The owner's Build tap picked it\.\nmodel: Codex\nref: A1\nworktree: \/w\/A1\n/);
  const { started, ...record } = read(at('waves', 'w', 'agents', 'A1.json'));
  assert.deepEqual(record, { label: 'Codex builder', kind: 'codex', worktree: tapped.worktree });
  assert.ok(started > tapped.started);
  assert.equal((await board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'build')).code, 0);
  assert.equal(read(at('waves', 'w', 'agents', 'A1.json')).worktree, undefined);
});

// docs/adr/2026-11-05-0128-one-adapter-launches-claude-or-codex.md
test("a builder's start keeps the session id its launch recorded since the record last started or closed, and drops an older one", async () => {
  const file = at('waves', 'w', 'agents', 'A1.json');
  const session = { id: 'sess-1', at: '2026-11-03T10:00:01.000Z' };
  write(file, { label: 'Builder', kind: 'claude', model: 'opus', started: '2026-11-03T10:00:00.000Z', dispatched: 'hub', session, worktree: { path: '/w/A1', branch: 'A1', repo: '/r' } });
  write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One', lane: 'progress' }] });
  assert.equal((await board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'build')).code, 0);
  assert.deepEqual(read(file).session, session, 'the agent taking up its launch keeps its session');
  // A lander launched on a closed record: its session was written after the close.
  const lander = { id: 'sess-2', at: '2026-11-03T12:00:01.000Z' };
  write(file, { ...read(file), done: '2026-11-03T12:00:00.000Z', session: lander });
  assert.equal((await board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'build', '--label', 'Lander')).code, 0);
  assert.deepEqual(read(file).session, lander);
  // A start with no launch since the record started belongs to no session the record knows.
  assert.equal((await board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'build')).code, 0);
  assert.equal(read(file).session, undefined);
});

test("builder start --dispatch opens the record before the agent launches, for build, prototype and grill, and the agent's own start takes it up", async () => {
  write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'feat: one', lane: 'todo' }, { id: 'A2', title: 'feat: two', lane: 'todo' }] });
  const dispatched = await board('--site', 'orch', 'builder', 'start', 'w/A1', '--dispatch', '--kind', 'build', '--model', 'sonnet', '--label', 'Sonnet builder');
  assert.equal(dispatched.code, 0, dispatched.err);
  const open = read(at('waves', 'w', 'agents', 'A1.json'));
  assert.equal(open.dispatched, 'session');
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].lane, 'progress');
  const taken = await board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'build', '--label', 'Sonnet builder');
  assert.equal(taken.code, 0, taken.err);
  assert.match(taken.out, new RegExp(`kind: ${open.kind}\\. The session's dispatch picked it\\.`));
  const { started, ...record } = read(at('waves', 'w', 'agents', 'A1.json'));
  assert.deepEqual(record, { label: 'Sonnet builder', kind: open.kind, ...(open.model ? { model: open.model } : {}) });
  assert.ok(started >= open.started);
  for (const kind of ['prototype', 'grill']) {
    const r = await board('--site', 'orch', 'builder', 'start', 'w/A2', '--dispatch', '--kind', kind, '--model', 'opus', '--label', `${kind} agent`);
    assert.equal(r.code, 0, r.err);
    assert.equal(read(at('waves', 'w', 'agents', 'A2.json')).dispatched, 'session');
    assert.equal(read(at('waves', 'w', 'wave.json')).items[1].lane, 'todo');
    const own = await board('--site', 'orch', 'builder', 'start', 'w/A2', '--kind', kind, '--label', `${kind} agent`);
    assert.equal(own.code, 0, own.err);
    const after = read(at('waves', 'w', 'agents', 'A2.json'));
    assert.equal(after.dispatched, undefined);
    assert.equal(after.kind, kind);
  }
});

test('--dispatch on a record whose worktree the dispatch made keeps it through the agent\'s start, and a record already done is not taken up', async () => {
  write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One', lane: 'progress' }] });
  const wt = { path: '/w/A1', branch: 'A1', repo: '/r' };
  write(at('waves', 'w', 'agents', 'A1.json'), { label: 'Prototype', kind: 'claude', model: 'opus', started: '2026-11-03T10:00:00.000Z', dispatched: 'session', worktree: wt });
  assert.equal((await board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'prototype')).code, 0);
  assert.deepEqual(read(at('waves', 'w', 'agents', 'A1.json')).worktree, wt);
  write(at('waves', 'w', 'agents', 'A1.json'), { label: 'Old', kind: 'claude', started: '2026-11-03T10:00:00.000Z', dispatched: 'session', worktree: wt, done: '2026-11-03T11:00:00.000Z' });
  assert.equal((await board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'prototype')).code, 0);
  assert.equal(read(at('waves', 'w', 'agents', 'A1.json')).worktree, undefined);
});

test("--dispatch on a record the Build tap opened leaves it alone and says it's already open", async () => {
  const tapped = { label: 'Builder', kind: 'codex', started: '2026-11-03T10:00:00.000Z', dispatched: 'tap', worktree: { path: '/w/A1', branch: 'A1', repo: '/r' } };
  write(at('waves', 'w', 'agents', 'A1.json'), tapped);
  write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One', lane: 'progress' }] });
  const r = await board('--site', 'orch', 'builder', 'start', 'w/A1', '--dispatch', '--kind', 'build', '--worktree');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "A1: already open: the Implement tap opened its record; launch the agent, whose own builder start takes it up\n");
  assert.deepEqual(read(at('waves', 'w', 'agents', 'A1.json')), tapped);
});

test('builder start under another agent name refuses while the Build tap opened the main record and nobody took it up', async () => {
  write(at('waves', 'w', 'agents', 'A1.json'), { label: 'Builder', kind: 'codex', started: '2026-11-03T10:00:00.000Z', dispatched: 'tap' });
  write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One', lane: 'progress' }] });
  const r = await board('--site', 'orch', 'builder', 'start', 'w/A1', '--agent', 'bench', '--kind', 'bench');
  assert.equal(r.code, 1);
  assert.match(r.err, /the Implement tap opened w\/A1's main builder record and no agent has taken it up; run builder start w\/A1 without --agent first/);
  assert.equal(fs.existsSync(at('waves', 'w', 'agents', 'A1@bench.json')), false);
  assert.equal((await board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'build')).code, 0);
  assert.equal((await board('--site', 'orch', 'builder', 'start', 'w/A1', '--agent', 'bench', '--kind', 'bench')).code, 0);
});

test('builder progress refuses without an open builder record, as builder call does', async () => {
  write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One', lane: 'todo' }] });
  const none = await board('--site', 'orch', 'builder', 'progress', 'w/A1', '--phase', 'reading', 'the notes');
  assert.equal(none.code, 1);
  assert.match(none.err, /builder progress needs an open builder record on w\/A1; run builder start first/);
  assert.equal(fs.existsSync(at('waves', 'w', 'agents', 'A1.json')), false);
  write(at('waves', 'w', 'agents', 'A1.json'), { label: 'Builder', started: '2026-11-03T10:00:00.000Z', done: '2026-11-03T11:00:00.000Z' });
  assert.match((await board('--site', 'orch', 'builder', 'progress', 'w/A1', '--phase', 'reading', 'the notes')).err, /needs an open builder record/);
  assert.equal(read(at('waves', 'w', 'agents', 'A1.json')).done, '2026-11-03T11:00:00.000Z');
});

test('builder start refuses a Claude pause before making records or a worktree, and runs while going or Off', async () => {
  const until = new Date(Date.now() + 3600_000).toISOString();
  const usage = { at: new Date().toISOString(), five_hour: { used_percentage: 91, resets_at: until }, seven_day: { used_percentage: 96, resets_at: until } };
  write(at('kickflip', 'usage.json'), { claude: usage });
  const r = await board('--site', 'orch', 'builder', 'start', 'w/A1', '--worktree');
  assert.equal(r.code, 1);
  assert.match(r.err, new RegExp(`Work is paused: Claude's 5-hour usage is at 91%. Resumes at ${until}. The owner can tap Keep going on the Hub page.`));
  assert.equal(fs.existsSync(at('waves', 'w', 'agents')), false);
  write(at('kickflip', 'settings.json'), { keepGoing: { window: 'five_hour', until } });
  assert.equal((await board('--site', 'orch', 'builder', 'start', 'w/A1')).code, 0);
  write(at('kickflip', 'settings.json'), { pauseAt: 100 });
  assert.equal((await board('--site', 'orch', 'builder', 'start', 'w/A1', '--agent', 'two')).code, 0);
  write(at('kickflip', 'settings.json'), {});
  write(at('kickflip', 'usage.json'), { claude: { ...usage, five_hour: { ...usage.five_hour, used_percentage: 40 } } });
  assert.match((await board('--site', 'orch', 'builder', 'start', 'w/A1')).err, /Claude's weekly usage is at 96%/);
});

// docs/adr/2026-11-06-0106-a-busy-mac-holds-new-work.md
test('builder start refuses every kind while the host is busy, and starts once it eases', async () => {
  write(at('kickflip', 'machine-state.json'), { state: 'busy', reason: 'load high' });
  for (const kind of ['build', 'grill']) {
    const r = await board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', kind);
    assert.equal(r.code, 1);
    assert.match(r.err, /Work is held: the host is busy \(load high\)\. It starts again when the host eases\./);
  }
  assert.equal(fs.existsSync(at('waves', 'w', 'agents')), false);
  write(at('kickflip', 'machine-state.json'), { state: 'normal', reason: null });
  assert.equal((await board('--site', 'orch', 'builder', 'start', 'w/A1')).code, 0);
});

// docs/adr/2026-11-06-0106-a-busy-mac-holds-new-work.md
test('builder start on a record its dispatch already opened is not held, while a fresh start still is', async () => {
  assert.equal((await board('--site', 'orch', 'builder', 'start', 'w/A1', '--dispatch', '--kind', 'grill')).code, 0);
  write(at('kickflip', 'machine-state.json'), { state: 'busy', reason: 'load high' });
  const taken = await board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'grill');
  assert.equal(taken.code, 0, taken.err);
  assert.match((await board('--site', 'orch', 'builder', 'start', 'w/A1', '--agent', 'two', '--dispatch', '--kind', 'grill')).err, /the host is busy/);
});

// docs/adr/2026-11-03-1551-planners-and-implementers-are-two-kinds-of-agent.md
test('builder start saves a planner\'s model, Sonnet for a prototype and Opus for a grill by default, and its status lines are marked planner, read its kind\'s word and keep no builder phase', async () => {
  const record = (agent) => read(at('waves', 'w', 'agents', agent === 'main' ? 'A1.json' : `A1@${agent}.json`));
  for (const [kind, model] of [['prototype', 'sonnet'], ['grill', 'opus']]) {
    const r = await board('builder', 'start', 'w/A1', '--site', 'orch', '--agent', kind, '--kind', kind);
    assert.equal(r.code, 0, r.err);
    assert.equal(record(kind).model, model);
    assert.match(r.out, new RegExp(`^model: Claude ${model === 'opus' ? 'Opus' : 'Sonnet'}$`, 'm'));
  }
  assert.equal((await board('builder', 'start', 'w/A1', '--site', 'orch', '--agent', 'prototype', '--kind', 'prototype', '--model', 'opus')).code, 0);
  assert.equal(record('prototype').model, 'opus');
  // A dispatched planner's model stays through the agent's own start.
  assert.equal((await board('builder', 'start', 'w/A1', '--site', 'orch', '--dispatch', '--kind', 'grill', '--model', 'sonnet')).code, 0);
  assert.equal((await board('builder', 'start', 'w/A1', '--site', 'orch', '--kind', 'grill', '--phase', 'reading', '--progress', 'the notes')).code, 0);
  assert.equal(record('main').model, 'sonnet');
  assert.equal((await board('builder', 'progress', 'w/A1', '--site', 'orch', '--agent', 'prototype', '--phase', 'building', 'the takes')).code, 0);
  // A planner needs no --phase.
  const bare = await board('builder', 'progress', 'w/A1', '--site', 'orch', '--agent', 'prototype', 'take B');
  assert.equal(bare.code, 0, bare.err);
  assert.equal((await board('builder', 'start', 'w/A1', '--site', 'orch', '--agent', 'fix', '--kind', 'claude', '--phase', 'testing', '--progress', 'the fix')).code, 0);
  assert.equal((await board('builder', 'progress', 'w/A1', '--site', 'orch', '--agent', 'fix', 'no phase')).code, 1);
  assert.deepEqual(lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).map(({ text, planner, phase }) => [text, planner, phase]), [
    ['Grilling: the notes', true, undefined], ['Prototyping: the takes', true, undefined], ['Prototyping: take B', true, undefined], ['Claude Opus testing: the fix', undefined, 'testing'],
  ]);
});

test('builder done on a record with judgment calls hands the card back, its records marked handed back, with the Next its calls ask for', async () => {
  const item = () => read(at('waves', 'w', 'wave.json')).items[0];
  const record = () => read(at('waves', 'w', 'agents', 'A1.json'));
  assert.equal((await board('builder', 'start', 'w/A1', '--site', 'orch', '--label', 'Builder')).code, 0);
  assert.equal((await board('builder', 'call', 'w/A1', '--site', 'orch', 'Kept the old label')).code, 0);
  const refused = await board('builder', 'done', 'w/A1', '--site', 'orch', '--next', 'Land it');
  assert.deepEqual([refused.code, refused.err], [1, "builder done sets w/A1's Next itself while its record has judgment calls; run it without --next\n"]);
  const done = await board('builder', 'done', 'w/A1', '--site', 'orch');
  assert.equal(done.code, 0, done.err);
  assert.equal(done.out, "A1: builder done\nhanded back: Next \"Verify the builder's judgment calls\"\n");
  assert.deepEqual([typeof record().handed_back, item().next, Boolean(record().done)], ['string', "Verify the builder's judgment calls", true]);

  assert.equal((await board('builder', 'verified', 'w/A1', '--site', 'orch')).code, 0);
  assert.equal((await board('builder', 'start', 'w/A1', '--site', 'orch', '--label', 'Builder')).code, 0);
  assert.equal((await board('builder', 'call', 'w/A1', '--site', 'orch', 'Question: keep the old label?')).code, 0);
  assert.equal((await board('builder', 'call', 'w/A1', '--site', 'orch', 'Kept the old colour')).code, 0);
  assert.equal((await board('builder', 'done', 'w/A1', '--site', 'orch')).code, 0);
  assert.deepEqual([typeof record().handed_back, item().next], ['string', "Answer the builder's questions"]);
});

// docs/adr/2026-11-06-0425-the-implementer-limit-counts-agents-and-a-card-spawns-helpers.md
test('agent launch asks for a helper on an open card, which then starts, reports and hands back as its own agent; agent wait prints its hand-back and agent merge brings in its branch', async (t) => {
  const repo = scratchRepo();
  write(at('kickflip', 'manifest.json'), { sites: { orch: { dir: site('orch'), port: 1, cmd: [process.execPath, '/skill/board/server.mjs', site('orch')], owner: { repo } } } });
  const main = await onOrch('builder', 'start', 'w/A1', '--kind', 'build');
  assert.equal(main.code, 0, main.err);
  const helperFile = at('waves', 'w', 'agents', 'A1@tests.json');

  for (const [args, err] of [
    [['--name', 'main', '--task', 'x'], /--name takes a short lowercase name/],
    [['--name', 'visual-e1', '--task', 'x'], /--name takes a short lowercase name/],
    [['--name', 'Tests', '--task', 'x'], /--name takes a short lowercase name/],
    [['--name', 'tests'], /--task must be non-empty text/],
    [['--name', 'tests', '--task', 'x', '--model', 'haiku'], /--model takes opus or sonnet/],
  ]) {
    const r = await onOrch('agent', 'launch', 'w/A1', ...args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err, err);
  }
  const asked = await onOrch('agent', 'launch', 'w/A1', '--name', 'tests', '--task', 'Write the scroll tests', '--writes', '--model', 'sonnet');
  assert.equal(asked.code, 0, asked.err);
  assert.match(asked.out, /helper tests requested: the board launches it now/);
  const record = read(helperFile);
  assert.deepEqual([record.label, record.kind, record.task, record.writes, record.model, 'started' in record, typeof record.requested], ['tests', 'helper', 'Write the scroll tests', true, 'sonnet', false, 'string']);
  assert.equal(threadOf().at(-1).text, 'Asked for helper tests, which writes code');
  assert.match((await onOrch('agent', 'launch', 'w/A1', '--name', 'tests', '--task', 'Again')).err, /already has an agent named tests/);
  assert.match((await onOrch('agent', 'launch', 'w/ENG-1', '--name', 'tests', '--task', 'x', '--writes')).err, /branches from w\/ENG-1's worktree, and the card has none/);
  assert.equal((await onOrch('agent', 'launch', 'w/ENG-1', '--name', 'survey', '--task', 'Read the scroll code')).code, 0, 'a read-only helper needs no worktree');
  onHome(t);
  const { now, checked } = pollClock(t);
  const wait = store.waitHelper(site('orch'), 'w/ENG-1', { name: 'survey', now });
  await checked();
  t.mock.timers.tick(9 * 60_000);
  await assert.rejects(wait, { message: 'helper survey is still waiting to launch after 9 minutes; run agent wait again' });
  t.mock.timers.reset();

  // The board server opens the record in the helper's own worktree off the card's branch (store.mjs startHelper);
  // here the test stands in for it.
  const tree = at('kickflip', 'worktrees', 'A1-tests');
  git(worktree(), 'worktree', 'add', '--quiet', '-b', 'A1-tests', tree, 'A1');
  write(helperFile, { ...record, started: new Date().toISOString(), dispatched: 'hub', worktree: { path: tree, branch: 'A1-tests', repo } });
  const start = await onOrch('builder', 'start', 'w/A1', '--kind', 'helper', '--agent', 'tests');
  assert.equal(start.code, 0, start.err);
  const taken = read(helperFile);
  assert.deepEqual([taken.label, taken.task, taken.writes, taken.model, taken.worktree.path, 'dispatched' in taken], ['tests', 'Write the scroll tests', true, 'sonnet', tree, false]);
  assert.equal((await onOrch('builder', 'progress', 'w/A1', '--agent', 'tests', '--phase', 'building', 'the first test')).code, 0);
  assert.equal(threadOf().filter((m) => m.kind === 'status').at(-1).text, 'Tests building: the first test', 'its lines carry its name');
  commit(tree, 'scroll.test.mjs', 'test', 'feat: scroll tests\n\nRefs: #1');
  assert.equal((await onOrch('builder', 'done', 'w/A1', '--agent', 'tests')).code, 2, 'a helper hands back with --text');
  assert.equal((await onOrch('builder', 'done', 'w/A1', '--agent', 'tests', '--text', 'Added the scroll tests')).code, 0);
  assert.equal(typeof read(helperFile).done, 'string');
  assert.equal(read(at('waves', 'w', 'agents', 'A1.json')).done, undefined, "the card's build runs on");

  const done = await onOrch('agent', 'wait', 'w/A1', '--name', 'tests');
  assert.equal(done.code, 0, done.err);
  assert.equal(done.out, `helper tests done: Added the scroll tests\nbranch A1-tests in ${tree}: merge it with agent merge w/A1 --name tests\n`);
  assert.equal('waits' in read(at('waves', 'w', 'agents', 'A1.json')), false, 'the wait clears its mark');
  commit(worktree(), 'card.txt', 'card', 'feat: the card\n\nRefs: A1');
  const merged = await onOrch('agent', 'merge', 'w/A1', '--name', 'tests');
  assert.equal(merged.code, 0, merged.err);
  assert.equal(merged.out, `merged A1-tests into A1\nworktree removed: ${tree}\nbranch deleted: A1-tests\n`);
  // docs/adr/2026-11-11-1700-commits-are-conventional-and-name-their-card-in-a-refs-trailer.md
  assert.equal(git(worktree(), 'log', '-1', '--format=%B'), 'chore: merge the A1-tests helper branch\n\nRefs: A1');
  assert.equal(fs.readFileSync(path.join(worktree(), 'scroll.test.mjs'), 'utf8'), 'test');
  assert.deepEqual(branches(repo), ['A1', 'main']);
});

test("agent wait marks its spawner waiting while the helper is open, and refuses once the helper's process is gone without its done", async (t) => {
  onHome(t);
  assert.equal((await onOrch('builder', 'start', 'w/A1', '--kind', 'claude')).code, 0);
  assert.equal((await onOrch('agent', 'launch', 'w/A1', '--name', 'look', '--task', 'Read the code')).code, 0);
  const helperFile = at('waves', 'w', 'agents', 'A1@look.json');
  // The helper's own builder start, after its launch recorded the session, keeps that session.
  const launched = new Date(Date.now() - 2000).toISOString();
  write(helperFile, { ...read(helperFile), started: new Date().toISOString(), session: { id: 's', pid: 4242, at: launched } });
  let running = true;
  const { now, checked } = pollClock(t);
  const waiting = store.waitHelper(site('orch'), 'w/A1', { name: 'look', now, alive: (pid) => pid === 4242 && running });
  await checked();
  assert.equal(record().waits, 'look', 'the spawner reads waiting on its helper');
  running = false;
  t.mock.timers.tick(2000);
  await assert.rejects(waiting, { message: "helper look's process exited without builder done; do its task yourself" });
  assert.equal('waits' in record(), false);
});

// docs/adr/2026-11-12-1300-builder-done-posts-no-line-to-the-thread.md
test("builder done on a planner run takes no --text and posts no thread line; a helper's hand-back stays on its record only", async () => {
  assert.equal((await board('builder', 'start', 'w/A1', '--site', 'orch', '--kind', 'grill')).code, 0);
  const thread = () => lines(site('orch', 'data', 'threads', 'w__A1.jsonl'));
  assert.equal((await board('builder', 'progress', 'w/A1', '--site', 'orch', '--phase', 'reading', 'Reading the card')).code, 0);
  assert.match((await board('builder', 'done', 'w/A1', '--site', 'orch', '--text', 'Asked which badge stays')).err, /takes no --text/);
  const before = thread().length;
  const done = await board('builder', 'done', 'w/A1', '--site', 'orch');
  assert.equal(done.code, 0, done.err);
  assert.equal(typeof read(at('waves', 'w', 'agents', 'A1.json')).done, 'string');
  assert.equal(thread().filter((l) => l.kind === 'status').length, thread().slice(0, before).filter((l) => l.kind === 'status').length);
  assert.equal(thread().some((l) => /Asked which badge stays/.test(l.text || '')), false);
  assert.equal((await board('builder', 'start', 'w/A1', '--site', 'orch', '--label', 'Builder')).code, 0);
  assert.match((await board('builder', 'done', 'w/A1', '--site', 'orch', '--next', 'Review', '--text', 'x')).err, /--text goes on/);
});

// docs/adr/2026-11-11-1300-a-planner-that-ends-without-its-question-waits-on-the-orchestrator.md
test("a grill or prototype planner's builder done leaves a fault line when the card is still in its phase with no question open, staged or screening, and prints it", async () => {
  const thread = () => (fs.existsSync(site('orch', 'data', 'threads', 'w__A1.jsonl')) ? lines(site('orch', 'data', 'threads', 'w__A1.jsonl')) : []);
  for (const [kind, phase] of [['grill', 'grilling'], ['prototype', 'prototyping']]) {
    write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One', lane: 'todo', phase }] });
    fs.rmSync(site('orch', 'data', 'threads', 'w__A1.jsonl'), { force: true });
    assert.equal((await board('builder', 'start', 'w/A1', '--site', 'orch', '--kind', kind)).code, 0);
    const done = await board('builder', 'done', 'w/A1', '--site', 'orch');
    assert.equal(done.code, 0, done.err);
    assert.match(done.out, new RegExp(`Its ${kind} planner ended without posting a question, so it waits on the orchestrator\\.`));
    const fault = lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).find((l) => l.line === 'planner-unasked');
    assert.equal(fault.detail, kind);
    // A card already past the phase, or with a question staged for it, gets no fault.
    fs.rmSync(site('orch', 'data', 'threads', 'w__A1.jsonl'), { force: true });
    write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One', lane: 'todo', phase: 'ready' }] });
    assert.equal((await board('builder', 'start', 'w/A1', '--site', 'orch', '--kind', kind)).code, 0);
    assert.equal((await board('builder', 'done', 'w/A1', '--site', 'orch')).code, 0);
    assert.equal(thread().some((l) => l.line === 'planner-unasked'), false);
    write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One', lane: 'todo', phase }] });
    if (kind !== 'grill') continue; // a prototype planner's questions publish at once, so only a grill's stay staged
    write(site('orch', 'data', 'staged-questions.json'), { 'w/A1': [{ id: 'q1' }] });
    assert.equal((await board('builder', 'start', 'w/A1', '--site', 'orch', '--kind', kind)).code, 0);
    assert.equal((await board('builder', 'done', 'w/A1', '--site', 'orch')).code, 0);
    assert.equal(thread().some((l) => l.line === 'planner-unasked'), false);
    fs.rmSync(site('orch', 'data', 'staged-questions.json'), { force: true });
  }
});

// docs/adr/2026-11-07-2100-a-cards-past-runs-keep-their-records-so-they-fold.md
test("a builder start over a finished record keeps that run as a past record with its label, kind, times and log, and none of its calls, worktree or hand-back; an unfinished record and another agent's are not kept", async () => {
  write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One', lane: 'progress' }] });
  const main = at('waves', 'w', 'agents', 'A1.json');
  const pasts = () => fs.readdirSync(at('waves', 'w', 'agents')).filter((n) => n.startsWith('A1@past-'));
  assert.equal((await board('builder', 'start', 'w/A1', '--label', 'Builder', '--kind', 'claude')).code, 0);
  assert.equal((await board('builder', 'start', 'w/A1', '--label', 'Again', '--kind', 'claude')).code, 0);
  assert.deepEqual(pasts(), []);
  assert.equal((await board('builder', 'call', 'w/A1', 'Kept the name')).code, 0);
  write(main, { ...read(main), worktree: { path: '/wt/A1', branch: 'A1', repo: '/repo' }, session: { id: 's', pid: 1, log: 'builder-A1.log', at: '2026-11-07T10:00:00Z' } });
  const first = read(main);
  assert.equal((await board('builder', 'done', 'w/A1', '--site', 'orch')).code, 0);
  const done = read(main).done;
  assert.equal((await board('builder', 'start', 'w/A1', '--label', 'Lander', '--kind', 'claude')).code, 0);
  const [past] = pasts();
  assert.equal(pasts().length, 1);
  assert.deepEqual(read(at('waves', 'w', 'agents', past)), { label: 'Again', kind: 'claude', model: first.model, started: first.started, done, session: { log: 'builder-A1.log' } });
  assert.equal(read(main).label, 'Lander');
  assert.equal((await board('builder', 'start', 'w/A1', '--agent', 'bench', '--kind', 'bench')).code, 0);
  assert.equal((await board('builder', 'done', 'w/A1', '--agent', 'bench')).code, 0);
  assert.equal((await board('builder', 'start', 'w/A1', '--agent', 'bench', '--kind', 'bench')).code, 0);
  assert.equal(pasts().length, 1);
});

// docs/adr/2026-11-07-2100-a-cards-past-runs-keep-their-records-so-they-fold.md
test("a past run's record is no agent of the card: builder list and a later done see only the live record", async () => {
  write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One', lane: 'progress' }] });
  assert.equal((await board('builder', 'start', 'w/A1', '--label', 'Builder', '--kind', 'claude')).code, 0);
  assert.equal((await board('builder', 'call', 'w/A1', 'A call')).code, 0);
  assert.equal((await board('builder', 'done', 'w/A1', '--site', 'orch')).code, 0);
  assert.equal((await board('builder', 'start', 'w/A1', '--label', 'Lander', '--kind', 'claude')).code, 0);
  assert.equal(fs.readdirSync(at('waves', 'w', 'agents')).filter((n) => n.startsWith('A1@past-')).length, 1);
  const out = await board('builder', 'list', 'w/A1', '--site', 'orch');
  assert.doesNotMatch(out.out + out.err, /past-/);
});
