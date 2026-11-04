// docs/adr/2026-11-04-0306-builders-launch-headless-check-their-notes-and-land-on-their-own.md
// On a board whose builders launch headless (board.json headless_builders), the board server launches each build as
// `claude -p <brief>` in the card's worktree instead of waking its session to brief and dispatch one, and a lander the
// same way once the session has verified a handed-back build's judgment calls. The brief is built from the card: its
// notes file, the hub's and board's rules, and the board's CLI. A builder lands its own work (board.mjs land), resolving
// any rebase conflict itself; only judgment calls and deferred asks go to the session.
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
import { modelName } from './domain.mjs';

export const BOARD_CLI = fileURLToPath(new URL('./bin/board.mjs', import.meta.url));
const cli = (route) => `node ${BOARD_CLI} --site ${route}`;
const rebase = (base) => `git -c core.commentChar=';' rebase ${base}`;
const ruleLines = (rules) => (rules.length ? ['Rules from the hub and this board:', ...rules.map((r) => `- ${r}`), ''] : []);

const landSteps = ({ route, key, worktree, base }) => [
  `Land it yourself: run \`${cli(route)} land ${key} --text "<what you checked>"\`. It rebases onto ${base}, reruns the full test suite and fast-forwards ${base}.`,
  `- On a conflict it undoes its rebase and names the files: run \`${rebase(base)}\` in ${worktree}, resolve each conflict keeping both sides' intent, continue with \`git -c core.commentChar=';' rebase --continue\`, rerun the tests, and land again.`,
  '- On failing tests, fix them, commit, and land again.',
  '- While another card is landing it refuses, naming that card: wait a minute and land again.',
  `- Landing never goes to the orchestrator. If land refuses for a reason you can't fix, record it with \`${cli(route)} builder call ${key} "<why>"\` and run \`${cli(route)} builder done ${key}\`.`,
];

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
    'To finish:',
    `- If you recorded a judgment call, run \`${b} builder done ${key}\` and stop: it hands the card back for the orchestrator to verify your calls, and the board launches a lander once it has.`,
    `- Otherwise: ${landSteps({ route, key, worktree, base }).join('\n')}`,
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
    ...landSteps({ route, key, worktree, base }),
    '',
    'Never push.',
  ].join('\n');
}

// Runs claude -p <prompt> in cwd in auto mode on model, detached, its output in log, without the launching session's
// own CLAUDE_* environment. → {pid, log} once it has started; rejects when it can't start.
export function launchHeadless({ bin = claudeBin(), cwd, prompt, model, log }) {
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const out = fs.openSync(log, 'a');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !inherited(k)));
  if (path.isAbsolute(bin)) env.PATH = `${path.dirname(bin)}:${env.PATH || ''}`;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-p', prompt, '--permission-mode', 'auto', '--model', model], { cwd, env, detached: true, stdio: ['ignore', out, out] });
    child.once('spawn', () => { fs.closeSync(out); child.unref(); resolve({ pid: child.pid, log }); });
    child.once('error', (e) => { fs.closeSync(out); reject(e); });
  });
}

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// docs/adr/2026-11-04-1010-a-dead-headless-builder-is-relaunched-once.md
// tracked is {<key>: {model, pid, relaunched}}, the headless builds the server launched or meant to launch (pid null: held
// by the usage pause, not yet launched). open is the set of keys whose builder record is still open. A tracked build whose
// record has closed drops. One with no pid yet launches; one whose process has exited with its record still open launches
// again once, and the second time goes to handBack instead of waiting on the stall alarm. launch({key, model}) → {pid}.
// → the tracked map as it now stands.
export async function reviveBuilders(tracked, open, { launch, handBack, alive = pidAlive }) {
  const next = {};
  for (const [key, entry] of Object.entries(tracked)) {
    if (!open.has(key)) continue;
    if (entry.pid !== null && alive(entry.pid)) { next[key] = entry; continue; }
    if (entry.pid !== null && entry.relaunched) { await handBack(entry.model ? { key, model: entry.model } : { key }); continue; }
    next[key] = { model: entry.model, ...(await launch({ key, model: entry.model })), relaunched: entry.pid !== null };
  }
  return next;
}

const logFile = (id, role) => path.join(os.homedir(), '.claude', 'kickflip', 'logs', `${role}-${id}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);

// Launches the headless builder of a build startTappedBuild started ({key, model, worktree}), or with lander the
// lander of a verified card, and writes a thread line saying so. → {pid, log}; rejects when claude can't start.
export async function launchBuilder(site, { key, model }, { lander = false } = {}) {
  const facts = await briefFacts(site, key);
  const route = boardAt(site)?.route ?? path.basename(site);
  const rules = [...readHubRules(), ...(await readBoardRules(site))].map((r) => r.text);
  const card = { ...facts, route, base: builderRepo(site).base, rules };
  const picked = model || 'opus';
  const launched = await launchHeadless({ cwd: facts.worktree, prompt: lander ? landerBrief(card) : builderBrief(card), model: picked, log: logFile(key.split('/')[1], lander ? 'lander' : 'builder') });
  await appendThread(site, key, { text: `${lander ? 'Lander' : 'Builder'} launched headless on ${modelName({ model: picked })} in ${facts.worktree}; its log is ${launched.log}.` });
  return launched;
}
