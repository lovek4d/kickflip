// Slack, from the board's side: each PR's link and reactions, each reviewer's day thread and digest, the Slack threads
// a board's tasks were filed from, and the orchestrator's `slack` commands. The hub sends what these owe
// (hub/review-send.mjs, hub/slack-intake.mjs) and records each send here. Its files are written through files.mjs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { githubStateFile, appendEvent } from '../hub/boards.mjs';
import { routeRecord } from '../hub/routes.mjs';
import { ticketBadge } from './tickets.mjs';
import { boardConfig, editJSON, itemSources, readJSON, readLog } from './files.mjs';
import { prSize } from '../hub/pr-report.mjs';
import { cardPRs, parsePRRef, prKeyOf, prURL } from '../shared/card-prs.mjs';
import { reviewLinks, reviewTime, topicItems, reviewersOf } from './review.mjs';
import { readiness } from '../hub/readiness.mjs';
import { SlackError, SLACK_NEEDS_TOKEN, isSignedOff, readSlack, savedSlack, slackDay, slackUserId } from '../hub/slack.mjs';
import { BoardError, domId, needSite, text } from './checks.mjs';
import { addItem, appendMessage, askCardOf } from './cards.mjs';
import { boardRepoOf, boardTarget, sameName, settingsOf, storedTickets } from './settings.mjs';

const fail = (msg) => { throw new BoardError(msg); };

// docs/adr/2026-11-07-0300-slack-sends-hang-off-prs-and-go-out-from-the-hub-tick.md,
// docs/adr/2026-11-11-1600-review-posts-go-into-one-day-thread-per-board.md,
// docs/adr/2026-11-12-0044-a-day-thread-carries-only-each-prs-link.md
// data/pr-slack.json {<owner/repo#n>: {links: {<reviewer>: {channel, thread_ts, ts, reactions}},
// replies: [{id, text, to: {<reviewer>: {channel?, ts, reactions}}}]}}: each PR's Slack messages, apart from the cards
// that hold it. Every reviewer of a PR has their own link message, in the owner's DM with them: a reply in that day's
// thread when it has thread_ts, else posted top-level before the day threads. replies are the PR's other messages
// already posted, which get the link's reactions: a one-PR digest reply (id digest-<date>), and the bumps sent before
// they stopped; one never posted is never sent. A message carries ts once posted, and posting_at while its post is out
// or after its ts couldn't be recorded; either way it is never posted again. reactions are the ones the hub added,
// [{kind, name}], the PR state and the emoji; a name alone is an earlier build's, its kind read from LEGACY_REACTIONS.
// state is the words of the state line an earlier build put in the message, until an edit takes it out.
const prSlackFile = (site) => path.join(needSite(site), 'data', 'pr-slack.json');
export const readPRSlack = (site) => readJSON(prSlackFile(site), {});
const held = (message) => Boolean(message?.ts || message?.posting_at);
// Whether a reviewer is owed a PR's link: the hub last read it open and out of draft, and its link isn't held.
const linkOwed = (gh, record, pr, name) => gh?.state === 'OPEN' && !gh.isDraft && !held(record[pr]?.links?.[name]);

// Posts one Slack message at most once. find(file's object) → the message's record. It is marked posting, posted, then
// given its ts. A post that throws is unmarked, to go again next poll; a ts that can't be recorded leaves it marked.
async function postOnce(file, find, post) {
  await editJSON(file, (all) => {
    const message = find(all);
    if (held(message)) fail('that Slack message has already gone out');
    message.posting_at = new Date().toISOString();
  });
  let ts;
  try { ts = await post(); } catch (e) {
    await editJSON(file, (all) => { delete find(all).posting_at; });
    throw e;
  }
  try {
    await editJSON(file, (all) => { const message = find(all); message.ts = ts; delete message.posting_at; });
  } catch (e) { fail(`posted, but its record failed, so it won't go again: ${e.message}`); }
  return ts;
}

// due: one of review due's links, or slack link's; thread: the reviewer's day thread {channel, ts}; post() → ts.
export const postLink = (site, due, thread, post) => postOnce(prSlackFile(site), (all) => {
  const rec = all[due.pr] ||= { links: {}, replies: [] };
  return Object.assign(rec.links[due.reviewer] ||= { reactions: [] }, { channel: thread.channel, thread_ts: thread.ts });
}, post);
// The message one of review due's reactions or edits is for. due.reply is the reply's index in the PR's replies, and
// absent for the reviewer's link; a due whose message isn't there is a bug.
function dueMessage(all, due) {
  const rec = all[due.pr];
  return (due.reply === undefined ? rec?.links[due.reviewer] : rec?.replies[due.reply]?.to[due.reviewer])
    || fail(`no recorded Slack message for ${due.reviewer} on ${due.pr}${due.reply === undefined ? '' : ` reply ${due.reply}`}`);
}
// due: one of review due's reactions, once Slack has added or removed it.
export const recordReaction = (site, due) => editJSON(prSlackFile(site), (all) => {
  const message = dueMessage(all, due);
  const kept = reactionsOf(message).filter((r) => r.name !== due.emoji);
  message.reactions = due.remove ? kept : [...kept, { kind: due.kind, name: due.emoji }];
});
// due: one of review due's edits, once Slack has it: the message no longer shows a state line.
export const recordEdit = (site, due) => editJSON(prSlackFile(site), (all) => { delete dueMessage(all, due).state; });

