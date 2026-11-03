#!/usr/bin/env node
// kickflip hub: one loopback server that Tailscale sends every request to.
//   /                 the app shell (board/public/app.html), which opens this device's last board, else the board with
//                     the most waiting; a browser's page load of any site's page, such as /<route>/,
//                     /<route>/settings.html or /learn/, gets the shell too (shell.mjs pageOf)
//                     (docs/adr/0055-one-app-for-the-whole-hub.md)
//   /_hub/app/<file>  the shell's scripts and CSS, read from ../board/public then ../starter/public on each request;
//                     ?v=<version> caches for a year
//   /_hub/stream      the shell's one event stream: `change {route}` for each board's change signal and `sidebar` with
//                     /_hub/sidebar.json's data when it changes (stream.mjs)
//   /_hub/, /_hub/settings, /_hub/settings/polling
//                     the hub page (both paths) and Polling, views of the shell; any GET of them gets the shell
//   /_hub/api/hub, /_hub/api/settings, /_hub/api/polling?w=HH:MM
//                     those views' data and words (views.mjs), including integration readiness rows on /_hub/api/hub
//   /_hub/sidebar.json what the sidebar shows (board/public/ui-sidebar.js): {code, total, start,
//                     sites: [{route, title, board, state, count, changedAt, created, icon, sub}], hub: {tone, word, detail, broken},
//                     notifications: {state, text}}, each site's row from its GET /_claude/needs
//                     (home.mjs; docs/adr/0010-sites-report-what-waits-through-claude-needs.md)
//                     starting lists pending boards and their clone/start phase (sessions.mjs)
//                     usage: {claude, codex}, each null when hidden, else {at, five_hour, seven_day}; windows are
//                     null without a reading, else {used_percentage, resets_at, state: live|reset|stale} (usage.mjs).
//                     Reset windows read 0%; stale means older than that window. Codex scans cache for 60 seconds.
//                     /_hub/api/hub carries the same usage field.
//                     Both carry pause: {pause_at, state: normal|paused|going, window, used, resets_at,
//                     codex: {past, window, used, resets_at}} (../shared/usage-gate.mjs).
//                     /_hub/ JSON answers carry X-Hub-Code, the running hub's code hash.
//   /_hub/api/linear GET {set, workspace, url_key, teams: [{key, name}], projects: [{id, name, team}]} through Hub's Linear
//                     key, {set: false} without one, {set: true, refused: true, …} once Linear refused it, or with
//                     error when Linear can't be reached
//   /_hub/linear/projects POST {team, name} creates a Linear project in that team → {id, name, team}
//   /_hub/repos      GET the signed-in owner's and orgs' repos with clone/share metadata
//   /_hub/repo       GET ?github=owner/repo checks a pasted GitHub repo, including one outside the list;
//                     returns one repo row with listed: false, or 404 when unreachable (repos.mjs)
//   /_hub/branches   GET ?github=owner/repo lists branches and the repo default
//   /_hub/board-repo/<route> GET repo and branch; POST {github, branch} prepares the clone and sends repo-changed
//                     (board-repo.mjs); the hub board's GET names kickflip's clone and its POST is refused
//   /_hub/new-board  POST {name, github, branch, purpose, tickets} → {route}: a starting reservation, then the board's session starts
//                     without holding the response; DELETE /_hub/new-board/<route> dismisses a start that failed
//                     or timed out (new-board.mjs)
//   /_hub/close-board/<route> GET the board's title, hub flag, open PRs and running builder records
//   /_hub/close-board POST {route, name} stops the session, closes builder records and keeps the site under `closed`
//   /_hub/reopen-board POST {route} restores that entry and resumes its recorded session (close-board.mjs)
//   /_hub/status.json the manifest's sites and their process state, as JSON
//   /_hub/needs.json  {total, sites: {<route>: {count, working, summary, lanes, building} | null}}: total is the
//                     Home Screen badge; ?fresh=1 skips the cache
//   /<route>/...      forwarded to that site's port with the /<route> prefix
//                     removed (X-Forwarded-Prefix carries it), unless it is a page load the shell takes; a site with a
//                     dir and no port is a plain page whose files the hub serves itself (files.mjs)
//   /sw.js, /manifest.webmanifest, /_hub/icon-*.png
//                     the Home Screen app and its service worker (scope /), which shows pushes and keeps the shell
//                     and its files to open while the host can't be reached; the shell's response carries
//                     X-App-Shell: 1, and a request with X-App-Shell: 1 is a page load (shell.mjs destOf)
//   /_hub/colors.css  ../shared/colors.css, the colours the shell and the down page link; ?v=colorsVersion() caches for a year
//   /_hub/kickflip.png the header's image and every page's tab icon (/favicon.ico redirects to it), and /_hub/hub.css the down page's CSS, read from ../board/public
//   /_hub/push/key    GET the VAPID public key; /_hub/push/subscribe and
//                     /_hub/push/test take POSTs from the hub views (push.mjs)
//   The forms below answer the view's JSON when the request accepts application/json, and redirect back with a 303
//   otherwise:
//   /_hub/settings/notifications POST set=on|weekends with value=on (absent for off), or snooze=<push.mjs
//                     setNotifications choice | off> → /_hub/api/settings's JSON, or 400 {error} when refused
//                     (303 to ?refused=snooze). Custom posts a UTC ISO date-time; snoozeEnd refuses an end not
//                     after now or more than 30 days on.
//   /_hub/settings/keep-awake POST keep_awake=<duration.mjs durationEnd choice | off> → /_hub/api/settings's JSON, or
//                     400 {error} for an end not after now or more than 30 days on (303 to ?refused=keep-awake), or
//                     409 {error} off macOS (awake.mjs)
//   /_hub/settings/codex POST value=auto|always|off → /_hub/api/hub's JSON, or 400 {error}, or 409 {error} with the
//                     fix while Codex isn't installed or logged in, checked afresh
//   /_hub/settings/pause-at POST value=50..100 in steps of 5 → /_hub/api/hub's JSON, or 400 {error}; 100 is Off
//   /_hub/settings/keep-going POST value=on|off → /_hub/api/hub's JSON, or 400 {error}; on without a pause → 409 {error}
//   /_hub/settings/linear POST key=<Linear personal API key>, checked with Linear and saved, as refused if Linear
//                     refuses it, or remove=1 → /_hub/api/settings's JSON, whose `linear` names only the workspace,
//                     or 400 {error}, 502 {error} when Linear can't be reached (linear.mjs)
//   /_hub/settings/polling POST one schedule.mjs editPolling change {op, w, value} → /_hub/api/polling's JSON for the
//                     window to show, or 400 {error}
//   /_hub/push/flush  POST sends the queued pushes now → {sent, count, ok, message}
//   /_hub/settings/rules POST {rules: [{id?, text}], base: [id]} saves the hub rules in settings.json (rules.mjs
//                     applyRules) and, when anything changed, sends every board a `rules {scope: "hub", added, edited,
//                     removed}` event (boards.mjs sendToBoards). → {rules, events, failed}; a bad list → 400 {error}
//   /_hub/poll        POST runs one poll now, or joins the running one, and returns its result as JSON;
//                     {"flush": false} skips sending the queue (`kickflip poll-now`)
//   /_hub/build       POST {route, key}, key <wave>/<id> or main (retry failed tip), loopback only:
//                     runs <worktree>/.kickflip/build <key> <worktree>
//                     asynchronously; data/try.json and data/try/<id>.log carry its state (try.mjs)
//   /_hub/prompts     POST a PermissionRequest hook's input (permission-hook.mjs) → {id, deadline}: a pending prompt in
//                     prompts.json, on the board whose owner is that session, else the hub page, with a push
//                     (docs/adr/0060-background-sessions-prompts-come-to-the-phone.md), or {state: 'answered', answer}
//                     with allow when the session has a remembered exact match, with no pending prompt or push
//   /_hub/prompts/<id>/wait?ms=N  GET, the hook's poll, held up to N ms (at most prompts.mjs POLL_MS) →
//                     {state: 'pending'} or {state: 'answered', answer}, which removes the prompt; 404 once it's gone
//   /_hub/prompts/<id>/answer  POST the owner's {choice: allow | always | deny, answers?} from Needs you → {ok};
//                     404 when gone, 409 when already answered, 400 {error} for a choice that doesn't fit
//   /_hub/prompts/<id> DELETE, the hook giving up at its deadline
// Every non-GET/HEAD request passes ../starter/cross-site.mjs before routing or proxying (403 plain text).
// Routes that parse JSON require application/json; settings forms and raw uploads keep their own types.
// /_hub/build also requires loopback and refuses Origin and forwarded headers.
// It also runs every site: it starts each manifest entry's `cmd`, restarts it
// when it exits, restarts it when its entry changes, and stops every one before it exits itself. A site with a port and
// no `cmd` runs its own server: the hub only probes it, and it reads Down while nothing answers
// (docs/adr/0087-a-page-joins-without-a-session.md). On each slot of the
// polling interval (schedule.mjs), and once a minute after it starts, it checks
// GitHub (github.mjs), pushes once for each board that is deaf (boards.mjs
// checkListening, listenState), then sends the queued pushes unless schedule.mjs heldUntil holds them;
// one poll never overlaps another. At each of the polling settings' wake times it wakes each
// board's session once a day (github.mjs sendWakes)
// (docs/adr/0025-the-hub-polls-github-and-sends-pushes-on-one-interval.md). Every feature that serves
// boards takes them from boards.mjs listBoards, the one board registry
// (docs/adr/0040-one-board-registry-for-every-hub-feature.md). The host's service manager keeps the
// hub itself running (../shared/service.mjs, `kickflip install`).
// After each poll it records when each board's hub links first failed (boards.mjs recordLinkFaults). As it starts it
// records the hash of its own code (boards.mjs recordHubCode), so the hub link (boards.mjs hubLink) can tell when the
// files changed under it (docs/adr/0046-hub-links-turn-red-only-after-a-grace-period.md), and flags `hub-orchestrator`
// as the hub board once when no site has the flag (boards.mjs migrateHubFlag).
// Every 15 seconds it counts each board's watched lines, and resumes the recorded session of a board that got an event
// while that session wasn't running, and pushes once when that doesn't bring it back (sessions.mjs checkSessions;
// docs/adr/0061-a-boards-session-wakes-when-an-event-arrives.md).
// Every 15 seconds it drops the pending prompts whose hook has gone (prompts.mjs expired).
// It runs caffeinate while Keep awake is on, and starts it again as it starts while time is left (awake.mjs).
// On paused → normal it sends every board usage-resumed {window}, keeping usage-gate-state.json across restarts.
// Each served card and main has its own Tailscale HTTPS port, through a loopback relay (try.mjs).
// Every 15 seconds try.mjs refreshes card heads, auto-builds cards and rebuilds main; polls fetch non-hub branches.
// Try worktrees live in ~/.claude/kickflip/try/<route>-main; board data/try.json and data/try/*.log record runs.
// State lives in ~/.claude/kickflip: manifest.json, logs/<route>.log, run/<route>.pid, github-state.json, wake-state.json,
// deaf-state.json, link-faults.json, hub-code.json, resume-state.json, prompts.json, linear.json, integrations.json.
import http from 'node:http';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { routeRecord } from './routes.mjs';
import { publicKey, addSubscription, sendAll, flushQueue, queueStatus, saveSettings, readSettings, migrateSettings, setNotifications, readCodexShare, setCodexShare, deliver, pushRoute } from './push.mjs';
import { POLL_MS, answerOf, expired, pendingFor, promptRecord, pushOf, updatePrompts, shown, pruneRemembered, rememberRules, rememberedAnswer, rememberedFor } from './prompts.mjs';
import { nextSlot, windowAt, hold, heldUntil, holdLine, editPolling } from './schedule.mjs';
import { capital, hubView, settingsView, pollingView, flushView, SNOOZE_REFUSED, AWAKE_REFUSED } from './views.mjs';
import { caffeinate, setKeepAwake, awakeUntil, awakeUnsupported } from './awake.mjs';
import { checkGitHub, sendWakes } from './github.mjs';
import { listBoards, isBoardSite, listenState, RESUME_STATE, sendToBoards, checkListening, recordHubCode, runningHubCode, migrateHubFlag, recordLinkFaults, linksOf, hubLink, hubCodeState, readJSON } from './boards.mjs';
import { liveSessions } from './live.mjs';
import { RuleError, applyRules, changed, readHubRules, writeHubRules } from './rules.mjs';
import { siteIcon } from './icons.mjs';
import { readNeeds, sidebarSites, startRoute, hubHealth } from './home.mjs';
import { checkSessions, startingBoards } from './sessions.mjs';
import { repoService, repoLookupRoute } from './repos.mjs';
import { boardRepo, changeBoardRepo, migrateBoardRepos } from './board-repo.mjs';
import { requestBoard, dismissBoard } from './new-board.mjs';
import { boardClosure, closeBoard, closedBoards, reopenBoard } from './close-board.mjs';
import { crossSite, isJSON } from '../starter/cross-site.mjs';
import { BOARD_PUBLIC, appFile, colorsVersion, destOf, fileVersion, pageOf, shellHtml } from './shell.mjs';
import { hubStream } from './stream.mjs';
import { usageReader, checkUsagePause } from './usage.mjs';
import { readUsageGate, setPauseAt, setKeepGoing } from '../shared/usage-gate.mjs';
import { readiness, readCodex } from './readiness.mjs';
import { BuildError, startBuild, stopTries, tryTick, initializeTries, fetchTryBranches } from './try.mjs';
import { migrateOnStart } from '../bin/install.mjs';
import { serveFiles } from './files.mjs';
import { LinearError, linearStatus, removeLinearKey, saveLinearKey, savedClient } from './linear.mjs';

