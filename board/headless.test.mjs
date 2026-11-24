import { home } from '../shared/scratch-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { freePorts, startBoard } from '../shared/test-helpers.mjs';
import { builderBrief, helperBrief, landerBrief, plannerBrief, rebaseBrief, visualBrief, stopAgents, agentMayRun, BOARD_CLI, CONTEXT_CAP, handoffLines, landByBuilder, resumeChoice, sessionState } from './headless.mjs';
import { reviveBuilders } from './runs.mjs';
import { briefFacts, archiveCards, builderProgress, builderResume, handBackCalls, readArchive, recordCall, threadFile, verifyCalls, writeBrief } from './store.mjs';
import { standardWords } from './commit-message.mjs';
import { SUMMARY_HINT } from './domain.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

// The server tests run the board server in this process (shared/test-helpers.mjs startBoard), so the board reads its
// manifest, logs and worktrees under the file's scratch HOME (shared/scratch-home.mjs), and calls no hub.
process.env.KICKFLIP_HUB_PORT = '1';

// The scratch HOME, emptied of what an earlier test left, whose server has closed.
function emptyHome() {
  for (const name of fs.readdirSync(home)) fs.rmSync(path.join(home, name), { recursive: true, force: true });
  return home;
}

// Tells the server of the test's writes to files as a store write does (with none, a change it can't name), and
// resolves once the passes they started have finished.
async function wrote(board, ...files) {
  if (!files.length) board.changed();
  for (const file of files) board.changed(file);
  await board.settled();
}

// docs/adr/2026-11-14-0009-the-board-server-takes-the-launcher-its-tests-pass.md
// The agents a board launches through startServer's launch, in order in runs: each run is launchAgent's arguments
// {kind, model, cwd, prompt, resume} with the pid and sessionId it answered. Each agent's process is a node that idles
// until gone(pid) ends it or the test ends, so the board's own liveness reads (pidAlive, ps) see it run; its log opens
// with the init event that names its session, as Claude's does. failWith(error) makes each launch from then reject.
function launcher(t) {
  const runs = [];
  const children = new Map();
  let failure = null;
  async function launch({ kind, model, cwd, prompt, resume, log }) {
    if (failure) throw failure;
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { detached: true, stdio: 'ignore' });
    children.set(child.pid, child);
    await once(child, 'spawn');
    const sessionId = `sess-${runs.length + 1}`;
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.appendFileSync(log, JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }) + '\n');
    runs.push({ kind, model, cwd, prompt, resume, pid: child.pid, sessionId });
    return { pid: child.pid, sessionId, log };
  }
  async function gone(pid) {
    const child = children.get(pid);
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  t.after(() => Promise.all([...children.keys()].map(gone)));
  return { runs, launch, gone, failWith: (error) => { failure = error; } };
}

// brief is the orchestrator's, which a grill, prototype or visual agent starts from; a builder's brief ignores it.
const card = { route: 'shop', key: 'w/A1', ref: 'ENG-1', title: 'Make it go', notes: '/s/waves/w/a1.md', worktree: '/wt/A1', base: 'main', rules: ['Use Node 22+'], thread: '/s/data/threads/w__A1.jsonl',
  brief: { heading: 'Brief for grill round 1', text: 'Settled: the footer folds.\nOpen: the phone layout.' } };

