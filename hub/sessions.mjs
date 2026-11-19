// Board sessions the hub can start and wake. The manifest records each site's session in its `owner`
// {session, label, since, repo}: repo is the folder the session runs in, where `claude --resume` finds it. A
// session `kickflip start` launched for a route with no site yet waits in the manifest's `starting` {<route>: owner}
// until its join moves it into the site. A New board request (new-board.mjs) records {title, repo, asked_at} there
// first, then its board `site` once the clone is ready, which the hub serves until the join takes it over
// (docs/adr/2026-11-17-0254-a-new-board-opens-empty-while-its-orchestrator-starts.md), then the hub's start merges its owner in, or `error` when claude failed. Board sessions start in the background (`claude --bg`) in auto mode, with
// worktree.bgIsolation "none" so it stays in the repo folder, since its builders make their own worktrees, and with
// the hook that brings its prompts to the owner's phone. The hub board (`hub: true`) is the one exception: its session
// runs in the foreground inside a tmux session the hub starts, with the same flags and hook, and `kickflip hub`
// attaches to it (docs/adr/2026-11-03-0313-boards-run-in-the-background-and-the-hub-board-in-tmux.md).
// checkSessions is the hub's wake (docs/adr/2026-10-30-1601-a-boards-session-wakes-when-an-event-arrives.md): when an event lands
// for a board whose owner session isn't running, or the owner taps its page (`asked`), the session is resumed at once; a board not listening for
// RESUME_AFTER with an event its session hasn't heard is resumed as a fallback. A board whose session runs idle but
// hasn't listened for RESTART_AFTER is restarted, stopped and resumed, unless auto-restarts.mjs restartHeld holds it
// (docs/adr/2026-11-15-0123-the-hub-restarts-a-session-not-listening-and-a-server-not-answering.md). Any of these happens
// once per outage, and if the board still isn't listening COMEBACK_WAIT later, the owner gets one push. A listening
// board whose session sat idle past its prompt cache starts fresh (freshIdleSessions).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { joinName, routeRecord, validRoute } from './routes.mjs';
import { withFileLock } from './locks.mjs';
import { resumeStateFile, carryCursor, hubBoard, isListening, listBoards, listenState, oldestUnheard, readManifest, readJSON, saveJSON, watchedCounts, watchedLines, watcherCursor, withManifestLock, writeManifest } from './boards.mjs';
import { readUsageGate, heldUsageEvent } from '../shared/usage-gate.mjs';
import { liveSessions, sessionRecords, processStarts, verifiedProcess } from './live.mjs';
import { deliver } from './push.mjs';
import { readOrchestratorModel, setOrchestratorModel } from '../shared/hub-settings.mjs';
import { WAIT_MS, actionOf, pending, readPrompts, shown } from './prompts.mjs';
import { lastTurn as transcriptWrite, sessionActivity } from './session-activity.mjs';
import { nodeBin, storedPath } from '../bin/install.mjs';
import { reposDir } from '../shared/repos.mjs';
import { isClone } from './repos.mjs';
import { trustFolder } from './trust.mjs';
import { contextFull, contextReading } from './usage.mjs';
import { audit, boardAudit, hubAudit } from '../shared/audit.mjs';
import { logRestart, restartHeld } from './auto-restarts.mjs';

const SKILL_DIR = storedPath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
export const RESUME_AFTER = 3 * 60_000;
export const COMEBACK_WAIT = 5 * 60_000;
export const RESTART_AFTER = 2 * 60_000;
// Why a session restart happens, as auto-restarts.jsonl and the board's Hub row say it.
const NOT_LISTENING = 'not listening';
export const STARTING_WAIT = 15 * 60_000;
// A course (new-course.mjs) runs /teach's research before lesson 1 and its join, so it waits longer.
export const COURSE_WAIT = 45 * 60_000;
const compactStateFile = () => path.join(os.homedir(), '.claude', 'kickflip', 'compact-state.json');

// Whether a Starting record didn't start: its start recorded an error, or it hasn't joined STARTING_WAIT (a course
// COURSE_WAIT) after it was asked.
export const startFailed = (rec, now = Date.now()) => Boolean(rec.error) || now - Date.parse(rec.asked_at || rec.since) >= (rec.kind === 'course' ? COURSE_WAIT : STARTING_WAIT);

// A Starting record's step (docs/adr/2026-11-04-1914-a-new-board-shows-its-start-steps-and-clone-progress.md): cloning;
// starting, the orchestrator's session, from the clone's end until it joins; or landing, from its join until the board
// is listening (docs/adr/2026-11-04-2030-landing-it-lasts-until-the-board-listens.md).
// → {step, stepAt}, stepAt when the step began
function startStep(rec) {
  if (rec.joined_at) return { step: 'landing', stepAt: rec.joined_at };
  if (rec.phase === 'cloning') return { step: 'cloning', stepAt: rec.asked_at };
  return { step: 'starting', stepAt: rec.phase_at || rec.asked_at || rec.since };
}

// A starting session's signals (docs/adr/2026-11-16-2300-a-starting-board-shows-its-sessions-liveness-activity-and-prompt.md),
// read only while the record is starting orchestrator with its session known: running, liveSessions' Map (null when ps
// gave no answer); activity, its transcript's last step (session-activity.mjs); prompt, its oldest pending prompt
// (prompts.mjs). → {running, activity, prompt} | {}
export function startSignals(rec, { running, store = readPrompts(), home = os.homedir() }) {
  if (!rec.session || startStep(rec).step !== 'starting') return {};
  return { running, activity: sessionActivity(rec.repo, rec.session, { home }), prompt: pending(store).find((p) => p.session === rec.session) || null };
}

// How long a starting session's transcript may stay quiet, with no prompt waiting on the owner, before its row reads stalled.
export const STALL_AFTER = 3 * 60_000;

