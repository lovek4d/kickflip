// docs/adr/2026-11-15-0130-an-at-kickflip-in-a-slack-dm-is-filed-as-a-routed-ask.md
// A message saying kickflip, with or without the @, in one of the owner's 1:1 Slack DMs, from anyone, goes to the router as a request, which files it as a
// routed ask on the board it fits; the board refuses to sort that ask ready before the owner stages its card. One
// search.messages call each Slack poll finds the matches, two while the workspace has a kickflip bot user. The token is the owner's, with no bot, so the match is on the
// word kickflip in the text, or the mention of the workspace's kickflip bot user when it has one. A filed message gets the received status's reaction, 👀 by default; a failed reaction is reported, never fatal. The request's words are the thread up to the match: the opener and the replies before it, then
// the match, each as "<name>: <text>". Its from names the Slack thread, {channel, thread_ts, ts, reacted?}, reacted the
// received status's emoji (statusEmojis) once Slack took it, the reaction the task's status then swaps
// (docs/adr/2026-11-23-0010-a-slack-message-on-a-task-shows-where-it-stands-as-one-reaction.md).
// Not filed: a group DM or channel, our own signed-off posts, a thread already filed, and a board's day thread or its
// posts' threads, where an @kickflip is a slack-question (review-send.mjs hearBoards).
// ~/.claude/kickflip/slack-intake.json holds since, the Slack ts intake started at, and threads, each filed thread's
// "<channel>:<thread_ts>" mapped to its match's ts. Intake starts at its first poll, past every match already there,
// and keeps a thread for KEEP_DAYS, reading no match older.
import os from 'node:os';
import path from 'node:path';
import { appendEvent, isListening, listBoards, readJSON, saveJSON } from './boards.mjs';
import { savedSlack, slackStatus, missingScope, setSearching, isSignedOff, slackUserId, statusEmojis } from './slack.mjs';
import { queueRequest } from './router.mjs';
import { appendMessage, appendStatus } from '../board/cards.mjs';
import { boardPosts, followedSlackThreads, markSlackPost, markSlackFollow, markSlackThreadHeard, markSlackWait, recordSlackStatus, slackOutbox, slackStatusDue } from '../board/slack-store.mjs';

export const INTAKE_FILE = path.join(os.homedir(), '.claude', 'kickflip', 'slack-intake.json');
const NAMED = /\bkickflip\b/i;
const KEEP_DAYS = 30;

// A match's thread: the thread_ts its permalink names when it is a reply, else its own ts.
const threadOf = (m) => new URL(m.permalink).searchParams.get('thread_ts') || m.ts;

// Each Slack person's name by id, from one users.list; a failure is pushed onto failed and names no one.
async function slackNames(slack, failed) {
  try { return new Map((await slack.people()).map((p) => [p.id, p.name])); } catch (e) {
    failed.push(`naming Slack people: ${e.message}`);
    return new Map();
  }
}
// A message's text with each Slack mention written as @<name>.
const mentionsNamed = (text, name) => String(text || '').replace(/<@(U[A-Z0-9]+)(\|[^>]*)?>/g, (_, id) => `@${name(id)}`);

