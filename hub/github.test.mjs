import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeGh, prView, writePR, writeUser, writeIssueComments, writeReviewComments, writeReviews, calls } from '../shared/fake-gh.mjs';
import { fakeLinear, linearWorld } from '../shared/test-helpers.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'github-'));
process.env.HOME = home;
const priorPath = process.env.PATH;
process.env.PATH = `${fakeGh(home)}:${priorPath}`;
writeUser(home, { login: 'owner' });
const { summarize, changesBetween, carry, checkGitHub } = await import('./github.mjs');
after(() => { process.env.PATH = priorPath; fs.rmSync(home, { recursive: true, force: true }); });

const gh = (over = {}) => ({
  pr: 7, state: 'OPEN', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED',
  head: 'abc1234567', failing: [], pending: 0, events: [], ...over,
});
const sum = (over) => summarize(gh(over));

test('summarize keeps the state fields, sorted failing names and the newest event', () => {
  const s = sum({ failing: ['lint', 'build', 'lint'], pending: 2, reviewDecision: '', events: [{ id: 11, at: '2026-10-23T10:00:00Z' }, { id: 12, at: '2026-10-23T11:00:00Z' }] });
  assert.deepEqual(s, {
    state: 'OPEN', isDraft: false, reviewDecision: null, mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', head: 'abc1234567',
    failing: ['build', 'lint'], pending: 2, eventId: '12', eventAt: '2026-10-23T11:00:00Z',
  });
});

test('a PR seen for the first time reports only a merge or unhandled comments', () => {
  assert.deepEqual(changesBetween(undefined, sum()), []);
  assert.deepEqual(changesBetween(undefined, sum({ failing: ['x'], isDraft: true })), []);
  assert.deepEqual(changesBetween(undefined, sum({ state: 'MERGED', events: [{ id: 1, at: 't' }] })), ['comments', 'merged']);
});