// docs/adr/2026-11-14-0451-a-prs-slack-link-is-a-bar-coloured-by-the-builders-risk.md
// docs/adr/2026-11-14-2300-every-pr-message-is-the-bar-with-no-mention.md
// A PR's message in a day thread, the one PR message format every sender uses (the first-day link, each digest reply, a
// session's `slack link`): no text, and one attachment whose colour bar is the card's risk (grey with none), headed by
// the card's ticket id linking its issue (the attachment's small author line; none without a ticket), titled by the
// PR's title linking the PR, then “+N/-M · K files · <risk> risk”, the size from GitHub and the risk word repeating the
// colour, then from two days old its own line, “_(N days old)_”. The Slack client signs off the attachment's text, so
// the sign-off stays the message's last line. ticket: ticketBadge's {id, url}; old: whole days since the PR's first
// link to that reviewer, when over two. → {text, attachments}
const RISK_COLOURS = { low: '#2eb67d', medium: '#e8912d', high: '#e01e5a' };
const NO_RISK_COLOUR = '#9e9e9e';
function prLink(pr, gh, item, { ticket, old } = {}) {
  const [repo, number] = pr.split('#');
  const title = gh.title || item.title;
  const size = Number.isInteger(gh.additions) ? [`+${gh.additions}/-${gh.deletions}`, `${gh.files} file${gh.files === 1 ? '' : 's'}`] : [];
  const line = [...size, item.risk && `${item.risk} risk`].filter(Boolean).join(' · ');
  const age = old && `(${old} days old)`;
  return {
    text: '',
    attachments: [{
      color: RISK_COLOURS[item.risk] || NO_RISK_COLOUR, ...(ticket ? { author_name: ticket.id, author_link: ticket.url } : {}),
      title, title_link: prURL({ repo, number }), text: [line, age && `_${age}_`].filter(Boolean).join('\n'),
      fallback: [ticket?.id, `${repo.split('/').pop()}#${number} ${title}`, line, age].filter(Boolean).join(' · '),
    }],
  };
}
// docs/adr/2026-11-18-0434-a-prs-state-is-reactions-again-and-the-signature-is-picked.md
// The state a PR's message to the reviewer whose github login is github is reacted to with: merged, closed, or approved
// once it is approved (approved below) or that reviewer approved it; null while it is open and none of those.
function prKind(gh, github) {
  if (gh.state === 'MERGED') return 'merged';
  if (gh.state === 'CLOSED') return 'closed';
  return approved(gh) || (github && gh.reviews?.[github] === 'APPROVED') ? 'approved' : null;
}
// The reactions the hub added to a recorded message, [{kind, name}]. An earlier build recorded each by its name alone:
// these three, whose kind is known; it reacted with a standard emoji in their place while the workspace lacked them,
// which removing the recorded name then misses.
const LEGACY_REACTIONS = { git_approved: 'approved', git_merged: 'merged', x: 'closed' };
const reactionsOf = (message) => (message.reactions || []).map((r) => (typeof r === 'string' ? { kind: LEGACY_REACTIONS[r], name: r } : r)).filter((r) => r.kind);
// A card's ticket for its PR's message, null without one.
const ticketOfCard = (cfg, item, repo) => (cfg.tickets ? ticketBadge(storedTickets(cfg.tickets), item.ticket, { repo }) : null);
// docs/adr/2026-11-12-1400-a-chip-per-pr-reviewer-and-git-approved-waits-for-githubs-decision.md: a PR is approved on
// GitHub's review decision, which counts a code owner's approval when the branch asks for one; on a branch that asks
// for no review (no decision) any human approval does (hub/pr-report.mjs leaves a bot's out of `approved`). The digest,
// review due's headers and the approved reaction all ask this one test.
// A reviewer's digest holds a PR while GitHub still needs an approval for it (its decision is neither APPROVED nor empty,
// as on a branch that asks for no review) and that reviewer, by their github login, has not approved it themselves; the
// approval of a bot or another person takes it out of nobody else's digest.
const waitsOn = (gh, github) => Boolean(gh.reviewDecision) && gh.reviewDecision !== 'APPROVED' && !(github && gh.reviews?.[github] === 'APPROVED');
const approved = (gh) => (gh?.reviewDecision ? gh.reviewDecision === 'APPROVED' : Boolean(gh?.approved));