// Files each new @kickflip DM as a queued request, which the hub's tick routes. slack: the client, the saved token's
// by default; a client kept across polls asks for the bot user once. → {filed: ['<name> in <channel>: <link>'],
// failed: [why]}, both empty without a saved working token, or while it lacks search:read, which the Slack row then says.
export async function fileSlackAsks({ boards = listBoards(), fetch, slack = savedSlack({ fetch }), now = new Date() } = {}) {
  const filed = [];
  const failed = [];
  if (!slack || slackStatus().refused) return { filed, failed };
  let botId;
  try { botId = await slack.botId(); } catch (e) { failed.push(`finding the kickflip bot user: ${e.message}`); }
  const mention = botId && `<@${botId}>`;
  let matches;
  try {
    matches = await slack.search({ query: 'kickflip' });
    // A picked @Kickflip mention holds no word, so the bot's mention is searched for too, when the workspace has the bot.
    if (mention) {
      const seen = new Set(matches.map((m) => `${m.channel?.id}:${m.ts}`));
      matches.push(...(await slack.search({ query: mention })).filter((m) => !seen.has(`${m.channel?.id}:${m.ts}`)));
    }
  } catch (e) {
    if (!missingScope(e)) return { filed, failed: [...failed, `searching Slack for kickflip: ${e.message}`] };
    setSearching(false);
    return { filed, failed };
  }
  setSearching(true);
  const clock = now.getTime() / 1000;
  const hits = matches.filter((m) => m.channel?.is_im && !m.channel.is_mpim && (NAMED.test(m.text || '') || (mention && String(m.text || '').includes(mention))) && !isSignedOff(m.text, m.attachments))
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
    const names = await slackNames(slack, failed);
    const name = (id) => names.get(id) || id;
    const words = (m) => `${name(m.user)}: ${mentionsNamed(m.text, name)}`;
    for (const m of fresh) {
      const thread = threadOf(m);
      if (state.threads[key(m)] || ours.has(thread)) continue;
      try {
        const seed = thread === m.ts ? [m] : (await slack.replies({ channel: m.channel.id, ts: thread })).filter((r) => Number(r.ts) <= Number(m.ts));
        const received = statusEmojis().received;
        let reacted = received;
        try { await slack.react({ channel: m.channel.id, ts: m.ts, name: received }); } catch (e) {
          reacted = null;
          failed.push(`reacting :${received}: to ${m.permalink}: ${e.message}`);
        }
        await queueRequest({ text: seed.map(words).join('\n\n'), from: { via: 'slack', by: name(m.user), link: m.permalink, slack: { channel: m.channel.id, thread_ts: thread, ts: m.ts, ...(reacted ? { reacted } : {}) } } });
        state.threads[key(m)] = m.ts;
        saveJSON(INTAKE_FILE, state);
        filed.push(`${name(m.user)} in ${m.channel.id}: ${m.permalink}`);
      } catch (e) { failed.push(`filing ${m.permalink}: ${e.message}`); }
    }
  }
  saveJSON(INTAKE_FILE, state);
  return { filed, failed };
}

