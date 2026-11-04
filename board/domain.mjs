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
import { ticketBadge, ticketIn } from './tickets.mjs';
import { reviewLinks, reviewTime, reviewersOf } from './review.mjs';
import { remoteFromInput } from '../hub/repos.mjs';
import { reviewsOf, reviewNeeds, reviewActions } from './auto-review.mjs';
import { cardPRs, hasPR, leastReady, prKeyOf, prURL } from '../shared/card-prs.mjs';
import vm from 'node:vm';

// Page scripts with no exports, which the page loads as is, so node runs them the same way.
const enums = vm.createContext({});
for (const file of ['ui-enums.js', 'ui-order.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), enums);
export const { BUTTON, ACTION_KIND, BUILDER_KIND, PR_STATE } = enums.BoardUI;
const { laneOrder } = enums.BoardUI;

export const ITEM_EVENTS = ['item-message', 'mark-ready', 'grill-more', 'prototype-request'];
export const ITEM_STATUSES = ['planned', 'waiting', 'building', 'fixing', 'checking', 'held', 'merged', 'done', 'dropped'];
export const BUILDER_STALLED_AFTER = 30 * 60000;
// The thread line's kind for a Build tap the board server refused (store.mjs startTappedBuild).
export const BUILD_REFUSED = 'build-refused';
const DAY = 86400000;
// Done holds closed work cards, Asks the answered asks (docs/adr/2026-11-03-0259-answered-asks-have-their-own-section-below-done.md).
const closedLane = (i) => i.lane === 'done' || i.lane === 'asks';
// A finished wave's Done cards fold under a row of their own, which board/public/app-lanes.js reads back by this id.
export const waveFold = (slug) => `wave:${slug}`;
// A PR in review longer than this parks in the Stale lane (docs/adr/2026-10-29-1639-a-pr-in-review-shows-its-age-and-goes-stale-after-seven-days.md).
const STALE_AFTER = 7 * DAY;

// board/public/ui-links.js links Linear ids in text from these urls, so a board with no workspace links none.
const linearRef = (id, tickets) => ({ id, url: tickets?.workspace ? `https://linear.app/${tickets.workspace}/issue/${id}` : null });
// Internal items keep their stored ids, which key threads, builder records and events; S<n> reads <prefix>-<n>, INT
// without an internal ticket source. Other ids read as stored, so a changed prefix never relabels them.
const internalRef = (id, prefix) => String(id).replace(/^S(\d+)$/, `${prefix || 'INT'}-$1`);
// A card reads as its ticket when the ticket is from the board's source (#n, TEAM-n or PREFIX-n), else by its id;
// its key keeps the stored id (docs/adr/2026-11-02-2100-a-card-is-named-by-its-boards-ticket-source.md).
export const refOf = (wave, item, tickets) => (ticketIn(tickets, item.ticket) ? item.ticket
  : wave.internal === true ? internalRef(item.id, tickets?.prefix) : item.id);
// A board without a source reads stored tickets as Internal · INT. A stored ticket from another source keeps its own
// id, unlinked (docs/adr/2026-11-01-1348-a-board-has-one-ticket-source.md).
const ticketOf = (tickets, stored, id, at) => ticketBadge(tickets || (stored ? { source: 'internal', prefix: 'INT' } : null), id, at)
  || (stored ? { id: String(stored), url: null, source: null } : null);

// The lane before owner waits are placed: In Progress while Claude acts next, In Review while the reviewers do, or
// while a pushed branch waits on the owner's merge (docs/adr/2026-11-02-1850-a-board-can-work-on-any-git-remote.md).
// buildBoard places a card that only the owner can move on (docs/adr/2026-10-29-1639-the-lane-follows-who-acts-next.md).
// A reopened card has left Done whatever its PR's state.
function laneOf(item, pr, running, pushed, reopened) {
  const s = (item.status || '').toLowerCase();
  if (s === 'merged' || s === 'done' || s === 'dropped' || (!reopened && (pr?.state === 'MERGED' || pr?.state === 'CLOSED'))) return 'done';
  if (running || s === 'checking') return 'progress';
  if (pushed) return 'review';
  if (pr && pr.state === 'OPEN' && !pr.isDraft) return pr.checks?.state === 'fail' ? 'progress' : 'review';
  return pr ? 'progress' : 'todo';
}

// The state of one of a card's PRs (ui-enums.js PR_STATE): merged once GitHub or the card says so, or null before GitHub
// is read.
function prStateOf(pr, it) {
  if (pr?.state === 'MERGED' || it.status === 'merged' || it.merged_at) return PR_STATE.merged;
  if (pr?.state === 'CLOSED') return PR_STATE.closed;
  if (pr?.state === 'OPEN') return pr.isDraft ? PR_STATE.draft : PR_STATE.open;
  return null;
}

const droppedCard = (i) => {
  const s = (i.status || '').toLowerCase();
  return s === 'dropped' || (i.pr?.state === 'CLOSED' && s !== 'merged' && s !== 'done');
};

// A wave is finished once it has work items and every work item is in Done
// (docs/adr/2026-10-29-1639-lists-never-cut-silently.md). merged counts the wave's Done cards that weren't dropped.
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
// docs/adr/2026-10-29-1752-auto-merge-is-a-board-setting-off-by-default.md
const OWNER_MERGE_NEXT = { waiting: 'Approved, Merge shows once CI and the merge state allow', ready: 'Approved and green: tap Merge', merging: 'Merging' };
const FIX_CI = 'Fix the failing CI';
const TAP_DONE = 'Tap Done once it is settled';

// Only Claude's and GitHub's messages are ever unread, and replies, which are Claude's; never the owner's lines,
// their answers included, nor status, agent or ask-link lines (ui-threads.js unread).
const countsUnread = (m) => (m.who === 'claude' || m.via === 'github') && !['status', 'agent', 'ask-link'].includes(m.kind);

// said is the owner's messages and answers in the card's thread (threadOf), and askedAt the asked_at of its questions.
// prs is the card's PRs, [{repo, number, gh}], gh being GitHub's state or null before it is read; the least-ready one
// decides the lane, what it waits on and its Next (docs/adr/2026-11-03-1904-a-card-holds-several-prs-across-repos.md).
function workItem({ slug, wave, it, order, prs, repo, remote, base, builder, reachedPhase, agents, worktree, eta, thread, events, working, said, askedAt, topicItems, boardReviewers, now, bumpedAt, holdAsk, closedAt, mergeAt, autoMerge, tickets }) {
  const views = prs.map((p) => ({ repo: p.repo, number: p.number, url: prURL(p), ...(p.gh || {}), status: prStateOf(p.gh, it) }));
  const least = leastReady(prs.map((p) => p.gh));
  const pr = prs[least]?.gh || null;
  const prStatus = views[least]?.status ?? null;
  // docs/adr/2026-11-02-0009-the-board-applies-the-owners-hold-resume-and-done-at-once.md
  const tappedDone = Boolean(closedAt) && String(closedAt) > String(it.status_at || '');
  if (tappedDone && it.status !== 'merged') it = { ...it, status: 'done' };
  // When the card last closed: the owner's Done, its done or merged status, or its PR's merge.
  const closed = [tappedDone && closedAt, it.status_at, it.merged_at, ...prs.map((p) => p.gh?.mergedAt)].filter(Boolean).map(String).sort().pop() || null;
  // A done or merged card reopens; a dropped one, or one whose PR closed unmerged, doesn't
  // (docs/adr/2026-11-02-1952-a-message-or-question-on-a-done-card-reopens-it.md,
  // docs/adr/2026-11-03-1843-a-merged-card-reopens-and-its-pr-badge-shows-the-prs-state.md).
  const doneAt = String(closed || '');
  const reopenAt = ['done', 'merged'].includes(it.status) || (prStatus === PR_STATE.merged && it.status !== 'dropped')
    ? [...said.filter((m) => m.kind === 'item-message').map((m) => m.ts), ...askedAt].map(String).filter((t) => t > doneAt).sort().pop() : undefined;
  if (reopenAt) it = { ...it, status: undefined, next: undefined };
  const ownerPending = Boolean(reopenAt) && said.some((m) => String(m.ts) > doneAt && (m.state === 'waiting' || m.state === 'working'));
  const key = `${slug}/${it.id}`;
  const reviewers = reviewersOf(wave, boardReviewers);
  const sentAt = Object.fromEntries(Object.entries(reviewLinks(wave, it, key, topicItems)).map(([name, link]) => [name, reviewTime(link.ts)]));
  const inReviewSince = Object.values(sentAt).filter(Boolean).sort()[0] || null;
  const lastTs = [...thread.map((m) => m.ts), ...events.map((e) => e.ts)].sort().pop() || null;
  // A builder status line is progress, not a message: it is never unread and answers no owner message.
  const othersAt = [...thread.filter((m) => countsUnread({ ...m, who: m.who || 'claude' })).map((m) => m.ts), ...events.map((e) => e.reply?.at)].filter(Boolean).sort();
  const lastGrill = events.filter((e) => e.kind === 'grill-more').pop();
  const grillRunning = agents.some((a) => a.kind === 'grill' && a.started && !a.done);
  // A branch pushed to a plain git remote, which has no PR (docs/adr/2026-11-02-1850-a-board-can-work-on-any-git-remote.md).
  const pushed = !hasPR(it) && it.pushed?.branch ? { branch: it.pushed.branch, at: it.pushed.at || null, host: remote?.host || null } : null;
  let lane = laneOf(it, pr, agents.some((a) => a.started && !a.done && builds(a)), pushed, Boolean(reopenAt));
  if (reopenAt && lane === 'todo') lane = 'progress';
  if (lane === 'review' && inReviewSince && now - Date.parse(inReviewSince) > STALE_AFTER) lane = 'stale';
  let waitsOn = waitsOnOf(lane, pr, builder, (it.status || '').toLowerCase(), pushed);
  const changing = waitsOn === 'builder' && pr?.state === 'OPEN' && !pr.isDraft;
  const redReady = lane === 'progress' && !waitsOn && pr?.state === 'OPEN' && !pr.isDraft;
  // A reopened card Claude has answered waits on the owner's Done.
  const awaitsDone = Boolean(reopenAt) && lane === 'progress' && !waitsOn && !redReady && !ownerPending;
  if (awaitsDone) waitsOn = 'owner';
  const tapped = holdAsk && String(holdAsk.ts) > String(it.held_at || '');
  // Only a Todo card reads held; old data can't show one in Done.
  const held = lane === 'todo' && (tapped ? Boolean(holdAsk.data.hold) : it.status === 'held' || Boolean(it.held));
  // docs/adr/2026-11-02-1727-a-card-can-be-held-until-a-time.md
  const heldUntil = held ? (tapped ? holdAsk.data.until : it.pick_up_at) || null : null;
  // docs/adr/2026-10-29-1639-a-card-that-hasnt-started-can-be-bumped.md
  const bumpable = lane === 'todo' || (!held && lane === 'progress' && waitsOn !== 'ready' && waitsOn !== 'checking');
  // The owner's Merge waits on the session until it merges or writes in the thread, such as why it can't merge yet.
  const lastClaudeAt = thread.filter((m) => (m.who || 'claude') === 'claude' && m.kind !== 'status').map((m) => String(m.ts)).sort().pop() || '';
  const merging = waitsOn === 'merge' && Boolean(mergeAt) && String(mergeAt) > lastClaudeAt;
  // A Build tap the board refused: its reason stays on a Todo card while it is the card's newest line
  // (docs/adr/2026-11-03-0219-a-build-tap-starts-the-build-in-the-board-server.md).
  const newest = thread.filter((m) => m.kind !== 'status').sort((a, b) => String(a.ts).localeCompare(String(b.ts))).at(-1);
  const refusal = lane === 'todo' && newest?.kind === BUILD_REFUSED ? newest.text : null;
  // docs/adr/2026-11-03-0223-each-lane-has-one-fixed-order.md
  // When the card last came into In Progress: its reopening, else its latest build agent's start, else its status change.
  const progressSince = reopenAt || agents.filter(builds).map((a) => a.started).filter(Boolean).map(String).sort().pop() || it.queued_at
    || (['building', 'fixing', 'checking'].includes(String(it.status || '').toLowerCase()) ? it.status_at || null : null);
  const reviewNext = pushed && waitsOn === 'owner' ? `merge ${pushed.branch} into ${base}`
    : waitsOn === 'merge' && !autoMerge ? OWNER_MERGE_NEXT[merging ? 'merging' : 'waiting'] : REVIEW_NEXT[waitsOn];
  return {
    key, kind: 'work', order, wave: slug, waveTitle: wave.title || slug, id: it.id, ref: refOf(wave, it, tickets), title: it.title, status: it.status || null,
    created: it.created || null, progressSince, closedAt: lane === 'done' ? closed : null,
    internal: wave.internal === true, repo: wave.internal === true && !wave.repo ? null : repo,
    lane, waitsOn, builder: waitsOn === 'checking' ? null : builder, reachedPhase, agents, worktree: worktree ?? null, eta, working, reopened: Boolean(reopenAt), awaitsDone,
    queued: lane !== 'done' && Boolean(it.queued_at),
    deps: it.deps || [], held, heldUntil, risky: Boolean(it.risky), bumpable, bumpedAt: bumpable ? bumpedAt || null : null,
    holdable: lane !== 'done', hasNotes: Boolean(it.plan || String(it.notes || '').trim()),
    finishable: lane !== 'done',
    merging, refusal, manualSteps: it.manual_steps || [], fromAsk: it.from_ask || null, next: changing || lane === 'done' || waitsOn === 'checking' ? null : redReady ? FIX_CI : reviewNext || it.next || null,
    branch: it.branch || pr?.headRefName || pushed?.branch || null, pushed: lane === 'done' ? null : pushed,
    ticket: tickets?.source === 'linear' && !it.ticket && it.linear?.length ? null
      : ticketOf(tickets, it.ticket, it.ticket || (wave.internal ? refOf(wave, it, tickets) : it.linear?.[0]), { repo, key }),
    ticketSource: tickets?.source || null,
    linear: (it.linear || []).map((id) => tickets?.source === 'linear' ? ticketBadge(tickets, id, { key, repo }) || linearRef(id, tickets) : linearRef(id, tickets)),
    pr: views[least] || null, prs: views,
    reviewers: reviewers.map((r) => r.name), review: reviewOf(reviewers, pr, sentAt), inReviewSince,
    threadCount: thread.length + events.length, lastTs, othersAt,
    // A Grill tap is handled once it is replied to, questions are posted after it, or a grill agent that started after it finishes.
    grilling: grillRunning || Boolean(lastGrill && !lastGrill.reply && !askedAt.some((t) => String(t) > String(lastGrill.ts))
      && !agents.some((a) => a.kind === 'grill' && a.done && String(a.started) > String(lastGrill.ts))),
    state: it.state || null,
    updatedAt: pr?.mergedAt || pr?.updatedAt || it.merged_at || builder?.at || lastTs || null, ask: null, fold: null, action: null,
    install: lane === 'done' ? null : installOf(it.install, pr),
  };
}

// docs/adr/2026-10-29-1729-a-device-app-card-carries-an-install-link.md
// older: the PR's head has moved past the commit the build came from; unknown heads never read older.
function installOf(install, pr) {
  if (!install?.url) return null;
  const sha = install.sha ? String(install.sha).toLowerCase() : null;
  const head = pr?.headRefOid ? String(pr.headRefOid).toLowerCase() : null;
  return { url: install.url, label: install.label || null, builtAt: install.built_at || null, sha, older: Boolean(sha && head && !head.startsWith(sha)) };
}

// Why GitHub wouldn't merge the PR now, one short reason each; none means approved, CI green (or none) and the merge
// state CLEAN. checks: {state, pending?, failing?: [name]}. board.mjs merge refuses on the same reasons.
export function mergeBlockers(pr) {
  if (pr?.state !== 'OPEN') return [`PR is ${String(pr?.state || 'unknown').toLowerCase()}`];
  const { state, pending, failing } = pr.checks || {};
  return [
    pr.isDraft && 'it is a draft',
    pr.reviewDecision !== 'APPROVED' && `review: ${String(pr.reviewDecision || 'none').toLowerCase().replace(/_/g, ' ')}`,
    state === 'fail' && `failing: ${failing?.length ? failing.join(', ') : 'a check'}`,
    state === 'pending' && `pending: ${pending ? plural(pending, 'check') : 'checks'}`,
    pr.mergeStateStatus !== 'CLEAN' && `merge state: ${String(pr.mergeStateStatus || 'unknown').toLowerCase()}`,
  ].filter(Boolean);
}
const mergeable = (pr) => !mergeBlockers(pr).length;

// What the owner acts on next, or null: {kind, url, label}, url relative to the site root. kind is pick (a prototype
// question), questions, ready (a green draft's Ready on GitHub), done (an ask's Done in its thread), steps (manual
// steps on an approved PR, which the session never merges on its own) or merge (the open card's Merge, while the board's
// auto-merge is off). A held card waits on nobody, and a reopened card waiting only on its Done has no action.
function actionOf(it, questionById, autoMerge) {
  if (it.held || closedLane(it)) return null;
  const thread = `#item=${encodeURIComponent(it.key)}`;
  if (asking(it)) {
    const q = questionById.get(it.questions.first);
    if (PROTOTYPE_URL.test(q?.url || '')) return { kind: ACTION_KIND.pick, url: `questions.html#${q.id}`, label: 'Prototypes ready: pick a take' };
    return { kind: ACTION_KIND.questions, url: `questions.html#${it.questions.first}`, label: `Answer ${plural(it.questions.open, 'question')}` };
  }
  if (it.waitsOn === 'ready') return { kind: ACTION_KIND.ready, url: it.pr.url, label: 'Tap Ready on GitHub' };
  if (it.kind === 'ask' && it.waitsOn === 'owner') return { kind: ACTION_KIND.done, url: thread, label: it.next || TAP_DONE };
  if (it.waitsOn === 'merge' && it.manualSteps.length) return { kind: ACTION_KIND.steps, url: thread, label: 'Run the manual steps, then merge' };
  // docs/adr/2026-10-29-1752-auto-merge-is-a-board-setting-off-by-default.md
  if (it.waitsOn === 'merge' && !autoMerge && !it.merging && it.prs.every((p) => ['MERGED', 'CLOSED'].includes(p.state) || mergeable(p))) return { kind: ACTION_KIND.merge, url: thread, label: 'Merge' };
  return null;
}

const asking = (it) => Boolean(it.questions && it.questions.state !== 'resolved' && it.questions.open > 0);
const ASKING = new Set([ACTION_KIND.pick, ACTION_KIND.questions]);

// The open card's one workflow button, which board/public/app-cards.js only labels: openQuestions while it has open
// questions, held or not, markDone for an ask waiting on the owner's Done, grill otherwise, and none on a Done card or
// on an ask with neither.
function actionButtonOf(it) {
  if (closedLane(it)) return null;
  if (asking(it)) return BUTTON.openQuestions;
  if (it.action?.kind === ACTION_KIND.done) return BUTTON.markDone;
  return it.kind === 'ask' ? null : BUTTON.grill;
}

// docs/adr/2026-11-02-1745-a-todo-card-that-nothing-blocks-has-build.md
// The open card's Build: on a work card still unstarted in Todo, held or not, that waits on nothing from the owner and
// has a take picked on its prototypes (noTakePicked). On a card an unfinished dep blocks, the tap queues the build
// (docs/adr/2026-11-03-0301-build-on-a-blocked-card-queues-it.md).
const buildableOf = (it) => it.kind === 'work' && it.lane === 'todo' && !it.action && !it.unpicked;

// docs/adr/2026-11-03-0504-a-prototype-pick-is-the-builds-go.md
// Whether an answer choosing choice on question q (an owner.json item) is a card's prototype answer that picks none of
// its takes, the owner having cleared the pick to leave only a note.
export const picksNoTake = (q, choice) => /^item:/.test(q.topic || '') && PROTOTYPE_URL.test(q.url || '') && !(q.options || []).some((o) => o.id === choice);
// The newest of card key's answers to its prototype questions and prototype requests on any of its questions
// (ownerQuestion views), when it is a request or an answer that picks none of the takes: the card isn't ready to
// build (docs/adr/2026-11-03-1803-a-question-asked-for-a-prototype-is-resolved.md). → {id, note}, or null.
export function noTakePicked(questions, key) {
  const mine = questions.filter((q) => q.topic === `item:${key}`);
  const inputs = [...mine.filter((q) => PROTOTYPE_URL.test(q.url || '')).flatMap((q) => q.answers.map((a) => ({ q, a, again: picksNoTake(q, a.choice) }))),
    ...mine.filter((q) => q.request).map((q) => ({ q, a: q.request, again: true }))].sort((x, y) => String(x.a.ts).localeCompare(String(y.a.ts)));
  const last = inputs.at(-1);
  return last?.again ? { id: last.q.id, note: last.a.note.replace(/\s+/g, ' ').trim() } : null;
}
// docs/adr/2026-11-03-1646-a-prototype-answer-with-no-pick-prototypes-again.md
// A Todo card's Next while noTakePicked holds it: the card is prototyping, and the next round is its way out.
export const PROTOTYPE_AGAIN = 'Prototype again';

// The open card's button that resolves each action kind, which the board page colours orange: an action button, the
// PR's Review on GitHub, or Merge.
const RESOLVED_BY = Object.freeze({
  [ACTION_KIND.pick]: BUTTON.openQuestions, [ACTION_KIND.questions]: BUTTON.openQuestions, [ACTION_KIND.ready]: BUTTON.github,
  [ACTION_KIND.steps]: BUTTON.github, [ACTION_KIND.merge]: BUTTON.merge, [ACTION_KIND.done]: BUTTON.markDone,
});

// docs/adr/2026-10-29-1639-the-lane-follows-who-acts-next.md
// A card only the owner can move on goes to In Review, apart from a Todo card waiting on its questions, which stays in
// Todo (docs/adr/2026-10-30-1309-an-unstarted-card-waits-on-its-questions-in-todo.md). One Claude still works on, or one already
// waiting on the reviewers, keeps its lane; either way it carries its action. A reopened card that waits only on the
// owner's Done goes to In Review with no action
// (docs/adr/2026-11-03-0137-a-card-waiting-only-to-be-closed-has-no-action-needed.md).
function placeOwnerWait(it, questionById, autoMerge) {
  it.action = actionOf(it, questionById, autoMerge);
  it.awaitsDone &&= !it.action;
  it.actionButton = actionButtonOf(it);
  it.resolvedBy = RESOLVED_BY[it.action?.kind] || null;
  if (it.action?.kind === ACTION_KIND.merge) it.next = OWNER_MERGE_NEXT.ready;
  if (it.awaitsDone) Object.assign(it, { lane: 'review', next: TAP_DONE, bumpable: false, bumpedAt: null });
  const ownerOnly = it.lane === 'todo' || (it.lane === 'progress' && (it.waitsOn === 'ready' || it.waitsOn === 'owner'));
  if (!it.action || !ownerOnly) return;
  const lane = it.lane === 'todo' && ASKING.has(it.action.kind) ? 'todo' : 'review';
  Object.assign(it, { lane, waitsOn: it.waitsOn === 'ready' ? 'ready' : 'owner', next: it.action.label });
  if (lane === 'review') Object.assign(it, { bumpable: false, bumpedAt: null });
}

// docs/adr/2026-10-29-1639-a-started-card-never-returns-to-todo.md
// docs/adr/2026-11-03-0202-a-card-moves-to-in-progress-only-once-building-starts.md
// A work card has started once building has: a build agent's record, running or finished, or a building or fixing
// status. A PR, a pushed branch and checking place it on their own (laneOf). A build the owner queued on a blocked card
// counts too (docs/adr/2026-11-03-0301-build-on-a-blocked-card-queues-it.md).
const started = (it) => it.queued || it.agents.some(builds) || ['building', 'fixing'].includes(String(it.status || '').toLowerCase());

// docs/adr/2026-11-03-0237-an-in-progress-card-always-has-a-builder-line-or-a-next.md
// An In Progress card shows its builder line while a builder record is open, else its Next. buildBoard gives one with
// neither this as its Next; owesNext is store.mjs's check before a write that would leave one so.
export const NO_NEXT = 'none set yet';
// Whether a work item's wave entry and builder records leave its card started with no open record and no Next, where
// nothing else gives it a line or places it: a PR or pushed branch (GitHub or the owner's merge words most of those,
// and buildBoard's gap the rest), checking, a hold, a queued build, whose blockers fill the place, or a finished status.
export function owesNext(item, records) {
  const status = String(item.status || '').toLowerCase();
  if (item.next || hasPR(item) || item.pushed || item.held || item.queued_at || ['held', 'checking', 'done', 'merged', 'dropped'].includes(status)) return false;
  const agents = records.filter((r) => r?.started);
  return !agents.some((r) => !r.done) && started({ status, agents });
}

// An ask is a New card at the top of Todo until Claude replies to it or writes in its thread; then it is an answered ask
// in the Asks section, below Done, with its thread (docs/adr/2026-10-29-1639-the-plus-makes-a-new-card.md,
// docs/adr/2026-11-03-0259-answered-asks-have-their-own-section-below-done.md). An ask that became work or was folded into a card has no card
// of its own: buildBoard leaves it out. msgs is its thread; bumpedAt is its latest ask-bump.
// mark is Claude's latest data/ask-progress.json entry {state, at, next} and doneAt the owner's latest ask-done: the newer
// one decides whether the ask sits in In Progress with a Done button (docs/adr/2026-10-29-1639-an-ask-can-wait-in-progress-until-the-owner-marks-it-done.md).
// A mark with moved is an ask sent to another board on the owner's answer, so it never shows as an answer.
// pending counts its questions (topic item:ask:<event id>) that are open or answered and waiting on Claude: an answered
// ask with either stays in Todo until a mark or the owner's Done closes it, since only Claude's progress mark puts an
// ask in In Progress (docs/adr/2026-10-30-1309-an-unstarted-card-waits-on-its-questions-in-todo.md,
// docs/adr/2026-11-03-0259-answered-asks-have-their-own-section-below-done.md).
// An ask with no ticket is named by when it was asked: the time today, else the short date and time.
function askedLabel(iso, now = new Date()) {
  const d = new Date(iso);
  const at = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === now.toDateString() ? at : `${d.getMonth() + 1}/${d.getDate()} ${at}`;
}
function askItem(e, msgs, bumpedAt, linked, mark, doneAt, pending) {
  const msg = msgs.find((m) => m.kind === 'ask' && m.eventId === e.id);
  const files = msg.files;
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
  const othersAt = [...msgs.filter(countsUnread).map((m) => m.ts), ...msgs.map((m) => m.reply?.at)].filter(Boolean).sort();
  const lastTs = [...msgs.map((m) => m.ts), ...othersAt, ...(inProgress ? [mark.at] : [])].filter(Boolean).sort().pop();
  return {
    key: `ask:${e.id}`, kind: 'ask', order: 0, wave: null, waveTitle: null, id: e.id, ref: handled ? askedLabel(e.ts) : 'New', isNew: !handled, title, status: null,
    internal: false, repo: null, lane: inProgress ? 'progress' : done ? 'asks' : 'todo', waitsOn: inProgress && !ownerPending ? 'owner' : null, builder: null, agents: [], eta: null, working: msgs.some((m) => m.state === 'working'),
    deps: [], held: false, risky: false, bumpable: !handled, bumpedAt: bumped, manualSteps: [], fromAsk: null, from: null, next: inProgress ? mark.next || null : null, hasNotes: false, branch: null,
    finishable: handled && !done,
    linear: [], pr: null, prs: [], reviewers: [], review: {}, inReviewSince: null, progressSince: inProgress ? mark.at || null : null, closedAt: null,
    threadCount: msgs.length, lastTs, othersAt: handled ? othersAt : [], grilling: false, created: e.ts, updatedAt: handled ? lastTs : e.ts,
    ask: { eventId: e.id, state, askedAt: e.ts, bumpedAt: bumped, edited: Boolean(msg.edited), canEdit: !handled, text: msg.text, files, answerAt, from: msg.from || null },
    fold: null, action: null,
  };
}

// Two kinds of agent: planners, the grill and prototype agents, which write no output code, and implementers, every
// other kind. A planner works toward a build, so it never starts a card or puts it in In Progress, and its lines are
// the owner's blue (docs/adr/2026-11-03-0202-a-card-moves-to-in-progress-only-once-building-starts.md,
// docs/adr/2026-11-03-1551-planners-and-implementers-are-two-kinds-of-agent.md).
const PLANNERS = new Set(['grill', 'prototype']);
export const plans = (agent) => PLANNERS.has(agent.kind);
export const builds = (agent) => !plans(agent);

// An item's agents, oldest first, from its records by agent name.
function agentsOf(records = {}) {
  return Object.entries(records).filter(([, r]) => r && typeof r === 'object').map(([name, r]) => ({
    name, kind: providerOf(r.kind) || null, model: r.model || (r.kind === 'opus' || r.kind === 'sonnet' ? r.kind : null), label: r.label || null, started: r.started || null, eta: r.done ? null : r.eta || null, done: r.done || null,
    calls: Array.isArray(r.calls) ? r.calls : [], verified: r.verified || null,
  })).sort((a, b) => String(a.started || '').localeCompare(String(b.started || '')) || a.name.localeCompare(b.name));
}
// The worktree path the newest builder record keeping one names (board/worktree.mjs makeWorktree), or null. The board
// server drops it once land has removed the folder.
function worktreeOf(records = {}) {
  return Object.values(records).filter((r) => r?.worktree?.path).sort((a, b) => String(a.started || '').localeCompare(String(b.started || ''))).at(-1)?.worktree.path ?? null;
}

// An install builder takes precedence so another running agent cannot hide the install's build state. A phased line
// ("Testing: <detail>") reads "Testing · <detail>" on the card; a line with no phase, from builder done's note or from
// before phases, reads as written (docs/adr/2026-11-03-0128-a-builder-status-line-is-a-phase-and-a-short-detail.md). Before the
// first line the card reads preheating, whoever opened the record
// (docs/adr/2026-11-03-1718-a-card-reads-starting-from-its-tap-with-one-dispatched-mark.md). While a build runs, its line wins over a running
// planner's; with only planners running the line is theirs, marked planner
// (docs/adr/2026-11-03-1551-planners-and-implementers-are-two-kinds-of-agent.md).
// The phase the card's latest build reached: its newest phased line since that build started, kept after the build ends,
// never a planner's (docs/adr/2026-11-03-2024-every-in-progress-card-shows-its-phase-bars.md).
function reachedPhaseOf(agents, lines = []) {
  const since = agents.filter(builds).map((a) => String(a.started || '')).filter(Boolean).sort().pop();
  if (since === undefined) return null;
  return lines.filter((m) => m.kind === 'status' && m.phase && !m.planner && String(m.ts) >= since).sort((a, b) => String(a.ts).localeCompare(String(b.ts))).pop()?.phase || null;
}

function builderOf(agents, lines = [], now) {
  const open = agents.filter((a) => a.started && !a.done);
  const planner = open.every(plans);
  const running = planner ? open : open.filter(builds);
  const since = running.map((a) => String(a.started || '')).sort()[0];
  if (since === undefined) return null;
  const line = lines.filter((m) => m.kind === 'status' && String(m.ts) >= since && (planner || !m.planner)).sort((a, b) => String(a.ts).localeCompare(String(b.ts))).pop();
  const kind = running.some((a) => a.kind === BUILDER_KIND.install) ? BUILDER_KIND.install : providerOf(running.at(-1).kind);
  const silentSince = line?.ts || since;
  const progress = line ? (line.phase ? line.text.replace(': ', ' · ') : line.text || null) : null;
  return { progress, phase: line?.phase || null, at: silentSince, kind, planner, silentSince, stalled: now - Date.parse(silentSince) >= BUILDER_STALLED_AFTER };
}

// The model the agent runs: a Claude kind's record holds it as model (opus or sonnet), a record without one reads from its kind.
// Records written before kind became the provider hold kind opus or sonnet, which read as kind claude with that model.
const MODEL_NAMES = { opus: 'Claude Opus', sonnet: 'Claude Sonnet', codex: 'Codex' };
export const modelName = ({ model, kind }) => MODEL_NAMES[model] || MODEL_NAMES[kind] || (kind === 'claude' ? MODEL_NAMES.opus : null);
export const providerOf = (kind) => (kind === 'opus' || kind === 'sonnet' ? 'claude' : kind);

// "Claude Opus implementer", "Claude Sonnet implementer", "Codex benchmarks": the model once, never "Claude Opus · Opus
// implementer" (owner, question int42-agents-look; owner ask on #89). A label's builder reads implementer, since Build
// means the package (docs/adr/2026-11-03-1549-a-todo-cards-button-reads-implement.md). A planner with a model is named by its
// kind: "Claude Sonnet prototype", "Claude Opus grill". A kind that is no model keeps its own word ("Prototype sketch").
function agentName(a) {
  const model = modelName(a);
  const { kind } = a;
  const label = a.label?.replace(/\bbuilder\b/, 'implementer').replace(/\bBuilder\b/, 'Implementer');
  const lower = (t) => t[0].toLowerCase() + t.slice(1);
  if (model && plans(a)) return `${model} ${kind}`;
  if (model) return `${model} ${lower(label?.replace(/^(?:claude\s+)?(?:opus|sonnet|codex)\b\s*/i, '') || 'implementer')}`;
  const k = kind ? kind[0].toUpperCase() + kind.slice(1) : '';
  if (!k) return label || 'Implementer';
  if (!label) return k;
  return label.toLowerCase().includes(kind.toLowerCase()) ? label : `${k} ${lower(label)}`;
}

// docs/adr/2026-11-03-1313-an-answer-stops-waiting-once-its-acted-on.md
// Whether an owner answer at ts is acted on by its question's resolution: resolved, at or after ts when it records when.
const resolvedSince = (q, ts) => Boolean(q.resolved) && (!q.resolved_at || String(q.resolved_at) >= String(ts));
// A question's state: open (no answer yet), answered (waiting for Claude), replied (Claude answered), resolved
// (owner.json sets `resolved` and `resolved_at`). An answer newer than `resolved_at` reopens it; without `resolved_at`
// it stays resolved. Each answer is acted on once the question's resolution covers it. request is the owner's newest
// prototype-request for it after its last answer, which the board server resolves it with
// (docs/adr/2026-11-03-1803-a-question-asked-for-a-prototype-is-resolved.md). answerEvents are owner-answer events and
// requestEvents prototype-request events, oldest first; store.mjs reads their states to close a card's questions.
export function ownerQuestion(q, answerEvents, requestEvents = []) {
  const answers = answerEvents.filter((e) => e.data?.id === q.id);
  const last = answers[answers.length - 1] || null;
  const reopened = Boolean(q.resolved && q.resolved_at && last && String(last.ts) > q.resolved_at);
  const resolved = q.resolved && !reopened;
  const req = requestEvents.filter((e) => e.data?.question === q.id && String(e.ts) > String(last?.ts || '')).at(-1);
  const state = resolved ? 'resolved' : !last ? 'open' : last.reply ? 'replied' : 'answered';
  return { ...q, state, request: req ? { id: req.id, ts: req.ts, note: req.data.note || '', choice: req.data.choice || null } : null,
    answers: answers.map((e) => ({ ts: e.ts, choice: e.data.choice || null, note: e.data.note || '', files: e.data.files || [], reply: e.reply, acted: resolvedSince(q, e.ts) })) };
}

// docs/adr/2026-11-02-1332-a-prototype-round-ends-with-a-one-take-confirm.md
// The prototype round a question belongs to: owner.json's `round`, set by `question add` with `round_of` and on a
// confirm an earlier board opened, else 1 for a question on a prototype page and 0 for any other.
export const roundOf = (q) => q.round ?? (PROTOTYPE_URL.test(q.url || '') ? 1 : 0);
// docs/adr/2026-11-03-0504-a-prototype-pick-is-the-builds-go.md
// The answer that settles round n among a topic's questions (ownerQuestion views): the newest of any answer to a
// confirm an earlier board opened and a question's last answer when it picks one of its takes, its note being the
// build's guidance; undefined while none has.
export function roundSettledBy(qs, n) {
  const settles = (q, a) => q.confirm_of || (q.options || []).some((o) => o.id === a.choice);
  return qs.filter((q) => roundOf(q) === n && q.answers.length).map((q) => [q, q.answers.at(-1)])
    .filter(([q, a]) => settles(q, a)).map(([, a]) => a)
    .sort((x, y) => String(x.ts).localeCompare(String(y.ts))).at(-1);
}
// A topic's latest round: making while a question in it has a request and no later round has arrived, closed once an
// answer settles it, back while one of its questions is unresolved, else none.
function roundState(qs) {
  const req = qs.find((q) => q.request && !qs.some((x) => roundOf(x) > roundOf(q)));
  if (req) return { n: roundOf(req) + 1, state: 'making' };
  const n = Math.max(0, ...qs.map(roundOf));
  if (!n) return null;
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
    return { ...t, state, questions: qs.map((q) => q.id), open: count('open'), answered: count('answered'), replied: count('replied'),
      resolved: count('resolved'), round: roundState(qs) };
  }).filter((t) => t.questions.length);
}

