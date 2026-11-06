// docs/adr/2026-11-04-0306-builders-launch-headless-check-their-notes-and-land-on-their-own.md
// docs/adr/2026-11-04-2130-the-hub-launches-every-agent-from-the-card.md
// The board server launches every agent a card gets, through the adapter (agents.mjs): each build, Claude or Codex, in
// the card's worktree, a lander the same way for a handed-back build whose verified calls didn't finish it (a question
// was open, or the finish refused), and each planner, a grill or a prototype, in the board's repo. The brief, one per
// role in plain steps either agent follows, is built from the card: its notes file, the hub's and board's rules, and
// the board's CLI. A builder finishes its own work with builder done (finish.mjs), resolving any rebase conflict itself;
// only judgment calls and deferred asks go to the session.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchAgent } from './agents.mjs';
import { processStarts, ps } from '../hub/live.mjs';
import { boardAt } from '../hub/boards.mjs';
import { readHubRules } from '../hub/rules.mjs';
import { builderRepo } from './worktree.mjs';
import { BoardError, appendThread, briefFacts, readBoardRules, recordSession } from './store.mjs';
import { HELPER, modelName, plans, VISUAL } from './domain.mjs';

export const BOARD_CLI = fileURLToPath(new URL('./bin/board.mjs', import.meta.url));
const cli = (route) => `node ${BOARD_CLI} --site ${route}`;
const rebase = (base) => `git -c core.commentChar=';' rebase ${base}`;
const ruleLines = (rules, heading = 'Rules from the hub and this board:') => (rules.length ? [heading, ...rules.map((r) => `- ${r}`), ''] : []);
// docs/adr/2026-11-05-0130-the-orchestrator-links-a-new-card-when-it-files-it.md: the cards the card links (briefFacts' links).
const linkLines = (links) => (links.length ? [
  "Related cards: read their notes for context; don't build their scope.",
  ...links.map((l) => `- ${l.ref} "${l.title}" (${l.relation}, ${l.lane}): ${l.notes || 'no notes'}`),
  '',
] : []);

// docs/adr/2026-11-04-1611-finishing-a-build-is-one-step.md: builder done finishes the card.
const finishSteps = ({ route, key, worktree, base }) => [
  `- With no unverified calls, done finishes the card itself: it rebases onto ${base}, reruns the full test suite, fast-forwards ${base} and closes the card (on a board with pull requests it pushes the branch and opens a draft PR instead; with Auto-merge off it stops before the fast-forward, and the card waits for the owner's Merge).`,
  `- On a conflict it undoes its rebase and names the files: run \`${rebase(base)}\` in ${worktree}, resolve each conflict keeping both sides' intent, continue with \`git -c core.commentChar=';' rebase --continue\`, rerun the tests, and run done again.`,
  '- On failing tests, fix them, commit, and run done again.',
  '- While another card is landing, done waits its turn and then lands; leave it running.',
  '- Once a reviewer has the card\'s PR link, done refuses without `--updated "<what changed>"`, which goes in that link\'s Slack thread, or `--updated none` for a change only to comments, names, docs or tests.',
  `- Finishing never goes to the orchestrator. If done refuses for a reason you can't fix, record it with \`${cli(route)} builder call ${key} "<why>"\` and run done again: with the call it hands the card back.`,
];
const finishCommand = ({ route, key }) => `\`${cli(route)} builder done ${key} --text "<what you checked>"\``;

// docs/adr/2026-11-06-0425-the-implementer-limit-counts-agents-and-a-card-spawns-helpers.md
// How a builder hands part of its card to helpers running beside it, which the board launches and counts.
const helperSteps = (b, key) => [
  `5. To run a separate part of the work in parallel, ask the board for a helper: \`${b} agent launch ${key} --name <short-name> --task "<the whole task, with the files and what to hand back>"\`, adding --writes when it changes code or runs tests (it gets its own worktree off your branch, and waits for a free implementer slot). Then \`${b} agent wait ${key} --name <short-name>\`, which prints its hand-back; it returns within 10 minutes, so run it again while it says still running, and do the task yourself if it says the helper exited. Merge a writing helper's work with \`${b} agent merge ${key} --name <short-name>\` before you test and finish.`,
];

