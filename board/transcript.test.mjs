import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transcriptMovedAt, transcriptCommandRunning } from './transcript.mjs';

test("a worktree's transcript movement is the newest .jsonl in its Claude projects folder, and null when there is none", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-'));
  const worktree = '/Users/x/.claude/kickflip/worktrees/GH-1';
  const folder = path.join(home, '.claude', 'projects', '-Users-x--claude-kickflip-worktrees-GH-1');
  assert.equal(transcriptMovedAt(worktree, home), null);
  fs.mkdirSync(folder, { recursive: true });
  assert.equal(transcriptMovedAt(worktree, home), null);
  for (const [name, time] of [['a.jsonl', 1000], ['b.jsonl', 3000], ['c.txt', 5000]]) {
    fs.writeFileSync(path.join(folder, name), '');
    fs.utimesSync(path.join(folder, name), time, time);
  }
  assert.equal(transcriptMovedAt(worktree, home), 3000000);
});

test("a worktree recorded through a link is found under its real path's projects folder, where Claude Code writes its transcript", () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-')));
  const real = path.join(home, '.claude', 'kickflip', 'checkouts.noindex', 'worktrees');
  fs.mkdirSync(path.join(real, 'GH-3'), { recursive: true });
  fs.symlinkSync(real, path.join(home, '.claude', 'kickflip', 'worktrees'));
  const folder = path.join(home, '.claude', 'projects', path.join(real, 'GH-3').replace(/[/.]/g, '-'));
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'a.jsonl'), '');
  fs.utimesSync(path.join(folder, 'a.jsonl'), 2000, 2000);
  assert.equal(transcriptMovedAt(path.join(home, '.claude', 'kickflip', 'worktrees', 'GH-3'), home), 2000000);
});

test("a transcript whose last message is a tool call with no result yet reads as a command running, and its movement stays the file mtime", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-'));
  const worktree = '/Users/x/.claude/kickflip/worktrees/GH-2';
  const folder = path.join(home, '.claude', 'projects', '-Users-x--claude-kickflip-worktrees-GH-2');
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 'a.jsonl');
  const call = { message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } };
  const result = { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } };
  const other = { type: 'api-request' };
  const write = (...entries) => { fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n'); fs.utimesSync(file, 1000, 1000); };
  const reading = () => [transcriptCommandRunning(worktree, home), transcriptMovedAt(worktree, home)];
  write(call);
  assert.deepEqual(reading(), [true, 1_000_000]);
  write(call, other);
  assert.deepEqual(reading(), [true, 1_000_000]);
  write(call, result);
  assert.deepEqual(reading(), [false, 1_000_000]);
  write(result, call, other);
  fs.appendFileSync(file, '{"message":');
  fs.utimesSync(file, 1000, 1000);
  assert.deepEqual(reading(), [true, 1_000_000]);
});
