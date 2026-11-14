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
import { builderRepo } from './worktree.mjs';
import { standardWords } from './commit-message.mjs';
import { appendStatus, BoardError, briefFacts, readBoardRules, recordedSession, recordSession } from './store.mjs';
import { HELPER, plans, VISUAL } from './domain.mjs';

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
  "Related cards: read their notes for context; don't build their scope.",
  ...links.map((l) => `- ${l.ref} "${l.title}" (${l.relation}, ${l.lane}): ${l.notes ? `notes ${l.notes}` : 'no notes'}, thread ${l.thread}`),
  '',
] : []);
// docs/adr/2026-11-11-1100-every-agent-brief-names-the-cards-thread-file.md: the card's thread, by its exact file.
const threadLine = (thread) => `The card's thread, which holds the owner's messages (who: love): ${thread}. Read it live.`;

// docs/adr/2026-11-04-1611-finishing-a-build-is-one-step.md: builder done finishes the card.
const finishSteps = ({ route, key, worktree, base }) => [
  `- With no unverified calls, done finishes the card itself: it rebases onto ${base}, reruns the tests the change affects, fast-forwards ${base} and closes the card (on a board with pull requests it pushes the branch and opens a draft PR instead, titled by \`--title "<type>(<scope>): <what the PR does>"\`, a Conventional subject of at most 100 characters written from the whole diff, else the card's title; with Auto-merge off it stops before the fast-forward, and the card waits for the owner's Merge).`,
  `- On a conflict it undoes its rebase and names the files: run \`${rebase(base)}\` in ${worktree}, resolve each conflict keeping both sides' intent, continue with \`git -c core.commentChar=';' rebase --continue\`, rerun the tests, and run done again.`,
  '- On failing tests, fix them, commit, and run done again.',
  '- While another card is landing, done waits its turn and then lands; leave it running.',
  `- Finishing never goes to the orchestrator. If done refuses for a reason you can't fix, record it with \`${cli(route)} builder call ${key} "<why>"\` and run done again: with the call it hands the card back.`,
];
const finishCommand = ({ route, key }) => `\`${cli(route)} builder done ${key} --text "<what you checked>"\``;

// docs/adr/2026-11-06-0425-the-implementer-limit-counts-agents-and-a-card-spawns-helpers.md
// How a builder hands part of its card to helpers running beside it, which the board launches and counts.
const helperSteps = (b, key) => [
  `5. To run a separate part of the work in parallel, ask the board for a helper: \`${b} agent launch ${key} --name <short-name> --task "<the whole task, with the files and what to hand back>"\`, adding --writes when it changes code or runs tests (it gets its own worktree off your branch, and waits for a free implementer slot). Then \`${b} agent wait ${key} --name <short-name>\`, which prints its hand-back; it returns within 10 minutes, so run it again while it says still running, and do the task yourself if it says the helper exited. Merge a writing helper's work with \`${b} agent merge ${key} --name <short-name>\` before you test and finish.`,
];

