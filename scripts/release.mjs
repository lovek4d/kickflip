// docs/adr/2026-11-11-1700-commits-are-conventional-and-name-their-card-in-a-refs-trailer.md
// docs/adr/2026-11-12-1251-land-tags-a-release-commit-and-pushes-the-tag.md
// `node scripts/release.mjs <x.y.z> --ref <ref>`, run by a release card's builder in its worktree: bumps package.json and
// package-lock.json to x.y.z and commits them, the message "chore(release): <x.y.z>" with the subjects landed since the
// last v* tag listed below it, oldest first, and the card's Refs trailer. It makes no tag: land tags the commit as it
// lands.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { releaseMessage } from '../board/commit-message.mjs';

const [version, flag, ref] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || flag !== '--ref' || !ref) {
  console.error('usage: node scripts/release.mjs <x.y.z> --ref <ref>');
  process.exit(1);
}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const last = git('describe', '--tags', '--abbrev=0', '--match', 'v*');
const subjects = git('log', '--reverse', '--no-merges', '--format=%s', `${last}..HEAD`).split('\n').filter(Boolean);
execFileSync('npm', ['version', version, '--no-git-tag-version'], { stdio: 'inherit' });
git('add', ...['package.json', 'package-lock.json'].filter((f) => fs.existsSync(f)));
execFileSync('git', ['commit', '--quiet', '-F', '-'], { input: releaseMessage(version, subjects, ref) });
