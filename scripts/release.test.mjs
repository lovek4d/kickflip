import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'release.mjs');

// docs/adr/2026-11-11-1700-commits-are-conventional-and-name-their-card-in-a-refs-trailer.md
// docs/adr/2026-11-12-1251-land-tags-a-release-commit-and-pushes-the-tag.md
test('the release script bumps the version and commits "chore(release): X.Y.Z" listing the subjects since the last v* tag, oldest first, with its card\'s Refs trailer, and leaves the tag to land', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'release-'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'x', version: '0.1.0' }, null, 2) + '\n');
  fs.writeFileSync(path.join(repo, 'package-lock.json'), JSON.stringify({ name: 'x', version: '0.1.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'x', version: '0.1.0' } } }, null, 2) + '\n');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'chore(release): 0.1.0');
  git('tag', 'v0.1.0');
  for (const [file, subject] of [['a', 'feat(board): one'], ['b', 'fix: two']]) {
    fs.writeFileSync(path.join(repo, file), file);
    git('add', '-A');
    git('commit', '--quiet', '-m', `${subject}\n\nRefs: #1`);
  }
  const usage = 'usage: node scripts/release.mjs <x.y.z> --ref <ref>\n';
  assert.equal(spawnSync(process.execPath, [script, '0.2', '--ref', '#9'], { cwd: repo, encoding: 'utf8' }).stderr, usage);
  assert.equal(spawnSync(process.execPath, [script, '0.2.0'], { cwd: repo, encoding: 'utf8' }).stderr, usage);
  const r = spawnSync(process.execPath, [script, '0.2.0', '--ref', '#9'], { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git('log', '-1', '--format=%B'), 'chore(release): 0.2.0\n\n- feat(board): one\n- fix: two\n\nRefs: #9');
  assert.equal(git('tag', '--points-at', 'HEAD'), '', 'land tags the release once it lands');
  assert.equal(git('status', '--porcelain'), '');
  const shown = (file) => JSON.parse(git('show', `HEAD:${file}`));
  assert.deepEqual([shown('package.json').version, shown('package-lock.json').version], ['0.2.0', '0.2.0']);
  fs.rmSync(repo, { recursive: true, force: true });
});
