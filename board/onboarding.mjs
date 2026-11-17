import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildScriptError, listKickflipTargets, scriptsDirOf } from './build-script.mjs';

// docs/adr/2026-11-07-1000-a-new-board-starts-with-onboarding-to-dos.md
// The cards a new board starts with in Todo, grilling at once, so the first view is the process at work rather than an
// empty page. Each is a card with a notes file, whose body is the instruction its grill and builder read like any card's.

// docs/adr/2026-11-17-1451-a-boards-scripts-live-in-its-repo-or-in-kickflip.md: the scripts card's first-round
// question is where the board's scripts live, asked even when the repo already has some.
const HOME_QUESTION = 'Build scripts in the repo or in kickflip?';
const HOME_PART = (has) => `## First round

Ask the owner first, in the grill's first round: "${HOME_QUESTION}" Ask it even when the repo already has scripts.
- In kickflip (Recommended): the board keeps its own copies in its site's \`scripts/\` folder, written with \`board.mjs script set <name> --file <file>\` (mode 0700), so the repo needs no \`.kickflip/\` folder. One copy serves every task and main.
- In the repo: \`.kickflip/build\` and \`.kickflip/release\` committed to the repo, reviewed and landed like code, so a task can try a script change on its branch.

Then run \`board.mjs settings set scripts kickflip\` or \`board.mjs settings set scripts repo\`, and write the scripts the chosen home lacks. ${homeState(has)} Kickflip's scripts start empty: picking kickflip writes new ones there, and leaves the repo's \`.kickflip/\` as it is.
`;
const homeState = (has) => {
  const repo = [has.build && '`.kickflip/build`', has.release && '`.kickflip/release`'].filter(Boolean);
  const kickflip = [has.kickflip?.build && '`build`', has.kickflip?.release && '`release`'].filter(Boolean);
  return [repo.length ? `The repo's main has ${repo.join(' and ')}.` : "The repo's main has no scripts.",
    kickflip.length ? `Kickflip holds ${kickflip.join(' and ')} for this board.` : 'Kickflip holds none for this board.'].join(' ');
};

const BUILD_PART = `## Build script

The hub builds and serves a task's version of this repo by running one script, \`<build> <file>/<id> <worktree>\`, with the task's worktree as its working folder: the repo's \`.kickflip/build\`, or the board's \`build\` in kickflip.

Contract (docs/adr/2026-11-01-1846-a-boards-build-script-serves-or-builds-each-card-and-main.md):
- Print exactly \`port <n>\` on stdout to serve a website on that port.
- Or exit 0 with no port for an app build, publishing the install with \`board.mjs item set --install --install-sha\`.
- The file is a regular file, executable, writable by no one but its owner.

What this part does, when the chosen home has no build script:
- Look at the repo for what it builds: a website or server, an iOS or Android app, a CLI, a library with nothing to serve.
- If it finds one type, write \`build\` for it.
- If it finds several, ask the owner which the board should serve, write one \`build-<target>\` for each type the owner wants (for example \`build-web\`, \`build-ios\`), and set this board's Build target in Board Settings to the one picked.
- If nothing here builds, say so and write no build script.
`;

const RELEASE_PART = `## Release script

A release task is one whose commit subject is \`chore(release): <version>\`. When the board has a release script, the repo's \`.kickflip/release\` or the board's \`release\` in kickflip, land runs it for each release task, with no shell (docs/adr/2026-11-16-0200-a-repos-kickflip-release-replaces-lands-tag-release.md):
- \`<release> check <version> <commit>\` before landing: a non-zero exit refuses the land, and what it printed goes in the land's line.
- \`<release> ship <version> <commit>\` once main reached origin, while the board's Run release script box is on: a non-zero exit says the release didn't ship, and the land stands.
- Like the build script, the file is a regular file, executable, writable by no one but its owner.

What this part does, when the chosen home has no release script:
- Look at how the repo releases: a tag CI publishes from, a package registry, an app store, a deploy.
- If it releases, write \`release\` whose check confirms the version is ready (the version in the repo's manifest at <commit>, the tag or release not taken) and whose ship does the release (for example, tags <commit> and pushes the tag).
- If it has no release, say so and write no release script.
`;

