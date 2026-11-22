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

test('a new @kickflip in a 1:1 DM is queued for the router once, as its sender\'s words with the Slack thread in from, and one bot-user lookup and one search read each poll without a bot user', async () => {
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
  assert.deepEqual(slack.calls.map((c) => c.method), ['users.list', 'search.messages']);
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

test("group DMs, channels, our own signed-off posts and a board's day thread file nothing; the owner's own @kickflip does", async () => {
  const { world, slack, poll } = await started();
  const day = '1792800500.000100';
  world.messages.push({ channel: 'D1', user: 'U0', text: 'Orch Digest', ts: day });
  write(path.join(site, 'data', 'review-digests.json'), { digests: [{ date: '2026-11-14', reviewer: 'Ann', channel: 'D1', ts: day }] });
  await poll();
  slack.say({ channel: 'G1', user: 'U1', text: '@kickflip in a group DM' });
  slack.say({ channel: 'C1', user: 'U1', text: '@kickflip in a channel' });
  slack.say({ channel: 'D2', user: 'U0', text: 'Ask @kickflip in your DM\n- :claude_kickflip:' });
  slack.say({ channel: 'D1', user: 'U1', text: '@kickflip what is left?', thread_ts: day });
  const own = slack.say({ channel: 'D3', user: 'U0', text: '@kickflip note the deploy window' });
  assert.deepEqual(await poll(), { filed: [`Love in D3: ${link(world, 'D3', own)}`], failed: [] });
  assert.deepEqual(queued().map((q) => q.from.by), ['Love']);
});

test('a plain kickflip in a 1:1 DM files too, and gets one 👀 reaction, once', async () => {
  const { world, slack, poll } = await started();
  await poll();
  const ts = slack.say({ channel: 'D2', user: 'U2', text: 'is kickflip down?' });
  assert.deepEqual(await poll(), { filed: [`Bob in D2: ${link(world, 'D2', ts)}`], failed: [] });
  assert.deepEqual(world.reactions.map((r) => `${r.channel} ${r.timestamp} ${r.name}`), [`D2 ${ts} eyes`]);
  await poll();
  assert.equal(world.reactions.length, 1);
});

test("a picked @Kickflip mention of the workspace's bot user files, and without a bot user only the word does", async () => {
  const { world, slack, poll } = await started();
  world.people = [...people, { id: 'UB', name: 'kickflip', is_bot: true, profile: { real_name: 'Kickflip' } }];
  await poll();
  const ts = slack.say({ channel: 'D2', user: 'U2', text: '<@UB> the export 500s' });
  slack.say({ channel: 'D1', user: 'U1', text: '<@UOTHER> not the bot' });
  assert.deepEqual(await poll(), { filed: [`Bob in D2: ${link(world, 'D2', ts)}`], failed: [] });
  assert.equal(queued().length, 1);
  assert.deepEqual(world.reactions.map((r) => r.timestamp), [ts]);
});

test("a <@ID> mention with no bot user in the workspace files nothing", async () => {
  const { slack, poll } = await started();
  await poll();
  slack.say({ channel: 'D2', user: 'U2', text: '<@UB> the export 500s' });
  assert.deepEqual(await poll(), { filed: [], failed: [] });
});

test('a reaction Slack refuses is reported and leaves the ask filed', async () => {
  const { slack, poll } = await started();
  await poll();
  slack.say({ channel: 'D2', user: 'U2', text: 'kickflip please' });
  const failing = (url, opts) => (String(url).includes('reactions.add') ? Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'missing_scope' }))) : slack.fetch(url, opts));
  const result = await fileSlackAsks({ boards, fetch: failing, now: new Date(1792800900_000) });
  assert.equal(result.filed.length, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(queued().length, 1);
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

// docs/adr/2026-11-15-1530-later-replies-in-a-slack-filed-tasks-thread-land-on-the-task.md
const { followSlackAsks } = await import('./slack-intake.mjs');
const jsonLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const messageEvents = () => jsonLines(path.join(site, 'data', 'events.jsonl')).filter((e) => e.kind === 'item-message');
const threadLines = () => jsonLines(path.join(site, 'data', 'threads', 'items__T-1.jsonl'));
const follow = (slack) => followSlackAsks({ boards, fetch: slack.fetch });
// A board holding task items/T-1, which an @kickflip at ts in DM D2's thread thread_ts became, sent by `by`, in lane.
function slackFiled(world, { thread_ts, ts = thread_ts, by = 'Bob', lane = 'todo' }) {
  write(path.join(site, 'board.json'), { title: 'Orch', items: 'items.json', reviewers: [] });
  write(path.join(site, 'items.json'), { items: [{ id: 'T-1', title: 'fix: export 500s', from_ask: 'ea', lane }] });
  const routed = { reason: 'the only board', via: 'slack', by, link: link(world, 'D2', ts, ts === thread_ts ? undefined : thread_ts), slack: { channel: 'D2', thread_ts, ts }, at: '2026-11-15T09:00:00Z' };
  fs.mkdirSync(path.join(site, 'data'), { recursive: true });
  fs.writeFileSync(path.join(site, 'data', 'events.jsonl'), JSON.stringify({ id: 'ea', ts: '2026-11-15T09:00:00Z', kind: 'ask', data: { text: `${by}: @kickflip the export button 500s`, routed } }) + '\n');
}

test("each later reply in a Slack-filed task's thread lands on the task once: the asker's and the owner's @kickflip ones as messages that wake the orchestrator, the rest copied silently", async () => {
  const { world, slack } = await started();
  const asked = slack.say({ channel: 'D2', user: 'U2', text: '@kickflip the export button 500s' });
  slackFiled(world, { thread_ts: asked });
  const theirs = slack.say({ channel: 'D2', user: 'U2', text: 'Still 500s for <@U0> after the deploy', thread_ts: asked });
  const plain = slack.say({ channel: 'D2', user: 'U0', text: 'Seen, thanks', thread_ts: asked });
  slack.say({ channel: 'D2', user: 'U0', text: 'Looking into it\n- :claude_kickflip:', thread_ts: asked });
  const named = slack.say({ channel: 'D2', user: 'U0', text: '@kickflip check the logs too', thread_ts: asked });
  const shot = `${1792800000 + 9000}.000100`;
  world.messages.push({ channel: 'D2', user: 'U2', text: 'Here', thread_ts: asked, ts: shot, files: [{ name: 'trace.png', permalink: 'https://acme.slack.com/files/U2/F1/trace.png' }] });
  assert.deepEqual(await follow(slack), { copied: ['orch items/T-1: Bob', 'orch items/T-1: Love', 'orch items/T-1: Love', 'orch items/T-1: Bob'], failed: [] });
  assert.deepEqual(messageEvents().map((e) => e.data), [
    { key: 'items/T-1', text: 'Still 500s for @Love after the deploy', sendId: `slack:D2:${theirs}`, slack: { by: 'Bob', link: link(world, 'D2', theirs, asked), thread: { channel: 'D2', thread_ts: asked } } },
    { key: 'items/T-1', text: '@kickflip check the logs too', sendId: `slack:D2:${named}`, slack: { link: link(world, 'D2', named, asked), thread: { channel: 'D2', thread_ts: asked } } },
    { key: 'items/T-1', text: 'Here\ntrace.png: https://acme.slack.com/files/U2/F1/trace.png', sendId: `slack:D2:${shot}`, slack: { by: 'Bob', link: link(world, 'D2', shot, asked), thread: { channel: 'D2', thread_ts: asked } } },
  ]);
  assert.deepEqual(threadLines().map((m) => [m.who, m.via, m.text, m.link]), [['love', 'slack', 'Seen, thanks', link(world, 'D2', plain, asked)]]);
  slack.calls.length = 0;
  assert.deepEqual(await follow(slack), { copied: [], failed: [] });
  assert.deepEqual(slack.calls.map((c) => [c.method, c.body.oldest]), [['conversations.replies', shot]]);
  assert.equal(messageEvents().length, 3);
});

test("only replies after the @kickflip land, those before it being its words; when the owner asked, the other person's reply is copied silently", async () => {
  const { world, slack } = await started();
  const opener = slack.say({ channel: 'D2', user: 'U2', text: 'The export button 500s' });
  const asked = slack.say({ channel: 'D2', user: 'U0', text: '@kickflip can you look?', thread_ts: opener });
  slackFiled(world, { thread_ts: opener, ts: asked, by: 'Love' });
  const theirs = slack.say({ channel: 'D2', user: 'U2', text: 'Thanks!', thread_ts: opener });
  assert.deepEqual(await follow(slack), { copied: ['orch items/T-1: Bob'], failed: [] });
  assert.deepEqual(messageEvents(), []);
  assert.deepEqual(threadLines().map((m) => [m.who, m.via, m.text, m.link]), [['Bob', 'slack', 'Thanks!', link(world, 'D2', theirs, opener)]]);
});

test('a Done task reads its Slack thread no more', async () => {
  const { world, slack } = await started();
  const asked = slack.say({ channel: 'D2', user: 'U2', text: '@kickflip the export button 500s' });
  slackFiled(world, { thread_ts: asked, lane: 'done' });
  slack.say({ channel: 'D2', user: 'U2', text: 'Works now', thread_ts: asked });
  slack.calls.length = 0;
  assert.deepEqual(await follow(slack), { copied: [], failed: [] });
  assert.deepEqual(slack.calls, []);
  assert.deepEqual(threadLines(), []);
});

test("a thread keeps landing on its open task after the owner's reply was copied and the orchestrator's posted: the asker's later reply lands too", async () => {
  const { world, slack } = await started();
  const { postSlackReplies } = await import('./slack-intake.mjs');
  const { queueSlackReply } = await import('../board/slack-store.mjs');
  const asked = slack.say({ channel: 'D2', user: 'U2', text: '@kickflip the export button 500s' });
  slackFiled(world, { thread_ts: asked });
  const owner = slack.say({ channel: 'D2', user: 'U0', text: 'Looking at it', thread_ts: asked });
  assert.deepEqual(await follow(slack), { copied: ['orch items/T-1: Love'], failed: [] });
  fs.mkdirSync(path.join(site, 'data', 'replies'), { recursive: true });
  fs.writeFileSync(path.join(site, 'data', 'replies', 'r1.md'), 'It is fixed in the next build');
  await queueSlackReply(site, 'items/T-1', 'r1');
  assert.deepEqual(await postSlackReplies({ boards, fetch: slack.fetch }), { posted: ['orch items/T-1: a reply'], failed: [] });
  assert.deepEqual(await follow(slack), { copied: [], failed: [] });
  const later = slack.say({ channel: 'D2', user: 'U2', text: 'did one more pass Kickflip. any other concerns or are we good', thread_ts: asked });
  assert.deepEqual(await follow(slack), { copied: ['orch items/T-1: Bob'], failed: [] });
  assert.deepEqual(messageEvents().map((e) => e.data.sendId), [`slack:D2:${later}`]);
  const slackThreads = read(path.join(site, 'data', 'slack-threads.json'), {});
  assert.equal(slackThreads.threads[`D2:${asked}`], later);
  assert.ok(owner);
});

test("a thread that can't be read says so once on its card, is read again each poll, and its replies land when Slack answers", async () => {
  const { world, slack } = await started();
  const asked = slack.say({ channel: 'D2', user: 'U2', text: '@kickflip the export button 500s' });
  slackFiled(world, { thread_ts: asked });
  const later = slack.say({ channel: 'D2', user: 'U2', text: 'Any news?', thread_ts: asked });
  let down = true;
  const fetch = async (url, init) => (down && String(url).includes('conversations.replies')
    ? { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: false, error: 'internal_error' }), text: async () => '' }
    : slack.fetch(url, init));
  for (let i = 0; i < 2; i++) assert.equal((await followSlackAsks({ boards, fetch })).failed.length, 1);
  assert.deepEqual(threadLines().filter((m) => m.line === 'slack-follow-failed').map((m) => m.text),
    ["Can't read its Slack thread, replies may be missing: Slack: internal_error"]);
  down = false;
  assert.deepEqual(await followSlackAsks({ boards, fetch }), { copied: ['orch items/T-1: Bob'], failed: [] });
  assert.deepEqual(messageEvents().map((e) => e.data.sendId), [`slack:D2:${later}`]);
  down = true;
  await followSlackAsks({ boards, fetch });
  assert.equal(threadLines().filter((m) => m.line === 'slack-follow-failed').length, 2, 'a recovered thread says so again when it fails anew');
});
