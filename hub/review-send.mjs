// The hub sends what each board's `review due` owes, as the owner through Hub's Slack token, recording each send in the
// board's files as board/store.mjs posts it (docs/adr/2026-11-05-0141-the-hub-sends-reviewer-slack-messages-with-its-own-token.md,
// docs/adr/2026-11-07-0300-slack-sends-hang-off-prs-and-go-out-from-the-hub-tick.md,
// docs/adr/2026-11-11-1600-review-posts-go-into-one-day-thread-per-board.md,
// docs/adr/2026-11-12-0044-a-day-thread-carries-only-each-prs-link.md). Each reviewer gets one thread per board for
// each Slack day, in the DM the hub opens with them: the weekday digest opens it when it is due first, else a
// “<board> reviews” header line. Each PR's link goes in as a reply, and nothing else about the PR does. Reactions go on
// every posted link and reply. A failed send stays owed and goes again next poll. After the sends, the hub hears the
// day threads (hearBoards).
import fs from 'node:fs';
import path from 'node:path';
import { appendEvent, listBoards } from './boards.mjs';
import { savedSlack, slackStatus, refusalUnpushed, markRefusalPushed, missingScope, setHearing, hearingUnpushed, markHearingPushed, slackUserId, isSignedOff } from './slack.mjs';
import { deliver } from './push.mjs';
import { reviewDue, postLink, recordReaction, postDigest, recordHeader, openDayThread, heardThreads, markHeard, boardPosts } from '../board/store.mjs';

const refusedToken = (e) => e.status === 400 && e.message === 'Slack refused the token.';

const digestHeader = (board) => (n) => `${board.title} digest: ${n ? `${n} pending your review` : 'all reviewed'}`;

async function sendBoard(board, slack, now) {
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
        header: digestHeader(board),
        post: (message) => slack.post(message),
      });
    });
  }
  // A posted digest header's count follows its reviewer's PRs as they leave review; a failed edit stays owed.
  for (const h of due.headers) {
    await attempt(`digest count for ${h.reviewer}`, async () => {
      await slack.update({ channel: h.channel, ts: h.ts, text: `${h.lead}${digestHeader(board)(h.n)}${h.tail}` });
      await recordHeader(board.dir, h);
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

// docs/adr/2026-11-12-0000-reviewers-ask-the-board-in-the-day-thread.md
// Each new message in a day thread the hub still hears wakes its board with a slack-question event {reviewer, channel,
// thread_ts, ts, from, answer}, holding where the message is and none of its words. Boards share one DM per reviewer,
// so one history read per DM finds the threads with replies past what was heard, and only those are read. The board's
// own posts and the orchestrator's signed-off answers wake nobody; the owner's message expects an answer only when it names
// @kickflip. → {sent, failed}
async function hearBoards(boards, slack, now) {
  const sent = [];
  const failed = [];
  const owner = slackUserId();
  const byChannel = new Map();
  for (const board of boards) {
    try {
      for (const thread of await heardThreads(board.dir, now)) byChannel.set(thread.channel, [...(byChannel.get(thread.channel) || []), { board, thread }]);
    } catch (e) { failed.push(`${board.route}: reading its day threads: ${e.message}`); }
  }
  // One failed read leaves the rest heard; missing_scope stops them all.
  const attempt = async (what, read) => {
    try { await read(); } catch (e) {
      if (missingScope(e)) throw e;
      failed.push(`${what}: ${e.message}`);
    }
  };
  for (const [channel, threads] of byChannel) {
    await attempt(`hearing DM ${channel}`, async () => {
      const oldest = threads.map((t) => t.thread.ts).sort((a, b) => Number(a) - Number(b))[0];
      const latest = new Map((await slack.history({ channel, oldest })).map((m) => [m.ts, m.latest_reply]));
      setHearing(true);
      for (const { board, thread } of threads) {
        const heard = thread.heard || thread.ts;
        if (!(Number(latest.get(thread.ts)) > Number(heard))) continue;
        await attempt(`${board.route}: hearing ${thread.reviewer}'s ${thread.date} thread`, async () => {
          const fresh = (await slack.replies({ channel, ts: thread.ts, oldest: heard })).filter((m) => Number(m.ts) > Number(heard));
          const ours = await boardPosts(board.dir);
          // Each message is marked heard once its event is in, so a failure part way wakes no message twice.
          for (const m of fresh) {
            if (!m.subtype && !m.bot_id && !ours.has(m.ts) && !(m.user === owner && isSignedOff(m.text))) {
              const from = m.user === owner ? 'owner' : 'reviewer';
              await appendEvent(board, 'slack-question', { reviewer: thread.reviewer, channel, thread_ts: thread.ts, ts: m.ts, from, answer: from === 'reviewer' || /@kickflip\b/i.test(m.text || '') });
              sent.push(`${board.route}: slack-question from ${from === 'owner' ? 'the owner' : thread.reviewer}`);
            }
            await markHeard(board.dir, thread, m.ts);
          }
        });
      }
    });
  }
  return { sent, failed };
}

// Hears the day threads, or, while the token can't read them, pushes that once; sends go on either way.
async function hear(boards, slack, now) {
  try { return await hearBoards(boards, slack, now); } catch (e) {
    if (!missingScope(e)) return { sent: [], failed: [`hearing the day threads: ${e.message}`] };
    setHearing(false);
    if (!hearingUnpushed()) return { sent: [], failed: [] };
    await deliver({ title: 'Slack can’t read the review threads', body: 'Reviewers’ messages to the board wait unheard until Hub’s Slack app has im:history: add it, reinstall the app and paste its new token in Hub › Integrations › Slack. Sends go on.', url: '/_hub/settings#slack', tag: 'slack-unheard' }, { kind: 'fault', at: now });
    markHearingPushed();
    return { sent: ["pushed that Slack can't read the review threads"], failed: [] };
  }
}

// boards: listBoards()'s {route, dir, title}. Sends, then hears the day threads unless Slack refused the token.
// → {sent: ['<route>: <what>'], failed: ['<route>: <why>']}, both empty without a saved token.
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
  if (!slackStatus().refused) {
    try {
      const heard = await hear(boards, slack, now);
      sent.push(...heard.sent);
      failed.push(...heard.failed);
    } catch (e) { failed.push(`unheard push: ${e.message}`); }
  }
  try { sent.push(...await pushRefusal(boards, now)); } catch (e) { failed.push(`refused-token push: ${e.message}`); }
  return { sent, failed };
}
