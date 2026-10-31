import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendEvent, hubBoard, readManifest, withManifestLock, writeManifest } from './boards.mjs';
import { ROUTE_RE, routeFromName, routeRecord } from './routes.mjs';
import { STARTING_WAIT } from './sessions.mjs';

const refuse = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

function repoLabel(repo) {
  const home = fs.realpathSync(os.homedir());
  return repo === home ? '~' : repo.startsWith(`${home}${path.sep}`) ? `~${repo.slice(home.length)}` : repo;
}

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

export async function requestBoard(input) {
  const newBoard = details(input);
  return withManifestLock(async () => {
    const manifest = readManifest();
    const { route, title, repo, purpose } = newBoard;
    if (Object.hasOwn(manifest.sites || {}, route) || Object.hasOwn(manifest.starting || {}, route)) refuse('That board route already exists.');
    const hub = hubBoard(manifest);
    if (!hub) refuse('No hub board is flagged; flag one with web-ts set <route> --hub', 503);
    manifest.starting = { ...manifest.starting, [route]: { title, repo, asked_at: new Date().toISOString() } };
    await writeManifest(manifest);
    // The one feature that depends on the dev-time hub session: docs/adr/0068-the-hub-session-is-a-dev-time-role.md.
    try { await appendEvent(hub, 'ask', { text: `New board: ${title} in ${repoLabel(repo)}${purpose ? ` — ${purpose}` : ''}`, newBoard }); }
    catch (e) {
      delete manifest.starting[route];
      if (!Object.keys(manifest.starting).length) delete manifest.starting;
      await writeManifest(manifest);
      throw e;
    }
    return { route };
  });
}

export async function dismissBoard(route) {
  return withManifestLock(async () => {
    const manifest = readManifest();
    const pending = routeRecord(manifest.starting, route);
    const askedAt = Date.parse(pending?.asked_at || pending?.since);
    if (!pending || routeRecord(manifest.sites, route) || !Number.isFinite(askedAt) || Date.now() - askedAt < STARTING_WAIT) refuse('Only a board that didn’t start can be dismissed.');
    delete manifest.starting[route];
    if (!Object.keys(manifest.starting).length) delete manifest.starting;
    await writeManifest(manifest);
    return { route };
  });
}