const HUB_DIR = path.dirname(fileURLToPath(import.meta.url));
const COLORS = path.join(HUB_DIR, '..', 'shared', 'colors.css');

const log = (...a) => console.log(new Date().toISOString(), ...a);
const migration = migrateOnStart();
for (const step of migration.steps) log(`migration: ${step}`);
for (const conflict of migration.conflicts) log(`migration failed: ${conflict}`);

const HOME = path.join(os.homedir(), '.claude', 'kickflip');
const MANIFEST = path.join(HOME, 'manifest.json');
const LOGS = path.join(HOME, 'logs');
const RUN = path.join(HOME, 'run');
const PORT = Number(process.env.KICKFLIP_HUB_PORT || 4500);
for (const d of [HOME, LOGS, RUN]) fs.mkdirSync(d, { recursive: true });

try { const code = recordHubCode(); log(`hub code ${code.hash} (${code.files.length} files)`); } catch (e) { log('could not record the hub code hash:', e.message); }
try { const route = await migrateHubFlag(); if (route) log(`manifest: flagged /${route} as the hub board`); } catch (e) { log('hub board migration failed:', e.message); }
try { const routes = await migrateBoardRepos(); if (routes.length) log(`manifest: recorded GitHub repos for ${routes.map((r) => `/${r}`).join(', ')}`); } catch (e) { log('board repo migration failed:', e.message); }
const repos = repoService();
const readUsage = usageReader();
const awake = caffeinate({ log });
awake.apply();

// ---------- manifest ----------
let manifest = { version: 1, sites: {} };
// Read on every call: Linux stamps file mtimes per clock tick, so two writes a few ms apart can share an mtime, and a
// cache keyed on it keeps the first.
function loadManifest() {
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    manifest.sites ||= {};
  } catch (e) {
    if (e.code === 'ENOENT') manifest = { version: 1, sites: {} };
    else log('manifest unreadable, keeping the last good copy:', e.message);
  }
  return manifest;
}

// ---------- supervisor ----------
// route -> { child, key, state, since, exitCode, restarts, nextStart, up }
const procs = new Map();
// Every child spawned and not yet exited, including one whose route has left procs.
const children = new Set();
let shuttingDown = false;
const KILL_AFTER = 5000;
const keyOf = (s) => JSON.stringify([s.cmd, s.cwd || s.dir, s.port, s.env || {}, s.restart_at || 0]);
const runs = (s) => Array.isArray(s?.cmd) && s.cmd.length > 0 && Boolean(s.port);
// How a site is served: 'cmd', a server the hub runs; 'port', one it only forwards to; 'files', its dir served by the hub.
const servesOf = (s) => (runs(s) ? 'cmd' : s?.port ? 'port' : 'files');
// route -> whether a 'port' site answered its last probe.
const answering = new Map();

