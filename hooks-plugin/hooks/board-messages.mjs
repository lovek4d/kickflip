#!/usr/bin/env node
// A Claude Code PostToolUse hook that shows a board's session the owner's new words while it works, after its next tool
// call, instead of only at its watcher's next wake: each thread message, ask and ask edit (OWNER_WORDS) past the
// watcher's cursor that it hasn't shown yet, with its sent time and age, its plain line and its event line. It marks
// the ones the watcher marks working (WORKING_KINDS), so they read thinking… on the board at once, moves the mark of an
// ask whose edit it shows to now, as the watcher does, and records them in
// the session's shown file, so the watcher's next wake prints them again tagged already shown. A subagent's tool call
// carries agent_id and gets nothing. Any error shows nothing
// (docs/adr/2026-11-10-1056-the-owners-words-reach-the-orchestrator-after-its-next-tool-call.md).
import fs from 'node:fs';
import path from 'node:path';

process.stdout.on('error', () => {});

const EVENTS = 'data/events.jsonl';
const readJSON = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const parsed = (line) => { try { return JSON.parse(line); } catch { return null; } };
function age(ts, now) {
  const min = Math.floor((now - Date.parse(ts)) / 60_000);
  if (!(min >= 1)) return 'just now';
  return min < 60 ? `${min} min ago` : `${Math.floor(min / 60)} h ${min % 60} min ago`;
}

async function shownOn(board, session, now) {
  const { OWNER_WORDS, plainLine, shownFile } = await import('../../bin/event-lines.mjs');
  const { editedAsks, markWorking, restampWorking, WORKING_KINDS } = await import('../../board/store.mjs');
  const cursor = readJSON(path.join(board.dir, 'data', `.watch-cursor-${session}.json`));
  if (!Number.isInteger(cursor?.[EVENTS])) return [];
  let lines = [];
  try { lines = fs.readFileSync(path.join(board.dir, EVENTS), 'utf8').split('\n').filter(Boolean).slice(cursor[EVENTS]); } catch {}
  const pending = lines.map((line) => ({ line, e: parsed(line) })).filter(({ e }) => OWNER_WORDS.includes(e?.kind) && typeof e.id === 'string');
  const file = shownFile(board.dir, session);
  // Ids the watcher has since woken past drop out.
  const before = (readJSON(file)?.ids || []).filter((id) => pending.some(({ e }) => e.id === id));
  const fresh = pending.filter(({ e }) => !before.includes(e.id));
  if (!fresh.length) return [];
  await markWorking(board.dir, fresh.filter(({ e }) => WORKING_KINDS.includes(e.kind)).map(({ e }) => e.id));
  await restampWorking(board.dir, editedAsks(fresh.map(({ e }) => e)));
  fs.writeFileSync(file, JSON.stringify({ ids: [...before, ...fresh.map(({ e }) => e.id)] }));
  const out = [`The owner wrote on /${board.route} while you worked. Read it now: their words come before what you were doing. Your watcher prints each again on its next wake, tagged already shown.`];
  for (const { line, e } of fresh) out.push(`sent ${e.ts}, ${age(e.ts, now)}: ${await plainLine(board.dir, line)}`, `event ${EVENTS} ${line}`);
  return out;
}

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (input.hook_event_name === 'PostToolUse' && !input.agent_id && typeof input.session_id === 'string' && input.session_id) {
    const { listBoards } = await import('../../hub/boards.mjs');
    const owned = listBoards().filter((b) => b.owner?.session === input.session_id);
    const now = Date.now();
    const lines = (await Promise.all(owned.map((b) => shownOn(b, input.session_id, now).catch(() => [])))).flat();
    if (lines.length) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: lines.join('\n') } }));
  }
} catch {}
process.exitCode = 0;
