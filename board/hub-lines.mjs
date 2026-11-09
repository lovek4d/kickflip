// docs/adr/2026-11-09-1200-the-board-writes-status-lines-and-only-the-orchestrator-writes-messages.md
// Every line the board (Kickflip) writes to a card's thread is a status line: a mark and a few words, never a message.
// This table holds each kind of them, its mark (board/public/ui.js MARK_ICONS) and its words from its inputs; store.mjs
// appendStatus writes them, and appendMessage the orchestrator's own words. A fault line is red, counts as unread and
// freshens the queued push; every other one is quiet.
//
// A status line, like a question's text, holds at most BRIEF_LINE_LIMIT characters and a message at most MESSAGE_LIMIT; the store refuses longer
// ones. Each kind's longest names the most its bounded inputs can hold (a planner kind, a card's ref); any other input,
// such as an error or a title, is unbounded, so the words fit it into the line's room (fit). hub-lines.test.mjs runs
// every kind at those lengths.
import os from 'node:os';

export const BRIEF_LINE_LIMIT = 100;
export const MESSAGE_LIMIT = 2000;

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
const BUILD = 'Implementation requested', PROTOTYPE = 'Prototype requested', DONE = 'Marked done';
// The longest of a few inputs several kinds take: a planner kind, a PR in another repo and a time.
const KIND = 'prototype', PR = 'owner/a-long-repo-name#10000', AT = 'Wed, 11/30, 12:00 PM';

