import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from '../shared/temp-dir.mjs';

const home = tempDir('release-watch-');
process.env.HOME = home;
const { runReleaseWatch, firstFailingTest } = await import('./release-watch.mjs');

// A board on GitHub repo o/r whose item file holds items, and an exec standing in for gh and npm: runs by tag gives
// gh run list's JSON per tag, npm the versions npm view finds, logs gh run view --log-failed's text by run id.
function releaseBoard(route, items) {
  const dir = path.join(home, route);
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
  write(path.join(dir, 'board.json'), { items: 'data/items.json', slug: 'r' });
  write(path.join(dir, 'data/items.json'), { repo: 'o/r', items });
  const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse) : []);
  const world = { runs: {}, npm: [], logs: {}, calls: [] };
  const exec = async (cmd, args) => {
    world.calls.push([cmd, ...args].join(' '));
    if (cmd === 'gh' && args[0] === 'run' && args[1] === 'list') return JSON.stringify(world.runs[args[args.indexOf('--branch') + 1]] || []);
    if (cmd === 'gh' && args[0] === 'run' && args[1] === 'view') return world.logs[args[2]] || '';
    if (cmd === 'npm') return world.npm.includes(args[1].split('@').at(-1)) ? JSON.stringify(args[1].split('@').at(-1)) : '';
    throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
  };
  const itemFile = () => JSON.parse(fs.readFileSync(path.join(dir, 'data/items.json'), 'utf8'));
  return {
    world,
    watch: async () => {
      const failed = [];
      await runReleaseWatch([{ route, dir, kind: 'board', github: 'o/r', files: [{ slug: 'r', itemFile: itemFile() }] }], failed, { exec });
      return failed;
    },
    item: (id) => itemFile().items.find((i) => i.id === id),
    thread: (key) => lines(path.join(dir, 'data/threads', `${key.replace('/', '__')}.jsonl`)),
    events: () => lines(path.join(dir, 'data/events.jsonl')),
  };
}

const LOG = [
  'publish\tUNKNOWN STEP\t2026-11-17T19:27:35.7046Z # Subtest: a task already Done posts no end line',
  'publish\tUNKNOWN STEP\t2026-11-17T19:27:35.7047Z ok 2297 - a task already Done posts no end line',
  "publish\tUNKNOWN STEP\t2026-11-17T19:27:35.9296Z not ok 2298 - the digest's day opens at quiet hours' end",
  'publish\tUNKNOWN STEP\t2026-11-17T19:27:35.9358Z   ---',
  'publish\tUNKNOWN STEP\t2026-11-17T19:27:35.9359Z   duration_ms: 15.321305',
  "publish\tUNKNOWN STEP\t2026-11-17T19:27:35.9360Z   location: '/home/runner/work/kickflip/kickflip/hub/slack.test.mjs:9:1'",
  "publish\tUNKNOWN STEP\t2026-11-17T19:27:35.9361Z   failureType: 'testCodeFailure'",
  'publish\tUNKNOWN STEP\t2026-11-17T19:27:36.0001Z not ok 12 - /home/runner/work/kickflip/kickflip/hub/slack.test.mjs',
].join('\n');

// docs/adr/2026-11-18-0200-a-release-card-waits-in-in-review-until-its-release-is-published.md
test("a failed run's first failing test is its first not ok line, with the file and line the test starts at", () => {
  assert.equal(firstFailingTest(LOG), "the digest's day opens at quiet hours' end (hub/slack.test.mjs:9)");
  assert.equal(firstFailingTest('publish\tSmoke install\t2026-11-17T19:27:35Z npm error 404'), null);
});