// A Starting record's state from its signals (startSignals): failed when startFailed says or its session has ended;
// else, while starting orchestrator, its last activity, the prompt it waits on, or stalled once quiet for STALL_AFTER
// since its last activity or its session's start, whichever is later.
// → {failed, error?, ended?, activity?, prompt?, stalled?, quietSince?}
export function startHealth(rec, { running, activity, prompt } = {}, now = Date.now()) {
  if (startFailed(rec, now)) return { failed: true, ...(rec.error ? { error: rec.error } : {}) };
  if (running && rec.session && !running.has(rec.session) && startStep(rec).step === 'starting') {
    return { failed: true, ended: true, error: `Its session ended before it joined the hub${activity ? `; its last step was ${activity.text}` : ''}.` };
  }
  if (prompt) return { failed: false, ...(activity ? { activity: activity.text } : {}), prompt: shown(prompt) };
  if (!activity) return { failed: false };
  const quietSince = Math.max(activity.at, Date.parse(rec.since || rec.phase_at || rec.asked_at));
  return { failed: false, activity: activity.text, ...(now - quietSince >= STALL_AFTER ? { stalled: true, quietSince: new Date(quietSince).toISOString() } : {}) };
}

// The sidebar's Starting rows. clonePercent(route) is a running clone's percent (new-board.mjs), which a cloning row
// carries. listening(route) is whether a joined board hears its events: its row stays until then, and a late one reads
// why it failed. signals(rec) is a record's startSignals. A record whose route has joined shows only while landing. A
// served one's board opens at its route while it starts (new-board.mjs serveStart). A course's row (course: true) goes
// once its page joins, since a page has nothing to listen with.
export function startingBoards(manifest, now = Date.now(), clonePercent = () => undefined, listening = () => true, signals = () => ({})) {
  const shows = (route, rec) => !routeRecord(manifest.sites, route) || (rec.kind !== 'course' && rec.joined_at && !listening(route));
  return Object.entries(manifest.starting || {}).filter(([route, rec]) => shows(route, rec)).map(([route, rec]) => {
    const { failed, error, ...health } = startHealth(rec, signals(rec), now);
    return {
      route, title: rec.title || rec.label || route, repo: rec.repo, ...startStep(rec), ...(rec.kind === 'course' ? { course: true } : {}),
      ...(rec.phase === 'cloning' && clonePercent(route) !== undefined ? { percent: clonePercent(route) } : {}),
      ...(rec.branch ? { branch: rec.branch, tickets: rec.tickets } : {}),
      askedAt: rec.asked_at || rec.since, failed, ...(rec.joined_at ? { joined: true } : {}), ...(rec.site ? { served: true } : {}),
      ...(error ? { error } : failed && rec.joined_at ? { error: 'Its session joined, but the board is not listening yet.' } : {}),
      ...health,
    };
  });
}

// Each prompt a starting session raises goes in the hub's audit log with its tool and input, so the start's
// BG_SETTINGS can allow it up front next time. input: the PermissionRequest hook's. → the route logged, or null for a
// session that isn't a start's.
export function logStartPrompt(input, { manifest = readManifest(), now = new Date() } = {}) {
  const [route] = Object.entries(manifest.starting || {}).find(([, rec]) => rec.session && rec.session === input.session_id && !rec.joined_at) || [];
  if (!route) return null;
  const asked = input.tool_name === 'AskUserQuestion' ? `asked: ${input.tool_input?.questions?.[0]?.question || 'a question'}` : `asked to ${actionOf(input.tool_name, input.tool_input)}`;
  audit(hubAudit(), { call: 'start-prompt', result: 'asked', reason: `/${route}'s starting session ${asked}.`, inputs: { route, session: input.session_id, tool: input.tool_name, input: input.tool_input } }, { now });
  return route;
}
// "none" is the value that turns isolation off; Claude Code drops any other value and isolates. The PermissionRequest
// hook sends the session's prompts to the phone, and its timeout stays a minute past the hook's own wait
// (docs/adr/2026-10-30-1516-background-sessions-prompts-come-to-the-phone.md). Every session the hub starts or resumes gets them,
// the hub board's foreground one in tmux included. The PermissionDenied hook tells the hub when auto mode refused a
// command, which notes it under the board setting that allows it (board/permissions.mjs). The deny rule refuses the
// Workflow tool at once, since its opt-in prompt waits at a terminal nobody watches
// (docs/adr/2026-11-04-0036-a-board-session-never-stalls-on-a-workflow-prompt.md). The allow rule lets a session run
// `kickflip doctor`, which only reads, without a prompt, since a starting session that checks a failed step with it
// would otherwise stall on one (docs/adr/2026-11-16-2300-a-starting-board-shows-its-sessions-liveness-activity-and-prompt.md);
// `--fix` still asks. The Stop hook keeps a board's session from ending a turn while its board has no watcher
// (hooks-plugin/hooks/watcher-stop.mjs); it comes with every session the hub launches, so the guard holds whatever the
// host's settings.json carries (docs/adr/2026-11-19-1310-the-hub-gives-every-board-session-the-watcher-stop-hook.md).
// The hub service's PATH may have no
// node, hence a full path.
export const PROMPT_HOOK_TIMEOUT_S = WAIT_MS / 1000 + 60;
export const BG_SETTINGS = JSON.stringify({
  worktree: { bgIsolation: 'none' },
  permissions: { allow: ['Bash(kickflip doctor)'], deny: ['Workflow'] },
  hooks: {
    PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: `"${nodeBin()}" "${path.join(SKILL_DIR, 'hub', 'permission-hook.mjs')}"`, timeout: PROMPT_HOOK_TIMEOUT_S }] }],
    PermissionDenied: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `"${nodeBin()}" "${path.join(SKILL_DIR, 'hub', 'permission-denied-hook.mjs')}"`, timeout: 15 }] }],
    Stop: [{ hooks: [{ type: 'command', command: `"${nodeBin()}" "${path.join(SKILL_DIR, 'hooks-plugin', 'hooks', 'watcher-stop.mjs')}"` }] }],
  },
});

