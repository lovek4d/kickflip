import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { kickflipHas, repoHas, onboardingItems } from './onboarding.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

const dir = () => tempDir('onboarding-');
const SCRIPTS = 'Choose the test, build and release scripts to set up';
const CONTEXT = "Write the repo's CONTEXT.md glossary and first ADR";
const titles = (items) => items.map((i) => i.title);
const notesOf = (d, items) => items.map((i) => fs.readFileSync(path.join(d, i.plan), 'utf8'));
const scriptsNotes = (has) => {
  const d = dir();
  const [scripts] = onboardingItems(path.join(d, 'wave.json'), { has });
  assert.equal(scripts.title, SCRIPTS);
  return fs.readFileSync(path.join(d, scripts.plan), 'utf8');
};
// The questions the scripts card's notes give its grill to post: the notes' one json block.
const questionsOf = (notes) => JSON.parse(/```json\n([\s\S]*?)\n```/.exec(notes)[1]);
const existing = (q) => q.options.filter((o) => o.existing).map((o) => o.id);
const recommended = (q) => q.options.filter((o) => o.recommended).map((o) => o.id);

test('onboarding cards are filed grilling as tasks keyed T-<n> with no ticket, each with a notes file', () => {
  const d = dir();
  const items = onboardingItems(path.join(d, 'wave.json'), { has: {} });
  assert.deepEqual(items.map((i) => [i.id, i.phase, i.ticket, i.plan]), [['T-1', 'grilling', undefined, 'T-1-notes.md'], ['T-2', 'grilling', undefined, 'T-2-notes.md']]);
  for (const i of items) assert.match(fs.readFileSync(path.join(d, i.plan), 'utf8'), /^# /);
});

// docs/adr/2026-11-23-1730-onboarding-asks-per-script-and-files-a-task-for-each.md
test('the scripts card asks one question per script, test, build and release, each Create in repo, Create in kickflip or Don\'t create', () => {
  const notes = scriptsNotes({});
  assert.match(notes, new RegExp(`^# ${SCRIPTS}\\n`));
  const qs = questionsOf(notes);
  assert.deepEqual(qs.map((q) => q.question), ['Set up a test script?', 'Set up a build script?', 'Set up a release script?']);
  for (const q of qs) {
    assert.deepEqual(q.options.map((o) => [o.id, o.label]), [['repo', 'Create in repo'], ['kickflip', 'Create in kickflip'], ['none', "Don't create"]]);
  }
  assert.doesNotMatch(notes, /Build scripts in the repo or in kickflip\?/);
  assert.match(notes, /no split question/);
});

test('with the script in neither home, kickflip is recommended and nothing is preselected', () => {
  for (const [q, name] of questionsOf(scriptsNotes({})).map((q, i) => [q, ['test', 'build', 'release'][i]])) {
    assert.deepEqual(recommended(q), ['kickflip']);
    assert.equal(q.suggested, undefined);
    assert.deepEqual(existing(q), []);
    assert.ok(q.context.endsWith(`The repo's main has no \`.kickflip/${name}\`. Kickflip holds no \`${name}\` for this board.`), q.context);
  }
});

test('a script the repo already has recommends and preselects Create in repo, saying it exists there; one only kickflip holds, Create in kickflip', () => {
  const [testQ, build, release] = questionsOf(scriptsNotes({ test: true, release: true, kickflip: { build: true, release: true } }));
  for (const [q, name] of [[testQ, 'test'], [release, 'release']]) {
    assert.deepEqual(recommended(q), ['repo']);
    assert.deepEqual(q.suggested, { option: 'repo', reason: `The repo's main already has \`.kickflip/${name}\`.` });
    assert.ok(q.context.includes(`The repo's main already has \`.kickflip/${name}\`.`), q.context);
  }
  assert.ok(release.context.includes('Kickflip also holds `release` for this board.'), release.context);
  assert.deepEqual(recommended(build), ['kickflip']);
  assert.deepEqual(existing(testQ), ['repo']);
  assert.deepEqual(existing(build), ['kickflip']);
  assert.deepEqual(existing(release), ['repo', 'kickflip']);
  assert.deepEqual(build.suggested, { option: 'kickflip', reason: 'Kickflip already holds `build` for this board.' });
});

test('question add takes the questions as they are, given an id and topic', async () => {
  const { checkQuestions } = await import('./questions.mjs');
  const site = dir();
  fs.mkdirSync(path.join(site, 'data'));
  fs.writeFileSync(path.join(site, 'data', 'owner.json'), JSON.stringify({ topics: [{ id: 'onboarding', title: 'Onboarding' }], items: [] }));
  const qs = questionsOf(scriptsNotes({ test: true, kickflip: { build: true } })).map((q, i) => ({ id: `s${i}`, topic: 'onboarding', ...q }));
  await checkQuestions(site, qs);
});

test('after the answers, each create files its own task by the split path, mixed homes ask once which home for all, and a none is a thread line', () => {
  const notes = scriptsNotes({});
  assert.match(notes, /## After the answers\n/);
  assert.match(notes, /A grill can propose a split/);
  assert.match(notes, /--parent <key> --split/);
  assert.match(notes, /item set <key> --done --split-into <the new keys>/);
  assert.match(notes, /"No <name> script: you chose not to create one\."/);
  assert.match(notes, /one home for all its scripts/);
  assert.match(notes, /Scripts home for all: repo or kickflip\?/);
  assert.match(notes, /`board\.mjs settings set scripts repo` or `board\.mjs settings set scripts kickflip`/);
  assert.match(notes, /reviews it against the contract and keeps it/);
});

// docs/adr/2026-11-16-0200-a-repos-kickflip-release-replaces-lands-tag-release.md
test('the scripts card carries each script task\'s part, with its contract', () => {
  const notes = scriptsNotes({});
  assert.match(notes, /`<build> <file>\/<id> <worktree>`/);
  assert.match(notes, /`<release> check <version> <commit>` before landing/);
  assert.match(notes, /`<release> ship <version> <commit>` once main reached origin, while the board's Run release script box is on/);
});

// docs/adr/2026-11-21-2310-a-land-runs-its-repos-own-test-script.md
test('the test part asks for the test command, or a stub that opts out', () => {
  const notes = scriptsNotes({});
  assert.match(notes, /### Test script\n/);
  assert.match(notes, /`<test> <base>`, with the run's worktree as its working folder/);
  assert.match(notes, /a repo with no node test files and no test script refuses to land/);
  assert.match(notes, /ask the owner for the command that runs the repo's tests/);
  assert.match(notes, /stub that exits 0/);
  assert.ok(notes.indexOf('### Test script') < notes.indexOf('### Build script') && notes.indexOf('### Build script') < notes.indexOf('### Release script'));
});

test('the CONTEXT card covers only the missing CONTEXT.md or ADR, and is left out with both', () => {
  const d = dir();
  const all = { build: true, release: true };
  assert.deepEqual(titles(onboardingItems(path.join(d, 'a.json'), { has: { ...all, context: true, adr: true } })), [SCRIPTS]);
  const [, noAdr] = onboardingItems(path.join(d, 'b.json'), { has: { ...all, context: true } });
  assert.equal(noAdr.title, 'Write the first ADR');
  const [n1] = notesOf(d, [noAdr]);
  assert.match(n1, /^# Write the first ADR\n/);
  assert.doesNotMatch(n1, /Write CONTEXT\.md at the repo root/);
  const [, noContext] = onboardingItems(path.join(d, 'c.json'), { has: { ...all, adr: true } });
  assert.equal(noContext.title, 'Write the repo\'s CONTEXT.md glossary');
  const [n2] = notesOf(d, [noContext]);
  assert.match(n2, /Write CONTEXT\.md at the repo root/);
  assert.doesNotMatch(n2, /Write the first ADR in docs\/adr/);
});

test('cards keep T-1.. ids, the scripts card first even when the repo has every script', () => {
  const d = dir();
  const items = onboardingItems(path.join(d, 'wave.json'), { has: { test: true, build: true, release: true } });
  assert.deepEqual(items.map((i) => [i.id, i.title, i.plan]), [['T-1', SCRIPTS, 'T-1-notes.md'], ['T-2', CONTEXT, 'T-2-notes.md']]);
});

test("kickflipHas reads executable test, build, build-<target> and release from the site's scripts folder", async () => {
  const { writeScript } = await import('./build-script.mjs');
  const site = dir();
  assert.deepEqual(kickflipHas(site), { test: false, build: false, release: false });
  writeScript(site, 'build-web', '#!/bin/sh\n');
  assert.deepEqual(kickflipHas(site), { test: false, build: true, release: false });
  writeScript(site, 'test', '#!/bin/sh\n');
  writeScript(site, 'release', '#!/bin/sh\n');
  fs.chmodSync(path.join(site, 'scripts', 'release'), 0o600);
  assert.deepEqual(kickflipHas(site), { test: true, build: true, release: false });
});

test('repoHas reads executable test, build, release, CONTEXT.md and docs/adr from a ref', () => {
  const d = dir();
  const git = (...a) => execFileSync('git', ['-C', d, ...a], { stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(d, '.kickflip'));
  fs.mkdirSync(path.join(d, 'docs/adr'), { recursive: true });
  fs.writeFileSync(path.join(d, '.kickflip/release'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(d, '.kickflip/test'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(d, '.kickflip/build-web'), '#!/bin/sh\n', { mode: 0o644 });
  fs.writeFileSync(path.join(d, 'CONTEXT.md'), '# x\n');
  fs.writeFileSync(path.join(d, 'docs/adr/a.md'), '# a\n');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x');
  assert.deepEqual(repoHas(d, 'main'), { test: true, build: false, release: true, context: true, adr: true });
});

test('a repo with no commits, or a ref that does not exist, has nothing', () => {
  const none = { test: false, build: false, release: false, context: false, adr: false };
  assert.deepEqual(repoHas(dir(), 'HEAD'), none);
  assert.deepEqual(repoHas(path.join(dir(), 'missing'), 'main'), none);
});