function pidFile(route) { return path.join(RUN, route + '.pid'); }

function killStale(route, site) {
  // A hub that died hard leaves its children running and holding their ports.
  // Only stop the recorded pid if it still runs this site's command: pids get reused.
  try {
    const pid = Number(fs.readFileSync(pidFile(route), 'utf8'));
    const cmdline = pid ? execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim() : '';
    if (cmdline && cmdline.includes(site.cmd[site.cmd.length - 1])) { process.kill(-pid, 'SIGTERM'); log(`stopped stale ${route} (pgid ${pid})`); }
  } catch {}
  try { fs.unlinkSync(pidFile(route)); } catch {}
}

function start(route, site) {
  const p = procs.get(route) || { restarts: 0 };
  const out = fs.openSync(path.join(LOGS, route + '.log'), 'a');
  const [cmd, ...args] = site.cmd;
  const env = { ...process.env, ...(site.env || {}), PORT: String(site.port), PREFIX: '/' + route, KICKFLIP_ROUTE: route };
  fs.writeSync(out, `\n--- ${new Date().toISOString()} hub starting: ${site.cmd.join(' ')} (port ${site.port})\n`);
  let child;
  try {
    child = spawn(cmd, args, { cwd: site.cwd || site.dir, env, stdio: ['ignore', out, out], detached: true });
  } catch (e) {
    fs.writeSync(out, `hub could not start it: ${e.message}\n`);
    fs.closeSync(out);
    Object.assign(p, { child: null, key: keyOf(site), state: 'crashed', exitCode: null, nextStart: Date.now() + backoff(p.restarts++) });
    procs.set(route, p);
    return;
  }
  fs.closeSync(out);
  fs.writeFileSync(pidFile(route), String(child.pid));
  Object.assign(p, { child, key: keyOf(site), state: 'starting', since: Date.now(), exitCode: null });
  procs.set(route, p);
  log(`started ${route} pid ${child.pid}`);
  if (child.pid) children.add(child);
  const ended = (code, sig) => {
    children.delete(child);
    if (p.child !== child) return;
    try { fs.unlinkSync(pidFile(route)); } catch {}
    const ranLong = Date.now() - p.since > 60_000;
    if (ranLong) p.restarts = 0;
    Object.assign(p, { child: null, state: p.stopping ? 'stopped' : 'crashed', exitCode: code ?? sig, nextStart: Date.now() + backoff(p.restarts++) });
    p.stopping = false;
    log(`${route} exited (${code ?? sig})`);
  };
  // A child that never spawned, such as one whose cwd is missing, emits no exit.
  child.on('error', (e) => { log(`${route} spawn error: ${e.message}`); if (!child.pid) ended(e.code, null); });
  child.on('exit', ended);
}

const backoff = (n) => Math.min(60_000, 1000 * 2 ** Math.min(n, 6));

function stop(route) {
  const p = procs.get(route);
  if (!p || !p.child) { procs.delete(route); return; }
  p.stopping = true;
  const c = p.child;
  signal(c, 'SIGTERM');
  setTimeout(() => { if (children.has(c)) signal(c, 'SIGKILL'); }, KILL_AFTER);
}

const signal = (child, sig) => { try { process.kill(-child.pid, sig); } catch {} };