// docs/adr/2026-11-12-0600-every-planner-launches-from-the-orchestrators-brief.md
test("a grill's, a prototype's and a visual agent's brief open with the orchestrator's brief, before the thread and notes, and none is written without one", () => {
  const briefs = [plannerBrief({ ...card, kind: 'grill', repo: '/r/shop' }), plannerBrief({ ...card, kind: 'prototype', repo: '/r/shop' }), visualBrief({ ...card, repo: '/r/shop', agent: 'visual-1' })];
  for (const [brief, what] of briefs.map((b, i) => [b, ['questions', 'takes', 'page'][i]])) {
    assert.ok(brief.includes(`Start from the orchestrator's brief, its notes section "Brief for grill round 1": what the discussion settled, what is still open, and what your ${what} should cover, with the files that matter. Read it before the thread and the notes:\n\nSettled: the footer folds.\nOpen: the phone layout.\n`), what);
    assert.ok(brief.indexOf('Settled: the footer folds.') < brief.indexOf('1. Run') && brief.indexOf('1. Run') < brief.indexOf('item thread w/A1'), what);
  }
  for (const write of [() => plannerBrief({ ...card, kind: 'grill', repo: '/r/shop', brief: undefined }), () => visualBrief({ ...card, repo: '/r/shop', agent: 'v', brief: null })]) {
    assert.throws(write, /no orchestrator's brief/);
  }
  assert.ok(!builderBrief(card).includes('Settled: the footer folds.'), "a builder's brief has none");
});

// docs/adr/2026-11-04-0306-builders-launch-headless-check-their-notes-and-land-on-their-own.md
test("a headless builder's brief names its card, notes, worktree and rules, and has it report, ask, record calls and finish with builder done", () => {
  const brief = builderBrief(card);
  const b = `node ${BOARD_CLI} --site shop`;
  for (const want of [
    'ENG-1', 'Make it go', '/s/waves/w/a1.md', 'Work only in /wt/A1', 'Use Node 22+',
    `${b} builder start w/A1 --kind build`, `${b} builder progress w/A1 --phase`, `${b} builder call w/A1`, `${b} builder ask w/A1`,
    `${b} builder asks w/A1`, `${b} builder done w/A1 --risk low|medium|high --summary "${SUMMARY_HINT}" --text`, 'posts as the Builder\'s message in the thread, above your judgment calls', 'New on w/A1 while you build: …": take it in before you hand back.', "git -c core.commentChar=';' rebase main", 'Never push',
  ]) assert.ok(brief.includes(want), `the brief has ${want}`);
  assert.ok(!brief.includes('node --test'), 'the brief runs the affected tests, not the full suite');
  for (const phase of ['reading', 'building', 'checking', 'landing']) assert.ok(brief.includes(`- ${phase}:`), `the brief says what ${phase} means`);
  assert.ok(!brief.includes('testing'), 'the brief has no testing step');
});

// docs/adr/2026-11-24-0300-a-builder-writes-its-prs-body-by-the-repos-pr-guide.md
test("a builder's brief has it write the PR's body to a file by the repo's PR guide: the doc AGENTS.md names, else the PR template, else kickflip's default", () => {
  const b = `node ${BOARD_CLI} --site shop`;
  const wt = tempDir('pr-guide-');
  const bodyLine = (brief) => brief.split('\n').find((l) => l.startsWith('- --body-file'));
  const fallback = bodyLine(builderBrief({ ...card, worktree: wt }));
  assert.ok(builderBrief(card).includes(`${b} builder done w/A1 --risk low|medium|high --summary "${SUMMARY_HINT}" --text "<what you checked>" --body-file <path>`));
  assert.match(fallback, /^- --body-file <path> is the draft PR's body on a board with pull requests, markdown with no length cap; --text stays the short line of what you checked, the thread's closing line\. Write the body by kickflip's default PR guide, as this repo has none: ## Summary \(Problem \/ Solution \/ Impact\), ## Verification \(the commands you ran, on the base then on the branch, in a collapsed <details> block, and a "Not checked:" line\), ## Known limits when there are any, and ## Merge risk \(the level, a one-way or two-way door, the blast radius, the deploy order, the rollback, what to watch\)\. The merge squashes its Summary section, wrapped at 72, into the commit on main\.$/);
  fs.mkdirSync(path.join(wt, '.github'));
  fs.writeFileSync(path.join(wt, '.github', 'PULL_REQUEST_TEMPLATE.md'), '## What\n');
  assert.match(bodyLine(builderBrief({ ...card, worktree: wt })), /Write the body by the repo's PR guide, \.github\/PULL_REQUEST_TEMPLATE\.md, in the worktree: read it first\. The merge squashes/);
  fs.mkdirSync(path.join(wt, 'docs'));
  fs.writeFileSync(path.join(wt, 'docs', 'pull-requests.md'), '# PRs\n');
  fs.writeFileSync(path.join(wt, 'AGENTS.md'), '# Agents\n\nSee [the style guide](docs/style.md).\nPR descriptions follow [our guide](docs/pull-requests.md).\n');
  assert.match(bodyLine(builderBrief({ ...card, worktree: wt })), /Write the body by the repo's PR guide, docs\/pull-requests\.md, in the worktree: read it first\./);
  // A doc AGENTS.md names that isn't there falls through to the template.
  fs.rmSync(path.join(wt, 'docs', 'pull-requests.md'));
  assert.match(bodyLine(builderBrief({ ...card, worktree: wt })), /PR guide, \.github\/PULL_REQUEST_TEMPLATE\.md,/);
  // A builder launched with no worktree yet gets the default.
  assert.match(bodyLine(builderBrief({ ...card, worktree: null })), /by kickflip's default PR guide/);
  // A red-CI fix run keeps the open PR's body unless it has to change.
  assert.match(bodyLine(builderBrief({ ...card, fix: { pr: 9, failing: [] } })), /^- --body-file <path> replaces the open PR's body; leave it out to keep the body as it is\./);
});

// docs/adr/2026-11-16-1915-the-hub-status-opens-the-load-sheet-at-any-load-collapsed.md
test("a builder's brief has it stop any process it starts in the background before the command returns, never leaving one detached", () => {
  assert.match(builderBrief(card), /A process you start in the background \(CPU load such as `yes` to reproduce a flake, a server, a watcher\) you stop before the command that started it returns, with a `trap` or an explicit `kill`: never leave one running detached\. builder done refuses while one still runs in your worktree, and names it\./);
});

// docs/adr/2026-11-14-0600-builders-run-only-their-own-tests-and-the-land-runs-affected-once.md
test("a builder's brief runs only the tests it writes or changes, as it builds, and leaves the affected set and the rebase to the land", () => {
  const b = `node ${BOARD_CLI} --site shop`;
  for (const brief of [builderBrief(card), landerBrief(card)]) {
    assert.ok(!/rerun the tests|run the tests your change affects/.test(brief), 'it never runs the affected set itself');
    assert.ok(brief.includes('it rebases onto main once, runs the tests the change affects once'), 'the finish step runs them, once');
  }
  const brief = builderBrief(card);
  assert.ok(brief.includes(`run only the test files you write or change, with \`${b} test --dir /wt/A1 --base main\`, as part of building`), brief);
  assert.ok(brief.includes("don't rebase before you finish"), 'the land rebases');
  assert.ok(brief.includes("don't start the text with it"), 'the brief says not to lead with the phase word');
  assert.ok(!brief.includes(`${b} land`), 'done finishes the task, so the brief never runs land');
  assert.ok(brief.indexOf('builder call') < brief.indexOf(`${b} builder done`), 'calls come before the finishing step');
  assert.match(brief, /--risk is your judgment of .*: it colours the PR's Slack message for its reviewers\./, 'the brief says why it asks for risk');
  assert.match(builderBrief({ ...card, notes: null }), /no notes file/);
  assert.ok(brief.includes('tick each against evidence') && brief.includes('call "Missing: <deliverable>, <why>"'), "the brief has the builder tick the card's deliverables, a missing one a Missing: call");
  assert.ok(brief.indexOf('Missing: <deliverable>') < brief.indexOf(`${b} builder done`), 'the deliverables are ticked before the finishing step');
});

// docs/adr/2026-11-06-0200-the-board-rebases-a-conflicting-pr-with-a-headless-run.md
test("a rebase run's brief takes up the card, rebases its PR's branch onto origin's base keeping both sides and finishes with builder done, which runs the affected tests once, handing a failure back as a call", () => {
  const brief = rebaseBrief({ ...card, pr: 31 });
  const b = `node ${BOARD_CLI} --site shop`;
  for (const want of [
    `${b} builder start w/A1 --kind build --label Rebase --phase building --progress "Rebase run started · fetching main"`,
    'PR #31', 'Work only in /wt/A1', 'git fetch origin', "git -c core.commentChar=';' rebase origin/main", "keeping both sides' intent",
    '"Rebasing onto main · resolving', `${b} builder call w/A1 "Rebase failed in`, `${b} builder done w/A1 --text`, '--force-with-lease', 'Never push',
    'runs the tests the change affects once before it pushes',
  ]) assert.ok(brief.includes(want), `the rebase brief has ${want}`);
  assert.ok(!brief.includes(`${b} test`), 'its builder done runs the tests, so the run itself runs none');
  assert.ok(brief.indexOf('builder call') < brief.indexOf(`${b} builder done`), 'a failure is a call, before the finishing step');
});

// docs/adr/2026-11-19-1500-red-ci-on-a-cards-pr-launches-its-builder.md
test("a fix run's brief is the builder's with the PR's failing checks as its next, a Fix CI label, and no new PR", () => {
  const b = `node ${BOARD_CLI} --site shop`;
  const brief = builderBrief({ ...card, fix: { pr: 31, failing: ['lint', 'unit'] } });
  for (const want of [
    'This run fixes red CI', 'PR #31 is open and failing the checks lint, unit', 'gh run view <run id> --log-failed', 'Not caused by this change',
    `${b} builder start w/A1 --kind build --label "Fix CI"`, `${b} builder done w/A1 --risk`, 'opens no new PR', 'Never push',
  ]) assert.ok(brief.includes(want), `the fix brief has ${want}`);
  assert.ok(builderBrief({ ...card, fix: { pr: 31, failing: [] } }).includes('failing a check'), 'a PR with no named check');
  const plain = builderBrief(card);
  assert.ok(!plain.includes('red CI') && plain.includes(`${b} builder start w/A1 --kind build\``), 'a plain build is as before');
});

test("a resumed builder's land brief speaks to the builder, says why the land needs it, and keeps the lander's steps and label", () => {
  const brief = landerBrief({ ...card, resumed: true, why: 'rebasing A1 onto main conflicts in a.txt' });
  const b = `node ${BOARD_CLI} --site shop`;
  assert.match(brief, /^The board resumes you, the builder of task ENG-1 .* to land your build: rebasing A1 onto main conflicts in a\.txt/);
  assert.ok(!brief.includes('You are the headless lander'));
  for (const want of [`${b} builder start w/A1 --kind build --label Lander --phase landing`, `${b} builder done w/A1 --text`, 'Never push']) assert.ok(brief.includes(want), `it has ${want}`);
  assert.match(rebaseBrief({ ...card, pr: 31, resumed: true }), /^The board resumes you, the builder of task ENG-1/);
});

test("a lander's brief takes up the card's verified build, acts on the owner's answers, and finishes it with builder done", () => {
  const brief = landerBrief({ ...card, answers: [{ ask: 'ask1', question: 'Keep the badge?', answer: 'Drop it: too loud' }] });
  const b = `node ${BOARD_CLI} --site shop`;
  for (const want of [`${b} builder start w/A1 --kind build`, 'ask1 "Keep the badge?": Drop it: too loud', "git -c core.commentChar=';' rebase main", `${b} builder done w/A1 --text`, 'Never push']) {
    assert.ok(brief.includes(want), `the lander's brief has ${want}`);
  }
  assert.ok(brief.includes("don't start the text with it"), 'the lander brief says not to lead with the phase word');
  // Its start posts the landing line, so the card reads landing from the lander's first second.
  assert.ok(brief.includes(`${b} builder start w/A1 --kind build --label Lander --phase landing --progress "taking up the verified build"`), 'the lander starts on landing');
});

// docs/adr/2026-11-14-2300-picked-prototypes-draw-in-parallel-and-their-records-merge-by-topic.md
test("a prototype planner draws each prototype the brief names and each of the owner's requests as its own round, one sub-agent each on its own model, all at once, topics given out first", () => {
  const b = `node ${BOARD_CLI} --site shop`;
  const asks = [{ question: 'a1-foot', note: 'Neither: bolder' }, { question: 'a1-head', note: 'On a phone', choice: 'B' }, { text: 'Try a dark mode too', files: [{ name: 'shot.png', path: '/up/shot.png' }] }];
  const proto = plannerBrief({ ...card, kind: 'prototype', repo: '/r/shop', asks });
  for (const want of [
    'Draw each prototype as its own round, all at once: each prototype the orchestrator\'s brief names, which the owner picked from its suggestions, and each of the owner\'s requests below, one round each.',
    `Before any round is drawn, give each its own topic, in a-z, 0-9 and "-", that no other round and no prototype \`${b} prototype list\` shows uses.`,
    'launch one sub-agent per round with the Agent tool, all in one message so they draw in parallel, each on your own model (give it no model), a lone round too',
    'Brief each sub-agent with its topic, what its round shows, the request it answers and the rest of this step, which it does for its topic alone',
    'The owner\'s requests, one round each:',
    '- question a1-foot, noting "Neither: bolder": draw that question\'s next round, its question naming round_of a1-foot.',
    '- question a1-head, noting "On a phone", leaning to option B: draw that question\'s next round, its question naming round_of a1-head.',
    '- writing "Try a dark mode too", attaching /up/shot.png.',
  ]) assert.ok(proto.includes(want), want);
  // A served round's base worktree and build script are made once, before the fan-out.
  assert.ok(proto.includes(`run \`${b} prototype base\` yourself before the sub-agents launch`));
  // With no request, the brief's named prototypes are the rounds, or the planner finds the questions worth seeing.
  const none = plannerBrief({ ...card, kind: 'prototype', repo: '/r/shop' });
  assert.ok(!none.includes("The owner's requests") && none.includes('When the brief names none and no request names a question, find the design questions worth seeing yourself, one round each.'));
  // A grill draws no rounds.
  assert.ok(!plannerBrief({ ...card, kind: 'grill', repo: '/r/shop' }).includes('Agent tool'));
});

// docs/adr/2026-11-04-2130-the-hub-launches-every-agent-from-the-card.md
test("a headless planner's brief names its card and its notes so far, spells its steps out with the skill only an optional extra, and has it start, post questions and finish", () => {
  const b = `node ${BOARD_CLI} --site shop`;
  const grill = plannerBrief({ ...card, kind: 'grill', repo: '/r/shop' });
  for (const want of ['ENG-1', 'Make it go', '/s/waves/w/a1.md', 'grilling skill', `${b} builder start w/A1 --kind grill`, `${b} question add`, `${b} builder done w/A1`, 'docs/adr', 'Never push']) {
    assert.ok(grill.includes(want), `the grill's brief has ${want}`);
  }
  const proto = plannerBrief({ ...card, notes: null, kind: 'prototype', repo: '/r/shop', asks: [{ question: 'a1-look', note: 'Bigger', choice: 'B' }] });
  for (const want of ['prototype skill', `${b} builder start w/A1 --kind prototype`, `${b} prototype add`, 'a1-look', 'Bigger', 'B']) {
    assert.ok(proto.includes(want), `the prototype's brief has ${want}`);
  }
  assert.ok(!proto.includes('/s/waves/w/a1.md'));
  // docs/adr/2026-11-09-1100-the-board-owns-a-cards-notes-file.md: a planner hands its notes to the board as a draft.
  assert.ok(grill.includes(`${b} item notes w/A1 --heading "Grill (<MM/DD>)" --file <draft.md>`) && proto.includes(`${b} item notes w/A1 --heading "Prototype (<MM/DD>)" --file <draft.md>`));
  assert.ok(!(grill + proto).includes('--notes-file'));
  // docs/adr/2026-11-06-1700-a-boards-lessons-live-in-the-product.md: what a planner leaves open is a question, not a notes line.
  for (const brief of [grill, proto]) assert.ok(brief.includes('Anything you leave open becomes a question with question add, never only a line in the notes'));
  for (const brief of [grill, proto]) assert.ok(brief.includes("A question's text is one line of at most 100 characters") && brief.includes('which take markdown'));
  assert.ok(grill.includes(`${b} builder done w/A1`) && !grill.includes(`builder done w/A1 --text`));
  // docs/adr/2026-11-09-1300-a-prototype-round-is-take-files-unless-a-board-rule-asks-for-in-situ.md: take files by default.
  for (const want of ['Invoke the prototype skill with the Skill tool and build the round as take files', `${b} prototype add <topic> --card w/A1 --take <K>:<label>`, "repo's existing components", "Build in situ only where one of the board's rules asks for it"]) {
    assert.ok(proto.includes(want), `the prototype's brief has ${want}`);
  }
  assert.ok(proto.indexOf('--take <K>:<label> …`, write the take files') < proto.indexOf('prototype base'));
  assert.ok(!proto.includes('Only a repo whose app can'));
  // docs/adr/2026-11-06-1500-a-prototype-round-is-a-page-in-the-boards-base-worktree.md: where a rule asks for in situ, a
  // round is a page in the base prototype worktree, recorded --served, that takes ?variant= and ?state= and the viewer's message.
  for (const want of [`${b} prototype base`, '--served <path>', '--state <key>:<label>', '?variant=', '?state=', 'KickflipPrototype.on', 'real components', 'mock data', 'prints "port <n>"']) {
    assert.ok(proto.includes(want), `the prototype's brief has ${want}`);
  }
  assert.match(proto, /write no output code in .*?\/r\/shop itself/);
  assert.ok(grill.includes('write no output code there'));
  // docs/adr/2026-11-18-0100-implement-is-only-the-cards-tap.md: a grill ends on the card's Implement ask, never a
  // question offering Implement.
  assert.ok(grill.includes(`End the round on the task's Implement ask, never a question: as your last step, once your questions are added, run \`${b} thread w/A1 --implement --text "<what to answer first, then tap Implement>"\``));
  assert.ok(grill.includes("the board returns the task to discussing with Implement as its next action, and only the owner's Implement tap stages it"));
  assert.ok(grill.includes('No question offers Implement'));
  for (const brief of [grill, proto]) assert.ok(!brief.includes('next_gate') && !brief.includes('What next, given these answers?') && !brief.includes('Keep discussing'));
  assert.ok(!grill.includes('prototype_gate') && !grill.includes('Prototype round first?'));
  // docs/adr/2026-11-11-1700-a-cards-gates-are-facts-it-keeps.md: a kept yes moves the card to prototyping with no
  // Implement ask; a kept no or ran ends on the ask as any grill does.
  const yes = plannerBrief({ ...card, kind: 'grill', repo: '/r/shop', prototype: 'yes' });
  assert.ok(yes.includes("The task keeps the owner's answer to its prototype question, yes, so end with no Implement ask: once every question you ask is answered, or as you finish when you ask none, the board moves the task to prototyping."));
  assert.ok(!yes.includes('--implement'));
  for (const prototype of ['no', 'ran']) {
    const kept = plannerBrief({ ...card, kind: 'grill', repo: '/r/shop', prototype });
    assert.ok(kept.includes("End the round on the task's Implement ask"), prototype);
  }
  // docs/adr/2026-11-10-1600-tickets-are-made-at-ready.md: the grill never asks about a ticket, and says so.
  assert.ok(!grill.includes('ticket_gate') && !grill.includes('Create a ticket') && !proto.includes('ticket_gate'));
  assert.ok(grill.includes('Never ask whether to make a ticket: the board makes a task\'s ticket when it goes ready.'));
  // docs/adr/2026-11-07-1216-a-grill-can-propose-splitting-its-card-into-a-wave.md: a grill proposes a split as one question.
  assert.ok(grill.includes('separable parts') && grill.includes('"Split as proposed"') && grill.includes('"Keep as one task"'));
  // docs/adr/2026-11-09-2200-splits-and-waves-follow-vertical-slices-with-stated-conflicts.md: the slicing comes from /to-tickets, the conflicts are named per card.
  assert.ok(grill.includes('~/.claude/skills/to-tickets/SKILL.md') && grill.includes('step 3, "Draft vertical slices"'));
  assert.ok(grill.includes('the earlier proposed tasks it waits on, or none'));
  assert.ok(grill.includes('only when it builds on that task or shares its seam'));
  assert.ok(!grill.includes('which tasks build side by side'));
  assert.ok(!proto.includes('Split as proposed'));
  // A grill sets no ready itself: the owner's Implement tap moves the card; the owner asking for prototypes ends it prototyping.
  assert.ok(grill.includes(`end the task \`${b} item set w/A1 --phase prototyping\` instead and skip the Implement ask`));
  assert.ok(grill.includes("Otherwise the owner's Implement tap is what moves the task on"));
  assert.ok(grill.includes('never set it ready yourself'));
  assert.ok(grill.includes('never leave a Next that asks the owner to mark it ready'));
  assert.ok(!proto.includes('--phase ready'));
  // docs/adr/2026-11-05-0128-one-adapter-launches-claude-or-codex.md: Codex has no skills, so they're named only as extras.
  assert.ok(grill.includes('Invoke the grilling skill with the Skill tool') && proto.includes('Invoke the prototype skill with the Skill tool'));
  assert.ok(!/Follow the (grilling|prototype) skill/.test(grill + proto));
  // docs/adr/2026-11-05-0930-planners-run-the-skills-from-one-engineered-prompt.md: one round, board questions not chat, rules labelled.
  assert.ok(grill.includes('as one round') && grill.includes('never into the chat') && grill.includes('after the round, finish'));
  assert.ok(proto.includes('never asking in the chat'));
  const ruled = plannerBrief({ ...card, kind: 'grill', repo: '/r/shop', rules: ['Push main after every land'] });
  assert.match(ruled, /Rules from the hub and this board, written for the orchestrator:/);
  assert.ok(ruled.includes('- Push main after every land'));
  assert.ok(builderBrief({ ...card, rules: ['x'] }).includes('Rules from the hub and this board:\n- x'), "a builder's rules aren't relabelled");
});

// docs/adr/2026-11-18-2330-agents-read-the-cards-thread-and-notes-stop-copying-it.md
test("every brief tells its agent to read the card's thread with item thread, and a builder lets a later owner message beat the notes and reads it again in checking", () => {
  const t = 'item thread w/A1';
  const briefs = {
    builder: builderBrief(card), lander: landerBrief(card), rebase: rebaseBrief({ ...card, pr: 3 }), helper: helperBrief({ ...card, agent: 'h', task: 'x', cwd: '/wt/A1' }),
    grill: plannerBrief({ ...card, kind: 'grill', repo: '/r/shop' }), visual: visualBrief({ ...card, repo: '/r/shop', agent: 'v' }),
  };
  for (const [name, brief] of Object.entries(briefs)) assert.ok(brief.includes(t), `the ${name} brief names the thread command`);
  const builder = briefs.builder;
  assert.ok(builder.includes('who: love') && builder.includes("the owner's message wins") && !builder.includes('the notes win'), 'a later owner message beats the notes');
  assert.ok(builder.includes('Ask it only when you are blocked') && builder.includes('builder asks w/A1 --wait') && builder.includes('Found: <what>'), 'the brief asks only when blocked, waits with --wait, and files findings as calls');
  assert.ok(builder.includes('Read the thread again in checking'));
  assert.ok(briefs.grill.includes('never quotes of the owner'), 'a planner writes findings, never quotes of the thread');
});

// docs/adr/2026-11-05-0130-the-orchestrator-links-a-new-card-when-it-files-it.md
test("a builder's and a planner's brief list the card's related cards with their notes, for context only; a lander's doesn't", () => {
  const links = [
    { relation: 'related', ref: 'ENG-2', title: 'Sort the lane', lane: 'Todo', notes: '/s/waves/w/a2.md', thread: '/s/data/threads/w__A2.jsonl' },
    { relation: 'parent', ref: 'ENG-3', title: 'The lane', lane: 'Done', notes: null, thread: '/s/data/threads/w__A3.jsonl' },
  ];
  for (const brief of [builderBrief({ ...card, links }), plannerBrief({ ...card, kind: 'grill', repo: '/r/shop', links })]) {
    for (const want of ['Related tasks', "don't build their scope", 'ENG-2 "Sort the lane" (related, Todo): notes /s/waves/w/a2.md, thread /s/data/threads/w__A2.jsonl', 'ENG-3 "The lane" (parent, Done): no notes, thread /s/data/threads/w__A3.jsonl']) {
      assert.ok(brief.includes(want), `the brief has ${want}`);
    }
  }
  assert.ok(!builderBrief(card).includes('Related tasks'), 'a task with no links has no Related tasks line');
  assert.ok(!landerBrief({ ...card, links }).includes('Related tasks'));
});

test("briefFacts gives a card's links: Related to set on either card, its Parent and its deps, each with its ref, title, lane and notes path", async () => {
  const home = tempDir('brief-facts-');
  try {
    const site = path.join(home, 'site');
    fs.mkdirSync(path.join(site, 'data'), { recursive: true });
    fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'T', items: 'data/items.json', slug: 't' }));
    fs.writeFileSync(path.join(site, 'data', 'items.json'), JSON.stringify({ title: 'T', items: [
      { id: 'A1', title: 'One', parent: 'P1', deps: ['D1'], related: ['R1'] },
      { id: 'R1', title: 'Rel', plan: 'r1.md' },
      { id: 'R2', title: 'Rel back', lane: 'review', related: ['t/A1'] },
      { id: 'P1', title: 'Par', lane: 'done', closed_at: '2026-11-01T10:00:00Z' },
      { id: 'D1', title: 'Dep', lane: 'progress' },
      { id: 'X1', title: 'Other' },
    ] }));
    const { links } = await briefFacts(site, 't/A1');
    assert.deepEqual(links, [
      { relation: 'parent', ref: 'P1', title: 'Par', lane: 'Done', notes: null, thread: threadFile(site, 't/P1') },
      { relation: 'depends on', ref: 'D1', title: 'Dep', lane: 'In Progress', notes: null, thread: threadFile(site, 't/D1') },
      { relation: 'related', ref: 'R1', title: 'Rel', lane: 'Todo', notes: path.join(site, 'data', 'r1.md'), thread: threadFile(site, 't/R1') },
      { relation: 'related', ref: 'R2', title: 'Rel back', lane: 'In Review', notes: null, thread: threadFile(site, 't/R2') },
    ]);
    assert.equal((await briefFacts(site, 't/A1')).thread, threadFile(site, 't/A1'));
    assert.deepEqual((await briefFacts(site, 't/X1')).links, []);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("the server launches the builder for a tap and a pull instead of waking the session, and a lander once a handed-back card's calls are verified and no question is open", async (t) => {
  const home = emptyHome();
  const site = path.join(home, 'site');
  const data = path.join(site, 'data');
  fs.mkdirSync(path.join(data, 'threads'), { recursive: true });
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  const origin = path.join(home, 'origin');
  fs.mkdirSync(origin);
  git(origin, 'init', '--quiet', '-b', 'main');
  git(origin, 'config', 'user.name', 'Test');
  git(origin, 'config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(origin, 'a.txt'), 'a\n');
  git(origin, 'add', '-A');
  git(origin, 'commit', '--quiet', '-m', 'base');
  const clone = path.join(home, 'clone');
  git(home, 'clone', '--quiet', origin, clone);
  const manifest = path.join(home, '.claude', 'kickflip', 'manifest.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ sites: { shop: { dir: site, port: 1, cmd: ['node', '/x/board/server.mjs'], github: 'owner/project', branch: 'main', owner: { repo: clone } } } }));
  const boardJSON = (extra = {}) => fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'Shop', items: 'data/items.json', slug: 't', ...extra }));
  boardJSON();
  fs.writeFileSync(path.join(data, 'owner.json'), JSON.stringify({ topics: [], items: [{ id: 'h4q', topic: 'item:t/H4', question: 'Which?', options: [{ id: 'A', label: 'This' }] }] }));
  fs.writeFileSync(path.join(data, 'h1.md'), '# H1\n');
  const lander = path.join(home, 'lander-wt');
  fs.mkdirSync(lander);
  const verified = { started: '2026-11-04T01:00:00.000Z', done: '2026-11-04T02:00:00.000Z', kind: 'claude', model: 'opus', calls: [{ at: '2026-11-04T01:30:00.000Z', text: 'Kept it small' }], handed_back: '2026-11-04T02:00:00.000Z', verified: { at: '2026-11-04T03:00:00.000Z' }, worktree: { path: lander, branch: 'H3', repo: clone } };
  fs.mkdirSync(path.join(data, 'agents'));
  fs.writeFileSync(path.join(data, 'agents', 'H3.json'), JSON.stringify(verified));
  fs.writeFileSync(path.join(data, 'agents', 'H4.json'), JSON.stringify({ ...verified, worktree: { ...verified.worktree, path: lander, branch: 'H4' } }));
  fs.writeFileSync(path.join(data, 'items.json'), JSON.stringify({ items: [
    { id: 'H1', title: 'feat: tapped', phase: 'staging', size: 'large', plan: 'h1.md' },
    { id: 'H2', title: 'feat: pulled', phase: 'staging', size: 'large' },
    { id: 'H3', title: 'Verified', lane: 'progress', next: "Verify the builder's judgment calls" },
    { id: 'H4', title: 'Asked', lane: 'progress', next: "Answer the builder's questions" },
  ] }));
  const { runs, launch } = launcher(t);
  const log = () => (fs.existsSync(path.join(data, 'events.jsonl')) ? fs.readFileSync(path.join(data, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
  const thread = (id) => fs.readFileSync(path.join(data, 'threads', `t__${id}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
  const board = await startBoard(t, { site, launch });
  const { base } = board;
  await board.settled();
  // The verified card with no open question gets one lander; the one whose deferred ask waits on the owner gets none yet.
  assert.equal(runs.length, 1, 'the lander launches');
  const [landing] = runs;
  assert.equal(landing.cwd, lander);
  assert.match(landing.prompt, /builder done t\/H3 --text/);

  const tapped = await fetch(`${base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'card-build', key: 't/H1' }) }).then((r) => r.json());
  assert.equal(tapped.id, null);
  await board.settled();
  const worktree = path.join(home, '.claude', 'kickflip', 'worktrees', 'shop', 'H1');
  assert.equal(runs.length, 2, 'the tapped builder launches');
  const built = runs[1];
  assert.equal(fs.realpathSync(built.cwd), fs.realpathSync(worktree));
  assert.deepEqual([built.kind, built.resume], ['claude', undefined]);
  assert.ok(built.prompt.includes(path.join(data, 'h1.md')) && built.prompt.includes('builder start t/H1 --kind build'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'agents', 'H1.json'), 'utf8')).dispatched, 'tap');
  const launchLog = JSON.parse(fs.readFileSync(path.join(data, 'agents', 'H1.json'), 'utf8')).session.log;
  assert.match(launchLog, /^builder-H1-.*\.log$/);
  assert.ok(!thread('H1').some((m) => /launched on/.test(m.text)), 'no launch message');
  const logs = path.join(home, '.claude', 'kickflip', 'logs');
  fs.writeFileSync(path.join(logs, launchLog), 'x'.repeat(300_000) + '\nlast line\n');
  const tail = await fetch(`${base}/api/log?file=${launchLog}`).then((r) => r.json());
  assert.equal(tail.truncated, true);
  assert.ok(tail.text.endsWith('last line\n') && tail.text.length < 262_144);
  for (const bad of ['../../site/board.json', '..%2F..%2Fsite%2Fboard.json', 'a/b.log', '.hidden.log', 'notes.txt', '']) assert.equal((await fetch(`${base}/api/log?file=${bad}`)).status, 400, bad);
  assert.equal((await fetch(`${base}/api/log?file=missing.log`)).status, 404);
  // The transcript reads the whole log, start included, from a byte offset.
  fs.writeFileSync(path.join(logs, launchLog), `${JSON.stringify({ type: 'system', subtype: 'init', model: 'm', cwd: '/wt' })}\n${'x'.repeat(300_000)}\nlast line\npart`);
  const whole = await fetch(`${base}/api/transcript?file=${launchLog}&from=0`).then((r) => r.json());
  assert.deepEqual(whole.rows.map((row) => row.body.slice(0, 9)), ['m in /wt', 'x'.repeat(9), 'last line']);
  assert.deepEqual([whole.stream, whole.finished, whole.size - whole.next], [true, false, 4]);
  const after = await fetch(`${base}/api/transcript?file=${launchLog}&from=${whole.next}`).then((r) => r.json());
  assert.deepEqual([after.rows, after.next], [[], whole.next]);
  for (const bad of ['file=a/b.log&from=0', `file=${launchLog}&from=-1`, `file=${launchLog}&from=x`, `file=${launchLog}`]) assert.equal((await fetch(`${base}/api/transcript?${bad}`)).status, 400, bad);
  assert.equal((await fetch(`${base}/api/transcript?file=missing.log&from=0`)).status, 404);
  assert.match(await fetch(`${base}/log.html`).then((r) => r.text()), /api\/log\?file=/);
  assert.deepEqual(log().filter((e) => e.kind === 'card-build'), []);

  // A card readied after the start is pulled with no switch to turn on.
  const items = JSON.parse(fs.readFileSync(path.join(data, 'items.json'), 'utf8'));
  items.items.find((i) => i.id === 'H2').phase = 'ready';
  fs.writeFileSync(path.join(data, 'items.json'), JSON.stringify(items));
  await wrote(board, path.join(data, 'items.json'));
  assert.equal(runs.length, 3);
  assert.match(runs[2].prompt, /builder start t\/H2 --kind build/, 'the pulled builder launches');
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'agents', 'H2.json'), 'utf8')).dispatched, 'hub');
  assert.deepEqual(log().filter((e) => e.kind === 'card-pull' || e.kind === 'card-build'), []);

  // The owner's answer to H4's question lets its lander go, once.
  fs.writeFileSync(path.join(data, 'owner.json'), JSON.stringify({ topics: [], items: [{ id: 'h4q', topic: 'item:t/H4', question: 'Which?', options: [{ id: 'A', label: 'This' }], resolved: true, resolved_at: '2026-11-04T04:00:00.000Z' }] }));
  await wrote(board, path.join(data, 'owner.json'));
  assert.equal(runs.length, 4);
  assert.match(runs[3].prompt, /builder done t\/H4 --text/, "H4's lander launches");
  boardJSON({ title: 'Shop again' });
  await wrote(board, path.join(site, 'board.json'));
  assert.equal(runs.length, 4, 'each verification gets one lander');
});

// docs/adr/2026-11-06-0200-the-board-rebases-a-conflicting-pr-with-a-headless-run.md
test("the server starts a rebase run on each card whose open PR conflicts, in its worktree or one made from the PR's branch, once per conflict", async (t) => {
  const home = emptyHome();
  const site = path.join(home, 'site');
  const data = path.join(site, 'data');
  fs.mkdirSync(path.join(data, 'threads'), { recursive: true });
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  const origin = path.join(home, 'origin');
  fs.mkdirSync(origin);
  git(origin, 'init', '--quiet', '-b', 'main');
  git(origin, 'config', 'user.name', 'Test');
  git(origin, 'config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(origin, 'a.txt'), 'a\n');
  git(origin, 'add', '-A');
  git(origin, 'commit', '--quiet', '-m', 'base');
  git(origin, 'checkout', '--quiet', '-b', 'by-hand');
  fs.writeFileSync(path.join(origin, 'b.txt'), 'by hand\n');
  git(origin, 'add', '-A');
  git(origin, 'commit', '--quiet', '-m', 'R2 by hand');
  git(origin, 'checkout', '--quiet', 'main');
  const clone = path.join(home, 'clone');
  git(home, 'clone', '--quiet', origin, clone);
  const built = path.join(home, 'wt-R1');
  git(clone, 'worktree', 'add', '--quiet', '-b', 'R1', built, 'origin/main');
  const manifest = path.join(home, '.claude', 'kickflip', 'manifest.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ sites: { shop: { dir: site, port: 1, cmd: ['node', '/x/board/server.mjs'], github: 'owner/project', branch: 'main', owner: { repo: clone } } } }));
  const boardJSON = (extra = {}) => fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'Shop', items: 'data/items.json', slug: 't', ...extra }));
  boardJSON();
  fs.mkdirSync(path.join(data, 'agents'));
  fs.writeFileSync(path.join(data, 'agents', 'R1.json'), JSON.stringify({ label: 'Builder', kind: 'claude', model: 'opus', started: '2026-11-05T01:00:00.000Z', done: '2026-11-05T02:00:00.000Z', worktree: { path: built, branch: 'R1', repo: clone } }));
  fs.writeFileSync(path.join(data, 'items.json'), JSON.stringify({ items: [
    { id: 'R1', title: 'feat: built here', pr: 5 },
    { id: 'R2', title: 'feat: linked by hand', pr: 6 },
    { id: 'R3', title: 'Clean', pr: 7 },
  ] }));
  // The hub's check of each PR, which the board reads (server.mjs prViewOf).
  const view = (n, over) => ({ state: 'OPEN', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', checks: { total: 0, fail: 0, pending: 0, state: 'none' }, reviews: {}, headRefName: n === 6 ? 'by-hand' : `R${n - 4}`, ...over });
  fs.writeFileSync(path.join(home, '.claude', 'kickflip', 'github-state.json'), JSON.stringify({ prs: {
    'owner/project#5': view(5, { isDraft: true, mergeable: 'CONFLICTING', headRefOid: 'a'.repeat(40) }),
    'owner/project#6': view(6, { mergeable: 'CONFLICTING', headRefOid: 'b'.repeat(40) }),
    'owner/project#7': view(7, { headRefOid: 'c'.repeat(40) }),
  } }));
  const { runs, launch, gone } = launcher(t);
  const read = (file) => JSON.parse(fs.readFileSync(path.join(data, file), 'utf8'));
  const board = await startBoard(t, { site, launch });
  await board.settled();
  assert.equal(runs.length, 2, 'both rebase runs launch');
  const byCard = Object.fromEntries(runs.map((r) => [/builder start t\/(R\d)/.exec(r.prompt)[1], r]));
  assert.deepEqual(Object.keys(byCard).sort(), ['R1', 'R2'], 'the clean PR gets none');
  assert.equal(byCard.R1.cwd, built);
  assert.ok(byCard.R1.prompt.includes('builder start t/R1 --kind build --label Rebase') && byCard.R1.prompt.includes('PR #5'));
  const made = path.join(home, '.claude', 'kickflip', 'worktrees', 'shop', 'R2');
  assert.equal(fs.realpathSync(byCard.R2.cwd), fs.realpathSync(made));
  assert.equal(git(made, 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'by-hand'), "the hand-linked PR's worktree is made from its branch");
  assert.deepEqual([read('agents/R1.json').label, read('agents/R1.json').dispatched, read('agents/R1.json').done], ['Rebase', 'hub', undefined]);
  const items = read('items.json').items;
  assert.deepEqual(items.map((i) => i.rebase_run?.conflict ?? null), [`${'a'.repeat(40)}@main`, `${'b'.repeat(40)}@main`, null]);
  assert.deepEqual(Object.fromEntries(Object.entries(read('rebases.json')).map(([k, v]) => [k, v.conflict])), { 't/R1': `${'a'.repeat(40)}@main`, 't/R2': `${'b'.repeat(40)}@main` });
  const { items: cards } = await fetch(`${board.base}/api/board`).then((r) => r.json());
  assert.deepEqual(['t/R1', 't/R2'].map((k) => cards.find((c) => c.key === k).lane), ['review', 'review'], 'the run leaves the task in In Review');

  boardJSON({ title: 'Shop again' });
  await wrote(board, path.join(site, 'board.json'));
  assert.equal(runs.length, 2, 'each conflict gets one run');

  // docs/adr/2026-11-14-0725-one-land-step-decides-a-verified-cards-land.md: a run that exits with its record open is
  // relaunched once, then is a fault.
  await gone(byCard.R1.pid);
  await wrote(board);
  assert.equal(runs.length, 3, 'the dead run is relaunched');
  assert.ok(runs[2].prompt.includes('builder start t/R1 --kind build --label Rebase'), 'as the rebase run');
  assert.equal(read('rebases.json')['t/R1'].relaunched, 1);
  await gone(runs[2].pid);
  await wrote(board);
  await wrote(board);
  assert.equal(runs.length, 3, 'not relaunched twice');
  assert.equal(read('rebases.json')['t/R1'].handedBack, true);
  const lines = fs.readFileSync(threadFile(site, 't/R1'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((m) => m.line === 'exited-twice');
  assert.deepEqual(lines.map((m) => m.text), ['Its rebase run exited twice unfinished; it waits on the orchestrator.'], 'one fault line');
  const { items: after } = await fetch(`${board.base}/api/board`).then((r) => r.json());
  assert.equal(after.find((c) => c.key === 't/R1').orchestrator?.kind, 'stale', 'its card waits on the orchestrator');
});

// docs/adr/2026-11-19-1500-red-ci-on-a-cards-pr-launches-its-builder.md
test("the server launches a card's builder on the PR's branch when its ready PR's CI goes red, naming the failing check, once per red head", async (t) => {
  const home = emptyHome();
  const site = path.join(home, 'site');
  const data = path.join(site, 'data');
  fs.mkdirSync(path.join(data, 'threads'), { recursive: true });
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  const origin = path.join(home, 'origin');
  fs.mkdirSync(origin);
  git(origin, 'init', '--quiet', '-b', 'main');
  git(origin, 'config', 'user.name', 'Test');
  git(origin, 'config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(origin, 'a.txt'), 'a\n');
  git(origin, 'add', '-A');
  git(origin, 'commit', '--quiet', '-m', 'base');
  const clone = path.join(home, 'clone');
  git(home, 'clone', '--quiet', origin, clone);
  const built = path.join(home, 'wt-F1');
  git(clone, 'worktree', 'add', '--quiet', '-b', 'F1', built, 'origin/main');
  const manifest = path.join(home, '.claude', 'kickflip', 'manifest.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ sites: { shop: { dir: site, port: 1, cmd: ['node', '/x/board/server.mjs'], github: 'owner/project', branch: 'main', owner: { repo: clone } } } }));
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'Shop', items: 'data/items.json', slug: 't' }));
  fs.mkdirSync(path.join(data, 'agents'));
  fs.writeFileSync(path.join(data, 'agents', 'F1.json'), JSON.stringify({ label: 'Builder', kind: 'claude', model: 'opus', started: '2026-11-05T01:00:00.000Z', done: '2026-11-05T02:00:00.000Z', worktree: { path: built, branch: 'F1', repo: clone } }));
  fs.writeFileSync(path.join(data, 'items.json'), JSON.stringify({ items: [
    { id: 'F1', title: 'feat: red', pr: 5 },
    { id: 'F2', title: 'feat: green', pr: 6 },
    { id: 'F3', title: 'feat: red draft', pr: 7 },
  ] }));
  const view = (n, over) => ({ state: 'OPEN', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', checks: { total: 1, fail: 0, pending: 0, state: 'pass' }, failing: [], reviews: {}, headRefName: `F${n - 4}`, headRefOid: String(n).repeat(40), ...over });
  const write = (over) => fs.writeFileSync(path.join(home, '.claude', 'kickflip', 'github-state.json'), JSON.stringify({ prs: {
    'owner/project#5': view(5, { checks: { total: 1, fail: 1, pending: 0, state: 'fail' }, failing: ['unit', 'lint'], ...over }),
    'owner/project#6': view(6),
    'owner/project#7': view(7, { isDraft: true, checks: { total: 1, fail: 1, pending: 0, state: 'fail' }, failing: ['unit'] }),
  } }));
  write();
  const { runs, launch } = launcher(t);
  const read = (file) => JSON.parse(fs.readFileSync(path.join(data, file), 'utf8'));
  const board = await startBoard(t, { site, launch });
  await board.settled();
  assert.equal(runs.length, 1, "only the ready red PR's card gets a fix run: not the green one, nor the red draft");
  assert.equal(runs[0].cwd, built);
  for (const want of ['builder start t/F1 --kind build --label "Fix CI"', 'PR #5 is open and failing the checks lint, unit']) assert.ok(runs[0].prompt.includes(want), `the fix brief has ${want}`);
  const record = read('agents/F1.json');
  assert.deepEqual([record.label, record.dispatched, record.done], ['Fix CI', 'hub', undefined]);
  assert.deepEqual(read('fixes.json'), { 't/F1': `${'5'.repeat(40)}:lint,unit` });
  assert.deepEqual(read('items.json').items[0].fix_run.failing, ['lint', 'unit']);
  const thread = fs.readFileSync(threadFile(site, 't/F1'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(thread.some((m) => m.line === 'fix-run-started'), 'its thread says the fix run started');
  const { items: cards } = await fetch(`${board.base}/api/board`).then((r) => r.json());
  assert.equal(cards.find((c) => c.key === 't/F1').lane, 'progress', 'the fix builder takes it to In Progress');

  await wrote(board);
  assert.equal(runs.length, 1, 'each red head gets one run');
});

// docs/adr/2026-11-04-2230-a-lander-the-pause-stopped-starts-again.md
test('a lander whose process is gone while its builder record is open (the usage pause ended it) is launched again, and board.mjs lander does the same by hand', async (t) => {
  const home = emptyHome();
  const site = path.join(home, 'site');
  const data = path.join(site, 'data');
  fs.mkdirSync(path.join(data, 'agents'), { recursive: true });
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  const clone = path.join(home, 'clone');
  fs.mkdirSync(clone);
  git(clone, 'init', '--quiet', '-b', 'main');
  const manifest = path.join(home, '.claude', 'kickflip', 'manifest.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ sites: { shop: { dir: site, port: 1, cmd: ['node', '/x/board/server.mjs'], github: 'owner/project', branch: 'main', owner: { repo: clone } } } }));
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'Shop', items: 'data/items.json', slug: 't' }));
  const worktree = path.join(home, 'wt');
  fs.mkdirSync(worktree);
  const recordFile = path.join(data, 'agents', 'H3.json');
  const handedBack = { started: '2026-11-04T01:00:00.000Z', done: '2026-11-04T02:00:00.000Z', kind: 'claude', model: 'opus', calls: [{ at: '2026-11-04T01:30:00.000Z', text: 'Kept it small' }], handed_back: '2026-11-04T02:00:00.000Z', verified: { at: '2026-11-04T03:00:00.000Z' }, worktree: { path: worktree, branch: 'H3', repo: clone } };
  fs.writeFileSync(recordFile, JSON.stringify(handedBack));
  const waveFile = path.join(data, 'items.json');
  fs.writeFileSync(waveFile, JSON.stringify({ items: [{ id: 'H3', title: 'Verified', lane: 'progress', next: "Verify the builder's judgment calls" }] }));
  const { runs, launch, gone } = launcher(t);
  const record = () => JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  // Handed back: the record closed marked handed_back, with no build open since.
  const handedBackAgain = () => typeof record().done === 'string' && typeof record().handed_back === 'string' && record().started !== handedBack.started;
  let board = await startBoard(t, { site, launch });
  await board.settled();
  assert.equal(runs.length, 1, 'the lander launches');
  // The lander started (its builder start reopens the record) and then its process went with the pause.
  const landers = () => JSON.parse(fs.readFileSync(path.join(data, 'landers.json'), 'utf8'));
  assert.equal(landers()['t/H3'].pid, runs[0].pid, 'the lander is tracked');
  await gone(runs[0].pid);
  const building = () => {
    const { done: _, handed_back: __, ...open } = handedBack;
    fs.writeFileSync(recordFile, JSON.stringify({ ...open, label: 'Lander', started: new Date().toISOString() }));
    const w = JSON.parse(fs.readFileSync(waveFile, 'utf8')); w.items[0].next = 'Landing'; fs.writeFileSync(waveFile, JSON.stringify(w));
  };
  building();
  await wrote(board, recordFile, waveFile);
  assert.equal(runs.length, 2, 'the stopped lander launches again');
  assert.ok(handedBackAgain(), JSON.stringify(record()));
  // The one command does the same by hand, with the server stopped so its own pass cannot relaunch first.
  await board.close();
  building();
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bin', 'board.mjs');
  fs.mkdirSync(path.join(home, '.claude', 'kickflip', 'sites'), { recursive: true });
  fs.symlinkSync(site, path.join(home, '.claude', 'kickflip', 'sites', 'shop'));
  const out = execFileSync(process.execPath, [cli, '--site', 'shop', 'lander', 't/H3'], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert.match(out, /is handed back again/);
  assert.ok(handedBackAgain(), JSON.stringify(record()));
  assert.equal(landers()['t/H3'], undefined);
  board = await startBoard(t, { site, launch });
  await board.settled();
  assert.equal(runs.length, 3, 'the restarted server launches the lander again');
});

// docs/adr/2026-11-14-0725-one-land-step-decides-a-verified-cards-land.md
test('a lander that exited without landing on a checked card is relaunched once the host eases, and exiting again is a fault', async (t) => {
  const home = emptyHome();
  const site = path.join(home, 'site');
  const data = path.join(site, 'data');
  fs.mkdirSync(path.join(data, 'agents'), { recursive: true });
  const clone = path.join(home, 'clone');
  fs.mkdirSync(clone);
  execFileSync('git', ['-C', clone, 'init', '--quiet', '-b', 'main']);
  const kickflip = path.join(home, '.claude', 'kickflip');
  fs.mkdirSync(kickflip, { recursive: true });
  fs.writeFileSync(path.join(kickflip, 'manifest.json'), JSON.stringify({ sites: { shop: { dir: site, port: 1, cmd: ['node', '/x/board/server.mjs'], github: 'owner/project', branch: 'main', owner: { repo: clone } } } }));
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'Shop', items: 'data/items.json', slug: 't' }));
  const worktree = path.join(home, 'wt');
  fs.mkdirSync(worktree);
  const verified = '2026-11-14T03:54:50.052Z';
  // Verified and handed back; its lander was launched and has gone (builder start refused it on a busy host).
  fs.writeFileSync(path.join(data, 'agents', 'H4.json'), JSON.stringify({ started: '2026-11-13T20:00:00.000Z', done: '2026-11-13T21:00:00.000Z', kind: 'claude', model: 'opus', calls: [{ at: '2026-11-13T20:30:00.000Z', text: 'Kept it small' }], handed_back: '2026-11-13T21:00:00.000Z', verified: { at: verified }, worktree: { path: worktree, branch: 'H4', repo: clone } }));
  fs.writeFileSync(path.join(data, 'items.json'), JSON.stringify({ items: [{ id: 'H4', title: 'fix: verified', lane: 'progress' }] }));
  const landersFile = path.join(data, 'landers.json');
  fs.writeFileSync(landersFile, JSON.stringify({ 't/H4': { verified, pid: 2 ** 22 + 12345 } }));
  const busy = path.join(kickflip, 'machine-state.json');
  fs.writeFileSync(busy, JSON.stringify({ state: 'busy', reason: 'load high' }));
  const landers = () => JSON.parse(fs.readFileSync(landersFile, 'utf8'));
  const card = async () => (await fetch(`${board.base}/api/board`).then((r) => r.json())).items.find((c) => c.key === 't/H4');
  const { runs, launch, gone } = launcher(t);
  const board = await startBoard(t, { site, launch });
  await board.settled();
  assert.equal(runs.length, 0, 'none launches while the host is busy');
  assert.deepEqual(landers()['t/H4'], { verified, pid: 2 ** 22 + 12345 }, 'and the card stays due');
  assert.equal((await card()).land.words, 'Landing held: host busy');
  fs.writeFileSync(busy, JSON.stringify({ state: 'normal', reason: null }));
  await wrote(board);
  assert.equal(runs.length, 1, 'the host eased: a lander launches');
  assert.match(runs[0].prompt, /You are the headless lander/, 'a fresh lander, not the builder resumed again');
  assert.deepEqual([landers()['t/H4'].pid, landers()['t/H4'].relaunched], [runs[0].pid, 1]);
  assert.equal((await card()).land.step, 'running');
  await gone(runs[0].pid);
  await wrote(board);
  await wrote(board);
  assert.equal(runs.length, 1, 'the relaunched lander exited too: no third launch');
  assert.equal(landers()['t/H4'].handedBack, true);
  const faults = fs.readFileSync(threadFile(site, 't/H4'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((m) => m.line === 'exited-twice');
  assert.deepEqual(faults.map((m) => m.text), ['Its lander exited twice unfinished; it waits on the orchestrator.']);
  const faulted = await card();
  assert.deepEqual([faulted.land.step, faulted.orchestrator.kind], ['fault', 'stale']);
});

// docs/adr/2026-11-19-0242-a-bump-goes-first-in-every-queue.md
test("a bumped card's lander launches while the host is busy, and the unbumped one beside it waits", async (t) => {
  const home = emptyHome();
  const site = path.join(home, 'site');
  const data = path.join(site, 'data');
  fs.mkdirSync(path.join(data, 'agents'), { recursive: true });
  const clone = path.join(home, 'clone');
  fs.mkdirSync(clone);
  execFileSync('git', ['-C', clone, 'init', '--quiet', '-b', 'main']);
  const kickflip = path.join(home, '.claude', 'kickflip');
  fs.mkdirSync(kickflip, { recursive: true });
  fs.writeFileSync(path.join(kickflip, 'manifest.json'), JSON.stringify({ sites: { shop: { dir: site, port: 1, cmd: ['node', '/x/board/server.mjs'], github: 'owner/project', branch: 'main', owner: { repo: clone } } } }));
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'Shop', items: 'data/items.json', slug: 't' }));
  const verified = '2026-11-14T03:54:50.052Z';
  for (const id of ['H5', 'H6']) {
    const worktree = path.join(home, `wt-${id}`);
    fs.mkdirSync(worktree);
    fs.writeFileSync(path.join(data, 'agents', `${id}.json`), JSON.stringify({ started: '2026-11-13T20:00:00.000Z', done: '2026-11-13T21:00:00.000Z', kind: 'claude', model: 'opus', calls: [{ at: '2026-11-13T20:30:00.000Z', text: 'Kept it small' }], handed_back: '2026-11-13T21:00:00.000Z', verified: { at: verified }, worktree: { path: worktree, branch: id, repo: clone } }));
  }
  fs.writeFileSync(path.join(data, 'items.json'), JSON.stringify({ items: [{ id: 'H5', title: 'fix: unbumped', lane: 'progress' }, { id: 'H6', title: 'fix: bumped', lane: 'progress' }] }));
  fs.writeFileSync(path.join(data, 'events.jsonl'), `${JSON.stringify({ id: 'cb1', ts: '2026-11-14T04:00:00.000Z', kind: 'card-bump', data: { key: 't/H6' } })}\n`);
  fs.writeFileSync(path.join(kickflip, 'machine-state.json'), JSON.stringify({ state: 'busy', reason: 'load high' }));
  const card = async (key) => (await fetch(`${board.base}/api/board`).then((r) => r.json())).items.find((c) => c.key === key);
  const { runs, launch } = launcher(t);
  const board = await startBoard(t, { site, launch });
  await board.settled();
  assert.equal(runs.length, 1, 'only the bumped card lands');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(data, 'landers.json'), 'utf8'))), ['t/H6']);
  assert.equal((await card('t/H5')).land.words, 'Landing held: host busy');
  assert.equal((await card('t/H6')).land.step, 'running');
});