// docs/adr/2026-11-15-1530-later-replies-in-a-slack-filed-tasks-thread-land-on-the-task.md
// Each new reply in the Slack thread an open task was filed from lands on the task, until the task is Done. Each poll
// reads one conversations.history per DM holding such threads, which gives each thread's latest_reply, and reads a
// thread's replies, from the newest one read, only when its latest_reply moved past it, as hearing the day threads does
// (review-send.mjs hearBoards). The @kickflip's sender's replies and the
// owner's naming @kickflip are item-message events, which wake the orchestrator as the owner's own message does, drawn
// under the sender's name with Slack and the reply's permalink; every other reply is a thread line under its writer's
// name, which wakes no one. A file in a reply is its name and permalink, since a Slack file opens only with a token.
// Not copied: the boards' own posts, the owner's signed-off ones (the orchestrator's), Slack's bot and event messages,
// and an empty one. A read that fails, its DM's or its own, writes one fault line on the card, and the thread is read
// again each poll until it is read. Each reply is marked read once it is in, so a failure part way copies none twice.
// slack: the client, as for fileSlackAsks. → {copied: ['<route> <key>: <name>'], failed: [why]}, both empty without a
// saved working token.
const COPIED_SUBTYPES = ['file_share', 'thread_broadcast'];
export async function followSlackAsks({ boards = listBoards(), fetch, slack = savedSlack({ fetch }) } = {}) {
  const copied = [];
  const failed = [];
  if (!slack || slackStatus().refused) return { copied, failed };
  const owner = slackUserId();
  let names;
  // Boards share the owner's DMs, so each DM's threads are gathered across boards and its history read once.
  const byChannel = new Map();
  for (const board of boards) {
    try {
      const threads = await followedSlackThreads(board.dir);
      const ours = threads.length ? await boardPosts(board.dir) : null;
      for (const thread of threads) byChannel.set(thread.channel, [...(byChannel.get(thread.channel) || []), { board, thread, ours }]);
    } catch (e) { failed.push(`${board.route}: reading its Slack-filed tasks: ${e.message}`); }
  }
  const unread = async ({ board, thread }, e) => {
    failed.push(`${board.route}: following ${thread.key}'s Slack thread: ${e.message}`);
    if (!thread.failing) {
      await markSlackFollow(board.dir, thread, true);
      await appendStatus(board.dir, thread.key, 'slack-follow-failed', { error: e.message });
    }
  };
  for (const [channel, follows] of byChannel) {
    let latest;
    try {
      const oldest = follows.map((f) => f.thread.thread_ts).sort((a, b) => Number(a) - Number(b))[0];
      latest = new Map((await slack.history({ channel, oldest })).map((m) => [m.ts, m.latest_reply]));
    } catch (e) {
      // A token without im:history reads no thread; hearing the day threads pushes that (review-send.mjs hear).
      if (missingScope(e)) return { copied, failed };
      for (const f of follows) await unread(f, e);
      continue;
    }
    for (const { board, thread, ours } of follows) {
      try {
        if (Number(latest.get(thread.thread_ts)) > Number(thread.heard)) {
          const fresh = (await slack.replies({ channel: thread.channel, ts: thread.thread_ts, oldest: thread.heard })).filter((m) => Number(m.ts) > Number(thread.heard));
          for (const m of fresh) {
            if (!m.bot_id && (!m.subtype || COPIED_SUBTYPES.includes(m.subtype)) && !ours.has(m.ts) && !(m.user === owner && isSignedOff(m.text, m.attachments))) {
              names ??= await slackNames(slack, failed);
              const name = (id) => names.get(id) || id;
              const text = [mentionsNamed(m.text, name), ...(m.files || []).map((f) => `${f.name || f.title}: ${f.permalink}`)].filter((t) => t.trim()).join('\n');
              if (text) {
                const link = `${new URL(thread.link).origin}/archives/${thread.channel}/p${m.ts.replace('.', '')}?thread_ts=${thread.thread_ts}&cid=${thread.channel}`;
                const theirs = m.user === owner ? null : name(m.user);
                if (name(m.user) === thread.by || (!theirs && NAMED.test(m.text || ''))) {
                  await appendEvent(board, 'item-message', { key: thread.key, text, sendId: `slack:${thread.channel}:${m.ts}`, slack: { ...(theirs ? { by: theirs } : {}), link, thread: { channel: thread.channel, thread_ts: thread.thread_ts } } });
                } else await appendMessage(board.dir, thread.key, { text, who: theirs || 'love', via: 'slack', link });
                copied.push(`${board.route} ${thread.key}: ${name(m.user)}`);
              }
            }
            await markSlackThreadHeard(board.dir, thread, m.ts);
          }
        }
        if (thread.failing) await markSlackFollow(board.dir, thread, false);
      } catch (e) {
        if (missingScope(e)) return { copied, failed };
        await unread({ board, thread }, e);
      }
    }
  }
  return { copied, failed };
}

