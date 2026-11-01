// Board sessions the hub can start and wake. The manifest records each site's session in its `owner`
// {session, label, since, repo, model?}: repo is the folder the session runs in, where `claude --resume` finds it. A
// session `kickflip start` launched for a route with no site yet waits in the manifest's `starting` {<route>: owner}
// until its join moves it into the site. A New board request (new-board.mjs) records {title, repo, asked_at} there
// first, then the hub's start merges its owner in, or `error` when claude failed. Board sessions start in the background (`claude --bg`) in auto mode, with
// worktree.bgIsolation "none" so it stays in the repo folder, since its builders make their own worktrees, and with
// the hook that brings its prompts to the owner's phone. `kickflip hub` runs the hub board's session in the owner's terminal.
// checkSessions is the hub's wake (docs/adr/0061-a-boards-session-wakes-when-an-event-arrives.md): when an event lands
// for a board whose owner session isn't running, the session is resumed at once; a board not listening for
// RESUME_AFTER with an event its session hasn't heard is resumed as a fallback. Either happens once per outage, and if
// the board still isn't listening COMEBACK_WAIT later, the owner gets one push.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { routeRecord, validRoute } from './routes.mjs';
import { withFileLock } from './locks.mjs';
import { RESUME_STATE, carryCursor, hubBoard, isListening, listBoards, oldestUnheard, readManifest, readJSON, saveJSON, watchedCounts, withManifestLock, writeManifest } from './boards.mjs';
import { liveSessions, sessionRecords, processStarts, verifiedProcess } from './live.mjs';
import { deliver } from './push.mjs';
import { WAIT_MS } from './prompts.mjs';
import { storedPath } from '../bin/install.mjs';

const SKILL_DIR = storedPath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
export const RESUME_AFTER = 3 * 60_000;
export const COMEBACK_WAIT = 5 * 60_000;
export const STARTING_WAIT = 15 * 60_000;

export function startingBoards(manifest, now = Date.now()) {
  return Object.entries(manifest.starting || {}).filter(([route]) => !routeRecord(manifest.sites, route)).map(([route, rec]) => {
    const askedAt = rec.asked_at || rec.since;
    return { route, title: rec.title || rec.label || route, repo: rec.repo, ...(rec.phase ? { phase: rec.phase } : {}), askedAt, failed: Boolean(rec.error) || now - Date.parse(askedAt) >= STARTING_WAIT, ...(rec.error ? { error: rec.error } : {}) };
  });
}
// "none" is the value that turns isolation off; Claude Code drops any other value and isolates. The PermissionRequest
// hook sends the session's prompts to the phone, and its timeout stays a minute past the hook's own wait
// (docs/adr/0060-background-sessions-prompts-come-to-the-phone.md). launchd's PATH may have no node, hence execPath.
export const PROMPT_HOOK_TIMEOUT_S = WAIT_MS / 1000 + 60;
export const BG_SETTINGS = JSON.stringify({
  worktree: { bgIsolation: 'none' },
  hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: `"${process.execPath}" "${path.join(SKILL_DIR, 'hub', 'permission-hook.mjs')}"`, timeout: PROMPT_HOOK_TIMEOUT_S }] }] },
});

export class SessionError extends Error {
  // reason: 'none' (no session or folder recorded), 'hub' (no hub board), 'live' (the session runs), 'failed' (claude refused)
  constructor(message, reason) { super(message); this.reason = reason; }
}

export function withSessionLock(route, fn) {
  if (!validRoute(route)) throw new SessionError('Choose a board route.', 'none');
  return withFileLock(path.join(os.homedir(), '.claude', 'kickflip', 'session-locks', route),
    () => fn({ resume: (options) => resumeRecordedSession(route, options) }), { staleAfter: 120_000, timeout: 90_000 });
}

