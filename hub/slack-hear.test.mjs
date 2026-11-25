import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fakeSlack, slackWorld } from '../shared/test-helpers.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

// boards.mjs and store.mjs read HOME as they load, so it is set before they are imported.
const home = tempDir('slack-hear-');
process.env.HOME = home;
const { sendReviews } = await import('./review-send.mjs');
const { slackStatus, slackClient } = await import('./slack.mjs');
const { readinessRows } = await import('./readiness.mjs');
const { slackThread, slackAnswer, slackSay, slackTask, slackLink, slackSkip } =await import('../board/slack-store.mjs');

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

// A board with Ann's day thread open, its digest and the PR's link posted. → {world, slack, poll, day}
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
  assert.deepEqual(world.messages.map((m) => m.text), ['Orch Digest\n1 PR pending review\n- :skateboard:', '', '']);
  assert.deepEqual(world.messages.slice(1).map((m) => m.attachments[0].text), ['+84/-12 · 5 files\n- :skateboard:', '+84/-12 · 5 files\n- :skateboard:']);
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

test("until the token can read DMs (im:history), sends go on, the owner is pushed once and the Slack row reads degraded with im:history missing; a read that works clears it", async () => {
  const world = slackWorld();
  const slack = fakeSlack(world);
  saveToken(world);
  world.unheard = true;
  const poll = () => sendReviews({ boards, fetch: slack.fetch, now: sunday });
  const first = await poll();
  assert.deepEqual(first.sent, ['orch: digest to Ann', 'orch: link to Ann on o/r#1', "pushed that Slack can't read the review threads"]);
  assert.deepEqual(first.failed, []);
  assert.equal(slackStatus().unheard, true);
  const [row] = readinessRows({ slack: slackStatus() });
  assert.equal(row.ready, true);
  assert.deepEqual(row.permissions.missing, [{ scope: 'im:history', effect: "Review-thread replies aren't heard" }]);
  assert.deepEqual(await poll(), { sent: [], failed: [] });
  world.unheard = false;
  await poll();
  assert.equal(slackStatus().unheard, undefined);
  assert.equal(readinessRows({ slack: slackStatus() })[0].permissions, undefined);
});

