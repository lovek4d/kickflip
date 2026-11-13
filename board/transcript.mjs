import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// → the newest .jsonl ({file, stat}) in a run's Claude Code transcript folder
// (<home>/.claude/projects/<the worktree's real path with / and . turned into ->, as Claude Code names it from its cwd>),
// or undefined when it holds none; throws when the folder can't be read.
function newestTranscript(worktree, home) {
  let real = worktree;
  try { real = fs.realpathSync(worktree); } catch {}
  const folder = path.join(home, '.claude', 'projects', real.replace(/[/.]/g, '-'));
  return fs.readdirSync(folder).filter((f) => f.endsWith('.jsonl')).map((f) => ({ file: path.join(folder, f), stat: fs.statSync(path.join(folder, f)) }))
    .reduce((a, b) => (a && a.stat.mtimeMs >= b.stat.mtimeMs ? a : b), undefined);
}

// → when (ms) a run in worktree last moved: the mtime of its newest transcript, or null when there is none or it can't be read.
export function transcriptMovedAt(worktree, home = os.homedir()) {
  try {
    return newestTranscript(worktree, home)?.stat.mtimeMs ?? null;
  } catch {
    return null;
  }
}

// A run's own transcript, from its stream log (headless.mjs: `claude -p --output-format stream-json`, one event per
// line), for the reader sheet's View transcript (app-reader.js). Rows {kind, label?, body, id?, for?}: the start,
// Claude's words, each tool call as one line with its id, each call's output as an `out` row `for` that id (the sheet
// opens it on the call's line), a line that isn't an event as an `out` row of its own, and the result. Thinking and the
// other events have none; a user event's `tool_use_result` copy of the output is skipped for `message.content`'s.
const OUTPUT_CHARS = 4000;
const cut = (v) => (v.length > OUTPUT_CHARS ? `${v.slice(0, OUTPUT_CHARS)}…` : v);
const textOf = (content) => (typeof content === 'string' ? content : content.map((part) => part.text ?? '').join('\n'));
const callOf = (input) => input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.description ?? JSON.stringify(input);
const eventOf = (line) => { try { const e = JSON.parse(line); return typeof e?.type === 'string' ? e : null; } catch { return null; } };

function rowsOf(e) {
  if (e.type === 'system') return e.subtype === 'init' ? [{ kind: 'sys', label: 'start', body: `${e.model} in ${e.cwd}` }] : [];
  if (e.type === 'result') return [{ kind: 'text end', label: e.is_error ? 'stopped' : 'done', body: e.result ?? e.subtype }];
  if (e.type !== 'assistant' && e.type !== 'user') return [];
  const content = e.message.content;
  if (typeof content === 'string') return [{ kind: 'text', body: content }];
  return content.flatMap((c) => (c.type === 'text' ? [{ kind: 'text', body: c.text }]
    : c.type === 'tool_use' ? [{ kind: 'tool', id: c.id, label: c.name.toLowerCase(), body: callOf(c.input) }]
    : c.type === 'tool_result' ? [{ kind: 'out', for: c.tool_use_id, body: cut(textOf(c.content)) }] : []));
}

// → {rows, next, stream, finished} of a log's bytes from byte `from`, read to their last whole line: `next` is the
// byte after it, where the next read starts; `stream` whether a line was an event, `finished` whether the result was.
export function transcriptChunk(bytes, from) {
  const end = bytes.lastIndexOf(10) + 1;
  const lines = bytes.subarray(0, end).toString('utf8').split('\n').slice(0, -1);
  const rows = [];
  let stream = false;
  let finished = false;
  for (const line of lines) {
    const e = eventOf(line);
    if (!e) { rows.push({ kind: 'out', body: cut(line) }); continue; }
    stream = true;
    finished ||= e.type === 'result';
    rows.push(...rowsOf(e));
  }
  return { rows, next: from + end, stream, finished };
}

// → transcriptChunk of the log file from byte `from` to its end, with the file's size.
export async function readRunTranscript(file, from) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const bytes = Buffer.alloc(Math.max(0, size - from));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, from);
    return { ...transcriptChunk(bytes.subarray(0, bytesRead), from), size };
  } finally { await handle.close(); }
}
