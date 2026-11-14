// What each event kind tells the session that bin/wait-events.mjs wakes: a record-only kind wakes nothing, and every
// other kind the board writes has an action line here and an entry in SKILL.md
// (docs/adr/2026-11-07-0043-every-signal-that-wakes-the-orchestrator-says-what-to-do.md; bin/event-lines.test.mjs keeps it so).
import path from 'node:path';
import { waitsAgainLine } from '../board/domain.mjs';
import { cardName } from '../board/store.mjs';
import { routeRecord } from '../hub/routes.mjs';

// The owner's own words, which hooks-plugin/hooks/board-messages.mjs shows mid-task and the next wake prints again,
// tagged (docs/adr/2026-11-10-1056-the-owners-words-reach-the-orchestrator-after-its-next-tool-call.md).
export const OWNER_WORDS = ['item-message', 'ask', 'ask-edited'];
// The ids of those the hook showed a session since its watcher's last wake: {ids: [event id]}.
export const shownFile = (dir, session) => path.join(dir, 'data', `.shown-${session}.json`);

// docs/adr/2026-11-05-1000-record-only-events-do-not-wake-the-session.md,
// docs/adr/2026-11-06-1100-only-typed-thread-messages-wake-the-orchestrator.md: a button tap the board server applies
// itself (Hold, Resume, Done, Reopen, Unbump, a bare or worded Grill, Prototype or Visual) and an unblock wake nobody. A lifted
// pause (usage-resumed) wakes nobody either: the watcher reads the gate itself, and the work it held wakes the session.
export const RECORD_ONLY = ['main-pulled', 'settings', 'reviewers-removed', 'reviewers-added', 'question-reopen', 'repo-changed', 'ping', 'hello',
  'card-hold', 'card-done', 'card-reopen', 'card-unbump', 'card-unblocked', 'brief-written', 'grill-more', 'prototype-request', 'visual-request', 'usage-resumed'];
const kindOf = (line) => { try { return JSON.parse(line).kind; } catch { return null; } };
export const recordOnly = (line) => RECORD_ONLY.includes(kindOf(line));