// An item's thread: Claude's and GitHub's lines, the owner's messages and
// buttons from the board, and their answers to the item's questions,
// oldest first. working maps the event ids marked working in data/working.json (bin/wait-events.mjs writes them).
// Each owner message has a state: replied (Claude replied to its event), answered (a Claude line, or the reply to
// the thread's ask, came after it), working (marked, neither yet) or waiting. An item-message still working or
// waiting can be deleted or edited, and shows its latest ask-edited text (docs/adr/2026-10-29-1639-a-pending-ask-can-be-deleted-or-bumped.md)
// with the files each edit sent after its own. An ask's thread
// (key ask:<event id>), and a work item's whose fromAsk names an ask, opens with that ask. links [{key, ref, became}] are the
// work items an ask's thread links to: each adds a link line after the ask, and a linked ask counts as answered.
// moved lists the asks folded into this work item (data/ask-links.json): each shows at its own time, marked moved and
// answered. A work item's thread also takes the owner's messages from its asks' threads; the caller adds their lines.
// agents is the item's builder records by agent name: each adds a line when it started and one when it finished,
// which, like status lines, answer no message.
const ACTION_LABELS = { 'mark-ready': 'Mark ready', 'grill-more': 'Grill please', 'prototype-request': 'Prototype please' };
const actionText = (e, asked) => {
  if (e.kind !== 'prototype-request' || !asked.has(e.data.question)) return e.data.text || routeRecord(ACTION_LABELS, e.kind) || '';
  const q = asked.get(e.data.question);
  const o = (q.options || []).find((x) => x.id === e.data.choice);
  return [`Prototype please:${q.question}`, o && `${o.id}. ${o.label}`, e.data.note].filter(Boolean).join('\n→ ');
};
const claudeAtOf = (msgs) => [...msgs.filter((m) => m.who === 'claude' && m.kind !== 'status' && m.kind !== 'agent').map((m) => m.ts),
  ...msgs.filter((m) => m.kind === 'ask').map((m) => m.reply?.at)].filter(Boolean).map(String).sort().pop() || '';
