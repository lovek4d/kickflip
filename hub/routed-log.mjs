// docs/adr/2026-11-21-2300-each-board-takes-a-routed-ask-or-passes-it-down-haikus-ranking.md
// ~/.claude/kickflip/routed.json: each request the router filed, newest last, for the hub page's New rows. The hub writes
// an entry when it files a request (router.mjs) and when the owner places or Haiku answers one; a board's `ask move
// --next` writes it when its orchestrator passes the ask on (board/asks.mjs passAsk). An entry is {id, at, text, via, by,
// link?, slack?, route, eventId, reason}: route and eventId are where the ask is now, and passed [{route, reason}] the
// boards that passed it, in order. unplaced marks one every board in Haiku's ranking passed, answer {text, at, slack?,
// slackError?} Haiku's answer to it, and placed one the owner then put on a board.
import os from 'node:os';
import path from 'node:path';
import { readJSON, saveJSON } from './boards.mjs';
import { withFileLock } from './locks.mjs';

export const ROUTED_LOG = path.join(os.homedir(), '.claude', 'kickflip', 'routed.json');
// The hub page shows this many; the log keeps no more.
const KEEP = 30;

export const readRouted = () => readJSON(ROUTED_LOG, { routed: [] }).routed;
// Runs change(entries) → entries under the log's lock, keeping the newest KEEP.
export const changeRouted = (change) => withFileLock(ROUTED_LOG, () => saveJSON(ROUTED_LOG, { routed: change(readRouted()).slice(-KEEP) }));
// Changes the entry with request id id to change(entry); an entry already gone from the log stays gone.
export const changeEntry = (id, change) => changeRouted((entries) => entries.map((e) => (e.id === id ? change(e) : e)));

// Records that the board at route passed request id's ask on for reason: to {route, eventId}, the ask on the next board,
// or none, when no board was left, which leaves it unplaced for Haiku to answer.
export const notePassed = (id, { route, reason }, to) => changeEntry(id, (e) => ({
  ...e, passed: [...(e.passed || []), { route, reason }], ...(to ? { route: to.route, eventId: to.eventId } : { unplaced: true }),
}));
