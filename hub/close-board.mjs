import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { carryCursor, isBoardSite, listBoards, readManifest, watcherCursor, withManifestLock, writeManifest } from './boards.mjs';
import { routeRecord, validRoute } from './routes.mjs';
import { stopSession, withSessionLock } from './sessions.mjs';
import { liveSessions } from './live.mjs';
import { openBoardBuilders } from '../board/runs.mjs';
import { closeBoardBuilders } from '../board/runs.mjs';
import { itemSources, sitesDir } from '../board/files.mjs';
import { baseWorktreeOf } from '../board/prototype-base.mjs';
import { isClone } from './repos.mjs';

const refuse = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const checkRoute = (route) => { if (!validRoute(route)) refuse('Choose a board route.'); };

function boardOf(route, manifest) {
  checkRoute(route);
  const board = listBoards(manifest).find((b) => b.route === route);
  if (!board) refuse('That board is not open.', 404);
  return board;
}

export async function boardClosure(route, manifest = readManifest()) {
  const board = boardOf(route, manifest);
  return { route, title: board.title, prs: board.prs, builders: await openBoardBuilders(board.dir) };
}

export function closedBoards(manifest = readManifest()) {
  return Object.entries(manifest.closed || {}).filter(([, entry]) => isBoardSite(entry?.site))
    .map(([route, entry]) => ({ route, title: entry.title || entry.site.title || route, closedAt: entry.closed_at, dir: entry.site.dir, repo: entry.site.owner?.repo || '' }));
}

export async function closeBoard(route, name, { live, stop } = {}) {
  checkRoute(route);
  return withSessionLock(route, () => withManifestLock(async () => {
    const manifest = readManifest();
    const board = boardOf(route, manifest);
    const site = routeRecord(manifest.sites, route);
    if (name !== board.title) refuse('Type the board’s name exactly to close it.');
    if (routeRecord(manifest.closed, route)) refuse('That route already has a closed board.', 409);
    const shared = site.owner?.session && listBoards(manifest).filter((other) => other.route !== route && other.owner?.session === site.owner.session);
    if (shared?.length) refuse(`This session is also recorded by ${shared.map((other) => `${other.title} (/${other.route})`).join(', ')}; close refused.`, 409);
    const cursor = watcherCursor(board);
    await stopSession(site.owner, { live, stop });
    const builders = await closeBoardBuilders(board.dir);
    manifest.closed = { ...manifest.closed, [route]: { site, title: board.title, cursor, closed_at: new Date().toISOString() } };
    delete manifest.sites[route];
    await writeManifest(manifest);
    return { route, filesKept: site.dir, buildersClosed: builders.length, next: '/_hub/' };
  }));
}

export async function reopenBoard(route, { run, tmux, live } = {}) {
  checkRoute(route);
  return withSessionLock(route, async ({ resume }) => {
    const saved = await withManifestLock(async () => {
      const manifest = readManifest();
      const entry = routeRecord(manifest.closed, route);
      if (!isBoardSite(entry?.site)) refuse('That board is not closed.', 404);
      if (routeRecord(manifest.sites, route) || routeRecord(manifest.starting, route)) refuse('That route is already in use.', 409);
      if (Object.values(manifest.sites || {}).some((site) => site.port === entry.site.port)) refuse('The board’s recorded port is in use by another site.', 409);
      if (!fs.statSync(entry.site.dir, { throwIfNoEntry: false })?.isDirectory()) refuse('The board’s folder is missing.', 409);
      if (!entry.site.owner?.session || !entry.site.owner.repo) refuse('The board has no recorded session and folder to resume.', 409);
      manifest.sites ||= {};
      manifest.sites[route] = entry.site;
      if (entry.cursor) carryCursor(boardOf(route, manifest), { from: entry.site.owner.session, mark: entry.cursor });
      delete manifest.closed[route];
      if (!Object.keys(manifest.closed).length) delete manifest.closed;
      await writeManifest(manifest);
      return entry;
    });
    try {
      const session = await resume({ run, tmux, live, mark: saved.cursor });
      return { route, session: session.session };
    } catch (error) {
      const current = routeRecord(readManifest().sites, route);
      if (error.reason === 'live' && current?.owner?.session && (live || liveSessions)()?.has(current.owner.session)) return { route, session: current.owner.session };
      await withManifestLock(async () => {
        const manifest = readManifest();
        if (JSON.stringify(routeRecord(manifest.sites, route)) !== JSON.stringify(saved.site)) return;
        delete manifest.sites[route];
        manifest.closed = { ...manifest.closed, [route]: saved };
        await writeManifest(manifest);
      });
      throw error;
    }
  });
}

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim().split('\n')[0] };
};
const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };

// The worktrees git lists for repo, each {path: its real path, branch: the branch checked out, or null when detached}.
function worktreesOf(repo) {
  return git(repo, 'worktree', 'list', '--porcelain').out.split('\n\n').map((entry) => {
    const lines = entry.split('\n');
    const at = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
    const branch = lines.find((l) => l.startsWith('branch refs/heads/'))?.slice('branch refs/heads/'.length) ?? null;
    return { path: at && real(at), branch };
  }).filter((w) => w.path);
}

