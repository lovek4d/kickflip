import { SLACK_NEEDS_TOKEN } from '../hub/slack.mjs';

// How long Reviewers waits for each list, so the answer comes before the hub's proxy gives up on the board and the page
// reads that as a restart (docs/adr/2026-11-13-2234-a-limit-a-person-sees-stays-and-its-test-passes-the-runner.md).
const PEOPLE_WAIT_MS = Number(process.env.KICKFLIP_PEOPLE_WAIT_MS) || 12_000;
const afterWait = (what) => new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} did not answer in time`)), PEOPLE_WAIT_MS).unref());

// What Board settings' Reviewers picks from: the workspace's Slack people and the board repo's GitHub collaborators,
// asked at once. slackPeople is null when Slack has no token or refused it, githubPeople null when the board has no
// GitHub repo; giveUp(what) rejects once a lookup has been waited on long enough. A list that can't be fetched or is
// given up on is null (Slack) or empty (GitHub, where a typed login still works), with the reason.
// → {slack, github, slackProblem?, githubProblem?}
export async function reviewerPeople({ slackPeople, githubPeople, giveUp = afterWait }) {
  const within = (lookup, what) => Promise.race([lookup(), giveUp(what)]);
  const [slackAnswer, githubAnswer] = await Promise.allSettled([
    slackPeople ? within(slackPeople, 'Slack') : Promise.resolve(null),
    githubPeople ? within(githubPeople, 'GitHub') : Promise.resolve([]),
  ]);
  const out = { slack: null, github: [] };
  if (!slackPeople) out.slackProblem = SLACK_NEEDS_TOKEN;
  else if (slackAnswer.status === 'fulfilled') out.slack = slackAnswer.value;
  else {
    const e = slackAnswer.reason;
    out.slackProblem = e.message === 'Slack: missing_scope' ? 'Slack needs the users:read scope; update the app on Hub › Integrations › Slack.' : e.message;
  }
  if (githubAnswer.status === 'fulfilled') out.github = githubAnswer.value;
  else out.githubProblem = `GitHub: ${githubAnswer.reason.message}`;
  return out;
}
