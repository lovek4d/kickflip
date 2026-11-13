import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardTitleFault, releaseMessage, releaseVersion, squashBody, squashMessage, standardWords, startTitleBrief, startTitleFault, subjectFault, TYPES } from './commit-message.mjs';

test('the brief tells a builder to put Refs on the line directly above Co-Authored-By, no blank line between', () => {
  assert.match(standardWords('#7'), /"Refs: #7" on the line directly above Co-Authored-By, no blank line between$/);
});

test('a subject is Conventional: one of the Angular types, an optional lowercase scope, an optional "!", a summary, 100 characters at most', () => {
  for (const type of TYPES) assert.equal(subjectFault(`${type}: something`), null, type);
  for (const ok of ['feat(board): land checks the subject', 'fix!: drop the old flag', 'refactor(hub-sync)!: one poll', `feat: ${'x'.repeat(66)}`]) {
    assert.equal(subjectFault(ok), null, ok);
  }
  const shape = /^isn't "<type>\(<scope>\): <summary>"/;
  for (const bad of ['#517: land checks the subject', 'feature: x', 'Feat: x', 'feat(Board): x', 'feat(): x', 'feat:x', 'feat: ', 'feat(#517): x', 'Version 0.8.0']) {
    assert.match(subjectFault(bad), shape, bad);
  }
  assert.equal(subjectFault(`feat: ${'x'.repeat(95)}`), 'is 101 characters, over 100');
});

test('a release message is "chore(release): X.Y.Z" with the subjects landed since the last tag as a list, oldest first, then its card\'s Refs trailer', () => {
  assert.equal(releaseMessage('0.9.0', ['feat(board): one', 'fix: two'], '#7'), 'chore(release): 0.9.0\n\n- feat(board): one\n- fix: two\n\nRefs: #7');
  assert.equal(releaseMessage('0.9.0', [], '#7'), 'chore(release): 0.9.0\n\nRefs: #7');
  assert.equal(subjectFault(releaseMessage('0.9.0', [], '#7').split('\n')[0]), null);
});

test('a release subject names its version; any other subject names none', () => {
  assert.equal(releaseVersion('chore(release): 0.9.0'), '0.9.0');
  assert.equal(releaseVersion('chore(release): next'), 'next');
  for (const other of ['chore: 0.9.0', 'chore(release)!: 0.9.0', 'feat(release): 0.9.0', 'chore(release): ']) assert.equal(releaseVersion(other), null, other);
});

test("a squash body is the PR's body, then Refs: <ref> and each Co-Authored-By its commits carry, once", () => {
  const commits = [{ messageBody: 'Detail.\n\nRefs: #7\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' }, { messageBody: 'Refs: #7\nCo-authored-by: Claude Opus 5.5 <noreply@anthropic.com>\nCo-Authored-By: Ann <ann@x>' }, { messageBody: '' }];
  assert.equal(squashBody('#7', 'Checked it on the phone.\n', commits),
    'Checked it on the phone.\n\nRefs: #7\nCo-authored-by: Claude Opus 5.5 <noreply@anthropic.com>\nCo-Authored-By: Ann <ann@x>');
  assert.equal(squashBody('#7', '', []), 'Refs: #7');
});

// docs/adr/2026-11-12-0800-a-cards-title-is-its-pr-title.md
test('a card title is a Conventional subject, or an ask, "ask(<scope>): <question>?", 100 characters at most', () => {
  for (const ok of ['feat(board): every task title is Conventional', 'fix: one', 'ask(board): do we still need the staging phase?', 'ask: why?']) assert.equal(cardTitleFault(ok), null, ok);
  for (const bad of ['Every task title is Conventional', 'ask(board): do we still need staging', 'ask(Board): why?', 'ask:why?', 'ask(board)!: why?']) {
    assert.ok(cardTitleFault(bad), bad);
  }
  assert.equal(cardTitleFault('ask(board): do we still need staging'), 'isn\'t "ask(<scope>): <question>?", ending with "?"');
  assert.equal(cardTitleFault(`ask: ${'x'.repeat(95)}?`), 'is 101 characters, over 100');
  assert.equal(cardTitleFault(`feat: ${'x'.repeat(95)}`), 'is 101 characters, over 100');
});

test("a card goes into In Progress only with a Conventional subject for a title, and the refusal names item set --title", () => {
  assert.equal(startTitleFault('w/A1', 'feat(board): one'), null);
  assert.equal(startTitleFault('w/A1', 'One'), 'w/A1\'s title "One" isn\'t "<type>(<scope>): <summary>" with the type one of feat, fix, refactor, docs, test, chore, perf, build, ci, style, revert and a lowercase scope; retitle it with item set w/A1 --title "<type>(<scope>): <summary>" before it goes into In Progress');
  assert.match(startTitleFault('w/A1', 'ask(board): why?'), /^w\/A1's title "ask\(board\): why\?" is an ask, which is answered, not built; retitle it with item set w\/A1 --title/);
  // The same refusal in a status line: its reason, with no title quoted.
  assert.equal(startTitleBrief('feat(board): one'), null);
  assert.equal(startTitleBrief('One'), "its title isn't <type>(<scope>): <summary>; retitle it");
  assert.equal(startTitleBrief('ask(board): why?'), 'its title is an ask, which is answered, not built; retitle it');
  assert.equal(startTitleBrief(`feat: ${'x'.repeat(95)}`), 'its title is 101 characters, over 100; retitle it');
});

// docs/adr/2026-11-11-2318-every-land-squashes-the-branch-into-one-commit.md
test("a land's squash message is --title else the first commit's subject, the first commit's detail, then one trailer block: Refs: <ref> and each Co-Authored-By the commits carry, once", () => {
  const claude = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';
  const messages = [
    `feat(board): land squashes\n\nThe detail,\nwrapped.\n\n#7 starts this line.\n\nRefs: #7\n\n${claude}`,
    'review fixes\n\nDropped.\n\nCo-authored-by: Claude Opus 5.5 <noreply@anthropic.com>\nCo-Authored-By: Ann <ann@x>',
    'chore: merge the tests helper branch',
  ];
  const block = 'Refs: #7\nCo-authored-by: Claude Opus 5.5 <noreply@anthropic.com>\nCo-Authored-By: Ann <ann@x>';
  assert.equal(squashMessage(messages, { ref: '#7' }), `feat(board): land squashes\n\nThe detail,\nwrapped.\n\n#7 starts this line.\n\n${block}`);
  assert.equal(squashMessage(messages, { ref: '#7', title: 'fix: the title' }), `fix: the title\n\nThe detail,\nwrapped.\n\n#7 starts this line.\n\n${block}`);
  assert.equal(squashMessage(['feat: x\n\nRefs: #8'], { ref: '#7' }), 'feat: x\n\nRefs: #7');
  // With no card, the Refs the commits carry stay, each once.
  assert.equal(squashMessage(['feat: x\n\nRefs: #8', 'fix: y\n\nRefs: #8\nRefs: #9'], {}), 'feat: x\n\nRefs: #8\nRefs: #9');
  assert.equal(squashMessage(['feat: x', 'fix: y'], {}), 'feat: x');
  // A message already in its final shape comes back as it is.
  const final = `feat: x\n\nDetail.\n\nRefs: #7\n${claude}`;
  assert.equal(squashMessage([final], { ref: '#7' }), final);
});
