// What a Claude Code session last did, from its transcript, for a starting board's row
// (docs/adr/2026-11-16-2300-a-starting-board-shows-its-sessions-liveness-activity-and-prompt.md). Claude Code writes a
// session's transcript to <home>/.claude/projects/<its folder's real path, each character but a letter or digit turned
// into ->/<session>.jsonl, one event per line.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { actionOf } from './prompts.mjs';

// The tail read for the last step: a step's line can be long, but the last one sits within it.
const TAIL_BYTES = 256 * 1024;
const ING = { run: 'running', read: 'reading', edit: 'editing', write: 'writing', fetch: 'fetching', search: 'searching', use: 'using' };

// The session's transcript file: under its folder's name, else under any project folder, since Claude Code's naming of
// a folder with other characters isn't pinned. → path | null
function transcriptFile(folder, session, home) {
  const projects = path.join(home, '.claude', 'projects');
  let real = folder;
  try { real = fs.realpathSync(folder); } catch {}
  const named = path.join(projects, real.replace(/[^a-zA-Z0-9]/g, '-'), `${session}.jsonl`);
  if (fs.existsSync(named)) return named;
  let dirs = [];
  try { dirs = fs.readdirSync(projects); } catch { return null; }
  return dirs.map((d) => path.join(projects, d, `${session}.jsonl`)).find((f) => fs.existsSync(f)) || null;
}

// One tool call as the row says it: loading a skill, joining the hub, else prompts.mjs actionOf in its -ing form.
function stepOf({ name, input }) {
  if (name === 'Skill') return `loading the ${input?.skill || input?.command || 'a'} skill`;
  if (name === 'Bash' && /\bkickflip(\.mjs)?\s+join\b/.test(input?.command || '')) return 'joining the hub';
  const action = actionOf(name, input);
  const [verb, ...rest] = action.split(' ');
  return [ING[verb] || verb, ...rest].join(' ');
}

// The last assistant step in lines, newest first: a tool call, thinking, or writing; null when the session hasn't taken one.
function lastStep(lines) {
  for (const l of lines.toReversed()) {
    let event;
    try { event = JSON.parse(l); } catch { continue; }
    if (event?.type !== 'assistant' || !Array.isArray(event.message?.content)) continue;
    const part = event.message.content.findLast((c) => ['tool_use', 'thinking', 'text'].includes(c?.type));
    if (!part) continue;
    return part.type === 'tool_use' ? stepOf(part) : part.type === 'thinking' ? 'thinking' : 'writing';
  }
  return null;
}

// The session's last turn: its transcript's last write (ms), or null when no transcript of the session can be read.
export function lastTurn(folder, session, { home = os.homedir() } = {}) {
  if (typeof session !== 'string' || !/^[\w-]+$/.test(session)) return null;
  const file = transcriptFile(folder, session, home);
  return file ? fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? null : null;
}

// → {at: the transcript's last write (ms), text: its last step, or 'reading its prompt' before it took one}, or null
// when no transcript of the session can be read.
export function sessionActivity(folder, session, { home = os.homedir() } = {}) {
  if (typeof session !== 'string' || !/^[\w-]+$/.test(session)) return null;
  const file = transcriptFile(folder, session, home);
  if (!file) return null;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const { size, mtimeMs } = fs.fstatSync(fd);
      const from = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      return { at: mtimeMs, text: lastStep(buf.toString('utf8').split('\n')) || 'reading its prompt' };
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}