const CONTEXT_PART = `- Write CONTEXT.md at the repo root: a glossary of the terms this project uses, one entry each with what it means and what to avoid calling it.
- Ask the owner what the project is for and which words they use for its parts; their wording goes in verbatim.
`;

const ADR_PART = `- Write the first ADR in docs/adr/, named docs/adr/YYYY-MM-DD-HHMM-<slug>.md, for the biggest decision the repo's shape shows: what was chosen and what was considered.
`;

export const SCRIPTS_CARD = 'Choose where the build scripts live, and prepare them';
// The cards a repo still needs, given what main already holds (has: build, release, context, adr, and kickflip:
// {build, release}, what the board's site holds). The scripts card is always there, for its first-round question; the
// CONTEXT card covers only the missing parts.
function cardsFor(has) {
  const cards = [{ title: SCRIPTS_CARD, notes: `# ${SCRIPTS_CARD}\n\n${[HOME_PART(has), BUILD_PART, RELEASE_PART].join('\n')}` }];
  const gaps = [!has.context && 'CONTEXT.md', !has.adr && 'ADR'].filter(Boolean);
  if (gaps.length === 2) {
    cards.push({ title: "Write the repo's CONTEXT.md glossary and first ADR", notes: `# Write CONTEXT.md and the first ADR\n\nTasks in this repo are grilled and built against its own words and decisions. This task writes them down.\n\nWhat this task does:\n${CONTEXT_PART}${ADR_PART}- If the repo already has a CONTEXT.md or ADRs, extend them rather than start again.\n` });
  } else if (!has.context) {
    cards.push({ title: "Write the repo's CONTEXT.md glossary", notes: `# Write CONTEXT.md\n\nTasks in this repo are grilled and built against its own words and decisions. This repo has its ADRs; this task writes down the words.\n\nWhat this task does:\n${CONTEXT_PART}` });
  } else if (!has.adr) {
    cards.push({ title: 'Write the first ADR', notes: `# Write the first ADR\n\nTasks in this repo are grilled and built against its own words and decisions. This repo has its CONTEXT.md; this task writes down the first decision.\n\nWhat this task does:\n${ADR_PART}- Use the words of CONTEXT.md.\n` });
  }
  return cards;
}

// What ref's tree in repo already holds: an executable .kickflip/build or .kickflip/build-<target>, an executable
// .kickflip/release, a CONTEXT.md and a docs/adr directory.
export function repoHas(repo, ref) {
  const ls = (p) => {
    try { return execFileSync('git', ['-C', repo, 'ls-tree', `${ref}:${p}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }); } catch { return ''; }
  };
  const kickflip = ls('.kickflip').split('\n');
  const root = ls('');
  return {
    build: kickflip.some((line) => /^100755 blob \S+\tbuild(-.+)?$/.test(line)),
    release: kickflip.some((line) => /^100755 blob \S+\trelease$/.test(line)),
    context: /^100\d+ blob \S+\tCONTEXT\.md$/m.test(root),
    adr: /^040000 tree \S+\tdocs$/m.test(root) && /^040000 tree \S+\tadr$/m.test(ls('docs')),
  };
}

// What the board in site already holds in kickflip: an executable scripts/build or scripts/build-<target>, and an
// executable scripts/release.
export function kickflipHas(site) {
  return { build: listKickflipTargets(site).length > 0 || !buildScriptError(path.join(scriptsDirOf(site), 'build')),
    release: !buildScriptError(path.join(scriptsDirOf(site), 'release')) };
}

// Writes the onboarding cards' notes files beside itemFile. → the items for that new item file, each a task keyed
// T-<n> with no ticket, so nothing is opened on GitHub or Linear until the card goes ready
// (docs/adr/2026-11-09-1500-a-task-is-a-card-with-no-ticket-keyed-t-n.md); a card is left out, or its notes narrowed,
// to what main lacks (docs/adr/2026-11-16-1100-onboarding-cards-cover-only-what-the-repo-lacks.md).
export function onboardingItems(itemFile, { has, now = new Date() }) {
  return cardsFor(has).map((c, i) => {
    const id = `T-${i + 1}`;
    const plan = `${id}-notes.md`;
    fs.writeFileSync(path.join(path.dirname(itemFile), plan), c.notes);
    return { id, title: c.title, created: new Date(now.getTime() + i).toISOString(), phase: 'grilling', plan };
  });
}
