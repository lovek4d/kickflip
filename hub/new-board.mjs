import { ticketSource } from '../board/tickets.mjs';
import { isListening, listBoards, readManifest, withManifestLock, writeManifest } from './boards.mjs';
import { ROUTE_RE, routeFromName, routeRecord } from './routes.mjs';
import { repoService, validateGithub, validateBranch, validateRemote } from './repos.mjs';
import { DEFAULT_MODEL, startFailed, startSession, stopSession } from './sessions.mjs';
import { MODELS } from './board-model.mjs';
import { LINEAR_NEEDS_KEY, linearWorks, savedClient } from './linear.mjs';

const refuse = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

function details(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((k) => !['name', 'github', 'remote', 'branch', 'purpose', 'tickets', 'model'].includes(k))) refuse('Send only name, github or remote, branch, purpose, tickets and model.');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 60) refuse('Name must be 1–60 characters.');
  if (typeof input.purpose !== 'string' || !input.purpose.trim() || input.purpose.length > 240) refuse('Description must be 1–240 characters.');
  if (input.model !== undefined && !MODELS.includes(input.model)) refuse('Model must be opus or sonnet.');
  const title = input.name.trim().replace(/\s+/g, ' ');
  const route = routeFromName(title);
  if (!ROUTE_RE.test(route)) refuse('Name must contain a letter or digit for its route.');
  const { github, remote } = repoInput(input);
  const branch = validateBranch(input.branch);
  let tickets = input.tickets === undefined ? { source: 'none' } : input.tickets;
  if (remote && tickets?.source === 'github') refuse('GitHub issues need a repo on GitHub; pick None or Linear.');
  let newProject;
  if (tickets?.source === 'linear' && typeof tickets === 'object' && Object.hasOwn(tickets, 'new_project')) {
    const { new_project: name, ...rest } = tickets;
    newProject = typeof name === 'string' ? name.trim() : '';
    if (!newProject || newProject.length > 80) refuse('Name the new Linear project.');
    tickets = { ...rest, project: newProject };
  }
  return { route, title, github, remote, branch, tickets: ticketSource(tickets), model: input.model || DEFAULT_MODEL, newProject, purpose: input.purpose.trim().replace(/\s+/g, ' ') };
}

// A board's repo from a request: {github} on GitHub, or {remote} on any other git host
// (docs/adr/2026-11-02-1850-a-board-can-work-on-any-git-remote.md).
export function repoInput(input) {
  if ((input.github === undefined) === (input.remote === undefined)) refuse('Send the repo as github or as remote.');
  return input.github !== undefined ? { github: validateGithub(input.github) } : { remote: validateRemote(input.remote).remote };
}

const taken = (manifest, route) => Object.hasOwn(manifest.sites || {}, route) || Object.hasOwn(manifest.starting || {}, route) || Object.hasOwn(manifest.closed || {}, route);
const TAKEN = 'That board route already exists. Reopen it from Closed boards if it is closed.';

// The new session runs these join flags through its shell, so each value must stay one quoted word. The board's name,
// which gives its title and route, comes first in the prompt, after /kickflip board (sessions.mjs startArgv).
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const joinFlags = ({ purpose }) => (purpose ? `--description ${quote(purpose)}` : '');

