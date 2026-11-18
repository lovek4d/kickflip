import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { affectedTests, literalPaths, ownTests, testDependencies } from './affected.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

// docs/adr/2026-11-12-2104-lands-and-builders-run-only-the-tests-a-change-affects.md
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const put = (dir, file, text) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };

// A scratch repo on main: lib/a.mjs imports lib/b.mjs; a.test.mjs imports lib/a.mjs; spawn.test.mjs names hub/hub.mjs by
// path, which imports lib/c.mjs; page.test.mjs reads public/page.html, which loads public/ui.js; fixture.test.mjs uses
// a helper whose spawned scripts the map names; core.test.mjs is the always-run core; lone.test.mjs needs nothing.
function repo(t, map = {}) {
  const dir = tempDir('affected-');
  git(dir, 'init', '--quiet', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  put(dir, 'package.json', '{}\n');
  put(dir, 'lib/a.mjs', "import { b } from './b.mjs';\nexport const a = b;\n");
  put(dir, 'lib/b.mjs', 'export const b = 1;\n');
  put(dir, 'lib/c.mjs', 'export const c = 1;\n');
  put(dir, 'lib/unused.mjs', 'export const u = 1;\n');
  put(dir, 'hub/hub.mjs', "import '../lib/c.mjs';\n");
  put(dir, 'public/page.html', '<script src="ui.js"></script>\n');
  put(dir, 'public/ui.js', 'window.ui = 1;\n');
  put(dir, 'tools/run.mjs', 'process.exit(0);\n');
  put(dir, 'helper.mjs', "export const run = (name) => path.join(here, 'tools', name);\n");
  put(dir, 'a.test.mjs', "import { a } from './lib/a.mjs';\n");
  put(dir, 'spawn.test.mjs', "const hub = path.join(root, 'hub', 'hub.mjs');\n");
  put(dir, 'page.test.mjs', "const page = new URL('./public/page.html', import.meta.url);\n");
  put(dir, 'fixture.test.mjs', "import { run } from './helper.mjs';\nrun('run.mjs');\n");
  put(dir, 'core.test.mjs', '');
  put(dir, 'lone.test.mjs', '');
  put(dir, 'notes.md', '# notes\n');
  put(dir, 'board/test-map.json', JSON.stringify({ core: ['core.test.mjs'], full: ['shared-fixture.mjs'], paths: { 'helper.mjs': ['tools/'] }, ...map }));
  put(dir, 'shared-fixture.mjs', '');
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '-m', 'base');
  git(dir, 'switch', '--quiet', '-c', 'work');
  return dir;
}
const commit = (dir) => { git(dir, 'add', '-A'); git(dir, 'commit', '--quiet', '-m', 'change'); };

test('a change runs the tests that reach the changed file through imports, with the core, and no others', (t) => {
  const dir = repo(t);
  put(dir, 'lib/b.mjs', 'export const b = 2;\n');
  commit(dir);
  assert.deepEqual(affectedTests(dir, 'main'), { files: ['a.test.mjs', 'core.test.mjs'], full: null, touched: ['a.test.mjs'] });
});

test('the full suite names as touched only the tests the change reaches, so an untouched failure can be told from one the change made', (t) => {
  const dir = repo(t);
  put(dir, 'lib/b.mjs', 'export const b = 2;\n');
  put(dir, 'package.json', '{"x":1}\n');
  commit(dir);
  const { files, full, touched } = affectedTests(dir, 'main');
  assert.equal(files.length, 6);
  assert.match(full, /changed$/);
  assert.deepEqual(touched, ['a.test.mjs']);
});

test('a test reaches the files it names by path, joined from its literal segments, and what those import in turn', (t) => {
  const dir = repo(t);
  put(dir, 'lib/c.mjs', 'export const c = 2;\n');
  commit(dir);
  assert.deepEqual(affectedTests(dir, 'main').files, ['core.test.mjs', 'spawn.test.mjs']);
});

test('a page a test opens reaches the scripts the page loads', (t) => {
  const dir = repo(t);
  put(dir, 'public/ui.js', 'window.ui = 2;\n');
  commit(dir);
  assert.deepEqual(affectedTests(dir, 'main').files, ['core.test.mjs', 'page.test.mjs']);
});

