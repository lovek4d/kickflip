// The hub sends what each board's `review due` owes, as the owner through Hub's Slack token, and records each send
// with the board's own writers (docs/adr/2026-11-05-0141-the-hub-sends-reviewer-slack-messages-with-its-own-token.md).
// A review link goes alone, the bare PR URL, to the DM the hub opens with the reviewer; a merged card's recorded links
// get git_merged; the weekday digest is a top-level “🤖 <board> digest: …” with one thread reply per PR.
import { listBoards } from './boards.mjs';
import { savedSlack } from './slack.mjs';
import { reviewDue, reviewSent, reviewReact, reviewDigestSent } from '../board/store.mjs';

const refusedToken = (e) => e.status === 400 && e.message === 'Slack refused the token.';

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
  for (const dm of due.dms) {
    await attempt(`link to ${dm.reviewer} on ${dm.key}`, async () => {
      const channel = await slack.openDM(dm.slack_user);
      const ts = await slack.post({ channel, text: dm.text });
      await reviewSent(board.dir, dm.key, dm.reviewer, { ts, channel });
    });
  }
  for (const r of due.reactions) {
    await attempt(`${r.emoji} for ${r.reviewer} on ${r.key}`, async () => {
      await slack.react({ channel: r.channel, ts: r.ts, name: r.emoji });
      await reviewReact(board.dir, r.key, r.reviewer, r.emoji);
    });
  }
  for (const reviewer of due.digest?.reviewers || []) {
    const n = reviewer.items.length;
    await attempt(`digest to ${reviewer.name}`, async () => {
      const channel = await slack.openDM(reviewer.slack_user);
      const ts = await slack.post({ channel, text: `🤖 ${board.title} digest: ${n} PR${n === 1 ? '' : 's'} pending your review` });
      for (const item of reviewer.items) {
        await slack.post({ channel, thread_ts: ts, text: `${item.url} · ${item.title}${item.days_old ? ` (${item.days_old} days old)` : ''}` });
      }
      await reviewDigestSent(board.dir, reviewer.name, { ts, channel, items: reviewer.items.map((i) => i.key).join(',') }, { now });
    });
  }
  return { sent, failed };
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
  return { sent, failed };
}
