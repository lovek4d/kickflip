// docs/adr/2026-11-27-2345-a-board-pulls-in-open-github-issues-no-task-names.md
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeGh, writeUser, writeIssues, calls } from '../shared/fake-gh.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

const home = tempDir('issue-pull-');
process.env.HOME = home;
const priorPath = process.env.PATH;
process.env.PATH = `${fakeGh(home)}:${priorPath}`;
writeUser(home, { login: 'owner' });
const { checkGitHub } = await import('./github.mjs');
const { issuesToPull, issueBacklog, defaultBacklog } = await import('./issue-pull.mjs');
const { listBoards } = await import('./boards.mjs');
const { setBoardDefault } = await import('../shared/hub-settings.mjs');
after(() => { process.env.PATH = priorPath; });

const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse) : []);
const issue = (number, { created = '2026-11-20T10:00:00Z', assignees = [], title = `Issue ${number}` } = {}) => ({
  number, title, url: `https://github.com/o/r/issues/${number}`, createdAt: created, author: { login: 'reporter' }, assignees: { nodes: assignees.map((login) => ({ login })) },
});
function fileBoard(route, cfg, items, { archive = [] } = {}) {
  const dir = path.join(home, route);
  write(path.join(dir, 'board.json'), { items: 'data/items.json', slug: route, tickets: { source: 'github' }, ...cfg });
  write(path.join(dir, 'data/items.json'), { repo: 'o/r', items });
  if (archive.length) write(path.join(dir, 'data/done-archive.json'), { cards: archive });
  const manifest = { sites: { [route]: { dir, port: 1, github: 'o/r', cmd: [process.execPath, new URL('../board/server.mjs', import.meta.url).pathname] } } };
  return {
    dir, manifest,
    poll: () => checkGitHub({ every: 15, manifest }),
    items: () => JSON.parse(fs.readFileSync(path.join(dir, 'data/items.json'), 'utf8')).items,
    thread: (key) => lines(path.join(dir, 'data/threads', `${key.replace('/', '__')}.jsonl`)),
    events: () => lines(path.join(dir, 'data/events.jsonl')).filter((e) => e.kind === 'issue-pulled'),
  };
}

test('issuesToPull keeps the open issues no task names, by the mode, after the since mark', () => {
  const issues = [issue(5, { assignees: ['Owner'] }), issue(4), issue(3, { created: '2026-11-01T00:00:00Z', assignees: ['owner'] }), issue(2, { assignees: ['ann'] })];
  const named = new Set(['#4']);
  const pick = (over) => issuesToPull(issues, { mode: 'all', me: 'owner', since: null, named, ...over }).map((i) => i.number);
  assert.deepEqual(pick({}), [2, 3, 5], 'all: every unnamed open issue, oldest first');
  assert.deepEqual(pick({ mode: 'assigned' }), [3, 5], 'assigned only: the owner\'s, any case');
  assert.deepEqual(pick({ since: '2026-11-10T00:00:00Z' }), [2, 5], 'only new: created after the mark');
  assert.deepEqual(pick({ mode: 'off' }), []);
  assert.deepEqual(pick({ mode: 'assigned', me: null }), [], 'with no owner login, none is the owner\'s');
});

test('the poll files an unnamed open issue once as a discussing GH-<n> task and wakes the orchestrator; a named one, open or Done, is skipped', async () => {
  const board = fileBoard('pull-all', { pull_issues: 'all' }, [
    { id: 'T-1', title: 'feat: on the board', ticket: '#11', lane: 'todo' },
    { id: 'T-2', title: 'feat: done here', ticket: '#12', lane: 'done' },
  ], { archive: [{ key: 'pull-all/T-3', item: { id: 'T-3', title: 'feat: archived', ticket: '#13', lane: 'done' } }] });
  writeIssues(home, 'o/r', [issue(14, { title: 'Crash on start' }), issue(13), issue(12), issue(11)]);
  const first = await board.poll();
  assert.deepEqual(first.failed, []);
  const pulled = board.items().find((i) => i.id === 'GH-14');
  assert.deepEqual([pulled.title, pulled.ticket, pulled.lane, pulled.phase], ['Crash on start', '#14', 'todo', 'discussing']);
  assert.deepEqual(board.items().map((i) => i.id), ['T-1', 'T-2', 'GH-14']);
  assert.match(fs.readFileSync(path.join(board.dir, 'data', pulled.plan), 'utf8'), /https:\/\/github\.com\/o\/r\/issues\/14/);
  assert.deepEqual(board.thread('pull-all/GH-14').map((l) => l.text), ['Pulled in from GitHub issue #14.']);
  assert.deepEqual(board.events().map((e) => e.data), [{ key: 'pull-all/GH-14', ticket: '#14', title: 'Crash on start', url: 'https://github.com/o/r/issues/14' }]);
  await board.poll();
  assert.equal(board.items().filter((i) => i.id === 'GH-14').length, 1, 'never filed again');
  assert.equal(board.events().length, 1);
});

