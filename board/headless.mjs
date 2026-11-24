// docs/adr/2026-11-04-0306-builders-launch-headless-check-their-notes-and-land-on-their-own.md
// docs/adr/2026-11-04-2130-the-hub-launches-every-agent-from-the-card.md
// The board server launches every agent a card gets, through the adapter (agents.mjs): each build, Claude or Codex, in
// the card's worktree, a lander the same way for a handed-back build whose verified calls didn't finish it (a question
// was open, or the finish refused), and each planner, a grill or a prototype, in the board's repo. The brief, one per
// role in plain steps either agent follows, is built from the card: its notes file, the hub's and board's rules, and
// the board's CLI. A builder finishes its own work with builder done (finish.mjs), resolving any rebase conflict itself;
// only judgment calls and deferred asks go to the session.
import fs from 'node:fs';
import os from 'node:os';
import { BRIEF_LINE_LIMIT } from './hub-lines.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchAgent } from './agents.mjs';
import { processStarts, ps } from '../hub/live.mjs';
import { boardAt } from '../hub/boards.mjs';
import { readHubRules } from '../hub/rules.mjs';
import { builderRepo, git } from './worktree.mjs';
import { standardWords } from './commit-message.mjs';
import { BoardError } from './checks.mjs';
import { claimed, claimLaunch, release } from '../shared/launch-claim.mjs';
import { appendBuilderResumed, appendStatus } from './cards.mjs';
import { readBoardRules } from './settings.mjs';
import { briefFacts, recordedSession, recordSession } from './runs.mjs';
import { HELPER, plans, REVIEWER, SUMMARY_HINT, VISUAL } from './domain.mjs';

export const BOARD_CLI = fileURLToPath(new URL('./bin/board.mjs', import.meta.url));
const cli = (route) => `node ${BOARD_CLI} --site ${route}`;
const rebase = (base) => `git -c core.commentChar=';' rebase ${base}`;
// docs/adr/2026-11-09-1100-the-board-owns-a-cards-notes-file.md: the board writes every card's notes; an agent hands it
// a draft.
const DRAFT = 'a draft .md of your own outside the board\'s data folder (such as in /tmp)';
const notesCommand = (b, key, heading) => `\`${b} item notes ${key} --heading "${heading}" --file <draft.md>\``;
const ruleLines = (rules, heading = 'Rules from the hub and this board:') => (rules.length ? [heading, ...rules.map((r) => `- ${r}`), ''] : []);
// docs/adr/2026-11-05-0130-the-orchestrator-links-a-new-card-when-it-files-it.md: the cards the card links (briefFacts' links).
const linkLines = (links) => (links.length ? [
  "Related tasks: read their notes for context; don't build their scope.",
  ...links.map((l) => `- ${l.ref} "${l.title}" (${l.relation}, ${l.lane}): ${l.notes ? `notes ${l.notes}` : 'no notes'}, thread ${l.thread}`),
  '',
] : []);
// docs/adr/2026-11-15-0200-a-board-asks-another-board-and-its-orchestrator-answers.md: any agent asks another board
// when its own repo doesn't explain why.
// docs/adr/2026-11-17-1940-a-question-and-its-options-stand-alone.md: said in each brief of a planner that writes questions.
const STANDALONE = "A question stands alone: its context and each option's label and detail are answerable as they stand, with no code or label defined elsewhere (L1, take B, finding 3) unless the option says what each one is. A question about something a visual or prototype shows carries that page as its url, which the sheet links; the page gives detail, never the meaning. question add refuses a code-only option label and a context that names the card's visual or prototype with no url. A question about changing behaviour that exists today includes one option with existing: true, the current logic unchanged, worded as what happens now (it can also be recommended); a question about something with no current behaviour, such as a new feature's choice, has none, and question add refuses a second.";
// docs/adr/2026-11-18-2200-a-board-asks-a-board-on-another-of-your-hubs-while-its-online.md: or a board on another of
// the owner's hubs, as <hub>/<route>.
const askBoardLine =(b, key) => `When this repo doesn't explain why something is the way it is and another board in the hub owns that part, ask that board's orchestrator with \`${b} ask <route> "<question>" --from ${key}\` and carry on; a board on another of your hubs is <hub>/<route>, and \`${b} boards\` lists every one. \`${b} asks\` prints its answer, and \`${b} asks --wait\` waits for it.`;
// docs/adr/2026-11-18-2330-agents-read-the-cards-thread-and-notes-stop-copying-it.md: the thread is the owner's record,
// read with item thread; the notes hold the orchestrator's and planners' decisions and never quote it.
const threadCommand = (b, key) => `\`${b} item thread ${key}\``;
const threadLine = (b, key) => `The task's thread is the owner's record: ${threadCommand(b, key)} prints it in order, the owner's messages (who: love), their Implement and Reply words, their answers, and the board's and agents' lines. Read it first, and live; the notes never quote it.`;

// docs/adr/2026-11-04-1611-finishing-a-build-is-one-step.md: builder done finishes the card.
const finishSteps = ({ route, key, worktree, base }) => [
  `- With no unverified calls, done finishes the task itself: it rebases onto ${base} once, runs the tests the change affects once, fast-forwards ${base} and closes the task (on a board with pull requests it pushes the branch and opens a draft PR instead, titled by \`--title "<type>(<scope>): <what the PR does>"\`, a Conventional subject of at most 100 characters written from the whole diff, else the task's title; with Auto-merge off it stops before the fast-forward, and the task waits for the owner's Merge).`,
  `- On a conflict it undoes its rebase and names the files: run \`${rebase(base)}\` in ${worktree}, resolve each conflict keeping both sides' intent, continue with \`git -c core.commentChar=';' rebase --continue\`, and run done again, which runs the tests.`,
  '- On failing tests, fix them, commit, and run done again.',
  '- While another task is landing, done waits its turn and then lands; leave it running.',
  `- Finishing never goes to the orchestrator. If done refuses for a reason you can't fix, record it with \`${cli(route)} builder call ${key} "<why>"\` and run done again: with the call it hands the task back.`,
];
const finishCommand = ({ route, key }) => `\`${cli(route)} builder done ${key} --text "<what you checked>"\``;

