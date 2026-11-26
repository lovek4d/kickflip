// docs/adr/2026-11-09-1200-the-board-writes-status-lines-and-only-the-orchestrator-writes-messages.md
// Every line the board (Kickflip) writes to a card's thread is a status line: a mark and a few words, never a message.
// This table holds each kind of them, its mark (board/public/ui.js MARK_ICONS) and its words from its inputs; cards.mjs
// appendStatus writes them, and appendMessage the orchestrator's own words. A fault line is red, counts as unread and
// freshens the queued push; every other one is quiet.
//
// docs/adr/2026-11-12-2350-a-status-line-too-long-is-refused-at-write-through-one-length-rule.md
// A status line, like a question's text, holds at most BRIEF_LINE_LIMIT characters and a message at most MESSAGE_LIMIT.
// Every status line's words meet the one length rule, lineFault: words an author writes (item set --phase ready --text,
// builder progress) are refused past it, never cut, and the words of each kind here are worded to fit it. Each kind's
// longest names the most its bounded inputs can hold (a planner kind, a card's ref), and a kind with only bounded
// inputs reads whole; any other input, such as an error or a path, is unbounded, so the words lead with the reason and
// fit the input into the room the rest leaves (fit). hub-lines.test.mjs runs every kind at those lengths.
import os from 'node:os';

export const BRIEF_LINE_LIMIT = 100;
export const MESSAGE_LIMIT = 2000;
// The most a progress line's detail runs to: the room a status line leaves once its head ("Codex checking: ") takes
// its part.
export const DETAIL_CAP = BRIEF_LINE_LIMIT - 20;

// The one length rule of a status line's words: → why words run past room, the part of BRIEF_LINE_LIMIT a line's fixed
// lead leaves them ("Marked as ready · <text>"), naming their length and the room, or null when they fit.
export const lineFault = (words, room = BRIEF_LINE_LIMIT) => (words.length > room ? `runs to ${words.length} characters, past ${room}` : null);

