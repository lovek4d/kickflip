import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// docs/adr/2026-11-14-1217-test-runs-wait-while-the-host-is-busy-and-leave-nothing-behind.md
// A test makes its temp dirs only through shared/temp-dir.mjs tempDir, which removes them as the test process exits.
// A test source is a *.test.mjs or *.bench.mjs file, or a module only test sources import; a line of one, outside a
// // comment, that makes a dir (mkdtemp or mkdir) in the system temp dir (os.tmpdir or TMPDIR) fails here.
const TEMP = /\bmkd(?:temp|ir)\w*\s*\(.*(?:\btmpdir\s*\(|\bTMPDIR\b)/;
const HELPER = 'shared/temp-dir.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const self = path.relative(root, fileURLToPath(import.meta.url));

const tempLines = (source) => source.split('\n').map((line, i) => [i + 1, line]).filter(([, line]) => !line.trimStart().startsWith('//') && TEMP.test(line));

// The repo-relative modules a source imports by a relative path.
const importsOf = (file, source) => [...source.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)]
  .map((m) => path.relative(root, path.resolve(root, path.dirname(file), m[1])));

// Each test source in the repo: the test and bench files, and the modules only test sources import.
function testSources() {
  const files = execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '*.mjs'], { encoding: 'utf8' })
    .split('\n').filter((f) => f && !/(^|\/)(\.repos|node_modules)\//.test(f) && fs.existsSync(path.join(root, f)));
  const isTest = (f) => /\.(test|bench)\.mjs$/.test(f);
  const importers = new Map();
  for (const file of files) {
    for (const dep of importsOf(file, fs.readFileSync(path.join(root, file), 'utf8'))) importers.set(dep, [...(importers.get(dep) ?? []), file]);
  }
  // A module imported only by test sources is one too, so a fixture's own helpers count.
  const sources = new Set(files.filter(isTest));
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of files) if (!sources.has(f) && importers.get(f)?.every((by) => sources.has(by))) { sources.add(f); grew = true; }
  }
  return [...sources].filter((f) => f !== self && f !== HELPER);
}

test('a line making a dir in the system temp dir counts, and not in a comment, under a test home or as a cwd', () => {
  assert.deepEqual(tempLines([
    "const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'));",
    "await fsp.mkdtemp(join(tmpdir(), 'x-'));",
    "fs.mkdirSync(path.join(process.env.TMPDIR, 'x'), { recursive: true });",
    "// fs.mkdtempSync(path.join(os.tmpdir(), 'x-')) in a comment",
    "const own = fs.mkdtempSync(path.join(home, 'case-'));",
    "const dir = tempDir('x-');",
    "spawnSync('claude', [], { cwd: os.tmpdir() });",
  ].join('\n')).map(([n]) => n), [1, 2, 3]);
});

test('the test sources are the test and bench files and the modules only test sources import', () => {
  const sources = testSources();
  assert.ok(sources.includes('board/board-fixture.mjs'), 'a fixture only tests import');
  assert.ok(sources.includes('shared/test-helpers.mjs'));
  assert.ok(!sources.includes('board/worktree.mjs'), 'a module the product imports is not a test source');
});

test('no test source makes a temp dir but through tempDir, which removes it', () => {
  const found = testSources().flatMap((file) => tempLines(fs.readFileSync(path.join(root, file), 'utf8')).map(([n, line]) => `${file}:${n}: ${line.trim()}`));
  assert.deepEqual(found, [], `make a test's temp dir with ${HELPER} tempDir(prefix), so it goes when the test process exits`);
});
