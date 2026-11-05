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

// → when (ms) a run in worktree last moved: now while its newest .jsonl in its Claude Code transcript folder
// (<home>/.claude/projects/<the worktree path with / and . turned into ->) ends on a tool call with no result yet,
// else that file's mtime; null when the folder holds none or can't be read.
export function transcriptMovedAt(worktree, home = os.homedir(), now = Date.now()) {
  const folder = path.join(home, '.claude', 'projects', worktree.replace(/[/.]/g, '-'));
  try {
    const files = fs.readdirSync(folder).filter((f) => f.endsWith('.jsonl')).map((f) => ({ file: path.join(folder, f), stat: fs.statSync(path.join(folder, f)) }));
    if (!files.length) return null;
    const newest = files.reduce((a, b) => (b.stat.mtimeMs > a.stat.mtimeMs ? b : a));
    return endsOnToolCall(newest.file, newest.stat.size) ? now : newest.stat.mtimeMs;
  } catch {
    return null;
  }
}
