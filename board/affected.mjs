// The tests a change affects: the test files of a repo whose computed set reaches a file the change touches
// (docs/adr/2026-11-12-2104-lands-and-builders-run-only-the-tests-a-change-affects.md).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// A change to one of these runs the full suite: what installs the code, what runs it in CI, and the selector itself.
const FULL = ['package.json', 'package-lock.json', '.github/', 'board/affected.mjs', 'board/test-map.json'];
const MODULE = /\.(mjs|js)$/;
const IMPORT = /\b(?:from|import)\s*\(?\s*(['"])(\.{1,2}\/[^'"\n]+)\1/g;
const MAP = 'board/test-map.json';

function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${dir}: ${r.stderr.trim()}`);
  return r.stdout.split('\n').filter(Boolean);
}

const STRING = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;

// The repo files a module names in its quoted strings: each string, and each run of strings separated only by commas
// (path.join(root, 'hub', 'hub.mjs')) joined with slashes, from any string of the run to its end, resolved from
// the module's folder and from the repo root. An import specifier is a quoted string, so imports are among them. A
// string written as ./ or ../ and a name, that names a folder, names every file in it; a template string counts up to
// its first ${}, so `./public/${file}` names the files in public.
export function literalPaths(file, source, files) {
  const found = new Set();
  const here = path.posix.dirname(file);
  const add = (candidate) => {
    if (!candidate || candidate.length > 200 || candidate.startsWith('/') || /^[a-z]+:/i.test(candidate)) return;
    for (const from of [here, '.']) {
      const at = path.posix.normalize(path.posix.join(from, candidate)).replace(/\/$/, '');
      if (files.has(at)) found.add(at);
      else if (/^\.\.?\/(\.\.\/)*[^./]/.test(candidate) && !at.startsWith('..')) {
        for (const f of files) if (f.startsWith(`${at}/`)) found.add(f);
      }
    }
  };
  let run = [];
  let end = 0;
  const close = () => { for (let i = 0; i < run.length; i++) { add(run[i]); add(run.slice(i).join('/')); } };
  for (const m of source.matchAll(STRING)) {
    if (!/^\s*,\s*$/.test(source.slice(end, m.index))) { close(); run = []; }
    run.push(m[1] ?? m[2] ?? m[3].split('${')[0]);
    end = m.index + m[0].length;
  }
  close();
  return found;
}

// The repo's board/test-map.json: {core: tests every run includes, full: files whose change runs the full suite, paths:
// {module: files it builds the path of at runtime, a name ending in / meaning every file in that folder}}.
function testMap(dir) {
  const file = path.join(dir, MAP);
  const map = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  return { core: map.core ?? [], full: map.full ?? [], paths: map.paths ?? {} };
}

// The repo's files, tracked or untracked and not ignored, outside other repos' clones (.repos) and installed packages.
const repoFiles = (dir) => new Set(git(dir, 'ls-files', '--cached', '--others', '--exclude-standard')
  .filter((f) => !/(^|\/)(\.repos|node_modules)\//.test(f) && fs.existsSync(path.join(dir, f))));

// The repo files a module imports by a relative specifier, statically or with import().
export function importPaths(file, source, files) {
  const here = path.posix.dirname(file);
  return new Set([...source.matchAll(IMPORT)].map((m) => path.posix.join(here, m[2])).filter((f) => files.has(f)));
}

// Each test file of the repo at dir → the set of repo files it reaches: itself and, from each file reached, the paths a
// test or a page names (literalPaths), the files a module imports, and the files the map adds for it. A module's other
// quoted paths aren't followed: code that stores or serves a path doesn't run it.
export function testDependencies(dir, files = repoFiles(dir), map = testMap(dir)) {
  const edges = new Map();
  const named = (file) => {
    if (!edges.has(file)) {
      const read = () => fs.readFileSync(path.join(dir, file), 'utf8');
      const out = file.endsWith('.test.mjs') || file.endsWith('.html') ? literalPaths(file, read(), files)
        : MODULE.test(file) ? importPaths(file, read(), files) : new Set();
      for (const entry of map.paths[file] ?? []) {
        for (const f of files) if (entry.endsWith('/') ? f.startsWith(entry) : f === entry) out.add(f);
      }
      edges.set(file, out);
    }
    return edges.get(file);
  };
  const deps = new Map();
  for (const test of [...files].filter((f) => f.endsWith('.test.mjs')).sort()) {
    const seen = new Set([test]);
    const todo = [test];
    while (todo.length) for (const next of named(todo.pop())) if (!seen.has(next)) { seen.add(next); todo.push(next); }
    deps.set(test, seen);
  }
  return deps;
}

// The test files to run for the change in the worktree at dir since its merge base with base: its commits, its
// uncommitted edits and its untracked files. → {files, full}, the files repo-relative and sorted; full is null, or why
// every test file runs: a change to a FULL file or one of the map's full files, a deleted or renamed file, or a changed
// file no test reaches. A markdown file no test reaches needs none. The map's core tests are always among the files.
export function affectedTests(dir, base) {
  const [since] = git(dir, 'merge-base', base, 'HEAD');
  const files = repoFiles(dir);
  const map = testMap(dir);
  const deps = testDependencies(dir, files, map);
  const all = [...deps.keys()];
  const changed = [];
  let broad = null;
  for (const line of git(dir, 'diff', '--name-status', '-M', since)) {
    const [status, file] = line.split('\t');
    if (status === 'D') return { files: all, full: `${file} was deleted`, touched: all };
    if (status.startsWith('R')) return { files: all, full: `${file} was renamed`, touched: all };
    changed.push(file);
  }
  changed.push(...git(dir, 'ls-files', '--others', '--exclude-standard'));
  const run = new Set(map.core);
  const touched = new Set();
  for (const file of [...new Set(changed)].sort()) {
    const reached = all.filter((test) => deps.get(test).has(file));
    for (const test of reached) touched.add(test);
    if ([...FULL, ...map.full].some((f) => (f.endsWith('/') ? file.startsWith(f) : file === f))) broad ??= `${file} changed`;
    else if (!reached.length && !file.endsWith('.md')) broad ??= `${file} reaches no test`;
    for (const test of reached) run.add(test);
  }
  // A broad change runs every file, but only the files it reaches are ones it touched.
  return { files: broad ? all : [...run].sort(), full: broad, touched: [...touched].sort() };
}