// docs/adr/2026-11-03-0003-the-board-records-what-it-knows-and-commands-make-the-rule-calls.md
// `review due`: each Slack send still owed, from local state with no GitHub call; the hub sends them each poll.
// date: the Slack day, whose thread a link goes in. links: a fresh link to each reviewer of a card's PR that the hub
// last read open and out of draft, once per PR. reactions: on each posted link and reply to a reviewer of a card's PR,
// the reaction of the state the PR is in now (prKind), and each the hub added for another state removed, removals
// first; a PR the hub holds no state for is left as it is. edits: each posted link and digest reply an earlier build
// put a state line in, as the whole message again without it. digest: review digest's answer while one is due, else
// null. emojis() → {<state kind>: emoji name}, the hub's (hub/slack.mjs prEmojis), asked only when a reaction is owed,
// so a quiet poll makes no Slack call for them. While Slack isn't ready → waiting and nothing owed.
export async function reviewDue(site, options) {
  needSite(site);
  const waiting = await readiness.waiting('slack');
  if (waiting) return { waiting, links: [], reactions: [], edits: [], headers: [], digest: null };
  const cfg = await boardConfig(site);
  const cache = await readJSON(githubStateFile(), {});
  const record = await readPRSlack(site);
  const links = [];
  // Each PR's first card with its ticket, and the reviewers of every card holding it.
  const cards = new Map();
  const githubOf = new Map();
  for (const source of await itemSources(site)) {
    const itemFile = await readJSON(source.file, {});
    const people = reviewersOf(itemFile, cfg.reviewers);
    for (const r of people) githubOf.set(r.name, r.github);
    for (const item of itemFile.items || []) {
      const ticket = ticketOfCard(cfg, item, boardRepoOf(site, itemFile));
      for (const p of cardPRs(item, boardRepoOf(site, itemFile))) {
        const pr = prKeyOf(p);
        if (!cards.has(pr)) cards.set(pr, { item, ticket, people: [] });
        const card = cards.get(pr);
        card.people.push(...people.filter((r) => !card.people.some((q) => q.name === r.name)));
        if (item.lane === 'done') continue;
        const gh = routeRecord(cache.prs, pr);
        for (const r of people) {
          if (!linkOwed(gh, record, pr, r.name) || links.some((l) => l.pr === pr && l.reviewer === r.name)) continue;
          links.push({ pr, key: `${source.slug}/${item.id}`, reviewer: r.name, slack_user: r.slack_user, ...prLink(pr, gh, item, { ticket }) });
        }
      }
    }
  }
  const reactions = [];
  const edits = [];
  for (const [pr, rec] of Object.entries(record)) {
    const gh = routeRecord(cache.prs, pr);
    const card = cards.get(pr);
    if (!gh || !card) continue;
    const follow = (name, message, reply) => {
      if (!message.ts || !card.people.some((r) => r.name === name)) return;
      const at = { pr, reviewer: name, ...(reply === undefined ? {} : { reply }), channel: message.channel || rec.links[name].channel, ts: message.ts };
      const kind = prKind(gh, githubOf.get(name));
      const added = reactionsOf(message);
      for (const r of added.filter((r) => r.kind !== kind)) reactions.push({ ...at, kind: r.kind, emoji: r.name, remove: true });
      if (kind && !added.some((r) => r.kind === kind)) reactions.push({ ...at, kind });
      if (!message.state) return;
      // A digest reply showed the link's age on the day it went.
      const age = reply === undefined ? 0 : (Number(message.ts) - Number(rec.links[name]?.ts)) / 86400;
      edits.push({ ...at, ...prLink(pr, gh, card.item, { ticket: card.ticket, old: age > 2 ? Math.floor(age) : null }) });
    };
    for (const [name, link] of Object.entries(rec.links)) follow(name, link);
    rec.replies.forEach((reply, at) => { for (const [name, sent] of Object.entries(reply.to)) follow(name, sent, at); });
  }
  const adds = reactions.filter((r) => !r.remove);
  const emojis = adds.length && options?.emojis ? await options.emojis() : {};
  for (const r of adds) r.emoji = emojis[r.kind];
  // headers: each posted digest header whose count of PRs now waiting on that reviewer (review digest's items) differs from the count it shows,
  // with the header's text at the new count. A header an earlier build put in a reply carries that reply's lead and tail.
  const digest = await reviewDigest(site, options);
  const headers = [];
  for (const d of (await readJSON(digestFile(site), {})).digests || []) {
    const ts = d.live && (d.live.reply === undefined ? d.ts : d.replies?.[d.live.reply]?.ts);
    if (!ts) continue;
    const n = digest.reviewers.find((r) => r.name === d.reviewer)?.items.length ?? 0;
    if (n !== d.live.shown) headers.push({ date: d.date, reviewer: d.reviewer, channel: d.channel, ts, n, text: `${d.live.lead ?? ''}${digestHeader(cfg.title, n)}${d.live.tail ?? ''}` });
  }
  return { date: slackDay(options?.now).date, links, reactions, edits, headers, digest: digest.due ? digest : null };
}
// due: one of review due's headers, once Slack has its edit.
export const recordHeader = (site, due) => editJSON(digestFile(site), (all) => { dayEntry(due.date, due.reviewer)(all).live.shown = due.n; });