// The standard brief for a card's headless builder. card: {route, key, ref, title, notes, worktree, base, rules, links}.
export function builderBrief({ route, key, ref, title, notes, thread, worktree, base, rules = [], links = [] }) {
  const b = cli(route);
  return [
    `You are the headless builder for card ${ref} (${key}, "${title}") on the kickflip board /${route}. The board launched you; nobody watches this session, so never wait on a person. Work only in ${worktree}. Never restart the hub or a board server, and never push.`,
    '',
    `1. Run \`${b} builder start ${key} --kind build\`. If it refuses, stop.`,
    `2. Report progress with \`${b} builder progress ${key} --phase reading|building|testing|checking|landing "<plain, 80 characters or fewer>"\`, at least every 10 minutes. The board adds the phase word; don't start the text with it. The phases:`,
    '   - reading: the notes and the code, until the first test is written.',
    '   - building: the tests and the code, the ADR and docs, and the commit.',
    '   - testing: the run of the tests your change affects, before you finish.',
    "   - checking: your own review of the diff before you hand back; the Orchestrator's review of your calls continues on the same 4th bar.",
    '   - landing: set by the finish step itself; you never report it.',
    `3. Decide, record the call (step 4) and carry on: the orchestrator reviews your calls after the build. Ask it only when you are blocked, meaning every way forward would likely be thrown away: the spec contradicts itself or the code, a rule needs the owner's go before code is written, or the answer is a fact only the orchestrator has. Then run \`${b} builder ask ${key} "<question>"\`, do any work the answer can't change, and wait with \`${b} builder asks ${key} --wait\`, which returns within 10 minutes, so run it again while it says still waiting. If no answer comes in 30 minutes, record the question as a call, "Question: <question>", and hand back.`,
    `4. Record each judgment call the notes leave open with \`${b} builder call ${key} "<call>"\` instead of guessing silently or asking. A problem you find outside your card is a call "Found: <what>" for the orchestrator to file at review; ask about it at once only when it stalls other cards' builds or lands.`,
    ...helperSteps(b, key),
    '',
    notes ? `Spec: the card's notes, ${notes}, all sections, where later sections override earlier ones.` : `The card has no notes file: build from its title, and record what you had to decide as calls.`,
    `${threadLine(thread)} Read it with the notes: a message of the owner's is an instruction, but where it contradicts the notes, the notes win; that contradiction counts as blocked (step 3), so ask with \`${b} builder ask ${key} "<question>"\` and wait as step 3 says. Read the thread again in checking, before you finish, for anything the owner wrote during the build.`,
    '',
    ...linkLines(links),
    ...ruleLines(rules),
    `Write tests first, and run the tests your change affects once, in the foreground, at the end, as \`${b} test --dir ${worktree} --base ${base}\`. Where the repo keeps ADRs, write one named with a timestamp: docs/adr/YYYY-MM-DD-HHMM-<slug>.md.`,
    `Commit with \`git -c core.commentChar=';' commit -F <file>\`: ${standardWords(ref)}. Land refuses any other shape.`,
    '',
    `To finish, run ${finishCommand({ route, key })}.`,
    "- If you recorded a judgment call, it hands the card back for the orchestrator to verify your calls; stop there: the orchestrator's verification finishes the card.",
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
      ? `The board resumes you, the builder of card ${ref} (${key}, "${title}") on the kickflip board /${route}, to land your build: ${why ?? 'the orchestrator verified your judgment calls'}, and it waits only to land. Nobody watches this session, so never wait on a person. Work only in ${worktree}, never restart the hub or a board server, and never push.`
      : `You are the headless lander for card ${ref} (${key}, "${title}") on the kickflip board /${route}. Its build is done and the orchestrator verified its judgment calls; it waits only to land. Nobody watches this session, so never wait on a person. Work only in ${worktree}, never restart the hub or a board server, and never push.`,
    '',
    `1. Run \`${b} builder start ${key} --kind build --label Lander --phase landing --progress "taking up the verified build"\`. If it refuses, stop.`,
    `2. Report progress with \`${b} builder progress ${key} --phase landing "<plain, 80 characters or fewer>"\`. The board adds the phase word; don't start the text with it.`,
    ...(answers.length ? [
      "3. The owner answered the builder's deferred asks. Where an answer changes the build, change it, with its tests, and commit:",
      ...answers.map((a) => `- ${a.ask} "${a.question}": ${a.answer}`),
    ] : []),
    '',
    threadLine(thread),
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
    ...(resumed ? [`The board resumes you, the builder of card ${ref}, for this run: the lines below are your brief for it.`] : []),
    `You are the headless rebase run for card ${ref} (${key}, "${title}") on the kickflip board /${route}. Its PR #${pr} conflicts with ${base}; rebase its branch onto ${base} so the PR is clean again. Nobody watches this session, so never wait on a person. Work only in ${worktree}, never restart the hub or a board server, and never push.`,
    '',
    `1. Run \`${b} builder start ${key} --kind build --label Rebase --phase building --progress "Rebase run started · fetching ${base}"\`. If it refuses, stop.`,
    `2. Run \`git fetch origin\`, then \`${rebase(`origin/${base}`)}\`. Resolve each conflict keeping both sides' intent, \`git add\` it and continue with \`git -c core.commentChar=';' rebase --continue\`. Report each step with \`${b} builder progress ${key} --phase building "<line>"\`, the board adds the phase word, in these words: "Rebasing onto ${base} · resolving <n> files", then "Rebasing onto ${base} · suite running".`,
    `3. Run the tests the change affects once, in the foreground, as \`${b} test --dir ${worktree} --base origin/${base}\`.` + " Fix what the rebase broke, and commit each fix with `git -c core.commentChar=';' commit -F <file>`. A push with commits of its own is no longer rebase-only, so a merge after an approval won't count it as trivial.",
    `4. If a conflict or a failing test is past what you can resolve with confidence, run \`git -c core.commentChar=';' rebase --abort\` if a rebase is under way, record it with \`${b} builder call ${key} "Rebase failed in <the files or tests> · <why>"\`, and run the finish step: with the call it hands the card to the orchestrator.`,
    '',
    threadLine(thread),
    '',
    `To finish, run ${finishCommand({ route, key })}, the text saying what you resolved. It reruns the suite and pushes the branch to PR #${pr} with --force-with-lease; the PR stays as it is.`,
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

// The brief for a planner, a grill or a prototype, launched from the card and its notes so far. card as builderBrief's,
// with kind grill or prototype, repo the board's repo folder it reads, the owner's text and files (uploads, {name, path})
// when the request carried them, and for the owner's eye on one question, question (its id), note and choice.
// prototype is the card's kept prototype answer (briefFacts), which the grill then never asks
// (docs/adr/2026-11-11-1700-a-cards-gates-are-facts-it-keeps.md).
export function plannerBrief({ route, key, ref, title, notes, thread, kind, repo, brief, rules = [], links = [], text, files = [], question, note, choice, prototype = null }) {
  const b = cli(route);
  const grill = kind === 'grill';
  return [
    `You are the headless ${grill ? 'grill' : 'prototype'} planner for card ${ref} (${key}, "${title}") on the kickflip board /${route}. The board launched you; nobody watches this session, so never wait on a person: the owner answers on the board, and a later planner or builder picks up from their answers. Read and run in ${repo}; write no output code ${grill ? 'there' : `in ${repo} itself`}, never restart the hub or a board server, and never push.`,
    '',
    ...orchestratorsBrief(brief, grill ? 'questions' : 'takes'),
    `1. Run \`${b} builder start ${key} --kind ${kind}\`. If it refuses, stop.`,
    `2. Gather the context yourself: ${notes ? `the card's notes, ${notes}, all sections, where later sections override earlier ones; ` : 'the card has no notes file yet; '}its thread, ${thread}, the repo's docs/adr and CONTEXT.md, and the cards its notes and thread link.`,
    `3. Report progress with \`${b} builder progress ${key} "<plain, 80 characters or fewer>"\` at least every 10 minutes.`,
    grill
      ? `4. Find every decision the card leaves open: read the code it touches and answer what the code answers yourself. Post each decision left as a question for the owner with \`${b} question add --file <json>\` on topic item:${key}, one per decision, your recommendation first. Once you finish, the orchestrator screens them before the owner sees them, settling the ones the board already answers and passing the owner the rest.`
        + ' Invoke the grilling skill with the Skill tool and run it as one round: its questions go to the board with question add, never into the chat, and you never wait for an answer; after the round, finish. (With no Skill tool, follow this step as written.)'
        + ` When the code shows the card has separable parts, each a build of its own, propose splitting it into a wave of smaller cards as one question ahead of the closing question: its options "Split as proposed" and "Keep as one card", your recommendation first. Slice it as ~/.claude/skills/to-tickets/SKILL.md step 3, "Draft vertical slices", says (read that step; you can't invoke the skill, and skip its quiz and publish steps). The first card is the thinnest end-to-end path. The question's context lists each proposed card with its title, its scope, the files it touches and the earlier proposed cards it waits on, or none: a card waits on an earlier one only when it builds on that card or shares its seam (the same function, component, CLI command or doc paragraph); sharing only a file waits on nothing. Write the same breakdown in your notes section. On Split the orchestrator files the cards when the card stages; never file them yourself.`
        + (prototype
          ? ` The card keeps the owner's answer to its prototype question, ${prototype}, so ask no closing "What next, given these answers?" question: once every question you ask is answered, or as you finish when you ask none, the board moves the card ${prototype === 'yes' ? 'to prototyping' : 'to staging'}.`
          : ` End every grill with one more question, "What next, given these answers?", whose options are implement (label "Implement"), prototype ("Prototype first") and discuss ("Keep discussing"), in that order, with "next_gate": true in its \`question add --file\` entry: once the owner has answered every question the board moves the card to staging on implement, to prototyping on prototype, or back to discussing on discuss, so nothing else moves it. Recommend implement when your questions settle the card and it doesn't change the hub's or a board's UI, prototype when it does. Ask it even when it is your only question.`)
        + " Never ask whether to make a ticket: the board makes a card's ticket when it goes ready."
      : `4. Invoke the prototype skill with the Skill tool and build the round as take files, one per option: record them with \`${b} prototype add <topic> --card ${key} --take <K>:<label> …\`, write the take files it prints, built from the repo's existing components, helpers and scripts fed mock data (the prototype template loads the board's scripts, so a take reuses the board's components; a hub-page take reuses them by path or copy), each take showing the states it needs inside itself, then post one question whose url opens prototype-<topic>.html with \`${b} question add --file <json>\` on topic item:${key}, never asking in the chat. Build in situ only where one of the board's rules asks for it: then, run \`${b} prototype base\`, which makes it or moves it to main and prints its path, whether its build script is there and the listener a page loads. When the build script is missing, write one there that serves the app and prints "port <n>" (board/build-script.mjs). Add one page to the worktree, at a path no other round uses, built from the repo's real components, helpers and scripts fed mock data, fully interactive; it reads the take from ?variant= and the state from ?state=, and loads the listener so \`KickflipPrototype.on((take, state) => …)\` re-renders it in place when the viewer switches. Record it with \`${b} prototype add <topic> --card ${key} --served <path> --take <K>:<label> … --state <key>:<label> …\`, one take per option and one state for each state that matters to the question, then post one question whose url opens prototype-<topic>.html with \`${b} question add --file <json>\` on topic item:${key}, never asking in the chat. (With no Skill tool, follow this step as written.)`,
    ...(text ? [`   The owner asked for this ${grill ? 'grill' : 'prototype'}, writing: "${text}"`] : []),
    ...(files.length ? [`   The owner attached: ${files.map((f) => f.path).join(', ')}.`] : []),
    ...(question ? [`   The owner asked for prototypes of question ${question}${note ? `, noting "${note}"` : ''}${choice ? `, leaning to option ${choice}` : ''}: draw that question's next round, its question naming round_of ${question}.`] : []),
    `5. Record what you learned in the card's notes, naming each answered question's id: write it in ${DRAFT}, then run ${notesCommand(b, key, `${grill ? 'Grill' : 'Prototype'} (<MM/DD>)`)}, which appends it as a section. The notes file is read-only; never write into it. Anything you leave open becomes a question with question add, never only a line in the notes, so the card can't go ready past it. A question's text is one line of at most ${BRIEF_LINE_LIMIT} characters (question add refuses a longer one); put the detail in its context and the options' details, which take markdown.`,
    ...(grill ? [
      `6. Where the owner asked for prototypes, or a rule here wants a UI prototype first, end the card \`${b} item set ${key} --phase prototyping\` instead and skip the closing question. Otherwise ${prototype ? 'the board' : 'the closing question'} is what moves the card on: never set it ready yourself, and never leave a Next that asks the owner to mark it ready.`,
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
// plannerBrief's, with agent its record's name and the owner's text and files when the request carried them.
export function visualBrief({ route, key, ref, title, notes, thread, repo, agent, brief, rules = [], links = [], text, files = [] }) {
  const b = cli(route);
  return [
    `You are the headless visual agent for card ${ref} (${key}, "${title}") on the kickflip board /${route}. The card's thread wants a visual: one HTML page that answers in a visual way, such as a diagram, a flow or a comparison. It is not a prototype or a grill: no question, no takes. The board launched you; nobody watches this session, so never wait on a person. Read and run in ${repo}; write no code there, never restart the hub or a board server, and never push.`,
    '',
    ...orchestratorsBrief(brief, 'page'),
    `1. Run \`${b} builder start ${key} --kind visual --agent ${agent}\`. If it refuses, stop.`,
    `2. Gather what the page needs: ${notes ? `the card's notes, ${notes}; ` : ''}its thread, ${thread}, and the code or docs it is about.`,
    ...(text ? [`   The owner wrote, asking for it: "${text}"`] : []),
    ...(files.length ? [`   The owner attached: ${files.map((f) => f.path).join(', ')}.`] : []),
    '3. Write one HTML file outside the repo, such as in a temporary folder. Keep its own CSS and script inline; it may load a library such as Mermaid or D3 from a CDN. Make it read well at phone width (390px) and on a desktop, in the dark and the light theme (prefers-color-scheme).',
    `4. Place it with \`${b} visual add ${key} --file <page.html> --title "<what it shows>"\`, which copies it to the board and links it in the thread.`,
    '',
    'Write nothing else: no notes, questions, card state, Next or progress lines.',
    '',
    ...linkLines(links),
    ...ruleLines(rules, "Rules from the hub and this board, written for the orchestrator: where one tells you to push, land, restart the hub or a board server, or do the orchestrator's work, it isn't yours; you never push or restart:"),
    `To finish, run \`${b} builder done ${key} --agent ${agent}\`.`,
    '',
    'Never push.',
  ].join('\n');
}

// docs/adr/2026-11-06-0425-the-implementer-limit-counts-agents-and-a-card-spawns-helpers.md
// The brief for a helper another agent on the card asked for (store.mjs requestHelper): its task, in cwd, its own
// worktree when it writes, else the card's or the board's repo read-only. card as builderBrief's, with agent its name,
// task, writes and cwd. It reports and finishes as its own agent, and its done --text is what its spawner reads.
export function helperBrief({ route, key, ref, title, notes, thread, agent, task, writes, cwd, rules = [], links = [] }) {
  const b = cli(route);
  return [
    `You are the headless helper ${agent} on card ${ref} (${key}, "${title}") on the kickflip board /${route}. Another agent working on the card asked the board for you to do one task beside it, and waits on your hand-back. Nobody watches this session, so never wait on a person. Never restart the hub or a board server, and never push.`,
    writes
      ? `Work only in ${cwd}, your own worktree, branched from the card's: commit your work there with \`git -c core.commentChar=';' commit -F <file>\`: ${standardWords(ref)}. The card's builder merges your branch, so leave nothing uncommitted.`
      : `Read and run in ${cwd}; change no files there and commit nothing.`,
    '',
    'The task:',
    task,
    '',
    `1. Run \`${b} builder start ${key} --kind helper --agent ${agent}\`. If it refuses, stop.`,
    `2. Report progress with \`${b} builder progress ${key} --agent ${agent} --phase reading|building|testing|checking "<plain, 80 characters or fewer>"\` at least every 10 minutes; the board adds your name and the phase word.`,
    "3. Do only the task. Don't ask the orchestrator or the owner, record no judgment calls and post no questions: put any decision you had to make in your hand-back.",
    notes ? `   The card's notes, for context: ${notes}.` : '',
    `   ${threadLine(thread)}`,
    '',
    ...linkLines(links),
    ...ruleLines(rules, "Rules from the hub and this board, written for the orchestrator: where one tells you to push, land, restart the hub or a board server, or do the orchestrator's work, it isn't yours; you never push or restart:"),
    `To finish, run \`${b} builder done ${key} --agent ${agent} --text "<your hand-back: what you did or found, ${writes ? 'what you committed, ' : ''}and any decision you made>"\`.`,
    '',
    'Never push.',
  ].filter((l, i, all) => l !== '' || all[i - 1] !== '').join('\n');
}

// The agents launchBuilder started, of agents each {pid, at} as store.mjs openAgents reads them, whose process still
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

// Whether a card already has a builder, from its open builder records (store.mjs openRuns): one with no process yet is a
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

// docs/adr/2026-11-04-1010-a-dead-headless-builder-is-relaunched-once.md
// tracked is {<key>: {kind, model, pid, log, relaunched}}, the headless builds the server launched or meant to launch (pid
// null: held by the usage pause or not yet launched). open is the set of keys whose builder record is still open. A tracked build whose
// record has closed drops. One with no pid yet launches; one whose process has exited with its record still open launches
// again once, and the second time goes to handBack, once: it stays tracked, marked handedBack, so its card reads stopped
// (server.mjs snapshot alive). One whose kind held(kind) says its usage holds waits as it is
// (docs/adr/2026-11-05-0128-one-adapter-launches-claude-or-codex.md). One the orchestrator stopped (stopped, the keys
// whose card reads it) is handed back at once, with no line, since the stop wrote its own. One paused (paused, the keys
// whose build reads paused) waits as it is, since the board resumes it
// (docs/adr/2026-11-09-1300-a-card-pause-stops-its-builder-at-its-next-stopping-point.md). One whose process exited on
// the usage limit (limitedUntil(entry), its reset, else null) doesn't spend its relaunch: atLimit(card, until) pauses it,
// pid null. launch({key, kind, model}) → {pid, log}.
// → the tracked map as it now stands.
export async function reviveBuilders(tracked, open, { launch, handBack, alive = pidAlive, held = () => false, stopped = new Set(), paused = new Set(), limitedUntil = () => null, atLimit = async () => {} }) {
  const next = {};
  for (const [key, entry] of Object.entries(tracked)) {
    if (!open.has(key)) continue;
    if (stopped.has(key)) { next[key] = { ...entry, handedBack: true }; continue; }
    if (paused.has(key) || (entry.pid !== null && alive(entry.pid)) || entry.handedBack) { next[key] = entry; continue; }
    const card = { key, ...(entry.kind ? { kind: entry.kind } : {}), ...(entry.model ? { model: entry.model } : {}) };
    const until = entry.pid !== null ? limitedUntil(entry) : null;
    if (until) { await atLimit(card, until); next[key] = { ...entry, pid: null }; continue; }
    if (held(entry.kind ?? 'claude')) { next[key] = entry; continue; }
    if (entry.pid !== null && entry.relaunched) { await handBack(card); next[key] = { ...entry, handedBack: true }; continue; }
    const { key: _, ...kept } = card;
    next[key] = { ...kept, ...(await launch(card)), relaunched: entry.pid !== null || Boolean(entry.relaunched) };
  }
  return next;
}

const logFile = (id, role) => path.join(os.homedir(), '.claude', 'kickflip', 'logs', `${role}-${id}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);

// Launches the agent of a build startTappedBuild started ({key, kind, model}), the rebase run when the card has one
// open (store.mjs startRebase's rebase_run, so a relaunch after a restart briefs it the same), with lander the lander of
// a verified card, or with planner the planner startPlanner opened ({key, kind: grill|prototype, model, text?, files?, question?,
// note?, choice?}) or the visual agent startVisual opened ({key, kind: visual, model, agent, text?, files?}), through the
// adapter (agents.mjs launchAgent): a build or lander as its record's kind, a planner as Claude. The session id it names
// goes on the agent's builder record and, with the log, in a thread line saying so.
// → {pid, sessionId, log}; rejects when the agent can't start.
export async function launchBuilder(site, { key, kind = 'claude', model, agent = 'main', brief, text, files, question, note, choice, task, writes, worktree }, { lander = false } = {}) {
  const facts = await briefFacts(site, key);
  const route = boardAt(site)?.route ?? path.basename(site);
  const rules = [...readHubRules(), ...(await readBoardRules(site))].map((r) => r.text);
  const { base, repo } = builderRepo(site);
  const planner = plans({ kind });
  const helper = kind === HELPER;
  const rebase = !planner && !helper && !lander && facts.rebasePR !== null;
  const visual = kind === VISUAL;
  const cwd = planner ? repo : helper ? worktree ?? facts.worktree ?? repo : facts.worktree;
  const card = { ...facts, route, base, repo, rules, kind, agent, brief, text, files, question, note, choice, task, writes, cwd, pr: facts.rebasePR };
  const role = visual ? 'Visual agent' : helper ? `Helper ${agent}` : planner ? 'Planner' : lander ? 'Lander' : rebase ? 'Rebase run' : 'Builder';
  const prompt = visual ? visualBrief(card) : helper ? helperBrief(card) : planner ? plannerBrief(card) : lander ? landerBrief(card) : rebase ? rebaseBrief(card) : builderBrief(card);
  const launched = await launchAgent({ kind: planner || helper ? 'claude' : kind, model, cwd, site, prompt, log: logFile(key.split('/')[1], role.split(' ')[0].toLowerCase()) });
  await recordSession(site, key, launched.sessionId, launched.pid, agent, path.basename(launched.log));
  return launched;
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
export const resumeBrief = ({ ref, worktree, cleared }) => `The board paused your build of card ${ref}, and the pause has cleared: ${cleared}. Carry on where you stopped, in ${worktree}, following your brief as before. Your builder record is still open, so don't run builder start again.`;

// The one seam where the board puts a card's builder session back to work: every resume (a cleared pause, a verified
// land, a Merge tap's conflict, a PR rebase run) goes through here, and none of them knows how. card is {key, kind,
// model}; brief(facts) the words the session is resumed with, facts as store.mjs briefFacts'. A Claude build whose
// record keeps a session id resumes it in the card's worktree; a Codex build, one with no session (a session's own
// build, which the board never launched), or one the caller says to take fresh (fresh) is launched anew, with
// freshLaunch its launchBuilder options. → {pid, sessionId, log, resumed}, resumed whether the session continued.
export async function resumeBuilder(site, { key, kind = 'claude', model, session, brief, fresh = false, freshLaunch = {} }) {
  if (kind !== 'claude' || !session || fresh) return { ...await launchBuilder(site, { key, kind, model }, freshLaunch), resumed: false };
  const facts = await briefFacts(site, key);
  const launched = await launchAgent({ kind, model, cwd: session.worktree ?? facts.worktree, site, prompt: brief(facts), resume: session.id, log: logFile(key.split('/')[1], 'builder') });
  await recordSession(site, key, launched.sessionId ?? session.id, launched.pid, 'main', path.basename(launched.log));
  return { ...launched, resumed: true };
}

// Lands a card through its own builder: its newest session, resumed with the lander's brief (landerBrief, why saying what
// the land hit), or with the rebase run's when the card has one open. A session recorded in another worktree than the
// one the run works in isn't resumed. A resume whose launch fails, like a card with nothing to resume, gets today's
// fresh lander (or rebase run). → resumeBuilder's.
export async function landByBuilder(site, { key, kind = 'claude', model }, { why, fresh = false } = {}) {
  const found = await recordedSession(site, key);
  const facts = await briefFacts(site, key);
  const rebase = facts.rebasePR !== null;
  const session = found && (!rebase || found.worktree === facts.worktree) ? found : null;
  const route = boardAt(site)?.route ?? path.basename(site);
  const { base } = builderRepo(site);
  const brief = (f) => (rebase ? rebaseBrief : landerBrief)({ ...f, route, base, pr: f.rebasePR, why, resumed: true });
  const freshLaunch = { lander: !rebase };
  let launched;
  try {
    launched = await resumeBuilder(site, { key, kind, model, session, brief, fresh, freshLaunch });
  } catch (e) {
    if (!session) throw e;
    launched = await resumeBuilder(site, { key, kind, model, session: null, brief, freshLaunch });
  }
  if (launched.resumed) await appendStatus(site, key, 'builder-resumed-to-land', { session: launched.sessionId ?? session.id });
  return launched;
}
