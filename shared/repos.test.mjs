import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cloneRoot, reposDir } from './repos.mjs';
import { skillRepo } from '../board/worktree.mjs';

test('reposDir belongs to the running clone and accepts another root without creating it', () => {
  assert.equal(reposDir(), path.join(cloneRoot(), '.repos'));
  assert.equal(skillRepo(), cloneRoot());
  assert.equal(reposDir('/scratch/kickflip'), '/scratch/kickflip/.repos');
});

test('the clone paths and default builder repo work directly and through installed links in a temp HOME', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kickflip-paths-')));
  const root = path.join(home, 'dev', 'kickflip clone');
  const env = { ...process.env, HOME: home };
  const run = (command, args) => {
    const result = spawnSync(command, args, { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  try {
    fs.mkdirSync(root, { recursive: true });
    for (const dir of ['bin', 'board', 'hub', 'shared', 'hooks-plugin']) {
      fs.cpSync(path.join(cloneRoot(), dir), path.join(root, dir), { recursive: true, filter: (file) => !file.endsWith('.test.mjs') });
    }
    run('git', ['-C', root, 'init', '--quiet', '-b', 'main']);
    run('git', ['-C', root, 'add', '.']);
    run('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'base']);
    const installer = path.join(root, 'install-probe.mjs');
    fs.writeFileSync(installer, "import { installLinks } from './bin/install.mjs';\ninstallLinks();\n");
    run(process.execPath, [installer]);
    const linked = path.join(home, '.claude', 'skills', 'join-web-ts');
    const probe = path.join(root, 'paths-probe.mjs');
    fs.writeFileSync(probe, [
      "import { cloneRoot, reposDir } from './shared/repos.mjs';",
      "import { skillRepo } from './board/worktree.mjs';",
      "import { BG_SETTINGS, hubArgv } from './hub/sessions.mjs';",
      "import './board/domain.mjs';",
      "console.log(JSON.stringify({ root: cloneRoot(), repos: reposDir(), repo: skillRepo(), settings: BG_SETTINGS, hub: hubArgv({route: 'hub'}) }));",
    ].join('\n'));
    for (const entry of [root, linked]) {
      const found = JSON.parse(run(process.execPath, [path.join(entry, 'paths-probe.mjs')]));
      assert.deepEqual([found.root, found.repos, found.repo], [root, path.join(root, '.repos'), root]);
      assert.ok(found.settings.includes(path.join(root, 'hub', 'permission-hook.mjs')));
      assert.ok(found.hub.at(-1).includes(path.join(root, 'docs', 'hub-session.md')));
      assert.match(run(process.execPath, [path.join(entry, 'bin', 'web-ts.mjs')]), /web-ts install/);
      const wave = path.join(home, '.claude', 'waves', 'w');
      fs.mkdirSync(wave, { recursive: true });
      fs.writeFileSync(path.join(wave, 'wave.json'), JSON.stringify({ title: 'W', items: [{ id: 'A1', title: 'One' }] }));
      assert.match(run(process.execPath, [path.join(entry, 'board', 'bin', 'board.mjs'), 'builder', 'start', 'w/A1', '--worktree']), /worktree:/);
      const record = JSON.parse(fs.readFileSync(path.join(wave, 'agents', 'A1.json'), 'utf8'));
      assert.equal(record.worktree.repo, root);
      run('git', ['-C', root, 'worktree', 'remove', record.worktree.path]);
      run('git', ['-C', root, 'branch', '-D', 'A1']);
      fs.rmSync(path.join(wave, 'agents'), { recursive: true });
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
