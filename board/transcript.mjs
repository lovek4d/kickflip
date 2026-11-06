import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TAIL_BYTES = 256 * 1024;

// → whether the transcript file's last message is a tool call with no result after it: a command still running.
// Reads only the file's tail; a line cut by the tail or still being written doesn't parse and is skipped.
function endsOnToolCall(file, size) {
  const length = Math.min(size, TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buffer, 0, length, size - length); } finally { fs.closeSync(fd); }
  for (const line of buffer.toString('utf8').split('\n').reverse()) {
    let content;
    try { content = JSON.parse(line).message?.content; } catch { continue; }
    if (Array.isArray(content)) return content.at(-1)?.type === 'tool_use';
  }
  return false;
}

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

// → whether a run in worktree has a command still running: its newest transcript ends on a tool call with no result yet.
export function transcriptCommandRunning(worktree, home = os.homedir()) {
  try {
    const newest = newestTranscript(worktree, home);
    return newest !== undefined && endsOnToolCall(newest.file, newest.stat.size);
  } catch {
    return false;
  }
}
