// The board's domain: turns a snapshot of plain data (wave files, builder
// records, PR state, threads, page events, owner questions) into the work
// items, lanes and owner questions every page shows. Pure: callers read the
// files and GitHub, and the pages render what this returns without
// re-deriving state.
//
// A work item's lane, what it waits on and its builder line are decided here
// and nowhere else. A builder record is ~/.claude/waves/<wave>/agents/<id>.json for agent main, or
// agents/<id>@<agent>.json ({label, kind, started, eta, done}), written only by `bin/board.mjs builder`. Progress is not a record field:
// it is the item's status lines in its thread.
// A record with done is a finished agent: it stays for the thread's timeline and no longer counts as building.

import { routeRecord } from '../hub/routes.mjs';
import fs from 'node:fs';
import { ticketBadge } from './tickets.mjs';
import { reviewLinks, reviewTime, reviewersOf } from './review.mjs';
import { remoteFromInput } from '../hub/repos.mjs';
import vm from 'node:vm';

// A page script with no exports, which the page loads as is, so node runs it the same way.
const enums = vm.createContext({});
vm.runInContext(fs.readFileSync(new URL('./public/ui-enums.js', import.meta.url), 'utf8'), enums);
export const { BUTTON, ACTION_KIND, BUILDER_KIND } = enums.BoardUI;

export const ITEM_EVENTS = ['item-message', 'mark-ready', 'grill-more', 'build-followup', 'prototype-request'];
export const ITEM_STATUSES = ['planned', 'waiting', 'building', 'fixing', 'checking', 'held', 'merged', 'done', 'dropped'];
export const BUILDER_STALLED_AFTER = 30 * 60000;
const LANE_ORDER = { review: 0, stale: 1, progress: 2, todo: 3, done: 4 };
const DAY = 86400000;
// Done cards older than this fold under one row (docs/adr/0012-lists-never-cut-silently.md).
const DONE_OPEN = 7 * DAY;
export const OLDER_FOLD = 'older';
// A finished wave's Done cards fold under a row of their own, which board/public/app-lanes.js reads back by this id.
export const waveFold = (slug) => `wave:${slug}`;
// Answered asks fold under one row of their own, like a finished wave (docs/adr/0012-lists-never-cut-silently.md), read back by board/public/app-lanes.js.
export const ASKS_FOLD = 'asks';
// A PR in review longer than this parks in the Stale lane (docs/adr/0044-a-pr-in-review-shows-its-age-and-goes-stale-after-seven-days.md).
const STALE_AFTER = 7 * DAY;

// board/public/ui-links.js links Linear ids in text from these urls, so a board with no workspace links none.
const linearRef = (id, tickets) => ({ id, url: tickets?.workspace ? `https://linear.app/${tickets.workspace}/issue/${id}` : null });
// Internal items keep their stored ids, which key threads, builder records and events; S<n> reads <prefix>-<n>, INT
// without an internal ticket source. Other ids read as stored, so a changed prefix never relabels them.
const internalRef = (id, prefix) => String(id).replace(/^S(\d+)$/, `${prefix || 'INT'}-$1`);
export const refOf = (wave, id, tickets) => (wave.internal === true ? internalRef(id, tickets?.prefix) : id);
// A board without a source reads stored tickets as Internal · INT. A stored ticket from another source keeps its own
// id, unlinked (docs/adr/0081-a-board-has-one-ticket-source.md).
const ticketOf = (tickets, stored, id, at) => ticketBadge(tickets || (stored ? { source: 'internal', prefix: 'INT' } : null), id, at)
  || (stored ? { id: String(stored), url: null, source: null } : null);

// The lane before owner waits are placed: In Progress while Claude acts next, In Review while the reviewers do, or
// while a pushed branch waits on the owner's merge (docs/adr/0127-a-board-can-work-on-any-git-remote.md).
// buildBoard places a card that only the owner can move on (docs/adr/0045-the-lane-follows-who-acts-next.md).
function laneOf(item, pr, running, pushed) {
  const s = (item.status || '').toLowerCase();
  if (s === 'merged' || s === 'done' || s === 'dropped' || pr?.state === 'MERGED' || pr?.state === 'CLOSED') return 'done';
  if (running || s === 'checking') return 'progress';
  if (pushed) return 'review';
  if (pr && pr.state === 'OPEN' && !pr.isDraft) return pr.checks?.state === 'fail' ? 'progress' : 'review';
  return pr ? 'progress' : 'todo';
}

const droppedCard = (i) => {
  const s = (i.status || '').toLowerCase();
  return s === 'dropped' || (i.pr?.state === 'CLOSED' && s !== 'merged' && s !== 'done');
};

// A wave is finished once it has work items and every work item and follow-up is in Done
// (docs/adr/0012-lists-never-cut-silently.md). merged counts the wave's Done cards that weren't dropped.
function finishedOf(cards) {
  if (!cards.some((i) => i.kind === 'work') || cards.some((i) => i.lane !== 'done')) return null;
  const done = cards.filter((i) => i.lane === 'done');
  const dropped = done.filter(droppedCard).length;
  return { merged: done.length - dropped, dropped };
}

// Each reviewer's state, and since when the link has waited on them.
function reviewOf(reviewers, pr, sentAt) {
  return Object.fromEntries(reviewers.map((r) => {
    const verdict = routeRecord(pr?.reviews, r.github);
    const state = verdict === 'APPROVED' ? 'approved' : verdict === 'CHANGES_REQUESTED' ? 'changes' : Object.hasOwn(sentAt, r.name) ? 'sent' : 'unsent';
    return [r.name, { state, since: state === 'sent' ? routeRecord(sentAt, r.name) : null, github: r.github || null }];
  }));
}

// What the card waits on: the owning session's check of finished work, the owner's Ready on GitHub, the builder, the
// owner's merge of a pushed branch, the reviewers, the merge once GitHub counts it approved, or nothing. buildBoard sets
// `owner` for the owner's other waits.
function waitsOnOf(lane, pr, builder, status, pushed) {
  if (builder?.kind === BUILDER_KIND.install) return 'builder';
  if (status === 'checking') return 'checking';
  if (builder) return 'builder';
  if (pushed && lane === 'review') return 'owner';
  if (lane === 'progress' && pr?.state === 'OPEN' && pr.isDraft && pr.checks?.state === 'pass') return 'ready';
  if (lane === 'review' || lane === 'stale') return pr?.reviewDecision === 'APPROVED' ? 'merge' : 'reviewers';
  return null;
}

// A done card has no next step, whatever its wave file's `next` still says.
// A card whose PR is ready for review reads its next step from GitHub, never from the wave file's `next`, and a card
// waiting on the owner reads its action. While its PR is changing, the builder line takes the place of a next step.
const PROTOTYPE_URL = /(^|\/)prototype-[\w-]+\.html/;
const REVIEW_NEXT = { reviewers: 'Waiting for PR reviewers', merge: 'Approved, merges once CI and the merge state allow' };
// docs/adr/0052-auto-merge-is-a-board-setting-off-by-default.md
const OWNER_MERGE_NEXT = { waiting: 'Approved, Merge shows once CI and the merge state allow', ready: 'Approved and green: tap Merge', merging: 'Merging' };
const FIX_CI = 'Fix the failing CI';

