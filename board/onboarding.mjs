import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildScriptError, listKickflipTargets, scriptsDirOf } from './build-script.mjs';

// docs/adr/2026-11-07-1000-a-new-board-starts-with-onboarding-to-dos.md
// The cards a new board starts with in Todo, grilling at once, so the first view is the process at work rather than an
// empty page. Each is a card with a notes file, whose body is the instruction its grill and builder read like any card's.

const BUILD_PART = `### Build script

The hub builds and serves a task's version of this repo by running one script, \`<build> <file>/<id> <worktree>\`, with the task's worktree as its working folder: the repo's \`.kickflip/build\`, or the board's \`build\` in kickflip.

Contract (docs/adr/2026-11-01-1846-a-boards-build-script-serves-or-builds-each-card-and-main.md):
- Print exactly \`port <n>\` on stdout to serve a website on that port.
- Or exit 0 with no port for an app build, publishing the install with \`board.mjs item set --install --install-sha\`.
- The file is a regular file, executable, writable by no one but its owner.

What this task does, when the chosen home has no build script:
- Look at the repo for what it builds: a website or server, an iOS or Android app, a CLI, a library with nothing to serve.
- If it finds one type, write \`build\` for it.
- If it finds several, ask the owner which the board should serve, write one \`build-<target>\` for each type the owner wants (for example \`build-web\`, \`build-ios\`), and set this board's Build target in Board Settings to the one picked.
- If nothing here builds, say so and write no build script.
`;

const TEST_PART = `### Test script

Every land, PR push and nightly suite runs the board's test script, the repo's \`.kickflip/test\` or the board's \`test\` in kickflip, as \`<test> <base>\`, with the run's worktree as its working folder (docs/adr/2026-11-21-2310-a-land-runs-its-repos-own-test-script.md). With none it runs the repo's node test files, and a repo with no node test files and no test script refuses to land.
- Exit non-zero to refuse the land; its last lines go in the refusal.
- A stub that exits 0 opts the repo out of tests, and its last line is said on each land.
- Like the build script, the file is a regular file, executable, writable by no one but its owner.

What this task does, when the chosen home has no test script and the repo has no node test files:
- Look at how the repo tests: a package script, a test runner's config, a CI workflow.
- If it tests, ask the owner for the command that runs the repo's tests, and write \`test\` to run it.
- If it has no tests, ask the owner whether to write a stub that exits 0 with a last line saying so, so the first land isn't refused.
`;

const RELEASE_PART = `### Release script

A release task is one whose commit subject is \`chore(release): <version>\`. When the board has a release script, the repo's \`.kickflip/release\` or the board's \`release\` in kickflip, land runs it for each release task, with no shell (docs/adr/2026-11-16-0200-a-repos-kickflip-release-replaces-lands-tag-release.md):
- \`<release> check <version> <commit>\` before landing: a non-zero exit refuses the land, and what it printed goes in the land's line.
- \`<release> ship <version> <commit>\` once main reached origin, while the board's Run release script box is on: a non-zero exit says the release didn't ship, and the land stands.
- Like the build script, the file is a regular file, executable, writable by no one but its owner.

What this task does, when the chosen home has no release script:
- Look at how the repo releases: a tag CI publishes from, a package registry, an app store, a deploy.
- If it releases, write \`release\` whose check confirms the version is ready (the version in the repo's manifest at <commit>, the tag or release not taken) and whose ship does the release (for example, tags <commit> and pushes the tag).
- If it has no release, say so and write no release script.
`;

// docs/adr/2026-11-23-1730-onboarding-asks-per-script-and-files-a-task-for-each.md
// The scripts card asks one question per script, in the order a land meets them, and files a task for each create.
const SCRIPTS = [
  { name: 'test', part: TEST_PART, what: 'Every land, PR push and nightly suite runs it.',
    without: "Lands run the repo's node test files, and a repo with none refuses to land." },
  { name: 'build', part: BUILD_PART, what: "The hub builds and serves each task's version of the repo with it.",
    without: "The board serves and builds no task's version of the repo." },
  { name: 'release', part: RELEASE_PART, what: 'Land checks and ships each `chore(release): <version>` task with it.',
    without: 'The board runs no release check or ship.' },
];

// The question for one script, given what each home holds: the home that already has it recommended and preselected,
// the repo's ahead of kickflip's; else kickflip recommended.
function scriptQuestion({ name, what, without }, has) {
  const inRepo = Boolean(has[name]);
  const inKickflip = Boolean(has.kickflip?.[name]);
  const repoLine = inRepo ? `The repo's main already has \`.kickflip/${name}\`.` : `The repo's main has no \`.kickflip/${name}\`.`;
  const kickflipLine = inKickflip ? `Kickflip ${inRepo ? 'also' : 'already'} holds \`${name}\` for this board.` : `Kickflip holds no \`${name}\` for this board.`;
  const pick = inRepo ? 'repo' : 'kickflip';
  const options = [
    { id: 'repo', label: 'Create in repo', detail: `\`.kickflip/${name}\` committed to the repo, reviewed and landed like code, so a task can try a script change on its branch.` },
    { id: 'kickflip', label: 'Create in kickflip', detail: `The board keeps its own \`${name}\` in its site's \`scripts/\` folder, written with \`board.mjs script set ${name} --file <file>\`, so the repo needs no \`.kickflip/\` folder. One copy serves every task and main.` },
    { id: 'none', label: "Don't create", detail: without },
  ].map((o) => (o.id === pick ? { ...o, recommended: true } : o));
  return { question: `Set up a ${name} script?`, context: `${what} ${repoLine} ${kickflipLine}`, options,
    ...(inRepo || inKickflip ? { suggested: { option: pick, reason: inRepo ? repoLine : kickflipLine } } : {}) };
}

