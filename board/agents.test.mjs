import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { launchAgent } from './agents.mjs';
import { until, untilTestEnds } from '../shared/test-helpers.mjs';

// A fake agent that records how it ran, prints what it's given, and stays alive until the test process ends when stays.
function fakeAgent(dir, name, { stdout = '', stderr = '', stays = false } = {}) {
  const seen = path.join(dir, `${name}-seen.json`);
  const bin = path.join(dir, name);
  fs.writeFileSync(bin, `#!/usr/bin/env node
require('fs').writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), nested: process.env.CLAUDECODE ?? null }));
process.stdout.write(${JSON.stringify(stdout)});
process.stderr.write(${JSON.stringify(stderr)});
${stays ? untilTestEnds() : ''};
`);
  fs.chmodSync(bin, 0o755);
  return { bin, seen: () => JSON.parse(fs.readFileSync(seen, 'utf8')) };
}
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), name));

// docs/adr/2026-11-05-0128-one-adapter-launches-claude-or-codex.md
test('launchAgent runs claude -p in auto mode on the model in cwd, without the session’s CLAUDE_* variables, and reads the session id from its init event', async () => {
  const dir = tmp('agent-claude-');
  try {
    const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-claude-1', model: 'claude-sonnet', cwd: dir });
    const fake = fakeAgent(dir, 'claude', { stdout: `${init}\n`, stays: true });
    const log =path.join(dir, 'logs', 'A1.log');
    const before = process.env.CLAUDECODE;
    process.env.CLAUDECODE = '1';
    let launched;
    try { launched = await launchAgent({ kind: 'claude', bin: fake.bin, model: 'sonnet', cwd: dir, site: '/s/shop', prompt: 'Build it.', log, sessionWait: Infinity }); } finally {
      if (before === undefined) delete process.env.CLAUDECODE; else process.env.CLAUDECODE = before;
    }
    assert.ok(Number.isInteger(launched.pid));
    assert.equal(launched.sessionId, 'sess-claude-1');
    assert.equal(launched.log, log);
    assert.deepEqual(fake.seen(), { argv: ['-p', 'Build it.', '--permission-mode', 'auto', '--model', 'sonnet', '--output-format', 'stream-json', '--verbose'], cwd: fs.realpathSync(dir), nested: null });
    assert.ok(fs.readFileSync(log, 'utf8').includes('sess-claude-1'), 'its output goes to the log');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("launchAgent runs codex exec in the worktree under workspace-write, with the site and the repo's .git writable and network on, and reads the session id from its banner", async () => {
  const dir = tmp('agent-codex-');
  try {
    const repo = path.join(dir, 'repo');
    const worktree = path.join(dir, 'wt');
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'start']);
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', worktree, '-b', 'A1']);
    const fake = fakeAgent(dir, 'codex', { stderr: 'OpenAI Codex v0.154.0\n--------\nworkdir: x\nsession id: 019a-codex-2\n--------\n', stays: true });
    const launched = await launchAgent({ kind: 'codex', bin: fake.bin, cwd: worktree, site: '/s/shop', prompt: 'Build it.', log: path.join(dir, 'A1.log'), sessionWait: Infinity });
    assert.equal(launched.sessionId, '019a-codex-2');
    assert.deepEqual(fake.seen().argv, [
      'exec', '--color', 'never', '--cd', worktree, '--sandbox', 'workspace-write',
      '--add-dir', '/s/shop', '--add-dir', path.join(fs.realpathSync(repo), '.git'),
      '-c', 'sandbox_workspace_write.network_access=true', 'Build it.',
    ]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('launchAgent gives no session id for an agent that exits without one, and rejects when the agent does not start', async () => {
  const dir = tmp('agent-none-');
  try {
    const fake = fakeAgent(dir, 'claude', { stdout: 'ran\n' });
    const launched = await launchAgent({ kind: 'claude', bin: fake.bin, model: 'opus', cwd: dir, site: dir, prompt: 'x', log: path.join(dir, 'A1.log') });
    assert.equal(launched.sessionId, null);
    await assert.rejects(launchAgent({ kind: 'claude', bin: path.join(dir, 'missing'), model: 'opus', cwd: dir, site: dir, prompt: 'x', log: path.join(dir, 'A2.log') }), /ENOENT/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// docs/adr/2026-11-13-2234-a-limit-a-person-sees-stays-and-its-test-passes-the-runner.md
test('launchAgent goes on without a session id once its session wait runs out, and the agent runs on', async () => {
  const dir = tmp('agent-wait-');
  const fake = path.join(dir, 'claude');
  fs.writeFileSync(fake, `#!${process.execPath}\n${untilTestEnds()}\n`);
  fs.chmodSync(fake, 0o755);
  let launched;
  try {
    launched = await launchAgent({ kind: 'claude', bin: fake, model: 'sonnet', cwd: dir, site: dir, prompt: 'x', log: path.join(dir, 'A1.log'), sessionWait: 0 });
    assert.equal(launched.sessionId, null);
    assert.doesNotThrow(() => process.kill(launched.pid, 0));
  } finally {
    if (launched) process.kill(launched.pid, 'SIGKILL');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('launchAgent stops watching the log once it has the session id, so the agent exiting after its log is gone throws nothing', async () => {
  const dir = tmp('agent-gone-');
  const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-gone', model: 'claude-sonnet', cwd: dir });
  const fake = fakeAgent(dir, 'claude', { stdout: `${init}\n`, stays: true });
  const launched = await launchAgent({ kind: 'claude', bin: fake.bin, model: 'sonnet', cwd: dir, site: dir, prompt: 'x', log: path.join(dir, 'logs', 'A1.log'), sessionWait: Infinity });
  assert.equal(launched.sessionId, 'sess-gone');
  fs.rmSync(dir, { recursive: true, force: true });
  process.kill(launched.pid);
  const thrown = [];
  const caught = (e) => thrown.push(e);
  process.on('uncaughtException', caught);
  try {
    await until(() => { try { process.kill(launched.pid, 0); return false; } catch { return true; } }, 'the agent never exited');
    await new Promise((r) => setTimeout(r, 200));
  } finally { process.off('uncaughtException', caught); }
  assert.deepEqual(thrown, []);
});

// docs/adr/2026-11-05-2200-the-hub-pulls-a-new-version-itself-and-offers-restart.md
test('an agent launched by a process that is then killed keeps running, as builders do across a hub restart', async () => {
  const dir = tmp('agent-detached-');
  try {
    const fake = fakeAgent(dir, 'claude', { stdout: `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', cwd: dir })}\n`, stays: true });
    const launcher = path.join(dir, 'launcher.mjs');
    fs.writeFileSync(launcher, `import { launchAgent } from ${JSON.stringify(new URL('./agents.mjs', import.meta.url).href)};
const { pid } = await launchAgent({ kind: 'claude', bin: ${JSON.stringify(fake.bin)}, model: 'sonnet', cwd: ${JSON.stringify(dir)}, site: '/s/x', prompt: 'p', log: ${JSON.stringify(path.join(dir, 'a.log'))} });
console.log(pid);
setInterval(() => {}, 1000);
`);
    const hub = spawn(process.execPath, [launcher], { stdio: ['ignore', 'pipe', 'inherit'] });
    const agentPid = Number(await new Promise((resolve) => hub.stdout.once('data', (d) => resolve(String(d).trim()))));
    hub.kill('SIGKILL');
    await new Promise((resolve) => hub.once('exit', resolve));
    assert.doesNotThrow(() => process.kill(agentPid, 0));
    process.kill(agentPid);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