test('assigned only pulls the owner\'s issues, only-new skips those before the mark, and off pulls nothing', async () => {
  writeIssues(home, 'o/r', [issue(23, { assignees: ['owner'] }), issue(22, { assignees: ['ann'] }), issue(21, { created: '2026-11-01T00:00:00Z' })]);
  const assigned = fileBoard('pull-mine', { pull_issues: 'assigned' }, []);
  await assigned.poll();
  assert.deepEqual(assigned.items().map((i) => i.id), ['GH-23']);
  const fresh = fileBoard('pull-new', { pull_issues: 'all', pull_issues_since: '2026-11-10T00:00:00Z' }, []);
  await fresh.poll();
  assert.deepEqual(fresh.items().map((i) => i.id), ['GH-22', 'GH-23']);
  const off = fileBoard('pull-off', {}, []);
  const before = calls(home).length;
  await off.poll();
  assert.deepEqual(off.items(), []);
  assert.ok(!calls(home).slice(before).some((a) => a[1] === 'graphql' && /issues\(states: OPEN/.test(a[3])), 'a board that pulls nothing asks for no issues');
  const linear = fileBoard('pull-linear', { pull_issues: 'all', tickets: { source: 'linear', workspace: 'w', team: 'ENG', project: 'P' } }, []);
  await linear.poll();
  assert.deepEqual(linear.items(), [], 'a board on Linear pulls no GitHub issues');
});

test('an issue gone from the open list closes its unstarted task Done, notes a started one once, and leaves the rest', async () => {
  const board = fileBoard('gone', {}, [
    { id: 'T-1', title: 'feat: unstarted', ticket: '#61', lane: 'todo', phase: 'ready' },
    { id: 'T-2', title: 'feat: started', ticket: '#62', lane: 'todo', phase: 'ready', branch: 'b' },
    { id: 'T-3', title: 'feat: still open', ticket: '#63', lane: 'todo' },
    { id: 'T-4', title: 'feat: done', ticket: '#64', lane: 'done' },
    { id: 'T-5', title: 'feat: no ticket', lane: 'todo' },
  ]);
  writeIssues(home, 'o/r', [issue(63)]);
  const before = calls(home).length;
  const first = await board.poll();
  assert.deepEqual(first.failed, []);
  const lane = (id) => board.items().find((i) => i.id === id).lane;
  assert.deepEqual(['T-1', 'T-2', 'T-3', 'T-4', 'T-5'].map(lane), ['done', 'todo', 'todo', 'done', 'todo']);
  assert.deepEqual(board.thread('gone/T-1').map((l) => l.text).filter((t) => /upstream/.test(t)), ['Issue #61 closed upstream, so this task closed.']);
  assert.deepEqual(board.thread('gone/T-2').map((l) => l.text), ['Issue #62 closed upstream; this task was already started.']);
  assert.equal(calls(home).slice(before).some((a) => a[0] === 'issue'), false, 'closing the task does not call the closed issue back');
  await board.poll();
  assert.equal(board.thread('gone/T-2').length, 1, 'said once');
});

test('with more open issues than the poll lists, a missing one is not taken as closed', async () => {
  const board = fileBoard('gone-big', {}, [{ id: 'T-1', title: 'feat: old', ticket: '#5', lane: 'todo', phase: 'ready' }]);
  writeIssues(home, 'o/r', Array.from({ length: 120 }, (_, i) => issue(300 - i)));
  await board.poll();
  assert.equal(board.items()[0].lane, 'todo');
});

test('a board takes the Hub default unless it overrides it', async () => {
  writeIssues(home, 'o/r', [issue(31)]);
  await setBoardDefault('pull_issues', 'all');
  const takes = fileBoard('pull-default', {}, []);
  const overrides = fileBoard('pull-override', { pull_issues: 'off' }, []);
  await takes.poll();
  await overrides.poll();
  assert.deepEqual([takes.items().map((i) => i.id), overrides.items()], [['GH-31'], []]);
  await setBoardDefault('pull_issues', 'off');
});

test('issueBacklog counts what turning the pull on would bring in', async () => {
  writeIssues(home, 'o/r', [issue(43, { assignees: ['owner'] }), issue(42), issue(41)]);
  const board = fileBoard('pull-count', {}, [{ id: 'T-1', title: 'feat: here', ticket: '#41', lane: 'todo' }]);
  const self = listBoards(board.manifest)[0];
  assert.deepEqual(await issueBacklog(self, 'all'), { count: 2, more: false });
  assert.deepEqual(await issueBacklog(self, 'assigned'), { count: 1, more: false });
  writeIssues(home, 'o/r', Array.from({ length: 120 }, (_, i) => issue(200 - i)));
  assert.deepEqual(await issueBacklog(self, 'all'), { count: 100, more: true });
});

test("defaultBacklog sums the boards that take the Hub default and can pull, for Hub settings' ask", async () => {
  writeIssues(home, 'o/r', [issue(52), issue(51)]);
  const takes = fileBoard('sum-takes', {}, [{ id: 'T-1', title: 'feat: here', ticket: '#51', lane: 'todo' }]);
  const overrides = fileBoard('sum-overrides', { pull_issues: 'all' }, []);
  const none = fileBoard('sum-none', { tickets: undefined }, []);
  const boards = listBoards({ sites: { ...takes.manifest.sites, ...overrides.manifest.sites, ...none.manifest.sites } });
  assert.deepEqual(await defaultBacklog('all', boards), { count: 1, more: false, boards: ['sum-takes'] });
  assert.equal(await defaultBacklog('all', boards.slice(1)), null);
});