// docs/adr/2026-11-16-1700-replies-to-a-slack-message-post-into-its-slack-thread.md
// The orchestrator's replies to a Slack-filed task's Slack messages (the @kickflip ask, or a Slack reply copied onto the
// task) post into its Slack thread as the owner, signed off, in the order written; once the task is
// Done, one end line follows and nothing more posts. While the task waits on the owner, one "Waiting on owner: <what>"
// line posts per wait (slack-store.mjs ownerWaitWords), after the replies; a wait that clears and a new one post again.
// A failed wait line is retried each poll with no fault line. A failed post writes one fault line on the card and is retried
// each poll, holding back the thread's later posts; each posted one's ts is recorded, so none posts twice.
// slack: the client, as for fileSlackAsks. → {posted: ['<route> <key>: a reply' | 'its end line'], failed: [why]}, both
// empty without a saved working token.
export async function postSlackReplies({ boards = listBoards(), fetch, slack = savedSlack({ fetch }) } = {}) {
  const posted = [];
  const failed = [];
  if (!slack || slackStatus().refused) return { posted, failed };
  for (const board of boards) {
    let outbox;
    try { outbox = await slackOutbox(board.dir); } catch (e) { failed.push(`${board.route}: reading its Slack replies: ${e.message}`); continue; }
    for (const thread of outbox) {
      const posts = [...thread.replies.map((r) => ({ ...r, what: 'a reply' })), ...(thread.end ? [{ ...thread.end, what: 'its end line' }] : []),
        ...(thread.wait ? [{ text: `Waiting on owner: ${thread.wait}`, what: 'a wait line', wait: thread.wait }] : [])];
      for (const p of posts) {
        try {
          const ts = await slack.post({ channel: thread.channel, thread_ts: thread.thread_ts, text: p.text });
          await (p.wait ? markSlackWait(board.dir, thread, p.wait, ts) : markSlackPost(board.dir, thread, p.name, { ts }));
          posted.push(`${board.route} ${thread.key}: ${p.what}`);
        } catch (e) {
          failed.push(`${board.route}: posting ${p.what} of ${thread.key} to Slack: ${e.message}`);
          if (!p.failed && !p.wait) {
            await markSlackPost(board.dir, thread, p.name, { failed: true });
            await appendStatus(board.dir, thread.key, 'slack-post-failed', { what: p.what, error: e.message });
          }
          break;
        }
      }
    }
  }
  return { posted, failed };
}

// docs/adr/2026-11-23-0010-a-slack-message-on-a-task-shows-where-it-stands-as-one-reaction.md
// Each Slack message on a Slack-filed task shows where it stands as one reaction, swapped as it moves on (slack-store.mjs
// slackStatusDue): 👀 received, 🤔 thinking, ✋ waiting on the owner, ✅ done, or Hub › Slack's picks. A message's
// removal goes before its add, and a failed one holds back that message's rest until the next poll, which tries again.
// listening(board) says whether the board's session hears its events; slack: the client, as for fileSlackAsks.
// → {reacted: ['<route> <key>: [removed ]:<emoji>:'], failed: [why]}, both empty without a saved working token.
export async function reactSlackStatus({ boards = listBoards(), fetch, slack = savedSlack({ fetch }), listening = (board) => isListening(board) } = {}) {
  const reacted = [];
  const failed = [];
  if (!slack || slackStatus().refused) return { reacted, failed };
  const emojis = statusEmojis();
  for (const board of boards) {
    let due;
    try { due = await slackStatusDue(board.dir, { emojis, listening: () => listening(board) }); } catch (e) { failed.push(`${board.route}: reading its Slack messages' status: ${e.message}`); continue; }
    const stuck = new Set();
    for (const r of due) {
      const id = `${r.channel}:${r.ts}`;
      if (stuck.has(id)) continue;
      try {
        await (r.remove ? slack.unreact : slack.react)({ channel: r.channel, ts: r.ts, name: r.emoji });
        await recordSlackStatus(board.dir, r);
        reacted.push(`${board.route} ${r.key}: ${r.remove ? 'removed ' : ''}:${r.emoji}:`);
      } catch (e) {
        stuck.add(id);
        failed.push(`${board.route}: ${r.remove ? `removing :${r.emoji}: from` : `reacting :${r.emoji}: to`} ${r.key}: ${e.message}`);
      }
    }
  }
  return { reacted, failed };
}