test('changesBetween names each kind of change once, in order', () => {
  const prev = sum();
  assert.deepEqual(changesBetween(prev, sum()), []);
  assert.deepEqual(changesBetween(prev, sum({ failing: ['build'] })), ['ci']);
  assert.deepEqual(changesBetween(sum({ pending: 3 }), sum({ pending: 1 })), []);
  assert.deepEqual(changesBetween(sum({ pending: 3 }), sum({ pending: 0 })), ['ci']);
  assert.deepEqual(changesBetween(prev, sum({ head: 'def', pending: 4 })), []);
  assert.deepEqual(changesBetween(prev, sum({ head: 'def', pending: 0 })), ['ci']);
  assert.deepEqual(changesBetween(prev, sum({ head: 'def', state: 'MERGED' })), ['ci', 'merged']);
  assert.deepEqual(changesBetween(prev, sum({ reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN' })), ['review', 'mergeable']);
  assert.deepEqual(changesBetween(prev, sum({ events: [{ id: 5, at: 't' }] })), ['comments']);
  assert.deepEqual(changesBetween(sum({ events: [{ id: 5, at: 't' }] }), sum({ events: [{ id: 5, at: 't' }] })), []);
  assert.deepEqual(changesBetween(sum({ events: [{ id: 5, at: 't' }] }), sum()), []);
  assert.deepEqual(changesBetween(prev, sum({ state: 'MERGED' })), ['merged']);
  assert.deepEqual(changesBetween(sum({ state: 'MERGED' }), sum({ state: 'MERGED' })), []);
  assert.deepEqual(changesBetween(prev, sum({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })), ['mergeable']);
  assert.deepEqual(changesBetween(prev, sum({ isDraft: true })), ['draft']);
});

test("a head move never asks a session to rebuild an install", () => {
  const moved = changesBetween(sum(), sum({ head: 'def4567890' }));
  assert.deepEqual(moved, ['ci']);
  assert.deepEqual(changesBetween(undefined, sum({ head: 'def' })), []);
  assert.deepEqual(changesBetween(sum({ head: null }), sum({ head: 'def' })), ['ci']);
  assert.ok(!changesBetween(sum(), sum({ head: 'def', state: 'CLOSED' })).includes('head'));
  assert.ok(!changesBetween(sum(), sum({ head: null })).includes('head'));
});

test('an UNKNOWN mergeability is no change, and the last known one carries over it', () => {
  const prev = sum();
  const unknown = sum({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' });
  assert.deepEqual(changesBetween(prev, unknown), []);
  const kept = carry(prev, unknown);
  assert.equal(kept.mergeable, 'MERGEABLE');
  assert.equal(kept.mergeStateStatus, 'BLOCKED');
  assert.deepEqual(changesBetween(kept, sum()), []);
  assert.deepEqual(changesBetween(kept, sum({ mergeable: 'CONFLICTING' })), ['mergeable']);
  assert.equal(carry(undefined, unknown).mergeable, 'UNKNOWN');
});

test('the poll remembers head changes without waking either kind of board until CI settles', async () => {
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
  const claude = (...parts) => path.join(home, '.claude', ...parts);
  const waveDir = path.join(home, 'waves-board');
  const fileDir = path.join(home, 'file-board');
  const events = (dir) => {
    const file = path.join(dir, 'data/events.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse) : [];
  };
  const cmd = [process.execPath, new URL('../board/server.mjs', import.meta.url).pathname];
  const manifest = { sites: { waves: { dir: waveDir, port: 1, cmd }, file: { dir: fileDir, port: 1, cmd } } };
  write(path.join(waveDir, 'board.json'), { items: 'waves' });
  write(claude('waves', 'w', 'wave.json'), { repo: 'o/r', items: [
    { id: 'A1', pr: 7, install: { url: 'https://m/app.apk' } }, { id: 'A2', pr: 7 }, { id: 'A3', pr: 8 },
  ] });
  write(path.join(fileDir, 'board.json'), { items: 'data/wave.json', slug: 'own' });
  write(path.join(fileDir, 'data/wave.json'), { repo: 'o/r', items: [
    { id: 'S1', pr: 7, install: { url: 'https://m/app.apk', sha: 'new' } }, { id: 'S2', pr: 7 },
  ] });
  const result = (pr, head, more = {}) => writePR(home, pr, prView({ head, pending: 2, ...more }));
  const poll = () => checkGitHub({ every: 15, manifest });
  result(7, 'old');
  result(8, 'old');
  assert.deepEqual((await poll()).changes, []);
  result(7, 'new');
  result(8, 'new');
  const moved = await poll();
  assert.deepEqual(moved.changes, []);
  assert.deepEqual(events(waveDir), []);
  assert.deepEqual(events(fileDir), []);
  assert.deepEqual(calls(home).filter((a) => a[0] === 'pr').map((a) => a[2]), ['7', '8', '7', '8']);
  const state = JSON.parse(fs.readFileSync(claude('kickflip', 'github-state.json'), 'utf8'));
  assert.equal(state.prs['o/r#8'].head, 'new');
  assert.deepEqual((await poll()).events, []);
  result(7, 'newer', { pending: 0 });
  await poll();
  assert.deepEqual(events(waveDir).at(-1).data.prs, [
    { wave: 'w', id: 'A1', pr: 7, changes: ['ci'] }, { wave: 'w', id: 'A2', pr: 7, changes: ['ci'] },
  ]);
  assert.deepEqual(events(fileDir).at(-1).data.prs, [
    { wave: 'own', id: 'S1', pr: 7, changes: ['ci'] }, { wave: 'own', id: 'S2', pr: 7, changes: ['ci'] },
  ]);
});

test('the poll retries a failed CI delivery without repeating it on another board', async () => {
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
  const claude = (...parts) => path.join(home, '.claude', ...parts);
  const installDir = path.join(home, 'retry-install');
  const otherDir = path.join(home, 'retry-other');
  const cmd = [process.execPath, new URL('../board/server.mjs', import.meta.url).pathname];
  const manifest = { sites: { install: { dir: installDir, port: 1, cmd }, other: { dir: otherDir, port: 1, cmd } } };
  for (const [dir, install] of [[installDir, { url: 'https://m/app.apk' }], [otherDir, undefined]]) {
    write(path.join(dir, 'board.json'), { items: 'data/wave.json', slug: 'w' });
    write(path.join(dir, 'data/wave.json'), { repo: 'o/r', items: [{ id: 'A1', pr: 7, install }] });
  }
  const stateFile = claude('kickflip', 'github-state.json');
  write(stateFile, { prs: { 'o/r#7': sum() } });
  writePR(home, 7, prView({ head: 'new' }));
  const blocked = path.join(installDir, 'data/events.jsonl');
  fs.mkdirSync(blocked);
  const poll = () => checkGitHub({ every: 15, manifest });
  const first = await poll();
  assert.equal(first.failed.length, 1);
  assert.deepEqual(first.events.map((e) => e.route), ['other']);
  const otherEvents = path.join(otherDir, 'data/events.jsonl');
  const delivered = fs.readFileSync(otherEvents, 'utf8');
  assert.deepEqual(JSON.parse(delivered).data.prs, [{ wave: 'w', id: 'A1', pr: 7, changes: ['ci'] }]);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).prs['o/r#7'].head, 'abc1234567');
  fs.rmdirSync(blocked);
  const retried = await poll();
  assert.deepEqual(retried.failed, []);
  assert.deepEqual(retried.events.map((e) => e.route), ['install']);
  assert.deepEqual(JSON.parse(fs.readFileSync(blocked, 'utf8')).data.prs, [{ wave: 'w', id: 'A1', pr: 7, changes: ['ci'] }]);
  assert.equal(fs.readFileSync(otherEvents, 'utf8'), delivered);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).prs['o/r#7'].head, 'new');
  assert.deepEqual((await poll()).events, []);
});

function fileBoard(route, cfg, items) {
  const dir = path.join(home, route);
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
  write(path.join(dir, 'board.json'), { items: 'data/wave.json', ...cfg });
  write(path.join(dir, 'data/wave.json'), { repo: 'o/r', items });
  const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse) : []);
  const manifest = { sites: { [route]: { dir, port: 1, cmd: [process.execPath, new URL('../board/server.mjs', import.meta.url).pathname] } } };
  return {
    poll: () => checkGitHub({ every: 15, manifest }),
    thread: (key) => lines(path.join(dir, 'data/threads', `${key.replace('/', '__')}.jsonl`)),
    events: () => lines(path.join(dir, 'data/events.jsonl')),
    wave: () => JSON.parse(fs.readFileSync(path.join(dir, 'data/wave.json'), 'utf8')),
  };
}

test("the poll writes each new owner and reviewer comment or review into its card's thread once", async () => {
  const board = fileBoard('lines', { slug: 'w', reviewers: [{ name: 'Ann', github: 'ann-gh' }] }, [{ id: 'A1', pr: 50, gh_since: '2026-10-23T10:00:00Z' }]);
  const url = (anchor) => `https://github.com/o/r/pull/50#${anchor}`;
  const comment = (id, login, at, body) => ({ id, user: { login }, created_at: at, body, html_url: url(`issuecomment-${id}`) });
  writePR(home, 50, prView());
  writeIssueComments(home, 50, [
    comment(1, 'owner', '2026-10-23T09:00:00Z', 'Handled before gh_since.'),
    comment(2, 'owner', '2026-10-23T11:00:00Z', 'Please rename it.'),
    comment(3, 'owner', '2026-10-23T11:01:00Z', '🤖 Renamed.\n\n<!-- claude-bridge -->'),
    comment(4, 'chatgpt-codex-connector[bot]', '2026-10-23T11:02:00Z', 'P1: a finding.'),
    comment(5, 'Ann-GH', '2026-10-23T11:03:00Z', 'Looks fine.'),
  ]);
  writeReviews(home, 50, [
    { id: 2, user: { login: 'ann-gh' }, submitted_at: '2026-10-23T11:04:00Z', body: '', state: 'APPROVED', html_url: url('pullrequestreview-2') },
    { id: 9, user: { login: 'bea' }, submitted_at: '2026-10-23T11:05:00Z', body: '', state: 'COMMENTED', html_url: url('pullrequestreview-9') },
    { id: 10, user: { login: 'bea' }, submitted_at: '2026-10-23T11:06:00Z', body: 'Split the file.', state: 'CHANGES_REQUESTED' },
  ]);
  writeReviewComments(home, 50, [{ id: 8, user: { login: 'bea' }, created_at: '2026-10-23T11:05:00Z', body: 'Typo here.', path: 'a.mjs', line: 3, html_url: url('discussion_r8') }]);
  const shown = () => board.thread('w/A1').map(({ who, text, link, via }) => ({ who, text, link, via }));
  assert.deepEqual((await board.poll()).failed, []);
  const first = [
    { who: 'love', text: 'Please rename it.', link: url('issuecomment-2'), via: 'github' },
    { who: 'Ann', text: 'Looks fine.', link: url('issuecomment-5'), via: 'github' },
    { who: 'Ann', text: 'Approved.', link: url('pullrequestreview-2'), via: 'github' },
    { who: 'bea', text: 'Typo here.', link: url('discussion_r8'), via: 'github' },
    { who: 'bea', text: 'Changes requested. Split the file.', link: 'https://github.com/o/r/pull/50', via: 'github' },
  ];
  assert.deepEqual(shown(), first);
  assert.deepEqual(board.events().map((e) => e.data.prs), [[{ wave: 'w', id: 'A1', pr: 50, changes: ['comments'] }]]);
  await board.poll();
  assert.deepEqual(shown(), first);
  writeIssueComments(home, 50, [comment(2, 'owner', '2026-10-23T11:00:00Z', 'Please rename it.'), comment(11, 'owner', '2026-10-23T12:00:00Z', 'Thanks.')]);
  await board.poll();
  assert.deepEqual(shown(), [...first, { who: 'love', text: 'Thanks.', link: url('issuecomment-11'), via: 'github' }]);
});

test('a merged PR closes its card as merged, frees the card waiting on it and still wakes the session', async () => {
  const board = fileBoard('merges', { slug: 'm' }, [{ id: 'A1', pr: 51 }, { id: 'A2', deps: ['A1'] }]);
  writePR(home, 51, prView({ state: 'MERGED' }));
  assert.deepEqual((await board.poll()).failed, []);
  assert.equal(board.wave().items[0].status, 'merged');
  assert.deepEqual(board.thread('m/A1').map((l) => l.text), ['Merged PR #51.']);
  assert.deepEqual(board.thread('m/A2').map((l) => l.text), ['Unblocked: A1 is merged.']);
  assert.deepEqual(board.events().map((e) => [e.kind, e.data]), [
    ['card-unblocked', { key: 'm/A2' }], ['github-change', { prs: [{ wave: 'm', id: 'A1', pr: 51, changes: ['merged'] }] }],
  ]);
  const fetches = calls(home).length;
  assert.equal((await board.poll()).watched, 0);
  assert.equal(calls(home).length, fetches);
  assert.deepEqual(board.thread('m/A1').map((l) => l.text), ['Merged PR #51.']);
});

async function linearPoll(t, { key = true } = {}) {
  const world = linearWorld();
  const linear = fakeLinear(world);
  const server = await linear.serve();
  const previous = process.env.KICKFLIP_LINEAR_URL;
  process.env.KICKFLIP_LINEAR_URL = server.url;
  const keyFile = path.join(home, '.claude', 'kickflip', 'linear.json');
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
  if (key) write(keyFile, { key: world.key, workspace: 'Acme', url_key: 'acme', viewer: world.viewer });
  t.after(async () => {
    await server.close();
    if (previous === undefined) delete process.env.KICKFLIP_LINEAR_URL; else process.env.KICKFLIP_LINEAR_URL = previous;
    fs.rmSync(keyFile, { force: true });
  });
  const root = fs.mkdtempSync(path.join(home, 'linear-poll-'));
  const manifest = { sites: {} };
  const board = (route, items, cfg = {}) => {
    const dir = path.join(root, route);
    const settings = { items: 'data/wave.json', slug: 'linear', tickets: { source: 'linear' }, ...cfg };
    write(path.join(dir, 'board.json'), settings);
    const file = settings.items === 'waves' ? path.join(home, '.claude', 'waves', 'linear', 'wave.json') : path.join(dir, settings.items);
    const set = (items) => write(file, { repo: 'o/r', items });
    set(items);
    manifest.sites[route] = { dir, port: 1, cmd: [process.execPath, new URL('../board/server.mjs', import.meta.url).pathname] };
    return set;
  };
  const issue = (id, state = 's-todo', assignee = world.viewer.id) => { world.issues[id] = { team: 'ENG', state, assignee }; };
  const updates = () => linear.calls.filter((c) => c.query.includes('issueUpdate'));
  return { world, linear, board, issue, updates, poll: () => checkGitHub({ every: 15, manifest }) };
}

test('the poll advances a draft to In Progress, a ready PR to In Review and a merge to Done, idempotently', async (t) => {
  const { board, issue, poll, world, linear, updates } = await linearPoll(t);
  board('draft', [{ id: 'A1', pr: 31, ticket: 'ENG-1' }]);
  issue('ENG-1');
  for (const [pr, state] of [
    [{ isDraft: true }, 'In Progress'], [{ isDraft: false }, 'In Review'], [{ state: 'MERGED' }, 'Done'],
  ]) {
    writePR(home, 31, prView(pr));
    const moved = await poll();
    assert.deepEqual(moved.failed, []);
    assert.deepEqual(moved.linear, { moved: [{ id: 'ENG-1', state }], failed: [] });
    const count = updates().length;
    assert.deepEqual((await poll()).linear, { moved: [], failed: [] });
    assert.equal(updates().length, count);
  }
  assert.equal(world.issues['ENG-1'].state, 's-done');
  assert.equal(updates().length, 3);
  assert.equal(linear.calls.filter((c) => c.query.includes('issue(id')).length, 5);
  assert.ok(!linear.calls.some((c) => c.query.includes('viewer')));
});

test("the poll leaves someone else's ticket alone without looking up states or mutating", async (t) => {
  const { board, issue, poll, world, linear, updates } = await linearPoll(t);
  board('unowned', [{ id: 'A1', pr: 32, linear: ['ENG-2'] }], { tickets: { source: 'internal' } });
  issue('ENG-2', 's-todo', 'someone-else');
  writePR(home, 32, prView());
  assert.deepEqual((await poll()).linear, { moved: [], failed: [] });
  assert.equal(world.issues['ENG-2'].state, 's-todo');
  assert.equal(linear.calls.length, 1);
  assert.equal(updates().length, 0);
});

test('the poll never moves an In Review or Done ticket backwards for a draft PR', async (t) => {
  const { board, issue, poll, world, linear, updates } = await linearPoll(t);
  board('later', [{ id: 'A1', pr: 33, linear: ['ENG-3', 'ENG-4'] }]);
  issue('ENG-3', 's-rev');
  issue('ENG-4', 's-done');
  writePR(home, 33, prView({ isDraft: true }));
  assert.deepEqual((await poll()).linear, { moved: [], failed: [] });
  assert.deepEqual([world.issues['ENG-3'].state, world.issues['ENG-4'].state], ['s-rev', 's-done']);
  assert.equal(linear.calls.length, 2);
  assert.equal(updates().length, 0);
});

test('a shared ticket waits for both cards across file boards to be ready and then merged', async (t) => {
  const { board, issue, poll, world, updates } = await linearPoll(t);
  const first = board('shared-first', [{ id: 'A1', pr: 34, ticket: 'ENG-5' }]);
  board('shared-second', [{ id: 'A1', pr: 35, ticket: 'ENG-5' }, { id: 'dropped', status: 'dropped', ticket: 'ENG-5' }]);
  issue('ENG-5');
  writePR(home, 34, prView());
  writePR(home, 35, prView({ isDraft: true }));
  assert.deepEqual((await poll()).linear.moved, [{ id: 'ENG-5', state: 'In Progress' }]);
  writePR(home, 35, prView());
  assert.deepEqual((await poll()).linear.moved, [{ id: 'ENG-5', state: 'In Review' }]);
  writePR(home, 34, prView({ state: 'MERGED' }));
  assert.deepEqual((await poll()).linear, { moved: [], failed: [] });
  assert.equal(world.issues['ENG-5'].state, 's-rev');
  first([{ id: 'A1', pr: 34, status: 'merged', ticket: 'ENG-5' }]);
  writePR(home, 35, prView({ state: 'MERGED' }));
  assert.deepEqual((await poll()).linear.moved, [{ id: 'ENG-5', state: 'Done' }]);
  assert.equal(updates().length, 3);
});

test('the poll combines Linear lists and Linear-source tickets once across waves boards, including created tickets', async (t) => {
  const { board, issue, poll, linear, updates } = await linearPoll(t);
  const items = [
    { id: 'A1', pr: 36, linear: ['ENG-6', 'ENG-7'], ticket: 'ENG-7', ticket_created: true },
    { id: 'A2', pr: 36, ticket: 'ENG-8' },
  ];
  board('waves-linear', items, { items: 'waves' });
  board('waves-internal', items, { items: 'waves', tickets: { source: 'internal' } });
  board('file-internal', [{ id: 'A1', pr: 36, ticket: 'ENG-9' }], { tickets: { source: 'internal' } });
  issue('ENG-6');
  issue('ENG-7', 's-todo', null);
  issue('ENG-8');
  issue('ENG-9');
  writePR(home, 36, prView());
  assert.deepEqual((await poll()).linear, { moved: [
    { id: 'ENG-6', state: 'In Review' }, { id: 'ENG-7', state: 'In Review' }, { id: 'ENG-8', state: 'In Review' },
  ], failed: [] });
  assert.deepEqual(linear.calls.filter((c) => c.query.includes('issue(id')).map((c) => c.variables.id), ['ENG-6', 'ENG-7', 'ENG-8']);
  assert.equal(updates().length, 3);
});

test('an unstarted carrying card blocks review and a closed unmerged PR does not start its ticket', async (t) => {
  const { board, issue, poll, linear } = await linearPoll(t);
  board('unstarted', [
    { id: 'A1', pr: 37, ticket: 'ENG-10' }, { id: 'A2', ticket: 'ENG-10' },
    { id: 'A3', pr: 38, ticket: 'ENG-11' }, { id: 'A4', status: 'done', ticket: 'ENG-10' },
  ]);
  issue('ENG-10');
  issue('ENG-11');
  writePR(home, 37, prView());
  writePR(home, 38, prView({ state: 'CLOSED' }));
  assert.deepEqual((await poll()).linear, { moved: [{ id: 'ENG-10', state: 'In Progress' }], failed: [] });
  assert.deepEqual(linear.calls.filter((c) => c.query.includes('issue(id')).map((c) => c.variables.id), ['ENG-10']);
});

test('a failed PR fetch skips a shared ticket even when its other card was fetched successfully', async (t) => {
  const { board, issue, poll, linear, updates } = await linearPoll(t);
  board('failed-pr', [{ id: 'A1', pr: 39, ticket: 'ENG-12' }, { id: 'A2', pr: 40, ticket: 'ENG-12' }]);
  issue('ENG-12');
  writePR(home, 39, prView());
  writePR(home, 40, { fail: true });
  const result = await poll();
  assert.equal(result.failed.length, 1);
  assert.deepEqual(result.linear, { moved: [], failed: [] });
  assert.equal(linear.calls.length, 0);
  assert.equal(updates().length, 0);
  writePR(home, 40, prView());
  assert.deepEqual((await poll()).linear.moved, [{ id: 'ENG-12', state: 'In Review' }]);
});

test('Linear failures stay separate from GitHub and retry on an unchanged PR', async (t) => {
  const { board, issue, poll, world } = await linearPoll(t);
  board('linear-failure', [{ id: 'A1', pr: 41, ticket: 'ENG-13' }]);
  issue('ENG-13');
  writePR(home, 41, prView());
  const key = world.key;
  world.key = 'refused';
  const failed = await poll();
  assert.deepEqual(failed.failed, []);
  assert.deepEqual(failed.linear, { moved: [], failed: ['linear ENG-13: Linear refused the key.'] });
  const state = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'kickflip', 'github-state.json'), 'utf8'));
  assert.equal(state.lastCheck.at, failed.at);
  assert.equal(state.lastCheck.failed, 0);
  world.key = key;
  assert.deepEqual((await poll()).linear, { moved: [{ id: 'ENG-13', state: 'In Review' }], failed: [] });
});

test('without a saved key the poll makes no Linear request and keeps GitHub changes and checked boards', async (t) => {
  const { board, poll, linear } = await linearPoll(t, { key: false });
  board('no-key', [{ id: 'A1', pr: 42, ticket: 'ENG-14', linear: ['ENG-15'] }]);
  writePR(home, 42, prView());
  assert.deepEqual((await poll()).linear, { moved: [], failed: [] });
  writePR(home, 42, prView({ isDraft: true }));
  const result = await poll();
  assert.deepEqual(result.linear, { moved: [], failed: [] });
  assert.deepEqual(result.failed, []);
  assert.equal(result.watched, 1);
  assert.deepEqual(result.changes, [{ repo: 'o/r', pr: 42, changes: ['draft'] }]);
  assert.deepEqual(result.events.map((e) => e.route), ['no-key']);
  assert.deepEqual(result.checked, ['no-key']);
  assert.equal(linear.calls.length, 0);
});