// The standard brief for a card's headless builder. card: {route, key, ref, title, notes, worktree, base, rules, links}.
export function builderBrief({ route, key, ref, title, notes, worktree, base, rules = [], links = [] }) {
  const b = cli(route);
  return [
    `You are the headless builder for card ${ref} (${key}, "${title}") on the kickflip board /${route}. The board launched you; nobody watches this session, so never wait on a person. Work only in ${worktree}. Never restart the hub or a board server, and never push.`,
    '',
    `1. Run \`${b} builder start ${key} --kind build\`. If it refuses, stop.`,
    `2. Report progress with \`${b} builder progress ${key} --phase reading|building|testing|checking|landing "<plain, 80 characters or fewer>"\`, at least every 10 minutes. The board adds the phase word; don't start the text with it. The phases:`,
    '   - reading: the notes and the code, until the first test is written.',
    '   - building: the tests and the code, the ADR and docs, and the commit.',
    '   - testing: the full suite run before you finish.',
    "   - checking: your own review of the diff before you hand back; the Orchestrator's review of your calls continues on the same 4th bar.",
    '   - landing: set by the finish step itself; you never report it.',
    `3. To ask the orchestrator something, run \`${b} builder ask ${key} "<question>"\` and carry on; read its replies with \`${b} builder asks ${key}\`. Never block on a reply.`,
    `4. Record each judgment call the notes leave open with \`${b} builder call ${key} "<call>"\` instead of guessing silently.`,
    ...helperSteps(b, key),
    '',
    notes ? `Spec: the card's notes, ${notes}, all sections, where later sections override earlier ones.` : `The card has no notes file: build from its title, and record what you had to decide as calls.`,
    '',
    ...linkLines(links),
    ...ruleLines(rules),
    "Write tests first, and run the full suite once, in the foreground, at the end. Where the repo keeps ADRs, write one named with a timestamp: docs/adr/YYYY-MM-DD-HHMM-<slug>.md.",
    `Commit with \`git -c core.commentChar=';' commit -F <file>\`, the subject "${ref}: <what the card now does>".`,
    '',
    `To finish, run ${finishCommand({ route, key })}.`,
    "- If you recorded a judgment call, it hands the card back for the orchestrator to verify your calls; stop there: the orchestrator's verification finishes the card.",
    ...finishSteps({ route, key, worktree, base }),
    '',
    'Never push.',
  ].join('\n');
}

