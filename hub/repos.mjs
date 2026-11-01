import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { reposDir } from '../shared/repos.mjs';
import { withFileLock } from './locks.mjs';
import { storedPath } from '../bin/install.mjs';

const refuse = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
export function validateGithub(github) {
  if (typeof github !== 'string' || github.length > 140 || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?\/[a-z\d_.-]{1,100}$/i.test(github) || ['.', '..', '.git'].includes(github.split('/')[1].toLowerCase())) refuse('Repo must be owner/name on GitHub.');
  return github;
}
export function validateBranch(branch) {
  if (typeof branch !== 'string' || !branch || branch.length > 255 || branch === '@' || branch.startsWith('-')
    || /[\s\x00-\x1f\x7f~^:?*\[\\]/.test(branch) || branch.includes('..') || branch.includes('@{')
    || branch.split('/').some((part) => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) refuse('Choose a valid branch name.');
  return branch;
}

const valid = (check, value) => { try { check(value); return true; } catch { return false; } };

export function githubFromOrigin(origin) {
  const match = /^(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(origin.trim());
  if (!match) return null;
  try { return validateGithub(match[1]); } catch { return null; }
}

export function runRepo(command, argv, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, argv, { ...options, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => resolve({ status: 1, stdout, stderr: e.message }));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

export function repoPath(github, base = reposDir()) {
  validateGithub(github);
  const root = path.resolve(base);
  const dest = path.resolve(root, github.toLowerCase());
  if (!dest.startsWith(`${root}${path.sep}`)) refuse('Clone path must stay inside .repos.');
  let part = root;
  for (const name of ['', ...github.toLowerCase().split('/')]) {
    if (name) part = path.join(part, name);
    if (fs.lstatSync(part, { throwIfNoEntry: false })?.isSymbolicLink()) refuse('Clone path must stay inside .repos; symlinks are refused.');
  }
  let ancestor = root;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (fs.realpathSync(ancestor) !== ancestor) refuse('Clone path must stay inside .repos; symlinks are refused.');
  return dest;
}

// Error lines reach the page, and git can echo a remote URL with its credentials.
const firstLine = (r, fallback) => (r.stderr || r.stdout || fallback).trim().split('\n')[0].replace(/(\w+:\/\/)[^/\s@]+@/g, '$1');
const checked = async (run, command, argv, options) => {
  const r = await run(command, argv, options);
  if (r.status !== 0) refuse(firstLine(r, `${command} failed`), 502);
  return r.stdout;
};
const ghJSON = async (run, argv) => JSON.parse(await checked(run, 'gh', argv));

async function verifyClone(run, dest, github) {
  if (!fs.lstatSync(path.join(dest, '.git'), { throwIfNoEntry: false })?.isDirectory()) refuse('The clone path must have a real .git metadata directory; symlinks are refused.');
  const root = await run('git', ['-C', dest, 'rev-parse', '--show-toplevel']);
  if (root.status !== 0 || path.resolve(root.stdout.trim()) !== fs.realpathSync(dest)) refuse('The clone path must be the root of a Git work tree.');
  const origin = await run('git', ['-C', dest, 'remote', 'get-url', 'origin']);
  if (origin.status !== 0 || githubFromOrigin(origin.stdout)?.toLowerCase() !== github.toLowerCase()) refuse(`The clone path origin must be github.com/${github}.`);
}

async function fetchBranch(run, dest, github, branch) {
  const result = await run('git', ['-C', dest, 'fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  if (result.status !== 0) refuse(`Could not fetch branch "${branch}" from ${github}: ${firstLine(result, 'git fetch failed')}`, 502);
}

export function repoService({ run = runRepo, base = reposDir(), now = Date.now } = {}) {
  let cache, pending;
  async function discover() {
    const auth = await run('gh', ['auth', 'status']);
    if (auth.status !== 0) return { signedIn: false, repos: [] };
    const user = await ghJSON(run, ['api', 'user']);
    const pages = await ghJSON(run, ['api', 'user/orgs', '--paginate', '--slurp']);
    const owners = [...new Set([user.login, ...pages.flat().map((o) => o.login)])];
    const lists = await Promise.all(owners.map((owner) => ghJSON(run, ['repo', 'list', owner, '--limit', '100000', '--json', 'nameWithOwner,isPrivate,pushedAt,defaultBranchRef,description'])));
    const repos = new Map();
    for (const r of lists.flat()) {
      if (!valid(validateGithub, r.nameWithOwner)) continue;
      repos.set(r.nameWithOwner.toLowerCase(), { github: r.nameWithOwner, private: r.isPrivate, pushedAt: r.pushedAt, defaultBranch: r.defaultBranchRef?.name || '', description: r.description || '' });
    }
    return { signedIn: true, login: user.login, owners, repos: [...repos.values()].sort((a, b) => (b.pushedAt || '').localeCompare(a.pushedAt || '') || a.github.localeCompare(b.github)) };
  }
  return {
    path: (github) => repoPath(github, base),
    cloned: (github) => fs.lstatSync(path.join(repoPath(github, base), '.git'), { throwIfNoEntry: false })?.isDirectory() || false,
    async list(manifest = {}, { fresh = false } = {}) {
      if (fresh || !cache || now() - cache.at >= 60_000) {
        pending ||= discover().then((value) => { cache = { at: now(), value }; return value; }).finally(() => { pending = null; });
        await pending;
      }
      return { ...cache.value, repos: cache.value.repos.map((repo) => {
        const clone = repoPath(repo.github, base);
        const shared = Object.entries(manifest.sites || {}).filter(([, s]) => s.github?.toLowerCase() === repo.github.toLowerCase() && typeof s.owner?.repo === 'string' && storedPath(path.resolve(s.owner.repo)).toLowerCase() === storedPath(clone).toLowerCase()).map(([route, s]) => ({ route, title: s.title || route }));
        return { ...repo, clone, cloned: fs.lstatSync(path.join(clone, '.git'), { throwIfNoEntry: false })?.isDirectory() || false, shared };
      }) };
    },
    async branches(github) {
      validateGithub(github);
      const repo = await ghJSON(run, ['api', `repos/${github}`]);
      const pages = await ghJSON(run, ['api', `repos/${github}/branches?per_page=100`, '--paginate', '--slurp']);
      return { defaultBranch: repo.default_branch, branches: pages.flat().map((b) => b.name).filter((name) => valid(validateBranch, name)) };
    },
    async ensure(github, branch = 'main') {
      const dest = repoPath(github, base);
      validateBranch(branch);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      return withFileLock(path.join(path.resolve(base), '.locks', github.toLowerCase()), async () => {
        repoPath(github, base);
        if (fs.existsSync(dest)) {
          await verifyClone(run, dest, github);
          await fetchBranch(run, dest, github, branch);
          return dest;
        }
        const temp = fs.mkdtempSync(path.join(path.resolve(base), '.clone-'));
        try {
          await checked(run, 'gh', ['repo', 'clone', github, path.join(temp, 'repo')]);
          await verifyClone(run, path.join(temp, 'repo'), github);
          await fetchBranch(run, path.join(temp, 'repo'), github, branch);
          repoPath(github, base);
          fs.renameSync(path.join(temp, 'repo'), dest);
        } finally { fs.rmSync(temp, { recursive: true, force: true }); }
        return dest;
      }, { timeout: 10 * 60_000, heartbeat: true });
    },
  };
}
