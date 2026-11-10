// docs/adr/2026-11-09-1626-gh-refuses-while-githubs-hourly-limit-holds.md
// Every kickflip gh call runs through here. While GitHub's hourly limit holds for the budget a call spends (REST's core
// or GraphQL) of the account it runs as, the call refuses at once with the reset time, and gh never runs. A call that
// hits the limit asks `gh api rate_limit`, which spends nothing, for each spent budget's reset and records it in the
// gate file ~/.claude/kickflip/gh-limit.json: {<account>: {core|graphql: <reset ISO time>}}. The account is the login a
// board sets (its github_login, its tickets' github.account), else PRIMARY, gh's active login. GitHub's secondary limit
// (too many calls at once) never holds the gate: rate_limit shows no budget spent for it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { clock } from '../hub/schedule.mjs';

export const PRIMARY = 'primary';

export const gateFile = (home = os.homedir()) => path.join(home, '.claude', 'kickflip', 'gh-limit.json');

// The budget a gh call spends: graphql, core, or null for one that spends none (a token read, rate_limit itself).
// gh's pr, issue and repo commands run on GraphQL.
export function budgetOf(args) {
  const [command, sub] = args;
  if (command === 'auth') return sub === 'token' || sub === 'git-credential' ? null : 'core';
  if (command === 'api') {
    const endpoint = args.slice(1).find((a) => !a.startsWith('-'));
    return endpoint === 'graphql' ? 'graphql' : endpoint === 'rate_limit' ? null : 'core';
  }
  if (command === 'run') return 'core';
  return ['pr', 'issue', 'repo'].includes(command) ? 'graphql' : null;
}

const readGate = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };

// When the account's budget resets while the limit holds it, else null. Without a budget, the later of the account's
// held budgets.
export function limitedUntil({ account = PRIMARY, budget, now = Date.now(), file = gateFile() } = {}) {
  const held = Object.entries(readGate(file)[account] || {}).filter(([b, at]) => (!budget || b === budget) && Date.parse(at) > now).map(([, at]) => at);
  return held.sort().at(-1) || null;
}

// The words a refused call fails with.
export const limitWords = (until, account = PRIMARY, now = new Date()) => `GitHub rate limited${account === PRIMARY ? '' : ` for ${account}`}, resets at ${clock(new Date(until), now)}`;

// GitHub's words for its hourly limit, in REST's message or GraphQL's error; never its secondary limit.
const hitLimit = (output) => /API rate limit (already )?exceeded/i.test(output) && !/secondary rate limit/i.test(output);

// Records each budget rate_limit's answer shows spent, with its reset. → whether one was recorded
function record(file, account, answer) {
  let resources;
  try { resources = JSON.parse(answer).resources; } catch { return false; }
  const spent = ['core', 'graphql'].filter((b) => resources?.[b]?.remaining === 0 && Number(resources[b].reset) * 1000 > Date.now());
  if (!spent.length) return false;
  const gate = readGate(file);
  const now = Date.now();
  for (const [name, budgets] of Object.entries(gate)) {
    for (const [b, at] of Object.entries(budgets)) if (!(Date.parse(at) > now)) delete budgets[b];
    if (!Object.keys(budgets).length) delete gate[name];
  }
  gate[account] = { ...gate[account], ...Object.fromEntries(spent.map((b) => [b, new Date(resources[b].reset * 1000).toISOString()])) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(gate, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return true;
}

const refusal = (args, account, file) => {
  const budget = budgetOf(args);
  const until = budget && limitedUntil({ account, budget, file });
  return until ? { status: 1, stdout: '', stderr: limitWords(until, account), limited: until } : null;
};
// A failed call that hit the limit: the call's result, with limited and the gate's words once the gate holds it.
const gated = (result, args, account, file) => {
  const until = limitedUntil({ account, budget: budgetOf(args), file });
  return until ? { ...result, stderr: limitWords(until, account), limited: until } : result;
};

// One gh call through the gate. options: env, account, and execFile's timeout, maxBuffer and cwd.
// → {status, stdout, stderr, limited?: the reset time when the limit refused or stopped it}; never rejects.
export async function gh(args, { env = process.env, account = PRIMARY, file = gateFile(), ...options } = {}) {
  const refused = refusal(args, account, file);
  if (refused) return refused;
  const run = (argv) => new Promise((resolve) => execFile('gh', argv, { ...options, env }, (err, stdout, stderr) => resolve({
    status: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr || (err ? err.message : '')) })));
  const result = await run(args);
  if (result.status === 0 || !hitLimit(`${result.stderr}\n${result.stdout}`)) return result;
  const limits = await run(['api', 'rate_limit']);
  return limits.status === 0 && record(file, account, limits.stdout) ? gated(result, args, account, file) : result;
}

// gh's synchronous form, for a caller that runs gh with spawnSync. → as gh
export function ghSync(args, { env = process.env, account = PRIMARY, file = gateFile(), ...options } = {}) {
  const refused = refusal(args, account, file);
  if (refused) return refused;
  const run = (argv) => {
    const r = spawnSync('gh', argv, { encoding: 'utf8', ...options, env });
    return { status: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || r.error?.message || '' };
  };
  const result = run(args);
  if (result.status === 0 || !hitLimit(`${result.stderr}\n${result.stdout}`)) return result;
  const limits = run(['api', 'rate_limit']);
  return limits.status === 0 && record(file, account, limits.stdout) ? gated(result, args, account, file) : result;
}
