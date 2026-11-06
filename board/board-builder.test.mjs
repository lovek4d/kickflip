import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePorts, until } from '../shared/test-helpers.mjs';
import { home, at, site, write, read, lines, run, board, wave, question, git, commit, scratchRepo, worktree, land, branches, record, toolUse, toolResult, stopHook, ago } from './board-fixture.mjs';

test('agent.mjs still writes builder records, beside the wave file it names', () => {
  assert.equal(run('agent.mjs', ['start', 'w/A1', '--label', 'Opus builder']).code, 0);
  assert.equal(read(at('waves', 'w', 'agents', 'A1.json')).label, 'Opus builder');
  assert.equal(run('agent.mjs', ['done', 'w/A1']).code, 0);
  assert.equal(Number.isNaN(Date.parse(read(at('waves', 'w', 'agents', 'A1.json')).done)), false);

  assert.equal(run('agent.mjs', ['start', 'audit/A1', '--dir', site('audit', 'data')]).code, 0);
  assert.equal(typeof read(site('audit', 'data', 'agents', 'A1.json')).started, 'string');
  assert.equal(board('builder', 'done', 'audit/A1', '--site', 'audit').code, 0);
  assert.equal(typeof read(site('audit', 'data', 'agents', 'A1.json')).done, 'string');
  assert.equal(run('agent.mjs', ['start', 'audit/A1', '--dir', site('audit', 'data')]).code, 0);
  assert.equal('done' in read(site('audit', 'data', 'agents', 'A1.json')), false);
  assert.equal(run('agent.mjs', ['start', 'w/Z9']).code, 1);
});

test('builder keeps one record per agent on an item, with its kind and an ETA it can change or clear', () => {
  assert.equal(board('item', 'set', 'w/A1', '--status', 'building').code, 0);
  assert.equal(board('builder', 'start', 'w/A1', '--label', 'Opus builder', '--kind', 'claude').code, 0);
  assert.equal(board('builder', 'start', 'w/A1', '--agent', 'bench', '--kind', 'bench', '--eta', '2026-10-23T16:30:00-07:00').code, 0);
  assert.deepEqual([read(at('waves', 'w', 'agents', 'A1.json')).kind, read(at('waves', 'w', 'agents', 'A1@bench.json')).eta], ['claude', '2026-10-23T23:30:00.000Z']);
  assert.equal(board('builder', 'progress', 'w/A1', 'Still', 'running', '--phase', 'testing', '--site', 'orch', '--agent', 'bench', '--eta', '2026-10-24T01:00:00Z').code, 0);
  assert.equal(read(at('waves', 'w', 'agents', 'A1@bench.json')).eta, '2026-10-24T01:00:00.000Z');
  assert.equal(board('builder', 'progress', 'w/A1', 'Done soon', '--phase', 'testing', '--site', 'orch', '--agent', 'bench', '--clear-eta').code, 0);
  assert.equal('eta' in read(at('waves', 'w', 'agents', 'A1@bench.json')), false);
  assert.match(board('builder', 'progress', 'w/A1', 'x', '--phase', 'testing', '--site', 'orch', '--eta', 'soon').err, /--eta takes an ISO time/);
  assert.equal(board('builder', 'progress', 'w/A1', 'Benchmarking', '--phase', 'testing', '--site', 'orch', '--agent', 'bench', '--eta', '2026-10-24T01:00:00Z').code, 0);
  assert.equal(board('builder', 'done', 'w/A1', '--agent', 'bench').code, 0);
  const bench = read(at('waves', 'w', 'agents', 'A1@bench.json'));
  assert.deepEqual([typeof bench.done, 'eta' in bench, 'done' in read(at('waves', 'w', 'agents', 'A1.json'))], ['string', false, false]);
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].status, 'building');
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--next', 'Review').code, 0);
  assert.equal('done' in read(at('waves', 'w', 'agents', 'A1.json')), false);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--pr', '7').code, 0);
  assert.deepEqual([typeof read(at('waves', 'w', 'agents', 'A1.json')).done, read(at('waves', 'w', 'agents', 'A1@bench.json')).done], ['string', bench.done]);
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].status, undefined);
  for (const [key, flags, file] of [
    ['w/A1', [], at('waves', 'w', 'wave.json')],
    ['audit/A1', ['--site', 'audit'], site('audit', 'data', 'wave.json')],
    ['audit/A1', ['--dir', site('audit', 'data')], site('audit', 'data', 'wave.json')],
  ]) {
    const route = key.startsWith('audit/') ? ['--site', 'audit'] : [];
    for (const status of ['building', 'fixing', 'checking', 'held', 'done']) {
      assert.equal(board('item', 'set', key, ...route, '--status', status, ...(status === 'done' && route.length ? ['--text', 'Done.'] : [])).code, 0);
      const before = read(file).items[0];
      assert.equal(board('builder', 'start', key, ...flags).code, 0);
      assert.equal(board('builder', 'start', key, ...flags, '--agent', 'install', '--kind', 'install').code, 0);
      assert.equal(board('builder', 'done', key, ...flags).code, 0);
      assert.deepEqual(read(file).items[0], before);
      assert.equal(board('builder', 'done', key, ...flags, '--agent', 'install').code, 0);
      const after = read(file).items[0];
      assert.equal(after.status, ['building', 'fixing'].includes(status) ? undefined : status);
      if (!['building', 'fixing'].includes(status)) assert.deepEqual(after, before);
      assert.equal(board('builder', 'done', key, ...flags, '--agent', 'install').code, 0);
      assert.deepEqual(read(file).items[0], after);
    }
  }
});

test('a hand-back closes ordinary builders while an install survives until explicitly stopped or the card finishes', () => {
  const install = at('waves', 'w', 'agents', 'A1@install.json');
  assert.equal(board('builder', 'start', 'w/A1', '--agent', 'install', '--kind', 'install', '--eta', '2026-10-30T18:00:00Z').code, 0);
  const running = read(install);
  assert.equal(board('builder', 'start', 'w/A1').code, 0);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--pr', '7', '--clear-status').code, 0);
  assert.equal(typeof read(at('waves', 'w', 'agents', 'A1.json')).done, 'string');
  assert.deepEqual(read(install), running);
  assert.equal(board('builder', 'start', 'w/A1', '--agent', 'fix').code, 0);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--status', 'checking').code, 0);
  assert.equal(typeof read(at('waves', 'w', 'agents', 'A1@fix.json')).done, 'string');
  assert.deepEqual(read(install), running);
  assert.equal(board('builder', 'done', 'w/A1', '--agent', 'install').code, 0);
  assert.equal(typeof read(install).done, 'string');
  assert.equal('eta' in read(install), false);
  for (const status of ['done', 'merged', 'dropped']) {
    assert.equal(board('builder', 'start', 'w/A1', '--agent', 'install', '--kind', 'install').code, 0);
    assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--status', status, '--text', 'Closed.').code, 0);
    assert.equal(typeof read(install).done, 'string', status);
  }
});

