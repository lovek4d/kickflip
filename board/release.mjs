// docs/adr/2026-11-16-0200-a-repos-kickflip-release-replaces-lands-tag-release.md
// The release step of a land. A landed commit whose subject is "chore(release): <version>" is a release. When the
// commit holds an executable `.kickflip/release`, that script is the repo's release: land runs
// `.kickflip/release check <version> <commit>` before landing, refusing on a non-zero exit, and
// `.kickflip/release ship <version> <commit>` once main reached origin while the board's Run release script box is on.
// With no script, land's built-in tag release (release-tag.mjs) checks and tags v<version>, which stays local.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BoardError } from './store.mjs';
import { releaseVersion } from './commit-message.mjs';
import { buildScriptError } from './build-script.mjs';
import { releaseTag, tagRelease, localRelease } from './release-tag.mjs';

export const RELEASE_SCRIPT = '.kickflip/release';
const SCRIPT_TIME_LIMIT_MS = 10 * 60_000;
const OUTPUT_LINES = 20;

const fail = (msg) => { throw new BoardError(msg); };
function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

// Whether ref's tree in repo holds a `.kickflip/release`.
export const hasReleaseScript = (repo, ref) => git(repo, 'cat-file', '-e', `${ref}:${RELEASE_SCRIPT}`).ok;

const versionOf = (repo, commit) => {
  const subject = git(repo, 'log', '-1', '--format=%s', commit).out;
  return { subject, version: releaseVersion(subject) };
};

// Runs dir's `.kickflip/release <verb> <version> <commit>` with no shell, checked as `.kickflip/build` is
// (build-script.mjs buildScriptError). → {ok, output}, output the last lines it printed or why it couldn't run.
function runScript(dir, verb, version, commit) {
  const file = path.join(dir, RELEASE_SCRIPT);
  const invalid = buildScriptError(file);
  if (invalid) return { ok: false, output: invalid.replace(/^Build script/, RELEASE_SCRIPT) };
  const r = spawnSync(file, [verb, version, commit], { cwd: dir, encoding: 'utf8', timeout: SCRIPT_TIME_LIMIT_MS });
  const printed = `${r.stdout || ''}\n${r.stderr || ''}`.split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-OUTPUT_LINES).join('\n');
  if (r.error) return { ok: false, output: [`${RELEASE_SCRIPT} ${verb} could not run: ${r.error.message}`, printed].filter(Boolean).join('\n') };
  if (r.status !== 0) return { ok: false, output: [`${RELEASE_SCRIPT} ${verb} exited ${r.status ?? r.signal}`, printed].filter(Boolean).join('\n') };
  return { ok: true, output: printed };
}

// Before landing commit, checked out in dir: refuses a release the repo's script, or land's built-in check, refuses.
export function checkRelease(repo, dir, commit) {
  const { subject, version } = versionOf(repo, commit);
  if (!version) return;
  if (!hasReleaseScript(repo, commit)) { releaseTag(repo, commit); return; }
  const checked = runScript(dir, 'check', version, commit);
  if (!checked.ok) fail(`land: "${subject}" is a release, and ${RELEASE_SCRIPT} check refused it:\n${checked.output}`);
}

// Under the land lock, once base was fast-forwarded to commit. → {release, err}: release null for no release, else
// {version, commit, script: true} for the repo's script or {version, commit, tag} for the built-in tag it made; err
// when the built-in tag couldn't be made.
export function landRelease(repo, commit) {
  const { version } = versionOf(repo, commit);
  if (!version) return { release: null };
  if (hasReleaseScript(repo, commit)) return { release: { version, commit, script: true } };
  const { tag, err } = tagRelease(repo, commit);
  return { release: tag ? { version, commit, tag } : null, err };
}

// After base reached origin: ships release, landRelease's. runRelease is the board's Run release script box
// (permissions.mjs). The script runs from repo's checkout of base, which the fast-forward left at release.commit.
// → {line} for the land's output, and failed, what went wrong, when the release didn't ship.
export function shipRelease(repo, release, { runRelease }) {
  if (!release.script) return localRelease(repo, release.tag);
  const how = `run ${RELEASE_SCRIPT} ship ${release.version} ${release.commit} in ${repo}`;
  if (!runRelease) return { line: `release ${release.version} waits while Run release script is off; turn it on in Board Settings, then ${how}` };
  if (!git(repo, 'diff', '--quiet', release.commit, '--', RELEASE_SCRIPT).ok) {
    const why = `${path.join(repo, RELEASE_SCRIPT)} isn't the landed commit's`;
    return { line: `landed, but release ${release.version} didn't ship: ${why}; ${how}`, failed: why };
  }
  const shipped = runScript(repo, 'ship', release.version, release.commit);
  if (shipped.ok) return { line: [`shipped release ${release.version} with ${RELEASE_SCRIPT}`, shipped.output].filter(Boolean).join('\n') };
  return { line: `landed, but release ${release.version} didn't ship: ${shipped.output}\n${how}`, failed: shipped.output };
}
