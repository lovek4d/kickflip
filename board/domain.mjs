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
import { prLinks, reviewLinks, reviewTime, reviewersOf } from './review.mjs';
import { remoteFromInput } from '../hub/repos.mjs';
import { reviewsOf, reviewNeeds, reviewActions } from './auto-review.mjs';
import { cardPRs, hasPR, leastReady, prKeyOf, prURL } from '../shared/card-prs.mjs';
import vm from 'node:vm';
import { checkWords, parseCheck } from '../shared/owner-check.mjs';
import { buildScriptOf } from './build-script.mjs';

// Page scripts with no exports, which the page loads as is, so node runs them the same way.
const enums = vm.createContext({});
for (const file of ['ui-enums.js', 'ui-order.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), enums);
export const { BUTTON, ACTION_KIND, BUILDER_KIND, PR_STATE } = enums.BoardUI;
const { laneOrder } = enums.BoardUI;

export const ITEM_EVENTS = ['item-message', 'mark-ready', 'grill-more', 'prototype-request', 'visual-request', 'reask-request'];
// The owner's tap on a sent question's Resolved badge, {key?, question}: the question opens again (ownerQuestion), and
// its card's thread reads "Question N was reopened". A record-only event, which wakes no session.
export const QUESTION_REOPEN = 'question-reopen';
export const ITEM_STATUSES = ['building', 'fixing', 'checking', 'held', 'merged', 'done', 'dropped'];
export const BUILDER_STALLED_AFTER = 10 * 60000;
// How long a headless builder whose process lives may go without a status line or transcript movement before it reads
// quiet (docs/adr/2026-11-05-0410-a-card-status-word-comes-from-a-signal-the-board-checks.md).
export const BUILDER_QUIET_AFTER = 5 * 60000;
// The thread line's kind for a Build tap the board server refused (store.mjs startTappedBuild).
export const BUILD_REFUSED = 'build-refused';
// The thread line kinds of a builder's ask and the orchestrator's answer or deferral of it (store.mjs askOrchestrator).
export const BUILDER_ASK = Object.freeze({ ask: 'builder-ask', answer: 'builder-answer' });
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
// A reopened card has left Done whatever its PR's state. An open PR is In Review, a draft too whatever its CI, apart
// from red CI on a PR the board marks ready itself, which goes back to Claude: one out of draft, or a draft while the
// board skips the draft (docs/adr/2026-11-04-1913-a-board-can-skip-the-draft.md). A card the board's rebase run works on
// (rebasing) stays in its open PR's lane while the run builds and once it hands back
// (docs/adr/2026-11-06-0200-the-board-rebases-a-conflicting-pr-with-a-headless-run.md).
function laneOf(item, pr, running, pushed, reopened, skipDraft, rebasing) {
  const s = (item.status || '').toLowerCase();
  if (s === 'merged' || s === 'done' || s === 'dropped' || (!reopened && (pr?.state === 'MERGED' || pr?.state === 'CLOSED'))) return 'done';
  if ((running || s === 'checking') && !rebasing) return 'progress';
  if (pushed) return 'review';
  if (pr?.state === 'OPEN') return pr.checks?.state === 'fail' && (!pr.isDraft || skipDraft) ? 'progress' : 'review';
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

// What the card waits on: the owning session's check of finished work, the builder, the owner's merge of a pushed
// branch, the owner's review of a draft and Ready on GitHub, the CI before the board marks a draft ready itself, the
// reviewers, the merge once GitHub counts it approved, or nothing. buildBoard sets `owner` for the owner's other waits.
// A verified branch held for the owner's Merge waits on the merge, and so does a ready PR on a card no reviewer is on
// (docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md).
function waitsOnOf(lane, pr, builder, status, pushed, skipDraft, { held, needsApproval }) {
  if (builder?.kind === BUILDER_KIND.install) return 'builder';
  if (status === 'checking') return 'checking';
  if (builder) return 'builder';
  if (held && lane === 'review') return 'merge';
  if (pushed && lane === 'review') return 'owner';
  if (lane === 'review' && pr?.state === 'OPEN' && pr.isDraft) return skipDraft ? 'ci' : 'ready';
  if (lane === 'review' || lane === 'stale') return reviewed(pr, needsApproval) ? 'merge' : 'reviewers';
  return null;
}

// Whether a PR's review lets it merge: approved, or on a card no reviewer is on, GitHub asking for no review or changes.
const reviewed = (pr, needsApproval) => pr?.reviewDecision === 'APPROVED' || (!needsApproval && !['REVIEW_REQUIRED', 'CHANGES_REQUESTED'].includes(pr?.reviewDecision));

// A done card has no next step, whatever its wave file's `next` still says.
// A card whose PR is ready for review reads its next step from GitHub, never from the wave file's `next`, and a card
// waiting on the owner reads its action. While its PR is changing, the builder line takes the place of a next step.
const PROTOTYPE_URL = /(^|\/)prototype-[\w-]+\.html/;
const REVIEW_NEXT = { reviewers: 'Waiting for PR reviewers', merge: 'Approved, merges once CI and the merge state allow', ci: 'Marked ready for review once CI passes' };
// docs/adr/2026-10-29-1752-auto-merge-is-a-board-setting-off-by-default.md
const OWNER_MERGE_NEXT = { waiting: 'Approved, Merge shows once CI and the merge state allow', ready: 'Approved and green: tap Merge', merging: 'Merging' };
// docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md: a ready PR on a card no reviewer is on, and a held branch.
const UNREVIEWED_MERGE_NEXT = { auto: 'Ready, merges once CI and the merge state allow', waiting: 'Ready, Merge shows once CI and the merge state allow', ready: 'Ready and green: tap Merge' };
const heldNext = (base) => `Verified: tap Merge to land it on ${base}`;
const FIX_CI = 'Fix the failing CI';
const TAP_DONE = 'Tap Done once it is settled';

// Only Claude's and GitHub's messages are ever unread, and replies, which are Claude's; never the owner's lines,
// their answers included, nor status, agent or ask-link lines, nor the orchestrator's answer to a builder's ask, which
// leaves the card quiet (ui-threads.js unread; docs/adr/2026-11-04-0247-a-builder-asks-the-orchestrator-mid-build.md).
const QUIET_KINDS = ['status', 'agent', 'ask-link', BUILDER_ASK.answer];
const countsUnread = (m) => (m.who === 'claude' || m.via === 'github') && !QUIET_KINDS.includes(m.kind);

// said is the owner's messages and answers in the card's thread (threadOf), and askedAt the asked_at of its questions.
// prs is the card's PRs, [{repo, number, gh}], gh being GitHub's state or null before it is read; the least-ready one
// decides the lane, what it waits on and its Next (docs/adr/2026-11-03-1904-a-card-holds-several-prs-across-repos.md).
const LANDER_HANDOFF = /^(?:Not merged yet: |Lander launched headless )/;
function workItem({ slug, wave, it, order, prs, repo, remote, base, builder, reachedPhase, agents, worktree, eta, thread, events, working, said, askedAt, topicItems, prSlack, boardReviewers, now, bumpedAt, holdAsk, closedAt, mergeAt, autoMerge, skipDraft, tickets }) {
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
  // docs/adr/2026-11-04-0158-a-card-whose-code-landed-stays-in-review-while-an-owner-step-remains.md: the owner step holds a card whose code landed (done, merged, or its PR merged) in In
  // Review until the owner's Done.
  const ownerStep = it.owner_step && !tappedDone && it.status !== 'dropped' ? String(it.owner_step) : null;
  const landed = ['done', 'merged'].includes(it.status) || prStatus === PR_STATE.merged;
  if (reopenAt) it = { ...it, status: undefined, next: undefined };
  const ownerPending = Boolean(reopenAt) && said.some((m) => String(m.ts) > doneAt && (m.state === 'waiting' || m.state === 'working'));
  const key = `${slug}/${it.id}`;
  const reviewers = reviewersOf(wave, boardReviewers);
  const sentAt = Object.fromEntries(Object.entries(reviewLinks(wave, it, key, topicItems, prLinks(prSlack, prs))).map(([name, link]) => [name, reviewTime(link.ts)]));
  const inReviewSince = Object.values(sentAt).filter(Boolean).sort()[0] || null;
  const lastTs = [...thread.map((m) => m.ts), ...events.map((e) => e.ts)].sort().pop() || null;
  // A builder status line is progress, not a message: it is never unread and answers no owner message.
  const othersAt = [...thread.filter((m) => countsUnread({ ...m, who: m.who || 'claude' })).map((m) => m.ts), ...events.map((e) => e.reply?.at)].filter(Boolean).sort();
  // A branch pushed to a plain git remote, which has no PR (docs/adr/2026-11-02-1850-a-board-can-work-on-any-git-remote.md).
  const pushed = !hasPR(it) && it.pushed?.branch ? { branch: it.pushed.branch, at: it.pushed.at || null, host: remote?.host || null } : null;
  // A verified branch waiting for the owner's Merge (docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md).
  const mergeReady = !hasPR(it) && it.merge_ready?.branch ? { branch: it.merge_ready.branch, at: it.merge_ready.at || null, base } : null;
  // docs/adr/2026-11-06-0200-the-board-rebases-a-conflicting-pr-with-a-headless-run.md: the run the server started
  // (rebase_run) until its push, and the push it made (rebased), while that is still the PR's head.
  const rebasing = Boolean(it.rebase_run) && pr?.state === 'OPEN';
  const lastRebase = (it.rebased || []).at(-1);
  let lane = laneOf(it, pr, agents.some((a) => a.started && !a.done && builds(a)), pushed || mergeReady, Boolean(reopenAt), skipDraft, rebasing);
  if (reopenAt && lane === 'todo') lane = 'progress';
  if (lane === 'review' && inReviewSince && now - Date.parse(inReviewSince) > STALE_AFTER) lane = 'stale';
  const stepWaits = Boolean(ownerStep) && landed && lane === 'done';
  if (stepWaits) lane = 'review';
  let waitsOn = waitsOnOf(lane, pr, builder, (it.status || '').toLowerCase(), pushed, skipDraft, { held: mergeReady, needsApproval: reviewers.length > 0 });
  const changing = waitsOn === 'builder' && pr?.state === 'OPEN' && !pr.isDraft;
  const redReady = lane === 'progress' && !waitsOn && pr?.state === 'OPEN' && (!pr.isDraft || skipDraft);
  // A reopened card Claude has answered waits on the owner's Done.
  const awaitsDone = stepWaits || (Boolean(reopenAt) && lane === 'progress' && !waitsOn && !redReady && !ownerPending);
  if (awaitsDone) waitsOn = 'owner';
  const tapped = holdAsk && String(holdAsk.ts) > String(it.held_at || '');
  // Only a Todo card reads held; old data can't show one in Done.
  const held = lane === 'todo' && (tapped ? Boolean(holdAsk.data.hold) : it.status === 'held' || Boolean(it.held));
  // docs/adr/2026-11-02-1727-a-card-can-be-held-until-a-time.md
  const heldUntil = held ? (tapped ? holdAsk.data.until : it.pick_up_at) || null : null;
  // docs/adr/2026-10-29-1639-a-card-that-hasnt-started-can-be-bumped.md
  const bumpable = lane === 'todo' || lane === 'progress';
  // A bump made before the card's first build started clears when that build starts.
  const firstBuild = agents.filter(builds).map((a) => String(a.started || '')).filter(Boolean).sort()[0] || '';
  const bumpStands = bumpedAt && !(firstBuild && String(bumpedAt) < firstBuild);
  // The owner's Merge waits on the session until it merges or writes in the thread, such as why it can't merge yet.
  // A held Merge handed to a lander (finish.mjs landHeld) is still merging: the card leaves In Review once the lander starts.
  const lastClaudeAt = thread.filter((m) => (m.who || 'claude') === 'claude' && m.kind !== 'status' && !LANDER_HANDOFF.test(m.text || '')).map((m) => String(m.ts)).sort().pop() || '';
  // A held card's tap is recorded on it (store.mjs tapMerge), and the board server's land writes its outcome there.
  const tappedAt = [mergeAt, mergeReady && it.merge_ready.tapped].filter(Boolean).map(String).sort().pop();
  const merging = waitsOn === 'merge' && Boolean(tappedAt) && tappedAt > lastClaudeAt;
  // docs/adr/2026-11-04-2320-a-merge-tap-waits-its-turn-to-land.md: a tap queued behind another land says so in a status line.
  const lastStatus = thread.filter((m) => m.kind === 'status' && String(m.ts) > String(tappedAt)).sort((a, b) => String(a.ts).localeCompare(String(b.ts))).at(-1);
  const mergingNext = lastStatus?.text.startsWith('Waiting for ') ? `${OWNER_MERGE_NEXT.merging} · ${lastStatus.text[0].toLowerCase()}${lastStatus.text.slice(1)}` : OWNER_MERGE_NEXT.merging;
  // A Build tap the board refused: its reason stays on a Todo card while it is the card's newest line
  // (docs/adr/2026-11-03-0219-a-build-tap-starts-the-build-in-the-board-server.md).
  const newest = thread.filter((m) => m.kind !== 'status').sort((a, b) => String(a.ts).localeCompare(String(b.ts))).at(-1);
  const refusal = lane === 'todo' && newest?.kind === BUILD_REFUSED ? newest.text : null;
  // docs/adr/2026-11-03-0223-each-lane-has-one-fixed-order.md
  // When the card last came into In Progress: its reopening, else its latest build agent's start, else its status change.
  const progressSince = reopenAt || agents.filter(builds).map((a) => a.started).filter(Boolean).map(String).sort().pop()
    || (['building', 'fixing', 'checking'].includes(String(it.status || '').toLowerCase()) ? it.status_at || null : null);
  const approved = pr?.reviewDecision === 'APPROVED';
  const reviewNext = pushed && waitsOn === 'owner' ? `merge ${pushed.branch} into ${base}`
    : mergeReady && waitsOn === 'merge' ? (merging ? mergingNext : heldNext(base))
    : waitsOn === 'merge' && !autoMerge ? (merging ? mergingNext : (approved ? OWNER_MERGE_NEXT : UNREVIEWED_MERGE_NEXT).waiting)
    : waitsOn === 'merge' && !approved ? UNREVIEWED_MERGE_NEXT.auto : REVIEW_NEXT[waitsOn];
  // A draft PR waits on the owner's review of it, unless the card was given a Next.
  const draftNext = prStatus === PR_STATE.draft ? `Review draft PR #${views[least].number}` : null;
  const rebasedNext = !rebasing && lastRebase?.to && lastRebase.to === pr?.headRefOid
    ? `Rebased onto ${lastRebase.base || base}, pushed${pr.mergeable === 'MERGEABLE' ? ' · PR is clean again' : ''}` : null;
  // A rebase run that handed back: its newest judgment call says why (headless.mjs rebaseBrief).
  const rebaseFailed = rebasing && waitsOn === 'checking'
    ? agents.flatMap((a) => a.calls).sort((a, b) => String(a.at).localeCompare(String(b.at))).at(-1)?.text ?? null : null;
  return {
    key, kind: 'work', order, wave: slug, waveTitle: wave.title || slug, id: it.id, ref: refOf(wave, it, tickets), title: it.title, status: it.status || null,
    created: it.created || null, reviewSince: it.review_since || inReviewSince || it.merge_ready?.at || it.pushed?.at || it.created || null, progressSince, closedAt: lane === 'done' ? closed : null,
    internal: wave.internal === true, repo: wave.internal === true && !wave.repo ? null : repo,
    lane, waitsOn, builder: waitsOn === 'checking' ? null : builder, reachedPhase, agents, worktree: worktree ?? null, eta, working, reopened: Boolean(reopenAt), awaitsDone,
    ownerStep: awaitsDone ? ownerStep : null,
    // docs/adr/2026-11-04-2308-an-owner-step-can-carry-a-code-check.md
    ownerCheck: awaitsDone && ownerStep && it.owner_check ? { words: checkWords(parseCheck(it.owner_check.check)), broken: it.owner_check.broken || null } : null,
    // docs/adr/2026-11-07-0700-staging-then-ready.md: when the card was staged, and when it was last sent back for a round.
    stagedAt: lane === 'todo' && it.state === 'staging' ? it.staged_at || null : null, roundAt: it.round_at || null,
    deps: it.deps || [], blockedUntil: it.blocked_until || null, blockReason: it.block_reason || null, held, heldUntil, risky: Boolean(it.risky), bumpable, bumpedAt: bumpable && bumpStands ? bumpedAt : null,
    holdable: lane !== 'done', hasNotes: Boolean(it.plan || String(it.notes || '').trim()),
    finishable: lane !== 'done',
    merging, refusal, manualSteps: it.manual_steps || [], fromAsk: it.from_ask || null, unfiled: Boolean(it.unfiled), next: changing || lane === 'done' || waitsOn === 'checking' ? null : redReady ? FIX_CI : rebasedNext || reviewNext || it.next || draftNext || null,
    rebaseFailed,
    branch: it.branch || pr?.headRefName || pushed?.branch || null, pushed: lane === 'done' || stepWaits ? null : pushed,
    mergeReady: lane === 'review' ? mergeReady : null,
    // docs/adr/2026-11-05-1809-the-orchestrator-stops-the-boards-own-runs.md: a Merge tap's land the orchestrator
    // stopped reads so until the next tap.
    landStopped: lane === 'review' && mergeReady && it.merge_ready.stopped && String(it.merge_ready.stopped) > String(it.merge_ready.tapped || '')
      ? { words: stoppedWords('land'), at: it.merge_ready.stopped } : null,
    ticket: tickets?.source === 'linear' && !it.ticket && it.linear?.length ? null
      : ticketOf(tickets, it.ticket, it.ticket || (wave.internal ? refOf(wave, it, tickets) : it.linear?.[0]), { repo, key }),
    ticketSource: tickets?.source || null,
    linear: (it.linear || []).map((id) => tickets?.source === 'linear' ? ticketBadge(tickets, id, { key, repo }) || linearRef(id, tickets) : linearRef(id, tickets)),
    pr: views[least] || null, prs: views,
    reviewers: reviewers.map((r) => r.name), review: reviewOf(reviewers, pr, sentAt), inReviewSince,
    threadCount: thread.length + events.length, lastTs, othersAt,
    grilling: planningOf('grill', events, agents, askedAt), prototyping: planningOf('prototype', events, agents, askedAt),
    state: it.state || null,
    updatedAt: pr?.mergedAt || pr?.updatedAt || it.merged_at || builder?.at || lastTs || null, ask: null, fold: null, action: null,
    install: lane === 'done' ? null : installOf(it.install, pr),
    waitFacts: waitFactsOf(it, { agents, thread, events, refusedAt: refusal ? newest.ts : null }),
  };
}

// docs/adr/2026-11-04-2300-each-lane-is-a-queue-for-the-orchestrator.md
// What a card's wait on the orchestrator is read from (orchestratorWaitOf), kept on the item only until buildBoard places
// it: when its status was set and its stored Next, its oldest builder ask with no answer, its newest grill and prototype
// requests, when the pull refused it, whether its records hold unverified calls, and the session's writes on it: a thread
// line of Claude's other than a status, agent or refusal line, a verify and a builder start.
function waitFactsOf(it, { agents, thread, events, refusedAt }) {
  const answered = new Set(thread.filter((m) => m.kind === BUILDER_ASK.answer).map((m) => m.ask));
  const ask = thread.filter((m) => m.kind === BUILDER_ASK.ask && !answered.has(m.ask)).sort((a, b) => String(a.ts).localeCompare(String(b.ts)))[0];
  const requestAt = (kind) => events.filter((e) => isRequest(e, kind)).pop()?.ts || null;
  const lines = thread.filter((m) => (m.who || 'claude') === 'claude' && !['status', 'agent', BUILD_REFUSED].includes(m.kind)).map((m) => m.ts);
  return {
    statusAt: it.status_at || null, next: it.next || null, ask: ask ? { at: ask.ts, text: ask.text } : null,
    grillAt: requestAt('grill'), prototypeAt: requestAt('prototype'), refusedAt,
    unverified: agents.some((a) => a.calls.some((c) => !a.verified || String(c.at) > String(a.verified.at))),
    writes: [...lines, ...agents.flatMap((a) => [a.verified?.at, a.started])].filter(Boolean).map(String).sort(),
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
// state CLEAN. checks: {state, pending?, failing?: [name]}. needsApproval false, on a card no reviewer is on, waits on a
// review only while GitHub asks for one or for changes (docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md).
// board.mjs merge refuses on the same reasons.
export function mergeBlockers(pr, { needsApproval = true } = {}) {
  if (pr?.state !== 'OPEN') return [`PR is ${String(pr?.state || 'unknown').toLowerCase()}`];
  const { state, pending, failing } = pr.checks || {};
  return [
    pr.isDraft && 'it is a draft',
    !reviewed(pr, needsApproval) && `review: ${String(pr.reviewDecision || 'none').toLowerCase().replace(/_/g, ' ')}`,
    state === 'fail' && `failing: ${failing?.length ? failing.join(', ') : 'a check'}`,
    state === 'pending' && `pending: ${pending ? plural(pending, 'check') : 'checks'}`,
    pr.mergeStateStatus !== 'CLEAN' && `merge state: ${String(pr.mergeStateStatus || 'unknown').toLowerCase()}`,
  ].filter(Boolean);
}
const mergeable = (pr, needsApproval) => !mergeBlockers(pr, { needsApproval }).length;

// What the owner acts on next, or null: {kind, url, label}, url relative to the site root. kind is pick (a prototype
// question), questions, ready (a draft's review, then Ready on GitHub), done (an ask's Done in its thread), steps (manual
// steps on an approved PR, which the session never merges on its own) or merge (the open card's Merge, while the board's
// auto-merge is off, and always on a verified branch held for it). A held card waits on nobody, and a reopened card
// waiting only on its Done has no action. Held only stops the automatic pull, so a held card has actions like any other
// (docs/adr/2026-11-05-0500-held-only-stops-the-automatic-pull.md).
function actionOf(it, questionById, autoMerge) {
  if (closedLane(it)) return null;
  const thread = `#item=${encodeURIComponent(it.key)}`;
  if (asking(it)) {
    const q = questionById.get(it.questions.first);
    if (PROTOTYPE_URL.test(q?.url || '')) return { kind: ACTION_KIND.pick, url: `questions.html#${q.id}`, label: 'Prototypes ready: pick a take' };
    return { kind: ACTION_KIND.questions, url: `questions.html#${it.questions.first}`, label: `Answer ${plural(it.questions.open, 'question')}` };
  }
  if (it.waitsOn === 'ready') return { kind: ACTION_KIND.ready, url: it.pr.url, label: `Review draft PR #${it.pr.number}` };
  if (it.kind === 'ask' && it.waitsOn === 'owner') return { kind: ACTION_KIND.done, url: thread, label: it.next || TAP_DONE };
  if (it.waitsOn === 'merge' && it.manualSteps.length && !it.mergeReady) return { kind: ACTION_KIND.steps, url: thread, label: 'Run the manual steps, then merge' };
  // docs/adr/2026-10-29-1752-auto-merge-is-a-board-setting-off-by-default.md
  if (it.waitsOn === 'merge' && (!autoMerge || it.mergeReady) && !it.merging && it.prs.every((p) => ['MERGED', 'CLOSED'].includes(p.state) || mergeable(p, it.reviewers.length > 0))) return { kind: ACTION_KIND.merge, url: thread, label: 'Merge' };
  return null;
}

const asking = (it) => Boolean(it.questions && it.questions.state !== 'resolved' && it.questions.open > 0);
const ASKING = new Set([ACTION_KIND.pick, ACTION_KIND.questions]);

// The card's one workflow button, which board/public/app-cards.js only labels: openQuestions on any card that has had
// questions, Done ones too, held or not, which resolvedBy colours orange only while they wait on the owner, and none
// otherwise (docs/adr/2026-11-05-2331-a-sent-answer-is-resolved-in-place-until-the-page-reloads.md). An ask waiting on
// the owner's Done has it in its thread box, beside Reply
// (docs/adr/2026-11-05-1918-done-shows-only-in-in-review-beside-reply.md). A grill or prototype is asked for from the
// thread's fire and eye (docs/adr/2026-11-04-2130-a-button-tap-is-a-status-line-or-a-message-footer.md).
function actionButtonOf(it) {
  return it.questions ? BUTTON.openQuestions : null;
}

// docs/adr/2026-11-02-1745-a-todo-card-that-nothing-blocks-has-build.md
// The open card's Build: on a work card still unstarted in Todo, held or not, that waits on nothing from the owner and
// has a take picked on its prototypes (noTakePicked). On a card an unfinished dep blocks, the tap bumps it
// (docs/adr/2026-11-05-0802-todo-has-no-queue.md).
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
  [ACTION_KIND.steps]: BUTTON.github, [ACTION_KIND.merge]: BUTTON.merge, [ACTION_KIND.done]: BUTTON.done,
});

// docs/adr/2026-10-29-1639-the-lane-follows-who-acts-next.md
// A card only the owner can move on goes to In Review, apart from a Todo card waiting on its questions, which stays in
// Todo (docs/adr/2026-10-30-1309-an-unstarted-card-waits-on-its-questions-in-todo.md). One Claude still works on, or one already
// waiting on the reviewers, keeps its lane; either way it carries its action. A reopened card that waits only on the
// owner's Done goes to In Review with no action
// (docs/adr/2026-11-03-0137-a-card-waiting-only-to-be-closed-has-no-action-needed.md).
// A card whose only open questions are its builder's deferred asks waits on the owner from where it is, with Open
// questions and no Action needed (docs/adr/2026-11-04-0247-a-builder-asks-the-orchestrator-mid-build.md).
function placeOwnerWait(it, questionById, autoMerge) {
  it.action = actionOf(it, questionById, autoMerge);
  if (it.action?.kind === ACTION_KIND.questions && it.questions.fromAsks) {
    Object.assign(it, { action: null, waitsOn: 'owner', next: it.action.label, actionButton: actionButtonOf(it), resolvedBy: null });
    return;
  }
  it.awaitsDone &&= !it.action;
  if (!it.awaitsDone) Object.assign(it, { ownerStep: null, ownerCheck: null });
  it.actionButton = actionButtonOf(it);
  it.resolvedBy = RESOLVED_BY[it.action?.kind] || null;
  if (it.action?.kind === ACTION_KIND.merge && !it.mergeReady) it.next = (it.pr?.reviewDecision === 'APPROVED' ? OWNER_MERGE_NEXT : UNREVIEWED_MERGE_NEXT).ready;
  if (it.awaitsDone) Object.assign(it, { lane: 'review', next: it.ownerStep || TAP_DONE, bumpable: false, bumpedAt: null });
  const ownerOnly = it.lane === 'todo' || it.waitsOn === 'ready' || (it.lane === 'progress' && it.waitsOn === 'owner');
  if (!it.action || !ownerOnly) return;
  const lane = it.lane === 'todo' && ASKING.has(it.action.kind) ? 'todo' : 'review';
  Object.assign(it, { lane, waitsOn: it.waitsOn === 'ready' ? 'ready' : 'owner', next: it.action.label });
  if (lane === 'review') Object.assign(it, { bumpable: false, bumpedAt: null });
}

// docs/adr/2026-10-29-1639-a-started-card-never-returns-to-todo.md
// docs/adr/2026-11-03-0202-a-card-moves-to-in-progress-only-once-building-starts.md
// A work card has started once building has: a build agent's record, running or finished, or a building or fixing
// status. A PR, a pushed branch and checking place it on their own (laneOf).
const started = (it) => it.agents.some(builds) || ['building', 'fixing'].includes(String(it.status || '').toLowerCase());

// docs/adr/2026-11-03-0237-an-in-progress-card-always-has-a-builder-line-or-a-next.md
// An In Progress card shows its builder line while a builder record is open, else its Next. buildBoard gives one with
// neither this as its Next; owesNext is store.mjs's check before a write that would leave one so.
export const NO_NEXT = 'none set yet';
// Whether a work item's wave entry and builder records leave its card started with no open record and no Next, where
// nothing else gives it a line or places it: a PR or pushed branch (GitHub or the owner's merge words most of those,
// and buildBoard's gap the rest), checking, a hold, or a finished status.
export function owesNext(item, records) {
  const status = String(item.status || '').toLowerCase();
  if (item.next || hasPR(item) || item.pushed || item.held || ['held', 'checking', 'done', 'merged', 'dropped'].includes(status)) return false;
  const agents = records.filter((r) => r?.started);
  return !agents.some((r) => !r.done) && started({ status, agents });
}

// An ask is a New card in Todo, at the bottom among the cards by when it was sent (a bump moves it to the top), until Claude replies to it or writes in its thread; then it is an answered ask
// in the Asks section, below Done, with its thread (docs/adr/2026-10-29-1639-the-plus-makes-a-new-card.md,
// docs/adr/2026-11-03-0259-answered-asks-have-their-own-section-below-done.md). An ask that became work has no card
// of its own: buildBoard leaves it out. A folded ask stays, in Asks, with a thread line saying where it went. msgs is its thread; bumpedAt is its latest ask-bump.
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
    internal: false, repo: null, lane: inProgress ? 'progress' : done ? 'asks' : 'todo', waitsOn: inProgress && !ownerPending ? 'owner' : null, builder: null, agents: [], eta: null, working: msgs.some((m) => stateEntries(m).some(([, state]) => state === 'working')),
    deps: [], held: false, risky: false, bumpable: !handled, bumpedAt: bumped, manualSteps: [], fromAsk: null, from: null, next: inProgress ? mark.next || null : null, hasNotes: false, branch: null,
    finishable: handled && !done,
    linear: [], pr: null, prs: [], reviewers: [], review: {}, inReviewSince: null, reviewSince: null, progressSince: inProgress ? mark.at || null : null, closedAt: null,
    threadCount: msgs.length, lastTs, othersAt: handled ? othersAt : [], grilling: false, prototyping: false, created: e.ts, updatedAt: handled ? lastTs : e.ts,
    ask: { eventId: e.id, state, askedAt: e.ts, bumpedAt: bumped, edited: Boolean(msg.edited), canEdit: !handled, text: msg.text, files, answerAt, from: msg.from || null },
    fold: null, action: null,
  };
}

// Two kinds of agent: planners, the grill and prototype agents, which write no output code, and implementers, every
// other kind. A planner works toward a build, so it never starts a card or puts it in In Progress, and its lines are
// the owner's blue (docs/adr/2026-11-03-0202-a-card-moves-to-in-progress-only-once-building-starts.md,
// docs/adr/2026-11-03-1551-planners-and-implementers-are-two-kinds-of-agent.md).
// A visual agent is a planner too, drawing one page for the thread beside whatever else runs on the card: it is no
// card's work, so the card's status and its arrival for a grill pass it by
// (docs/adr/2026-11-05-1921-a-visual-is-a-page-an-agent-draws-for-a-thread.md).
export const VISUAL = 'visual';
const PLANNERS = new Set(['grill', 'prototype', VISUAL]);
export const plans = (agent) => PLANNERS.has(agent.kind);
export const builds = (agent) => !plans(agent);
// A planner's word, never a builder phase: its card reads it before the planner's first line and leads each line with
// it (docs/adr/2026-11-04-0131-every-new-task-is-grilled-or-prototyped-at-once.md). A request no planner has picked up
// reads preheating instead (ui-cards.js; docs/adr/2026-11-05-0410-a-card-status-word-comes-from-a-signal-the-board-checks.md).
export const PLANNER_WORD = { grill: 'grilling', prototype: 'prototyping' };

// docs/adr/2026-11-05-1809-the-orchestrator-stops-the-boards-own-runs.md
// The words for what the orchestrator did to a card's run (build, land), as its status line and thread line read:
// "land stopped by orchestrator".
export const orchestratorDid = (run, act) => `${run} ${act} by orchestrator`;
export const stoppedWords = (run) => orchestratorDid(run, 'stopped');
// The owner's request of a planner kind on a card: a Grill tap (grill-more) or a card's Prototype tap (prototype-request
// with no question). Under way while a planner of that kind runs, or while the newest request has no reply, no
// question was posted after it and no planner of that kind that started with or after it has finished; the board
// server opens the planner in the request's own millisecond.
const REQUEST_KIND = { grill: 'grill-more', prototype: 'prototype-request' };
const isRequest = (e, kind) => e.kind === REQUEST_KIND[kind] && !e.data?.question;
function planningOf(kind, events, agents, askedAt) {
  if (agents.some((a) => a.kind === kind && a.started && !a.done)) return true;
  const last = events.filter((e) => isRequest(e, kind)).pop();
  return Boolean(last && !last.reply && !askedAt.some((t) => String(t) > String(last.ts))
    && !agents.some((a) => a.kind === kind && a.done && String(a.started) >= String(last.ts)));
}

// docs/adr/2026-11-04-2130-a-prototype-request-waits-for-its-prototype.md
// How long a prototype request may wait with no prototype agent running before the board raises it to the session.
export const PROTOTYPE_WAIT = 30 * 60000;
// The prototype requests on a built board's open cards still waiting on their prototype, while no prototype agent runs on
// the card: the card's own request while it is under way, and each of its questions reading requested.
// → [{key, request, question?, since}], since being the request's time.
export function prototypeWaits(built, events) {
  const out = [];
  for (const it of built.items) {
    if (closedLane(it) || (it.agents || []).some((a) => a.kind === 'prototype' && a.started && !a.done)) continue;
    const own = it.prototyping && events.filter((e) => e.data?.key === it.key && isRequest(e, 'prototype')).pop();
    if (own) out.push({ key: it.key, request: own.id, since: own.ts });
    for (const q of built.owner.filter((x) => x.topic === `item:${it.key}` && x.state === 'requested')) out.push({ key: it.key, request: q.request.id, question: q.id, since: q.request.ts });
  }
  return out;
}

// An item's agents, oldest first, from its records by agent name.
function agentsOf(records = {}) {
  return Object.entries(records).filter(([, r]) => r && typeof r === 'object').map(([name, r]) => ({
    name, kind: providerOf(r.kind) || null, model: r.model || (r.kind === 'opus' || r.kind === 'sonnet' ? r.kind : null), label: r.label || null, started: r.started || null, eta: r.done ? null : r.eta || null, done: r.done || null,
    calls: Array.isArray(r.calls) ? r.calls : [], verified: r.verified || null, stopped: r.stopped || null,
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
// first line a build's progress is null, which the card reads as starting, whoever opened the record
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

// A run's silence is the time since its newest progress line or movement in its worktree's Claude transcript (moved
// {<worktree path>: ms}, server.mjs snapshot); a run with no readable transcript has its progress lines alone. alive is
// whether the card's headless process lives (server.mjs snapshot alive), null when the board tracks none for it, or
// 'held' while the board holds its launch for a usage pause: held, never stalled, since the board launches it once the
// pause lifts (server.mjs reviveHeadless), so it is no wait on the orchestrator.
// commandRunning is whether its transcript ends on a tool call with no result (server.mjs snapshot commandRunning).
// A live one reads quiet after BUILDER_QUIET_AFTER of silence with no command running, and is never stalled; a gone one is stalled at once; an
// untracked one is stalled after BUILDER_STALLED_AFTER of silence
// (docs/adr/2026-11-05-0410-a-card-status-word-comes-from-a-signal-the-board-checks.md).
// A run the orchestrator stopped (a record's stopped {run, at}, written since that record last started) reads stopped
// with its words from the stop, gone and waiting on the orchestrator from then.
function builderOf(agents, lines = [], now, movedAt = null, alive = null, commandRunning = false) {
  const open = agents.filter((a) => a.started && !a.done && a.kind !== VISUAL);
  const planner = open.every(plans);
  const running = planner ? open : open.filter(builds);
  const since = running.map((a) => String(a.started || '')).sort()[0];
  if (since === undefined) return null;
  const line = lines.filter((m) => m.kind === 'status' && String(m.ts) >= since && (planner || !m.planner)).sort((a, b) => String(a.ts).localeCompare(String(b.ts))).pop();
  const kind = running.some((a) => a.kind === BUILDER_KIND.install) ? BUILDER_KIND.install : providerOf(running.at(-1).kind);
  const stop = planner ? null : running.find((a) => a.stopped && String(a.stopped.at) >= String(a.started))?.stopped;
  const quiet = line?.ts || since;
  const silentSince = stop ? stop.at : movedAt !== null && movedAt > Date.parse(quiet) ? new Date(movedAt).toISOString() : quiet;
  const progress = line ? (line.phase || line.planner ? line.text.replace(': ', ' · ') : line.text || null) : planner ? PLANNER_WORD[kind] : null;
  const silent = now - Date.parse(silentSince);
  const held = !planner && !stop && alive === 'held';
  const live = planner || held ? null : stop ? false : alive;
  const stalled = held ? false : live === null ? silent >= BUILDER_STALLED_AFTER : !live;
  return { progress, phase: line?.phase || null, at: quiet, kind, planner, silentSince, stalled, alive: live, held, quiet: live === true && !commandRunning && silent >= BUILDER_QUIET_AFTER, stopped: stop ? stoppedWords(stop.run) : null };
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
// A question's state: open (no answer yet), answered (waiting for Claude), replied (Claude answered), requested (a
// prototype was asked for it), resolved (owner.json sets `resolved` and `resolved_at`). An answer newer than
// `resolved_at` reopens it; without `resolved_at` it stays resolved. Each answer is acted on once the question's
// resolution covers it. request is the owner's newest prototype-request for it after its last answer: the question reads
// requested until a question naming it in round_of resolves it
// (docs/adr/2026-11-04-2130-a-prototype-request-waits-for-its-prototype.md). answerEvents are owner-answer events and
// requestEvents prototype-request events, oldest first; store.mjs reads their states to close a card's questions.
// reask is the owner's newest reask-request for a resolved question while it is newer than `resolved_at`: question add
// with reask_of resolves the question again once the session asks it again.
// reopenEvents are question-reopen events, the owner's tap on a sent question's Resolved badge: the newest one, while
// it is newer than the last answer, the last prototype request and `resolved_at`, opens the question again for a new
// answer, and `reopened` is set (docs/adr/2026-11-05-2331-a-sent-answer-is-resolved-in-place-until-the-page-reloads.md).
export function ownerQuestion(q, answerEvents, requestEvents = [], reaskEvents = [], reopenEvents = []) {
  const answers = answerEvents.filter((e) => e.data?.id === q.id);
  const last = answers[answers.length - 1] || null;
  const reopen = reopenEvents.filter((e) => e.data?.question === q.id).at(-1);
  const after = (e, ...times) => Boolean(e) && times.every((t) => String(e.ts) > String(t || ''));
  const answeredAgain = Boolean(q.resolved && q.resolved_at && last && String(last.ts) > q.resolved_at);
  const req = requestEvents.filter((e) => e.data?.question === q.id && after(e, last?.ts, reopen?.ts)).at(-1);
  const reopened = after(reopen, last?.ts, req?.ts, q.resolved_at);
  const resolved = q.resolved && !answeredAgain && !reopened;
  const reask = resolved ? reaskEvents.filter((e) => e.data?.question === q.id && String(e.ts) > String(q.resolved_at || '')).at(-1) : null;
  const state = reopened ? 'open' : resolved ? 'resolved' : req ? 'requested' : !last ? 'open' : last.reply ? 'replied' : 'answered';
  return { ...q, state, reopened, request: req ? { id: req.id, ts: req.ts, note: req.data.note || '', choice: req.data.choice || null } : null, reask: reask ? { id: reask.id, ts: reask.ts } : null,
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

// docs/adr/2026-11-07-0300-prototypes-have-their-own-button-and-viewer.md
// A card's prototypes, for its Prototypes button (app-cards.js) and the viewer's rounds (prototype-switcher.js): each of
// its questions (ownerQuestion views) on a prototype page, oldest round first, and open while one of them waits on the
// owner's pick. null when it has none.
function prototypesOf(qs) {
  const rounds = qs.filter((q) => PROTOTYPE_URL.test(q.url || '')).map((q) => ({ n: roundOf(q), q: q.id, url: q.url, confirm: Boolean(q.confirm_of), state: q.state }))
    .sort((a, b) => a.n - b.n);
  return rounds.length ? { open: rounds.some((r) => r.state === 'open'), rounds } : null;
}

const add = (map, key, value) => { const list = map.get(key); if (list) list.push(value); else map.set(key, [value]); };
// list grouped by keyOf, each group in the list's order. → Map
const groupBy = (list, keyOf) => { const map = new Map(); for (const x of list) add(map, keyOf(x), x); return map; };

// A topic is resolved once every question in it is; questions without a known topic share "Other".
// A card's questions use topic `item:<key>`: `item:<wave>/<id>`, or `item:ask:<event id>` for a New card not yet sorted.
// The board supplies its title when owner.json has none, and names the card as card, so the page's board can leave the
// title out and name the topic from its card (server.mjs pageBoard). closed holds the topics of Done cards: one with no open
// question is resolved, so its answered questions never wait on Claude.
function ownerTopics(topics, questions, closed = new Set()) {
  const known = new Set(topics.map((t) => t.id));
  const all = [...topics];
  if (questions.some((q) => !known.has(q.topic))) all.push({ id: '', title: 'Other' });
  const byTopic = groupBy(questions, (q) => (known.has(q.topic) ? q.topic : ''));
  return all.map((t) => {
    const qs = byTopic.get(t.id) || [];
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
// A Grill or Prototype tap with nothing typed, or a resolved question's re-ask, is a request entry, muted, not a message
// from the owner; the session builds the planner's prompt from the event (docs/adr/2026-11-04-0131-every-new-task-is-grilled-or-prototyped-at-once.md).
// A request with text, a question's prototype request (its question, pick and note) and an answer are the owner's
// messages, with the tap's words as their footer's status
// (docs/adr/2026-11-04-2130-a-button-tap-is-a-status-line-or-a-message-footer.md).
export const ACTION_LABELS = { 'mark-ready': 'Mark ready', 'grill-more': 'grill requested', 'prototype-request': 'prototype requested', 'visual-request': 'visual requested', 'reask-request': 're-ask requested' };
const REQUESTS = ['grill-more', 'prototype-request', 'visual-request'];
export const ANSWERS_SUBMITTED = 'answers submitted';
export const QUICK_BUILD = 'quick build: no grill';
// docs/adr/2026-11-05-0300-implement-in-the-thread-queues-the-card-for-the-orchestrator.md
// A Todo card's thread box sends with Reply (intent: 'reply') or Implement (intent: 'build'), and its message's footer
// names that button. A bare Implement is a request line. A one-button box's message carries no intent and has no footer.
export const INTENT_LABELS = { reply: 'Reply', build: 'Implement' };
const intentLabel = (e) => INTENT_LABELS[e.data.intent];
const bareMessage = (e) => e.kind === 'item-message' && !String(e.data.text || '').trim() && !e.data.files?.length;
const actionText = (e, asked) => {
  if (bareMessage(e) && e.data.intent === 'build') return intentLabel(e);
  if (e.kind !== 'prototype-request' || !asked.has(e.data.question)) return e.data.text || (e.data.files?.length ? '' : routeRecord(ACTION_LABELS, e.kind)) || '';
  const q = asked.get(e.data.question);
  const o = (q.options || []).find((x) => x.id === e.data.choice);
  return [numbered(asked, q), o && `${o.id}. ${o.label}`, e.data.note].filter(Boolean).join('\n→ ');
};
// docs/adr/2026-11-05-2331-a-sent-answer-is-resolved-in-place-until-the-page-reloads.md
// A question's number on its card: its place among the card's questions in owner.json, which only appends, so a new
// round's questions number on after the earlier ones. asked: the card's questions by id, in owner.json order.
const numberOf = (asked, id) => [...asked.keys()].indexOf(id) + 1;
const numbered = (asked, q) => `Question ${numberOf(asked, q.id)} · ${q.question}`;
// The reopened line's mark (board/public/ui.js MARK_ICONS).
const REOPENED = 'question reopened';
// A Grill or Prototype request: bare (the request line) or carrying the owner's text, files or question (a message with
// its status); a thread message has its button's label as its status (intentLabel).
// A Full person's event names them in the thread, by name, else login (docs/adr/2026-11-05-1912-a-shared-person-is-view-or-full.md).
const byOf = (e) => (e.data?.shared_by?.login ? { by: e.data.shared_by.name || e.data.shared_by.login } : {});
const requestOf = (e, asked) => {
  if (e.kind === 'item-message') return bareMessage(e) && e.data.intent === 'build' ? { request: true } : INTENT_LABELS[e.data.intent] ? { status: intentLabel(e) } : {};
  if (!REQUESTS.includes(e.kind)) return e.kind === 'reask-request' ? { request: true } : {};
  return (e.data.question ? asked.has(e.data.question) : String(e.data.text || '').trim() || e.data.files?.length) ? { status: ACTION_LABELS[e.kind] } : { request: true };
};
// A Claude line answers the owner's messages before it; an agent's lines and the orchestrator's answer to a builder don't.
const claudeAtOf = (msgs) => [...msgs.filter((m) => m.who === 'claude' && !['status', 'agent', BUILDER_ASK.answer].includes(m.kind)).map((m) => m.ts),
  ...msgs.filter((m) => m.kind === 'ask').map((m) => m.reply?.at)].filter(Boolean).map(String).sort().pop() || '';
// docs/adr/2026-11-04-0349-the-board-is-built-once-per-data-version.md
// The event log and owner questions grouped once per build, so each card's thread picks its own instead of scanning
// them all: byKey the item events by card key, answers the owner-answer events by their question's topic, asks the
// ask events by id, edits each ask-edited event's text and editFiles their files by the event they edit, questions
// owner.json's questions by topic, and order each event's place in the log. Each list keeps the log's order.
export function threadIndex(events, owner = {}) {
  const questions = new Map();
  const topicOf = new Map();
  for (const q of owner.items || []) { add(questions, q.topic, q); topicOf.set(q.id, q.topic); }
  const byKey = new Map(), answers = new Map(), reopens = new Map(), asks = new Map(), edits = new Map(), editFiles = new Map(), order = new Map();
  events.forEach((e, i) => {
    order.set(e, i);
    if (e.data?.key && ITEM_EVENTS.includes(e.kind)) add(byKey, e.data.key, e);
    if (e.kind === 'owner-answer' && topicOf.has(e.data?.id)) add(answers, topicOf.get(e.data.id), e);
    if (e.kind === QUESTION_REOPEN && topicOf.has(e.data?.question)) add(reopens, topicOf.get(e.data.question), e);
    if (e.kind === 'ask') asks.set(e.id, e);
  });
  for (const e of events.filter((x) => x.kind === 'ask-edited').sort((a, b) => String(a.ts).localeCompare(String(b.ts)))) {
    edits.set(e.data?.id, e.data?.text);
    for (const f of e.data?.files || []) add(editFiles, e.data?.id, f);
  }
  return { byKey, answers, reopens, asks, edits, editFiles, questions, order };
}
// The events of several of an index's lists in the log's order.
const inLogOrder = (index, lists) => {
  const found = lists.filter((l) => l?.length);
  return found.length > 1 ? found.flat().sort((a, b) => index.order.get(a) - index.order.get(b)) : [...(found[0] || [])];
};
// A launch line written before lines carried a log field ends "; its log is <path>." with the path under the logs folder:
// that becomes the line's log (the file's name) and the text without the clause.
const LEGACY_LOG = /; its log is \S*\/\.claude\/kickflip\/logs\/([^/\s]+\.log)\.$/;
const withLog = (m) => {
  const legacy = !m.log && typeof m.text === 'string' ? LEGACY_LOG.exec(m.text) : null;
  return legacy ? { ...m, text: `${m.text.slice(0, legacy.index)}.`, log: legacy[1] } : m;
};
// The agent a status line belongs to, and its run: the line's own run id (the started time of the agent record it was
// written under) names it. A line with no run id, from before lines carried one, falls to the agents of its kind of work
// (planners for a planner line, implementers for the rest) that had started by its time and not finished before it, the
// newest started. → {agent: its name, run: its started time, running}, or {} for a line no agent covers.
function agentOfLine(agentList, m) {
  const own = m.run ? agentList.find((a) => a.started === m.run)
    : agentList.filter((a) => plans(a) === Boolean(m.planner) && a.started && String(a.started) <= String(m.ts) && (!a.done || String(m.ts) <= String(a.done))).pop();
  return own ? { agent: agentName(own), run: own.started, running: !own.done } : {};
}
export function threadOf(key, { lines = [], events = [], owner = {}, working = {}, fromAsk = null, links = [], agents = {}, moved = [], index = threadIndex(events, owner) }) {
  const askIds = key.startsWith('ask:') ? [key.slice(4)] : [fromAsk, ...moved].filter(Boolean);
  const keys = [...new Set([key, ...askIds.map((id) => `ask:${id}`)])];
  const asked = new Map((index.questions.get(`item:${key}`) || []).map((q) => [q.id, q]));
  const answers = index.answers.get(`item:${key}`) || [];
  // An answer is acted on, and waits on Claude no more, once its question is resolved after it, a later prototype
  // round names its question (round_of), or a build starts on the card after it.
  const rounded = new Set([...asked.values()].map((q) => q.round_of).filter(Boolean));
  const buildsFrom = agentsOf(agents).filter(builds).map((a) => String(a.started || '')).filter(Boolean);
  const acted = new Set(answers
    .filter((e) => resolvedSince(asked.get(e.data.id), e.ts) || rounded.has(e.data.id) || buildsFrom.some((s) => s > String(e.ts))).map((e) => e.id));
  const agentList = agentsOf(agents);
  const msgs = [
    // First, so a start sorts above the status line `builder start` writes at the same moment.
    // A planner's lines are marked planner, which the thread draws in the owner's blue.
    ...agentsOf(agents).flatMap((a) => [
      ...(a.started ? [{ ts: a.started, who: 'claude', kind: 'agent', text: `${agentName(a)} started`, agent: agentName(a), run: a.started, finished: false, eta: a.done ? null : a.eta, ...(plans(a) ? { planner: true } : {}) }] : []),
      ...(a.done ? [{ ts: a.done, who: 'claude', kind: 'agent', text: `${agentName(a)} finished`, agent: agentName(a), run: a.started, finished: true, eta: null, ...(plans(a) ? { planner: true } : {}) }] : []),
      // Its judgment calls, one entry under its lines: at its finish, or at its newest call while it runs
      // (docs/adr/2026-11-03-0514-a-builder-records-its-judgment-calls-and-the-session-verifies-them.md).
      ...(a.calls.length ? [{ ts: a.done || a.calls.at(-1).at, who: 'claude', kind: 'calls', text: agentName(a), calls: a.calls.map((c) => c.text), verified: a.verified }] : []),
    ]),
    ...lines.map(withLog).map((m) => ({ ts: m.ts, who: m.who || 'claude', ...(m.log ? { log: m.log } : {}),...(m.kind === 'status' ? { kind: 'status', ...(m.planner ? { planner: true } : {}), ...agentOfLine(agentList, m) } : {}), ...(m.kind === VISUAL ? { kind: VISUAL } : {}),
      ...(Object.values(BUILDER_ASK).includes(m.kind) ? { kind: m.kind, ask: m.ask } : {}), text: m.text || '', html: m.html || null, link: m.link || null, via: m.via || null, ...(m.by ? { by: m.by } : {}) })),
    ...inLogOrder(index, keys.map((k) => index.byKey.get(k)))
      .map((e) => ({ ts: e.ts, who: 'love', via: 'site', kind: e.kind, text: actionText(e, asked), files: e.data.files || [], eventId: e.id, reply: e.reply,
        ...requestOf(e, asked), ...byOf(e) })),
    ...answers.map((e) => {
      const answer = [e.data.label || e.data.choice, e.data.note].filter(Boolean).join(' · ');
      return { ts: e.ts, who: 'love', via: 'questions', kind: e.kind, text: `${numbered(asked, asked.get(e.data.id))}\n→ ${answer}`, files: e.data.files || [], eventId: e.id, reply: e.reply, status: ANSWERS_SUBMITTED, ...byOf(e) };
    }),
    ...(index.reopens.get(`item:${key}`) || []).map((e) => ({ ts: e.ts, who: 'love', kind: e.kind, request: true, mark: REOPENED, text: `Question ${numberOf(asked, e.data.question)} was reopened`, ...byOf(e) })),
    ...inLogOrder(index, [...new Set(askIds)].map((id) => (index.asks.has(id) ? [index.asks.get(id)] : [])))
      .flatMap((e) => [{ ts: e.ts, who: 'love', via: 'ask', kind: e.kind, text: e.data?.text || '', files: e.data?.files || [], eventId: e.id, reply: e.reply, ...(moved.includes(e.id) ? { moved: true } : {}), ...byOf(e),
        ...(typeof e.data?.from?.title === 'string' ? { from: e.data.from.title } : {}) },
        ...(e.data?.quick === true ? [{ ts: e.ts, who: 'love', kind: 'quick-build', request: true, text: QUICK_BUILD }] : []),
        ...links.map((l) => ({ ts: e.ts, who: 'claude', kind: 'ask-link', text: l.folded ? `Moved to ${l.ref}: ${l.title}` : `${l.became ? 'Became' : 'Added to'} ${l.ref}`, link: `#item=${encodeURIComponent(l.key)}`, html: null, via: null }))]),
  ].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const lastClaude = claudeAtOf(msgs);
  const { edits, editFiles } = index;
  for (const m of msgs) {
    if (!m.eventId) continue;
    if ((m.kind === 'ask' || m.kind === 'item-message') && typeof edits.get(m.eventId) === 'string') {
      Object.assign(m, { text: edits.get(m.eventId), edited: true, files: [...m.files, ...(editFiles.get(m.eventId) || [])] });
    }
    const linked = m.kind === 'ask' && (links.length > 0 || Boolean(m.moved));
    m.state = m.reply ? 'replied' : linked || acted.has(m.eventId) || lastClaude > String(m.ts) ? 'answered' : routeRecord(working, m.eventId) ? 'working' : 'waiting';
    m.canDelete = m.kind === 'item-message' && (m.state === 'working' || m.state === 'waiting');
    m.canEdit = m.canDelete;
  }
  return foldSubmits(msgs);
}
// docs/adr/2026-11-04-2130-a-button-tap-is-a-status-line-or-a-message-footer.md
// One submit of several answers is one write, so its owner-answer events share a ts: they fold into one message at the
// first answer's place, with each answer's block in submit order, its first event id, and answers listing every member
// {eventId, state, reply}. The message is as pending as its most pending member.
const STATE_ORDER = ['waiting', 'working', 'answered', 'replied'];
function foldSubmits(msgs) {
  const submits = new Map();
  for (const m of msgs) if (m.kind === 'owner-answer') submits.set(m.ts, [...(submits.get(m.ts) || []), m]);
  return msgs.flatMap((m) => {
    if (m.kind !== 'owner-answer') return [m];
    const group = submits.get(m.ts);
    if (group.length === 1) return [m];
    if (group[0] !== m) return [];
    return [{ ...m, text: group.map((a) => a.text).join('\n\n'), files: group.flatMap((a) => a.files),
      state: group.map((a) => a.state).sort((a, b) => STATE_ORDER.indexOf(a) - STATE_ORDER.indexOf(b))[0],
      reply: undefined, answers: group.map((a) => ({ eventId: a.eventId, state: a.state, reply: a.reply, text: a.text })) }];
  });
}
// The states of the events a message stands for: each answer of a folded submit, else the message itself.
export const stateEntries = (m) => (m.answers || [m]).filter((a) => a.eventId).map((a) => [a.eventId, a.state]);

// docs/adr/2026-11-03-1840-waves-are-bands-in-todo.md
// The wave bands in Todo: each open lineup, the owner's wave (docs/adr/2026-11-02-1202-a-wave-the-owner-asks-for-is-a-lineup-of-cards.md),
// then on a board over ~/.claude/waves each unfinished wave file. A lineup is open until finished_at or until all its
// cards are Done. A band's keys are its cards, a lineup's in build order and a wave file's in lane order; next is a
// lineup's first ready Todo card, else its first Todo card with a word for why not, and a lineup's phases are its keys by
// phase (lineupPhases), for its step numbers; a wave file's are null. A band's kind is
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
    .map(({ l, cards }) => ({ kind: 'lineup', slug: l.slug, title: l.title, goal: l.goal, keys: cards.map((i) => i.key),
      phases: l.phases.map((p) => p.filter((k) => byKey.has(k))).filter((p) => p.length), next: nextOf(cards),
      merged: merged(cards), total: cards.length, triage: triageOf('lineup', l.slug) }));
  if (!snapshot.fromWaves) return bands;
  return [...bands, ...waves.filter((w) => !w.finished).map((w) => ({ w, cards: items.filter((i) => i.wave === w.slug && i.kind !== 'ask') }))
    .filter(({ cards }) => cards.length).map(({ w, cards }) => ({ kind: 'wave', slug: w.slug, title: w.title, goal: null, keys: cards.map((i) => i.key), phases: null, next: null,
      merged: merged(cards), total: cards.length, triage: triageOf('wave', w.slug) }))];
}
// A lineup's next card: its first Todo card Implement can start now, so one phase's ready cards are offered in turn, else
// its first Todo card, with the word for why Implement can't start it.
function nextOf(cards) {
  const todo = cards.filter((i) => i.lane === 'todo');
  const it = todo.find((i) => i.ready && i.buildable) || todo[0];
  if (!it) return null;
  const ready = it.ready && it.buildable;
  const word = ready ? 'ready' : it.held ? 'held' : it.blockedBy.length ? `waits on ${it.blockedBy.map((d) => d.ref).join(', ')}` : it.blockedUntil ? `blocked until ${it.blockedUntil}`
    : it.action ? 'needs you' : it.state || 'not ready';
  return { key: it.key, ref: it.ref, ready, word };
}

// docs/adr/2026-11-03-1840-waves-are-bands-in-todo.md
// Lineup slug's phases once its card key moves by one place (-1 up, 1 down) among the lineup's cards still in Todo,
// which keep the places they hold: the card swaps places with its neighbour, each taking the other's phase, and every
// phase keeps its size; started and done cards stay where they are. → the keys by phase, or null when the lineup isn't
// open or the card is not in Todo or already at that end.
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
  const order = band.keys.map((k) => (lanes.get(k) === 'todo' ? movable[at++] : k));
  at = 0;
  return band.phases.map((p) => order.slice(at, (at += p.length)));
}

// docs/adr/2026-11-04-0238-a-wave-builds-in-phases.md
// A lineup's cards by phase, [[id, …], …] in build order: each card is blocked by every card of the phase before, and
// one phase's cards build side by side. A lineup made before phases has items [id, …] instead, one card per phase.
export const lineupPhases = (lineup) => lineup.phases || lineup.items.map((id) => [id]);

// snapshot: {waves: [{slug, wave, agents: {<id>: {<agent>: record}}}], fromWaves,
//   prs: {"<repo>#<n>": pr}, threads: {<key>: [line]}, events: [event with reply, hidden ones left out],
//   working: {<event id>: ts}, checked: data/checked.json, listen, watcher: data/watcher.json, askLinks: {<ask event id>: <wave>/<id>},
//   askProgress: {<ask event id>: {state: progress|done, at, next, moved}}, owner: owner.json,
//   autoMerge: board.json's auto_merge (true leaves merging to the GitHub tick, so no card gets the owner's Merge),
//   skipDraft: board.json's skip_draft (true leaves a draft to the hub's poll, which marks it ready once CI passes, so
//   no draft gets the owner's review),
//   autoBuild: board.json's auto_build (true leaves card runs to the hub, so no card gets the owner's Serve / Build),
//   threads also holds each ask's lines under ask:<event id>; github: the board's owner/name, or remote: its git link
//   on another host, and branch: the board's branch;
//   topicItems: merged topic items, prSlack: data/pr-slack.json, prompts: this board's pending prompts (../hub/prompts.mjs shown), now: ms}
// moved maps ask:<event id> to the work item whose thread holds that ask.
// An event marked working needs its reply loaded, or it counts as still working.
export function buildBoard(snapshot) {
  const { owner = {}, topicItems = {}, events = [], threads = {}, prs = {}, working = {} } = snapshot;
  const now = snapshot.now ?? Date.now();
  const index = threadIndex(events, owner);
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
      // An archived card's own ask is linked to it as well (store.mjs archiveCards), and counts once, as its from_ask.
      const folded = (foldedInto.get(key) || []).filter((id) => id !== it.from_ask);
      const askIds = [it.from_ask, ...folded].filter((id) => asks.has(id));
      const askKeys = new Set(askIds.map((id) => `ask:${id}`));
      const lines = [...(routeRecord(threads, key) || []), ...askIds.flatMap((id) => routeRecord(threads, `ask:${id}`) || [])];
      if (it.from_ask) madeFrom.set(it.from_ask, [...(madeFrom.get(it.from_ask) || []), { key, ref: refOf(wave, it, tickets), became: true }]);
      const msgs = threadOf(key, { lines, events, owner, working, fromAsk: it.from_ask || null, moved: folded, index });
      for (const m of msgs) for (const [id, state] of stateEntries(m)) threadStates.set(id, state);
      claudeAt.set(key, claudeAtOf(msgs));
      items.push(workItem({
        slug, wave, it, order, repo, remote, base: snapshot.branch || 'main',
        prs: cardPRs(it, repo).map((p) => ({ ...p, gh: routeRecord(prs, prKeyOf(p)) || null })),
        ...((agents) => ({ agents, builder: builderOf(agents, routeRecord(threads, key), now, snapshot.moved?.[worktreeOf(routeRecord(records, it.id))] ?? null, routeRecord(snapshot.alive, key) ?? null, Boolean(snapshot.commandRunning?.[worktreeOf(routeRecord(records, it.id))])), reachedPhase: reachedPhaseOf(agents, routeRecord(threads, key)), eta: agents.map((a) => a.eta).filter(Boolean).sort().pop() || null }))(agentsOf(routeRecord(records, it.id))),
        worktree: worktreeOf(routeRecord(records, it.id)) ?? it.worktree?.path ?? null,
        thread: lines,
        events: [...inLogOrder(index, [key, ...askKeys].map((k) => index.byKey.get(k))), ...askIds.map((id) => asks.get(id))],
        working: msgs.some((m) => stateEntries(m).some(([, state]) => state === 'working')),
        said: msgs.filter((m) => m.who === 'love' && (m.kind === 'item-message' || m.kind === 'owner-answer')),
        askedAt: (index.questions.get(`item:${key}`) || []).filter((q) => q.asked_at).map((q) => q.asked_at),
        topicItems, prSlack: snapshot.prSlack || {}, boardReviewers: snapshot.reviewers || [], now, bumpedAt: cardBumps.get(key), holdAsk: cardHolds.get(key), closedAt: cardDones.get(key),
        mergeAt: cardMerges.get(key), autoMerge, skipDraft: snapshot.skipDraft === true, tickets,
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
    pull: tries.pull ? { running: tries.pull.running === true, error: tries.pull.error || null } : null,
    // The script main's run used: its board's build target (build-script.mjs buildScriptOf).
    script: buildScriptOf(run.target) } : null;

  const askProgress = snapshot.askProgress || {};
  const askDones = latest('ask-done', 'id');
  const answerEvents = groupBy(events.filter((e) => e.kind === 'owner-answer'), (e) => e.data?.id);
  const requestEvents = groupBy(events.filter((e) => e.kind === 'prototype-request'), (e) => e.data?.question);
  const reaskEvents = groupBy(events.filter((e) => e.kind === 'reask-request'), (e) => e.data?.question);
  const reopenEvents = groupBy(events.filter((e) => e.kind === QUESTION_REOPEN), (e) => e.data?.question);
  const questions = (owner.items || []).map((q) => ownerQuestion(q, answerEvents.get(q.id) || [], requestEvents.get(q.id) || [], reaskEvents.get(q.id) || [], reopenEvents.get(q.id) || []));
  const questionById = new Map(questions.map((q) => [q.id, q]));
  const questionsOn = groupBy(questions, (q) => q.topic);
  const pendingOn = (topic) => {
    const qs = questionsOn.get(topic) || [];
    return { open: qs.filter((q) => q.state === 'open').length, answered: qs.filter((q) => q.state === 'answered').length };
  };
  for (const e of asks.values()) {
    const key = `ask:${e.id}`;
    const related = works.get(routeRecord(askLinks, e.id));
    const links = [...(madeFrom.get(e.id) || [])];
    const folded = related && !links.some((l) => l.key === related.key);
    if (folded) links.push({ key: related.key, ref: related.ref, title: related.title, became: false, folded: true });
    if (links.length && !folded) { moved.set(key, links[0].key); continue; }
    // An ask linked to a card the board no longer holds went with it to the archive (store.mjs archiveCards).
    if (!folded && routeRecord(askLinks, e.id)) { moved.set(key, routeRecord(askLinks, e.id)); continue; }
    const msgs = threadOf(key, { lines: routeRecord(threads, key) || [], events, working, links, index });
    for (const m of msgs) for (const [id, state] of stateEntries(m)) threadStates.set(id, state);
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
  const lineups = snapshot.waves.flatMap(({ slug, wave }) => (wave.lineups || []).map((l) => {
    const phases = lineupPhases(l).map((p) => p.map((id) => `${slug}/${id}`));
    return { ...l, phases, keys: phases.flat() };
  }));
  const topicsOf = () => ownerTopics([...(owner.topics || []), ...items.filter((it) => !declared.has(`item:${it.key}`))
    .map((it) => ({ id: `item:${it.key}`, card: it.key, title: `${it.ref}: ${it.title}`, ...(it.kind === 'ask' ? { askedAt: it.ask.askedAt } : {}) })),
  ...lineups.filter((l) => !declared.has(`lineup:${l.slug}`)).map((l) => ({ id: `lineup:${l.slug}`, title: l.title, summary: 'Wave triage.' })),
  ...(snapshot.fromWaves ? waves : []).filter((w) => !declared.has(`wave:${w.slug}`)).map((w) => ({ id: `wave:${w.slug}`, title: w.title, summary: 'Wave triage.' }))], questions,
  new Set(items.filter(closedLane).map((it) => `item:${it.key}`)));
  const itemTopics = new Map(topicsOf().map((t) => [t.id, t]));
  for (const it of items) {
    const t = itemTopics.get(`item:${it.key}`);
    if (!t) { it.questions = null; it.prototypes = null; continue; }
    const pending = t.questions.filter((id) => questionById.get(id)?.state !== 'resolved');
    const first = t.questions.find((id) => questionById.get(id)?.state === 'open') || pending[0] || t.questions[0];
    // askedAt: when each open question was asked, which the card counts as new questions; fromAsks: every open one is a
    // builder's ask the orchestrator deferred to the owner.
    const open = t.questions.map((id) => questionById.get(id)).filter((q) => q?.state === 'open');
    it.questions = { topic: t.id, state: t.state, open: t.open, answered: t.answered, replied: t.replied, resolved: t.resolved, first,
      askedAt: open.map((q) => q.asked_at).filter(Boolean).sort(), fromAsks: open.length > 0 && open.every((q) => q.ask) };
    it.prototypes = prototypesOf(t.questions.map((id) => questionById.get(id)));
  }
  // A card waits on each dep until it reaches Done, which a reopened dep still counts as, and a Done card waits on nothing (docs/adr/2026-10-29-1639-cards-wait-on-explicit-blocked-by-links.md).
  // It also waits on its blocked-until condition until an agent clears it, and a block, by either, carries its reason
  // (docs/adr/2026-11-05-2358-nothing-waiting-on-the-orchestrator-is-missed.md). blocked: either holds it.
  const byKey = new Map(items.map((i) => [i.key, i]));
  for (const it of items) {
    const open = it.kind === 'work' && it.lane !== 'done';
    it.blockedBy = !open ? [] : it.deps.map((d) => byKey.get(String(d).includes('/') ? d : `${it.wave}/${d}`))
      .filter((d) => d && d.lane !== 'done' && !d.reopened).map(linkOf);
    it.blockedUntil = open ? it.blockedUntil ?? null : null;
    it.blockReason = open ? it.blockReason ?? null : null;
    it.blocked = it.blockedBy.length > 0 || Boolean(it.blockedUntil);
    placeOwnerWait(it, questionById, autoMerge);
    if (it.lane === 'todo' && it.kind === 'work' && !it.held && started(it)) it.lane = 'progress';
    it.unpicked = it.kind === 'work' && it.lane === 'todo' && Boolean(noTakePicked(questions, it.key));
    if (it.unpicked) it.state = 'prototyping';
    if (it.unpicked && !it.action) it.next = PROTOTYPE_AGAIN;
    it.buildable = buildableOf(it);
    // docs/adr/2026-11-03-0516-a-new-card-is-ready-grilling-or-prototyping.md: an unstarted card from an ask, or one an agent
    // added (docs/adr/2026-11-05-0130-the-orchestrator-links-a-new-card-when-it-files-it.md), is unsorted until its session
    // sets its state (shown as its ticket, never New), and ready once Ready with nothing blocking it or waiting on the owner.
    const unstarted = it.kind === 'work' && it.lane === 'todo';
    it.unsorted = unstarted && (Boolean(it.fromAsk) || it.unfiled) && !it.state;
    it.ready = unstarted && it.state === 'ready' && !it.blocked && !it.action;
    // docs/adr/2026-11-07-0700-staging-then-ready.md
    it.staging = unstarted && it.state === 'staging';
  }
  linkCards(items, byKey, storedLinks);
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
    if (it.kind === 'work' && it.lane === 'progress' && !it.builder && !it.next && it.waitsOn !== 'checking' && !it.working) it.next = NO_NEXT;
    it.sortAt = SORT_AT[it.lane](it) || (['review', 'stale'].includes(it.lane) ? null : it.updatedAt) || null;
  }
  for (const it of items) {
    if (it.kind !== 'work') continue;
    const answeredAt = (questionsOn.get(`item:${it.key}`) || []).filter((q) => q.state === 'answered').map((q) => q.answers.at(-1).ts).sort().pop();
    const workingSince = workingOn.filter((w) => w.key === it.key).map((w) => String(w.since)).sort()[0];
    // A rebase run's hand-back, or its stalled run, waits on the orchestrator from In Review (laneOf).
    it.orchestrator = ['progress', 'todo', 'stale'].includes(it.lane) || it.waitsOn === 'checking' || (it.lane === 'review' && it.builder?.stalled) ? orchestratorWaitOf(it, it.waitFacts, { answeredAt, workingSince }) : null;
    delete it.waitFacts;
  }
  // Items arrive in the order the page shows them (public/ui-order.js).
  items.sort(laneOrder);

  const waveBands = waveBandsOf(snapshot, waves, lineups, items, questions, events);
  // Built again after the sort, so the item topics follow the lanes' order.
  const topicList = topicsOf();
  const reviews = reviewsOf({ on: snapshot.autoReview, incoming: snapshot.incoming, records: snapshot.reviewRecords, events, now,
    refs: new Map(items.filter((i) => i.kind === 'work').map((i) => [i.key, i.ref])) });
  const needs = [...needsOf(items, topicList, questions), ...reviewNeeds(reviews)];
  // Waiting on you's pills follow Needs you: a topic with open questions takes its Needs you line's place, the rest keep
  // their order after (docs/adr/2026-11-05-2130-needs-you-feeds-oldest-first.md).
  const needRank = new Map(needs.filter((line) => line.questions).map((line, i) => [line.topic || `item:${line.key}`, i]));
  const rankOf = (t) => needRank.get(t.id) ?? needRank.size;
  topicList.sort((a, b) => rankOf(a) - rankOf(b));
  const inProgress = new Set(needs.filter((line) => line.questions && line.progress).map((line) => `item:${line.key}`));
  for (const t of topicList) if (inProgress.has(t.id)) t.progress = true;
  // The page shows those this browser hasn't seen in the answer banner (docs/adr/2026-10-29-1639-every-ask-is-a-card.md).
  const answers = items.filter((i) => i.ask?.answerAt).sort((a, b) => b.ask.answerAt.localeCompare(a.ask.answerAt))
    .map((i) => ({ key: i.key, id: i.id, text: i.title, at: i.ask.answerAt }));
  return withHub({ kind, main, remote: remote && { host: remote.host, name: `${remote.host}/${remote.path}` }, waves, waveBands, items, moved: Object.fromEntries(moved), answers, owner: questions, ownerTopics: topicList, reviews, needs, working: workingOn.length, workingOn, checks: checksOf(snapshot, now) }, snapshot);
}

// docs/adr/2026-11-04-0349-the-board-is-built-once-per-data-version.md
// A built board with the hub's side added: prompts, this board's pending prompts (../hub/prompts.mjs shown), lead Needs
// you, and listen (hub/boards.mjs listenState) names the watcher's state. buildBoard adds its snapshot's; the server
// adds them to the build it shares, so the hub's state, which changes outside the board's data, is read each time.
export function withHub(built, { listen, prompts } = {}) {
  const needs = [...promptLines(prompts), ...built.needs];
  return { ...built, needs, needsSummary: needsSummary(needs), checks: { ...built.checks, watcher: { listening: 'running', asleep: 'asleep', waking: 'waking' }[listen] || 'stopped' } };
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
  todo: (i) => i.created, progress: (i) => i.progressSince, review: (i) => i.reviewSince, stale: (i) => i.reviewSince,
  done: (i) => i.closedAt, asks: (i) => i.ask.answerAt,
};

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// checked is data/checked.json {at, every (minutes), idle?}, watcher data/watcher.json {since} or null, replyAt the newest reply file's time
// (docs/adr/2026-10-29-1639-the-board-shows-github-checks-and-watcher-health.md). claudeAt is the newest write of Claude's the
// board can see: a reply, a Claude thread line, a working mark, a builder record or a watcher start. checked.json
// doesn't count, since the hub writes it on every poll (hub/github.mjs).
function checksOf({ checked, watcher, replyAt, threads = {}, working = {}, waves = [] }, now) {
  const every = Number(checked?.every) || 30;
  const writes = [
    replyAt, watcher?.since, ...Object.values(working),
    ...Object.values(threads).flat().filter((l) => (l.who || 'claude') === 'claude').map((l) => l.ts),
    ...waves.flatMap((w) => Object.values(w.agents || {}).flatMap((byAgent) => Object.values(byAgent || {})).map((r) => r?.done || r?.started)),
  ].filter((t) => typeof t === 'string' && !Number.isNaN(Date.parse(t)));
  const claudeAt = writes.reduce((latest, t) => (latest && Date.parse(latest) > Date.parse(t) ? latest : t), null);
  const idle = Boolean(checked?.idle);
  return {
    at: checked?.at || null, every: idle ? null : every, idle, late: !idle && Boolean(checked?.at) && now - Date.parse(checked.at) > 2 * every * 60000,
    claudeAt,
  };
}

// Needs you: one line per topic not tied to an item with open questions, and one per item with open
// questions or a draft waiting on Ready, oldest first by since: its card's created time, the key Todo sorts by; a topic with no card
// has none, so it takes when its oldest open question was asked. A line with no stamp comes last,
// in board order; lines of cards in the In Progress lane come first (docs/adr/2026-11-05-2130-needs-you-feeds-oldest-first.md). Answered questions wait on Claude, so they don't count. A held item has
// its line like any other: held only stops the automatic pull (docs/adr/2026-11-05-0500-held-only-stops-the-automatic-pull.md).
// {kind, text, url} is the GET /_claude/needs contract (docs/adr/2026-10-29-1639-sites-report-what-waits-through-claude-needs.md);
// url is relative to the site root.
function needsOf(items, topics, questions) {
  const onItems = new Set(items.map((it) => it.questions?.topic).filter(Boolean));
  const firstOpen = (ids) => ids.find((id) => questions.find((q) => q.id === id)?.state === 'open') || ids[0];
  const fromTopics = topics.filter((t) => t.state !== 'resolved' && t.open > 0 && !onItems.has(t.id)).map((t) => {
    const url = `questions.html#${firstOpen(t.questions)}`;
    const band = /^(?:lineup|wave):(.+)$/.exec(t.id)?.[1] || null;
    return { kind: 'Question', title: t.title, text: `${t.title} · ${plural(t.open, 'question')}`, url, topic: t.id, band, questions: { open: t.open, url }, ready: null,
      since: questions.filter((q) => q.topic === t.id && q.state === 'open').map((q) => q.asked_at).filter(Boolean).sort()[0] || null };
  });
  const fromItems = items.map((it) => {
    const asking = it.questions && it.questions.state !== 'resolved' && it.questions.open > 0 ? { open: it.questions.open, url: `questions.html#${it.questions.first}` } : null;
    const ready = it.waitsOn === 'ready' ? it.pr.url : null;
    // docs/adr/2026-10-29-1639-the-lane-follows-who-acts-next.md: every card with Action needed gets a line.
    const other = !asking && !ready && it.action ? { label: it.action.label, url: it.action.url } : null;
    if (!asking && !ready && !other) return null;
    const title = `${it.ref}: ${it.title}`;
    const text = [title, asking && plural(asking.open, 'question'), ready && 'Ready on GitHub', other?.label].filter(Boolean).join(' · ');
    return { kind: asking ? 'Question' : ready ? 'Tap Ready' : 'Action needed', title, text, url: `#item=${encodeURIComponent(it.key)}`, key: it.key, questions: asking, ready, action: other,
      since: it.created || null, progress: it.lane === 'progress' };
  }).filter(Boolean);
  return [...fromTopics, ...fromItems].sort(oldestFirst);
}
const oldestFirst = (a, b) => (Boolean(b.progress) - Boolean(a.progress)) || (a.since && b.since ? a.since.localeCompare(b.since) : Boolean(b.since) - Boolean(a.since));

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

// A card ready to build: an unstarted work card that isn't held, with state ready and nothing blocking it. Ready says
// the rest: it comes only from staging, and a question, a Grill or Prototype tap, or a Reply takes a card out of it
// (docs/adr/2026-11-07-0700-staging-then-ready.md).
const pullableCard = (i) => i.buildable && i.state === 'ready' && !i.held && !i.blocked;

// docs/adr/2026-11-04-0057-auto-implement-fills-in-progress-up-to-a-cap.md
// A board's Maximum parallel implementers when board.json sets none.
export const MAX_IMPLEMENTERS = 10;

// docs/adr/2026-11-02-1754-an-idle-board-pulls-in-its-top-todo-card.md
// For built items in board order, cap the board's Maximum parallel implementers and pulled the cards the pull started
// builds on: implementers counts the open cards with a running build or waiting in Orchestrator review, a running
// planner and a card waiting on the owner counting as no work
// (docs/adr/2026-11-03-1551-planners-and-implementers-are-two-kinds-of-agent.md); idle while there are none.
// pullable lists the cards ready to build no message a session is working on, in board order, so bumped first and the
// rest newest first (docs/adr/2026-11-03-0516-a-new-card-is-ready-grilling-or-prototyping.md, docs/adr/2026-11-03-1631-the-idle-pull-takes-ready-cards-first.md).
// waiting lists the pulled cards not yet started that still hold a slot: pullable, or still in Todo with a session
// working on them. pulls lists the pullable cards not pulled that fit the free slots: the cap less the implementers and
// waiting (docs/adr/2026-11-04-0057-auto-implement-fills-in-progress-up-to-a-cap.md, docs/adr/2026-11-05-0802-todo-has-no-queue.md).
export function pullOf(items, { cap = MAX_IMPLEMENTERS, pulled = [] } = {}) {
  const open = items.filter((i) => !closedLane(i));
  const running = (i) => (i.agents || []).filter((a) => !a.done);
  const implementers = open.filter((i) => i.waitsOn === 'checking' || running(i).some(builds)).length;
  const pullable = open.filter((i) => pullableCard(i) && !i.working).map((i) => i.key);
  const waiting = open.filter((i) => pulled.includes(i.key) && (pullable.includes(i.key) || (i.buildable && i.working))).map((i) => i.key);
  const pulls = pullable.filter((k) => !waiting.includes(k)).slice(0, Math.max(0, cap - implementers - waiting.length));
  return { idle: !implementers, pullable, waiting, pulls };
}

// docs/adr/2026-11-06-0200-the-board-rebases-a-conflicting-pr-with-a-headless-run.md
// For built items: the open work cards whose PR in the card's repo, draft or ready, GitHub reads CONFLICTING, with no
// agent running on them and no hand-back waiting, each keyed on the PR's head and the base it conflicts with
// ({key: conflict} in sent is the run already started for it). → [{key, pr, branch, conflict}], branch the PR's head branch
export function rebasesDue(items, sent, base) {
  return items.filter((i) => i.kind === 'work' && !closedLane(i) && i.waitsOn !== 'checking' && !(i.agents || []).some((a) => a.started && !a.done)).flatMap((i) => {
    const p = (i.prs || []).find((v) => v.state === 'OPEN' && v.mergeable === 'CONFLICTING' && v.repo === i.repo && v.headRefOid);
    const conflict = p && `${p.headRefOid}@${base}`;
    return p && routeRecord(sent, i.key) !== conflict ? [{ key: i.key, pr: p.number, branch: p.headRefName, conflict }] : [];
  });
}

// docs/adr/2026-11-04-2359-every-card-arriving-in-todo-is-grilled-by-the-board.md
// How many grills and prototypes a board runs at once, unless its max_planners setting says otherwise.
export const MAX_PLANNERS = 3;
// For built items: the cards that arrived in Todo and get a grill now, top first. A card arrives when it is an open work
// card in Todo nothing has picked up: buildable, neither ready nor staging, filed (not New), blocked by no unfinished dep, held or worked on by a session, with
// no planner record ever, no grill or prototype requested and no question topic. However it was filed (an ask, item add,
// the +, an import) it counts the same. The cap, less the planners running, takes them from the top; the rest wait.
export function arrivalsOf(items, { cap = MAX_PLANNERS } = {}) {
  const open = items.filter((i) => !closedLane(i));
  const planners = open.filter((i) => (i.agents || []).some((a) => plans(a) && a.started && !a.done)).length;
  const arrived = open.filter((i) => i.buildable && !['ready', 'staging'].includes(i.state) && !i.unsorted && !i.blocked && !i.held && !i.working && !i.grilling && !i.prototyping
    && !i.questions && !(i.agents || []).some((a) => plans(a) && a.kind !== VISUAL));
  return arrived.slice(0, Math.max(0, cap - planners)).map((i) => i.key);
}

// docs/adr/2026-11-07-0700-staging-then-ready.md
// For built items: the Todo cards sent back from staging or ready to grilling or prototyping (roundAt) whose round no
// planner has started since, and none runs. The board launches each, so the orchestrator never starts a planner.
// → [{key, kind}], kind grill or prototype.
export function roundsDue(items) {
  return items.filter((i) => i.kind === 'work' && i.lane === 'todo' && i.roundAt && ['grilling', 'prototyping'].includes(i.state)
    && !(i.agents || []).some((a) => plans(a) && a.kind !== VISUAL && a.started && (String(a.started) >= String(i.roundAt) || !a.done)))
    .map((i) => ({ key: i.key, kind: i.state === 'grilling' ? 'grill' : 'prototype' }));
}

// docs/adr/2026-11-05-1921-a-visual-is-a-page-an-agent-draws-for-a-thread.md
// For built items and the event log: per card with no visual agent running, its oldest visual-request no agent has
// drawn, the agent of request <id> being named visual-<id>, so a card's requests are drawn one after another.
// → [{key, request}], request being the event.
export const visualAgent = (request) => `${VISUAL}-${request.id}`;
export function visualsDue(items, events) {
  const out = [];
  for (const it of items) {
    const agents = it.agents || [];
    if (agents.some((a) => a.kind === VISUAL && a.started && !a.done)) continue;
    const drawn = new Set(agents.map((a) => a.name));
    const request = events.find((e) => e.kind === 'visual-request' && e.data?.key === it.key && !drawn.has(visualAgent(e)));
    if (request) out.push({ key: it.key, request });
  }
  return out;
}

// docs/adr/2026-11-04-1900-triage-runs-once-overnight-on-cards-waiting-on-your-answers.md
// For built items: the Todo a triage looks at, one line per Todo card, with its key, title and deps, sorted, so a card
// added, dropped, renamed or relinked changes it. '' when Todo is empty.
// A triage also reads the Stale cards; Done cards leave the board by archivedOf, never by a triage
// (docs/adr/2026-11-04-0307-the-board-keeps-the-newest-100-done-cards.md).
export function todoOf(items) {
  return items.filter((i) => i.lane === 'todo' || i.lane === 'stale').map((i) => JSON.stringify([i.key, i.title, i.deps || []])).sort().join('\n');
}

// docs/adr/2026-11-04-1900-triage-runs-once-overnight-on-cards-waiting-on-your-answers.md
// For built items: what an overnight triage looks at. waiting: the keys of the work cards outside Done with open
// questions, in board order; seen: those cards with when each open question was asked, then todoOf, so a question
// asked or answered, or a Todo change, changes it.
export function triageOf(items) {
  const waiting = items.filter((i) => i.kind === 'work' && i.lane !== 'done' && i.questions?.open > 0);
  const asked = waiting.map((i) => JSON.stringify([i.key, i.questions.open, i.questions.askedAt || []])).sort().join('\n');
  return { waiting: waiting.map((i) => i.key), seen: `${asked}\n--\n${todoOf(items)}` };
}

// docs/adr/2026-11-04-0307-the-board-keeps-the-newest-100-done-cards.md
// The board keeps its newest DONE_KEPT Done cards, and GET /api/done pages the archive in as many at a time.
export const DONE_KEPT = 100;
// The fields of a Done card the page draws: the Done lane's card and its open detail (ui-cards.js workLines,
// app-cards.js), the wave bands' "N done" links (app-lanes.js), unread counts (othersAt), the Notes, Questions and
// Prototypes buttons, and ui-snapshot.js updateSign. No page file reads `agents`, and the rest are set on a Done card only to be sent.
export const DONE_FIELDS = ['key', 'kind', 'id', 'ref', 'title', 'lane', 'status', 'wave', 'waveTitle', 'fold', 'internal', 'ticket', 'ticketSource', 'linear', 'pr', 'prs',
  'review', 'reviewers', 'risky', 'sortAt', 'threadCount', 'othersAt', 'hasNotes', 'questions', 'prototypes', 'next', 'ask', 'action', 'actionButton', 'builder', 'working', 'waitsOn',
  'reachedPhase', 'grilling', 'refusal', 'install', 'parent', 'children', 'related', 'waitsOnIt', 'blockedBy', 'ready', 'finishable', 'reopened', 'manualSteps', 'branch', 'worktree'];
export const slimDone = (it) => Object.fromEntries(DONE_FIELDS.filter((f) => f in it).map((f) => [f, it[f]]));

// The built board's Done cards that move to the archive (store.mjs archiveCards): past the newest `keep` by when they
// closed, finished in their wave file, and none that the board still counts or links: a card in a wave band, one an
// unfinished card names as a dep, parent, child or related card, and one with a question not yet resolved.
export function archivedOf(built, keep = DONE_KEPT) {
  const banded = new Set((built.waveBands || []).flatMap((b) => b.keys));
  const linked = new Set(built.items.filter((i) => i.lane !== 'done').flatMap((i) => [
    ...(i.deps || []).map((d) => (String(d).includes('/') ? String(d) : `${i.wave}/${d}`)), i.parent?.key, ...(i.children || []).map((c) => c.key), ...(i.related || []).map((r) => r.key)]));
  return built.items.filter((i) => i.lane === 'done' && i.kind === 'work').sort((a, b) => String(b.closedAt || '').localeCompare(String(a.closedAt || '')))
    .slice(keep).filter((i) => ['done', 'merged', 'dropped'].includes(i.status) && !banded.has(i.key) && !linked.has(i.key) && (!i.questions || i.questions.state === 'resolved'));
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

// docs/adr/2026-11-04-0257-an-idle-board-pushes-once-when-it-has-gone-idle.md
// Strictly idle, for a built board and pulled the cards the pull started builds on: no agent running on an open card, so
// nothing building, grilling or prototyping, no grill or prototype request under way, no card waiting in Orchestrator
// review to land, no pulled card waiting to start and no event a session is working on.
export function strictlyIdle(built, { pulled = [] } = {}) {
  const open = built.items.filter((i) => !closedLane(i));
  const busy = open.some((i) => i.waitsOn === 'checking' || i.grilling || i.prototyping || (i.agents || []).some((a) => !a.done));
  return !busy && !built.working && !pullOf(built.items, { pulled }).waiting.length;
}

// docs/adr/2026-11-04-2300-each-lane-is-a-queue-for-the-orchestrator.md
// What an open work card waits on the orchestrator for, or null: an open builder ask; an owner answer not acted on;
// a staged card's judgment (staging); unless the owner owes it an answer, a hand-back with judgment calls not verified (calls) or a checked card with none left
// (checking); a builder silent past the stall limit (stalled); a review in the Stale lane, from when it crossed seven
// days (stale); a grill or prototype asked for with no planner of that kind running; a refusal by the pull; or a started
// card with no live builder and nothing else placing it (unowned). since is when it began to wait, and picked when the
// session first wrote on the card after that (waitFactsOf), or the watcher marked one of its events working, which the
// card reads as Orchestrator review. → {kind, since, picked, next}, next saying what it waits for.
const STAGING_NEXT = 'Judge the staged card: item set --state ready, or --state grilling or prototyping for another round';
function orchestratorWaitOf(it, facts, { answeredAt, workingSince }) {
  const running = (kind) => it.agents.some((a) => a.kind === kind && a.started && !a.done);
  const lastBuild = [it.progressSince, ...it.agents.map((a) => a.done)].filter(Boolean).map(String).sort().pop() || null;
  const wait = facts.ask ? { kind: 'ask', since: facts.ask.at, next: `Answer the builder's ask: ${facts.ask.text}` }
    : it.staging ? { kind: 'staging', since: it.stagedAt, next: STAGING_NEXT }
    : answeredAt ? { kind: 'answer', since: answeredAt, next: "Act on the owner's answer" }
    : ASKING.has(it.action?.kind) ? null
    : it.builder?.stopped ? { kind: 'stalled', since: it.builder.silentSince, next: `${it.builder.stopped}: start it again when it should run, or drop the card` }
    : it.builder?.stalled ? { kind: 'stalled', since: it.builder.silentSince, next: 'Find out why the builder went silent or stopped, then restart or finish its run' }
    : it.lane === 'stale' && it.inReviewSince ? { kind: 'stale', since: new Date(Date.parse(it.inReviewSince) + STALE_AFTER).toISOString(), next: 'Find out why the review went stale and fix what you can: rebase, CI, comments, a silent reviewer' }
    : it.waitsOn === 'checking' ? facts.unverified ? { kind: 'calls', since: facts.statusAt, next: facts.next || "Verify the builder's judgment calls" }
      : { kind: 'checking', since: facts.statusAt, next: facts.next || 'Land the checked build' }
    : it.grilling && facts.grillAt && !running('grill') ? { kind: 'grill', since: facts.grillAt, next: 'Start the grill asked for' }
    : it.prototyping && facts.prototypeAt && !running('prototype') ? { kind: 'prototype', since: facts.prototypeAt, next: 'Draw the prototype asked for' }
    : it.refusal && facts.refusedAt ? { kind: 'refused', since: facts.refusedAt, next: it.refusal }
    : it.next === NO_NEXT && lastBuild ? { kind: 'unowned', since: lastBuild, next: 'Start a builder on it, or set its Next' }
    : null;
  if (!wait?.since) return null;
  const since = String(wait.since);
  const picked = [facts.writes.find((t) => t > since), workingSince].filter(Boolean).sort()[0] || null;
  return { kind: wait.kind, since, picked, next: wait.next };
}

// The cards idle on the orchestrator in a built board, lanes top-down: In Progress, then Todo, each in the board's order.
// → [{key, ref, title, kind, since, picked, next}]
export function orchestratorWaits(built) {
  return built.items.filter((i) => i.orchestrator).map((i) => ({ key: i.key, ref: i.ref, title: i.title, ...i.orchestrator }));
}
// How long a card waits on the orchestrator, not picked up, before the board pushes the owner about it once.
export const ORCHESTRATOR_PUSH_AFTER = 30 * 60000;

// docs/adr/2026-11-05-2358-nothing-waiting-on-the-orchestrator-is-missed.md
// How long a wait nobody picked up goes between wakes, and how long a picked-up one that stays open goes, from its pickup.
export const REWAKE_AFTER = 15 * 60000;
export const PICKED_REWAKE_AFTER = 60 * 60000;
// One check of the cards idle on the orchestrator, for the stored list (data/orchestrator-waits.json) and the current
// waits (orchestratorWaits) at now: each entry carries bumped, its last wake, and keeps pushed. A wait joins the list when
// its key, kind and since are new, and wakes the session then unless it is already picked up. After that it wakes again
// once REWAKE_AFTER passes since its last wake (or its since, for an entry stored before bumped), and once picked up,
// once PICKED_REWAKE_AFTER passes since the later of its pickup and its last wake.
// → {waits, added: [key], again: [{key, ref, kind, since, next}]}
export function waitsStep(previous, current, now) {
  const at = now.toISOString();
  const added = [];
  const again = [];
  const waits = current.map((w) => {
    const was = previous.find((p) => p.key === w.key && p.kind === w.kind && p.since === w.since);
    if (!was) {
      if (!w.picked) added.push(w.key);
      return { ...w, bumped: at };
    }
    const last = w.picked ? [w.picked, was.bumped].filter(Boolean).sort().pop() : was.bumped || w.since;
    const due = now - Date.parse(last) >= (w.picked ? PICKED_REWAKE_AFTER : REWAKE_AFTER);
    if (due) again.push({ key: w.key, ref: w.ref, kind: w.kind, since: w.since, next: w.next });
    return { ...w, bumped: due ? at : was.bumped || w.since, ...(was.pushed ? { pushed: true } : {}) };
  });
  return { waits, added, again };
}
// The plain line the watcher prints for a re-wake's cards at time at (ms):
// "still waiting on you: <ref> <kind> for <age>: <next>", the cards joined by "; ".
export function waitsAgainLine(again, at) {
  const age = (since) => {
    const minutes = Math.floor((at - Date.parse(since)) / 60000);
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`;
  };
  return `still waiting on you: ${again.map((w) => `${w.ref} ${w.kind} for ${age(w.since)}: ${w.next}`).join('; ')}`;
}

// How long a board stays strictly idle before the idle notification pushes.
export const IDLE_MINUTES = 15;
// One idle check for state, data/idle.json {last, since?, pushed?}: last is when the last idle push went out, or the
// first check's time before any, since when this idle stretch began, pushed whether it pushed. Busy ends the stretch;
// a stretch pushes once, IDLE_MINUTES in. → {state, push}
export function idleStep(state, { idle, now }) {
  const at = now.toISOString();
  const last = state.last || at;
  if (!idle) return { state: { last }, push: false };
  if (!state.since) return { state: { last, since: at }, push: false };
  if (state.pushed || now - Date.parse(state.since) < IDLE_MINUTES * 60000) return { state: { ...state, last }, push: false };
  return { state: { last: at, since: state.since, pushed: true }, push: true };
}

// The idle push's body for built items: the work cards that landed in Done since since, dropped ones left out, and the
// waves (lineups) whose every card is Done with the last one closing since since.
export function idleSummary(items, since) {
  const after = (i) => String(i.closedAt || '') > since;
  const landed = items.filter((i) => i.kind === 'work' && i.lane === 'done' && !droppedCard(i) && after(i));
  const lineups = new Map();
  for (const i of items) if (i.lineup) lineups.set(i.lineup.slug, [...(lineups.get(i.lineup.slug) || []), i]);
  const waves = [...lineups.values()].filter((cards) => cards.every((i) => i.lane === 'done') && cards.some(after)).map((cards) => cards[0].lineup.title);
  const refs = landed.slice(0, 3).map((i) => i.ref).join(', ') + (landed.length > 3 ? ` and ${landed.length - 3} more` : '');
  const parts = [landed.length && `${landed.length} ${landed.length === 1 ? 'card' : 'cards'} landed: ${refs}`, ...waves.map((t) => `${t} finished`)].filter(Boolean);
  return parts.join(' · ') || 'Nothing closed since the last idle notification.';
}