test('builder start --model records the Claude model and prints it', () => {
  assert.equal(board('item', 'set', 'w/A1', '--status', 'building').code, 0);
  const r = board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'claude', '--model', 'sonnet', '--label', 'Sonnet builder');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^model: Claude Sonnet$/m);
  assert.deepEqual(['kind', 'model'].map((f) => read(at('waves', 'w', 'agents', 'A1.json'))[f]), ['claude', 'sonnet']);
  assert.equal(board('--site', 'orch', 'builder', 'start', 'w/A1', '--agent', 'x', '--kind', 'codex', '--model', 'opus').code, 1);
});

// docs/adr/2026-11-03-0514-a-builder-records-its-judgment-calls-and-the-session-verifies-them.md
test('builder call appends a one-line call to the open record, calls prints them, verified marks them checked, and a restart keeps the unverified ones', () => {
  const main = at('waves', 'w', 'agents', 'A1.json');
  const noRecord = board('builder', 'call', 'w/A1', 'Kept the old name');
  assert.deepEqual([noRecord.code, noRecord.err], [1, 'builder call needs an open builder record on w/A1; run builder start first\n']);
  assert.equal(board('builder', 'start', 'w/A1').code, 0);
  assert.deepEqual(board('builder', 'calls', 'w/A1'), { code: 0, err: '', out: 'no judgment calls recorded\n' });
  assert.match(board('builder', 'verified', 'w/A1').err, /no unverified judgment calls/);
  const said = board('--site', 'orch', 'builder', 'call', 'w/A1', 'Question: does the land check cover every agent?');
  assert.deepEqual([said.code, said.out], [0, 'judgment call recorded on A1\n']);
  assert.equal(board('builder', 'call', 'w/A1', 'Kept', 'the old name').code, 0);
  assert.match(board('builder', 'call', 'w/A1', 'two\nlines').err, /one line/);
  assert.deepEqual(read(main).calls.map((c) => c.text), ['Question: does the land check cover every agent?', 'Kept the old name']);
  assert.deepEqual(board('builder', 'calls', 'w/A1').out.trim().split('\n'), ['1. Question: does the land check cover every agent?', '2. Kept the old name', 'not verified yet']);

  // A hand-back closes the record; a restart of the same agent is that build resumed, its calls and worktree kept.
  write(main, { ...read(main), worktree: { path: '/wt/A1', branch: 'A1', repo: '/repo' } });
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--status', 'checking').code, 0);
  assert.match(board('builder', 'call', 'w/A1', 'Late').err, /needs an open builder record/);
  assert.equal(board('builder', 'start', 'w/A1').code, 0);
  assert.deepEqual([read(main).calls.length, read(main).worktree.path], [2, '/wt/A1']);
  assert.equal(board('builder', 'call', 'w/A1', 'Dropped the cap').code, 0);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--status', 'checking').code, 0);
  // A dispatch on that record, and the agent's own start taking the dispatch up, keep the calls too.
  assert.equal(board('--site', 'orch', 'builder', 'start', 'w/A1', '--dispatch', '--kind', 'claude').code, 0);
  assert.equal(board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'build').code, 0);
  assert.deepEqual([read(main).calls.length, 'dispatched' in read(main)], [3, false]);
  assert.equal(board('item', 'set', 'w/A1', '--site', 'orch', '--status', 'checking').code, 0);

  const verified = board('--site', 'orch', 'builder', 'verified', 'w/A1', '--note', 'All match the notes.');
  assert.deepEqual([verified.code, verified.out], [0, 'A1: judgment calls verified\n']);
  assert.equal(read(main).verified.note, 'All match the notes.');
  assert.match(board('builder', 'calls', 'w/A1').out, /^3\. Dropped the cap\nverified \S+: All match the notes\.$/m);
  assert.match(board('builder', 'verified', 'w/A1').err, /no unverified judgment calls/);

  // Once verified, a restart is a new build: its record starts with no calls.
  assert.equal(board('builder', 'start', 'w/A1').code, 0);
  assert.deepEqual(['calls' in read(main), 'verified' in read(main), 'worktree' in read(main)], [false, false, false]);
});