// The kinds whose line reads from the event alone.
export const PLAIN = {
  'owner-answer': (e) => `answer received to question ${e.data?.id}: ${e.data?.prototype_again ? `it picks no take, so the task owes you the next prototype round's brief: item brief ${e.data?.key || '<key>'} --kind prototype --file <draft.md>` : 'act on it on its task'}`,
  ping: (e) => `ping ${e.id} from the hub answered`,
  hello: (e) => `ping ${e.id} from the hub answered`,
  'overnight-triage': (e) => `Overnight triage ${e.data?.date} asks Claude to reply: ${e.data?.cards?.length} tasks wait on open questions; run the triage, then board.mjs reply ${e.id}`,
  'pr-review': (e) => `review asked on PR #${e.data?.pr}: the board was idle; read its diff and review post it`,
  // docs/adr/2026-11-05-2358-nothing-waiting-on-the-orchestrator-is-missed.md
  'orchestrator-waits': (e) => [e.data?.added?.length && `waiting on you now: ${e.data.added.join(', ')}`,
    e.data?.again?.length && waitsAgainLine(e.data.again, Date.parse(e.ts))].filter(Boolean).join(' · '),
  // docs/adr/2026-11-06-1653-the-orchestrator-reviews-every-lane-on-a-schedule.md
  'check-github': (e) => (e.data?.reason === 'morning' ? 'the daily wake: run one GitHub tick, then walk every lane top-down once: clear each blocked-until condition that holds, and act on any task stuck with no wait; a thread line on each task you act on, nothing else' : 'GitHub check asked: run one GitHub tick'),
  'github-change': (e) => `${e.data?.prs?.length ?? 0} PRs changed on GitHub: run one GitHub tick`,
  'review-answer': (e) => (e.data?.answer === 'skip' ? `skip answered on the review of PR #${e.data?.pr}: record it posted, post nothing` : `post answered on the review of PR #${e.data?.pr}: review post it`),
  'arch-review': (e) => `architecture review asked on ${e.data?.key}: review ${e.data?.repo} on ${e.data?.branch} and file the findings`,
  rules: (e) => `${e.data?.scope === 'hub' ? 'hub' : 'board'} rules changed: the rule lines below are the new ones; follow them from now`,
  'prototype-overdue': (e) => `prototype overdue on ${e.data?.key}: dispatch its prototype agent now`,
  // docs/adr/2026-11-12-0000-reviewers-ask-the-board-in-the-day-thread.md
  'slack-question': (e) => (e.data?.answer
    ? `${e.data.from === 'owner' ? 'the owner' : e.data?.reviewer} wrote to the board in ${e.data?.reviewer}'s Slack review thread: slack thread ${e.id}, then, only if it asks something, answer about this board alone with slack answer ${e.id} --text (250 characters at most), or file a request for work with slack task ${e.id} <file>; a thanks gets no reply`
    : `the owner wrote in ${e.data?.reviewer}'s Slack review thread without @kickflip: slack thread ${e.id} for context; no reply`),
};
// The kinds whose line names the card the event is on.
export const ON_CARD = {
  // docs/adr/2026-11-05-0300-implement-in-the-thread-queues-the-card-for-the-orchestrator.md
  'item-message': (c, e) => (String(e.data?.key).startsWith('ask:') && e.data?.intent === 'build' ? `Implement asked on ${c}: file it with item add --from-ask --phase ready, with its --size and notes`
    : e.data?.intent === 'build' ? `Implement asked on ${c}: it is staging, the message in its notes; judge it against the whole board, then item set --phase ready --text "<what you checked>", or --phase grilling or prototyping` : `message received from ${c}'s thread: reply in its thread; ask open points with reply --questions <json>, not in prose`),
  // docs/adr/2026-11-06-1700-a-bump-marks-the-priority-through-every-lane.md
  'card-bump': (c) => `${c} bumped: handle its waits lines first; with none, leave it`,
  'ask-edited': (c) => `${c} edited: use the new text, and say what changed if you had started`,
  'ask-withdrawn': (c) => `${c} deleted: drop it`,
  'card-done': (c) => `${c} marked done`,
  'card-reopen': (c) => `${c} reopened to Todo, discussing`,
  'card-hold': (c, e) => `${c} ${e.data?.hold ? 'held' : 'resumed'}`,
  'card-unblocked': (c) => `${c} unblocked`,
  'prototype-request': (c) => `prototype asked on ${c}`,
  // docs/adr/2026-11-05-1921-a-visual-is-a-page-an-agent-draws-for-a-thread.md
  'visual-request': (c) => `visual asked on ${c}: the board launches its visual agent`,
  'reask-request': (c) => `question asked again on ${c}: ask it again with question add reask_of`,
  // docs/adr/2026-11-09-1300-a-card-pause-stops-its-builder-at-its-next-stopping-point.md
  'builder-resume': (c, e) => `${c}'s pause cleared (${e.data?.cleared}): tell its builder in your session to carry on where it stopped`,
  'builder-ask': (c, e) => `${e.data?.ask} from ${c}'s builder: ${e.data?.text} (builder answer it, or builder defer it)`,
  'owner-check-broken': (c, e) => `${c}'s owner-step check can't run: ${e.data?.error}; fix it with item set --check, or drop it`,
  'card-added': (c) => `${c} added by an agent: link it and file it: item notes, then item set --relate and --phase`,
  // docs/adr/2026-11-07-0115-the-orchestrator-sorts-new-tasks-itself.md,
  // docs/adr/2026-11-09-1900-every-ask-is-a-task-card-from-the-moment-it-arrives.md: c is the New card the board filed
  // for the ask; its waits line carries its key.
  ask: (c, e) => `new task ${e.id} received as ${c}: sort that New task: link a ticket it names with item set <its key> --ticket <id>; discuss it with reply <its key>, which reads it discussing; item notes, then item set <its key> --phase ready, with --size, for an Implement ask, or --phase grilling or prototyping only when the ask asks for one; or merge it into a task with item relate-ask ${e.id} <task> --summary`,
};

// One plain line per event line, from its kind and card (data.key, data.id for an ask-* event, or an ask's own id), or null for a
// line that isn't an event. A card name that can't be read falls back to the key, so the cursor still moves.
export async function plainLine(dir, line) {
  let e;
  try { e = JSON.parse(line); } catch { return null; }
  if (typeof e?.kind !== 'string') return null;
  const key = typeof e.data?.key === 'string' ? e.data.key : e.kind.startsWith('ask-') && typeof e.data?.id === 'string' ? `ask:${e.data.id}` : e.kind === 'ask' ? `ask:${e.id}` : null;
  const card = key && await cardName(dir, key).catch(() => key);
  if (routeRecord(PLAIN, e.kind)) return PLAIN[e.kind](e);
  if (card && routeRecord(ON_CARD, e.kind)) return ON_CARD[e.kind](card, e);
  return card ? `${e.kind} on ${card}` : `${e.kind} received`;
}