export class SessionError extends Error {
  // reason: 'none' (no session or folder recorded), 'hub' (no hub board), 'live' (the session runs), 'unknown' (ps gave
  // no answer, so whether the session runs is unknown), 'failed' (claude or tmux refused)
  constructor(message, reason) { super(message); this.reason = reason; }
}

export function withSessionLock(route, fn) {
  if (!validRoute(route)) throw new SessionError('Choose a board route.', 'none');
  return withFileLock(path.join(os.homedir(), '.claude', 'kickflip', 'session-locks', route),
    () => fn({ resume: (options) => resumeRecordedSession(route, options) }), { staleAfter: 120_000, timeout: 90_000 });
}

// The hub's service gives it a PATH without ~/.local/bin, where the Claude Code installer puts claude.
export function claudeBin() {
  if (process.env.KICKFLIP_CLAUDE) return process.env.KICKFLIP_CLAUDE;
  const local = path.join(os.homedir(), '.local', 'bin', 'claude');
  return fs.existsSync(local) ? local : 'claude';
}

// A session's environment names its own session and parent; a claude started under it would take them as its own.
export const inherited = (k) => k === 'CLAUDECODE' || k === 'CLAUDE_PID' || k === 'CLAUDE_EFFORT' || k.startsWith('CLAUDE_CODE_');

// tmux, for the hub board's foreground session. The hub service's PATH may lack Homebrew's or the system's bin.
export function tmuxBin() {
  if (process.env.KICKFLIP_TMUX) return process.env.KICKFLIP_TMUX;
  return ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find((p) => fs.existsSync(p)) || 'tmux';
}
// Runs one tmux command, which returns at once (new-session -d detaches). → {status, stdout, stderr}
export function runTmux(argv) {
  const r = spawnSync(tmuxBin(), argv, { encoding: 'utf8', timeout: 10_000, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !inherited(k))) });
  if (r.error?.code === 'ENOENT') return { status: 127, stdout: '', stderr: "tmux isn't installed; kickflip doctor names how to install it" };
  return { status: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || r.error?.message || '' };
}
// The tmux session a hub board's session runs in.
export const tmuxName = (route) => `kickflip-${route}`;
const hasTmux = (tmux, route) => tmux(['has-session', '-t', `=${tmuxName(route)}`]).status === 0;
// docs/adr/2026-11-17-1500-the-board-menu-shows-how-to-join-the-orchestrator-in-a-terminal.md
// The command that opens a board's orchestrator session in a terminal, live: the hub board's tmux session, else
// `claude attach` with the background session's short id, its session id's first 8 characters. tmux says which, for
// how to leave it running. → {command, tmux}, null while the board has no session recorded.
export function joinOf(board) {
  const session = board.owner?.session;
  if (!session) return null;
  return board.hub ? { command: `tmux attach -t ${tmuxName(board.route)}`, tmux: true } : { command: `claude attach ${session.slice(0, 8)}`, tmux: false };
}

// After a hub board's session was stopped, waits for its tmux session to be gone, polling has-session up to `limit`
// times, `sleep` ms apart, and kills one still there, so the resume that follows doesn't refuse it as live. A board
// that doesn't run in tmux has nothing to wait for.
export async function closeTmux(route, { manifest = readManifest(), tmux = runTmux, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), limit = 20 } = {}) {
  if (routeRecord(manifest.sites, route)?.hub !== true) return;
  for (let polls = 0; hasTmux(tmux, route); polls++) {
    if (polls >= limit) {
      tmux(['kill-session', '-t', `=${tmuxName(route)}`]);
      return;
    }
    await sleep(500);
  }
}