test('builder ask posts to the thread as the builder and wakes the orchestrator, which answers or defers to the owner', () => {
  const main = at('waves', 'w', 'agents', 'A1.json');
  const orch = (...args) => board('--site', 'orch', ...args);
  assert.match(orch('builder', 'ask', 'w/A1', 'Stay orange?').err, /needs an open builder record on w\/A1/);
  assert.equal(orch('builder', 'start', 'w/A1', '--kind', 'claude', '--model', 'opus').code, 0);
  assert.match(board('builder', 'ask', 'w/A1', 'Stay orange?').err, /needs --site/);
  const asked = orch('builder', 'ask', 'w/A1', 'Should Implement stay', 'orange?');
  assert.deepEqual([asked.code, asked.out], [0, 'A1: asked the orchestrator, ask1\n']);
  assert.match(orch('builder', 'ask', 'w/A1', 'two\nlines').err, /one line/);
  const [line] = lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).filter((m) => m.kind === 'builder-ask');
  assert.deepEqual([line.who, line.text, line.ask], ['Claude Opus builder', 'Should Implement stay orange?', 'ask1']);
  const event = lines(site('orch', 'data', 'events.jsonl')).at(-1);
  assert.deepEqual([event.kind, event.data], ['builder-ask', { key: 'w/A1', ask: 'ask1', agent: 'main', text: 'Should Implement stay orange?' }]);
  assert.deepEqual(orch('builder', 'asks', 'w/A1').out, 'ask1. Should Implement stay orange?\n  waiting on the orchestrator\n');

  const answered = orch('builder', 'answer', 'w/A1', 'ask1', '--text', 'Go quiet.');
  assert.deepEqual([answered.code, answered.out], [0, 'A1: ask1 answered\n']);
  assert.match(orch('builder', 'answer', 'w/A1', 'ask1', '--text', 'Again').err, /ask1 on w\/A1 is already answered/);
  assert.match(orch('builder', 'answer', 'w/A1', 'ask9', '--text', 'No').err, /no ask "ask9" on w\/A1; builder asks w\/A1 lists them/);
  const reply = lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).at(-1);
  assert.deepEqual([reply.who, reply.kind, reply.ask, reply.text], ['claude', 'builder-answer', 'ask1', 'Go quiet.']);
  assert.equal(orch('builder', 'ask', 'w/A1', 'Fold Done on a new device?').code, 0);
  const deferred = orch('builder', 'defer', 'w/A1', 'ask2', '--text', 'Not sure. Carry on with folded; I put it to the owner after review.');
  assert.deepEqual([deferred.code, deferred.out], [0, 'A1: ask2 deferred to the owner\n']);
  assert.deepEqual(orch('builder', 'asks', 'w/A1').out.trim().split('\n'), ['ask1. Should Implement stay orange?', '  answered: Go quiet.',
    'ask2. Fold Done on a new device?', '  deferred: Not sure. Carry on with folded; I put it to the owner after review.']);
  // A deferred ask is a question for the owner: the build hands back for it, and the review puts it to the owner.
  assert.deepEqual(read(main).calls.map((c) => c.text), ['Question: Fold Done on a new device? (deferred to the owner)']);
  assert.match(orch('builder', 'done', 'w/A1').out, /handed back: checking, Next "Answer the builder's questions"/);
  assert.match(orch('builder', 'verified', 'w/A1').err, /^ask2 on w\/A1 was deferred to the owner; add its question with "ask": "ask2" first\n$/);
  const q = (extra) => ({ id: 'gh-fold', topic: 'item:w/A1', question: 'Fold Done on a new device?', options: [{ id: 'yes', label: 'Folded', recommended: true }, { id: 'no', label: 'Open' }], ...extra });
  write(path.join(home, 'q.json'), q({ ask: 'ask1' }));
  assert.match(orch('question', 'add', '--file', path.join(home, 'q.json')).err, /question gh-fold\.ask names ask1, which the orchestrator answered; only a deferred ask goes to the owner/);
  write(path.join(home, 'q.json'), q({ ask: 'ask2' }));
  assert.equal(orch('question', 'add', '--file', path.join(home, 'q.json')).code, 0);
  assert.equal(orch('builder', 'verified', 'w/A1').code, 0);
});

test('builder pick names the kind that builds now, builder start refuses the other, and --kind build takes the pick', () => {
  const noCodex = (...args) => run('board.mjs', args, undefined, { PATH: path.join(home, 'bin') });
  assert.deepEqual(noCodex('builder', 'pick', 'w/A1', '--site', 'orch'), { code: 0, err: '', out: "claude opus: Codex isn't installed on the host. Claude model is Auto and the card isn't small.\n" });
  assert.equal(noCodex('builder', 'pick', 'w/Z9', '--site', 'orch').code, 1);
  const refused = noCodex('builder', 'start', 'w/A1', '--site', 'orch', '--kind', 'codex');
  assert.deepEqual([refused.code, refused.err], [1, "--kind codex: claude builds now. Codex isn't installed on the host. Claude model is Auto and the card isn't small. Pass --kind claude, or --kind build.\n"]);
  assert.equal(fs.existsSync(at('waves', 'w', 'agents', 'A1.json')), false);
  const picked = noCodex('builder', 'start', 'w/A1', '--site', 'orch', '--kind', 'build');
  assert.equal(picked.code, 0, picked.err);
  assert.match(picked.out, /^kind: claude\. Codex isn't installed on the host\. Claude model is Auto and the card isn't small\.\nmodel: Claude Opus$/m);
  assert.match(picked.out, /^ref: A1$/m);
  assert.equal(read(at('waves', 'w', 'agents', 'A1.json')).kind, 'claude');
  assert.equal(read(at('waves', 'w', 'agents', 'A1.json')).model, 'opus');
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].status, 'building');
  write(at('waves', 'w', 'wave.json'), { ...read(at('waves', 'w', 'wave.json')), items: [...read(at('waves', 'w', 'wave.json')).items, { id: 'A2', title: 'Two', deps: ['A1'] }] });
  const blocked = noCodex('builder', 'start', 'w/A2', '--site', 'orch', '--kind', 'claude');
  assert.equal(blocked.code, 1);
  assert.match(blocked.err, /A1/);
  assert.equal(fs.existsSync(at('waves', 'w', 'agents', 'A2.json')), false);
});