// docs/adr/2026-11-06-0425-the-implementer-limit-counts-agents-and-a-card-spawns-helpers.md
// How a builder hands part of its card to helpers running beside it, which the board launches and counts.
const helperSteps = (b, key) => [
  `5. To run a separate part of the work in parallel, ask the board for a helper: \`${b} agent launch ${key} --name <short-name> --task "<the whole task, with the files and what to hand back>"\`, adding --writes when it changes code or runs tests (it gets its own worktree off your branch, and waits for a free implementer slot). Then \`${b} agent wait ${key} --name <short-name>\`, which prints its hand-back; it returns within 10 minutes, so run it again while it says still running, and do the task yourself if it says the helper exited. Merge a writing helper's work with \`${b} agent merge ${key} --name <short-name>\` before you finish.`,
];

// The standard brief for a card's headless builder. card: {route, key, ref, title, notes, worktree, base, rules, links}.
// With fix, {pr, failing: [check name]}, it is the fix run of a PR whose CI is red (docs/adr/2026-11-19-1500-red-ci-on-a-cards-pr-launches-its-builder.md).
export function builderBrief({ route, key, ref, title, notes, thread, worktree, base, rules = [], links = [], fix = null }) {
  const b = cli(route);
  return [
    `You are the headless builder for task ${ref} (${key}, "${title}") on the kickflip board /${route}. The board launched you; nobody watches this session, so never wait on a person. Work only in ${worktree}. Never restart the hub or a board server, and never push.`,
    '',
    ...(fix ? [
      `This run fixes red CI. The task's PR #${fix.pr} is open and failing ${fix.failing.length ? `the check${fix.failing.length === 1 ? '' : 's'} ${fix.failing.join(', ')}` : 'a check'}: your Next is to make it pass. Read the failing run's log (\`gh pr checks ${fix.pr}\`, then \`gh run view <run id> --log-failed\`), reproduce the failure locally where you can, and fix its cause on the PR's branch in ${worktree}. A failure the change didn't cause (a flake, an outage, main's own broken test) is not yours to fix: record it as a call "Not caused by this change: <check>, <why>" and finish. builder done pushes your commits to the PR's branch and opens no new PR.`,
      '',
    ] : []),
    `1. Run \`${b} builder start ${key} --kind build${fix ? ' --label "Fix CI"' : ''}\`. If it refuses, stop.`,
    `2. Report progress with \`${b} builder progress ${key} --phase reading|building|checking|landing "<plain, 80 characters or fewer>"\`, at least every 10 minutes. The board adds the phase word; don't start the text with it. The phases:`,
    '   - reading: the notes and the code, until the first test is written.',
    '   - building: the tests and the code, the runs of the tests you write or change, the ADR and docs, and the commit.',
    "   - checking: your own review of the diff before you hand back; the Orchestrator's review of your calls continues on the same bar.",
    '   - landing: set by the finish step itself; you never report it.',
    `3. Decide, record the call (step 4) and carry on: the orchestrator reviews your calls after the build. Ask it only when you are blocked, meaning every way forward would likely be thrown away: the spec contradicts itself or the code, a rule needs the owner's go before code is written, or the answer is a fact only the orchestrator has. Then run \`${b} builder ask ${key} "<question>"\`, do any work the answer can't change, and wait with \`${b} builder asks ${key} --wait\`, which returns within 10 minutes, so run it again while it says still waiting. If no answer comes in 30 minutes, record the question as a call, "Question: <question>", and hand back.`,
    `4. Record each judgment call the notes leave open with \`${b} builder call ${key} "<call>"\` instead of guessing silently or asking. A problem you find outside your task is a call "Found: <what>" for the orchestrator to file at review; ask about it at once only when it stalls other tasks' builds or lands.`,
    ...helperSteps(b, key),
    '',
    notes ? `Spec: the task's notes, ${notes}, all sections, where later sections override earlier ones.` : `The task has no notes file: build from its title, and record what you had to decide as calls.`,
    `${threadLine(b, key)} Read it with the notes: a message of the owner's is an instruction, and where a later one contradicts the notes, the owner's message wins. Read the thread again in checking, before you finish, for anything the owner wrote during the build. What reaches the task while you build (the orchestrator's words, the owner's messages, a new notes section) prints after a command or tool call as "New on ${key} while you build: …": take it in before you hand back.`,
    `In checking, list the deliverables the card asks for (the notes and the thread name them: a table, a before/after timing, a doc, a test) and tick each against evidence in your diff or output. A deliverable you could not produce, such as one that needs a local stack a headless run lacks, is a call "Missing: <deliverable>, <why>" (\`${b} builder call ${key} "<call>"\`), never a quiet gap.`,
    `A timing you measure while the host is busy (other builds, tests or lands running) is provisional: say so wherever you report it, and record the call as "Provisional: <timing>, taken while the host was busy".`,
    askBoardLine(b, key),
    '',
    ...linkLines(links),
    ...ruleLines(rules),
    `Write tests first, and run only the test files you write or change, with \`${b} test --dir ${worktree} --base ${base}\`, as part of building: it runs just those, or the repo's test script whole where it has one. Run no other test set, and don't rebase before you finish: the finish step rebases once and runs the tests your change affects once. Where the repo keeps ADRs, write one named with a timestamp: docs/adr/YYYY-MM-DD-HHMM-<slug>.md.`,
    "A process you start in the background (CPU load such as `yes` to reproduce a flake, a server, a watcher) you stop before the command that started it returns, with a `trap` or an explicit `kill`: never leave one running detached. builder done refuses while one still runs in your worktree, and names it.",
    `Commit with \`git -c core.commentChar=';' commit -F <file>\`: ${standardWords(ref)}. Land refuses any other shape.`,
    '',
    `To finish, run \`${b} builder done ${key} --risk low|medium|high --summary "${SUMMARY_HINT}" --text "<what you checked>"\`, picking one risk word.`,
    "- --summary is the owner's plain account of the build: it posts as the Builder's message in the thread, above your judgment calls, and done refuses without it. --text stays the short line of what you checked.",
    "- --risk is your judgment of how likely your change is to break something, from what it touches and how well the tests cover it: it colours the PR's Slack message for its reviewers.",
    "- If you recorded a judgment call, it hands the task back for the orchestrator to verify your calls; stop there: the orchestrator's verification finishes the task.",
    ...finishSteps({ route, key, worktree, base }),
    '',
    'Never push.',
  ].join('\n');
}