test('slack thread reads the thread, slack answer posts the answer signed off in it, and slack task files the request discussing with the message in its thread', async () => {
  const { world, slack, poll, day } = await opened();
  const asked = slack.say({ channel: 'D1', user: 'U1', text: 'Could the digest skip drafts?\nThey clutter it.', thread_ts: day });
  slack.say({ channel: 'D1', user: 'U0', text: 'fyi', thread_ts: day });
  await poll();
  const [question, quiet] = events().filter((e) => e.kind === 'slack-question');
  const client = slackClient(world.token, { fetch: slack.fetch });

  assert.deepEqual((await slackThread(site, question.id, client)).lines, [
    'board: Orch Digest',
    '    1 PR pending review',
    '    - :skateboard:',
    'board: r#1 Fix limiter · +84/-12 · 5 files',
    'board: r#1 Fix limiter · +84/-12 · 5 files',
    '→ Ann: Could the digest skip drafts?',
    '    They clutter it.',
    'you: fyi',
  ]);

  // docs/adr/2026-11-15-1200-an-event-with-no-task-waits-on-the-orchestrator-until-acted-on.md: each command that acts
  // on a message records it handled; reading one that expects a reply does not.
  const handled = () => events().filter((e) => e.kind === 'slack-handled').map((e) => e.data);
  assert.deepEqual(handled(), []);
  await slackThread(site, quiet.id, client);
  assert.deepEqual(handled(), [{ id: quiet.id, by: 'thread' }]);
  await slackAnswer(site, question.id, 'Drafts never reach it; filed a task for the owner.', client);
  assert.deepEqual(handled().at(-1), { id: question.id, by: 'answer' });
  assert.deepEqual((await slackSkip(site, question.id)).lines, ["no reply to Ann's day thread"]);
  assert.deepEqual(handled().at(-1), { id: question.id, by: 'skip' });
  await assert.rejects(slackSkip(site, 'enope'), /no slack-question "enope"/);
  assert.deepEqual(world.messages.at(-1), { channel: 'D1', user: 'U0', text: 'Drafts never reach it; filed a task for the owner.\n- :skateboard:', thread_ts: day, ts: world.messages.at(-1).ts });
  await assert.rejects(slackAnswer(site, quiet.id, 'ok', client), /names no @kickflip, so it expects no reply/);
  await slackAnswer(site, question.id, 'x'.repeat(250), client);
  await assert.rejects(slackAnswer(site, question.id, 'x'.repeat(251), client), /runs to 251 characters, past the orchestrator's 250/);
  await assert.rejects(slackAnswer(site, 'enope', 'ok', client), /no slack-question "enope"/);

  const filed = await slackTask(site, question.id, 'w', { title: 'feat(digest): skip drafts', notes: 'Ann asks the digest to skip drafts.' }, client);
  assert.equal(filed.key, 'w/T-1');
  assert.deepEqual(handled().at(-1), { id: question.id, by: 'task' });
  const card = read(waveFile).items.find((i) => i.id === 'T-1');
  assert.equal(card.phase, 'discussing');
  const thread = lines(path.join(site, 'data', 'threads', 'w__T-1.jsonl'));
  const said = thread.find((l) => l.via === 'slack');
  assert.deepEqual([said.who, said.text, said.link], ['Ann', 'Could the digest skip drafts?\nThey clutter it.', `https://acme.slack.com/archives/D1/p${asked.replace('.', '')}?thread_ts=${day}&cid=D1`]);
});

test("slack say posts the words signed off in the reviewer's day thread, opening today's when none is open, and the hub hears past it", async () => {
  const { world, slack, poll, day } = await opened();
  const client = slackClient(world.token, { fetch: slack.fetch });
  assert.deepEqual((await slackSay(site, 'ann', 'r#1 is ready for another look.', { now: sunday }, client)).lines, ["said in Ann's day thread"]);
  assert.deepEqual(world.messages.at(-1), { channel: 'D1', user: 'U0', text: 'r#1 is ready for another look.\n- :skateboard:', thread_ts: day, ts: world.messages.at(-1).ts });
  await poll();
  assert.deepEqual(questions(), []);

  // The next day, the words open that day's thread with its digest, as the hub opens one, and the hub sends no second.
  world.messages.length = 0;
  await slackSay(site, 'Ann', 'Merged.', { now: days(1) }, client);
  const [header, listed, said] = world.messages;
  assert.deepEqual([header.channel, header.text, header.thread_ts], ['D1', 'Orch Digest\n1 PR pending review\n- :skateboard:', undefined]);
  assert.deepEqual([listed.attachments[0].title, listed.attachments[0].text, listed.thread_ts], ['Fix limiter', '+84/-12 · 5 files\n_(9 days old)_\n- :skateboard:', header.ts]);
  assert.deepEqual([said.text, said.thread_ts], ['Merged.\n- :skateboard:', header.ts]);
  await poll(days(1));
  assert.deepEqual(questions(), []);
  assert.equal(world.messages.length, 3);

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
    assert.equal(world.messages.at(-1).text, 'Not yet; filed for the owner.\n- :skateboard:');
    const said = await cli('slack', 'say', 'Ann', '--text', 'Batching is filed.');
    assert.equal(said.code, 0, said.err);
    assert.equal(world.messages.at(-1).text, 'Batching is filed.\n- :skateboard:');
    const filed = await cli('slack', 'task', question.id, 'w', '--title', 'feat(slack): batch sends', '--notes', 'Ann asks for batching.');
    assert.equal(filed.code, 0, filed.err);
    assert.match(filed.out, /w\/T-1/);
    // A reviewer's request is filed discussing, for the owner's review: the command takes no phase or size.
    const refused = await cli('slack', 'task', question.id, 'w', '--title', 'feat(slack): batch sends', '--notes', 'x', '--phase', 'ready');
    assert.notEqual(refused.code, 0);
    assert.equal(read(waveFile).items.find((i) => i.id === 'T-1').phase, 'discussing');
  } finally { await server.close(); }
});

