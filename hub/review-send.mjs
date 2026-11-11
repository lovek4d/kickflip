// The hub sends what each board's `review due` owes, as the owner through Hub's Slack token, recording each send in the
// board's files as board/store.mjs posts it (docs/adr/2026-11-05-0141-the-hub-sends-reviewer-slack-messages-with-its-own-token.md,
// docs/adr/2026-11-07-0300-slack-sends-hang-off-prs-and-go-out-from-the-hub-tick.md,
// docs/adr/2026-11-11-1600-review-posts-go-into-one-day-thread-per-board.md). Each reviewer gets one thread per board
// for each Slack day, in the DM the hub opens with them: the weekday digest opens it when it is due first, else a
// “<board> reviews” header line. Each PR's link and its push, comment and Updated bumps go in as replies; a link posted
// top-level before the day threads keeps its own thread for its bumps. Reactions go on every link and bump. A failed
// send stays owed and goes again next poll.
import fs from 'node:fs';
import path from 'node:path';
import { listBoards } from './boards.mjs';
import { savedSlack, refusalUnpushed, markRefusalPushed } from './slack.mjs';
import { deliver } from './push.mjs';
import { reviewDue, queuePushes, postLink, postReply, recordReaction, postDigest, openDayThread } from '../board/store.mjs';

const refusedToken = (e) => e.status === 400 && e.message === 'Slack refused the token.';

async function sendBoard(board, slack, now) {
  await queuePushes(board.dir);
  const due = await reviewDue(board.dir, { now });
  if (due.waiting) return { sent: [], failed: [] };
  const sent = [];
  const failed = [];
  // One reviewer's failure leaves the rest to go; a refused token stops every send.
  const attempt = async (what, send) => {
    try { await send(); sent.push(what); } catch (e) {
      if (refusedToken(e)) throw e;
      failed.push(`${board.route}: ${what}: ${e.message}`);
    }
  };
  // The digest goes first, so on a weekday morning it opens the day's thread.
  for (const reviewer of (due.digest?.reviewers || []).filter((r) => r.owed)) {
    await attempt(`digest to ${reviewer.name}`, async () => {
      await postDigest(board.dir, due.digest.date, reviewer, {
        channel: reviewer.sent?.channel || await slack.openDM(reviewer.slack_user),
        header: (n) => `${board.title} digest: ${n} PR${n === 1 ? '' : 's'} pending your review`,
        post: (message) => slack.post(message),
      });
    });
  }
  // Each reviewer's day thread, opened at most once a poll; a failed open fails that reviewer's sends until the next.
  const threads = new Map();
  const dayThread = (name, channel) => {
    if (!threads.has(name)) threads.set(name, (async () => openDayThread(board.dir, due.date, name, { channel: await channel(), header: `${board.title} reviews`, post: (message) => slack.post(message) }))());
    return threads.get(name);
  };
  for (const link of due.links) {
    await attempt(`link to ${link.reviewer} on ${link.pr}`, async () => {
      const thread = await dayThread(link.reviewer, () => slack.openDM(link.slack_user));
      await postLink(board.dir, link, thread, () => slack.post({ channel: thread.channel, thread_ts: thread.ts, text: link.text }));
    });
  }
  for (const reply of due.replies) {
    await attempt(`${reply.id} to ${reply.reviewer} on ${reply.pr}`, async () => {
      const threadTs = reply.thread_ts || (await dayThread(reply.reviewer, async () => reply.channel)).ts;
      await postReply(board.dir, reply, () => slack.post({ channel: reply.channel, thread_ts: threadTs, text: reply.text }));
    });
  }
  for (const r of due.reactions) {
    await attempt(`${r.emoji} for ${r.reviewer} on ${r.pr}`, async () => {
      await slack.react({ channel: r.channel, ts: r.ts, name: r.emoji });
      await recordReaction(board.dir, r);
    });
  }
  return { sent, failed };
}

const hasReviewers = (board) => {
  try { return (JSON.parse(fs.readFileSync(path.join(board.dir, 'board.json'), 'utf8')).reviewers || []).length > 0; } catch { return false; }
};

// One fault push for each time Slack refuses the token while a board has reviewers, so no send waits unseen.
async function pushRefusal(boards, now) {
  if (!refusalUnpushed() || !boards.some(hasReviewers)) return [];
  await deliver({ title: 'Slack refused Hub’s token', body: 'Reviewer links, reactions and digests wait until a working token is saved in Hub › Integrations › Slack.', url: '/_hub/settings#slack', tag: 'slack-token' }, { kind: 'fault', immediate: true, at: now });
  markRefusalPushed();
  return ['pushed that Slack refused the token'];
}

// boards: listBoards()'s {route, dir, title}. → {sent: ['<route>: <what>'], failed: ['<route>: <why>']}, both empty
// without a saved token.
export async function sendReviews({ boards = listBoards(), fetch, now = new Date() } = {}) {
  const slack = savedSlack({ fetch });
  const sent = [];
  const failed = [];
  if (!slack) return { sent, failed };
  for (const board of boards) {
    try {
      const out = await sendBoard(board, slack, now);
      sent.push(...out.sent.map((what) => `${board.route}: ${what}`));
      failed.push(...out.failed);
    } catch (e) {
      failed.push(`${board.route}: ${e.message}`);
      if (refusedToken(e)) break;
    }
  }
  try { sent.push(...await pushRefusal(boards, now)); } catch (e) { failed.push(`refused-token push: ${e.message}`); }
  return { sent, failed };
}
