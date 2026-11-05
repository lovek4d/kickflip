import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeSlack, slackWorld } from '../shared/test-helpers.mjs';

// boards.mjs and store.mjs read HOME as they load, so it is set before they are imported.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-'));
process.env.HOME = home;
process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));
const { slackClient, slackStatus, saveSlackToken, removeSlackToken, savedSlack } = await import('./slack.mjs');
const { sendReviews } = await import('./review-send.mjs');
const { reviewUpdated } = await import('../board/store.mjs');

const kf = (...p) => path.join(home, '.claude', 'kickflip', ...p);
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const site = kf('sites', 'orch');
const waveFile = path.join(home, '.claude', 'waves', 'w', 'wave.json');
const ann = { name: 'Ann', slack_user: 'U1', dm: 'D1', github: 'ann' };
const bob = { name: 'Bob', slack_user: 'U2', dm: 'D2', github: 'bob' };
const saveToken = (world, extra = {}) => write(kf('secrets.json'), { slack: { token: world.token, team: world.team, team_id: world.team_id, user: world.user, user_id: world.user_id, saved_at: '2026-11-02T00:00:00Z', ...extra } });

beforeEach(() => {
  fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
  write(path.join(site, 'board.json'), { title: 'Orch', items: 'waves', reviewers: [ann] });
  write(kf('slack.json'), { timezone: 'America/Los_Angeles' });
});

test('the client checks the token, opens a DM, posts and threads, and reacts once, through the fetch it is given', async () => {
  const world = slackWorld();
  const slack = fakeSlack(world);
  const client = slackClient(world.token, { fetch: slack.fetch });
  assert.deepEqual(await client.who(), { team: 'Acme', team_id: 'T1', user: 'love', user_id: 'U0' });
  assert.equal(await client.openDM('U2'), 'D2');
  const ts = await client.post({ channel: 'D2', text: 'https://github.com/o/r/pull/1' });
  await client.post({ channel: 'D2', text: 'reply', thread_ts: ts });
  assert.deepEqual(world.messages.map((m) => [m.channel, m.text, m.thread_ts ?? null]), [['D2', 'https://github.com/o/r/pull/1', null], ['D2', 'reply', ts]]);
  for (let i = 0; i < 2; i++) await client.react({ channel: 'D2', ts, name: 'git_merged' });
  assert.deepEqual(world.reactions, [{ channel: 'D2', timestamp: ts, name: 'git_merged' }]);
  await assert.rejects(client.openDM('U404'), { message: 'Slack: user_not_found', status: 502 });
  let refused = null;
  await assert.rejects(slackClient('xoxp-wrong-token', { fetch: slack.fetch, checked: (works) => { refused = !works; } }).who(), { message: 'Slack refused the token.', status: 400 });
  assert.equal(refused, true);
  await assert.rejects(slackClient(world.token, { fetch: async () => { throw new Error('offline'); } }).who(), { message: 'Could not reach Slack: offline', status: 502 });
});

test("the client lists the workspace's people by name, leaving out bots and deactivated accounts, and says when the token lacks users:read", async () => {
  const world = slackWorld();
  world.people = [
    { id: 'U2', name: 'bob', profile: { real_name: 'Bob Lee' } }, { id: 'U1', name: 'ann', real_name: 'Ann Fox' },
    { id: 'U9', name: 'gone', deleted: true }, { id: 'B1', name: 'robot', is_bot: true }, { id: 'USLACKBOT', name: 'slackbot' }, { id: 'U3', name: 'cy' },
  ];
  const client = slackClient(world.token, { fetch: fakeSlack(world).fetch });
  assert.deepEqual(await client.people(), [{ id: 'U1', name: 'Ann Fox' }, { id: 'U2', name: 'Bob Lee' }, { id: 'U3', name: 'cy' }]);
  world.missingScope = true;
  await assert.rejects(client.people(), { message: 'Slack: missing_scope' });
});