// The brief for a lander, launched once the session verified a handed-back build's calls. card as builderBrief's, with
// answers [{ask, question, answer}], the owner's answers to the asks the session deferred.
export function landerBrief({ route, key, ref, title, worktree, base, answers = [] }) {
  const b = cli(route);
  return [
    `You are the headless lander for card ${ref} (${key}, "${title}") on the kickflip board /${route}. Its build is done and the orchestrator verified its judgment calls; it waits only to land. Nobody watches this session, so never wait on a person. Work only in ${worktree}, never restart the hub or a board server, and never push.`,
    '',
    `1. Run \`${b} builder start ${key} --kind build --label Lander --phase landing --progress "taking up the verified build"\`. If it refuses, stop.`,
    `2. Report progress with \`${b} builder progress ${key} --phase landing "<plain, 80 characters or fewer>"\`. The board adds the phase word; don't start the text with it.`,
    ...(answers.length ? [
      "3. The owner answered the builder's deferred asks. Where an answer changes the build, change it, with its tests, and commit:",
      ...answers.map((a) => `- ${a.ask} "${a.question}": ${a.answer}`),
    ] : []),
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
export function rebaseBrief({ route, key, ref, title, worktree, base, pr }) {
  const b = cli(route);
  return [
    `You are the headless rebase run for card ${ref} (${key}, "${title}") on the kickflip board /${route}. Its PR #${pr} conflicts with ${base}; rebase its branch onto ${base} so the PR is clean again. Nobody watches this session, so never wait on a person. Work only in ${worktree}, never restart the hub or a board server, and never push.`,
    '',
    `1. Run \`${b} builder start ${key} --kind build --label Rebase --phase building --progress "Rebase run started · fetching ${base}"\`. If it refuses, stop.`,
    `2. Run \`git fetch origin\`, then \`${rebase(`origin/${base}`)}\`. Resolve each conflict keeping both sides' intent, \`git add\` it and continue with \`git -c core.commentChar=';' rebase --continue\`. Report each step with \`${b} builder progress ${key} --phase building "<line>"\`, the board adds the phase word, in these words: "Rebasing onto ${base} · resolving <n> files", then "Rebasing onto ${base} · suite running".`,
    "3. Run the full test suite once, in the foreground. Fix what the rebase broke, and commit each fix with `git -c core.commentChar=';' commit -F <file>`. A push with commits of its own is no longer rebase-only, so a merge after an approval won't count it as trivial.",
    `4. If a conflict or a failing test is past what you can resolve with confidence, run \`git -c core.commentChar=';' rebase --abort\` if a rebase is under way, record it with \`${b} builder call ${key} "Rebase failed in <the files or tests> · <why>"\`, and run the finish step: with the call it hands the card to the orchestrator.`,
    '',
    `To finish, run ${finishCommand({ route, key })}, the text saying what you resolved. It reruns the suite and pushes the branch to PR #${pr} with --force-with-lease; the PR stays as it is.`,
    `- If it refuses because someone pushed to the branch since your fetch, fetch and rebase again (step 2), then run done again.`,
    '- On failing tests, fix them, commit, and run done again.',
    '',
    'Never push.',
  ].join('\n');
}

// The brief for a planner, a grill or a prototype, launched from the card and its notes so far. card as builderBrief's,
// with kind grill or prototype, repo the board's repo folder it reads, the owner's text and files (uploads, {name, path})
// when the request carried them, and for the owner's eye on one question, question (its id), note and choice.
export function plannerBrief({ route, key, ref, title, notes, kind, repo, rules = [], links = [], text, files = [], question, note, choice }) {
  const b = cli(route);
  const grill = kind === 'grill';
  return [
    `You are the headless ${grill ? 'grill' : 'prototype'} planner for card ${ref} (${key}, "${title}") on the kickflip board /${route}. The board launched you; nobody watches this session, so never wait on a person: the owner answers on the board, and a later planner or builder picks up from their answers. Read and run in ${repo}; write no output code ${grill ? 'there' : `in ${repo} itself`}, never restart the hub or a board server, and never push.`,
    '',
    `1. Run \`${b} builder start ${key} --kind ${kind}\`. If it refuses, stop.`,
    `2. Gather the context yourself: ${notes ? `the card's notes, ${notes}, all sections, where later sections override earlier ones; ` : 'the card has no notes file yet; '}its thread, in the board site's data/threads folder, the repo's docs/adr and CONTEXT.md, and the cards its notes and thread link.`,
    `3. Report progress with \`${b} builder progress ${key} "<plain, 80 characters or fewer>"\` at least every 10 minutes.`,
    grill
      ? `4. Find every decision the card leaves open: read the code it touches and answer what the code answers yourself. Post each decision left as a question for the owner with \`${b} question add --file <json>\` on topic item:${key}, one per decision, your recommendation first.`
        + ' Invoke the grilling skill with the Skill tool and run it as one round: its questions go to the board with question add, never into the chat, and you never wait for an answer; after the round, finish. (With no Skill tool, follow this step as written.)'
        + ` End every grill with one more question, "Prototype round first?", whose options are yes and no, with "prototype_gate": true in its \`question add --file\` entry: the board moves the card to prototyping on yes, or to staging on no once the owner has answered the rest, so nothing else moves it. Recommend yes when the card changes the hub's or a board's UI, no otherwise. Ask it even when it is your only question.`
      : `4. Build the round in situ, in the board's base prototype worktree: run \`${b} prototype base\`, which makes it or moves it to main and prints its path, whether its build script is there and the listener a page loads. When the build script is missing, write one there that serves the app and prints "port <n>" (board/build-script.mjs). Add one page to the worktree, at a path no other round uses, built from the repo's real components, helpers and scripts fed mock data, fully interactive; it reads the take from ?variant= and the state from ?state=, and loads the listener so \`KickflipPrototype.on((take, state) => …)\` re-renders it in place when the viewer switches. Record it with \`${b} prototype add <topic> --card ${key} --served <path> --take <K>:<label> … --state <key>:<label> …\`, one take per option and one state for each state that matters to the question, then post one question whose url opens prototype-<topic>.html with \`${b} question add --file <json>\` on topic item:${key}, never asking in the chat. Only a repo whose app can't be served as a web page keeps take files: \`${b} prototype add <topic> --card ${key} --take <K>:<label> …\`, one take file per option built from the board's real components fed fake data. Invoke the prototype skill with the Skill tool for this step. (With no Skill tool, follow this step as written.)`,
    ...(text ? [`   The owner asked for this ${grill ? 'grill' : 'prototype'}, writing: "${text}"`] : []),
    ...(files.length ? [`   The owner attached: ${files.map((f) => f.path).join(', ')}.`] : []),
    ...(question ? [`   The owner asked for prototypes of question ${question}${note ? `, noting "${note}"` : ''}${choice ? `, leaning to option ${choice}` : ''}: draw that question's next round, its question naming round_of ${question}.`] : []),
    `5. Record what you learned in the card's notes with \`${b} item set ${key} --notes-file <file.md>\`, naming each answered question's id.`,
    ...(grill ? [
      `6. Where the owner asked for prototypes, or a rule here wants a UI prototype first, end the card \`${b} item set ${key} --state prototyping\` instead and skip the prototype question. Otherwise the prototype question is what moves the card on: never set it ready yourself, and never leave a Next that asks the owner to mark it ready.`,
    ] : []),
    '',
    ...linkLines(links),
    ...ruleLines(rules, "Rules from the hub and this board, written for the orchestrator: where one tells you to push, land, restart the hub or a board server, or do the orchestrator's work, it isn't yours; you never push or restart:"),
    `To finish, run \`${b} builder done ${key} --text "<what you asked>"\`.`,
    '',
    'Never push.',
  ].join('\n');
}

// docs/adr/2026-11-05-1921-a-visual-is-a-page-an-agent-draws-for-a-thread.md
// The brief for a visual agent: one HTML page answering the owner's visual request in the card's thread. card as
// plannerBrief's, with agent its record's name and the owner's text and files when the request carried them.
export function visualBrief({ route, key, ref, title, notes, repo, agent, rules = [], links = [], text, files = [] }) {
  const b = cli(route);
  return [
    `You are the headless visual agent for card ${ref} (${key}, "${title}") on the kickflip board /${route}. The owner asked, in the card's thread, for a visual: one HTML page that answers in a visual way, such as a diagram, a flow or a comparison. It is not a prototype or a grill: no question, no takes. The board launched you; nobody watches this session, so never wait on a person. Read and run in ${repo}; write no code there, never restart the hub or a board server, and never push.`,
    '',
    `1. Run \`${b} builder start ${key} --kind visual --agent ${agent}\`. If it refuses, stop.`,
    `2. Gather what the page needs: ${notes ? `the card's notes, ${notes}; ` : ''}its thread, in the board site's data/threads folder, and the code or docs it is about.`,
    text ? `   The owner wrote: "${text}"` : '   The owner typed nothing: draw what the thread was last discussing.',
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
export function helperBrief({ route, key, ref, title, notes, agent, task, writes, cwd, rules = [], links = [] }) {
  const b = cli(route);
  return [
    `You are the headless helper ${agent} on card ${ref} (${key}, "${title}") on the kickflip board /${route}. Another agent working on the card asked the board for you to do one task beside it, and waits on your hand-back. Nobody watches this session, so never wait on a person. Never restart the hub or a board server, and never push.`,
    writes
      ? `Work only in ${cwd}, your own worktree, branched from the card's: commit your work there with \`git -c core.commentChar=';' commit -F <file>\`, the subject "${ref}: <what it does>". The card's builder merges your branch, so leave nothing uncommitted.`
      : `Read and run in ${cwd}; change no files there and commit nothing.`,
    '',
    'The task:',
    task,
    '',
    `1. Run \`${b} builder start ${key} --kind helper --agent ${agent}\`. If it refuses, stop.`,
    `2. Report progress with \`${b} builder progress ${key} --agent ${agent} --phase reading|building|testing|checking "<plain, 80 characters or fewer>"\` at least every 10 minutes; the board adds your name and the phase word.`,
    "3. Do only the task. Don't ask the orchestrator or the owner, record no judgment calls and post no questions: put any decision you had to make in your hand-back.",
    notes ? `   The card's notes, for context: ${notes}.` : '',
    '',
    ...linkLines(links),
    ...ruleLines(rules, "Rules from the hub and this board, written for the orchestrator: where one tells you to push, land, restart the hub or a board server, or do the orchestrator's work, it isn't yours; you never push or restart:"),
    `To finish, run \`${b} builder done ${key} --agent ${agent} --text "<your hand-back: what you did or found, ${writes ? 'what you committed, ' : ''}and any decision you made>"\`.`,
    '',
    'Never push.',
  ].filter((l, i, all) => l !== '' || all[i - 1] !== '').join('\n');
}

// docs/adr/2026-11-06-0204-intake-triage-sorts-new-tasks-on-sonnet.md
// The brief for an intake triage run on one intake event: event, its kind (ask, item-message on an ask's thread, or
// card-added) and key, the card it is on. cards is the board's index, every open work card {ref, key, title, lane,
// state, notes: its notes file or null}; waves {slug, dir} where a new card can go; thread the card's messages
// {who, text, files?}; quick whether the ask asked for an Implement. It sorts that one event and exits: thread lines are its report.
export function intakeBrief({ route, repo, rules = [], waves = [], cards = [], event, key, kind, quick = false, thread = [] }) {
  const b = cli(route);
  const said = thread.map((m) => `- ${m.who}: ${m.text}${m.files?.length ? ` (attached: ${m.files.map((f) => f.path).join(', ')})` : ''}`);
  // An Implement ask files to staging, for the orchestrator to judge; any other card to its grill or prototype.
  const state = quick ? '--state staging --size <small|large>' : '--state <grilling|prototyping>';
  const stateLine = quick
    ? '      The owner chose Implement: put the plan in the notes; the orchestrator judges it from staging before it goes ready.'
    : "      --state prototyping when it changes the hub's or a board's UI, --state grilling for anything else; the board starts the grill or prototype itself.";
  const fileIt = (from) => [
    `   1. Write its notes file in the wave's folder, a .md named for the change: open with the owner's words verbatim, under "## Asked (owner, <date>)", then a short "## What it is" in plain words and a "## Related" line naming each linked card and how they overlap. Append that "## Related" line to each linked card's notes file too.`,
    `   2. ${from}`,
    stateLine,
  ];
  const jobs = {
    ask: [
      `Your job: sort new task ${event}, on card ${key}, one of these ways:`,
      `- Answer it, when it is a question or asks for nothing to build: \`${b} reply ${event} --file <reply.html>\`.`,
      `- Fold it into the open card it is about: \`${b} item relate-ask ${event} <key> --summary "<one line>"\`, then append the owner's words verbatim to that card's notes file under "## Asked (owner, <date>)".`,
      `- File it as a new card: \`${b} item add <wave> --title "<the change, in plain words>"\` prints "<label> added as <key>"; use that key.`,
      ...fileIt(`\`${b} item set <key> --from-ask ${event} --notes-file <file> --relate <keys> --text "<one line on what you filed>" ${state}\` (link every card it overlaps, depends on or would duplicate; --deps for one it truly waits on).`),
    ],
    'item-message': [
      `Your job: the owner's message ${event} in the thread of new task ${key}, whose last line is theirs. Answer it with \`${b} reply ${event} --file <reply.html>\`, or, if it changes what the task asks, sort the task as the message now has it:`,
      `- fold it: \`${b} item relate-ask ${key.slice(4)} <key> --summary "<one line>"\`; or file it: \`${b} item add <wave> --title "<the change>"\`, then`,
      ...fileIt(`\`${b} item set <key> --from-ask ${key.slice(4)} --notes-file <file> --relate <keys> --text "<one line>" ${state}\`,`),
      `  then reply to the message saying what you did.`,
    ],
    'card-added': [
      `Your job: card ${key}, which an agent added unfiled (card-added ${event}). Read its notes and the cards its title looks related to, tidy its notes (what it is, why, where it came from), and add a "## Related" line to it and each linked card's notes. Then file it in one call:`,
      `\`${b} item set ${key} --relate <keys> --text "<one line>" --state <grilling|prototyping>\`: prototyping when it changes the hub's or a board's UI, grilling for anything else.`,
    ],
  };
  return [
    `You are an intake triage run on the kickflip board /${route}. The board launched you to sort one thing that reached it unsorted; nobody watches this session, so never wait on a person. Work in ${repo}, reading only: you write through the board's CLI, \`${b} <command>\`, and notes files, nothing else. Never set a card ready, never build, never push, and never restart the hub or a board server.`,
    '',
    ...jobs[kind],
    '',
    `If you can't tell how to sort it (which card it belongs to, or what it asks), don't guess: \`${b} intake handoff ${event} --text "<what you are unsure of>"\` hands it to the orchestrator, and stop.`,
    'Each command writes its own line in the thread, which is your report; add one with `' + b + ' thread ' + key + ' --text "<line>"` only for what those lines leave unsaid. Every line stands alone: name cards by their label.',
    '',
    `The thread of ${key}:`,
    ...(said.length ? said : ['- (no messages)']),
    '',
    "The board's open cards, as label key \"title\", lane, state: notes file. Read the notes of any card whose title looks related before you choose.",
    ...(cards.length ? cards.map((c) => `- ${c.ref} ${c.key} "${c.title}", ${c.lane}, ${c.state || 'no state'}: ${c.notes || 'no notes'}`) : ['- (none)']),
    '',
    'Waves a new card can go in, as slug: folder:',
    ...waves.map((w) => `- ${w.slug}: ${w.dir}`),
    '',
    ...ruleLines(rules, "Rules from the hub and this board, written for the orchestrator: where one tells you to push, land, build or restart, it isn't yours:"),
    'Sort that one thing, then exit. Never push.',
  ].join('\n');
}

// Launches the intake triage run on Sonnet in the board's repo (intakeBrief's), with a thread line on its card naming
// it, a status line, so the task still reads New. → {pid, sessionId, log, exited}; rejects when it can't start.
export async function launchIntake(site, intake) {
  const route = boardAt(site)?.route ?? path.basename(site);
  const rules = [...readHubRules(), ...(await readBoardRules(site))].map((r) => r.text);
  const { repo } = builderRepo(site);
  const launched = await launchAgent({ kind: 'claude', model: 'sonnet', cwd: repo, site, prompt: intakeBrief({ ...intake, route, repo, rules }), log: logFile(intake.event, 'intake') });
  await appendThread(site, intake.key, { text: `Intake triage launched on ${modelName({ kind: 'claude', model: 'sonnet' })} in ${repo}.`, kind: 'status', log: path.basename(launched.log) });
  return launched;
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
// SIGTERM to each group, then SIGKILL to what still runs after grace ms. → the processes it stopped, each {pid, args}.
export async function stopRuns(leaders, { grace = 5000 } = {}) {
  const table = ps(['-A', '-o', 'pid=,ppid=,pgid=,args=']);
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
// tracked is {<key>: {kind, model, pid, relaunched}}, the headless builds the server launched or meant to launch (pid null: held
// by the usage pause, not yet launched). open is the set of keys whose builder record is still open. A tracked build whose
// record has closed drops. One with no pid yet launches; one whose process has exited with its record still open launches
// again once, and the second time goes to handBack, once: it stays tracked, marked handedBack, so its card reads stopped
// (server.mjs snapshot alive). One whose kind held(kind) says its usage holds waits as it is
// (docs/adr/2026-11-05-0128-one-adapter-launches-claude-or-codex.md). One the orchestrator stopped (stopped, the keys
// whose card reads it) is handed back at once, with no line, since the stop wrote its own. launch({key, kind, model})
// → {pid}. → the tracked map as it now stands.
export async function reviveBuilders(tracked, open, { launch, handBack, alive = pidAlive, held = () => false, stopped = new Set() }) {
  const next = {};
  for (const [key, entry] of Object.entries(tracked)) {
    if (!open.has(key)) continue;
    if (stopped.has(key)) { next[key] = { ...entry, handedBack: true }; continue; }
    if ((entry.pid !== null && alive(entry.pid)) || held(entry.kind ?? 'claude') || entry.handedBack) { next[key] = entry; continue; }
    const card = { key, ...(entry.kind ? { kind: entry.kind } : {}), ...(entry.model ? { model: entry.model } : {}) };
    if (entry.pid !== null && entry.relaunched) { await handBack(card); next[key] = { ...entry, handedBack: true }; continue; }
    const { key: _, ...kept } = card;
    next[key] = { ...kept, ...(await launch(card)), relaunched: entry.pid !== null };
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
export async function launchBuilder(site, { key, kind = 'claude', model, agent = 'main', text, files, question, note, choice, task, writes, worktree }, { lander = false } = {}) {
  const facts = await briefFacts(site, key);
  const route = boardAt(site)?.route ?? path.basename(site);
  const rules = [...readHubRules(), ...(await readBoardRules(site))].map((r) => r.text);
  const { base, repo } = builderRepo(site);
  const planner = plans({ kind });
  const helper = kind === HELPER;
  const rebase = !planner && !helper && !lander && facts.rebasePR !== null;
  const visual = kind === VISUAL;
  const cwd = planner ? repo : helper ? worktree ?? facts.worktree ?? repo : facts.worktree;
  const card = { ...facts, route, base, repo, rules, kind, agent, text, files, question, note, choice, task, writes, cwd, pr: facts.rebasePR };
  const role = visual ? 'Visual agent' : helper ? `Helper ${agent}` : planner ? 'Planner' : lander ? 'Lander' : rebase ? 'Rebase run' : 'Builder';
  const prompt = visual ? visualBrief(card) : helper ? helperBrief(card) : planner ? plannerBrief(card) : lander ? landerBrief(card) : rebase ? rebaseBrief(card) : builderBrief(card);
  const launched = await launchAgent({ kind: planner || helper ? 'claude' : kind, model, cwd, site, prompt, log: logFile(key.split('/')[1], role.split(' ')[0].toLowerCase()) });
  if (launched.sessionId) await recordSession(site, key, launched.sessionId, launched.pid, agent, path.basename(launched.log));
  return launched;
}