const digestFile = (site) => path.join(needSite(site), 'data', 'review-digests.json');

// `review digest`: each reviewer's PRs the hub last read open, out of draft and not approved (failing checks included), one item per PR
// with its digest reply's message, the PR's bar (prLink) with its age for a link over two days old.
// data/review-digests.json {digests: [{date, reviewer, channel, ts, heard?, replies?: [{pr, text, attachments, ts}]}]} holds
// each reviewer's thread for each day, posted as postOnce posts: ts is its opener, the digest's header or the header
// line an earlier build posted, and replies are the digest's. heard is the newest message in the thread the hub has
// read (docs/adr/2026-11-12-0000-reviewers-ask-the-board-in-the-day-thread.md). The day's digest opens each reviewer's
// day thread (docs/adr/2026-11-14-0449-one-digest-opens-each-day-thread.md): it is owed from quiet hours' end on a weekday
// in the Slack timezone (hub/slack.mjs slackDay), however late the hub gets to it that day, and any day a link is owed to a reviewer whose thread is
// not open yet (linked); until every message of it is posted.
export async function reviewDigest(site, { now = new Date() } = {}) {
  needSite(site);
  const cfg = await boardConfig(site);
  const cache = await readJSON(githubStateFile(), {});
  const record = await readPRSlack(site);
  const topics = topicItems();
  const reviewers = new Map();
  for (const source of await itemSources(site)) {
    const itemFile = await readJSON(source.file, {});
    const people = reviewersOf(itemFile, cfg.reviewers);
    for (const r of people) if (!reviewers.has(r.name)) reviewers.set(r.name, { name: r.name, slack_user: r.slack_user, dm: r.dm, items: [] });
    for (const item of itemFile.items || []) {
      if (item.lane === 'done') continue;
      const key = `${source.slug}/${item.id}`;
      const legacy = reviewLinks(itemFile, item, key, topics);
      const prs = cardPRs(item, boardRepoOf(site, itemFile));
      // When the card went into review, as the In review lane sorts it (domain.mjs reviewSince): its first link sent to any reviewer.
      const sentAt = [...prs.flatMap((p) => Object.values(record[prKeyOf(p)]?.links || {})), ...Object.values(legacy)].map((l) => reviewTime(l.ts)).filter(Boolean).sort()[0];
      const since = item.review_since || sentAt || item.merge_ready?.at || item.pushed?.at || item.created || '';
      for (const p of prs) {
        const pr = prKeyOf(p);
        const gh = routeRecord(cache.prs, pr);
        for (const r of people) if (linkOwed(gh, record, pr, r.name)) reviewers.get(r.name).linked = true;
        if (gh?.state !== 'OPEN' || gh.isDraft) continue;
        for (const r of people) {
          if (!waitsOn(gh, r.github)) continue;
          const ts = record[pr]?.links?.[r.name]?.ts || routeRecord(legacy, r.name)?.ts || null;
          const age = ts ? (now.getTime() - Number(ts) * 1000) / 86400000 : null;
          const old = age > 2 ? Math.floor(age) : null;
          reviewers.get(r.name).items.push({ since, key, pr, title: item.title, url: prURL(p), sent_ts: ts, ...(old ? { days_old: old } : {}),
            message: prLink(pr, gh, item, { ticket: ticketOfCard(cfg, item, boardRepoOf(site, itemFile)), old }) });
        }
      }
    }
  }
  const { date, open } = slackDay(now);
  const today = ((await readJSON(digestFile(site), {})).digests || []).filter((d) => d.date === date);
  const waiting = await readiness.waiting('slack');
  for (const sent of today) if (!reviewers.has(sent.reviewer)) reviewers.set(sent.reviewer, { name: sent.reviewer, items: [] });
  for (const r of reviewers.values()) {
    r.items.sort((a, b) => (a.since ? 0 : 1) - (b.since ? 0 : 1) || a.since.localeCompare(b.since));
    for (const item of r.items) delete item.since;
  }
  const list = [...reviewers.values()].map((r) => {
    const sent = today.find((d) => d.reviewer === r.name);
    const owed = sent?.replies ? !sent.posting_at && (!sent.ts || sent.replies.some((reply) => !held(reply)))
      : !sent?.posting_at && ((open && r.items.length > 0) || (!sent?.ts && Boolean(r.linked)));
    return { ...r, owed, ...(sent ? { sent } : {}) };
  }).filter((r) => r.items.length || r.sent || r.owed);
  return { date, due: !waiting && list.some((r) => r.owed), ...(waiting ? { waiting } : {}), reviewers: list };
}

