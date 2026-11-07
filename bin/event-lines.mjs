// What each event kind tells the session that bin/wait-events.mjs wakes: a record-only kind wakes nothing, and every
// other kind the board writes has an action line here and an entry in SKILL.md
// (docs/adr/2026-11-07-0043-every-signal-that-wakes-the-orchestrator-says-what-to-do.md; bin/event-lines.test.mjs keeps it so).
import { intakeKeyOf, waitsAgainLine } from '../board/domain.mjs';

// docs/adr/2026-11-05-1000-record-only-events-do-not-wake-the-session.md,
// docs/adr/2026-11-06-1100-only-typed-thread-messages-wake-the-orchestrator.md: a button tap the board server applies
// itself (Hold, Resume, Done, Unbump, a bare or worded Grill, Prototype or Visual) and an unblock wake nobody. A lifted
// pause (usage-resumed) wakes nobody either: the watcher reads the gate itself, and the work it held wakes the session.
export const RECORD_ONLY = ['main-pulled', 'settings', 'ask-done', 'reviewers-removed', 'reviewers-added', 'question-reopen', 'repo-changed', 'ping', 'hello',
  'card-hold', 'card-done', 'card-unbump', 'card-unblocked', 'grill-more', 'prototype-request', 'visual-request', 'usage-resumed'];
// docs/adr/2026-11-06-0204-intake-triage-sorts-new-tasks-on-sonnet.md: on a board, intake (a new task, the owner's
// message in an ask's thread, an agent-added card) is intake triage's, and its hand-off reaches the session as an
// intake wait in orchestrator-waits, so none of them wakes the session.
const parsed = (line) => { try { return JSON.parse(line); } catch { return null; } };
export const recordOnly = (line, board) => {
  const e = parsed(line);
  return RECORD_ONLY.includes(e?.kind) || (Boolean(board) && e !== null && (e.kind === 'intake-handoff' || intakeKeyOf(e) !== null));
};

// The kinds whose line reads from the event alone.
export const PLAIN = {
  ask: (e) => `new task ${e.id} received: intake triage sorts it`,
  'owner-answer': (e) => `answer received to question ${e.data?.id}: act on it on its card`,
  ping: (e) => `ping ${e.id} from the hub answered`,
  hello: (e) => `ping ${e.id} from the hub answered`,
  'overnight-triage': (e) => `Overnight triage ${e.data?.date} asks Claude to reply: ${e.data?.cards?.length} cards wait on open questions; run the triage, then board.mjs reply ${e.id}`,
  'pr-review': (e) => `review asked on PR #${e.data?.pr}: the board was idle; read its diff and review post it`,
  // docs/adr/2026-11-05-2358-nothing-waiting-on-the-orchestrator-is-missed.md
  'orchestrator-waits': (e) => [e.data?.added?.length && `waiting on you now: ${e.data.added.join(', ')}`,
    e.data?.again?.length && waitsAgainLine(e.data.again, Date.parse(e.ts))].filter(Boolean).join(' · '),
  // docs/adr/2026-11-06-1653-the-orchestrator-reviews-every-lane-on-a-schedule.md
  'check-github': (e) => (e.data?.reason === 'morning' ? 'the daily wake: run one GitHub tick, then walk every lane top-down once: clear each blocked-until condition that holds, and act on any card stuck with no wait; a thread line on each card you act on, nothing else' : 'GitHub check asked: run one GitHub tick'),
  'github-change': (e) => `${e.data?.prs?.length ?? 0} PRs changed on GitHub: run one GitHub tick`,
  'review-answer': (e) => (e.data?.answer === 'skip' ? `skip answered on the review of PR #${e.data?.pr}: record it posted, post nothing` : `post answered on the review of PR #${e.data?.pr}: review post it`),
  'plan-waves': (e) => `Plan waves asked on ${e.data?.keys?.length ?? 0} Todo cards: triage them into waves and ask the owner about them`,
  'arch-review': (e) => `architecture review asked on ${e.data?.key}: review ${e.data?.repo} on ${e.data?.branch} and file the findings`,
  rules: (e) => `${e.data?.scope === 'hub' ? 'hub' : 'board'} rules changed: the rule lines below are the new ones; follow them from now`,
  'prototype-overdue': (e) => `prototype overdue on ${e.data?.key}: dispatch its prototype agent now`,
};
// The kinds whose line names the card the event is on.
export const ON_CARD = {
  // docs/adr/2026-11-05-0300-implement-in-the-thread-queues-the-card-for-the-orchestrator.md
  'item-message': (c, e) => (String(e.data?.key).startsWith('ask:') ? `message received from ${c}'s thread: intake triage answers it`
    : e.data?.intent === 'build' ? `Implement asked on ${c}: it is staging, the message in its notes; judge it against the whole board, then item set --phase ready --text "<what you checked>", or --phase grilling or prototyping` : `message received from ${c}'s thread: reply in its thread`),
  // docs/adr/2026-11-06-1700-a-bump-marks-the-priority-through-every-lane.md
  'card-bump': (c) => `${c} bumped: handle its waits lines first; with none, leave it`,
  'ask-bump': (c) => `${c} bumped: take that ask first`,
  'ask-edited': (c) => `${c} edited: use the new text, and say what changed if you had started`,
  'ask-done': (c) => `${c} marked done`,
  'ask-withdrawn': (c) => `${c} deleted: drop it`,
  'card-done': (c) => `${c} marked done`,
  'card-hold': (c, e) => `${c} ${e.data?.hold ? 'held' : 'resumed'}`,
  'card-unblocked': (c) => `${c} unblocked`,
  'prototype-request': (c) => `prototype asked on ${c}`,
  // docs/adr/2026-11-05-1921-a-visual-is-a-page-an-agent-draws-for-a-thread.md
  'visual-request': (c) => `visual asked on ${c}: the board launches its visual agent`,
  'reask-request': (c) => `question asked again on ${c}: ask it again with question add reask_of`,
  'builder-ask': (c, e) => `${e.data?.ask} from ${c}'s builder: ${e.data?.text} (builder answer it, or builder defer it)`,
  'owner-check-broken': (c, e) => `${c}'s owner-step check can't run: ${e.data?.error}; fix it with item set --check, or drop it`,
  'card-added': (c) => `${c} added by an agent: intake triage links and files it`,
  'intake-handoff': (c, e) => `intake triage handed ${c} to you: ${e.data?.text}`,
};
