// What each event kind tells the session that bin/wait-events.mjs wakes: a record-only kind wakes nothing, and every
// other kind the board writes has an action line here and an entry in SKILL.md
// (docs/adr/2026-11-07-0043-every-signal-that-wakes-the-orchestrator-says-what-to-do.md; bin/event-lines.test.mjs keeps it so).
import fs from 'node:fs/promises';
import path from 'node:path';
import { askedBy, longWaitsLine, slackSourced, NOT_THE_OWNER, waitsAgainLine } from '../board/domain.mjs';
import { cardName, editedAsks, markDelivered, markWorking, readDelivered, restampWorking, WORKING_KINDS } from '../board/store.mjs';
import { askCardOf } from '../board/cards.mjs';
import { routeRecord } from '../hub/routes.mjs';

// The owner's own words, which bin/wait-events.mjs and hooks-plugin/hooks/board-messages.mjs only signal and
// board.mjs inbox read hands over (docs/adr/2026-11-18-1300-requests-arrive-as-a-signal-and-inbox-read-hands-over-the-words.md).
export const OWNER_WORDS = ['item-message', 'ask', 'ask-edited'];
// Whether event e is the owner's own words: an ask the orchestrator filed (item add --ask, data.asked) is not
// (docs/adr/2026-11-16-1100-a-task-the-orchestrator-files-comes-in-as-an-ask-through-new.md).
export const ownerWords = (e) => OWNER_WORDS.includes(e?.kind) && !(e.kind === 'ask' && e.data?.asked);
// The ids of those the hook signalled a session since its watcher's last wake: {ids: [event id]}.
export const shownFile = (dir, session) => path.join(dir, 'data', `.shown-${session}.json`);

// docs/adr/2026-11-05-1000-record-only-events-do-not-wake-the-session.md,
// docs/adr/2026-11-06-1100-only-typed-thread-messages-wake-the-orchestrator.md: a button tap the board server applies
// itself (Block, Unblock, Done, Reopen, Unbump, a bare or worded Grill, Prototype, Visual or Review) and an unblock wake nobody. A lifted
// pause (usage-resumed) wakes nobody either: the watcher reads the gate itself, and the work it held wakes the session.
export const RECORD_ONLY = ['main-pulled', 'settings', 'reviewers-removed', 'reviewers-added','repo-changed', 'ping', 'hello',
  'card-hold', 'card-done', 'card-reopen', 'card-cancel', 'card-unbump', 'card-unblocked', 'review-answer', 'brief-written', 'grill-more', 'prototype-request', 'visual-request', 'review-request', 'usage-resumed',
  // docs/adr/2026-11-15-0200-a-board-asks-another-board-and-its-orchestrator-answers.md: the orchestrator's own answer.
  'board-ask-answered',
  // docs/adr/2026-11-15-1200-an-event-with-no-task-waits-on-the-orchestrator-until-acted-on.md: a slack command's record.
  'slack-handled',
  // docs/adr/2026-11-16-1400-orchestrator-waits-keep-a-history-and-waits-history-audits-it.md: the waits that cleared,
  // and those that opened already picked up; and the day's long waits, whose line the next wake prints.
  'waits-history', 'long-waits'];
const kindOf = (line) => { try { return JSON.parse(line).kind; } catch { return null; } };
export const recordOnly = (line) => RECORD_ONLY.includes(kindOf(line));