// The brief for a lander, launched (or, with resumed, sent to the card's builder session, with why the land needs it) once the session verified a handed-back build's calls. card as builderBrief's, with
// answers [{ask, question, answer}], the owner's answers to the asks the session deferred.
export function landerBrief({ route, key, ref, title, thread, worktree, base, answers = [], resumed = false, why }) {
  const b = cli(route);
  return [
    resumed
      ? `The board resumes you, the builder of task ${ref} (${key}, "${title}") on the kickflip board /${route}, to land your build: ${why ?? 'the orchestrator verified your judgment calls'}, and it waits only to land. Nobody watches this session, so never wait on a person. Work only in ${worktree}, never restart the hub or a board server, and never push.`
      : `You are the headless lander for task ${ref} (${key}, "${title}") on the kickflip board /${route}. Its build is done and the orchestrator verified its judgment calls; it waits only to land. Nobody watches this session, so never wait on a person. Work only in ${worktree}, never restart the hub or a board server, and never push.`,
    '',
    `1. Run \`${b} builder start ${key} --kind build --label Lander --phase landing --progress "taking up the verified build"\`. If it refuses, stop.`,
    `2. Report progress with \`${b} builder progress ${key} --phase landing "<plain, 80 characters or fewer>"\`. The board adds the phase word; don't start the text with it.`,
    ...(answers.length ? [
      "3. The owner answered the builder's deferred asks. Where an answer changes the build, change it, with its tests, and commit:",
      ...answers.map((a) => `- ${a.ask} "${a.question}": ${a.answer}`),
    ] : []),
    '',
    threadLine(b, key),
    `Commit with \`git -c core.commentChar=';' commit -F <file>\`: ${standardWords(ref)}. Land refuses any other shape, so reword a commit the build left in another.`,
    '',
    `To finish, run ${finishCommand({ route, key })}.`,
    ...finishSteps({ route, key, worktree, base }),
    '',
    'Never push.',
  ].join('\n');
}

// docs/adr/2026-11-06-0200-the-board-rebases-a-conflicting-pr-with-a-headless-run.md
// The brief for a rebase run, launched when the card's open PR, pr, conflicts with its base. card as builderBrief's. Its
// progress lines are the card's status line, so the brief gives their words; a conflict it can't resolve is a judgment
// call, which hands the card to the orchestrator.
export function rebaseBrief({ route, key, ref, title, thread, worktree, base, pr, resumed = false }) {
  const b = cli(route);
  return [
    ...(resumed ? [`The board resumes you, the builder of task ${ref}, for this run: the lines below are your brief for it.`] : []),
    `You are the headless rebase run for task ${ref} (${key}, "${title}") on the kickflip board /${route}. Its PR #${pr} conflicts with ${base}; rebase its branch onto ${base} so the PR is clean again. Nobody watches this session, so never wait on a person. Work only in ${worktree}, never restart the hub or a board server, and never push.`,
    '',
    `1. Run \`${b} builder start ${key} --kind build --label Rebase --phase building --progress "Rebase run started · fetching ${base}"\`. If it refuses, stop.`,
    `2. Run \`git fetch origin\`, then \`${rebase(`origin/${base}`)}\`. Resolve each conflict keeping both sides' intent, \`git add\` it and continue with \`git -c core.commentChar=';' rebase --continue\`. Report each step with \`${b} builder progress ${key} --phase building "<line>"\`, the board adds the phase word, in these words: "Rebasing onto ${base} · resolving <n> files".`,
    "3. Run no tests yourself: the finish step runs the tests the change affects. Fix what the rebase or a failing test broke, and commit each fix with `git -c core.commentChar=';' commit -F <file>`. A push with commits of its own is no longer rebase-only, so a merge after an approval won't count it as trivial.",
    `4. If a conflict or a failing test is past what you can resolve with confidence, run \`git -c core.commentChar=';' rebase --abort\` if a rebase is under way, record it with \`${b} builder call ${key} "Rebase failed in <the files or tests> · <why>"\`, and run the finish step: with the call it hands the task to the orchestrator.`,
    '',
    threadLine(b, key),
    '',
    `To finish, run ${finishCommand({ route, key })}, the text saying what you resolved. It runs the tests the change affects once before it pushes the branch to PR #${pr} with --force-with-lease; the PR stays as it is.`,
    `- If it refuses because someone pushed to the branch since your fetch, fetch and rebase again (step 2), then run done again.`,
    '- On failing tests, fix them, commit, and run done again.',
    '',
    'Never push.',
  ].join('\n');
}

// docs/adr/2026-11-12-0600-every-planner-launches-from-the-orchestrators-brief.md
// The orchestrator's brief, {heading, text} as its notes section, which a grill, prototype or visual agent reads before
// anything else, what naming what the agent makes; an agent with none is a bug, so it throws.
function orchestratorsBrief(brief, what) {
  if (!brief?.text) throw new Error("no orchestrator's brief: the board launches a grill, prototype or visual agent only from one (item brief)");
  return [`Start from the orchestrator's brief, its notes section "${brief.heading}": what the discussion settled, what is still open, and what your ${what} should cover, with the files that matter. Read it before the thread and the notes:`, '', brief.text, ''];
}

// One of the owner's prototype requests as a line of the planner's brief: for the owner's Prototype on one question, question
// (its id), note and choice; else the owner's text and files (uploads, {name, path}).
function requestLine({ text, files = [], question, note, choice }) {
  if (question) return `   - question ${question}${note ? `, noting "${note}"` : ''}${choice ? `, leaning to option ${choice}` : ''}: draw that question's next round, its question naming round_of ${question}.`;
  return `   - ${[text && `writing "${text}"`, files.length && `attaching ${files.map((f) => f.path).join(', ')}`].filter(Boolean).join(', ')}.`;
}

