// docs/adr/2026-11-04-0306-builders-launch-headless-check-their-notes-and-land-on-their-own.md
// docs/adr/2026-11-04-2130-the-hub-launches-every-agent-from-the-card.md
// The board server launches every agent a card gets: each build as `claude -p <brief>` (or `codex exec` for a codex
// pick) in the card's worktree, a lander the same way for a handed-back build whose verified calls didn't finish it (a
// question was open, or the finish refused), and each planner, a grill or a prototype, in the board's repo. The brief
// is built from the card: its notes file, the hub's and board's rules, and the board's CLI. A builder finishes its own
// work with builder done (finish.mjs), resolving any rebase conflict itself; only judgment calls and deferred asks go to
// the session.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claudeBin, inherited } from '../hub/sessions.mjs';
import { boardAt } from '../hub/boards.mjs';
import { readHubRules } from '../hub/rules.mjs';
import { builderRepo } from './worktree.mjs';
import { appendThread, briefFacts, readBoardRules } from './store.mjs';
import { modelName, plans } from './domain.mjs';

export const BOARD_CLI = fileURLToPath(new URL('./bin/board.mjs', import.meta.url));
const cli = (route) => `node ${BOARD_CLI} --site ${route}`;
const rebase = (base) => `git -c core.commentChar=';' rebase ${base}`;
const ruleLines = (rules) => (rules.length ? ['Rules from the hub and this board:', ...rules.map((r) => `- ${r}`), ''] : []);

// docs/adr/2026-11-04-1611-finishing-a-build-is-one-step.md: builder done finishes the card.
const finishSteps = ({ route, key, worktree, base }) => [
  `- With no unverified calls, done finishes the card itself: it rebases onto ${base}, reruns the full test suite, fast-forwards ${base} and closes the card (on a board with pull requests it pushes the branch and opens a draft PR instead; with Auto-merge off it stops before the fast-forward, and the card waits for the owner's Merge).`,
  `- On a conflict it undoes its rebase and names the files: run \`${rebase(base)}\` in ${worktree}, resolve each conflict keeping both sides' intent, continue with \`git -c core.commentChar=';' rebase --continue\`, rerun the tests, and run done again.`,
  '- On failing tests, fix them, commit, and run done again.',
  '- While another card is landing, done waits its turn and then lands; leave it running.',
  `- Finishing never goes to the orchestrator. If done refuses for a reason you can't fix, record it with \`${cli(route)} builder call ${key} "<why>"\` and run done again: with the call it hands the card back.`,
];
const finishCommand = ({ route, key }) => `\`${cli(route)} builder done ${key} --text "<what you checked>"\``;

// The standard brief for a card's headless builder. card: {route, key, ref, title, notes, worktree, base, rules}.
export function builderBrief({ route, key, ref, title, notes, worktree, base, rules = [] }) {
  const b = cli(route);
  return [
    `You are the headless builder for card ${ref} (${key}, "${title}") on the kickflip board /${route}. The board launched you; nobody watches this session, so never wait on a person. Work only in ${worktree}. Never restart the hub or a board server, and never push.`,
    '',
    `1. Run \`${b} builder start ${key} --kind build\`. If it refuses, stop.`,
    `2. Report progress with \`${b} builder progress ${key} --phase reading|building|testing|checking|landing "<plain, 80 characters or fewer>"\`, at least every 10 minutes.`,
    `3. To ask the orchestrator something, run \`${b} builder ask ${key} "<question>"\` and carry on; read its replies with \`${b} builder asks ${key}\`. Never block on a reply.`,
    `4. Record each judgment call the notes leave open with \`${b} builder call ${key} "<call>"\` instead of guessing silently.`,
    '',
    notes ? `Spec: the card's notes, ${notes}, all sections, where later sections override earlier ones.` : `The card has no notes file: build from its title, and record what you had to decide as calls.`,
    '',
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
    `1. Run \`${b} builder start ${key} --kind build --label Lander\`. If it refuses, stop.`,
    `2. Report progress with \`${b} builder progress ${key} --phase landing "<plain, 80 characters or fewer>"\`.`,
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

// The brief for a planner, a grill or a prototype, launched from the card and its notes so far. card as builderBrief's,
// with kind grill or prototype, repo the board's repo folder it reads, the owner's text and files (uploads, {name, path})
// when the request carried them, and for the owner's eye on one question, question (its id), note and choice.
export function plannerBrief({ route, key, ref, title, notes, kind, repo, rules = [], text, files = [], question, note, choice }) {
  const b = cli(route);
  const grill = kind === 'grill';
  return [
    `You are the headless ${grill ? 'grill' : 'prototype'} planner for card ${ref} (${key}, "${title}") on the kickflip board /${route}. The board launched you; nobody watches this session, so never wait on a person: the owner answers on the board, and a later planner or builder picks up from their answers. Read and run in ${repo}; write no output code there, never restart the hub or a board server, and never push.`,
    '',
    `1. Run \`${b} builder start ${key} --kind ${kind}\`. If it refuses, stop.`,
    `2. Gather the context yourself: ${notes ? `the card's notes, ${notes}, all sections, where later sections override earlier ones; ` : 'the card has no notes file yet; '}its thread, in the board site's data/threads folder, the repo's docs/adr and CONTEXT.md, and the cards its notes and thread link.`,
    `3. Report progress with \`${b} builder progress ${key} "<plain, 80 characters or fewer>"\` at least every 10 minutes.`,
    grill
      ? `4. Follow the grilling skill: find every decision the card leaves open, and post each as a question for the owner with \`${b} question add --file <json>\` on topic item:${key}, one per decision, your recommendation first.`
      : `4. Follow the prototype skill: record the prototype with \`${b} prototype add <topic> --card ${key} --take <K>:<label> …\`, write one take per option, built from the board's real components fed fake data, and post one question whose url opens it with \`${b} question add --file <json>\` on topic item:${key}.`,
    ...(text ? [`   The owner asked for this ${grill ? 'grill' : 'prototype'}, writing: "${text}"`] : []),
    ...(files.length ? [`   The owner attached: ${files.map((f) => f.path).join(', ')}.`] : []),
    ...(question ? [`   The owner asked for prototypes of question ${question}${note ? `, noting "${note}"` : ''}${choice ? `, leaning to option ${choice}` : ''}: draw that question's next round, its question naming round_of ${question}.`] : []),
    `5. Record what you learned in the card's notes with \`${b} item set ${key} --notes-file <file.md>\`, naming each answered question's id.`,
    '',
    ...ruleLines(rules),
    `To finish, run \`${b} builder done ${key} --text "<what you asked>"\`.`,
    '',
    'Never push.',
  ].join('\n');
}

const codexBin = () => process.env.KICKFLIP_CODEX || 'codex';
// The command line for an agent of kind: codex exec with full access, since a builder writes the board's data and the
// repo's .git outside its worktree; claude -p in auto mode on model otherwise.
const agentArgs = ({ kind, prompt, model, cwd }) => (kind === 'codex'
  ? ['exec', '--sandbox', 'danger-full-access', '--cd', cwd, prompt]
  : ['-p', prompt, '--permission-mode', 'auto', '--model', model, '--output-format', 'stream-json', '--verbose']);

// Runs claude -p <prompt> in cwd in auto mode on model, or with kind codex codex exec, detached, without the launching
// session's own CLAUDE_* environment. Its output goes to log as it runs; a Claude agent's is one stream-json event per
// line, which the board's log sheet reads as it grows (app-reader.js). → {pid, log} once it has started; rejects when it
// can't start.
export function launchHeadless({ kind = 'claude', bin = kind === 'codex' ? codexBin() : claudeBin(), cwd, prompt, model, log }) {
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const out = fs.openSync(log, 'a');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !inherited(k)));
  if (path.isAbsolute(bin)) env.PATH = `${path.dirname(bin)}:${env.PATH || ''}`;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, agentArgs({ kind, prompt, model, cwd }), { cwd, env, detached: true, stdio: ['ignore', out, out] });
    child.once('spawn', () => { fs.closeSync(out); child.unref(); resolve({ pid: child.pid, log }); });
    child.once('error', (e) => { fs.closeSync(out); reject(e); });
  });
}

