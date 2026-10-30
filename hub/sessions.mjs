// Board sessions the hub can start and bring back. The manifest records each site's session in its `owner`
// {session, label, since, repo, model?}: repo is the folder the session runs in, where `claude --resume` finds it. A
// session `web-ts start` launched for a route with no site yet waits in the manifest's `starting` {<route>: owner}
// until its join moves it into the site. Every session starts in the background (`claude --bg`) in auto mode, with
// worktree.bgIsolation "none" so it stays in the repo folder, since its builders make their own worktrees.
// checkSessions is the hub's auto-resume: a board not listening for RESUME_AFTER whose session isn't live is resumed
// once, and if it still isn't listening COMEBACK_WAIT later, the owner gets one push.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listBoards, readManifest, readJSON, saveJSON, watcherRunning } from './boards.mjs';
import { liveSessions, sessionRecords } from './live.mjs';
import { deliver } from './push.mjs';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESUME_STATE = path.join(os.homedir(), '.claude', 'web-ts', 'resume-state.json');
export const RESUME_AFTER = 3 * 60_000;
export const COMEBACK_WAIT = 5 * 60_000;
// "none" is the value that turns isolation off; Claude Code drops any other value and isolates.
export const BG_SETTINGS = JSON.stringify({ worktree: { bgIsolation: 'none' } });

export class SessionError extends Error {
  // reason: 'none' (no session or folder recorded), 'live' (the session runs), 'failed' (claude refused)
  constructor(message, reason) { super(message); this.reason = reason; }
}

// launchd gives the hub a PATH without ~/.local/bin, where the Claude Code installer puts claude.
export function claudeBin() {
  if (process.env.WEB_TS_CLAUDE) return process.env.WEB_TS_CLAUDE;
  const local = path.join(os.homedir(), '.local', 'bin', 'claude');
  return fs.existsSync(local) ? local : 'claude';
}

// A session's environment names its own session and parent; a claude started under it would take them as its own.
const inherited = (k) => k === 'CLAUDECODE' || k === 'CLAUDE_PID' || k === 'CLAUDE_EFFORT' || k.startsWith('CLAUDE_CODE_');

// Runs claude with argv in cwd. → {status, stdout, stderr}. A process `claude --bg` leaves behind can hold our pipes
// open, so this settles shortly after claude exits rather than on close, and drops the pipes so the caller can exit.
export function runClaude(argv, { cwd }) {
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
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} done(1); }, 60_000);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { stderr += e.message; done(1); });
    child.on('close', (code) => done(code ?? 1));
    child.on('exit', (code) => setTimeout(() => done(code ?? 1), 300));
    child.unref();
  });
}

const common = ({ name, model }) => ['--name', name, '--permission-mode', 'auto', '--settings', BG_SETTINGS, ...(model ? ['--model', model] : [])];
export const startArgv = ({ id, route, name, model, prompt }) => ['--bg', '--session-id', id, ...common({ name, model }), `/join-web-ts ${route}${prompt ? ` ${prompt}` : ''}`];
export const resumePrompt = (route, id) => `The hub resumed this session because /${route} stopped listening. Rejoin the board (join-web-ts steps 3 and 5): rerun \`node ${path.join(SKILL_DIR, 'bin', 'web-ts.mjs')} join ${route} --session ${id}\`, relaunch its watcher as a background task, then go on with what its events ask.`;
export const resumeArgv = ({ id, route, name, model }) => ['--resume', id, '--bg', ...common({ name, model }), resumePrompt(route, id)];

// The session recorded for a route: its site's owner, else a start its join hasn't taken up. → owner + {title} | null
export function sessionOf(manifest, route) {
  const site = manifest?.sites?.[route];
  const owner = site?.owner?.session ? site.owner : manifest?.starting?.[route];
  return owner?.session ? { ...owner, title: site?.title || route } : null;
}

// `claude --bg` prints the short id `claude attach` takes, the first 8 characters of the session id. When it names
// another session than the id asked for, that session's record gives the full id. → {session, confirmed}
async function startedId(stdout, id) {
  const shorts = [...new Set(stdout.match(/\b[0-9a-f]{8}\b/g) || [])];
  if (!shorts.length || shorts.includes(id.slice(0, 8))) return { session: id, confirmed: shorts.length > 0 };
  for (let i = 0; i < 20; i++) {
    const r = sessionRecords().find((x) => shorts.some((s) => x.jobId === s || x.sessionId.startsWith(s)));
    if (r) return { session: r.sessionId, confirmed: true };
    await new Promise((res) => setTimeout(res, 500));
  }
  return { session: id, confirmed: false };
}

function refuseLive(rec, live) {
  const l = rec && live().get(rec.session);
  if (l) throw new SessionError(`session ${rec.session} is live (${l.kind === 'bg' ? 'in the background' : 'in a terminal'}, pid ${l.pid}); it gets no second process`, 'live');
}

