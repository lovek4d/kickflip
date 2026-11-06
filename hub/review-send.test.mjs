import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeSlack, slackWorld } from '../shared/test-helpers.mjs';

// boards.mjs and store.mjs read HOME as they load, so it is set before they are imported.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'review-send-'));
process.env.HOME = home;
process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));
const { sendReviews } = await import('./review-send.mjs');
const { reviewUpdated, reviewDigest, reviewDue } = await import('../board/store.mjs');

const kf = (...p) => path.join(home, '.claude', 'kickflip', ...p);
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const site = kf('sites', 'orch');
const waveFile = path.join(home, '.claude', 'waves', 'w', 'wave.json');
const ann = { name: 'Ann', slack_user: 'U1', dm: 'D1', github: 'ann' };
const bob = { name: 'Bob', slack_user: 'U2', dm: 'D2', github: 'bob' };
const saveToken = (world) => write(kf('secrets.json'), { slack: { token: world.token, team: world.team, team_id: world.team_id, user: world.user, user_id: world.user_id, saved_at: '2026-11-02T00:00:00Z' } });
const boards = [{ route: 'orch', dir: site, title: 'Orch' }];
const prSlack = () => read(path.join(site, 'data', 'pr-slack.json'));
const digests = () => read(path.join(site, 'data', 'review-digests.json')).digests;
const pr = (over = {}) => ({ state: 'OPEN', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', head: 'aaa0000000', title: 'Fix limiter', additions: 84, deletions: 12, files: 5, approved: false, commits: [{ oid: 'aaa0000000', subject: 'Add limiter' }], ...over });
const setPRs = (prs) => write(kf('github-state.json'), { prs });
// 09:00 on a Monday in Los Angeles, when the digest opens; and a Sunday, when none is due
const monday = new Date('2026-11-02T17:00:00Z');
const sunday = new Date('2026-11-01T17:00:00Z');

beforeEach(() => {
  fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
  write(path.join(site, 'board.json'), { title: 'Orch', items: 'waves', reviewers: [ann] });
  write(kf('slack.json'), { timezone: 'America/Los_Angeles' });
});

test("each open PR gets its own link to every reviewer, in the owner's format, and pushes, Updated and reactions go to that link", async () => {
  const world = { ...slackWorld(), dms: { U1: 'D1', U2: 'D9' } };
  const slack = fakeSlack(world);
  write(waveFile, { repo: 'o/r', reviewers: [bob], items: [{ id: 'A1', title: 'Limits', prs: [{ number: 1 }, { number: 2 }] }] });
  setPRs({ 'o/r#1': pr(), 'o/r#2': pr({ isDraft: true, title: 'Docs' }) });
  const poll = () => sendReviews({ boards, fetch: slack.fetch, now: sunday });

  assert.deepEqual(await poll(), { sent: [], failed: [] });
  assert.equal(slack.calls.length, 0);
  saveToken(world);
  assert.deepEqual((await poll()).sent, ['orch: link to Ann on o/r#1', 'orch: link to Bob on o/r#1']);
  const link1 = 'Fix limiter\nhttps://github.com/o/r/pull/1\n+84/-12, 5 files';
  assert.deepEqual(world.messages.map((m) => [m.channel, m.text]), [['D1', link1], ['D9', link1]]);
  const [ann1, bob1] = world.messages.map((m) => m.ts);
  assert.deepEqual(prSlack()['o/r#1'], { head: 'aaa0000000', links: { Ann: { reactions: [], channel: 'D1', ts: ann1 }, Bob: { reactions: [], channel: 'D9', ts: bob1 } }, replies: [] });
  assert.deepEqual(await poll(), { sent: [], failed: [] });

  // A push replies in each thread with the new commits' subjects; the draft coming out gets its own fresh link.
  const commits = [{ oid: 'aaa0000000', subject: 'Add limiter' }, { oid: 'bbb0000000', subject: 'Fix reset' }, { oid: 'ccc0000000', subject: 'Add the reset test' }];
  setPRs({ 'o/r#1': pr({ head: 'ccc0000000', commits }), 'o/r#2': pr({ title: 'Docs', additions: 3, deletions: 0, files: 1 }) });
  world.messages.length = 0;
  await poll();
  const link2 = 'Docs\nhttps://github.com/o/r/pull/2\n+3/-0, 1 file';
  assert.deepEqual(world.messages.map((m) => [m.channel, m.text, m.thread_ts ?? null]), [
    ['D1', link2, null], ['D9', link2, null],
    ['D1', 'New push to #1\nFix reset · Add the reset test', ann1], ['D9', 'New push to #1\nFix reset · Add the reset test', bob1],
  ]);
  const [ann2, bob2] = world.messages.map((m) => m.ts);

  // Updated reaches every reviewer's thread on each of the card's PRs, approved or not.
  assert.deepEqual((await reviewUpdated(site, 'w/A1', 'limits reset per key')).lines, ['Updated queued for Ann, Bob on w/A1']);
  await assert.rejects(reviewUpdated(site, 'w/A1', '  '), /non-empty/);
  world.messages.length = 0;
  await poll();
  assert.deepEqual(world.messages.map((m) => [m.channel, m.text, m.thread_ts]), [
    ['D1', 'Updated: limits reset per key', ann1], ['D9', 'Updated: limits reset per key', bob1],
    ['D1', 'Updated: limits reset per key', ann2], ['D9', 'Updated: limits reset per key', bob2],
  ]);
  assert.deepEqual(await poll(), { sent: [], failed: [] });

  // Anyone's approval adds git_approved to every link of that PR, then git_merged on merge, or x on a close.
  setPRs({ 'o/r#1': pr({ head: 'ccc0000000', approved: true }), 'o/r#2': pr({ title: 'Docs', state: 'CLOSED' }) });
  await poll();
  setPRs({ 'o/r#1': pr({ head: 'ccc0000000', approved: true, state: 'MERGED' }), 'o/r#2': pr({ title: 'Docs', state: 'CLOSED' }) });
  await poll();
  assert.deepEqual(world.reactions.map((r) => [r.channel, r.timestamp, r.name]), [
    ['D1', ann1, 'git_approved'], ['D9', bob1, 'git_approved'], ['D1', ann2, 'x'], ['D9', bob2, 'x'], ['D1', ann1, 'git_merged'], ['D9', bob1, 'git_merged'],
  ]);
  assert.deepEqual(prSlack()['o/r#1'].links.Ann.reactions, ['git_approved', 'git_merged']);
  assert.deepEqual(await poll(), { sent: [], failed: [] });

  // A refused token stops every send, and is pushed once while a board has reviewers.
  world.token = 'xoxp-revoked';
  write(waveFile, { ...read(waveFile), items: [...read(waveFile).items, { id: 'A3', title: 'Three', pr: 3 }] });
  setPRs({ 'o/r#3': pr() });
  const refused = await poll();
  assert.deepEqual([refused.sent, refused.failed], [['pushed that Slack refused the token'], ['orch: Slack refused the token.']]);
  assert.ok(read(kf('secrets.json')).slack.refusal_pushed_at);
  assert.deepEqual(await poll(), { sent: [], failed: [] });
  assert.match((await reviewDue(site)).waiting, /Slack refused the token/);
});

test("one reviewer's failed send leaves the others sent and goes again next poll, and a post whose record fails is never posted twice", async () => {
  const world = { ...slackWorld(), dms: { U2: 'D2' } };
  const slack = fakeSlack(world);
  saveToken(world);
  write(waveFile, { repo: 'o/r', reviewers: [bob], items: [{ id: 'A1', title: 'Open', pr: 1 }] });
  setPRs({ 'o/r#1': pr() });
  const out = await sendReviews({ boards, fetch: slack.fetch, now: sunday });
  assert.deepEqual(out.failed, ['orch: link to Ann on o/r#1: Slack: user_not_found']);
  assert.equal(prSlack()['o/r#1'].links.Ann, undefined);
  world.dms.U1 = 'D1';
  assert.deepEqual((await sendReviews({ boards, fetch: slack.fetch, now: sunday })).sent, ['orch: link to Ann on o/r#1']);

  // The data folder turns read-only just after Slack takes the post, so its ts can't be recorded.
  write(waveFile, { ...read(waveFile), items: [...read(waveFile).items, { id: 'A2', title: 'Two', pr: 2 }] });
  setPRs({ 'o/r#1': pr(), 'o/r#2': pr({ title: 'Two' }) });
  const data = path.join(site, 'data');
  const lockAfterPost = async (url, init) => {
    const answer = await slack.fetch(url, init);
    if (String(url).endsWith('chat.postMessage')) fs.chmodSync(data, 0o500);
    return answer;
  };
  const broken = await sendReviews({ boards, fetch: lockAfterPost, now: sunday });
  fs.chmodSync(data, 0o700);
  assert.match(broken.failed[0], /^orch: link to Ann on o\/r#2: posted, but its record failed, so it won't go again/);
  assert.ok(prSlack()['o/r#2'].links.Ann.posting_at);
  world.messages.length = 0;
  await sendReviews({ boards, fetch: slack.fetch, now: sunday });
  assert.deepEqual(world.messages.map((m) => m.channel), ['D2'], "only Bob's link to #2 goes; Ann's is never posted again");
});

test('the digest is owed to each reviewer until its header and every reply are posted, resumes without a second header, and skips a day missed by 17:00', async () => {
  const world = { ...slackWorld(), dms: { U2: 'D2' } };
  const slack = fakeSlack(world);
  saveToken(world);
  write(waveFile, { repo: 'o/r', reviewers: [bob], items: [{ id: 'A1', title: 'Open', prs: [{ number: 1 }, { number: 2 }] }] });
  setPRs({ 'o/r#1': pr(), 'o/r#2': pr() });
  const poll = (now = monday, fetch = slack.fetch) => sendReviews({ boards, fetch, now });
  assert.equal((await reviewDigest(site, { now: new Date('2026-11-03T01:00:00Z') })).due, false, '17:00 in Los Angeles: that day is skipped');
  assert.equal((await reviewDigest(site, { now: new Date('2026-11-03T00:59:00Z') })).due, true);

  // Ann can't be reached; Bob's thread replies fail once his header is up.
  let failReplies = true;
  const flaky = async (url, init) => {
    const body = JSON.parse(init.body || '{}');
    if (failReplies && String(url).endsWith('chat.postMessage') && body.thread_ts && body.channel === 'D2') return { ok: true, status: 200, json: async () => ({ ok: false, error: 'ratelimited' }) };
    return slack.fetch(url, init);
  };
  const first = await poll(monday, flaky);
  assert.ok(first.failed.includes('orch: digest to Ann: Slack: user_not_found'), first.failed.join('\n'));
  assert.ok(first.failed.includes('orch: digest to Bob: Slack: ratelimited'), first.failed.join('\n'));
  assert.deepEqual(world.messages.filter((m) => m.text.includes('digest')).map((m) => [m.channel, m.text]), [['D2', 'Orch digest: 2 PRs pending your review']]);

  failReplies = false;
  world.dms.U1 = 'D1';
  world.messages.length = 0;
  await poll();
  const digestLines = world.messages.filter((m) => m.thread_ts || m.text.includes('digest')).map((m) => [m.channel, m.text]);
  assert.deepEqual(digestLines, [
    ['D1', 'Orch digest: 2 PRs pending your review'], ['D1', 'https://github.com/o/r/pull/1 · Open'], ['D1', 'https://github.com/o/r/pull/2 · Open'],
    ['D2', 'https://github.com/o/r/pull/1 · Open'], ['D2', 'https://github.com/o/r/pull/2 · Open'],
  ]);
  assert.deepEqual(digests().map((d) => [d.date, d.reviewer, d.replies.every((r) => r.ts)]).sort(), [['2026-11-02', 'Ann', true], ['2026-11-02', 'Bob', true]]);
  world.messages.length = 0;
  await poll();
  assert.equal(world.messages.length, 0);
  // The next day starts afresh, keeping only that day's record.
  await poll(new Date('2026-11-03T17:00:00Z'));
  assert.deepEqual(digests().map((d) => d.date), ['2026-11-03', '2026-11-03']);
});
