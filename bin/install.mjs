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
  const source = path.join(root, 'bin', 'statusline.mjs');
  if (!fs.statSync(source, { throwIfNoEntry: false })?.isFile()) throw new Error(`not a file: ${source}`);
  const statusline = path.join(home, '.claude', 'statusline.sh');
  const target = path.resolve(skillsDir, 'join-web-ts', 'bin', 'statusline.mjs');
  const existing = fs.lstatSync(statusline, { throwIfNoEntry: false });
  let replace = false;
  if (existing) {
    if (!existing.isSymbolicLink()) throw new Error(`refusing to replace real path ${statusline}; move it aside explicitly, then rerun install`);
    let real;
    try { real = fs.realpathSync(statusline); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    // A site's status-line prototype stands in only until kickflip's own is installed.
    const sites = path.join(home, '.claude', 'web-ts', 'sites');
    let sitesReal = sites;
    try { sitesReal = fs.realpathSync(sites); } catch {}
    const prototype = Boolean(real) && [sites, sitesReal].some((dir) => real.startsWith(dir + path.sep));
    if (real && real !== fs.realpathSync(source) && !prototype) throw new Error(`refusing to replace link ${statusline} -> ${fs.readlinkSync(statusline)}; remove that link explicitly, then rerun install`);
    replace = prototype || path.resolve(path.dirname(statusline), fs.readlinkSync(statusline)) !== target || !real;
  }
  links.push({ link: statusline, target, created: !existing, ...(replace ? { replaced: true } : {}) });
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(path.dirname(statusline), { recursive: true });
  for (const { link, target, created, replaced } of links) {
    if (replaced) fs.unlinkSync(link);
    if (created || replaced) fs.symlinkSync(target, link, link === statusline ? 'file' : 'dir');
  }
  return links;
}

export function installClaudeSettings({ home = os.homedir() } = {}) {
  const file = path.join(home, '.claude', 'settings.json');
  let settings = {};
  let mode = 0o600;
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    mode = fs.statSync(file).mode;
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error(`not a settings object: ${file}`);
  const notes = [];
  let changed = false;
  const command = path.join(home, '.claude', 'statusline.sh');
  if (!Object.hasOwn(settings, 'statusLine')) {
    // statusLine.command runs in a shell; quote homes containing shell metacharacters.
    const shellCommand = /^[\w/.-]+$/.test(command) ? command : `'${command.replaceAll("'", "'\\''")}'`;
    settings.statusLine = { type: 'command', command: shellCommand };
    changed = true;
    notes.push(`set statusLine in ${file} -> ${shellCommand}`);
  } else {
    const current = settings.statusLine?.command;
    const ownCommands = [command, `"${command}"`, `'${command.replaceAll("'", "'\\''")}'`, '~/.claude/statusline.sh', '$HOME/.claude/statusline.sh', '"$HOME/.claude/statusline.sh"', '${HOME}/.claude/statusline.sh', '"${HOME}/.claude/statusline.sh"'];
    if (settings.statusLine?.type !== 'command' || !ownCommands.includes(current)) notes.push(`kept existing statusLine in ${file}; it points elsewhere`);
  }
  const missing = path.join(home, '.claude', 'hooks', 'no-paths.py');
  if (!fs.existsSync(missing) && settings.hooks && typeof settings.hooks === 'object') {
    const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const scripts = [missing, '~/.claude/hooks/no-paths.py', '$HOME/.claude/hooks/no-paths.py', '${HOME}/.claude/hooks/no-paths.py'].map(escape).join('|');
    // Match an executed script (directly or through Python), not a path mentioned in echo or an argument to another hook.
    const stale = new RegExp(`^\\s*(?:exec\\s+)?(?:(?:/usr/bin/env\\s+)?(?:[^\\s]+/)?python(?:\\d+(?:\\.\\d+)*)?(?:\\s+-[^\\s]+)*\\s+)?(?:"(?:${scripts})"|'(?:${scripts})'|(?:${scripts}))(?=$|\\s)`);
    for (const [event, groups] of Object.entries(settings.hooks)) {
      if (!Array.isArray(groups)) continue;
      settings.hooks[event] = groups.flatMap((group) => {
        if (!Array.isArray(group?.hooks)) return [group];
        const hooks = group.hooks.filter((hook) => {
          if (hook?.type !== 'command' || typeof hook.command !== 'string' || !stale.test(hook.command)) return true;
          notes.push(`removed stale hook ${event}: ${hook.command}`);
          changed = true;
          return false;
        });
        if (hooks.length === group.hooks.length) return [group];
        return hooks.length ? [{ ...group, hooks }] : [];
      });
    }
  }
  if (changed) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { mode, flag: 'wx' });
      fs.renameSync(tmp, file);
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }
  return notes;
}

export function uninstallStatusLine({ home = os.homedir(), skillsDir = path.join(home, '.claude', 'skills'), cloneRoot = runningClone() } = {}) {
  const link = path.join(home, '.claude', 'statusline.sh');
  if (!fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) return false;
  const target = path.resolve(path.dirname(link), fs.readlinkSync(link));
  let owned = target === path.resolve(skillsDir, 'join-web-ts', 'bin', 'statusline.mjs');
  try { owned ||= fs.realpathSync(link) === fs.realpathSync(path.join(cloneRoot, 'bin', 'statusline.mjs')); } catch {}
  if (!owned) return false;
  fs.unlinkSync(link);
  return true;
}
