import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../shared/temp-dir.mjs';

const script = fileURLToPath(new URL('./release', import.meta.url));

// docs/adr/2026-11-16-0200-a-repos-kickflip-release-replaces-lands-tag-release.md
test("kickflip's .kickflip/release checks package.json's version and that v<version> is new here and on origin, and ship tags the commit and pushes the tag", () => {
  const home = tempDir('kickflip-release-');
  const [repo, origin] = [path.join(home, 'repo'), path.join(home, 'origin.git')];
  const git = (cwd, ...args) => {
    const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const run = (...args) => spawnSync(script, args, { cwd: repo, encoding: 'utf8' });
  const release = (version) => {
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'x', version }) + '\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--quiet', '-m', `chore(release): ${version}`);
    return git(repo, 'rev-parse', 'HEAD');
  };
  git(home, 'init', '--quiet', '--bare', origin);
  git(home, 'init', '--quiet', '-b', 'main', repo);
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'remote', 'add', 'origin', origin);

  const first = release('0.1.0');
  const ok = run('check', '0.1.0', first);
  assert.equal(ok.status, 0, ok.stderr);

  const mismatch = run('check', '0.2.0', first);
  assert.equal(mismatch.status, 1);
  assert.equal(mismatch.stderr, `package.json's version at ${first} is 0.1.0, not 0.2.0; bump it with node scripts/release.mjs 0.2.0 --ref <ref>\n`);

  const shipped = run('ship', '0.1.0', first);
  assert.equal(shipped.status, 0, shipped.stderr);
  assert.equal(shipped.stdout, `tagged v0.1.0 at ${first} and pushed it to origin\n`);
  assert.equal(git(origin, 'rev-parse', 'v0.1.0^{commit}'), first);

  const again = run('check', '0.1.0', first);
  assert.equal(again.status, 1);
  assert.equal(again.stderr, 'tag v0.1.0 already exists here; release another version\n');

  const second = release('0.2.0');
  git(origin, 'tag', 'v0.2.0', first);
  const onOrigin = run('check', '0.2.0', second);
  assert.equal(onOrigin.status, 1);
  assert.equal(onOrigin.stderr, 'tag v0.2.0 already exists on origin; release another version\n');

  const usage = run('publish', '0.2.0', second);
  assert.equal(usage.status, 2);
  assert.equal(usage.stderr, 'usage: .kickflip/release check|ship <version> <commit>\n');
});
