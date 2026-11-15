// docs/adr/2026-11-15-0123-the-hub-restarts-a-session-not-listening-and-a-server-not-answering.md
// The hub's automatic restarts: a board session running but not listening (sessions.mjs checkSessions) and a board
// server running but not answering (hub.mjs reconcile). Each one appends to ~/.claude/kickflip/auto-restarts.jsonl
// {at, board, what: 'session' | 'server', why, outcome}, outcome 'restarted' or 'failed' as it happens, then 'back' or
// 'not back' once the hub knows whether it worked, so the owner can audit how often the boards needed one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { landQueue } from '../board/worktree.mjs';
import { openBoardBuilders } from '../board/store.mjs';

export const autoRestartsFile = () => path.join(os.homedir(), '.claude', 'kickflip', 'auto-restarts.jsonl');
// How long a board's Hub row says it was restarted.
export const ROW_FOR = 24 * 60 * 60_000;

export function logRestart({ board, what, why, outcome, error }, { now = new Date() } = {}) {
  const file = autoRestartsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ at: now.toISOString(), board, what, why, outcome, ...(error ? { error } : {}) }) + '\n');
}

export function readRestarts() {
  let text;
  try { text = fs.readFileSync(autoRestartsFile(), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return text.split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

// Each board's newest automatic restart within ROW_FOR, as its Hub row line: Map route → {link, detail}.
export function restartLines(now = Date.now(), entries = readRestarts()) {
  const lines = new Map();
  for (const e of entries) {
    if (e.outcome !== 'restarted' || now - Date.parse(e.at) > ROW_FOR) continue;
    lines.set(e.board, { link: 'restarted', detail: `the ${e.what} ${agoWords(now - Date.parse(e.at))}: ${e.why}` });
  }
  return lines;
}
const agoWords = (ms) => (ms < 60_000 ? 'just now' : ms < 3600_000 ? `${Math.floor(ms / 60_000)}m ago` : `${Math.floor(ms / 3600_000)}h ago`);

// Why an automatic restart of the board at dir waits: its session is busy (record, its live session record), a builder
// of the board is open, or a land is queued or landing on the host. → the reason, or null when nothing holds it.
export async function restartHeld({ dir, record = null, builders = openBoardBuilders, lands = landQueue }) {
  if (record?.status === 'busy') return 'its session is busy';
  if ((await builders(dir)).length) return 'a builder is open';
  if (lands().length) return 'a land is queued or landing';
  return null;
}