function workItem({ slug, wave, it, order, pr, repo, remote, base, builder, agents, eta, thread, events, working, topicItems, boardReviewers, now, bumpedAt, holdAsk, closedAt, mergeAt, buildAt, autoMerge, tickets }) {
  // docs/adr/0106-the-board-applies-the-owners-hold-resume-and-done-at-once.md
  if (closedAt && String(closedAt) > String(it.status_at || '')) it = { ...it, status: 'done' };
  const key = `${slug}/${it.id}`;
  const reviewers = reviewersOf(wave, boardReviewers);
  const sentAt = Object.fromEntries(Object.entries(reviewLinks(wave, it, key, topicItems)).map(([name, link]) => [name, reviewTime(link.ts)]));
  const inReviewSince = Object.values(sentAt).filter(Boolean).sort()[0] || null;
  const lastTs = [...thread.map((m) => m.ts), ...events.map((e) => e.ts)].sort().pop() || null;
  // A builder status line is progress, not a message: it is never unread and answers no owner message.
  const othersAt = [...thread.filter((m) => (m.who || 'claude') !== 'love' && m.kind !== 'status').map((m) => m.ts), ...events.map((e) => e.reply?.at)].filter(Boolean).sort();
  const lastGrill = events.filter((e) => e.kind === 'grill-more').pop();
  // A branch pushed to a plain git remote, which has no PR (docs/adr/0127-a-board-can-work-on-any-git-remote.md).
  const pushed = !it.pr && it.pushed?.branch ? { branch: it.pushed.branch, at: it.pushed.at || null, host: remote?.host || null } : null;
  let lane = laneOf(it, pr, Boolean(builder), pushed);
  if (lane === 'review' && inReviewSince && now - Date.parse(inReviewSince) > STALE_AFTER) lane = 'stale';
  const waitsOn = waitsOnOf(lane, pr, builder, (it.status || '').toLowerCase(), pushed);
  const changing = waitsOn === 'builder' && pr?.state === 'OPEN' && !pr.isDraft;
  const redReady = lane === 'progress' && !waitsOn && pr?.state === 'OPEN' && !pr.isDraft;
  const tapped = holdAsk && String(holdAsk.ts) > String(it.held_at || '');
  const held = tapped ? Boolean(holdAsk.data.hold) : it.status === 'held' || Boolean(it.held);
  // docs/adr/0118-a-card-can-be-held-until-a-time.md
  const heldUntil = held ? (tapped ? holdAsk.data.until : it.pick_up_at) || null : null;
  // docs/adr/0019-a-card-that-hasnt-started-can-be-bumped.md
  const bumpable = !held && (lane === 'todo' || (lane === 'progress' && waitsOn !== 'ready' && waitsOn !== 'checking'));
  // The owner's Merge waits on the session until it merges or writes in the thread, such as why it can't merge yet.
  const lastClaudeAt = thread.filter((m) => (m.who || 'claude') === 'claude' && m.kind !== 'status').map((m) => String(m.ts)).sort().pop() || '';
  const merging = waitsOn === 'merge' && Boolean(mergeAt) && String(mergeAt) > lastClaudeAt;
  // The owner's Build waits on the session until the card's status changes or Claude writes in the thread.
  const starting = Boolean(buildAt) && String(buildAt) > lastClaudeAt && String(buildAt) > String(it.status_at || '');
  const reviewNext = pushed && waitsOn === 'owner' ? `merge ${pushed.branch} into ${base}`
    : waitsOn === 'merge' && !autoMerge ? OWNER_MERGE_NEXT[merging ? 'merging' : 'waiting'] : REVIEW_NEXT[waitsOn];
  return {
    key, kind: 'work', order, wave: slug, waveTitle: wave.title || slug, id: it.id, ref: refOf(wave, it.id, tickets), title: it.title, status: it.status || null,
    created: it.created || null,
    internal: wave.internal === true, repo: wave.internal === true && !wave.repo ? null : repo,
    lane, waitsOn, builder: waitsOn === 'checking' ? null : builder, agents, eta, working,
    deps: it.deps || [], held, heldUntil, risky: Boolean(it.risky), bumpable, bumpedAt: bumpable ? bumpedAt || null : null,
    holdable: lane !== 'done', hasNotes: Boolean(it.plan || String(it.notes || '').trim()),
    finishable: lane !== 'done',
    merging, starting, manualSteps: it.manual_steps || [], fromAsk: it.from_ask || null, from: null, next: changing || lane === 'done' || waitsOn === 'checking' ? null : redReady ? FIX_CI : reviewNext || it.next || null,
    branch: it.branch || pr?.headRefName || pushed?.branch || null, pushed: lane === 'done' ? null : pushed,
    ticket: tickets?.source === 'linear' && !it.ticket && it.linear?.length ? null
      : ticketOf(tickets, it.ticket, it.ticket || (wave.internal ? refOf(wave, it.id, tickets) : it.linear?.[0]), { repo, key }),
    ticketSource: tickets?.source || null,
    linear: (it.linear || []).map((id) => tickets?.source === 'linear' ? ticketBadge(tickets, id, { key, repo }) || linearRef(id, tickets) : linearRef(id, tickets)),
    pr: it.pr && repo ? { number: it.pr, url: `https://github.com/${repo}/pull/${it.pr}`, ...(pr || {}) } : null,
    reviewers: reviewers.map((r) => r.name), review: reviewOf(reviewers, pr, sentAt), inReviewSince,
    threadCount: thread.length + events.length, lastTs, othersAt,
    grilling: Boolean(lastGrill && !lastGrill.reply),
    updatedAt: pr?.mergedAt || pr?.updatedAt || it.merged_at || builder?.at || lastTs || null, ask: null, fold: null, action: null,
    install: lane === 'done' ? null : installOf(it.install, pr),
  };
}

// docs/adr/0051-a-device-app-card-carries-an-install-link.md
// older: the PR's head has moved past the commit the build came from; unknown heads never read older.
function installOf(install, pr) {
  if (!install?.url) return null;
  const sha = install.sha ? String(install.sha).toLowerCase() : null;
  const head = pr?.headRefOid ? String(pr.headRefOid).toLowerCase() : null;
  return { url: install.url, label: install.label || null, builtAt: install.built_at || null, sha, older: Boolean(sha && head && !head.startsWith(sha)) };
}

// An approved PR that GitHub would merge now: CI green (or none) and the merge state CLEAN.
const mergeable = (pr) => pr?.state === 'OPEN' && !pr.isDraft && pr.reviewDecision === 'APPROVED' && ['pass', 'none'].includes(pr.checks?.state) && pr.mergeStateStatus === 'CLEAN';

// What the owner acts on next, or null: {kind, url, label}, url relative to the site root. kind is pick (a prototype
// question), questions, ready (a green draft's Ready on GitHub), done (an ask's Done in its thread), steps (manual
// steps on an approved PR, which the session never merges on its own) or merge (the open card's Merge, while the board's
// auto-merge is off). A held card waits on nobody.
function actionOf(it, questionById, autoMerge) {
  if (it.held || it.lane === 'done') return null;
  const thread = `#item=${encodeURIComponent(it.key)}`;
  if (asking(it)) {
    const q = questionById.get(it.questions.first);
    if (PROTOTYPE_URL.test(q?.url || '')) return { kind: ACTION_KIND.pick, url: `questions.html#${q.id}`, label: 'Prototypes ready: pick a take' };
    return { kind: ACTION_KIND.questions, url: `questions.html#${it.questions.first}`, label: `Answer ${plural(it.questions.open, 'question')}` };
  }
  if (it.waitsOn === 'ready') return { kind: ACTION_KIND.ready, url: it.pr.url, label: 'Tap Ready on GitHub' };
  if (it.kind === 'ask' && it.waitsOn === 'owner') return { kind: ACTION_KIND.done, url: thread, label: it.next || 'Tap Done once it is settled' };
  if (it.waitsOn === 'merge' && it.manualSteps.length) return { kind: ACTION_KIND.steps, url: thread, label: 'Run the manual steps, then merge' };
  // docs/adr/0052-auto-merge-is-a-board-setting-off-by-default.md
  if (it.waitsOn === 'merge' && !autoMerge && !it.merging && mergeable(it.pr)) return { kind: ACTION_KIND.merge, url: thread, label: 'Merge' };
  return null;
}

