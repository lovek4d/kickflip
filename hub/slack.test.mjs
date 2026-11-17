import { home, write, inProcessHub } from './hub-fixture.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeSlack, slackWorld } from '../shared/test-helpers.mjs';
import { slackClient, slackStatus, saveSlackToken, removeSlackToken, savedSlack, isSignedOff } from './slack.mjs';

const kf = (...p) => path.join(home, '.claude', 'kickflip', ...p);
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const site = kf('sites', 'orch');
const ann = { name: 'Ann', slack_user: 'U1', dm: 'D1', github: 'ann' };

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
  assert.deepEqual(world.messages.map((m) => [m.channel, m.text, m.thread_ts ?? null]), [['D2', 'https://github.com/o/r/pull/1\n- :claude_kickflip:', null], ['D2', 'reply\n- :claude_kickflip:', ts]]);
  // With attachments, the sign-off ends the last one's text instead, as its last line, and an edit names its time there.
  const bar = [{ color: '#2eb67d', title: 'Fix', title_link: 'https://github.com/o/r/pull/1', text: '+1/-0 · 1 file · low risk', fallback: 'r#1 Fix' }];
  const barred = await client.post({ channel: 'D2', text: '<@U2>', thread_ts: ts, attachments: bar });
  const signed = (a, line) => ({ ...a, text: `${a.text}\n${line}`, mrkdwn_in: ['text'] });
  assert.deepEqual(world.messages.at(-1), { channel: 'D2', user: 'U0', text: '<@U2>', thread_ts: ts, ts: barred, attachments: [signed(bar[0], '- :claude_kickflip:')] });
  assert.ok(isSignedOff(world.messages.at(-1).text, world.messages.at(-1).attachments));
  assert.ok(!isSignedOff('<@U2>', bar));
  const red = { ...bar[0], color: '#e01e5a' };
  // 14:05 in Los Angeles
  await client.update({ channel: 'D2', ts: barred, text: '<@U2>', attachments: [red], at: new Date('2026-11-02T22:05:00Z') });
  assert.deepEqual(world.messages.at(-1).attachments, [signed(red, '- :claude_kickflip: · _updated 14:05_')]);
  assert.ok(isSignedOff(world.messages.at(-1).text, world.messages.at(-1).attachments));
  world.messages.length = 2;
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

test('the hub saves the Slack token from its settings form and serves only the workspace and user', async (t) => {
  const web = kf();
  write(path.join(web, 'manifest.json'), { version: 1, sites: {} });
  const world = slackWorld();
  const server = await fakeSlack(world).serve();
  t.after(() => server.close());
  process.env.KICKFLIP_SLACK_URL = server.url;
  const { base } = await inProcessHub(t);
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

test('every post ends with a “- :claude_kickflip:” line, or “- :robot_face:” when the workspace lacks the emoji or the token lacks emoji:read, and the emoji is looked up once per client', async () => {
  for (const [name, change, line] of [['has it', {}, '- :claude_kickflip:'], ['no emoji', { noEmoji: true }, '- :robot_face:'], ['no scope', { emojiMissingScope: true }, '- :robot_face:']]) {
    const world = Object.assign(slackWorld(), change);
    const slack = fakeSlack(world);
    const client = slackClient(world.token, { fetch: slack.fetch });
    await client.post({ channel: 'D2', text: 'one' });
    await client.post({ channel: 'D2', text: 'two\nlines' });
    assert.deepEqual(world.messages.map((m) => m.text), [`one\n${line}`, `two\nlines\n${line}`], name);
    assert.equal(slack.calls.filter((c) => c.method === 'emoji.list').length, 1, name);
  }
});

test('a PR reaction uses the custom git_approved and git_merged when the workspace has them, else the standard emojis, and x as it is; a failed emoji.list reads as none', async () => {
  for (const [name, change, want] of [
    ['has them', {}, ['git_approved', 'git_merged', 'x']],
    ['no custom', { noEmoji: true }, ['white_check_mark', 'large_purple_circle', 'x']],
    ['no scope', { emojiMissingScope: true }, ['white_check_mark', 'large_purple_circle', 'x']],
  ]) {
    const world = Object.assign(slackWorld(), change);
    const slack = fakeSlack(world);
    const client = slackClient(world.token, { fetch: slack.fetch });
    assert.deepEqual([await client.prEmoji('git_approved'), await client.prEmoji('git_merged'), await client.prEmoji('x')], want, name);
    assert.equal(slack.calls.filter((c) => c.method === 'emoji.list').length, 1, name);
  }
});

test('an edit is signed off with its time in the Slack timezone, in italics, and still reads as ours', async () => {
  for (const [change, line] of [[{}, '- :claude_kickflip:'], [{ noEmoji: true }, '- :robot_face:']]) {
    const world = Object.assign(slackWorld(), change);
    const slack = fakeSlack(world);
    const client = slackClient(world.token, { fetch: slack.fetch });
    const ts = await client.post({ channel: 'D2', text: 'Board Digest\n2 PRs pending review' });
    // 14:05 in Los Angeles
    await client.update({ channel: 'D2', ts, text: 'Board Digest\n1 PR pending review', at: new Date('2026-11-02T22:05:00Z') });
    assert.equal(world.messages[0].text, `Board Digest\n1 PR pending review\n${line} · _updated 14:05_`);
    assert.ok(isSignedOff(world.messages[0].text));
  }
  assert.ok(isSignedOff('words\n- :claude_kickflip:'));
  assert.ok(!isSignedOff('words\n- :claude_kickflip: · updated later'));
  assert.ok(!isSignedOff('- :claude_kickflip:\nmore words'));
});

test('read methods go form-encoded, as Slack reads them, and writes go as JSON', async () => {
  const world = slackWorld();
  const slack = fakeSlack(world);
  const client = slackClient(world.token, { fetch: slack.fetch });
  const sent = [];
  const spy = async (url, init) => { sent.push([String(url).split('/').at(-1), init.headers['content-type'], init.body]); return slack.fetch(url, init); };
  const spied = slackClient(world.token, { fetch: spy });
  await client.post({ channel: 'D2', text: 'kickflip hello' });
  await spied.search({ query: 'kickflip' });
  await spied.people();
  await spied.post({ channel: 'D2', text: 'x' });
  const by = (m) => sent.find(([method]) => method === m);
  assert.equal(by('search.messages')[1], 'application/x-www-form-urlencoded');
  assert.equal(new URLSearchParams(by('search.messages')[2]).get('query'), 'kickflip');
  assert.equal(by('users.list')[1], 'application/x-www-form-urlencoded');
  assert.match(by('emoji.list')[1], /^application\/x-www-form-urlencoded/);
  assert.match(by('chat.postMessage')[1], /^application\/json/);
  assert.equal((await spied.search({ query: 'hello' })).length, 1);
});
