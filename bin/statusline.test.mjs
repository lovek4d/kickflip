import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { statusLine } from './statusline.mjs';

const script = fileURLToPath(new URL('./statusline.mjs', import.meta.url));
let home;
beforeEach(() => { home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kickflip-statusline-'))); });
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
const env = () => ({ ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' });
const usageFile = () => path.join(home, '.claude', 'kickflip', 'usage.json');
const run = (input, overrides = {}) => {
  const result = spawnSync(process.execPath, [script], {
    input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: env(), ...overrides,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
};

test('status line prints the exact directory, branch, model and context for clean, unstaged and staged repos', () => {
  const repo = path.join(home, 'dev', 'kickflip');
  fs.mkdirSync(repo, { recursive: true });
  // All Git mutations in this test target its temporary fixture, never the worktree.
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { env: env(), stdio: 'ignore' });
  git('init', '-b', 'feature');
  const tracked = path.join(repo, 'tracked');
  fs.writeFileSync(tracked, 'original\n');
  git('add', 'tracked');
  git('commit', '-m', 'fixture');
  // The line's own git calls have a 500 ms limit so a slow repo never holds up a redraw; here git runs with none, so a
  // loaded host can't drop the branch or the *.
  const untimed = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...env(), GIT_OPTIONAL_LOCKS: '0' } });
  const inRepo = (input, expected) => assert.equal(statusLine(input, { git: untimed }), expected);
  const input = { cwd: repo, model: { display_name: 'Opus 4.6' }, context_window: { used_percentage: 42 } };
  inRepo(input, 'dev/kickflip feature · Opus 4.6 / 42% ctx');
  fs.writeFileSync(path.join(repo, 'untracked'), 'untracked files do not count');
  inRepo(input, 'dev/kickflip feature · Opus 4.6 / 42% ctx');
  fs.writeFileSync(tracked, 'changed\n');
  inRepo(input, 'dev/kickflip feature* · Opus 4.6 / 42% ctx');
  inRepo({ ...input, rate_limits: { five_hour: { used_percentage: 81 }, seven_day: { used_percentage: 78 } } }, 'dev/kickflip feature* · Opus 4.6 / 42% ctx · 5h: 81% / 7d: 78%');
  git('add', 'tracked');
  inRepo(input, 'dev/kickflip feature* · Opus 4.6 / 42% ctx');
  git('commit', '-m', 'second fixture');
  git('checkout', '--detach', 'HEAD');
  inRepo(input, 'dev/kickflip · Opus 4.6 / 42% ctx');
});

test('status line shortens slash-separated directories and omits absent fields, including outside Git', () => {
  for (const [cwd, dir] of [[home, '~'], [path.join(home, 'dev'), '~/dev'], [path.join(home, 'dev', 'kickflip'), 'dev/kickflip'], ['/one/two/three', 'two/three'], ['/one', '/one'], ['/', '/'], [home + '-other/child', path.basename(home) + '-other/child']]) {
    assert.equal(run({ cwd }), dir + '\n');
  }
  assert.equal(fs.existsSync(usageFile()), false, 'a line without rate limits saves no usage');
  assert.equal(run({ model: { display_name: 'Sonnet' }, context_window: { used_percentage: 0 } }), 'Sonnet / 0% ctx\n');
  assert.equal(run({ context_window: { used_percentage: 12.5 } }), '12% ctx\n');
  assert.equal(run({ model: { display_name: 'Opus 5.5' }, context_window: { used_percentage: 41.7 }, rate_limits: { five_hour: { used_percentage: 23.4, resets_at: 1793580000 }, seven_day: { used_percentage: 57, resets_at: 1794003836 } } }), 'Opus 5.5 / 41% ctx · 5h: 23% / 7d: 57%\n');
  assert.equal(run({ rate_limits: { seven_day: { used_percentage: 99.9 } } }), '7d: 99%\n');
  assert.equal(run({ model: { display_name: 'Opus' }, rate_limits: { five_hour: { used_percentage: 0 }, seven_day: { used_percentage: 'bad' } } }), 'Opus · 5h: 0%\n');
  assert.equal(run({ cwd: '/one/two/three', rate_limits: { five_hour: { used_percentage: 81 } } }), 'two/three · 5h: 81%\n');
  assert.equal(run({ cwd: '/one/two/three', context_window: { used_percentage: 20 }, rate_limits: { seven_day: { used_percentage: 78 } } }), 'two/three · 20% ctx · 7d: 78%\n');
  assert.equal(run({ cwd: '/one/two/three', model: { display_name: 'Opus 5.5' } }), 'two/three · Opus 5.5\n');
  assert.equal(run({ context_window: { used_percentage: null } }), '\n');
  assert.equal(run({}), '\n');
});

test('status line writes normalized Claude usage atomically, preserving other top-level data', () => {
  fs.mkdirSync(path.dirname(usageFile()), { recursive: true });
  const codex = { five_hour: { used_percentage: 15 }, at: '2026-11-01T12:00:00Z' };
  fs.writeFileSync(usageFile(), JSON.stringify({ codex, extra: { keep: true }, claude: { old: true } }));
  const inode = fs.statSync(usageFile()).ino;
  const resets = 1793552400;
  const iso = '2026-11-07T17:00:00.000Z';
  const before = Date.now();
  assert.equal(run({ model: { display_name: 'Opus' }, session_id: 'session-1', rate_limits: {
    five_hour: { used_percentage: 42, resets_at: resets }, seven_day: { used_percentage: '7.5', resets_at: iso },
  } }), 'Opus · 5h: 42% / 7d: 7%\n');
  const data = JSON.parse(fs.readFileSync(usageFile(), 'utf8'));
  assert.deepEqual(data.codex, codex);
  assert.deepEqual(data.extra, { keep: true });
  assert.deepEqual(data.claude.five_hour, { used_percentage: 42, resets_at: new Date(resets * 1000).toISOString(), resets_at_raw: resets });
  assert.deepEqual(data.claude.seven_day, { used_percentage: 7.5, resets_at: iso, resets_at_raw: iso });
  assert.equal(data.claude.session, 'session-1');
  assert.ok(Date.parse(data.claude.at) >= before && Date.parse(data.claude.at) <= Date.now());
  assert.equal(data.claude.old, undefined);
  assert.notEqual(fs.statSync(usageFile()).ino, inode);
  assert.deepEqual(fs.readdirSync(path.dirname(usageFile())), ['usage.json']);
});

test('usage is created only with rate_limits and absent or malformed limits leave existing usage untouched', () => {
  assert.equal(run({ model: { display_name: 'Opus' } }), 'Opus\n');
  assert.equal(fs.existsSync(path.join(home, '.claude')), false);
  run({ rate_limits: { five_hour: { used_percentage: 0, resets_at: '1793552400' } } });
  const data = JSON.parse(fs.readFileSync(usageFile(), 'utf8'));
  assert.deepEqual(data.claude.five_hour, { used_percentage: 0, resets_at: new Date(1793552400 * 1000).toISOString(), resets_at_raw: '1793552400' });
  assert.equal(data.claude.seven_day, null);
  assert.equal(data.claude.session, undefined);
  const before = fs.readFileSync(usageFile(), 'utf8');
  for (const input of [{}, { rate_limits: null }, { rate_limits: 'bad' }, { rate_limits: [] }, '{bad', 'null']) {
    run(input);
    assert.equal(fs.readFileSync(usageFile(), 'utf8'), before);
  }
});

test('bad stdin and filesystem failures are silent and always exit zero', () => {
  for (const input of ['', 'bad JSON', 'null', '42', '[]']) assert.equal(run(input), '');
  fs.writeFileSync(path.join(home, '.claude'), 'blocks the usage directory');
  assert.equal(run({ model: { display_name: 'Opus' }, rate_limits: { five_hour: { used_percentage: 42 } } }), 'Opus · 5h: 42%\n');
  assert.equal(fs.readFileSync(path.join(home, '.claude'), 'utf8'), 'blocks the usage directory');
});

test('usage tolerates corrupt old data and invalid percentages and reset timestamps', () => {
  fs.mkdirSync(path.dirname(usageFile()), { recursive: true });
  for (const old of ['{bad', 'null', '[]']) {
    fs.writeFileSync(usageFile(), old);
    run({ rate_limits: { five_hour: { used_percentage: 'bad', resets_at: 'invalid' }, seven_day: { used_percentage: '', resets_at: 1e30 } } });
    const { claude } = JSON.parse(fs.readFileSync(usageFile(), 'utf8'));
    assert.deepEqual(claude.five_hour, { used_percentage: null, resets_at: null, resets_at_raw: 'invalid' });
    assert.deepEqual(claude.seven_day, { used_percentage: null, resets_at: null, resets_at_raw: 1e30 });
  }
});

test('status line flushes output before attempting a blocked usage read', async () => {
  // A FIFO keeps the usage read waiting, proving the line already reached stdout.
  if (process.platform === 'win32') return;
  fs.mkdirSync(path.dirname(usageFile()), { recursive: true });
  execFileSync('mkfifo', [usageFile()]);
  const child = spawn(process.execPath, [script], { env: env(), stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    child.stdin.end(JSON.stringify({ model: { display_name: 'Opus' }, rate_limits: {} }));
    const [data] = await once(child.stdout, 'data');
    assert.equal(data.toString(), 'Opus\n');
    assert.equal(child.exitCode, null);
  } finally {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
  }
});

test('status line saves each session\'s context percentage by session id, atomically, and only with both', () => {
  const dir = path.join(home, '.claude', 'kickflip', 'context');
  const before = Date.now();
  assert.equal(run({ session_id: 'abc-1', context_window: { used_percentage: 62.7 } }), '62% ctx\n');
  assert.equal(run({ session_id: 'def_2', context_window: { used_percentage: 5 } }), '5% ctx\n');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'abc-1.json'), 'utf8'));
  assert.equal(saved.percent, 62);
  assert.ok(Date.parse(saved.at) >= before && Date.parse(saved.at) <= Date.now());
  run({ session_id: 'abc-1', context_window: { used_percentage: 70 } });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'abc-1.json'), 'utf8')).percent, 70);
  run({ session_id: 'abc-1', context_window: { used_percentage: null } });
  run({ context_window: { used_percentage: 40 } });
  run({ session_id: '../escape', context_window: { used_percentage: 40 } });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['abc-1.json', 'def_2.json']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'abc-1.json'), 'utf8')).percent, 70);
  assert.equal(fs.existsSync(usageFile()), false);
});
