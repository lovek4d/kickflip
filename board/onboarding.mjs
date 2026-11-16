import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// docs/adr/2026-11-07-1000-a-new-board-starts-with-onboarding-to-dos.md
// The cards a new board starts with in Todo, grilling at once, so the first view is the process at work rather than an
// empty page. Each is a card with a notes file, whose body is the instruction its grill and builder read like any card's.

const BUILD_PART = `The hub builds and serves a task's version of this repo by running one script, \`.kickflip/build <file>/<id> <worktree>\`, in the task's worktree. This board has none on main yet.

Contract (docs/adr/2026-11-01-1846-a-boards-build-script-serves-or-builds-each-card-and-main.md):
- Print exactly \`port <n>\` on stdout to serve a website on that port.
- Or exit 0 with no port for an app build, publishing the install with \`board.mjs item set --install --install-sha\`.
- The file is a regular file in the repo, executable, writable by no one but its owner.

What this part does:
- Look at the repo for what it builds: a website or server, an iOS or Android app, a CLI, a library with nothing to serve.
- If it finds one type, write \`.kickflip/build\` for it.
- If it finds several, ask the owner which the board should serve, write one \`.kickflip/build-<target>\` for each type the owner wants (for example \`build-web\`, \`build-ios\`), and set this board's Build target in Board Settings to the one picked.
- If nothing here builds, say so and write no build script.
`;

const RELEASE_PART = `A release task is one whose commit subject is \`chore(release): <version>\`. When the repo has \`.kickflip/release\`, land runs it for each release task, with no shell (docs/adr/2026-11-16-0200-a-repos-kickflip-release-replaces-lands-tag-release.md):
- \`.kickflip/release check <version> <commit>\` before landing: a non-zero exit refuses the land, and what it printed goes in the land's line.
- \`.kickflip/release ship <version> <commit>\` once main reached origin, while the board's Run release script box is on: a non-zero exit says the release didn't ship, and the land stands.
- Like the build script, the file is a regular file in the repo, executable, writable by no one but its owner.

What this part does:
- Look at how the repo releases: a tag CI publishes from, a package registry, an app store, a deploy.
- If it releases, write \`.kickflip/release\` whose check confirms the version is ready (the version in the repo's manifest at <commit>, the tag or release not taken) and whose ship does the release (for example, tags <commit> and pushes the tag).
- If it has no release, say so and write no release script.
`;

const CONTEXT_PART = `- Write CONTEXT.md at the repo root: a glossary of the terms this project uses, one entry each with what it means and what to avoid calling it.
- Ask the owner what the project is for and which words they use for its parts; their wording goes in verbatim.
`;

const ADR_PART = `- Write the first ADR in docs/adr/, named docs/adr/YYYY-MM-DD-HHMM-<slug>.md, for the biggest decision the repo's shape shows: what was chosen and what was considered.
`;

// The cards a repo still needs, given what main already holds (has: build, release, context, adr). Each card's title
// and notes cover only the missing parts.
function cardsFor(has) {
  const cards = [];
  const needs = [!has.build && 'build', !has.release && 'release'].filter(Boolean);
  if (needs.length) {
    const what = needs.map((n) => `.kickflip/${n}`).join(' and ');
    const parts = [!has.build && BUILD_PART, !has.release && RELEASE_PART].filter(Boolean).join('\n');
    cards.push({ title: `Prepare ${what}`, notes: `# Prepare ${what}\n\n${parts}` });
  }
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
