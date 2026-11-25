// docs/adr/2026-11-25-0200-slack-is-read-every-30-seconds-on-its-own-poll.md
// The Slack poll: every Slack read and post the hub makes, but the review sends, which ride the GitHub poll
// (review-send.mjs sendReviews). Each run files new @kickflip DMs, copies replies in Slack-filed tasks' threads, posts
// the replies owed, swaps their status reactions, after the replies so a message whose reply just posted swaps on the
// same run, and hears the reviewers' day threads, then sends the queued pushes when it queued any and pushes aren't
// held. The hub runs it on its 15 s clock (shared/polls.mjs slack-poll); a run goes once slackEvery has passed since
// the last began, give or take a tick, so every 30 s, here or away, and every 5 minutes in quiet hours. One run at a
// time: a run asked for while one runs joins it, so no post goes twice. Every run uses one client per saved token
// (slack.mjs heldSlack), so what a client asks once holds across runs.
import { readSettings, flushQueue } from './push.mjs';
import { heldUntil, slackEvery } from './schedule.mjs';
import { heldSlack } from './slack.mjs';
import { fileSlackAsks, followSlackAsks, postSlackReplies, reactSlackStatus } from './slack-intake.mjs';
import { hearReviews } from './review-send.mjs';
import { CLOCKS } from '../shared/polls.mjs';

const ERROR_LOG_MS = 60 * 60_000;

// Each step in run order: its function, the result's list of what it did, how each line logs, and its failures' name.
export const STEPS = Object.freeze([
  { id: 'intake', run: fileSlackAsks, done: 'filed', line: (l) => `@kickflip from ${l}, queued for the router`, failures: 'slack intake' },
  { id: 'follow', run: followSlackAsks, done: 'copied', line: (l) => `copied a reply onto ${l}`, failures: 'slack follow' },
  { id: 'replies', run: postSlackReplies, done: 'posted', line: (l) => `posted ${l}`, failures: 'slack replies' },
  { id: 'status', run: reactSlackStatus, done: 'reacted', line: (l) => `reacted on ${l}`, failures: 'slack status' },
  { id: 'hear', run: hearReviews, done: 'sent', line: (l) => `heard ${l}`, failures: 'slack hearing' },
]);

// boards() → listBoards()'s boards; log(line). Each step's failures log at most hourly. → {run}: run() starts a run
// when one is due and returns it, the running one while one runs, else null. A run resolves to {at, <step id>: its
// result, flushed: {count, sent, ok} | null}.
export function slackPoll({ boards, log, clock = Date.now, settings = readSettings, slack = heldSlack, flush = flushQueue, steps = STEPS }) {
  let running = null;
  let startedAt = 0;
  const loggedAt = {};
  async function runSteps(now) {
    const result = { at: now.toISOString() };
    const client = slack();
    for (const step of steps) {
      let out;
      try { out = await step.run({ boards: boards(), slack: client, now }); } catch (e) { out = { [step.done]: [], failed: [e.message] }; }
      result[step.id] = out;
      for (const line of out[step.done]) log(`slack: ${step.line(line)}`);
      if (out.failed.length && clock() - (loggedAt[step.id] || 0) > ERROR_LOG_MS) {
        loggedAt[step.id] = clock();
        log(`${step.failures}: ${out.failed.length} failed, first: ${out.failed[0]} (logged at most hourly)`);
      }
    }
    result.flushed = null;
    if (steps.some((step) => result[step.id].queued) && heldUntil(now, settings()) === null) {
      try {
        const r = await flush();
        if (r) { result.flushed = { count: r.count, sent: r.sent, ok: r.ok }; log(`push queue: sent ${r.sent} of ${r.count} queued`); }
      } catch (e) { log('push queue flush failed:', e.message); }
    }
    return result;
  }
  return {
    run() {
      if (running) return running;
      const now = new Date(clock());
      if (startedAt && now - startedAt < slackEvery(now, settings()) - CLOCKS.quarter) return null;
      startedAt = now.getTime();
      running = runSteps(now).finally(() => { running = null; });
      return running;
    },
  };
}
