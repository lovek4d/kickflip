import { ticketSource } from '../board/tickets.mjs';
import { readManifest, withManifestLock, writeManifest } from './boards.mjs';
import { ROUTE_RE, routeFromName, routeRecord } from './routes.mjs';
import { repoService, validateGithub, validateBranch, validateRemote } from './repos.mjs';
import { STARTING_WAIT, startSession } from './sessions.mjs';
import { savedClient } from './linear.mjs';

const refuse = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

function details(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((k) => !['name', 'github', 'remote', 'branch', 'purpose', 'tickets'].includes(k))) refuse('Send only name, github or remote, branch, purpose and tickets.');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 60) refuse('Name must be 1–60 characters.');
  if (input.purpose !== undefined && (typeof input.purpose !== 'string' || input.purpose.length > 240)) refuse('Purpose must be at most 240 characters.');
  const title = input.name.trim().replace(/\s+/g, ' ');
  const route = routeFromName(title);
  if (!ROUTE_RE.test(route)) refuse('Name must contain a letter or digit for its route.');
  const { github, remote } = repoInput(input);
  const branch = validateBranch(input.branch);
  let tickets = input.tickets === undefined ? { source: 'internal' } : input.tickets;
  if (remote && tickets?.source === 'github') refuse('GitHub issues need a repo on GitHub; pick Internal or Linear.');
  let newProject;
  if (tickets?.source === 'linear' && typeof tickets === 'object' && Object.hasOwn(tickets, 'new_project')) {
    const { new_project: name, ...rest } = tickets;
    newProject = typeof name === 'string' ? name.trim() : '';
    if (!newProject || newProject.length > 80) refuse('Name the new Linear project.');
    tickets = { ...rest, project: newProject };
  }
  return { route, title, github, remote, branch, tickets: ticketSource(tickets), newProject, purpose: (input.purpose || '').trim().replace(/\s+/g, ' ') };
}

// A board's repo from a request: {github} on GitHub, or {remote} on any other git host
// (docs/adr/0127-a-board-can-work-on-any-git-remote.md).
export function repoInput(input) {
  if ((input.github === undefined) === (input.remote === undefined)) refuse('Send the repo as github or as remote.');
  return input.github !== undefined ? { github: validateGithub(input.github) } : { remote: validateRemote(input.remote).remote };
}

const taken = (manifest, route) => Object.hasOwn(manifest.sites || {}, route) || Object.hasOwn(manifest.starting || {}, route) || Object.hasOwn(manifest.closed || {}, route);
const TAKEN = 'That board route already exists. Reopen it from Closed boards if it is closed.';

// The new session runs these join flags through its shell, so each value must stay one quoted word.
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const joinFlags = ({ title, purpose }) => `--template board --items data/wave.json --title ${quote(title)}${purpose ? ` --description ${quote(purpose)}` : ''}`;

function errorLine(message) {
  const line = String(message).split('\n').map((l) => l.trim()).find(Boolean) || 'claude did not start';
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

// Records the start's outcome on the route's Starting row: its session as `kickflip start` records one, or `error`. A
// route that has joined or been dismissed meanwhile is left alone.
async function recordStart(route, outcome) {
  await withManifestLock(async () => {
    const m = readManifest();
    const pending = routeRecord(m.starting, route);
    if (!pending || routeRecord(m.sites, route)) return;
    m.starting[route] = outcome.phase ? { ...pending, phase: outcome.phase } : outcome.error ? { ...pending, error: outcome.error }
      : { ...pending, session: outcome.session, label: outcome.name, since: new Date().toISOString(), repo: outcome.repo, ...(outcome.model ? { model: outcome.model } : {}) };
    await writeManifest(m);
  });
}

// Reserves the route on a Starting row, then starts the board's session in the background
// (docs/adr/0069-the-hub-starts-a-new-boards-session.md). run and live go to sessions.mjs startSession. Tickets with
// new_project create that Linear project first, through linear (linear.mjs savedClient by default); without a key the
// project keeps its name, and the board's session creates it through its Linear MCP.
// → {route, started}: started settles once the outcome is on the Starting row, as {session} or {error}, and never rejects.
export async function requestBoard(input, { run, live, repos = repoService(), changed = () => {}, linear } = {}) {
  const board = details(input);
  const { route, title, github, remote, branch, newProject } = board;
  let { tickets } = board;
  const source = github || remote;
  const repo = repos.path(source);
  const client = newProject === undefined ? null : linear || savedClient();
  if (client) {
    if (taken(readManifest(), route)) refuse(TAKEN);
    try { tickets = { ...tickets, project: (await client.createProject(tickets.team, newProject)).id }; }
    catch (e) { refuse(e.message, e.status || 502); }
  }
  await withManifestLock(async () => {
    const manifest = readManifest();
    if (taken(manifest, route)) refuse(TAKEN);
    manifest.starting = { ...manifest.starting, [route]: { title, repo, ...(github ? { github } : { remote }), branch, tickets, phase: repos.cloned(source) ? 'starting' : 'cloning', asked_at: new Date().toISOString() } };
    await writeManifest(manifest);
  });
  const started = (async () => {
    let outcome;
    try {
      await repos.ensure(source, branch);
      await recordStart(route, { phase: 'starting' });
      changed();
      const r = await startSession(route, { repo, prompt: joinFlags(board), run, live, clones: repos.base });
      outcome = { session: r.session, name: r.name, repo: r.repo, model: r.model };
    } catch (e) { outcome = { error: errorLine(e.message) }; }
    try { await recordStart(route, outcome); } catch (e) { return { error: errorLine(`could not record the start: ${e.message}`) }; }
    return outcome.error ? { error: outcome.error } : { session: outcome.session };
  })();
  return { route, started };
}

export async function dismissBoard(route) {
  return withManifestLock(async () => {
    const manifest = readManifest();
    const pending = routeRecord(manifest.starting, route);
    const askedAt = Date.parse(pending?.asked_at || pending?.since);
    const failed = Boolean(pending?.error) || (Number.isFinite(askedAt) && Date.now() - askedAt >= STARTING_WAIT);
    if (!pending || routeRecord(manifest.sites, route) || !failed) refuse('Only a board that didn’t start can be dismissed.');
    delete manifest.starting[route];
    if (!Object.keys(manifest.starting).length) delete manifest.starting;
    await writeManifest(manifest);
    return { route };
  });
}