// The hub board's session, when its context is full (usage.mjs contextFull) and it runs in its tmux session, gets /compact
// typed into its pane, once per fill: compact-state.json {<route>: {session, percent, at, error?}} records the attempt
// and is cleared once the board's context is no longer full, so a session that fills again is compacted again. A
// background session has no pane to type into; the sidebar reads context full for it
// (docs/adr/2026-11-03-1823-a-board-session-compacts-before-its-context-fills.md). The hub runs it after each session check.
// → {compacted: [route], failed: [message]}
export async function compactFullContexts({ manifest = readManifest(), now = new Date(), running = liveSessions(), wakes = readJSON(resumeStateFile(), {}), tmux = runTmux } = {}) {
  // With ps giving no answer, no board's listen state is known, so the check waits for the next.
  if (!running) return { compacted: [], failed: [] };
  const state = Object.assign(Object.create(null), readJSON(compactStateFile(), {}));
  const compacted = [];
  const failed = [];
  let dirty = false;
  const hub = hubBoard(manifest)?.route;
  for (const board of listBoards(manifest)) {
    const reading = contextReading(board.owner?.session);
    if (!contextFull(listenState(board, { now: now.getTime(), running, wakes }), reading)) {
      if (routeRecord(state, board.route)) { delete state[board.route]; dirty = true; }
      continue;
    }
    if (board.route !== hub || routeRecord(state, board.route) || !hasTmux(tmux, board.route)) continue;
    const target = `=${tmuxName(board.route)}:`;
    const typed = tmux(['send-keys', '-t', target, '-l', '/compact']);
    const sent = typed.status === 0 ? tmux(['send-keys', '-t', target, 'Enter']) : typed;
    const error = sent.status === 0 ? null : (sent.stderr || sent.stdout).trim().slice(0, 300) || `tmux exited ${sent.status}`;
    state[board.route] = { session: board.owner.session, percent: reading.percent, at: now.toISOString(), ...(error ? { error } : {}) };
    audit(boardAudit(board.dir), { call: 'compact', result: error ? 'failed' : 'typed /compact', reason: `Its session's context is ${reading.percent}% full and it isn't listening.${error ? ` ${error}` : ''}`, inputs: { session: board.owner.session, context: reading } }, { now });
    dirty = true;
    if (error) failed.push(`${board.route}: could not send /compact to tmux session ${tmuxName(board.route)} (${error})`);
    else compacted.push(board.route);
  }
  if (dirty) saveJSON(compactStateFile(), state);
  return { compacted, failed };
}

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
  const running = live();
  if (!running) throw new SessionError(unknownLiveness(owner.session), 'unknown');
  const record = running.get(owner.session);
  if (!record) return;
  await stop(record, { cwd: owner.repo || record.cwd || os.homedir() });
  const deadline = Date.now() + 5000;
  // A check ps gives no answer for leaves the session running, so the wait goes on to the next.
  for (let running = live(); !running || running.get(owner.session)?.pid === record.pid; running = live()) {
    if (Date.now() >= deadline) throw new SessionError(`session ${owner.session} did not stop`, 'failed');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// Attaches this terminal to the route's tmux session, or switches to it from inside tmux, until the owner detaches.
// → {status}
export function attachTmux(route) {
  const target = `=${tmuxName(route)}`;
  return runForeground(tmuxBin(), process.env.TMUX ? ['switch-client', '-t', target] : ['attach-session', '-t', target]);
}

function runForeground(bin, argv) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !inherited(k) && k !== 'CLAUDE_BG_ISOLATION'));
  // A terminal's Ctrl-C or Ctrl-\ signals both processes; this one has to outlive tmux to hand back its exit code.
  const ignore = () => {};
  process.on('SIGINT', ignore).on('SIGQUIT', ignore);
  const settle = () => process.off('SIGINT', ignore).off('SIGQUIT', ignore);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, argv, { env, stdio: 'inherit' });
    child.on('error', (e) => { settle(); reject(new SessionError(e.message, 'failed')); });
    child.on('close', (code) => { settle(); resolve({ status: code ?? 1 }); });
  });
}

// Every board's orchestrator runs on Hub settings' Orchestrators (push.mjs readOrchestratorModel), read at each start
// (docs/adr/2026-11-18-0800-models-and-land-tests-are-hub-settings-only.md).
const common = ({ name }) => ['--name', name, '--permission-mode', 'auto', '--settings', BG_SETTINGS, '--model', readOrchestratorModel()];
// The session passes the board name to kickflip board through its shell, so the name stays one quoted word.
const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
// The skill's board entry point, which starts and resumes every board's session alike
// (docs/adr/2026-11-15-0014-kickflip-is-handoff-page-and-board.md).
const boardLine = (route, title) => `/kickflip board ${quote(joinName(route, title))}`;
const notYours = (id) => `If your session id (the folder above your scratchpad) isn't ${id}, rejoin with yours and --force.`;
// first, when given, is the whole first prompt in place of the board line and prompt (a course's /teach, new-course.mjs).
export const startArgv = ({ route, name, prompt, first }) => ['--bg', ...common({ name }), first || `${boardLine(route, name)}${prompt ? ` ${prompt}` : ''}`];
export const resumePrompt = (route, id, title) => `${boardLine(route, title)}\nThe hub resumed this session because /${route} had nobody listening. Rejoin the board as session ${id} and relaunch its watcher as a background task, then go on with what its events ask. ${notYours(id)}`;
// A background session resumed with any flag starts as a copy under a new id, so one goes without them and keeps the
// options it started with; a session that never ran in the background gets them (Claude Code's `note:` line says which).
// prompt, when given, is the whole resume prompt in place of the board's (a course's next lesson, new-course.mjs).
export const resumeArgv = ({ id, route, name, background, prompt }) => ['--resume', id, '--bg', ...(background ? [] : common({ name })), prompt || resumePrompt(route, id, name)];

const HUB_PROMPT = `You are the hub session: read \`${path.join(SKILL_DIR, 'docs', 'hub-session.md')}\`.`;
// The hub board's session in the foreground: the recorded one resumed; with fresh, a new one under id, which the
// manifest already names as the owner (freshHubSession); else a new one that joins with --hub.
export const hubArgv = ({ route, title, id, fresh = false }) => {
  if (fresh) return ['--session-id', id, ...common({ name: title }), `${boardLine(route, title)}\n${HUB_PROMPT}`];
  return [
    ...(id ? ['--resume', id] : []), ...common({ name: title }),
    id ? `${boardLine(route, title)}\n${HUB_PROMPT} ${notYours(id)}` : `${boardLine(route, title)} --hub\n${HUB_PROMPT}`,
  ];
};

// Starts the hub board's session in a detached tmux session named tmuxName(route), in cwd. env drops the caller's
// session variables, since tmux passes its own environment on. → the claude argv
function startTmux(route, argv, { cwd, tmux }) {
  const bin = claudeBin();
  const unset = [...new Set(['CLAUDECODE', 'CLAUDE_BG_ISOLATION', ...Object.keys(process.env).filter(inherited)])].flatMap((k) => ['-u', k]);
  const r = tmux(['new-session', '-d', '-s', tmuxName(route), '-c', cwd, '/usr/bin/env', ...unset,
    ...(path.isAbsolute(bin) ? [`PATH=${path.dirname(bin)}:${process.env.PATH || ''}`] : []), bin, ...argv]);
  if (r.status !== 0) throw new SessionError(`tmux new-session failed (${r.status}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`, 'failed');
  return [bin, ...argv];
}