test("the watch reads a release card's tag run and npm: publishing while the run is missing, running or npm lacks the version, published once both show it, asking the owner for Done", async () => {
  const release = { version: '0.19.1', tag: 'v0.19.1', pkg: '@o/kit', since: '2026-11-17T20:00:00Z', state: 'publishing' };
  const board = releaseBoard('published', [{ id: 'R1', lane: 'done', release }, { id: 'R2', lane: 'progress', release: { ...release, version: '0.19.2', tag: 'v0.19.2' } }, { id: 'R3', lane: 'done' }]);
  assert.deepEqual(await board.watch(), []);
  assert.equal(board.item('R1').release.state, 'publishing');
  assert.deepEqual(board.world.calls, ['gh run list --repo o/r --branch v0.19.1 --event push --limit 20 --json databaseId,workflowName,status,conclusion,url,createdAt'], 'only a landed release card is watched');
  board.world.runs['v0.19.1'] = [{ databaseId: 5, workflowName: 'release', status: 'in_progress', conclusion: '', url: 'https://github.com/o/r/actions/runs/5', createdAt: '2026-11-17T20:01:00Z' }];
  await board.watch();
  assert.equal(board.item('R1').release.state, 'publishing');
  board.world.runs['v0.19.1'][0] = { ...board.world.runs['v0.19.1'][0], status: 'completed', conclusion: 'success' };
  await board.watch();
  assert.equal(board.item('R1').release.state, 'publishing', 'npm has yet to serve it');
  board.world.npm.push('0.19.1');
  await board.watch();
  assert.deepEqual(board.item('R1').release, { ...release, state: 'published', url: 'https://github.com/o/r/actions/runs/5' });
  assert.equal(board.item('R1').lane, 'done');
  assert.deepEqual(board.thread('r/R1').map((l) => [l.line, l.text, l.link]),
    [['release-published', 'Published 0.19.1: its release run passed and @o/kit@0.19.1 is on npm. Tap Done.', 'https://github.com/o/r/actions/runs/5']]);
  const calls = board.world.calls.length;
  await board.watch();
  assert.equal(board.world.calls.length, calls, 'a published release is watched no more');
  assert.deepEqual(board.events(), []);
});

test("a failed tag run marks the card red with the run's link and its first failing test, wakes the orchestrator once, and a passing rerun publishes it", async () => {
  const release = { version: '0.19.0', tag: 'v0.19.0', pkg: '@o/kit', since: '2026-11-17T19:00:00Z', state: 'publishing' };
  const board = releaseBoard('failed', [{ id: 'F1', lane: 'done', release }]);
  const url = 'https://github.com/o/r/actions/runs/44';
  board.world.runs['v0.19.0'] = [{ databaseId: 44, workflowName: 'release', status: 'completed', conclusion: 'failure', url, createdAt: '2026-11-17T19:23:06Z' }];
  board.world.logs['44'] = LOG;
  assert.deepEqual(await board.watch(), []);
  const failure = "the digest's day opens at quiet hours' end (hub/slack.test.mjs:9)";
  assert.deepEqual(board.item('F1').release, { ...release, state: 'failed', url, failure });
  assert.deepEqual(board.thread('r/F1').map((l) => [l.line, l.text, l.link]), [['release-failed', `Release 0.19.0 failed: ${failure}`, url]]);
  assert.deepEqual(board.events().map((e) => [e.kind, e.data]), [['release-failed', { key: 'r/F1', version: '0.19.0', url, failure }]]);
  await board.watch();
  assert.equal(board.thread('r/F1').length, 1);
  assert.equal(board.events().length, 1);
  assert.equal(board.world.calls.filter((c) => c.startsWith('gh run view')).length, 1, 'the log is read once per failed run');
  // A rerun in progress, then passing, with the version on npm.
  board.world.runs['v0.19.0'][0] = { ...board.world.runs['v0.19.0'][0], status: 'in_progress', conclusion: '' };
  await board.watch();
  assert.equal(board.item('F1').release.state, 'publishing');
  board.world.runs['v0.19.0'][0] = { ...board.world.runs['v0.19.0'][0], status: 'completed', conclusion: 'success' };
  board.world.npm.push('0.19.0');
  await board.watch();
  assert.equal(board.item('F1').release.state, 'published');
  assert.equal(board.item('F1').release.failure, undefined);
});

test("a release with no package publishes on its tag's runs alone, and a gh that can't run leaves the card as it is, said in failed", async () => {
  const board = releaseBoard('nopkg', [{ id: 'N1', lane: 'done', release: { version: '2.0.0', tag: 'v2.0.0', since: '2026-11-17T19:00:00Z', state: 'publishing' } }]);
  board.world.runs['v2.0.0'] = [{ databaseId: 9, workflowName: 'release', status: 'completed', conclusion: 'success', url: 'u9', createdAt: '2026-11-17T19:01:00Z' }];
  await board.watch();
  assert.equal(board.item('N1').release.state, 'published');
  assert.equal(board.thread('r/N1')[0].text, 'Published 2.0.0: its release run passed. Tap Done.');

  const broken = releaseBoard('gh-down', [{ id: 'G1', lane: 'done', release: { version: '1.0.0', tag: 'v1.0.0', since: '2026-11-17T19:00:00Z', state: 'publishing' } }]);
  broken.world.runs = null;
  const failed = await broken.watch();
  assert.equal(failed.length, 1);
  assert.match(failed[0], /^gh-down: could not read r\/G1's release 1\.0\.0: /);
  assert.equal(broken.item('G1').release.state, 'publishing');
});
