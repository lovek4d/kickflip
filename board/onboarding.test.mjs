import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { kickflipHas, repoHas, onboardingItems } from './onboarding.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

const dir = () => tempDir('onboarding-');

test('onboarding cards are filed grilling as tasks keyed T-<n> with no ticket, each with a notes file', () => {
  const d = dir();
  const items = onboardingItems(path.join(d, 'wave.json'), { has: {} });
  assert.deepEqual(items.map((i) => [i.id, i.phase, i.ticket, i.plan]), [['T-1', 'grilling', undefined, 'T-1-notes.md'], ['T-2', 'grilling', undefined, 'T-2-notes.md']]);
  for (const i of items) assert.match(fs.readFileSync(path.join(d, i.plan), 'utf8'), /^# /);
});

// docs/adr/2026-11-16-0200-a-repos-kickflip-release-replaces-lands-tag-release.md
test('the scripts card sets up the build and release scripts, with their contracts', () => {
  const d = dir();
  const [scripts] = onboardingItems(path.join(d, 'wave.json'), { has: {} });
  assert.equal(scripts.title, SCRIPTS);
  const notes = fs.readFileSync(path.join(d, scripts.plan), 'utf8');
  assert.match(notes, new RegExp(`^# ${SCRIPTS}\\n`));
  assert.match(notes, /`<build> <file>\/<id> <worktree>`/);
  assert.match(notes, /`<release> check <version> <commit>` before landing/);
  assert.match(notes, /`<release> ship <version> <commit>` once main reached origin, while the board's Run release script box is on/);
});

const titles = (items) => items.map((i) => i.title);
const SCRIPTS = 'Choose where the build scripts live, and prepare them';
const CONTEXT = "Write the repo's CONTEXT.md glossary and first ADR";
const notesOf = (d, items) => items.map((i) => fs.readFileSync(path.join(d, i.plan), 'utf8'));

// docs/adr/2026-11-17-1451-a-boards-scripts-live-in-its-repo-or-in-kickflip.md
test('the scripts card always asks first whether the scripts live in the repo or in kickflip, kickflip recommended, and says what each home holds', () => {
  const d = dir();
  const cases = [
    [{}, "The repo's main has no scripts. Kickflip holds none for this board."],
    [{ build: true }, "The repo's main has `.kickflip/build`. Kickflip holds none for this board."],
    [{ build: true, release: true, context: true, adr: true }, "The repo's main has `.kickflip/build` and `.kickflip/release`. Kickflip holds none for this board."],
    [{ release: true, kickflip: { build: true } }, "The repo's main has `.kickflip/release`. Kickflip holds `build` for this board."],
  ];
  cases.forEach(([has, state], i) => {
    const items = onboardingItems(path.join(d, `${i}.json`), { has });
    assert.equal(items[0].title, SCRIPTS);
    const [notes] = notesOf(d, items);
    assert.match(notes, /## First round\n\nAsk the owner first, in the grill's first round: "Build scripts in the repo or in kickflip\?" Ask it even when the repo already has scripts\.\n- In kickflip \(Recommended\)/);
    assert.match(notes, /`board\.mjs settings set scripts kickflip` or `board\.mjs settings set scripts repo`, and write the scripts the chosen home lacks/);
    assert.ok(notes.includes(state), notes);
  });
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

test('cards keep T-1.. ids, the scripts card first even when the repo has both scripts', () => {
  const d = dir();
  const items = onboardingItems(path.join(d, 'wave.json'), { has: { build: true, release: true } });
  assert.deepEqual(items.map((i) => [i.id, i.title, i.plan]), [['T-1', SCRIPTS, 'T-1-notes.md'], ['T-2', CONTEXT, 'T-2-notes.md']]);
});

test("kickflipHas reads executable build, build-<target> and release from the site's scripts folder", async () => {
  const { writeScript } = await import('./build-script.mjs');
  const site = dir();
  assert.deepEqual(kickflipHas(site), { build: false, release: false });
  writeScript(site, 'build-web', '#!/bin/sh\n');
  assert.deepEqual(kickflipHas(site), { build: true, release: false });
  writeScript(site, 'release', '#!/bin/sh\n');
  fs.chmodSync(path.join(site, 'scripts', 'release'), 0o600);
  assert.deepEqual(kickflipHas(site), { build: true, release: false });
});

test('repoHas reads executable build, release, CONTEXT.md and docs/adr from a ref', () => {
  const d = dir();
  const git = (...a) => execFileSync('git', ['-C', d, ...a], { stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(d, '.kickflip'));
  fs.mkdirSync(path.join(d, 'docs/adr'), { recursive: true });
  fs.writeFileSync(path.join(d, '.kickflip/release'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(d, '.kickflip/build-web'), '#!/bin/sh\n', { mode: 0o644 });
  fs.writeFileSync(path.join(d, 'CONTEXT.md'), '# x\n');
  fs.writeFileSync(path.join(d, 'docs/adr/a.md'), '# a\n');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x');
  assert.deepEqual(repoHas(d, 'main'), { build: false, release: true, context: true, adr: true });
});

test('a repo with no commits, or a ref that does not exist, has nothing', () => {
  const none = { build: false, release: false, context: false, adr: false };
  assert.deepEqual(repoHas(dir(), 'HEAD'), none);
  assert.deepEqual(repoHas(path.join(dir(), 'missing'), 'main'), none);
});