// A handed-back build with no calls has nothing to land until builder verified marks it; a gone worktree reads so on
// the card and launches nothing, and once it is back the next pass launches the lander.
test('builder verified on a no-call handed-back build lets the next pass launch its lander, which a gone worktree skips', async (t) => {
  const home = emptyHome();
  const site = path.join(home, 'site');
  const data = path.join(site, 'data');
  fs.mkdirSync(path.join(data, 'agents'), { recursive: true });
  const clone = path.join(home, 'clone');
  fs.mkdirSync(clone);
  execFileSync('git', ['-C', clone, 'init', '--quiet', '-b', 'main']);
  const kickflip = path.join(home, '.claude', 'kickflip');
  fs.mkdirSync(kickflip, { recursive: true });
  fs.writeFileSync(path.join(kickflip, 'manifest.json'), JSON.stringify({ sites: { shop: { dir: site, port: 1, cmd: ['node', '/x/board/server.mjs'], github: 'owner/project', branch: 'main', owner: { repo: clone } } } }));
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'Shop', items: 'data/items.json', slug: 't' }));
  const worktree = path.join(home, 'wt');
  const recordFile = path.join(data, 'agents', 'H5.json');
  fs.writeFileSync(recordFile, JSON.stringify({ started: '2026-11-13T20:00:00.000Z', done: '2026-11-13T21:00:00.000Z', kind: 'claude', model: 'opus', handed_back: '2026-11-13T21:00:00.000Z', worktree: { path: worktree, branch: 'H5', repo: clone } }));
  const waveFile = path.join(data, 'items.json');
  fs.writeFileSync(waveFile, JSON.stringify({ items: [{ id: 'H5', title: 'fix: verified', lane: 'progress' }] }));
  const card = async () => (await fetch(`${board.base}/api/board`).then((r) => r.json())).items.find((c) => c.key === 't/H5');
  const { runs, launch } = launcher(t);
  const board = await startBoard(t, { site, launch });
  await board.settled();
  assert.deepEqual([runs.length, (await card()).land], [0, null], 'unverified: nothing to land');
  await verifyCalls(site, 't/H5', {});
  await wrote(board, recordFile);
  assert.equal(runs.length, 0, 'its worktree is gone: no lander');
  const gone = await card();
  assert.deepEqual([gone.land.step, gone.land.words, gone.orchestrator.kind], ['worktree-gone', "Lander can't start: its worktree is gone", 'stale']);
  fs.mkdirSync(worktree);
  await wrote(board, recordFile);
  assert.equal(runs.length, 1, 'the next pass launches its lander');
  assert.equal((await card()).land.step, 'running');
});