// launchd gives the hub a PATH without ~/.local/bin, where the Claude Code installer puts claude.
export function claudeBin() {
  if (process.env.KICKFLIP_CLAUDE) return process.env.KICKFLIP_CLAUDE;
  const local = path.join(os.homedir(), '.local', 'bin', 'claude');
  return fs.existsSync(local) ? local : 'claude';
}

// A session's environment names its own session and parent; a claude started under it would take them as its own.
const inherited = (k) => k === 'CLAUDECODE' || k === 'CLAUDE_PID' || k === 'CLAUDE_EFFORT' || k.startsWith('CLAUDE_CODE_');

// Runs claude with argv in cwd. → {status, stdout, stderr}. A process `claude --bg` leaves behind can hold our pipes
// open, so this settles shortly after claude exits rather than on close, and drops the pipes so the caller can exit.
export function runClaude(argv, { cwd, timeout = 60_000 }) {
  const bin = claudeBin();
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !inherited(k)));
  env.CLAUDE_BG_ISOLATION = 'none';
  if (path.isAbsolute(bin)) env.PATH = `${path.dirname(bin)}:${env.PATH || ''}`;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try { child = spawn(bin, argv, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { resolve({ status: 1, stdout, stderr: e.message }); return; }
    const done = (status) => { clearTimeout(timer); child.stdout.destroy(); child.stderr.destroy(); resolve({ status, stdout, stderr }); };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} done(1); }, timeout);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { stderr += e.message; done(1); });
    child.on('close', (code) => done(code ?? 1));
    child.on('exit', (code) => setTimeout(() => done(code ?? 1), 300));
    child.unref();
  });
}

export async function runSessionStop(record, { cwd, run = runClaude, starts = processStarts, signal = process.kill } = {}) {
  if (record.kind === 'bg') {
    const result = await run(['stop', record.jobId || record.sessionId.slice(0, 8)], { cwd, timeout: 8000 });
    if (result.status !== 0) throw new SessionError(`claude stop failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`, 'failed');
  } else {
    if (!verifiedProcess(record, starts)) throw new SessionError(`Cannot verify session ${record.sessionId}'s process identity; refusing to signal pid ${record.pid}.`, 'failed');
    signal(record.pid, 'SIGTERM');
  }
}

export async function stopSession(owner, { live = liveSessions, stop = runSessionStop } = {}) {
  if (!owner?.session) return;
  const record = live().get(owner.session);
  if (!record) return;
  await stop(record, { cwd: owner.repo || record.cwd || os.homedir() });
  const deadline = Date.now() + 5000;
  while (live().get(owner.session)?.pid === record.pid) {
    if (Date.now() >= deadline) throw new SessionError(`session ${owner.session} did not stop`, 'failed');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export function runForegroundClaude(argv, { cwd }) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !inherited(k) && k !== 'CLAUDE_BG_ISOLATION'));
  // A terminal's Ctrl-C or Ctrl-\ signals both processes; this one has to outlive claude to hand back its exit code.
  const ignore = () => {};
  process.on('SIGINT', ignore).on('SIGQUIT', ignore);
  const settle = () => process.off('SIGINT', ignore).off('SIGQUIT', ignore);
  return new Promise((resolve, reject) => {
    const child = spawn(claudeBin(), argv, { cwd, env, stdio: 'inherit' });
    child.on('error', (e) => { settle(); reject(new SessionError(e.message, 'failed')); });
    child.on('close', (code) => { settle(); resolve({ status: code ?? 1 }); });
  });
}

const common = ({ name, model }) => ['--name', name, '--permission-mode', 'auto', '--settings', BG_SETTINGS, ...(model ? ['--model', model] : [])];
export const startArgv = ({ route, name, model, prompt }) => ['--bg', ...common({ name, model }), `/kickflip ${route}${prompt ? ` ${prompt}` : ''}`];
export const resumePrompt = (route, id) => `The hub resumed this session because /${route} had nobody listening. Rejoin the board as session ${id} (kickflip steps 3 and 5): rerun \`node ${path.join(SKILL_DIR, 'bin', 'kickflip.mjs')} join ${route} --session ${id}\`, relaunch its watcher as a background task, then go on with what its events ask. If your session id (the folder above your scratchpad) isn't ${id}, rejoin with yours and --force.`;
// A background session resumed with any flag starts as a copy under a new id, so one goes without them and keeps the
// options it started with; a session that never ran in the background gets them (Claude Code's `note:` line says which).
export const resumeArgv = ({ id, route, name, model, background }) => ['--resume', id, '--bg', ...(background ? [] : common({ name, model })), resumePrompt(route, id)];

