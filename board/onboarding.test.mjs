import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasBuildScript, onboardingItems } from './onboarding.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

const dir = () => tempDir('onboarding-');

test('onboarding cards are filed grilling as tasks keyed T-<n> with no ticket, each with a notes file', () => {
  const d = dir();
  const items = onboardingItems(path.join(d, 'wave.json'), { hasBuild: false });
  assert.deepEqual(items.map((i) => [i.id, i.phase, i.ticket, i.plan]), [['T-1', 'grilling', undefined, 'T-1-notes.md'], ['T-2', 'grilling', undefined, 'T-2-notes.md']]);
  for (const i of items) assert.match(fs.readFileSync(path.join(d, i.plan), 'utf8'), /^# /);
});

// docs/adr/2026-11-16-0200-a-repos-kickflip-release-replaces-lands-tag-release.md
test('the build card also sets up .kickflip/release, with its check and ship contract', () => {
  const d = dir();
  const [build] = onboardingItems(path.join(d, 'wave.json'), { hasBuild: false });
  assert.equal(build.title, 'Prepare .kickflip/build and .kickflip/release');
  const notes = fs.readFileSync(path.join(d, build.plan), 'utf8');
  assert.match(notes, /^# Prepare \.kickflip\/build and \.kickflip\/release\n/);
  assert.match(notes, /`\.kickflip\/release check <version> <commit>` before landing/);
  assert.match(notes, /`\.kickflip\/release ship <version> <commit>` once main reached origin, while the board's Run release script box is on/);
});

test('the build card is left out when main has a build script', () => {
  const d = dir();
  const items = onboardingItems(path.join(d, 'wave.json'), { hasBuild: true });
  assert.deepEqual(items.map((i) => [i.id, i.title]), [['T-1', "Write the repo's CONTEXT.md glossary and first ADR"]]);
  assert.match(fs.readFileSync(path.join(d, 'T-1-notes.md'), 'utf8'), /^# Write CONTEXT\.md/);
});

test('a repo with no commits, or a ref that does not exist, has no build script', () => {
  assert.equal(hasBuildScript(dir(), 'HEAD'), false);
  assert.equal(hasBuildScript(path.join(dir(), 'missing'), 'main'), false);
});
