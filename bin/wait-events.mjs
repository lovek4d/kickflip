#!/usr/bin/env node
// Waits for the next viewer event on a site, then exits so the owning Claude
// session wakes up. Run it as a background task; relaunch it after handling.
//   wait-events.mjs <route> <session-id>
// Watches the files in the site's manifest `watch` list (relative to its dir),
// counting lines that match `filter` (a regex; every line when unset).
// Prints and exits on:
//   event <file> <line>       new matching lines (several, batched for 2 s), each followed by one plain line saying
//                             what came in, on which card and what to do (plainLine, from ./event-lines.mjs), prefixed `already shown: `
//                             for one the PostToolUse hook showed mid-task (./event-lines.mjs shownFile,
//                             docs/adr/2026-11-10-1056-the-owners-words-reach-the-orchestrator-after-its-next-tool-call.md); on a board it marks each ask,
//                             item-message, wave-triage and overnight-triage working in data/working.json, moves the mark of an ask
//                             whose ask-edited it prints to now (the stamp sorting commands check), and answers a ping for the
//                             session (board/store.mjs ackPing), then prints:
//   waits <kind> <ref> <key>[ bumped] since <iso>[, picked up <iso>]: <next>
//                             each wait on the orchestrator, a line for each of a card's waits, bumped cards first, then lanes top-down, from data/orchestrator-waits.json,
//                             which the board server keeps (board/server.mjs checkWaits): handle each one on every wake
//                             (docs/adr/2026-11-04-2300-each-lane-is-a-queue-for-the-orchestrator.md), then
//   rule hub <text>           each hub rule (settings.json `rules`), then
//   rule board <text>         each of the board's own (board.json `rules`): the owner's standing instructions,
//                             printed with every wake (docs/adr/2026-10-29-1639-rules-live-on-settings-at-hub-and-board-level.md), then
//   setting <name> <value>    each board setting from board.json: auto-merge, auto-build, auto-triage, auto-review, skip-draft and the rest on|off,
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
//   ./event-lines.mjs RECORD_ONLY, the board server's own taps and usage-resumed among them. The cursor moves past them
//   at once, a ping is answered then, and their lines print, in order, ahead of the new events on the next wake.
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
import { pathToFileURL } from 'node:url';
import { routeRecord } from '../hub/routes.mjs';
import { readHubRules, rulesOf, ruleLines } from '../hub/rules.mjs';
import { boardAt, linksOf, hubLink, stopPreviousWatcher } from '../hub/boards.mjs';
import { parentOf, sessionGone as sessionGoneFor } from '../hub/live.mjs';
import { ackPing, editedAsks, markWorking, restampWorking, settingsLines, settingsOf, WORKING_KINDS } from '../board/store.mjs';
import { readUsageGate, heldUsageEvent, pausedLine } from '../shared/usage-gate.mjs';
import { recordOnly, plainLine, shownFile } from './event-lines.mjs';

function siteOf(route) {
  try { return routeRecord(JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'kickflip', 'manifest.json'), 'utf8')).sites, route) || null; } catch { return undefined; }
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

const parsed = (line) => { try { return JSON.parse(line); } catch { return null; } };
// A board is a site with a board.json; other sites get no rules.
function boardOf(s) {
  try { return JSON.parse(fs.readFileSync(path.resolve(s.dir, 'board.json'), 'utf8')); } catch (e) { return e.code === 'ENOENT' ? null : {}; }
}
// Printing the ping is the proof the session hears the board (docs/adr/2026-11-03-0003-the-board-records-what-it-knows-and-commands-make-the-rule-calls.md).
async function ackPings(dir, lines, log) {
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if ((e.kind === 'ping' || e.kind === 'hello') && typeof e.id === 'string') await ackPing(dir, e.id).catch((err) => log(`ping ${e.id} not answered (${err.message})`));
  }
}

