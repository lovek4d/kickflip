import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeSlack, slackWorld } from '../shared/test-helpers.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

// boards.mjs and store.mjs read HOME as they load, so it is set before they are imported.
const home = tempDir('review-send-');
process.env.HOME = home;
const { sendReviews } = await import('./review-send.mjs');
const { isSignedOff } = await import('./slack.mjs');
const { reviewDigest, reviewDue } = await import('../board/store.mjs');

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
const pr = (over = {}) => ({ state: 'OPEN', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', head: 'aaa0000000', title: 'Fix limiter', additions: 84, deletions: 12, files: 5, approved: false, ...over });
const setPRs = (prs) => write(kf('github-state.json'), { prs });
// 09:00 on a Monday in Los Angeles, when the digest opens; and a Sunday, when none is due
const monday = new Date('2026-11-02T17:00:00Z');
const sunday = new Date('2026-11-01T17:00:00Z');

beforeEach(() => {
  fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true });
  write(path.join(site, 'board.json'), { title: 'Orch', items: 'waves', reviewers: [ann] });
  write(kf('slack.json'), { timezone: 'America/Los_Angeles' });
});

const SIGN_OFF = '\n- :claude_kickflip:';
// Each post's words, then a line for each attachment: its colour bar, linked title and text; the sign-off line, which
// ends the text or the last attachment, taken off.
const unsigned = (words) => (words.endsWith(SIGN_OFF) ? words.slice(0, -SIGN_OFF.length) : words);
const shown = (m) => unsigned([m.text, ...(m.attachments || []).map((a) => `▌${a.color} <${a.title_link}|${a.title}> ${a.text}`)].filter(Boolean).join('\n'));
const pairs = (list) => list.map((m) => [m.channel, shown(m), m.thread_ts ?? null]);
// A PR's link: no text and no mention, only the bar holding the PR's title, size and risk, grey with no risk.
const COLOURS = { low: '#2eb67d', medium: '#e8912d', high: '#e01e5a', none: '#9e9e9e' };
const bar = (n, title, line, risk = 'none') => `▌${COLOURS[risk]} <https://github.com/o/r/pull/${n}|${title}> ${line}`;
const linkTo = (u, n, title, line, risk) => bar(n, title, line, risk);