// The brief for a planner, a grill or a prototype, launched from the card and its notes so far. card as builderBrief's,
// with kind grill or prototype, repo the board's repo folder it reads, and a grill's the owner's text and files (uploads,
// {name, path}) when the request carried them. A prototype draws each round at once, one sub-agent each: one for each
// prototype the orchestrator's brief names and each of asks, the owner's requests (requestLine)
// (docs/adr/2026-11-14-2300-picked-prototypes-draw-in-parallel-and-their-records-merge-by-topic.md).
// prototype is the card's kept prototype answer (briefFacts), which the grill then never asks
// (docs/adr/2026-11-11-1700-a-cards-gates-are-facts-it-keeps.md). A grill ends on the card's Implement ask, never a
// question, bar on a kept yes, which the board acts on (docs/adr/2026-11-18-0100-implement-is-only-the-cards-tap.md).
export function plannerBrief({ route, key, ref, title, notes, thread, kind, repo, brief, rules = [], links = [], text, files = [], asks = [], prototype = null }) {
  const b = cli(route);
  const grill = kind === 'grill';
  return [
    `You are the headless ${grill ? 'grill' : 'prototype'} planner for task ${ref} (${key}, "${title}") on the kickflip board /${route}. The board launched you; nobody watches this session, so never wait on a person: the owner answers on the board, and a later planner or builder picks up from their answers. Read and run in ${repo}; write no output code ${grill ? 'there' : `in ${repo} itself`}, never restart the hub or a board server, and never push.`,
    '',
    ...orchestratorsBrief(brief, grill ? 'questions' : 'takes'),
    `1. Run \`${b} builder start ${key} --kind ${kind}\`. If it refuses, stop.`,
    `2. Gather the context yourself: ${notes ? `the task's notes, ${notes}, all sections, where later sections override earlier ones; ` : 'the task has no notes file yet; '}its thread, ${threadCommand(b, key)} (the owner's record, which the notes never quote), the repo's docs/adr and CONTEXT.md, and the tasks its notes and thread link. ${askBoardLine(b, key)}`,
    `3. Report progress with \`${b} builder progress ${key} "<plain, 80 characters or fewer>"\` at least every 10 minutes.`,
    grill
      ? `4. Find every decision the task leaves open: read the code it touches and answer what the code answers yourself. Post each decision left as a question for the owner with \`${b} question add --file <json>\` on topic item:${key}, one per decision, your recommendation first. ${STANDALONE} Once you finish, the orchestrator screens them before the owner sees them, settling the ones the board already answers and passing the owner the rest.`
        + ' Invoke the grilling skill with the Skill tool and run it as one round: its questions go to the board with question add, never into the chat, and you never wait for an answer; after the round, finish. (With no Skill tool, follow this step as written.)'
        + ` When the code shows the task has separable parts, each a build of its own, propose splitting it into smaller tasks as one question: its options "Split as proposed" and "Keep as one task", your recommendation first. Slice it as ~/.claude/skills/to-tickets/SKILL.md step 3, "Draft vertical slices", says (read that step; you can't invoke the skill, and skip its quiz and publish steps). The first task is the thinnest end-to-end path. The question's context lists each proposed task with its title, its scope, the files it touches and the earlier proposed tasks it waits on, or none: a task waits on an earlier one only when it builds on that task or shares its seam (the same function, component, CLI command or doc paragraph); sharing only a file waits on nothing. Write the same breakdown in your notes section. On Split the orchestrator files the tasks when the task stages; never file them yourself.`
        + (prototype === 'yes'
          ? " The task keeps the owner's answer to its prototype question, yes, so end with no Implement ask: once every question you ask is answered, or as you finish when you ask none, the board moves the task to prototyping."
          : ` End the round on the task's Implement ask, never a question: as your last step, once your questions are added, run \`${b} thread ${key} --implement --text "<what to answer first, then tap Implement>"\`. Once the owner has answered every question, or as you finish when you ask none, the board returns the task to discussing with Implement as its next action, and only the owner's Implement tap stages it. No question offers Implement: question add refuses one with an Implement option.`)
        + " Never ask whether to make a ticket: the board makes a task's ticket when it goes ready."
      : `4. Draw each prototype as its own round, all at once: each prototype the orchestrator's brief names, which the owner picked from its suggestions, and each of the owner's requests below, one round each. When the brief names none and no request names a question, find the design questions worth seeing yourself, one round each. Before any round is drawn, give each its own topic, in a-z, 0-9 and "-", that no other round and no prototype \`${b} prototype list\` shows uses. Then launch one sub-agent per round with the Agent tool, all in one message so they draw in parallel, each on your own model (give it no model), a lone round too. Brief each sub-agent with its topic, what its round shows, the request it answers and the rest of this step, which it does for its topic alone; wait for them all, then go on to step 5 yourself.`
        + ` Each round, in its sub-agent: Invoke the prototype skill with the Skill tool and build the round as take files, one per option: record them with \`${b} prototype add <topic> --card ${key} --take <K>:<label> …\`, write the take files it prints, built from the repo's existing components, helpers and scripts fed mock data (the prototype template loads the board's scripts, so a take reuses the board's components; a hub-page take reuses them by path or copy), each take showing the states it needs inside itself, then post one question whose url opens prototype-<topic>.html with \`${b} question add --file <json>\` on topic item:${key}, never asking in the chat. ${STANDALONE} Build in situ only where one of the board's rules asks for it: then, run \`${b} prototype base\` yourself before the sub-agents launch, which makes it or moves it to main and prints its path, whether its build script is there and the listener a page loads. When the build script is missing, write one there that serves the app and prints "port <n>" (board/build-script.mjs). Each round adds one page to the worktree, at a path no other round uses, built from the repo's real components, helpers and scripts fed mock data, fully interactive; it reads the take from ?variant= and the state from ?state=, and loads the listener so \`KickflipPrototype.on((take, state) => …)\` re-renders it in place when the viewer switches. Record it with \`${b} prototype add <topic> --card ${key} --served <path> --take <K>:<label> … --state <key>:<label> …\`, one take per option and one state for each state that matters to the question, then post one question whose url opens prototype-<topic>.html with \`${b} question add --file <json>\` on topic item:${key}, never asking in the chat. (With no Skill tool, follow this step as written.)`,
    ...(grill && text ? [`   The owner asked for this grill, writing: "${text}"`] : []),
    ...(grill && files.length ? [`   The owner attached: ${files.map((f) => f.path).join(', ')}.`] : []),
    ...(!grill && asks.length ? ["   The owner's requests, one round each:", ...asks.map(requestLine)] : []),
    `5. Record what you learned in the task's notes, naming each answered question's id: write it in ${DRAFT}, then run ${notesCommand(b, key, `${grill ? 'Grill' : 'Prototype'} (<MM/DD>)`)}, which appends it as a section. The notes file is read-only; never write into it. Notes hold what you found and decided, never quotes of the owner's words: they stay in the thread. Anything you leave open becomes a question with question add, never only a line in the notes, so the task can't go ready past it. A question's text is one line of at most ${BRIEF_LINE_LIMIT} characters (question add refuses a longer one); put the detail in its context and the options' details, which take markdown.`,
    ...(grill ? [
      `6. Where the owner asked for prototypes, or a rule here wants a UI prototype first, end the task \`${b} item set ${key} --phase prototyping\` instead and skip the Implement ask. Otherwise ${prototype === 'yes' ? 'the board' : "the owner's Implement tap"} is what moves the task on: never set it ready yourself, and never leave a Next that asks the owner to mark it ready.`,
    ] : []),
    '',
    ...linkLines(links),
    ...ruleLines(rules, "Rules from the hub and this board, written for the orchestrator: where one tells you to push, land, restart the hub or a board server, or do the orchestrator's work, it isn't yours; you never push or restart:"),
    `To finish, run \`${b} builder done ${key}\`.`,
    '',
    'Never push.',
  ].join('\n');
}