const SCRIPTS_CARD = 'Choose the test, build and release scripts to set up';
const scriptsNotes = (has) => `# ${SCRIPTS_CARD}

This task asks which of the board's scripts to set up, and where, and files a task for each one the owner chooses. It writes no script itself.

## Questions

Ask the owner one round of exactly these questions, in this order, and nothing more: no split question, since the answers decide the tasks. Post them as given with \`board.mjs question add --file <json>\`, adding only each one's \`id\` and its \`topic\`, this task's. A script one home already has comes with that home's option recommended and preselected: \`suggested\`, whose reason the sheet shows as the Orchestrator choice.

\`\`\`json
${JSON.stringify(SCRIPTS.map((script) => scriptQuestion(script, has)), null, 2)}
\`\`\`

## After the answers

Judging this task when it stages:
- A board has one home for all its scripts, board.json \`scripts\` (docs/adr/2026-11-17-1451-a-boards-scripts-live-in-its-repo-or-in-kickflip.md), and never runs the other home's. When the creates name both homes, first ask the owner one more question, "Scripts home for all: repo or kickflip?", its context naming which scripts chose which home and each script the other home already has; that answer is every create's home.
- Set the home with \`board.mjs settings set scripts repo\` or \`board.mjs settings set scripts kickflip\`.
- File a task for each script answered Create, by the split path (SKILL.md, "A grill can propose a split"): \`item add\` with \`--parent <key> --split\`, staging or as an ask as the board's Automatically stage split tickets says. Its notes are that script's section below, its home, and whether the home already has the script. Each task does its own repo discovery and grill.
- Each script answered Don't create is a thread line on this task: "No <name> script: you chose not to create one."
- Close this task with \`item set <key> --done --split-into <the new keys>\`, or, with no create, \`--done --text\` saying so.

## Each script's task

When its home already has the script, the task reviews it against the contract and keeps it, changing only what breaks the contract. Kickflip's scripts start empty: picking kickflip writes new ones there, and leaves the repo's \`.kickflip/\` as it is.

${SCRIPTS.map((script) => script.part).join('\n')}`;

const CONTEXT_PART = `- Write CONTEXT.md at the repo root: a glossary of the terms this project uses, one entry each with what it means and what to avoid calling it.
- Ask the owner what the project is for and which words they use for its parts; their wording goes in verbatim.
`;

const ADR_PART = `- Write the first ADR in docs/adr/, named docs/adr/YYYY-MM-DD-HHMM-<slug>.md, for the biggest decision the repo's shape shows: what was chosen and what was considered.
`;

// The cards a repo still needs, given what main already holds (has: test, build, release, context, adr, and kickflip:
// {test, build, release}, what the board's site holds). The scripts card is always there, for its questions; the
// CONTEXT card covers only the missing parts.
function cardsFor(has) {
  const cards = [{ title: SCRIPTS_CARD, notes: scriptsNotes(has) }];
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

// What ref's tree in repo already holds: an executable .kickflip/test, .kickflip/build or .kickflip/build-<target>, an
// executable .kickflip/release, a CONTEXT.md and a docs/adr directory.
export function repoHas(repo, ref) {
  const ls = (p) => {
    try { return execFileSync('git', ['-C', repo, 'ls-tree', `${ref}:${p}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }); } catch { return ''; }
  };
  const kickflip = ls('.kickflip').split('\n');
  const root = ls('');
  return {
    test: kickflip.some((line) => /^100755 blob \S+\ttest$/.test(line)),
    build: kickflip.some((line) => /^100755 blob \S+\tbuild(-.+)?$/.test(line)),
    release: kickflip.some((line) => /^100755 blob \S+\trelease$/.test(line)),
    context: /^100\d+ blob \S+\tCONTEXT\.md$/m.test(root),
    adr: /^040000 tree \S+\tdocs$/m.test(root) && /^040000 tree \S+\tadr$/m.test(ls('docs')),
  };
}

// What the board in site already holds in kickflip: an executable scripts/test, scripts/build or
// scripts/build-<target>, and scripts/release.
export function kickflipHas(site) {
  return { test: !buildScriptError(path.join(scriptsDirOf(site), 'test')),
    build: listKickflipTargets(site).length > 0 || !buildScriptError(path.join(scriptsDirOf(site), 'build')),
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