export function threadOf(key, { lines = [], events = [], owner = {}, working = {}, fromAsk = null, links = [], agents = {}, moved = [] }) {
  const askIds = key.startsWith('ask:') ? [key.slice(4)] : [fromAsk, ...moved].filter(Boolean);
  const keys = new Set([key, ...askIds.map((id) => `ask:${id}`)]);
  const asked = new Map((owner.items || []).filter((q) => q.topic === `item:${key}`).map((q) => [q.id, q]));
  // An answer is acted on, and waits on Claude no more, once its question is resolved after it, a later prototype
  // round names its question (round_of), or a build starts on the card after it.
  const rounded = new Set([...asked.values()].map((q) => q.round_of).filter(Boolean));
  const buildsFrom = agentsOf(agents).filter(builds).map((a) => String(a.started || '')).filter(Boolean);
  const acted = new Set(events.filter((e) => e.kind === 'owner-answer' && asked.has(e.data?.id))
    .filter((e) => resolvedSince(asked.get(e.data.id), e.ts) || rounded.has(e.data.id) || buildsFrom.some((s) => s > String(e.ts))).map((e) => e.id));
  const msgs = [
    // First, so a start sorts above the status line `builder start` writes at the same moment.
    // A planner's lines are marked planner, which the thread draws in the owner's blue.
    ...agentsOf(agents).flatMap((a) => [
      ...(a.started ? [{ ts: a.started, who: 'claude', kind: 'agent', text: `${agentName(a)} started`, finished: false, eta: a.done ? null : a.eta, ...(plans(a) ? { planner: true } : {}) }] : []),
      ...(a.done ? [{ ts: a.done, who: 'claude', kind: 'agent', text: `${agentName(a)} finished`, finished: true, eta: null, ...(plans(a) ? { planner: true } : {}) }] : []),
      // Its judgment calls, one entry under its lines: at its finish, or at its newest call while it runs
      // (docs/adr/2026-11-03-0514-a-builder-records-its-judgment-calls-and-the-session-verifies-them.md).
      ...(a.calls.length ? [{ ts: a.done || a.calls.at(-1).at, who: 'claude', kind: 'calls', text: agentName(a), calls: a.calls.map((c) => c.text), verified: a.verified }] : []),
    ]),
    ...lines.map((m) => ({ ts: m.ts, who: m.who || 'claude', ...(m.kind === 'status' ? { kind: 'status', ...(m.planner ? { planner: true } : {}) } : {}), text: m.text || '', html: m.html || null, link: m.link || null, via: m.via || null })),
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
  const lastClaude = claudeAtOf(msgs);
  const editEvents = events.filter((e) => e.kind === 'ask-edited').sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const edits = new Map(editEvents.map((e) => [e.data?.id, e.data?.text]));
  const editFiles = (id) => editEvents.filter((e) => e.data?.id === id).flatMap((e) => e.data.files || []);
  for (const m of msgs) {
    if (!m.eventId) continue;
    if ((m.kind === 'ask' || m.kind === 'item-message') && typeof edits.get(m.eventId) === 'string') {
      Object.assign(m, { text: edits.get(m.eventId), edited: true, files: [...m.files, ...editFiles(m.eventId)] });
    }
    const linked = m.kind === 'ask' && (links.length > 0 || Boolean(m.moved));
    m.state = m.reply ? 'replied' : linked || acted.has(m.eventId) || lastClaude > String(m.ts) ? 'answered' : routeRecord(working, m.eventId) ? 'working' : 'waiting';
    m.canDelete = m.kind === 'item-message' && (m.state === 'working' || m.state === 'waiting');
    m.canEdit = m.canDelete;
  }
  return msgs;
}

// docs/adr/2026-11-03-1840-waves-are-bands-in-todo.md
// The wave bands in Todo: each open lineup, the owner's wave (docs/adr/2026-11-02-1202-a-wave-the-owner-asks-for-is-a-lineup-of-cards.md),
// then on a board over ~/.claude/waves each unfinished wave file. A lineup is open until finished_at or until all its
// cards are Done. A band's keys are its cards, a lineup's in build order and a wave file's in lane order; next is a
// lineup's first card still in Todo, ready when Implement can start it now, else word says why not. A band's kind is
// lineup or wave (a wave file). Triage runs from the newest wave-triage {<kind>: <slug>} event until that event's
// reply, and its questions use topic <kind>:<slug>. Each lineup card gets `lineup` {slug, title}, an open lineup's over a
// finished one's, which arch-review.mjs archOf counts a review's wave by.
function waveBandsOf(snapshot, waves, lineups, items, questions, events) {
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
  const bands = open.filter((x) => x.open)
    .map(({ l, cards }) => ({ kind: 'lineup', slug: l.slug, title: l.title, goal: l.goal, keys: cards.map((i) => i.key), next: nextOf(cards),
      merged: merged(cards), total: cards.length, triage: triageOf('lineup', l.slug) }));
  if (!snapshot.fromWaves) return bands;
  return [...bands, ...waves.filter((w) => !w.finished).map((w) => ({ w, cards: items.filter((i) => i.wave === w.slug && i.kind !== 'ask') }))
    .filter(({ cards }) => cards.length).map(({ w, cards }) => ({ kind: 'wave', slug: w.slug, title: w.title, goal: null, keys: cards.map((i) => i.key), next: null,
      merged: merged(cards), total: cards.length, triage: triageOf('wave', w.slug) }))];
}
// A lineup's next card: its first still in Todo, and the word for whether Implement can start it.
function nextOf(cards) {
  const it = cards.find((i) => i.lane === 'todo');
  if (!it) return null;
  const ready = it.ready && it.buildable;
  const word = ready ? 'ready' : it.held ? 'held' : it.blockedBy.length ? `waits on ${it.blockedBy.map((d) => d.ref).join(', ')}`
    : it.action ? 'needs you' : it.unsorted ? 'new' : it.state || 'not ready';
  return { key: it.key, ref: it.ref, ready, word };
}

// docs/adr/2026-11-03-1840-waves-are-bands-in-todo.md
// Lineup slug's order once its card key moves by one place (-1 up, 1 down) among the lineup's cards still in Todo,
// which keep the places they hold; started and done cards stay where they are. → the keys in their new order, or null
// when the lineup isn't open or the card is not in Todo or already at that end.
export function lineupMoved(built, slug, key, by) {
  const band = built.waveBands.find((b) => b.kind === 'lineup' && b.slug === slug);
  if (!band) return null;
  const lanes = new Map(built.items.map((i) => [i.key, i.lane]));
  const movable = band.keys.filter((k) => lanes.get(k) === 'todo');
  const from = movable.indexOf(key);
  const to = from + by;
  if (from < 0 || to < 0 || to >= movable.length) return null;
  [movable[from], movable[to]] = [movable[to], movable[from]];
  let at = 0;
  return band.keys.map((k) => (lanes.get(k) === 'todo' ? movable[at++] : k));
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
  // A card's bump counts until a later card-unbump (docs/adr/2026-11-03-0301-build-on-a-blocked-card-queues-it.md).
  const cardUnbumps = latest('card-unbump', 'key');
  const cardBumps = new Map([...latest('card-bump', 'key')].filter(([key, ts]) => !(String(cardUnbumps.get(key) || '') > String(ts))));
  const cardDones = latest('card-done', 'key');
  const cardMerges = latest('card-merge', 'key');
  const autoMerge = snapshot.autoMerge === true;
  const tickets = snapshot.tickets;
  const cardHolds = new Map(events.filter((e) => e.kind === 'card-hold').sort((a, b) => String(a.ts).localeCompare(String(b.ts))).map((e) => [e.data?.key, e]));
  const madeFrom = new Map();
  const askLinks = snapshot.askLinks || {};
  // The asks folded into each work item (docs/adr/2026-10-29-1639-the-plus-makes-a-new-card.md).
  const foldedInto = new Map();
  for (const [id, key] of Object.entries(askLinks)) if (asks.has(id)) foldedInto.set(key, [...(foldedInto.get(key) || []), id]);

  const waves = [];
  const items = [];
  const threadStates = new Map();
  // By card key: when Claude last answered in its thread, and when a Done work card closed.
  const claudeAt = new Map();
  const closedWork = new Map();
  // By work card key: the Parent and Related to keys its wave entry stores (linkCards).
  const storedLinks = new Map();
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
      if (it.from_ask) madeFrom.set(it.from_ask, [...(madeFrom.get(it.from_ask) || []), { key, ref: refOf(wave, it, tickets), became: true }]);
      const msgs = threadOf(key, { lines, events, owner, working, fromAsk: it.from_ask || null, moved: folded });
      for (const m of msgs) if (m.eventId) threadStates.set(m.eventId, m.state);
      claudeAt.set(key, claudeAtOf(msgs));
      items.push(workItem({
        slug, wave, it, order, repo, remote, base: snapshot.branch || 'main',
        prs: cardPRs(it, repo).map((p) => ({ ...p, gh: routeRecord(prs, prKeyOf(p)) || null })),
        ...((agents) => ({ agents, builder: builderOf(agents, routeRecord(threads, key), now), reachedPhase: reachedPhaseOf(agents, routeRecord(threads, key)), eta: agents.map((a) => a.eta).filter(Boolean).sort().pop() || null }))(agentsOf(routeRecord(records, it.id))),
        worktree: worktreeOf(routeRecord(records, it.id)),
        thread: lines,
        events: [...itemEvents.filter((e) => e.data.key === key || askKeys.has(e.data.key)), ...askIds.map((id) => asks.get(id))],
        working: msgs.some((m) => m.state === 'working'),
        said: msgs.filter((m) => m.who === 'love' && (m.kind === 'item-message' || m.kind === 'owner-answer')),
        askedAt: (owner.items || []).filter((q) => q.topic === `item:${key}` && q.asked_at).map((q) => q.asked_at),
        topicItems, boardReviewers: snapshot.reviewers || [], now, bumpedAt: cardBumps.get(key), holdAsk: cardHolds.get(key), closedAt: cardDones.get(key),
        mergeAt: cardMerges.get(key), autoMerge, tickets,
      }));
      const card = items[items.length - 1];
      storedLinks.set(key, { parent: it.parent ? linkKey(slug, it.parent) : null, related: (it.related || []).map((r) => linkKey(slug, r)) });
      if (card.lane === 'done') closedWork.set(key, card.closedAt || String(card.updatedAt || ''));
    });
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
    kind, state: run.state || null, url: kind === 'web' ? null : snapshot.main?.install?.url || null, port: kind === 'web' && run.state === 'ready' ? run.https || null : null,
    // A local board's pull from origin (hub/try.mjs pullMain), which Main's refresh icon shows.
    pull: tries.pull ? { running: tries.pull.running === true, error: tries.pull.error || null } : null } : null;

  const askProgress = snapshot.askProgress || {};
  const askDones = latest('ask-done', 'id');
  const answerEvents = events.filter((e) => e.kind === 'owner-answer');
  const requestEvents = events.filter((e) => e.kind === 'prototype-request');
  const questions = (owner.items || []).map((q) => ownerQuestion(q, answerEvents, requestEvents));
  const pendingOn = (topic) => {
    const qs = questions.filter((q) => q.topic === topic);
    return { open: qs.filter((q) => q.state === 'open').length, answered: qs.filter((q) => q.state === 'answered').length };
  };
  for (const e of asks.values()) {
    const key = `ask:${e.id}`;
    const related = works.get(routeRecord(askLinks, e.id));
    const links = [...(madeFrom.get(e.id) || [])];
    if (related && !links.some((l) => l.key === related.key)) links.push({ key: related.key, ref: related.ref, became: false });
    if (links.length) { moved.set(key, links[0].key); continue; }
    const msgs = threadOf(key, { lines: routeRecord(threads, key) || [], events, working, links });
    for (const m of msgs) if (m.eventId) threadStates.set(m.eventId, m.state);
    claudeAt.set(key, claudeAtOf(msgs));
    items.push(askItem(e, msgs, bumps.get(e.id), links.length > 0 || Boolean(routeRecord(askLinks, e.id)), routeRecord(askProgress, e.id), askDones.get(e.id), pendingOn(`item:${key}`)));
  }
  for (const w of waves) {
    const cards = items.filter((i) => i.wave === w.slug);
    w.finished = finishedOf(cards);
    if (w.finished) for (const i of cards) if (i.lane === 'done') i.fold = waveFold(w.slug);
  }
  for (const i of items) i.lineup = null;
  const declared = new Set((owner.topics || []).map((t) => t.id));
  const lineups = snapshot.waves.flatMap(({ slug, wave }) => (wave.lineups || []).map((l) => ({ ...l, keys: l.items.map((id) => `${slug}/${id}`) })));
  const topicsOf = () => ownerTopics([...(owner.topics || []), ...items.filter((it) => !declared.has(`item:${it.key}`))
    .map((it) => ({ id: `item:${it.key}`, title: `${it.ref}: ${it.title}`, ...(it.kind === 'ask' ? { askedAt: it.ask.askedAt } : {}), summary: 'Questions about this work item.' })),
  ...lineups.filter((l) => !declared.has(`lineup:${l.slug}`)).map((l) => ({ id: `lineup:${l.slug}`, title: l.title, summary: 'Wave triage.' })),
  ...(snapshot.fromWaves ? waves : []).filter((w) => !declared.has(`wave:${w.slug}`)).map((w) => ({ id: `wave:${w.slug}`, title: w.title, summary: 'Wave triage.' }))], questions,
  new Set(items.filter(closedLane).map((it) => `item:${it.key}`)));
  const itemTopics = new Map(topicsOf().map((t) => [t.id, t]));
  for (const it of items) {
    const t = itemTopics.get(`item:${it.key}`);
    if (!t) { it.questions = null; continue; }
    const pending = t.questions.filter((id) => questions.find((q) => q.id === id)?.state !== 'resolved');
    const first = t.questions.find((id) => questions.find((q) => q.id === id)?.state === 'open') || pending[0] || t.questions[0];
    it.questions = { topic: t.id, state: t.state, open: t.open, answered: t.answered, replied: t.replied, resolved: t.resolved, first };
  }
  // A card waits on each dep until it reaches Done, which a reopened dep still counts as, and a Done card waits on nothing (docs/adr/2026-10-29-1639-cards-wait-on-explicit-blocked-by-links.md).
  const byKey = new Map(items.map((i) => [i.key, i]));
  const questionById = new Map(questions.map((q) => [q.id, q]));
  for (const it of items) {
    it.blockedBy = it.kind !== 'work' || it.lane === 'done' ? [] : it.deps.map((d) => byKey.get(String(d).includes('/') ? d : `${it.wave}/${d}`))
      .filter((d) => d && d.lane !== 'done' && !d.reopened).map(linkOf);
    placeOwnerWait(it, questionById, autoMerge);
    if (it.lane === 'todo' && it.kind === 'work' && !it.held && started(it)) it.lane = 'progress';
    it.unpicked = it.kind === 'work' && it.lane === 'todo' && Boolean(noTakePicked(questions, it.key));
    if (it.unpicked) it.state = 'prototyping';
    if (it.unpicked && !it.action) it.next = PROTOTYPE_AGAIN;
    it.buildable = buildableOf(it);
    // docs/adr/2026-11-03-0516-a-new-card-is-ready-grilling-or-prototyping.md: an unstarted card from an ask reads New until its
    // session sets its state, and ready once Ready with nothing blocking it or waiting on the owner.
    const unstarted = it.kind === 'work' && it.lane === 'todo';
    it.unsorted = unstarted && Boolean(it.fromAsk) && !it.state;
    it.ready = unstarted && it.state === 'ready' && !it.blockedBy.length && !it.action;
    it.sortAt = SORT_AT[it.lane](it) || it.updatedAt || null;
  }
  linkCards(items, byKey, storedLinks);
  // Items arrive in the order the page shows them (public/ui-order.js).
  items.sort(laneOrder);

  const waveBands = waveBandsOf(snapshot, waves, lineups, items, questions, events);
  // Built again after the sort, so the item topics follow the lanes' order.
  const topicList = topicsOf();
  const reviews = reviewsOf({ on: snapshot.autoReview, incoming: snapshot.incoming, records: snapshot.reviewRecords, events, now,
    refs: new Map(items.filter((i) => i.kind === 'work').map((i) => [i.key, i.ref])) });
  const needs = [...promptLines(snapshot.prompts), ...needsOf(items, topicList, questions), ...reviewNeeds(reviews)];
  // A marked event works until Claude answers it: a reply, a later Claude line in its card's thread or a reply to that
  // card's ask, its ask becoming or folding into a card, or its card leaving the board or closing after the mark. An
  // event on no card works until its reply.
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
    return [cardDones.get(key), id && askDones.get(id), done, closedWork.get(key)].filter(Boolean).sort().pop() || '';
  };
  const unanswered = (e) => {
    const card = cardOf(e);
    if (card === null) return !e.reply;
    if (!byKey.has(card) || !(closedAt(card) < String(routeRecord(working, e.id)))) return false;
    if (threadStates.has(e.id)) return threadStates.get(e.id) === 'working';
    return !e.reply && !moved.has(ownCardOf(e)) && !(String(claudeAt.get(card) || '') > String(e.ts));
  };
  const workingOn = events.filter((e) => routeRecord(working, e.id) && unanswered(e))
    .map((e) => ({ id: e.id, kind: e.kind, key: cardOf(e), data: e.data, since: routeRecord(working, e.id) }));
  for (const it of items) {
    it.working = workingOn.some((w) => w.key === it.key);
    if (it.kind === 'work' && it.lane === 'progress' && !it.builder && !it.next && it.waitsOn !== 'checking' && !it.working && !it.queued) it.next = NO_NEXT;
  }
  // The page shows those this browser hasn't seen in the answer banner (docs/adr/2026-10-29-1639-every-ask-is-a-card.md).
  const answers = items.filter((i) => i.ask?.answerAt).sort((a, b) => b.ask.answerAt.localeCompare(a.ask.answerAt))
    .map((i) => ({ key: i.key, id: i.id, text: i.title, at: i.ask.answerAt }));
  return { kind, main, remote: remote && { host: remote.host, name: `${remote.host}/${remote.path}` }, waves, waveBands, items, moved: Object.fromEntries(moved), answers, owner: questions, ownerTopics: topicList, reviews, needs, needsSummary: needsSummary(needs), working: workingOn.length, workingOn, checks: checksOf(snapshot, now) };
}