const asking = (it) => Boolean(it.questions && it.questions.state !== 'resolved' && it.questions.open > 0);
const ASKING = new Set([ACTION_KIND.pick, ACTION_KIND.questions]);

// The open card's one workflow button, which board/public/app-cards.js only labels: openQuestions while it has open
// questions, held or not, markDone for an ask waiting on the owner's Done, grill otherwise, and none on a Done card or
// on an ask with neither.
function actionButtonOf(it) {
  if (it.lane === 'done') return null;
  if (asking(it)) return BUTTON.openQuestions;
  if (it.action?.kind === ACTION_KIND.done) return BUTTON.markDone;
  return it.kind === 'ask' ? null : BUTTON.grill;
}

// docs/adr/0122-a-todo-card-that-nothing-blocks-has-build.md
// The open card's Build: on a work card still unstarted in Todo, not held, that no unfinished dep blocks and that waits
// on nothing from the owner.
const buildableOf = (it) => it.kind === 'work' && it.lane === 'todo' && !it.held && !it.blockedBy.length && !it.action;

// The open card's button that resolves each action kind, which the board page colours orange: an action button, the
// PR's Review on GitHub, or Merge.
const RESOLVED_BY = Object.freeze({
  [ACTION_KIND.pick]: BUTTON.openQuestions, [ACTION_KIND.questions]: BUTTON.openQuestions, [ACTION_KIND.ready]: BUTTON.github,
  [ACTION_KIND.steps]: BUTTON.github, [ACTION_KIND.merge]: BUTTON.merge, [ACTION_KIND.done]: BUTTON.markDone,
});

// docs/adr/0045-the-lane-follows-who-acts-next.md
// A card only the owner can move on goes to In Review, apart from a Todo card waiting on its questions, which stays in
// Todo (docs/adr/0059-an-unstarted-card-waits-on-its-questions-in-todo.md). One Claude still works on, or one already
// waiting on the reviewers, keeps its lane; either way it carries its action.
function placeOwnerWait(it, questionById, autoMerge) {
  it.action = actionOf(it, questionById, autoMerge);
  it.actionButton = actionButtonOf(it);
  it.resolvedBy = RESOLVED_BY[it.action?.kind] || null;
  if (it.action?.kind === ACTION_KIND.merge) it.next = OWNER_MERGE_NEXT.ready;
  const ownerOnly = it.lane === 'todo' || (it.lane === 'progress' && (it.waitsOn === 'ready' || it.waitsOn === 'owner'));
  if (!it.action || !ownerOnly) return;
  const lane = it.lane === 'todo' && ASKING.has(it.action.kind) ? 'todo' : 'review';
  Object.assign(it, { lane, waitsOn: it.waitsOn === 'ready' ? 'ready' : 'owner', next: it.action.label, bumpable: false, bumpedAt: null });
}

// docs/adr/0049-a-started-card-never-returns-to-todo.md
const started = (it) => it.agents.length > 0 || Boolean(it.questions && it.questions.answered + it.questions.replied + it.questions.resolved > 0);

// An open follow-up is a Todo card of its wave (docs/adr/0034-follow-ups-are-todo-cards-of-their-wave.md).
function followUp({ slug, wave, f, order, repo, bumpedAt, closedAt, tickets }) {
  const done = Boolean(f.done || closedAt);
  return {
    key: `${slug}/${f.id}`, kind: 'followup', order, wave: slug, waveTitle: wave.title || slug, id: f.id, ref: f.id, title: f.title, status: null,
    repo: wave.internal === true && !wave.repo ? null : repo, finishable: !done,
    lane: done ? 'done' : 'todo', waitsOn: null, builder: null, agents: [], eta: null, working: false, inReviewSince: null,
    deps: [], held: false, risky: false, bumpable: !done, bumpedAt: done ? null : bumpedAt || null, manualSteps: [], fromAsk: null, from: f.from || null, next: null, hasNotes: false, branch: null,
    ticket: ticketOf(tickets, f.ticket, f.ticket || f.id, { repo, key: `${slug}/${f.id}` }),
    linear: [linearRef(f.id, tickets)], pr: null, reviewers: [], review: {},
    threadCount: 0, lastTs: null, othersAt: [], grilling: false, created: f.filed || null, updatedAt: f.filed || null, ask: null, fold: null, action: null,
  };
}

// An ask is a New card at the top of Todo until Claude replies to it or writes in its thread; then it is a Done item with
// its thread (docs/adr/0047-the-plus-makes-a-new-card.md). An ask that became work or was folded into a card has no card
// of its own: buildBoard leaves it out. msgs is its thread; bumpedAt is its latest ask-bump.
// mark is Claude's latest data/ask-progress.json entry {state, at, next} and doneAt the owner's latest ask-done: the newer
// one decides whether the ask sits in In Progress with a Done button (docs/adr/0035-an-ask-can-wait-in-progress-until-the-owner-marks-it-done.md).
// A mark with moved is an ask sent to another board on the owner's answer, so it never shows as an answer.
// pending counts its questions (topic item:ask:<event id>) that are open or answered and waiting on Claude: an answered
// ask with either stays out of Done until a mark or the owner's Done closes it
// (docs/adr/0059-an-unstarted-card-waits-on-its-questions-in-todo.md).
function askItem(e, msgs, bumpedAt, linked, mark, doneAt, pending) {
  const msg = msgs.find((m) => m.kind === 'ask' && m.eventId === e.id);
  const files = e.data?.files || [];
  const title = (msg.text || '').trim().split('\n')[0] || files.map((f) => f.name).join(', ') || 'Ask';
  const answered = msg.state === 'replied' || msg.state === 'answered';
  const inProgress = mark?.state === 'progress' && !(String(doneAt || '') > String(mark.at || ''));
  const closed = !inProgress && (Boolean(mark) || Boolean(doneAt));
  const asked = answered && !closed && !inProgress && pending.open > 0;
  const onClaude = answered && !closed && !inProgress && !asked && pending.answered > 0;
  const done = closed || (answered && !inProgress && !asked && !onClaude);
  const answerAt = answered && !linked && !mark?.moved
    ?[...msgs.filter((m) => m.who === 'claude' && m.kind !== 'ask-link' && m.kind !== 'status').map((m) => m.ts), ...msgs.map((m) => m.reply?.at)].filter(Boolean).sort().pop() || null
    : null;
  const handled = done || inProgress || asked || onClaude;
  // An owner message Claude hasn't answered puts the next step back with Claude.
  const ownerPending = msgs.some((m) => m.who === 'love' && m.kind !== 'ask' && (m.state === 'waiting' || m.state === 'working'));
  const state = handled ? 'answered' : msg.state;
  const bumped = handled ? null : bumpedAt || null;
  const othersAt = [...msgs.filter((m) => m.who !== 'love' && m.kind !== 'ask-link').map((m) => m.ts), ...msgs.map((m) => m.reply?.at)].filter(Boolean).sort();
  const lastTs = [...msgs.map((m) => m.ts), ...othersAt, ...(inProgress ? [mark.at] : [])].filter(Boolean).sort().pop();
  return {
    key: `ask:${e.id}`, kind: 'ask', order: 0, wave: null, waveTitle: null, id: e.id, ref: handled ? 'Task' : 'New', isNew: !handled, title, status: null,
    internal: false, repo: null, lane: inProgress || onClaude ? 'progress' : done ? 'done' : 'todo', waitsOn: inProgress && !ownerPending ? 'owner' : null, builder: null, agents: [], eta: null, working: msgs.some((m) => m.state === 'working'),
    deps: [], held: false, risky: false, bumpable: !handled, bumpedAt: bumped, manualSteps: [], fromAsk: null, from: null, next: inProgress ? mark.next || null : null, hasNotes: false, branch: null,
    finishable: handled && !done,
    linear: [], pr: null, reviewers: [], review: {}, inReviewSince: null,
    threadCount: msgs.length, lastTs, othersAt: handled ? othersAt : [], grilling: false, created: e.ts, updatedAt: handled ? lastTs : e.ts,
    ask: { eventId: e.id, state, askedAt: e.ts, bumpedAt: bumped, edited: Boolean(msg.edited), canEdit: !handled, text: msg.text, files, answerAt, from: msg.from || null },
    fold: null, action: null,
  };
}

