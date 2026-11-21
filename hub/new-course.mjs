// docs/adr/2026-11-18-0600-new-starts-a-board-or-a-teach-course.md
// The New sheet's Course: a /teach course in its own folder under pages, started by the hub in a background session
// that joins the folder as a page once lesson 1 is written. Its Starting row is new-board.mjs's, read by sessions.mjs
// startingBoards, and Dismiss is New board's.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readManifest, withManifestLock, writeManifest } from './boards.mjs';
import { ROUTE_RE, routeFromName, routeRecord } from './routes.mjs';
import { liveSessions } from './live.mjs';
import { resumeSession, startSession } from './sessions.mjs';
import { repoName, repoService } from './repos.mjs';
import { repoInput, cloneFor } from './new-board.mjs';
import { folderPath, shownFolder } from './folders.mjs';
import { trustFolder } from './trust.mjs';
import { claimLaunch } from '../shared/launch-claim.mjs';
import { nodeBin, storedPath } from '../bin/install.mjs';

const refuse = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const KICKFLIP = path.join(storedPath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')), 'bin', 'kickflip.mjs');

// Where every course's folder lives, one per route.
export const pagesHome = () => path.join(os.homedir(), '.claude', 'kickflip', 'pages');

// The lessons a course page has written, lessons/*.html, for a folder under pagesHome; null for any other folder or none.
export function courseLessons(dir) {
  if (typeof dir !== 'string' || path.dirname(path.resolve(dir)) !== pagesHome()) return null;
  try { return fs.readdirSync(path.join(dir, 'lessons')).filter((f) => f.endsWith('.html') && !f.startsWith('.')).length; }
  catch { return fs.existsSync(dir) ? 0 : null; }
}

// A course's optional source, what /teach reads (docs/adr/2026-11-21-2300-new-board-and-new-course-share-one-source-field.md):
// {github} or {remote}, read from its clone in the shared clone home, or {folder}, read in place. → the source, or null
function sourceOf(input) {
  const given = ['github', 'remote', 'folder'].filter((k) => input[k] !== undefined);
  if (!given.length) return null;
  if (given.length > 1) refuse('Send at most one source: github, remote or folder.');
  return input.folder !== undefined ? { folder: folderPath(input.folder) } : repoInput(input);
}

function details(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((k) => !['name', 'learn', 'github', 'remote', 'folder'].includes(k))) refuse('Send only name, learn and one source: github, remote or folder.');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 60) refuse('Name must be 1–60 characters.');
  if (typeof input.learn !== 'string' || !input.learn.trim() || input.learn.length > 1000) refuse('Say what you want to learn, in 1–1000 characters.');
  const title = input.name.trim().replace(/\s+/g, ' ');
  const route = routeFromName(title);
  if (!ROUTE_RE.test(route)) refuse('Name must contain a letter or digit for its route.');
  return { route, title, learn: input.learn.trim(), source: sourceOf(input) };
}

const taken = (manifest, route) => [manifest.sites, manifest.starting, manifest.closed].some((records) => routeRecord(records, route));
// The session runs the join through its shell, so each value stays one quoted word.
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;

// What the course reads, as its prompt names it: a repo by its name and clone, a folder by ~ path and full path.
const learnFrom = (source, read) => (source.folder ? `the folder ${shownFolder(read)} at ${read}` : `${repoName(source.github || source.remote)}, cloned at ${read}`);

// The course session's first prompt: /teach with what the owner wants to learn, then the source it reads, if any, at
// read, then what makes its folder a page.
export const coursePrompt = ({ title, learn, dir, source, read }) => `/teach ${learn}\n\n`
  + (source ? `Learn from ${learnFrom(source, read)}: read it for the lessons, and never write to it; every lesson goes in this folder. ` : '')
  + `The kickflip hub started this session for the course "${title}" from its New sheet; this folder is its workspace. `
  + 'Once lesson 1 is written, write index.html here, linking the lessons and reference pages in the course\'s style, '
  + `then put the folder on the hub as its page: ${quote(nodeBin())} ${quote(KICKFLIP)} page ${quote(title)} --session <your session id> --dir ${quote(dir)} --icon book. `
  + 'Your session id is the directory name just above your scratchpad.';

