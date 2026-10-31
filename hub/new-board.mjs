import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readManifest, withManifestLock, writeManifest } from './boards.mjs';
import { ROUTE_RE, routeFromName, routeRecord } from './routes.mjs';
import { STARTING_WAIT, startSession } from './sessions.mjs';

const refuse = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

function details(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some((k) => !['name', 'repo', 'purpose'].includes(k))) refuse('Send only name, repo and purpose.');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 60) refuse('Name must be 1–60 characters.');
  if (typeof input.purpose !== 'string' || input.purpose.length > 240) refuse('Purpose must be at most 240 characters.');
  const title = input.name.trim().replace(/\s+/g, ' ');
  const route = routeFromName(title);
  if (!ROUTE_RE.test(route)) refuse('Name must contain a letter or digit for its route.');
  let repo = input.repo;
  if (typeof repo !== 'string') refuse('Repo must be an existing folder under your home.');
  repo = repo.trim().replace(/^~(?=\/|$)/, os.homedir());
  try {
    if (!path.isAbsolute(repo)) throw new Error();
    repo = fs.realpathSync(repo);
    const relative = path.relative(fs.realpathSync(os.homedir()), repo);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !fs.statSync(repo).isDirectory()) throw new Error();
  } catch { refuse('Repo must be an existing folder under your home.'); }
  return { route, title, repo, purpose: input.purpose.trim().replace(/\s+/g, ' ') };
}

// The new session runs these join flags through its shell, so each value must stay one quoted word.
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const joinFlags = ({ title, purpose }) => `--template board --title ${quote(title)}${purpose ? ` --description ${quote(purpose)}` : ''}`;

function errorLine(message) {
  const line = String(message).split('\n').map((l) => l.trim()).find(Boolean) || 'claude did not start';
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

// Records the start's outcome on the route's Starting row: its session as `web-ts start` records one, or `error`. A
// route that has joined or been dismissed meanwhile is left alone.
async function recordStart(route, outcome) {
  await withManifestLock(async () => {
    const m = readManifest();
    const pending = routeRecord(m.starting, route);
    if (!pending || routeRecord(m.sites, route)) return;
    m.starting[route] = outcome.error ? { ...pending, error: outcome.error }
      : { ...pending, session: outcome.session, label: outcome.name, since: new Date().toISOString(), repo: outcome.repo, ...(outcome.model ? { model: outcome.model } : {}) };
    await writeManifest(m);
  });
}

// Reserves the route on a Starting row, then starts the board's session in the background
// (docs/adr/0069-the-hub-starts-a-new-boards-session.md). run and live go to sessions.mjs startSession.
// → {route, started}: started settles once the outcome is on the Starting row, as {session} or {error}, and never rejects.
export async function requestBoard(input, { run, live } = {}) {
  const board = details(input);
  const { route, title, repo } = board;
  await withManifestLock(async () => {
    const manifest = readManifest();
    if (Object.hasOwn(manifest.sites || {}, route) || Object.hasOwn(manifest.starting || {}, route) || Object.hasOwn(manifest.closed || {}, route)) refuse('That board route already exists. Reopen it from Closed boards if it is closed.');
    manifest.starting = { ...manifest.starting, [route]: { title, repo, asked_at: new Date().toISOString() } };
    await writeManifest(manifest);
  });
  const started = (async () => {
    let outcome;
    try {
      const r = await startSession(route, { repo, prompt: joinFlags(board), run, live });
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
