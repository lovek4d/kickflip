// docs/adr/2026-11-06-1500-a-prototype-round-is-a-page-in-the-boards-base-worktree.md
// A board's base prototype worktree: one checkout of its repo's main where each prototype round adds a page built from
// the repo's real components fed mock data. The hub serves it with the board's build script (hub/try.mjs, key
// BASE_KEY) while an open question links a served round, and the render check runs that script itself.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { boardAt } from '../hub/boards.mjs';
import { boardRepo, mainRefOf } from '../hub/board-repo.mjs';
import { buildScriptOf } from './build-script.mjs';
import { BoardError } from './store.mjs';

const execFileAsync = promisify(execFile);
const git = async (dir, ...args) => (await execFileAsync('git', ['-C', dir, ...args], { encoding: 'utf8', timeout: 60_000 })).stdout.trim();

// The try key the hub serves the base worktree under; card keys are <file>/<id>, so it never names a card.
export const BASE_KEY = 'prototypes';
export const baseWorktreeOf = (route) => path.join(os.homedir(), '.claude', 'kickflip', 'worktrees', `${route}-prototypes`);
// The listener a round's page loads: KickflipPrototype.on((take, state) => …).
export const FRAME_SCRIPT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'shared', 'prototype-frame.js');

// Makes the worktree, detached at ref, or moves it there with a plain checkout, which keeps the rounds' pages; when a
// page's edit to a tracked file blocks the move, it stays where it is.
// → {dir, sha, made: bool, blocked: [file] | null}
export async function ensureBase({ repo, ref, dir }) {
  const target = await git(repo, 'rev-parse', '--verify', `${ref}^{commit}`);
  if (!fs.existsSync(dir)) {
    await git(repo, 'worktree', 'prune');
    await git(repo, 'worktree', 'add', '--quiet', '--detach', dir, target);
    return { dir, sha: target, made: true, blocked: null };
  }
  try {
    await git(dir, 'checkout', '--quiet', '--detach', target);
    return { dir, sha: target, made: false, blocked: null };
  } catch (e) {
    const blocked = [...String(e.stderr || '').matchAll(/^\t(.+)$/gm)].map((m) => m[1].trim());
    if (!blocked.length) throw e;
    return { dir, sha: await git(dir, 'rev-parse', 'HEAD'), made: false, blocked };
  }
}

// board.mjs prototype base: the board's base worktree on its main, whether its build script is there, and the listener.
export async function prototypeBase(site) {
  const board = boardAt(site);
  if (!board) throw new BoardError(`${site} is not a board in the hub's manifest, so it has no repo to prototype in`);
  const source = boardRepo(board.route);
  const branch = source.branch || 'main';
  const base = await ensureBase({ repo: source.repo, ref: mainRefOf(source), dir: baseWorktreeOf(board.route) });
  const how = base.made ? `made from ${branch}` : base.blocked ? `kept: its pages' edits to ${base.blocked.join(', ')} block the move to ${branch}` : `moved to ${branch}`;
  const script = buildScriptOf(board.build_target);
  const present = fs.existsSync(path.join(base.dir, script));
  return { lines: [
    `base ${base.dir} at ${base.sha.slice(0, 7)}, ${how}`,
    present ? `build script ${script} is there` : `build script ${script} is missing: write one that serves the app and prints "port <n>"`,
    `listener ${FRAME_SCRIPT}`,
  ] };
}
