import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { turnsOf, claimBuilds, othersHeld, leaveTurns, turnDue } from './build-turns.mjs';
import { MAX_TASKS_IN_PROGRESS, readTasksInProgress, setTasksInProgress } from '../shared/hub-settings.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

const want = (key, first = null) => ({ key, first });
const board = (site, held, wants, granted = []) => ({ site, held, wants, granted });
const grants = (out) => Object.fromEntries([...out.grants].filter(([, keys]) => keys.length));

// docs/adr/2026-11-19-0602-one-hub-wide-build-cap-boards-take-turns.md
test('free slots go round the boards one card each, from the board after the last served', () => {
  const boards = [board('/a', 0, [want('a/1'), want('a/2'), want('a/3')]), board('/b', 0, [want('b/1')]), board('/c', 0, [want('c/1'), want('c/2')])];
  assert.deepEqual(grants(turnsOf(boards, { cap: 5 })), { '/a': ['a/1', 'a/2'], '/b': ['b/1'], '/c': ['c/1', 'c/2'] }, 'a board with nothing left gives its turn up');
  const two = turnsOf(boards, { cap: 2 });
  assert.deepEqual([grants(two), two.last], [{ '/a': ['a/1'], '/b': ['b/1'] }, '/b']);
  const next = turnsOf(boards, { cap: 2, last: '/b' });
  assert.deepEqual([grants(next), next.last], [{ '/c': ['c/1'], '/a': ['a/1'] }, '/a'], 'the turn picks up after the last board served');
  assert.deepEqual(grants(turnsOf(boards, { cap: 1, last: '/bb' })), { '/c': ['c/1'] }, 'a last board gone hands the turn to the next by name');
});

test('the cap counts every board\'s held and granted slots', () => {
  const boards = [board('/a', 3, [want('a/1')]), board('/b', 1, [want('b/1'), want('b/2')], ['b/1'])];
  assert.deepEqual(grants(turnsOf(boards, { cap: 5 })), {}, 'three held, one held and one granted: full');
  assert.deepEqual(grants(turnsOf(boards, { cap: 7 })), { '/a': ['a/1'], '/b': ['b/2'] }, 'a granted card is not granted again');
  assert.deepEqual(grants(turnsOf(boards, { cap: 2 })), {}, 'over the cap, nothing');
});

test('a bumped card takes the next slot ahead of the turns, the earliest bump first, and moves no turn', () => {
  const boards = [board('/a', 0, [want('a/1')]), board('/b', 0, [want('b/1'), want('b/2', '2026-11-19T02:00:00Z')]), board('/c', 0, [want('c/1', '2026-11-19T01:00:00Z')])];
  const one = turnsOf(boards, { cap: 1, last: '/c' });
  assert.deepEqual([grants(one), one.last], [{ '/c': ['c/1'] }, '/c']);
  assert.deepEqual(grants(turnsOf(boards, { cap: 3, last: '/c' })), { '/c': ['c/1'], '/b': ['b/2'], '/a': ['a/1'] });
});

function home(t) {
  const dir = tempDir('build-turns-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the hub number is tasksInProgress in settings.json, 5 unless set, 1 to 99', async (t) => {
  const dir = home(t);
  assert.equal(readTasksInProgress(dir), MAX_TASKS_IN_PROGRESS);
  assert.equal(MAX_TASKS_IN_PROGRESS, 5);
  assert.equal(await setTasksInProgress('3', dir), 3);
  assert.equal(readTasksInProgress(dir), 3);
  for (const bad of ['0', '100', 'x', '2.5']) await assert.rejects(setTasksInProgress(bad, dir), { status: 400 });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'kickflip', 'settings.json'), 'utf8')).tasksInProgress, 3);
});

test('a board takes its own turn at once and grants the next boards\' turns for them to take', async (t) => {
  const dir = home(t);
  assert.deepEqual(await claimBuilds({ home: dir, site: '/b', held: 1, wants: [want('b/1'), want('b/2')], cap: 2 }), { take: ['b/1'] }, 'alone, it takes the free slot');
  assert.deepEqual(await claimBuilds({ home: dir, site: '/a', held: 0, wants: [want('a/1')], cap: 2 }), { take: [] }, 'full: nothing');
  assert.equal(othersHeld({ home: dir, site: '/a' }), 2);
  // b/1 lands: /b's next pass frees its slot, and the turn after /b is /a's.
  assert.deepEqual(await claimBuilds({ home: dir, site: '/b', held: 1, wants: [want('b/2')], cap: 2 }), { take: [] });
  assert.equal(othersHeld({ home: dir, site: '/b' }), 1, '/a holds its granted card');
  assert.deepEqual(await claimBuilds({ home: dir, site: '/a', held: 0, wants: [want('a/1')], cap: 2 }), { take: ['a/1'] }, '/a takes its grant');
  assert.equal(othersHeld({ home: dir, site: '/b' }), 1);
  // A grant whose card is no longer wanted is dropped and the slot goes on.
  await claimBuilds({ home: dir, site: '/a', held: 0, wants: [], cap: 2 });
  assert.deepEqual(await claimBuilds({ home: dir, site: '/b', held: 1, wants: [want('b/2')], cap: 2 }), { take: ['b/2'] });
});

test('a board whose server is gone holds no slot, and a closing board leaves the turns', async (t) => {
  const dir = home(t);
  await claimBuilds({ home: dir, site: '/a', held: 2, wants: [], cap: 2 });
  const file = fs.readdirSync(path.join(dir, '.claude', 'kickflip', 'builds')).find((f) => f.endsWith('.json') && f !== 'turn.json');
  const entry = path.join(dir, '.claude', 'kickflip', 'builds', file);
  fs.writeFileSync(entry, JSON.stringify({ ...JSON.parse(fs.readFileSync(entry, 'utf8')), pid: 2 ** 22 + 12345 }));
  assert.equal(othersHeld({ home: dir, site: '/b' }), 0);
  await claimBuilds({ home: dir, site: '/a', held: 2, wants: [], cap: 2 });
  assert.equal(othersHeld({ home: dir, site: '/b' }), 2);
  leaveTurns({ home: dir, site: '/a' });
  assert.equal(othersHeld({ home: dir, site: '/b' }), 0);
});

test('a pass at the turns is due on a grant, or on a wanted card while the hub has a free slot', async (t) => {
  const dir = home(t);
  assert.equal(turnDue({ home: dir, site: '/a', cap: 2 }), false, 'a board with no entry yet waits for its first pass');
  await claimBuilds({ home: dir, site: '/a', held: 2, wants: [want('a/1')], cap: 2 });
  assert.equal(turnDue({ home: dir, site: '/a', cap: 2 }), false, 'full');
  assert.equal(turnDue({ home: dir, site: '/a', cap: 3 }), true, 'the owner raised the number');
  assert.deepEqual(await claimBuilds({ home: dir, site: '/b', held: 0, wants: [want('b/1'), want('b/2')], cap: 4 }), { take: ['b/1'] });
  assert.equal(turnDue({ home: dir, site: '/a', cap: 4 }), true, '/b\'s pass granted /a the first turn');
  assert.equal(turnDue({ home: dir, site: '/b', cap: 4 }), false, 'and the hub is full');
});
