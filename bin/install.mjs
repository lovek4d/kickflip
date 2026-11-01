import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cloneRoot as runningClone } from '../shared/repos.mjs';

export const LOGIN_LABEL = 'local.claude.kickflip-hub';
const OLD_LOGIN_LABEL = 'local.claude.web-ts-hub';

// Moves a Mac set up under the web-ts names to the kickflip ones (docs/adr/0084-kickflip-is-the-only-name.md): the
// state folder, keeping a link at its old path; a kickflip skill link beside join-web-ts; the hooks plugin link; and
// the status line through the new skill link. Each step runs only while its old shape is there, so a rerun does
// nothing. → {steps, conflicts}: lines saying what moved, or with dryRun what would, and what blocks a move.
export function migrateHome({ home = os.homedir(), skillsDir = path.join(home, '.claude', 'skills'), dryRun = false } = {}) {
  const steps = [];
  const conflicts = [];
  const lstat = (p) => fs.lstatSync(p, { throwIfNoEntry: false });
  const act = (done, planned, fn) => {
    if (dryRun) { steps.push(`would ${planned}`); return; }
    fn();
    steps.push(done);
  };

  const oldState = path.join(home, '.claude', 'web-ts');
  const state = path.join(home, '.claude', 'kickflip');
  if (lstat(oldState)?.isDirectory()) {
    if (lstat(state)) conflicts.push(`${oldState} and ${state} are both folders; merge them by hand, then leave a link at ${oldState}`);
    else act(`moved ${oldState} -> ${state}, linked from the old path`, `move ${oldState} -> ${state} and link the old path to it`, () => {
      // A rename keeps every open file and watch in the folder working; another process may have moved it first.
      try { fs.renameSync(oldState, state); } catch (e) { if (!lstat(state) || lstat(oldState)?.isDirectory()) throw e; }
      replaceWithLink(oldState, 'kickflip');
    });
  }

  const oldSkill = path.join(skillsDir, 'join-web-ts');
  const skill = path.join(skillsDir, 'kickflip');
  const oldSkillStat = lstat(oldSkill);
  if (oldSkillStat && !lstat(skill)) {
    const target = oldSkillStat.isSymbolicLink() ? path.resolve(skillsDir, fs.readlinkSync(oldSkill)) : oldSkill;
    act(`linked ${skill} -> ${target}`, `link ${skill} -> ${target}`, () => fs.symlinkSync(target, skill, 'dir'));
  }

  const oldHooks = path.join(skillsDir, 'web-ts-hooks');
  const hooks = path.join(skillsDir, 'kickflip-hooks');
  const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
  const clonePlugin = real(path.join(oldSkillStat ? oldSkill : skill, 'hooks-plugin'));
  // Two links to one plugin would load its hooks twice in every new session.
  if (lstat(oldHooks)?.isSymbolicLink() && clonePlugin && real(oldHooks) === clonePlugin) {
    const target = path.join(skill, 'hooks-plugin');
    if (!lstat(hooks)) act(`linked ${hooks} -> ${target}`, `link ${hooks} -> ${target}`, () => fs.symlinkSync(target, hooks, 'dir'));
    act(`removed ${oldHooks}`, `remove ${oldHooks}`, () => fs.unlinkSync(oldHooks));
  }

  const statusline = path.join(home, '.claude', 'statusline.sh');
  if (lstat(statusline)?.isSymbolicLink() && path.resolve(path.dirname(statusline), fs.readlinkSync(statusline)) === path.join(oldSkill, 'bin', 'statusline.mjs') && (oldSkillStat || lstat(skill))) {
    const target = path.join(skill, 'bin', 'statusline.mjs');
    act(`linked ${statusline} -> ${target}`, `link ${statusline} -> ${target}`, () => replaceWithLink(statusline, target));
  }
  return { steps, conflicts };
}

// For entry points: moves the old names before anything reads or creates state under the new ones.
export function migrateOnStart() {
  try { return migrateHome(); } catch (e) { return { steps: [], conflicts: [e.message] }; }
}

function replaceWithLink(file, target) {
  const tmp = `${file}.${process.pid}.${Date.now()}.link`;
  fs.symlinkSync(target, tmp);
  try { fs.renameSync(tmp, file); } catch (e) {
    // A process still on the old path can recreate it as an empty folder between the move and the link.
    try { fs.rmdirSync(file); fs.renameSync(tmp, file); } catch { fs.unlinkSync(tmp); throw e; }
  }
}

const launchctl = (argv) => {
  const r = spawnSync('launchctl', argv, { encoding: 'utf8' });
  return { status: r.status ?? 1, error: (r.error?.message || r.stderr || `exit ${r.status}`).trim().split('\n')[0] };
};