// An item's agents, oldest first, from its records by agent name.
function agentsOf(records = {}) {
  return Object.entries(records).filter(([, r]) => r && typeof r === 'object').map(([name, r]) => ({
    name, kind: r.kind || null, label: r.label || null, started: r.started || null, eta: r.done ? null : r.eta || null, done: r.done || null,
  })).sort((a, b) => String(a.started || '').localeCompare(String(b.started || '')) || a.name.localeCompare(b.name));
}
// An install builder takes precedence so another running agent cannot hide the install's build state.
function builderOf(agents, lines = [], now) {
  const running = agents.filter((a) => a.started && !a.done);
  const since = running.map((a) => String(a.started || '')).sort()[0];
  if (since === undefined) return null;
  const line = lines.filter((m) => m.kind === 'status' && String(m.ts) >= since).sort((a, b) => String(a.ts).localeCompare(String(b.ts))).pop();
  const kind = running.some((a) => a.kind === BUILDER_KIND.install) ? BUILDER_KIND.install : running.at(-1).kind;
  const silentSince = line?.ts || since;
  return { progress: line?.text || null, at: silentSince, kind, silentSince, stalled: now - Date.parse(silentSince) >= BUILDER_STALLED_AFTER };
}

// Names the kind once, as "Opus builder" or "Codex benchmarks", never "Opus · Opus builder" (owner, question int42-agents-look).
function agentName({ kind, label }) {
  const k = kind ? kind[0].toUpperCase() + kind.slice(1) : '';
  if (!k) return label || 'Builder';
  if (!label) return k;
  return label.toLowerCase().includes(kind.toLowerCase()) ? label : `${k} ${label[0].toLowerCase()}${label.slice(1)}`;
}

// A question's state: open (no answer yet), answered (waiting for Claude), replied (Claude answered), requested (the
// owner asked for a prototype of it after its last answer, until the round arrives and resolves it), resolved
// (owner.json sets `resolved` and `resolved_at`). An answer newer than `resolved_at` reopens it; without `resolved_at`
// it stays resolved. answerEvents are owner-answer events and requestEvents prototype-request events, oldest first;
// store.mjs reads their states to close a card's questions.
export function ownerQuestion(q, answerEvents, requestEvents = []) {
  const answers = answerEvents.filter((e) => e.data?.id === q.id);
  const last = answers[answers.length - 1] || null;
  const reopened = Boolean(q.resolved && q.resolved_at && last && String(last.ts) > q.resolved_at);
  const resolved = q.resolved && !reopened;
  const req = resolved ? null : requestEvents.filter((e) => e.data?.question === q.id && String(e.ts) > String(last?.ts || '')).at(-1);
  const state = resolved ? 'resolved' : req ? 'requested' : !last ? 'open' : last.reply ? 'replied' : 'answered';
  return { ...q, state, request: req ? { id: req.id, ts: req.ts, note: req.data.note || '' } : null,
    answers: answers.map((e) => ({ ts: e.ts, choice: e.data.choice || null, note: e.data.note || '', files: e.data.files || [], reply: e.reply })) };
}

// docs/adr/0111-a-prototype-round-ends-with-a-one-take-confirm.md
// The prototype round a question belongs to: owner.json's `round`, set by `question add` with `round_of` and by
// `question confirm`, else 1 for a question on a prototype page and 0 for any other.
export const roundOf = (q) => q.round ?? (PROTOTYPE_URL.test(q.url || '') ? 1 : 0);
// docs/adr/0116-a-confirm-waits-for-claudes-update.md
// An ownerQuestion view whose last answer picks one of its prototype takes with a note: it waits on Claude until
// `question confirm` opens its confirm or `question resolve --no-change` resolves it.
export function awaitsConfirm(q) {
  const a = q.answers.at(-1);
  return Boolean(a?.note.trim()) && q.state !== 'resolved' && !q.confirm_of && PROTOTYPE_URL.test(q.url || '')
    && (q.options || []).some((o) => o.id === a.choice);
}
// docs/adr/0114-a-pick-with-no-note-settles-a-prototype-round.md
// The answer that settles round n among a topic's questions (ownerQuestion views): the newest of any answer to the
// round's confirm, a question's last answer when it picks one of its takes with no note, and the answer a
// `--no-change` resolve covers (owner.json `no_change`, that answer's ts); undefined while none has.
export function roundSettledBy(qs, n) {
  const settles = (q, a) => q.confirm_of || q.no_change === a.ts || (!a.note.trim() && (q.options || []).some((o) => o.id === a.choice));
  return qs.filter((q) => roundOf(q) === n && q.answers.length).map((q) => [q, q.answers.at(-1)])
    .filter(([q, a]) => settles(q, a)).map(([, a]) => a)
    .sort((x, y) => String(x.ts).localeCompare(String(y.ts))).at(-1);
}
// A topic's latest round: making while a question in it is requested or awaits its confirm, closed once an answer
// settles it, back while one of its questions is unresolved, else none.
function roundState(qs) {
  const req = qs.find((q) => q.state === 'requested');
  if (req) return { n: roundOf(req) + 1, state: 'making' };
  const n = Math.max(0, ...qs.map(roundOf));
  if (!n) return null;
  if (qs.some((q) => roundOf(q) === n && awaitsConfirm(q))) return { n, state: 'making' };
  const settled = roundSettledBy(qs, n);
  if (settled) return { n, state: 'closed', take: settled.choice };
  return qs.some((q) => roundOf(q) === n && q.state !== 'resolved') ? { n, state: 'back' } : null;
}