test("review posts go into one thread per board in each reviewer's DM each day, opened by the day's digest: then only each PR's link, never a bump", async () => {
  const world = { ...slackWorld(), dms: { U1: 'D1', U2: 'D9' } };
  const slack = fakeSlack(world);
  write(waveFile, { repo: 'o/r', reviewers: [bob], items: [{ id: 'A1', title: 'Limits', prs: [{ number: 1 }, { number: 2 }, { number: 3 }] }] });
  setPRs({ 'o/r#1': pr(), 'o/r#2': pr({ isDraft: true, title: 'Docs' }), 'o/r#3': pr({ isDraft: true, title: 'Tests' }) });
  const poll = (now = sunday) => sendReviews({ boards, fetch: slack.fetch, now });

  assert.deepEqual(await poll(), { sent: [], failed: [] });
  assert.equal(slack.calls.length, 0);
  saveToken(world);
  // Sunday has no scheduled digest, so the first link opens each reviewer's thread with it.
  assert.deepEqual((await poll()).sent, ['orch: digest to Ann', 'orch: digest to Bob', 'orch: link to Ann on o/r#1', 'orch: link to Bob on o/r#1']);
  const link1 = (u) => linkTo(u, 1, 'Fix limiter', '+84/-12 · 5 files');
  const listed = (u, n) => `<@${u}> https://github.com/o/r/pull/${n} · Limits`;
  const opener = 'Orch Digest\n1 PR pending review';
  const [annDay, annListed, bobDay, bobListed, ann1, bob1] = world.messages.map((m) => m.ts);
  assert.deepEqual(pairs(world.messages), [
    ['D1', opener, null], ['D1', listed('U1', 1), annDay], ['D9', opener, null], ['D9', listed('U2', 1), bobDay],
    ['D1', link1('U1'), annDay], ['D9', link1('U2'), bobDay],
  ]);
  assert.deepEqual(prSlack()['o/r#1'].links, { Ann: { reactions: [], channel: 'D1', thread_ts: annDay, ts: ann1 }, Bob: { reactions: [], channel: 'D9', thread_ts: bobDay, ts: bob1 } });
  assert.deepEqual(digests().map((d) => [d.date, d.reviewer, d.channel, d.ts]), [['2026-11-01', 'Ann', 'D1', annDay], ['2026-11-01', 'Bob', 'D9', bobDay]]);
  assert.deepEqual(await poll(), { sent: [], failed: [] });

  // A push posts nothing; the draft coming out is a new link in the day's thread.
  setPRs({ 'o/r#1': pr({ head: 'ccc0000000' }), 'o/r#2': pr({ title: 'Docs', additions: 3, deletions: 0, files: 1 }), 'o/r#3': pr({ isDraft: true, title: 'Tests' }) });
  let since = world.messages.length;
  await poll();
  const link2 = (u) => linkTo(u, 2, 'Docs', '+3/-0 · 1 file');
  assert.deepEqual(pairs(world.messages.slice(since)), [['D1', link2('U1'), annDay], ['D9', link2('U2'), bobDay]]);
  const [ann2, bob2] = world.messages.slice(since).map((m) => m.ts);
  assert.deepEqual(await poll(), { sent: [], failed: [] });

  // A bump an earlier build queued and never sent is dropped: review due owes no bumps.
  const queued = prSlack();
  queued['o/r#1'].replies.push({ id: 'updated-1', text: 'updated: limits reset per key', to: { Ann: {}, Bob: {} } });
  write(path.join(site, 'data', 'pr-slack.json'), queued);
  assert.equal('replies' in await reviewDue(site, { now: sunday }), false);
  assert.deepEqual(await poll(), { sent: [], failed: [] });

  // GitHub's APPROVED review decision reacts git_approved on every link to that PR and its digest line, then git_merged on
  // merge, or x on a close; the digest's header names no PR and gets none, and its count is edited down.
  setPRs({ 'o/r#1': pr({ head: 'ccc0000000', approved: true, reviewDecision: 'APPROVED' }), 'o/r#2': pr({ title: 'Docs', state: 'CLOSED' }), 'o/r#3': pr({ isDraft: true, title: 'Tests' }) });
  await poll();
  const reacted = () => world.reactions.map((r) => `${r.timestamp} ${r.name}`).sort();
  const on = (list, name) => list.map((ts) => `${ts} ${name}`);
  assert.deepEqual(reacted(), [...on([ann1, bob1, annListed, bobListed], 'git_approved'), ...on([ann2, bob2], 'x')].sort());
  assert.equal(world.messages.find((m) => m.ts === annDay).text, 'Orch Digest\nAll reviewed\n- :claude_kickflip: · _updated 09:00_');
  setPRs({ 'o/r#1': pr({ head: 'ccc0000000', approved: true, reviewDecision: 'APPROVED', state: 'MERGED' }), 'o/r#2': pr({ title: 'Docs', state: 'CLOSED' }), 'o/r#3': pr({ isDraft: true, title: 'Tests' }) });
  await poll();
  assert.deepEqual(reacted(), [...on([ann1, bob1, annListed, bobListed], 'git_approved'), ...on([ann1, bob1, annListed, bobListed], 'git_merged'), ...on([ann2, bob2], 'x')].sort());
  assert.ok(world.reactions.every((r) => r.channel === ([bob1, bob2, bobListed].includes(r.timestamp) ? 'D9' : 'D1')));
  assert.deepEqual(prSlack()['o/r#1'].links.Ann.reactions, ['git_approved', 'git_merged']);
  assert.deepEqual(await poll(), { sent: [], failed: [] });

  // The next day's thread opens with that day's digest, however late on the weekday the hub gets to it.
  setPRs({ 'o/r#3': pr({ title: 'Tests', additions: 1, deletions: 1, files: 1 }) });
  since = world.messages.length;
  const mondayEvening = new Date('2026-11-03T02:00:00Z');
  await poll(mondayEvening);
  const [annNext, , bobNext] = world.messages.slice(since).map((m) => m.ts);
  const link3 = (u) => linkTo(u, 3, 'Tests', '+1/-1 · 1 file');
  assert.deepEqual(pairs(world.messages.slice(since)), [
    ['D1', opener, null], ['D1', listed('U1', 3), annNext], ['D9', opener, null], ['D9', listed('U2', 3), bobNext],
    ['D1', link3('U1'), annNext], ['D9', link3('U2'), bobNext],
  ]);
  assert.deepEqual(digests().map((d) => [d.date, d.reviewer]), [['2026-11-01', 'Ann'], ['2026-11-01', 'Bob'], ['2026-11-02', 'Ann'], ['2026-11-02', 'Bob']]);

  // A refused token stops every send, and is pushed once while a board has reviewers.
  world.token = 'xoxp-revoked';
  write(waveFile, { ...read(waveFile), items: [...read(waveFile).items, { id: 'A4', title: 'Four', pr: 4 }] });
  setPRs({ 'o/r#4': pr() });
  const refused = await poll();
  assert.deepEqual([refused.sent, refused.failed], [['pushed that Slack refused the token'], ['orch: Slack refused the token.']]);
  assert.ok(read(kf('secrets.json')).slack.refusal_pushed_at);
  assert.deepEqual(await poll(), { sent: [], failed: [] });
  assert.match((await reviewDue(site)).waiting, /Slack refused the token/);
});

