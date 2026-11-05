import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transcriptMovedAt } from './transcript.mjs';

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
