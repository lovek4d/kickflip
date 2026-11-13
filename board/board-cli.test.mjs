import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, read, at } from './board-fixture.mjs';

// The board-*.test.mjs files run board.mjs's main in-process (board-fixture.mjs boardWith); these run it as its own
// node process, once per command group, for what only a process shows: --help, and the exit code of a success, a
// refusal (1) and a usage error (2).
const board = (...args) => run('board.mjs', args);
const usage = /\(node board\.mjs --help lists the commands\)\n$/;

test('board.mjs prints its usage for --help and no arguments, and exits 2 naming an unknown command', () => {
  for (const args of [['--help'], []]) {
    const r = board(...args);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^usage: node board\.mjs <command>/);
  }
  const unknown = board('nope', 'please');
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /^unknown command "nope please"/);
  assert.match(unknown.err, usage);
});

test('item: a write exits 0, an unknown card 1, and missing arguments 2', () => {
  const held = board('item', 'set', 'w/A1', '--site', 'orch', '--held');
  assert.equal(held.code, 0, held.err);
  assert.equal(read(at('waves', 'w', 'wave.json')).items[0].held, true);
  assert.deepEqual(board('item', 'set', 'w/Z9', '--site', 'orch', '--held'), { code: 1, out: '', err: 'item file "w" has no item "Z9"\n' });
  const bare = board('item', 'add');
  assert.equal(bare.code, 2);
  assert.match(bare.err, /^item add takes <file\[\/id\]> /);
  assert.match(bare.err, usage);
});

test('builder: a start exits 0, an unknown card 1, and missing arguments 2', () => {
  const start = board('builder', 'start', 'w/A1', '--site', 'orch', '--kind', 'claude');
  assert.equal(start.code, 0, start.err);
  assert.match(start.out, /^A1: builder started\n/);
  assert.equal(board('builder', 'start', 'w/Z9', '--site', 'orch').code, 1);
  const bare = board('builder', 'progress');
  assert.equal(bare.code, 2);
  assert.match(bare.err, usage);
});

test('land: missing arguments and a land without --text exit 2', () => {
  const bare = board('land');
  assert.equal(bare.code, 2);
  assert.match(bare.err, /^land takes <file\/id> /);
  const untold = board('land', 'w/A1', '--site', 'orch');
  assert.equal(untold.code, 2);
  assert.match(untold.err, /^land needs --text/);
  assert.match(untold.err, usage);
});

test('settings: reading them exits 0 with JSON, an unknown setting 1, and a set without a value 2', () => {
  const r = board('--site', 'orch', 'settings');
  assert.equal(r.code, 0, r.err);
  assert.equal(typeof JSON.parse(r.out).auto_merge, 'boolean');
  const unknown = board('--site', 'orch', 'settings', 'set', 'nope', 'on');
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /^no board setting "nope"/);
  const bare = board('--site', 'orch', 'settings', 'set', 'prs');
  assert.equal(bare.code, 2);
  assert.match(bare.err, /^settings set takes <name> <value> /);
});