function probe(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(800, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

let first = true;
const closingResponses = new Set();
async function reconcile() {
  if (shuttingDown) return;
  const { sites } = loadManifest();
  for (const route of [...procs.keys()]) {
    if (closingResponses.has(route)) continue;
    if (!routeRecord(sites, route)) { log(`${route} left the manifest; stopping it`); stop(route); procs.delete(route); }
    else if (!runs(routeRecord(sites, route))) { log(`${route} no longer has a command; stopping it`); stop(route); procs.delete(route); }
  }
  for (const route of [...answering.keys()]) if (servesOf(routeRecord(sites, route)) !== 'port') answering.delete(route);
  for (const [route, site] of Object.entries(sites)) if (servesOf(site) === 'port') answering.set(route, await probe(site.port));
  for (const [route, site] of Object.entries(sites)) {
    if (!runs(site)) continue;
    if (first) killStale(route, site);
    const p = procs.get(route);
    if (p && p.child && p.key !== keyOf(site)) {
      log(`${route} entry changed; restarting it`);
      stop(route);
      p.restarts = 0;
      p.nextStart = Date.now() + 1500;
      continue;
    }
    if (!p || (!p.child && Date.now() >= (p.nextStart || 0))) start(route, site);
  }
  first = false;
  for (const [route, p] of procs) {
    const site = routeRecord(sites, route);
    if (!site) continue;
    p.up = p.child ? await probe(site.port) : false;
    if (p.child && p.up) p.state = 'up';
  }
}
const reconciling = setInterval(() => reconcile().catch((e) => log('reconcile failed:', e.message)), 2000);
reconcile().catch((e) => log('reconcile failed:', e.message));

// ---------- polling ----------
try { if (migrateSettings()) log('settings: migrated the push schedule to the polling interval'); } catch (e) { log('settings migration failed:', e.message); }

const FIRST_POLL_MS = 60_000;
const ERROR_LOG_MS = 60 * 60_000;
// running: the poll in progress; startedAt: when the last one began; last: its result.
const polls = { running: null, startedAt: 0, firstAt: Date.now() + FIRST_POLL_MS, last: null, errorLoggedAt: 0, linearErrorLoggedAt: 0 };

const nextPollAt = () => new Date(polls.startedAt ? nextSlot(new Date(polls.startedAt), readSettings()).getTime() : polls.firstAt);

function runPoll({ flush = true } = {}) {
  if (polls.running) return polls.running;
  const startedAt = new Date();
  polls.startedAt = startedAt.getTime();
  polls.running = (async () => {
    const settings = readSettings();
    let result;
    try { result = await checkGitHub({ every: windowAt(startedAt, settings).every_minutes, manifest: loadManifest() }); }
    catch (e) { result = { at: startedAt.toISOString(), watched: 0, failed: [e.message], changes: [], events: [], checked: [], linear: { moved: [], failed: [] } }; }
    await fetchTryBranches({ manifest: loadManifest(), log });
    if (result.failed.length && Date.now() - polls.errorLoggedAt > ERROR_LOG_MS) {
      polls.errorLoggedAt = Date.now();
      log(`github check: ${result.failed.length} step${result.failed.length === 1 ? '' : 's'} failed, first: ${result.failed[0]} (logged at most hourly)`);
    }
    if (result.changes.length) log(`github check: ${result.changes.map((c) => `#${c.pr} ${c.changes.join(',')}`).join('; ')} → ${result.events.map((e) => e.route).join(', ') || 'no board'}`);
    for (const { id, state } of result.linear.moved) log(`linear: ${id} → ${state}`);
    if (result.linear.failed.length && Date.now() - polls.linearErrorLoggedAt > ERROR_LOG_MS) {
      polls.linearErrorLoggedAt = Date.now();
      log(`linear check: ${result.linear.failed.length} step${result.linear.failed.length === 1 ? '' : 's'} failed, first: ${result.linear.failed[0]} (logged at most hourly)`);
    }
    try { result.deaf = await checkListening({ manifest: loadManifest() }); }
    catch (e) { result.deaf = { pushed: [], failed: [e.message] }; }
    if (result.deaf.pushed.length || result.deaf.failed.length) log(`not listening: pushed ${result.deaf.pushed.join(', ') || 'none'}${result.deaf.failed.length ? `; ${result.deaf.failed.join('; ')}` : ''}`);
    try { recordLinkFaults(loadManifest()); } catch (e) { log('could not record link faults:', e.message); }
    result.flushed = null;
    result.held = heldUntil(startedAt, settings) !== null;
    if (flush && !result.held) {
      try {
        const r = await flushQueue();
        if (r) { result.flushed = { count: r.count, sent: r.sent, ok: r.ok }; log(`push queue: sent ${r.sent} of ${r.count} queued`); }
      } catch (e) { log('push queue flush failed:', e.message); }
    }
    polls.last = result;
    return result;
  })().finally(() => { polls.running = null; });
  return polls.running;
}

let waking = null;
function runWakes() {
  waking ||= sendWakes({ settings: readSettings(), manifest: loadManifest() }).then((r) => {
    if (r.due.length) log(`wake ${r.due.join(', ')}: check-github → ${r.events.map((e) => e.route).join(', ') || 'no board'}${r.failed.length ? `; ${r.failed.join('; ')}` : ''}`);
  }).catch((e) => log('wake failed:', e.message)).finally(() => { waking = null; });
}

const sessionCheck = { running: null };
function runSessionCheck() {
  if (sessionCheck.running || closingResponses.size) return;
  sessionCheck.running = checkSessions({ manifest: loadManifest() }).then((r) => {
    if (r.resumed.length || r.pushed.length || r.failed.length) log(`sessions: resumed ${r.resumed.join(', ') || 'none'}; pushed ${r.pushed.join(', ') || 'none'}${r.failed.length ? `; ${r.failed.join('; ')}` : ''}`);
  }).catch((e) => log('session check failed:', e.message)).finally(() => { sessionCheck.running = null; });
}

await initializeTries(loadManifest());

// ---------- pending prompts ----------
const STARTED_AT = Date.now();
// id → the resolvers of the hook's poll held open on it.
const promptWaiters = new Map();
function promptChanged(route) {
  if (route) { needsCache.delete(route); stream.changed(route); } else stream.refresh();
}
async function prunePrompts() {
  const { gone, rulesChanged } = await updatePrompts((store) => {
    const gone = expired(store, { now: Date.now(), aliveSince: STARTED_AT });
    const rulesChanged = pruneRemembered(store, promptContext());
    for (const r of gone) delete store.prompts[r.id];
    return { gone, rulesChanged };
  });
  for (const r of gone) promptChanged(r.route);
  if (rulesChanged) stream.refresh();
  if (gone.length) log(`prompts: dropped ${gone.map((r) => r.id).join(', ')}, whose hook went away`);
}

const promptContext = () => ({ running: liveSessions(), boards: listBoards(loadManifest()) });

let checkingUsage = false;
async function checkUsageGate() {
  if (checkingUsage) return;
  checkingUsage = true;
  try {
    await checkUsagePause({ gate: readUsageGate(), resume: async (window) => {
      const out = await sendToBoards(listBoards(loadManifest()), 'usage-resumed', { window });
      for (const failed of out.failed) log(failed);
    } });
  } finally { checkingUsage = false; }
}

setInterval(() => {
  tryTick({ manifest: loadManifest() }).catch((e) => log('try tick failed:', e.message));
  checkUsageGate().catch((e) => log('usage gate failed:', e.message));
  if (!polls.running && Date.now() >= nextPollAt().getTime()) runPoll().catch((e) => log('poll failed:', e.message));
  runWakes();
  awake.apply();
  prunePrompts().catch((e) => log('prompt expiry failed:', e.message)).finally(runSessionCheck);
}, 15_000);

// Sites run detached, so the hub must not exit while one it started still runs.
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(reconciling);
  awake.stop();
  log('hub stopping; stopping sites');
  for (const p of procs.values()) if (p.child) p.stopping = true;
  for (const c of children) signal(c, 'SIGTERM');
  let triesStopped = false;
  stopTries().finally(() => { triesStopped = true; });
  const deadline = Date.now() + KILL_AFTER;
  setInterval(() => {
    if ((!triesStopped || children.size) && Date.now() < deadline) return;
    for (const c of children) { log(`pid ${c.pid} ignored SIGTERM; killing it`); signal(c, 'SIGKILL'); }
    process.exit(0);
  }, 50);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ---------- status ----------
const lastChange = new Map(); // route -> { at, checked }
function newestMtime(dir, budget = { n: 3000 }) {
  let newest = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (budget.n-- <= 0) break;
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) newest = Math.max(newest, newestMtime(full, budget));
    else { try { newest = Math.max(newest, fs.statSync(full).mtimeMs); } catch {} }
  }
  return newest;
}
function changedAt(route, site) {
  const c = lastChange.get(route);
  if (c && Date.now() - c.checked < 30_000) return c.at;
  const at = newestMtime(site.dir);
  lastChange.set(route, { at, checked: Date.now() });
  return at;
}

const isFolder = (dir) => { try { return typeof dir === 'string' && fs.statSync(dir).isDirectory(); } catch { return false; } };

function status() {
  const { sites } = loadManifest();
  return Object.entries(sites).sort(([a], [b]) => a.localeCompare(b)).map(([route, s]) => {
    const p = procs.get(route) || {};
    const serves = servesOf(s);
    const state = serves === 'files' ? (isFolder(s.dir) ? 'up' : 'down')
      : serves === 'port' ? (answering.has(route) ? (answering.get(route) ? 'up' : 'down') : 'starting')
        : p.child ? (p.up ? 'up' : 'starting') : (p.state === 'crashed' ? 'down' : (p.state || 'starting'));
    return {
      route, title: s.title || route, description: s.description || '', icon: s.icon || null, color: s.color || null, port: s.port ?? null, serves, state,
      exitCode: p.exitCode ?? null, owner: s.owner || null, changedAt: changedAt(route, s) || null, created: s.created || null,
      log: path.join(LOGS, route + '.log'),
    };
  });
}

// ---------- pages ----------
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// route -> {at, needs}: needs is a promise of home.mjs readNeeds' answer from the site's GET /_claude/needs,
// or of null when the site doesn't serve it, errs or takes over NEEDS_TIMEOUT.
const needsCache = new Map();
const NEEDS_TTL = 20_000;
const NEEDS_TIMEOUT = 1500;
async function fetchNeeds(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/_claude/needs`, { signal: AbortSignal.timeout(NEEDS_TIMEOUT) });
    if (!r.ok) return null;
    return readNeeds(await r.json());
  } catch { return null; }
}
// fresh: true refetches every site's answer, a Set of routes only those. A site with no owning session is never asked.
async function waitingCounts(rows, { fresh = false } = {}) {
  const up = rows.filter((r) => r.state === 'up' && r.owner && r.port);
  for (const r of up) {
    const c = needsCache.get(r.route);
    if (fresh === true || fresh?.has?.(r.route) || !c || Date.now() - c.at >= NEEDS_TTL) needsCache.set(r.route, { at: Date.now(), needs: fetchNeeds(r.port) });
  }
  const needs = await Promise.all(up.map((r) => needsCache.get(r.route).needs));
  return new Map(up.map((r, i) => [r.route, needs[i]]));
}
// A site whose answer is unknown adds nothing. A board's pending prompts are in its count already; the rest wait on the
// hub page.
const badgeTotal = (waiting) => [...waiting.values()].reduce((n, w) => n + (w?.count || 0), 0) + pendingFor(null).length;

// ---------- sidebar ----------
// Each board's linksOf and listenState (boards.mjs), cached as long as the sites' needs, since every open page asks
// for the sidebar. → {links: Map of route to linksOf, listens: Map of route to listenState}
const linksCache = { at: 0, value: null };
function boardLinks(boards) {
  if (linksCache.value && Date.now() - linksCache.at < NEEDS_TTL) return linksCache.value;
  const links = new Map();
  const listens = new Map();
  const ctx = { running: liveSessions(), wakes: readJSON(RESUME_STATE, {}) };
  for (const b of boards) {
    try {
      const listen = listenState(b, ctx);
      listens.set(b.route, listen);
      links.set(b.route, linksOf(b, { listen }));
    } catch (e) { log(`links of ${b.route} failed:`, e.message); links.set(b.route, []); }
  }
  Object.assign(linksCache, { at: Date.now(), value: { links, listens } });
  return linksCache.value;
}

// What /_hub/sidebar.json serves, with each board's links, the hub's code hashes and the status rows behind it for the
// hub's page.
async function sidebarState({ fresh = false } = {}) {
  const now = new Date();
  const rows = status();
  const waiting = await waitingCounts(rows, { fresh });
  const manifest = loadManifest();
  const boards = listBoards(manifest);
  const { links, listens } = boardLinks(boards);
  const code = hubCodeState();
  const sites = sidebarSites(rows, waiting, new Set(boards.map((b) => b.route)), listens);
  const settings = readSettings();
  const held = hold(now, settings);
  const data = {
    code: code.running ?? null,
    total: badgeTotal(waiting), start: startRoute(sites), sites, hub: hubHealth(sites, links, hubLink(code)),
    home: fs.realpathSync(os.homedir()),
    starting: startingBoards(manifest, now.getTime()),
    usage: readUsage({ codexShare: readCodexShare(readCodex()) }),
    pause: readUsageGate(),
    notifications: !held ? { state: 'on', text: 'On' } : held.why === 'off' ? { state: 'off', text: 'Off' } : { state: 'held', text: capital(holdLine(held, now)) },
  };
  return { data, links, rows, code };
}

// ---------- app shell ----------
// Text a browser accepts gzipped goes gzipped; the shell's scripts are a few hundred kilobytes before it.
function sendText(req, res, code, headers, body) {
  let out = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const h = { ...headers, vary: [headers.vary, 'accept-encoding'].filter(Boolean).join(', ') };
  if (out.length >= 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) { out = zlib.gzipSync(out); h['content-encoding'] = 'gzip'; }
  h['content-length'] = out.length;
  res.writeHead(code, h);
  res.end(req.method === 'HEAD' ? undefined : out);
}

// The app shell with the sidebar drawn in (board/public/ui-sidebar.js, run here in a vm context) and its data beside
// it, so the first paint has both. here is a site's route or a hub page's path without its leading slash. "<" is
// escaped in the data so no site's title can close its script.
async function shellPage(here) {
  const { data } = await sidebarState();
  const context = vm.createContext({});
  for (const file of ['ui-page-header.js', 'ui-sidebar.js']) vm.runInContext(fs.readFileSync(path.join(BOARD_PUBLIC, file), 'utf8'), context);
  return shellHtml({ sidebar: context.BoardUI.sidebar(data, { here }), sidebarData: JSON.stringify(data).replace(/</g, '\\u003c'), touchIcon: iconUrl(180) });
}

const stream = hubStream({
  targets: () => Object.entries(loadManifest().sites).filter(([, s]) => isBoardSite(s) && s.port).map(([route, s]) => ({ route, port: s.port })),
  sidebar: async ({ fresh }) => (await sidebarState({ fresh })).data,
  log,
});

// iOS caches a Home Screen icon by its URL, so each URL carries the file's mtime: a replaced icon gets a new address.
function iconUrl(size) {
  let v = '0';
  try { v = Math.floor(fs.statSync(path.join(HUB_DIR, `icon-${size}.png`)).mtimeMs).toString(36); } catch {}
  return `/_hub/icon-${size}.png?v=${v}`;
}
const manifestJson = () => JSON.stringify({
  name: 'Claude sites', short_name: 'Claude', start_url: '/', scope: '/', display: 'standalone',
  background_color: '#121514', theme_color: '#121514',
  icons: [{ src: iconUrl(192), sizes: '192x192', type: 'image/png' }, { src: iconUrl(512), sizes: '512x512', type: 'image/png' }],
});

async function readBody(req, limit = 16 * 1024) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > limit) throw Object.assign(new Error('too large'), { status: 413 }); }
  return body;
}
async function readJSONBody(req, limit) {
  if (!isJSON(req.headers)) throw Object.assign(new Error('Send the body as application/json.'), { status: 403 });
  const body = await readBody(req, limit);
  return body ? JSON.parse(body) : {};
}

// The page the hub answers a site that is down or missing with, which a frame or curl gets too.
const head = (title, extra = '') => `<!doctype html><html lang="en" class="hub-view"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title><link rel="manifest" href="/manifest.webmanifest"><link rel="icon" type="image/png" href="/_hub/kickflip.png"><link rel="apple-touch-icon" href="${iconUrl(180)}">
<meta name="apple-mobile-web-app-title" content="Claude">${extra}<link rel="stylesheet" href="/_hub/colors.css?v=${colorsVersion()}"><link rel="stylesheet" href="/_hub/hub.css"></head><body><main>`;

// ---------- hub views ----------
// The hub page and its settings modals live in the app shell (board/public/view-hub.js, view-hub-settings.js, view-polling.js), which
// take their words from views.mjs through /_hub/api/*. A form POST that asks for JSON gets the view's data back; any
// other gets a 303 back to the page.
const wantsJSON = (req) => /\bapplication\/json\b/.test(req.headers.accept || '');
const pollState = () => ({ running: Boolean(polls.running), nextAt: nextPollAt(), last: polls.last });

async function hubData(req) {
  await prunePrompts();
  const now = new Date();
  const { data, links, rows, code } = await sidebarState();
  return {
    ...hubView({
      now, st: queueStatus(now), poll: pollState(), sidebar: data, rows, links, rules: readHubRules(), integrations: await readiness.rows(),
      code, host: req.headers['x-forwarded-host'] || req.headers.host || '', codexShare: readCodexShare(readCodex()), codex: readCodex(), awake: awakeUntil(now),
      remembered: new Map(listBoards(loadManifest()).map((b) => [b.route, rememberedFor(b.route)])),
    }),
    prompts: pendingFor(null).map(shown),
    remembered: rememberedFor(null),
  };
}
const settingsData = async () => {
  const now = new Date();
  const awake = { until: awakeUntil(now), unsupported: awakeUnsupported() };
  return { ...settingsView({ now, st: queueStatus(now), rules: readHubRules(), route: await pushRoute(), linear: linearStatus(), awake }), closed: closedBoards() };
};
const pollingData = (select) => { const now = new Date(); return pollingView({ now, st: queueStatus(now), poll: pollState(), select }); };

const redirect = (res, location) => { res.writeHead(303, { location, 'cache-control': 'no-store' }); res.end(); };

async function hubRoute(req, res, url) {
  const send = (code, type, body, extra = {}) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...extra }); res.end(body); };
  const sendJSON = (code, v) => {
    const hash = runningHubCode();
    return send(code, 'application/json', JSON.stringify(v), hash ? { 'x-hub-code': hash } : {});
  };
  const json = wantsJSON(req);
  const p = url.pathname;
  const closing = /^\/_hub\/close-board\/([a-z0-9-]+)$/.exec(p);
  if (closing && req.method === 'GET') {
    try { return sendJSON(200, await boardClosure(closing[1])); }
    catch (e) { return sendJSON(e.status || 400, { error: e.message }); }
  }
  if (['/_hub/close-board', '/_hub/reopen-board'].includes(p) && req.method === 'POST') {
    let route;
    try {
      const input = await readJSONBody(req);
      route = input.route;
      if (p === '/_hub/reopen-board') {
        const result = await reopenBoard(route);
        stream.refresh();
        return sendJSON(200, result);
      }
      if (closingResponses.has(route)) return sendJSON(409, { error: 'That board is already closing.' });
      closingResponses.add(route);
      // The hub owns this response; reconciliation waits until it is flushed before stopping the site's server.
      const release = () => closingResponses.delete(route);
      res.once('finish', release);
      res.once('close', release);
      await sessionCheck.running;
      const result = await closeBoard(route, input.name);
      stream.refresh();
      return sendJSON(200, result);
    } catch (e) { return sendJSON(e.status || 400, { error: e.message }); }
  }
  if (p === '/_hub/repos' && req.method === 'GET') {
    try { return sendJSON(200, await repos.list(loadManifest(), { fresh: url.searchParams.get('fresh') === '1' })); }
    catch (e) { return sendJSON(e.status || 502, { error: e.message }); }
  }
  if (p === '/_hub/branches' && req.method === 'GET') {
    try { return sendJSON(200, await repos.branches(url.searchParams.get('github'))); }
    catch (e) { return sendJSON(e.status || 502, { error: e.message }); }
  }
  if (p === '/_hub/repo' && req.method === 'GET') return repoLookupRoute(url, { repos, manifest: loadManifest(), sendJSON });
  const repoRoute = /^\/_hub\/board-repo\/([a-z0-9-]+)$/.exec(p);
  if (repoRoute && ['GET', 'POST'].includes(req.method)) {
    try {
      const result = req.method === 'GET' ? boardRepo(repoRoute[1]) : await changeBoardRepo(repoRoute[1], await readJSONBody(req), { repos });
      if (req.method === 'POST') stream.refresh();
      return sendJSON(200, result);
    } catch (e) { return sendJSON(e.status || 400, { error: e.message }); }
  }
  if (p === '/_hub/new-board' && req.method === 'POST') {
    if (!isJSON(req.headers)) return send(403, 'text/plain; charset=utf-8', 'Send name, github, branch and purpose as application/json.');
    let input;
    try { input = await readJSONBody(req); } catch { return send(400, 'text/plain; charset=utf-8', 'Send name, github, branch and purpose as JSON.'); }
    try {
      const { route, started } = await requestBoard(input, { repos, changed: () => stream.refresh() });
      started.then(({ error }) => { if (error) log(`new board /${route} didn't start: ${error}`); stream.refresh(); });
      stream.refresh();
      return sendJSON(200, { route });
    } catch (e) { if (e.status) return send(e.status, 'text/plain; charset=utf-8', e.message); throw e; }
  }
  const dismiss = /^\/_hub\/new-board\/([a-z0-9-]+)$/.exec(p);
  if (dismiss && req.method === 'DELETE') {
    try {
      const result = await dismissBoard(dismiss[1]);
      stream.refresh();
      return sendJSON(200, result);
    } catch (e) { if (e.status) return send(e.status, 'text/plain; charset=utf-8', e.message); throw e; }
  }
  if (p === '/_hub/build' && req.method === 'POST') {
    if (shuttingDown) return sendJSON(503, { error: 'The hub is stopping. Try again after it restarts.' });
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    if (!local.includes(req.socket.remoteAddress) || !['127.0.0.1', 'localhost', '[::1]'].includes(host)
      || req.headers.origin || Object.keys(req.headers).some((h) => h === 'forwarded' || h.startsWith('x-forwarded-'))) {
      return sendJSON(403, { error: 'Builds can only be started from the host over loopback.' });
    }
    let input;
    try { input = await readJSONBody(req); } catch (e) { return sendJSON(e.status || 400, { error: 'Send the board route and card key as JSON.' }); }
    try { return sendJSON(202, await startBuild(input, { manifest: loadManifest(), log })); }
    catch (e) { if (e instanceof BuildError) return sendJSON(e.status, { error: e.message }); throw e; }
  }
  if (p === '/sw.js') return send(200, 'text/javascript; charset=utf-8', fs.readFileSync(path.join(HUB_DIR, 'sw.js')), { 'service-worker-allowed': '/' });
  if (p === '/manifest.webmanifest') return send(200, 'application/manifest+json', manifestJson());
  const icon = /^\/_hub\/icon-(180|192|512)\.png$/.exec(p);
  if (icon) {
    try { return send(200, 'image/png', fs.readFileSync(path.join(HUB_DIR, `icon-${icon[1]}.png`)), { 'cache-control': 'max-age=86400' }); }
    catch { res.writeHead(404).end(); return; }
  }
  if (p === '/_hub/colors.css') {
    const cache = url.searchParams.get('v') === colorsVersion() ? 'public, max-age=31536000, immutable' : 'no-cache';
    try { return send(200, 'text/css; charset=utf-8', fs.readFileSync(COLORS), { 'cache-control': cache }); }
    catch { res.writeHead(404).end(); return; }
  }
  if (p === '/_hub/kickflip.png') {
    try { return send(200, 'image/png', fs.readFileSync(path.join(BOARD_PUBLIC, 'kickflip.png')), { 'cache-control': 'max-age=86400' }); }
    catch { res.writeHead(404).end(); return; }
  }
  if (p === '/_hub/hub.css') return send(200, 'text/css; charset=utf-8', fs.readFileSync(path.join(BOARD_PUBLIC, 'hub.css')));
  if (p === '/_hub/sidebar.json') return sendJSON(200, (await sidebarState({ fresh: url.searchParams.get('fresh') === '1' })).data);
  if (p === '/_hub/stream' && req.method === 'GET') { stream.handle(req, res); return; }
  if (p.startsWith('/_hub/app/')) {
    const f = appFile(p.slice('/_hub/app/'.length));
    if (!f) { res.writeHead(404).end(); return; }
    const ext = path.extname(f);
    const type = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' }[ext];
    const cache = url.searchParams.get('v') === fileVersion(f) ? 'public, max-age=31536000, immutable' : 'no-cache';
    if (ext === '.png') return send(200, type, fs.readFileSync(f), { 'cache-control': cache });
    return sendText(req, res, 200, { 'content-type': type, 'cache-control': cache }, fs.readFileSync(f));
  }
  if (p === '/_hub/api/hub') return sendJSON(200, await hubData(req));
  if (p === '/_hub/api/settings') return sendJSON(200, await settingsData());
  if (p === '/_hub/api/polling') return sendJSON(200, pollingData(url.searchParams.get('w')));
  if (p === '/_hub/push/key') return sendJSON(200, { key: publicKey() });
  if (p === '/_hub/push/subscribe' && req.method === 'POST') {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return sendJSON(200, { count: addSubscription(await readJSONBody(req), `https://${host}/`, req.headers['user-agent']) });
  }
  if (p === '/_hub/push/test' && req.method === 'POST') {
    const results = await sendAll({ title: 'Claude', body: 'Test notification from the hub.', url: '/', tag: 'hub-test' });
    return sendJSON(200, { sent: results.filter((r) => r.status >= 200 && r.status < 300).length, results });
  }
  // set=on|weekends with value=on (absent for off), or snooze=<push.mjs setNotifications choice | off>.
  if (p === '/_hub/settings/notifications' && req.method === 'POST') {
    const f = new URLSearchParams(await readBody(req));
    const set = f.get('set');
    const change = set === 'on' ? { on: f.get('value') === 'on' } : set === 'weekends' ? { weekends_off: f.get('value') === 'on' } : f.has('snooze') ? { snooze: f.get('snooze') } : null;
    const bad = 'Pass set=on or set=weekends with value=on, or snooze.';
    if (!change) return json ? sendJSON(400, { error: bad }) : send(400, 'text/plain; charset=utf-8', bad);
    let r;
    try { r = await setNotifications(change); } catch (e) {
      if (e.status !== 400) throw e;
      return json ? sendJSON(400, { error: SNOOZE_REFUSED }) : redirect(res, '/_hub/?refused=snooze#notifications');
    }
    if (r.dropped) log(`notifications off: dropped ${r.dropped} queued push${r.dropped === 1 ? '' : 'es'}`);
    return json ? sendJSON(200, await settingsData()) : redirect(res, '/_hub/#notifications');
  }
  if (p === '/_hub/settings/keep-awake' && req.method === 'POST') {
    const f = new URLSearchParams(await readBody(req));
    try { setKeepAwake(f.get('keep_awake')); } catch (e) {
      if (e.status === 409) return json ? sendJSON(409, { error: e.message }) : send(409, 'text/plain; charset=utf-8', e.message);
      if (e.status !== 400) throw e;
      return json ? sendJSON(400, { error: AWAKE_REFUSED }) : redirect(res, '/_hub/?refused=keep-awake#keep-awake');
    }
    awake.apply();
    return json ? sendJSON(200, await settingsData()) : redirect(res, '/_hub/#keep-awake');
  }
  if (p === '/_hub/settings/codex' && req.method === 'POST') {
    const f = new URLSearchParams(await readBody(req));
    try { setCodexShare(f.get('value'), readCodex({ fresh: true })); } catch (e) {
      if (e.status !== 400 && e.status !== 409) throw e;
      return json ? sendJSON(e.status, { error: e.message }) : send(e.status, 'text/plain; charset=utf-8', e.message);
    }
    return json ? sendJSON(200, await hubData(req)) : redirect(res, '/_hub/');
  }
  if (['/_hub/settings/pause-at', '/_hub/settings/keep-going'].includes(p) && req.method === 'POST') {
    const f = new URLSearchParams(await readBody(req));
    try {
      if (p.endsWith('/pause-at')) setPauseAt(f.get('value')); else setKeepGoing(f.get('value'));
      await checkUsageGate();
    } catch (e) {
      if (e.status !== 400 && e.status !== 409) throw e;
      return json ? sendJSON(e.status, { error: e.message }) : send(e.status, 'text/plain; charset=utf-8', e.message);
    }
    return json ? sendJSON(200, await hubData(req)) : redirect(res, '/_hub/');
  }
  if (p === '/_hub/settings/linear' && req.method === 'POST') {
    const f = new URLSearchParams(await readBody(req, 4 * 1024));
    try {
      if (f.has('remove')) { removeLinearKey(); log('linear: key removed'); }
      else log(`linear: key ${(await saveLinearKey(f.get('key'))).refused ? 'refused by Linear' : 'saved'}`);
    } catch (e) {
      if (!(e instanceof LinearError)) throw e;
      return json ? sendJSON(e.status, { error: e.message }) : send(e.status, 'text/plain; charset=utf-8', e.message);
    }
    return json ? sendJSON(200, await settingsData()) : redirect(res, '/_hub/#linear');
  }
  if (p === '/_hub/api/linear' && req.method === 'GET') {
    const status = linearStatus();
    if (!status.set || status.refused) return sendJSON(200, status);
    const linear = savedClient();
    try {
      const teams = await linear.teams();
      return sendJSON(200, { ...linearStatus(), teams: teams.map(({ key, name }) => ({ key, name })),
        projects: teams.flatMap((t) => t.projects.map((pr) => ({ id: pr.id, name: pr.name, team: t.key }))) });
    } catch (e) { if (!(e instanceof LinearError)) throw e; return sendJSON(200, { ...linearStatus(), error: e.message }); }
  }
  if (p === '/_hub/linear/projects' && req.method === 'POST') {
    const linear = savedClient();
    if (!linear) return sendJSON(400, { error: 'Add a Linear key on Hub first.' });
    let input;
    try { input = await readJSONBody(req, 4 * 1024); } catch (e) { return sendJSON(e.status || 400, { error: 'Send the team and project name as JSON.' }); }
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 80 || typeof input.team !== 'string' || !/^[A-Z][A-Z0-9]*$/.test(input.team)) return sendJSON(400, { error: 'Name the project and its team.' });
    try { return sendJSON(200, await linear.createProject(input.team, name)); }
    catch (e) { if (!(e instanceof LinearError)) throw e; return sendJSON(e.status, { error: e.message }); }
  }
  // One schedule.mjs editPolling change {op, w, value}.
  if (p === '/_hub/settings/polling' && req.method === 'POST') {
    const f = new URLSearchParams(await readBody(req));
    const op = f.get('op') || '';
    const edit = editPolling(readSettings(), { op, w: f.get('w') || '', value: (f.get('value') || '').trim() });
    try {
      if (edit.error) throw Object.assign(new Error(edit.error), { status: 400 });
      saveSettings(edit.input);
    } catch (e) {
      if (e.status !== 400) throw e;
      return json ? sendJSON(400, { error: e.message }) : send(400, 'text/plain; charset=utf-8', e.message);
    }
    return json ? sendJSON(200, pollingData(edit.select)) : redirect(res, `/_hub/?w=${encodeURIComponent(edit.select)}#polling`);
  }
  if (p === '/_hub/settings/rules' && req.method === 'POST') {
    let body, saved;
    try {
      body = await readJSONBody(req, 64 * 1024);
      saved = applyRules(readHubRules(), body.rules, body.base ?? []);
      if (changed(saved.changes)) writeHubRules(saved.rules);
    } catch (e) {
      if (!(e instanceof RuleError) && !(e instanceof SyntaxError)) throw e;
      return sendJSON(400, { error: e.message });
    }
    if (!changed(saved.changes)) return sendJSON(200, { rules: saved.rules, changed: false, events: [], failed: [] });
    const sent = await sendToBoards(listBoards(loadManifest()), 'rules', { scope: 'hub', ...saved.changes });
    log(`hub rules saved: rules → ${sent.events.map((e) => e.route).join(', ') || 'no board'}${sent.failed.length ? `; ${sent.failed.join('; ')}` : ''}`);
    return sendJSON(200, { rules: saved.rules, changed: true, ...sent });
  }
  if (p === '/_hub/push/flush' && req.method === 'POST') {
    const r = await flushQueue();
    if (r) log(`push queue: ${r.ok ? 'sent' : 'could not send'} ${r.count} queued (from the settings page)`);
    return json ? sendJSON(200, flushView(r)) : redirect(res, `/_hub/settings/polling?flushed=${r ? (r.ok ? r.count : 'failed') : 0}`);
  }
  if (p === '/_hub/poll' && req.method === 'POST') {
    const body = await readJSONBody(req);
    return sendJSON(200, await runPoll({ flush: body.flush !== false }));
  }
  if (p === '/_hub/prompts' && req.method === 'POST') {
    let input;
    try { input = await readJSONBody(req, 8 * 1024 * 1024); } catch (e) { if (e.status) throw e; return sendJSON(400, { error: 'Send the hook input as JSON.' }); }
    if (!input?.tool_name || (input.hook_event_name && input.hook_event_name !== 'PermissionRequest')) return sendJSON(400, { error: 'Send a PermissionRequest hook input.' });
    const { answer, rec } = await updatePrompts((store) => {
      const context = promptContext();
      const board = context.boards.find((b) => b.owner?.session && b.owner.session === input.session_id) || null;
      if (pruneRemembered(store, context)) stream.refresh();
      const answer = rememberedAnswer(store, input);
      if (answer) return { answer };
      const rec = promptRecord(input, { board, live: context.running.get(input.session_id) });
      store.prompts[rec.id] = rec;
      return { rec };
    });
    if (answer) return sendJSON(200, { state: 'answered', answer });
    promptChanged(rec.route);
    log(`prompt ${rec.id}: ${rec.route ? `/${rec.route}` : rec.cwd} ${rec.tool}${rec.action ? ` (${rec.action})` : ''}`);
    deliver(pushOf(rec), { kind: 'prompt', immediate: true }).catch((e) => log(`prompt ${rec.id}: push failed: ${e.message}`));
    return sendJSON(200, { id: rec.id, deadline: rec.deadline });
  }
  const prompt = /^\/_hub\/prompts\/([\w-]+)(\/wait|\/answer)?$/.exec(p);
  if (prompt) return promptRoute(req, res, { id: prompt[1], op: prompt[2]?.slice(1) || null, url, sendJSON });
  return false;
}