test("a PR's link is one bar with no mention, coloured by the builder's risk holding the PR's title, size and risk, and last the sign-off line", async () => {
  const world = slackWorld();
  const slack = fakeSlack(world);
  saveToken(world);
  write(waveFile, { repo: 'o/r', items: [
    { id: 'A1', title: 'Low', pr: 1, risk: 'low' }, { id: 'A2', title: 'Medium', pr: 2, risk: 'medium' },
    { id: 'A3', title: 'High', pr: 3, risk: 'high' }, { id: 'A4', title: 'None', pr: 4 },
  ] });
  setPRs({ 'o/r#1': pr({ title: 'fix(board): bug no longer occurs', additions: 13, deletions: 45, files: 1 }), 'o/r#2': pr({ title: 'Two' }), 'o/r#3': pr({ title: 'Three' }), 'o/r#4': pr({ title: 'Four' }) });
  await sendReviews({ boards, fetch: slack.fetch, now: sunday });
  const links = world.messages.filter((m) => m.attachments);
  assert.deepEqual(links.map((m) => m.text), Array(4).fill(''));
  assert.ok(links.every((m) => isSignedOff(m.text, m.attachments)));
  assert.deepEqual(links[0].attachments, [{
    color: COLOURS.low, title: 'fix(board): bug no longer occurs', title_link: 'https://github.com/o/r/pull/1', text: '+13/-45 · 1 file · low risk\n- :claude_kickflip:', mrkdwn_in: ['text'],
    fallback: 'r#1 fix(board): bug no longer occurs · +13/-45 · 1 file · low risk',
  }]);
  assert.deepEqual(links.map(shown), [
    linkTo('U1', 1, 'fix(board): bug no longer occurs', '+13/-45 · 1 file · low risk', 'low'),
    linkTo('U1', 2, 'Two', '+84/-12 · 5 files · medium risk', 'medium'),
    linkTo('U1', 3, 'Three', '+84/-12 · 5 files · high risk', 'high'),
    linkTo('U1', 4, 'Four', '+84/-12 · 5 files'),
  ]);
});

test('a link posted top-level before the day threads, and a bump sent before bumps stopped, keep getting reactions', async () => {
  const world = slackWorld();
  const slack = fakeSlack(world);
  saveToken(world);
  write(waveFile, { repo: 'o/r', items: [{ id: 'A1', title: 'Old', pr: 1 }] });
  setPRs({ 'o/r#1': pr({ approved: true, reviewDecision: 'APPROVED' }) });
  write(path.join(site, 'data', 'pr-slack.json'), { 'o/r#1': { head: 'aaa0000000', links: { Ann: { channel: 'D1', ts: '1792700000.000100', reactions: [] } }, replies: [{ id: 'push-1', text: '1 new commit', to: { Ann: { ts: '1792700000.000200', reactions: [] } } }] } });
  await sendReviews({ boards, fetch: slack.fetch, now: sunday });
  assert.deepEqual(world.messages, []);
  assert.deepEqual(world.reactions.map((r) => [r.channel, r.timestamp, r.name]).sort(), [['D1', '1792700000.000100', 'git_approved'], ['D1', '1792700000.000200', 'git_approved']]);
});

