import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasBuildScript, onboardingItems } from './onboarding.mjs';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-'));

test('onboarding cards are filed grilling with Internal tickets under the board prefix, each with a notes file', () => {
  const d = dir();
  const items = onboardingItems(path.join(d, 'wave.json'), { prefix: 'ACME', hasBuild: false });
  assert.deepEqual(items.map((i) => [i.id, i.state, i.ticket]), [['onboard-build', 'grilling', 'ACME-1'], ['onboard-context', 'grilling', 'ACME-2']]);
  for (const i of items) assert.match(fs.readFileSync(path.join(d, i.plan), 'utf8'), /^# /);
});

test('the build card is left out when main has a build script', () => {
  const d = dir();
  const items = onboardingItems(path.join(d, 'wave.json'), { hasBuild: true });
  assert.deepEqual(items.map((i) => [i.id, i.ticket]), [['onboard-context', 'INT-1']]);
  assert.equal(fs.existsSync(path.join(d, 'onboard-build-notes.md')), false);
});

test('a repo with no commits, or a ref that does not exist, has no build script', () => {
  assert.equal(hasBuildScript(dir(), 'HEAD'), false);
  assert.equal(hasBuildScript(path.join(dir(), 'missing'), 'main'), false);
});