// A topic is resolved once every question in it is; questions without a known topic share "Other".
// A card's questions use topic `item:<key>`: `item:<wave>/<id>`, or `item:ask:<event id>` for a New card not yet sorted.
// The board supplies its title when owner.json has none. closed holds the topics of Done cards: one with no open
// question is resolved, so its answered questions never wait on Claude.
function ownerTopics(topics, questions, closed = new Set()) {
  const known = new Set(topics.map((t) => t.id));
  const all = [...topics];
  if (questions.some((q) => !known.has(q.topic))) all.push({ id: '', title: 'Other' });
  return all.map((t) => {
    const qs = questions.filter((q) => (known.has(q.topic) ? q.topic : '') === t.id);
    const count = (s) => qs.filter((q) => q.state === s).length;
    const settled = qs.every((q) => q.state === 'resolved') || (closed.has(t.id) && !count('open'));
    const state = qs.length && settled ? 'resolved' : 'open';
    return { ...t, state, questions: qs.map((q) => q.id), open: count('open'), answered: count('answered'), replied: count('replied'), requested: count('requested'),
      resolved: count('resolved'), round: roundState(qs) };
  }).filter((t) => t.questions.length);
}

// An item's thread: Claude's and GitHub's lines, the owner's messages and
// buttons from the board, and their answers to the item's questions,
// oldest first. working maps the event ids `board.mjs working` marked.
// Each owner message has a state: replied (Claude replied to its event), answered (a Claude line
// came after it), working (marked, neither yet) or waiting. An item-message still working or
// waiting can be deleted or edited, and shows its latest ask-edited text (docs/adr/0014-a-pending-ask-can-be-deleted-or-bumped.md). An ask's thread
// (key ask:<event id>), and a work item's whose fromAsk names an ask, opens with that ask. links [{key, ref, became}] are the
// work items an ask's thread links to: each adds a link line after the ask, and a linked ask counts as answered.
// moved lists the asks folded into this work item (data/ask-links.json): each shows at its own time, marked moved and
// answered. A work item's thread also takes the owner's messages from its asks' threads; the caller adds their lines.
// agents is the item's builder records by agent name: each adds a line when it started and one when it finished,
// which, like status lines, answer no message.
const ACTION_LABELS = { 'mark-ready': 'Mark ready', 'grill-more': 'Grill', 'prototype-request': 'Asked for prototypes' };
const actionText = (e, asked) => {
  if (e.kind !== 'prototype-request' || !asked.has(e.data.question)) return e.data.text || routeRecord(ACTION_LABELS, e.kind) || '';
  return [`Asked for a prototype: ${asked.get(e.data.question).question}`, e.data.note].filter(Boolean).join('\n→ ');
};
export function threadOf(key, { lines = [], events = [], owner = {}, working = {}, fromAsk = null, links = [], agents = {}, moved = [] }) {
  const askIds = key.startsWith('ask:') ? [key.slice(4)] : [fromAsk, ...moved].filter(Boolean);
  const keys = new Set([key, ...askIds.map((id) => `ask:${id}`)]);
  const asked = new Map((owner.items || []).filter((q) => q.topic === `item:${key}`).map((q) => [q.id, q]));
  const msgs = [
    // First, so a start sorts above the status line `builder start` writes at the same moment.
    ...agentsOf(agents).flatMap((a) => [
      ...(a.started ? [{ ts: a.started, who: 'claude', kind: 'agent', text: `${agentName(a)} started`, finished: false, eta: a.done ? null : a.eta }] : []),
      ...(a.done ? [{ ts: a.done, who: 'claude', kind: 'agent', text: `${agentName(a)} finished`, finished: true, eta: null }] : []),
    ]),
    ...lines.map((m) => ({ ts: m.ts, who: m.who || 'claude', ...(m.kind === 'status' ? { kind: 'status' } : {}), text: m.text || '', html: m.html || null, link: m.link || null, via: m.via || null })),
    ...events.filter((e) => keys.has(e.data?.key) && ITEM_EVENTS.includes(e.kind))
      .map((e) => ({ ts: e.ts, who: 'love', via: 'site', kind: e.kind, text: actionText(e, asked), files: e.data.files || [], eventId: e.id, reply: e.reply })),
    ...events.filter((e) => e.kind === 'owner-answer' && asked.has(e.data?.id)).map((e) => {
      const answer = [e.data.label || e.data.choice, e.data.note].filter(Boolean).join(' · ');
      return { ts: e.ts, who: 'love', via: 'questions', kind: e.kind, text: `${asked.get(e.data.id).question}\n→ ${answer}`, files: e.data.files || [], eventId: e.id, reply: e.reply };
    }),
    ...events.filter((e) => e.kind === 'ask' && askIds.includes(e.id))
      .flatMap((e) => [{ ts: e.ts, who: 'love', via: 'ask', kind: e.kind, text: e.data?.text || '', files: e.data?.files || [], eventId: e.id, reply: e.reply, ...(moved.includes(e.id) ? { moved: true } : {}),
        ...(typeof e.data?.from?.title === 'string' ? { from: e.data.from.title } : {}) },
        ...links.map((l) => ({ ts: e.ts, who: 'claude', kind: 'ask-link', text: `${l.became ? 'Became' : 'Added to'} ${l.ref}`, link: `#item=${encodeURIComponent(l.key)}`, html: null, via: null }))]),
  ].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const lastClaude = msgs.filter((m) => m.who === 'claude' && m.kind !== 'status' && m.kind !== 'agent').map((m) => String(m.ts)).pop() || '';
  const edits = new Map(events.filter((e) => e.kind === 'ask-edited').sort((a, b) => String(a.ts).localeCompare(String(b.ts))).map((e) => [e.data?.id, e.data?.text]));
  for (const m of msgs) {
    if (!m.eventId) continue;
    if ((m.kind === 'ask' || m.kind === 'item-message') && typeof edits.get(m.eventId) === 'string') Object.assign(m, { text: edits.get(m.eventId), edited: true });
    const linked = m.kind === 'ask' && (links.length > 0 || Boolean(m.moved));
    m.state = m.reply ? 'replied' : linked || lastClaude > String(m.ts) ? 'answered' : routeRecord(working, m.eventId) ? 'working' : 'waiting';
    m.canDelete = m.kind === 'item-message' && (m.state === 'working' || m.state === 'waiting');
    m.canEdit = m.canDelete;
  }
  return msgs;
}

// The Waves section's rows: each open lineup, the owner's wave (docs/adr/0109-a-wave-the-owner-asks-for-is-a-lineup-of-cards.md),
// then on a board over ~/.claude/waves each unfinished wave file. Each lineup card gets `lineup` {slug, title} for its
// chip, an open lineup's over a finished one's. A lineup is open until finished_at or until all its cards are Done.
// A row's kind is lineup or wave (a wave file). Triage runs from the newest wave-triage {<kind>: <slug>} event until
// that event's reply, and its questions use topic <kind>:<slug>.
function waveRowsOf(snapshot, waves, lineups, items, questions, events) {
  const triageOf = (kind, slug) => {
    const last = events.filter((e) => e.kind === 'wave-triage' && e.data?.[kind] === slug).pop();
    const pending = questions.filter((q) => q.topic === `${kind}:${slug}` && (q.state === 'open' || q.state === 'answered')).length;
    return { running: Boolean(last && !last.reply), questions: pending };
  };
  const byKey = new Map(items.map((i) => [i.key, i]));
  const merged = (cards) => cards.filter((i) => i.lane === 'done' && !droppedCard(i)).length;
  const open = lineups.map((l) => ({ l, cards: l.keys.map((k) => byKey.get(k)).filter(Boolean) }))
    .map((x) => ({ ...x, open: !x.l.finished_at && x.cards.some((i) => i.lane !== 'done') }))
    .sort((a, b) => Number(a.open) - Number(b.open));
  for (const { l, cards } of open) for (const i of cards) i.lineup = { slug: l.slug, title: l.title };
  const rows = open.filter((x) => x.open).map(({ l, cards }) => ({ kind: 'lineup', slug: l.slug, title: l.title, goal: l.goal,
    order: cards.map((i) => ({ key: i.key, ref: i.ref })), merged: merged(cards), total: cards.length, triage: triageOf('lineup', l.slug) }));
  if (!snapshot.fromWaves) return rows;
  return [...rows, ...waves.filter((w) => !w.finished).map((w) => ({ w, cards: items.filter((i) => i.wave === w.slug && i.kind !== 'ask') }))
    .filter(({ cards }) => cards.length).map(({ w, cards }) => ({ kind: 'wave', slug: w.slug, title: w.title, goal: null, order: null, merged: merged(cards), total: cards.length,
      triage: triageOf('wave', w.slug) }))];
}