// docs/adr/2026-11-04-1010-a-dead-headless-builder-is-relaunched-once.md
test('a headless builder whose process exited with its record open is relaunched once, then handed back; one held by the pause launches when asked; a closed record drops', async () => {
  const launched = [];
  const handed = [];
  const launch = async ({ key, model }) => { launched.push(key); return { pid: 900 + launched.length }; };
  const handBack = async (card) => { handed.push(card); };
  const alive = (pid) => pid === 1;
  const open = new Set(['w/A', 'w/B', 'w/C', 'w/D']);
  const tracked = {
    'w/A': { model: 'opus', pid: 1, relaunched: false },
    'w/B': { model: 'sonnet', pid: 2, relaunched: false },
    'w/C': { model: 'opus', pid: 3, relaunched: true },
    'w/D': { model: 'opus', pid: null, relaunched: false },
    'w/E': { model: 'opus', pid: 4, relaunched: false },
  };
  const next = await reviveBuilders(tracked, open, { launch, handBack, alive });
  assert.deepEqual(launched, ['w/B', 'w/D']);
  assert.deepEqual(handed, [{ key: 'w/C', model: 'opus' }]);
  assert.deepEqual(next, {
    'w/A': tracked['w/A'],
    'w/B': { model: 'sonnet', pid: 901, relaunched: true },
    'w/C': { ...tracked['w/C'], handedBack: true },
    'w/D': { model: 'opus', pid: 902, relaunched: false },
  });
  // A handed-back build stays tracked, so its card reads stopped, and is handed back only once.
  const again = await reviveBuilders({ 'w/C': next['w/C'] }, open, { launch, handBack, alive });
  assert.deepEqual([again, handed.length, launched.length], [{ 'w/C': next['w/C'] }, 1, 2]);
});