// Writes the hub's login item and starts it in place of the running one, including one under the old label. When the
// new one won't start, the old one is put back and started. run(argv) runs launchctl → {status, error}. → note lines.
export async function installLoginItem({ plist, launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents'), uid = process.getuid(), run = launchctl, wait = (ms) => new Promise((r) => setTimeout(r, ms)), dryRun = false }) {
  const domain = `gui/${uid}`;
  const file = path.join(launchAgentsDir, `${LOGIN_LABEL}.plist`);
  const old = path.join(launchAgentsDir, `${OLD_LOGIN_LABEL}.plist`);
  let oldPlist = null;
  try { oldPlist = fs.readFileSync(old, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const notes = [];
  if (dryRun) {
    if (oldPlist !== null) notes.push(`would stop ${domain}/${OLD_LOGIN_LABEL} and remove ${old}`);
    return [...notes, `would write ${file} and start ${domain}/${LOGIN_LABEL}`];
  }
  fs.mkdirSync(launchAgentsDir, { recursive: true });
  fs.writeFileSync(file, plist);
  if (oldPlist !== null) {
    run(['bootout', `${domain}/${OLD_LOGIN_LABEL}`]);
    fs.unlinkSync(old);
    notes.push(`stopped ${domain}/${OLD_LOGIN_LABEL} and removed ${old}`);
  }
  run(['bootout', `${domain}/${LOGIN_LABEL}`]);
  await wait(500);
  const started = run(['bootstrap', domain, file]);
  if (started.status === 0) return [...notes, `started ${domain}/${LOGIN_LABEL} from ${file}`];
  if (oldPlist === null) throw new Error(started.error);
  fs.writeFileSync(old, oldPlist);
  fs.rmSync(file, { force: true });
  const restored = run(['bootstrap', domain, old]);
  throw new Error(`${started.error}; ${restored.status === 0 ? `restarted ${domain}/${OLD_LOGIN_LABEL} from ${old}` : `could not restart ${domain}/${OLD_LOGIN_LABEL} either (${restored.error})`}`);
}

export function storedPath(realPath, { home = os.homedir(), skillsDir = path.join(home, '.claude', 'skills'), cloneRoot = runningClone() } = {}) {
  if (typeof realPath !== 'string' || !path.isAbsolute(realPath)) return realPath;
  const relative = path.relative(cloneRoot, realPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return realPath;
  // A worktree or a scratch HOME has no link to this clone; naming the link there would store a dangling path or another checkout's code.
  const link = path.resolve(skillsDir, 'kickflip');
  let linked = false;
  try { linked = fs.realpathSync(link) === fs.realpathSync(cloneRoot); } catch {}
  return linked ? path.join(link, relative) : realPath;
}

export function installLinks({ home = os.homedir(), skillsDir = path.join(home, '.claude', 'skills'), cloneRoot = runningClone(), dryRun = false } = {}) {
  const root = fs.realpathSync(cloneRoot);
  const links = [['kickflip', root], ['kickflip-hooks', path.join(root, 'hooks-plugin')]].map(([name, source]) => {
    if (!fs.statSync(source, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`not a directory: ${source}`);
    const target = name === 'kickflip' ? source : path.resolve(skillsDir, 'kickflip', 'hooks-plugin');
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
  const target = path.resolve(skillsDir, 'kickflip', 'bin', 'statusline.mjs');
  const existing = fs.lstatSync(statusline, { throwIfNoEntry: false });
  let replace = false;
  if (existing) {
    if (!existing.isSymbolicLink()) throw new Error(`refusing to replace real path ${statusline}; move it aside explicitly, then rerun install`);
    let real;
    try { real = fs.realpathSync(statusline); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    // A site's status-line prototype stands in only until kickflip's own is installed.
    const sites = path.join(home, '.claude', 'kickflip', 'sites');
    let sitesReal = sites;
    try { sitesReal = fs.realpathSync(sites); } catch {}
    const prototype = Boolean(real) && [sites, sitesReal].some((dir) => real.startsWith(dir + path.sep));
    if (real && real !== fs.realpathSync(source) && !prototype) throw new Error(`refusing to replace link ${statusline} -> ${fs.readlinkSync(statusline)}; remove that link explicitly, then rerun install`);
    replace = prototype || path.resolve(path.dirname(statusline), fs.readlinkSync(statusline)) !== target || !real;
  }
  links.push({ link: statusline, target, created: !existing, ...(replace ? { replaced: true } : {}) });
  if (dryRun) return links;
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
  let owned = target === path.resolve(skillsDir, 'kickflip', 'bin', 'statusline.mjs');
  try { owned ||= fs.realpathSync(link) === fs.realpathSync(path.join(cloneRoot, 'bin', 'statusline.mjs')); } catch {}
  if (!owned) return false;
  fs.unlinkSync(link);
  return true;
}
