import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardTitleFault, releaseMessage, squashBody, startTitleFault, subjectFault, TYPES } from './commit-message.mjs';

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

// docs/adr/2026-11-12-0800-a-cards-title-is-its-pr-title.md
test('a card title is a Conventional subject, or an ask, "ask(<scope>): <question>?", 72 characters at most', () => {
  for (const ok of ['feat(board): every card title is Conventional', 'fix: one', 'ask(board): do we still need the staging phase?', 'ask: why?']) assert.equal(cardTitleFault(ok), null, ok);
  for (const bad of ['Every card title is Conventional', 'ask(board): do we still need staging', 'ask(Board): why?', 'ask:why?', 'ask(board)!: why?']) {
    assert.ok(cardTitleFault(bad), bad);
  }
  assert.equal(cardTitleFault('ask(board): do we still need staging'), 'isn\'t "ask(<scope>): <question>?", ending with "?"');
  assert.equal(cardTitleFault(`ask: ${'x'.repeat(67)}?`), 'is 73 characters, over 72');
  assert.equal(cardTitleFault(`feat: ${'x'.repeat(67)}`), 'is 73 characters, over 72');
});

test("a card goes into In Progress only with a Conventional subject for a title, and the refusal names item set --title", () => {
  assert.equal(startTitleFault('w/A1', 'feat(board): one'), null);
  assert.equal(startTitleFault('w/A1', 'One'), 'w/A1\'s title "One" isn\'t "<type>(<scope>): <summary>" with the type one of feat, fix, refactor, docs, test, chore, perf, build, ci, style, revert and a lowercase scope; retitle it with item set w/A1 --title "<type>(<scope>): <summary>" before it goes into In Progress');
  assert.match(startTitleFault('w/A1', 'ask(board): why?'), /^w\/A1's title "ask\(board\): why\?" is an ask, which is answered, not built; retitle it with item set w\/A1 --title/);
});
