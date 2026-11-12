import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'release.mjs');

// docs/adr/2026-11-11-1700-commits-are-conventional-and-name-their-card-in-a-refs-trailer.md
test('the release script commits "chore(release): X.Y.Z" listing the subjects since the last v* tag, oldest first, and tags vX.Y.Z', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'release-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'x', version: '0.1.0' }, null, 2) + '\n');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'chore(release): 0.1.0');
  git('tag', 'v0.1.0');
  for (const [file, subject] of [['a', 'feat(board): one'], ['b', 'fix: two']]) {
    fs.writeFileSync(path.join(repo, file), file);
    git('add', '-A');
    git('commit', '--quiet', '-m', `${subject}\n\nRefs: #1`);
  }
  assert.equal(spawnSync(process.execPath, [script, '0.2'], { cwd: repo, encoding: 'utf8' }).stderr, 'usage: node scripts/release.mjs <x.y.z>\n');
  const r = spawnSync(process.execPath, [script, '0.2.0'], { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git('log', '-1', '--format=%B'), 'chore(release): 0.2.0\n\n- feat(board): one\n- fix: two');
  assert.equal(git('describe', '--tags', '--exact-match'), 'v0.2.0');
  assert.equal(JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version, '0.2.0');
  fs.rmSync(repo, { recursive: true, force: true });
});
