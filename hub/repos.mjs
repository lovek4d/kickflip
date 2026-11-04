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
  return githubFromInput(match[1]);
}

// A board repo on another git host (docs/adr/0127-a-board-can-work-on-any-git-remote.md): https://host/path,
// ssh://[user@]host[:port]/path or user@host:path. A link with a password or token, a query, a local path, file:// or
// a github.com host is refused, as is a host without a dot, whose clone folder could pass for a GitHub owner's.
// → {remote, host, path}: remote is the link as given, host lowercased, path without .git; or null
const HOST = /^[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)+$/i;
const SEGMENT = /^[\w~][\w.~-]{0,99}$|^\.[\w~-][\w.~-]{0,98}$/;
export function remoteFromInput(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim().replace(/\/+$/, '');
  const link = /^https:\/\/([^/@\s?#]+?)(?::\d{1,5})?\/([^\s?#]+)$/i.exec(text)
    || /^ssh:\/\/(?:[^@/:\s]+@)?([^/@:\s?#]+)(?::\d{1,5})?\/([^\s?#]+)$/i.exec(text)
    || /^[^@/:\s]+@([^/@:\s?#]+):([^\s?#]+)$/.exec(text);
  if (!link || text.length > 400 || !HOST.test(link[1]) || /^(?:www\.)?github\.com$/i.test(link[1])) return null;
  const parts = link[2].replace(/^\/+/, '').replace(/\.git$/i, '').split('/');
  if (parts.length > 10 || !parts.every((part) => SEGMENT.test(part) && part !== '..')) return null;
  return { remote: text, host: link[1].toLowerCase(), path: parts.join('/') };
}
const REMOTE_SHAPES = 'Paste a git link: https://host/path, ssh://host/path or user@host:path.';
export const validateRemote = (remote) => remoteFromInput(remote) || refuse(REMOTE_SHAPES);
// A board repo string is a GitHub owner/name, which never has a colon, or a remote link, which always does.
export const isRemote = (repo) => typeof repo === 'string' && repo.includes(':');
// The clone folder's parts under .repos: <owner>/<repo>, or <host>/<path…> for a remote, lowercased.
export const repoParts = (repo) => (isRemote(repo) ? (({ host, path: p }) => [host, ...p.toLowerCase().split('/')])(validateRemote(repo)) : validateGithub(repo).toLowerCase().split('/'));
// owner/name, or host/path for a remote: how the picker and errors name a repo.
export const repoName = (repo) => (isRemote(repo) ? (({ host, path: p }) => `${host}/${p}`)(validateRemote(repo)) : validateGithub(repo));
const sameRepo = (a, b) => { try { return repoParts(a).join('/') === repoParts(b).join('/'); } catch { return false; } };

// Browser paths belong to a repo too; clone-origin checks above still require a repo-root URL.
export function githubFromInput(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  const link = /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s?#]+\/[^/\s?#]+)(?:\/[^\s]*)?(?:[?#][^\s]*)?$/i.exec(text);
  const github = link ? link[1].replace(/\.git$/i, '') : text;
  try { return validateGithub(github); } catch { return null; }
}

// Kept separate from hub startup so route tests use the same handler with an injected service and no listener.
export async function repoLookupRoute(url, { repos, manifest, sendJSON }) {
  try { return sendJSON(200, await repos.lookup(url.searchParams.get('github') ?? url.searchParams.get('remote'), manifest)); }
  catch (e) { return sendJSON(e.status || 502, { error: e.message }); }
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

// The folder's default branch: origin's (refs/remotes/origin/HEAD) first, since the folder may have a feature branch
// checked out, else the checked-out branch. → the name, or '' when neither is a valid branch
export async function defaultBranch(cwd, run = runRepo) {
  const remote = await run('git', ['-C', cwd, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const head = await run('git', ['-C', cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
  for (const branch of [remote.status === 0 && remote.stdout.trim().replace(/^origin\//, ''), head.status === 0 && head.stdout.trim()]) {
    if (branch && valid(validateBranch, branch)) return branch;
  }
  return '';
}

// repo is a GitHub owner/name or a remote link.
export function repoPath(repo, base = reposDir()) {
  const parts = repoParts(repo);
  const root = path.resolve(base);
  const dest = path.resolve(root, ...parts);
  if (!dest.startsWith(`${root}${path.sep}`)) refuse('Clone path must stay inside .repos.');
  let part = root;
  for (const name of ['', ...parts]) {
    if (name) part = path.join(part, name);
    if (fs.lstatSync(part, { throwIfNoEntry: false })?.isSymbolicLink()) refuse('Clone path must stay inside .repos; symlinks are refused.');
  }
  let ancestor = root;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (fs.realpathSync(ancestor) !== ancestor) refuse('Clone path must stay inside .repos; symlinks are refused.');
  return dest;
}

const hasGit = (dir) => fs.lstatSync(path.join(dir, '.git'), { throwIfNoEntry: false })?.isDirectory() === true;
// Whether dir is, through any symlinks, a clone repoService made under base, with its own .git: <base>/<owner>/<repo>,
// or <base>/<host>/<path…> with no clone above it.
export function isClone(dir, base = reposDir()) {
  let real, root, parts;
  try { real = fs.realpathSync(dir); root = fs.realpathSync(base); parts = path.relative(root, real).split(path.sep); } catch { return false; }
  if (parts.length === 2 && valid(validateGithub, parts.join('/'))) return hasGit(real);
  if (parts.length < 2 || parts.length > 11 || !HOST.test(parts[0]) || !parts.slice(1).every((part) => SEGMENT.test(part) && part !== '..')) return false;
  for (let n = 2; n < parts.length; n++) if (hasGit(path.join(root, ...parts.slice(0, n)))) return false;
  return hasGit(real);
}

const PROGRESS = /^(?:Cloning into |remote: (?:Enumerating|Counting|Compressing|Total) |Receiving objects:|Resolving deltas:|Updating files:)/;
// A failed command's error line (docs/adr/0110-a-clone-uses-ghs-token-over-https.md): git prints progress before its
// fatal: line and may follow it with a blank line and advice. Error lines reach the page, and git can echo a remote
// URL with its credentials.
function errorLine(text, fallback) {
  const paragraphs = String(text || '').split(/\n\s*\n/).map((p) => p.split(/[\r\n]+/).map((l) => l.trim()).filter((l) => l && !PROGRESS.test(l)));
  return (paragraphs.find((p) => p.length)?.at(-1) || fallback).replace(/(\w+:\/\/)[^/\s@]+@/g, '$1');
}
const failure = (r, fallback) => errorLine(r.stderr || r.stdout, fallback);
const checked = async (run, command, argv, options) => {
  const r = await run(command, argv, options);
  if (r.status !== 0) refuse(failure(r, `${command} failed`), 502);
  return r.stdout;
};
const ghJSON = async (run, argv) => JSON.parse(await checked(run, 'gh', argv));

async function verifyClone(run, dest, repo) {
  if (!fs.lstatSync(path.join(dest, '.git'), { throwIfNoEntry: false })?.isDirectory()) refuse('The clone path must have a real .git metadata directory; symlinks are refused.');
  const root = await run('git', ['-C', dest, 'rev-parse', '--show-toplevel']);
  if (root.status !== 0 || path.resolve(root.stdout.trim()) !== fs.realpathSync(dest)) refuse('The clone path must be the root of a Git work tree.');
  const origin = await run('git', ['-C', dest, 'remote', 'get-url', 'origin']);
  const same = origin.status === 0 && (isRemote(repo) ? sameRepo(origin.stdout.trim(), repo) : githubFromOrigin(origin.stdout)?.toLowerCase() === repo.toLowerCase());
  if (!same) refuse(`The clone path origin must be ${isRemote(repo) ? repoName(repo) : `github.com/${repo}`}.`);
}

// The fallback for a public repo gh can't see: with no credential helper or prompt, success means the repo is public,
// and a private or missing one fails at once instead of waiting on a password prompt.
const publicGit = (run, argv) => run('git', ['-c', 'credential.helper=', ...argv], { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
// Git over https with gh's token as its only credential, whatever gh's git_protocol says, and no prompt, so a public
// repo needs no sign-in and one the token can't reach fails at once.
export const githubGitArgv = (argv) => ['-c', 'credential.helper=', '-c', 'credential.https://github.com.helper=!gh auth git-credential', ...argv];
const githubGit = (run, argv) => run('git', githubGitArgv(argv), { env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
// A remote board's git uses git's own credential (SSH agent, keychain helper) with every prompt off, ssh's too, so a
// remote it can't reach fails at once instead of waiting on a password or host-key question.
export const remoteGitEnv = (env = process.env) => ({ ...env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes' });
const remoteGit = (run, argv) => run('git', argv, { env: remoteGitEnv() });
const gitFor = (repo) => (isRemote(repo) ? remoteGit : githubGit);
const cloneURL = (repo) => (isRemote(repo) ? repo : `https://github.com/${repo}.git`);

// Why git couldn't reach a board repo's origin with git's own credential, from its stderr: the remote's own line when
// it sent one ("remote: Repository not found."), else git's last line, and the fix. github is the repo's owner/name,
// or '' when unknown; remote is a remote board's link. → {error, hint}
const NO_ACCESS = /not found|authentication failed|could not read username|invalid username or password|permission denied|terminal prompts disabled|\b403\b/i;
export function gitReachFault(stderr, { github = '', remote = '', repo }) {
  const lines = String(stderr || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const error = (lines.find((l) => /^remote:/i.test(l)) || lines.at(-1) || 'git failed without a message').replace(/(\w+:\/\/)[^/\s@]+@/g, '$1');
  const reach = remoteFromInput(remote);
  const hint = reach ? `check git can reach ${reach.host}: git ls-remote ${reach.remote}`
    : github && NO_ACCESS.test(lines.join('\n')) ? `git's github.com login can't see ${github}; run gh auth setup-git`
      : `run git -C ${repo} fetch origin to see the whole error`;
  return { error, hint };
}
// A remote's error as one sentence for the picker: git's line, then the hint.
const reachError = (r, remote) => {
  const { error, hint } = gitReachFault(r.stderr || r.stdout, { remote, repo: '' });
  return `${error.replace(/[.\s]*$/, '.')} ${hint[0].toUpperCase()}${hint.slice(1)}.`;
};

async function fetchBranch(run, dest, repo, branch) {
  const result = await gitFor(repo)(run, ['-C', dest, 'fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  if (result.status !== 0) refuse(`Could not fetch branch "${branch}" from ${repoName(repo)}: ${failure(result, 'git fetch failed')}`, 502);
}

export function repoService({ run = runRepo, base = reposDir(), now = Date.now } = {}) {
  let cache, pending;
  const lookups = new Map();
  const repoRow = (r) => ({ github: r.nameWithOwner, private: r.isPrivate, pushedAt: r.pushedAt || '', defaultBranch: r.defaultBranchRef?.name || '', description: r.description || '' });
  const decorate = (repo, manifest) => {
    const id = repo.github || repo.remote;
    const clone = repoPath(id, base);
    const shared = Object.entries(manifest.sites || {}).filter(([, s]) => sameRepo(s.github || s.remote, id) && typeof s.owner?.repo === 'string' && storedPath(path.resolve(s.owner.repo)).toLowerCase() === storedPath(clone).toLowerCase()).map(([route, s]) => ({ route, title: s.title || route }));
    return { ...repo, clone, cloned: fs.lstatSync(path.join(clone, '.git'), { throwIfNoEntry: false })?.isDirectory() || false, shared };
  };
  // → {defaultBranch, branches} from ls-remote's answer, or the failed run as {failed}
  async function lsRemote(gitRun, url) {
    const remote = await gitRun(run, ['ls-remote', '--symref', url, 'HEAD', 'refs/heads/*']);
    if (remote.status !== 0) return { failed: remote };
    const stdout = remote.stdout;
    const branches = [...new Set([...stdout.matchAll(/^[\da-f]+\s+refs\/heads\/(.+)$/gm)].map((m) => m[1]).filter((name) => valid(validateBranch, name)))];
    const head = /^ref:\s+refs\/heads\/(.+)\s+HEAD$/m.exec(stdout)?.[1];
    return { defaultBranch: branches.includes(head) ? head : branches[0] || '', branches };
  }
  async function remoteBranches(github) {
    const found = await lsRemote(publicGit, `https://github.com/${github}.git`);
    return found.failed ? null : found;
  }
  async function findRemote(remote) {
    const found = await lsRemote(remoteGit, remote);
    if (found.failed) refuse(reachError(found.failed, remote), 404);
    const { host, path: name } = validateRemote(remote);
    return { remote, host, name: `${host}/${name}`, github: '', pushedAt: '', defaultBranch: found.defaultBranch, description: '' };
  }
  async function find(github) {
    const result = await run('gh', ['repo', 'view', github, '--json', 'nameWithOwner,isPrivate,description,pushedAt,defaultBranchRef']);
    if (result.status === 0) {
      const repo = JSON.parse(result.stdout);
      validateGithub(repo.nameWithOwner);
      return repoRow(repo);
    }
    const remote = await publicGit(run, ['ls-remote', '--heads', `https://github.com/${github}.git`]);
    if (remote.status !== 0) return null;
    return { github, private: false, pushedAt: '', defaultBranch: '', description: '' };
  }
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
      repos.set(r.nameWithOwner.toLowerCase(), repoRow(r));
    }
    return { signedIn: true, login: user.login, owners, repos: [...repos.values()].sort((a, b) => (b.pushedAt || '').localeCompare(a.pushedAt || '') || a.github.localeCompare(b.github)) };
  }
  return {
    base: path.resolve(base),
    path: (repo) => repoPath(repo, base),
    cloned: (repo) => fs.lstatSync(path.join(repoPath(repo, base), '.git'), { throwIfNoEntry: false })?.isDirectory() || false,
    async list(manifest = {}, { fresh = false } = {}) {
      if (fresh || !cache || now() - cache.at >= 60_000) {
        pending ||= discover().then((value) => { cache = { at: now(), value }; return value; }).finally(() => { pending = null; });
        await pending;
      }
      return { ...cache.value, repos: cache.value.repos.map((repo) => decorate(repo, manifest)) };
    },
    // A GitHub link or owner/name, or another host's git link (remoteFromInput).
    async lookup(input, manifest = {}) {
      const github = githubFromInput(input);
      const remote = github ? null : remoteFromInput(input);
      if (!github && !remote) refuse(isRemote(input) ? REMOTE_SHAPES : 'Repo must be owner/name on GitHub.');
      const key = github ? github.toLowerCase() : repoParts(remote.remote).join('/');
      let entry = lookups.get(key);
      if (!entry || now() - entry.at >= 60_000) {
        for (const [key, value] of lookups) if (now() - value.at >= 60_000) lookups.delete(key);
        entry = { at: now(), pending: github ? find(github) : findRemote(remote.remote) };
        lookups.set(key, entry);
        entry.pending.catch(() => { if (lookups.get(key) === entry) lookups.delete(key); });
      }
      const repo = await entry.pending;
      if (!repo) refuse("Not found, or you don't have access.", 404);
      return decorate({ ...repo, listed: false }, manifest);
    },
    async branches(repo) {
      if (isRemote(repo)) {
        validateRemote(repo);
        const found = await lsRemote(remoteGit, repo);
        if (found.failed) refuse(reachError(found.failed, repo), 502);
        return found;
      }
      const github = validateGithub(repo);
      try {
        const repo = await ghJSON(run, ['api', `repos/${github}`]);
        const pages = await ghJSON(run, ['api', `repos/${github}/branches?per_page=100`, '--paginate', '--slurp']);
        return { defaultBranch: repo.default_branch, branches: pages.flat().map((b) => b.name).filter((name) => valid(validateBranch, name)) };
      } catch (e) {
        const remote = await remoteBranches(github);
        if (!remote) throw e;
        return remote;
      }
    },
    // repo is a GitHub owner/name or a remote link.
    async ensure(repo, branch = 'main') {
      const dest = repoPath(repo, base);
      validateBranch(branch);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      return withFileLock(path.join(path.resolve(base), '.locks', ...repoParts(repo)), async () => {
        repoPath(repo, base);
        if (fs.existsSync(dest)) {
          await verifyClone(run, dest, repo);
          await fetchBranch(run, dest, repo, branch);
          return dest;
        }
        const temp = fs.mkdtempSync(path.join(path.resolve(base), '.clone-'));
        try {
          const clone = await gitFor(repo)(run, ['clone', cloneURL(repo), path.join(temp, 'repo')]);
          if (clone.status !== 0) refuse(isRemote(repo) ? reachError(clone, repo) : failure(clone, 'git clone failed'), 502);
          await verifyClone(run, path.join(temp, 'repo'), repo);
          await fetchBranch(run, path.join(temp, 'repo'), repo, branch);
          repoPath(repo, base);
          fs.renameSync(path.join(temp, 'repo'), dest);
        } finally { fs.rmSync(temp, { recursive: true, force: true }); }
        return dest;
      }, { timeout: 10 * 60_000, heartbeat: true });
    },
  };
}