// docs/adr/2026-11-05-0913-the-hub-and-each-board-keep-an-audit-log-of-the-calls-their-code-makes.md
test("a build start records builder pick's choice, reason and inputs in the board's audit log, which board.mjs audit prints", () => {
  const noCodex = (...args) => run('board.mjs', args, undefined, { PATH: path.join(home, 'bin') });
  assert.equal(board('--site', 'orch', 'audit').out, 'No calls in the last 30 days.\n');
  assert.equal(noCodex('builder', 'pick', 'w/A1', '--site', 'orch').code, 0);
  assert.equal(fs.existsSync(site('orch', 'data', 'audit.jsonl')), false, 'a pick that starts nothing records nothing');
  const started = noCodex('builder', 'start', 'w/A1', '--site', 'orch', '--kind', 'build');
  assert.equal(started.code, 0, started.err);
  const [entry, ...more] = fs.readFileSync(site('orch', 'data', 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const reason = "Codex isn't installed on the host. Claude model is Auto and the card isn't small.";
  assert.deepEqual([{ ...entry, at: typeof entry.at }, more], [{ at: 'string', call: 'builder-pick', key: 'w/A1', result: 'claude opus', reason, inputs: { codex: 'not installed', claudeModel: 'auto', size: null, cardModel: null } }, []]);
  const printed = board('--site', 'orch', 'audit');
  assert.equal(printed.code, 0, printed.err);
  assert.equal(printed.out, `${entry.at} builder-pick w/A1: claude opus. ${reason}\n  inputs: {"codex":"not installed","claudeModel":"auto","size":null,"cardModel":null}\n`);
  assert.equal(board('--site', 'orch', 'audit', 'w/A1').out, printed.out);
  assert.equal(board('--site', 'orch', 'audit', 'w/B7').out, 'No calls in the last 30 days.\n');
  assert.equal(board('audit').code, 1, 'audit reads a board, so it needs --site');
});

// docs/adr/2026-11-03-1526-usage-picks-opus-auto-or-sonnet-for-claude-builders.md
test("a card's --size and --model feed builder pick's Claude model, and builder start refuses a --model the hub's Claude model rules out", () => {
  const noCodex = (...args) => run('board.mjs', args, undefined, { PATH: path.join(home, 'bin') });
  const card = () => read(at('waves', 'w', 'wave.json')).items[0];
  const pick = () => noCodex('builder', 'pick', 'w/A1', '--site', 'orch').out;
  assert.deepEqual([board('item', 'set', 'w/A1', '--size', 'small').code, card().size], [0, 'small']);
  assert.equal(pick(), "claude sonnet: Codex isn't installed on the host. Claude model is Auto and the card is small.\n");
  assert.deepEqual([board('item', 'set', 'w/A1', '--model', 'opus').code, card().model], [0, 'opus']);
  assert.equal(pick(), "claude opus: Codex isn't installed on the host. Claude model is Auto and the card asks for Claude Opus.\n");
  assert.equal(board('item', 'set', 'w/A1', '--model', '', '--size', '').code, 0);
  assert.deepEqual(['size' in card(), 'model' in card()], [false, false]);
  assert.match(board('item', 'set', 'w/A1', '--size', 'tiny').err, /^--size takes small or large/);
  assert.match(board('item', 'set', 'w/A1', '--model', 'haiku').err, /^--model takes opus or sonnet/);
  const added = board('item', 'add', 'w/A9', '--title', 'Nine', '--size', 'small', '--model', 'sonnet');
  assert.equal(added.code, 0, added.err);
  assert.deepEqual([read(at('waves', 'w', 'wave.json')).items.at(-1).size, read(at('waves', 'w', 'wave.json')).items.at(-1).model], ['small', 'sonnet']);
  assert.equal('state' in read(at('waves', 'w', 'wave.json')).items.at(-1), false, 'a card added without --state gets its grill from the board');
  // docs/adr/2026-11-07-0700-staging-then-ready.md: item add never files a card ready; it reaches ready through staging.
  const count = () => read(at('waves', 'w', 'wave.json')).items.length;
  const before = count();
  assert.match(board('item', 'add', 'w/Q1', '--title', 'Quick', '--state', 'planned').err, /--state takes ready, grilling or prototyping/);
  write(at('waves', 'w', 'q1.md'), '# Quick\n');
  assert.match(board('item', 'add', 'w/Q1', '--title', 'Quick', '--state', 'ready', '--size', 'small', '--notes-file', 'q1.md').err, /item add files a card grilling or prototyping/);
  assert.equal(count(), before, 'a refused add writes no card');

  write(at('kickflip', 'settings.json'), { claudeModel: 'sonnet' });
  assert.equal(pick(), "claude sonnet: Codex isn't installed on the host. Claude model is Sonnet.\n");
  const refused = noCodex('builder', 'start', 'w/A1', '--site', 'orch', '--kind', 'claude', '--model', 'opus');
  assert.deepEqual([refused.code, refused.err], [1, "--model opus: the hub's Claude model is Sonnet. Pass --model sonnet, or no --model.\n"]);
  assert.equal(fs.existsSync(at('waves', 'w', 'agents', 'A1.json')), false);
  assert.equal(noCodex('builder', 'start', 'w/A1', '--site', 'orch', '--kind', 'opus').code, 1);
  const started = noCodex('builder', 'start', 'w/A1', '--site', 'orch', '--kind', 'build');
  assert.equal(started.code, 0, started.err);
  assert.match(started.out, /^kind: claude\. Codex isn't installed on the host\. Claude model is Sonnet\.\nmodel: Claude Sonnet$/m);
  assert.equal(read(at('waves', 'w', 'agents', 'A1.json')).model, 'sonnet');
  // A kind other than a build keeps its own model.
  assert.equal(noCodex('builder', 'start', 'w/A1', '--site', 'orch', '--agent', 'p', '--kind', 'prototype', '--model', 'opus').code, 0);
});

test('builder start --worktree makes a worktree on a new branch from main, keeps it on the record and prints it, and refuses a taken path or branch', () => {
  const repo = scratchRepo();
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  commit(repo, 'landed.txt', 'locally landed');
  const r = board('builder', 'start', 'w/A1', '--worktree', '--repo', repo);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `A1: builder started\nworktree: ${worktree()}\n`);
  assert.deepEqual(read(at('waves', 'w', 'agents', 'A1.json')).worktree, { path: worktree(), branch: 'A1', repo });
  assert.equal(git(worktree(), 'rev-parse', '--abbrev-ref', 'HEAD'), 'A1');
  assert.equal(git(worktree(), 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'main'));
  const taken = board('builder', 'start', 'w/A1', '--agent', 'two', '--worktree', '--repo', repo);
  assert.deepEqual([taken.code, taken.err], [1, `--worktree: ${worktree()} already exists and another open builder record uses it; land or remove it first\n`]);
  assert.equal(fs.existsSync(at('waves', 'w', 'agents', 'A1@two.json')), false);
  git(repo, 'worktree', 'remove', worktree());
  const branch = board('builder', 'start', 'w/A1', '--agent', 'two', '--worktree', '--repo', repo);
  assert.deepEqual([branch.code, branch.err], [1, `--worktree: branch A1 already exists in ${repo}\n`]);
  assert.equal(fs.existsSync(worktree()), false);
  assert.equal(board('builder', 'start', 'w/A1', '--repo', repo).code, 2);
});

test("a build start on a board makes the card's worktree when its record keeps none, and the agent taking up a dispatched record keeps that one", () => {
  const repo = scratchRepo();
  write(at('kickflip', 'manifest.json'), { sites: { orch: { dir: site('orch'), port: 1, cmd: [process.execPath, '/skill/board/server.mjs', site('orch')], owner: { repo } } } });
  const dispatched = board('--site', 'orch', 'builder', 'start', 'w/A1', '--dispatch', '--kind', 'claude');
  assert.equal(dispatched.code, 0, dispatched.err);
  assert.ok(dispatched.out.includes(`worktree: ${worktree()}\n`), dispatched.out);
  assert.equal(git(worktree(), 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'main'));
  const taken = board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'build', '--label', 'Opus implementer');
  assert.equal(taken.code, 0, taken.err);
  assert.deepEqual(read(at('waves', 'w', 'agents', 'A1.json')).worktree, { path: worktree(), branch: 'A1', repo });
  assert.equal(board('--site', 'orch', 'builder', 'start', 'w/A1', '--agent', 'notes', '--label', 'Notes').code, 0);
  assert.equal(read(at('waves', 'w', 'agents', 'A1@notes.json')).worktree, undefined);
  assert.deepEqual(branches(repo), ['A1', 'main']);

  commit(worktree(), 'work.txt', 'built');
  assert.equal(board('--site', 'orch', 'builder', 'done', 'w/A1', '--next', 'Check the build').code, 0);
  const again = board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'build');
  assert.equal(again.code, 0, again.err);
  assert.deepEqual(read(at('waves', 'w', 'agents', 'A1.json')).worktree, { path: worktree(), branch: 'A1', repo });
  assert.equal(fs.readFileSync(path.join(worktree(), 'work.txt'), 'utf8'), 'built');
});

