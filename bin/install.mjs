import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cloneRoot as runningClone } from '../shared/repos.mjs';

export function installLinks({ home = os.homedir(), skillsDir = path.join(home, '.claude', 'skills'), cloneRoot = runningClone() } = {}) {
  const root = fs.realpathSync(cloneRoot);
  const links = [['join-web-ts', root], ['web-ts-hooks', path.join(root, 'hooks-plugin')]].map(([name, target]) => {
    if (!fs.statSync(target, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`not a directory: ${target}`);
    const link = path.resolve(skillsDir, name);
    const existing = fs.lstatSync(link, { throwIfNoEntry: false });
    if (existing) {
      let real;
      try { real = fs.realpathSync(link); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (existing.isSymbolicLink()) {
        if (real !== fs.realpathSync(target)) throw new Error(`refusing to replace link ${link} -> ${fs.readlinkSync(link)}; remove that link explicitly, then rerun install`);
      } else if (!existing.isDirectory() || real !== fs.realpathSync(target)) {
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
