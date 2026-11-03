// The mattpocock/skills an architecture review follows, a prerequisite kickflip installs with the skills CLI and
// never pins (docs/adr/0125-the-bulb-runs-an-architecture-review-of-the-boards-repo.md).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SKILLS_SOURCE = 'mattpocock/skills';
export const REVIEW_SKILLS = ['improve-codebase-architecture', 'codebase-design', 'grilling', 'prototype'];

export const skillFile = (name, home = os.homedir()) => path.join(home, '.claude', 'skills', name, 'SKILL.md');
export const missingSkills = (home = os.homedir()) => REVIEW_SKILLS.filter((name) => !fs.existsSync(skillFile(name, home)));

export const addArgv = (names) => ['--yes', 'skills', 'add', SKILLS_SOURCE, '-g', '-y', '-a', 'claude-code', '--skill', ...names];
export const addCommand = (names) => `npx skills add ${SKILLS_SOURCE} -g -y -a claude-code --skill ${names.join(' ')}`;
export const updateCommand = (names) => `npx skills update ${names.join(' ')} -g -y`;

// What the skills CLI recorded for each installed review skill from SKILLS_SOURCE: {name: folder path in the repo,
// folder hash}. The hash is the folder's git tree sha, so it compares with the repo's tree.
function lockedSkills(home) {
  let lock;
  try { lock = JSON.parse(fs.readFileSync(path.join(home, '.agents', '.skill-lock.json'), 'utf8')); } catch { return {}; }
  return Object.fromEntries(REVIEW_SKILLS.flatMap((name) => {
    const entry = lock?.skills?.[name];
    return entry?.source === SKILLS_SOURCE && entry.skillPath && entry.skillFolderHash ? [[name, { folder: path.posix.dirname(entry.skillPath), hash: entry.skillFolderHash }]] : [];
  }));
}

// → {missing, stale, checked}: the review skills not installed, the installed ones whose folder differs from the
// source's default branch, and whether that comparison ran. run(command, argv) → {status, stdout} reads the source's
// tree through gh.
export function skillsState({ home = os.homedir(), run, gh = true } = {}) {
  const missing = missingSkills(home);
  const locked = lockedSkills(home);
  const installed = REVIEW_SKILLS.filter((name) => !missing.includes(name) && locked[name]);
  if (!gh || !installed.length) return { missing, stale: [], checked: false };
  const tree = run('gh', ['api', `repos/${SKILLS_SOURCE}/git/trees/HEAD?recursive=1`, '--jq', '.tree[] | select(.type == "tree") | .path + " " + .sha']);
  if (tree.status !== 0) return { missing, stale: [], checked: false };
  const shas = new Map(tree.stdout.split('\n').filter(Boolean).map((line) => line.split(' ')));
  return { missing, stale: installed.filter((name) => shas.has(locked[name].folder) && shas.get(locked[name].folder) !== locked[name].hash), checked: true };
}

const list = (names) => (names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
// The sheet's words while a review waits on missing skills, or null when none is missing.
export function reviewWaits(home = os.homedir()) {
  const missing = missingSkills(home);
  if (!missing.length) return null;
  return `Architecture reviews wait on ${list(missing)} from ${SKILLS_SOURCE}, which ${missing.length === 1 ? 'isn’t' : 'aren’t'} installed. Run kickflip doctor --fix on the host to add ${missing.length === 1 ? 'it' : 'them'}.`;
}