// `kickflip hub`: attaches this terminal to the hub board's tmux session, first starting it when none runs: the
// recorded session resumed in its folder, else a fresh one in repo (default the cwd) that joins with --hub.
// While the tmux session runs, nothing else starts. Refuses a recorded session live outside tmux, and a missing folder.
// `repo` is the folder for a fresh session, or for a recorded session whose folder the manifest lacks. → attach's {status}
export async function hubSession({ manifest = readManifest(), repo, tmux = runTmux, attach = attachTmux, live = liveSessions } = {}) {
  const board = hubBoard(manifest);
  if (!board) throw new SessionError('No hub board is flagged; flag one with kickflip set <route> --hub, or run kickflip join --hub in its repo folder', 'hub');
  if (!hasTmux(tmux, board.route)) {
    const owner = board.owner?.session ? board.owner : null;
    if (owner && !owner.repo && !repo) throw new SessionError(`/${board.route}'s session ${owner.session} has no folder recorded; pass --repo <its folder>`, 'none');
    refuseLive(owner, live);
    const cwd = owner?.repo || path.resolve(repo || process.cwd());
    if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
      throw new SessionError(owner?.repo ? `/${board.route}'s recorded folder ${cwd} is gone; rejoin from its new folder with --repo` : `no folder at ${cwd}`, 'none');
    }
    startTmux(board.route, hubArgv({ route: board.route, title: board.title, id: owner?.session }), { cwd, tmux });
  }
  return attach(board.route);
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

const unknownLiveness = (session) => `Couldn't tell whether session ${session} is live: ps gave no answer in time, as happens on a busy host. Try again in a moment.`;

// Refuses while rec's session is live, and while ps can't say whether it is, since a second process can't be undone.
function refuseLive(rec, live) {
  if (!rec) return;
  const running = live();
  if (!running) throw new SessionError(unknownLiveness(rec.session), 'unknown');
  const l = running.get(rec.session);
  if (l) throw new SessionError(`session ${rec.session} is live (${l.kind === 'bg' ? 'in the background' : 'in a terminal'}, pid ${l.pid}); it gets no second process`, 'live');
}

// Records `to` as the route's session in place of `from`, keeping the rest of its owner record (label, repo),
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
// prompt is `/kickflip board '<board name>'` plus prompt, or first in full. Refuses while the route's recorded session is live. Writes nothing to the
// manifest. A folder that is a clone under clones (repos.mjs isClone), or any folder with trust (a folder the owner picked in New), is first marked trusted for Claude Code (trust.mjs).
// → {route, session, confirmed, repo, name, argv, output}
export async function startSession(route, { manifest = readManifest(), repo, prompt, first, run = runClaude, live = liveSessions, clones = reposDir(), trust = false } = {}) {
  if (routeRecord(manifest.closed, route)) throw new SessionError(`/${route} is closed; use kickflip reopen ${route}`, 'none');
  const rec = sessionOf(manifest, route);
  refuseLive(rec, live);
  const dir = path.resolve(repo || rec?.repo || process.cwd());
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new SessionError(`no folder at ${dir}`, 'none');
  if (trust || isClone(dir, clones)) {
    try { trustFolder(dir); } catch (e) { throw new SessionError(`Couldn't trust this folder for Claude Code: ${e.message}`, 'failed'); }
  }
  const name = routeRecord(manifest?.sites, route)?.title || routeRecord(manifest?.starting, route)?.title || route;
  const argv = startArgv({ route, name, prompt, first });
  const r = await run(argv, { cwd: dir });
  if (r.status !== 0) {
    const output = (r.stderr || '').trim() || (r.stdout || '').trim();
    throw new SessionError(output ? `claude --bg failed (${r.status}): ${output.slice(0, 300)}` : `claude exited ${r.status} with no output; check \`claude agents\``, 'failed');
  }
  const { session, confirmed } = await startedId(r.stdout);
  if (!session) throw new SessionError(`claude --bg started a session but no session record names it yet; find it with claude agents (${r.stdout.trim().slice(0, 300)})`, 'failed');
  return { route, session, confirmed, repo: storedPath(dir), name, argv: [claudeBin(), ...argv], output: r.stdout.trim() };
}

// Under the route's session lock: stops its recorded session and starts a fresh one in its folder (startSession), which
// rejoins the board, then records it as the route's owner in place of the old one with the old one's watcher cursor
// (moveOwner). → {route, session, previous}
export function freshSession(route, { live = liveSessions, stop = runSessionStop, run = runClaude } = {}) {
  return withSessionLock(route, async () => {
    const manifest = readManifest();
    const rec = sessionOf(manifest, route);
    if (!rec?.repo) throw new SessionError(`/${route} has no session and folder recorded`, 'none');
    await stopSession(rec, { live, stop });
    const r = await startSession(route, { manifest, run, live });
    await moveOwner(route, { from: rec.session, to: r.session });
    return { route, session: r.session, previous: rec.session };
  });
}

// The hub board's freshSession, under the route's session lock: stops its recorded session, waits for its tmux session
// to close (closeTmux), records id as the owner with the old session's watcher cursor (moveOwner), then starts a new
// session under id in tmux (hubArgv fresh), which joins as the owner it already is. A tmux start that fails moves the
// owner back. → {route, session, previous}
export function freshHubSession(route, { live = liveSessions, stop = runSessionStop, tmux = runTmux, sleep, limit, id = randomUUID() } = {}) {
  return withSessionLock(route, async () => {
    const manifest = readManifest();
    const rec = sessionOf(manifest, route);
    if (!rec?.repo) throw new SessionError(`/${route} has no session and folder recorded`, 'none');
    await stopSession(rec, { live, stop });
    await closeTmux(route, { manifest, tmux, sleep, limit });
    await moveOwner(route, { from: rec.session, to: id });
    try {
      startTmux(route, hubArgv({ route, title: rec.title, id, fresh: true }), { cwd: rec.repo, tmux });
    } catch (e) {
      await moveOwner(route, { from: id, to: rec.session });
      throw e;
    }
    return { route, session: id, previous: rec.session };
  });
}