test('the test map adds the paths a module builds at runtime, a folder meaning every file in it', (t) => {
  const dir = repo(t);
  put(dir, 'tools/run.mjs', 'process.exit(1);\n');
  commit(dir);
  assert.deepEqual(affectedTests(dir, 'main').files, ['core.test.mjs', 'fixture.test.mjs']);
});

test('a changed test runs itself, and uncommitted and untracked changes count', (t) => {
  const dir = repo(t);
  put(dir, 'lone.test.mjs', '// changed\n');
  put(dir, 'lib/new.mjs', 'export const n = 1;\n');
  put(dir, 'a.test.mjs', "import { a } from './lib/a.mjs';\nimport { n } from './lib/new.mjs';\n");
  assert.deepEqual(affectedTests(dir, 'main').files, ['a.test.mjs', 'core.test.mjs', 'lone.test.mjs']);
});

test('a markdown file no test names runs only the core', (t) => {
  const dir = repo(t);
  put(dir, 'notes.md', '# notes, edited\n');
  put(dir, 'docs/adr/2026-11-13-0500-x.md', '# x\n');
  commit(dir);
  assert.deepEqual(affectedTests(dir, 'main'), { files: ['core.test.mjs'], full: null, touched: [] });
});

test('the full suite runs for package files, CI, the selector, the shared fixture, a deleted or renamed file, or a file no test reaches', async (t) => {
  const all = ['a.test.mjs', 'core.test.mjs', 'fixture.test.mjs', 'lone.test.mjs', 'page.test.mjs', 'spawn.test.mjs'];
  const cases = [
    ['package.json', (dir) => put(dir, 'package.json', '{"x":1}\n')],
    ['package-lock.json', (dir) => put(dir, 'package-lock.json', '{}\n')],
    ['.github/workflows/test.yml', (dir) => put(dir, '.github/workflows/test.yml', 'on: push\n')],
    ['board/affected.mjs', (dir) => put(dir, 'board/affected.mjs', '')],
    ['board/test-map.json', (dir) => put(dir, 'board/test-map.json', '{}')],
    ['shared-fixture.mjs', (dir) => put(dir, 'shared-fixture.mjs', '// edited\n')],
    ['lib/c.mjs', (dir) => git(dir, 'rm', '--quiet', 'lib/c.mjs'), 'was deleted'],
    ['lib/b.mjs', (dir) => git(dir, 'mv', 'lib/b.mjs', 'lib/bee.mjs'), 'was renamed'],
    ['lib/unused.mjs', (dir) => put(dir, 'lib/unused.mjs', 'export const u = 2;\n'), 'reaches no test'],
  ];
  for (const [file, change, why = 'changed'] of cases) {
    await t.test(file, (t) => {
      const dir = repo(t);
      change(dir);
      commit(dir);
      const { files, full } = affectedTests(dir, 'main');
      assert.deepEqual({ files, full }, { files: all, full: `${file} ${why}` });
    });
  }
});

test('a repo with no test map runs the tests the change reaches, with no core', (t) => {
  const dir = repo(t);
  git(dir, 'rm', '--quiet', 'board/test-map.json');
  git(dir, 'commit', '--quiet', '-m', 'no map');
  git(dir, 'branch', '--quiet', '-f', 'main');
  put(dir, 'lib/b.mjs', 'export const b = 2;\n');
  commit(dir);
  assert.deepEqual(affectedTests(dir, 'main'), { files: ['a.test.mjs'], full: null, touched: ['a.test.mjs'] });
});

const BOARD = fileURLToPath(new URL('./bin/board.mjs', import.meta.url));
// HOME is a scratch one, so the run reads no busy state the hub's tick kept (shared/machine-gate.mjs) and never prints
// "waiting: the host is busy": its output doesn't depend on the host's load.
const testCommand = (dir) => execFileSync(process.execPath, [BOARD, 'test', '--dir', dir, '--base', 'main'], { encoding: 'utf8', env: { ...process.env, HOME: tempDir('affected-home-') } });

// docs/adr/2026-11-14-0600-builders-run-only-their-own-tests-and-the-land-runs-affected-once.md
test('a builder\'s own tests are the test files its change adds or edits, committed or not, and none it deleted', (t) => {
  const dir = repo(t);
  put(dir, 'a.test.mjs', "import { a } from './lib/a.mjs';\n// edited\n");
  put(dir, 'lib/b.mjs', 'export const b = 2;\n');
  git(dir, 'rm', '--quiet', 'spawn.test.mjs');
  commit(dir);
  put(dir, 'lone.test.mjs', '// edited, uncommitted\n');
  put(dir, 'new.test.mjs', '');
  assert.deepEqual(ownTests(dir, 'main'), ['a.test.mjs', 'lone.test.mjs', 'new.test.mjs']);
});

