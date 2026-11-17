// docs/adr/2026-11-16-1700-replies-to-a-slack-message-post-into-its-slack-thread.md
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeSlack, slackWorld } from '../shared/test-helpers.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

// boards.mjs and store.mjs read HOME as they load, so it is set before they are imported.
const home = tempDir('slack-replies-');
process.env.HOME = home;
const { postSlackReplies, followSlackAsks } = await import('./slack-intake.mjs');
const store = await import('../board/store.mjs');
const { appendMessage } = store;
const { boardPosts, queueSlackReply } = await import('../board/slack-store.mjs');
// What `board reply` does: write the reply, then queue it to its Slack thread when writeReply returns one to queue.
const writeReply = async (...args) => {
  const written = await store.writeReply(...args);
  if (written.slack) await queueSlackReply(args[0], written.slack.key, written.slack.name);
  return written;
};

const kf = (...p) => path.join(home, '.claude', 'kickflip', ...p);
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
const jsonLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const site = kf('sites', 'orch');
const boards = [{ route: 'orch', dir: site, title: 'Orch' }];
const people = [{ id: 'U0', name: 'love', profile: { real_name: 'Love' } }, { id: 'U2', name: 'bob', profile: { real_name: 'Bob' } }];
const threadLines = () => jsonLines(path.join(site, 'data', 'threads', 'items__T-1.jsonl'));
const eventsFile = path.join(site, 'data', 'events.jsonl');
const addEvent = (e) => fs.appendFileSync(eventsFile, JSON.stringify(e) + '\n');
const setItem = (changes) => {
  const file = path.join(site, 'items.json');
  const items = JSON.parse(fs.readFileSync(file, 'utf8'));
  Object.assign(items.items[0], changes);
  write(file, items);
};

beforeEach(() => fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true }));

// A saved token over a fake Slack, and a board whose task items/T-1 an @kickflip from Bob in DM D2 became, its ask
// event ea. → {world, slack, asked, post}
function filed() {
  const world = { ...slackWorld(), people };
  const slack = fakeSlack(world);
  write(kf('secrets.json'), { slack: { token: world.token, team: world.team, team_id: world.team_id, user: world.user, user_id: world.user_id, saved_at: '2026-11-02T00:00:00Z' } });
  const asked = slack.say({ channel: 'D2', user: 'U2', text: '@kickflip the export button 500s' });
  write(path.join(site, 'board.json'), { title: 'Orch', items: 'items.json', reviewers: [] });
  write(path.join(site, 'items.json'), { items: [{ id: 'T-1', title: 'fix: export 500s', from_ask: 'ea', lane: 'todo', phase: 'discussing' }] });
  const routed = { reason: 'the only board', via: 'slack', by: 'Bob', link: `${world.url}archives/D2/p${asked.replace('.', '')}`, slack: { channel: 'D2', thread_ts: asked, ts: asked }, at: '2026-11-15T09:00:00Z' };
  fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
  fs.writeFileSync(eventsFile, '');
  addEvent({ id: 'ea', ts: '2026-11-15T09:00:00Z', kind: 'ask', data: { text: 'Bob: @kickflip the export button 500s', routed } });
  // world.postError, when set, is Slack's answer to every chat.postMessage.
  const fetch = (url, init) => (world.postError && String(url).endsWith('/chat.postMessage') ? { ok: true, status: 200, json: async () => ({ ok: false, error: world.postError }) } : slack.fetch(url, init));
  return { world, slack, asked, post: () => postSlackReplies({ boards, fetch }) };
}
const inThread = (world, asked) => world.messages.filter((m) => m.thread_ts === asked).map((m) => m.text);

test('a reply to the @kickflip ask posts into its Slack thread once, as 🤖 and signed off', async () => {
  const { world, slack, asked, post } = filed();
  await writeReply(site, 'ea', 'Looking: the export job times out at 30s.');
  assert.deepEqual(await post(), { posted: ['orch items/T-1: a reply'], failed: [] });
  assert.deepEqual(inThread(world, asked), ['🤖 Looking: the export job times out at 30s.\n- :claude_kickflip:']);
  assert.deepEqual(await post(), { posted: [], failed: [] });
  assert.equal(inThread(world, asked).length, 1, 'never posted twice');
  // The posted reply is the board's own: following the thread copies it back nowhere.
  assert.ok((await boardPosts(site)).has(world.messages.at(-1).ts));
  slack.calls.length = 0;
  assert.deepEqual(await followSlackAsks({ boards, fetch: slack.fetch }), { copied: [], failed: [] });
});

test("a reply to a Slack reply copied onto the task posts; a reply to the owner's board message, and any thread line, stays on the board", async () => {
  const { world, asked, post } = filed();
  addEvent({ id: 'es', ts: '2026-11-15T10:00:00Z', kind: 'item-message', data: { key: 'items/T-1', text: 'Still 500s', slack: { by: 'Bob', link: 'https://acme.slack.com/x' } } });
  addEvent({ id: 'eb', ts: '2026-11-15T10:05:00Z', kind: 'item-message', data: { key: 'items/T-1', text: 'What does the log say?' } });
  await writeReply(site, 'eb', 'The log names a timeout.');
  await appendMessage(site, 'items/T-1', { text: 'Raising the timeout.' });
  await writeReply(site, 'es', 'A fix for the timeout is on its way.');
  await post();
  assert.deepEqual(inThread(world, asked), ['🤖 A fix for the timeout is on its way.\n- :claude_kickflip:']);
});

test('a failed post is one fault line on the card, retried each poll until it posts, in order', async () => {
  const { world, asked, post } = filed();
  await writeReply(site, 'ea', 'First.');
  await writeReply(site, 'ea', 'Second.');
  world.postError = 'channel_not_found';
  const failing = await post();
  assert.equal(failing.posted.length, 0);
  assert.equal(failing.failed.length, 1, 'the later reply waits behind the first');
  await post();
  assert.deepEqual(threadLines().filter((m) => m.line === 'slack-post-failed').map((m) => m.text), ["Couldn't post a reply to its Slack thread, retrying each poll: Slack: channel_not_found"]);
  delete world.postError;
  assert.equal((await post()).posted.length, 2);
  assert.deepEqual(inThread(world, asked), ['🤖 First.\n- :claude_kickflip:', '🤖 Second.\n- :claude_kickflip:']);
});

test('once the task is Done one end line posts, closed or built and landed, and mirroring stops', async () => {
  for (const [phase, end] of [['closed', 'Closed'], ['merged', 'Built and landed']]) {
    fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
    const { world, asked, post } = filed();
    await post();
    await writeReply(site, 'ea', 'Done here.');
    setItem({ lane: 'done', phase });
    await post();
    await writeReply(site, 'ea', 'After Done.');
    await post();
    assert.deepEqual(inThread(world, asked), ['🤖 Done here.\n- :claude_kickflip:', `🤖 ${end}: fix: export 500s\n- :claude_kickflip:`]);
  }
});

test('a task already Done when its thread was first polled posts no end line', async () => {
  const { world, asked, post } = filed();
  setItem({ lane: 'done', phase: 'closed' });
  await post();
  await post();
  assert.deepEqual(inThread(world, asked), []);
});