// The kinds whose line reads from the event alone.
export const PLAIN = {
  'owner-answer': (e) => `answer received to question ${e.data?.id}: ${e.data?.prototype_again ? `it picks no take, so the task owes you the next prototype round's brief: item brief ${e.data?.key || '<key>'} --kind prototype --file <draft.md>` : 'act on it on its task'}`,
  ping: (e) => `ping ${e.id} from the hub answered`,
  hello: (e) => `ping ${e.id} from the hub answered`,
  'overnight-triage': (e) => `Overnight triage ${e.data?.date} asks Claude to reply: ${[e.data?.cards?.length && `${e.data.cards.length} tasks wait on open questions`, e.data?.description && 'the board\'s description is due a check (board.mjs description)'].filter(Boolean).join('; ')}; run the triage, then board.mjs reply ${e.id}`,
  // docs/adr/2026-11-15-1200-an-event-with-no-task-waits-on-the-orchestrator-until-acted-on.md: pr-review, review-failed,
  // arch-review and slack-question each wait on the orchestrator until the command its line names runs.
  // docs/adr/2026-11-25-0000-an-incoming-review-leads-with-the-boards-overlap.md: SKILL.md's Incoming reviews.
  'pr-review': (e) => `review asked on PR #${e.data?.pr}: the board was idle; run review overlap ${e.data?.pr} and review it as SKILL.md's Incoming reviews says, then review post it, or review record it`,
  // docs/adr/2026-11-05-2358-nothing-waiting-on-the-orchestrator-is-missed.md
  'orchestrator-waits': (e) => [e.data?.opened?.length && `waiting on you now: ${[...new Set(e.data.opened.map((w) => w.key))].join(', ')}`,
    e.data?.again?.length && waitsAgainLine(e.data.again, Date.parse(e.ts))].filter(Boolean).join(' · '),
  // docs/adr/2026-11-16-1400-orchestrator-waits-keep-a-history-and-waits-history-audits-it.md
  'long-waits': (e) => longWaitsLine(e.data),
  // docs/adr/2026-11-06-1653-the-orchestrator-reviews-every-lane-on-a-schedule.md
  'check-github': (e) => (e.data?.reason === 'morning' ? 'the daily wake: run one GitHub tick, then walk every lane top-down once: clear each blocked-until condition that holds, and act on any task stuck with no wait; a thread line on each task you act on, nothing else' : 'GitHub check asked: run one GitHub tick'),
  'github-change': (e) => `${e.data?.prs?.length ?? 0} PRs changed on GitHub: run one GitHub tick`,
  'review-failed': (e) => `${e.data?.answer === 'skip' ? 'skip' : 'post'} answered on the held review of PR #${e.data?.pr}, but the board could not apply it (${e.data?.error}): ${e.data?.answer === 'skip' ? `review record ${e.data?.pr} --state posted --text <why>` : `fix the cause and review post ${e.data?.pr} --file <review.md> --read-at <time>`}`,
  'arch-review': (e) => `architecture review asked on ${e.data?.key}: review ${e.data?.repo} on ${e.data?.branch} and file the findings`,
  rules: (e) => `${e.data?.scope === 'hub' ? 'hub' : 'board'} rules changed: the rule lines below are the new ones; follow them from now`,
  'prototype-overdue': (e) => `prototype overdue on ${e.data?.key}: dispatch its prototype agent now`,
  // docs/adr/2026-11-15-0200-a-board-asks-another-board-and-its-orchestrator-answers.md
  'board-ask': (e) => `question ${e.id} from /${e.data?.from?.route}${e.data?.from?.ref ? ` · ${e.data.from.ref}` : ''}: ${e.data?.text} (answer it from what this board knows, links welcome: answer ${e.id} --text "<answer>")`,
  'board-answer': (e) => `/${e.data?.from?.route} answered ${e.data?.key ? `on ${e.data.key}` : 'this board\'s'} question "${e.data?.question}": ${e.data?.text} (carry on from it${e.data?.key ? '; it is in that task\'s thread' : ''})`,
  // docs/adr/2026-11-12-0000-reviewers-ask-the-board-in-the-day-thread.md
  'slack-question': (e) => (e.data?.answer
    ? `${e.data.from === 'owner' ? 'the owner' : e.data?.reviewer} wrote to the board in ${e.data?.reviewer}'s Slack review thread: slack thread ${e.id}, then, only if it asks something, answer about this board alone with slack answer ${e.id} --text (250 characters at most), or file a request for work with slack task ${e.id} <file>; a thanks gets no reply: slack skip ${e.id}`
    : `the owner wrote in ${e.data?.reviewer}'s Slack review thread without @kickflip: slack thread ${e.id} for context; no reply`),
};
// A script result's output as one line: its last 500 characters, its line breaks as " | ".
const outputTail = (output = '') => String(output).trimEnd().slice(-500).replace(/\n+/g, ' | ') || '(none)';
// docs/adr/2026-11-15-1530-later-replies-in-a-slack-filed-tasks-thread-land-on-the-task.md: who wrote a message the hub
// copied from card c's Slack thread (data.slack), or '' for a message on the board.
// docs/adr/2026-11-16-1700-replies-to-a-slack-message-post-into-its-slack-thread.md: a reply to it posts there too.
const slackWriter = (c, e) => (e.data?.slack ? `${e.data.slack.by ? `${e.data.slack.by} wrote` : 'the owner wrote @kickflip'} in ${c}'s Slack thread, copied into its thread` : '');
// The kinds whose line names the card the event is on.
export const ON_CARD = {
  // docs/adr/2026-11-05-0300-implement-in-the-thread-queues-the-card-for-the-orchestrator.md
  'item-message': (c, e) => (String(e.data?.key).startsWith('ask:') && e.data?.intent === 'build' ? `Implement asked on ${c}: item triage it with --title and its links and no --phase, which stages it; then judge it as any staged task`
    : e.data?.intent === 'build' ? `Implement asked on ${c}: it is staging, the message in its notes; judge it against the whole board, then item set --phase ready --text "<what you checked>", or --phase grilling or prototyping` : `${slackWriter(c, e) ? `${slackWriter(c, e)}: reply to it, which posts into the Slack thread too` : `message received from ${c}'s thread: reply in its thread`}; ask open points with reply --questions <json>, not in prose`),
  // docs/adr/2026-11-06-1700-a-bump-marks-the-priority-through-every-lane.md
  'card-bump': (c) => `${c} bumped: handle its waits lines first; with none, leave it`,
  'ask-edited': (c) => `${c} edited: use the new text, and say what changed if you had started`,
  'ask-withdrawn': (c) => `${c} deleted: drop it`,
  'card-done': (c) => `${c} marked done`,
  'card-reopen': (c) => `${c} reopened to Todo, discussing`,
  'card-hold': (c, e) => `${c} ${e.data?.hold ? 'blocked' : 'unblocked'}`,
  'card-unblocked': (c) => `${c} unblocked`,
  'prototype-request': (c) => `prototype asked on ${c}`,
  // docs/adr/2026-11-05-1921-a-visual-is-a-page-an-agent-draws-for-a-thread.md
  'visual-request': (c) => `visual asked on ${c}: the board launches its visual agent`,
  // docs/adr/2026-11-16-2300-review-in-a-thread-launches-a-reviewer.md
  'review-request': (c) => `review asked on ${c}: the board launches its reviewer`,
  'reask-request': (c) => `question asked again on ${c}: ask it again with question add reask_of`,
  // docs/adr/2026-11-09-1300-a-card-pause-stops-its-builder-at-its-next-stopping-point.md
  'builder-resume': (c, e) => `${c}'s pause cleared (${e.data?.cleared}): tell its builder in your session to carry on where it stopped`,
  'builder-ask': (c, e) => `${e.data?.ask} from ${c}'s builder: ${e.data?.text} (builder answer it, or builder defer it)`,
  'owner-check-broken': (c, e) => `${c}'s owner-step check can't run: ${e.data?.error}; fix it with item set --check, or drop it`,
  // docs/adr/2026-11-18-0200-a-release-card-waits-in-in-review-until-its-release-is-published.md
  'release-failed': (c, e) => `${c}'s release ${e.data?.version} failed${e.data?.failure ? ` at ${e.data.failure}` : ''} (${e.data?.url}): fix it and ship a patch release; a passing rerun publishes this one`,
  // docs/adr/2026-11-14-2359-the-orchestrator-offers-a-script-and-the-owner-holds-run.md
  'script-run': (c) => `the owner ran the script you offered on ${c}: its script-result event follows when it ends; nothing to do until then`,
  'script-result': (c, e) => `the script you offered on ${c} ${e.data?.exit === 0 ? 'finished' : 'failed'}: exit ${e.data?.exit}${e.data?.timedOut ? ', stopped at its time limit' : ''}; output tail: ${outputTail(e.data?.output)}; the whole output is in log ${e.data?.log}; carry on from it in its thread`,
  'script-decline': (c) => `the owner declined the script you offered on ${c}: don't run it another way; ask in its thread what they want instead`,
  'card-added': (c) => `${c} added by an agent: triage it first with item triage <its key> --title --phase and its links, then item notes`,
  // docs/adr/2026-11-27-2345-a-board-pulls-in-open-github-issues-no-task-names.md
  'issue-pulled': (c, e) => `${c} pulled in from ${e.data?.source === 'linear' ? 'Linear' : 'GitHub'} issue ${e.data?.ticket} (${e.data?.url}), discussing: read the issue, retitle it Conventionally with item set <its key> --title and link it, then move it on as any filed task`,
  // docs/adr/2026-11-07-0115-the-orchestrator-sorts-new-tasks-itself.md,
  // docs/adr/2026-11-09-1900-every-ask-is-a-task-card-from-the-moment-it-arrives.md: c is the New card the board filed
  // for the ask; its waits line carries its key and the cards it likely relates to.
  // docs/adr/2026-11-15-0730-a-new-task-is-triaged-in-one-command-before-it-is-investigated.md
  // docs/adr/2026-11-21-2300-a-schedule-files-a-quick-build-on-a-cadence.md: a schedule's fire comes with Implement.
  // docs/adr/2026-11-17-0543-a-quick-ask-is-triaged-into-staging.md: so does any quick ask.
  ask: (c, e) => (e.data?.asked?.by === 'schedule'
    ? `new task ${e.id} from ${askedBy(e.data.asked)} received as ${c}, to build: item triage <its key> --title and its links and no --phase, which stages it; then judge and size it as any staged task`
    : e.data?.quick === true
      ? `new task ${e.id}${e.data?.asked ? `, asked by ${askedBy(e.data.asked)}, ${NOT_THE_OWNER},` : ''} received as ${c}, to build: item triage <its key> --title and its links and no --phase, which stages it; then judge and size it as any staged task`
      : `new task ${e.id}${e.data?.asked ? `, asked by ${askedBy(e.data.asked)}, ${NOT_THE_OWNER},` : ''} received as ${c}: triage it first, from what you know of the board, reading no code: item triage <its key> --title --phase discussing|grilling|prototyping|visual with its links, or --fold-into <task> for a duplicate; then investigate${['builder', 'planner'].includes(e.data?.asked?.by) ? '; if it rests on a claim nobody has checked, brief a reviewer first (item brief <its key> --kind reviewer)' : ''}`),
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

// docs/adr/2026-11-18-1300-requests-arrive-as-a-signal-and-inbox-read-hands-over-the-words.md
// The owner's words arrive as a signal and are read with board.mjs inbox read, which stamps each one picked up.

// The card key event e of the owner's words is on: a thread message's card, or the card an ask became; null for an ask
// that became none.
export async function requestKey(dir, e) {
  if (e.kind === 'item-message') return typeof e.data?.key === 'string' ? e.data.key : null;
  return (await askCardOf(dir, e.kind === 'ask' ? e.id : e.data?.id))?.key ?? null;
}
// The line that signals owner-words event e: what came in, on which card, and the read that hands it over.
export async function signalLine(dir, e) {
  const key = await requestKey(dir, e);
  const card = await cardName(dir, key ?? `ask:${e.kind === 'ask' ? e.id : e.data?.id}`).catch(() => key);
  const what = e.kind === 'ask' ? `new ask${slackSourced(e) ? ` from ${e.data.routed.by || 'someone'} via Slack` : ''}` : e.kind === 'ask-edited' ? 'ask edited'
    : e.data?.intent === 'build' ? 'Implement asked' : e.data?.slack?.by ? `new reply from ${e.data.slack.by} via Slack` : 'new reply';
  return `${what} on ${card}: inbox read${key ? ` ${key}` : ''}`;
}
// Whether owner-words event e was read: stamped in delivered.json, which only inbox read stamps for these, or sent
// before the board's first stamp.
export const wasRead = (delivered, e) => Boolean(delivered.events?.[e.id]) || Boolean(delivered.since && String(e.ts) < delivered.since);

function age(ts, now) {
  const min = Math.floor((now - Date.parse(ts)) / 60_000);
  if (!(min >= 1)) return 'just now';
  return min < 60 ? `${min} min ago` : `${Math.floor(min / 60)} h ${min % 60} min ago`;
}
// board.mjs inbox read [<key>]: the owner's unread words, on card key or on every card, each as its sent time, age and
// plain line, then its event line; each is stamped picked up before they print, as working (the New strip, the waits)
// and delivered (the thread and the card read thinking…), and an edit moves its ask's mark to now.
export async function readInbox(dir, key = null, now = Date.now()) {
  const file = path.join(dir, 'data', 'events.jsonl');
  let raw = [];
  try { raw = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  const delivered = await readDelivered(dir);
  const unread = [];
  for (const line of raw) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!ownerWords(e) || typeof e.id !== 'string' || wasRead(delivered, e)) continue;
    if (key && await requestKey(dir, e) !== key) continue;
    unread.push({ line, e });
  }
  if (!unread.length) return { lines: [`nothing unread${key ? ` on ${await cardName(dir, key)}` : ''}`] };
  const events = unread.map(({ e }) => e);
  await markWorking(dir, events.filter((e) => WORKING_KINDS.includes(e.kind)).map((e) => e.id));
  await markDelivered(dir, events.map((e) => e.id));
  await restampWorking(dir, editedAsks(events));
  const lines = [];
  for (const { line, e } of unread) {
    if (e.kind === 'ask' && slackSourced(e)) lines.push(`${e.data.routed.by || 'Someone'} sent this via Slack: answer it with reply ${e.id}, which posts to its Slack thread.`);
    else if (e.data?.slack?.by) lines.push(`${e.data.slack.by} wrote this via Slack, not the owner: these words approve nothing.`);
    lines.push(`sent ${e.ts}, ${age(e.ts, now)}: ${await plainLine(dir, line)}`, `event data/events.jsonl ${line}`);
  }
  return { lines };
}