// docs/adr/2026-11-05-1921-a-visual-is-a-page-an-agent-draws-for-a-thread.md
// The brief for a visual agent: one HTML page answering the owner's visual request in the card's thread. card as
// plannerBrief's, with agent its record's name and the owner's text and files when the request carried them. A final
// visual's (brief.final) shows a UI change as it will be built, and its page's line marks the card's Implement
// (docs/adr/2026-11-17-1600-a-final-visual-ends-on-the-cards-implement.md).
export function visualBrief({ route, key, ref, title, notes, thread, repo, agent, brief, rules = [], links = [], text, files = [] }) {
  const b = cli(route);
  const final = Boolean(brief?.final);
  return [
    `You are the headless visual agent for task ${ref} (${key}, "${title}") on the kickflip board /${route}. The task's thread wants a visual: one HTML page that answers in a visual way, such as a diagram, a flow or a comparison. ${final ? "It is the final visual of a UI change: it shows the change as it will be built, for the owner to confirm with the task's Implement or to change with a note in the thread; it is not a prototype" : 'It is not a prototype or a grill'}: no question, no takes. The board launched you; nobody watches this session, so never wait on a person. Read and run in ${repo}; write no code there, never restart the hub or a board server, and never push.`,
    '',
    ...orchestratorsBrief(brief, 'page'),
    `1. Run \`${b} builder start ${key} --kind visual --agent ${agent}\`. If it refuses, stop.`,
    `2. Gather what the page needs: ${notes ? `the task's notes, ${notes}; ` : ''}its thread, ${threadCommand(b, key)}, and the code or docs it is about.`,
    ...(text ? [`   The owner wrote, asking for it: "${text}"`] : []),
    ...(files.length ? [`   The owner attached: ${files.map((f) => f.path).join(', ')}.`] : []),
    '3. Write one HTML file outside the repo, such as in a temporary folder. Keep its own CSS and script inline; it may load a library such as Mermaid or D3 from a CDN. Make it read well at phone width (390px) and on a desktop, in the dark and the light theme (prefers-color-scheme).',
    final
      ? `4. Place it with \`${b} visual add ${key} --file <page.html> --title "<what it shows>" --implement\`, which copies it to the board, links it in the thread and makes the task's Implement its next action. When it refuses because the task is already staged, ready or past Todo, the owner has had Implement: place it again without --implement.`
      : `4. Place it with \`${b} visual add ${key} --file <page.html> --title "<what it shows>"\`, which copies it to the board and links it in the thread.`,
    '',
    'Write nothing else: no notes, questions, task state, Next or progress lines.',
    '',
    ...linkLines(links),
    ...ruleLines(rules, "Rules from the hub and this board, written for the orchestrator: where one tells you to push, land, restart the hub or a board server, or do the orchestrator's work, it isn't yours; you never push or restart:"),
    `To finish, run \`${b} builder done ${key} --agent ${agent}\`.`,
    '',
    'Never push.',
  ].join('\n');
}

// docs/adr/2026-11-16-2300-review-in-a-thread-launches-a-reviewer.md
// The brief for a reviewer: an adversarial review of the card's diff (target diff, in its worktree against base) or of
// its plan (target plan, its notes), its verified findings posted as one ranked thread message with reviewer post. card as
// visualBrief's, with target, worktree and base.
export function reviewerBrief({ route, key, ref, title, notes, thread, repo, agent, brief, target, worktree, base, rules = [], links = [], text, files = [] }) {
  const b = cli(route);
  const diff = target === 'diff';
  return [
    `You are the headless reviewer for task ${ref} (${key}, "${title}") on the kickflip board /${route}. The owner asked for a review in the task's thread: attack ${diff ? 'its diff' : 'its plan'} and report what is wrong with it. The board launched you; nobody watches this session, so never wait on a person. Read and run in ${repo}; write no code anywhere, never commit, never restart the hub or a board server, and never push.`,
    '',
    ...orchestratorsBrief(brief, 'review'),
    `1. Run \`${b} builder start ${key} --kind ${REVIEWER} --agent ${agent}\`. If it refuses, stop.`,
    `2. Read what the task is for: ${notes ? `its notes, ${notes}, all sections, where later sections override earlier ones; ` : ''}its thread, ${threadCommand(b, key)}, and the repo's CONTEXT.md and docs/adr where they bear on it.`,
    ...(text ? [`   The owner wrote, asking for it: "${text}"`] : []),
    ...(files.length ? [`   The owner attached: ${files.map((f) => f.path).join(', ')}.`] : []),
    diff
      ? `3. Review the diff: \`git -C ${worktree} diff ${base}\` (the branch's commits and any uncommitted work against ${base}), and read the code around each change in ${worktree}. Look for bugs, a broken caller, a state the change doesn't handle, a race, a test that doesn't test what it says, and anything the notes ask for that the diff misses or contradicts.`
      : '3. Review the plan: the notes and the thread, against the code they name. Look for a contradiction, a decision left open, a case the plan misses, a step the code makes harder than the plan assumes, and a cheaper way to the same end.',
    '   Verify each finding before you keep it: read the code or run a read-only command that shows it. Drop what you cannot show; a short list of real findings beats a long one.',
    `4. Write the findings as a JSON list in a file outside the repo, each {"severity": "high" | "medium" | "low", "at": "<file>:<line>", "text": "<the concrete failure, one sentence>"}, "at" left out where no line holds it. Post them with \`${b} reviewer post ${key} --file <findings.json>\`, which ranks them and posts one message in the thread; post an empty list when you find nothing.`,
    '',
    'Write nothing else: no notes, questions, task state, Next or progress lines.',
    '',
    ...linkLines(links),
    ...ruleLines(rules, "Rules from the hub and this board, written for the orchestrator: where one tells you to push, land, restart the hub or a board server, or do the orchestrator's work, it isn't yours; you never push or restart:"),
    `To finish, run \`${b} builder done ${key} --agent ${agent}\`.`,
    '',
    'Never push.',
  ].join('\n');
}