// Hub settings' Orchestrators: saves the hub's choice, which every board's session takes at its next start. The hub
// board's session, idle in its tmux pane, takes it at once: it gets `/model <model>` typed into it, as the hub types
// /compact (compactFullContexts). → {model, applies: 'now', 'next start' while that session is busy or not running, or
// null with no hub board}
export async function changeOrchestratorModel(value, { manifest = readManifest(), live = liveSessions, tmux = runTmux } = {}) {
  const model = await setOrchestratorModel(value);
  const board = hubBoard(manifest);
  if (!board) return { model, applies: null };
  if (live()?.get(board.owner?.session)?.status !== 'idle') return { model, applies: 'next start' };
  const target = `=${tmuxName(board.route)}:`;
  const typed = tmux(['send-keys', '-t', target, '-l', `/model ${model}`]);
  return { model, applies: typed.status === 0 && tmux(['send-keys', '-t', target, 'Enter']).status === 0 ? 'now' : 'next start' };
}

// docs/adr/2026-11-17-2330-an-idle-orchestrator-restarts-fresh-once-its-prompt-cache-lapses.md
// The prompt cache's lifetime: a session idle past it re-reads its whole context uncached on its next wake.
export const CACHE_TTL = 60 * 60_000;
// How long a wait may go unpicked and still be the new session's to pick up.
const PICKUP_GRACE = 60_000;
// How long after a fresh start a session's turns count as its join and brief, not as work of its own.
const JOIN_WINDOW = 15 * 60_000;
export const freshStateFile = () => path.join(os.homedir(), '.claude', 'kickflip', 'fresh-state.json');
// Whether the hub started session fresh for route (fresh-state.json), so its join prints the board brief.
export const freshFor = (route, session) => routeRecord(readJSON(freshStateFile(), {}), route)?.session === session;

// What holds a fresh start among the board's open waits (data/orchestrator-waits.json): a builder's hand-back waiting
// on verify at any age, any wait picked up and not finished, and one unpicked past PICKUP_GRACE. A limbo wait is the
// orchestrator's backlog, which never wakes it, so it holds nothing.
const holdsFresh = (w, now) => w.kind !== 'limbo' && (w.kind === 'calls' || Boolean(w.picked) || now - Date.parse(w.since) > PICKUP_GRACE);

// Whether a board's orchestrator starts fresh now: it is listening (a board that isn't goes through the resume path),
// its session isn't busy, its last turn (its transcript's last write, ms) is past CACHE_TTL, and no open wait holds it
// (holdsFresh). entry is its fresh-state.json record {session, at}: the session it names, the one a fresh start made
// or the one a failed start left, is skipped until it takes a turn past JOIN_WINDOW after at, so each lapse gets one.
// → the minutes it has been idle when due, else null
export function freshStartDue({ listening, busy, lastTurn, waits, entry, session, now }) {
  if (!listening || busy || lastTurn == null || now - lastTurn <= CACHE_TTL) return null;
  if (entry?.session === session && lastTurn < Date.parse(entry.at) + JOIN_WINDOW) return null;
  if (waits.some((w) => holdsFresh(w, now))) return null;
  return Math.round((now - lastTurn) / 60_000);
}

// The hub's fresh starts over every board (freshStartDue), after each session check, keeping fresh-state.json
// {<route>: {session, at, error?}}, whose entry clears once the board's session is another. fresh(board) starts it
// (freshHubSession for the hub board, freshSession for one in the background); each start and failure goes in the
// board's audit log. A start that couldn't tell whether the session runs is tried on the next check.
// → {started: [route], failed: [message]}
export async function freshIdleSessions({
  manifest = readManifest(), now = new Date(), running = liveSessions(),
  listening = (board) => isListening(board, { now: now.getTime(), running }),
  lastTurn = (board) => transcriptWrite(board.owner.repo, board.owner.session),
  waitsOf = (board) => readJSON(path.join(board.dir, 'data', 'orchestrator-waits.json'), {}).waits || [],
  paused = (board) => readUsageGate({ now, dir: board.dir }).state === 'paused',
  fresh = (board) => (board.hub ? freshHubSession(board.route) : freshSession(board.route)),
} = {}) {
  // With ps giving no answer, no board's listen state is known, so the check waits for the next.
  if (!running) return { started: [], failed: [] };
  const state = Object.assign(Object.create(null), readJSON(freshStateFile(), {}));
  const out = { started: [], failed: [] };
  let dirty = false;
  for (const board of listBoards(manifest)) {
    const session = board.owner?.session;
    let entry = routeRecord(state, board.route);
    if (entry && entry.session !== session) { delete state[board.route]; entry = null; dirty = true; }
    if (!session || !board.owner.repo) continue;
    // The transcript's time first: a session inside its cache asks nothing more of ps or the board's files.
    const turn = lastTurn(board);
    if (turn == null || now.getTime() - turn <= CACHE_TTL || paused(board)) continue;
    const idle =freshStartDue({ listening: listening(board), busy: running.get(session)?.status === 'busy', lastTurn: turn, waits: waitsOf(board), entry, session, now: now.getTime() });
    if (idle === null) continue;
    const reason = `Idle ${idle} minutes, its prompt cache lapsed.`;
    const inputs = { session, lastTurn: new Date(turn).toISOString() };
    try {
      const r = await fresh(board);
      state[board.route] = { session: r.session, at: now.toISOString() };
      audit(boardAudit(board.dir), { call: 'fresh', result: 'started fresh', reason, inputs: { ...inputs, fresh: r.session } }, { now });
      out.started.push(board.route);
    } catch (e) {
      if (e.reason !== 'unknown') state[board.route] = { session, at: now.toISOString(), error: e.message };
      audit(boardAudit(board.dir), { call: 'fresh', result: 'failed', reason: `${reason} ${e.message}`, inputs }, { now });
      out.failed.push(`${board.route}: could not start its session fresh (${e.message})`);
    }
    dirty = true;
  }
  if (dirty) saveJSON(freshStateFile(), state);
  return out;
}

