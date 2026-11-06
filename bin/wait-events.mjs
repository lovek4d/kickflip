#!/usr/bin/env node
// Waits for the next viewer event on a site, then exits so the owning Claude
// session wakes up. Run it as a background task; relaunch it after handling.
//   wait-events.mjs <route> <session-id>
// Watches the files in the site's manifest `watch` list (relative to its dir),
// counting lines that match `filter` (a regex; every line when unset).
// Prints and exits on:
//   event <file> <line>       new matching lines (several, batched for 2 s), each followed by one plain line saying
//                             what came in and on which card (plainLine); on a board it marks each ask,
//                             item-message, wave-triage and overnight-triage working in data/working.json and answers a ping for the
//                             session (board/store.mjs ackPing), then prints:
//   waits <kind> <ref> <key> since <iso>[, picked up <iso>]: <next>
//                             each card idle on the orchestrator, lanes top-down, from data/orchestrator-waits.json,
//                             which the board server keeps (board/server.mjs checkWaits): handle each one on every wake
//                             (docs/adr/2026-11-04-2300-each-lane-is-a-queue-for-the-orchestrator.md), then
//   rule hub <text>           each hub rule (settings.json `rules`), then
//   rule board <text>         each of the board's own (board.json `rules`): the owner's standing instructions,
//                             printed with every wake (docs/adr/2026-10-29-1639-rules-live-on-settings-at-hub-and-board-level.md), then
//   setting <name> <value>    each board setting from board.json: auto-merge, auto-build, auto-pull, auto-triage, auto-review, skip-draft and the rest on|off,
//                             max-implementers <1..99>, github-login <login> and tickets <json> when set
//                             (docs/adr/2026-10-29-1752-auto-merge-is-a-board-setting-off-by-default.md), then
//   quiet <text>              the fixed instruction to keep the terminal quiet (QUIET), then
//   usage paused <iso> <window> <used>%  while Claude is paused, after rules/settings; hub work events wait for reset;
//                             `usage paused <iso|forever> manual hub|board` under Pause hub or Pause board
//   link <name> <detail>      each hub link that doesn't reach the board (../hub/boards.mjs linksOf), the list its
//                             Hub links sheet shows (docs/adr/2026-10-29-1639-one-board-registry-for-every-hub-feature.md), at
//                             once, while the sheet still reads it settling
//                             (docs/adr/2026-10-29-1639-hub-links-turn-red-only-after-a-grace-period.md); and `link hub
//                             <detail>` while the hub runs older code than its files (../hub/boards.mjs hubLink)
//   handed-over <owner json>  another session took the route over: stop, don't relaunch
//   Record-only events never wake the session (docs/adr/2026-11-05-1000-record-only-events-do-not-wake-the-session.md):
//   main-pulled, settings, ask-done, reviewers-removed, reviewers-added, question-reopen, repo-changed and ping (hello, as old boards wrote it),
//   and on a board the intake that intake triage sorts: ask, card-added, item-message on an ask's thread, and intake-handoff
//   (docs/adr/2026-11-06-0204-intake-triage-sorts-new-tasks-on-sonnet.md). The cursor moves past them at once, a ping
//   is answered then, and their lines print, in order, ahead of the new events on the next wake, marked working only
//   when they woke the session.
//   site-removed              the route left the manifest: stop, don't relaunch
// On start it writes <site dir>/data/watcher.json {pid, since}, and adds exited_at when it exits; a board reads it
// to say whether a watcher runs (docs/adr/2026-10-29-1639-the-board-shows-github-checks-and-watcher-health.md).
// It first stops the watcher that file records for the same route and session (../hub/boards.mjs stopPreviousWatcher),
// and exits printing nothing, its events left for the next watcher, once the session that launched it has died
// (../hub/live.mjs sessionGone), checked on each wake and again before it prints
// (docs/adr/2026-11-03-2010-a-watcher-exits-when-its-session-dies.md).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { routeRecord } from '../hub/routes.mjs';
import { readHubRules, rulesOf, ruleLines } from '../hub/rules.mjs';
import { boardAt, linksOf, hubLink, stopPreviousWatcher } from '../hub/boards.mjs';
import { parentOf, sessionGone } from '../hub/live.mjs';
import { ackPing, cardName, markWorking, settingsLines, settingsOf, WORKING_KINDS } from '../board/store.mjs';
import { readUsageGate, heldUsageEvent, pausedLine } from '../shared/usage-gate.mjs';
import { intakeKeyOf, waitsAgainLine } from '../board/domain.mjs';