const hubPrompt = (route) => `You are the hub session. Read \`${path.join(SKILL_DIR, 'docs', 'hub-session.md')}\`, then rejoin /${route} and relaunch its watcher.`;
export const hubArgv = ({ route, id, model }) => [
  ...(id ? ['--resume', id] : []), ...(model ? ['--model', model] : []),
  id ? `${hubPrompt(route)} If your session id (the folder above your scratchpad) isn't ${id}, rejoin with yours and --force.` : `/kickflip ${route} --hub\n${hubPrompt(route)}`,
];

// `repo` is the folder for a fresh session, or for a recorded session whose folder the manifest lacks.
export async function hubSession({ manifest = readManifest(), repo, run = runForegroundClaude, live = liveSessions } = {}) {
  const board = hubBoard(manifest);
  if (!board) throw new SessionError('No hub board is flagged; flag one with kickflip set <route> --hub, or join one with kickflip join hub-orchestrator --template board --hub --session <id>', 'hub');
  const owner = board.owner?.session ? board.owner : null;
  if (owner && !owner.repo && !repo) throw new SessionError(`/${board.route}'s session ${owner.session} has no folder recorded; pass --repo <its folder>`, 'none');
  refuseLive(owner, live);
  const cwd = owner?.repo || path.resolve(repo || process.cwd());
  if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
    throw new SessionError(owner?.repo ? `/${board.route}'s recorded folder ${cwd} is gone; rejoin from its new folder with --repo` : `no folder at ${cwd}`, 'none');
  }
  return run(hubArgv({ route: board.route, id: owner?.session, model: owner?.model }), { cwd });
}

// The session recorded for a route: its site's owner, else a start its join hasn't taken up. → owner + {title} | null
export function sessionOf(manifest, route) {
  const site = routeRecord(manifest?.sites, route);
  const owner = site?.owner?.session ? site.owner : routeRecord(manifest?.starting, route);
  return owner?.session ? { ...owner, title: site?.title || route } : null;
}

// `claude --bg` prints `backgrounded · <short id> · <name>`, the short id being the session id's first 8 characters,
// which a session's record carries as jobId. → {session, confirmed}: expected when the short id is its, else the
// session whose record names the short id, else expected unconfirmed (null for a start).
async function startedId(stdout, expected = null) {
  const short = stdout.match(/backgrounded\s*·\s*([0-9a-f]{8})\b/)?.[1] || stdout.match(/\bclaude attach ([0-9a-f]{8})\b/)?.[1];
  if (!short) return { session: expected, confirmed: false };
  if (expected?.startsWith(short)) return { session: expected, confirmed: true };
  for (let i = 0; i < 20; i++) {
    const r = sessionRecords().find((x) => x.jobId === short || x.sessionId.startsWith(short));
    if (r) return { session: r.sessionId, confirmed: true };
    await new Promise((res) => setTimeout(res, 500));
  }
  return { session: expected, confirmed: false };
}

// Whether `claude agents` lists the session as a background one, running or stopped.
async function isBackground(id, { run, cwd }) {
  const r = await run(['agents', '--json', '--all'], { cwd });
  try { return JSON.parse(r.stdout).some((s) => s?.sessionId === id && s.kind === 'background'); } catch { return false; }
}

function refuseLive(rec, live) {
  const l = rec && live().get(rec.session);
  if (l) throw new SessionError(`session ${rec.session} is live (${l.kind === 'bg' ? 'in the background' : 'in a terminal'}, pid ${l.pid}); it gets no second process`, 'live');
}

