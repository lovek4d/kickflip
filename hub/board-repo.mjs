import { readManifest, withManifestLock, writeManifest, isBoardSite, listBoards, appendEvent } from './boards.mjs';
import { routeRecord } from './routes.mjs';
import { repoService, validateGithub, validateBranch, runRepo, githubFromOrigin } from './repos.mjs';

export { githubFromOrigin } from './repos.mjs';

const refuse = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
export function boardRepo(route, manifest = readManifest()) {
  const site = routeRecord(manifest.sites, route);
  if (!isBoardSite(site)) refuse('Board not found.', 404);
  return { github: site.github || '', branch: site.branch || '', repo: site.owner?.repo || '' };
}

export async function changeBoardRepo(route, input, { repos = repoService(), event = appendEvent } = {}) {
  boardRepo(route);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => !['github', 'branch'].includes(k))) refuse('Send only github and branch.');
  const github = validateGithub(input.github);
  const branch = validateBranch(input.branch);
  const repo = await repos.ensure(github, branch);
  return withManifestLock(async () => {
    const manifest = readManifest();
    const previous = boardRepo(route, manifest);
    const site = routeRecord(manifest.sites, route);
    Object.assign(site, { github, branch, updated: new Date().toISOString() });
    site.owner = { ...site.owner, repo };
    await writeManifest(manifest);
    const board = listBoards(manifest).find((b) => b.route === route);
    const id = await event(board, 'repo-changed', { github, branch, repo, previous });
    return { github, branch, repo, id };
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