const [route, session] = process.argv.slice(2);
if (!route || !session) { console.error('usage: wait-events.mjs <route> <session-id>'); process.exit(2); }
const MANIFEST = path.join(os.homedir(), '.claude', 'kickflip', 'manifest.json');

function site() {
  try { return routeRecord(JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).sites, route) || null; } catch { return undefined; }
}
function matching(s) {
  const re = s.filter ? new RegExp(s.filter) : null;
  const res = Object.create(null);
  for (const f of s.watch || ['data/events.jsonl']) {
    let lines = [];
    try { lines = fs.readFileSync(path.resolve(s.dir, f), 'utf8').split('\n').filter(Boolean); } catch {}
    res[f] = re ? lines.filter((l) => re.test(l)) : lines;
  }
  return res;
}

const QUIET = "quiet The owner doesn't read this session's terminal. Answer a prompt typed in it in full. A wake, a task "
  + "notification or a builder's result is not one: write no text of your own, since board.mjs and this watcher print one "
  + "line for each thing done. Talk and questions go on the board, never AskUserQuestion; only a failure the board can't "
  + 'show, such as the hub being down, gets one line here. Each message to the owner stands alone in its card\'s thread: name cards '
  + 'by label (#96), and a pointer such as "above" or "here" must make sense in that thread, never point into this session.';

// docs/adr/2026-11-06-1100-only-typed-thread-messages-wake-the-orchestrator.md: a button tap the board server applies
// itself (Hold, Resume, Done, Unbump, a bare or worded Grill, Prototype or Visual) and an unblock wake nobody.
const RECORD_ONLY = ['main-pulled', 'settings', 'ask-done', 'reviewers-removed', 'reviewers-added', 'question-reopen', 'repo-changed', 'ping', 'hello',
  'card-hold', 'card-done', 'card-unbump', 'card-unblocked', 'grill-more', 'prototype-request', 'visual-request'];
const parsed = (line) => { try { return JSON.parse(line); } catch { return null; } };
// docs/adr/2026-11-06-0204-intake-triage-sorts-new-tasks-on-sonnet.md: on a board, intake (a new task, the owner's
// message in an ask's thread, an agent-added card) is intake triage's, and its hand-off reaches the session as an
// intake wait in orchestrator-waits, so none of them wakes the session.
const recordOnly = (line, board) => {
  const e = parsed(line);
  return RECORD_ONLY.includes(e?.kind) || (Boolean(board) && e !== null && (e.kind === 'intake-handoff' || intakeKeyOf(e) !== null));
};
// A board is a site with a board.json; other sites get no rules.
function boardOf(s) {
  try { return JSON.parse(fs.readFileSync(path.resolve(s.dir, 'board.json'), 'utf8')); } catch (e) { return e.code === 'ENOENT' ? null : {}; }
}
// Printing the ping is the proof the session hears the board (docs/adr/2026-11-03-0003-the-board-records-what-it-knows-and-commands-make-the-rule-calls.md).
async function ackPings(dir, lines) {
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if ((e.kind === 'ping' || e.kind === 'hello') && typeof e.id === 'string') await ackPing(dir, e.id).catch((err) => console.log(`ping ${e.id} not answered (${err.message})`));
  }
}