test('builder start --worktree remakes a leftover worktree that holds no work from current main, saying so, and refuses one holding commits or changes, naming them', () => {
  const repo = scratchRepo();
  const leftover = () => git(repo, 'worktree', 'add', '--quiet', '-b', 'A1', worktree(), 'main');
  leftover();
  write(path.join(worktree(), 'node_modules', 'x.js'), 'ignored\n');
  write(path.join(repo, '.git', 'info', 'exclude'), 'node_modules\n');
  commit(worktree(), 'ahead.txt', 'unlanded');
  const refused = board('builder', 'start', 'w/A1', '--worktree', '--repo', repo);
  assert.deepEqual([refused.code, refused.err], [1, `--worktree: ${worktree()} holds 1 commit beyond main; land or remove it first\n`]);
  write(path.join(worktree(), 'a.txt'), 'new\n');
  write(path.join(worktree(), 'shared', 'notes.md'), 'b\n');
  const both = board('builder', 'start', 'w/A1', '--worktree', '--repo', repo);
  assert.deepEqual([both.code, both.err], [1, `--worktree: ${worktree()} holds 1 commit beyond main and 2 changed files; land or remove it first\n`]);
  git(worktree(), 'reset', '--quiet', '--hard', 'main');
  const changed = board('builder', 'start', 'w/A1', '--worktree', '--repo', repo);
  assert.deepEqual([changed.code, changed.err], [1, `--worktree: ${worktree()} holds 1 changed file; land or remove it first\n`]);
  assert.equal(fs.existsSync(at('waves', 'w', 'agents', 'A1.json')), false);

  fs.rmSync(path.join(worktree(), 'a.txt'));
  commit(repo, 'landed.txt', 'main moved');
  const r = board('builder', 'start', 'w/A1', '--worktree', '--repo', repo);
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
  const [hubPort] = await freePorts();
  const start = (...args) => spawnSync(process.execPath, [path.join(link, 'board', 'bin', 'board.mjs'), ...args, 'builder', 'start', 'w/A1', '--worktree'], { env: { ...process.env, HOME: home, KICKFLIP_HUB_PORT: String(hubPort) }, encoding: 'utf8' });
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

test("item set --status building gives the card its worktree before any builder runs and a later build start keeps it", () => {
  const repo = scratchRepo();
  write(at('kickflip', 'manifest.json'), { sites: { orch: { dir: site('orch'), port: 1, cmd: [process.execPath, '/skill/board/server.mjs', site('orch')], owner: { repo } } } });
  const set = board('--site', 'orch', 'item', 'set', 'w/A1', '--status', 'building');
  assert.equal(set.code, 0, set.err);
  assert.equal(git(worktree(), 'rev-parse', '--abbrev-ref', 'HEAD'), 'A1');
  assert.deepEqual(read(at('waves', 'w', 'wave.json')).items.find((i) => i.id === 'A1').worktree, { path: worktree(), branch: 'A1', repo });
  assert.equal(fs.existsSync(at('waves', 'w', 'agents', 'A1.json')), false);
  commit(worktree(), 'work.txt', 'built');
  const started = board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'build');
  assert.equal(started.code, 0, started.err);
  assert.deepEqual(read(at('waves', 'w', 'agents', 'A1.json')).worktree, { path: worktree(), branch: 'A1', repo });
  assert.equal(fs.readFileSync(path.join(worktree(), 'work.txt'), 'utf8'), 'built');
});

test('a board builder uses its shared clone and selected remote branch without changing the clone checkout', () => {
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
  const r = board('--site', 'orch', 'builder', 'start', 'w/A1', '--worktree');
  assert.equal(r.code, 0, r.err);
  assert.equal(git(worktree(), 'rev-parse', 'HEAD'), head);
  assert.equal(git(repo, 'branch', '--show-current'), 'main');
  assert.equal(read(at('waves', 'w', 'agents', 'A1.json')).worktree.repo, repo);
});

test("builder start and progress on --site write each new status line to the item's thread as its phase and detail, named by a further agent's kind", () => {
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch', '--phase', 'reading', '--progress', 'the plan').code, 0);
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch', '--agent', 'bench', '--kind', 'claude', '--phase', 'testing', '--progress', 'the benchmark').code, 0);
  assert.equal(board('builder', 'progress', 'w/A1', 'the', 'benchmark', '--phase', 'testing', '--site', 'orch', '--agent', 'bench').code, 0);
  assert.equal(board('builder', 'progress', 'w/A1', '--phase', 'building', 'the', 'limiter', '--site', 'orch').code, 0);
  assert.equal(board('builder', 'progress', 'w/A1', '--site', 'orch', '--phase', 'checking', '--text', 'the page at phone width').code, 0);
  assert.equal(board('builder', 'progress', 'w/A1', 'Twice', '--phase', 'testing', '--site', 'orch', '--text', 'Twice').code, 2);
  assert.equal(board('builder', 'progress', 'w/A1', '--phase', 'testing', '--site', 'orch').code, 2);
  assert.equal(board('builder', 'done', 'w/A1', '--site', 'orch').code, 0);
  const unseen = board('builder', 'progress', 'w/A1', 'Unseen', '--phase', 'testing', '--agent', 'bench');
  assert.deepEqual([unseen.code, /needs --site/.test(unseen.err)], [1, true]);
  assert.equal(board('builder', 'start', 'w/A1', '--agent', 'lint', '--phase', 'testing', '--progress', 'Unseen').code, 1);
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

test("a status line drops a detail's repeat of its own phase label", () => {
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch').code, 0);
  assert.equal(board('builder', 'progress', 'w/A1', '--phase', 'landing', '--site', 'orch', '--text', 'Landing: x').code, 0);
  assert.equal(board('builder', 'progress', 'w/A1', '--phase', 'landing', '--site', 'orch', '--text', 'landing rebase').code, 0);
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch', '--agent', 'bench', '--kind', 'claude', '--phase', 'landing', '--progress', 'Landing: y').code, 0);
  assert.deepEqual(lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).map((m) => m.text), ['Landing: x', 'Landing: rebase', 'Claude Opus landing: y']);
});

test('builder progress and start --progress refuse a missing or unknown phase and a detail over 80 characters, writing nothing', () => {
  const long = 'x'.repeat(81);
  for (const [args, err] of [
    [['builder', 'progress', 'w/A1', 'the plan', '--phase', 'waiting', '--site', 'orch'], /^--phase takes reading, building, testing, checking or landing, not "waiting"$/],
    [['builder', 'progress', 'w/A1', long, '--phase', 'testing', '--site', 'orch'], /^builder progress is 81 characters; the cap is 80\. Say it shorter\.$/],
    [['builder', 'start', 'w/A1', '--site', 'orch', '--progress', 'the plan'], /^--progress needs --phase reading, building, testing, checking or landing$/],
    [['builder', 'start', 'w/A1', '--site', 'orch', '--phase', 'reading'], /^--phase goes with --progress "<detail>"$/],
    [['builder', 'start', 'w/A1', '--site', 'orch', '--phase', 'reading', '--progress', long], /^--progress is 81 characters; the cap is 80\. Say it shorter\.$/],
  ]) {
    const r = board(...args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err.trim(), err, args.join(' '));
  }
  assert.equal(fs.existsSync(site('orch', 'data', 'threads', 'w__A1.jsonl')), false);
  assert.equal(fs.existsSync(at('waves', 'w', 'agents', 'A1.json')), false);
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch').code, 0);
  const bare = board('builder', 'progress', 'w/A1', 'the plan', '--site', 'orch');
  assert.deepEqual([bare.code, bare.err.trim()], [1, 'builder progress needs --phase reading, building, testing, checking or landing']);
  assert.equal(board('builder', 'progress', 'w/A1', 'x'.repeat(80), '--phase', 'landing', '--site', 'orch').code, 0);
});

test('the SubagentStop hook closes the builder records its agent started and left open, quietly and any number of times', () => {
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch').code, 0);
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch', '--agent', 'bench').code, 0);
  assert.equal(board('builder', 'start', 'audit/A1', '--site', 'audit').code, 0);
  assert.equal(board('builder', 'done', 'audit/A1', '--site', 'audit').code, 0);
  const finished = read(site('audit', 'data', 'agents', 'A1.json')).done;
  const transcript = path.join(home, 'agent.jsonl');
  write(transcript, [
    'not json',
    toolUse('t1', 'node ~/.claude/skills/kickflip/board/bin/board.mjs --site orch builder start w/A1 --kind build --label "Opus builder"; ls', ago(5 * 60 * 1000)),
    toolResult('t1', ago(1000)),
    toolUse('t2', 'B="node ~/.claude/skills/kickflip/board/bin/board.mjs --site orch"; eval "$B builder start w/A1 --agent bench --kind codex"', ago(1000)),
    toolUse('t3', '$B builder start audit/A1 --site audit', ago(1000)),
  ].join('\n') + '\n');
  for (const _ of [1, 2]) {
    const r = stopHook({ agent_transcript_path: transcript });
    assert.deepEqual([r.code, r.out], [0, '']);
  }
  assert.equal(typeof read(at('waves', 'w', 'agents', 'A1.json')).done, 'string');
  assert.equal(typeof read(at('waves', 'w', 'agents', 'A1@bench.json')).done, 'string');
  assert.equal(read(site('audit', 'data', 'agents', 'A1.json')).done, finished);
});

test('the SubagentStop hook leaves a record another agent restarted on the card after its own start', () => {
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch', '--agent', 'fix').code, 0);
  const transcript = path.join(home, 'agent.jsonl');
  write(transcript, [toolUse('t1', 'node board.mjs --site orch builder start w/A1 --agent fix', ago(10 * 60 * 1000)), toolResult('t1', ago(10 * 60 * 1000 - 500))].join('\n'));
  assert.equal(stopHook({ agent_transcript_path: transcript }).code, 0);
  assert.equal('done' in read(at('waves', 'w', 'agents', 'A1@fix.json')), false);
});

test('the SubagentStop hook leaves the records open while background work the agent started still runs, and closes them on its real finish', () => {
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch').code, 0);
  const transcript = path.join(home, 'agent.jsonl');
  const launched = (id, toolUseResult) => JSON.stringify({ type: 'user', timestamp: ago(500), message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'started' }] }, toolUseResult });
  write(transcript, [
    toolUse('t1', 'node board.mjs --site orch builder start w/A1 --kind build', ago(1000)),
    toolResult('t1', ago(900)),
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

test('the SubagentStop hook exits 0 with nothing on stdout when its input or transcript is missing', () => {
  for (const input of [{ agent_transcript_path: path.join(home, 'gone.jsonl') }, {}, 'not json']) {
    const r = stopHook(input);
    assert.deepEqual([r.code, r.out, /builder-stop-hook: /.test(r.err)], [0, '', true]);
  }
});

test("a builder's builder start takes up the record the owner's Build tap started: same kind and worktree, its own start time, and no longer dispatched", () => {
  const tapped = { label: 'Codex builder', kind: 'codex', started: '2026-11-03T10:00:00.000Z', dispatched: 'tap', worktree: { path: '/w/A1', branch: 'A1', repo: '/r' } };
  write(at('waves', 'w', 'agents', 'A1.json'), tapped);
  write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One', status: 'building' }] });
  const r = board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'build', '--label', 'Codex builder');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^A1: builder started\nkind: codex\. The owner's Build tap picked it\.\nmodel: Codex\nref: A1\nworktree: \/w\/A1\n/);
  const { started, ...record } = read(at('waves', 'w', 'agents', 'A1.json'));
  assert.deepEqual(record, { label: 'Codex builder', kind: 'codex', worktree: tapped.worktree });
  assert.ok(started > tapped.started);
  assert.equal(board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'build').code, 0);
  assert.equal(read(at('waves', 'w', 'agents', 'A1.json')).worktree, undefined);
});

// docs/adr/2026-11-05-0128-one-adapter-launches-claude-or-codex.md
test("a builder's start keeps the session id its launch recorded since the record last started or closed, and drops an older one", () => {
  const file = at('waves', 'w', 'agents', 'A1.json');
  const session = { id: 'sess-1', at: '2026-11-03T10:00:01.000Z' };
  write(file, { label: 'Builder', kind: 'claude', model: 'opus', started: '2026-11-03T10:00:00.000Z', dispatched: 'hub', session, worktree: { path: '/w/A1', branch: 'A1', repo: '/r' } });
  write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One', status: 'building' }] });
  assert.equal(board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'build').code, 0);
  assert.deepEqual(read(file).session, session, 'the agent taking up its launch keeps its session');
  // A lander launched on a closed record: its session was written after the close.
  const lander = { id: 'sess-2', at: '2026-11-03T12:00:01.000Z' };
  write(file, { ...read(file), done: '2026-11-03T12:00:00.000Z', session: lander });
  assert.equal(board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'build', '--label', 'Lander').code, 0);
  assert.deepEqual(read(file).session, lander);
  // A start with no launch since the record started belongs to no session the record knows.
  assert.equal(board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'build').code, 0);
  assert.equal(read(file).session, undefined);
});

