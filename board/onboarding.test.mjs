import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repoHas, onboardingItems } from './onboarding.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

const dir = () => tempDir('onboarding-');

test('onboarding cards are filed grilling as tasks keyed T-<n> with no ticket, each with a notes file', () => {
  const d = dir();
  const items = onboardingItems(path.join(d, 'wave.json'), { has: {} });
  assert.deepEqual(items.map((i) => [i.id, i.phase, i.ticket, i.plan]), [['T-1', 'grilling', undefined, 'T-1-notes.md'], ['T-2', 'grilling', undefined, 'T-2-notes.md']]);
  for (const i of items) assert.match(fs.readFileSync(path.join(d, i.plan), 'utf8'), /^# /);
});

// docs/adr/2026-11-16-0200-a-repos-kickflip-release-replaces-lands-tag-release.md
test('the build card also sets up .kickflip/release, with its check and ship contract', () => {
  const d = dir();
  const [build] = onboardingItems(path.join(d, 'wave.json'), { has: {} });
  assert.equal(build.title, 'Prepare .kickflip/build and .kickflip/release');
  const notes = fs.readFileSync(path.join(d, build.plan), 'utf8');
  assert.match(notes, /^# Prepare \.kickflip\/build and \.kickflip\/release\n/);
  assert.match(notes, /`\.kickflip\/release check <version> <commit>` before landing/);
  assert.match(notes, /`\.kickflip\/release ship <version> <commit>` once main reached origin, while the board's Run release script box is on/);
});

const titles = (items) => items.map((i) => i.title);
const BUILD = 'Prepare .kickflip/build';
const CONTEXT = "Write the repo's CONTEXT.md glossary and first ADR";
const notesOf = (d, items) => items.map((i) => fs.readFileSync(path.join(d, i.plan), 'utf8'));

// docs/adr/2026-11-16-1100-onboarding-cards-cover-only-what-the-repo-lacks.md
test('the build card covers only what is missing: build, release, or both', () => {
  const d = dir();
  const [onlyRelease] = onboardingItems(path.join(d, 'a.json'), { has: { build: true } });
  assert.equal(onlyRelease.title, 'Prepare .kickflip/release');
  const [n1] = notesOf(d, [onlyRelease]);
  assert.match(n1, /^# Prepare \.kickflip\/release\n/);
  assert.match(n1, /\.kickflip\/release check/);
  assert.doesNotMatch(n1, /\.kickflip\/build <file>/);

  const [onlyBuild] = onboardingItems(path.join(d, 'b.json'), { has: { release: true } });
  assert.equal(onlyBuild.title, BUILD);
  const [n2] = notesOf(d, [onlyBuild]);
  assert.match(n2, /^# Prepare \.kickflip\/build\n/);
  assert.match(n2, /\.kickflip\/build <file>/);
  assert.doesNotMatch(n2, /\.kickflip\/release check/);
});

test('no build card when main has both build and release', () => {
  const d = dir();
  const items = onboardingItems(path.join(d, 'wave.json'), { has: { build: true, release: true } });
  assert.deepEqual(items.map((i) => [i.id, i.title]), [['T-1', CONTEXT]]);
  assert.match(fs.readFileSync(path.join(d, 'T-1-notes.md'), 'utf8'), /^# Write CONTEXT\.md and the first ADR/);
});

test('the CONTEXT card covers only the missing CONTEXT.md or ADR, and is left out with both', () => {
  const d = dir();
  const all = { build: true, release: true };
  assert.deepEqual(onboardingItems(path.join(d, 'a.json'), { has: { ...all, context: true, adr: true } }), []);
  const [noAdr] = onboardingItems(path.join(d, 'b.json'), { has: { ...all, context: true } });
  assert.equal(noAdr.title, 'Write the first ADR');
  const [n1] = notesOf(d, [noAdr]);
  assert.match(n1, /^# Write the first ADR\n/);
  assert.doesNotMatch(n1, /Write CONTEXT\.md at the repo root/);
  const [noContext] = onboardingItems(path.join(d, 'c.json'), { has: { ...all, adr: true } });
  assert.equal(noContext.title, 'Write the repo\'s CONTEXT.md glossary');
  const [n2] = notesOf(d, [noContext]);
  assert.match(n2, /Write CONTEXT\.md at the repo root/);
  assert.doesNotMatch(n2, /Write the first ADR in docs\/adr/);
});

test('cards keep T-1.. ids after one is left out', () => {
  const d = dir();
  const items = onboardingItems(path.join(d, 'wave.json'), { has: { build: true, release: true } });
  assert.deepEqual(items.map((i) => i.plan), ['T-1-notes.md']);
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
