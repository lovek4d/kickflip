// docs/adr/2026-11-06-1700-a-bump-marks-the-priority-through-every-lane.md: a bump past the cap bumps out a build, and a
// bump lasts until its unbump or the card's close, which the land queue reads too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { home, at, site, write, read, itemOf, threadOf, record } from './board-fixture.mjs';
import { until } from '../shared/test-helpers.mjs';
import * as store from './store.mjs';
import { bumpOut } from './stop.mjs';

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const now = () => new Date().toISOString();
const waveFile = () => at('waves', 'w', 'wave.json');
const setA1 = (fields) => { const w = read(waveFile()); Object.assign(w.items.find((i) => i.id === 'A1'), fields); write(waveFile(), w); };
const recordFile = () => at('waves', 'w', 'agents', 'A1.json');
const addEvent = (kind, ts, data) => write(site('orch', 'data', 'events.jsonl'), [...readEvents(), { id: `${kind}-${ts}`, ts, kind, data }].map((e) => JSON.stringify(e)).join('\n') + '\n');
function onHome(t) {
  const old = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = old; });
}
function readEvents() {
  try { return fs.readFileSync(site('orch', 'data', 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}

test("a bump-out stops the card's board-launched builder, keeps its worktree, and sends it back to Todo as ready, naming the bump, until it starts again", async (t) => {
  onHome(t);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  t.after(() => { try { process.kill(child.pid, 'SIGKILL'); } catch {} });
  await new Promise((r) => setTimeout(r, 200));
  setA1({ lane: 'progress', phase: 'staging', staged_at: now() });
  const tree = { path: path.join(home, 'tree'), branch: 'A1', repo: path.join(home, 'repo') };
  write(recordFile(), { started: new Date(Date.now() - 60_000).toISOString(), kind: 'claude', model: 'opus', worktree: tree, session: { id: 's1', pid: child.pid, at: now() } });
  const lines = await bumpOut(site('orch'), 'w/A1', 'w/ENG-1');
  assert.match(lines[0], /^A1 bumped out by ENG-1$/);
  await until(() => !alive(child.pid), 'the builder is gone');
  const item = itemOf();
  assert.deepEqual([item.lane, item.phase, item.staged_at, item.bumped_out?.by], ['todo', 'ready', undefined, 'w/ENG-1']);
  assert.equal(typeof record().done, 'string', 'its record closes, so nothing relaunches it');
  assert.deepEqual(record().worktree, tree);
  assert.deepEqual(threadOf().map((l) => l.text), ['Bumped out by ENG-1: back to Todo, ready. It starts again once a slot frees.']);

  fs.mkdirSync(tree.path, { recursive: true });
  await store.startBuilder(site('orch'), 'w/A1', { kind: 'build', dispatch: 'hub', ownWorktree: async () => tree });
  assert.deepEqual(record().worktree, tree, 'the build starts again in the worktree it kept');
  assert.deepEqual([itemOf().lane, itemOf().bumped_out], ['progress', undefined], 'its next start ends the bump-out');
});

test('the land queue takes a bump made before the first build, and drops one made before the card last closed', async (t) => {
  onHome(t);
  setA1({ lane: 'progress' });
  write(recordFile(), { started: '2026-11-06T10:00:00.000Z', kind: 'claude' });
  addEvent('card-bump', '2026-11-06T09:00:00.000Z', { key: 'w/A1' });
  assert.equal(await store.landFirst(site('orch'), 'w/A1'), '2026-11-06T09:00:00.000Z');
  setA1({ lane: 'progress', closed_at: '2026-11-06T09:30:00.000Z', reopened_at: '2026-11-06T09:40:00.000Z' });
  assert.equal(await store.landFirst(site('orch'), 'w/A1'), null);
  addEvent('card-unbump', '2026-11-06T09:50:00.000Z', { key: 'w/A1' });
  addEvent('card-bump', '2026-11-06T09:55:00.000Z', { key: 'w/A1' });
  assert.equal(await store.landFirst(site('orch'), 'w/A1'), '2026-11-06T09:55:00.000Z');
});