// A new background session for the route, in repo (else the recorded session's folder, else the cwd), whose first
// prompt is `/join-web-ts <route>` plus prompt. Refuses while the route's recorded session is live. Writes nothing.
// → {route, session, confirmed, repo, model, name, argv, output}
export async function startSession(route, { manifest = readManifest(), repo, model, prompt, run = runClaude, live = liveSessions } = {}) {
  const rec = sessionOf(manifest, route);
  refuseLive(rec, live);
  const dir = path.resolve(repo || rec?.repo || process.cwd());
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new SessionError(`no folder at ${dir}`, 'none');
  const id = crypto.randomUUID();
  const name = manifest?.sites?.[route]?.title || route;
  const argv = startArgv({ id, route, name, model: model || rec?.model, prompt });
  const r = await run(argv, { cwd: dir });
  if (r.status !== 0) throw new SessionError(`claude --bg failed (${r.status}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`, 'failed');
  const { session, confirmed } = await startedId(r.stdout, id);
  return { route, session, confirmed, repo: dir, model: model || rec?.model || null, name, argv: [claudeBin(), ...argv], output: r.stdout.trim() };
}

// `claude --resume <id> --bg` for the route's recorded session, in its folder. Refuses with no session or folder
// recorded, and while the session is live. → {route, session, repo, argv, output}
export async function resumeSession(route, { manifest = readManifest(), run = runClaude, live = liveSessions } = {}) {
  const rec = sessionOf(manifest, route);
  if (!rec) throw new SessionError(`/${route} has no recorded session`, 'none');
  if (!rec.repo) throw new SessionError(`/${route}'s session ${rec.session} has no folder recorded; its session records one by rejoining (web-ts join, --repo)`, 'none');
  refuseLive(rec, live);
  const argv = resumeArgv({ id: rec.session, route, name: rec.title, model: rec.model });
  const r = await run(argv, { cwd: rec.repo });
  if (r.status !== 0) throw new SessionError(`claude --resume failed (${r.status}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`, 'failed');
  return { route, session: rec.session, repo: rec.repo, argv: [claudeBin(), ...argv], output: r.stdout.trim() };
}

// One board's next auto-resume step. entry is its resume-state.json record {down_since, resumed_at?, error?,
// pushed_at?}, kept while the board isn't listening. recorded: it has a session and folder to resume.
// → {action: 'none' | 'resume' | 'push', entry: the record to keep, null once it listens}
export function resumeStep(entry, { listening, live, recorded, now }) {
  if (listening) return { action: 'none', entry: null };
  const at = new Date(now).toISOString();
  const e = entry ? { ...entry } : { down_since: at };
  if (e.pushed_at) return { action: 'none', entry: e };
  if (e.resumed_at) {
    return e.error || now - Date.parse(e.resumed_at) >= COMEBACK_WAIT ? { action: 'push', entry: { ...e, pushed_at: at } } : { action: 'none', entry: e };
  }
  if (!recorded || live || now - Date.parse(e.down_since) < RESUME_AFTER) return { action: 'none', entry: e };
  return { action: 'resume', entry: { ...e, resumed_at: at } };
}

// The hub's auto-resume over every board (resumeStep), keeping ~/.claude/web-ts/resume-state.json {<route>: entry}.
// → {resumed: [route], pushed: [route], failed: [message]}
export async function checkSessions({
  manifest = readManifest(), now = new Date(), live = liveSessions,
  listening = (board) => watcherRunning(board.dir, now.getTime()),
  resume = (route) => resumeSession(route, { manifest, live }), push = deliver,
} = {}) {
  const state = readJSON(RESUME_STATE, {});
  const running = live();
  const next = {};
  const out = { resumed: [], pushed: [], failed: [] };
  for (const board of listBoards(manifest)) {
    const rec = sessionOf(manifest, board.route);
    const isLive = Boolean(rec && running.has(rec.session));
    let { action, entry } = resumeStep(state[board.route], { listening: listening(board), live: isLive, recorded: Boolean(rec?.repo), now: now.getTime() });
    if (action === 'resume') {
      try { await resume(board.route); out.resumed.push(board.route); } catch (e) { entry = { ...entry, error: e.message }; out.failed.push(`${board.route}: could not resume its session (${e.message})`); }
    } else if (action === 'push') {
      const body = entry.error ? `The hub couldn't resume it: ${entry.error}`
        : isLive ? "Its session is running but hasn't relaunched its watcher."
          : `It still isn't listening after the hub resumed it. Try web-ts resume ${board.route}, or claude agents.`;
      try {
        await push({ title: `${board.title}'s session didn't come back`, body, url: `/${board.route}/`, tag: `resume-${board.route}` }, { immediate: true, at: now });
        out.pushed.push(board.route);
      } catch (e) { entry = { ...entry, pushed_at: undefined }; out.failed.push(`${board.route}: could not push that its session didn't come back (${e.message})`); }
    }
    if (entry) next[board.route] = entry;
  }
  if (JSON.stringify(next) !== JSON.stringify(state)) saveJSON(RESUME_STATE, next);
  return out;
}
