import { home } from '../shared/scratch-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startBoard, untilTestEnds } from '../shared/test-helpers.mjs';
import { hasBuilder, reviveBuilders } from './headless.mjs';

// docs/adr/2026-11-13-2345-a-card-never-gets-a-second-builder-while-its-first-is-alive.md
test('a card whose open record has no process yet, or a process that may run, has a builder; ps giving no answer reads as may run, not dead', () => {
  const noPs = () => null;
  const gone = () => new Map();
  const at = new Date().toISOString();
  assert.equal(hasBuilder([{ pid: null, at: null }], { starts: gone }), true, 'a start whose launch is still to come');
  assert.equal(hasBuilder([{ pid: process.pid, at }], { starts: noPs }), true, 'a failed ps is unknown, not dead');
  assert.equal(hasBuilder([{ pid: process.pid, at }], { starts: gone }), false, 'ps answered and the process is not listed');
  assert.equal(hasBuilder([], { starts: noPs }), false);
});

test('a tracked builder whose process runs is never relaunched, whatever ps says', async () => {
  const tracked = { 'w/A': { kind: 'claude', model: 'opus', pid: process.pid, relaunched: false } };
  const next = await reviveBuilders(tracked, new Set(['w/A']), { launch: async () => assert.fail('no second builder'), handBack: async () => assert.fail('nothing is handed back') });
  assert.deepEqual(next, tracked);
});

// A board whose Todo card the pull starts, its builders fake claudes that name a session at once and stay up.
async function pullingBoard(t) {
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args]);
  git('init', '--quiet', '-b', 'main');
  git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '--quiet', '--allow-empty', '-m', 'base');
  const site = path.join(home, 'site');
  const data = path.join(site, 'data');
  fs.mkdirSync(path.join(data, 'threads'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'kickflip'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'kickflip', 'manifest.json'), JSON.stringify({ sites: { t: { dir: site, port: 1, cmd: ['node', '/x/board/server.mjs'], branch: 'main', owner: { repo } } } }));
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ items: 'data/items.json', slug: 't', max_implementers: 2 }));
  const wave = path.join(data, 'items.json');
  fs.writeFileSync(wave, JSON.stringify({ items: [{ id: 'A1', title: 'feat: next', lane: 'todo', phase: 'ready' }] }));
  const log = path.join(home, 'launches.log');
  const claude = path.join(home, 'claude');
  fs.writeFileSync(claude, `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(log)}, 'x\\n');\nconsole.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-' + process.pid }));\n${untilTestEnds()};\n`);
  fs.chmodSync(claude, 0o755);
  process.env.KICKFLIP_CLAUDE = claude;
  const board = await startBoard(t, { site });
  await board.settled();
  const launches = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0);
  const pass = async () => { board.changed(wave); await board.settled(); };
  return { ...board, wave, launches, pass };
}

test('two pull passes back to back launch one builder, even when the second reads the card as unstarted again', async (t) => {
  const b = await pullingBoard(t);
  await b.pass();
  assert.equal(b.launches(), 1);
  // The second pass's board read predates the first's start: the card is in Todo again, its builder record open.
  const items = JSON.parse(fs.readFileSync(b.wave, 'utf8'));
  items.items[0].lane = 'todo';
  items.items[0].phase = 'ready';
  delete items.items[0].started;
  fs.writeFileSync(b.wave, JSON.stringify(items));
  await b.pass();
  await b.pass();
  assert.equal(b.launches(), 1);
});
