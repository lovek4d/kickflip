import { readManifest, withManifestLock, writeManifest, isBoardSite, listBoards, appendEvent, buildsLocally } from './boards.mjs';
import { routeRecord } from './routes.mjs';
import { repoService, validateBranch, runRepo, githubFromOrigin } from './repos.mjs';
import { repoInput } from './new-board.mjs';
import { boardConfig } from '../board/store.mjs';
import { storedPath } from '../bin/install.mjs';
import { cloneRoot } from '../shared/repos.mjs';

export { githubFromOrigin } from './repos.mjs';

const refuse = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
export function boardRepo(route, manifest = readManifest()) {
  const site = routeRecord(manifest.sites, route);
  if (!isBoardSite(site)) refuse('Board not found.', 404);
  // `local` (boards.mjs buildsLocally): builders branch from the repo's local main. A board's repo is its session's
  // folder, the hub board's too.
  const local = buildsLocally(site);
  return { github: site.github || '', ...(site.remote ? { remote: site.remote } : {}), branch: site.branch || '', repo: storedPath(site.owner?.repo || ''), ...(local ? { local: true } : {}) };
}

export async function changeBoardRepo(route, input, { repos = repoService(), event = appendEvent } = {}) {
  boardRepo(route);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => !['github', 'remote', 'branch'].includes(k))) refuse('Send only github or remote, and branch.');
  const { github = '', remote } = repoInput(input);
  const branch = validateBranch(input.branch);
  const dir = routeRecord(readManifest().sites, route).dir;
  if (remote && (await boardConfig(dir)).tickets?.source === 'github') refuse('This board files its cards as GitHub issues. Switch Tickets to Internal or Linear first.', 409);
  const repo = storedPath(await repos.ensure(github || remote, branch));
  return withManifestLock(async () => {
    const manifest = readManifest();
    const previous = boardRepo(route, manifest);
    const site = routeRecord(manifest.sites, route);
    Object.assign(site, { github, remote, branch, updated: new Date().toISOString() });
    delete site.local;
    if (!github) delete site.github;
    if (!remote) delete site.remote;
    site.owner = { ...site.owner, repo };
    await writeManifest(manifest);
    const board = listBoards(manifest).find((b) => b.route === route);
    const now = { github, ...(remote ? { remote } : {}), branch, repo };
    const id = await event(board, 'repo-changed', { ...now, previous });
    return { ...now, id };
  });
}

// The remote's default branch first: the folder may have a feature branch checked out.
async function defaultBranch(run, cwd) {
  const remote = await run('git', ['-C', cwd, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const head = await run('git', ['-C', cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
  for (const branch of [remote.status === 0 && remote.stdout.trim().replace(/^origin\//, ''), head.status === 0 && head.stdout.trim()]) {
    try { if (branch) return validateBranch(branch); } catch {}
  }
  return '';
}

export async function migrateBoardRepos({ run = runRepo } = {}) {
  return withManifestLock(async () => {
    const manifest = readManifest();
    const done = Array.isArray(manifest.migrated) ? manifest.migrated : [];
    if (done.includes('board-github') || !Object.keys(manifest.sites || {}).length) return [];
    const changed = [];
    for (const [route, site] of Object.entries(manifest.sites || {})) {
      if (!isBoardSite(site) || site.github) continue;
      const cwd = site.owner?.repo || site.dir;
      const origin = await run('git', ['-C', cwd, 'remote', 'get-url', 'origin']);
      const github = origin.status === 0 ? githubFromOrigin(origin.stdout) : null;
      if (!github) continue;
      site.github = github;
      const branch = site.branch || await defaultBranch(run, cwd);
      if (branch) site.branch = branch;
      changed.push(route);
    }
    manifest.migrated = [...done, 'board-github'];
    await writeManifest(manifest);
    return changed;
  });
}

// The hub board once built on the running kickflip clone, with its GitHub repo read from the clone's origin. Run by the
// hub as it starts, once (the manifest's `migrated` list records it): a hub board with no `local` mark becomes a local
// board of its session's folder, else of the running clone, recording that folder's GitHub origin and branch, as
// `kickflip join` records them (docs/adr/0147-boards-run-in-the-background-and-the-hub-board-in-tmux.md). → the route
// changed, or null
export async function migrateHubBoard({ run = runRepo, clone = cloneRoot() } = {}) {
  return withManifestLock(async () => {
    const manifest = readManifest();
    const done = Array.isArray(manifest.migrated) ? manifest.migrated : [];
    if (done.includes('hub-local') || !Object.keys(manifest.sites || {}).length) return null;
    const found = Object.entries(manifest.sites || {}).find(([, s]) => s?.hub === true && isBoardSite(s) && s.local !== true);
    if (found) {
      const [, site] = found;
      const folder = site.owner?.repo || storedPath(clone);
      const origin = await run('git', ['-C', folder, 'remote', 'get-url', 'origin']);
      const github = site.github || (origin.status === 0 ? githubFromOrigin(origin.stdout) : null);
      const head = await run('git', ['-C', folder, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
      Object.assign(site, { local: true, ...(github ? { github } : {}), ...(!site.branch && head.status === 0 && head.stdout.trim() ? { branch: head.stdout.trim() } : {}), owner: { ...site.owner, repo: folder } });
    }
    manifest.migrated = [...done, 'hub-local'];
    await writeManifest(manifest);
    return found ? found[0] : null;
  });
}