export const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// docs/adr/2026-11-04-1010-a-dead-headless-builder-is-relaunched-once.md
// tracked is {<key>: {kind, model, pid, relaunched}}, the headless builds the server launched or meant to launch (pid null: held
// by the usage pause, not yet launched). open is the set of keys whose builder record is still open. A tracked build whose
// record has closed drops. One with no pid yet launches; one whose process has exited with its record still open launches
// again once, and the second time goes to handBack. launch({key, kind, model}) → {pid}.
// → the tracked map as it now stands.
export async function reviveBuilders(tracked, open, { launch, handBack, alive = pidAlive }) {
  const next = {};
  for (const [key, entry] of Object.entries(tracked)) {
    if (!open.has(key)) continue;
    if (entry.pid !== null && alive(entry.pid)) { next[key] = entry; continue; }
    const card = { key, ...(entry.kind ? { kind: entry.kind } : {}), ...(entry.model ? { model: entry.model } : {}) };
    if (entry.pid !== null && entry.relaunched) { await handBack(card); continue; }
    const { key: _, ...kept } = card;
    next[key] = { ...kept, ...(await launch(card)), relaunched: entry.pid !== null };
  }
  return next;
}

const logFile = (id, role) => path.join(os.homedir(), '.claude', 'kickflip', 'logs', `${role}-${id}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);

// Launches the agent of a build startTappedBuild started ({key, kind, model}), with lander the lander of a verified
// card, or with planner the planner startPlanner opened ({key, kind: grill|prototype, model, text?, files?, question?,
// note?, choice?}), and writes a thread line saying so, with its log. → {pid, log}; rejects when the agent can't start.
export async function launchBuilder(site, { key, kind = 'claude', model, text, files, question, note, choice }, { lander = false } = {}) {
  const facts = await briefFacts(site, key);
  const route = boardAt(site)?.route ?? path.basename(site);
  const rules = [...readHubRules(), ...(await readBoardRules(site))].map((r) => r.text);
  const { base, repo } = builderRepo(site);
  const planner = plans({ kind });
  const card = { ...facts, route, base, repo, rules, kind, text, files, question, note, choice };
  const picked = kind === 'codex' ? 'codex' : model || 'opus';
  const role = planner ? 'Planner' : lander ? 'Lander' : 'Builder';
  const cwd = planner ? repo : facts.worktree;
  const prompt = planner ? plannerBrief(card) : lander ? landerBrief(card) : builderBrief(card);
  const launched = await launchHeadless({ kind: planner ? 'claude' : kind, cwd, prompt, model: picked, log: logFile(key.split('/')[1], role.toLowerCase()) });
  await appendThread(site, key, { text: `${role} launched on ${modelName({ kind, model: picked })} in ${cwd}.`, log: path.basename(launched.log) });
  return launched;
}