// `claude --resume <id> --bg` for the route's recorded session, in its folder (resumeArgv), then records the id it
// comes back under as the route's owner (moveOwner), so the prompt and the manifest name the same id. mark winds the
// session's watcher cursor back to it, and prompt replaces the resume prompt. Refuses with no session or folder recorded, and while the session is live.
// → {route, session, previous, confirmed, repo, argv, output}
export function resumeSession(route, options = {}) {
  return withSessionLock(route, ({ resume }) => resume(options));
}

// Under the route's session lock: stops its recorded session, waits for its tmux session to close (closeTmux), then resumes it (resumeRecordedSession), whose first turn
// relaunches its watcher. → resume's answer
export function restartSession(route, { manifest = readManifest(), live = liveSessions, stop = runSessionStop, run = runClaude, tmux = runTmux, sleep, limit } = {}) {
  return withSessionLock(route, async ({ resume }) => {
    await stopSession(sessionOf(manifest, route), { live, stop });
    await closeTmux(route, { manifest, tmux, sleep, limit });
    return resume({ manifest, live, run, tmux });
  });
}

async function resumeRecordedSession(route, { manifest = readManifest(), run = runClaude, tmux = runTmux, live = liveSessions, mark = null, prompt } = {}) {
  if (routeRecord(readManifest().closed, route)) throw new SessionError(`/${route} is closed; use kickflip reopen ${route}`, 'none');
  const rec = sessionOf(manifest, route);
  if (!rec) throw new SessionError(`/${route} has no recorded session`, 'none');
  if (!rec.repo) throw new SessionError(`/${route}'s session ${rec.session} has no folder recorded; its session records one by rejoining (kickflip join, --repo)`, 'none');
  refuseLive(rec, live);
  // The hub board comes back in the foreground, in its tmux session; a foreground resume keeps the session's id.
  if (routeRecord(manifest.sites, route)?.hub === true) {
    if (hasTmux(tmux, route)) throw new SessionError(`/${route}'s tmux session ${tmuxName(route)} is still open; attach with kickflip hub`, 'live');
    const argv = startTmux(route, hubArgv({ route, title: rec.title, id: rec.session }), { cwd: rec.repo, tmux });
    await moveOwner(route, { from: rec.session, to: rec.session, mark });
    return { route, session: rec.session, previous: rec.session, confirmed: false, repo: rec.repo, argv, output: `in tmux session ${tmuxName(route)}` };
  }
  const background = await isBackground(rec.session, { run, cwd: rec.repo });
  const argv = resumeArgv({ id: rec.session, route, name: rec.title, background, prompt });
  const r = await run(argv, { cwd: rec.repo });
  if (r.status !== 0) throw new SessionError(`claude --resume failed (${r.status}): ${(r.stderr || r.stdout).trim().slice(0, 300)}`, 'failed');
  const { session, confirmed } = await startedId(r.stdout, rec.session);
  await moveOwner(route, { from: rec.session, to: session, mark });
  return { route, session, previous: rec.session, confirmed, repo: rec.repo, argv: [claudeBin(), ...argv], output: r.stdout.trim() };
}

// One board's next wake step. entry is its resume-state.json record {down_since, mark?, deaf_since?, resumed_at?,
// restarted?, error?, pushed_at?}, kept while the board isn't listening; mark is the watched line counts when its
// session was first seen not running, deaf_since when it was first seen running and not listening, and restarted marks
// a wake that was a restart. counts: the watched line counts now. waiting: an event its session hasn't heard
// (boards.mjs oldestUnheard). recorded: it has a session and folder to resume. asked: the owner tapped the board's page
// (hub.mjs /_hub/wake), which wakes it at once like an event landing. idle: its running session's record says idle.
// held(): whether something holds a restart (auto-restarts.mjs restartHeld), asked only once one is due.
// → {action: 'none' | 'resume' | 'restart' | 'push', entry: the record to keep, null once it listens}
export async function resumeStep(entry, { listening, live, recorded, counts, waiting, asked = false, idle = false, held = async () => false, now }) {
  if (listening) return { action: 'none', entry: null };
  const at = new Date(now).toISOString();
  const e = entry ? { ...entry } : { down_since: at };
  if (live) {
    delete e.mark;
    e.deaf_since ??= at;
  } else {
    delete e.deaf_since;
    if (!e.mark && counts) e.mark = counts;
  }
  if (e.pushed_at) return { action: 'none', entry: e };
  if (e.resumed_at) {
    return e.error || now - Date.parse(e.resumed_at) >= COMEBACK_WAIT ? { action: 'push', entry: { ...e, pushed_at: at } } : { action: 'none', entry: e };
  }
  if (!recorded) return { action: 'none', entry: e };
  if (live) {
    if (!idle || now - Date.parse(e.deaf_since) < RESTART_AFTER || await held()) return { action: 'none', entry: e };
    return { action: 'restart', entry: { ...e, resumed_at: at, restarted: true } };
  }
  const landed = Boolean(entry?.mark && counts && Object.entries(counts).some(([f, n]) => n > (routeRecord(entry.mark, f) ?? 0)));
  if (landed || asked || (waiting && now - Date.parse(e.down_since) >= RESUME_AFTER)) return { action: 'resume', entry: { ...e, resumed_at: at } };
  return { action: 'none', entry: e };
}

