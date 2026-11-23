// docs/adr/2026-11-23-0010-a-slack-message-on-a-task-shows-where-it-stands-as-one-reaction.md
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeSlack, slackWorld } from '../shared/test-helpers.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

// boards.mjs and store.mjs read HOME as they load, so it is set before they are imported.
const home = tempDir('slack-status-');
process.env.HOME = home;
const { reactSlackStatus, postSlackReplies } = await import('./slack-intake.mjs');
const store = await import('../board/store.mjs');
const { queueSlackReply } = await import('../board/slack-store.mjs');
const { setPREmoji } = await import('./slack.mjs');
const writeReply = async (...args) => {
  const written = await store.writeReply(...args);
  if (written.slack) await queueSlackReply(args[0], written.slack.key, written.slack.name, written.slack.thread);
  return written;
};

const kf = (...p) => path.join(home, '.claude', 'kickflip', ...p);
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
const site = kf('sites', 'orch');
const boards = [{ route: 'orch', dir: site, title: 'Orch' }];
const people = [{ id: 'U0', name: 'love', profile: { real_name: 'Love' } }, { id: 'U2', name: 'bob', profile: { real_name: 'Bob' } }];
const eventsFile = path.join(site, 'data', 'events.jsonl');
const addEvent = (e) => fs.appendFileSync(eventsFile, JSON.stringify(e) + '\n');
const setItem = (changes) => {
  const file = path.join(site, 'items.json');
  const items = JSON.parse(fs.readFileSync(file, 'utf8'));
  Object.assign(items.items[0], changes);
  write(file, items);
};
const working = (ids) => write(path.join(site, 'data', 'working.json'), { events: Object.fromEntries(ids.map((id) => [id, new Date().toISOString()])) });

beforeEach(() => fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true }));

// A saved token over a fake Slack, and a board whose task items/T-1 an @kickflip from Bob in DM D2 became, its ask event
// ea, still New, which intake reacted 👀 to. listening says whether the board's session hears its events.
function filed({ reacted = 'eyes' } = {}) {
  const world = { ...slackWorld(), people };
  const slack = fakeSlack(world);
  write(kf('secrets.json'), { slack: { token: world.token, team: world.team, team_id: world.team_id, user: world.user, user_id: world.user_id, saved_at: '2026-11-02T00:00:00Z' } });
  const asked = slack.say({ channel: 'D2', user: 'U2', text: '@kickflip the export button 500s' });
  if (reacted) world.reactions.push({ channel: 'D2', timestamp: asked, name: reacted });
  write(path.join(site, 'board.json'), { title: 'Orch', items: 'items.json', reviewers: [] });
  write(path.join(site, 'items.json'), { items: [{ id: 'T-1', title: 'fix: export 500s', from_ask: 'ea', lane: 'todo' }] });
  const routed = { reason: 'the only board', via: 'slack', by: 'Bob', link: `${world.url}archives/D2/p${asked.replace('.', '')}`, slack: { channel: 'D2', thread_ts: asked, ts: asked, ...(reacted ? { reacted } : {}) }, at: '2026-11-15T09:00:00Z' };
  fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
  fs.writeFileSync(eventsFile, '');
  addEvent({ id: 'ea', ts: '2026-11-15T09:00:00Z', kind: 'ask', data: { text: 'Bob: @kickflip the export button 500s', routed } });
  const state = { listening: true };
  return {
    world, slack, asked, state,
    react: () => reactSlackStatus({ boards, fetch: slack.fetch, listening: () => state.listening }),
    post: () => postSlackReplies({ boards, fetch: slack.fetch }),
  };
}
const on = (world, ts) => world.reactions.filter((r) => r.timestamp === ts).map((r) => r.name);

test("a Slack ask's message reads 👀 while received, 🤔 while the orchestrator works on it, and ✅ once its reply posts, which stays", async () => {
  const { world, asked, react, post } = filed();
  assert.deepEqual(await react(), { reacted: [], failed: [] }, "intake's 👀 already stands for received");
  assert.deepEqual(on(world, asked), ['eyes']);
  working(['ea']);
  assert.deepEqual(await react(), { reacted: ['orch items/T-1: removed :eyes:', 'orch items/T-1: :thinking_face:'], failed: [] });
  assert.deepEqual(on(world, asked), ['thinking_face']);
  assert.deepEqual(await react(), { reacted: [], failed: [] });
  await writeReply(site, 'ea', 'Looking: the export job times out at 30s.');
  await react();
  assert.deepEqual(on(world, asked), ['thinking_face'], 'a reply not yet posted leaves it thinking');
  await post();
  await react();
  assert.deepEqual(on(world, asked), ['white_check_mark']);
  setItem({ lane: 'done', phase: 'closed' });
  assert.deepEqual(await react(), { reacted: [], failed: [] });
  assert.deepEqual(on(world, asked), ['white_check_mark']);
});