test('the token is saved in secrets.json once Slack answers, as refused when Slack refuses it, and its status names the workspace without it', async () => {
  const world = slackWorld();
  const { fetch } = fakeSlack(world);
  const file = kf('secrets.json');
  write(file, { linear: { key: 'lin_api_kept' } });
  assert.deepEqual(slackStatus(), { set: false });
  for (const bad of ['', 'xoxb-bot-token', 'two words']) await assert.rejects(saveSlackToken(bad, { fetch }), { status: 400 });
  await assert.rejects(saveSlackToken(world.token, { fetch: async () => { throw new Error('offline'); } }), { status: 502 });
  assert.equal(read(file).slack, undefined);
  assert.deepEqual(await saveSlackToken('xoxp-wrong-token', { fetch }), { set: true, refused: true });
  assert.deepEqual(await saveSlackToken(` ${world.token} `, { fetch }), { set: true, team: 'Acme', user: 'love' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual([read(file).slack.token, read(file).slack.user_id, read(file).linear], [world.token, 'U0', { key: 'lin_api_kept' }]);
  assert.doesNotMatch(JSON.stringify(slackStatus()), /xoxp/);
  const token = world.token;
  world.token = 'xoxp-rotated';
  await assert.rejects(savedSlack({ fetch }).who(), { message: 'Slack refused the token.' });
  assert.deepEqual(slackStatus(), { set: true, refused: true, team: 'Acme', user: 'love' });
  world.token = token;
  await savedSlack({ fetch }).who();
  assert.deepEqual(slackStatus(), { set: true, team: 'Acme', user: 'love' });
  assert.deepEqual(removeSlackToken(), { set: false });
  assert.deepEqual(read(file), { linear: { key: 'lin_api_kept' } });
  assert.equal(savedSlack({ fetch }), null);
});

test('the hub sends each owed review link in a DM it opens, each git_merged reaction and the weekday digest, records each once, and sends nothing without a working token', async () => {
  const now = new Date('2026-11-02T17:00:00Z');
  const world = { ...slackWorld(), dms: { U1: 'D1', U2: 'D9' } };
  const slack = fakeSlack(world);
  write(waveFile, { repo: 'o/r', reviewers: [bob], items: [
    { id: 'A1', title: 'Open', pr: 1 },
    { id: 'A3', title: 'Merged', pr: 3, status: 'merged', review_link_ts: { Ann: { ts: '1792700000.1', channel: 'D1' } } },
  ] });
  write(kf('github-state.json'), { prs: { 'o/r#1': { state: 'OPEN', isDraft: false, reviewDecision: 'REVIEW_REQUIRED' }, 'o/r#3': { state: 'MERGED' } } });
  const boards = [{ route: 'orch', dir: site, title: 'Orch' }];

  assert.deepEqual(await sendReviews({ boards, fetch: slack.fetch, now }), { sent: [], failed: [] });
  assert.equal(slack.calls.length, 0);

  saveToken(world);
  const first = await sendReviews({ boards, fetch: slack.fetch, now });
  assert.deepEqual(first.failed, []);
  const top = world.messages.filter((m) => !m.thread_ts);
  assert.deepEqual(top.map((m) => [m.channel, m.text]), [
    ['D1', 'https://github.com/o/r/pull/1'], ['D9', 'https://github.com/o/r/pull/1'],
    ['D1', '🤖 Orch digest: 1 PR pending your review'], ['D9', '🤖 Orch digest: 1 PR pending your review'],
  ]);
  const replies = world.messages.filter((m) => m.thread_ts);
  assert.deepEqual(replies.map((m) => [m.channel, m.text, m.thread_ts]), [['D1', 'https://github.com/o/r/pull/1 · Open', top[2].ts], ['D9', 'https://github.com/o/r/pull/1 · Open', top[3].ts]]);
  assert.deepEqual(world.reactions, [{ channel: 'D1', timestamp: '1792700000.1', name: 'git_merged' }]);
  const items = read(waveFile).items;
  assert.deepEqual(items[0].review_link_ts, { Ann: { ts: top[0].ts, channel: 'D1' }, Bob: { ts: top[1].ts, channel: 'D9' } });
  assert.deepEqual(items[1].review_link_ts.Ann.reactions, ['git_merged']);
  assert.deepEqual(read(path.join(site, 'data', 'review-digests.json')).digests.map((d) => [d.reviewer, d.dm, d.ts, d.items]), [['Ann', 'D1', top[2].ts, ['w/A1']], ['Bob', 'D9', top[3].ts, ['w/A1']]]);
  assert.equal(first.sent.length, 5);

  const calls = slack.calls.length;
  assert.deepEqual(await sendReviews({ boards, fetch: slack.fetch, now }), { sent: [], failed: [] });
  assert.equal(slack.calls.length, calls);

  write(waveFile, { ...read(waveFile), items: [...read(waveFile).items, { id: 'A5', title: 'Fresh', pr: 5 }] });
  write(kf('github-state.json'), { prs: { ...read(kf('github-state.json')).prs, 'o/r#5': { state: 'OPEN', isDraft: false } } });
  world.token = 'xoxp-revoked';
  const refused = await sendReviews({ boards, fetch: slack.fetch, now });
  assert.deepEqual([refused.sent, refused.failed], [[], ['orch: Slack refused the token.']]);
  assert.equal(slackStatus().refused, true);
  assert.equal(read(waveFile).items[2].review_link_ts, undefined);
});

test('one reviewer Slack refuses leaves the others sent and the refused one owed', async () => {
  const world = { ...slackWorld(), dms: { U2: 'D2' } };
  const slack = fakeSlack(world);
  saveToken(world);
  write(waveFile, { repo: 'o/r', reviewers: [bob], items: [{ id: 'A1', title: 'Open', pr: 1 }] });
  write(kf('github-state.json'), { prs: { 'o/r#1': { state: 'OPEN', isDraft: false } } });
  const out = await sendReviews({ boards: [{ route: 'orch', dir: site, title: 'Orch' }], fetch: slack.fetch, now: new Date('2026-11-01T17:00:00Z') });
  assert.deepEqual(out.failed, ['orch: link to Ann on w/A1: Slack: user_not_found']);
  assert.deepEqual(Object.keys(read(waveFile).items[0].review_link_ts), ['Bob']);
});

test('review updated posts “🤖 Updated: …” under each recorded link of a reviewer who has not approved', async () => {
  const world = slackWorld();
  const slack = fakeSlack(world);
  write(waveFile, { repo: 'o/r', reviewers: [bob], items: [
    { id: 'A1', title: 'Open', pr: 1, review_link_ts: { Ann: { ts: '1792700000.1', channel: 'D1' }, Bob: { ts: '1792700000.2', channel: 'D2' } } },
    { id: 'A2', title: 'Unsent', pr: 2 },
  ] });
  const asked = [];
  const reviews = async (repo, number) => { asked.push(`${repo}#${number}`); return { bob: 'APPROVED', ann: 'COMMENTED' }; };
  await assert.rejects(reviewUpdated(site, 'w/A1', 'retries now back off', { fetch: slack.fetch, reviews }), /Hub’s Slack token/);
  saveToken(world);
  await assert.rejects(reviewUpdated(site, 'w/A1', '  ', { fetch: slack.fetch, reviews }), /non-empty/);
  assert.deepEqual((await reviewUpdated(site, 'w/A1', 'retries now back off', { fetch: slack.fetch, reviews })).lines, ['🤖 Updated sent to Ann on w/A1']);
  assert.deepEqual(world.messages, [{ channel: 'D1', text: '🤖 Updated: retries now back off', thread_ts: '1792700000.1', ts: world.messages[0].ts }]);
  assert.deepEqual(asked, ['o/r#1']);
  assert.deepEqual((await reviewUpdated(site, 'w/A2', 'x', { fetch: slack.fetch, reviews })).lines, ['no reviewer waiting on a sent link for w/A2']);
});

test('the hub saves the Slack token from its settings form and serves only the workspace and user', async (t) => {
  const { spawn } = await import('node:child_process');
  const { freePorts } = await import('../shared/test-helpers.mjs');
  const hubHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-slack-'));
  const web = path.join(hubHome, '.claude', 'kickflip');
  write(path.join(web, 'manifest.json'), { version: 1, sites: {} });
  const world = slackWorld();
  const server = await fakeSlack(world).serve();
  const [port] = await freePorts(1);
  const hub = spawn(process.execPath, [new URL('./hub.mjs', import.meta.url).pathname], { env: { ...process.env, HOME: hubHome, KICKFLIP_HUB_PORT: String(port), KICKFLIP_CLAUDE: '/usr/bin/false', KICKFLIP_TMUX: '/usr/bin/false', KICKFLIP_SLACK_URL: server.url } });
  t.after(async () => { hub.kill(); await server.close(); fs.rmSync(hubHome, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    let out = '';
    hub.stdout.on('data', (d) => { out += d; if (out.includes('hub on')) resolve(); });
    hub.once('exit', reject);
  });
  const base = `http://127.0.0.1:${port}`;
  const form = (body) => fetch(`${base}/_hub/settings/slack`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body });
  assert.equal((await (await fetch(`${base}/_hub/api/settings`)).json()).slack.summary, 'No token');
  const bad = await form('token=xoxb-a-bot-token-here');
  assert.deepEqual([bad.status, (await bad.json()).error], [400, 'Paste a Slack user token, which starts with xoxp-.']);
  const saved = await form(`token=${world.token}`);
  assert.equal(saved.status, 200);
  const text = await saved.text();
  assert.doesNotMatch(text, /xoxp/);
  assert.deepEqual([JSON.parse(text).slack.summary, JSON.parse(text).slack.sub], ['Token set · Acme workspace', 'Token •••••••• · sends as love']);
  assert.equal(read(path.join(web, 'secrets.json')).slack.token, world.token);
  assert.equal(fs.statSync(path.join(web, 'secrets.json')).mode & 0o777, 0o600);
  assert.equal((await form('remove=1')).status, 200);
  assert.equal(read(path.join(web, 'secrets.json')).slack, undefined);
});
