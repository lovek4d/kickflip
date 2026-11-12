// docs/adr/2026-11-12-1251-land-tags-a-release-commit-and-pushes-the-tag.md
// The release step of a land, one seam a repo's own release step can replace (T-244): a landed commit whose subject is
// "chore(release): <version>" (scripts/release.mjs's) is a release, tagged v<version> once it lands, and its tag goes
// to origin after the base branch.
import { spawnSync } from 'node:child_process';
import { BoardError } from './store.mjs';
import { releaseVersion } from './commit-message.mjs';

const fail = (msg) => { throw new BoardError(msg); };
function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

// The tag commit in repo takes as it lands, "v<version>", or null when it isn't a release. Refuses a release whose
// package.json there names another version, or whose tag is already on another commit.
export function releaseTag(repo, commit) {
  const subject = git(repo, 'log', '-1', '--format=%s', commit).out;
  const version = releaseVersion(subject);
  if (!version) return null;
  let found = null;
  try { found = JSON.parse(git(repo, 'show', `${commit}:package.json`).out).version ?? null; } catch {}
  if (found !== version) fail(`land: "${subject}" is a release, but package.json's version there is ${found ?? 'missing'}; bump it to ${version} with node scripts/release.mjs and land again`);
  const tag = `v${version}`;
  const on = git(repo, 'rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`).out;
  if (on && on !== git(repo, 'rev-parse', commit).out) {
    fail(`land: tag ${tag} is already on ${git(repo, 'rev-parse', '--short', on).out}, not this release; release another version, or delete the tag if it was never pushed (git -C ${repo} tag -d ${tag}), and land again`);
  }
  return tag;
}

// Tags commit, the one just landed, when it is a release. → {tag} with tag null for no release, and err when the tag
// couldn't be made.
export function tagRelease(repo, commit) {
  let tag;
  try { tag = releaseTag(repo, commit); } catch (e) { return { tag: null, err: e.message }; }
  if (!tag || git(repo, 'rev-parse', '--verify', '--quiet', `refs/tags/${tag}`).ok) return { tag };
  const made = git(repo, 'tag', tag, commit);
  return made.ok ? { tag } : { tag: null, err: `could not tag ${tag} (${made.err})` };
}

// After the base branch reached origin: pushes tag when the board's "Push release tags" switch (permissions.mjs
// pushTags) is on. → {line} for the land's output, and failed, origin's refusal, when the push didn't go.
export function pushRelease(repo, tag, on) {
  const how = `push it with git -C ${repo} push origin ${tag}`;
  if (!on) return { line: `${tag} stays local while Push release tags is off; ${how}` };
  const pushed = git(repo, 'push', '--quiet', 'origin', `refs/tags/${tag}`);
  if (pushed.ok) return { line: `pushed ${tag} to origin` };
  return { line: `landed, but ${tag} didn't reach origin: ${pushed.err}; ${how}`, failed: pushed.err };
}
