// A folder on this Mac as a New board's repo, worked in place with no clone
// (docs/adr/2026-11-18-0724-a-new-board-can-anchor-on-a-folder-on-this-mac.md).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runRepo, githubFromOrigin, remoteFromInput, defaultBranch, validateBranch, repoName } from './repos.mjs';
import { routeRecord } from './routes.mjs';
import { storedPath } from '../bin/install.mjs';

const refuse = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

// ~/x as the page shows a folder under home.
export const shownFolder = (dir, home = os.homedir()) => (dir === home ? '~' : dir.startsWith(home + path.sep) ? `~${dir.slice(home.length)}` : dir);

// The folder a typed path names, ~ for home: a real directory inside home, not home itself, not in ~/.claude, reached
// through no symlink. → its absolute path
export function folderPath(input, home = os.homedir()) {
  if (typeof input !== 'string' || !input.trim() || input.length > 1000) refuse('Type a folder’s path, such as ~/dev/notes.');
  const text = input.trim();
  const realHome = fs.realpathSync(home);
  const typed = text === '~' ? realHome : text.startsWith('~/') ? path.join(realHome, text.slice(2)) : path.isAbsolute(text) ? path.resolve(text) : null;
  if (!typed) refuse('Start the path with ~/ or /.');
  const dir = typed.startsWith(home + path.sep) ? path.join(realHome, path.relative(home, typed)) : typed;
  if (dir === realHome) refuse('That’s your whole home folder. Pick a folder inside it.');
  if (!dir.startsWith(realHome + path.sep)) refuse('Pick a folder inside your home folder.');
  if (dir === path.join(realHome, '.claude') || dir.startsWith(path.join(realHome, '.claude') + path.sep)) refuse('Inside ~/.claude. That folder is Claude’s own.');
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) refuse('No folder there.', 404);
  if (stat.isSymbolicLink()) refuse('That’s a symlink. Pick the folder it points to.');
  if (!stat.isDirectory()) refuse('That’s a file, not a folder.');
  if (fs.realpathSync(dir) !== dir) refuse('That path goes through a symlink. Pick the folder it points to.');
  return dir;
}

// The route of the board, open, starting or closed, whose repo is dir, else null.
export function boardOnFolder(dir, manifest) {
  const same = (repo) => typeof repo === 'string' && storedPath(path.resolve(repo)) === storedPath(dir);
  for (const [route, site] of Object.entries(manifest.sites || {})) if (same(site?.owner?.repo)) return route;
  for (const [route, rec] of Object.entries(manifest.starting || {})) if (same(rec?.repo) && !routeRecord(manifest.sites, route)) return route;
  for (const [route, rec] of Object.entries(manifest.closed || {})) if (same(rec?.site?.owner?.repo)) return route;
  return null;
}

const out = async (run, cwd, ...argv) => { const r = await run('git', ['-C', cwd, ...argv]); return r.status === 0 ? r.stdout.trim() : null; };

