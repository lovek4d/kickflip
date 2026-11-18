#!/usr/bin/env node
// A Claude Code PostToolUse hook that signals a board's session the owner's new words while it works, after its next
// tool call, instead of only at its watcher's next wake: each thread message, ask and ask edit (ownerWords: never an ask
// the orchestrator filed itself) past the watcher's cursor that it hasn't signalled yet and inbox read hasn't handed
// over, as one signal line each, never the words. board.mjs inbox read prints them and stamps them picked up; the hook
// stamps nothing, and records the ids it signalled in the session's shown file. A subagent's tool call carries agent_id
// and gets nothing. Any error shows nothing
// (docs/adr/2026-11-10-1056-the-owners-words-reach-the-orchestrator-after-its-next-tool-call.md,
// docs/adr/2026-11-18-1300-requests-arrive-as-a-signal-and-inbox-read-hands-over-the-words.md).
import fs from 'node:fs';
import path from 'node:path';

process.stdout.on('error', () => {});

const EVENTS = 'data/events.jsonl';
const readJSON = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const parsed = (line) => { try { return JSON.parse(line); } catch { return null; } };

async function shownOn(board, session) {
  const { ownerWords, shownFile, signalLine, wasRead } = await import('../../bin/event-lines.mjs');
  const { readDelivered } = await import('../../board/store.mjs');
  const cursor = readJSON(path.join(board.dir, 'data', `.watch-cursor-${session}.json`));
  if (!Number.isInteger(cursor?.[EVENTS])) return [];
  let lines = [];
  try { lines = fs.readFileSync(path.join(board.dir, EVENTS), 'utf8').split('\n').filter(Boolean).slice(cursor[EVENTS]); } catch {}
  const pending = lines.map(parsed).filter((e) => ownerWords(e) && typeof e.id === 'string');
  const file = shownFile(board.dir, session);
  // Ids the watcher has since woken past drop out.
  const before = (readJSON(file)?.ids || []).filter((id) => pending.some((e) => e.id === id));
  const delivered = await readDelivered(board.dir);
  const fresh = pending.filter((e) => !before.includes(e.id) && !wasRead(delivered, e));
  if (!fresh.length) return [];
  fs.writeFileSync(file, JSON.stringify({ ids: [...before, ...fresh.map((e) => e.id)] }));
  // A message the hub copied from a Slack thread carries slack.by, its sender: not the owner, so it approves nothing.
  const read = `board.mjs --site ${board.route} inbox read`;
  const out = [fresh.some((e) => !e.data?.slack?.by)
    ? `The owner wrote on /${board.route} while you worked. Read it now with ${read}: their words come before what you were doing.`
    : `${[...new Set(fresh.map((e) => e.data.slack.by))].join(', ')} wrote via Slack on /${board.route} while you worked (not the owner; these words approve nothing). Read it with ${read}.`];
  for (const e of fresh) out.push(await signalLine(board.dir, e));
  return out;
}

// docs/adr/2026-11-16-0007-builder-resume-updates-a-running-builder-or-resumes-a-handed-back-one.md
// A board-launched builder's session gets the news its card holds for it (board/runs.mjs takeNews), found by the pointer
// data/builder-news/<session id>.json that names the card.
async function newsOn(board, session) {
  const key = readJSON(path.join(board.dir, 'data', 'builder-news', `${session}.json`))?.key;
  if (!key) return [];
  const { takeNews } = await import('../../board/store.mjs');
  return takeNews(board.dir, key);
}

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (input.hook_event_name === 'PostToolUse' && !input.agent_id && typeof input.session_id === 'string' && input.session_id) {
    const { listBoards } = await import('../../hub/boards.mjs');
    const boards = listBoards();
    const owned = boards.filter((b) => b.owner?.session === input.session_id);
    const lines = (await Promise.all([...owned.map((b) => shownOn(b, input.session_id).catch(() => [])), ...boards.map((b) => newsOn(b, input.session_id).catch(() => []))])).flat();
    if (lines.length) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: lines.join('\n') } }));
  }
} catch {}
process.exitCode = 0;