const PLAIN = {
  ask: (e) => `new task ${e.id} received: intake triage sorts it`,
  'owner-answer': (e) => `answer received to question ${e.data?.id}`,
  ping: (e) => `ping ${e.id} from the hub answered`,
  hello: (e) => `ping ${e.id} from the hub answered`,
  'overnight-triage': (e) => `Overnight triage ${e.data?.date} asked: ${e.data?.cards?.length} cards wait on your answers`,
  'pr-review': (e) => `review asked on PR #${e.data?.pr}: the board was idle`,
  // docs/adr/2026-11-05-2358-nothing-waiting-on-the-orchestrator-is-missed.md
  'orchestrator-waits': (e) => [e.data?.added?.length && `waiting on you now: ${e.data.added.join(', ')}`,
    e.data?.again?.length && waitsAgainLine(e.data.again, Date.parse(e.ts))].filter(Boolean).join(' · '),
  'review-answer': (e) => `${e.data?.answer === 'skip' ? 'skip' : 'post'} answered on the review of PR #${e.data?.pr}`,
};
const ON_CARD = {
  // docs/adr/2026-11-05-0300-implement-in-the-thread-queues-the-card-for-the-orchestrator.md
  'item-message': (c, e) => (String(e.data?.key).startsWith('ask:') ? `message received from ${c}'s thread: intake triage answers it`
    : e.data?.intent === 'build' ? `Implement asked on ${c}: it is staging, the message in its notes; judge it, then item set --state ready, or --state grilling or prototyping` : `message received from ${c}'s thread`),
  'card-merge': (c) => `merge asked on ${c}`,
  'card-done': (c) => `${c} marked done`,
  'card-bump': (c) => `${c} bumped`,
  'ask-bump': (c) => `${c} bumped`,
  'ask-edited': (c) => `${c} edited`,
  'ask-done': (c) => `${c} marked done`,
  'ask-withdrawn': (c) => `${c} deleted`,
  'card-hold': (c, e) => `${c} ${e.data?.hold ? 'held' : 'resumed'}`,
  'card-unblocked': (c) => `${c} unblocked`,
  'prototype-request': (c) => `prototype asked on ${c}`,
  // docs/adr/2026-11-05-1921-a-visual-is-a-page-an-agent-draws-for-a-thread.md
  'visual-request': (c) => `visual asked on ${c}: the board launches its visual agent`,
  'reask-request': (c) => `question asked again on ${c}`,
  'builder-ask': (c, e) => `${e.data?.ask} from ${c}'s builder: ${e.data?.text}`,
  'owner-check-broken': (c, e) => `${c}'s owner-step check can't run: ${e.data?.error}`,
  'card-added': (c) => `${c} added by an agent: intake triage links and files it`,
  'intake-handoff': (c, e) => `intake triage handed ${c} to you: ${e.data?.text}`,
};

// One plain line per event line, from its kind and card (data.key, or data.id for an ask-* event), or null for a
// line that isn't an event. A card name that can't be read falls back to the key, so the cursor still moves.
async function plainLine(dir, line) {
  let e;
  try { e = JSON.parse(line); } catch { return null; }
  if (typeof e?.kind !== 'string') return null;
  const key = typeof e.data?.key === 'string' ? e.data.key : e.kind.startsWith('ask-') && typeof e.data?.id === 'string' ? `ask:${e.data.id}` : null;
  const card = key && await cardName(dir, key).catch(() => key);
  if (routeRecord(PLAIN, e.kind)) return PLAIN[e.kind](e);
  if (card && routeRecord(ON_CARD, e.kind)) return ON_CARD[e.kind](card, e);
  return card ? `${e.kind} on ${card}` : `${e.kind} received`;
}

// One line per card idle on the orchestrator (board/domain.mjs orchestratorWaits), none while the board server hasn't
// written the list.
function waitLines(dir) {
  let waits = [];
  try { waits = JSON.parse(fs.readFileSync(path.resolve(dir, 'data', 'orchestrator-waits.json'), 'utf8')).waits || []; } catch {}
  return waits.map((w) => `waits ${w.kind} ${w.ref} ${w.key} since ${w.since}${w.picked ? `, picked up ${w.picked}` : ''}: ${w.next}`);
}

const s0 = site();
if (!s0) { console.log('site-removed'); process.exit(0); }
// The cursor carries the counts across relaunches, so a line written while no watcher
// ran is still reported. Without it, the first run starts from the current counts.
const cursorFile = path.resolve(s0.dir, 'data', `.watch-cursor-${session}.json`);
const watcherFile = path.resolve(s0.dir, 'data', 'watcher.json');
const parents = [process.ppid, parentOf(process.ppid)];
const orphaned = () => {
  parents[1] ??= parentOf(parents[0]);
  if (sessionGone(session, parents)) process.exit(0);
};
stopPreviousWatcher(s0.dir, route, session);
try {
  fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
  fs.writeFileSync(watcherFile, JSON.stringify({ pid: process.pid, since: new Date().toISOString() }));
} catch {}
// A newer watcher may already own the file, so only this watcher's record gets its exit time.
process.on('exit', () => {
  try {
    const w = JSON.parse(fs.readFileSync(watcherFile, 'utf8'));
    if (w.pid === process.pid) fs.writeFileSync(watcherFile, JSON.stringify({ ...w, exited_at: new Date().toISOString() }));
  } catch {}
});
let base;
try { base = JSON.parse(fs.readFileSync(cursorFile, 'utf8')); } catch {}
if (!base) {
  base = Object.fromEntries(Object.entries(matching(s0)).map(([f, l]) => [f, l.length]));
  fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
  fs.writeFileSync(cursorFile, JSON.stringify(base));
}