// docs/adr/2026-11-05-0128-one-adapter-launches-claude-or-codex.md
test("a tracked builder whose kind its usage holds waits, launched or not, while the other kind's builders revive", async () => {
  const launched = [];
  const launch = async ({ key }) => { launched.push(key); return { pid: 900 + launched.length }; };
  const tracked = {
    'w/A': { kind: 'codex', pid: null, relaunched: false },
    'w/B': { kind: 'codex', pid: 2, relaunched: false },
    'w/C': { kind: 'claude', model: 'opus', pid: null, relaunched: false },
  };
  const next = await reviveBuilders(tracked, new Set(Object.keys(tracked)), { launch, handBack: async () => assert.fail('nothing is handed back'), alive: () => false, held: (kind) => kind === 'codex' });
  assert.deepEqual(launched, ['w/C']);
  assert.deepEqual(next, { 'w/A': tracked['w/A'], 'w/B': tracked['w/B'], 'w/C': { kind: 'claude', model: 'opus', pid: 901, relaunched: false } });
});

// docs/adr/2026-11-19-0242-a-bump-goes-first-in-every-queue.md
test('held builders launch bumped first, the earliest bump first, and a busy host holds only the unbumped ones', async () => {
  const launched = [];
  const launch = async ({ key }) => { launched.push(key); return { pid: 900 + launched.length }; };
  const tracked = Object.fromEntries(['w/A', 'w/B', 'w/C', 'w/D'].map((k) => [k, { kind: 'claude', model: 'opus', pid: null, relaunched: false }]));
  const bumps = { 'w/C': '2026-11-18T11:00:00.000Z', 'w/D': '2026-11-18T10:00:00.000Z' };
  const opts = { launch, handBack: async () => assert.fail('nothing is handed back'), alive: () => false, bumpOf: (key) => bumps[key] ?? null };
  const busy = await reviveBuilders(tracked, new Set(Object.keys(tracked)), { ...opts, held: (_, bumped) => !bumped });
  assert.deepEqual(launched, ['w/D', 'w/C']);
  assert.deepEqual(Object.keys(busy), ['w/A', 'w/B', 'w/C', 'w/D'], 'the map keeps its own order');
  assert.deepEqual([busy['w/A'], busy['w/D'].pid], [tracked['w/A'], 901]);
  launched.length = 0;
  await reviveBuilders(tracked, new Set(Object.keys(tracked)), opts);
  assert.deepEqual(launched, ['w/D', 'w/C', 'w/A', 'w/B']);
});

// docs/adr/2026-11-06-1249-the-pause-line-reads-every-headless-agents-usage.md,
// docs/adr/2026-11-09-1300-a-card-pause-stops-its-builder-at-its-next-stopping-point.md
test('a builder that exited on the usage limit keeps its one relaunch: it pauses, and a paused build is never relaunched', async () => {
  const reset = '2026-11-06T12:10:00.000Z';
  const launched = [];
  const limits = [];
  const launch = async ({ key }) => { launched.push(key); return { pid: 900 + launched.length, log: `/logs/${key}-2` }; };
  const tracked = {
    'w/A': { kind: 'claude', model: 'opus', pid: 1, relaunched: false, log: '/logs/A' },
    'w/B': { kind: 'claude', model: 'opus', pid: 2, relaunched: true, log: '/logs/B' },
    'w/C': { kind: 'claude', model: 'opus', pid: 3, relaunched: false, log: '/logs/C' },
  };
  const limitedUntil = (entry) => (entry.log === '/logs/C' ? null : reset);
  const opts = { launch, handBack: async () => assert.fail('nothing is handed back'), alive: () => false, limitedUntil, atLimit: async (card, at) => limits.push([card.key, at]) };
  const held = await reviveBuilders(tracked, new Set(Object.keys(tracked)), { ...opts, held: () => true });
  assert.deepEqual(launched, []);
  assert.deepEqual(limits, [['w/A', reset], ['w/B', reset]]);
  assert.deepEqual(held, { 'w/A': { ...tracked['w/A'], pid: null }, 'w/B': { ...tracked['w/B'], pid: null }, 'w/C': tracked['w/C'] });
  const later = await reviveBuilders(held, new Set(Object.keys(held)), { ...opts, paused: new Set(['w/A', 'w/B']) });
  assert.deepEqual(launched, ['w/C'], 'the paused ones wait for the board to resume them');
  assert.deepEqual([later['w/A'], later['w/B']], [held['w/A'], held['w/B']]);
});

// docs/adr/2026-11-04-1010-a-dead-headless-builder-is-relaunched-once.md
test("the server's minute check relaunches a tracked headless builder whose process died with its record open", async (t) => {
  const home = emptyHome();
  const site = path.join(home, 'site');
  const data = path.join(site, 'data');
  fs.mkdirSync(path.join(data, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(data, 'threads'));
  const wt = path.join(home, 'wt');
  fs.mkdirSync(wt);
  const manifest = path.join(home, '.claude', 'kickflip', 'manifest.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ sites: { shop: { dir: site, port: 1, cmd: ['node', '/x/board/server.mjs'], github: 'owner/project', branch: 'main', owner: { repo: wt } } } }));
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'Shop', items: 'data/items.json', slug: 't' }));
  fs.writeFileSync(path.join(data, 'items.json'), JSON.stringify({ items: [{ id: 'R1', title: 'Revive me', lane: 'progress' }] }));
  fs.writeFileSync(path.join(data, 'agents', 'R1.json'), JSON.stringify({ started: '2026-11-04T01:00:00.000Z', kind: 'claude', model: 'opus', worktree: { path: wt, branch: 'R1', repo: wt } }));
  const dead = spawn(process.execPath, ['-e', '']);
  await once(dead, 'exit');
  fs.writeFileSync(path.join(data, 'headless-builders.json'), JSON.stringify({ 't/R1': { model: 'opus', pid: dead.pid, relaunched: false } }));
  const { runs, launch } = launcher(t);
  const board = await startBoard(t, { site, launch });
  await board.settled();
  board.minute();
  await board.settled();
  assert.equal(runs.length, 1, 'the dead builder is relaunched');
  assert.match(runs[0].prompt, /builder start t\/R1 --kind build/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'headless-builders.json'), 'utf8'))['t/R1'].relaunched, true, 'the relaunch is tracked');
  // The launch names its session, which goes on the card's builder record.
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'agents', 'R1.json'), 'utf8')).session.id, runs[0].sessionId);
  assert.match(JSON.parse(fs.readFileSync(path.join(data, 'agents', 'R1.json'), 'utf8')).session.log, /^builder-R1-.*\.log$/);
  // docs/adr/2026-11-05-0913-the-hub-and-each-board-keep-an-audit-log-of-the-calls-their-code-makes.md
  const logged = fs.readFileSync(path.join(data, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.call === 'relaunch');
  assert.deepEqual({ ...logged, at: undefined }, { at: undefined, call: 'relaunch', key: 't/R1', result: 'relaunched', reason: 'Its builder exited with its record open, for the first time.', inputs: { model: 'opus', pid: dead.pid, relaunched: false } });
});

// docs/adr/2026-11-05-2130-a-restarted-server-launches-the-build-its-pull-left-without-a-builder.md
test("a restarted server launches the builder of an In Progress card whose record is still dispatched and untracked, and leaves a planner and a tracked one alone", async (t) => {
  const home = emptyHome();
  const site = path.join(home, 'site');
  const data = path.join(site, 'data');
  fs.mkdirSync(path.join(data, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(data, 'threads'));
  const wt = path.join(home, 'wt');
  fs.mkdirSync(wt);
  const manifest = path.join(home, '.claude', 'kickflip', 'manifest.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ sites: { shop: { dir: site, port: 1, cmd: ['node', '/x/board/server.mjs'], github: 'owner/project', branch: 'main', owner: { repo: wt } } } }));
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'Shop', items: 'data/items.json', slug: 't' }));
  fs.writeFileSync(path.join(data, 'items.json'), JSON.stringify({ items: ['C1', 'C2', 'C3', 'C4', 'C5'].map((id) => ({ id, title: id, lane: 'progress' })) }));
  const record = (extra) => JSON.stringify({ started: '2026-11-05T04:42:41.000Z', kind: 'claude', model: 'sonnet', worktree: { path: wt, branch: 'x', repo: wt }, ...extra });
  fs.writeFileSync(path.join(data, 'agents', 'C1.json'), record({ dispatched: 'hub' }));
  fs.writeFileSync(path.join(data, 'agents', 'C2.json'), record({ dispatched: 'hub', kind: 'grill' }));
  fs.writeFileSync(path.join(data, 'agents', 'C3.json'), record({ dispatched: 'hub' }));
  fs.writeFileSync(path.join(data, 'agents', 'C4.json'), record({}));
  // A session's dispatch opens the record for an agent the session launches itself, with no kind, model or worktree.
  fs.writeFileSync(path.join(data, 'agents', 'C5.json'), JSON.stringify({ started: '2026-11-05T04:42:41.000Z', label: 'Builder', dispatched: 'session' }));
  fs.writeFileSync(path.join(data, 'headless-builders.json'), JSON.stringify({ 't/C3': { model: 'opus', pid: process.pid, relaunched: false } }));
  const { runs, launch } = launcher(t);
  const board = await startBoard(t, { site, launch });
  await board.settled();
  assert.equal(runs.length, 1, 'the cut-off builder launches, and only it');
  assert.match(runs[0].prompt, /builder start t\/C1 --kind build/);
  // It runs as its record's pick, in its record's worktree, which its brief names.
  assert.deepEqual([runs[0].kind, runs[0].model, runs[0].cwd], ['claude', 'sonnet', wt]);
  assert.ok(runs[0].prompt.includes(`Work only in ${wt}`));
  assert.equal(JSON.parse(fs.readFileSync(path.join(data, 'headless-builders.json'), 'utf8'))['t/C1']?.relaunched, false, 'the launch is tracked');
});

