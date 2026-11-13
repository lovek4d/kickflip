import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// docs/adr/2026-11-07-1000-a-new-board-starts-with-onboarding-to-dos.md
// The cards a new board starts with in Todo, grilling at once, so the first view is the process at work rather than an
// empty page. Each is a card with a notes file, whose body is the instruction its grill and builder read like any card's.

const BUILD_NOTES = `# Prepare .kickflip/build

The hub builds and serves a task's version of this repo by running one script, \`.kickflip/build <file>/<id> <worktree>\`, in the task's worktree. This board has none on main yet.

Contract (docs/adr/2026-11-01-1846-a-boards-build-script-serves-or-builds-each-card-and-main.md):
- Print exactly \`port <n>\` on stdout to serve a website on that port.
- Or exit 0 with no port for an app build, publishing the install with \`board.mjs item set --install --install-sha\`.
- The file is a regular file in the repo, executable, writable by no one but its owner.

What this task does:
- Look at the repo for what it builds: a website or server, an iOS or Android app, a CLI, a library with nothing to serve.
- If it finds one type, write \`.kickflip/build\` for it.
- If it finds several, ask the owner which the board should serve, write one \`.kickflip/build-<target>\` for each type the owner wants (for example \`build-web\`, \`build-ios\`), and set this board's Build target in Board Settings to the one picked.
- If nothing here builds, say so and write nothing.
`;

const CONTEXT_NOTES = `# Write CONTEXT.md and the first ADR

Tasks in this repo are grilled and built against its own words and decisions. This task writes them down.

What this task does:
- Write CONTEXT.md at the repo root: a glossary of the terms this project uses, one entry each with what it means and what to avoid calling it.
- Write the first ADR in docs/adr/, named docs/adr/YYYY-MM-DD-HHMM-<slug>.md, for the biggest decision the repo's shape shows: what was chosen and what was considered.
- Ask the owner what the project is for and which words they use for its parts; their wording goes in verbatim.
- If the repo already has a CONTEXT.md or ADRs, extend them rather than start again.
`;

const ONBOARDING = [
  { title: 'Prepare .kickflip/build', notes: BUILD_NOTES, needsNoBuild: true },
  { title: "Write the repo's CONTEXT.md glossary and first ADR", notes: CONTEXT_NOTES },
];

// Whether ref's tree in repo holds an executable .kickflip/build or .kickflip/build-<target>.
export function hasBuildScript(repo, ref) {
  try {
    const out = execFileSync('git', ['-C', repo, 'ls-tree', `${ref}:.kickflip`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
    return out.split('\n').some((line) => /^100755 blob \S+\tbuild(-.+)?$/.test(line));
  } catch { return false; }
}

// Writes the onboarding cards' notes files beside itemFile. → the items for that new item file, each a task keyed
// T-<n> with no ticket, so nothing is opened on GitHub or Linear until the card goes ready
// (docs/adr/2026-11-09-1500-a-task-is-a-card-with-no-ticket-keyed-t-n.md); the build card is left out when main already
// has a build script.
export function onboardingItems(itemFile, { hasBuild, now = new Date() }) {
  const cards = ONBOARDING.filter((c) => !(c.needsNoBuild && hasBuild));
  return cards.map((c, i) => {
    const id = `T-${i + 1}`;
    const plan = `${id}-notes.md`;
    fs.writeFileSync(path.join(path.dirname(itemFile), plan), c.notes);
    return { id, title: c.title, created: new Date(now.getTime() + i).toISOString(), phase: 'grilling', plan };
  });
}