// What deleting the closed board at entry removes: each worktree its builder records name that git still lists on the
// record's branch, with that branch, and the prototype base worktree, each {repo, path, branch, base}; and the branches
// of records whose worktree is already gone, {repo, branch}. A path another board's build has since taken (on another
// branch) is not this board's.
async function boardWork(route, entry) {
  const records = [];
  for (const source of await itemSources(entry.site.dir)) {
    if (!source.dir.startsWith(entry.site.dir + path.sep)) continue;
    const dir = path.join(source.dir, 'agents');
    for (const name of (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []).filter((d) => d.isFile() && d.name.endsWith('.json')).map((d) => d.name)) {
      try { records.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')).worktree); } catch {}
    }
  }
  const trees = new Map();
  const branches = new Map();
  const listed = new Map();
  const listOf = (repo) => { if (!listed.has(repo)) listed.set(repo, real(repo) ? worktreesOf(repo) : []); return listed.get(repo); };
  for (const wt of records.filter((w) => w?.repo && w.branch)) {
    const at = real(wt.path);
    if (at && listOf(wt.repo).some((w) => w.path === at && w.branch === wt.branch)) trees.set(at, { repo: wt.repo, path: at, branch: wt.branch, base: false });
    else if (real(wt.repo) && git(wt.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${wt.branch}`).ok) branches.set(`${wt.repo}\0${wt.branch}`, { repo: wt.repo, branch: wt.branch });
  }
  const repo = entry.site.owner?.repo;
  const base = real(baseWorktreeOf(route));
  if (repo && base && listOf(repo).some((w) => w.path === base)) trees.set(base, { repo, path: base, branch: null, base: true });
  return { trees: [...trees.values()], branches: [...branches.values()] };
}

// docs/adr/2026-11-18-2300-a-closed-board-can-be-deleted.md
// Deletes the closed board at route for good: its builder worktrees and their local branches, its prototype base
// worktree, its site folder, its shared clone under the clone home when no other open, closed or starting board records
// it, and last its closed entry, so a delete that fails part way can be run again. It refuses, changing nothing, while a
// builder worktree holds uncommitted work or a builder branch holds commits on neither base nor a remote branch, naming
// each, and for a site folder outside the hub's sites folder. The owner's
// own repo, and GitHub, are never touched.
export async function deleteClosedBoard(route) {
  checkRoute(route);
  return withSessionLock(route, () => withManifestLock(async () => {
    const manifest = readManifest();
    const entry = routeRecord(manifest.closed, route);
    if (!isBoardSite(entry?.site)) refuse('That board is not closed.', 404);
    const dir = path.resolve(entry.site.dir);
    if (path.dirname(dir) !== path.resolve(sitesDir())) refuse(`Its folder ${dir} is outside the hub’s sites folder; delete refused.`, 409);
    const { trees, branches } = await boardWork(route, entry);
    // Builders never push, so commits on a builder branch that are on neither the base branch nor any remote branch
    // exist nowhere else: they refuse the delete as uncommitted work does.
    const base = entry.site.branch || 'main';
    const unlanded = [...trees.filter((t) => t.branch), ...branches].map((b) => {
      const local = git(b.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${base}`).ok ? [`refs/heads/${base}`] : [];
      return { ...b, count: Number(git(b.repo, 'rev-list', '--count', `refs/heads/${b.branch}`, '--not', '--remotes', ...local).out) };
    }).filter((b) => b.count);
    const dirty = trees.filter((t) => !t.base && git(t.path, 'status', '--porcelain').out);
    const faults = [...dirty.map((t) => `${t.path} holds uncommitted work`), ...unlanded.map((b) => `${b.branch} has ${b.count} commit${b.count === 1 ? '' : 's'} not on ${base}`)];
    if (faults.length) refuse(`${faults.join('; ')}. Land, push or remove it, then delete again.`, 409);
    const run = (cwd, ...args) => { const r = git(cwd, ...args); if (!r.ok) refuse(`git ${args.join(' ')} failed: ${r.err}`, 500); };
    // --force takes ignored files (node_modules and the like), and the prototype base's untracked pages.
    for (const t of trees) {
      run(t.repo, 'worktree', 'remove', '--force', t.path);
      if (t.branch) run(t.repo, 'branch', '--quiet', '-D', t.branch);
    }
    for (const b of branches) run(b.repo, 'branch', '--quiet', '-D', b.branch);
    await fs.promises.rm(dir, { recursive: true, force: true });
    const clone = entry.site.owner?.repo;
    const others = [...Object.entries(manifest.sites || {}), ...Object.entries(manifest.closed || {}).map(([r, e]) => [r, e?.site]), ...Object.entries(manifest.starting || {}).map(([r, s]) => [r, { owner: { repo: s?.repo } }])]
      .filter(([other]) => other !== route).map(([, site]) => site?.owner?.repo && real(site.owner.repo)).filter(Boolean);
    const cloneRemoved = Boolean(clone && isClone(clone) && !others.includes(real(clone)));
    if (cloneRemoved) await fs.promises.rm(clone, { recursive: true, force: true });
    delete manifest.closed[route];
    if (!Object.keys(manifest.closed).length) delete manifest.closed;
    await writeManifest(manifest);
    return { route, worktreesRemoved: trees.length, cloneRemoved };
  }));
}