async function promptRoute(req, res, { id, op, url, sendJSON }) {
  if (op === 'wait' && req.method === 'GET') {
    const seen = () => updatePrompts((store) => {
      const rec = routeRecord(store.prompts, id);
      if (rec?.answer) delete store.prompts[id];
      else if (rec) rec.seen = new Date().toISOString();
      return rec;
    });
    const take = (rec) => {
      promptChanged(rec.route);
      return sendJSON(200, { state: 'answered', answer: rec.answer });
    };
    const rec = await seen();
    if (!rec) return sendJSON(404, { state: 'gone' });
    if (rec.answer) return take(rec);
    const ms = Math.max(0, Math.min(Number(url.searchParams.get('ms')) || POLL_MS, POLL_MS));
    await new Promise((resolve) => {
      const set = promptWaiters.get(id) || new Set();
      promptWaiters.set(id, set);
      const done = () => { clearTimeout(timer); set.delete(done); if (!set.size && promptWaiters.get(id) === set) promptWaiters.delete(id); resolve(); };
      const timer = setTimeout(done, ms);
      set.add(done);
      res.on('close', done);
    });
    if (res.writableEnded || res.destroyed) return;
    const now = await seen();
    if (!now) return sendJSON(404, { state: 'gone' });
    return now.answer ? take(now) : sendJSON(200, { state: 'pending' });
  }
  if (op === 'answer' && req.method === 'POST') {
    const body = await readJSONBody(req);
    const result = await updatePrompts((store) => {
      const rec = routeRecord(store.prompts, id);
      if (!rec) return { status: 404, error: 'That prompt has expired.' };
      if (rec.answer) return { status: 409, error: 'That prompt was already answered.' };
      const { answer, error } = answerOf(rec, body);
      if (error) return { status: 400, error };
      rec.answer = answer;
      const context = promptContext();
      pruneRemembered(store, context);
      rememberRules(store, rec, context);
      return { rec, answer };
    });
    if (result.error) return sendJSON(result.status, { error: result.error });
    const { rec, answer } = result;
    log(`prompt ${id}: ${answer.choice}`);
    for (const done of [...(promptWaiters.get(id) || [])]) done();
    promptChanged(rec.route);
    return sendJSON(200, { ok: true });
  }
  if (op === null && req.method === 'DELETE') {
    const rec = await updatePrompts((store) => {
      const rec = routeRecord(store.prompts, id);
      delete store.prompts[id];
      return rec;
    });
    if (rec) { promptChanged(rec.route); log(`prompt ${id}: its hook gave up`); }
    return sendJSON(200, { ok: true });
  }
  return false;
}