// prefix, then as much of free as fits in the room suffix leaves. free's paths read from ~ in place of the home folder,
// and when it is too long, by their last part alone (…/name); if it is still too long, it is cut with an ellipsis, which
// takes the place of a full stop leading suffix.
const PATH = /(?:~|\/)[^\s:;,()'"]*\/([^\s:;,()'"/]+)/g;
export function fit(prefix, free, suffix = '') {
  const room = BRIEF_LINE_LIMIT - prefix.length - suffix.length;
  let words = String(free ?? '').split(os.homedir()).join('~').replace(/\s+/g, ' ').trim();
  if (words.length > room) words = words.replace(PATH, '…/$1');
  if (words.length <= room) return prefix + words + suffix;
  return `${prefix}${words.slice(0, room - 1).trimEnd()}…${suffix.replace(/^\./, '')}`;
}

const HELD = 'Held', RESUMED = 'Resumed', BLOCKED = 'Blocked', FAULT = 'Fault', MOVE = 'move', QUESTIONS = 'questions';
const REMINDER = 'Reminder';
const REMIND_WORDS = { done: "it's done", 'needs-you': 'it needs you' };
const BUILD = 'Implementation requested', PROTOTYPE = 'Prototype requested', DONE = 'Marked done';
// The longest of a few inputs several kinds take: a planner kind, a PR in another repo and a time.
const KIND = 'prototype', PR = 'owner/a-long-repo-name#10000', AT = 'Wed, 11/30, 12:00 PM', VERSION = '10.100.1000-rc.100';
const TICKET = 'ABCDEFGHIJ-1000000';

// A line's tone, by the colour rule (AGENTS.md): red a fault, orange build work, blue for the owner to read or a planner,
// green done, purple merged, grey idle, held or a relation. A fault kind has no tone of its own: its fault flag is red,
// and red outranks every other. The thread draws the line's icon, words and link in it (ui-threads.js tone).
// docs/adr/2026-11-15-0010-every-thread-status-line-takes-its-colour-from-one-tone-map.md
export const TONES = ['red', 'orange', 'blue', 'green', 'purple', 'grey'];

export const HUB_LINES = {
  // Holds and waits.
  'host-busy': { tone: 'grey', mark: HELD, text: () => 'Host is busy, work will resume when the host recovers' },
  'planner-held': { tone: 'grey', mark: HELD, text: ({ kind }) => `The ${kind} waits and starts when the hold lifts.`, longest: { kind: KIND } },
  paused: { tone: 'grey', mark: HELD, text: ({ phase, words, clear }) => fit(`Paused${phase ? ` at ${phase}` : ''}: `, words, `. It resumes once ${clear}.`), longest: { phase: 'building', clear: 'the usage pause lifts' } },
  'run-stopped': { tone: 'grey', mark: HELD, text: ({ words }) => words, longest: { words: 'build stopped by orchestrator' } },
  'land-moved-first': { tone: 'orange', mark: MOVE, text: ({ words }) => words, longest: { words: 'land moved first by orchestrator' } },
  'builder-stopped': { tone: 'grey', mark: HELD, text: () => 'Stopped its builder.' },
  'land-waiting': { tone: 'orange', mark: HELD, text: ({ card }) => fit('Waiting for ', card, ' to land') },
  // retry: the card's newest test run was its land's and failed (landRetry), so this wait is the land's retry.
  'test-waiting': { tone: 'orange', mark: HELD, text: ({ card, retry }) => fit(retry ? 'Retrying: waiting to test, ' : 'Waiting to test: ', card, ' is testing first'), longest: { retry: true } },
  // Resumes and unblocks.
  resumed: { tone: 'orange', mark: RESUMED, text: ({ clear }) => `Resumed: ${clear}.`, longest: { clear: 'the usage pause lifted' } },
  // 'prototype-round', 'discussing-start' and 'new-question' are no longer written: a phase change within
  // Todo is silent (docs/adr/2026-11-16-1800-a-phase-change-within-todo-writes-no-thread-line.md). They stay so threads
  // written before still render.
  'ready-expired': { tone: 'grey', mark: MOVE, text: () => 'Ready expired after a day unpulled: re-checking against what landed since' },
  // docs/adr/2026-11-26-2200-a-let-me-know-when-reminder-pushes-once.md: a task's reminder set, cancelled, pushed or
  // ended with its task closed.
  'reminder-set': { tone: 'blue', mark: REMINDER, text: ({ when }) => `Reminder set: one push when ${REMIND_WORDS[when]}.`, longest: { when: 'needs-you' } },
  'reminder-cancelled': { tone: 'grey', mark: REMINDER, text: () => 'Reminder cancelled.' },
  // docs/adr/2026-11-26-2300-a-bell-on-a-card-pushes-at-every-stage-of-its-task.md: a bell ends with its task
  // done, its last push sent.
  'reminder-sent': { tone: 'blue', mark: REMINDER, text: ({ when }) => (when === 'every-stage' ? "Bell's last push sent: it's done." : `Reminder sent: ${REMIND_WORDS[when]}.`), longest: { when: 'every-stage' } },
  'reminder-dropped': { tone: 'grey', mark: REMINDER, text: () => 'Reminder dropped: it closed without needing you.' },
  'hold-ended': { tone: 'orange', mark: RESUMED, text: ({ at }) => `Unblocked: its block until ${at} ended.`, longest: { at: AT } },
  // No longer written: a blocked card is never ready, so none stays ready at its block's end. It stays so threads
  // written before still render.
  'recheck-released': { tone: 'grey', mark: RESUMED, text: ({ card }) => fit('Stays ready: ', card, " touched none of this task's files") },
  unblocked: { tone: 'orange', mark: RESUMED, text: ({ lifted }) => fit('Unblocked: ', lifted, '.') },
  'unblocked-done': { tone: 'orange', mark: RESUMED, text: ({ card }) => fit('Unblocked: ', card, ' is done.') },
  'unblocked-closed': { tone: 'orange', mark: RESUMED, text: ({ card }) => fit('Unblocked: ', card, ' closed without landing.') },
  // Blocks.
  'blocked-pausing': { tone: 'grey', mark: BLOCKED, text: ({ blocked }) => fit('Blocked ', blocked, ': its builder pauses at its next stopping point and it stays In Progress.') },
  'blocked-stays': { tone: 'grey', mark: BLOCKED, text: ({ blocked }) => fit('Blocked ', blocked, ': it stays In Progress.') },
  'cant-start-yet': { tone: 'grey', mark: BLOCKED, text: ({ names }) => fit('Can’t start yet: waits on ', names, '. Bumped to the top of Todo.') },
  'split-moved': { tone: 'grey', mark: BLOCKED, text: ({ card, to }) => fit('Split: ', `${card} became ${to}`, ', so it waits on those now.') },
  // docs/adr/2026-11-17-0519-a-land-failing-on-mains-own-test-blocks-on-mains-fix.md
  'land-held-on-base': { tone: 'orange', mark: BLOCKED, text: ({ card, files }) => fit('Not landed: main fails it too, so it waits on main’s fix ', `${card} (${files})`, '.') },
  'merge-blocked': { tone: 'grey', mark: BLOCKED, text: ({ blocked }) => fit('Not merged: blocked ', blocked, '.') },
  // Launches, requests and moves.
  pulled: { tone: 'orange', mark: BUILD, text: () => 'Moved to In Progress: slot available' },
  'helper-asked': { tone: 'orange', mark: BUILD, text: ({ agent, writes }) => fit('Asked for helper ', agent, writes ? ', which writes code' : ''), longest: { writes: true } },
  'arch-review': { tone: 'orange', mark: BUILD, text: ({ card }) => fit('Started an architecture review of ', card, '; its report becomes the notes') },
  'prototype-after': { tone: 'blue', mark: PROTOTYPE, text: () => 'Prototype round asked: it moves to prototyping once every question is answered.' },
  'prototype-round': { tone: 'blue', mark: PROTOTYPE, text: () => 'You asked for a prototype round, so the board moved the task to prototyping.' },
  'discussing-start': { tone: 'blue', mark: 'Marked as discussing', text: ({ from }) => (from ? fit('Filed from ', from, ': it starts discussing.') : 'Filed with no phase: it starts discussing.') },
  'ticket-made': { tone: 'blue', mark: 'Created ticket', text: ({ ticket }) => fit('Created ticket ', ticket, '') },
  // docs/adr/2026-11-19-1430-a-ticket-moves-when-it-is-yours-and-says-so-in-its-thread.md: what a card's move did to its
  // ticket (tickets.mjs moveTicket), state being the Linear state it moved to. A ticket id is #n or TEAM-n.
  'ticket-assigned': { tone: 'blue', mark: MOVE, text: ({ ticket }) => `Assigned ${ticket} to you.`, longest: { ticket: TICKET } },
  'ticket-moved': { tone: 'blue', mark: MOVE, text: ({ ticket, state, assigned }) => fit(assigned ? `Assigned ${ticket} to you and moved it to ` : `Moved ${ticket} to `, state, '.'), longest: { ticket: TICKET, assigned: true } },
  'ticket-left': { tone: 'blue', mark: MOVE, text: ({ ticket }) => `Left ${ticket} as it is: assigned to someone else.`, longest: { ticket: TICKET } },
  'ticket-commented': { tone: 'blue', mark: MOVE, text: ({ ticket }) => `Commented on ${ticket}.`, longest: { ticket: TICKET } },
  'ticket-closed': { tone: 'green', mark: DONE, text: ({ ticket, state }) => (state ? fit(`Closed ${ticket}: moved to `, state, '.') : `Closed ${ticket}.`), longest: { ticket: TICKET } },
  // docs/adr/2026-11-13-0130-a-questions-added-line-is-stored-and-stays-in-the-thread.md: one per batch published on a
  // card, holding its question ids; orange while any of them is open (domain.mjs threadOf), grey once none is.
  'questions-added': { tone: 'grey', mark: QUESTIONS, text: ({ count }) => `${count} question${count === 1 ? '' : 's'} added`, longest: { count: 1000 } },
  'new-question': { tone: 'blue', mark: QUESTIONS, text: () => 'A new question on it, so it is grilling until you answer.' },
  'screen-timeout': { tone: 'blue', mark: QUESTIONS, text: () => 'Questions passed to you unscreened: the orchestrator didn’t screen them in 15 minutes.' },
  'ask-moved': { tone: 'grey', mark: MOVE, text: ({ board }) => fit('Moved to ', board, '.') },
  // docs/adr/2026-11-14-2340-handoff-moves-a-ticket-to-another-board-and-leaves-a-pointer.md: on a handed ticket's
  // thread, grey, linking the task it became on the other board (asks.mjs handoff); and drawn from a handed ask's own
  // event (domain.mjs threadOf), never written, above the ask on the receiving board; blue, as created.
  'handed-to': { tone: 'grey', mark: MOVE, text: ({ route, ref }) => fit('Handed to ', `/${route} · ${ref}`) },
  'handed-from': { tone: 'blue', mark: 'ask-link', text: ({ source }) => fit('Handed from ', source) },
  // docs/adr/2026-11-16-1100-a-task-the-orchestrator-files-comes-in-as-an-ask-through-new.md: drawn from an ask the
  // orchestrator filed (domain.mjs askedLine), never written, above the ask; blue, as created.
  'asked-from': { tone: 'blue', mark: 'ask-link', text: ({ phrase }) => fit('', phrase) },
  // docs/adr/2026-11-15-0200-a-board-asks-another-board-and-its-orchestrator-answers.md: on the asking card, grey and
  // quiet, the question the card's agent put to another board (asks.mjs askBoard); the answer follows as that board's
  // message. One to another hub that waits in this hub's outbox reads why
  // (docs/adr/2026-11-18-2250-asks-between-hubs-wait-in-an-outbox-while-the-other-hub-is-offline-or-older.md).
  'board-asked': { tone: 'grey', mark: 'ask-link', text: ({ route, question, queued }) => fit(`Asked ${route}${queued ? `, queued: ${queued}` : ''}: `, question), longest: { route: 'macbook-pro2/a-long-board-route-name', queued: 'macbook-pro2 runs an older kickflip' } },
  // docs/adr/2026-11-12-2345-a-haiku-router-files-each-incoming-request-on-a-board.md: drawn from a routed ask's own
  // event (domain.mjs threadOf), never written, above the ask; blue, as the owner reads it and may move the ask.
  'ask-routed': { tone: 'blue', mark: 'ask-link', text: ({ via, reason }) => fit(`Routed here from ${via}: `, reason), longest: { via: 'a handoff' } },
  // docs/adr/2026-11-21-2300-each-board-takes-a-routed-ask-or-passes-it-down-haikus-ranking.md: in its place on an ask
  // another board passed on (asks.mjs passAsk), the last board that passed it and why.
  'ask-passed-on': { tone: 'blue', mark: 'ask-link', text: ({ route, reason }) => fit(`Passed on by ${route}: `, reason), longest: { route: '/a-long-board-route-name' } },
  // docs/adr/2026-11-09-1900-every-ask-is-a-task-card-from-the-moment-it-arrives.md: on the ask's thread, the card it
  // became merged into another (asks.mjs relateAsk), which hides the ask's own row and feeds the top banner.
  'card-merged': { tone: 'grey', mark: MOVE, text: ({ card }) => fit('Merged into ', card, '.') },
  'pr-found': { tone: 'blue', mark: MOVE, text: ({ pr, branch }) => fit(`Found PR #${pr} on branch `, branch, '.'), longest: { pr: 100000 } },
  'ci-passed': { tone: 'green', mark: DONE, text: ({ pr }) => `CI passed, so PR #${pr} is marked ready for review.`, longest: { pr: 100000 } },
  'worktree-remade': { tone: 'grey', mark: MOVE, text: () => 'Remade its leftover worktree: it held no commits or changes.' },
  // docs/adr/2026-11-22-2345-a-closed-tasks-worktree-goes-and-the-hub-sweeps-what-is-left.md
  'worktree-kept': { tone: 'grey', mark: MOVE, text: ({ why }) => fit('Kept its worktree, removed in 14 days: ', why) },
  // docs/adr/2026-11-16-0500-a-refused-start-returns-the-card-to-ready.md: builder pick on a refused card clears the refusal.
  'refusal-cleared': { tone: 'grey', mark: MOVE, text: () => 'Cleared the refused start: the next pull may take it.' },
  merged: { tone: 'purple', mark: DONE, text: ({ words }) => fit('', words) },
  'already-merged': { tone: 'green', mark: DONE, text: ({ prs, many }) => fit(`PR${many ? 's' : ''} `, prs, ` ${many ? 'were' : 'was'} already merged.`), longest: { many: true } },
  'ask-moved-closed': { tone: 'green', mark: DONE, text: ({ board }) => fit('Closed: its ask moved to ', board, '.') },
  'handed-closed': { tone: 'green', mark: DONE, text: ({ route, ref }) => fit('Closed: handed to ', `/${route} · ${ref}`, '.') },
  'check-passed': { tone: 'green', mark: DONE, text: ({ found }) => fit('Check passed: ', found, '. Closed.') },
  // docs/adr/2026-11-18-0200-a-release-card-waits-in-in-review-until-its-release-is-published.md, linking the run.
  'release-published': { tone: 'green', mark: DONE, text: ({ version, words }) => fit(`Published ${version}: `, words, '. Tap Done.'), longest: { version: VERSION } },
  'findings-settled': { tone: 'green', mark: DONE, text: ({ filed }) => fit('Every finding is settled: ', filed ? `filed ${filed}` : 'none filed', '.') },
  'branch-merged': { tone: 'green', mark: DONE, text: ({ branch, into, host }) => fit('', `${branch} is merged into ${into} on ${host}`, ', so this task is Done.') },
  'branch-gone': { tone: 'green', mark: DONE, text: ({ branch, host }) => fit('', `${branch} is gone from ${host}`, ', so this task is Done.') },
  'prs-closed': { tone: 'grey', mark: DONE, text: ({ prs }) => fit('Closed: ', prs, ' closed unmerged.'), longest: { prs: `${PR}, ${PR}` } },
  'landed-on-merge': { tone: 'green', mark: DONE, text: ({ base }) => fit('Landed on ', base, ' on your Merge.') },
  // A land a lander takes over: the card still reads merging (domain.mjs workItem).
  'lander-handoff': { tone: 'orange', mark: BUILD, text: ({ why }) => fit('Not merged yet: ', why, '. Its builder resumes to fix it and land it.') },
  'builder-resumed': { tone: 'orange', mark: BUILD, text: () => 'Builder resumed' },
  // docs/adr/2026-11-18-2000-builder-start-takes-up-a-launch.md: a card In Progress with nothing building it (runs.mjs restartStuckBuilds).
  'builder-restarted': { tone: 'orange', mark: BUILD, text: () => 'Restarted its builder in place: nothing was building it.' },
  // docs/adr/2026-11-19-1500-red-ci-on-a-cards-pr-launches-its-builder.md: the fix run on a red PR (runs.mjs launchFixes).
  'fix-run-started': { tone: 'orange', mark: BUILD, text: ({ pr, failing }) => fit(`PR #${pr} has red CI, so its builder starts a fix: `, failing), longest: { pr: 100000 } },
  'fix-run-failed': { mark: FAULT, fault: true, detail: ({ error }) => error, text: ({ pr, error }) => fit(`PR #${pr} has red CI, but its fix run couldn't start: `, error), longest: { pr: 100000 } },
  // docs/adr/2026-11-16-0007-builder-resume-updates-a-running-builder-or-resumes-a-handed-back-one.md: the orchestrator's
  // builder resume, to a running builder (told) or a handed-back one the board resumed (rerun).
  'builder-told': { tone: 'orange', mark: BUILD, detail: ({ text }) => text, text: ({ text }) => fit('Passed to the builder: ', text) },
  'builder-rerun': { tone: 'orange', mark: BUILD, detail: ({ text }) => text, text: ({ text }) => fit('Resumed: ', text) },
  // docs/adr/2026-11-15-0040-a-cold-resume-past-150k-starts-a-fresh-agent-with-a-handoff.md: cap, in thousands of tokens.
  'fresh-builder': { tone: 'orange', mark: BUILD, text: ({ cap }) => `Fresh builder: its session was over ${cap}k.`, longest: { cap: 1000 } },
  // Faults.
  'ticket-failed': { mark: FAULT, fault: true, detail: ({ why }) => why, text: ({ ticket, to, why, comment }) => fit(comment ? `Couldn't comment on ${ticket}: ` : to ? `Couldn't move ${ticket} to ${to}: ` : `Couldn't close ${ticket}: `, why), longest: { ticket: TICKET, to: 'In Progress' } },
  // brief, when the refusal has one, is its reason in a line's room (commit-message.mjs startTitleBrief); why is whole.
  'build-refused': { mark: FAULT, fault: true, detail: ({ why }) => why, text: ({ why, brief }) => fit("Couldn't start implementing: ", brief ?? why) },
  'planner-unasked': { mark: FAULT, fault: true, detail: ({ kind }) => kind, text: ({ kind }) => `Its ${kind} planner ended without posting a question, so it waits on the orchestrator.`, longest: { kind: 'prototype' } },
  'visual-unplaced': { mark: FAULT, fault: true, text: () => 'Its visual agent ended without placing its page, so it waits on the orchestrator.' },
  'planner-failed': { mark: FAULT, fault: true, detail: ({ error }) => error, text: ({ kind, error }) => fit(`Couldn't start the ${kind}: `, error), longest: { kind: 'visual agent' } },
  'helper-failed': { mark: FAULT, fault: true, detail: ({ error }) => error, text: ({ name, error }) => fit(`Couldn't start helper ${name}: `, error), longest: { name: 'a-helper-name-of-24-char' } },
  // run names what exited: the builder, the lander or the rebase run (runs.mjs reviveHeadless, launchLanders, launchRebases).
  'exited-twice': { mark: FAULT, fault: true, text: ({ run = 'builder' }) => `Its ${run} exited twice unfinished; it waits on the orchestrator.`, longest: { run: 'rebase run' } },
  'resume-failed': { mark: FAULT, fault: true, detail: ({ error }) => error, text: ({ error }) => fit("Couldn't resume the builder headless: ", error) },
  'relaunch-failed': { mark: FAULT, fault: true, detail: ({ error }) => error, text: ({ error }) => fit("Couldn't relaunch the builder headless: ", error) },
  'lander-failed': { mark: FAULT, fault: true, detail: ({ error }) => error, text: ({ error }) => fit("Couldn't launch the lander; land it by hand: ", error) },
  'rebase-failed': { mark: FAULT, fault: true, detail: ({ error }) => error, text: ({ pr, error }) => fit(`PR #${pr} conflicts, but the rebase run couldn't start: `, error), longest: { pr: 100000 } },
  'rebase-launch-failed': { mark: FAULT, fault: true, detail: ({ error }) => error, text: ({ error }) => fit("Couldn't launch the rebase run; it reads stopped: ", error) },
  // docs/adr/2026-11-09-1626-gh-refuses-while-githubs-hourly-limit-holds.md: a merge or a finish's PR that GitHub's limit refused.
  'gh-limited': { mark: FAULT, fault: true, detail: ({ words }) => words, text: ({ what, words }) => fit(`${what}: `, words, '.'), longest: { what: 'No PR opened' } },
  'merge-refused': { mark: FAULT, fault: true, detail: ({ why }) => why, text: ({ why }) => fit('Not merged: ', why, '.') },
  'land-failed': { mark: FAULT, fault: true, detail: ({ why }) => why, text: ({ why }) => fit('Not merged: ', why, '. Tap Merge again.') },
  'push-failed': { mark: FAULT, fault: true, detail: ({ error }) => error, text: ({ base, error }) => fit(`Landed, but ${base} didn't reach origin: `, error), longest: { base: 'a-long-base-branch' } },
  // docs/adr/2026-11-16-1700-replies-to-a-slack-message-post-into-its-slack-thread.md
  'slack-post-failed': { mark: FAULT, fault: true, detail: ({ error }) => error, text: ({ what, error }) => fit(`Couldn't post ${what} to its Slack thread, retrying each poll: `, error), longest: { what: 'its end line' } },
  'slack-follow-failed': { mark: FAULT, fault: true, detail: ({ error }) => error, text: ({ error }) => fit("Can't read its Slack thread, replies may be missing: ", error) },
  'answers-failed': { mark: FAULT, fault: true, detail: ({ error }) => error, text: ({ what, error }) => fit(`Answers recorded, but ${what} failed: `, error), longest: { what: 'planning the prototype again' } },
  'notes-missing': { mark: FAULT, fault: true, text: () => 'Its notes file was missing, so the board started a new one.' },
  'notes-shared': { mark: FAULT, fault: true, text: ({ card }) => fit('It shared its notes file with ', card, ', so the board gave it its own copy.') },
  'release-failed': { mark: FAULT, fault: true, detail: ({ failure }) => failure, text: ({ version, failure }) => (failure ? fit(`Release ${version} failed: `, failure) : `Release ${version} failed: its run failed.`), longest: { version: VERSION } },
  'check-broken': { mark: FAULT, fault: true, detail: ({ error }) => error, text: ({ error }) => fit("The owner step's check can't run, so it stopped: ", error) },
  'run-failed': { mark: FAULT, fault: true, detail: ({ why }) => why, text: ({ kind, code }) => `${kind} failed (exit ${code})`, longest: { kind: 'Serve', code: 255 } },
};
// A kind's words from its inputs, refused when the kind is unknown or the words are empty or break lineFault.
export function hubText(line, inputs = {}) {
  const kind = HUB_LINES[line];
  if (!kind) throw new Error(`no status line kind "${line}"`);
  const words = kind.text(inputs);
  const fault = words ? lineFault(words) : 'is empty';
  if (fault) throw new Error(`the "${line}" status line ${fault}: ${words}`);
  return words;
}
// The whole error behind a fault line's short words, kept past BRIEF_LINE_LIMIT up to MESSAGE_LIMIT (its end, where a
// command's last words sit, when longer); the thread draws it inside a folded section under the line's words.
export function detailOf(line, inputs = {}) {
  const whole = String(HUB_LINES[line]?.detail?.(inputs) ?? '').trim();
  return whole.length > MESSAGE_LIMIT ? `…${whole.slice(-(MESSAGE_LIMIT - 1))}` : whole;
}
// A stored line's mark and fault from its kind; a kind no longer in the table draws no mark.
export const hubLineOf = (m) => ({ mark: HUB_LINES[m.line]?.mark || '', fault: Boolean(HUB_LINES[m.line]?.fault), tone: HUB_LINES[m.line]?.fault ? 'red' : HUB_LINES[m.line]?.tone });
// The thread line kind of every line cards.mjs appendStatus writes.
export const HUB = 'hub';
// A wait line (a land waiting for a card to land or to test) is orange while its wait is on. Its land records the
// wait's end as a WAIT_OVER line, {of: the wait line's ts}, which draws nothing; a wait line carries the pid of the
// process that waits, so one whose land died without recording an end reads as over too.
export const WAIT_LINES = ['land-waiting', 'test-waiting'];
export const WAIT_OVER = 'wait-over';
// docs/adr/2026-11-19-0559-a-landing-cards-live-line-says-what-its-land-waits-on.md
// Whether a land's test wait on thread, a card's stored lines, is a retry: the newest test result there
// (runs.mjs testReport's {test: 'end', failed}) is a land's, and it failed.
export function landRetry(thread) {
  const end = thread.filter((m) => m.kind === 'status' && m.test === 'end').sort((a, b) => String(a.ts).localeCompare(String(b.ts))).pop();
  return end?.phase === 'landing' && end.failed > 0;
}
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// thread is a card's stored lines. → the lines without the WAIT_OVER records, and the ts of the wait lines among them
// whose wait is over.
export function waitsOf(thread) {
  const ended = new Set(thread.filter((m) => m.kind === WAIT_OVER).map((m) => m.of));
  const lines = thread.filter((m) => m.kind !== WAIT_OVER);
  return { lines, over: new Set(lines.filter((m) => m.kind === HUB && WAIT_LINES.includes(m.line) && (ended.has(m.ts) || !pidAlive(m.pid))).map((m) => m.ts)) };
}