test('a reply recorded without an id, or sharing one, is marked on its own message and not due again', async () => {
  const world = slackWorld();
  const slack = fakeSlack(world);
  saveToken(world);
  write(waveFile, { repo: 'o/r', items: [{ id: 'A1', title: 'Old', pr: 1 }] });
  setPRs({ 'o/r#1': pr({ state: 'MERGED' }) });
  const sent = (ts) => ({ ts, reactions: [] });
  write(path.join(site, 'data', 'pr-slack.json'), { 'o/r#1': { head: 'aaa0000000', links: { Ann: { channel: 'D1', ts: '1792700000.000100', reactions: [] } }, replies: [{ text: 'a', to: { Ann: sent('1792700000.000200') } }, { id: 'x', text: 'b', to: { Ann: sent('1792700000.000300') } }, { id: 'x', text: 'c', to: { Ann: sent('1792700000.000400') } }] } });
  await sendReviews({ boards, fetch: slack.fetch, now: sunday });
  assert.equal(world.reactions.length, 4);
  const record = prSlack()['o/r#1'];
  assert.deepEqual([record.links.Ann, ...record.replies.map((r) => r.to.Ann)].map((m) => m.reactions), [['git_merged'], ['git_merged'], ['git_merged'], ['git_merged']]);
  assert.deepEqual((await reviewDue(site, { now: sunday })).reactions, []);
});

test('no reaction is owed to someone who is no longer a reviewer', async () => {
  const world = slackWorld();
  const slack = fakeSlack(world);
  saveToken(world);
  write(waveFile, { repo: 'o/r', items: [{ id: 'A1', title: 'Old', pr: 1 }] });
  setPRs({ 'o/r#1': pr({ state: 'MERGED' }) });
  write(path.join(site, 'data', 'pr-slack.json'), { 'o/r#1': { head: 'aaa0000000', links: { Ann: { channel: 'D1', ts: '1792700000.000100', reactions: [] }, Bob: { channel: 'D2', ts: '1792700000.000500', reactions: [] } }, replies: [{ id: 'push-1', text: 'p', to: { Bob: { ts: '1792700000.000600', reactions: [] } } }] } });
  await sendReviews({ boards, fetch: slack.fetch, now: sunday });
  assert.deepEqual(world.reactions.map((r) => r.timestamp), ['1792700000.000100']);
  assert.deepEqual((await reviewDue(site, { now: sunday })).reactions, []);
});

test("a link before 09:00 opens the day's thread with the digest, and the weekday morning sends no second one", async () => {
  const world = slackWorld();
  const slack = fakeSlack(world);
  saveToken(world);
  write(waveFile, { repo: 'o/r', items: [{ id: 'A1', title: 'Open', prs: [{ number: 1 }, { number: 2 }] }] });
  setPRs({ 'o/r#1': pr() });
  await sendReviews({ boards, fetch: slack.fetch, now: new Date('2026-11-02T16:00:00Z') });
  const [day] = world.messages.map((m) => m.ts);
  assert.deepEqual(pairs(world.messages), [
    ['D1', 'Orch Digest\n1 PR pending review', null], ['D1', '<@U1> https://github.com/o/r/pull/1 · Open', day],
    ['D1', linkTo('U1', 1, 'Fix limiter', '+84/-12 · 5 files'), day],
  ]);
  setPRs({ 'o/r#1': pr(), 'o/r#2': pr({ title: 'Docs' }) });
  world.messages.length = 0;
  await sendReviews({ boards, fetch: slack.fetch, now: monday });
  assert.deepEqual(pairs(world.messages), [['D1', linkTo('U1', 2, 'Docs', '+84/-12 · 5 files'), day]]);
  assert.equal((await reviewDigest(site, { now: monday })).due, false);
});

test("a digest due in a thread an earlier build opened with a header line goes in it as one reply listing the PRs, its count live", async () => {
  const world = slackWorld();
  const slack = fakeSlack(world);
  saveToken(world);
  write(waveFile, { repo: 'o/r', items: [{ id: 'A1', title: 'Open', prs: [{ number: 1 }, { number: 2 }] }] });
  setPRs({ 'o/r#1': pr(), 'o/r#2': pr({ title: 'Docs' }) });
  const day = slack.say({ channel: 'D1', user: 'U0', text: 'Orch reviews\n- :claude_kickflip:' });
  write(path.join(site, 'data', 'review-digests.json'), { digests: [{ date: '2026-11-02', reviewer: 'Ann', channel: 'D1', ts: day }] });
  await sendReviews({ boards, fetch: slack.fetch, now: monday });
  const listed = '\nhttps://github.com/o/r/pull/1 · Open\nhttps://github.com/o/r/pull/2 · Open';
  assert.deepEqual(pairs(world.messages.slice(1)), [
    ['D1', `<@U1> Orch Digest\n2 PRs pending review${listed}`, day],
    ['D1', linkTo('U1', 1, 'Fix limiter', '+84/-12 · 5 files'), day],
    ['D1', linkTo('U1', 2, 'Docs', '+84/-12 · 5 files'), day],
  ]);
  assert.equal((await reviewDigest(site, { now: monday })).due, false);
  setPRs({ 'o/r#1': pr({ state: 'MERGED' }), 'o/r#2': pr({ title: 'Docs' }) });
  await sendReviews({ boards, fetch: slack.fetch, now: monday });
  assert.equal(world.messages[1].text, `<@U1> Orch Digest\n1 PR pending review${listed}${SIGN_OFF} · _updated 09:00_`);
  assert.equal(world.messages.length, 4);
});

