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

const label = (n) => `<https://github.com/o/r/pull/${n}|r#${n}>`;
const pairs = (list) => list.map((m) => [m.channel, m.text, m.thread_ts ?? null]);

test("review posts go into one thread per board in each reviewer's DM each day, opened by a header line, with brief bumps naming the reviewer and the PR", async () => {
  const world = { ...slackWorld(), dms: { U1: 'D1', U2: 'D9' } };
  const slack = fakeSlack(world);
  write(waveFile, { repo: 'o/r', reviewers: [bob], items: [{ id: 'A1', title: 'Limits', prs: [{ number: 1 }, { number: 2 }] }] });
  setPRs({ 'o/r#1': pr(), 'o/r#2': pr({ isDraft: true, title: 'Docs' }) });
  const poll = (now = sunday) => sendReviews({ boards, fetch: slack.fetch, now });

  assert.deepEqual(await poll(), { sent: [], failed: [] });
  assert.equal(slack.calls.length, 0);
  saveToken(world);
  assert.deepEqual((await poll()).sent, ['orch: link to Ann on o/r#1', 'orch: link to Bob on o/r#1']);
  const link1 = (u) => `<@${u}> ${label(1)} ready for review: Fix limiter (+84/-12, 5 files)`;
  const [annDay, ann1, bobDay, bob1] = world.messages.map((m) => m.ts);
  assert.deepEqual(pairs(world.messages), [['D1', 'Orch reviews', null], ['D1', link1('U1'), annDay], ['D9', 'Orch reviews', null], ['D9', link1('U2'), bobDay]]);
  assert.deepEqual(prSlack()['o/r#1'], { head: 'aaa0000000', links: { Ann: { reactions: [], channel: 'D1', thread_ts: annDay, ts: ann1 }, Bob: { reactions: [], channel: 'D9', thread_ts: bobDay, ts: bob1 } }, replies: [] });
  assert.deepEqual(digests().map((d) => [d.date, d.reviewer, d.channel, d.ts]), [['2026-11-01', 'Ann', 'D1', annDay], ['2026-11-01', 'Bob', 'D9', bobDay]]);
  assert.deepEqual(await poll(), { sent: [], failed: [] });

  // A push replies in the day's thread with a count of the new commits; the draft coming out is a new link there.
  const commits = [{ oid: 'aaa0000000', subject: 'Add limiter' }, { oid: 'bbb0000000', subject: 'Fix reset' }, { oid: 'ccc0000000', subject: 'Add the reset test' }];
  setPRs({ 'o/r#1': pr({ head: 'ccc0000000', commits }), 'o/r#2': pr({ title: 'Docs', additions: 3, deletions: 0, files: 1 }) });
  world.messages.length = 0;
  await poll();
  const link2 = (u) => `<@${u}> ${label(2)} ready for review: Docs (+3/-0, 1 file)`;
  assert.deepEqual(pairs(world.messages), [
    ['D1', link2('U1'), annDay], ['D9', link2('U2'), bobDay],
    ['D1', `<@U1> ${label(1)} 2 new commits`, annDay], ['D9', `<@U2> ${label(1)} 2 new commits`, bobDay],
  ]);
  const [ann2, bob2, annPush, bobPush] = world.messages.map((m) => m.ts);

  // Updated reaches every reviewer on each of the card's PRs, approved or not, in the day's thread.
  assert.deepEqual((await reviewUpdated(site, 'w/A1', 'limits reset per key')).lines, ['Updated queued for Ann, Bob on w/A1']);
  await assert.rejects(reviewUpdated(site, 'w/A1', '  '), /non-empty/);
  world.messages.length = 0;
  await poll();
  const updated = (u, n) => `<@${u}> ${label(n)} updated: limits reset per key`;
  assert.deepEqual(pairs(world.messages), [
    ['D1', updated('U1', 1), annDay], ['D9', updated('U2', 1), bobDay], ['D1', updated('U1', 2), annDay], ['D9', updated('U2', 2), bobDay],
  ]);
  const [annUp1, bobUp1, annUp2, bobUp2] = world.messages.map((m) => m.ts);
  assert.deepEqual(await poll(), { sent: [], failed: [] });

  // Anyone's approval reacts git_approved on every message about that PR, then git_merged on merge, or x on a close;
  // the day's header names no PR and gets none.
  setPRs({ 'o/r#1': pr({ head: 'ccc0000000', approved: true }), 'o/r#2': pr({ title: 'Docs', state: 'CLOSED' }) });
  await poll();
  const reacted = () => world.reactions.map((r) => `${r.timestamp} ${r.name}`).sort();
  const on = (list, name) => list.map((ts) => `${ts} ${name}`);
  assert.deepEqual(reacted(), [...on([ann1, bob1, annPush, bobPush, annUp1, bobUp1], 'git_approved'), ...on([ann2, bob2, annUp2, bobUp2], 'x')].sort());
  setPRs({ 'o/r#1': pr({ head: 'ccc0000000', approved: true, state: 'MERGED' }), 'o/r#2': pr({ title: 'Docs', state: 'CLOSED' }) });
  await poll();
  assert.deepEqual(reacted(), [...on([ann1, bob1, annPush, bobPush, annUp1, bobUp1], 'git_approved'), ...on([ann1, bob1, annPush, bobPush, annUp1, bobUp1], 'git_merged'), ...on([ann2, bob2, annUp2, bobUp2], 'x')].sort());
  assert.ok(world.reactions.every((r) => r.channel === (r.timestamp === bob1 || [bob2, bobPush, bobUp1, bobUp2].includes(r.timestamp) ? 'D9' : 'D1')));
  assert.deepEqual(prSlack()['o/r#1'].links.Ann.reactions, ['git_approved', 'git_merged']);
  assert.deepEqual(prSlack()['o/r#1'].replies.find((r) => r.id.startsWith('updated')).to.Ann.reactions, ['git_approved', 'git_merged']);
  assert.deepEqual(await poll(), { sent: [], failed: [] });

  // A bump the next day goes in that day's thread, which a header opens, though the PR's link went out the day before.
  setPRs({ 'o/r#1': pr({ head: 'ccc0000000' }) });
  await reviewUpdated(site, 'w/A1', 'renamed the flag');
  world.messages.length = 0;
  const mondayEvening = new Date('2026-11-03T02:00:00Z');
  await poll(mondayEvening);
  const [annNext, , bobNext] = world.messages.map((m) => m.ts);
  assert.deepEqual(pairs(world.messages), [
    ['D1', 'Orch reviews', null], ['D1', `<@U1> ${label(1)} updated: renamed the flag`, annNext],
    ['D9', 'Orch reviews', null], ['D9', `<@U2> ${label(1)} updated: renamed the flag`, bobNext],
    ['D1', `<@U1> ${label(2)} updated: renamed the flag`, annNext], ['D9', `<@U2> ${label(2)} updated: renamed the flag`, bobNext],
  ]);
  assert.deepEqual(digests().map((d) => [d.date, d.reviewer]), [['2026-11-02', 'Ann'], ['2026-11-02', 'Bob']]);

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

test('a link posted top-level before the day threads keeps its own thread for bumps and reactions', async () => {
  const world = slackWorld();
  const slack = fakeSlack(world);
  saveToken(world);
  write(waveFile, { repo: 'o/r', items: [{ id: 'A1', title: 'Old', pr: 1 }] });
  setPRs({ 'o/r#1': pr() });
  write(path.join(site, 'data', 'pr-slack.json'), { 'o/r#1': { head: 'aaa0000000', links: { Ann: { channel: 'D1', ts: '1792700000.000100', reactions: [] } }, replies: [] } });
  await reviewUpdated(site, 'w/A1', 'limits reset per key');
  await sendReviews({ boards, fetch: slack.fetch, now: sunday });
  assert.deepEqual(pairs(world.messages), [['D1', `<@U1> ${label(1)} updated: limits reset per key`, '1792700000.000100']]);
  setPRs({ 'o/r#1': pr({ approved: true }) });
  await sendReviews({ boards, fetch: slack.fetch, now: sunday });
  assert.deepEqual(world.reactions.map((r) => [r.timestamp, r.name]).sort(), [['1792700000.000100', 'git_approved'], [world.messages[0].ts, 'git_approved']]);
});

test("a digest due once the day's thread is open goes in it as one reply listing the PRs", async () => {
  const world = slackWorld();
  const slack = fakeSlack(world);
  saveToken(world);
  write(waveFile, { repo: 'o/r', items: [{ id: 'A1', title: 'Open', prs: [{ number: 1 }, { number: 2 }] }] });
  setPRs({ 'o/r#1': pr() });
  await sendReviews({ boards, fetch: slack.fetch, now: new Date('2026-11-02T16:00:00Z') });
  const [day] = world.messages.map((m) => m.ts);
  setPRs({ 'o/r#1': pr(), 'o/r#2': pr({ title: 'Docs' }) });
  world.messages.length = 0;
  await sendReviews({ boards, fetch: slack.fetch, now: monday });
  assert.deepEqual(pairs(world.messages), [
    ['D1', '<@U1> Orch digest: 2 PRs pending your review\nhttps://github.com/o/r/pull/1 · Open (9 days old)\nhttps://github.com/o/r/pull/2 · Open', day],
    ['D1', `<@U1> ${label(2)} ready for review: Docs (+84/-12, 5 files)`, day],
  ]);
  assert.equal((await reviewDigest(site, { now: monday })).due, false);
  world.messages.length = 0;
  await sendReviews({ boards, fetch: slack.fetch, now: monday });
  assert.equal(world.messages.length, 0);
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
  // The digest opened each day's thread, so the links go in as replies under its header.
  const [annDigest] = world.messages.map((m) => m.ts);
  const bobDigest = digests().find((d) => d.reviewer === 'Bob').ts;
  const fix = (u, n) => `<@${u}> ${label(n)} ready for review: Fix limiter (+84/-12, 5 files)`;
  assert.deepEqual(pairs(world.messages), [
    ['D1', 'Orch digest: 2 PRs pending your review', null], ['D1', '<@U1> https://github.com/o/r/pull/1 · Open', annDigest], ['D1', '<@U1> https://github.com/o/r/pull/2 · Open', annDigest],
    ['D2', '<@U2> https://github.com/o/r/pull/1 · Open', bobDigest], ['D2', '<@U2> https://github.com/o/r/pull/2 · Open', bobDigest],
    ['D1', fix('U1', 1), annDigest], ['D2', fix('U2', 1), bobDigest], ['D1', fix('U1', 2), annDigest], ['D2', fix('U2', 2), bobDigest],
  ]);
  assert.deepEqual(digests().map((d) => [d.date, d.reviewer, d.replies.every((r) => r.ts)]).sort(), [['2026-11-02', 'Ann', true], ['2026-11-02', 'Bob', true]]);
  world.messages.length = 0;
  await poll();
  assert.equal(world.messages.length, 0);
  // A digest's one-PR reply is a message about that PR, so a merge reacts on it as on the link; its header gets none.
  const digestTs = (name, n) => digests().find((d) => d.reviewer === name).replies.find((r) => r.pr === `o/r#${n}`).ts;
  const linkTs = (name) => prSlack()['o/r#1'].links[name].ts;
  setPRs({ 'o/r#1': pr({ state: 'MERGED' }), 'o/r#2': pr() });
  await poll();
  assert.deepEqual(world.reactions.map((r) => `${r.channel} ${r.timestamp} ${r.name}`).sort(),
    [`D1 ${digestTs('Ann', 1)} git_merged`, `D1 ${linkTs('Ann')} git_merged`, `D2 ${digestTs('Bob', 1)} git_merged`, `D2 ${linkTs('Bob')} git_merged`].sort());
  // The next day starts afresh, keeping only that day's record.
  await poll(new Date('2026-11-03T17:00:00Z'));
  assert.deepEqual(digests().map((d) => d.date), ['2026-11-03', '2026-11-03']);
});