test("builder start --dispatch opens the record before the agent launches, for build, prototype and grill, and the agent's own start takes it up", () => {
  write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One', status: 'todo' }, { id: 'A2', title: 'Two', status: 'todo' }] });
  const dispatched = board('--site', 'orch', 'builder', 'start', 'w/A1', '--dispatch', '--kind', 'build', '--model', 'sonnet', '--label', 'Sonnet builder');
  assert.equal(dispatched.code, 0, dispatched.err);
  const open = read(at('waves', 'w', 'agents', 'A1.json'));
  assert.equal(open.dispatched, 'session');
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].status, 'building');
  const taken = board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'build', '--label', 'Sonnet builder');
  assert.equal(taken.code, 0, taken.err);
  assert.match(taken.out, new RegExp(`kind: ${open.kind}\\. The session's dispatch picked it\\.`));
  const { started, ...record } = read(at('waves', 'w', 'agents', 'A1.json'));
  assert.deepEqual(record, { label: 'Sonnet builder', kind: open.kind, ...(open.model ? { model: open.model } : {}) });
  assert.ok(started >= open.started);
  for (const kind of ['prototype', 'grill']) {
    const r = board('--site', 'orch', 'builder', 'start', 'w/A2', '--dispatch', '--kind', kind, '--model', 'opus', '--label', `${kind} agent`);
    assert.equal(r.code, 0, r.err);
    assert.equal(read(at('waves', 'w', 'agents', 'A2.json')).dispatched, 'session');
    assert.equal(read(at('waves', 'w', 'wave.json')).items[1].status, 'todo');
    const own = board('--site', 'orch', 'builder', 'start', 'w/A2', '--kind', kind, '--label', `${kind} agent`);
    assert.equal(own.code, 0, own.err);
    const after = read(at('waves', 'w', 'agents', 'A2.json'));
    assert.equal(after.dispatched, undefined);
    assert.equal(after.kind, kind);
  }
});

