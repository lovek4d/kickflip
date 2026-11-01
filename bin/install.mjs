import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cloneRoot as runningClone } from '../shared/repos.mjs';

export function storedPath(realPath, { home = os.homedir(), skillsDir = path.join(home, '.claude', 'skills'), cloneRoot = runningClone() } = {}) {
  if (typeof realPath !== 'string' || !path.isAbsolute(realPath)) return realPath;
  const relative = path.relative(cloneRoot, realPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return realPath;
  // A worktree or a scratch HOME has no link to this clone; naming the link there would store a dangling path or another checkout's code.
  const link = path.resolve(skillsDir, 'join-web-ts');
  let linked = false;
  try { linked = fs.realpathSync(link) === fs.realpathSync(cloneRoot); } catch {}
  return linked ? path.join(link, relative) : realPath;
}

export function installLinks({ home = os.homedir(), skillsDir = path.join(home, '.claude', 'skills'), cloneRoot = runningClone() } = {}) {
  const root = fs.realpathSync(cloneRoot);
  const links = [['join-web-ts', root], ['web-ts-hooks', path.join(root, 'hooks-plugin')]].map(([name, source]) => {
    if (!fs.statSync(source, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`not a directory: ${source}`);
    const target = name === 'join-web-ts' ? source : path.resolve(skillsDir, 'join-web-ts', 'hooks-plugin');
    const link = path.resolve(skillsDir, name);
    const existing = fs.lstatSync(link, { throwIfNoEntry: false });
    if (existing) {
      let real;
      try { real = fs.realpathSync(link); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (existing.isSymbolicLink()) {
        if (real !== fs.realpathSync(source)) throw new Error(`refusing to replace link ${link} -> ${fs.readlinkSync(link)}; remove that link explicitly, then rerun install`);
      } else if (!existing.isDirectory() || real !== fs.realpathSync(source)) {
        throw new Error(`refusing to replace real path ${link}; move it aside explicitly, then rerun install`);
      }
    }
    return { link, target, created: !existing };
  });
  fs.mkdirSync(skillsDir, { recursive: true });
  for (const { link, target, created } of links) {
    if (created) fs.symlinkSync(target, link, 'dir');
  }
  return links;
}