test('board.mjs test runs only the test files the worktree\'s change adds or edits and says so', (t) => {
  const dir = repo(t);
  put(dir, 'lib/b.mjs', 'export const b = 2;\n');
  put(dir, 'lone.test.mjs', "import test from 'node:test';\ntest('lone holds', () => {});\n");
  assert.equal(testCommand(dir), 'testing the 1 test file the change adds or edits; the land runs the tests it affects\ntests passed: 1\n');
});

test('board.mjs test with no test file changed runs nothing and passes', (t) => {
  const dir = repo(t);
  put(dir, 'lib/b.mjs', 'export const b = 2;\n');
  assert.equal(testCommand(dir), 'the change adds or edits no test file; the land runs the tests it affects\n');
});

test('board.mjs test fails naming each failing test', (t) => {
  const dir = repo(t);
  put(dir, 'a.test.mjs', "import test from 'node:test';\nimport { a } from './lib/a.mjs';\ntest('a holds', () => { throw new Error('no'); });\n");
  assert.throws(() => testCommand(dir), (e) => {
    assert.equal(e.status, 1);
    assert.equal(e.stdout, 'testing the 1 test file the change adds or edits; the land runs the tests it affects\n');
    assert.match(e.stderr, /^tests failed in .* \(1 failing\); fix them and run board\.mjs test again\na holds\n/);
    return true;
  });
});

test('the literal paths of a module are its quoted strings, single or joined in a run, that name a repo file', () => {
  const files = new Set(['board/domain.mjs', 'board/public/ui.js', 'hub/hub.mjs', 'SKILL.md']);
  const source = "import { x } from './domain.mjs';\npath.join(root, 'hub', 'hub.mjs');\nnew URL('./public/ui.js', import.meta.url);\nread('SKILL.md'); read('nope.mjs');";
  assert.deepEqual([...literalPaths('board/x.test.mjs', source, files)].sort(), ['SKILL.md', 'board/domain.mjs', 'board/public/ui.js', 'hub/hub.mjs']);
});

// The guard: a test that names a repo file in a quote, by any path, has that file in its computed set, so a file reached
// only through a path built at runtime needs a line in board/test-map.json. A bare name counts when only one repo file
// has it. OTHER lists the names a test quotes that aren't that repo file: a scratch file of the same name, a URL a
// server is checked to refuse, a path outside the repo, or words in a title or a fixture.
const OTHER = new Set([
  'board/headless.test.mjs SKILL.md', 'board/phases.test.mjs colors.css',
  'board/progress-review.test.mjs claude.js', 'board/ui.test.mjs sw.js', 'board/ui.test.mjs boards.mjs',
  'shared/service.test.mjs hub.mjs', 'hub/files.test.mjs index.html', 'hooks-plugin/hooks/waits-filter-gate.test.mjs wait-events.mjs',
  ...['sw.js', 'app.js', 'colors.css', 'kickflip.png', 'icon-180.png', 'style.css', 'prototype-kit.js', 'log.html'].map((name) => `hub/share.test.mjs ${name}`),
]);
test('every repo file a test names in a quote is in its computed set', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const deps = testDependencies(root);
  const tracked = git(root, 'ls-files', '--cached', '--others', '--exclude-standard').split('\n').filter(Boolean);
  const byName = new Map();
  for (const file of tracked) byName.set(path.basename(file), [...(byName.get(path.basename(file)) ?? []), file]);
  const missing = [];
  for (const [testFile, set] of deps) {
    const source = fs.readFileSync(path.join(root, testFile), 'utf8');
    for (const [, name] of source.matchAll(/['"`/]([\w.-]+\.(?:mjs|js|css|html|md|json|png))['"`]/g)) {
      const owners = byName.get(name);
      if (!owners || owners.length > 1 || OTHER.has(`${testFile} ${name}`) || owners[0].endsWith('.test.mjs')) continue;
      if (!set.has(owners[0])) missing.push(`${testFile} names ${name} (${owners[0]})`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});