// docs/adr/2026-11-18-2000-builder-start-takes-up-a-launch.md
test("a restarted server restarts in place a card In Progress with nothing building it, with no record or a finished one, and leaves one with an open record, a Next, a hand-back, a hold or in Todo alone", async (t) => {
  const home = emptyHome();
  const site = path.join(home, 'site');
  const data = path.join(site, 'data');
  fs.mkdirSync(path.join(data, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(data, 'threads'));
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  const origin = path.join(home, 'origin');
  fs.mkdirSync(origin);
  git(origin, 'init', '--quiet', '-b', 'main');
  git(origin, 'config', 'user.name', 'Test');
  git(origin, 'config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(origin, 'a.txt'), 'a\n');
  git(origin, 'add', '-A');
  git(origin, 'commit', '--quiet', '-m', 'base');
  const wt = path.join(home, 'clone');
  git(home, 'clone', '--quiet', origin, wt);
  const manifest = path.join(home, '.claude', 'kickflip', 'manifest.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ sites: { shop: { dir: site, port: 1, cmd: ['node', '/x/board/server.mjs'], github: 'owner/project', branch: 'main', owner: { repo: wt } } } }));
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'Shop', items: 'data/items.json', slug: 't' }));
  const at = '2026-11-15T22:25:56.000Z';
  const card = (id, extra) => ({ id, title: `fix(board): ${id}`, lane: 'progress', lane_at: at, ...extra });
  fs.writeFileSync(path.join(data, 'items.json'), JSON.stringify({ items: [card('L1'), card('L2'), card('L3', { held: 'owner' }), card('L4', { lane: 'todo' }),
    card('L5'), card('L6', { next: 'Waits on the owner' }), card('L7')] }));
  const tree = { path: wt, branch: 'x', repo: wt };
  const done = '2026-11-15T23:00:00.000Z';
  fs.writeFileSync(path.join(data, 'agents', 'L2.json'), JSON.stringify({ started: at, kind: 'claude', model: 'opus', worktree: tree }));
  // A build whose run ended with nothing after it, as the record a builder start left with nothing launched closes.
  fs.writeFileSync(path.join(data, 'agents', 'L5.json'), JSON.stringify({ started: at, done, kind: 'claude', model: 'opus', worktree: tree }));
  fs.writeFileSync(path.join(data, 'agents', 'L6.json'), JSON.stringify({ started: at, done, kind: 'claude', model: 'opus', worktree: tree }));
  fs.writeFileSync(path.join(data, 'agents', 'L7.json'), JSON.stringify({ started: at, done, handed_back: done, calls: [{ at: done, text: 'Kept the header' }], kind: 'claude', model: 'opus', worktree: tree }));
  const { runs, launch } = launcher(t);
  const board = await startBoard(t, { site, launch });
  await board.settled();
  assert.deepEqual(runs.map((r) => r.prompt.match(/builder start (t\/L\d) --kind build/)?.[1]).sort(), ['t/L1', 't/L5'], 'the stuck cards restart, and only they');
  // The restart is fresh and in place: the card stays In Progress, and one whose last build kept a worktree works there.
  assert.equal(runs.find((r) => r.prompt.includes('builder start t/L5 ')).cwd, wt);
  const items = JSON.parse(fs.readFileSync(path.join(data, 'items.json'), 'utf8')).items;
  assert.deepEqual(['L1', 'L5'].map((id) => items.find((i) => i.id === id).lane), ['progress', 'progress']);
  for (const id of ['L1', 'L5']) {
    const record = JSON.parse(fs.readFileSync(path.join(data, 'agents', `${id}.json`), 'utf8'));
    assert.deepEqual([Boolean(record.started), 'done' in record, record.dispatched], [true, false, 'hub'], `${id}'s record is open for its builder to take up`);
    assert.ok(JSON.parse(fs.readFileSync(path.join(data, 'headless-builders.json'), 'utf8'))[`t/${id}`], `${id}'s launch is tracked`);
    const thread = fs.readFileSync(path.join(data, 'threads', `t__${id}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(thread.some((m) => m.line === 'builder-restarted'), `${id}'s thread says it restarted`);
  }
  const audit = fs.readFileSync(path.join(data, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(audit.filter((e) => e.call === 'restart').map((e) => [e.key, e.result]).sort(), [['t/L1', 'restarted'], ['t/L5', 'restarted']]);
});

// A board server holds its port before any startup side effect: of two started on one site at once, only the one that
// binds launches the cut-off build, and the other rejects on EADDRINUSE having written nothing.
test('of two board servers started on one site at once, one launches each cut-off build and the other fails on its port having done nothing', async (t) => {
  const home = emptyHome();
  const site = path.join(home, 'site');
  const data = path.join(site, 'data');
  fs.mkdirSync(path.join(data, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(data, 'threads'));
  const wt = path.join(home, 'wt');
  fs.mkdirSync(wt);
  const manifest = path.join(home, '.claude', 'kickflip', 'manifest.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ sites: { shop: { dir: site, port: 1, cmd: ['node', '/x/board/server.mjs'], github: 'owner/project', branch: 'main', owner: { repo: wt } } } }));
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'Shop', items: 'data/items.json', slug: 't' }));
  fs.writeFileSync(path.join(data, 'items.json'), JSON.stringify({ items: [{ id: 'C1', title: 'C1', lane: 'progress' }] }));
  fs.writeFileSync(path.join(data, 'agents', 'C1.json'), JSON.stringify({ started: '2026-11-05T04:42:41.000Z', kind: 'claude', model: 'opus', dispatched: 'hub', worktree: { path: wt, branch: 'x', repo: wt } }));
  const { runs, launch } = launcher(t);
  const [port] = await freePorts(1);
  const { startServer } = await import('./server.mjs');
  const starts = await Promise.allSettled([startServer({ site, port, launch }), startServer({ site, port, launch })]);
  const won = starts.filter((s) => s.status === 'fulfilled').map((s) => s.value);
  t.after(() => Promise.all(won.map((b) => b.close())));
  const lost = starts.filter((s) => s.status === 'rejected').map((s) => s.reason.code);
  assert.deepEqual([won.length, lost], [1, ['EADDRINUSE']]);
  await won[0].settled();
  assert.equal(runs.length, 1, 'one builder launches');
  const audit = fs.readFileSync(path.join(data, 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(audit.filter((e) => e.call === 'launch-cut-off').length, 1, 'one launch-cut-off line');
});

// docs/adr/2026-11-04-2130-the-hub-launches-every-agent-from-the-card.md
// A local board over a git repo and its wave's items, its server in this process launching agents through launcher's
// launch; start() starts it, and its send(kind, body) posts a page event and resolves, with the answer, once the server
// has heard the event's writes and the passes they started have finished.
function oneLaunchBoard(t, items) {
  const home = emptyHome();
  const site = path.join(home, 'site');
  const data = path.join(site, 'data');
  fs.mkdirSync(path.join(data, 'threads'), { recursive: true });
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  const clone = path.join(home, 'clone');
  fs.mkdirSync(clone);
  git(clone, 'init', '--quiet', '-b', 'main');
  git(clone, 'config', 'user.name', 'Test');
  git(clone, 'config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(clone, 'a.txt'), 'a\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '--quiet', '-m', 'base');
  const manifest = path.join(home, '.claude', 'kickflip', 'manifest.json');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ sites: { shop: { dir: site, port: 1, cmd: ['node', '/x/board/server.mjs'], branch: 'main', local: true, owner: { repo: clone } } } }));
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'Shop', items: 'data/items.json', slug: 't' }));
  fs.writeFileSync(path.join(data, 'items.json'), JSON.stringify({ items }));
  const agents = launcher(t);
  const events = () => (fs.existsSync(path.join(data, 'events.jsonl')) ? fs.readFileSync(path.join(data, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).kind) : []);
  const thread = (id) => (fs.existsSync(path.join(data, 'threads', `t__${id}.jsonl`)) ? fs.readFileSync(path.join(data, 'threads', `t__${id}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse) : []);
  const record = (id) => JSON.parse(fs.readFileSync(path.join(data, 'agents', `${id}.json`), 'utf8'));
  const item = (id) => JSON.parse(fs.readFileSync(path.join(data, 'items.json'), 'utf8')).items.find((i) => i.id === id);
  async function start() {
    const board = await startBoard(t, { site, launch: agents.launch });
    await board.settled();
    const send = async (kind, body) => {
      const answer = await fetch(`${board.base}/_claude/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, ...body }) }).then((r) => r.json());
      await wrote(board);
      return answer;
    };
    // The orchestrator's `item brief` on card id: its words, for an agent of kind.
    const brief = async (id, kind, words) => {
      const draft = path.join(home, `brief-${id}-${kind}.md`);
      fs.writeFileSync(draft, words);
      await writeBrief(site, `t/${id}`, { kind, file: draft });
      await wrote(board, path.join(data, 'items.json'));
    };
    return { board, send, brief };
  }
  return { home, site, data, clone, ...agents, events, thread, record, item, start };
}

// docs/adr/2026-11-12-0600-every-planner-launches-from-the-orchestrators-brief.md
test("item brief refuses a staged or ready card, naming its phase, and writes nothing to it", async (t) => {
  const b = oneLaunchBoard(t, [{ id: 'S1', title: 'Staged', phase: 'staging' }, { id: 'R1', title: 'Ready', phase: 'ready' }]);
  const { brief } = await b.start();
  await assert.rejects(brief('S1', 'visual', 'Draw it.'), /is staging, so it gets no visual brief/);
  await assert.rejects(brief('R1', 'grill', 'Ask.'), /is ready, so it gets no grill brief/);
  assert.deepEqual([b.runs.length, b.item('S1').briefs, b.item('R1').briefs], [0, undefined, undefined]);
});