// docs/adr/2026-11-06-0425-the-implementer-limit-counts-agents-and-a-card-spawns-helpers.md
// The brief for a helper another agent on the card asked for (runs.mjs requestHelper): its task, in cwd, its own
// worktree when it writes, else the card's or the board's repo read-only. card as builderBrief's, with agent its name,
// task, writes and cwd. It reports and finishes as its own agent, and its done --text is what its spawner reads.
export function helperBrief({ route, key, ref, title, notes, thread, agent, task, writes, cwd, rules = [], links = [] }) {
  const b = cli(route);
  return [
    `You are the headless helper ${agent} on task ${ref} (${key}, "${title}") on the kickflip board /${route}. Another agent working on the task asked the board for you to do one task beside it, and waits on your hand-back. Nobody watches this session, so never wait on a person. Never restart the hub or a board server, and never push.`,
    writes
      ? `Work only in ${cwd}, your own worktree, branched from the task's: commit your work there with \`git -c core.commentChar=';' commit -F <file>\`: ${standardWords(ref)}. The task's builder merges your branch, so leave nothing uncommitted.`
      : `Read and run in ${cwd}; change no files there and commit nothing.`,
    '',
    'The task:',
    task,
    '',
    `1. Run \`${b} builder start ${key} --kind helper --agent ${agent}\`. If it refuses, stop.`,
    `2. Report progress with \`${b} builder progress ${key} --agent ${agent} --phase reading|building|checking "<plain, 80 characters or fewer>"\` at least every 10 minutes; the board adds your name and the phase word.`,
    "3. Do only the task. Don't ask the orchestrator or the owner, record no judgment calls and post no questions: put any decision you had to make in your hand-back.",
    notes ? `   The task's notes, for context: ${notes}.` : '',
    `   ${threadLine(b, key)}`,
    '',
    ...linkLines(links),
    ...ruleLines(rules, "Rules from the hub and this board, written for the orchestrator: where one tells you to push, land, restart the hub or a board server, or do the orchestrator's work, it isn't yours; you never push or restart:"),
    `To finish, run \`${b} builder done ${key} --agent ${agent} --text "<your hand-back: what you did or found, ${writes ? 'what you committed, ' : ''}and any decision you made>"\`.`,
    '',
    'Never push.',
  ].filter((l, i, all) => l !== '' || all[i - 1] !== '').join('\n');
}

// The agents launchBuilder started, of agents each {pid, at} as runs.mjs openAgents reads them, whose process still
// runs. Pids get reused, so a pid counts only while its process started within LAUNCH_WINDOW before the session was
// recorded; with no answer from ps, none does.
const LAUNCH_WINDOW = 60_000;
export function launchedAgents(agents, { starts = processStarts } = {}) {
  const pids = agents.filter((a) => a.pid && a.at).map((a) => a.pid);
  const started = (pids.length && starts(pids)) || new Map();
  return agents.filter((a) => {
    const at = started.get(a.pid);
    return at !== undefined && at <= Date.parse(a.at) && at >= Date.parse(a.at) - LAUNCH_WINDOW;
  });
}

// Whether the agent launchBuilder started may still run: false only when ps answered and its process isn't listed.
// With no answer from ps its liveness is unknown, so it may run (a closing check never reads a busy Mac as a dead agent).
export function agentMayRun(agent, { starts = processStarts } = {}) {
  return starts([agent.pid]) === null || launchedAgents([agent], { starts }).length > 0;
}

// Whether a card already has a builder, from its open builder records (runs.mjs openRuns): one with no process yet is a
// start whose launch is still to come, and one with a process counts while agentMayRun says it may run. A card that has
// one is never started again, so a second pull pass, or a resume, never puts a second builder beside the first.
export function hasBuilder(runs, { starts = processStarts } = {}) {
  return runs.some((r) => !r.pid || agentMayRun(r, { starts }));
}

// Stops the agents launchBuilder started (launchedAgents): SIGTERM to each agent's process group (it leads its own, so
// its children go too), SIGKILL after killAfter ms. → how many it signalled.
export function stopAgents(agents, { starts = processStarts, kill = (pid, sig) => process.kill(-pid, sig), killAfter = 5000 } = {}) {
  const mine = launchedAgents(agents, { starts });
  for (const { pid } of mine) {
    try { kill(pid, 'SIGTERM'); } catch { continue; }
    setTimeout(() => { try { kill(pid, 'SIGKILL'); } catch {} }, killAfter).unref();
  }
  return mine.length;
}