// docs/adr/2026-11-03-0526-a-follow-up-is-a-work-card-with-a-parent.md
// A card's links name other cards by {key, ref}. A wave entry stores its Parent and Related to as keys, a bare id
// naming a card of its own wave, as deps do.
const linkOf = (card) => ({ key: card.key, ref: card.ref });
const linkKey = (slug, k) => (String(k).includes('/') ? String(k) : `${slug}/${k}`);
const byRef = (a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true });
// Each work card's Parent (one card or none; a Parent no longer on the board reads as its stored id), its Children
// (the cards whose Parent it is), its Related to (set on either card, shown on both) and what Waits on it (the cards
// it blocks, the mirror of blockedBy). A card with a Parent is a follow-up.
function linkCards(items, byKey, stored) {
  const children = new Map();
  const related = new Map();
  const waits = new Map();
  const add = (map, key, card) => map.set(key, [...(map.get(key) || []), card]);
  for (const [key, links] of stored) {
    if (links.parent) add(children, links.parent, key);
    for (const r of links.related) if (r !== key) { add(related, key, r); add(related, r, key); }
  }
  for (const it of items) for (const d of it.blockedBy || []) add(waits, d.key, it.key);
  const cards = (keys = []) => [...new Set(keys)].map((k) => byKey.get(k)).filter(Boolean).map(linkOf).sort(byRef);
  for (const it of items) {
    const parent = stored.get(it.key)?.parent;
    it.parent = parent ? { key: parent, ref: byKey.get(parent)?.ref || parent.slice(parent.indexOf('/') + 1) } : null;
    it.children = cards(children.get(it.key));
    it.related = cards(related.get(it.key));
    it.waitsOnIt = cards(waits.get(it.key));
  }
}

