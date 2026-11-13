import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { collator } from '../shared/a-to-z.mjs';

const execFileAsync = promisify(execFile);

export function buildScriptError(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return 'Build script must be an absolute path.';
  let stat;
  try { stat = fs.lstatSync(file); } catch { return `Build script ${path.basename(file)} must be an existing regular file.`; }
  if (!stat.isFile()) return `Build script ${path.basename(file)} must be an existing regular file.`;
  if (stat.uid !== process.getuid()) return 'Build script must be owned by the current user.';
  if (stat.mode & 0o022) return 'Build script must not be writable by group or others.';
  if (!(stat.mode & 0o100)) return 'Build script must be executable.';
  return null;
}

// A board's build target, board.json build_target, names `.kickflip/build-<target>` in its repo; with none the hub runs
// `.kickflip/build` (docs/adr/2026-11-05-1823-board-settings-picks-which-build-script-a-board-runs.md).
export const validBuildTarget = (value) => typeof value === 'string' && /^[A-Za-z0-9][\w.-]{0,63}$/.test(value);
// → the script's path relative to a worktree, `.kickflip/build` or `.kickflip/build-<target>`
export const buildScriptOf = (target) => (target ? `.kickflip/build-${target}` : '.kickflip/build');

// The targets Board Settings offers: each executable `.kickflip/build-<target>` in the repo's tree at ref, sorted. run
// runs git as execFile does; git reads a local tree with no time limit
// (docs/adr/2026-11-13-2231-build-targets-wait-on-git.md). → [target], [] when the repo or ref can't be read
export async function listBuildTargets(repo, ref, { run = execFileAsync } = {}) {
  if (!repo) return [];
  let out;
  try { out = (await run('git', ['-C', repo, 'ls-tree', `${ref}:.kickflip`], { encoding: 'utf8' })).stdout; } catch { return []; }
  return out.split('\n').map((line) => /^100755 blob \S+\tbuild-(.+)$/.exec(line)?.[1]).filter(validBuildTarget).sort(collator.compare);
}
