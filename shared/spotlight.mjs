import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// kickflip's checkouts (board clones, builder worktrees, try checkouts) live in one folder named *.noindex, the name
// meant to keep Spotlight out of it, and each old path is a link into it, so the paths records and git store keep
// working (docs/adr/2026-11-08-1000-checkouts-live-in-a-noindex-folder.md, which records whether Spotlight honours it).
// macOS only: doctor and init skip it elsewhere.
export const CHECKOUTS = ['repos', 'worktrees', 'try'];
export const checkoutsDir = (home = os.homedir()) => path.join(home, '.claude', 'kickflip', 'checkouts.noindex');

const listed = (names) => names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

// → [{name, link, target, state, why}] for each checkout folder: ok when its old path links to its folder in
// checkouts.noindex; move when the old path is a real folder; link when there's no folder to move, so the fix makes it;
// yours, with why, when the fix can't move it.
export function checkoutFolders(home = os.homedir()) {
  const state = path.join(home, '.claude', 'kickflip');
  return CHECKOUTS.map((name) => {
    const link = path.join(state, name);
    const target = path.join(checkoutsDir(home), name);
    const at = { name, link, target };
    const stat = fs.lstatSync(link, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) {
      const to = path.resolve(state, fs.readlinkSync(link));
      if (to !== target) return { ...at, state: 'yours', why: `links to ${to}, not ${target}` };
      return { ...at, state: fs.existsSync(target) ? 'ok' : 'link' };
    }
    if (stat && !stat.isDirectory()) return { ...at, state: 'yours', why: 'is a file, not a folder' };
    if (stat && fs.lstatSync(target, { throwIfNoEntry: false })) return { ...at, state: 'yours', why: `${target} already exists` };
    return { ...at, state: stat ? 'move' : 'link' };
  });
}

// Moves each checkout folder into checkouts.noindex and links its old path there, unless runs (the live board runs, as
// lines) is not empty: a run's worktree or clone could be mid-write. → the notes saying what it did, or would with dryRun.
export function keepSpotlightOut({ home = os.homedir(), runs, dryRun = false }) {
  const folders = checkoutFolders(home);
  const notes = folders.filter((f) => f.state === 'yours').map((f) => `left ${f.link}: ${f.why}`);
  const pending = folders.filter((f) => f.state === 'move' || f.state === 'link');
  const dir = checkoutsDir(home);
  if (!pending.length) return notes;
  if (runs.length) return [...notes, `not moving ${listed(pending.map((f) => f.name))} into ${dir} while these board runs are live: ${runs.join(', ')}; kickflip doctor --fix moves them once they finish`];
  for (const f of pending) {
    if (dryRun) {
      notes.push(f.state === 'move' ? `would move ${f.link} into ${dir} and link the old path to it` : `would make ${f.target} and link ${f.link} to it`);
      continue;
    }
    fs.mkdirSync(dir, { recursive: true });
    if (f.state === 'move') fs.renameSync(f.link, f.target);
    else fs.mkdirSync(f.target);
    if (!fs.lstatSync(f.link, { throwIfNoEntry: false })) fs.symlinkSync(f.target, f.link);
    notes.push(f.state === 'move' ? `moved ${f.link} into ${dir}; the old path links to it` : `made ${f.target}; ${f.link} links to it`);
  }
  return notes;
}