// The digest's top lines: “<board title> Digest”, then its count of PRs pending review.
const digestHeader = (title, n) => `${title} Digest\n${n ? `${n} PR${n === 1 ? '' : 's'} pending review` : 'All reviewed'}`;

const dayEntry = (date, name) => (all) => (all.digests || []).find((d) => d.date === date && d.reviewer === name);
// The hub hears a day thread for HEARD_DAYS days, the day it opens included.
const HEARD_DAYS = 7;
const heardOn = (thread, date) => (Date.parse(date) - Date.parse(thread.date)) / 86400000 < HEARD_DAYS;
// The reviewer's entry for date, added when there is none; the file keeps the entries of the days still heard.
function addDayEntry(all, date, name, fields) {
  if (dayEntry(date, name)(all)) return;
  all.digests = [...(all.digests || []).filter((d) => heardOn(d, date)), { date, reviewer: name, ...fields }];
  delete all.last_date;
}

// docs/adr/2026-11-12-0000-reviewers-ask-the-board-in-the-day-thread.md
// The day threads the hub still hears on now's Slack day: those opened in the last HEARD_DAYS days.
// → [{date, reviewer, channel, ts, heard?}]
export async function heardThreads(site, now = new Date()) {
  const { date } = slackDay(now);
  return ((await readJSON(digestFile(site), {})).digests || []).filter((d) => d.ts && heardOn(d, date));
}
// Records ts as the newest message the hub has read in thread.
export const markHeard = (site, thread, ts) => editJSON(digestFile(site), (all) => { dayEntry(thread.date, thread.reviewer)(all).heard = ts; });
// The ts of every message the board posted to Slack: links, their replies, day-thread openers and digest replies.
export async function boardPosts(site) {
  const out = new Set();
  for (const rec of Object.values(await readPRSlack(site))) {
    for (const link of Object.values(rec.links || {})) out.add(link.ts);
    for (const reply of rec.replies || []) for (const sent of Object.values(reply.to)) out.add(sent.ts);
  }
  for (const d of (await readJSON(digestFile(site), {})).digests || []) for (const m of [d, ...(d.replies || [])]) out.add(m.ts);
  const posted = await readJSON(slackThreadsFile(site), {});
  for (const m of [...Object.values(posted.replies || {}), ...Object.values(posted.ends || {})]) out.add(m.ts);
  out.delete(undefined);
  return out;
}
// docs/adr/2026-11-15-1530-later-replies-in-a-slack-filed-tasks-thread-land-on-the-task.md
// data/slack-threads.json {threads: {"<channel>:<thread_ts>": ts}}: the newest reply the hub has read in each Slack
// thread a task was filed from.
const slackThreadsFile = (site) => path.join(site, 'data', 'slack-threads.json');
const slackThreadId = (t) => `${t.channel}:${t.thread_ts}`;
// The Slack threads this board's tasks follow: each ask routed from a Slack @kickflip whose card is not Done, as
// {key, channel, thread_ts, ts, by, link, heard, failing}: routed.slack, the @kickflip's sender and permalink, heard, the
// newest reply read, else the @kickflip's ts, since the replies up to it were its words, and failing, whether the last
// read of the thread failed and the card says so.
export async function followedSlackThreads(site) {
  const asks = (await readLog(path.join(site, 'data', 'events.jsonl'))).filter((e) => e.kind === 'ask' && e.data?.routed?.via === 'slack' && e.data.routed.slack);
  if (!asks.length) return [];
  const { threads: heard = {}, follows = {} } = await readJSON(slackThreadsFile(site), {});
  const out = [];
  for (const e of asks) {
    const card = await askCardOf(site, e.id);
    if (!card || card.item.lane === 'done') continue;
    const { slack, by, link } = e.data.routed;
    out.push({ key: card.key, ...slack, by, link, heard: heard[slackThreadId(slack)] || slack.ts, failing: Boolean(follows[slackThreadId(slack)]) });
  }
  return out;
}
// Records ts as the newest reply the hub has read in thread, one of followedSlackThreads.
export const markSlackThreadHeard = (site, thread, ts) => editJSON(slackThreadsFile(site), (all) => { all.threads = { ...all.threads, [slackThreadId(thread)]: ts }; });
// docs/adr/2026-11-16-1700-replies-to-a-slack-message-post-into-its-slack-thread.md
// Records whether the last read of thread, one of followedSlackThreads, failed, so the card says so once per failing run.
export const markSlackFollow = (site, thread, failing) => editJSON(slackThreadsFile(site), (all) => {
  const { [slackThreadId(thread)]: _, ...rest } = all.follows || {};
  all.follows = failing ? { ...rest, [slackThreadId(thread)]: true } : rest;
});
// slack-threads.json's replies {"<reply file name>": {key, ts?, failed?}}, in the order written: each reply to post, with
// the ts Slack gave it once posted and failed once a post failed and the card's fault line was written; and ends
// {"<channel>:<thread_ts>": {ts?, failed?}}: each thread seen while its task was open, so its end line posts once.
export const queueSlackReply = (site, key, name) => editJSON(slackThreadsFile(site), (all) => { all.replies = { ...all.replies, [name]: { key } }; });
// What the hub posts to each Slack-filed task's thread: [{key, channel, thread_ts, replies: [{name, text, failed?}],
// end: {text, failed?} | null}], its replies not yet posted, then, once the task is Done, its end line, "Closed: <title>"
// or "Built and landed: <title>". Records each thread whose task is open, so a task Done before its thread was first read
// posts no end line.
export async function slackOutbox(site) {
  const asks = (await readLog(path.join(site, 'data', 'events.jsonl'))).filter((e) => e.kind === 'ask' && e.data?.routed?.via === 'slack' && e.data.routed.slack);
  if (!asks.length) return [];
  const { replies = {}, ends = {} } = await readJSON(slackThreadsFile(site), {});
  const out = [];
  const opened = [];
  for (const e of asks) {
    const card = await askCardOf(site, e.id);
    if (!card) continue;
    const { channel, thread_ts } = e.data.routed.slack;
    const id = slackThreadId({ channel, thread_ts });
    const done = card.item.lane === 'done';
    if (!done && !ends[id]) opened.push(id);
    const owed = await Promise.all(Object.entries(replies).filter(([, r]) => r.key === card.key && !r.ts)
      .map(async ([name, r]) => ({ name, text: await fs.readFile(path.join(site, 'data', 'replies', `${name}.md`), 'utf8'), ...(r.failed ? { failed: true } : {}) })));
    const end = done && ends[id] && !ends[id].ts ? { text: `${card.item.phase === 'merged' ? 'Built and landed' : 'Closed'}: ${card.item.title}`, ...(ends[id].failed ? { failed: true } : {}) } : null;
    if (owed.length || end) out.push({ key: card.key, channel, thread_ts, replies: owed, end });
  }
  if (opened.length) await editJSON(slackThreadsFile(site), (all) => { all.ends = { ...all.ends, ...Object.fromEntries(opened.map((id) => [id, {}])) }; });
  return out;
}
// Records a post of slackOutbox's: thread's end line when reply is null, else reply, a reply's name; ts, the ts Slack
// gave it, or failed, after its first failed post.
export const markSlackPost = (site, thread, reply, { ts, failed }) => editJSON(slackThreadsFile(site), (all) => {
  const [field, id] = reply ? ['replies', reply] : ['ends', slackThreadId(thread)];
  all[field] = { ...all[field], [id]: { ...all[field]?.[id], ...(ts ? { ts } : { failed }) } };
});
// What the orchestrator posts in a day thread: its words, at most WORDS_LIMIT characters; the Slack client signs them off.
const WORDS_LIMIT = 250;
function orchestratorWords(words) {
  const body = text(words, '--text');
  if (body.length > WORDS_LIMIT) fail(`--text runs to ${body.length} characters, past the orchestrator's ${WORDS_LIMIT}: keep it brief`);
  return body;
}

