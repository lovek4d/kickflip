import { home } from '../shared/scratch-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// docs/adr/2026-11-17-2300-slack-and-migrations-leave-store-mjs-for-their-own-modules.md
// store.mjs is split by concept behind files.mjs: Slack in slack-store.mjs and the data migrations in migrations.mjs,
// each the one module that exports its concept's functions. home keeps the imports off the real hub.
void home;
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SLACK = ['readPRSlack', 'postLink', 'recordReaction', 'reviewDue', 'recordHeader', 'reviewDigest', 'heardThreads', 'markHeard', 'boardPosts',
  'followedSlackThreads', 'markSlackThreadHeard', 'slackOutbox', 'markSlackPost', 'slackThread', 'slackSkip', 'slackAnswer', 'slackSay', 'slackLink',
  'slackTask', 'dayThread', 'postDigest'];
const MIGRATIONS = ['migrateFollowups', 'migrateStatuses', 'migrateGates', 'migrateCreated', 'migratePhases', 'clearBuildPhases', 'discussNewCards',
  'stageImplementAsks', 'stripDeadFields', 'runMigrations', 'migrationsLeft'];

const store = await import('./store.mjs');
const slack = await import('./slack-store.mjs');
const migrations = await import('./migrations.mjs');

test("Slack's functions are slack-store.mjs's, and store.mjs exports none of them", () => {
  assert.deepEqual(SLACK.filter((n) => typeof slack[n] !== 'function'), []);
  assert.deepEqual(SLACK.filter((n) => n in store), []);
});

test("the data migrations are migrations.mjs's, and store.mjs exports none of them", () => {
  assert.deepEqual(MIGRATIONS.filter((n) => typeof migrations[n] !== 'function'), []);
  assert.deepEqual(MIGRATIONS.filter((n) => n in store), []);
});

// The names a module imports from board/store.mjs.
const fromStore = (rel) => [...fs.readFileSync(path.join(root, rel), 'utf8').matchAll(/import \{([^}]*)\} from '(?:\.\.\/board|\.)\/store\.mjs'/g)]
  .flatMap((m) => m[1].split(',').map((n) => n.trim()).filter(Boolean));

test("the hub's Slack modules take no Slack function from store.mjs", () => {
  for (const rel of ['hub/review-send.mjs', 'hub/slack-intake.mjs']) assert.deepEqual(fromStore(rel).filter((n) => SLACK.includes(n)), [], rel);
  assert.deepEqual(fromStore('hub/review-send.mjs'), []);
});

test("the hub's migrations come from migrations.mjs", () => {
  assert.deepEqual(fromStore('hub/hub.mjs').filter((n) => MIGRATIONS.includes(n)), []);
});

// docs/adr/2026-11-17-1137-cards-questions-asks-and-settings-leave-store-mjs.md
// Cards, questions, asks and settings each have their module too, the run records join runs.mjs, and store.mjs keeps
// no code: it re-exports each concept's functions for board.mjs and the tests.
const CONCEPTS = {
  'checks.mjs': ['BoardError', 'needSite', 'text', 'domId'],
  'cards.mjs': ['setItem', 'addItem', 'moveCard', 'mergeCard', 'archiveCards', 'appendStatus', 'appendMessage', 'cardName', 'threadFile', 'askCardOf'],
  'questions.mjs': ['addQuestions', 'settleAnswers', 'resolveQuestion', 'publishUnscreened', 'addNotes', 'writeBrief', 'addPrototype', 'itemNotes'],
  'asks.mjs': ['fileAsk', 'fileAsks', 'askItem', 'triageItem', 'moveAsk', 'handoff', 'writeReply', 'recordReview'],
  'settings.mjs': ['settingsOf', 'saveBoardSettings', 'setBoardSetting', 'readBoardRules', 'setReviewers', 'readHandshake', 'boardTarget'],
  'runs.mjs': ['startBuilder', 'startTappedBuild', 'startPlanner', 'closeRecord', 'stopPlanner', 'landable', 'builderProgress', 'recordCall', 'openBoardBuilders'],
};
const MODULES = [...Object.keys(CONCEPTS), 'slack-store.mjs', 'migrations.mjs'];
// The helpers store.mjs exported for slack-store.mjs and migrations.mjs alone while the cards were still in it.
const INTERIM = ['ownerFile', 'needSite', 'text', 'domId', 'askCardOf', 'sameName', 'storedTickets', 'topicQuestionsAll', 'leftTodo', 'depKey',
  'ticketWrite', 'archiveWrite', 'writeArchive', 'boardTarget', 'builderFiles'];
const source = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const importsStore = (rel) => /from '(?:\.\.\/board|\.)\/store\.mjs'|import\('(?:\.\.\/board|\.)\/store\.mjs'\)/.test(source(rel));

test('each concept is its own module, and store.mjs re-exports its functions', async () => {
  for (const [file, names] of Object.entries(CONCEPTS)) {
    const mod = await import(`./${file}`);
    assert.deepEqual(names.filter((n) => !(n in mod)), [], file);
    assert.deepEqual(names.filter((n) => !INTERIM.includes(n) && store[n] !== mod[n]), [], `store.mjs re-exports ${file}`);
  }
});

test('store.mjs holds no code: only re-exports, none from slack-store.mjs', () => {
  const code = source('board/store.mjs').split('\n').filter((l) => l && !l.startsWith('//'));
  assert.deepEqual(code.filter((l) => !/^export \{[^}]*\} from '\.\/[\w-]+\.mjs';$/.test(l)), []);
  assert.equal(importsStore('board/slack-store.mjs'), false);
  assert.doesNotMatch(source('board/store.mjs'), /slack-store\.mjs'/);
});

test('no concept module imports store.mjs', () => {
  assert.deepEqual(MODULES.filter((file) => importsStore(`board/${file}`)), []);
});

test("store.mjs exports none of the helpers it held for slack-store.mjs and migrations.mjs", () => {
  assert.deepEqual(INTERIM.filter((n) => n in store), []);
});
