import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardTitleFault, releaseMessage, releaseVersion, squashBody, squashMessage, standardWords, startTitleBrief, startTitleFault, subjectFault, TYPES, withTicket } from './commit-message.mjs';

test('the brief tells a builder to put Refs on the line directly above Co-Authored-By, no blank line between', () => {
  assert.match(standardWords('#7'), /"Refs: #7" on the line directly above Co-Authored-By, no blank line between\./);
});

// docs/adr/2026-11-24-2100-outside-text-cites-only-external-refs-and-a-subject-ends-with-its-ticket.md
test("the brief counts the land's ticket suffix in the cap, gives a task with no ticket no Refs line, and asks for no task key in the message", () => {
  assert.match(standardWords('#1193'), /a Conventional subject of at most 92 characters,/);
  assert.match(standardWords('#1193'), /no task ref in it \(the land adds " \(#1193\)"\)/);
  assert.match(standardWords(null), /a Conventional subject of at most 100 characters,/);
  assert.match(standardWords(null), /with no Refs line: the task has no ticket/);
  assert.doesNotMatch(standardWords(null), /"Refs: /);
  for (const ticket of ['#7', null]) assert.match(standardWords(ticket), /cites earlier work by its ticket, PR or commit, never a task key such as T-12/);
});

test('a subject ends with its ticket once, and with none stays as it is', () => {
  assert.equal(withTicket('feat(board): x', '#7'), 'feat(board): x (#7)');
  assert.equal(withTicket('feat(board): x (#7)', '#7'), 'feat(board): x (#7)');
  assert.equal(withTicket('feat(board): x', 'ENG-3'), 'feat(board): x (ENG-3)');
  assert.equal(withTicket('feat(board): x', null), 'feat(board): x');
  assert.equal(subjectFault(withTicket('feat(board): x', '#7')), null);
});

test('a subject is Conventional: one of the Angular types, an optional lowercase scope, an optional "!", a summary, 100 characters at most', () => {
  for (const type of TYPES) assert.equal(subjectFault(`${type}: something`), null, type);
  for (const ok of ['feat(board): land checks the subject', 'fix!: drop the old flag', 'refactor(hub-sync)!: one poll', 'feat(api,web): one change', 'fix(api, web-ui)!: two packages', `feat: ${'x'.repeat(66)}`]) {
    assert.equal(subjectFault(ok), null, ok);
  }
  const shape = /^isn't "<type>\(<scope>\): <summary>"/;
  for (const bad of ['#517: land checks the subject', 'feature: x', 'Feat: x', 'feat(Board): x', 'feat(): x', 'feat:x', 'feat: ', 'feat(#517): x', 'Version 0.8.0', 'feat(api,): x', 'feat(,api): x', 'feat(api,Web): x', 'feat(api;web): x']) {
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
  assert.equal(releaseVersion('chore(release): 0.9.0 (#7)'), '0.9.0');
  for (const other of ['chore: 0.9.0', 'chore(release)!: 0.9.0', 'feat(release): 0.9.0', 'chore(release): ', 'chore(release): 0.9.0 and more']) assert.equal(releaseVersion(other), null, other);
});

test('the standard lets the scope be a comma list of areas', () => {
  assert.match(standardWords('#7'), /the scope optional, lowercase and naming the area \(board, hub, skill\), or a comma list of areas for a change across them \(api,web\)/);
});

// docs/adr/2026-11-11-1700-commits-are-conventional-and-name-their-card-in-a-refs-trailer.md
test("a squash body is the PR body's Summary section, wrapped at 72, then the trailers; a body with no Summary heading goes whole", () => {
  const body = [
    '<!-- the template\'s note -->',
    '## Summary',
    '',
    '**Problem**: every board PR opened with a one-line body, so the orchestrator rewrote each one by hand with gh pr edit.',
    '',
    '- a list item long enough that it has to wrap onto a second line at the commit width',
    '',
    '### Solution',
    'Builders pass --body-file.',
    '',
    '## Verification',
    '<details><summary>commands</summary>npm test</details>',
  ].join('\n');
  assert.equal(squashBody(['#7'], body, []), [
    '**Problem**: every board PR opened with a one-line body, so the',
    'orchestrator rewrote each one by hand with gh pr edit.',
    '',
    '- a list item long enough that it has to wrap onto a second line at the',
    '  commit width',
    '',
    '### Solution',
    'Builders pass --body-file.',
    '',
    'Refs: #7',
  ].join('\n'));
  assert.equal(squashBody(['#7'], `Hand-written.\n\n${'word '.repeat(20)}`, []), `Hand-written.\n\n${'word '.repeat(14).trim()}\n${'word '.repeat(6).trim()}\n\nRefs: #7`);
  assert.equal(squashBody(['#7'], '# Summary\nOne.\n# Verification\nRan it.', []), 'One.\n\nRefs: #7');
});

test("a squash body keeps the trailers: Refs: <ref> and each Co-Authored-By its commits carry, once", () => {
  const commits = [{ messageBody: 'Detail.\n\nRefs: #7\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' }, { messageBody: 'Refs: #7\nCo-authored-by: Claude Opus 5.5 <noreply@anthropic.com>\nCo-Authored-By: Ann <ann@x>' }, { messageBody: '' }];
  assert.equal(squashBody(['#7'], 'Checked it on the phone.\n', commits),
    'Checked it on the phone.\n\nRefs: #7\nCo-authored-by: Claude Opus 5.5 <noreply@anthropic.com>\nCo-Authored-By: Ann <ann@x>');
  assert.equal(squashBody(['#7'], '', []), 'Refs: #7');
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
  assert.equal(startTitleFault('w/A1', 'One'), 'w/A1\'s title "One" isn\'t "<type>(<scope>): <summary>" with the type one of feat, fix, refactor, docs, test, chore, perf, build, ci, style, revert and a lowercase scope or a comma list of them; retitle it with item set w/A1 --title "<type>(<scope>): <summary>" before it goes into In Progress');
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
  assert.equal(squashMessage(messages, { refs: ['#7'] }), `feat(board): land squashes\n\nThe detail,\nwrapped.\n\n#7 starts this line.\n\n${block}`);
  assert.equal(squashMessage(messages, { refs: ['#7'], title: 'fix: the title' }), `fix: the title\n\nThe detail,\nwrapped.\n\n#7 starts this line.\n\n${block}`);
  assert.equal(squashMessage(['feat: x\n\nRefs: #8'], { refs: ['#7'] }), 'feat: x\n\nRefs: #7');
  // docs/adr/2026-11-24-2100-outside-text-cites-only-external-refs-and-a-subject-ends-with-its-ticket.md: a card's ticket
  // ends the subject and its related cards' tickets join its Refs; a card with no ticket has no Refs line.
  assert.equal(squashMessage(['feat: x\n\nRefs: T-4'], { refs: ['#7', '#9'], ticket: '#7', title: 'fix: the title' }), 'fix: the title (#7)\n\nRefs: #7\nRefs: #9');
  assert.equal(squashMessage(['feat: x\n\nRefs: T-4\nCo-Authored-By: X'], { refs: [] }), 'feat: x\n\nCo-Authored-By: X');
  // With no card, the Refs the commits carry stay, each once.
  assert.equal(squashMessage(['feat: x\n\nRefs: #8', 'fix: y\n\nRefs: #8\nRefs: #9'], {}), 'feat: x\n\nRefs: #8\nRefs: #9');
  assert.equal(squashMessage(['feat: x', 'fix: y'], {}), 'feat: x');
  // A message already in its final shape comes back as it is.
  const final = `feat: x\n\nDetail.\n\nRefs: #7\n${claude}`;
  assert.equal(squashMessage([final], { refs: ['#7'] }), final);
});