// A slack-question event's data: {reviewer, channel, thread_ts, ts, from: reviewer|owner, answer}.
async function slackQuestion(site, eventId) {
  domId(eventId, 'the event id');
  const e = (await readLog(path.join(needSite(site), 'data', 'events.jsonl'))).find((x) => x.id === eventId && x.kind === 'slack-question');
  return e?.data || fail(`no slack-question "${eventId}" in this site's data/events.jsonl`);
}
// docs/adr/2026-11-15-1200-an-event-with-no-task-waits-on-the-orchestrator-until-acted-on.md: a slack-handled {id, by}
// event, record-only, ends the orchestrator's wait on slack-question id (domain.mjs eventWaits); by is the command.
const slackHandled = (site, id, by) => appendEvent(boardTarget(site), 'slack-handled', { id, by });
const throughSlack = (slack) => slack || fail(SLACK_NEEDS_TOKEN);
const slackCall = (call) => call.catch((e) => (e instanceof SlackError ? fail(e.message) : Promise.reject(e)));

// `slack thread`: the event's day thread, read from Slack, one message a line and continued lines indented, then each
// attachment's fallback, such as a PR link's bar, indented too; each named board (the board's posts and answers), you
// (the owner) or the reviewer; → marks the event's message.
export async function slackThread(site, eventId, slack = savedSlack()) {
  const q = await slackQuestion(site, eventId);
  const ours = await boardPosts(site);
  const owner = slackUserId();
  const messages = await slackCall(throughSlack(slack).replies({ channel: q.channel, ts: q.thread_ts }));
  const lines = messages.flatMap((m) => {
    const who = ours.has(m.ts) || (m.user === owner && isSignedOff(m.text, m.attachments)) ? 'board' : m.user === owner ? 'you' : q.reviewer;
    const [first = '', ...rest] = [...(m.text ? m.text.split('\n') : []), ...(m.attachments || []).map((a) => a.fallback)];
    return [`${m.ts === q.ts ? '→ ' : ''}${who}: ${first}`, ...rest.map((l) => `    ${l}`)];
  });
  // A message that expects no reply is acted on once read.
  if (!q.answer) await slackHandled(site, eventId, 'thread');
  return { lines };
}

