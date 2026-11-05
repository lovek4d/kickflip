import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// → when (ms) a run in worktree last moved: the newest .jsonl in its Claude Code transcript folder
// (<home>/.claude/projects/<the worktree path with / and . turned into ->), or null when the folder holds none or can't be read.
export function transcriptMovedAt(worktree, home = os.homedir()) {
  const folder = path.join(home, '.claude', 'projects', worktree.replace(/[/.]/g, '-'));
  try {
    const times = fs.readdirSync(folder).filter((f) => f.endsWith('.jsonl')).map((f) => fs.statSync(path.join(folder, f)).mtimeMs);
    return times.length ? Math.max(...times) : null;
  } catch {
    return null;
  }
}