// One row as the down and missing pages list it.
const row = ({ icon = '', title, sub = '' }) => `<div class="row">${icon}<span class="body"><span class="text"><span class="title">${title}</span>${sub ? `<span class="sub">${sub}</span>` : ''}</span></span></div>`;

function downPage(route, site) {
  const p = procs.get(route) || {};
  const exit = p.exitCode !== undefined && p.exitCode !== null ? ` (last exit: ${p.exitCode})` : '';
  const serves = servesOf(site);
  const [tone, said] = serves === 'port' ? ['down', `down · nothing answers on port ${site.port}`]
    : serves === 'files' ? ['down', 'down · its folder is missing']
      : p.child ? ['wait', 'started · waiting for it to answer'] : ['down', `down · restarting${exit}`];
  const lede = serves === 'cmd' ? 'The hub runs every site and restarts one that stops.' : serves === 'port' ? 'Its session runs this server, so it comes back when that session starts it again.' : 'The hub serves this page from a folder that is no longer there.';
  return `${head(`${site.title || route} is down`, '<meta http-equiv="refresh" content="5">')}
<a class="back" href="/_hub/">‹ Hub</a>
<h1>${esc(site.title || route)} isn't answering</h1>
<p class="lede">${esc(lede)}</p>
<h2 class="label">Site</h2>
<div class="group">${row({ icon: siteIcon(route, site), title: esc(site.title || route), sub: `<span class="st ${tone}">${esc(said)}</span>` })}</div>
<p class="note">This page retries every 5 seconds.</p>
</main></body></html>`;
}