test('a working message reads received while the board is not listening', async () => {
  const { world, asked, state, react } = filed();
  working(['ea']);
  state.listening = false;
  await react();
  assert.deepEqual(on(world, asked), ['eyes']);
  state.listening = true;
  await react();
  assert.deepEqual(on(world, asked), ['thinking_face']);
});

test('a message the orchestrator acted on without a Slack reply reads ✋ while its task waits on the owner, and 👀 again once it does not', async () => {
  const { world, asked, react } = filed();
  await store.appendMessage(site, 'items/T-1', { text: 'Filed questions on the board.' });
  write(path.join(site, 'data', 'owner.json'), { items: [{ id: 'q1', topic: 'item:items/T-1', question: 'Which device?' }] });
  await react();
  assert.deepEqual(on(world, asked), ['raised_hand']);
  write(path.join(site, 'data', 'owner.json'), { items: [{ id: 'q1', topic: 'item:items/T-1', question: 'Which device?', resolved: 'Done.', resolved_at: '2026-11-15T11:00:00Z' }] });
  await react();
  assert.deepEqual(on(world, asked), ['eyes']);
});

test('each Slack message on a task carries its own status: a copied reply gets 👀 then 🤔, beside the ask', async () => {
  const { world, slack, asked, react, post } = filed();
  await writeReply(site, 'ea', 'On it.');
  await post();
  const later = slack.say({ channel: 'D2', user: 'U2', text: 'and the tests too', thread_ts: asked });
  addEvent({ id: 'es', ts: new Date().toISOString(), kind: 'item-message', data: { key: 'items/T-1', text: 'and the tests too', sendId: `slack:D2:${later}`, slack: { link: 'https://acme.slack.com/x', thread: { channel: 'D2', thread_ts: asked } } } });
  // The owner's board message is no Slack message, so nothing reacts to it.
  addEvent({ id: 'eb', ts: new Date().toISOString(), kind: 'item-message', data: { key: 'items/T-1', text: 'Hold off' } });
  await react();
  assert.deepEqual([on(world, asked), on(world, later)], [['white_check_mark'], ['eyes']]);
  working(['es']);
  await react();
  assert.deepEqual([on(world, asked), on(world, later)], [['white_check_mark'], ['thinking_face']]);
  assert.equal(world.reactions.length, 2);
});

test("a Done task's messages swap to ✅; a task Done before any poll saw it open gets nothing", async () => {
  const first = filed();
  await first.react();
  setItem({ lane: 'done', phase: 'merged' });
  await first.react();
  assert.deepEqual(on(first.world, first.asked), ['white_check_mark']);

  fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
  const late = filed();
  setItem({ lane: 'done', phase: 'closed' });
  assert.deepEqual(await late.react(), { reacted: [], failed: [] });
  assert.deepEqual(on(late.world, late.asked), ['eyes']);
});

test("the status emoji are Hub › Slack's picks, and an earlier ask with no recorded reaction counts intake's 👀 as its own", async () => {
  const { world, asked, react } = filed({ reacted: null });
  world.reactions.push({ channel: 'D2', timestamp: asked, name: 'eyes' });
  await setPREmoji('thinking', 'hourglass');
  working(['ea']);
  await react();
  assert.deepEqual(on(world, asked), ['hourglass']);
});

test('a reaction Slack refuses is reported and tried again next poll', async () => {
  const { world, slack, asked } = filed();
  working(['ea']);
  let refuse = true;
  const fetch = (url, init) => (refuse && String(url).endsWith('/reactions.add') ? { ok: true, status: 200, json: async () => ({ ok: false, error: 'message_not_found' }) } : slack.fetch(url, init));
  const failing = await reactSlackStatus({ boards, fetch, listening: () => true });
  assert.deepEqual(failing.failed, ['orch: reacting :thinking_face: to items/T-1: Slack: message_not_found']);
  refuse = false;
  await reactSlackStatus({ boards, fetch, listening: () => true });
  assert.deepEqual(on(world, asked), ['thinking_face']);
});