// One line per card idle on the orchestrator (board/domain.mjs orchestratorWaits), none while the board server hasn't
// written the list.
function waitLines(dir) {
  let waits = [];
  try { waits = JSON.parse(fs.readFileSync(path.resolve(dir, 'data', 'orchestrator-waits.json'), 'utf8')).waits || []; } catch {}
  return waits.map((w) => `waits ${w.kind} ${w.ref} ${w.key}${w.bumpedAt ? ' bumped' : ''} since ${w.since}${w.picked ? `, picked up ${w.picked}` : ''}: ${w.next}`);
}

// The hub links that don't reach the board, as `link <name> <detail>` lines. This watcher still runs, so the events
// link reads as reaching the board.
function linkLines(dir) {
  const self = boardAt(dir);
  return self ? [...linksOf(self, { listen: 'listening' }), hubLink()].filter((l) => !l.ok).map((l) => `link ${l.link} ${l.detail}`) : [];
}

// Writes through a temp file and a rename, so a reader of the cursor or watcher.json sees the old file or the new one, never half.
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// Watches one site for the session until an event wakes it, printing through log, and returns the exit code.
// sleep(ms) paces the 2 s polls and the 2 s batching window, sessionGone() says whether the session that launched
// the watcher has died, and pid is the watcher's own pid in watcher.json; links(dir) gives the link lines. A test
// drives each of them.
export async function watch({ route, session, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), sessionGone, log = console.log, pid = process.pid, links = linkLines }) {
  const s0 = siteOf(route);
  if (!s0) { log('site-removed'); return 0; }
  // The cursor carries the counts across relaunches, so a line written while no watcher
  // ran is still reported. Without it, the first run starts from the current counts.
  const cursorFile = path.resolve(s0.dir, 'data', `.watch-cursor-${session}.json`);
  const watcherFile = path.resolve(s0.dir, 'data', 'watcher.json');
  stopPreviousWatcher(s0.dir, route, session);
  try {
    fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
    writeAtomic(watcherFile, JSON.stringify({ pid, since: new Date().toISOString() }));
  } catch {}
  try {
    let base;
    try { base = JSON.parse(fs.readFileSync(cursorFile, 'utf8')); } catch {}
    if (!base) {
      base = Object.fromEntries(Object.entries(matching(s0)).map(([f, l]) => [f, l.length]));
      fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
      writeAtomic(cursorFile, JSON.stringify(base));
    }
    // Each pass that finds nothing to wake for counts in watcher.json, which a test waits on instead of a timer.
    let checks = 0;
    for (;;) {
      await sleep(2000);
      const s = siteOf(route);
      if (s === undefined) continue;
      if (s === null) { log('site-removed'); return 0; }
      if (s.owner?.session && s.owner.session !== session) { log('handed-over ' + JSON.stringify(s.owner)); return 0; }
      if (sessionGone()) return 0;
      const pending = (seen) => Object.fromEntries(Object.entries(seen).map(([f, lines]) => [f, [...(routeRecord(base.$quietHeld, f) || []), ...(routeRecord(base.$usageHeld, f) || []), ...lines.slice(routeRecord(base, f) || 0)]]));
      const eligible = (line, gate) => gate.state !== 'paused' || !heldUsageEvent(line);
      const wakes = (waiting, gate) => Object.values(waiting).some((lines) => lines.some((line) => eligible(line, gate) && !recordOnly(line)));
      const currentGate = readUsageGate({ dir: s.dir });
      const now = matching(s);
      if (!wakes(pending(now), currentGate)) {
        // Nothing to wake for: record-only lines are kept for the next wake, so the cursor can move past them.
        const fresh = Object.fromEntries(Object.entries(now).map(([f, lines]) => [f, lines.slice(routeRecord(base, f) || 0).filter(recordOnly)]));
        const rest = Object.fromEntries(Object.entries(now).map(([f, lines]) => [f, lines.slice(routeRecord(base, f) || 0).filter((l) => !recordOnly(l))]));
        if (Object.values(fresh).some((l) => l.length)) {
          if (boardOf(s)) await ackPings(s.dir, Object.values(fresh).flat(), log);
          const append = (kept, add) => Object.fromEntries(Object.keys(now).map((f) => [f, [...(routeRecord(kept, f) || []), ...add[f]]]));
          base = { ...Object.fromEntries(Object.entries(now).map(([f, l]) => [f, l.length])), $quietHeld: append(base.$quietHeld, fresh), $usageHeld: append(base.$usageHeld, rest) };
          if (!Object.values(base.$usageHeld).some((l) => l.length)) delete base.$usageHeld;
          writeAtomic(cursorFile, JSON.stringify(base));
        }
        checks += 1;
        try { writeAtomic(watcherFile, JSON.stringify({ pid, since: JSON.parse(fs.readFileSync(watcherFile, 'utf8')).since, checks })); } catch {}
        continue;
      }
      await sleep(2000);
      if (sessionGone()) return 0;
      const seen = matching(s);
      const gate = readUsageGate({ dir: s.dir });
      const waiting = pending(seen);
      if (!wakes(waiting, gate)) continue;
      const held = Object.create(null);
      const started = [];
      const handed = [];
      const heard = new Set(Object.values(base.$quietHeld || {}).flat());
      const pings = [];
      let shown = [];
      try { shown = JSON.parse(fs.readFileSync(shownFile(s.dir, session), 'utf8')).ids || []; } catch {}
      for (const [f, lines] of Object.entries(waiting)) {
        held[f] = lines.filter((line) => !eligible(line, gate));
        for (const line of lines.filter((line) => eligible(line, gate))) {
          if (!heard.has(line)) pings.push(line);
          log(`event ${f} ${line}`);
          const plain = await plainLine(s.dir, line);
          const e = parsed(line);
          if (plain) log(shown.includes(e?.id) ? `already shown: ${plain}` : plain);
          if (e && WORKING_KINDS.includes(e.kind) && typeof e.id === 'string') started.push(e.id);
          handed.push(e);
        }
      }
      const board = boardOf(s);
      // The session takes each one it is handed, so its page reads "Working on it" from now
      // (docs/adr/2026-11-02-2044-the-cli-and-board-server-do-the-boards-housekeeping.md).
      // An ask edit it prints hands the ask's new text over, so the ask's mark moves to now
      // (docs/adr/2026-11-12-1300-sorting-an-ask-refuses-an-edit-the-orchestrator-hasnt-read.md).
      if (board) await markWorking(s.dir, started).then(() => restampWorking(s.dir, editedAsks(handed))).catch((e) => log(`working marks not written (${e.message})`));
      if (board) await ackPings(s.dir, pings, log);
      if (board) for (const line of waitLines(s.dir)) log(line);
      if (board) for (const line of ruleLines(readHubRules(), rulesOf(board))) log(`rule ${line}`);
      if (board) for (const line of settingsLines(settingsOf(board))) log(line);
      if (board) log(QUIET);
      if (gate.state === 'paused') log(pausedLine(gate));
      // A failure here must not keep the cursor below from moving, or the same events would wake the session again.
      if (board) {
        try { for (const line of links(s.dir)) log(line); } catch (e) { log(`link registry could not check the links (${e.message})`); }
      }
      const next = Object.fromEntries(Object.entries(seen).map(([f, l]) => [f, l.length]));
      if (Object.values(held).some((lines) => lines.length)) next.$usageHeld = held;
      writeAtomic(cursorFile, JSON.stringify(next));
      return 0;
    }
  } finally {
    // A newer watcher may already own the file, so only this watcher's record gets its exit time.
    try {
      const w = JSON.parse(fs.readFileSync(watcherFile, 'utf8'));
      if (w.pid === pid) writeAtomic(watcherFile, JSON.stringify({ ...w, exited_at: new Date().toISOString() }));
    } catch {}
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [route, session] = process.argv.slice(2);
  if (!route || !session) { console.error('usage: wait-events.mjs <route> <session-id>'); process.exit(2); }
  const parents = [process.ppid, parentOf(process.ppid)];
  const sessionGone = () => {
    parents[1] ??= parentOf(parents[0]);
    return sessionGoneFor(session, parents);
  };
  process.exit(await watch({ route, session, sessionGone }));
}
