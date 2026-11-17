import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { collator } from '../shared/a-to-z.mjs';
import { BoardError } from './checks.mjs';

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

// A board's build target, board.json build_target, names its `build-<target>` script; with none the hub runs `build`
// (docs/adr/2026-11-05-1823-board-settings-picks-which-build-script-a-board-runs.md).
export const validBuildTarget = (value) => typeof value === 'string' && /^[A-Za-z0-9][\w.-]{0,63}$/.test(value);
// → the build script's name, `build` or `build-<target>`
export const buildNameOf = (target) => (target ? `build-${target}` : 'build');
// → the repo's build script relative to a worktree, `.kickflip/build` or `.kickflip/build-<target>`
export const buildScriptOf = (target) => `.kickflip/${buildNameOf(target)}`;
// The scripts a board runs: build, build-<target> and release.
export const validScriptName = (name) => name === 'build' || name === 'release' || (typeof name === 'string' && name.startsWith('build-') && validBuildTarget(name.slice(6)));

// Where a board's scripts live, board.json scripts
// (docs/adr/2026-11-17-1451-a-boards-scripts-live-in-its-repo-or-in-kickflip.md): 'kickflip' runs the board's own
// <site>/scripts/<name>, one copy for every card and main; absent, each run's worktree or checkout's .kickflip/<name>.
export const scriptsDirOf = (site) => path.join(site, 'scripts');
export const kickflipHeld = (cfg) => cfg?.scripts === 'kickflip';
// The scripts' home of the board in a site folder, from its board.json as it is now. → {dir: site, scripts: 'repo' | 'kickflip'}
export function scriptsOf(site) {
  let cfg = null;
  try { cfg = JSON.parse(fs.readFileSync(path.join(site, 'board.json'), 'utf8')); } catch {}
  return { dir: site, scripts: kickflipHeld(cfg) ? 'kickflip' : 'repo' };
}
// home: {dir: the board's site, scripts}, scriptsOf's or a listBoards entry. → the absolute file a run in dir (a
// worktree or the repo checkout) spawns for script name
export const scriptFileOf = (home, name, dir) => (home.scripts === 'kickflip' ? path.join(scriptsDirOf(home.dir), name) : path.join(dir, '.kickflip', name));
// → how the board's messages name script name: kickflip's file, else `.kickflip/<name>`
export const scriptShownOf = (home, name) => (home.scripts === 'kickflip' ? path.join(scriptsDirOf(home.dir), name) : `.kickflip/${name}`);

const checkName = (name) => {
  if (!validScriptName(name)) throw new BoardError(`no script "${name}": a board's scripts are build, build-<target> and release`);
};
// board.mjs script show: the text of the board's kickflip-held script name.
export function readScript(site, name) {
  checkName(name);
  try { return fs.readFileSync(path.join(scriptsDirOf(site), name), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') throw new BoardError(`this board has no ${name} script in kickflip; write one with script set ${name} --file <file>`); throw e; }
}
// board.mjs script set: replaces the board's kickflip-held script name with text, written mode 0700 so
// buildScriptError passes it. A save replaces the file; no earlier one is kept. → the file
export function writeScript(site, name, text) {
  checkName(name);
  if (typeof text !== 'string' || !text.trim()) throw new BoardError(`script set ${name} needs the script's text`);
  const dir = scriptsDirOf(site);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, name);
  const temp = path.join(dir, `.${name}.${process.pid}.tmp`);
  fs.writeFileSync(temp, text, { mode: 0o700 });
  fs.chmodSync(temp, 0o700);
  fs.renameSync(temp, file);
  return file;
}

// The targets Board Settings offers from the repo: each executable `.kickflip/build-<target>` in its tree at ref,
// sorted. run runs git as execFile does; git reads a local tree with no time limit
// (docs/adr/2026-11-13-2231-build-targets-wait-on-git.md). → [target], [] when the repo or ref can't be read
export async function listBuildTargets(repo, ref, { run = execFileAsync } = {}) {
  if (!repo) return [];
  let out;
  try { out = (await run('git', ['-C', repo, 'ls-tree', `${ref}:.kickflip`], { encoding: 'utf8' })).stdout; } catch { return []; }
  return out.split('\n').map((line) => /^100755 blob \S+\tbuild-(.+)$/.exec(line)?.[1]).filter(validBuildTarget).sort(collator.compare);
}

// The targets Board Settings offers from kickflip: each executable `build-<target>` in the site's scripts folder, sorted.
export function listKickflipTargets(site) {
  let names = [];
  try { names = fs.readdirSync(scriptsDirOf(site)); } catch {}
  return names.filter((name) => validScriptName(name) && name.startsWith('build-') && !buildScriptError(path.join(scriptsDirOf(site), name)))
    .map((name) => name.slice(6)).sort(collator.compare);
}