test("one reviewer's failed send leaves the others sent and goes again next poll, and a post whose record fails is never posted twice", async () => {
  const world = { ...slackWorld(), dms: { U2: 'D2' } };
  const slack = fakeSlack(world);
  saveToken(world);
  write(waveFile, { repo: 'o/r', reviewers: [bob], items: [{ id: 'A1', title: 'Open', pr: 1 }] });
  setPRs({ 'o/r#1': pr() });
  const out = await sendReviews({ boards, fetch: slack.fetch, now: sunday });
  assert.deepEqual(out.failed, ['orch: digest to Ann: Slack: user_not_found', "orch: link to Ann on o/r#1: the day's thread waits on its digest"]);
  assert.equal(prSlack()['o/r#1'].links.Ann, undefined);
  world.dms.U1 = 'D1';
  assert.deepEqual((await sendReviews({ boards, fetch: slack.fetch, now: sunday })).sent, ['orch: digest to Ann', 'orch: link to Ann on o/r#1']);

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

test('the digest is due each weekday from 09:00 however late the hub gets to it, and on a weekend only as a link opens the thread', async () => {
  saveToken(slackWorld());
  write(waveFile, { repo: 'o/r', items: [{ id: 'A1', title: 'Open', prs: [{ number: 1 }, { number: 2 }] }] });
  setPRs({ 'o/r#1': pr(), 'o/r#2': pr() });
  const sent = { channel: 'D1', ts: '1792700000.000100', reactions: [] };
  write(path.join(site, 'data', 'pr-slack.json'), { 'o/r#1': { links: { Ann: sent }, replies: [] }, 'o/r#2': { links: { Ann: sent }, replies: [] } });
  const due = async (at) => (await reviewDigest(site, { now: new Date(at) })).due;
  // Monday 2 November in Los Angeles
  assert.equal(await due('2026-11-02T16:59:00Z'), false, '08:59');
  assert.equal(await due('2026-11-02T17:00:00Z'), true, '09:00');
  assert.equal(await due('2026-11-03T00:59:00Z'), true, '16:59');
  assert.equal(await due('2026-11-03T04:00:00Z'), true, '20:00');
  assert.equal(await due('2026-11-07T17:00:00Z'), false, 'Saturday 09:00');
  setPRs({ 'o/r#1': pr(), 'o/r#2': pr(), 'o/r#3': pr() });
  write(waveFile, { repo: 'o/r', items: [{ id: 'A1', title: 'Open', prs: [{ number: 1 }, { number: 2 }, { number: 3 }] }] });
  assert.equal(await due('2026-11-07T17:00:00Z'), true, "Saturday, with #3's link owed");
});

test("a link on a day with no thread opens it with the same digest the weekday morning sends", async () => {
  const world = slackWorld();
  const slack = fakeSlack(world);
  saveToken(world);
  write(waveFile, { repo: 'o/r', items: [{ id: 'A1', title: 'Open', prs: [{ number: 1 }, { number: 2 }, { number: 3 }] }] });
  setPRs({ 'o/r#1': pr(), 'o/r#2': pr(), 'o/r#3': pr() });
  await sendReviews({ boards, fetch: slack.fetch, now: new Date('2026-11-07T17:00:00Z') });
  const [day] = world.messages.map((m) => m.ts);
  const listed = (n) => ['D1', `<@U1> https://github.com/o/r/pull/${n} · Open`, day];
  const link = (n) => ['D1', linkTo('U1', n, 'Fix limiter', '+84/-12 · 5 files'), day];
  assert.deepEqual(pairs(world.messages), [['D1', 'Orch Digest\n3 PRs pending review', null], listed(1), listed(2), listed(3), link(1), link(2), link(3)]);
  const onDemand = world.messages.slice(0, 4);

  // Monday 09:00, every link sent: the schedule opens that day's thread with the same digest, its PRs now days old.
  const since = world.messages.length;
  await sendReviews({ boards, fetch: slack.fetch, now: new Date('2026-11-09T17:00:00Z') });
  const scheduled = world.messages.slice(since);
  assert.ok(scheduled.slice(1).every((m) => m.thread_ts === scheduled[0].ts));
  const words = (list) => pairs(list).map(([channel, text]) => [channel, text.replace(/ \(\d+ days old\)$/, '')]);
  assert.deepEqual(words(scheduled), words(onDemand));
  assert.match(scheduled[1].text, /· Open \(\d+ days old\)\n/);
});

test('the digest is owed to each reviewer until its header and every reply are posted, and resumes without a second header', async () => {
  const world = { ...slackWorld(), dms: { U2: 'D2' } };
  const slack = fakeSlack(world);
  saveToken(world);
  write(waveFile, { repo: 'o/r', reviewers: [bob], items: [{ id: 'A1', title: 'Open', prs: [{ number: 1 }, { number: 2 }] }] });
  setPRs({ 'o/r#1': pr(), 'o/r#2': pr() });
  const poll = (now = monday, fetch = slack.fetch) => sendReviews({ boards, fetch, now });

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
  assert.deepEqual(world.messages.filter((m) => m.text.includes('Digest')).map((m) => [m.channel, m.text]), [['D2', 'Orch Digest\n2 PRs pending review\n- :claude_kickflip:']]);

  failReplies = false;
  world.dms.U1 = 'D1';
  world.messages.length = 0;
  await poll();
  // The digest opened each day's thread, so the links go in as replies under its header.
  const [annDigest] = world.messages.map((m) => m.ts);
  const bobDigest = digests().find((d) => d.reviewer === 'Bob').ts;
  const fix = (u, n) => linkTo(u, n, 'Fix limiter', '+84/-12 · 5 files');
  assert.deepEqual(pairs(world.messages), [
    ['D1', 'Orch Digest\n2 PRs pending review', null], ['D1', '<@U1> https://github.com/o/r/pull/1 · Open', annDigest], ['D1', '<@U1> https://github.com/o/r/pull/2 · Open', annDigest],
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
  // The next day starts afresh; the record keeps the last 7 days, whose threads the hub still hears.
  await poll(new Date('2026-11-03T17:00:00Z'));
  assert.deepEqual(digests().map((d) => d.date), ['2026-11-02', '2026-11-02', '2026-11-03', '2026-11-03']);
  await poll(new Date('2026-11-09T17:00:00Z'));
  assert.deepEqual(digests().map((d) => d.date), ['2026-11-03', '2026-11-03', '2026-11-09', '2026-11-09']);
});

test("a digest header's count is edited as its reviewer's PRs leave review, to All reviewed at none, signed off with the edit's time, and a failed edit leaves the post alone to go again", async () => {
  const world = slackWorld();
  const slack = fakeSlack(world);
  saveToken(world);
  write(waveFile, { repo: 'o/r', items: [{ id: 'A1', title: 'Open', prs: [{ number: 1 }, { number: 2 }] }] });
  setPRs({ 'o/r#1': pr(), 'o/r#2': pr() });
  const poll = (now = monday) => sendReviews({ boards, fetch: slack.fetch, now });
  await poll();
  const header = () => world.messages.find((m) => m.text.startsWith('Orch Digest')).text;
  assert.equal(header(), `Orch Digest\n2 PRs pending review${SIGN_OFF}`);

  setPRs({ 'o/r#1': pr({ reviewDecision: 'APPROVED', approved: true }), 'o/r#2': pr() });
  world.updateError = 'ratelimited';
  assert.deepEqual((await poll()).failed, ['orch: digest count for Ann: Slack: ratelimited']);
  assert.equal(header(), `Orch Digest\n2 PRs pending review${SIGN_OFF}`);
  delete world.updateError;
  assert.deepEqual((await poll()).sent, ['orch: digest count for Ann']);
  assert.equal(header(), `Orch Digest\n1 PR pending review${SIGN_OFF} · _updated 09:00_`);
  assert.ok(isSignedOff(header()));
  assert.deepEqual(await poll(), { sent: [], failed: [] });

  // 14:05 in Los Angeles
  setPRs({ 'o/r#1': pr({ state: 'MERGED' }), 'o/r#2': pr({ state: 'CLOSED' }) });
  await poll(new Date('2026-11-02T22:05:00Z'));
  assert.equal(header(), `Orch Digest\nAll reviewed${SIGN_OFF} · _updated 14:05_`);
});