// docs/adr/2026-11-03-0223-each-lane-has-one-fixed-order.md
// The time each lane sorts by, newest first: Todo when the card was made, In Progress and In Review (Stale too) when it
// came into the lane, Done when it closed, and Asks when Claude answered. A card with none falls back to its latest activity.
const SORT_AT = {
  todo: (i) => i.created, progress: (i) => i.progressSince, review: (i) => i.inReviewSince, stale: (i) => i.inReviewSince,
  done: (i) => i.closedAt, asks: (i) => i.ask.answerAt,
};

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// checked is data/checked.json {at, every (minutes), idle?}, listen whether the board hears its events
// (hub/boards.mjs listenState), watcher data/watcher.json {since} or null, replyAt the newest reply file's time
// (docs/adr/2026-10-29-1639-the-board-shows-github-checks-and-watcher-health.md). claudeAt is the newest write of Claude's the
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
    watcher: { listening: 'running', asleep: 'asleep', waking: 'waking' }[listen] || 'stopped', claudeAt,
  };
}

// Needs you: one line per topic not tied to an item with open questions, then one per item with open
// questions or a draft waiting on Ready. Answered questions wait on Claude, so they don't count, and a
// held item waits on nobody, so it has no line.
// {kind, text, url} is the GET /_claude/needs contract (docs/adr/2026-10-29-1639-sites-report-what-waits-through-claude-needs.md);
// url is relative to the site root.
function needsOf(items, topics, questions) {
  const onItems = new Set(items.map((it) => it.questions?.topic).filter(Boolean));
  const firstOpen = (ids) => ids.find((id) => questions.find((q) => q.id === id)?.state === 'open') || ids[0];
  const fromTopics = topics.filter((t) => t.state !== 'resolved' && t.open > 0 && !onItems.has(t.id)).map((t) => {
    const url = `questions.html#${firstOpen(t.questions)}`;
    const band = /^(?:lineup|wave):(.+)$/.exec(t.id)?.[1] || null;
    return { kind: 'Question', title: t.title, text: `${t.title} · ${plural(t.open, 'question')}`, url, topic: t.id, band, questions: { open: t.open, url }, ready: null };
  });
  const fromItems = items.filter((it) => !it.held).map((it) => {
    const asking = it.questions && it.questions.state !== 'resolved' && it.questions.open > 0 ? { open: it.questions.open, url: `questions.html#${it.questions.first}` } : null;
    const ready = it.waitsOn === 'ready' ? it.pr.url : null;
    // docs/adr/2026-10-29-1639-the-lane-follows-who-acts-next.md: every card with Action needed gets a line.
    const other = !asking && !ready && it.action ? { label: it.action.label, url: it.action.url } : null;
    if (!asking && !ready && !other) return null;
    const title = `${it.ref}: ${it.title}`;
    const text = [title, asking && plural(asking.open, 'question'), ready && 'Ready on GitHub', other?.label].filter(Boolean).join(' · ');
    return { kind: asking ? 'Question' : ready ? 'Tap Ready' : 'Action needed', title, text, url: `#item=${encodeURIComponent(it.key)}`, key: it.key, questions: asking, ready, action: other };
  }).filter(Boolean);
  return [...fromTopics, ...fromItems];
}