// Records `to` as the route's session in place of `from`, keeping the rest of its owner record (label, model, repo),
// and gives `to` from's watcher cursor wound back to mark (boards.mjs carryCursor). A route another session has
// taken meanwhile is left alone.
async function moveOwner(route, { from, to, mark }) {
  await withManifestLock(async () => {
    const m = readManifest();
    const board = listBoards(m).find((b) => b.route === route);
    if (board?.owner?.session === from && (mark || to !== from)) carryCursor(board, { from, to, mark });
    if (to === from) return;
    const site = routeRecord(m.sites, route);
    if (site?.owner?.session === from) Object.assign(site, { owner: { ...site.owner, session: to }, updated: new Date().toISOString() });
    else if (routeRecord(m.starting, route)?.session === from) m.starting[route] = { ...routeRecord(m.starting, route), session: to };
    else return;
    await writeManifest(m);
  });
}

// A new background session for the route, in repo (else the recorded session's folder, else the cwd), whose first
// prompt is `/kickflip <route>` plus prompt. Refuses while the route's recorded session is live. Writes nothing.
// → {route, session, confirmed, repo, model, name, argv, output}
export async function startSession(route, { manifest = readManifest(), repo, model, prompt, run = runClaude, live = liveSessions } = {}) {
  if (routeRecord(manifest.closed, route)) throw new SessionError(`/${route} is closed; use kickflip reopen ${route}`, 'none');
  const rec = sessionOf(manifest, route);
  refuseLive(rec, live);
  const dir = path.resolve(repo || rec?.repo || process.cwd());
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new SessionError(`no folder at ${dir}`, 'none');
  const name = routeRecord(manifest?.sites, route)?.title || routeRecord(manifest?.starting, route)?.title || route;
  const argv = startArgv({ route, name, model: model || rec?.model, prompt });
  const r = await run(argv, { cwd: dir });
  if (r.status !== 0) throw new SessionError(`claude --bg failed (${r.status}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`, 'failed');
  const { session, confirmed } = await startedId(r.stdout);
  if (!session) throw new SessionError(`claude --bg started a session but no session record names it yet; find it with claude agents (${r.stdout.trim().slice(0, 300)})`, 'failed');
  return { route, session, confirmed, repo: storedPath(dir), model: model || rec?.model || null, name, argv: [claudeBin(), ...argv], output: r.stdout.trim() };
}

// `claude --resume <id> --bg` for the route's recorded session, in its folder (resumeArgv), then records the id it
// comes back under as the route's owner (moveOwner), so the prompt and the manifest name the same id. mark winds the
// session's watcher cursor back to it. Refuses with no session or folder recorded, and while the session is live.
// → {route, session, previous, confirmed, repo, argv, output}
export function resumeSession(route, options = {}) {
  return withSessionLock(route, ({ resume }) => resume(options));
}

async function resumeRecordedSession(route, { manifest = readManifest(), run = runClaude, live = liveSessions, mark = null } = {}) {
  if (routeRecord(readManifest().closed, route)) throw new SessionError(`/${route} is closed; use kickflip reopen ${route}`, 'none');
  const rec = sessionOf(manifest, route);
  if (!rec) throw new SessionError(`/${route} has no recorded session`, 'none');
  if (!rec.repo) throw new SessionError(`/${route}'s session ${rec.session} has no folder recorded; its session records one by rejoining (kickflip join, --repo)`, 'none');
  refuseLive(rec, live);
  const background = await isBackground(rec.session, { run, cwd: rec.repo });
  const argv = resumeArgv({ id: rec.session, route, name: rec.title, model: rec.model, background });
  const r = await run(argv, { cwd: rec.repo });
  if (r.status !== 0) throw new SessionError(`claude --resume failed (${r.status}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`, 'failed');
  const { session, confirmed } = await startedId(r.stdout, rec.session);
  await moveOwner(route, { from: rec.session, to: session, mark });
  return { route, session, previous: rec.session, confirmed, repo: rec.repo, argv: [claudeBin(), ...argv], output: r.stdout.trim() };
}

