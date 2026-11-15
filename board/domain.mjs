// The board's domain: turns a snapshot of plain data (item files, builder
// records, PR state, threads, page events, owner questions) into the work
// items, lanes and owner questions every page shows. Pure: callers read the
// files and GitHub, and the pages render what this returns without
// re-deriving state.
//
// A work item's lane, what it waits on and its builder line are decided here
// and nowhere else. A builder record is <item file folder>/agents/<id>.json for agent main, or
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
import { HUB, hubLineOf, hubText } from './hub-lines.mjs';
import { startTitleFault } from './commit-message.mjs';
import { scriptLogName } from './scripts.mjs';
// The ask thread's line that says its card merged into another (hub-lines.mjs, store.mjs relateAsk).
const MERGED_LINE = 'card-merged';

// Page scripts with no exports, which the page loads as is, so node runs them the same way.
const enums = vm.createContext({});
for (const file of ['ui-enums.js', 'ui-order.js']) vm.runInContext(fs.readFileSync(new URL(`./public/${file}`, import.meta.url), 'utf8'), enums);
export const { BUTTON, ACTION_KIND, BUILDER_KIND, PR_STATE, PHASES } = enums.BoardUI;
const { laneOrder, isMessage } = enums.BoardUI;

export const ITEM_EVENTS = ['item-message', 'mark-ready', 'grill-more', 'prototype-request', 'visual-request', 'reask-request'];
// docs/adr/2026-11-14-2359-the-orchestrator-offers-a-script-and-the-owner-holds-run.md
// The events of a script offer on a card, each {key, id}: the owner's Run (with the script's sha), its result (exit,
// output, timedOut, log, ms), written when the run ends, and the owner's Decline.
export const SCRIPT_EVENTS = Object.freeze({ run: 'script-run', result: 'script-result', decline: 'script-decline' });
const SCRIPT_VALUES = Object.values(SCRIPT_EVENTS);
// An offer's state from its events and the newest offer on its card (live): finished or failed once its result is in,
// declined, running from the Run tap, waiting while it is the card's newest offer, else replaced by a newer one.
// → {state, exit?, output?, timedOut?, log?, ms?}
export function scriptStateOf(offer, events, live) {
  const mine = events.filter((e) => e.data?.id === offer.id);
  const result = mine.find((e) => e.kind === SCRIPT_EVENTS.result);
  if (result) {
    const { exit, output, timedOut, log, ms } = result.data;
    return { state: exit === 0 ? 'finished' : 'failed', exit, output: output ?? '', timedOut: Boolean(timedOut), log: log ?? null, ms: ms ?? null };
  }
  if (mine.some((e) => e.kind === SCRIPT_EVENTS.decline)) return { state: 'declined' };
  if (mine.some((e) => e.kind === SCRIPT_EVENTS.run)) return { state: 'running', log: scriptLogName(offer.id) };
  return { state: offer.id === live ? 'waiting' : 'replaced' };
}
// The owner's tap on a sent question's Resolved badge, {key?, question}: the question opens again (ownerQuestion), and
// its card's thread reads "Question N was reopened". A record-only event, which wakes no session.
export const QUESTION_REOPEN = 'question-reopen';
// docs/adr/2026-11-07-1400-a-card-stores-its-lane-and-facts-replace-statuses.md
// The lanes a card is stored in (its item file entry's `lane`, which store.mjs placeIn alone writes), and their names in a
// move's thread line.
export const LANES = Object.freeze({ todo: 'Todo', progress: 'In Progress', review: 'In Review', done: 'Done' });
// The thread line kind of a card's move from one lane to another (store.mjs moveCard).
export const MOVE = 'move';
// How long a run may go without a status line or transcript movement before it reads stale
// (docs/adr/2026-11-13-2030-stale-is-a-footer-word-after-15-minutes.md).
export const BUILDER_STALE_AFTER = 15 * 60000;
// The status line kind (hub-lines.mjs) for a Build tap the board server refused (store.mjs startTappedBuild).
export const BUILD_REFUSED = 'build-refused';
// The thread line kinds of a builder's ask and the orchestrator's answer or deferral of it (store.mjs askOrchestrator).
export const BUILDER_ASK = Object.freeze({ ask: 'builder-ask', answer: 'builder-answer' });
const DAY = 86400000;
// Done holds closed work cards and answered asks (docs/adr/2026-11-09-1430-answered-asks-fold-into-the-one-done-list.md).
const closedLane = (i) => i.lane === 'done';
// A finished item file's Done cards fold under a row of their own, which board/public/app-lanes.js reads back by this id.
// A PR in review longer than this reads stale, still In Review (docs/adr/2026-10-29-1639-a-pr-in-review-shows-its-age-and-goes-stale-after-seven-days.md).
const STALE_AFTER = 7 * DAY;

// board/public/ui-links.js links Linear ids in text from these urls, so a board with no workspace links none.
const linearRef = (id, tickets) => ({ id, url: tickets?.workspace ? `https://linear.app/${tickets.workspace}/issue/${id}` : null });
// Internal items keep their stored ids, which key threads, builder records and events; S<n> reads INT-<n>.
const internalRef = (id) => String(id).replace(/^S(\d+)$/, 'INT-$1');
// A card reads as its ticket when the ticket is from the board's source (#n or TEAM-n), else by its id, T-<n> for a
// task; its key keeps the stored id (docs/adr/2026-11-02-2100-a-card-is-named-by-its-boards-ticket-source.md).
export const refOf = (itemFile, item, tickets) => (ticketIn(tickets, item.ticket) ? item.ticket
  : itemFile.internal === true ? internalRef(item.id) : item.id);
// A stored ticket from another source, an INT-<n> from the retired Internal source included, keeps its own id, unlinked
// (docs/adr/2026-11-09-1500-a-task-is-a-card-with-no-ticket-keyed-t-n.md).
const ticketOf = (tickets, stored, at) => ticketBadge(tickets, stored, at) || (stored ? { id: String(stored), url: null, source: null } : null);

// The lane before owner waits are placed: In Progress while Claude acts next, In Review while the reviewers do, or
// while a pushed branch waits on the owner's merge (docs/adr/2026-11-02-1850-a-board-can-work-on-any-git-remote.md).
// buildBoard places a card that only the owner can move on (docs/adr/2026-10-29-1639-the-lane-follows-who-acts-next.md).
// A reopened card has left Done whatever its PR's state. An open PR is In Review, a draft too whatever its CI, apart
// from red CI on a PR the board marks ready itself, which goes back to Claude: one out of draft, or a draft while the
// board skips the draft (docs/adr/2026-11-04-1913-a-board-can-skip-the-draft.md). A card the board's rebase run works on
// (rebasing) stays in its open PR's lane while the run builds and once it hands back
// (docs/adr/2026-11-06-0200-the-board-rebases-a-conflicting-pr-with-a-headless-run.md). running and checking are the
// card's runs that can change its code, and busy is any run or hand-back: one that can't (an install run, a lander)
// leaves a card with an open PR or a held branch In Review, and puts any other in In Progress
// (docs/adr/2026-11-06-1546-only-a-run-that-changes-code-moves-an-in-review-card.md).
function laneOf(item, pr, running, checking, pushed, reopened, skipDraft, rebasing, busy) {
  if (!reopened && (item.lane === 'done' || pr?.state === 'MERGED' || pr?.state === 'CLOSED')) return 'done';
  if ((running || checking) && !rebasing) return 'progress';
  if (pushed) return 'review';
  if (pr?.state === 'OPEN') return pr.checks?.state === 'fail' && (!pr.isDraft || skipDraft) ? 'progress' : 'review';
  return pr || busy ? 'progress' : 'todo';
}

// The label a lander's builder record carries (headless.mjs landerBrief): it lands a verified build.
export const LANDER = 'Lander';

// docs/adr/2026-11-14-0725-one-land-step-decides-a-verified-cards-land.md
// docs/adr/2026-11-14-0031-a-land-step-reads-landables-skips.md
// The one next step of a verified card's land: the board server's launchLanders acts on it, and the card's status line
// and the orchestrator's waits line print it, so no line promises a launch the server won't make. verified is the
// verification the card waits to land, entry its data/landers.json entry {verified, pid, log, relaunched, handedBack}
// (relaunched counts the launches after the first for that verification), alive whether the entry's process lives,
// held the words for what holds the server's launches of its kind now (shared/usage-gate.mjs launchHeldWords) or null,
// and limited whether the entry's run ended on the usage limit, which spends no relaunch. skip is what store.mjs
// landable skips the card for, or null: {step: 'worktree-gone'}, {step: 'blocked', blocked: blockWords' words} or
// {step: 'asking'} (a question on it is open).
// running: the lander launched for this verification lives. fault: a relaunched lander exited without landing too, or
// the server already said so (handedBack). A skip: no lander launches while it stands. held: the launch waits for the
// hold to clear. launch: the first launch for a verification resumes the card's builder, a relaunch takes a fresh
// lander (fresh).
// → {step, relaunched, fresh?, held?, blocked?}, relaunched the count the entry records with a launch now.
export function landStep({ verified, entry, alive = false, held = null, limited = false, skip = null }) {
  const again = Boolean(entry) && entry.verified === verified;
  const count = again ? entry.relaunched ?? 0 : 0;
  if (again && alive) return { step: 'running', relaunched: count };
  // A block on the task ends a fault: the fix it waits on is the step.
  if (skip?.step === 'blocked') return { ...skip, relaunched: count };
  if (again && (entry.handedBack || (count > 0 && !limited))) return { step: 'fault', relaunched: count };
  if (skip) return { ...skip, relaunched: count };
  if (held) return { step: 'held', held, relaunched: count };
  return { step: 'launch', fresh: again, relaunched: again && !limited ? count + 1 : count };
}
// What each land step says: on the card's status line (card), and as the Next of the orchestrator's wait on it (next).
export const LAND_WORDS = {
  running: { card: () => 'Lander running', next: () => 'A lander is landing the verified build' },
  launch: { card: () => 'Lander starting', next: () => 'The board launches a lander within a minute to land the verified build' },
  held: { card: ({ held }) => `Landing held: ${held}`, next: ({ held }) => `Landing held: ${held}; the board launches a lander once that clears` },
  blocked: { card: ({ blocked }) => `Landing blocked ${blocked}`, next: ({ blocked }) => `Landing blocked ${blocked}; the board launches a lander once nothing blocks it` },
  asking: { card: () => 'Landing waits on its open question', next: () => 'Landing waits on its open question; the board launches a lander once it is answered' },
  'worktree-gone': { card: () => "Lander can't start: its worktree is gone", next: ({ key }) => `Its worktree is gone, so no lander can start: restore ${key}'s worktree from its branch, or ${STALL_NEXT}` },
  fault: { card: () => 'Lander exited twice without landing', next: ({ key }) => `Its lander exited twice without landing: read its log, then file the fix with item add --before ${key} (it blocks this task until the fix lands), board.mjs lander ${key} to try once more, or ${STALL_NEXT}` },
};
// docs/adr/2026-11-06-1546-only-a-run-that-changes-code-moves-an-in-review-card.md
// Whether a build agent's run can change the card's code: not an install run, which builds the app from the branch,
// nor a lander.
const changesCode = (agent) => agent.kind !== BUILDER_KIND.install && agent.label !== LANDER;

// The state of one of a card's PRs (ui-enums.js PR_STATE): merged once GitHub or the PR's merge mark on the card says
// so, or null before GitHub is read.
function prStateOf(pr, mergedAt) {
  if (pr?.state === 'MERGED' || mergedAt) return PR_STATE.merged;
  if (pr?.state === 'CLOSED') return PR_STATE.closed;
  if (pr?.state === 'OPEN') return pr.isDraft ? PR_STATE.draft : PR_STATE.open;
  return null;
}

// A Done card whose least-ready PR closed unmerged: its work never landed.
export const unlanded = (i) => i.pr?.status === PR_STATE.closed;

// docs/adr/2026-11-07-1400-a-card-stores-its-lane-and-facts-replace-statuses.md
// When the card's newest build handed back for the orchestrator's check (store.mjs handBackCalls, relaunchLander): that
// record closed with handed_back, and no build has started since. Install builds don't count. → the time, or null.
export function handedBackAt(agents) {
  const newest = newestBuild(agents);
  return newest?.done && newest.handed_back ? newest.handed_back : null;
}
// A helper's record never stands for the card's build, however late it started.
const newestBuild = (agents) => agents.filter((a) => a?.started && builds(a) && a.kind !== BUILDER_KIND.install && a.kind !== HELPER)
  .sort((a, b) => String(a.started).localeCompare(String(b.started))).at(-1);

// docs/adr/2026-11-12-1400-a-chip-per-pr-reviewer-and-git-approved-waits-for-githubs-decision.md
// A GitHub latest review's state as a review chip reads it; a dismissed or pending one is none.
const REVIEW_STATE = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes', COMMENTED: 'commented' };
// Each reviewer's state, and since when the link has waited on them.
function reviewOf(reviewers, pr, sentAt) {
  return Object.fromEntries(reviewers.map((r) => {
    const state = REVIEW_STATE[routeRecord(pr?.reviews, r.github)] || (Object.hasOwn(sentAt, r.name) ? 'sent' : 'unsent');
    return [r.name, { state, since: state === 'sent' ? routeRecord(sentAt, r.name) : null, github: r.github || null }];
  }));
}
// Each GitHub login beyond the card's reviewers whose latest review approved, asked for changes or commented, Codex's
// bot among them: [{github, state}].
function otherReviewsOf(reviewers, pr) {
  const board = new Set(reviewers.map((r) => r.github));
  return Object.entries(pr?.reviews || {}).filter(([login, verdict]) => REVIEW_STATE[verdict] && !board.has(login))
    .map(([login, verdict]) => ({ github: login, state: REVIEW_STATE[verdict] }));
}

// What the card waits on: the owning session's check of finished work, the builder, the owner's merge of a pushed
// branch, the owner's review of a draft and Ready on GitHub, the CI before the board marks a draft ready itself, the
// reviewers, the merge once GitHub counts it approved, or nothing. buildBoard sets `owner` for the owner's other waits.
// A verified branch held for the owner's Merge waits on the merge, and so does a ready PR on a card no reviewer is on
// (docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md).
function waitsOnOf(lane, pr, builder, checking, pushed, skipDraft, { held, needsApproval }) {
  if (builder?.kind === BUILDER_KIND.install) return 'builder';
  if (checking) return 'checking';
  if (builder) return 'builder';
  if (held && lane === 'review') return 'merge';
  if (pushed && lane === 'review') return 'owner';
  if (lane === 'review' && pr?.state === 'OPEN' && pr.isDraft) return skipDraft ? 'ci' : 'ready';
  if (lane === 'review') return reviewed(pr, needsApproval) ? 'merge' : 'reviewers';
  return null;
}

// Whether a PR's review lets it merge: approved, or on a card no reviewer is on, GitHub asking for no review or changes.
const reviewed = (pr, needsApproval) => pr?.reviewDecision === 'APPROVED' || (!needsApproval && !['REVIEW_REQUIRED', 'CHANGES_REQUESTED'].includes(pr?.reviewDecision));

// A done card has no next step, whatever its item file's `next` still says.
// A card whose PR is ready for review reads its next step from GitHub, never from the item file's `next`, and a card
// waiting on the owner reads its action. While its PR is changing, the builder line takes the place of a next step.
const PROTOTYPE_URL = /(^|\/)prototype-[\w-]+\.html/;
const REVIEW_NEXT = { reviewers: 'Waiting for PR reviewers', merge: 'Approved, merges once CI and the merge state allow', ci: 'Marked ready for review once CI passes' };
// docs/adr/2026-10-29-1752-auto-merge-is-a-board-setting-off-by-default.md
const OWNER_MERGE_NEXT = { waiting: 'Approved, Merge shows once CI and the merge state allow', ready: 'Approved and green: tap Merge', merging: 'Merging' };
// docs/adr/2026-11-04-2100-a-land-waits-for-your-merge.md: a ready PR on a card no reviewer is on, and a held branch.
const UNREVIEWED_MERGE_NEXT = { auto: 'Ready, merges once CI and the merge state allow', waiting: 'Ready, Merge shows once CI and the merge state allow', ready: 'Ready and green: tap Merge' };
const heldNext = (base) => `Verified: tap Merge to land it on ${base}`;
const FIX_CI = 'Fix the failing CI';
const REPLY_WAITS = 'Your reply waits on the orchestrator';
const TAP_DONE = 'Tap Done';
const TAP_CLOSE = 'Tap Close';

// Only Claude's and GitHub's messages are ever unread, and replies, which are Claude's, and the board's fault lines; never
// the owner's lines, their answers included, nor status, agent or ask-link lines, nor the board's other status lines,
// nor the orchestrator's answer to a builder's ask, which leaves the card quiet (ui-threads.js unread;
// docs/adr/2026-11-04-0247-a-builder-asks-the-orchestrator-mid-build.md,
// docs/adr/2026-11-09-1200-the-board-writes-status-lines-and-only-the-orchestrator-writes-messages.md).
const QUIET_KINDS = ['status', 'agent', 'ask-link', 'command', MOVE, BUILDER_ASK.answer];
const countsUnread = (m) => (m.who === 'claude' || m.via === 'github' || m.via === 'board') && (m.kind === HUB ? hubLineOf(m).fault : isMessage(m) && !QUIET_KINDS.includes(m.kind));

