// `board.mjs brief`: what a fresh orchestrator session reads after its join, in place of a long session's memory
// (docs/adr/2026-11-17-2330-an-idle-orchestrator-restarts-fresh-once-its-prompt-cache-lapses.md). The open waits are
// left to the watcher's first wake, which prints them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DAY = 24 * 60 * 60_000;
const clip = (s, n = 300) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

// Claude Code's memory index for sessions in repo: <home>/.claude/projects/<repo's real path, each character but a
// letter or digit a dash>/memory/MEMORY.md, as session-activity.mjs names a transcript's folder.
export function memoryFile(repo, { home = os.homedir(), real = (p) => { try { return fs.realpathSync(p); } catch { return p; } } } = {}) {
  return path.join(home, '.claude', 'projects', real(repo).replace(/[^a-zA-Z0-9]/g, '-'), 'memory', 'MEMORY.md');
}

// A card in progress as the brief says it: handed back (with calls to verify, or checked), else its builder's line.
function progressOf(c) {
  if (c.waitsOn === 'checking') return c.orchestrator?.kind === 'calls' ? 'handed back with judgment calls to verify' : `handed back, checked: ${c.next || 'land it'}`;
  if (!c.builder) return c.next || `waits on ${c.waitsOn}`;
  return `${c.builder.words || c.builder.phase || 'building'}${c.builder.stopped ? ` (stopped: ${c.builder.stopped})` : c.builder.stale ? ' (stale)' : ''}`;
}

// The owner's own words: their thread messages, the asks they wrote (not one the orchestrator filed, another board
// asked or a session routed) and their answers. → a line, or null for an event that isn't the owner's
function ownerLine(e) {
  if (e.kind === 'item-message') return `${e.data?.key}: ${clip(e.data?.text)}`;
  if (e.kind === 'ask' && !e.data?.asked && !e.data?.from && !e.data?.routed) return `ask ${e.id}: ${clip(e.data?.text)}`;
  if (e.kind === 'owner-answer') return `answer ${e.data?.id}: ${clip(e.data?.question, 150)} → ${e.data?.label || e.data?.choice || ''}${e.data?.note ? ` (${clip(e.data.note)})` : ''}`;
  return null;
}

// cards: the board's built work cards; events: its events.jsonl; memory: {file, exists}. → the brief's lines
export function briefLines({ route, cards, events, memory, now }) {
  const list = (rows) => (rows.length ? rows.map((r) => `  ${r}`) : ['  none']);
  const since = now.getTime() - DAY;
  return [
    `Board brief for /${route} at ${now.toISOString()}. The watcher's first wake prints the open waits.`,
    'In Progress:',
    ...list(cards.filter((c) => c.lane === 'progress').map((c) => `${c.ref} ${c.key} ${c.title}: ${progressOf(c)}`)),
    'Waiting on the owner:',
    ...list(cards.filter((c) => c.action).map((c) => `${c.ref} ${c.key} ${c.title}: ${c.action.label}`)),
    'Owner messages, last 24 h:',
    ...list(events.filter((e) => Date.parse(e.ts) >= since).map((e) => { const l = ownerLine(e); return l && `${e.ts} ${l}`; }).filter(Boolean)),
    `Memory: ${memory.file}${memory.exists ? '' : ' (none yet)'}`,
    'Anything you needed and could not find here or on the board is a board gap: file it.',
  ];
}