// The board session's pending prompts lead Needs you, since each holds the session until the owner answers it there
// (../hub/prompts.mjs shown; docs/adr/2026-10-30-1516-background-sessions-prompts-come-to-the-phone.md).
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
  const reviews = needs.filter((line) => line.review).length;
  return [prompts && plural(prompts, 'prompt'), questions && plural(questions, 'question'), drafts && `${plural(drafts, 'draft')} waiting on Ready`,
    reviews && `${plural(reviews, 'review')} held`].filter(Boolean).join(' · ');
}

// The GET /_claude/needs body for a built board (docs/adr/2026-10-29-1639-sites-report-what-waits-through-claude-needs.md).
// A Stale card is a PR still in review, so it counts as review.
export function needsAnswer(b) {
  const count = (...lanes) => b.items.filter((i) => lanes.includes(i.lane)).length;
  return {
    items: b.needs.map(({ kind, text, url }) => ({ kind, text, url })), working: b.working, summary: b.needsSummary,
    lanes: { review: count('review', 'stale'), progress: count('progress'), todo: count('todo') },
    building: b.items.some((i) => (i.agents || []).some((a) => !a.done)),
  };
}

// docs/adr/2026-11-02-1754-an-idle-board-pulls-in-its-top-todo-card.md
// For built items in board order: idle while no card has a running build and none waits in Orchestrator review, a
// running planner counting as no work (docs/adr/2026-11-03-1551-planners-and-implementers-are-two-kinds-of-agent.md);
// pullable lists the buildable cards nothing blocks, with no questions, no grill under way and no message a
// session is working on, taking only cards with state ready, in board order
// (docs/adr/2026-11-03-0516-a-new-card-is-ready-grilling-or-prototyping.md, docs/adr/2026-11-03-1631-the-idle-pull-takes-ready-cards-first.md). plannable lists, top first, the buildable cards
// not set ready, and the cards prototyping again with nothing waiting on the owner
// (docs/adr/2026-11-03-1646-a-prototype-answer-with-no-pick-prototypes-again.md), that aren't held, with no planner running, no grill under way, no question waiting on the owner or on
// Claude and no message a session is working on; empty while any card has a grill under way or a planner running.
export function pullOf(items) {
  const open = items.filter((i) => !closedLane(i));
  const running = (i) => (i.agents || []).filter((a) => !a.done);
  const idle = !open.some((i) => i.waitsOn === 'checking' || running(i).some(builds));
  const pullable = open.filter((i) => i.buildable && i.state === 'ready' && !i.unsorted && !i.blockedBy.length && !i.questions && !i.grilling && !i.working).map((i) => i.key);
  const planning = open.some((i) => i.grilling || running(i).some(plans));
  const plannable = planning ? [] : open.filter((i) => (i.buildable || (i.unpicked && !i.action)) && i.state !== 'ready' && !i.held && !i.questions?.open && !i.questions?.answered && !i.working).map((i) => i.key);
  return { idle, pullable, plannable };
}