// said is the owner's messages and answers in the card's thread (threadOf), and askedAt the asked_at of its questions.
// prs is the card's PRs, [{repo, number, gh}], gh being GitHub's state or null before it is read; the least-ready one
// decides the lane, what it waits on and its Next (docs/adr/2026-11-03-1904-a-card-holds-several-prs-across-repos.md).
// The board's lines while a land waits its turn or a lander takes it over, which leave the card merging.
const STILL_MERGING = ['lander-handoff', 'land-waiting'];
function workItem({ slug, itemFile, it, order, prs, repo, remote, base, builder, reachedPhase, agents, worktree, eta, thread, events, working, said, askedAt, topicItems, prSlack, boardReviewers, now, bumpedAt, holdAsk, closedAt, mergeAt, autoMerge, skipDraft, tickets, landers, landHeld, landSkips, plannerQueued }) {
  // An archived PR the board no longer reads the hub's check for draws what it kept (store.mjs keptPRs). A hub record
  // read without its url (a Done card's PR) keeps the one its repo and number give.
  const views = prs.map((p) => ({ repo: p.repo, number: p.number, ...(p.gh || p.kept || {}), url: (p.gh || p.kept)?.url || prURL(p), status: prStateOf(p.gh, p.merged_at) }));
  const least = leastReady(prs.map((p) => p.gh));
  const pr = prs[least]?.gh || null;
  const prStatus = views[least]?.status ?? null;
  const storedLane = it.lane || null;
  // docs/adr/2026-11-02-0009-the-board-applies-the-owners-hold-resume-and-done-at-once.md
  const tappedDone = Boolean(closedAt) && String(closedAt) > String(it.lane_at || '');
  if (tappedDone) it = { ...it, lane: 'done', closed_at: closedAt, reopened_at: undefined };
  // When the card last closed: its move to Done (the owner's Done until the board applies it), or its PRs' merge.
  const closed = [it.closed_at, ...prs.flatMap((p) => [p.merged_at, p.gh?.mergedAt])].filter(Boolean).map(String).sort().pop() || null;
  // A Done card reopens, and so does one whose PR merged; a reopened one stays open until it moves to Done again
  // (docs/adr/2026-11-02-1952-a-message-or-question-on-a-done-card-reopens-it.md,
  // docs/adr/2026-11-03-1843-a-merged-card-reopens-and-its-pr-badge-shows-the-prs-state.md). A card that never landed,
  // every PR closed unmerged, doesn't reopen
  // (docs/adr/2026-11-07-1400-a-card-stores-its-lane-and-facts-replace-statuses.md).
  const doneAt = String(closed || '');
  const neverLanded = views.length > 0 && views.every((v) => v.status === PR_STATE.closed);
  // The owner's Reopen put the card back in Todo, discussing (store.mjs recordOwnerTap): it reads as a Todo card until a
  // build takes it, merged PR or not, and still counts as finished for the cards waiting on it
  // (docs/adr/2026-11-12-1300-threads-say-reply-with-hold-resume-and-reopen-beside-it.md).
  const backInTodo = it.lane === 'todo' && Boolean(it.reopened_at);
  const reopenedAt = !backInTodo && (it.lane === 'done' || it.reopened_at || prStatus === PR_STATE.merged) && !neverLanded
    ? [...said.filter((m) => m.kind === 'item-message').map((m) => m.ts), ...askedAt].map(String).filter((t) => t > doneAt).sort().pop() || it.reopened_at || undefined : undefined;
  // docs/adr/2026-11-09-1900-every-ask-is-a-task-card-from-the-moment-it-arrives.md: a card the orchestrator answered
  // (store.mjs answerCard) before it was sorted or closed waits as a reopened card Claude has answered does: on the
  // owner's Done in In Review, or on the orchestrator while the owner's reply is unanswered.
  const answeredAt = it.answered_at && !it.phase && !it.closed_at && !reopenedAt ? String(it.answered_at) : undefined;
  const reopenAt = reopenedAt || answeredAt;
  // docs/adr/2026-11-04-0158-a-card-whose-code-landed-stays-in-review-while-an-owner-step-remains.md: the owner step
  // holds a card whose code landed (Done, or its PR merged) in In Review until the owner's Done.
  const ownerStep = it.owner_step && !tappedDone ? String(it.owner_step) : null;
  const landed = (it.lane === 'done' || prStatus === PR_STATE.merged) && !neverLanded;
  // A reopened card keeps only a Next the orchestrator set after the move out of Done; that follow-up work holds it In
  // Progress instead of In Review for the owner's Done (docs/adr/2026-11-07-1300-a-next-set-after-a-reopen-keeps-the-card-in-progress.md).
  const followUp = Boolean(reopenAt) && Boolean(it.next) && String(it.next_at || '') > String(it.reopened_at || closed || '');
  if (reopenAt && !followUp) it = { ...it, next: undefined };
  const checkingAt = handedBackAt(agents);
  // The owner's reply to a reopened card that Claude hasn't answered, since its oldest message still owed one.
  const replyAt = reopenAt ? said.filter((m) => String(m.ts) > doneAt && (m.state === 'waiting' || m.state === 'working')).map((m) => String(m.ts)).sort()[0] || null : null;
  const ownerPending = Boolean(replyAt);
  const key = `${slug}/${it.id}`;
  const reviewers = reviewersOf(itemFile, boardReviewers);
  const sentAt = Object.fromEntries(Object.entries(reviewLinks(itemFile, it, key, topicItems, prLinks(prSlack, prs))).map(([name, link]) => [name, reviewTime(link.ts)]));
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
  const runs = agents.filter((a) => a.started && !a.done && builds(a));
  const checkingCode = Boolean(checkingAt) && changesCode(newestBuild(agents));
  let lane = laneOf(it, pr, runs.some(changesCode), checkingCode, pushed || mergeReady, Boolean(reopenAt) || backInTodo, skipDraft, rebasing, runs.length > 0 || Boolean(checkingAt));
  if (reopenAt && lane === 'todo') lane = 'progress';
  if (backInTodo && !runs.length && !checkingAt) lane = 'todo';
  // docs/adr/2026-11-06-1252-stale-is-automatic-stalled-is-the-orchestrators-flag.md
  const staleReview = lane === 'review' && Boolean(inReviewSince) && now - Date.parse(inReviewSince) > STALE_AFTER;
  const stepWaits = Boolean(ownerStep) && landed && lane === 'done';
  if (stepWaits) lane = 'review';
  let waitsOn = waitsOnOf(lane, pr, builder, Boolean(checkingAt) && lane !== 'done', pushed, skipDraft, { held: mergeReady, needsApproval: reviewers.length > 0 });
  const changing = waitsOn === 'builder' && pr?.state === 'OPEN' && !pr.isDraft;
  const redReady = lane === 'progress' && !waitsOn && pr?.state === 'OPEN' && (!pr.isDraft || skipDraft);
  // A reopened card Claude has answered waits on the owner's Done.
  const awaitsDone = stepWaits || (Boolean(reopenAt) && lane === 'progress' && !waitsOn && !redReady && !ownerPending && !followUp);
  if (awaitsDone) waitsOn = 'owner';
  // docs/adr/2026-11-09-1804-in-progress-means-a-builder-runs.md: In Progress is a builder running on the card. A ready
  // PR gone red, and a reopened card nothing has built since its reopening, the owner's reply unanswered or a follow-up
  // Next set, wait in In Review on the orchestrator until it starts a builder.
  const builtSinceReopen = Boolean(reopenAt) && agents.some((a) => builds(a) && String(a.started || '') > String(reopenAt));
  const idle = lane === 'progress' && !waitsOn && (redReady || (Boolean(reopenAt) && !builtSinceReopen));
  if (idle) lane = 'review';
  const tapped = holdAsk && String(holdAsk.ts) > String(it.held_at || '');
  // A Todo card reads held, and so does an In Progress one, whose build the hold pauses until the owner's Resume
  // (docs/adr/2026-11-09-1300-a-card-pause-stops-its-builder-at-its-next-stopping-point.md,
  // docs/adr/2026-11-12-1300-threads-say-reply-with-hold-resume-and-reopen-beside-it.md); old data can't show one in
  // In Review or Done.
  const held = (lane === 'todo' || lane === 'progress') && (tapped ? Boolean(holdAsk.data.hold) : Boolean(it.held));
  // docs/adr/2026-11-02-1727-a-card-can-be-held-until-a-time.md
  const heldUntil = held ? (tapped ? holdAsk.data.until : it.pick_up_at) || null : null;
  // docs/adr/2026-10-29-1639-a-card-that-hasnt-started-can-be-bumped.md
  // docs/adr/2026-11-06-1700-a-bump-marks-the-priority-through-every-lane.md: every open card bumps, and a bump lasts
  // until its unbump or the card's close, merged or Done; one made before the card last closed is over.
  const bumpable = lane !== 'done';
  const bumpStands = Boolean(bumpedAt) && !(doneAt && String(bumpedAt) <= doneAt);
  // The owner's Merge waits on the session until it merges or writes in the thread, such as why it can't merge yet.
  // A held Merge handed to a lander (finish.mjs landHeld) is still merging; the card stays In Review while it runs.
  const lastClaudeAt = thread.filter((m) => (m.who || 'claude') === 'claude' && !['status', 'command', MOVE].includes(m.kind) && !STILL_MERGING.includes(m.line)).map((m) => String(m.ts)).sort().pop() || '';
  // A held card's tap is recorded on it (store.mjs tapMerge), and the board server's land writes its outcome there.
  const tappedAt = [mergeAt, mergeReady && it.merge_ready.tapped].filter(Boolean).map(String).sort().pop();
  const merging = waitsOn === 'merge' && Boolean(tappedAt) && tappedAt > lastClaudeAt;
  // docs/adr/2026-11-04-2320-a-merge-tap-waits-its-turn-to-land.md: a tap queued behind another land says so in a status line.
  const lastStatus = thread.filter((m) => (m.kind === 'status' || m.kind === HUB) && String(m.ts) > String(tappedAt)).sort((a, b) => String(a.ts).localeCompare(String(b.ts))).at(-1);
  const mergingNext = lastStatus?.line === 'land-waiting' ? `${OWNER_MERGE_NEXT.merging} · ${lastStatus.text[0].toLowerCase()}${lastStatus.text.slice(1)}` : OWNER_MERGE_NEXT.merging;
  // A Build tap the board refused: its reason stays on a Todo card while it is the card's newest line
  // (docs/adr/2026-11-03-0219-a-build-tap-starts-the-build-in-the-board-server.md).
  const newest = thread.filter((m) => !['status', MOVE].includes(m.kind)).sort((a, b) => String(a.ts).localeCompare(String(b.ts))).at(-1);
  const refusal = lane === 'todo' && newest?.line === BUILD_REFUSED ? newest.text : null;
  // docs/adr/2026-11-03-0223-each-lane-has-one-fixed-order.md
  // When the card last came into In Progress: its reopening, else its latest build agent's start.
  const progressSince = reopenAt || agents.filter(builds).map((a) => a.started).filter(Boolean).map(String).sort().pop() || null;
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
  const briefing = lane === 'done' ? null : BRIEF_KINDS.find((k) => (it.briefs || []).some((b) => b.kind === k && !b.brief)) ?? null;
  // A checked card with nothing left to verify waits to land: its land step (landStep), read from the server's lander
  // for it (landers {<key>: {...entry, alive, limited}}), what holds a launch of its kind (landHeld {<kind>: words}) and
  // what store.mjs landable skips it for (landSkips {<key>: skip}), as the server's launchLanders reads them.
  const verifiedAt = agents.map((a) => a.verified?.at).filter(Boolean).map(String).sort().at(-1) ?? null;
  const lander = routeRecord(landers, key);
  const step = waitsOn === 'checking' && verifiedAt && !unverifiedOf(agents)
    ? landStep({ verified: verifiedAt, entry: lander, alive: lander?.alive, limited: lander?.limited, skip: routeRecord(landSkips, key) ?? null, held: routeRecord(landHeld, providerOf(newestBuild(agents)?.kind) ?? 'claude') ?? null }) : null;
  // The card's status line reads the step's words (public/ui-cards.js).
  const land = step && { ...step, words: LAND_WORDS[step.step].card(step) };
  return {
    land,
    key, kind: 'work', order, file: slug, id: it.id, ref: refOf(itemFile, it, tickets), title: it.title, storedLane,
    created: it.created || null, reviewSince: (idle && reopenAt) || it.review_since || inReviewSince || it.merge_ready?.at || it.pushed?.at || it.created || null, progressSince, closedAt: lane === 'done' ? closed : null,
    internal: itemFile.internal === true, repo: itemFile.internal === true && !itemFile.repo ? null : repo,
    lane, waitsOn, builder: waitsOn === 'checking' ? null : builder, reachedPhase, agents, worktree: worktree ?? null, eta, working, reopened: Boolean(reopenedAt) || backInTodo, answered: Boolean(answeredAt), awaitsDone,
    // A planner of the card waits in the server's queue for a launch hold to lift (server.mjs launchPlanner): the
    // card's footer reads paused.
    plannerQueued,
    ownerStep: awaitsDone ? ownerStep : null,
    // docs/adr/2026-11-04-2308-an-owner-step-can-carry-a-code-check.md
    ownerCheck: awaitsDone && ownerStep && it.owner_check ? { words: checkWords(parseCheck(it.owner_check.check)), broken: it.owner_check.broken || null } : null,
    // docs/adr/2026-11-07-0700-staging-then-ready.md: when the card was staged, and when it was last sent back for a round.
    stagedAt: lane === 'todo' && it.phase === 'staging' ? it.staged_at || null : null,
    deps: it.deps || [], blockedUntil: it.blocked_until || null, blockReason: it.block_reason || null, held, heldUntil, risky: Boolean(it.risky), risk: it.risk || null, bumpable, bumpedAt: bumpable && bumpStands ? bumpedAt : null,
    holdable: lane !== 'done', hasNotes: Boolean(it.plan || String(it.notes || '').trim()),
    finishable: lane !== 'done',
    merging, refusal, manualSteps: it.manual_steps || [], fromAsk: it.from_ask || null, unfiled: Boolean(it.unfiled), filedHeld: Boolean(it.filed_held), next: changing || lane === 'done' || waitsOn === 'checking' ? null : idle && ownerPending ? REPLY_WAITS : redReady ? FIX_CI : rebasedNext || reviewNext || it.next || draftNext || null,
    rebaseFailed,
    commit: lane === 'done' && it.landed_sha ? { sha: it.landed_sha.slice(0, 7), url: repo ? `https://github.com/${repo}/commit/${it.landed_sha}` : null } : null,
    branch: it.branch || pr?.headRefName || pushed?.branch || null, pushed: lane === 'done' || stepWaits ? null : pushed,
    mergeReady: lane === 'review' ? mergeReady : null,
    // docs/adr/2026-11-05-1809-the-orchestrator-stops-the-boards-own-runs.md: a Merge tap's land the orchestrator
    // stopped reads so until the next tap.
    // Stale is the board's own reading of no updates: a run silent or gone, or a review past seven days. Stalled is the
    // orchestrator's flag (item stall), its reason, until a message on the card.
    stale: lane !== 'done' && (staleReview || Boolean(builder?.stale)), stalled: it.stalled?.reason || null, ownerWait: ownerWaitOf(it),
    landStopped: lane === 'review' && mergeReady && it.merge_ready.stopped && String(it.merge_ready.stopped) > String(it.merge_ready.tapped || '')
      ? { words: stoppedWords('land'), at: it.merge_ready.stopped } : null,
    ticket: tickets?.source === 'linear' && !it.ticket && it.linear?.length ? null
      : ticketOf(tickets, it.ticket, { repo }),
    ticketSource: tickets?.source || null,
    linear: (it.linear || []).map((id) => tickets?.source === 'linear' ? ticketBadge(tickets, id, { repo }) || linearRef(id, tickets) : linearRef(id, tickets)),
    pr: views[least] || null, prs: views,
    reviewers: reviewers.map((r) => r.name), review: reviewOf(reviewers, pr || prs[least]?.kept, sentAt),
    otherReviews: otherReviewsOf(reviewers, pr || prs[least]?.kept), inReviewSince,
    threadCount: thread.length + events.length, lastTs, othersAt,
    grilling: planningOf('grill', events, agents, askedAt), prototyping: planningOf('prototype', events, agents, askedAt),
    // docs/adr/2026-11-12-0600-every-planner-launches-from-the-orchestrators-brief.md: the card's briefs, owed or
    // waiting to launch, the kind whose brief the orchestrator owes (briefing), and the card's blue status word for them:
    // the brief's while it is owed, else generating visual while a visual agent draws.
    briefs: lane === 'done' ? [] : it.briefs || [], briefing,
    planning: briefing ? BRIEF_WORD[briefing] : agents.some((a) => a.kind === VISUAL && a.started && !a.done) ? PLANNER_WORD[VISUAL] : null,
    storedPhase: it.phase || null, phase: null, recheckAt: it.recheck_at || null,
    // docs/adr/2026-11-12-0500-a-new-task-is-a-conversation.md: whose turn a discussing card is, the orchestrator's
    // while an owner message or answer on it is unanswered, otherwise the owner's.
    turn: lane === 'todo' && it.phase === 'discussing' ? (said.some((m) => m.state === 'waiting' || m.state === 'working') ? 'claude' : 'owner') : undefined,
    updatedAt: pr?.mergedAt || pr?.updatedAt || prs[least]?.merged_at || builder?.at || lastTs || null, ask: null, action: null,
    install: lane === 'done' ? null : installOf(it.install, pr),
    waitFacts: waitFactsOf(it, { agents, thread, events, refusedAt: refusal ? newest.ts : null, replyAt: idle ? replyAt : null }),
  };
}

