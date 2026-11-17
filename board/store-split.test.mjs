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
  'stageImplementAsks', 'stripDeadFields', 'migrateWaveNames', 'migrateDropWaves'];

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
