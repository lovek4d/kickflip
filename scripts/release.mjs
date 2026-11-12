// docs/adr/2026-11-11-1700-commits-are-conventional-and-name-their-card-in-a-refs-trailer.md
// `node scripts/release.mjs <x.y.z>`, run in the clone: npm version's commit and v<x.y.z> tag, the message
// "chore(release): <x.y.z>" with the subjects landed since the last v* tag listed below it, oldest first.
import { execFileSync } from 'node:child_process';
import { releaseMessage } from '../board/commit-message.mjs';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('usage: node scripts/release.mjs <x.y.z>');
  process.exit(1);
}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const last = git('describe', '--tags', '--abbrev=0', '--match', 'v*');
const subjects = git('log', '--reverse', '--no-merges', '--format=%s', `${last}..HEAD`).split('\n').filter(Boolean);
execFileSync('npm', ['version', version, '-m', releaseMessage(version, subjects)], { stdio: 'inherit' });