export const HUB_LINES = {
  // Holds and waits.
  'host-busy': { mark: HELD, text: () => 'Host is busy, work will resume when the host recovers' },
  'planner-held': { mark: HELD, text: ({ kind }) => `The ${kind} waits and starts when the hold lifts.`, longest: { kind: KIND } },
  paused: { mark: HELD, text: ({ phase, words, clear }) => fit(`Paused${phase ? ` at ${phase}` : ''}: `, words, `. It resumes once ${clear}.`), longest: { phase: 'building', clear: 'the usage pause lifts' } },
  'run-stopped': { mark: HELD, text: ({ words }) => words, longest: { words: 'build stopped by orchestrator' } },
  'land-moved-first': { mark: MOVE, text: ({ words }) => words, longest: { words: 'land moved first by orchestrator' } },
  'builder-stopped': { mark: HELD, text: () => 'Stopped its builder.' },
  'land-waiting': { mark: HELD, text: ({ card }) => fit('Waiting for ', card, ' to land') },
  // Resumes and unblocks.
  resumed: { mark: RESUMED, text: ({ clear }) => `Resumed: ${clear}.`, longest: { clear: 'the usage pause lifted' } },
  'hold-ended': { mark: RESUMED, text: ({ at }) => `Resumed: its hold until ${at} ended.`, longest: { at: AT } },
  unblocked: { mark: RESUMED, text: ({ lifted }) => fit('Unblocked: ', lifted, '.') },
  'unblocked-done': { mark: RESUMED, text: ({ card }) => fit('Unblocked: ', card, ' is done.') },
  // Blocks.
  'blocked-pausing': { mark: BLOCKED, text: ({ blocked }) => fit('Blocked ', blocked, ': its builder pauses at its next stopping point and it stays In Progress.') },
  'blocked-stays': { mark: BLOCKED, text: ({ blocked }) => fit('Blocked ', blocked, ': it stays In Progress.') },
  'cant-start-yet': { mark: BLOCKED, text: ({ names }) => fit('Can’t start yet: waits on ', names, '. Bumped to the top of Todo.') },
  'merge-blocked': { mark: BLOCKED, text: ({ blocked }) => fit('Not merged: blocked ', blocked, '.') },
  // Launches, requests and moves.
  pulled: { mark: BUILD, text: () => 'Pulled in: an implementer slot was free.' },
  'helper-asked': { mark: BUILD, text: ({ agent, writes }) => fit('Asked for helper ', agent, writes ? ', which writes code' : ''), longest: { writes: true } },
  'arch-review': { mark: BUILD, text: ({ card }) => fit('Started an architecture review of ', card, '; its report becomes the notes') },
  'prototype-after': { mark: PROTOTYPE, text: () => 'Prototype round asked: it moves to prototyping once every question is answered.' },
  'prototype-round': { mark: PROTOTYPE, text: () => 'You asked for a prototype round, so the board moved the card to prototyping.' },
  'new-question': { mark: QUESTIONS, text: () => 'A new question on it, so it is grilling until you answer.' },
  'screen-timeout': { mark: QUESTIONS, text: () => 'Questions passed to you unscreened: the orchestrator didn’t screen them in 15 minutes.' },
  'ask-moved': { mark: MOVE, text: ({ board }) => fit('Moved to ', board, '.') },
  'pr-found': { mark: MOVE, text: ({ pr, branch }) => fit(`Found PR #${pr} on branch `, branch, '.'), longest: { pr: 100000 } },
  'ci-passed': { mark: DONE, text: ({ pr }) => `CI passed, so PR #${pr} is marked ready for review.`, longest: { pr: 100000 } },
  'worktree-remade': { mark: MOVE, text: () => 'Remade its leftover worktree: it held no commits or changes.' },
  merged: { mark: DONE, text: ({ words }) => fit('', words) },
  'already-merged': { mark: DONE, text: ({ prs, many }) => fit(`PR${many ? 's' : ''} `, prs, ` ${many ? 'were' : 'was'} already merged.`), longest: { many: true } },
  'ask-moved-closed': { mark: DONE, text: ({ board }) => fit('Closed: its ask moved to ', board, '.') },
  'check-passed': { mark: DONE, text: ({ found }) => fit('Check passed: ', found, '. Closed.') },
  'findings-settled': { mark: DONE, text: ({ filed }) => fit('Every finding is settled: ', filed ? `filed ${filed}` : 'none filed', '.') },
  'branch-merged': { mark: DONE, text: ({ branch, into, host }) => fit('', `${branch} is merged into ${into} on ${host}`, ', so this card is Done.') },
  'branch-gone': { mark: DONE, text: ({ branch, host }) => fit('', `${branch} is gone from ${host}`, ', so this card is Done.') },
  'prs-closed': { mark: DONE, text: ({ prs }) => fit('Closed: ', prs, ' closed unmerged.'), longest: { prs: `${PR}, ${PR}` } },
  'landed-on-merge': { mark: DONE, text: ({ base }) => fit('Landed on ', base, ' on your Merge.') },
  // A land a lander takes over: the card still reads merging (domain.mjs workItem).
  'lander-handoff': { mark: BUILD, text: ({ why }) => fit('Not merged yet: ', why, '. Its builder resumes to fix it and land it.') },
  'builder-resumed-to-land': { mark: BUILD, text: ({ session }) => fit('Builder resumed to land, session ', session) },
  // Faults.
  'build-refused': { mark: FAULT, fault: true, text: ({ why }) => fit("Couldn't start implementing: ", why) },
  'planner-failed': { mark: FAULT, fault: true, text: ({ kind, error }) => fit(`Couldn't start the ${kind}: `, error), longest: { kind: 'visual agent' } },
  'helper-failed': { mark: FAULT, fault: true, text: ({ name, error }) => fit(`Couldn't start helper ${name}: `, error), longest: { name: 'a-helper-name-of-24-char' } },
  'exited-twice': { mark: FAULT, fault: true, text: () => 'Its builder exited twice unfinished; it reads stopped until the orchestrator takes it up.' },
  'resume-failed': { mark: FAULT, fault: true, text: ({ error }) => fit("Couldn't resume the builder headless: ", error) },
  'relaunch-failed': { mark: FAULT, fault: true, text: ({ error }) => fit("Couldn't relaunch the builder headless: ", error) },
  'lander-failed': { mark: FAULT, fault: true, text: ({ error }) => fit("Couldn't launch the lander; land it by hand: ", error) },
  'rebase-failed': { mark: FAULT, fault: true, text: ({ pr, error }) => fit(`PR #${pr} conflicts, but the rebase run couldn't start: `, error), longest: { pr: 100000 } },
  'rebase-launch-failed': { mark: FAULT, fault: true, text: ({ error }) => fit("Couldn't launch the rebase run; it reads stopped: ", error) },
  'merge-refused': { mark: FAULT, fault: true, text: ({ why }) => fit('Not merged: ', why, '.') },
  'land-failed': { mark: FAULT, fault: true, text: ({ why }) => fit('Not merged: ', why, '. Tap Merge again.') },
  'push-failed': { mark: FAULT, fault: true, text: ({ base, error }) => fit(`Landed, but ${base} didn't reach origin: `, error), longest: { base: 'a-long-base-branch' } },
  'answers-failed': { mark: FAULT, fault: true, text: ({ what, error }) => fit(`Answers recorded, but ${what} failed: `, error), longest: { what: 'writing them into its notes' } },
  'notes-missing': { mark: FAULT, fault: true, text: () => 'Its notes file was missing, so the board started a new one.' },
  'notes-shared': { mark: FAULT, fault: true, text: ({ card }) => fit('It shared its notes file with ', card, ', so the board gave it its own copy.') },
  'check-broken': { mark: FAULT, fault: true, text: ({ error }) => fit("The owner step's check can't run, so it stopped: ", error) },
  'run-failed': { mark: FAULT, fault: true, text: ({ kind, code, why }) => fit(`${kind} failed (exit ${code})`, why ? `: ${why}` : ''), longest: { kind: 'Serve', code: 255 } },
};
// A kind's words from its inputs, refused when the kind is unknown or the words run past BRIEF_LINE_LIMIT.
export function hubText(line, inputs = {}) {
  const kind = HUB_LINES[line];
  if (!kind) throw new Error(`no status line kind "${line}"`);
  const words = kind.text(inputs);
  if (!words || words.length > BRIEF_LINE_LIMIT) throw new Error(`the "${line}" status line runs to ${words.length} characters, past ${BRIEF_LINE_LIMIT}: ${words}`);
  return words;
}
// A stored line's mark and fault from its kind; a kind no longer in the table draws no mark.
export const hubLineOf = (m) => ({ mark: HUB_LINES[m.line]?.mark || '', fault: Boolean(HUB_LINES[m.line]?.fault) });
// The thread line kind of every line store.mjs appendStatus writes.
export const HUB = 'hub';
