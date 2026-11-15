// docs/adr/2026-11-15-0130-an-at-kickflip-in-a-slack-dm-is-filed-as-a-routed-ask.md
// An @kickflip in one of the owner's 1:1 Slack DMs, from anyone, goes to the router as a request, which files it as a
// routed ask on the board it fits; the board refuses to sort that ask ready before the owner stages its card. One
// search.messages call each poll finds the matches. The token is the owner's, with no bot, so the match is on the
// text "@kickflip". The request's words are the thread up to the match: the opener and the replies before it, then
// the match, each as "<name>: <text>". Its from names the Slack thread, {channel, thread_ts, ts}.
// Not filed: a group DM or channel, our own signed-off posts, a thread already filed, and a board's day thread or its
// posts' threads, where an @kickflip is a slack-question (review-send.mjs hearBoards).
// ~/.claude/kickflip/slack-intake.json holds since, the Slack ts intake started at, and threads, each filed thread's
// "<channel>:<thread_ts>" mapped to its match's ts. Intake starts at its first poll, past every match already there,
// and keeps a thread for KEEP_DAYS, reading no match older.
import os from 'node:os';
import path from 'node:path';
import { listBoards, readJSON, saveJSON } from './boards.mjs';
import { savedSlack, slackStatus, missingScope, setSearching, isSignedOff } from './slack.mjs';
import { queueRequest } from './router.mjs';
import { boardPosts } from '../board/store.mjs';

export const INTAKE_FILE = path.join(os.homedir(), '.claude', 'kickflip', 'slack-intake.json');
const NAMED = /@kickflip\b/i;
const KEEP_DAYS = 30;

// A match's thread: the thread_ts its permalink names when it is a reply, else its own ts.
const threadOf = (m) => new URL(m.permalink).searchParams.get('thread_ts') || m.ts;

// Files each new @kickflip DM as a queued request, which the hub's tick routes. → {filed: ['<name> in <channel>:
// <link>'], failed: [why]}, both empty without a saved working token, or while it lacks search:read, which the Slack
// row then says.
export async function fileSlackAsks({ boards = listBoards(), fetch, now = new Date() } = {}) {
  const slack = savedSlack({ fetch });
  const filed = [];
  const failed = [];
  if (!slack || slackStatus().refused) return { filed, failed };
  let matches;
  try { matches = await slack.search({ query: 'kickflip' }); } catch (e) {
    if (!missingScope(e)) return { filed, failed: [`searching Slack for @kickflip: ${e.message}`] };
    setSearching(false);
    return { filed, failed };
  }
  setSearching(true);
  const clock = now.getTime() / 1000;
  const hits = matches.filter((m) => m.channel?.is_im && !m.channel.is_mpim && NAMED.test(m.text || '') && !isSignedOff(m.text, m.attachments))
    .sort((a, b) => Number(a.ts) - Number(b.ts));
  const saved = readJSON(INTAKE_FILE, null);
  if (!saved) {
    saveJSON(INTAKE_FILE, { since: String(Math.max(clock, ...hits.map((m) => Number(m.ts)))), threads: {} });
    return { filed, failed };
  }
  const horizon = Math.max(Number(saved.since), clock - KEEP_DAYS * 86400);
  const state = { since: saved.since, threads: Object.fromEntries(Object.entries(saved.threads).filter(([, ts]) => Number(ts) > horizon)) };
  const key = (m) => `${m.channel.id}:${threadOf(m)}`;
  const fresh = hits.filter((m) => Number(m.ts) > horizon && !state.threads[key(m)]);
  if (fresh.length) {
    const ours = new Set();
    for (const board of boards) {
      try { for (const ts of await boardPosts(board.dir)) ours.add(ts); } catch (e) { failed.push(`${board.route}: reading its Slack posts: ${e.message}`); }
    }
    let names = new Map();
    try { names = new Map((await slack.people()).map((p) => [p.id, p.name])); } catch (e) { failed.push(`naming Slack people: ${e.message}`); }
    const name = (id) => names.get(id) || id;
    const words = (m) => `${name(m.user)}: ${String(m.text || '').replace(/<@(U[A-Z0-9]+)(\|[^>]*)?>/g, (_, id) => `@${name(id)}`)}`;
    for (const m of fresh) {
      const thread = threadOf(m);
      if (state.threads[key(m)] || ours.has(thread)) continue;
      try {
        const seed = thread === m.ts ? [m] : (await slack.replies({ channel: m.channel.id, ts: thread })).filter((r) => Number(r.ts) <= Number(m.ts));
        await queueRequest({ text: seed.map(words).join('\n\n'), from: { via: 'slack', by: name(m.user), link: m.permalink, slack: { channel: m.channel.id, thread_ts: thread, ts: m.ts } } });
        state.threads[key(m)] = m.ts;
        saveJSON(INTAKE_FILE, state);
        filed.push(`${name(m.user)} in ${m.channel.id}: ${m.permalink}`);
      } catch (e) { failed.push(`filing ${m.permalink}: ${e.message}`); }
    }
  }
  saveJSON(INTAKE_FILE, state);
  return { filed, failed };
}