// The hub's wake over every board (resumeStep), keeping ~/.claude/kickflip/resume-state.json {<route>: entry}. asked
// is the routes whose page asked for a wake since the last check. restart(route) stops and resumes a running session
// (restartSession), and held(board, record) says what holds its restart (auto-restarts.mjs restartHeld). Each restart
// and whether it brought the board back go to auto-restarts.jsonl.
// → {resumed: [route], restarted: [route], pushed: [route], failed: [message]}
export async function checkSessions({
  manifest = readManifest(), now = new Date(), live = liveSessions, asked = new Set(),
  listening = (board, running) => isListening(board, { now: now.getTime(), running }),
  resume = (route, mark) => resumeSession(route, { manifest, live, mark }), push = deliver,
  restart = (route) => restartSession(route, { manifest, live }),
  held = (board, record) => restartHeld({ dir: board.dir, record }),
  gateOf = (board) => readUsageGate({ now, dir: board.dir }),
} = {}) {
  const running = live();
  // With ps giving no answer, which sessions run is unknown, so nothing wakes or pushes and every outage is kept for
  // the next check.
  if (!running) return { resumed: [], restarted: [], pushed: [], failed: [] };
  const state = readJSON(resumeStateFile(), {});
  const next = Object.create(null);
  const out = { resumed: [], restarted: [], pushed: [], failed: [] };
  for (const board of listBoards(manifest)) {
    const rec = sessionOf(manifest, board.route);
    const record = rec ? running.get(rec.session) : undefined;
    const isLive = Boolean(record);
    const heard = listening(board, running);
    const was = routeRecord(state, board.route);
    const inputs = { listening: heard, live: isLive, asked: asked.has(board.route), downSince: was?.down_since ?? null, resumedAt: was?.resumed_at ?? null };
    // docs/adr/2026-11-05-0913-the-hub-and-each-board-keep-an-audit-log-of-the-calls-their-code-makes.md
    const logged = (call, result, reason, options = {}) => audit(boardAudit(board.dir), { call, result, reason, inputs }, { now, ...options });
    let { action, entry } = await resumeStep(was, {
      listening: heard, live: isLive, recorded: Boolean(rec?.repo), now: now.getTime(), asked: asked.has(board.route),
      counts: heard ? null : watchedCounts(board), waiting: !heard && !isLive && oldestUnheard(board) !== null,
      idle: record?.status === 'idle',
      held: async () => {
        const why = gateOf(board).state === 'paused' ? 'its usage is paused' : await held(board, record);
        if (why) logged('session-restart', 'held', `Its session isn't listening, but ${why}.`, { once: true });
        return Boolean(why);
      },
    });
    if (heard && was?.restarted && !was.error && !was.pushed_at) logRestart({ board: board.route, what: 'session', why: NOT_LISTENING, outcome: 'back' }, { now });
    if (action === 'resume' && gateOf(board).state === 'paused') {
      const mark = routeRecord(state, board.route)?.mark || watcherCursor(board);
      const pending = Object.entries(watchedLines(board)).flatMap(([file, lines]) => lines.slice(routeRecord(mark, file) || 0));
      if (!pending.some((line) => !heldUsageEvent(line))) { action = 'none'; delete entry.resumed_at; }
    }
    if (action === 'restart') {
      const why = `Its session ran idle without listening for ${RESTART_AFTER / 60_000} minutes.`;
      try {
        await restart(board.route);
        out.restarted.push(board.route);
        logged('session-restart', 'restarted', why);
        logRestart({ board: board.route, what: 'session', why: NOT_LISTENING, outcome: 'restarted' }, { now });
      } catch (e) {
        if (e.reason === 'unknown') { delete entry.resumed_at; delete entry.restarted; } else {
          entry = { ...entry, error: e.message };
          logRestart({ board: board.route, what: 'session', why: NOT_LISTENING, outcome: 'failed', error: e.message }, { now });
        }
        out.failed.push(`${board.route}: could not restart its session (${e.message})`);
        logged('session-restart', 'failed', `${why} ${e.message}`);
      }
    } else if (action === 'resume') {
      const why = asked.has(board.route) ? "The owner opened the board's page while its session wasn't listening." : "An event waited while the board's session wasn't listening.";
      try { await resume(board.route, entry.mark); out.resumed.push(board.route); logged('session-resume', 'resumed', why); } catch (e) {
        // A resume that couldn't tell whether the session runs is tried again on the next check.
        if (e.reason === 'unknown') delete entry.resumed_at;
        else entry = { ...entry, error: e.message };
        out.failed.push(`${board.route}: could not resume its session (${e.message})`);
        logged('session-resume', 'failed', `${why} ${e.message}`);
      }
    } else if (action === 'push') {
      const verb = entry.restarted ? 'restart' : 'resume';
      const body = entry.error ? `The hub couldn't ${verb} it: ${entry.error}`
        : entry.restarted ? "The hub restarted it because it wasn't listening, and it still isn't."
          : isLive ? "Its session is running but hasn't relaunched its watcher."
            : `It still isn't listening after the hub resumed it. Try kickflip resume ${board.route}, or claude agents.`;
      const why = `Its session didn't come back after the hub ${verb}d it: ${body}`;
      try {
        await push({ title: `${board.title}'s session didn't come back`, body, url: `/${board.route}/`, tag: `resume-${board.route}` }, { kind: 'fault', immediate: true, at: now });
        if (entry.restarted && !entry.error) logRestart({ board: board.route, what: 'session', why: NOT_LISTENING, outcome: 'not back' }, { now });
        out.pushed.push(board.route);
        logged('push', 'sent', why);
      } catch (e) {
        entry = { ...entry, pushed_at: undefined };
        out.failed.push(`${board.route}: could not push that its session didn't come back (${e.message})`);
        logged('push', 'not sent', `${why} Not sent: ${e.message}`);
      }
    }
    if (entry) next[board.route] = entry;
  }
  if (JSON.stringify(next) !== JSON.stringify(state)) saveJSON(resumeStateFile(), next);
  return out;
}