// Reserves the route on a Starting record of kind course, makes and trusts its folder, then starts its session in the
// background. A repo source is cloned first (new-board.mjs cloneFor, through repos), the record reading cloning until
// then. run and live go to sessions.mjs startSession. → {route, started}: started settles once the outcome is on the
// Starting record, as {session} or {error}, and never rejects.
export async function requestCourse(input, { run, live, repos = repoService(), changed = () => {} } = {}) {
  const { route, title, learn, source } = details(input);
  const repo = source && (source.github || source.remote);
  const dir = path.join(pagesHome(), route);
  await withManifestLock(async () => {
    const manifest = readManifest();
    if (taken(manifest, route)) refuse('That name is taken: a board or page already has its route. Pick another name.', 409);
    const phase = repo && !repos.cloned(repo) ? 'cloning' : 'starting';
    manifest.starting = { ...manifest.starting, [route]: { kind: 'course', title, learn, repo: dir, ...(source ? { source } : {}), phase, asked_at: new Date().toISOString() } };
    await writeManifest(manifest);
  });
  return { route, started: start(route, { title, learn, dir, source }, { run, live, repos, changed }) };
}

async function start(route, { title, learn, dir, source }, { run, live, repos, changed }) {
  let outcome;
  try {
    const repo = source && (source.github || source.remote);
    const read = repo ? await cloneFor(route, repo, (await repos.branches(repo)).defaultBranch, { repos, changed }) : source?.folder;
    if (repo) await setPhase(route, 'starting');
    fs.mkdirSync(dir, { recursive: true });
    trustFolder(dir);
    const r = await startSession(route, { repo: dir, first: coursePrompt({ title, learn, dir, source, read }), dirs: read ? [read] : [], run, live });
    outcome = { session: r.session, label: r.name };
  } catch (e) { outcome = { error: String(e.message).split('\n')[0].slice(0, 200) }; }
  try {
    await withManifestLock(async () => {
      const m = readManifest();
      const pending = routeRecord(m.starting, route);
      if (!pending || routeRecord(m.sites, route)) return;
      m.starting[route] = outcome.error ? { ...pending, error: outcome.error }
        : { ...pending, session: outcome.session, label: outcome.label, since: new Date().toISOString() };
      await writeManifest(m);
    });
  } catch (e) { return { error: `could not record the start: ${e.message}` }; }
  changed();
  return outcome.error ? { error: outcome.error } : { session: outcome.session };
}

// Moves a course's Starting record on to phase, as the hub shows a New board's steps; a route that joined or went
// meanwhile is left alone.
async function setPhase(route, phase) {
  await withManifestLock(async () => {
    const m = readManifest();
    const pending = routeRecord(m.starting, route);
    if (!pending || routeRecord(m.sites, route)) return;
    m.starting[route] = { ...pending, phase, phase_at: new Date().toISOString() };
    await writeManifest(m);
  });
}

// What a resumed or fresh course session is asked once the owner taps its row while it is down.
const nextLesson = (title) => `The kickflip hub resumed this session because the owner opened the course "${title}" while its session was down. `
  + 'Read the course\'s files here to see where it left off, then carry on to the next lesson: write it, link it from index.html and say where it is.';

// The owner opened a course while its session is down: resumes that session in the course's folder with a prompt for
// the next lesson, or starts a fresh /teach there when no session is recorded (it reads the folder to find where the
// course left off), under a launch claim (shared/launch-claim.mjs) so two taps start one session, since the session
// has no recorded owner until the start ends. A session already live starts nothing. run and live go to sessions.mjs.
// → {route, started, session?}
export async function resumeCourse(route, { manifest = readManifest(), run, live = liveSessions } = {}) {
  const site = routeRecord(manifest.sites, route);
  if (courseLessons(site?.dir) === null) refuse('That course is not open.', 404);
  const title = site.title || route;
  const session = site.owner?.session;
  const running = live();
  if (!running) refuse('ps gave no answer, so whether its session runs is unknown. Try again in a moment.', 503);
  if (session && running.has(session)) return { route, started: false, session };
  if (session) {
    const owner = { ...site.owner, repo: site.owner.repo || site.dir };
    const r = await resumeSession(route, { manifest: { ...manifest, sites: { ...manifest.sites, [route]: { ...site, owner } } }, live, run, prompt: nextLesson(title) });
    return { route, started: true, session: r.session };
  }
  const first = `/teach continue the course "${title}"\n\n${nextLesson(title)}`;
  const claim = claimLaunch(path.join(os.homedir(), '.claude', 'kickflip', 'launches'), `course~${route}`);
  if (!claim) return { route, started: false };
  try {
    const r = await startSession(route, { manifest, repo: site.dir, first, run, live });
    await withManifestLock(async () => {
      const m = readManifest();
      const now = new Date().toISOString();
      m.sites[route].owner = { session: r.session, label: r.name, since: now, repo: r.repo, ...(r.model ? { model: r.model } : {}) };
      m.sites[route].updated = now;
      await writeManifest(m);
    });
    return { route, started: true, session: r.session };
  } finally { claim.release(); }
}