function errorLine(message) {
  const line = String(message).split('\n').map((l) => l.trim()).find(Boolean) || 'claude did not start';
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

// Records the start's outcome on the route's Starting row: a new phase, with when it began in phase_at, its session as
// `kickflip start` records one, or `error`. A route that has joined or been dismissed meanwhile is left alone.
async function recordStart(route, outcome) {
  await withManifestLock(async () => {
    const m = readManifest();
    const pending = routeRecord(m.starting, route);
    if (!pending || routeRecord(m.sites, route)) return;
    if (outcome.phase && outcome.phase === pending.phase) return;
    m.starting[route] = outcome.phase ? { ...pending, phase: outcome.phase, phase_at: new Date().toISOString() } : outcome.error ? { ...pending, error: outcome.error }
      : { ...pending, session: outcome.session, label: outcome.name, since: new Date().toISOString(), repo: outcome.repo, ...(outcome.model ? { model: outcome.model } : {}) };
    await writeManifest(m);
  });
}

// The Starting row's record before its start has an outcome.
const startingRecord = ({ title, purpose, repo, github, remote, branch, tickets, model }, repos) => ({
  title, purpose, repo, ...(github ? { github } : { remote }), branch, tickets, model,
  phase: repos.cloned(github || remote) ? 'starting' : 'cloning', asked_at: new Date().toISOString(),
});

// A fresh clone's percent by route, in hub memory only while it runs: the sidebar shows it, and the manifest keeps only
// the coarse phase (docs/adr/2026-11-04-1914-a-new-board-shows-its-start-steps-and-clone-progress.md).
const clonePercents = new Map();
export const clonePercent = (route) => clonePercents.get(route);
const PROGRESS_EVERY_MS = 1000;

// Prepares the clone and starts the route's session, recording the outcome on its Starting row. The clone's percent
// calls changed at most once a second. → a promise that settles once the outcome is recorded, as {session} or {error},
// and never rejects.
async function start(route, { purpose, repo, github, remote, branch, model }, { run, live, repos, changed }) {
  let outcome;
  let sent = -Infinity;
  const progress = (percent) => {
    clonePercents.set(route, percent);
    if (Date.now() - sent < PROGRESS_EVERY_MS) return;
    sent = Date.now();
    changed();
  };
  try {
    try { await repos.ensure(github || remote, branch, { progress }); } finally { clonePercents.delete(route); }
    await recordStart(route, { phase: 'starting' });
    changed();
    const r = await startSession(route, { repo, model, prompt: joinFlags({ purpose }), run, live, clones: repos.base });
    outcome = { session: r.session, name: r.name, repo: r.repo, model: r.model };
  } catch (e) { outcome = { error: errorLine(e.message) }; }
  try { await recordStart(route, outcome); } catch (e) { return { error: errorLine(`could not record the start: ${e.message}`) }; }
  return outcome.error ? { error: outcome.error } : { session: outcome.session };
}

// Reserves the route on a Starting row, then starts the board's session in the background
// (docs/adr/2026-10-31-0137-the-hub-starts-a-new-boards-session.md). run and live go to sessions.mjs startSession. Tickets with
// new_project create that Linear project first, through linear (linear.mjs savedClient by default). Linear tickets
// need Hub's working key, or the linear passed in.
// → {route, started}: started settles once the outcome is on the Starting row, as {session} or {error}, and never rejects.
export async function requestBoard(input, { run, live, repos = repoService(), changed = () => {}, linear } = {}) {
  const board = details(input);
  const { route, github, remote, newProject } = board;
  let { tickets } = board;
  if (tickets?.source === 'linear' && !linear && !linearWorks()) refuse(LINEAR_NEEDS_KEY);
  const repo = repos.path(github || remote);
  const client = newProject === undefined ? null : linear || savedClient();
  if (client) {
    if (taken(readManifest(), route)) refuse(TAKEN);
    try { tickets = { ...tickets, project: (await client.createProject(tickets.team, newProject)).id }; }
    catch (e) { refuse(e.message, e.status || 502); }
  }
  await withManifestLock(async () => {
    const manifest = readManifest();
    if (taken(manifest, route)) refuse(TAKEN);
    manifest.starting = { ...manifest.starting, [route]: startingRecord({ ...board, repo, tickets }, repos) };
    await writeManifest(manifest);
  });
  return { route, started: start(route, { ...board, repo }, { run, live, repos, changed }) };
}

// The route's Starting record when its start failed (sessions.mjs startFailed), else refuses with action's verb.
function failedStart(manifest, route, action) {
  const pending = routeRecord(manifest.starting, route);
  if (!pending || (routeRecord(manifest.sites, route) && !pending.joined_at) || !startFailed(pending)) refuse(`Only a board that didn’t start can be ${action}.`);
  return pending;
}

// Starts a failed New board start again from its Starting record, with the same route, repo, branch, tickets and
// purpose (docs/adr/2026-11-02-2006-a-failed-start-retries-from-its-sheet.md). A start that timed out first has its recorded
// session stopped (sessions.mjs stopSession, with live and stop), so the route never has two. The record loses its
// error and session, and takes a new phase and asked_at, and its repo path again from the repo and the current clone
// home, so the session starts in the folder the clone goes to. → {route, started} as requestBoard's.
export async function retryBoard(route, { run, live, stop, repos = repoService(), changed = () => {} } = {}) {
  const before = failedStart(readManifest(), route, 'retried');
  if (before.joined_at) refuse('Its session joined; a board that is not listening yet can only be dismissed.');
  if (!before.branch) refuse('Only a board asked for with New board can be retried; make it again with New board.');
  try { await stopSession(before, { live, stop }); } catch (e) { refuse(`Couldn’t stop its earlier session: ${e.message}`, 502); }
  const board = await withManifestLock(async () => {
    const manifest = readManifest();
    const pending = failedStart(manifest, route, 'retried');
    manifest.starting[route] = startingRecord({ ...pending, repo: repos.path(pending.github || pending.remote), purpose: pending.purpose || '' }, repos);
    await writeManifest(manifest);
    return manifest.starting[route];
  });
  return { route, started: start(route, board, { run, live, repos, changed }) };
}

export async function dismissBoard(route) {
  return withManifestLock(async () => {
    const manifest = readManifest();
    failedStart(manifest, route, 'dismissed');
    delete manifest.starting[route];
    if (!Object.keys(manifest.starting).length) delete manifest.starting;
    await writeManifest(manifest);
    return { route };
  });
}

// Drops the Starting records of boards that have landed: joined, and now listening (docs/adr/2026-11-04-2030-landing-it-lasts-until-the-board-listens.md),
// or whose board is gone. → the routes dropped
export async function settleStarts({ listening = isListening } = {}) {
  if (!Object.values(readManifest().starting || {}).some((rec) => rec.joined_at)) return [];
  return withManifestLock(async () => {
    const manifest = readManifest();
    const boards = new Map(listBoards(manifest).map((b) => [b.route, b]));
    const landed = Object.entries(manifest.starting || {}).filter(([route, rec]) => rec.joined_at && (!boards.has(route) || listening(boards.get(route)))).map(([route]) => route);
    if (!landed.length) return [];
    for (const route of landed) delete manifest.starting[route];
    if (!Object.keys(manifest.starting).length) delete manifest.starting;
    await writeManifest(manifest);
    return landed;
  });
}