// `slack skip`: a slack-question that needs no answer, such as a thanks, recorded handled with nothing posted.
export async function slackSkip(site, eventId) {
  const q = await slackQuestion(site, eventId);
  await slackHandled(site, eventId, 'skip');
  return { lines: [`no reply to ${q.reviewer}'s day thread`] };
}

// `slack answer`: the answer, signed off, posted as a reply in the event's day thread. Refuses an owner's message that
// names no @kickflip, which expects no reply, and words past WORDS_LIMIT.
export async function slackAnswer(site, eventId, words, slack = savedSlack()) {
  const q = await slackQuestion(site, eventId);
  if (!q.answer) fail("that message is the owner's and names no @kickflip, so it expects no reply");
  const message = orchestratorWords(words);
  await slackCall(throughSlack(slack).post({ channel: q.channel, thread_ts: q.thread_ts, text: message }));
  await slackHandled(site, eventId, 'answer');
  return { lines: [`answered in ${q.reviewer}'s day thread`] };
}

// `slack say`: the words, signed off, posted in the reviewer's day thread for now's Slack day, opened with the day's
// digest when none is open, as the hub opens one. The owner's explicit ask is its only use
// (SKILL.md); a message in a thread is answered with slack answer. Refuses words past WORDS_LIMIT.
export async function slackSay(site, name, words, { now = new Date() } = {}, slack = savedSlack()) {
  needSite(site);
  const message = orchestratorWords(words);
  const reviewer = await reviewerNamed(site, name);
  const client = throughSlack(slack);
  const thread = await openDayThread(site, client, reviewer, now);
  await slackCall(client.post({ channel: thread.channel, thread_ts: thread.ts, text: message }));
  return { lines: [`said in ${reviewer.name}'s day thread`] };
}

// The board's reviewer called name or whose Slack user is name, a leading @ ignored.
async function reviewerNamed(site, name) {
  const cfg = await boardConfig(site);
  const reviewers = new Map();
  for (const source of await itemSources(site)) for (const r of reviewersOf(await readJSON(source.file, {}), cfg.reviewers)) reviewers.set(r.name, r);
  const wanted = String(name).replace(/^@/, '');
  return [...reviewers.values()].find((r) => sameName(r.name, wanted) || r.slack_user === wanted)
    || fail(`no reviewer "${name}" on this board; its reviewers are ${[...reviewers.keys()].join(', ') || 'none'}`);
}

// The reviewer's day thread for now's Slack day, opened with the day's digest when none is open, as the hub opens one.
// → {channel, ts}
async function openDayThread(site, client, reviewer, now) {
  const { date } = slackDay(now);
  const open = dayEntry(date, reviewer.name)(await readJSON(digestFile(site), {}));
  return open?.ts ? open : slackCall(postDigest(site, date, (await reviewDigest(site, { now })).reviewers.find((r) => r.name === reviewer.name) || { ...reviewer, items: [] }, {
    channel: open?.channel || await slackCall(client.openDM(reviewer.slack_user)),
    post: (m) => client.post(m),
  }));
}

// `slack link`: a PR's link, the one PR message format (prLink), sent through the hub's Slack in the reviewer's day
// thread as review due sends the board's own, and recorded so the PR's reactions follow it and the board sends no
// second. pr: owner/repo#n, a PR URL or a number in the board's repo. The size is from GitHub (readPR), the risk from
// the card holding the PR, none without one.
export async function slackLink(site, pr, to, { now = new Date(), readPR = prSize } = {}, slack = savedSlack()) {
  needSite(site);
  const ref = parsePRRef(String(pr).replace(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/, '$1#$2')) || fail(`"${pr}" is no PR: give owner/repo#n, a PR URL or a number in the board's repo`);
  const repo = ref.repo || boardRepoOf(site, {}) || fail(`"${pr}" names no repo and this board has none: give owner/repo#n`);
  const key = prKeyOf({ repo, number: ref.number });
  const reviewer = await reviewerNamed(site, to);
  const client = throughSlack(slack);
  const cfg = await boardConfig(site);
  let card = {};
  let ticket = null;
  for (const source of await itemSources(site)) {
    const itemFile = await readJSON(source.file, {});
    const found = (itemFile.items || []).find((i) => cardPRs(i, boardRepoOf(site, itemFile)).some((p) => prKeyOf(p) === key));
    if (found) { card = found; ticket = ticketOfCard(cfg, found, boardRepoOf(site, itemFile)); }
  }
  let size;
  try { size = await readPR({ repo, pr: ref.number, login: settingsOf(cfg).github_login }); } catch (e) { fail(e.message); }
  const message = prLink(key, size, card, { ticket });
  const thread = await openDayThread(site, client, reviewer, now);
  await slackCall(postLink(site, { pr: key, reviewer: reviewer.name }, thread, () => client.post({ channel: thread.channel, thread_ts: thread.ts, ...message })));
  return { lines: [`sent ${key} to ${reviewer.name}'s day thread`] };
}

