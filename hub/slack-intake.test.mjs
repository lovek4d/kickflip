// docs/adr/2026-11-15-0130-an-at-kickflip-in-a-slack-dm-is-filed-as-a-routed-ask.md
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeSlack, slackWorld } from '../shared/test-helpers.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

// boards.mjs, router.mjs and store.mjs read HOME as they load, so it is set before they are imported.
const home = tempDir('slack-intake-');
process.env.HOME = home;
const { fileSlackAsks, INTAKE_FILE } = await import('./slack-intake.mjs');
const { ROUTE_QUEUE } = await import('./router.mjs');
const { slackStatus } = await import('./slack.mjs');
const { readinessRows } = await import('./readiness.mjs');

const kf = (...p) => path.join(home, '.claude', 'kickflip', ...p);
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
const read = (file, fallback) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback);
const site = kf('sites', 'orch');
const boards = [{ route: 'orch', dir: site, title: 'Orch' }];
const queued = () => read(ROUTE_QUEUE, { queue: [] }).queue.map((q) => ({ text: q.text, from: q.from }));
const people = [
  { id: 'U0', name: 'love', profile: { real_name: 'Love' } },
  { id: 'U1', name: 'ann', profile: { real_name: 'Ann' } },
  { id: 'U2', name: 'bob', profile: { real_name: 'Bob' } },
];

beforeEach(() => {
  fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
  write(path.join(site, 'board.json'), { title: 'Orch', items: 'waves', reviewers: [] });
});

// A saved token over a fake Slack, polled once so intake starts. → {world, slack, poll}
async function started() {
  const world = { ...slackWorld(), people };
  const slack = fakeSlack(world);
  write(kf('secrets.json'), { slack: { token: world.token, team: world.team, team_id: world.team_id, user: world.user, user_id: world.user_id, saved_at: '2026-11-02T00:00:00Z' } });
  // Before every fake message's ts, so each one said after the first poll is new.
  const poll = () => fileSlackAsks({ boards, fetch: slack.fetch, now: new Date(1792800900_000) });
  return { world, slack, poll };
}
const link = (world, channel, ts, thread) => `${world.url}archives/${channel}/p${ts.replace('.', '')}${thread ? `?thread_ts=${thread}&cid=${channel}` : ''}`;

test("intake starts at its first poll: an @kickflip already there, even one stamped past the poll's clock, is never filed", async () => {
  const { slack, poll } = await started();
  slack.say({ channel: 'D2', user: 'U2', text: '@kickflip from before' });
  assert.deepEqual(await poll(), { filed: [], failed: [] });
  assert.deepEqual(queued(), []);
  assert.ok(read(INTAKE_FILE).since, 'the first poll records where intake starts');
});

test('a new @kickflip in a 1:1 DM is queued for the router once, as its sender\'s words with the Slack thread in from, and one search reads each poll', async () => {
  const { world, slack, poll } = await started();
  await poll();
  const ts = slack.say({ channel: 'D2', user: 'U2', text: '@kickflip the export button 500s for <@U0>' });
  assert.deepEqual(await poll(), { filed: [`Bob in D2: ${link(world, 'D2', ts)}`], failed: [] });
  assert.deepEqual(queued(), [{
    text: 'Bob: @kickflip the export button 500s for @Love',
    from: { via: 'slack', by: 'Bob', link: link(world, 'D2', ts), slack: { channel: 'D2', thread_ts: ts, ts } },
  }]);
  slack.calls.length = 0;
  assert.deepEqual(await poll(), { filed: [], failed: [] });
  assert.deepEqual(slack.calls.map((c) => c.method), ['search.messages']);
  assert.equal(queued().length, 1);
});

test("an @kickflip reply carries its thread's opener and the replies before it, and a later @kickflip in that thread files nothing new", async () => {
  const { world, slack, poll } = await started();
  await poll();
  const opener = slack.say({ channel: 'D1', user: 'U1', text: 'The digest skipped my PR today' });
  slack.say({ channel: 'D1', user: 'U0', text: 'Odd, it was green', thread_ts: opener });
  const named = slack.say({ channel: 'D1', user: 'U1', text: '@Kickflip can you look?', thread_ts: opener });
  slack.say({ channel: 'D1', user: 'U0', text: 'after the ask', thread_ts: opener });
  assert.equal((await poll()).filed.length, 1);
  assert.deepEqual(queued(), [{
    text: 'Ann: The digest skipped my PR today\n\nLove: Odd, it was green\n\nAnn: @Kickflip can you look?',
    from: { via: 'slack', by: 'Ann', link: link(world, 'D1', named, opener), slack: { channel: 'D1', thread_ts: opener, ts: named } },
  }]);
  slack.say({ channel: 'D1', user: 'U0', text: '@kickflip any news?', thread_ts: opener });
  assert.deepEqual(await poll(), { filed: [], failed: [] });
  assert.equal(queued().length, 1);
});

test("group DMs, channels, a bare kickflip, our own signed-off posts and a board's day thread file nothing; the owner's own @kickflip does", async () => {
  const { world, slack, poll } = await started();
  const day = '1792800500.000100';
  world.messages.push({ channel: 'D1', user: 'U0', text: 'Orch Digest', ts: day });
  write(path.join(site, 'data', 'review-digests.json'), { digests: [{ date: '2026-11-14', reviewer: 'Ann', channel: 'D1', ts: day }] });
  await poll();
  slack.say({ channel: 'G1', user: 'U1', text: '@kickflip in a group DM' });
  slack.say({ channel: 'C1', user: 'U1', text: '@kickflip in a channel' });
  slack.say({ channel: 'D2', user: 'U2', text: 'is kickflip down?' });
  slack.say({ channel: 'D2', user: 'U0', text: 'Ask @kickflip in your DM\n- :claude_kickflip:' });
  slack.say({ channel: 'D1', user: 'U1', text: '@kickflip what is left?', thread_ts: day });
  const own = slack.say({ channel: 'D3', user: 'U0', text: '@kickflip note the deploy window' });
  assert.deepEqual(await poll(), { filed: [`Love in D3: ${link(world, 'D3', own)}`], failed: [] });
  assert.deepEqual(queued().map((q) => q.from.by), ['Love']);
});

test("a token without search:read files nothing and reads the Slack row degraded with search:read missing until a search works", async () => {
  const { world, slack, poll } = await started();
  world.unsearched = true;
  assert.deepEqual(await poll(), { filed: [], failed: [] });
  assert.equal(slackStatus().unsearched, true);
  const [row] = readinessRows({ slack: slackStatus() });
  assert.equal(row.ready, true);
  assert.deepEqual(row.permissions.missing, [{ scope: 'search:read', effect: "@kickflip in your DMs isn't found" }]);
  world.unsearched = false;
  await poll();
  slack.say({ channel: 'D2', user: 'U2', text: '@kickflip after the reinstall' });
  assert.equal((await poll()).filed.length, 1);
  assert.equal(slackStatus().unsearched, undefined);
  assert.equal(readinessRows({ slack: slackStatus() })[0].permissions, undefined);
});

test('without a saved token intake does nothing', async () => {
  assert.deepEqual(await fileSlackAsks({ boards }), { filed: [], failed: [] });
  assert.equal(read(INTAKE_FILE), undefined);
});