// ---------- proxy ----------
// A path starting with // parses as a host, and "//" alone throws and takes the hub down.
const requestURL = (req) => new URL(req.url.replace(/^\/+/, '/'), 'http://hub');

const server = http.createServer((req, res) => {
  const url = requestURL(req);
  if (req.method !== 'GET' && req.method !== 'HEAD' && crossSite(req.headers)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('Requests must come from the app’s own pages.');
    return;
  }
  const sites = new Set(Object.keys(loadManifest().sites));
  if (pageOf({ method: req.method, pathname: url.pathname, search: url.search, dest: destOf(req.headers), sites }) === 'shell') {
    const here = url.pathname === '/' ? '' : url.pathname.startsWith('/_hub/') ? url.pathname.slice(1) : decodeURIComponent(url.pathname.split('/')[1]);
    shellPage(here).then((html) => sendText(req, res, 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', vary: 'sec-fetch-dest', 'x-app-shell': '1' }, html))
      .catch((e) => { if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }); res.end(String(e.message || e)); });
    return;
  }
  if (url.pathname === '/_hub') { res.writeHead(302, { location: '/_hub/' + url.search }).end(); return; }
  if (url.pathname === '/_hub/status.json') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ hub: { port: PORT, pid: process.pid }, sites: status() }, null, 2)); return; }
  if (url.pathname === '/_hub/needs.json') {
    const rows = status();
    waitingCounts(rows, { fresh: url.searchParams.get('fresh') === '1' }).then((waiting) => {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ total: badgeTotal(waiting), sites: Object.fromEntries(rows.map((r) => [r.route, waiting.get(r.route) ?? null])) }));
    }).catch((e) => { if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }); res.end(String(e.message || e)); });
    return;
  }
  if (url.pathname === '/favicon.ico') { res.writeHead(301, { location: '/_hub/kickflip.png' }).end(); return; }
  if (url.pathname === '/sw.js' || url.pathname === '/manifest.webmanifest' || url.pathname.startsWith('/_hub/')) {
    hubRoute(req, res, url).then((handled) => { if (handled === false) res.writeHead(404).end(); })
      .catch((e) => { if (!res.headersSent) res.writeHead(e.status || 500, { 'content-type': 'text/plain' }); res.end(String(e.message || e)); });
    return;
  }

  const route = url.pathname.split('/')[1];
  const site = routeRecord(loadManifest().sites, route);
  if (!site) { res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }); res.end(`${head('No Site')}<a class="back" href="/_hub/">‹ Hub</a><h1>No site at /${esc(route)}</h1></main></body></html>`); return; }
  if (url.pathname === '/' + route) { res.writeHead(302, { location: '/' + route + '/' + url.search }).end(); return; }

  const prefix = '/' + route;
  const rest = req.url.slice(prefix.length) || '/';
  // The same URL is the shell for a page load and the page itself for its frame, so neither may answer the other.
  const vary = pageOf({ pathname: url.pathname, dest: 'document', sites }) === 'shell';
  if (servesOf(site) === 'files') {
    if (!isFolder(site.dir)) { res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(downPage(route, site)); return; }
    serveFiles(req, res, { dir: site.dir, rest, prefix, headers: vary ? { vary: 'sec-fetch-dest' } : {} })
      .catch((e) => { if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }); res.end(String(e.message || e)); });
    return;
  }
  const headers = { ...req.headers, 'x-forwarded-prefix': prefix, 'x-forwarded-host': req.headers['x-forwarded-host'] || req.headers.host, 'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'https' };
  const up = http.request({ host: '127.0.0.1', port: site.port, method: req.method, path: rest, headers }, (r) => {
    const h = { ...r.headers };
    if (vary) h.vary = [h.vary, 'sec-fetch-dest'].filter(Boolean).join(', ');
    if (typeof h.location === 'string' && h.location.startsWith('/') && !h.location.startsWith('//') && !h.location.startsWith(prefix + '/') && h.location !== prefix) h.location = prefix + h.location;
    res.writeHead(r.statusCode, h);
    r.pipe(res);
    // pipe() never ends res when the site dies mid-response, so a board's /api/stream would hang open on the page.
    r.on('close', () => { if (!r.complete) res.destroy(); });
  });
  // A page that leaves a long-lived response, such as a board's /api/stream, would otherwise keep the site's end open.
  res.on('close', () => { if (!res.writableFinished) up.destroy(); });
  up.on('error', () => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(downPage(route, site));
  });
  req.pipe(up);
});

// WebSockets and other upgrades: pipe the raw sockets through.
server.on('upgrade', (req, socket, head) => {
  const route = requestURL(req).pathname.split('/')[1];
  const site = routeRecord(loadManifest().sites, route);
  if (!site?.port) { socket.destroy(); return; }
  const prefix = `/${route}`;
  const rest = req.url.slice(prefix.length) || '/';
  const up = net.connect(site.port, '127.0.0.1', () => {
    const lines = [`${req.method} ${rest} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() !== 'x-forwarded-prefix') lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    lines.push(`X-Forwarded-Prefix: ${prefix}`);
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
  socket.on('close', () => up.destroy());
  up.on('close', () => socket.destroy());
});

server.listen(PORT, '127.0.0.1', () => log(`hub on http://127.0.0.1:${PORT}/ (manifest ${MANIFEST})`));