// snapshot: {waves: [{slug, wave, agents: {<id>: {<agent>: record}}}], fromWaves,
//   prs: {"<repo>#<n>": pr}, threads: {<key>: [line]}, events: [event with reply, hidden ones left out],
//   working: {<event id>: ts}, checked: data/checked.json, listen, watcher: data/watcher.json, askLinks: {<ask event id>: <wave>/<id>},
//   askProgress: {<ask event id>: {state: progress|done, at, next, moved}}, owner: owner.json,
//   autoMerge: board.json's auto_merge (true leaves merging to the GitHub tick, so no card gets the owner's Merge),
//   autoBuild: board.json's auto_build (true leaves card runs to the hub, so no card gets the owner's Serve / Build),
//   threads also holds each ask's lines under ask:<event id>; github: the board's owner/name, or remote: its git link
//   on another host, and branch: the board's branch;
//   topicItems: merged topic items, prompts: this board's pending prompts (../hub/prompts.mjs shown), now: ms}
// moved maps ask:<event id> to the work item whose thread holds that ask.
// An event marked working needs its reply loaded, or it counts as still working.
export function buildBoard(snapshot) {
  const { owner = {}, topicItems = {}, events = [], threads = {}, prs = {}, working = {} } = snapshot;
  const now = snapshot.now ?? Date.now();
  const itemEvents = events.filter((e) => e.data?.key && ITEM_EVENTS.includes(e.kind));
  const withdrawn = new Set(events.filter((e) => e.kind === 'ask-withdrawn' && !e.data?.key).map((e) => e.data?.id));
  const asks = new Map(events.filter((e) => e.kind === 'ask' && !withdrawn.has(e.id)).map((e) => [e.id, e]));
  const latest = (kind, field) => new Map(events.filter((e) => e.kind === kind).sort((a, b) => String(a.ts).localeCompare(String(b.ts))).map((e) => [e.data?.[field], e.ts]));
  const bumps = latest('ask-bump', 'id');
  const cardBumps = latest('card-bump', 'key');
  const cardDones = latest('card-done', 'key');
  const cardMerges = latest('card-merge', 'key');
  const cardBuilds = latest('card-build', 'key');
  const autoMerge = snapshot.autoMerge === true;
  const tickets = snapshot.tickets;
  const cardHolds = new Map(events.filter((e) => e.kind === 'card-hold').sort((a, b) => String(a.ts).localeCompare(String(b.ts))).map((e) => [e.data?.key, e]));
  const madeFrom = new Map();
  const askLinks = snapshot.askLinks || {};
  // The asks folded into each work item (docs/adr/0047-the-plus-makes-a-new-card.md).
  const foldedInto = new Map();
  for (const [id, key] of Object.entries(askLinks)) if (asks.has(id)) foldedInto.set(key, [...(foldedInto.get(key) || []), id]);

  const waves = [];
  const items = [];
  const threadStates = new Map();
  const remote = snapshot.github ? null : remoteFromInput(snapshot.remote);
  for (const { slug, wave, agents: records = {} } of snapshot.waves) {
    const repo = snapshot.github || wave.repo || null;
    waves.push({ slug, title: wave.title || slug, status: wave.status || null, internal: Boolean(wave.internal), finished: null, reviewers: (wave.reviewers || []).map((r) => r.name) });
    wave.items.forEach((it, order) => {
      const key = `${slug}/${it.id}`;
      const folded = foldedInto.get(key) || [];
      const askIds = [it.from_ask, ...folded].filter((id) => asks.has(id));
      const askKeys = new Set(askIds.map((id) => `ask:${id}`));
      const lines = [...(routeRecord(threads, key) || []), ...askIds.flatMap((id) => routeRecord(threads, `ask:${id}`) || [])];
      if (it.from_ask) madeFrom.set(it.from_ask, [...(madeFrom.get(it.from_ask) || []), { key, ref: refOf(wave, it.id, tickets), became: true }]);
      const msgs = threadOf(key, { lines, events, owner, working, fromAsk: it.from_ask || null, moved: folded });
      for (const m of msgs) if (m.eventId) threadStates.set(m.eventId, m.state);
      items.push(workItem({
        slug, wave, it, order, repo, remote, base: snapshot.branch || 'main',
        pr: it.pr && repo ? routeRecord(prs, `${repo}#${it.pr}`) || null : null,
        ...((agents) => ({ agents, builder: builderOf(agents, routeRecord(threads, key), now), eta: agents.map((a) => a.eta).filter(Boolean).sort().pop() || null }))(agentsOf(routeRecord(records, it.id))),
        thread: lines,
        events: [...itemEvents.filter((e) => e.data.key === key || askKeys.has(e.data.key)), ...askIds.map((id) => asks.get(id))],
        working: msgs.some((m) => m.state === 'working'),
        topicItems, boardReviewers: snapshot.reviewers || [], now, bumpedAt: cardBumps.get(key), holdAsk: cardHolds.get(key), closedAt: cardDones.get(key),
        mergeAt: cardMerges.get(key), buildAt: cardBuilds.get(key), autoMerge, tickets,
      }));
    });
    (wave.followups || []).forEach((f, n) => items.push(followUp({ slug, wave, f, order: wave.items.length + n, repo, bumpedAt: cardBumps.get(`${slug}/${f.id}`), closedAt: cardDones.get(`${slug}/${f.id}`), tickets })));
  }
  const works = new Map(items.map((i) => [i.key, i]));
  // An ask that became work or was folded into a card shows in that card's thread instead of as a card of its own; old
  // links to it open that card.
  const moved = new Map();
  const tries = snapshot.try || {};
  const autoBuild = snapshot.autoBuild === true;
  const kind = ['web', 'app'].includes(tries.kind) ? tries.kind : snapshot.waves.some(({ wave }) => wave.items.some((it) => it.install?.url)) ? 'app' : 'web';
  for (const it of items) {
    if (it.kind !== 'work' || it.lane === 'done') continue;
    const run = routeRecord(tries.cards, it.key) || {};
    const head = run.head || it.pr?.headRefOid;
    const sha = kind === 'web' ? run.sha : it.install?.sha;
    const state = it.builder?.kind === BUILDER_KIND.install ? 'running' : run.state || (kind === 'app' && it.install ? 'ready' : null);
    it.try = { kind, state, stale: Boolean(sha && head && !String(head).toLowerCase().startsWith(String(sha).toLowerCase())),
      url: kind === 'web' ? null : it.install?.url || null, port: kind === 'web' && state === 'ready' ? run.https || null : null,
      sha: sha || null, changes: run.ahead > 0, script: run.script === true, autoBuild };
  }
  const run = tries.main;
  const main = run?.script && run.sha ? { slug: run.slug, branch: run.branch || 'main', sha: run.sha.slice(0, 7), at: run.at,
    kind, state: run.state || null, url: kind === 'web' ? null : snapshot.main?.install?.url || null, port: kind === 'web' && run.state === 'ready' ? run.https || null : null } : null;

  const askProgress = snapshot.askProgress || {};
  const askDones = latest('ask-done', 'id');
  const answerEvents = events.filter((e) => e.kind === 'owner-answer');
  const requestEvents = events.filter((e) => e.kind === 'prototype-request');
  const questions = (owner.items || []).map((q) => ownerQuestion(q, answerEvents, requestEvents));
  const pendingOn = (topic) => {
    const qs = questions.filter((q) => q.topic === topic);
    return { open: qs.filter((q) => q.state === 'open').length, answered: qs.filter((q) => q.state === 'answered' || q.state === 'requested').length };
  };
  for (const e of asks.values()) {
    const key = `ask:${e.id}`;
    const related = works.get(routeRecord(askLinks, e.id));
    const links = [...(madeFrom.get(e.id) || [])];
    if (related && !links.some((l) => l.key === related.key)) links.push({ key: related.key, ref: related.ref, became: false });
    if (links.length) { moved.set(key, links[0].key); continue; }
    const msgs = threadOf(key, { lines: routeRecord(threads, key) || [], events, working, links });
    for (const m of msgs) if (m.eventId) threadStates.set(m.eventId, m.state);
    items.push(askItem(e, msgs, bumps.get(e.id), links.length > 0 || Boolean(routeRecord(askLinks, e.id)), routeRecord(askProgress, e.id), askDones.get(e.id), pendingOn(`item:${key}`)));
  }
  for (const w of waves) {
    const cards = items.filter((i) => i.wave === w.slug);
    w.finished = finishedOf(cards);
    if (w.finished) for (const i of cards) if (i.lane === 'done') i.fold = waveFold(w.slug);
  }
  for (const i of items) { i.lineup = null; if (i.kind === 'ask' && i.lane === 'done') i.fold = ASKS_FOLD; }
  const declared = new Set((owner.topics || []).map((t) => t.id));
  const lineups = snapshot.waves.flatMap(({ slug, wave }) => (wave.lineups || []).map((l) => ({ ...l, keys: l.items.map((id) => `${slug}/${id}`) })));
  const topicsOf = () => ownerTopics([...(owner.topics || []), ...items.filter((it) => !declared.has(`item:${it.key}`))
    .map((it) => ({ id: `item:${it.key}`, title: `${it.ref}: ${it.title}`, summary: 'Questions about this work item.' })),
  ...lineups.filter((l) => !declared.has(`lineup:${l.slug}`)).map((l) => ({ id: `lineup:${l.slug}`, title: l.title, summary: 'Wave triage.' })),
  ...(snapshot.fromWaves ? waves : []).filter((w) => !declared.has(`wave:${w.slug}`)).map((w) => ({ id: `wave:${w.slug}`, title: w.title, summary: 'Wave triage.' }))], questions,
  new Set(items.filter((it) => it.lane === 'done').map((it) => `item:${it.key}`)));
  const itemTopics = new Map(topicsOf().map((t) => [t.id, t]));
  for (const it of items) {
    const t = itemTopics.get(`item:${it.key}`);
    if (!t) { it.questions = null; continue; }
    const pending = t.questions.filter((id) => questions.find((q) => q.id === id)?.state !== 'resolved');
    const first = t.questions.find((id) => questions.find((q) => q.id === id)?.state === 'open') || pending[0] || t.questions[0];
    it.questions = { topic: t.id, state: t.state, open: t.open, answered: t.answered, replied: t.replied, resolved: t.resolved, first };
  }
  // A card waits on each dep until it reaches Done, and a Done card waits on nothing (docs/adr/0020-cards-wait-on-explicit-blocked-by-links.md).
  const byKey = new Map(items.map((i) => [i.key, i]));
  const questionById = new Map(questions.map((q) => [q.id, q]));
  for (const it of items) {
    it.blockedBy = it.kind !== 'work' || it.lane === 'done' ? [] : it.deps.map((d) => byKey.get(String(d).includes('/') ? d : `${it.wave}/${d}`))
      .filter((d) => d && d.lane !== 'done').map((d) => ({ key: d.key, ref: d.ref }));
    if (it.lane === 'done' && !it.fold && it.updatedAt && now - Date.parse(it.updatedAt) >= DONE_OPEN) it.fold = OLDER_FOLD;
    placeOwnerWait(it, questionById, autoMerge);
    if (it.lane === 'todo' && it.kind === 'work' && !it.held && started(it)) it.lane = 'progress';
    it.buildable = buildableOf(it);
  }
  // Items arrive in touched order; the page shows a lane in created order from rank.created, as this device chose.
  [...items].sort(laneOrder('created')).forEach((it, n) => { it.rank = { created: n }; });
  items.sort(laneOrder('touched'));

  const waveRows = waveRowsOf(snapshot, waves, lineups, items, questions, events);
  // Built again after the sort, so the item topics follow the lanes' order.
  const topicList = topicsOf();
  const needs = [...promptLines(snapshot.prompts), ...needsOf(items, topicList, questions)];
  // A thread's event works until a reply or a later Claude line; any other event until its reply. A mark also lapses once
  // its card leaves the board or is closed after the mark, since nothing would ever reply to it.
  const topicOf = new Map((owner.items || []).map((q) => [q.id, q.topic]));
  const ownCardOf = (e) => {
    if (e.kind === 'owner-answer') return topicOf.has(e.data?.id) ? /^item:(.+)$/.exec(topicOf.get(e.data.id))?.[1] || null : '';
    if (e.kind === 'ask') return `ask:${e.id}`;
    return e.data?.key || (e.kind.startsWith('ask-') && e.data?.id ? `ask:${e.data.id}` : null);
  };
  const cardOf = (e) => { const card = ownCardOf(e); return moved.get(card) || card; };
  const closedAt = (key) => {
    const id = key.startsWith('ask:') ? key.slice(4) : null;
    const done = id && routeRecord(askProgress, id)?.state === 'done' ? routeRecord(askProgress, id).at : null;
    return [cardDones.get(key), id && askDones.get(id), done].filter(Boolean).sort().pop() || '';
  };
  const live = (e) => {
    const card = cardOf(e);
    return card === null || (byKey.has(card) && closedAt(card) < String(routeRecord(working, e.id)));
  };
  const workingCount = events.filter((e) => routeRecord(working, e.id) && live(e) && (threadStates.has(e.id) ? threadStates.get(e.id) === 'working' : !e.reply)).length;
  // The page shows those this browser hasn't seen in the answer banner (docs/adr/0016-every-ask-is-a-card.md).
  const answers = items.filter((i) => i.ask?.answerAt).sort((a, b) => b.ask.answerAt.localeCompare(a.ask.answerAt))
    .map((i) => ({ key: i.key, id: i.id, text: i.title, at: i.ask.answerAt }));
  return { kind, main, remote: remote && { host: remote.host, name: `${remote.host}/${remote.path}` }, waves, waveRows, items, moved: Object.fromEntries(moved), answers, owner: questions, ownerTopics: topicList, needs, needsSummary: needsSummary(needs), working: workingCount, checks: checksOf(snapshot, now) };
}

