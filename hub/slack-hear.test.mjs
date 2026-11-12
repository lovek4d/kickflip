import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fakeSlack, slackWorld } from '../shared/test-helpers.mjs';

// boards.mjs and store.mjs read HOME as they load, so it is set before they are imported.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-hear-'));
process.env.HOME = home;
process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));
const { sendReviews } = await import('./review-send.mjs');
const { slackStatus, slackClient } = await import('./slack.mjs');
const { readinessRows } = await import('./readiness.mjs');
const { slackThread, slackAnswer, slackSay, slackTask } = await import('../board/store.mjs');

const kf = (...p) => path.join(home, '.claude', 'kickflip', ...p);
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const site = kf('sites', 'orch');
const waveFile = path.join(home, '.claude', 'waves', 'w', 'wave.json');
const ann = { name: 'Ann', slack_user: 'U1', dm: 'D1', github: 'ann' };
const saveToken = (world) => write(kf('secrets.json'), { slack: { token: world.token, team: world.team, team_id: world.team_id, user: world.user, user_id: world.user_id, saved_at: '2026-11-02T00:00:00Z' } });
const boards = [{ route: 'orch', dir: site, title: 'Orch' }];
const events = () => lines(path.join(site, 'data', 'events.jsonl'));
const questions = () => events().filter((e) => e.kind === 'slack-question').map((e) => e.data);
const pr = { state: 'OPEN', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', head: 'aaa0000000', title: 'Fix limiter', additions: 84, deletions: 12, files: 5, approved: false };
const sunday = new Date('2026-11-01T17:00:00Z');
const days = (n) => new Date(sunday.getTime() + n * 86400000);

beforeEach(() => {
  fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
  write(path.join(site, 'board.json'), { title: 'Orch', items: 'waves', reviewers: [ann] });
  write(kf('slack.json'), { timezone: 'America/Los_Angeles', slack_domain: 'acme' });
  write(waveFile, { repo: 'o/r', items: [{ id: 'A1', title: 'Limits', pr: 1 }] });
  write(kf('github-state.json'), { prs: { 'o/r#1': pr } });
});

// A board with Ann's day thread open, its header and the PR's link posted. → {world, slack, poll, day}
async function opened() {
  const world = slackWorld();
  const slack = fakeSlack(world);
  saveToken(world);
  const poll = (now = sunday) => sendReviews({ boards, fetch: slack.fetch, now });
  await poll();
  return { world, slack, poll, day: world.messages[0].ts };
}

test("each new message in an open day thread wakes its board once with a slack-question event: a reviewer's always expects an answer, the owner's only when it names @kickflip, and the board's own posts wake nobody", async () => {
  const { world, slack, poll, day } = await opened();
  assert.deepEqual(world.messages.map((m) => m.text), ['Orch reviews\n- :claude_kickflip:', `<@U1> <https://github.com/o/r/pull/1|r#1> ready for review: Fix limiter (+84/-12, 5 files)\n- :claude_kickflip:`]);
  assert.deepEqual(await poll(), { sent: [], failed: [] });
  assert.deepEqual(questions(), []);

  const asked = slack.say({ channel: 'D1', user: 'U1', text: 'Why a limiter per key?', thread_ts: day });
  const aside = slack.say({ channel: 'D1', user: 'U0', text: 'I will look tonight', thread_ts: day });
  const named = slack.say({ channel: 'D1', user: 'U0', text: '@Kickflip what is left on r#1?', thread_ts: day });
  slack.say({ channel: 'D1', user: 'U1', text: 'not in the thread' });
  assert.deepEqual((await poll()).sent, ['orch: slack-question from Ann', 'orch: slack-question from the owner', 'orch: slack-question from the owner']);
  const where = { reviewer: 'Ann', channel: 'D1', thread_ts: day };
  assert.deepEqual(questions(), [
    { ...where, ts: asked, from: 'reviewer', answer: true },
    { ...where, ts: aside, from: 'owner', answer: false },
    { ...where, ts: named, from: 'owner', answer: true },
  ]);

  // An answer the orchestrator posted, and a quiet poll, wake nobody; a quiet poll reads only the DM's history.
  slack.say({ channel: 'D1', user: 'U0', text: 'It keeps one noisy key from starving the rest.\n- :claude_kickflip:', thread_ts: day });
  await poll();
  slack.calls.length = 0;
  await poll();
  assert.deepEqual(slack.calls.map((c) => c.method), ['conversations.history']);
  assert.equal(questions().length, 3);

  // A thread is heard for 7 days after it opens, then no more.
  const later = slack.say({ channel: 'D1', user: 'U1', text: 'Thanks, and the reset?', thread_ts: day });
  await poll(days(6));
  assert.deepEqual(questions().at(-1), { ...where, ts: later, from: 'reviewer', answer: true });
  slack.say({ channel: 'D1', user: 'U1', text: 'Still there?', thread_ts: day });
  await poll(days(7));
  assert.equal(questions().length, 4);
});

test("until the token can read DMs (im:history), sends go on, the owner is pushed once and the Slack row says so; a read that works clears it", async () => {
  const world = slackWorld();
  const slack = fakeSlack(world);
  saveToken(world);
  world.unheard = true;
  const poll = () => sendReviews({ boards, fetch: slack.fetch, now: sunday });
  const first = await poll();
  assert.deepEqual(first.sent, ['orch: link to Ann on o/r#1', "pushed that Slack can't read the review threads"]);
  assert.deepEqual(first.failed, []);
  assert.equal(slackStatus().unheard, true);
  const [row] = readinessRows({ slack: slackStatus() });
  assert.equal(row.ready, true);
  assert.equal(row.note, "Can't read replies in the review threads: add im:history to the Slack app, reinstall it and paste its new token.");
  assert.deepEqual(await poll(), { sent: [], failed: [] });
  world.unheard = false;
  await poll();
  assert.equal(slackStatus().unheard, undefined);
  assert.equal(readinessRows({ slack: slackStatus() })[0].note, undefined);
});

test('slack thread reads the thread, slack answer posts the answer signed off in it, and slack task files the request grilling with the message in its thread', async () => {
  const { world, slack, poll, day } = await opened();
  const asked = slack.say({ channel: 'D1', user: 'U1', text: 'Could the digest skip drafts?\nThey clutter it.', thread_ts: day });
  slack.say({ channel: 'D1', user: 'U0', text: 'fyi', thread_ts: day });
  await poll();
  const [question, quiet] = events().filter((e) => e.kind === 'slack-question');
  const client = slackClient(world.token, { fetch: slack.fetch });

  assert.deepEqual((await slackThread(site, question.id, client)).lines, [
    'board: Orch reviews',
    '    - :claude_kickflip:',
    'board: <@U1> <https://github.com/o/r/pull/1|r#1> ready for review: Fix limiter (+84/-12, 5 files)',
    '    - :claude_kickflip:',
    '→ Ann: Could the digest skip drafts?',
    '    They clutter it.',
    'you: fyi',
  ]);

  await slackAnswer(site, question.id, 'Drafts never reach it; filed a task for the owner.', client);
  assert.deepEqual(world.messages.at(-1), { channel: 'D1', user: 'U0', text: 'Drafts never reach it; filed a task for the owner.\n- :claude_kickflip:', thread_ts: day, ts: world.messages.at(-1).ts });
  await assert.rejects(slackAnswer(site, quiet.id, 'ok', client), /names no @kickflip, so it expects no reply/);
  await slackAnswer(site, question.id, 'x'.repeat(250), client);
  await assert.rejects(slackAnswer(site, question.id, 'x'.repeat(251), client), /runs to 251 characters, past the orchestrator's 250/);
  await assert.rejects(slackAnswer(site, 'enope', 'ok', client), /no slack-question "enope"/);

  const filed = await slackTask(site, question.id, 'w', { title: 'Digest skips drafts', notes: 'Ann asks the digest to skip drafts.' }, client);
  assert.equal(filed.key, 'w/T-1');
  const card = read(waveFile).items.find((i) => i.id === 'T-1');
  assert.equal(card.phase, 'grilling');
  const thread = lines(path.join(site, 'data', 'threads', 'w__T-1.jsonl'));
  const said = thread.find((l) => l.via === 'slack');
  assert.deepEqual([said.who, said.text, said.link], ['Ann', 'Could the digest skip drafts?\nThey clutter it.', `https://acme.slack.com/archives/D1/p${asked.replace('.', '')}?thread_ts=${day}&cid=D1`]);
});

test("slack say posts the words signed off in the reviewer's day thread, opening today's when none is open, and the hub hears past it", async () => {
  const { world, slack, poll, day } = await opened();
  const client = slackClient(world.token, { fetch: slack.fetch });
  assert.deepEqual((await slackSay(site, 'ann', 'r#1 is ready for another look.', { now: sunday }, client)).lines, ["said in Ann's day thread"]);
  assert.deepEqual(world.messages.at(-1), { channel: 'D1', user: 'U0', text: 'r#1 is ready for another look.\n- :claude_kickflip:', thread_ts: day, ts: world.messages.at(-1).ts });
  await poll();
  assert.deepEqual(questions(), []);

  // The next day, the words open that day's thread under the board's header.
  world.messages.length = 0;
  await slackSay(site, 'Ann', 'Merged.', { now: days(1) }, client);
  const [header, said] = world.messages;
  assert.deepEqual([header.channel, header.text, header.thread_ts], ['D1', 'Orch reviews\n- :claude_kickflip:', undefined]);
  assert.deepEqual([said.text, said.thread_ts], ['Merged.\n- :claude_kickflip:', header.ts]);
  await poll(days(1));
  assert.deepEqual(questions(), []);

  await assert.rejects(slackSay(site, 'Ann', 'x'.repeat(251), { now: sunday }, client), /runs to 251 characters, past the orchestrator's 250/);
  await assert.rejects(slackSay(site, 'Zed', 'hi', { now: sunday }, client), /no reviewer "Zed" on this board; its reviewers are Ann/);
});

test('board.mjs slack thread, slack answer, slack say and slack task run through Hub’s token', async () => {
  const { world, slack, poll, day } = await opened();
  slack.say({ channel: 'D1', user: 'U1', text: 'Can it batch?', thread_ts: day });
  await poll();
  const [question] = events().filter((e) => e.kind === 'slack-question');
  const server = await slack.serve();
  try {
    const cli = (...args) => new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'board', 'bin', 'board.mjs'), '--site', 'orch', ...args], { env: { ...process.env, HOME: home, KICKFLIP_SLACK_URL: server.url, KICKFLIP_HUB_PORT: '1' } });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('close', (code) => resolve({ code, out, err }));
    });
    const thread = await cli('slack', 'thread', question.id);
    assert.equal(thread.code, 0, thread.err);
    assert.match(thread.out, /→ Ann: Can it batch\?/);
    const answered = await cli('slack', 'answer', question.id, '--text', 'Not yet; filed for the owner.');
    assert.equal(answered.code, 0, answered.err);
    assert.equal(world.messages.at(-1).text, 'Not yet; filed for the owner.\n- :claude_kickflip:');
    const said = await cli('slack', 'say', 'Ann', '--text', 'Batching is filed.');
    assert.equal(said.code, 0, said.err);
    assert.equal(world.messages.at(-1).text, 'Batching is filed.\n- :claude_kickflip:');
    const filed = await cli('slack', 'task', question.id, 'w', '--title', 'Batch sends', '--notes', 'Ann asks for batching.');
    assert.equal(filed.code, 0, filed.err);
    assert.match(filed.out, /w\/T-1/);
    // A reviewer's request is filed grilling, for the owner's review: the command takes no phase or size.
    const refused = await cli('slack', 'task', question.id, 'w', '--title', 'Batch sends', '--notes', 'x', '--phase', 'ready');
    assert.notEqual(refused.code, 0);
    assert.equal(read(waveFile).items.find((i) => i.id === 'T-1').phase, 'grilling');
  } finally { await server.close(); }
});
