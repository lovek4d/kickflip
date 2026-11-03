import { readManifest, withManifestLock, writeManifest, isBoardSite, listBoards, appendEvent, hubGithub, buildsLocally } from './boards.mjs';
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
  // `local` (boards.mjs buildsLocally): builders branch from the repo's local main. The hub board's repo is the running
  // kickflip clone; any other board's is its session's folder.
  if (site.hub === true) return { hub: true, local: true, github: hubGithub(), branch: '', repo: storedPath(cloneRoot()) };
  const local = buildsLocally(site);
  return { github: site.github || '', ...(site.remote ? { remote: site.remote } : {}), branch: site.branch || '', repo: storedPath(site.owner?.repo || ''), ...(local ? { local: true } : {}) };
}

function changeable(route, manifest) {
  const current = boardRepo(route, manifest);
  if (current.hub) refuse('The hub board works on kickflip’s own clone, so its repo can’t change.', 409);
  return current;
}

export async function changeBoardRepo(route, input, { repos = repoService(), event = appendEvent } = {}) {
  changeable(route);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => !['github', 'remote', 'branch'].includes(k))) refuse('Send only github or remote, and branch.');
  const { github = '', remote } = repoInput(input);
  const branch = validateBranch(input.branch);
  const dir = routeRecord(readManifest().sites, route).dir;
  if (remote && (await boardConfig(dir)).tickets?.source === 'github') refuse('This board files its cards as GitHub issues. Switch Tickets to Internal or Linear first.', 409);
  const repo = storedPath(await repos.ensure(github || remote, branch));
  return withManifestLock(async () => {
    const manifest = readManifest();
    const previous = changeable(route, manifest);
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
      // The hub board's builders work on the kickflip clone, not on its session's folder.
      if (!isBoardSite(site) || site.github || site.hub) continue;
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
