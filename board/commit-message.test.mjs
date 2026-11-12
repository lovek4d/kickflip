import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseMessage, squashBody, subjectFault, TYPES } from './commit-message.mjs';

test('a subject is Conventional: one of the Angular types, an optional lowercase scope, an optional "!", a summary, 72 characters at most', () => {
  for (const type of TYPES) assert.equal(subjectFault(`${type}: something`), null, type);
  for (const ok of ['feat(board): land checks the subject', 'fix!: drop the old flag', 'refactor(hub-sync)!: one poll', `feat: ${'x'.repeat(66)}`]) {
    assert.equal(subjectFault(ok), null, ok);
  }
  const shape = /^isn't "<type>\(<scope>\): <summary>"/;
  for (const bad of ['#517: land checks the subject', 'feature: x', 'Feat: x', 'feat(Board): x', 'feat(): x', 'feat:x', 'feat: ', 'feat(#517): x', 'Version 0.8.0']) {
    assert.match(subjectFault(bad), shape, bad);
  }
  assert.equal(subjectFault(`feat: ${'x'.repeat(67)}`), 'is 73 characters, over 72');
});

test('a release message is "chore(release): X.Y.Z" with the subjects landed since the last tag as a list, oldest first', () => {
  assert.equal(releaseMessage('0.9.0', ['feat(board): one', 'fix: two']), 'chore(release): 0.9.0\n\n- feat(board): one\n- fix: two');
  assert.equal(subjectFault(releaseMessage('0.9.0', []).split('\n')[0]), null);
});

test("a squash body is the PR's body, then Refs: <ref> and each Co-Authored-By its commits carry, once", () => {
  const commits = [{ messageBody: 'Detail.\n\nRefs: #7\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' }, { messageBody: 'Refs: #7\nCo-authored-by: Claude Opus 5.5 <noreply@anthropic.com>\nCo-Authored-By: Ann <ann@x>' }, { messageBody: '' }];
  assert.equal(squashBody('#7', 'Checked it on the phone.\n', commits),
    'Checked it on the phone.\n\nRefs: #7\nCo-authored-by: Claude Opus 5.5 <noreply@anthropic.com>\nCo-Authored-By: Ann <ann@x>');
  assert.equal(squashBody('#7', '', []), 'Refs: #7');
});