test("slack link sends the PR's one message format, the bar with no mention, in the reviewer's day thread, recorded so the board sends no second and reactions follow", async () => {
  const { world, poll, slack, day } = await opened();
  const client = slackClient(world.token, { fetch: slack.fetch });
  write(waveFile, { repo: 'o/r', items: [{ id: 'A1', title: 'Limits', pr: 1 }, { id: 'A2', title: 'Docs', pr: 2, risk: 'high' }] });
  const readPR = async ({ repo, pr: n }) => ({ title: `Docs of ${repo}#${n}`, additions: 3, deletions: 0, files: 1 });
  const lineOf = (m) => [m.channel, m.thread_ts, m.text, m.attachments];
  assert.deepEqual((await slackLink(site, 'o/r#2', '@U1', { now: sunday, readPR }, client)).lines, ["sent o/r#2 to Ann's day thread"]);
  assert.deepEqual(lineOf(world.messages.at(-1)), ['D1', day, '', [{
    color: '#e01e5a', title: 'Docs of o/r#2', title_link: 'https://github.com/o/r/pull/2', text: '+3/-0 · 1 file · high risk\n- :skateboard:', mrkdwn_in: ['text'],
    fallback: 'r#2 Docs of o/r#2 · +3/-0 · 1 file · high risk',
  }]]);
  assert.equal(read(path.join(site, 'data', 'pr-slack.json'))['o/r#2'].links.Ann.ts, world.messages.at(-1).ts);
  const sentTs = world.messages.at(-1).ts;

  // A PR URL and a number in the board's repo name the PR as well; a PR on no card has no risk; the same PR goes once.
  await slackLink(site, 'https://github.com/x/y/pull/9', 'ann', { now: sunday, readPR }, client);
  assert.equal(world.messages.at(-1).attachments[0].color, '#9e9e9e');
  assert.equal(world.messages.at(-1).attachments[0].text, '+3/-0 · 1 file\n- :skateboard:');
  await assert.rejects(slackLink(site, 'o/r#2', 'Ann', { now: sunday, readPR }, client), /already gone out/);
  await assert.rejects(slackLink(site, 'nope', 'Ann', { readPR }, client), /is no PR/);
  await assert.rejects(slackLink(site, 'o/r#2', 'Zed', { readPR }, client), /no reviewer "Zed"/);
  await assert.rejects(slackLink(site, 'o/r#3', 'Ann', { readPR: async () => { throw new Error('o/r#3: not found'); } }, client), /not found/);

  // The board's own poll posts nothing a second time for it.
  const before = world.messages.length;
  await poll();
  assert.equal(world.messages.filter((m) => m.attachments?.some((a) => a.title_link === 'https://github.com/o/r/pull/2')).length, 1);
  assert.ok(world.messages.length >= before);
  // Its merge reacts on it, as on the board's own link, and leaves its words as they are.
  write(kf('github-state.json'), { prs: { 'o/r#1': pr, 'o/r#2': { ...pr, state: 'MERGED', title: 'Docs of o/r#2', additions: 3, deletions: 0, files: 1 } } });
  await poll();
  assert.deepEqual(world.reactions.filter((r) => r.timestamp === sentTs).map((r) => r.name), ['git_merged']);
  assert.equal(world.messages.find((m) => m.ts === sentTs).attachments[0].text, '+3/-0 · 1 file · high risk\n- :skateboard:');
});

test('prLink is the only builder of a PR message: no other source file makes a PR attachment', () => {
  const root = path.join(import.meta.dirname, '..');
  const sources = fs.readdirSync(root, { recursive: true }).filter((f) => /\.mjs$/.test(f) && !/(^|\/)(node_modules|dist)\/|\.test\.mjs$/.test(f));
  assert.deepEqual(sources.filter((f) => fs.readFileSync(path.join(root, f), 'utf8').includes('title_link')), [path.join('board', 'slack-store.mjs')]);
});