// Whether any of a card's records holds a judgment call made since its verification, or with none.
const unverifiedOf = (agents) => agents.some((a) => a.calls.some((c) => !a.verified || String(c.at) > String(a.verified.at)));

// docs/adr/2026-11-04-2300-each-lane-is-a-queue-for-the-orchestrator.md
// What a card's wait on the orchestrator is read from (orchestratorWaitOf), kept on the item only until buildBoard places
// it: when its build handed back and its stored Next, its oldest builder ask with no answer, its newest grill and
// prototype requests, when the pull refused it, the owner's reply it waits on in In Review, whether its records hold
// unverified calls, and the session's writes on it: a thread line of Claude's other than a status, agent, move,
// refusal or board command line (staged, related, followup: the board writes those, not the session), a verify and a builder start.
function waitFactsOf(it, { agents, thread, events, refusedAt, replyAt }) {
  const answered = new Set(thread.filter((m) => m.kind === BUILDER_ASK.answer).map((m) => m.ask));
  const ask = thread.filter((m) => m.kind === BUILDER_ASK.ask && !answered.has(m.ask)).sort((a, b) => String(a.ts).localeCompare(String(b.ts)))[0];
  const requestAt = (kind) => events.filter((e) => isRequest(e, kind)).pop()?.ts || null;
  const lines = thread.filter((m) => (m.who || 'claude') === 'claude' && !m.command && !['status', 'agent', MOVE].includes(m.kind) && m.line !== BUILD_REFUSED).map((m) => m.ts);
  return {
    handedBackAt: handedBackAt(agents), next: it.next || null, ask: ask ? { at: ask.ts, text: ask.text } : null,
    unasked: thread.filter((m) => m.line === 'planner-unasked').sort((a, b) => String(a.ts).localeCompare(String(b.ts))).map((m) => ({ at: m.ts, kind: m.detail })).pop() || null,
    unplaced: thread.filter((m) => m.line === 'visual-unplaced').map((m) => m.ts).sort().pop() || null,
    pages: thread.filter((m) => m.kind === VISUAL).map((m) => m.ts),
    grillAt: requestAt('grill'), prototypeAt: requestAt('prototype'), refusedAt, replyAt, unblockedAt: it.unblocked_at || null,
    unverified: unverifiedOf(agents),
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

// docs/adr/2026-11-15-0800-owner-actions-follow-state-gone-pushes-close-stale-taps-refused.md
// The phases a Todo card owes the owner's Implement from; a staged or ready one has had it.
export const OWES_IMPLEMENT = ['new', 'discussing'];
// The orchestrator's mark on raw item it (implement or close), or null: a mark holds the phase and lane it was set in
// (store.mjs ownerMark) and stands only while the card keeps both, so no stored mark owes what the card's state
// contradicts. A mark from before marks held them stands as it was. An item with no phase or lane yet reads new in
// Todo, as the board's settle pass writes it.
export const markedState = (item) => ({ phase: item.phase || 'new', lane: item.lane || 'todo' });
function ownerWaitOf(it) {
  const mark = it.waits_on_owner;
  if (!mark) return null;
  const now = markedState(it);
  if (mark.phase !== undefined && (mark.phase !== now.phase || mark.lane !== now.lane)) return null;
  return mark.on;
}

// What the owner acts on next, or null: {kind, url, label}, url relative to the site root. kind is pick (a prototype
// question), questions, ready (a draft's review, then Ready on GitHub), done (an ask's Done in its thread), steps (manual
// steps on an approved PR, which the session never merges on its own) or merge (the open card's Merge, while the board's
// auto-merge is off, and always on a verified branch held for it), or, ahead of all of them, stalled (a card the
// orchestrator stalled, cleared by a message in its thread), then script (an offered script waiting on the owner's Run
// or Decline in its thread). A held card waits on nobody, and a reopened card
// waiting only on its Done has no action. Held only stops the automatic pull, so a held card has actions like any other
// (docs/adr/2026-11-05-0500-held-only-stops-the-automatic-pull.md).
function actionOf(it, questionById, autoMerge) {
  if (closedLane(it)) return null;
  const thread = `#selectedCard=${encodeURIComponent(it.key)}`;
  if (it.stalled) return { kind: ACTION_KIND.stalled, url: thread, label: `stalled: ${it.stalled}` };
  if (it.scriptWaiting) return { kind: ACTION_KIND.script, url: thread, label: 'Run or decline the script' };
  if (asking(it)) {
    const q = questionById.get(it.questions.first);
    if (PROTOTYPE_URL.test(q?.url || '')) return { kind: ACTION_KIND.pick, url: `questions.html#${q.id}`, label: 'Prototypes ready: pick a take' };
    return { kind: ACTION_KIND.questions, url: `questions.html#${it.questions.first}`, label: `Answer ${plural(it.questions.open, 'question')}` };
  }
  if (it.ownerWait === 'implement' && it.lane === 'todo' && OWES_IMPLEMENT.includes(it.storedPhase || 'new')) return { kind: ACTION_KIND.implement, url: `${thread}&reply`, label: 'Tap Implement' };
  // docs/adr/2026-11-12-0800-reply-close-marks-a-card-waiting-to-be-closed.md
  if (it.ownerWait === 'close') return { kind: ACTION_KIND.close, url: `${thread}&reply`, label: it.storedLane === 'review' ? TAP_DONE : TAP_CLOSE };
  if (it.waitsOn === 'ready') return { kind: ACTION_KIND.ready, url: it.pr.url, label: `Review draft PR #${it.pr.number}` };
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
// The note a question an Implement tap skipped is resolved with.
export const IMPLEMENT_SKIPPED = 'Skipped: you tapped Implement';
// Card key's answers to its prototype questions and prototype requests on any of its questions (ownerQuestion views)
// go by chain, a question and the rounds that follow it (round_of). A chain whose newest input is a request or an answer
// that picks none of the takes leaves the card unready to build
// (docs/adr/2026-11-03-1803-a-question-asked-for-a-prototype-is-resolved.md,
// docs/adr/2026-11-14-2300-picked-prototypes-draw-in-parallel-and-their-records-merge-by-topic.md).
// → the newest such input's {id, note}, or null.
export function noTakePicked(questions, key) {
  const mine = questions.filter((q) => q.topic === `item:${key}`);
  const byId = new Map(mine.map((q) => [q.id, q]));
  const chainOf = (q) => (byId.has(q.round_of) ? chainOf(byId.get(q.round_of)) : q.id);
  // An Implement tap's skip of a chain's question ends the chain's inputs older than the skip.
  const skippedAt = new Map();
  for (const q of mine) if (q.resolved === IMPLEMENT_SKIPPED) skippedAt.set(chainOf(q), String(q.resolved_at));
  const again = (q, ts, picksNone) => picksNone && !(String(ts) < (skippedAt.get(chainOf(q)) ?? ''));
  const inputs = [...mine.filter((q) => PROTOTYPE_URL.test(q.url || '')).flatMap((q) => q.answers.map((a) => ({ q, a, again: again(q, a.ts, picksNoTake(q, a.choice)) }))),
    ...mine.filter((q) => q.request).map((q) => ({ q, a: q.request, again: again(q, q.request.ts, true) }))].sort((x, y) => String(x.a.ts).localeCompare(String(y.a.ts)));
  const newest = new Map(inputs.map((input) => [chainOf(input.q), input]));
  const last = inputs.filter((input) => input.again && newest.get(chainOf(input.q)) === input).at(-1);
  return last ? { id: last.q.id, note: last.a.note.replace(/\s+/g, ' ').trim() } : null;
}
// docs/adr/2026-11-03-1646-a-prototype-answer-with-no-pick-prototypes-again.md
// A Todo card's Next while noTakePicked holds it: the card is prototyping, and the next round is its way out.
export const PROTOTYPE_AGAIN = 'Prototype again';

// The open card's button that resolves each action kind, which the board page colours orange: an action button, the
// PR's Review on GitHub, Merge, or a script offer's Run in its thread (public/ui-threads.js scriptCard).
const RESOLVED_BY = Object.freeze({
  [ACTION_KIND.pick]: BUTTON.openQuestions, [ACTION_KIND.questions]: BUTTON.openQuestions, [ACTION_KIND.ready]: BUTTON.github,
  [ACTION_KIND.steps]: BUTTON.github, [ACTION_KIND.merge]: BUTTON.merge, [ACTION_KIND.stalled]: BUTTON.reply, [ACTION_KIND.implement]: BUTTON.implement, [ACTION_KIND.close]: BUTTON.done, [ACTION_KIND.script]: BUTTON.run,
});

// docs/adr/2026-10-29-1639-the-lane-follows-who-acts-next.md
// A card only the owner can move on goes to In Review, apart from a Todo card waiting on its questions, which stays in
// Todo (docs/adr/2026-10-30-1309-an-unstarted-card-waits-on-its-questions-in-todo.md). One Claude still works on, or one already
// waiting on the reviewers, keeps its lane; either way it carries its action. A reopened card that waits only on the
// owner's Done goes to In Review with no action
// (docs/adr/2026-11-03-0137-a-card-waiting-only-to-be-closed-has-no-action-needed.md).
// A card whose only open questions are its builder's deferred asks waits on the owner from where it is, with Open
// questions and no Action needed (docs/adr/2026-11-04-0247-a-builder-asks-the-orchestrator-mid-build.md).
// docs/adr/2026-11-06-0102-a-block-past-todo-bumps-a-build-and-holds-a-land.md: a blocked card's Merge shows disabled,
// mergeBlocked its tooltip naming what blocks it, with no Action needed.
const MERGE_BLOCKED_NEXT = 'Merges once unblocked';
const mergeBlockedWords = (it) => `Blocked ${[it.blockedBy.length && `by ${it.blockedBy.map((d) => d.ref).join(', ')}`, it.blockedUntil && `until ${it.blockedUntil}`].filter(Boolean).join(' and ')}`;
function placeOwnerWait(it, questionById, autoMerge) {
  it.action = actionOf(it, questionById, autoMerge);
  it.mergeBlocked = it.action?.kind === ACTION_KIND.merge && it.blocked ? mergeBlockedWords(it) : null;
  if (it.mergeBlocked) Object.assign(it, { action: null, next: MERGE_BLOCKED_NEXT });
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
  // docs/adr/2026-11-12-2300-a-finished-ask-waits-in-todo-with-an-orange-close.md: an ask stored In Review before that
  // stays there with the close mark, waiting on the owner's Done, with no phase.
  if (it.action?.kind === ACTION_KIND.close && it.lane === 'todo' && it.storedLane === 'review' && !it.held) {
    Object.assign(it, { lane: 'review', waitsOn: 'owner', next: it.action.label });
    return;
  }
  const ownerOnly = it.lane === 'todo' || it.waitsOn === 'ready' || (it.lane === 'progress' && it.waitsOn === 'owner');
  // A stalled card stays in the lane it stalled in.
  if (!it.action || !ownerOnly || it.stalled) return;
  const lane = it.lane === 'todo' && (ASKING.has(it.action.kind) || it.action.kind === ACTION_KIND.implement || it.action.kind === ACTION_KIND.close) ? 'todo' : 'review';
  Object.assign(it, { lane, waitsOn: it.waitsOn === 'ready' ? 'ready' : 'owner', next: it.action.label });
}

// docs/adr/2026-10-29-1639-a-started-card-never-returns-to-todo.md
// docs/adr/2026-11-03-0202-a-card-moves-to-in-progress-only-once-building-starts.md
// A work card has started once it is stored past Todo (store.mjs placeIn: a build's start moves it, a block or a
// launch that failed moves it back); one never placed, once building has: a build agent's record, running or finished.
// A PR, a pushed branch and a hand-back place it on their own (laneOf).
const started = (storedLane, agents) => (storedLane ? storedLane !== 'todo' : agents.some(builds));

// docs/adr/2026-11-03-0237-an-in-progress-card-always-has-a-builder-line-or-a-next.md
// An In Progress card shows its builder line while a builder record is open, else its Next. buildBoard gives one with
// neither this as its Next; owesNext is store.mjs's check before a write that would leave one so.
export const NO_NEXT = 'none set yet';
// Whether a work item's item file entry and builder records leave its card started with no open record and no Next, where
// nothing else gives it a line or places it: a PR or pushed branch (GitHub or the owner's merge words most of those,
// and buildBoard's gap the rest), a hand-back, a hold, or Done.
export function owesNext(item, records) {
  const agents = records.filter((r) => r?.started);
  if (item.next || hasPR(item) || item.pushed || item.held || item.lane === 'done' || handedBackAt(agents)) return false;
  return !agents.some((r) => !r.done) && started(item.lane, agents);
}

// Two kinds of agent: planners, the grill and prototype agents, which write no output code, and implementers, every
// other kind. A planner works toward a build, so it never starts a card or puts it in In Progress, and its lines are
// the owner's blue (docs/adr/2026-11-03-0202-a-card-moves-to-in-progress-only-once-building-starts.md,
// docs/adr/2026-11-03-1551-planners-and-implementers-are-two-kinds-of-agent.md).
// A visual agent is a planner too, drawing one page for the thread beside whatever else runs on the card: it is no
// card's work, so the card's status and its arrival for a grill pass it by
// (docs/adr/2026-11-05-1921-a-visual-is-a-page-an-agent-draws-for-a-thread.md).
export const VISUAL = 'visual';
// docs/adr/2026-11-06-0425-the-implementer-limit-counts-agents-and-a-card-spawns-helpers.md
// A helper is an agent another agent on the card asked for (board.mjs agent launch), with a task, under its own name:
// an implementer, which takes a slot only when it writes (in its own worktree off the card's branch).
export const HELPER = 'helper';
const PLANNERS = new Set(['grill', 'prototype', VISUAL]);
export const plans = (agent) => PLANNERS.has(agent.kind);
export const builds = (agent) => !plans(agent);
// A planner's word, never a builder phase: its card reads it before the planner's first line and leads each line with
// it (docs/adr/2026-11-04-0131-every-new-task-is-grilled-or-prototyped-at-once.md). A running visual agent's card reads
// generating visual.
export const PLANNER_WORD = { grill: 'grilling', prototype: 'prototyping', [VISUAL]: 'generating visual' };
// docs/adr/2026-11-12-0600-every-planner-launches-from-the-orchestrators-brief.md
// The kinds of agent the board launches only from the orchestrator's brief, and a card's status word while the
// orchestrator owes that brief.
export const BRIEF_KINDS = ['grill', 'prototype', VISUAL];
export const BRIEF_WORD = { grill: 'preheating', prototype: 'planning prototype', [VISUAL]: 'planning visual' };

// docs/adr/2026-11-05-1809-the-orchestrator-stops-the-boards-own-runs.md
// The words for what the orchestrator did to a card's run (build, land), as its status line and thread line read:
// "land stopped by orchestrator".
export const orchestratorDid = (run, act) => `${run} ${act} by orchestrator`;
export const stoppedWords = (run) => orchestratorDid(run, 'stopped');
// The owner's request of a planner kind on a card: a Grill tap (grill-more, on the card or one of its questions) or a
// card's Prototype tap (prototype-request with no question: a question's reads requested instead). Under way while a planner of that kind runs, or while the newest request has no reply, no
// question was posted after it and no planner of that kind that started with or after it has finished; the board
// server opens the planner in the request's own millisecond.
const REQUEST_KIND = { grill: 'grill-more', prototype: 'prototype-request' };
const isRequest = (e, kind) => e.kind === REQUEST_KIND[kind] && !(kind === 'prototype' && e.data?.question);
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
    for (const q of built.owner.filter((x) => x.topic === `item:${it.key}` && x.state === 'requested' && x.request.kind === 'prototype-request')) out.push({ key: it.key, request: q.request.id, question: q.id, since: q.request.ts });
  }
  return out;
}

// An item's agents, oldest first, from its records by agent name. A past run's record (store.mjs keepPastRun, named
// past-<ms>) is no agent of the card; only the thread, which folds its lines, asks for it with withPast.
function agentsOf(records = {}, withPast = false) {
  return Object.entries(records).filter(([name, r]) => r && typeof r === 'object' && (withPast || !name.startsWith('past-'))).map(([name, r]) => ({
    name, kind: providerOf(r.kind) || null, model: r.model || (r.kind === 'opus' || r.kind === 'sonnet' ? r.kind : null), label: r.label || null, started: r.started || null, eta: r.done ? null : r.eta || null, done: r.done || null,
    // pid: the headless process the board launched for it (store.mjs recordSession), none for a session's own agent.
    log: r.session?.log || null, pid: r.session?.pid ?? null, calls: Array.isArray(r.calls) ? r.calls : [], verified: r.verified || null, stopped: r.stopped || null, handed_back: r.handed_back || null, ...(r.pause ? { pause: r.pause } : {}),
    ...(r.kind === HELPER ? { writes: Boolean(r.writes), requested: r.requested || null } : {}), ...(r.waits ? { waits: r.waits } : {}),
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
  return stepOf(lines.filter((m) => m.kind === 'status' && m.phase && !m.planner && String(m.ts) >= since).sort((a, b) => String(a.ts).localeCompare(String(b.ts))).pop()?.phase) || null;
}
// docs/adr/2026-11-14-0600-builders-run-only-their-own-tests-and-the-land-runs-affected-once.md: a line's build step,
// a line written in the testing step, which a builder's own tests in building replaced, reading building.
const stepOf = (phase) => (phase === 'testing' ? 'building' : phase);

// A run's silence is the time since its newest progress line or movement in its worktree's Claude transcript (moved
// {<worktree path>: ms}, server.mjs snapshot); a run with no readable transcript has its progress lines alone. alive is
// whether the card's headless process lives (server.mjs snapshot alive), null when the board tracks none for it, or
// 'held' while the board holds its launch for a usage pause: held, never stale, since the board launches it once the
// pause lifts (server.mjs reviveHeadless), so it is no wait on the orchestrator.
// A live one is never stale; a gone one is stale at once; an untracked one is stale after BUILDER_STALE_AFTER of silence
// (docs/adr/2026-11-13-2030-stale-is-a-footer-word-after-15-minutes.md).
// A run the orchestrator stopped (a record's stopped {run, at}, written since that record last started) reads stopped
// with its words from the stop, gone and waiting on the orchestrator from then.
function builderOf(agents, lines = [], now, movedAt = null, alive = null) {
  const open = agents.filter((a) => a.started && !a.done && a.kind !== VISUAL);
  const planner = open.every(plans);
  const running = planner ? open : open.filter(builds);
  const since = running.map((a) => String(a.started || '')).sort()[0];
  if (since === undefined) return null;
  // Only a still-running run's lines (a line from before lines kept their run counts by its time): a finished run
  // posts no closing line, and its last progress line no longer stands.
  const runs = new Set(running.map((a) => a.started));
  const line = lines.filter((m) => m.kind === 'status' && (m.run === undefined ? String(m.ts) >= since : runs.has(m.run)) && (planner || !m.planner)).sort((a, b) => String(a.ts).localeCompare(String(b.ts))).pop();
  // A helper runs on Claude, and the card's own run names its kind while one runs.
  const own = running.filter((a) => a.kind !== HELPER).at(-1);
  const kind = running.some((a) => a.kind === BUILDER_KIND.install) ? BUILDER_KIND.install : own ? providerOf(own.kind) : 'claude';
  const stop = planner ? null : running.find((a) => a.stopped && String(a.stopped.at) >= String(a.started))?.stopped;
  const quiet = line?.ts || since;
  const silentSince = stop ? stop.at : movedAt !== null && movedAt > Date.parse(quiet) ? new Date(movedAt).toISOString() : quiet;
  const progress = line ? (line.phase || line.planner ? line.text.replace(': ', ' · ') : line.text || null) : planner ? PLANNER_WORD[kind] : null;
  const silent = now - Date.parse(silentSince);
  // Once a build asked to pause has paused it is neither live nor stale, since the board
  // resumes it when its cause clears (docs/adr/2026-11-09-1300-a-card-pause-stops-its-builder-at-its-next-stopping-point.md).
  const pause = planner ? null : running.find((a) => a.pause)?.pause ?? null;
  const held = !planner && !stop && (alive === 'held' || Boolean(pause?.paused));
  const live = planner || held ? null : stop ? false : alive;
  const stale = held ? false : live === null ? silent >= BUILDER_STALE_AFTER : !live;
  return { progress, phase: stepOf(line?.phase) || null, at: quiet, kind, planner, silentSince, stale, alive: live, held, stopped: stop ? stoppedWords(stop.run) : null,
    ...(pause ? { pause: { cause: pause.cause, words: pause.words, paused: Boolean(pause.paused) } } : {}) };
}

// docs/adr/2026-11-09-1300-a-card-pause-stops-its-builder-at-its-next-stopping-point.md
// What each cause of a card pause says once the builder has stopped ("It resumes once …") and when it resumes
// ("Resumed: …"). A bump-out (bumped) was a pause a bump past the cap made before the implementer limit counted cards
// In Progress; a record left with one resumes on the next pass
// (docs/adr/2026-11-13-1126-the-implementer-limit-counts-cards-in-progress.md).
export const PAUSE_CLEARS = {
  blocked: ['nothing blocks it', 'nothing blocks it'],
  held: ['you unhold it', 'unheld'],
  usage: ['the usage pause lifts', 'the usage pause lifted'],
  bumped: ['a slot frees', 'a slot freed'],
};
// How long a build asked to pause may run on without reaching a stopping point before the board stops it.
export const PAUSE_HARD_STOP = 15 * 60_000;
// The card's open main build, the one a pause rides on, or null.
const mainBuild = (it) => (it.agents || []).find((a) => a.name === 'main' && a.started && !a.done && builds(a)) ?? null;
// Whether anything still pauses the card's build: a block, a hold, or a usage pause on its kind (usageHeld(kind)) or a
// usage limit that hasn't reset.
const stillPaused = (it, pause, kind, { now, usageHeld }) => it.blocked || it.held || usageHeld(kind ?? 'claude')
  || Boolean(pause.until && now < Date.parse(pause.until));
// One pass of the board's card pauses over built items. → {ask, drop, stop, resume}, each a list of keys: ask the
// running builds a usage pause on their kind (usageHeld(kind)) now holds, neither pausing already nor landing; drop
// the pauses whose cause cleared before their builder stopped; stop the builds still running PAUSE_HARD_STOP after
// they were asked; resume the paused builds nothing pauses any more, oldest pause first, each on its card's own slot.
export function pauseWork(items, { now = Date.now(), usageHeld }) {
  const out = { ask: [], drop: [], stop: [], resume: [] };
  const resumes = [];
  for (const it of items) {
    if (it.kind !== 'work' || it.lane !== 'progress') continue;
    const run = mainBuild(it);
    if (!run) continue;
    const { pause } = run;
    if (!pause) {
      if (it.builder?.phase !== 'landing' && usageHeld(run.kind ?? 'claude')) out.ask.push(it.key);
      continue;
    }
    const still = stillPaused(it, pause, run.kind, { now, usageHeld });
    if (pause.paused) { if (!still) resumes.push({ key: it.key, at: pause.paused }); continue; }
    if (!still) out.drop.push(it.key);
    else if (now - Date.parse(pause.at) >= PAUSE_HARD_STOP) out.stop.push(it.key);
  }
  out.resume = resumes.sort((a, b) => String(a.at).localeCompare(String(b.at))).map((r) => r.key);
  return out;
}

// docs/adr/2026-11-10-1400-the-auto-pass-re-reads-a-pause-before-dropping-it.md
// The drops a fresh read of the built items still lists: a Hold writes the item file and then the builder's record, so
// a snapshot between the two reads the pause without the hold. → the keys of drops that fresh drops as well.
export function confirmedDrops(drops, fresh, opts) {
  const again = pauseWork(fresh, opts).drop;
  return drops.filter((key) => again.includes(key));
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
// resolution covers it. request is the owner's newest prototype-request or grill-more for it after its last answer: the
// question reads requested until a question naming it in round_of (a prototype's) or the grill's next questions on its
// card (a grill-more's) resolve it
// (docs/adr/2026-11-04-2130-a-prototype-request-waits-for-its-prototype.md,
// docs/adr/2026-11-15-1100-grill-more-hands-its-question-to-the-grill.md). answerEvents are owner-answer events and
// requestEvents prototype-request and grill-more events, oldest first; store.mjs reads their states to close a card's questions.
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
  return { ...q, state, reopened, request: req ? { id: req.id, kind: req.kind, ts: req.ts, note: req.data.note || '', choice: req.data.choice || null } : null, reask: reask ? { id: reask.id, ts: reask.ts } : null,
    answers: answers.map((e) => ({ ts: e.ts, choice: e.data.choice || null, note: e.data.note || '', files: e.data.files || [], reply: e.reply, replies: e.replies, acted: resolvedSince(q, e.ts) })) };
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
  const req = qs.find((q) => q.request?.kind === 'prototype-request' && !qs.some((x) => roundOf(x) > roundOf(q)));
  if (req) return { n: roundOf(req) + 1, state: 'making' };
  const n = Math.max(0, ...qs.map(roundOf));
  if (!n) return null;
  const settled = roundSettledBy(qs, n);
  if (settled) return { n, state: 'closed', take: settled.choice };
  return qs.some((q) => roundOf(q) === n && q.state !== 'resolved') ? { n, state: 'back' } : null;
}

// docs/adr/2026-11-07-0300-prototypes-have-their-own-button-and-viewer.md
// A card's prototypes, for the viewer's rounds (prototype-switcher.js): each of
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
// A card's questions use topic `item:<file>/<id>`.
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
// docs/adr/2026-11-06-0021-a-button-without-a-text-box-posts-a-keyed-status-line.md
// A button with no text box, or with nothing typed in it, posts a status line in the thread and never a message: a
// muted request entry carrying its command key, whose words are COMMANDS[command] (ui.js MARK_ICONS holds each one's
// icon). The orchestrator reads the key when the card has no clearly defined next step (SKILL.md lists each).
// A Grill, Prototype or Visual tap with nothing typed, or a resolved question's re-ask, is such an entry from its event;
// the session builds the planner's prompt from the event (docs/adr/2026-11-04-0131-every-new-task-is-grilled-or-prototyped-at-once.md).
// A bare Implement, a Hold, Resume or Done, and a New task sent with Implement are such lines from the thread file or ask.
// A request with text, a question's prototype, grill or visual request (its question, pick and note), a New task sent
// with a request and an answer are the owner's messages, with the tap's words as their footer's status
// (docs/adr/2026-11-04-2130-a-button-tap-is-a-status-line-or-a-message-footer.md).
export const COMMANDS = {
  prototype: 'Prototype requested', grill: 'Grill requested', visual: 'Visual requested',
  reask: 'Re-ask requested', hold: 'Held', resume: 'Resumed', done: 'Marked done', reopened: 'Reopened',
  discussing: 'Marked as discussing', staged: 'Marked as staged', readied: 'Marked as ready',
  related: 'Related to', unrelated: 'Unrelated from', followup: 'Follow-up', 'followup-of': 'Follow-up of',
  created: 'Created ticket', 'created-from': 'Created from', 'blocked-by': 'Blocked by', unblocks: 'Unblocks',
};
// Each tap command's tone (hub-lines.mjs TONES): a request for a planner is blue like a planner's own lines.
export const COMMAND_TONES = {
  prototype: 'blue', grill: 'blue', visual: 'blue', reask: 'blue', hold: 'grey', resume: 'orange', done: 'green', reopened: 'grey',
  discussing: 'grey', staged: 'orange', readied: 'green', related: 'grey', unrelated: 'grey', followup: 'grey', 'followup-of': 'grey',
  created: 'blue', 'created-from': 'blue', 'blocked-by': 'grey', unblocks: 'grey',
};
const REQUEST_COMMANDS = { 'grill-more': 'grill', 'prototype-request': 'prototype', 'visual-request': 'visual', 'reask-request': 'reask' };
export const ACTION_LABELS = { 'mark-ready': 'Mark ready', ...Object.fromEntries(Object.entries(REQUEST_COMMANDS).map(([kind, key]) => [kind, COMMANDS[key]])) };
const REQUESTS = ['grill-more', 'prototype-request', 'visual-request'];
export const ANSWERS_SUBMITTED = 'answers submitted';
// docs/adr/2026-11-05-0300-implement-in-the-thread-queues-the-card-for-the-orchestrator.md
// A Todo card's thread box sends with Reply (intent: 'reply') or Implement (intent: 'build'), and its message's footer
// names that button. A bare Implement records no event: the board server writes its status line. A one-button box's
// message carries no intent and has no footer.
export const INTENT_LABELS = { build: 'Implement' };
const intentLabel = (e) => INTENT_LABELS[e.data.intent];
const actionText = (e, asked) => {
  if (!REQUESTS.includes(e.kind) || !asked.has(e.data.question)) return e.data.text || (e.data.files?.length ? '' : routeRecord(ACTION_LABELS, e.kind)) || '';
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
// docs/adr/2026-11-12-2345-a-haiku-router-files-each-incoming-request-on-a-board.md: a routed ask's status line, at its
// routing time, just before the ask arrived, linked to the message it came from.
const VIA_NAMES = { slack: 'Slack', handoff: 'a handoff' };
function routedLine(e) {
  const r = e.data?.routed;
  if (!r) return [];
  const m = { ts: r.at, who: 'claude', kind: HUB, line: 'ask-routed', text: hubText('ask-routed', { via: VIA_NAMES[r.via] || r.via, reason: r.reason }) };
  return [{ ...m, ...hubLineOf(m), html: null, link: r.link || null, via: null }];
}
// docs/adr/2026-11-14-2340-handoff-moves-a-ticket-to-another-board-and-leaves-a-pointer.md
// A handed ask's source, from its event's `from {route, key?, ref?, id?}` (store.mjs handoff, moveAsk): its words,
// "/<route> · <ref>" or "/<route>" for a moved ask, and a link to the card it came from there; or null.
function sourceOf(e) {
  const from = e.data?.from;
  if (typeof from?.route !== 'string') return null;
  return { words: `/${from.route}${from.ref ? ` · ${from.ref}` : ''}`, link: `/${from.route}/#selectedCard=${encodeURIComponent(from.key || `ask:${from.id}`)}` };
}
// A handed ask's Handed from line, a moment before the ask so it opens the thread.
function handedLine(e) {
  const source = sourceOf(e);
  if (!source) return [];
  const m = { ts: new Date(Date.parse(e.ts) - 1).toISOString(), who: 'claude', kind: HUB, line: 'handed-from', text: hubText('handed-from', { source: source.words }) };
  return [{ ...m, ...hubLineOf(m), html: null, link: source.link, via: null }];
}
// A Full person's event names them in the thread, by name, else login (docs/adr/2026-11-05-1912-a-shared-person-is-view-or-full.md).
const byOf = (e) => (e.data?.shared_by?.login ? { by: e.data.shared_by.name || e.data.shared_by.login } : {});
// docs/adr/2026-11-13-0230-a-card-reference-is-drawn-by-one-helper-with-its-lane-ring.md
// A line that names a card carries its key (card) and the words before it (words); board/public/ui-links.js cardRef
// draws the reference when the line shows, at the ref the card has then, linked, with its lane ring. Its text reads the
// same words and the card's ref from cards (by key, {ref}), or its id once it has left the board, never its key.
const refText = (key, cards) => cards.get(key)?.ref ?? key.slice(key.indexOf('/') + 1);
const naming = (m, words, key, cards) => ({ ...m, card: key, words, text: `${words} ${refText(key, cards)}`, link: `#selectedCard=${encodeURIComponent(key)}` });
// A link's line (store.mjs postLinkLines) names the other card by its stored key, under the command's words. A card's
// Created ticket line (hub-lines.mjs ticket-made) names the card itself, so it reads the ticket the card has now.
const namedLine = (m, key, cards) => (m.card ? naming(m, COMMANDS[m.command], m.card, cards)
  : m.kind === HUB && m.line === 'ticket-made' ? naming(m, hubLineOf(m).mark, key, cards) : m);
// A thread line a button wrote: its words can vary (Held until a time), so it names its mark.
const commandLine = (command) => ({ kind: 'command', command, request: true, mark: COMMANDS[command], tone: COMMAND_TONES[command] });
const requestOf = (e, asked) => {
  if (e.kind === 'item-message') return INTENT_LABELS[e.data.intent] ? { status: intentLabel(e) } : {};
  const command = { request: true, command: REQUEST_COMMANDS[e.kind] };
  if (!REQUESTS.includes(e.kind)) return e.kind === 'reask-request' ? command : {};
  return (e.data.question ? asked.has(e.data.question) : String(e.data.text || '').trim() || e.data.files?.length) ? { status: ACTION_LABELS[e.kind] } : command;
};
// A Claude line answers the owner's messages before it; an agent's lines, the orchestrator's answer to a builder and its
// visual request don't.
const claudeAtOf = (msgs) => [...msgs.filter((m) => m.who === 'claude' && !['status', 'agent', 'command', MOVE, BUILDER_ASK.answer, 'visual-request'].includes(m.kind)).map((m) => m.ts),
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
  const byKey = new Map(), answers = new Map(), reopens = new Map(), asks = new Map(), edits = new Map(), editFiles = new Map(), order = new Map(), scripts = new Map();
  events.forEach((e, i) => {
    order.set(e, i);
    if (e.data?.key && ITEM_EVENTS.includes(e.kind)) add(byKey, e.data.key, e);
    if (e.data?.key && SCRIPT_VALUES.includes(e.kind)) add(scripts, e.data.key, e);
    if (e.kind === 'owner-answer' && topicOf.has(e.data?.id)) add(answers, topicOf.get(e.data.id), e);
    if (e.kind === QUESTION_REOPEN && topicOf.has(e.data?.question)) add(reopens, topicOf.get(e.data.question), e);
    if (e.kind === 'ask') asks.set(e.id, e);
  });
  for (const e of events.filter((x) => x.kind === 'ask-edited').sort((a, b) => String(a.ts).localeCompare(String(b.ts)))) {
    edits.set(e.data?.id, e.data?.text);
    for (const f of e.data?.files || []) add(editFiles, e.data?.id, f);
  }
  return { byKey, answers, reopens, asks, edits, editFiles, questions, order, scripts };
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
  return own ? { agent: agentName(own), run: sectionOf(agentList, own), running: !own.done } : {};
}
// The run whose section an agent's lines belong to: its own started time, except a lander, whose lines join the build it
// lands, the newest build before it (docs/adr/2026-11-07-2100-a-cards-past-runs-keep-their-records-so-they-fold.md).
function sectionOf(agentList, a) {
  if (a.label !== LANDER) return a.started;
  return agentList.filter((x) => builds(x) && x.label !== LANDER && x.started && String(x.started) < String(a.started)).pop()?.started ?? a.started;
}
// On a tie in threadOf a message sorts above the status line it causes (the sort is stable, so an agent start still sorts above
// the status line `builder start` writes).
const isStatusLine = (m) => Boolean(m.request) || [MOVE, HUB, 'status', 'ask-link'].includes(m.kind);
export function threadOf(key, { lines = [], events = [], owner = {}, working = {}, listening = true, clearedAt = '', fromAsk = null, sorted = false, links = [], agents = {}, moved = [], cards = new Map(), index = threadIndex(events, owner) }) {
  const askIds = key.startsWith('ask:') ? [key.slice(4)] : [fromAsk, ...moved].filter(Boolean);
  const keys = [...new Set([key, ...askIds.map((id) => `ask:${id}`)])];
  const asked = new Map((index.questions.get(`item:${key}`) || []).map((q) => [q.id, q]));
  const answers = index.answers.get(`item:${key}`) || [];
  // An answer is acted on, and waits on Claude no more, once its question is resolved after it, a later prototype
  // round names its question (round_of), or a build starts on the card after it.
  const rounded = new Set([...asked.values()].map((q) => q.round_of).filter(Boolean));
  const buildsFrom = agentsOf(agents, true).filter(builds).map((a) => String(a.started || '')).filter(Boolean);
  const acted = new Set(answers
    .filter((e) => resolvedSince(asked.get(e.data.id), e.ts) || rounded.has(e.data.id) || buildsFrom.some((s) => s > String(e.ts))).map((e) => e.id));
  const agentList = agentsOf(agents, true);
  // docs/adr/2026-11-13-0130-a-questions-added-line-is-stored-and-stays-in-the-thread.md: a questions-added line is
  // open while any question it holds is.
  const reopens = index.reopens.get(`item:${key}`) || [];
  const isOpen = (id) => asked.has(id) && ownerQuestion(asked.get(id), answers, [], [], reopens).state === 'open';
  // A script offer carries its state (scriptStateOf); the card's newest offer is the one that can still wait.
  const scriptEvents = index.scripts.get(key) || [];
  const liveScript = lines.filter((m) => m.script).at(-1)?.script.id;
  const scriptView = (s) => ({ id: s.id, body: s.body, sha: s.sha, host: s.host, user: s.user, ...scriptStateOf(s, scriptEvents, liveScript) });
  const msgs = [
    // First, so a start sorts above the status line `builder start` writes at the same moment.
    // A planner's lines are marked planner, which the thread draws in the owner's blue.
    ...agentList.flatMap((a) => [
      ...(a.started ? [{ ts: a.started, who: 'claude', kind: 'agent', text: `${agentName(a)} started`, agent: agentName(a), run: sectionOf(agentList, a), finished: false, eta: a.done ? null : a.eta, ...(a.log ? { log: a.log } : {}), ...(plans(a) ? { planner: true } : {}) }] : []),
      ...(a.done ? [{ ts: a.done, who: 'claude', kind: 'agent', text: `${agentName(a)} finished`, agent: agentName(a), run: sectionOf(agentList, a), finished: true, eta: null, ...(plans(a) ? { planner: true } : {}) }] : []),
      // Its judgment calls, one entry under its lines: at its finish, or at its newest call while it runs
      // (docs/adr/2026-11-03-0514-a-builder-records-its-judgment-calls-and-the-session-verifies-them.md).
      ...(a.calls.length ? [{ ts: a.done || a.calls.at(-1).at, who: 'claude', kind: 'calls', text: agentName(a), calls: a.calls.map((c) => c.text), verified: a.verified }] : []),
    ]),
    ...lines.filter((m) => !m.live).map(withLog).map((m) => namedLine(m, key, cards)).map((m) => ({ ts: m.ts, who: m.who || 'claude', ...(m.log ? { log: m.log } : {}),...(m.kind === 'status' ? { kind: 'status', ...(m.planner ? { planner: true } : {}), ...agentOfLine(agentList, m) } : {}), ...(m.kind === VISUAL || m.kind === MOVE ? { kind: m.kind } : {}), ...(m.kind === HUB ? { kind: HUB, line: m.line, ...hubLineOf(m), ...(m.detail ? { detail: m.detail } : {}), ...(m.questions ? { open: m.questions.some(isOpen), ...(m.questions.some(isOpen) ? { tone: 'orange' } : {}) } : {}) } : {}), ...(m.command ? { ...commandLine(m.command), ...(m.sendId ? { sendId: m.sendId } : {}) } : {}), ...(m.card ? { card: m.card, words: m.words } : {}),
      ...(Object.values(BUILDER_ASK).includes(m.kind) ? { kind: m.kind, ask: m.ask } : {}), text: m.text || '', html: m.html || null, link: m.link || null, via: m.via || null, ...(m.by ? { by: m.by } : {}), ...(m.script ? { script: scriptView(m.script) } : {}) })),
    ...inLogOrder(index, keys.map((k) => index.byKey.get(k)))
      // An event the orchestrator wrote (who: claude, as its visual requests before item brief did) is Claude's line; every other event is the owner's.
      .map((e) => ({ ts: e.ts, who: e.data.who === 'claude' ? 'claude' : 'love', via: 'site', kind: e.kind, text: actionText(e, asked), files: e.data.files || [], eventId: e.id, reply: e.reply, replies: e.replies,
        ...(e.data.sendId ? { sendId: e.data.sendId } : {}), ...requestOf(e, asked), ...byOf(e) })),
    ...answers.map((e) => {
      const answer = [e.data.label || e.data.choice, e.data.note].filter(Boolean).join(' · ');
      return { ts: e.ts, who: 'love', via: 'questions', kind: e.kind, text: `${numbered(asked, asked.get(e.data.id))}\n→ ${answer}`, files: e.data.files || [], eventId: e.id, reply: e.reply, replies: e.replies, status: ANSWERS_SUBMITTED, ...byOf(e) };
    }),
    ...(index.reopens.get(`item:${key}`) || []).map((e) => ({ ts: e.ts, who: 'love', kind: e.kind, request: true, mark: REOPENED, text: `Question ${numberOf(asked, e.data.question)} was reopened`, ...byOf(e) })),
    ...inLogOrder(index, [...new Set(askIds)].map((id) => (index.asks.has(id) ? [index.asks.get(id)] : [])))
      .flatMap((e) => [...routedLine(e), ...handedLine(e), { ts: e.ts, who: 'love', via: 'ask', kind: e.kind, text: e.data?.text || '', files: e.data?.files || [], eventId: e.id, reply: e.reply, replies: e.replies, ...(e.data?.sendId ? { sendId: e.data.sendId } : {}), ...(moved.includes(e.id) ? { moved: true } : {}), ...byOf(e),
        ...(sourceOf(e) ? { from: sourceOf(e) } : {}), ...(typeof e.data?.note === 'string' ? { note: e.data.note } : {}), ...(BRIEF_KINDS.includes(e.data?.request) ? { status: COMMANDS[e.data.request] } : {}) },
        ...links.map((l) => naming({ ts: e.ts, who: 'claude', kind: 'ask-link', html: null, via: null }, l.folded ? 'Moved to' : l.became ? 'Became' : 'Added to', l.key, new Map([[l.key, l]])))]),
  ].sort((a, b) => String(a.ts).localeCompare(String(b.ts)) || isStatusLine(a) - isStatusLine(b));
  // docs/adr/2026-11-13-1800-every-wait-is-listed-and-working-is-display-only.md: the orchestrator's last action on the card, or the card's
  // close (clearedAt), ends the working of the messages before it, as a later Claude line does.
  const lastClaude = [claudeAtOf(msgs), String(clearedAt || '')].sort().pop();
  const { edits, editFiles } = index;
  for (const m of msgs) {
    if (!m.eventId) continue;
    if ((m.kind === 'ask' || m.kind === 'item-message') && typeof edits.get(m.eventId) === 'string') {
      Object.assign(m, { text: edits.get(m.eventId), edited: true, files: [...m.files, ...(editFiles.get(m.eventId) || [])] });
    }
    const linked = m.kind === 'ask' && (links.length > 0 || Boolean(m.moved) || (sorted && m.eventId === fromAsk));
    m.state = m.reply ? 'replied' : linked || acted.has(m.eventId) || lastClaude > String(m.ts) ? 'answered' : listening && routeRecord(working, m.eventId) ? 'working' : 'waiting';
    if (m.state === 'working') m.since = routeRecord(working, m.eventId);
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
      reply: undefined, answers: group.map((a) => ({ eventId: a.eventId, state: a.state, reply: a.reply, replies: a.replies, text: a.text })) }];
  });
}
// The states of the events a message stands for: each answer of a folded submit, else the message itself.
export const stateEntries = (m) => (m.answers || [m]).filter((a) => a.eventId).map((a) => [a.eventId, a.state]);


// snapshot: {files: [{slug, itemFile, agents: {<id>: {<agent>: record}}}], fromWaves,
//   prs: {"<repo>#<n>": pr}, threads: {<key>: [line]}, events: [event with reply, hidden ones left out],
//   working: {<event id>: ts}, actedOn: {<file>/<id>: ts} (data/acted-on.json, the orchestrator's last command on each card),
//   checked: data/checked.json, listen, watcher: data/watcher.json, askLinks: {<ask event id>: <file>/<id>},
//   owner: owner.json,
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
  const { owner = {}, topicItems = {}, events = [], threads = {}, prs = {}, working = {}, actedOn = {} } = snapshot;
  const now = snapshot.now ?? Date.now();
  const index = threadIndex(events, owner);
  const withdrawn = new Set(events.filter((e) => e.kind === 'ask-withdrawn').map((e) => e.data?.id));
  const asks = new Map(events.filter((e) => e.kind === 'ask' && !withdrawn.has(e.id)).map((e) => [e.id, e]));
  const latest = (kind, field) => new Map(events.filter((e) => e.kind === kind).sort((a, b) => String(a.ts).localeCompare(String(b.ts))).map((e) => [e.data?.[field], e.ts]));
  // A card's bump counts until a later card-unbump (docs/adr/2026-11-03-0301-build-on-a-blocked-card-queues-it.md).
  const cardUnbumps = latest('card-unbump', 'key');
  const cardBumps = new Map([...latest('card-bump', 'key')].filter(([key, ts]) => !(String(cardUnbumps.get(key) || '') > String(ts))));
  const cardDones = latest('card-done', 'key');
  const cardMerges = latest('card-merge', 'key');
  const autoMerge = snapshot.autoMerge === true;
  const tickets = snapshot.tickets;
  const cardHolds = new Map(events.filter((e) => e.kind === 'card-hold').sort((a, b) => String(a.ts).localeCompare(String(b.ts))).map((e) => [e.data?.key, e]));
  const madeFrom = new Map();
  // Every work card's ref by key, for the lines that name a card.
  const cards = new Map(snapshot.files.flatMap(({ slug, itemFile }) => itemFile.items.map((it) => [`${slug}/${it.id}`, { ref: refOf(itemFile, it, tickets) }])));
  const askLinks = snapshot.askLinks || {};
  // The asks folded into each work item (docs/adr/2026-10-29-1639-the-plus-makes-a-new-card.md).
  const foldedInto = new Map();
  for (const [id, key] of Object.entries(askLinks)) if (asks.has(id)) foldedInto.set(key, [...(foldedInto.get(key) || []), id]);

  const itemFiles = [];
  const items = [];
  const threadStates = new Map();
  // docs/adr/2026-11-14-1340-threads-ride-the-boards-sync.md: each card's thread as a page shows it, its builders' lines
  // included (threadOf with agents), by key: GET /api/thread's answer, and what the board's sync carries.
  const threadViews = {};
  // By card key: when Claude last answered in its thread, and when a Done work card closed.
  const claudeAt = new Map();
  const closedWork = new Map();
  // By work card key: the Parent and Related to keys its item file entry stores (linkCards).
  const storedLinks = new Map();
  const remote = snapshot.github ? null : remoteFromInput(snapshot.remote);
  for (const { slug, itemFile, agents: records = {} } of snapshot.files) {
    const repo = snapshot.github || itemFile.repo || null;
    itemFiles.push({ slug, title: itemFile.title || slug, status: itemFile.status || null, internal: Boolean(itemFile.internal), reviewers: (itemFile.reviewers || []).map((r) => r.name) });
    itemFile.items.forEach((it, order) => {
      const key = `${slug}/${it.id}`;
      // An archived card's own ask is linked to it as well (store.mjs archiveCards), and counts once, as its from_ask.
      const folded = (foldedInto.get(key) || []).filter((id) => id !== it.from_ask);
      const askIds = [it.from_ask, ...folded].filter((id) => asks.has(id));
      const askKeys = new Set(askIds.map((id) => `ask:${id}`));
      const lines = [...(routeRecord(threads, key) || []), ...askIds.flatMap((id) => routeRecord(threads, `ask:${id}`) || [])];
      if (it.from_ask) madeFrom.set(it.from_ask, [...(madeFrom.get(it.from_ask) || []), { key, ref: refOf(itemFile, it, tickets), became: true }]);
      const clearedAt = [routeRecord(actedOn, key), it.lane === 'done' ? it.closed_at : null, cardDones.get(key)].filter(Boolean).map(String).sort().pop() || '';
      const thread = { lines, events, owner, working, clearedAt, fromAsk: it.from_ask || null, sorted: Boolean(it.phase), moved: folded, cards, index };
      const msgs = threadOf(key, thread);
      threadViews[key] = threadOf(key, { ...thread, agents: routeRecord(records, it.id) || {} });
      for (const m of msgs) for (const [id, state] of stateEntries(m)) threadStates.set(id, state);
      claudeAt.set(key, claudeAtOf(msgs));
      items.push(workItem({
        slug, itemFile, it, order, repo, remote, base: snapshot.branch || 'main',
        prs: cardPRs(it, repo).map((p) => ({ ...p, gh: routeRecord(prs, prKeyOf(p)) || null })),
        ...((agents) => ({ agents, builder: builderOf(agents, routeRecord(threads, key), now, snapshot.moved?.[worktreeOf(routeRecord(records, it.id))] ?? null, routeRecord(snapshot.alive, key) ?? null), reachedPhase: reachedPhaseOf(agents, routeRecord(threads, key)), eta: agents.map((a) => a.eta).filter(Boolean).sort().pop() || null }))(agentsOf(routeRecord(records, it.id))),
        worktree: worktreeOf(routeRecord(records, it.id)) ?? it.worktree?.path ?? null,
        thread: lines,
        events: [...inLogOrder(index, [key, ...askKeys].map((k) => index.byKey.get(k))), ...askIds.map((id) => asks.get(id))],
        working: msgs.some((m) => stateEntries(m).some(([, state]) => state === 'working')),
        said: msgs.filter((m) => m.who === 'love' && (m.kind === 'item-message' || m.kind === 'owner-answer')),
        askedAt: (index.questions.get(`item:${key}`) || []).filter((q) => q.asked_at).map((q) => q.asked_at),
        topicItems, prSlack: snapshot.prSlack || {}, boardReviewers: snapshot.reviewers || [], now, bumpedAt: cardBumps.get(key), holdAsk: cardHolds.get(key), closedAt: cardDones.get(key),
        mergeAt: cardMerges.get(key), autoMerge, skipDraft: snapshot.skipDraft === true, tickets, landers: snapshot.landers || {}, landHeld: snapshot.landHeld || {}, landSkips: snapshot.landSkips || {}, plannerQueued: routeRecord(snapshot.queuedPlanners || {}, key) !== undefined,
      }));
      const card = items[items.length - 1];
      // An offered script waits on the owner's Run or Decline (actionOf).
      card.scriptWaiting = msgs.some((m) => m.script?.state === 'waiting');
      // A card filed from an ask takes the ask's place: Todo sorts it by when the ask was sent
      // (docs/adr/2026-11-10-1200-an-ask-is-titled-in-place-and-wears-an-ask-badge.md).
      if (asks.has(it.from_ask)) card.created = asks.get(it.from_ask).ts;
      card.askMsg = msgs.find((m) => m.kind === 'ask' && m.eventId === it.from_ask) || null;
      // docs/adr/2026-11-12-0228-new-asks-sit-in-a-new-strip-above-the-lanes.md: when the orchestrator ingested the ask
      // (store.mjs leaveNew), and the owner's message and files, for the New strip's line to the card.
      card.ingested = it.sorted_at && card.askMsg ? { at: it.sorted_at, text: card.askMsg.text, files: card.askMsg.files } : null;
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
  const kind = ['web', 'app'].includes(tries.kind) ? tries.kind : snapshot.files.some(({ itemFile }) => itemFile.items.some((it) => it.install?.url)) ? 'app' : 'web';
  for (const it of items) {
    if (it.kind !== 'work' || it.lane === 'done') continue;
    const run = routeRecord(tries.cards, it.key) || {};
    const head = run.head || it.pr?.headRefOid;
    const sha = kind === 'web' ? run.sha : it.install?.sha;
    const state = it.builder?.kind === BUILDER_KIND.install ? 'running' : run.state || (kind === 'app' && it.install ? 'ready' : null);
    it.try = { kind, state, stale: Boolean(sha && head && !String(head).toLowerCase().startsWith(String(sha).toLowerCase())),
      url: kind === 'web' ? null : it.install?.url || null, port: kind === 'web' && state === 'ready' ? run.https || null : null,
      sha: sha || null, changes: run.ahead > 0, script: run.script === true, autoBuild, hostBusy: Boolean(snapshot.hostBusy) };
  }
  const run = tries.main;
  const main = run?.script && run.sha ? { slug: run.slug, branch: run.branch || 'main', sha: run.sha.slice(0, 7), at: run.at,
    kind, state: run.state || null, url: kind === 'web' ? null : snapshot.main?.install?.url || null,
    // A web Main rebuilding, or whose new build failed, keeps its old server on the port: serving is that server's commit
    // (hub/try.mjs launchMain).
    port: kind === 'web' ? (run.state === 'ready' ? run.https : run.serving?.https) || null : null,
    serving: kind === 'web' && run.serving ? { sha: run.serving.sha.slice(0, 7), at: run.serving.at } : null,
    // A local board's pull from origin (hub/try.mjs pullMain), which Main's refresh icon shows.
    pull: tries.pull ? { running: tries.pull.running === true, error: tries.pull.error || null } : null,
    // The script main's run used: its board's build target (build-script.mjs buildScriptOf).
    script: buildScriptOf(run.target) } : null;

  const merges = [];
  const unfiled = [];
  const answerEvents = groupBy(events.filter((e) => e.kind === 'owner-answer'), (e) => e.data?.id);
  const requestEvents = groupBy(events.filter((e) => e.kind === 'prototype-request' || e.kind === 'grill-more'), (e) => e.data?.question);
  const reaskEvents = groupBy(events.filter((e) => e.kind === 'reask-request'), (e) => e.data?.question);
  const reopenEvents = groupBy(events.filter((e) => e.kind === QUESTION_REOPEN), (e) => e.data?.question);
  const questions = (owner.items || []).map((q) => ownerQuestion(q, answerEvents.get(q.id) || [], requestEvents.get(q.id) || [], reaskEvents.get(q.id) || [], reopenEvents.get(q.id) || []));
  const questionById = new Map(questions.map((q) => [q.id, q]));
  const questionsOn = groupBy(questions, (q) => q.topic);
  // docs/adr/2026-11-09-2000-old-asks-migrate-into-cards-and-the-ask-only-records-retire.md: every ask is a card and has
  // no row of its own. It lives in the card it became, or the one it was folded or merged into (data/ask-links.json,
  // which also holds an archived card's own ask), and its old links open that card. One sent to another board (its
  // thread's ask-moved line) lives there. One with none of these yet is unfiled, for the board server to file
  // (store.mjs fileAsks).
  for (const e of asks.values()) {
    const key = `ask:${e.id}`;
    const lines = routeRecord(threads, key) || [];
    const card = madeFrom.get(e.id)?.[0].key || routeRecord(askLinks, e.id);
    if (!card) {
      if (!lines.some((m) => m.line === 'ask-moved')) unfiled.push(e.id);
      continue;
    }
    moved.set(key, card);
    // docs/adr/2026-11-09-1900-every-ask-is-a-task-card-from-the-moment-it-arrives.md: an ask whose card merged into
    // another card (store.mjs relateAsk) shows in the New strip, with the owner's whole message and files
    // (docs/adr/2026-11-12-0228-new-asks-sit-in-a-new-strip-above-the-lanes.md).
    const merged = lines.filter((m) => m.line === MERGED_LINE).at(-1);
    const into = works.get(card);
    if (merged && into) {
      const message = String(index.edits.get(e.id) ?? e.data?.text ?? '').trim();
      const text = merged.title || message.split('\n')[0] || 'Ask';
      merges.push({ key: into.key, ref: into.ref, text, at: String(merged.ts), id: e.id, askedAt: String(e.ts), message, files: [...(e.data?.files || []), ...(index.editFiles.get(e.id) || [])] });
    }
  }
  const declared = new Set((owner.topics || []).map((t) => t.id));
  const topicsOf = () => ownerTopics([...(owner.topics || []), ...items.filter((it) => !declared.has(`item:${it.key}`))
    .map((it) => ({ id: `item:${it.key}`, card: it.key, title: `${it.ref}: ${it.title}` }))], questions,
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
    const depKeys = new Set(it.deps.map((d) => (String(d).includes('/') ? d : `${it.file}/${d}`)));
    it.blockedBy = !open ? [] : [...depKeys].map((k) => byKey.get(k))
      .filter((d) => d && d.lane !== 'done' && !d.reopened).sort(byAge).map(linkOf);
    it.blockedUntil = open ? it.blockedUntil ?? null : null;
    it.blockReason = open ? it.blockReason ?? null : null;
    it.blocked = it.blockedBy.length > 0 || Boolean(it.blockedUntil);
    placeOwnerWait(it, questionById, autoMerge);
    if (it.lane === 'todo' && it.kind === 'work' && !it.held && started(it.storedLane, it.agents)) it.lane = 'progress';
    it.unpicked = it.kind === 'work' && it.lane === 'todo' && Boolean(noTakePicked(questions, it.key));
    if (it.kind === 'work') it.phase = phaseOf(it);
    // docs/adr/2026-11-15-0800-owner-actions-follow-state-gone-pushes-close-stale-taps-refused.md: the card's version, its
    // lane and stored phase, which an owner tap carries from the page that drew it (server.mjs refuses a moved card's).
    it.version = `${it.lane}/${it.storedPhase || 'new'}`;
    if (it.unpicked && !it.action) it.next = PROTOTYPE_AGAIN;
    it.buildable = buildableOf(it);
    // docs/adr/2026-11-03-0516-a-new-card-is-ready-grilling-or-prototyping.md: an unstarted card from an ask, or one an agent
    // added (docs/adr/2026-11-05-0130-the-orchestrator-links-a-new-card-when-it-files-it.md), is unsorted until its session
    // sets its phase (shown as its ticket, never New), and ready once Ready with nothing blocking it or waiting on the owner.
    const unstarted = it.kind === 'work' && it.lane === 'todo';
    it.unsorted = unstarted && (Boolean(it.fromAsk) || it.unfiled) && !(it.filedHeld && it.held) && it.phase === 'new';
    // docs/adr/2026-11-09-1900-every-ask-is-a-task-card-from-the-moment-it-arrives.md: the card an ask became reads
    // New, with its ask's state, edit and delete, until the orchestrator sorts or answers it.
    if (it.kind === 'work') {
      const m = it.askMsg;
      delete it.askMsg;
      if (it.unsorted && m) {
        it.isNew = true;
        it.ask = { eventId: m.eventId, ...(m.sendId ? { sendId: m.sendId } : {}), state: m.state, ...(m.since ? { since: m.since } : {}), askedAt: m.ts, edited: Boolean(m.edited), canEdit: true, text: m.text, files: m.files, from: m.from || null, note: m.note || null };
      }
    }
    // docs/adr/2026-11-09-1939-a-block-only-keeps-a-card-from-in-progress.md: a card whose block ended waits for the
    // orchestrator's re-check before it is ready to build.
    it.ready = unstarted && it.phase === 'ready' && !it.blocked && !it.recheckAt && !it.action;
    // docs/adr/2026-11-07-0700-staging-then-ready.md
    it.staging = unstarted && it.phase === 'staging';
    // docs/adr/2026-11-06-1700-a-bump-marks-the-priority-through-every-lane.md: a bumped ready card a busy host holds
    // reads held.
    if (it.kind === 'work') it.hostHeld = Boolean(snapshot.hostBusy) && it.ready && Boolean(it.bumpedAt) && !it.held;
  }
  linkCards(items, byKey, storedLinks);
  // A marked event works until Claude answers it: a reply, a later Claude line in its card's thread or a reply to that
  // card's ask, a later orchestrator command on its card (actedOn), its ask becoming or folding into a card, or its card
  // leaving the board or closing after the mark. An event on no card works until its reply. Working is display only: it
  // gates no pull, arrival or idle check (docs/adr/2026-11-13-1800-every-wait-is-listed-and-working-is-display-only.md).
  const topicOf = new Map((owner.items || []).map((q) => [q.id, q.topic]));
  const ownCardOf = (e) => {
    if (e.kind === 'owner-answer') return topicOf.has(e.data?.id) ? /^item:(.+)$/.exec(topicOf.get(e.data.id))?.[1] || null : '';
    if (e.kind === 'ask') return `ask:${e.id}`;
    return e.data?.key || (e.kind.startsWith('ask-') && e.data?.id ? `ask:${e.data.id}` : null);
  };
  const cardOf = (e) => { const card = ownCardOf(e); return moved.get(card) || card; };
  const closedAt = (key) => [cardDones.get(key), closedWork.get(key)].filter(Boolean).sort().pop() || '';
  const unanswered = (e) => {
    const card = cardOf(e);
    if (card === null) return !e.reply;
    if (!byKey.has(card) || !(closedAt(card) < String(routeRecord(working, e.id)))) return false;
    if (threadStates.has(e.id)) return threadStates.get(e.id) === 'working';
    return !e.reply && !moved.has(ownCardOf(e)) && !([claudeAt.get(card), routeRecord(actedOn, card)].some((t) => String(t || '') > String(e.ts)));
  };
  const workingOn = events.filter((e) => routeRecord(working, e.id) && unanswered(e))
    .map((e) => ({ id: e.id, kind: e.kind, key: cardOf(e), data: e.data, since: routeRecord(working, e.id) }));
  for (const it of items) {
    it.working = workingOn.some((w) => w.key === it.key);
    if (it.kind === 'work' && it.lane === 'progress' && !it.builder && !it.next && it.waitsOn !== 'checking') it.next = NO_NEXT;
    it.sortAt = SORT_AT[it.lane](it) || (it.lane === 'review' ? null : it.updatedAt) || null;
  }
  for (const it of items) {
    if (it.kind !== 'work') continue;
    const answeredAt = (questionsOn.get(`item:${it.key}`) || []).filter((q) => q.state === 'answered').map((q) => q.answers.at(-1).ts).sort().pop();
    const workingSince = workingOn.filter((w) => w.key === it.key).map((w) => String(w.since)).sort()[0];
    // A rebase run's hand-back, its stale run, a stale review or an owner's reply waits on the orchestrator from In
    // Review (laneOf, workItem); a card the orchestrator stalled waits on the owner alone.
    const waits = !it.stalled && (['progress', 'todo'].includes(it.lane) || it.waitsOn === 'checking' || (it.lane === 'review' && (it.stale || it.waitFacts.unblockedAt || it.waitFacts.replyAt))) ? orchestratorWaitsOf(it, it.waitFacts, { answeredAt, workingSince }) : [];
    // The card shows its first wait; the waits list (orchestratorWaits) names every one.
    it.orchestrator = waits[0] || null;
    it.moreWaits = waits.slice(1);
    delete it.waitFacts;
  }
  intakeWaits(items, events, working, moved);
  screenWaits(items, snapshot.screening || {});
  // Items arrive in the order the page shows them (public/ui-order.js).
  items.sort(laneOrder);

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
  // A card answered before it was sorted is an answer, at its newest Claude line.
  const answers = items.flatMap((i) => (i.answered && claudeAt.get(i.key) ? [{ key: i.key, id: i.id, text: i.title, at: claudeAt.get(i.key) }] : []))
    .sort((a, b) => b.at.localeCompare(a.at));
  merges.sort((a, b) => b.at.localeCompare(a.at));
  // unfiled: the asks with no card yet, for the board server to file (store.mjs fileAsks).
  return withHub({ kind, main, remote: remote && { host: remote.host, name: `${remote.host}/${remote.path}` }, itemFiles, items, moved: Object.fromEntries(moved), answers, merges, unfiled, boardAsks: newBoardAsks(events, working), owner: questions, ownerTopics: topicList, reviews, needs, queue: queueOf(needs), working: workingOn.length, workingOn, checks: checksOf(snapshot, now), threadViews }, snapshot);
}

// docs/adr/2026-11-04-0349-the-board-is-built-once-per-data-version.md
// A built board with the hub's side added: prompts, this board's pending prompts (../hub/prompts.mjs shown), lead Needs
// you, and listen (hub/boards.mjs listenState) names the watcher's state. buildBoard adds its snapshot's; the server
// adds them to the build it shares, so the hub's state, which changes outside the board's data, is read each time.
// docs/adr/2026-11-13-1800-every-wait-is-listed-and-working-is-display-only.md: a listen state that isn't listening
// reads each card and New ask waiting, not working, as the thread does (threadOf's listening); the shared build, which
// pulls and waits read, keeps its working marks. A listen the caller didn't name leaves the build as built.
const notListening = (listen) => Boolean(listen) && listen !== 'listening';
const ASK_WAITS = ({ since, ...ask }) => ({ ...ask, state: ask.state === 'working' ? 'waiting' : ask.state });
export function withHub(built, { listen, prompts } = {}) {
  const needs = [...promptLines(prompts), ...built.needs];
  const items = notListening(listen) ? built.items.map((it) => (it.working || it.ask?.state === 'working' ? { ...it, working: false, ...(it.ask ? { ask: ASK_WAITS(it.ask) } : {}) } : it)) : built.items;
  const boardAsks = notListening(listen) ? built.boardAsks.map(ASK_WAITS) : built.boardAsks;
  return { ...built, items, boardAsks, needs, needsSummary: needsSummary(needs), checks: { ...built.checks, watcher: { listening: 'running', asleep: 'asleep', waking: 'waking' }[listen] || 'stopped' } };
}

// docs/adr/2026-11-03-0526-a-follow-up-is-a-work-card-with-a-parent.md
// A card's links name other cards by {key, ref}. An item file entry stores its Parent and Related to as keys, a bare id
// naming a card of its own item file, as deps do.
const linkOf = (card) => ({ key: card.key, ref: card.ref, lane: card.lane });
const linkKey = (slug, k) => (String(k).includes('/') ? String(k) : `${slug}/${k}`);
// Links list oldest first: by the cards' creation time, a card with none after those with one, ties by ref.
const byAge = (a, b) => (a.created ? (b.created ? Date.parse(a.created) - Date.parse(b.created) : -1) : b.created ? 1 : 0)
  || a.ref.localeCompare(b.ref, undefined, { numeric: true });
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
  for (const it of items) {
    for (const d of it.blockedBy || []) {
      add(waits, d.key, it.key);
      d.lane = byKey.get(d.key).lane;
    }
  }
  const cards = (keys = []) => [...new Set(keys)].map((k) => byKey.get(k)).filter(Boolean).sort(byAge).map(linkOf);
  for (const it of items) {
    const parent = stored.get(it.key)?.parent;
    it.parent = parent ? (byKey.has(parent) ? linkOf(byKey.get(parent)) : { key: parent, ref: parent.slice(parent.indexOf('/') + 1) }) : null;
    it.children = cards(children.get(it.key));
    it.related = cards(related.get(it.key));
    it.waitsOnIt = cards(waits.get(it.key));
  }
}

// docs/adr/2026-11-03-0223-each-lane-has-one-fixed-order.md
// The time each lane sorts by, newest first: Todo when the card was made, In Progress and In Review when it
// came into the lane, Done when it closed. A card with none falls back to its latest activity.
const SORT_AT = { todo: (i) => i.created, progress: (i) => i.progressSince, review: (i) => i.reviewSince, done: (i) => i.closedAt };

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// checked is data/checked.json {at, every (minutes), idle?}, watcher data/watcher.json {since} or null, replyAt the newest reply file's time
// (docs/adr/2026-10-29-1639-the-board-shows-github-checks-and-watcher-health.md). claudeAt is the newest write of Claude's the
// board can see: a reply, a Claude thread line, a working mark, a builder record or a watcher start. checked.json
// doesn't count, since the hub writes it on every poll (hub/github.mjs).
function checksOf({ checked, watcher, replyAt, threads = {}, working = {}, files = [] }, now) {
  const every = Number(checked?.every) || 30;
  const writes = [
    replyAt, watcher?.since, ...Object.values(working),
    ...Object.values(threads).flat().filter((l) => (l.who || 'claude') === 'claude').map((l) => l.ts),
    ...files.flatMap((w) => Object.values(w.agents || {}).flatMap((byAgent) => Object.values(byAgent || {})).map((r) => r?.done || r?.started)),
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
    return { kind: 'Question', title: t.title, text: `${t.title} · ${plural(t.open, 'question')}`, url, topic: t.id, questions: { open: t.open, url }, ready: null,
      since: questions.filter((q) => q.topic === t.id && q.state === 'open').map((q) => q.asked_at).filter(Boolean).sort()[0] || null };
  });
  const fromItems = items.map((it) => {
    const asking = it.questions && it.questions.state !== 'resolved' && it.questions.open > 0 ? { open: it.questions.open, url: `questions.html#${it.questions.first}` } : null;
    const ready = it.waitsOn === 'ready' ? it.pr.url : null;
    // docs/adr/2026-10-29-1639-the-lane-follows-who-acts-next.md: every card with Action needed gets a line.
    const other = !asking && !ready && it.action ? { kind: it.action.kind, label: it.action.label, url: it.action.url } : null;
    if (!asking && !ready && !other) return null;
    const title = `${it.ref}: ${it.title}`;
    const text = [title, asking && plural(asking.open, 'question'), ready && 'Ready on GitHub', other?.label].filter(Boolean).join(' · ');
    return { kind: asking ? 'Question' : ready ? 'Tap Ready' : 'Action needed', title, text, url: `#selectedCard=${encodeURIComponent(it.key)}`, key: it.key, questions: asking, ready, action: other,
      since: it.created || null, progress: it.lane === 'progress' };
  }).filter(Boolean);
  return [...fromTopics, ...fromItems].sort(oldestFirst);
}
// The ? page's queue and its count, one list: each Needs you line that waits on the owner on that page, in Needs you's
// order (oldest first), a prompt and a held review left out, which show on the hub page and in the Auto Review lane
// (docs/adr/2026-11-14-2330-the-questions-page-is-one-queue-of-what-the-badge-counts.md). Every entry has kind and
// since; a question is its topic's id, a tap its key, title, word (what the owner does) and label (its action's words).
const TAP_WORDS = { [ACTION_KIND.implement]: 'Implement', [ACTION_KIND.close]: 'Done', [ACTION_KIND.script]: 'Run' };
function queueOf(needs) {
  return needs.filter((line) => !line.prompt && !line.review).map((line) => {
    const { since, progress } = line;
    if (line.questions) return { kind: 'question', id: line.topic || `item:${line.key}`, since, progress: Boolean(progress) };
    const kind = line.ready ? 'ready' : line.action.kind === ACTION_KIND.implement ? 'implement' : line.action.kind === ACTION_KIND.close ? 'done' : 'action';
    const word = line.ready ? 'Ready' : TAP_WORDS[line.action.kind] || 'Action';
    return { kind, key: line.key, title: line.title, word, label: line.action?.label || '', fault: line.action?.kind === ACTION_KIND.stalled, since, progress: Boolean(progress) };
  });
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
  const actions = needs.filter((line) => line.action).length;
  return [prompts && plural(prompts, 'prompt'), questions && plural(questions, 'question'), actions && `${plural(actions, 'action')} needed`, drafts && `${plural(drafts, 'draft')} waiting on Ready`,
    reviews && `${plural(reviews, 'review')} held`].filter(Boolean).join(' · ');
}

// The GET /_claude/needs body for a built board (docs/adr/2026-10-29-1639-sites-report-what-waits-through-claude-needs.md).
export function needsAnswer(b) {
  const count = (...lanes) => b.items.filter((i) => lanes.includes(i.lane)).length;
  return {
    items: b.needs.map(({ kind, text, url }) => ({ kind, text, url })), working: b.working, summary: b.needsSummary,
    lanes: { review: count('review'), progress: count('progress'), todo: count('todo') },
    building: b.items.some((i) => (i.agents || []).some((a) => !a.done)),
  };
}

// A card ready to build: an unstarted work card that isn't held, with state ready, nothing blocking it and no re-check
// owed since its block ended. Ready says the rest: it comes only from staging, and a question, a Grill or Prototype
// tap, or a Reply takes a card out of it (docs/adr/2026-11-07-0700-staging-then-ready.md,
// docs/adr/2026-11-09-1939-a-block-only-keeps-a-card-from-in-progress.md).
const pullableCard = (i) => i.buildable && i.phase === 'ready' && !i.held && !i.blocked && !i.recheckAt;

// docs/adr/2026-11-04-0057-auto-implement-fills-in-progress-up-to-a-cap.md
// A board's Maximum parallel implementers when board.json sets none.
export const MAX_IMPLEMENTERS = 10;

// docs/adr/2026-11-02-1754-an-idle-board-pulls-in-its-top-todo-card.md
// docs/adr/2026-11-13-1126-the-implementer-limit-counts-cards-in-progress.md
// For built items in board order, cap the board's Maximum parallel implementers and pulled the cards the pull started
// builds on: each open card In Progress takes one slot until it lands, whatever runs on it, building, in Orchestrator
// review, landing, waiting on the owner, paused or stalled, and however many agents. A card in any other lane takes none.
// pullable lists the cards ready to build, in board order, so bumped first and the
// rest newest first (docs/adr/2026-11-03-0516-a-new-card-is-ready-grilling-or-prototyping.md, docs/adr/2026-11-03-1631-the-idle-pull-takes-ready-cards-first.md).
// waiting lists the pulled cards not yet started that still hold a slot: the pullable ones. free is the slots left, the cap less the cards In Progress and waiting. pulls lists the pullable
// cards not pulled that fit them, the bumped ones first (docs/adr/2026-11-04-0057-auto-implement-fills-in-progress-up-to-a-cap.md,
// docs/adr/2026-11-05-0802-todo-has-no-queue.md). helpers lists every requested helper, {key, name}: a card's helpers
// run on its slot. hold lists the cards an unanswered overnight triage names, which the pull leaves. retitle lists the
// cards ready to build whose title isn't a Conventional subject, which are left out of pullable until retitled. idle
// says no implementer agent is running and no card waits in Orchestrator review
// (docs/adr/2026-11-03-1551-planners-and-implementers-are-two-kinds-of-agent.md).
export function pullOf(items, { cap = MAX_IMPLEMENTERS, pulled = [], hold = [] } = {}) {
  const open = items.filter((i) => !closedLane(i));
  const inProgress = open.filter((i) => i.lane === 'progress').length;
  // A running implementer: no planner, no read-only helper, no paused build and none blocked on its own open helper
  // (agent wait's waits mark), on a card the orchestrator hasn't stalled.
  const running = (a, agents) => a.started && !a.done && builds(a) && !(a.kind === HELPER && !a.writes) && !a.pause?.paused
    && !(a.waits && agents.some((h) => h.name === a.waits && !h.done));
  const busy = open.some((i) => !i.stalled && (i.agents || []).some((a, _, all) => running(a, all)));
  // docs/adr/2026-11-12-0800-a-cards-title-is-its-pr-title.md: a card whose title its PR can't take waits to be retitled.
  // docs/adr/2026-11-13-1800-every-wait-is-listed-and-working-is-display-only.md: a card's phase alone decides its pull, not a working mark.
  const ready = open.filter((i) => pullableCard(i));
  const retitle = ready.filter((i) => startTitleFault(i.key, i.title)).map((i) => i.key);
  const pullable = ready.map((i) => i.key).filter((k) => !retitle.includes(k));
  const waiting = open.filter((i) => pulled.includes(i.key) && pullable.includes(i.key)).map((i) => i.key);
  const helpers = open.flatMap((i) => (i.agents || []).filter((a) => a.kind === HELPER && !a.started && !a.done).map((a) => ({ key: i.key, name: a.name })));
  const free = Math.max(0, cap - inProgress - waiting.length);
  const bumped = new Set(open.filter((i) => i.bumpedAt).map((i) => i.key));
  const fresh = pullable.filter((k) => !waiting.includes(k) && !hold.includes(k));
  const pulls = [...fresh.filter((k) => bumped.has(k)), ...fresh.filter((k) => !bumped.has(k))].slice(0, free);
  return { idle: !busy && !open.some((i) => i.waitsOn === 'checking'), pullable, retitle, waiting, pulls, helpers, free };
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

// docs/adr/2026-11-12-0112-a-card-serve-stays-up-while-its-worktree-does.md
// How many card serves a board keeps up at once, unless its max_serves setting says otherwise.
export const MAX_SERVES = 10;
// docs/adr/2026-11-12-0600-every-planner-launches-from-the-orchestrators-brief.md
// For built items: the agents due to launch, one per open card and kind with a written brief: a grill or prototype on a
// Todo card while no agent other than a visual one runs there, a visual beside anything but another visual
// (docs/adr/2026-11-05-1921-a-visual-is-a-page-an-agent-draws-for-a-thread.md), so a card's visuals draw one after
// another. A visual agent is named visual-<its brief's time in ms>. → [{key, kind}]
export const visualAgent = (brief) => `${VISUAL}-${Date.parse(brief.at)}`;
export function briefsDue(items) {
  const out = [];
  for (const it of items.filter((i) => i.kind === 'work' && !closedLane(i))) {
    const running = (it.agents || []).filter((a) => a.started && !a.done);
    for (const kind of BRIEF_KINDS) {
      if (!(it.briefs || []).some((b) => b.kind === kind && b.brief)) continue;
      const busy = kind === VISUAL ? running.some((a) => a.kind === VISUAL) : it.lane !== 'todo' || running.some((a) => a.kind !== VISUAL);
      if (!busy) out.push({ key: it.key, kind });
    }
  }
  return out;
}

// docs/adr/2026-11-07-0115-the-orchestrator-sorts-new-tasks-itself.md
// Intake is what reaches the board unsorted: a new task (ask), on the card it became, and a card an agent added with no
// phase (card-added). The card an intake event is on, or null: an ask the board server has yet to file has none.
const intakeKeyOf = (e, moved) => (e.kind === 'ask' ? moved.get(`ask:${e.id}`) ?? null
  : e.kind === 'card-added' ? e.data?.key ?? null
  : null);
// Whether intake event e, on card key, still waits to be sorted: the ask's card still New, the added card still
// unfiled. items is a built board's items by key.
function unsorted(items, e, key) {
  const it = items.get(key);
  if (!it) return false;
  return e.kind === 'ask' ? Boolean(it.isNew) : it.unfiled;
}
// docs/adr/2026-11-15-0730-a-new-task-is-triaged-in-one-command-before-it-is-investigated.md
// The open work cards a card's title suggests it relates to, for its triage: each sharing two or more significant
// words with its title, or the scope of a Conventional title when both have one, most shared words first, at most
// CANDIDATES_SHOWN. A significant word is four letters or more, not a STOP word, with a plural or verb ending dropped.
const CANDIDATES_SHOWN = 5;
const STOP = new Set(['about', 'also', 'board', 'boards', 'card', 'cards', 'could', 'does', 'each', 'every', 'from', 'have', 'into', 'just',
  'like', 'make', 'more', 'only', 'over', 'should', 'some', 'task', 'tasks', 'than', 'that', 'them', 'then', 'there', 'their', 'they',
  'this', 'what', 'when', 'which', 'with', 'would']);
const scopeOf = (title) => /^[a-z]+\(([^)]+)\)!?:/i.exec(title)?.[1]?.toLowerCase() ?? null;
const stem = (w) => w.replace(/(?:ing|ed|es|s)$/, (end) => (w.length - end.length >= 4 ? '' : end));
const wordsOf = (title) => new Set(String(title).replace(/^[a-z]+(\([^)]*\))?!?:/i, '').toLowerCase().split(/[^a-z0-9]+/)
  .filter((w) => w.length >= 4 && !STOP.has(w)).map(stem));
export function relatedCandidates(items, it) {
  const words = wordsOf(it.title);
  const scope = scopeOf(it.title);
  return items.filter((o) => o.kind === 'work' && o.key !== it.key && !closedLane(o) && !o.unsorted)
    .map((o) => ({ o, shared: [...wordsOf(o.title)].filter((w) => words.has(w)).length, scoped: Boolean(scope) && scopeOf(o.title) === scope }))
    .filter(({ shared, scoped }) => shared >= 2 || scoped)
    .sort((a, b) => b.shared - a.shared)
    .slice(0, CANDIDATES_SHOWN)
    .map(({ o }) => o);
}
const TRIAGE = (key) => `item triage ${key} --title "<type>(<scope>): <summary>" --phase discussing|grilling|prototyping|visual [--relate <keys>] [--deps <keys>] [--split-of <key>] [--ticket <id>] --text "<what comes next>", or --fold-into <task> for a duplicate`;
const candidatesLine = (cards) => (cards.length ? ` Likely related: ${cards.map((c) => `${c.key} "${c.title}"`).join(', ')}.` : '');
const INTAKE_NEXT = {
  ask: (key, cards) => `Triage the new task first, from what you know of the board, reading no code: ${TRIAGE(key)}. Then investigate: item notes, questions, a reply ${key}, and for an Implement ask item set ${key} --phase ready with --size.${candidatesLine(cards)}`,
  'card-added': (key, cards) => `Triage the task an agent added, from what you know of the board: ${TRIAGE(key)}. Then investigate: item notes.${candidatesLine(cards)}`,
};
// The orchestrator's wait on each card with an intake event still unsorted, on its card's item as orchestrator: from
// its oldest such event, picked up once the watcher marked that event working (working, data/working.json).
function intakeWaits(items, events, working, moved) {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const waited = new Set();
  for (const e of events) {
    const key = intakeKeyOf(e, moved);
    if (!key || waited.has(key) || !unsorted(byKey, e, key)) continue;
    waited.add(key);
    const it = byKey.get(key);
    waitFirst(it, { kind: 'intake', since: String(e.ts), picked: routeRecord(working, e.id) || null, next: INTAKE_NEXT[e.kind](key, relatedCandidates(items, it)) });
  }
}
// Puts wait on the card ahead of the waits it already has, which stay on its list.
function waitFirst(it, wait) {
  it.moreWaits = [it.orchestrator, ...(it.moreWaits || [])].filter(Boolean);
  it.orchestrator = wait;
}

// docs/adr/2026-11-07-0043-every-signal-that-wakes-the-orchestrator-says-what-to-do.md
// The orchestrator's wait on each card whose finished grill left questions for it to screen (store.mjs readScreening,
// {<key>: {since, ids}}), on its card's item as orchestrator, ahead of any other wait the card has.
function screenWaits(items, screening) {
  for (const it of items) {
    const s = routeRecord(screening, it.key);
    if (s) waitFirst(it, { kind: 'screen', since: s.since, picked: null, next: `Screen the grill's questions ${s.ids.join(', ')}: question settle <id> --note for each the board already answers, then question publish ${it.key}; left 15 minutes unscreened, they reach the owner as they are` });
  }
}

// docs/adr/2026-11-04-1900-triage-runs-once-overnight-on-cards-waiting-on-your-answers.md
// For built items: the Todo a triage looks at, one line per Todo card, with its key, title and deps, sorted, so a card
// added, dropped, renamed or relinked changes it. '' when Todo is empty.
// A triage also reads the stale reviews; Done cards leave the board by archivedOf, never by a triage
// (docs/adr/2026-11-04-0307-the-board-keeps-the-newest-100-done-cards.md).
export function todoOf(items) {
  return items.filter((i) => i.lane === 'todo' || (i.lane === 'review' && i.stale)).map((i) => JSON.stringify([i.key, i.title, i.deps || []])).sort().join('\n');
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
// app-cards.js), unread counts (othersAt), the Notes, Questions and Prototypes buttons, and ui-snapshot.js updateSign.
// No page file reads `agents`, and the rest are set on a Done card only to be sent.
export const DONE_FIELDS = ['key', 'kind', 'id', 'ref', 'title', 'lane', 'phase', 'file', 'fold', 'internal', 'ticket', 'ticketSource', 'linear', 'pr', 'prs',
  'review', 'reviewers', 'risky', 'risk', 'sortAt', 'threadCount', 'othersAt', 'hasNotes', 'questions', 'prototypes', 'next', 'ask', 'action', 'actionButton', 'builder', 'working', 'waitsOn',
  'reachedPhase', 'grilling', 'refusal', 'install', 'parent', 'children', 'related', 'waitsOnIt', 'blockedBy', 'ready', 'finishable', 'reopened', 'manualSteps', 'branch', 'worktree'];
export const slimDone = (it) => Object.fromEntries(DONE_FIELDS.filter((f) => f in it).map((f) => [f, it[f]]));

// The built board's Done cards that move to the archive (store.mjs archiveCards): past the newest `keep` by when they
// closed, finished in their item file, and none that the board still links: one an unfinished card names as a dep,
// parent, child or related card, and one with a question not yet resolved.
export function archivedOf(built, keep = DONE_KEPT) {
  const linked = new Set(built.items.filter((i) => i.lane !== 'done').flatMap((i) => [
    ...(i.deps || []).map((d) => (String(d).includes('/') ? String(d) : `${i.file}/${d}`)), i.parent?.key, ...(i.children || []).map((c) => c.key), ...(i.related || []).map((r) => r.key)]));
  return built.items.filter((i) => i.lane === 'done' && i.kind === 'work').sort((a, b) => String(b.closedAt || '').localeCompare(String(a.closedAt || '')))
    .slice(keep).filter((i) => i.storedLane === 'done' && !i.reopened && !linked.has(i.key) && (!i.questions || i.questions.state === 'resolved'));
}

// docs/adr/2026-11-11-1200-every-lane-has-phases.md
// A work card's phase in the lane the board shows it in (PHASES). Todo's is the stored one, new until set; a card whose
// prototype answer picked no take prototypes again, and one stored in another lane reads ready, as its move back writes.
// In Progress's is the step its build reached, the orchestrator's check being checking. In Review's is stale past seven
// days, else what the review waits on: the draft, the reviewers, or the merge, a pushed branch's included; a card there
// for another owner wait has none. Done's is how it closed, merged or closed, which a card not yet moved there reads from
// its PRs.
const REVIEW_PHASE = { ready: 'draft', ci: 'draft', reviewers: 'reviewers', merge: 'merge' };
function phaseOf(it) {
  if (it.lane === 'todo') {
    if (it.unpicked) return 'prototyping';
    if (PHASES.todo.includes(it.storedPhase)) return it.storedPhase;
    return it.storedLane && it.storedLane !== 'todo' ? 'ready' : 'new';
  }
  if (it.lane === 'progress') return it.waitsOn === 'checking' ? 'checking' : (it.builder && !it.builder.planner && it.builder.kind !== BUILDER_KIND.install && it.builder.phase) || it.reachedPhase || 'reading';
  if (it.lane === 'review') return it.stale ? 'stale' : it.waitsOn === 'owner' && it.pushed ? 'merge' : REVIEW_PHASE[it.waitsOn] ?? null;
  if (it.storedLane === 'done' && PHASES.done.includes(it.storedPhase)) return it.storedPhase;
  return it.prs.some((p) => p.status === PR_STATE.merged) ? 'merged' : 'closed';
}

// docs/adr/2026-11-07-1400-a-card-stores-its-lane-and-facts-replace-statuses.md
// The moves the board server's settle pass makes after a build (store.mjs moveCard): each work card whose built lane
// differs from its stored one moves to it, with why as its thread line. Done is left to what closes
// a card (item set --done, a land, a merge, the owner's Done), which records why itself, and a stored Done shown
// elsewhere moves only once a message or question reopened it: an owner step shows a landed card in In Review while it
// stays Done. → [{key, to, phase, why, from: {lane, phase}}], from the card's stored lane and phase the move was made
// from, which moveCard checks against the file.
// docs/adr/2026-11-11-1200-every-lane-has-phases.md: each move carries the card's phase there, and a card staying in
// In Progress or In Review whose phase changed moves within its lane, which writes no line. Todo's and Done's phases
// are their writers' (item set --phase, the board's staging, a close).
export function movesOf(built) {
  return built.items.filter((i) => i.kind === 'work').flatMap((i) => {
    const to = i.lane;
    if (to === 'done' || (i.storedLane === 'done' && !i.reopened)) return [];
    if (to === i.storedLane && (to === 'todo' || i.phase === i.storedPhase)) return [];
    return [{ key: i.key, to, phase: i.phase, why: moveWhy(i, to), from: { lane: i.storedLane, phase: i.storedPhase } }];
  });
}
function moveWhy(i, to) {
  if (to === 'todo') return i.held ? 'it is held' : i.blocked ? 'it is blocked' : 'nothing builds it';
  if (i.reopened && i.storedLane === 'done') return 'a message or question reopened it';
  if (i.answered && to === 'review') return 'answered, it waits for your Done';
  if (to === 'progress') return i.waitsOn === 'checking' ? 'its build handed back for a check' : i.builder ? 'a build started' : 'Claude acts next';
  return i.next || 'it waits on review';
}

// The push tag tied to a card's thread: ask-<event id> for ask:<event id>, item-<file>/<id> for a work item.
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
      url: questions.length ? it.action.url : `#selectedCard=${encodeURIComponent(it.key)}`, now: !queued.includes(it.action.kind), questions };
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
// review to land and no pulled card waiting to start. A working mark doesn't count
// (docs/adr/2026-11-13-1800-every-wait-is-listed-and-working-is-display-only.md).
export function strictlyIdle(built, { pulled = [] } = {}) {
  const open = built.items.filter((i) => !closedLane(i));
  const busy = open.some((i) => i.waitsOn === 'checking' || i.grilling || i.prototyping || (i.agents || []).some((a) => !a.done));
  return !busy && !pullOf(built.items, { pulled }).waiting.length;
}

// docs/adr/2026-11-04-2300-each-lane-is-a-queue-for-the-orchestrator.md
// Every wait an open work card has on the orchestrator, in this order, so one never hides another
// (docs/adr/2026-11-13-1800-every-wait-is-listed-and-working-is-display-only.md): an open builder ask; an owner answer not acted on;
// a staged card's judgment (staging); unless the owner owes it an answer, a hand-back with judgment calls not verified (calls) or a checked card with none left
// (checking); a builder silent past the stale limit, or stopped (stale); a review past seven days, from when it crossed
// them (stale); a grill or prototype asked for with no planner of that kind running; a refusal by the pull; or a started
// card with no live builder and nothing else placing it (unowned). since is when it began to wait, and picked when the
// session first wrote on the card after that (waitFactsOf), or the watcher marked one of its events working, which the
// card reads as Orchestrator review. → [{kind, since, picked, next, daily?}], next saying what it waits for, and daily on a
// stale review, which re-wakes once a day after pickup (waitsStep).
const STALL_NEXT = "item stall it with the reason when it can't go on";
// docs/adr/2026-11-06-1653-the-orchestrator-reviews-every-lane-on-a-schedule.md
const RESTART_NEXT = 'restart it once from its worktree with a thread line; if the restarted run goes stale too, item stall it with the reason';
// docs/adr/2026-11-07-1216-a-grill-can-propose-splitting-its-card-into-a-wave.md: a staged card whose split was answered Split is filed as its split, not set ready.
const STAGING_NEXT = 'Judge the staged task against the whole board: for a discussed task first fold what was agreed into a Build notes section with item notes; then item set --phase ready --text "<what you checked>", or --phase grilling or prototyping for another round; where its notes answer a split question Split as proposed, file the split instead';
const RECHECK_NEXT = 'Its block ended: re-read its notes and answered questions against what landed; answer a stale one again with question settle <id> --note, or send the task back with item set --phase grilling when the change is too big; then item set --phase ready --text "<what you re-checked>"';
function orchestratorWaitsOf(it, facts, { answeredAt, workingSince }) {
  const running = (kind) => it.agents.some((a) => a.kind === kind && a.started && !a.done);
  // A brief is owed only in Todo: a card past it has its build under way.
  const owed = it.lane === 'todo' && it.briefing ? it.briefs.find((b) => b.kind === it.briefing && !b.brief) : null;
  const briefed = (kind) => it.briefs.some((b) => b.kind === kind);
  const lastBuild = [it.progressSince, ...it.agents.map((a) => a.done)].filter(Boolean).map(String).sort().pop() || null;
  const unasked = facts.unasked && it.storedPhase === { grill: 'grilling', prototype: 'prototyping' }[facts.unasked.kind]
    && !it.agents.some((a) => a.kind === facts.unasked.kind && a.started && (!a.done || String(a.started) > facts.unasked.at)) ? facts.unasked : null;
  const unplaced = facts.unplaced && !facts.pages.some((t) => String(t) > facts.unplaced)
    && !it.agents.some((a) => a.kind === VISUAL && a.started && (!a.done || String(a.started) > facts.unplaced)) ? facts.unplaced : null;
  const waits = [
    facts.ask && { kind: 'ask', since: facts.ask.at, next: `Answer the builder's ask: ${facts.ask.text}` },
    it.staging && { kind: 'staging', since: it.stagedAt, next: STAGING_NEXT },
    answeredAt && { kind: 'answer', since: answeredAt, next: "Act on the owner's answer" },
    facts.replyAt && { kind: 'reply', since: facts.replyAt, next: "Act on the owner's reply" },
    // docs/adr/2026-11-12-0600-every-planner-launches-from-the-orchestrators-brief.md: the board launches no grill,
    // prototype or visual agent until the orchestrator writes its brief, whatever else the card asks of the owner.
    owed && { kind: 'brief', since: owed.at, next: `Write the ${owed.kind} brief: item brief ${it.key} --kind ${owed.kind} --file <draft.md>, with what the discussion settled, what is still open, what the ${{ grill: 'questions', prototype: 'takes', visual: 'page' }[owed.kind]} should cover and the files that matter` },
    // While the owner owes the card an answer, the waits below are theirs to unblock.
    ...(ASKING.has(it.action?.kind) ? [] : [
      // One stale wait: a stopped or silent builder, else a review past seven days. A builder waiting on its own ask is
      // the ask's wait, not a stale one.
      it.builder?.stopped || it.builder?.stale ? (facts.ask ? null
        : it.builder.stopped ? { kind: 'stale', since: it.builder.silentSince, next: `${it.builder.stopped}: ${RESTART_NEXT}, or drop the task` }
        : { kind: 'stale', since: it.builder.silentSince, next: `Find out why the builder went silent, then finish its run or ${RESTART_NEXT}` })
      : it.lane === 'review' && it.stale && { kind: 'stale', since: new Date(Date.parse(it.inReviewSince) + STALE_AFTER).toISOString(), daily: true, next: `Find out why the review went stale and fix what you can: rebase, CI, comments; if only a reviewer owes it, a thread line naming who; or ${STALL_NEXT}` },
      it.waitsOn === 'checking' && (facts.unverified ? { kind: 'calls', since: facts.handedBackAt, next: facts.next || "Verify the builder's judgment calls" }
        // A verified card's wait says its land step; a lander that faulted, or one with no worktree to land from, is stale.
        : it.land ? { kind: ['fault', 'worktree-gone'].includes(it.land.step) ? 'stale' : 'checking', since: facts.handedBackAt, next: LAND_WORDS[it.land.step].next({ ...it.land, key: it.key }) }
        : { kind: 'checking', since: facts.handedBackAt, next: facts.next || 'Land the checked build' }),
      it.grilling && facts.grillAt && !running('grill') && !briefed('grill') && { kind: 'grill', since: facts.grillAt, next: 'Start the grill asked for' },
      it.prototyping && facts.prototypeAt && !running('prototype') && !briefed('prototype') && { kind: 'prototype', since: facts.prototypeAt, next: 'Draw the prototype asked for' },
      // docs/adr/2026-11-11-1300-a-planner-that-ends-without-its-question-waits-on-the-orchestrator.md: held until the card
      // has a question (the owner's answer it owes, above), a planner of that kind running or started since, or a new phase.
      unasked && { kind: 'unasked', since: unasked.at, next: `Its ${unasked.kind} planner ended without its question: read its log, then post the question, start the planner again, or move the task's phase` },
      // docs/adr/2026-11-14-2015-a-clean-visual-end-with-no-page-reads-unplaced.md: held until a page lands or a newer visual agent starts.
      unplaced && { kind: 'visual', since: unplaced, next: 'Its visual agent ended without placing its page: read its log, then place the page with visual add, or ask for the visual again' },
      // docs/adr/2026-11-09-1939-a-block-only-keeps-a-card-from-in-progress.md: a ready Todo card whose block ended waits
      // for the re-check that releases it to the pull.
      it.recheckAt && it.lane === 'todo' && it.phase === 'ready' && !it.blocked && { kind: 'recheck', since: it.recheckAt, next: RECHECK_NEXT },
      it.refusal && facts.refusedAt && { kind: 'refused', since: facts.refusedAt, next: it.refusal },
      it.next === NO_NEXT && lastBuild && { kind: 'unowned', since: lastBuild, next: 'Start a builder on it, or set its Next' },
      // docs/adr/2026-11-07-1500-an-unblock-past-todo-waits-on-the-orchestrator.md: a card past Todo whose block ended waits until the session writes on it.
      facts.unblockedAt && it.lane !== 'todo' && !it.builder && !it.blocked && !facts.writes.some((t) => t > facts.unblockedAt)
        && { kind: 'unblocked', since: facts.unblockedAt, next: "Its block ended: act on what it waited for, or set its Next" },
    ]),
  ];
  return waits.filter((wait) => wait?.since).map((wait) => {
    const since = String(wait.since);
    const picked = [facts.writes.find((t) => t > since), workingSince].filter(Boolean).sort()[0] || null;
    return { kind: wait.kind, since, picked, next: wait.next, ...(wait.daily ? { daily: true } : {}) };
  });
}

// An overnight triage the session hasn't replied to, as an orchestrator wait: key is the event id the reply names,
// picked when the watcher marked the event working. Not tied to a card, so it sits after the cards' waits.
export const triageWaitOf = (event, picked = null) => ({ key: event.id, ref: event.data.date, title: `Overnight triage ${event.data.date}`, kind: 'triage', since: event.ts, picked, next: `Run the overnight triage and reply: board.mjs reply ${event.id}` });

// docs/adr/2026-11-15-0200-a-board-asks-another-board-and-its-orchestrator-answers.md
// The questions other boards in the hub asked this one (store.mjs askBoard), each from its board-ask event {text, from
// {route, title, key?, ref?}}, with the answer its board-ask-answered event {id, text} holds (store.mjs answerBoardAsk).
// → [{id, at, text, from, answer: {text, at} | null}], in asked order.
export function boardAsksOf(events) {
  const answers = new Map(events.filter((e) => e.kind === 'board-ask-answered').map((e) => [e.data?.id, { text: String(e.data?.text || ''), at: String(e.ts) }]));
  return events.filter((e) => e.kind === 'board-ask').map((e) => ({ id: e.id, at: String(e.ts), text: String(e.data?.text || ''), from: e.data?.from || {}, answer: answers.get(e.id) || null }));
}
const askedFrom = (from) => `/${from.route}${from.ref ? ` · ${from.ref}` : ''}`;
// Each unanswered question as an orchestrator wait, as an overnight triage is one: not tied to a card, key the event id
// answer names, picked when the watcher marked the event working (working, data/working.json's events).
export const boardAskWaits = (events, working = {}) => boardAsksOf(events).filter((a) => !a.answer).map((a) => ({
  key: a.id, ref: askedFrom(a.from), title: a.text, kind: 'ask', since: a.at, picked: routeRecord(working, a.id) || null,
  next: `Answer /${a.from.route}'s question: ${a.text}: answer ${a.id} --text "<the answer, with links>" from what this board knows`,
}));
// The New strip's entries for the unanswered questions (ui-cards.js newEntries): who asked, linking the asking card
// when there is one, and waiting, or working once the watcher picked the event up, as a New task's ask reads.
function newBoardAsks(events, working) {
  return boardAsksOf(events).filter((a) => !a.answer).map((a) => {
    const since = routeRecord(working, a.id);
    const link = `/${a.from.route}/${a.from.key ? `#selectedCard=${encodeURIComponent(a.from.key)}` : ''}`;
    return { id: a.id, sent: a.at, text: a.text, from: { words: askedFrom(a.from), link }, ...(since ? { state: 'working', since } : { state: 'waiting' }) };
  });
}

// The cards idle on the orchestrator in a built board: the bumped ones first across lanes, the earliest bump first
// (docs/adr/2026-11-06-1700-a-bump-marks-the-priority-through-every-lane.md), then the rest lanes top-down, each in
// the board's order, one entry per wait, a card's in its own order. bumpedAt is the card's bump, null on an unbumped one.
// → [{key, ref, title, kind, since, picked, next, bumpedAt}]
export function orchestratorWaits(built) {
  const waits = built.items.flatMap((i) => [i.orchestrator, ...(i.moreWaits || [])].filter(Boolean)
    .map((w) => ({ key: i.key, ref: i.ref, title: i.title, ...w, bumpedAt: i.bumpedAt || null })));
  return [...waits.filter((w) => w.bumpedAt).sort((a, b) => a.bumpedAt.localeCompare(b.bumpedAt)), ...waits.filter((w) => !w.bumpedAt)];
}
// How long a card waits on the orchestrator, not picked up, before the board pushes the owner about it once.
export const ORCHESTRATOR_PUSH_AFTER = 30 * 60000;

// docs/adr/2026-11-05-2358-nothing-waiting-on-the-orchestrator-is-missed.md
// How long a wait nobody picked up goes between wakes, and how long a picked-up one that stays open goes, from its pickup.
export const REWAKE_AFTER = 15 * 60000;
export const PICKED_REWAKE_AFTER = 60 * 60000;
// docs/adr/2026-11-06-1653-the-orchestrator-reviews-every-lane-on-a-schedule.md
// How long a picked-up daily wait (a stale review) goes between wakes: a change on its PR wakes the session sooner, by github-change.
export const DAILY_REWAKE_AFTER = 24 * 60 * 60000;
// One check of the cards idle on the orchestrator, for the stored list (data/orchestrator-waits.json) and the current
// waits (orchestratorWaits) at now: each entry carries bumped, its last wake, and keeps pushed. A wait joins the list when
// its key, kind and since are new, and wakes the session then unless it is already picked up. After that it wakes again
// once REWAKE_AFTER passes since its last wake (or its since, for an entry stored before bumped), and once picked up,
// once PICKED_REWAKE_AFTER (DAILY_REWAKE_AFTER for a daily wait) passes since the later of its pickup and its last wake.
// All the reminders share one clock: while the last one (lastAgain, an ISO time or null) is under REWAKE_AFTER old, due
// waits stay due and wake nothing, and the next reminder carries every wait due by then.
// → {waits, added: [key], again: [{key, ref, kind, since, next}], againAt}
export function waitsStep(previous, current, now, lastAgain = null) {
  const at = now.toISOString();
  const added = [];
  const again = [];
  const clockOpen = !lastAgain || now - Date.parse(lastAgain) >= REWAKE_AFTER;
  const waits = current.map((w) => {
    const was = previous.find((p) => p.key === w.key && p.kind === w.kind && p.since === w.since);
    if (!was) {
      if (!w.picked && !added.includes(w.key)) added.push(w.key);
      return { ...w, bumped: at };
    }
    const last = w.picked ? [w.picked, was.bumped].filter(Boolean).sort().pop() : was.bumped || w.since;
    const due = now - Date.parse(last) >= (!w.picked ? REWAKE_AFTER : w.daily ? DAILY_REWAKE_AFTER : PICKED_REWAKE_AFTER);
    const wakes = due && clockOpen;
    if (wakes) again.push({ key: w.key, ref: w.ref, kind: w.kind, since: w.since, next: w.next });
    return { ...w, bumped: wakes ? at : was.bumped || w.since, ...(was.pushed ? { pushed: true } : {}) };
  });
  return { waits, added, again, againAt: again.length ? at : lastAgain };
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

// The idle push's body for built items: the work cards that landed in Done since since, dropped ones left out.
export function idleSummary(items, since) {
  const after = (i) => String(i.closedAt || '') > since;
  const landed = items.filter((i) => i.kind === 'work' && i.lane === 'done' && !unlanded(i) && after(i));
  if (!landed.length) return 'Nothing closed since the last idle notification.';
  const refs = landed.slice(0, 3).map((i) => i.ref).join(', ') + (landed.length > 3 ? ` and ${landed.length - 3} more` : '');
  return `${landed.length} ${landed.length === 1 ? 'task' : 'tasks'} landed: ${refs}`;
}
