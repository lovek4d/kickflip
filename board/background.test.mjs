import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { backgroundArgv, onPath, userScopes } from './background.mjs';
import { launchAgent } from './agents.mjs';
import { nodeTests } from './worktree.mjs';
import { untilTestEnds } from '../shared/test-helpers.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

// docs/adr/2026-11-18-0400-builds-run-at-background-priority.md
const argv = ['claude', '-p', 'Build it.'];
const scopes = (starts) => () => starts;

test('on macOS a build runs under taskpolicy -b, at background priority', () => {
  assert.deepEqual(backgroundArgv(argv, { platform: 'darwin', scopes: scopes(true) }), ['taskpolicy', '-b', ...argv]);
});

test('on Linux where a systemd user scope starts, a build runs in its own scope at a fifth of the CPU and IO weight', () => {
  assert.deepEqual(backgroundArgv(argv, { platform: 'linux', scopes: scopes(true) }),
    ['systemd-run', '--user', '--scope', '-q', '-p', 'CPUWeight=20', '-p', 'IOWeight=20', ...argv]);
});

test("on Linux where a user scope doesn't start, and elsewhere, a build runs at the lowest nice", () => {
  assert.deepEqual(backgroundArgv(argv, { platform: 'linux', scopes: scopes(false) }), ['nice', '-n', '19', ...argv]);
  assert.deepEqual(backgroundArgv(argv, { platform: 'freebsd', scopes: scopes(true) }), ['nice', '-n', '19', ...argv]);
});

test('a host without systemd-run starts no user scope', { skip: process.platform === 'linux' && 'a Linux host may have one' }, () => {
  assert.equal(userScopes(), false);
});

test('onPath finds a command by name on PATH or as an executable path, and nothing for a missing or non-executable file', () => {
  const dir = tempDir('on-path-');
  try {
    const tool = path.join(dir, 'tool');
    fs.writeFileSync(tool, '#!/bin/sh\n', { mode: 0o755 });
    const plain = path.join(dir, 'plain');
    fs.writeFileSync(plain, '', { mode: 0o644 });
    assert.equal(onPath('tool', `/no/such:${dir}`), tool);
    assert.equal(onPath(tool, ''), tool);
    assert.equal(onPath('plain', dir), null);
    assert.equal(onPath(plain, ''), null);
    assert.equal(onPath('missing', dir), null);
    assert.equal(onPath(path.join(dir, 'missing'), ''), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The host's wrapper, and a fake of it first on PATH for a test: it logs how it was called and execs the command, the
// first argument that is an absolute path, as the real one does. → the lines it logged
const wrapper = backgroundArgv([])[0];
function fakeWrapper(t) {
  const dir = tempDir('wrappers-');
  const log = path.join(dir, 'wrapped.log');
  fs.writeFileSync(path.join(dir, wrapper), `#!/bin/sh
echo "${wrapper} $*" >> ${JSON.stringify(log)}
while [ $# -gt 0 ] && [ "\${1#/}" = "$1" ]; do shift; done
exec "$@"
`, { mode: 0o755 });
  const old = process.env.PATH;
  process.env.PATH = `${dir}:${old}`;
  t.after(() => { process.env.PATH = old; fs.rmSync(dir, { recursive: true, force: true }); });
  return () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
}

test('a launched agent starts through the background wrapper, and its pid is the agent', async (t) => {
  const wrapped = fakeWrapper(t);
  const dir = tempDir('agent-background-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'claude');
  const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' });
  fs.writeFileSync(bin, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(init)});\n${untilTestEnds()};\n`, { mode: 0o755 });
  const { pid, sessionId } = await launchAgent({ kind: 'claude', bin, model: 'opus', cwd: dir, site: dir, prompt: 'x', log: path.join(dir, 'A1.log'), sessionWait: Infinity });
  assert.equal(sessionId, 's1');
  assert.deepEqual(wrapped().map((line) => line.split(' ')[0]), [wrapper]);
  assert.ok(wrapped()[0].includes(`${bin} -p x`));
  assert.match(execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }), /claude -p x/, 'the pid is the agent, not its wrapper');
  await assert.rejects(launchAgent({ kind: 'claude', bin: path.join(dir, 'missing'), model: 'opus', cwd: dir, site: dir, prompt: 'x', log: path.join(dir, 'A2.log') }), /ENOENT/,
    'a missing agent still fails its launch, not just its wrapper');
});

test("a land's test run starts through the background wrapper", async (t) => {
  const wrapped = fakeWrapper(t);
  const dir = tempDir('tests-background-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'one.test.mjs'), "import test from 'node:test';\ntest('runs', () => {});\n");
  assert.deepEqual(await nodeTests(dir), { ok: true, pass: 1, fail: 0 });
  assert.deepEqual(wrapped().map((line) => line.split(' ')[0]), [wrapper]);
  assert.match(wrapped()[0], /--test .*one\.test\.mjs/);
});