// docs/adr/2026-11-12-0600-every-planner-launches-from-the-orchestrators-brief.md
test("the owner's Grill and Prototype taps and a card arriving in Todo launch no planner but owe the orchestrator's brief, which launches it from the card, in the board's repo", async (t) => {
  const b = oneLaunchBoard(t, [
    { id: 'G1', title: 'Grill me', phase: 'discussing' },
    { id: 'P1', title: 'Draw me', phase: 'discussing' },
    { id: 'Q1', title: 'Plan me' },
  ]);
  const { board, send, brief } = await b.start();
  await send('grill-more', { key: 't/G1', text: 'Ask about the phone' });
  assert.equal(b.runs.length, 0, 'the tap launches nothing');
  assert.deepEqual([b.item('G1').phase, b.item('G1').briefs.map((x) => [x.kind, x.ask, x.brief])], ['grilling', [['grill', { text: 'Ask about the phone' }, undefined]]]);
  const waits = JSON.parse(fs.readFileSync(path.join(b.data, 'orchestrator-waits.json'), 'utf8')).waits;
  assert.ok(waits.some((w) => w.key === 't/G1' && w.kind === 'brief'), 'the brief waits on the orchestrator');

  await brief('G1', 'grill', 'Settled: the footer folds.\nOpen: the phone layout.');
  assert.equal(b.runs.length, 1, 'the brief launches the grill');
  const [grill] = b.runs;
  assert.equal(grill.cwd, b.clone);
  assert.match(grill.prompt, /builder start t\/G1 --kind grill/);
  assert.match(grill.prompt, /grilling skill/);
  assert.match(grill.prompt, /Start from the orchestrator's brief, its notes section "Brief for grill round 1"[^]*Settled: the footer folds\.\nOpen: the phone layout\.[^]*1\. Run/);
  assert.match(grill.prompt, /The owner asked for this grill, writing: "Ask about the phone"/);
  assert.deepEqual([grill.kind, grill.model], ['claude', 'opus']);
  assert.deepEqual([b.record('G1').kind, b.record('G1').dispatched, b.record('G1').brief.brief.heading], ['grill', 'hub', 'Brief for grill round 1']);
  assert.match(b.record('G1').session.log, /^planner-G1-.*\.log$/, 'the launch records its session');
  assert.deepEqual([b.item('G1').lane, b.item('G1').briefs], ['todo', undefined], 'a planner never starts the task, and its brief left the task');

  await send('prototype-request', { key: 't/P1' });
  await brief('P1', 'prototype', 'Two takes: a drawer and a sheet.');
  assert.equal(b.runs.length, 2, 'the prototype launches');
  const proto = b.runs[1];
  assert.match(proto.prompt, /builder start t\/P1 --kind prototype/);
  assert.match(proto.prompt, /Two takes: a drawer and a sheet\./);
  assert.equal(proto.model, 'sonnet');

  // A card in Todo owes no grill brief of its own accord: only a tap or the orchestrator's brief asks for one.
  for (const id of ['G1', 'P1']) fs.writeFileSync(path.join(b.data, 'agents', `${id}.json`), JSON.stringify({ ...b.record(id), done: new Date().toISOString() }));
  fs.writeFileSync(path.join(b.site, 'board.json'), JSON.stringify({ title: 'Shop', items: 'data/items.json', slug: 't' }));
  await wrote(board, path.join(b.data, 'agents', 'G1.json'), path.join(b.data, 'agents', 'P1.json'), path.join(b.site, 'board.json'));
  assert.equal(b.item('Q1').briefs, undefined, 'a card with no phase owes no brief');
  assert.equal(b.runs.length, 2, 'nothing launches by itself');
  assert.deepEqual(b.thread('Q1').map((m) => m.line), [], "the start-up move to discussing writes no line");
  await brief('Q1', 'grill', 'Plan it.');
  assert.equal(b.runs.length, 3, 'its brief launches the grill');
  assert.match(b.runs[2].prompt, /builder start t\/Q1 --kind grill/);
  assert.ok(b.record('Q1').session?.log, 'the launch records the run');
  assert.ok(!b.events().includes('card-plan'), 'the grill wakes no session');
  // A brief while the card's planner is open launches nothing more, until it finishes.
  await brief('Q1', 'grill', 'And the desktop.');
  assert.equal(b.runs.length, 3);
});

// docs/adr/2026-11-06-1249-the-pause-line-reads-every-headless-agents-usage.md
const usageAt = (home, used) => {
  const file = path.join(home, '.claude', 'kickflip', 'usage.json');
  const resets = new Date(Date.now() + 3600_000).toISOString();
  fs.writeFileSync(file, JSON.stringify({ claude: { at: new Date(Date.now() - 600_000).toISOString(), five_hour: { used_percentage: used, resets_at: resets }, seven_day: { used_percentage: 20, resets_at: resets } } }));
};

test('a grill briefed during a pause waits on the card and launches when the pause lifts', async (t) => {
  const b = oneLaunchBoard(t, [{ id: 'G1', title: 'Grill me', phase: 'grilling' }]);
  usageAt(b.home, 95);
  const { board, send, brief } = await b.start();
  await send('grill-more', { key: 't/G1', text: 'One more thing' });
  await brief('G1', 'grill', 'Ask about the footer.');
  assert.equal(b.runs.length, 0, 'nothing launches while paused');
  assert.equal(b.item('G1').briefs[0].brief.heading, 'Brief for grill round 1', 'the brief waits on the task');
  fs.rmSync(path.join(b.home, '.claude', 'kickflip', 'usage.json'));
  board.minute();
  await board.settled();
  assert.equal(b.runs.length, 1, 'the grill launches once the pause lifts');
  assert.match(b.runs[0].prompt, /builder start t\/G1 --kind grill/);
  assert.match(b.runs[0].prompt, /One more thing/);
  assert.match(b.runs[0].prompt, /Ask about the footer\./);
  board.minute();
  await board.settled();
  assert.equal(b.runs.length, 1, 'it launches once');
});

test("within twice the buffer of the line the board launches every grill at once: only the pull's cap halves", async (t) => {
  const b = oneLaunchBoard(t, [{ id: 'A1', title: 'First', phase: 'grilling' }, { id: 'A2', title: 'Second', phase: 'grilling' }]);
  fs.writeFileSync(path.join(b.site, 'board.json'), JSON.stringify({ title: 'Shop', items: 'data/items.json', slug: 't' }));
  usageAt(b.home, 85);
  const { brief } = await b.start();
  for (const id of ['A1', 'A2']) await brief(id, 'grill', `Grill ${id}.`);
  assert.equal(b.runs.length, 2, 'near the line a launch waits on no usage reading');
});

test('a build whose builder fails to launch goes back to Todo with the reason, and wakes no session', async (t) => {
  const b = oneLaunchBoard(t, [{ id: 'F1', title: 'feat: fail me', phase: 'ready', size: 'large' }]);
  b.failWith(Object.assign(new Error('spawn /no-such-claude-here ENOENT'), { code: 'ENOENT' }));
  const { send } = await b.start();
  const tapped = await send('card-build', { key: 't/F1' });
  assert.equal(tapped.id, null);
  const last = b.thread('F1').at(-1);
  assert.equal(last.line, 'build-refused');
  assert.match(last.text, /^Couldn't start implementing: the launch failed: .*ENOENT/);
  assert.equal(b.item('F1').lane, 'todo', 'back in Todo');
  assert.ok(b.record('F1').done, 'its builder record is closed');
  assert.ok(!b.events().includes('card-build'));
});

// docs/adr/2026-11-05-0900-done-and-hold-stop-the-cards-headless-builder.md
test('stopAgents signals only the agents whose process started when their session was recorded, then kills what lingers', async () => {
  const at = '2026-11-05T10:00:00.000Z';
  const sent = [];
  const starts = (pids) => new Map(pids.map((p) => [p, p === 3 ? Date.parse('2026-11-01T00:00:00Z') : Date.parse(at) - 5000]));
  const n = stopAgents([{ pid: 1, at }, { pid: 2, at }, { pid: 3, at }, { pid: null, at: null }], { starts, kill: (pid, sig) => sent.push([pid, sig]), killAfter: 10 });
  assert.equal(n, 2, 'pid 3 started long before the session, so it is a reused pid; the record with no pid only closes');
  assert.deepEqual(sent, [[1, 'SIGTERM'], [2, 'SIGTERM']]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(sent.slice(2), [[1, 'SIGKILL'], [2, 'SIGKILL']]);
  assert.equal(stopAgents([{ pid: 9, at }], { starts: () => null, kill: () => assert.fail('ps gave no answer') }), 0);
});

// docs/adr/2026-11-12-2100-a-ps-with-no-answer-closes-no-planner.md
test('an agent may run when ps gave no answer, and not when ps answered without its pid', () => {
  const agent = { pid: 7, at: new Date().toISOString() };
  assert.equal(agentMayRun(agent, { starts: () => null }), true);
  assert.equal(agentMayRun(agent, { starts: () => new Map() }), false);
  assert.equal(agentMayRun(agent, { starts: () => new Map([[7, Date.parse(agent.at) - 5000]]) }), true);
});

// docs/adr/2026-11-09-1300-a-card-pause-stops-its-builder-at-its-next-stopping-point.md
test("the owner's Block pauses the card's running builder at its next progress report, and Unblock carries on its own session", async (t) => {
  const b = oneLaunchBoard(t, [{ id: 'H1', title: 'feat: hold me', phase: 'ready', size: 'large' }]);
  const { send } = await b.start();
  const { pid, id: session } = b.record('H1').session;
  assert.equal(pid, b.runs[0].pid, 'the pull of the ready task records the agent pid');
  await send('card-hold', { key: 't/H1', hold: true });
  assert.doesNotThrow(() => process.kill(pid, 0), 'the builder runs on to its stopping point');
  assert.deepEqual({ done: b.record('H1').done, pause: b.record('H1').pause?.cause, lane: b.item('H1').lane }, { done: undefined, pause: 'held', lane: 'progress' }, `read the record ${JSON.stringify(b.record('H1'))}`);
  assert.deepEqual(b.thread('H1').at(-1).text, 'Blocked', 'nothing stopped, so no stop line');
  assert.match((await builderProgress(b.site, 't/H1', 'Writing the test', { phase: 'building' })).lines[0], /^Paused: blocked\. Commit what you have now/);
  assert.equal(b.thread('H1').at(-1).text, 'Paused at building: blocked. It resumes once you unblock it.');
  await b.gone(pid);
  await send('card-hold', { key: 't/H1', hold: false });
  assert.equal(b.runs.length, 2, 'the resume launches its session again');
  assert.equal(b.record('H1').session.pid, b.runs[1].pid);
  const [, again] = b.runs;
  assert.equal(again.resume, session);
  assert.match(again.prompt, /^The board paused your build of task H1, and the pause has cleared: unblocked\. Carry on where you stopped/);
  assert.equal(again.cwd, b.record('H1').worktree.path);
  assert.deepEqual([b.record('H1').pause, b.record('H1').done], [undefined, undefined]);
  assert.ok(b.thread('H1').some((m) => m.text === 'Resumed: unblocked.'));
});

// docs/adr/2026-11-16-0007-builder-resume-updates-a-running-builder-or-resumes-a-handed-back-one.md
test("the owner's message reaches the running builder at its next command, and builder resume on its hand-back resumes its own session with every word since", async (t) => {
  const b = oneLaunchBoard(t, [{ id: 'H1', title: 'feat: sheet', phase: 'ready', size: 'large' }]);
  const { board, send } = await b.start();
  const { pid, id: session } = b.record('H1').session;
  await send('item-message', { key: 't/H1', text: 'Use the blue' });
  assert.ok(b.record('H1').news, 'the message waits on its record');
  assert.ok((await builderProgress(b.site, 't/H1', 'Writing the sheet', { phase: 'building' })).lines.includes('New on t/H1 while you build: the owner wrote: Use the blue'));

  await recordCall(b.site, 't/H1', 'Kept the sheet', {});
  await handBackCalls(b.site, 't/H1', {});
  await b.gone(pid);
  await send('item-message', { key: 't/H1', text: 'Also the red' });
  await builderResume(b.site, 't/H1', 'Make it a button');
  await wrote(board, path.join(b.data, 'agents', 'H1.json'));
  assert.equal(b.runs.length, 2, 'the resume launches its session again');
  const [, again] = b.runs;
  assert.equal(again.resume, session);
  assert.equal(again.cwd, b.record('H1').worktree.path);
  assert.match(again.prompt, /^The orchestrator resumes your handed-back build of task H1 to change it\./);
  for (const said of ['the owner wrote: Also the red', 'the orchestrator wrote: Make it a button']) assert.ok(again.prompt.includes(`New on t/H1 while you build: ${said}`), said);
  assert.ok(!again.prompt.includes('Use the blue'), 'its session read that one already');
  const rec = b.record('H1');
  assert.deepEqual([rec.done, rec.handed_back, rec.rerun, rec.news, rec.session.pid], [undefined, undefined, undefined, undefined, again.pid]);
  assert.deepEqual(rec.calls.map((c) => c.text), ['Kept the sheet'], 'its calls come back with its next hand-back');
  assert.equal(b.item('H1').next, undefined, 'it reads building again');
  assert.ok(b.thread('H1').some((m) => m.text === 'Resumed: Make it a button'));
});

// docs/adr/2026-11-15-0040-a-cold-resume-past-150k-starts-a-fresh-agent-with-a-handoff.md
test('a session resumes while under the cap or warm, and past the cap and an hour old goes fresh: a land on Sonnet, a build on its own model', () => {
  const now = Date.parse('2026-11-14T12:00:00.000Z');
  const ago = (minutes) => new Date(now - minutes * 60_000).toISOString();
  const cases = [
    // [context, minutes since its last turn, land, model] → choice
    [[149_999, 600, true, 'opus'], { resume: true }],
    [[150_000, 59, true, 'opus'], { resume: true }],
    [[150_000, 60, true, 'opus'], { resume: false, model: 'sonnet' }],
    [[400_000, 600, true, 'sonnet'], { resume: false, model: 'sonnet' }],
    [[150_000, 60, false, 'opus'], { resume: false, model: 'opus' }],
    [[212_000, 600, false, 'sonnet'], { resume: false, model: 'sonnet' }],
    [[20_000, 600, false, 'opus'], { resume: true }],
  ];
  for (const [[context, minutes, land, model], choice] of cases) {
    assert.deepEqual(resumeChoice({ context, at: ago(minutes) }, { now, land, model }), choice, `${context} tokens, ${minutes} minutes, land ${land}`);
  }
  assert.deepEqual(resumeChoice(null, { now, land: true, model: 'opus' }), { resume: true }, 'a session with no readable turn resumes, as before');
  assert.equal(CONTEXT_CAP, 150_000);
});

// A Claude run's stream-json log as the board keeps it: assistant turns with their usage and time, a sub-agent's among
// them, and the result.
const turn = (at, [input, read, write], { text, parent = null } = {}) => JSON.stringify({ type: 'assistant', timestamp: at, parent_tool_use_id: parent, message: { content: text ? [{ type: 'text', text }] : [{ type: 'tool_use', name: 'Bash' }], usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: 9 } } });

test("a session's state is its last top-level turn's context and time, and its last message the run's result", () => {
  const dir = tempDir('session-state-');
  const file = path.join(dir, 'builder.log');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
    turn('2026-11-14T10:00:00.000Z', [2, 90_000, 1000], { text: 'Reading the code' }),
    turn('2026-11-14T10:05:00.000Z', [3, 151_000, 2000], { text: 'Committed and handed back.' }),
    turn('2026-11-14T10:06:00.000Z', [1, 5_000, 0], { parent: 'toolu_1' }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'The build is committed and handed back.' }),
  ].join('\n') + '\n');
  assert.deepEqual(sessionState(file), { context: 153_003, at: '2026-11-14T10:05:00.000Z', last: 'The build is committed and handed back.' }, "a sub-agent's turn isn't the session's context");
  fs.writeFileSync(file, [turn('2026-11-14T10:00:00.000Z', [2, 90_000, 1000], { text: 'Rebasing onto main' }), turn('2026-11-14T10:01:00.000Z', [2, 91_000, 0])].join('\n') + '\n');
  assert.deepEqual(sessionState(file), { context: 91_002, at: '2026-11-14T10:01:00.000Z', last: 'Rebasing onto main' }, 'a run with no result: its last top-level text');
  fs.writeFileSync(file, JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }) + '\n');
  assert.equal(sessionState(file), null, 'no turn yet');
  assert.equal(sessionState(path.join(dir, 'gone.log')), null, 'no log');
});

test("a fresh agent's handoff holds why it carries on, the branch's commits and diff stat, and the old session's last message", () => {
  const words = handoffLines({ why: 'The land hit this: tests failed in a.test.mjs.', commits: 'abc1234 feat(board): a thing', stat: ' a.mjs | 4 ++--\n 1 file changed', last: 'Handed back with one call.' }).join('\n');
  assert.match(words, /builder session ran past 150k tokens of context, so you carry on in its place/);
  assert.match(words, /The land hit this: tests failed in a\.test\.mjs\./);
  assert.match(words, /Commits on the branch:\nabc1234 feat\(board\): a thing/);
  assert.match(words, /Diff stat against the base:\n a\.mjs \| 4 \+\+--\n 1 file changed/);
  assert.match(words, /The old session's last message:\nHanded back with one call\./);
  assert.doesNotMatch(handoffLines({ commits: '', stat: '', last: null }).join('\n'), /undefined|null/, 'a handoff with nothing to hand says none');
});

// The board's launch writes the builder's log; a test makes the session cold and over the cap by adding a turn to it.
const coldTurn = (b, id, context) => {
  const log = path.join(b.home, '.claude', 'kickflip', 'logs', b.record(id).session.log);
  fs.appendFileSync(log, turn(new Date(Date.now() - 2 * 3600_000).toISOString(), [2, context - 2, 0], { text: 'Paused here; committed the parser.' }) + '\n');
};

test('Unblock of a blocked build whose session is cold and past the cap starts a fresh builder on its model, with the handoff, and says so', async (t) => {
  const b = oneLaunchBoard(t, [{ id: 'H2', title: 'feat: hold me', phase: 'ready', size: 'large' }]);
  const { send } = await b.start();
  const { pid } = b.record('H2').session;
  await send('card-hold', { key: 't/H2', hold: true });
  await builderProgress(b.site, 't/H2', 'Writing the test', { phase: 'building' });
  await b.gone(pid);
  coldTurn(b, 'H2', 212_000);
  await send('card-hold', { key: 't/H2', hold: false });
  assert.equal(b.runs.length, 2, 'the resume launches an agent');
  const [first, fresh] = b.runs;
  assert.equal(fresh.resume, undefined, 'a fresh agent, not the session resumed');
  assert.equal(fresh.model, first.model, "a build's carry-on keeps its model");
  assert.match(fresh.prompt, /^You are the headless builder for task H2/);
  assert.match(fresh.prompt, /Why it carries on: The board paused this build, and the pause has cleared: unblocked\./);
  assert.match(fresh.prompt, /The old session's last message:\nPaused here; committed the parser\./);
  assert.ok(b.thread('H2').some((m) => m.text === 'Fresh builder: its session was over 150k.'), 'the thread says so, with no session id');
});

test("a land past the cap on a cold session goes to a fresh lander on Sonnet with what the land hit and the branch's commits; a warm one resumes", async (t) => {
  const b = oneLaunchBoard(t, [{ id: 'L1', title: 'feat: land me', phase: 'ready', size: 'large' }]);
  await b.start();
  const { worktree } = b.record('L1');
  fs.writeFileSync(path.join(worktree.path, 'b.txt'), 'b\n');
  execFileSync('git', ['-C', worktree.path, 'add', '-A']);
  execFileSync('git', ['-C', worktree.path, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '--quiet', '-m', 'feat(board): add b']);
  await b.gone(b.runs[0].pid);
  const key = 't/L1';
  const log = path.join(b.home, '.claude', 'kickflip', 'logs', b.record('L1').session.log);
  fs.appendFileSync(log, turn(new Date(Date.now() - 5 * 60_000).toISOString(), [2, 300_000, 0], { text: 'Handed back.' }) + '\n');
  const warm = await landByBuilder(b.site, { key, model: 'opus' }, { why: 'tests failed in a.test.mjs', launch: b.launch });
  assert.equal(warm.resumed, true, 'minutes after its last turn the cache is warm, so it resumes whatever its size');
  assert.equal(b.runs[1].resume, b.runs[0].sessionId);
  await b.gone(b.runs[1].pid);
  coldTurn(b, 'L1', 300_000);
  const cold = await landByBuilder(b.site, { key, model: 'opus' }, { why: 'tests failed in a.test.mjs', launch: b.launch });
  assert.equal(cold.resumed, false);
  const lander = b.runs[2];
  assert.deepEqual([lander.resume, lander.model], [undefined, 'sonnet']);
  assert.match(lander.prompt, /^You are the headless lander for task L1/);
  assert.match(lander.prompt, /Why it carries on: The land hit this: tests failed in a\.test\.mjs\./);
  assert.match(lander.prompt, /Commits on the branch:\n[0-9a-f]+ feat\(board\): add b/);
  assert.match(lander.prompt, /Diff stat against the base:\nb\.txt \| 1 \+/);
  assert.equal(b.thread('L1').filter((m) => m.line === 'fresh-builder').length, 1);
});

// docs/adr/2026-11-06-1100-only-typed-thread-messages-wake-the-orchestrator.md
test("Resume relaunches the grill a Hold stopped from the brief it ran on, and neither tap wakes a session", async (t) => {
  const b = oneLaunchBoard(t, [{ id: 'G2', title: 'Grill me', phase: 'grilling' }]);
  const { send, brief } = await b.start();
  await send('grill-more', { key: 't/G2', text: 'Ask about the footer' });
  await brief('G2', 'grill', 'Cover the footer on a phone.');
  assert.equal(b.runs.length, 1, 'the grill launches');
  assert.match(b.runs[0].prompt, /Ask about the footer/, 'the typed text goes to the planner');
  await send('card-hold', { key: 't/G2', hold: true });
  assert.ok(b.record('G2').done, 'the hold closed the grill');
  await send('card-hold', { key: 't/G2', hold: false });
  assert.equal(b.runs.length, 2, 'the resume launches the grill again');
  assert.match(b.runs[1].prompt, /builder start t\/G2 --kind grill/);
  assert.match(b.runs[1].prompt, /Cover the footer on a phone\.[^]*Ask about the footer/, 'with its brief and the ask it answered');
});

test('a stale lander entry for an archived Done card is dropped, and the card stays archived', async (t) => {
  const home = emptyHome();
  const site = path.join(home, 'site');
  const data = path.join(site, 'data');
  fs.mkdirSync(path.join(data, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'kickflip'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'kickflip', 'manifest.json'), JSON.stringify({ sites: { shop: { dir: site, port: 1, cmd: ['node', '/x/board/server.mjs'], github: 'owner/project', branch: 'main' } } }));
  fs.writeFileSync(path.join(site, 'board.json'), JSON.stringify({ title: 'Shop', items: 'data/items.json', slug: 't' }));
  fs.writeFileSync(path.join(data, 'items.json'), JSON.stringify({ items: [{ id: 'D1', title: 'Landed', lane: 'done', closed_at: '2026-11-01T00:00:00.000Z' }, { id: 'T1', title: 'Other', lane: 'todo' }] }));
  await archiveCards(site, [{ key: 't/D1', closed_at: '2026-11-01T00:00:00.000Z' }]);
  fs.writeFileSync(path.join(data, 'landers.json'), JSON.stringify({ 't/D1': { verified: 'v1', pid: 2 ** 22 + 12345 } }));
  const { runs, launch } = launcher(t);
  const board = await startBoard(t, { site, launch });
  await board.settled();
  assert.ok(!('t/D1' in JSON.parse(fs.readFileSync(path.join(data, 'landers.json'), 'utf8'))), 'the stale entry is dropped');
  assert.deepEqual((await readArchive(site)).map((a) => a.key), ['t/D1']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(data, 'items.json'), 'utf8')).items.map((i) => i.id), ['T1']);
  assert.equal(runs.length, 0);
});

