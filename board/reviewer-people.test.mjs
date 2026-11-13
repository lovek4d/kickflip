import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SLACK_NEEDS_TOKEN } from '../hub/slack.mjs';
import { reviewerPeople } from './reviewer-people.mjs';

const ann = { id: 'U1', name: 'Ann' };
const never = () => new Promise(() => {});

// docs/adr/2026-11-13-2234-a-limit-a-person-sees-stays-and-its-test-passes-the-runner.md
test("Reviewers lists the workspace's Slack people and the repo's GitHub collaborators, asked at once", async () => {
  const asked = [];
  const people = await reviewerPeople({
    slackPeople: async () => { asked.push('slack'); return [ann]; },
    githubPeople: async () => { asked.push('github'); return ['ann-gh']; },
    giveUp: never,
  });
  assert.deepEqual(people, { slack: [ann], github: ['ann-gh'] });
  assert.deepEqual(asked, ['slack', 'github']);
});

test('Reviewers says what to fix when Slack has no token, lacks users:read or fails, and why GitHub fails', async () => {
  assert.deepEqual(await reviewerPeople({ slackPeople: null, githubPeople: null, giveUp: never }), { slack: null, github: [], slackProblem: SLACK_NEEDS_TOKEN });
  assert.deepEqual(await reviewerPeople({
    slackPeople: async () => { throw new Error('Slack: missing_scope'); },
    githubPeople: async () => { throw new Error('gh: not logged in'); },
    giveUp: never,
  }), { slack: null, github: [], slackProblem: 'Slack needs the users:read scope; update the app on Hub › Integrations › Slack.', githubProblem: 'GitHub: gh: not logged in' });
  assert.deepEqual((await reviewerPeople({ slackPeople: async () => { throw new Error('Slack: ratelimited'); }, githubPeople: null, giveUp: never })).slackProblem, 'Slack: ratelimited');
});

test('Reviewers gives up on a lookup that has not answered by its wait, naming it, and keeps the one that did', async () => {
  const gaveUp = [];
  const giveUp = (what) => { gaveUp.push(what); return Promise.reject(new Error(`${what} did not answer in time`)); };
  assert.deepEqual(await reviewerPeople({ slackPeople: never, githubPeople: never, giveUp }),
    { slack: null, github: [], slackProblem: 'Slack did not answer in time', githubProblem: 'GitHub: GitHub did not answer in time' });
  assert.deepEqual(gaveUp, ['Slack', 'GitHub']);
  const githubOnly = (what) => (what === 'GitHub' ? giveUp(what) : never());
  assert.deepEqual(await reviewerPeople({ slackPeople: async () => [ann], githubPeople: never, giveUp: githubOnly }),
    { slack: [ann], github: [], githubProblem: 'GitHub: GitHub did not answer in time' });
});