// docs/adr/2026-11-05-1809-the-orchestrator-stops-the-boards-own-runs.md
// Stops the runs whose processes lead the process groups leaders, with every process under them: each group holding a
// leader's process or one descended from it, so a land's suite, which runs detached in a group of its own, goes too.
// SIGTERM to each group, then SIGKILL to what still runs after grace ms. ps reads the process table (live.mjs ps by
// default). → the processes it stopped, each {pid, args}.
export async function stopRuns(leaders, { grace = 5000, ps: ask = ps } = {}) {
  const psArgs = ['-A', '-o', 'pid=,ppid=,pgid=,args='];
  // A loaded Mac can outlast ps's timeout once; the retry is the second try before it refuses.
  const table = ask(psArgs) ?? ask(psArgs);
  if (table === null) throw new BoardError('ps gave no answer, so nothing was stopped; run it again');
  const rows = table.split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean)
    .map(([, pid, ppid, pgid, args]) => ({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), args }));
  const members = new Set(rows.filter((r) => leaders.includes(r.pgid)).map((r) => r.pid));
  for (let grew = true; grew;) {
    grew = false;
    for (const r of rows) if (!members.has(r.pid) && members.has(r.ppid)) { members.add(r.pid); grew = true; }
  }
  // Never this process's own group, nor init's: a group of 1 would be every process.
  const own = rows.find((r) => r.pid === process.pid)?.pgid;
  const stopped = rows.filter((r) => members.has(r.pid) && r.pgid > 1 && r.pgid !== own);
  const groups = [...new Set(stopped.map((r) => r.pgid))];
  const signal = (sig) => { for (const g of groups) try { process.kill(-g, sig); } catch {} };
  signal('SIGTERM');
  const deadline = Date.now() + grace;
  while (stopped.some((r) => pidAlive(r.pid)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  if (stopped.some((r) => pidAlive(r.pid))) signal('SIGKILL');
  return stopped.map(({ pid, args }) => ({ pid, args }));
}

export const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

const logsDir = () => path.join(os.homedir(), '.claude', 'kickflip', 'logs');
// A run's log, <role>-<card id>-<time>.log, role the first word of the run's role (Builder, Visual agent, Helper
// tests…) lower-cased, which AGENT_LOG matches.
const logFile = (id, role) => path.join(logsDir(), `${role}-${id}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
export const AGENT_LOG = /^(?:builder|visual|reviewer|helper|planner|lander|rebase)-.+\.log$/;

// docs/adr/2026-11-18-2030-a-launch-is-one-exclusive-claim.md
// The folder of the launch claims of the board at site, one file per run: its card and agent.
const claimsDir = (site) => path.join(site, 'data', 'launches');
const claimName = (key, agent) => `${key}~${agent}`;
// Frees the card's agent's launch claim, as its run ends or is stopped, so a later run of it launches.
export const releaseLaunch = (site, key, agent = 'main') => release(claimsDir(site), claimName(key, agent));
// Whether the board launched the card's agent and that launch is under way or its process lives.
export const launchLives = (site, key, agent = 'main') => claimed(claimsDir(site), claimName(key, agent));

// Launches through launch, with args, only if this process wins the exclusive claim on the card's agent, so two servers
// or passes deciding to launch the same run launch it once. The claim holds the launched process's pid from its spawn.
// → launch's answer, or null when another process holds the claim; a launch that rejects frees the claim.
async function launchClaimed(site, key, agent, launch, args, { spawned } = {}) {
  const claim = claimLaunch(claimsDir(site), claimName(key, agent));
  if (!claim) return null;
  try {
    const launched = await launch({ ...args, onSpawn: (pid) => { claim.settle(pid); spawned?.(pid); } });
    claim.settle(launched.pid);
    return launched;
  } catch (e) {
    claim.release();
    throw e;
  }
}

// Launches the agent of a build startTappedBuild started ({key, kind, model}), the rebase run when the card has one
// open (runs.mjs startRebase's rebase_run, so a relaunch after a restart briefs it the same), with lander the lander of
// a verified card, or with planner the planner startPlanner opened ({key, kind: grill|prototype, model, a grill's text? and
// files?, a prototype's asks [{text?, files?, question?, note?, choice?}]}) or the visual agent startVisual opened ({key, kind: visual, model, agent, text?, files?}), through the
// adapter, launch (agents.mjs launchAgent's arguments and answer; launchAgent itself unless a test passes its own): a
// build or lander as its record's kind, a planner as Claude. handoff ({why, last}), for a build or lander that carries
// on from a session past the cap (resumeBuilder), adds handoffLines to its brief, read with the branch's commits and diff
// stat against the base. The session id it names goes on the agent's builder record
// and, with the log, in a thread line saying so.
// → {pid, sessionId, log}, null when another process holds the launch claim on the card's agent (launchClaimed); rejects
// when the agent can't start.
export async function launchBuilder(site, { key, kind = 'claude', model, agent = 'main', brief, text, files, asks, task, writes, worktree, target }, { lander = false, handoff, launch = launchAgent } = {}) {
  const facts = await briefFacts(site, key);
  const route = boardAt(site)?.route ?? path.basename(site);
  const rules = [...readHubRules(), ...(await readBoardRules(site))].map((r) => r.text);
  const { base, repo } = builderRepo(site, { id: key.split('/')[1] });
  const planner = plans({ kind });
  const helper = kind === HELPER;
  const rebase = !planner && !helper && !lander && facts.rebasePR !== null;
  const visual = kind === VISUAL;
  const cwd = planner ? repo : helper ? worktree ?? facts.worktree ?? repo : facts.worktree;
  const reviewer = kind === REVIEWER;
  const card = { ...facts, route, base, repo, rules, kind, agent, brief, text, files, asks, task, writes, cwd, target, pr: facts.rebasePR, fix: facts.fixRun };
  const role = visual ? 'Visual agent' : reviewer ? 'Reviewer' : helper ? `Helper ${agent}` : planner ? 'Planner' : lander ? 'Lander' : rebase ? 'Rebase run' : 'Builder';
  const roleBrief = visual ? visualBrief(card) : reviewer ? reviewerBrief(card) : helper ? helperBrief(card) : planner ? plannerBrief(card) : lander ? landerBrief(card) : rebase ? rebaseBrief(card) : builderBrief(card);
  const prompt = handoff
    ? [roleBrief, ...handoffLines({ ...handoff, commits: git(cwd, 'log', '--oneline', `${base}..HEAD`).out, stat: git(cwd, 'diff', '--stat', `${base}...HEAD`).out })].join('\n')
    : roleBrief;
  const log = logFile(key.split('/')[1], role.split(' ')[0].toLowerCase());
  // The record names the process and its log from the spawn, before the session id arrives, so a restart in that gap
  // still finds what resume needs (sessionIdOf reads the id from the log).
  let atSpawn = Promise.resolve();
  const launched = await launchClaimed(site, key, agent, launch, { kind: planner || helper ? 'claude' : kind, model, cwd, site, prompt, log }, { spawned: (pid) => { atSpawn = recordSession(site, key, null, pid, agent, path.basename(log)); } });
  if (!launched) return null;
  await atSpawn;
  await recordSession(site, key, launched.sessionId, launched.pid, agent, path.basename(launched.log));
  return launched;
}

// The Claude session id a record's session names: its id, else the id its log's init line gave, which a launch cut off
// before it recorded the id still has. null when neither.
export function sessionIdOf(session) {
  if (session?.id) return session.id;
  if (!session?.log) return null;
  let text;
  try { text = fs.readFileSync(path.join(logsDir(), session.log), 'utf8'); } catch { return null; }
  for (const line of text.split('\n')) {
    try { const e = JSON.parse(line); if (e.session_id) return e.session_id; } catch { /* not a stream-json line */ }
  }
  return null;
}

// Why a Claude run whose process is gone failed, read from its stream-json log: null when its last result event is a
// clean one, that event's text when it is an error, and words of its own when the log has no result event (the run was
// killed or crashed) or can't be read.
const NO_RESULT = 'its process ended before it finished';
export function runFailure(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return NO_RESULT; }
  for (const line of text.split('\n').reverse()) {
    try {
      const e = JSON.parse(line);
      if (e.type === 'result') return e.is_error ? String(e.result || e.subtype || NO_RESULT).split('\n')[0].slice(0, 200) : null;
    } catch {}
  }
  return NO_RESULT;
}

// docs/adr/2026-11-09-1300-a-card-pause-stops-its-builder-at-its-next-stopping-point.md
// docs/adr/2026-11-09-1500-a-builder-resumes-to-land-its-own-conflict.md
// The words a paused builder's own session is resumed with, once its pause cleared ("nothing blocks it").
export const resumeBrief = ({ ref, worktree, cleared }) => `The board paused your build of task ${ref}, and the pause has cleared: ${cleared}. Carry on where you stopped, in ${worktree}, following your brief as before. Your builder record is still open, so don't run builder start again.`;

// docs/adr/2026-11-16-0007-builder-resume-updates-a-running-builder-or-resumes-a-handed-back-one.md
// The words a handed-back builder's own session is resumed with on the orchestrator's builder resume: the news since its
// hand-back (runs.mjs takeRerun's lines), the orchestrator's last.
export const rerunBrief = ({ ref, worktree, news }) => [
  `The orchestrator resumes your handed-back build of task ${ref} to change it. Carry on in ${worktree}, on the same branch, following your brief as before: amend your build to what follows, record your calls, and finish with builder done again. Your builder record is open again, so don't run builder start.`,
  ...news,
].join('\n');

// docs/adr/2026-11-15-0040-a-cold-resume-past-150k-starts-a-fresh-agent-with-a-handoff.md
// A resume reads the session's whole context again, and once the prompt cache (an hour) has gone cold it pays for all of
// it, so a session past CONTEXT_CAP tokens whose last turn is WARM or older goes to a fresh agent instead.
export const CONTEXT_CAP = 150_000;
const WARM = 60 * 60_000;

// A Claude session's state from its newest run's stream-json log: context, the tokens its last top-level turn (not a
// sub-agent's) read, input, cache read and cache write; at, that turn's time; and last, the run's last message, its
// result's text, else its last top-level text. null when the log can't be read or holds no top-level turn.
export function sessionState(file) {
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { return null; }
  let state = null;
  let result = null;
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'result') result = typeof e.result === 'string' ? e.result.trim() : null;
    if (e.type !== 'assistant' || e.parent_tool_use_id || !e.message?.usage) continue;
    const u = e.message.usage;
    const text = (e.message.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
    state = { context: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), at: e.timestamp, last: text || state?.last || null };
  }
  return state && { ...state, last: result || state.last };
}