// The board's order, each lane together, by touched (the card's latest activity) or created (when the card was made).
// docs/adr/0019-a-card-that-hasnt-started-can-be-bumped.md
// New cards lead Todo, unbumped ones oldest first, so the top one is the next taken (docs/adr/0047-the-plus-makes-a-new-card.md).
function laneOrder(by) {
  const bumped = (i) => i.bumpedAt || '';
  const unsorted = (i) => (i.isNew ? 0 : 1);
  const key = (i) => String((by === 'created' ? i.created : i.updatedAt) || '');
  const age = (a, b) => (a.isNew ? String(a.updatedAt).localeCompare(String(b.updatedAt)) : key(b).localeCompare(key(a)));
  // A follow-up's filed date would otherwise sort it above the Todo work that has no activity yet.
  const late = (i) => (by === 'touched' && i.lane === 'todo' && i.kind === 'followup' ? 1 : 0);
  return (a, b) => LANE_ORDER[a.lane] - LANE_ORDER[b.lane] || unsorted(a) - unsorted(b) || bumped(b).localeCompare(bumped(a)) || late(a) - late(b) || age(a, b) || b.order - a.order || a.key.localeCompare(b.key);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// checked is data/checked.json {at, every (minutes), idle?}, listen whether the board hears its events
// (hub/boards.mjs listenState), watcher data/watcher.json {since} or null, replyAt the newest reply file's time
// (docs/adr/0021-the-board-shows-github-checks-and-watcher-health.md). claudeAt is the newest write of Claude's the
// board can see: a reply, a Claude thread line, a working mark, a builder record or a watcher start. checked.json
// doesn't count, since the hub writes it on every poll (hub/github.mjs).
function checksOf({ checked, listen, watcher, replyAt, threads = {}, working = {}, waves = [] }, now) {
  const every = Number(checked?.every) || 30;
  const writes = [
    replyAt, watcher?.since, ...Object.values(working),
    ...Object.values(threads).flat().filter((l) => (l.who || 'claude') === 'claude').map((l) => l.ts),
    ...waves.flatMap((w) => Object.values(w.agents || {}).flatMap((byAgent) => Object.values(byAgent || {})).map((r) => r?.done || r?.started)),
  ].filter((t) => typeof t === 'string' && !Number.isNaN(Date.parse(t)));
  const claudeAt = writes.sort((a, b) => Date.parse(a) - Date.parse(b)).pop() || null;
  const idle = Boolean(checked?.idle);
  return {
    at: checked?.at || null, every: idle ? null : every, idle, late: !idle && Boolean(checked?.at) && now - Date.parse(checked.at) > 2 * every * 60000,
    watcher: { listening: 'running', asleep: 'asleep' }[listen] || 'stopped', claudeAt,
  };
}

// Needs you: one line per topic not tied to an item with open questions, then one per item with open
// questions or a draft waiting on Ready. Answered questions wait on Claude, so they don't count, and a
// held item waits on nobody, so it has no line.
// {kind, text, url} is the GET /_claude/needs contract (docs/adr/0010-sites-report-what-waits-through-claude-needs.md);
// url is relative to the site root.
function needsOf(items, topics, questions) {
  const onItems = new Set(items.map((it) => it.questions?.topic).filter(Boolean));
  const firstOpen = (ids) => ids.find((id) => questions.find((q) => q.id === id)?.state === 'open') || ids[0];
  const fromTopics = topics.filter((t) => t.state !== 'resolved' && t.open > 0 && !onItems.has(t.id)).map((t) => {
    const url = `questions.html#${firstOpen(t.questions)}`;
    const waveRow = /^(?:lineup|wave):(.+)$/.exec(t.id)?.[1] || null;
    return { kind: 'Question', title: t.title, text: `${t.title} · ${plural(t.open, 'question')}`, url, topic: t.id, waveRow, questions: { open: t.open, url }, ready: null };
  });
  const fromItems = items.filter((it) => !it.held).map((it) => {
    const asking = it.questions && it.questions.state !== 'resolved' && it.questions.open > 0 ? { open: it.questions.open, url: `questions.html#${it.questions.first}` } : null;
    const ready = it.waitsOn === 'ready' ? it.pr.url : null;
    // docs/adr/0045-the-lane-follows-who-acts-next.md: every card with Action needed gets a line.
    const other = !asking && !ready && it.action ? { label: it.action.label, url: it.action.url } : null;
    if (!asking && !ready && !other) return null;
    const title = `${it.ref}: ${it.title}`;
    const text = [title, asking && plural(asking.open, 'question'), ready && 'Ready on GitHub', other?.label].filter(Boolean).join(' · ');
    return { kind: asking ? 'Question' : ready ? 'Tap Ready' : 'Action needed', title, text, url: `#item=${encodeURIComponent(it.key)}`, key: it.key, questions: asking, ready, action: other };
  }).filter(Boolean);
  return [...fromTopics, ...fromItems];
}

// The board session's pending prompts lead Needs you, since each holds the session until the owner answers it there
// (../hub/prompts.mjs shown; docs/adr/0060-background-sessions-prompts-come-to-the-phone.md).
function promptLines(prompts = []) {
  return prompts.map((p) => {
    const text = p.questions?.length ? `Question: ${p.questions.map((q) => q.question).join(' · ')}` : `${p.tool}: ${p.detail || p.action}`;
    return { kind: 'Prompt', title: text, text, url: '', prompt: p };
  });
}

// The hub's one-line summary of the Needs you lines, such as "1 prompt · 2 questions · 1 draft waiting on Ready".
function needsSummary(needs) {
  const prompts = needs.filter((line) => line.prompt).length;
  const questions = needs.reduce((n, line) => n + (line.questions?.open || 0), 0);
  const drafts = needs.filter((line) => line.ready).length;
  return [prompts && plural(prompts, 'prompt'), questions && plural(questions, 'question'), drafts && `${plural(drafts, 'draft')} waiting on Ready`].filter(Boolean).join(' · ');
}

// The GET /_claude/needs body for a built board (docs/adr/0010-sites-report-what-waits-through-claude-needs.md).
// A Stale card is a PR still in review, so it counts as review.
export function needsAnswer(b) {
  const count = (...lanes) => b.items.filter((i) => lanes.includes(i.lane)).length;
  return {
    items: b.needs.map(({ kind, text, url }) => ({ kind, text, url })), working: b.working, summary: b.needsSummary,
    lanes: { review: count('review', 'stale'), progress: count('progress'), todo: count('todo') },
    building: b.items.some((i) => (i.agents || []).some((a) => !a.done)),
  };
}

// docs/adr/0123-an-idle-board-pulls-in-its-top-todo-card.md
// For built items in board order: idle while no card has a running builder and none waits in Orchestrator review;
// pullable lists, top first, the buildable cards with no questions and no grill under way.
export function pullOf(items) {
  const open = items.filter((i) => i.lane !== 'done');
  const idle = !open.some((i) => i.waitsOn === 'checking' || (i.agents || []).some((a) => !a.done));
  const pullable = open.filter((i) => i.buildable && !i.questions && !i.grilling).map((i) => i.key);
  return { idle, pullable };
}