for (;;) {
  await new Promise((r) => setTimeout(r, 2000));
  const s = site();
  if (s === undefined) continue;
  if (s === null) { console.log('site-removed'); process.exit(0); }
  if (s.owner?.session && s.owner.session !== session) { console.log('handed-over ' + JSON.stringify(s.owner)); process.exit(0); }
  orphaned();
  const pending = (seen) => Object.fromEntries(Object.entries(seen).map(([f, lines]) => [f, [...(routeRecord(base.$quietHeld, f) || []), ...(routeRecord(base.$usageHeld, f) || []), ...lines.slice(routeRecord(base, f) || 0)]]));
  const eligible = (line, gate) => gate.state !== 'paused' || !heldUsageEvent(line);
  const onBoard = boardOf(s) !== null;
  const quiet = (line) => recordOnly(line, onBoard);
  const wakes = (waiting, gate) => Object.values(waiting).some((lines) => lines.some((line) => eligible(line, gate) && !quiet(line)));
  const currentGate = readUsageGate({ dir: s.dir });
  const now = matching(s);
  if (!wakes(pending(now), currentGate)) {
    // Nothing to wake for: record-only lines are kept for the next wake, so the cursor can move past them.
    const fresh = Object.fromEntries(Object.entries(now).map(([f, lines]) => [f, lines.slice(routeRecord(base, f) || 0).filter(quiet)]));
    const rest = Object.fromEntries(Object.entries(now).map(([f, lines]) => [f, lines.slice(routeRecord(base, f) || 0).filter((l) => !quiet(l))]));
    if (Object.values(fresh).some((l) => l.length)) {
      if (boardOf(s)) await ackPings(s.dir, Object.values(fresh).flat());
      const append = (kept, add) => Object.fromEntries(Object.keys(now).map((f) => [f, [...(routeRecord(kept, f) || []), ...add[f]]]));
      base = { ...Object.fromEntries(Object.entries(now).map(([f, l]) => [f, l.length])), $quietHeld: append(base.$quietHeld, fresh), $usageHeld: append(base.$usageHeld, rest) };
      if (!Object.values(base.$usageHeld).some((l) => l.length)) delete base.$usageHeld;
      fs.writeFileSync(cursorFile, JSON.stringify(base));
    }
    continue;
  }
  await new Promise((r) => setTimeout(r, 2000));
  orphaned();
  const seen = matching(s);
  const gate = readUsageGate({ dir: s.dir });
  const waiting = pending(seen);
  if (!wakes(waiting, gate)) continue;
  const held = Object.create(null);
  const started = [];
  const heard = new Set(Object.values(base.$quietHeld || {}).flat());
  const pings = [];
  for (const [f, lines] of Object.entries(waiting)) {
    held[f] = lines.filter((line) => !eligible(line, gate));
    for (const line of lines.filter((line) => eligible(line, gate))) {
      if (!heard.has(line)) pings.push(line);
      console.log(`event ${f} ${line}`);
      const plain = await plainLine(s.dir, line);
      if (plain) console.log(plain);
      const e = parsed(line);
      if (e && WORKING_KINDS.includes(e.kind) && typeof e.id === 'string' && !quiet(line)) started.push(e.id);
    }
  }
  const board = boardOf(s);
  // The session takes each one it is handed, so its page reads "Working on it" from now
  // (docs/adr/2026-11-02-2044-the-cli-and-board-server-do-the-boards-housekeeping.md).
  if (board) await markWorking(s.dir, started).catch((e) => console.log(`working marks not written (${e.message})`));
  if (board) await ackPings(s.dir, pings);
  if (board) for (const line of waitLines(s.dir)) console.log(line);
  if (board) for (const line of ruleLines(readHubRules(), rulesOf(board))) console.log(`rule ${line}`);
  if (board) for (const line of settingsLines(settingsOf(board))) console.log(line);
  if (board) console.log(QUIET);
  if (gate.state === 'paused') console.log(pausedLine(gate));
  // This watcher still runs, so the events link reads as reaching the board. A failure here must not keep the
  // cursor below from moving, or the same events would wake the session again.
  try {
    const self = board && boardAt(s.dir);
    if (self) for (const l of [...linksOf(self, { listen: 'listening' }), hubLink()]) if (!l.ok) console.log(`link ${l.link} ${l.detail}`);
  } catch (e) { console.log(`link registry could not check the links (${e.message})`); }
  const next = Object.fromEntries(Object.entries(seen).map(([f, l]) => [f, l.length]));
  if (Object.values(held).some((lines) => lines.length)) next.$usageHeld = held;
  fs.writeFileSync(cursorFile, JSON.stringify(next));
  process.exit(0);
}
