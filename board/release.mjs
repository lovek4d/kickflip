// docs/adr/2026-11-16-0200-a-repos-kickflip-release-replaces-lands-tag-release.md
// The release step of a land. A landed commit whose subject is "chore(release): <version>" is a release. The board's
// release script is the repo's release: land runs `<release> check <version> <commit>` before landing, refusing on a
// non-zero exit, and `<release> ship <version> <commit>` once main reached origin while the board's Run release script
// box is on. The script is the commit's executable `.kickflip/release`, or, on a board whose scripts are in kickflip,
// its site's scripts/release (docs/adr/2026-11-17-1451-a-boards-scripts-live-in-its-repo-or-in-kickflip.md).
// Land has no release of its own: a release on a board with no script is refused.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { BoardError } from './checks.mjs';
import { releaseVersion } from './commit-message.mjs';
import { buildScriptError, scriptFileOf, scriptShownOf, scriptsOf } from './build-script.mjs';

const RELEASE_SCRIPT = '.kickflip/release';
const SCRIPT_TIME_LIMIT_MS = 10 * 60_000;
const OUTPUT_LINES = 20;

const fail = (msg) => { throw new BoardError(msg); };
function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

// The scripts' home of the board in site; a land with no board (board.mjs land without --site) runs the repo's.
const homeOf = (site) => (site ? scriptsOf(site) : { scripts: 'repo' });

// Whether the board in site has a release script: its kickflip-held one, or one in ref's tree in repo.
export const hasReleaseScript = (repo, ref, site) => {
  const home = homeOf(site);
  return home.scripts === 'kickflip' ? fs.existsSync(scriptFileOf(home, 'release')) : git(repo, 'cat-file', '-e', `${ref}:${RELEASE_SCRIPT}`).ok;
};
// → how the board's messages name its release script
export const releaseShownOf = (site) => scriptShownOf(homeOf(site), 'release');

const versionOf = (repo, commit) => {
  const subject = git(repo, 'log', '-1', '--format=%s', commit).out;
  return { subject, version: releaseVersion(subject) };
};

// Runs the board's release script for a run in dir, `<release> <verb> <version> <commit>`, with no shell and dir as
// cwd, checked as a build script is (build-script.mjs buildScriptError). → {ok, output}, output the last lines it
// printed or why it couldn't run.
function runScript(home, dir, verb, version, commit) {
  const file = scriptFileOf(home, 'release', dir);
  const shown = scriptShownOf(home, 'release');
  const invalid = buildScriptError(file);
  if (invalid) return { ok: false, output: invalid.replace(/^Build script/, shown) };
  const r = spawnSync(file, [verb, version, commit], { cwd: dir, encoding: 'utf8', timeout: SCRIPT_TIME_LIMIT_MS });
  const printed = `${r.stdout || ''}\n${r.stderr || ''}`.split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-OUTPUT_LINES).join('\n');
  if (r.error) return { ok: false, output: [`${shown} ${verb} could not run: ${r.error.message}`, printed].filter(Boolean).join('\n') };
  if (r.status !== 0) return { ok: false, output: [`${shown} ${verb} exited ${r.status ?? r.signal}`, printed].filter(Boolean).join('\n') };
  return { ok: true, output: printed };
}

// Before landing commit, checked out in dir: refuses a release on a board with no script, or one its script refuses.
export function checkRelease(repo, dir, commit, site) {
  const { subject, version } = versionOf(repo, commit);
  if (!version) return;
  const home = homeOf(site);
  const shown = scriptShownOf(home, 'release');
  if (!hasReleaseScript(repo, commit, site)) {
    fail(home.scripts === 'kickflip' ? `land: "${subject}" is a release. This board has no ${shown}, so land can't ship it; write one with board.mjs script set release and land again`
      : `land: "${subject}" is a release. This repo has no ${shown}, so land can't ship it; add one and land again`);
  }
  const checked = runScript(home, dir, 'check', version, commit);
  if (!checked.ok) fail(`land: "${subject}" is a release, and ${shown} check refused it:\n${checked.output}`);
}

// Under the land lock, once base was fast-forwarded to commit, which checkRelease passed. → {version, commit, pkg} for
// shipRelease and the card's release (finish.mjs), or null when commit isn't a release. pkg is the name in commit's
// package.json, which the hub's release watch looks for on npm (hub/release-watch.mjs), or null with none.
export function landRelease(repo, commit) {
  const { version } = versionOf(repo, commit);
  if (!version) return null;
  let pkg = null;
  try { pkg = JSON.parse(git(repo, 'show', `${commit}:package.json`).out).name || null; } catch {}
  return { version, commit, pkg };
}

// The Run card a release waiting on the box offers: the thread line's words and the script that tags the landed commit.
// docs/adr/2026-11-21-2349-a-failed-ticket-move-is-retried-on-the-hubs-poll-and-an-untagged-release-offers-its-tag.md
function tagOffer(repo, release, home, shown) {
  const file = home.scripts === 'kickflip' ? scriptFileOf(home, 'release') : `${shown}`;
  const quote = (word) => `'${word.replaceAll("'", `'\\''`)}'`;
  const verb = (v) => `${quote(file)} ${v} ${release.version} ${release.commit}`;
  return {
    text: `${release.version} landed but isn't tagged: Run release script is off, so the land stopped short of the tag. Run this to tag it and push the tag, which sends ${release.version} out to npm.`,
    body: `cd ${quote(repo)} && git fetch -q origin && ${verb('check')} && ${verb('ship')}\n`,
  };
}

// After base reached origin: ships release, landRelease's. runRelease is the board's Run release script box
// (permissions.mjs). The script runs from repo's checkout of base, which the fast-forward left at release.commit; a
// repo's script must be the landed commit's, a kickflip-held one is the board's one copy.
// → {line} for the land's output, and failed, what went wrong, when the release didn't ship.
export function shipRelease(repo, release, { runRelease }, site) {
  const home = homeOf(site);
  const shown = scriptShownOf(home, 'release');
  const how = `run ${shown} ship ${release.version} ${release.commit} in ${repo}`;
  if (!runRelease) return { line: `release ${release.version} waits while Run release script is off; turn it on in Board Settings, then ${how}`, offer: tagOffer(repo, release, home, shown) };
  if (home.scripts !== 'kickflip' && !git(repo, 'diff', '--quiet', release.commit, '--', RELEASE_SCRIPT).ok) {
    const why = `${scriptFileOf(home, 'release', repo)} isn't the landed commit's`;
    return { line: `landed, but release ${release.version} didn't ship: ${why}; ${how}`, failed: why };
  }
  const shipped = runScript(home, repo, 'ship', release.version, release.commit);
  if (shipped.ok) return { line: [`shipped release ${release.version} with ${shown}`, shipped.output].filter(Boolean).join('\n') };
  return { line: `landed, but release ${release.version} didn't ship: ${shipped.output}\n${how}`, failed: shipped.output };
}