test('--dispatch on a record whose worktree the dispatch made keeps it through the agent\'s start, and a record already done is not taken up', () => {
  write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One', status: 'building' }] });
  const wt = { path: '/w/A1', branch: 'A1', repo: '/r' };
  write(at('waves', 'w', 'agents', 'A1.json'), { label: 'Prototype', kind: 'claude', model: 'opus', started: '2026-11-03T10:00:00.000Z', dispatched: 'session', worktree: wt });
  assert.equal(board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'prototype').code, 0);
  assert.deepEqual(read(at('waves', 'w', 'agents', 'A1.json')).worktree, wt);
  write(at('waves', 'w', 'agents', 'A1.json'), { label: 'Old', kind: 'claude', started: '2026-11-03T10:00:00.000Z', dispatched: 'session', worktree: wt, done: '2026-11-03T11:00:00.000Z' });
  assert.equal(board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'prototype').code, 0);
  assert.equal(read(at('waves', 'w', 'agents', 'A1.json')).worktree, undefined);
});

test("--dispatch on a record the Build tap opened leaves it alone and says it's already open", () => {
  const tapped = { label: 'Builder', kind: 'codex', started: '2026-11-03T10:00:00.000Z', dispatched: 'tap', worktree: { path: '/w/A1', branch: 'A1', repo: '/r' } };
  write(at('waves', 'w', 'agents', 'A1.json'), tapped);
  write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One', status: 'building' }] });
  const r = board('--site', 'orch', 'builder', 'start', 'w/A1', '--dispatch', '--kind', 'build', '--worktree');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "A1: already open: the Implement tap opened its record; launch the agent, whose own builder start takes it up\n");
  assert.deepEqual(read(at('waves', 'w', 'agents', 'A1.json')), tapped);
});

