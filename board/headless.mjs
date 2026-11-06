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
import { modelName, plans, VISUAL } from './domain.mjs';

export const BOARD_CLI = fileURLToPath(new URL('./bin/board.mjs', import.meta.url));
const cli = (route) => `node ${BOARD_CLI} --site ${route}`;
const rebase = (base) => `git -c core.commentChar=';' rebase ${base}`;
const ruleLines = (rules, heading = 'Rules from the hub and this board:') => (rules.length ? [heading, ...rules.map((r) => `- ${r}`), ''] : []);
// docs/adr/2026-11-05-0130-the-orchestrator-links-a-new-card-when-it-files-it.md: the cards the card links (briefFacts' links).
const linkLines = (links) => (links.length ? [
  "Related cards: read their notes for context; don't build their scope.",
  ...links.map((l) => `- ${l.ref} "${l.title}" (${l.relation}, ${l.status}): ${l.notes || 'no notes'}`),
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
    `You are the headless ${grill ? 'grill' : 'prototype'} planner for card ${ref} (${key}, "${title}") on the kickflip board /${route}. The board launched you; nobody watches this session, so never wait on a person: the owner answers on the board, and a later planner or builder picks up from their answers. Read and run in ${repo}; write no output code there, never restart the hub or a board server, and never push.`,
    '',
    `1. Run \`${b} builder start ${key} --kind ${kind}\`. If it refuses, stop.`,
    `2. Gather the context yourself: ${notes ? `the card's notes, ${notes}, all sections, where later sections override earlier ones; ` : 'the card has no notes file yet; '}its thread, in the board site's data/threads folder, the repo's docs/adr and CONTEXT.md, and the cards its notes and thread link.`,
    `3. Report progress with \`${b} builder progress ${key} "<plain, 80 characters or fewer>"\` at least every 10 minutes.`,
    grill
      ? `4. Find every decision the card leaves open: read the code it touches and answer what the code answers yourself. Post each decision left as a question for the owner with \`${b} question add --file <json>\` on topic item:${key}, one per decision, your recommendation first.`
        + ' Invoke the grilling skill with the Skill tool and run it as one round: its questions go to the board with question add, never into the chat, and you never wait for an answer; after the round, finish. (With no Skill tool, follow this step as written.)'
        + ` End every grill with one more question, "Prototype round first?", whose options are yes and no, with "prototype_gate": true in its \`question add --file\` entry: the board moves the card to prototyping on yes, or to staging on no once the owner has answered the rest, so nothing else moves it. Recommend yes when the card changes the hub's or a board's UI, no otherwise. Ask it even when it is your only question.`
      : `4. Record the prototype with \`${b} prototype add <topic> --card ${key} --take <K>:<label> …\`, write one take per option as a page built from the board's real components fed fake data, and post one question whose url opens it with \`${b} question add --file <json>\` on topic item:${key}, never asking in the chat. Invoke the prototype skill with the Skill tool for this step. (With no Skill tool, follow this step as written.)`,
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
export async function launchBuilder(site, { key, kind = 'claude', model, agent = 'main', text, files, question, note, choice }, { lander = false } = {}) {
  const facts = await briefFacts(site, key);
  const route = boardAt(site)?.route ?? path.basename(site);
  const rules = [...readHubRules(), ...(await readBoardRules(site))].map((r) => r.text);
  const { base, repo } = builderRepo(site);
  const planner = plans({ kind });
  const rebase = !planner && !lander && facts.rebasePR !== null;
  const visual = kind === VISUAL;
  const card = { ...facts, route, base, repo, rules, kind, agent, text, files, question, note, choice, pr: facts.rebasePR };
  const role = visual ? 'Visual agent' : planner ? 'Planner' : lander ? 'Lander' : rebase ? 'Rebase run' : 'Builder';
  const cwd = planner ? repo : facts.worktree;
  const prompt = visual ? visualBrief(card) : planner ? plannerBrief(card) : lander ? landerBrief(card) : rebase ? rebaseBrief(card) : builderBrief(card);
  const launched = await launchAgent({ kind: planner ? 'claude' : kind, model, cwd, site, prompt, log: logFile(key.split('/')[1], role.split(' ')[0].toLowerCase()) });
  if (launched.sessionId) await recordSession(site, key, launched.sessionId, launched.pid, agent);
  const session = launched.sessionId ? `, session ${launched.sessionId}` : '';
  await appendThread(site, key, { text: `${role} launched on ${modelName({ kind, model })} in ${cwd}${session}.`, log: path.basename(launched.log) });
  return launched;
}