// docs/adr/2026-11-05-1921-a-visual-is-a-page-an-agent-draws-for-a-thread.md
test("a visual agent's brief has it start as its own agent, read the card and thread, write one page, place it with visual add and finish, touching nothing else", () => {
  const b = `node ${BOARD_CLI} --site shop`;
  const brief = visualBrief({ ...card, repo: '/r/shop', agent: 'visual-e1', text: 'Draw the land queue' });
  for (const want of [
    'ENG-1', 'Make it go', '/s/waves/w/a1.md', `${b} builder start w/A1 --kind visual --agent visual-e1`, 'Draw the land queue',
    `${b} visual add w/A1 --file`, '--title', `${b} builder done w/A1 --agent visual-e1`, 'CDN', 'Never push',
  ]) assert.ok(brief.includes(want), `the visual brief has ${want}`);
  assert.ok(!brief.includes('question add') && !brief.includes('item set'), 'a visual posts no question and moves no task');
  assert.ok(brief.indexOf('visual add') < brief.indexOf(`${b} builder done`));
  assert.doesNotMatch(visualBrief({ ...card, repo: '/r/shop', agent: 'visual-e1' }), /The owner wrote/, 'with no text from the owner, the orchestrator\'s brief says what to draw');
});

// docs/adr/2026-11-17-1600-a-final-visual-ends-on-the-cards-implement.md
test("a final visual's brief has its agent place the page with --implement, so the task's Implement is the next action, and ask no question", () => {
  const b = `node ${BOARD_CLI} --site shop`;
  const brief = visualBrief({ ...card, repo: '/r/shop', agent: 'visual-e1', brief: { ...card.brief, final: true } });
  assert.ok(brief.includes(`${b} visual add w/A1 --file <page.html> --title "<what it shows>" --implement`));
  assert.match(brief, /final visual of a UI change/);
  assert.match(brief, /already staged, ready or past Todo.*without --implement/, 'a task that has had Implement takes the page unmarked');
  assert.ok(!brief.includes('question add'), 'a final visual asks no question: the task\'s Implement confirms it');
  assert.doesNotMatch(visualBrief({ ...card, repo: '/r/shop', agent: 'visual-e1' }), /--implement/, 'a visual not final marks nothing');
});

// docs/adr/2026-11-07-0115-the-orchestrator-sorts-new-tasks-itself.md
test('a new task launches no agent: it arrives as a New card that waits on the orchestrator, which sorts it', async (t) => {
  const b = oneLaunchBoard(t, [{ id: 'A1', title: 'Filed', phase: 'grilling', lane: 'progress' }]);
  const { send } = await b.start();
  const { id } = await send('ask', { text: 'Make the header blue' });
  const filed = JSON.parse(fs.readFileSync(path.join(b.data, 'items.json'), 'utf8')).items.find((i) => i.from_ask === id);
  assert.deepEqual([filed.title, filed.lane, filed.phase], ['Make the header blue', 'todo', undefined]);
  const waits = JSON.parse(fs.readFileSync(path.join(b.data, 'orchestrator-waits.json'), 'utf8')).waits;
  assert.ok(waits.some((w) => w.key === `t/${filed.id}` && w.kind === 'intake'), 'the intake wait');
  assert.equal(b.runs.length, 0);
  assert.equal(fs.existsSync(path.join(b.data, 'intake-runs.json')), false);
});

test("the owner's visual request owes the orchestrator's visual brief, which launches a visual agent on Sonnet beside the card's build, as its own agent, and a second waits for the first to finish", async (t) => {
  const b = oneLaunchBoard(t, [{ id: 'V1', title: 'Show me', lane: 'progress' }]);
  fs.mkdirSync(path.join(b.data, 'agents'), { recursive: true });
  const build = { kind: 'claude', model: 'opus', started: new Date().toISOString(), worktree: { path: b.clone } };
  fs.writeFileSync(path.join(b.data, 'agents', 'V1.json'), JSON.stringify(build));
  const { board, send, brief } = await b.start();
  await send('visual-request', { key: 't/V1', text: 'Draw the queue' });
  assert.equal(b.runs.length, 0, 'the tap launches nothing');
  assert.deepEqual([b.item('V1').lane, b.item('V1').briefs.map((x) => [x.kind, x.ask])], ['progress', [['visual', { text: 'Draw the queue' }]]]);
  await brief('V1', 'visual', 'The land queue as a flow, oldest first.');
  assert.equal(b.runs.length, 1, 'the visual agent launches beside the build');
  const [run] = b.runs;
  const agent = /--agent (visual-\d+)/.exec(run.prompt)[1];
  assert.equal(run.cwd, b.clone);
  assert.match(run.prompt, new RegExp(`builder start t/V1 --kind visual --agent ${agent}`));
  assert.match(run.prompt, /The land queue as a flow, oldest first\.[^]*Draw the queue/);
  assert.equal(run.model, 'sonnet');
  const visual = b.record(`V1@${agent}`);
  assert.deepEqual([visual.kind, visual.model, visual.dispatched, visual.brief.brief.heading], ['visual', 'sonnet', 'hub', 'Brief for visual round 1']);
  assert.deepEqual(b.record('V1'), build, "the build's record is untouched");
  assert.ok(visual.session?.log, 'the launch records the run');

  await brief('V1', 'visual', 'Now the review lane.');
  assert.equal(b.runs.length, 1, 'the second waits while the first runs');
  fs.writeFileSync(path.join(b.data, 'agents', `V1@${agent}.json`), JSON.stringify({ ...b.record(`V1@${agent}`), done: new Date().toISOString() }));
  await wrote(board, path.join(b.data, 'agents', `V1@${agent}.json`));
  assert.equal(b.runs.length, 2, 'the second launches once the first is done');
  assert.doesNotMatch(b.runs[1].prompt, new RegExp(`--agent ${agent}\\b`));
  assert.match(b.runs[1].prompt, /Now the review lane\./);
});

// docs/adr/2026-11-06-0425-the-implementer-limit-counts-agents-and-a-card-spawns-helpers.md
test("a helper's brief gives it the task as its own agent, in its worktree when it writes, read-only otherwise, and has it hand back with done --text", () => {
  const b = `node ${BOARD_CLI} --site shop`;
  const writing = helperBrief({ ...card, agent: 'tests', task: 'Write the scroll tests in board/ui.test.mjs', writes: true, cwd: '/wt/A1-tests' });
  for (const want of [
    'ENG-1', 'Make it go', 'Write the scroll tests in board/ui.test.mjs', '/wt/A1-tests', `${b} builder start w/A1 --kind helper --agent tests`,
    `${b} builder progress w/A1 --agent tests --phase`, 'commit your work there', `${b} builder done w/A1 --agent tests --text`, 'Never push',
  ]) assert.ok(writing.includes(want), `the helper brief has ${want}`);
  assert.ok(!writing.includes('builder call') && !writing.includes('question add'), 'a helper records no calls and asks no questions');
  const reading = helperBrief({ ...card, agent: 'survey', task: 'Find every caller', writes: false, cwd: '/r/shop' });
  assert.match(reading, /change no files there and commit nothing/);
  assert.ok(!reading.includes('commit your work'));
  const build = builderBrief(card);
  for (const want of [`${b} agent launch w/A1 --name`, '--writes', `${b} agent wait w/A1 --name`, `${b} agent merge w/A1 --name`]) assert.ok(build.includes(want), `the builder brief has ${want}`);
});

// docs/adr/2026-11-11-1700-commits-are-conventional-and-name-their-card-in-a-refs-trailer.md
test("a builder's, a lander's and a writing helper's brief give the commit standard, the card's ref in a Refs trailer and never in the subject, and the builder titles a PR with --title", () => {
  const build = builderBrief(card);
  const helper = helperBrief({ ...card, agent: 'tests', task: 'x', writes: true, cwd: '/wt/A1-tests' });
  for (const brief of [build, helper, landerBrief(card)]) {
    assert.ok(brief.includes(standardWords('ENG-1')), brief);
    assert.ok(brief.includes('"Refs: ENG-1"'));
    assert.ok(!brief.includes('"ENG-1: <'), 'no subject starts with the ref');
  }
  assert.ok(build.includes(`--title "<type>(<scope>): <what the PR does>"`), build);
});

// docs/adr/2026-11-13-1126-the-implementer-limit-counts-cards-in-progress.md
test('a writing helper launches at once, its card In Progress already holding the slot, in its own worktree off the card branch', async (t) => {
  const b = oneLaunchBoard(t, [{ id: 'V1', title: 'Split me', lane: 'progress' }]);
  fs.writeFileSync(path.join(b.site, 'board.json'), JSON.stringify({ title: 'Shop', items: 'data/items.json', slug: 't' }));
  fs.writeFileSync(path.join(b.home, '.claude', 'kickflip', 'settings.json'), JSON.stringify({ tasksInProgress: 1 }));
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  const cardTree = path.join(b.home, '.claude', 'kickflip', 'worktrees', 'shop', 'V1');
  git(b.clone, 'worktree', 'add', '--quiet', '-b', 'V1', cardTree, 'main');
  fs.mkdirSync(path.join(b.data, 'agents'), { recursive: true });
  const main = { kind: 'claude', model: 'opus', started: new Date().toISOString(), worktree: { path: cardTree, branch: 'V1', repo: b.clone } };
  const write = (name, value) => fs.writeFileSync(path.join(b.data, 'agents', `${name}.json`), JSON.stringify(value));
  write('V1', main);
  const { board } = await b.start();
  write('V1@tests', { label: 'tests', kind: 'helper', task: 'Write the split tests', writes: true, model: 'sonnet', requested: new Date().toISOString() });
  await wrote(board, path.join(b.data, 'agents', 'V1@tests.json'));
  assert.equal(b.runs.length, 1, 'the helper launches with the one slot full');
  const [run] = b.runs;
  const tree = path.join(b.home, '.claude', 'kickflip', 'worktrees', 'shop', 'V1-tests');
  assert.equal(fs.realpathSync(run.cwd), fs.realpathSync(tree));
  assert.match(run.prompt, /builder start t\/V1 --kind helper --agent tests/);
  assert.match(run.prompt, /Write the split tests/);
  assert.equal(run.model, 'sonnet');
  const helper = b.record('V1@tests');
  assert.deepEqual([helper.kind, helper.dispatched, helper.task, helper.writes, helper.worktree.branch], ['helper', 'hub', 'Write the split tests', true, 'V1-tests']);
  assert.equal(git(tree, 'rev-parse', 'HEAD'), git(cardTree, 'rev-parse', 'HEAD'), "it branches from the task's branch");
  assert.ok(helper.session?.log, 'the launch records the run');
});

// docs/adr/2026-11-14-1530-a-land-reruns-an-untouched-failing-test-on-main.md
test("a builder's brief says a timing taken while the host is busy is provisional, and its call says so", () => {
  const brief = builderBrief(card);
  assert.ok(brief.includes('while the host is busy') && brief.includes('is provisional'), 'the brief marks a busy-host timing provisional');
  assert.ok(brief.includes('"Provisional: <timing>, taken while the host was busy"'), 'and gives the call its words');
});

test('a grill and a prototype planner brief tell the planner a question and its options stand alone, its visual or prototype carried as url', () => {
  const rule = /A question stands alone: its context and each option.s label and detail are answerable as they stand, with no code or label defined elsewhere/;
  for (const kind of ['grill', 'prototype']) {
    const brief = plannerBrief({ ...card, kind, repo: '/r/shop', brief: { text: 'Settled: x.' } });
    assert.match(brief, rule, kind);
    assert.match(brief, /carries that page as its url/, kind);
  }
});