// One board's next wake step. entry is its resume-state.json record {down_since, mark?, resumed_at?, error?,
// pushed_at?}, kept while the board isn't listening; mark is the watched line counts when its session was first seen
// not running. counts: the watched line counts now. waiting: an event its session hasn't heard (boards.mjs
// oldestUnheard). recorded: it has a session and folder to resume.
// → {action: 'none' | 'resume' | 'push', entry: the record to keep, null once it listens}
export function resumeStep(entry, { listening, live, recorded, counts, waiting, now }) {
  if (listening) return { action: 'none', entry: null };
  const at = new Date(now).toISOString();
  const e = entry ? { ...entry } : { down_since: at };
  if (live) delete e.mark;
  else if (!e.mark && counts) e.mark = counts;
  if (e.pushed_at) return { action: 'none', entry: e };
  if (e.resumed_at) {
    return e.error || now - Date.parse(e.resumed_at) >= COMEBACK_WAIT ? { action: 'push', entry: { ...e, pushed_at: at } } : { action: 'none', entry: e };
  }
  if (!recorded || live) return { action: 'none', entry: e };
  const landed = Boolean(entry?.mark && counts && Object.entries(counts).some(([f, n]) => n > (routeRecord(entry.mark, f) ?? 0)));
  if (landed || (waiting && now - Date.parse(e.down_since) >= RESUME_AFTER)) return { action: 'resume', entry: { ...e, resumed_at: at } };
  return { action: 'none', entry: e };
}

// The hub's wake over every board (resumeStep), keeping ~/.claude/kickflip/resume-state.json {<route>: entry}.
// → {resumed: [route], pushed: [route], failed: [message]}
export async function checkSessions({
  manifest = readManifest(), now = new Date(), live = liveSessions,
  listening = (board, running) => isListening(board, { now: now.getTime(), running }),
  resume = (route, mark) => resumeSession(route, { manifest, live, mark }), push = deliver,
} = {}) {
  const state = readJSON(RESUME_STATE, {});
  const running = live();
  const next = Object.create(null);
  const out = { resumed: [], pushed: [], failed: [] };
  for (const board of listBoards(manifest)) {
    const rec = sessionOf(manifest, board.route);
    const isLive = Boolean(rec && running.has(rec.session));
    const heard = listening(board, running);
    let { action, entry } = resumeStep(routeRecord(state, board.route), {
      listening: heard, live: isLive, recorded: Boolean(rec?.repo), now: now.getTime(),
      counts: heard ? null : watchedCounts(board), waiting: !heard && !isLive && oldestUnheard(board) !== null,
    });
    if (action === 'resume') {
      try { await resume(board.route, entry.mark); out.resumed.push(board.route); } catch (e) { entry = { ...entry, error: e.message }; out.failed.push(`${board.route}: could not resume its session (${e.message})`); }
    } else if (action === 'push') {
      const body = entry.error ? `The hub couldn't resume it: ${entry.error}`
        : isLive ? "Its session is running but hasn't relaunched its watcher."
          : `It still isn't listening after the hub resumed it. Try kickflip resume ${board.route}, or claude agents.`;
      try {
        await push({ title: `${board.title}'s session didn't come back`, body, url: `/${board.route}/`, tag: `resume-${board.route}` }, { kind: 'fault', immediate: true, at: now });
        out.pushed.push(board.route);
      } catch (e) { entry = { ...entry, pushed_at: undefined }; out.failed.push(`${board.route}: could not push that its session didn't come back (${e.message})`); }
    }
    if (entry) next[board.route] = entry;
  }
  if (JSON.stringify(next) !== JSON.stringify(state)) saveJSON(RESUME_STATE, next);
  return out;
}