// docs/adr/2026-11-03-1551-an-idle-board-triages-its-todo-once-a-day.md
// For built items: the Todo a triage looks at, one line per Todo card with its key, title and deps, sorted, so a card
// added, dropped, renamed or relinked changes it. '' when Todo is empty.
export function todoOf(items) {
  return items.filter((i) => i.lane === 'todo').map((i) => JSON.stringify([i.key, i.title, i.deps || []])).sort().join('\n');
}

// The push tag tied to a card's thread: ask-<event id> for ask:<event id>, item-<wave>/<id> for a work item.
export const pushTag = (key) => (key.startsWith('ask:') ? `ask-${key.slice(4)}` : `item-${key}`);

// docs/adr/2026-11-03-0003-the-board-records-what-it-knows-and-commands-make-the-rule-calls.md
// What waits on the owner in a built board, one entry per push tag: each card with Action needed (pushTag), each
// Needs you line for a topic off the cards, tagged topic-<id>, and each held review, tagged review-<PR number>. questions are the open questions behind it, oldest
// first. now: questions, picks, manual steps and a Done push at once; Ready and Merge queue for the tick's end.
// url is relative to the site root. → [{tag, kind, title, body, url, now, questions: [{id, question}]}]
export function ownerActions(built) {
  const open = (topic) => built.owner.filter((q) => q.topic === topic && q.state === 'open').map(({ id, question }) => ({ id, question }));
  const queued = [ACTION_KIND.ready, ACTION_KIND.merge];
  const cards = built.items.filter((it) => it.action).map((it) => {
    const questions = ASKING.has(it.action.kind) ? open(it.questions.topic) : [];
    return { tag: pushTag(it.key), kind: it.action.kind, title: `${it.ref}: ${it.action.label}`, body: questions[0]?.question || it.title,
      url: questions.length ? it.action.url : `#item=${encodeURIComponent(it.key)}`, now: !queued.includes(it.action.kind), questions };
  });
  const topics = built.needs.filter((line) => line.topic).map((line) => {
    const questions = open(line.topic);
    return { tag: `topic-${line.topic}`, kind: ACTION_KIND.questions, title: line.text, body: questions[0]?.question || line.title, url: line.url, now: true, questions };
  });
  return [...cards, ...topics, ...reviewActions(built.reviews)];
}

// docs/adr/2026-11-03-0003-the-board-records-what-it-knows-and-commands-make-the-rule-calls.md
// The card an owner answer to question id left ready to start: an unstarted work card, not held, that nothing blocks,
// with no open question, a take picked on its prototypes and nothing else waiting on the owner. → its key, or null.
export function startedByAnswer(built, id) {
  const q = built.owner.find((x) => x.id === id);
  const key = /^item:([^/:]+\/[^/]+)$/.exec(q?.topic || '')?.[1];
  const it = key && built.items.find((i) => i.key === key);
  if (!it || it.kind !== 'work' || it.lane === 'done' || it.held || it.blockedBy.length || it.action || it.unpicked || it.pr || it.pushed) return null;
  if (![null, 'planned', 'waiting'].includes(it.status) || it.agents.some((a) => !a.done)) return null;
  return built.owner.some((x) => x.topic === q.topic && x.state === 'open') ? null : key;
}