// Whether a card's builder session resumes, from its sessionState (null: its size is unknown, so it resumes, as before
// the cap): under CONTEXT_CAP, or with its last turn under WARM old, it does. Otherwise a fresh agent carries on: a land
// (a lander or rebase run) on Sonnet, and a build's carry-on on the build's own model.
// → {resume: true} or {resume: false, model}.
export function resumeChoice(state, { now = Date.now(), land, model }) {
  if (!state || state.context < CONTEXT_CAP || now - Date.parse(state.at) < WARM) return { resume: true };
  return { resume: false, model: land ? 'sonnet' : model };
}

// The handoff a fresh agent past the cap reads after its brief: why it carries on (a sentence, when the caller has one),
// the branch's commits and diff stat against the base, and the old session's last message.
export function handoffLines({ why, commits, stat, last }) {
  return [
    '',
    `Handoff: this task's builder session ran past ${CONTEXT_CAP / 1000}k tokens of context, so you carry on in its place. Its work so far is on the branch in the worktree; read it before you change anything.`,
    ...(why ? [`Why it carries on: ${why}`] : []),
    'Commits on the branch:', commits || '(none)',
    'Diff stat against the base:', stat || '(none)',
    "The old session's last message:", last || '(none)',
  ];
}

// The one seam where the board puts a card's builder session back to work: every resume (a cleared pause, a verified
// land, a Merge tap's conflict, a PR rebase run) goes through here, and none of them knows how. card is {key, kind,
// model}; brief(facts) the words the session is resumed with, facts as runs.mjs briefFacts'. A Claude build whose
// record keeps a session id resumes it in the card's worktree, unless resumeChoice, reading the session's log
// (session.log, the basename recordSession keeps), sends it to a fresh agent: launched with the handoff, why the
// sentence saying why it carries on, land whether it lands (a lander or rebase run), and a "Fresh builder" thread line.
// A Codex build, one with no session (a session's own build, which the board never launched), or one the caller says
// to take fresh (fresh) is launched anew. freshLaunch is a fresh launch's launchBuilder options. launch starts the agent
// either way, as launchBuilder's does.
// → {pid, sessionId, log, resumed}, resumed whether the session continued.
export async function resumeBuilder(site, { key, kind = 'claude', model, session, brief, why, land = false, fresh = false, freshLaunch = {}, launch = launchAgent }) {
  if (kind !== 'claude' || !session || fresh) return withResumed(await launchBuilder(site, { key, kind, model }, { ...freshLaunch, launch }), false);
  const state = session.log ? sessionState(path.join(logsDir(), session.log)) : null;
  const choice = resumeChoice(state, { land, model });
  if (!choice.resume) {
    const launched = await launchBuilder(site, { key, kind, model: choice.model }, { ...freshLaunch, handoff: { why, last: state.last }, launch });
    if (launched) await appendStatus(site, key, 'fresh-builder', { cap: CONTEXT_CAP / 1000 });
    return withResumed(launched, false);
  }
  const facts = await briefFacts(site, key);
  const launched = await launchClaimed(site, key, 'main', launch, { kind, model, cwd: session.worktree ?? facts.worktree, site, prompt: brief(facts), resume: session.id, log: logFile(key.split('/')[1], 'builder') });
  if (!launched) return null;
  await recordSession(site, key, launched.sessionId ?? session.id, launched.pid, 'main', path.basename(launched.log));
  return { ...launched, resumed: true };
}
const withResumed = (launched, resumed) => launched && { ...launched, resumed };

// Lands a card through its own builder: its newest session, resumed with the lander's brief (landerBrief, why saying what
// the land hit), or with the rebase run's when the card has one open. A session recorded in another worktree than the
// one the run works in isn't resumed. A resume whose launch fails, like a card with nothing to resume, gets today's
// fresh lander (or rebase run). launch starts the agent, as resumeBuilder's does. → resumeBuilder's.
export async function landByBuilder(site, { key, kind = 'claude', model }, { why, fresh = false, launch = launchAgent } = {}) {
  const found = await recordedSession(site, key);
  const facts = await briefFacts(site, key);
  const rebase = facts.rebasePR !== null;
  const session = found && (!rebase || found.worktree === facts.worktree) ? found : null;
  const route = boardAt(site)?.route ?? path.basename(site);
  const { base } = builderRepo(site, { id: key.split('/')[1] });
  const brief = (f) => (rebase ? rebaseBrief : landerBrief)({ ...f, route, base, pr: f.rebasePR, why, resumed: true });
  const freshLaunch = { lander: !rebase };
  let launched;
  try {
    launched = await resumeBuilder(site, { key, kind, model, session, brief, why: why && `The land hit this: ${why}.`, land: true, fresh, freshLaunch, launch });
  } catch (e) {
    if (!session) throw e;
    launched = await resumeBuilder(site, { key, kind, model, session: null, brief, freshLaunch, launch });
  }
  if (launched?.resumed) await appendBuilderResumed(site, key);
  return launched;
}
