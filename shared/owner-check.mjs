// docs/adr/2026-11-04-2308-an-owner-step-can-carry-a-code-check.md
// An owner step's code check: one named, read-only check with arguments, never a shell command. The builder attaches
// it with --check "<name> <args>" beside --owner-step, the card reads its words, and the hub's poll runs it on each
// check (hub/github.mjs), closing the card when it passes. Each kind runs as an argv call or a fetch, with no shell.
// A run → {passed: true, found} once the thing is there, {passed: false} while it isn't yet, and throws when the check
// can't run (a missing repo or package, no auth, a bad path, an unreachable address).
import { execFile } from 'node:child_process';

const REPO = /^[\w.-]+\/[\w.-]+$/;
const PACKAGE = /^(@[\w.-]+\/)?[\w.][\w.-]*$/;
const API_PATH = /^[\w.-]+(\/[\w.-]+)*$/;
const FIELD = /^[\w-]+(\.[\w-]+)*$/;

const bad = (message) => { throw new Error(message); };
const repoOf = (v) => (REPO.test(v || '') ? v : bad(`"${v ?? ''}" isn't a GitHub repo such as owner/name`));
const plain = (v, what) => (v && !v.startsWith('-') ? v : bad(`${what} is missing`));

// Each kind: usage, its argument check (→ the args it keeps), its words on the card and its run.
const KINDS = {
  tag: {
    usage: 'tag <owner/repo> <pattern>',
    args: ([repo, pattern, ...rest]) => (rest.length ? bad('tag takes a repo and one pattern') : [repoOf(repo), plain(pattern, 'the tag pattern')]),
    words: ([repo, pattern]) => `a ${pattern} tag on ${repo}`,
    async run([repo, pattern], { exec }) {
      const out = await exec('git', ['ls-remote', '--tags', `https://github.com/${repo}.git`]);
      const match = globOf(pattern);
      const tags = [...new Set(out.split('\n').map((l) => l.split('\t')[1]?.replace(/^refs\/tags\//, '').replace(/\^\{\}$/, '')).filter(Boolean))];
      const found = tags.filter((t) => match.test(t)).sort(byVersion).at(-1);
      return found ? { passed: true, found: `tag ${found} is on ${repo}` } : { passed: false };
    },
  },
  npm: {
    usage: 'npm <package> <version-or-range>',
    args: ([pkg, range, ...rest]) => (rest.length ? bad('npm takes a package and one version or range')
      : [PACKAGE.test(pkg || '') ? pkg : bad(`"${pkg ?? ''}" isn't an npm package name`), plain(range, 'the version or range')]),
    words: ([pkg, range]) => `${pkg}@${range} on npm`,
    async run([pkg, range], { exec }) {
      // npm exits 1 with "No match found" while no published version matches the range: not yet.
      const out = (await exec('npm', ['view', `${pkg}@${range}`, 'version', '--json']).catch((e) => {
        if (/No match found for version/.test(`${e.stdout ?? ''}${e.stderr ?? ''}`)) return '';
        throw e;
      })).trim();
      const versions = out ? [JSON.parse(out)].flat() : [];
      const found = versions.sort(byVersion).at(-1);
      return found ? { passed: true, found: `${pkg}@${found} is on npm` } : { passed: false };
    },
  },
  run: {
    usage: 'run <owner/repo> <workflow>',
    args: ([repo, ...workflow]) => [repoOf(repo), plain(workflow.join(' '), 'the workflow')],
    words: ([repo, workflow]) => `a passing ${workflow} run on ${repo}`,
    async run([repo, workflow], { exec, since }) {
      const out = await exec('gh', ['run', 'list', '--repo', repo, '--workflow', workflow, '--status', 'success', '--limit', '20', '--json', 'createdAt,url']);
      const found = JSON.parse(out || '[]').filter((r) => String(r.createdAt) >= since).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).at(-1);
      return found ? { passed: true, found: `${workflow} passed on ${repo} (${found.url})` } : { passed: false };
    },
  },
  gh: {
    usage: 'gh <owner/repo> <api-path> <field>=<value>',
    args([repo, apiPath, expect, ...rest]) {
      if (rest.length) bad('gh takes a repo, an API path and one field=value');
      if (!API_PATH.test(apiPath || '') || apiPath.split('/').includes('..')) bad(`"${apiPath ?? ''}" isn't an API path under the repo, such as actions/permissions`);
      const [field, ...value] = String(expect ?? '').split('=');
      if (!FIELD.test(field) || !value.length) bad(`"${expect ?? ''}" isn't a field=value, such as enabled=true`);
      return [repoOf(repo), apiPath, expect];
    },
    words: ([repo, apiPath, expect]) => `${apiPath} reads ${expect} on ${repo}`,
    async run([repo, apiPath, expect], { exec }) {
      const [field, ...rest] = expect.split('=');
      const value = rest.join('=');
      const got = field.split('.').reduce((v, k) => v?.[k], JSON.parse(await exec('gh', ['api', `repos/${repo}/${apiPath}`])));
      return got !== undefined && String(got) === value ? { passed: true, found: `${apiPath} reads ${expect} on ${repo}` } : { passed: false };
    },
  },
  url: {
    usage: 'url <http(s) address> [<status> | <text>]',
    args([address, ...expect]) {
      let parsed;
      try { parsed = new URL(address); } catch { bad(`"${address ?? ''}" isn't a web address`); }
      if (!['http:', 'https:'].includes(parsed.protocol)) bad('url takes an http or https address');
      return expect.length ? [address, expect.join(' ')] : [address];
    },
    words: ([address, expect]) => (expect === undefined || /^\d{3}$/.test(expect) ? `${address} answers ${expect ?? 200}` : `${address} shows "${expect}"`),
    async run([address, expect], { fetchImpl }) {
      const status = expect !== undefined && /^\d{3}$/.test(expect) ? Number(expect) : 200;
      const res = await fetchImpl(address, { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
      const body = await res.text();
      if (res.status !== status) return { passed: false };
      if (status === 200 && expect !== undefined && !/^\d{3}$/.test(expect)) return body.includes(expect) ? { passed: true, found: `${address} shows "${expect}"` } : { passed: false };
      return { passed: true, found: `${address} answered ${status}` };
    },
  },
};

export const CHECK_USAGE = Object.values(KINDS).map((k) => k.usage);

// "<name> <args>" → {name, args}, or throws naming what's wrong.
export function parseCheck(text) {
  const [name, ...words] = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  if (!name) bad(`--check takes "<name> <args>": ${CHECK_USAGE.join(', ')}`);
  const kind = Object.hasOwn(KINDS, name) ? KINDS[name] : bad(`--check has no check "${name}"; it takes ${CHECK_USAGE.join(', ')}`);
  try { return { name, args: kind.args(words) }; } catch (e) { return bad(`--check ${kind.usage}: ${e.message}`); }
}

// The stored form of a parsed check, one space between words.
export const checkText = ({ name, args }) => [name, ...args].join(' ');

// What the check waits for, as the card reads it.
export const checkWords = ({ name, args }) => KINDS[name].words(args);

// since: when the check was attached, which a run check's workflow run must follow.
export function runCheck({ name, args }, { since, exec = execArgv, fetchImpl = fetch } = {}) {
  return KINDS[name].run(args, { since, exec, fetchImpl });
}

// No shell: the command and its arguments go to execFile as they are. A non-zero exit throws its stderr's first line,
// with stdout and stderr on the error.
function execArgv(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 60_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const said = String(stderr || '').trim().split('\n').find(Boolean)?.replace(/^npm error /, '');
      reject(Object.assign(new Error(`${cmd} ${args[0]} failed: ${said || err.message}`), { stdout, stderr }));
    });
  });
}

function globOf(pattern) {
  return new RegExp(`^${pattern.split('').map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('')}$`);
}

// Version-aware order, so v0.10.0 sorts after v0.9.1.
function byVersion(a, b) {
  return a.localeCompare(b, 'en', { numeric: true });
}