// What New board finds at a typed folder (folderPath's refusals, and a folder that is already a board's repo, inside
// another repo, or a repo with no commits). → {folder, path, git, github?, remote?, branch, branches}: github when
// origin is on GitHub, remote when it is another git host; branch the folder's default (repos.mjs defaultBranch), or
// main for a folder git init will make a repo, which then has only main.
export async function folderInfo(input, { manifest = {}, home = os.homedir(), run = runRepo } = {}) {
  const dir = folderPath(input, home);
  const board = boardOnFolder(dir, manifest);
  if (board) refuse(`Already /${board}’s repo.`, 409);
  const top = await out(run, dir, 'rev-parse', '--show-toplevel');
  const shown = { folder: shownFolder(dir, fs.realpathSync(home)), path: dir };
  if (top === null) return { ...shown, git: false, branch: 'main', branches: ['main'] };
  if (fs.realpathSync(path.resolve(top)) !== dir) refuse(`Inside the git repo ${shownFolder(fs.realpathSync(path.resolve(top)), fs.realpathSync(home))}. Pick that folder.`);
  const branches = ((await out(run, dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')) || '').split('\n').filter((b) => { try { return validateBranch(b); } catch { return false; } });
  if (!branches.length) refuse('A git repo with no commits yet. Commit something first.');
  const found = await defaultBranch(dir, run);
  const branch = branches.includes(found) ? found : branches[0];
  const origin = await out(run, dir, 'remote', 'get-url', 'origin');
  const github = origin && githubFromOrigin(origin);
  const remote = origin && !github ? remoteFromInput(origin)?.remote : null;
  return { ...shown, git: true, ...(github ? { github } : remote ? { remote } : {}), branch, branches: [branch, ...branches.filter((b) => b !== branch)] };
}

// Makes dir a git repo on main and commits what's there, its .gitignore honoured, as "Initial commit". A failed commit
// removes the .git it made, so the folder is as it was.
export async function makeRepo(dir, run = runRepo) {
  const git = async (...argv) => {
    const r = await run('git', ['-C', dir, ...argv]);
    if (r.status !== 0) refuse(`git ${argv[0]} failed: ${(r.stderr || r.stdout).trim().split('\n').at(-1) || `exit ${r.status}`}`, 502);
  };
  await git('init', '--quiet', '-b', 'main');
  try {
    await git('add', '--all');
    await git('commit', '--quiet', '--allow-empty', '-m', 'Initial commit');
  } catch (e) { fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true }); throw e; }
}

// Folders under home for a path as it is typed: the subfolders of the folder it names so far whose names start with
// what follows its last slash, hidden ones only once that starts with a dot, never ~/.claude or a symlink, A–Z, at most
// limit. → ~/ paths
export function folderSuggestions(input, { home = os.homedir(), limit = 12 } = {}) {
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text.startsWith('~/') && !text.startsWith('/')) return [];
  const realHome = fs.realpathSync(home);
  const slash = text.lastIndexOf('/');
  const parent = text.slice(0, slash + 1);
  const start = text.slice(slash + 1).toLowerCase();
  let dir;
  try { dir = parent === '~/' ? realHome : folderPath(parent, home); } catch { return []; }
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory() && (start.startsWith('.') || !e.name.startsWith('.')) && e.name.toLowerCase().startsWith(start) && !(dir === realHome && e.name === '.claude'))
    .map((e) => e.name).sort((a, b) => a.localeCompare(b)).slice(0, limit)
    .map((name) => shownFolder(path.join(dir, name), realHome));
}

// docs/adr/2026-11-21-2300-new-board-and-new-course-share-one-source-field.md
// A typed folder a New course reads: any folder folderPath allows, a board's repo or a folder inside a repo too, since a
// course only reads it. → {folder, path, git}: git when the folder is in a git repo
export function readableFolder(input, home = os.homedir()) {
  const dir = folderPath(input, home);
  let inRepo = false;
  for (let at = dir; at !== path.dirname(at) && !inRepo; at = path.dirname(at)) inRepo = fs.existsSync(path.join(at, '.git'));
  return { folder: shownFolder(dir, fs.realpathSync(home)), path: dir, git: inRepo };
}

// The sources the New sheet's one field suggests besides the owner's GitHub repos: the other git remotes and the folders
// on this Mac that the hub's boards (open, starting, then closed) and starting courses use, each once in that order, by
// the titles of who uses it. A folder that is a board's repo names that board's route.
// → {remotes: [{remote, name, by}], folders: [{folder, path, by, board?}]}
export function recentSources(manifest, home = os.homedir()) {
  const remotes = new Map(), folders = new Map();
  const add = (map, key, entry, title) => { const seen = map.get(key); if (seen) seen.by.push(title); else map.set(key, { ...entry, by: [title] }); };
  const records = [
    ...Object.entries(manifest.sites || {}).map(([route, s]) => [route, s, s.local ? s.owner?.repo : null]),
    ...Object.entries(manifest.starting || {}).filter(([route]) => !routeRecord(manifest.sites, route)).map(([route, rec]) => [route, rec, rec.folder ? rec.repo : null]),
    ...Object.entries(manifest.closed || {}).map(([route, rec]) => [route, rec.site || {}, rec.site?.local ? rec.site.owner?.repo : null]),
  ];
  for (const [route, rec, boardFolder] of records) {
    const title = rec.title || route;
    const remote = rec.remote || rec.source?.remote;
    if (remote) add(remotes, repoName(remote), { remote, name: repoName(remote) }, title);
    const dir = boardFolder || rec.source?.folder;
    if (typeof dir === 'string') add(folders, dir, { folder: shownFolder(dir, home), path: dir, ...(boardFolder ? { board: route } : {}) }, title);
  }
  return { remotes: [...remotes.values()], folders: [...folders.values()] };
}