// `slack task`: a request for work in a day thread, filed as a new card in item file `file`, discussing, for the owner
// to review (docs/adr/2026-11-12-0500-a-new-task-is-a-conversation.md); never ready, so never a Quick build. The Slack
// message, read whole, is the card's first thread line, under its writer's name and linking to it when the Slack
// identity has the workspace's domain.
export async function slackTask(site, eventId, file, { title, notes, notesFrom }, slack = savedSlack()) {
  const q = await slackQuestion(site, eventId);
  const messages = await slackCall(throughSlack(slack).replies({ channel: q.channel, ts: q.thread_ts }));
  const message = messages.find((m) => m.ts === q.ts) || fail('that Slack message is gone from its thread');
  const filed = await addItem(site, file, { title, notes, notesFrom, phase: 'discussing', intake: true });
  const domain = readSlack().slack_domain;
  const link = domain ? `https://${domain}.slack.com/archives/${q.channel}/p${q.ts.replace('.', '')}?thread_ts=${q.thread_ts}&cid=${q.channel}` : undefined;
  await appendMessage(site, filed.key, { text: message.text, who: q.from === 'owner' ? 'love' : q.reviewer, via: 'slack', link });
  await slackHandled(site, eventId, 'task');
  return { ...filed, lines: [`filed ${filed.key} discussing, for the owner's review`] };
}

// The reviewer's day thread for date, {channel, ts}, or null until its opener is posted.
export async function dayThread(site, date, name) {
  const opened = dayEntry(date, name)(await readJSON(digestFile(site), {}));
  return opened?.ts ? { channel: opened.channel, ts: opened.ts } : null;
}

// Posts a reviewer's owed digest for date, one of review digest's reviewers. Opening the day's thread, it is the
// header, then one reply per PR, each the PR's bar (prLink) and nothing mentions the reviewer; a thread an earlier
// build opened gets the replies alone. A digest already begun keeps the PRs it began with. The entry's live holds the
// header's PRs and the count it shows, which review due finds to edit. post({channel, text, thread_ts?}) → ts.
// → the day thread, {channel, ts}
export async function postDigest(site, date, reviewer, { channel, post }) {
  const file = digestFile(site);
  const entry = dayEntry(date, reviewer.name);
  const { title } = await boardConfig(site);
  const header = (n) => digestHeader(title, n);
  await editJSON(file, (all) => {
    addDayEntry(all, date, reviewer.name, { channel });
    const opened = entry(all);
    if (opened.replies) return;
    opened.replies = reviewer.items.map((i) => ({ pr: i.pr, ...i.message }));
    // A thread an earlier build opened has a header line that isn't the digest's, so it has no count to edit.
    if (!opened.ts) opened.live = { shown: reviewer.items.length };
  });
  const sent = entry(await readJSON(file, {}));
  const top = sent.ts || await postOnce(file, entry, () => post({ channel: sent.channel, text: header(sent.live.shown) }));
  for (const [i, reply] of sent.replies.entries()) {
    if (!held(reply)) await postOnce(file, (all) => entry(all).replies[i], () => post({ channel: sent.channel, thread_ts: top, text: reply.text, attachments: reply.attachments }));
  }
  // A one-PR reply is a message about that PR, so it joins the PR's posted replies and gets its reactions (the digest
  // file keeps only the days still heard); a reply naming several PRs gets none.
  const posted = entry(await readJSON(file, {})).replies.filter((r) => r.pr && r.ts);
  if (posted.length) await editJSON(prSlackFile(site), (all) => {
    const id = `digest-${date}`;
    for (const reply of posted) {
      const rec = all[reply.pr] ||= { links: {}, replies: [] };
      const bump = rec.replies.find((r) => r.id === id) || rec.replies[rec.replies.push({ id, text: reply.text, to: {} }) - 1];
      bump.to[reviewer.name] ||= { channel: sent.channel, ts: reply.ts, reactions: [] };
    }
  });
  return { channel: sent.channel, ts: top };
}