test('builder start under another agent name refuses while the Build tap opened the main record and nobody took it up', () => {
  write(at('waves', 'w', 'agents', 'A1.json'), { label: 'Builder', kind: 'codex', started: '2026-11-03T10:00:00.000Z', dispatched: 'tap' });
  write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One', status: 'building' }] });
  const r = board('--site', 'orch', 'builder', 'start', 'w/A1', '--agent', 'bench', '--kind', 'bench');
  assert.equal(r.code, 1);
  assert.match(r.err, /the Implement tap opened w\/A1's main builder record and no agent has taken it up; run builder start w\/A1 without --agent first/);
  assert.equal(fs.existsSync(at('waves', 'w', 'agents', 'A1@bench.json')), false);
  assert.equal(board('--site', 'orch', 'builder', 'start', 'w/A1', '--kind', 'build').code, 0);
  assert.equal(board('--site', 'orch', 'builder', 'start', 'w/A1', '--agent', 'bench', '--kind', 'bench').code, 0);
});

test('builder progress refuses without an open builder record, as builder call does', () => {
  write(at('waves', 'w', 'wave.json'), { ...wave(), items: [{ id: 'A1', title: 'One', status: 'todo' }] });
  const none = board('--site', 'orch', 'builder', 'progress', 'w/A1', '--phase', 'reading', 'the notes');
  assert.equal(none.code, 1);
  assert.match(none.err, /builder progress needs an open builder record on w\/A1; run builder start first/);
  assert.equal(fs.existsSync(at('waves', 'w', 'agents', 'A1.json')), false);
  write(at('waves', 'w', 'agents', 'A1.json'), { label: 'Builder', started: '2026-11-03T10:00:00.000Z', done: '2026-11-03T11:00:00.000Z' });
  assert.match(board('--site', 'orch', 'builder', 'progress', 'w/A1', '--phase', 'reading', 'the notes').err, /needs an open builder record/);
  assert.equal(read(at('waves', 'w', 'agents', 'A1.json')).done, '2026-11-03T11:00:00.000Z');
});

test('builder start refuses a Claude pause before making records or a worktree, and runs while going or Off', () => {
  const until = new Date(Date.now() + 3600_000).toISOString();
  const usage = { at: new Date().toISOString(), five_hour: { used_percentage: 91, resets_at: until }, seven_day: { used_percentage: 96, resets_at: until } };
  write(at('kickflip', 'usage.json'), { claude: usage });
  const r = board('--site', 'orch', 'builder', 'start', 'w/A1', '--worktree');
  assert.equal(r.code, 1);
  assert.match(r.err, new RegExp(`Work is paused: Claude's 5-hour usage is at 91%. Resumes at ${until}. The owner can tap Keep going on the Hub page.`));
  assert.equal(fs.existsSync(at('waves', 'w', 'agents')), false);
  write(at('kickflip', 'settings.json'), { keepGoing: { window: 'five_hour', until } });
  assert.equal(board('--site', 'orch', 'builder', 'start', 'w/A1').code, 0);
  write(at('kickflip', 'settings.json'), { pauseAt: 100 });
  assert.equal(board('--site', 'orch', 'builder', 'start', 'w/A1', '--agent', 'two').code, 0);
  write(at('kickflip', 'settings.json'), {});
  write(at('kickflip', 'usage.json'), { claude: { ...usage, five_hour: { ...usage.five_hour, used_percentage: 40 } } });
  assert.match(board('--site', 'orch', 'builder', 'start', 'w/A1').err, /Claude's weekly usage is at 96%/);
});

// docs/adr/2026-11-03-1551-planners-and-implementers-are-two-kinds-of-agent.md
test('builder start saves a planner\'s model, Sonnet for a prototype and Opus for a grill by default, and its status lines are marked planner, read its kind\'s word and keep no builder phase', () => {
  const record = (agent) => read(at('waves', 'w', 'agents', agent === 'main' ? 'A1.json' : `A1@${agent}.json`));
  for (const [kind, model] of [['prototype', 'sonnet'], ['grill', 'opus']]) {
    const r = board('builder', 'start', 'w/A1', '--site', 'orch', '--agent', kind, '--kind', kind);
    assert.equal(r.code, 0, r.err);
    assert.equal(record(kind).model, model);
    assert.match(r.out, new RegExp(`^model: Claude ${model === 'opus' ? 'Opus' : 'Sonnet'}$`, 'm'));
  }
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch', '--agent', 'prototype', '--kind', 'prototype', '--model', 'opus').code, 0);
  assert.equal(record('prototype').model, 'opus');
  // A dispatched planner's model stays through the agent's own start.
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch', '--dispatch', '--kind', 'grill', '--model', 'sonnet').code, 0);
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch', '--kind', 'grill', '--phase', 'reading', '--progress', 'the notes').code, 0);
  assert.equal(record('main').model, 'sonnet');
  assert.equal(board('builder', 'progress', 'w/A1', '--site', 'orch', '--agent', 'prototype', '--phase', 'building', 'the takes').code, 0);
  // A planner needs no --phase.
  const bare = board('builder', 'progress', 'w/A1', '--site', 'orch', '--agent', 'prototype', 'take B');
  assert.equal(bare.code, 0, bare.err);
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch', '--agent', 'fix', '--kind', 'claude', '--phase', 'testing', '--progress', 'the fix').code, 0);
  assert.equal(board('builder', 'progress', 'w/A1', '--site', 'orch', '--agent', 'fix', 'no phase').code, 1);
  assert.deepEqual(lines(site('orch', 'data', 'threads', 'w__A1.jsonl')).map(({ text, planner, phase }) => [text, planner, phase]), [
    ['Grilling: the notes', true, undefined], ['Prototyping: the takes', true, undefined], ['Prototyping: take B', true, undefined], ['Claude Opus testing: the fix', undefined, 'testing'],
  ]);
});

test('builder done on a record with judgment calls hands the card back as checking, with the Next its calls ask for', () => {
  const item = () => read(at('waves', 'w', 'wave.json')).items[0];
  const record = () => read(at('waves', 'w', 'agents', 'A1.json'));
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch', '--label', 'Builder').code, 0);
  assert.equal(board('builder', 'call', 'w/A1', '--site', 'orch', 'Kept the old label').code, 0);
  const refused = board('builder', 'done', 'w/A1', '--site', 'orch', '--next', 'Land it');
  assert.deepEqual([refused.code, refused.err], [1, "builder done sets w/A1's Next itself while its record has judgment calls; run it without --next\n"]);
  const done = board('builder', 'done', 'w/A1', '--site', 'orch');
  assert.equal(done.code, 0, done.err);
  assert.equal(done.out, "A1: builder done\nhanded back: checking, Next \"Verify the builder's judgment calls\"\n");
  assert.deepEqual([item().status, item().next, Boolean(record().done)], ['checking', "Verify the builder's judgment calls", true]);

  assert.equal(board('builder', 'verified', 'w/A1', '--site', 'orch').code, 0);
  assert.equal(board('builder', 'start', 'w/A1', '--site', 'orch', '--label', 'Builder').code, 0);
  assert.equal(board('builder', 'call', 'w/A1', '--site', 'orch', 'Question: keep the old label?').code, 0);
  assert.equal(board('builder', 'call', 'w/A1', '--site', 'orch', 'Kept the old colour').code, 0);
  assert.equal(board('builder', 'done', 'w/A1', '--site', 'orch').code, 0);
  assert.deepEqual([item().status, item().next], ['checking', "Answer the builder's questions"]);
});
