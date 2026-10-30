#!/usr/bin/env node
// web-ts hub: one loopback server that Tailscale sends every request to.
//   /                 the app shell (board/public/app.html), which opens this device's last board, else the board with
//                     the most waiting; a browser's page load of any site's page, such as /<route>/,
//                     /<route>/settings.html or /learn/, gets the shell too (shell.mjs pageOf)
//                     (docs/adr/0055-one-app-for-the-whole-hub.md)
//   /_hub/app/<file>  the shell's scripts and CSS, read from ../board/public then ../starter/public on each request;
//                     ?v=<version> caches for a year
//   /_hub/stream      the shell's one event stream: `change {route}` for each board's change signal and `sidebar` with
//                     /_hub/sidebar.json's data when it changes (stream.mjs)
//   /_hub/, /_hub/settings, /_hub/settings/polling
//                     the hub page, Hub Settings and Polling, views of the shell; any GET of them gets the shell
//   /_hub/api/hub, /_hub/api/settings, /_hub/api/polling?w=HH:MM
//                     those views' data and words (views.mjs)
//   /_hub/sidebar.json what the sidebar shows (board/public/ui-sidebar.js): {total, start,
//                     sites: [{route, title, board, state, count, changedAt, created, icon, sub}], hub: {tone, word, detail, broken},
//                     notifications: {state, text}, polling: {text}}, each site's row from its GET /_claude/needs
//                     (home.mjs; docs/adr/0010-sites-report-what-waits-through-claude-needs.md)
//   /_hub/status.json the manifest's sites and their process state, as JSON
//   /_hub/needs.json  {total, sites: {<route>: {count, working, summary, lanes, building} | null}}: total is the
//                     Home Screen badge; ?fresh=1 skips the cache
//   /<route>/...      forwarded to that site's port with the /<route> prefix
//                     removed (X-Forwarded-Prefix carries it), unless it is a page load the shell takes
//   /sw.js, /manifest.webmanifest, /_hub/icon-*.png
//                     the Home Screen app and its service worker (scope /), which shows pushes and keeps the shell
//                     and its files to open while the Mac can't be reached; the shell's response carries
//                     X-App-Shell: 1, and a request with X-App-Shell: 1 is a page load (shell.mjs destOf)
//   /_hub/colors.css  ../shared/colors.css, the colours the shell and the down page link; ?v=colorsVersion() caches for a year
//   /_hub/kickflip.png the header's image, and /_hub/hub.css the down page's CSS, read from ../board/public
//   /_hub/push/key    GET the VAPID public key; /_hub/push/subscribe and
//                     /_hub/push/test take POSTs from the hub views (push.mjs)
//   The forms below answer the view's JSON when the request accepts application/json, and redirect back with a 303
//   otherwise:
//   /_hub/settings/notifications POST set=on|weekends with value=on (absent for off), or snooze=<push.mjs
//                     setNotifications choice | off> → /_hub/api/settings's JSON, or 400 {error} when refused
//                     (303 to ?refused=snooze)
//   /_hub/settings/polling POST one schedule.mjs editPolling change {op, w, value} → /_hub/api/polling's JSON for the
//                     window to show, or 400 {error}
//   /_hub/push/flush  POST sends the queued pushes now → {sent, count, ok, message}
//   /_hub/settings/rules POST {rules: [{id?, text}], base: [id]} saves the hub rules in settings.json (rules.mjs
//                     applyRules) and, when anything changed, sends every board a `rules {scope: "hub", added, edited,
//                     removed}` event (boards.mjs sendToBoards). → {rules, events, failed}; a bad list → 400 {error}
//   /_hub/poll        POST runs one poll now, or joins the running one, and returns its result as JSON;
//                     {"flush": false} skips sending the queue (`web-ts poll-now`)
// It also runs every site: it starts each manifest entry's `cmd`, restarts it
// when it exits, restarts it when its entry changes, and stops every one before it exits itself. On each slot of the
// polling interval (schedule.mjs), and once a minute after it starts, it checks
// GitHub (github.mjs), pushes once for each board that has stopped listening (boards.mjs
// checkListening), then sends the queued pushes unless schedule.mjs heldUntil holds them;
// one poll never overlaps another. At each of the polling settings' wake times it wakes each
// board's session once a day (github.mjs sendWakes)
// (docs/adr/0025-the-hub-polls-github-and-sends-pushes-on-one-interval.md). Every feature that serves
// boards takes them from boards.mjs listBoards, the one board registry
// (docs/adr/0040-one-board-registry-for-every-hub-feature.md). launchd keeps the
// hub itself running (see ../SKILL.md, `web-ts install`).
// After each poll it records when each board's hub links first failed (boards.mjs recordLinkFaults). As it starts it
// records the hash of its own code (boards.mjs recordHubCode), so a board's hub link can tell when the files changed
// under it (docs/adr/0046-hub-links-turn-red-only-after-a-grace-period.md).
// Once a minute it resumes the recorded session of a board that has stopped listening and whose session isn't running,
// and pushes once when that doesn't bring it back (sessions.mjs checkSessions).
// State lives in ~/.claude/web-ts: manifest.json, logs/<route>.log, run/<route>.pid, github-state.json, wake-state.json,
// deaf-state.json, link-faults.json, hub-code.json, resume-state.json.
import http from 'node:http';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { publicKey, addSubscription, sendAll, flushQueue, queueStatus, saveSettings, readSettings, migrateSettings, setNotifications } from './push.mjs';
import { clock, nextSlot, windowAt, hold, heldUntil, holdLine, editPolling } from './schedule.mjs';
import { capital, every, hubView, settingsView, pollingView, flushView, SNOOZE_REFUSED } from './views.mjs';
import { checkGitHub, sendWakes } from './github.mjs';
import { listBoards, isBoardSite, sendToBoards, checkListening, recordHubCode, recordLinkFaults, linksOf, hubCode, readJSON, HUB_CODE } from './boards.mjs';
import { RuleError, applyRules, changed, readHubRules, writeHubRules } from './rules.mjs';
import { siteIcon } from './icons.mjs';
import { readNeeds, sidebarSites, startRoute, hubHealth } from './home.mjs';
import { checkSessions } from './sessions.mjs';
import { BOARD_PUBLIC, appFile, colorsVersion, destOf, fileVersion, pageOf, shellHtml } from './shell.mjs';
import { hubStream } from './stream.mjs';

const HUB_DIR = path.dirname(fileURLToPath(import.meta.url));
const COLORS = path.join(HUB_DIR, '..', 'shared', 'colors.css');

const HOME = path.join(os.homedir(), '.claude', 'web-ts');
const MANIFEST = path.join(HOME, 'manifest.json');
const LOGS = path.join(HOME, 'logs');
const RUN = path.join(HOME, 'run');
const PORT = Number(process.env.WEB_TS_HUB_PORT || 4500);
for (const d of [HOME, LOGS, RUN]) fs.mkdirSync(d, { recursive: true });

const log = (...a) => console.log(new Date().toISOString(), ...a);
try { const code = recordHubCode(); log(`hub code ${code.hash} (${code.files.length} files)`); } catch (e) { log('could not record the hub code hash:', e.message); }

// ---------- manifest ----------
let manifest = { version: 1, sites: {} };
let manifestMtime = 0;
function loadManifest() {
  try {
    const st = fs.statSync(MANIFEST);
    if (st.mtimeMs !== manifestMtime) {
      manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
      manifest.sites ||= {};
      manifestMtime = st.mtimeMs;
    }
  } catch (e) {
    if (e.code === 'ENOENT') { manifest = { version: 1, sites: {} }; manifestMtime = 0; }
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
  const env = { ...process.env, ...(site.env || {}), PORT: String(site.port), PREFIX: '/' + route, WEB_TS_ROUTE: route };
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
async function reconcile() {
  if (shuttingDown) return;
  const { sites } = loadManifest();
  for (const route of [...procs.keys()]) {
    if (!sites[route]) { log(`${route} left the manifest; stopping it`); stop(route); procs.delete(route); }
  }
  for (const [route, site] of Object.entries(sites)) {
    if (!Array.isArray(site.cmd) || !site.cmd.length || !site.port) continue;
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
    const site = sites[route];
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
const polls = { running: null, startedAt: 0, firstAt: Date.now() + FIRST_POLL_MS, last: null, errorLoggedAt: 0 };

const nextPollAt = () => new Date(polls.startedAt ? nextSlot(new Date(polls.startedAt), readSettings()).getTime() : polls.firstAt);

function runPoll({ flush = true } = {}) {
  if (polls.running) return polls.running;
  const startedAt = new Date();
  polls.startedAt = startedAt.getTime();
  polls.running = (async () => {
    const settings = readSettings();
    let result;
    try { result = await checkGitHub({ every: windowAt(startedAt, settings).every_minutes, manifest: loadManifest() }); }
    catch (e) { result = { at: startedAt.toISOString(), watched: 0, failed: [e.message], changes: [], events: [], checked: [] }; }
    if (result.failed.length && Date.now() - polls.errorLoggedAt > ERROR_LOG_MS) {
      polls.errorLoggedAt = Date.now();
      log(`github check: ${result.failed.length} step${result.failed.length === 1 ? '' : 's'} failed, first: ${result.failed[0]} (logged at most hourly)`);
    }
    if (result.changes.length) log(`github check: ${result.changes.map((c) => `#${c.pr} ${c.changes.join(',')}`).join('; ')} → ${result.events.map((e) => e.route).join(', ') || 'no board'}`);
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

const SESSION_CHECK_MS = 60_000;
const sessionCheck = { running: null, at: 0 };
function runSessionCheck() {
  if (sessionCheck.running || Date.now() - sessionCheck.at < SESSION_CHECK_MS) return;
  sessionCheck.at = Date.now();
  sessionCheck.running = checkSessions({ manifest: loadManifest() }).then((r) => {
    if (r.resumed.length || r.pushed.length || r.failed.length) log(`sessions: resumed ${r.resumed.join(', ') || 'none'}; pushed ${r.pushed.join(', ') || 'none'}${r.failed.length ? `; ${r.failed.join('; ')}` : ''}`);
  }).catch((e) => log('session check failed:', e.message)).finally(() => { sessionCheck.running = null; });
}

setInterval(() => {
  if (!polls.running && Date.now() >= nextPollAt().getTime()) runPoll().catch((e) => log('poll failed:', e.message));
  runWakes();
  runSessionCheck();
}, 15_000);

// Sites run detached, so the hub must not exit while one it started still runs.
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(reconciling);
  log('hub stopping; stopping sites');
  for (const p of procs.values()) if (p.child) p.stopping = true;
  for (const c of children) signal(c, 'SIGTERM');
  const deadline = Date.now() + KILL_AFTER;
  setInterval(() => {
    if (children.size && Date.now() < deadline) return;
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

function status() {
  const { sites } = loadManifest();
  return Object.entries(sites).sort(([a], [b]) => a.localeCompare(b)).map(([route, s]) => {
    const p = procs.get(route) || {};
    const state = p.child ? (p.up ? 'up' : 'starting') : (p.state === 'crashed' ? 'down' : (p.state || 'starting'));
    return {
      route, title: s.title || route, description: s.description || '', icon: s.icon || null, color: s.color || null, port: s.port, state,
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
// fresh: true refetches every site's answer, a Set of routes only those.
async function waitingCounts(rows, { fresh = false } = {}) {
  const up = rows.filter((r) => r.state === 'up');
  for (const r of up) {
    const c = needsCache.get(r.route);
    if (fresh === true || fresh?.has?.(r.route) || !c || Date.now() - c.at >= NEEDS_TTL) needsCache.set(r.route, { at: Date.now(), needs: fetchNeeds(r.port) });
  }
  const needs = await Promise.all(up.map((r) => needsCache.get(r.route).needs));
  return new Map(up.map((r, i) => [r.route, needs[i]]));
}
// A site whose answer is unknown adds nothing.
const badgeTotal = (waiting) => [...waiting.values()].reduce((n, w) => n + (w?.count || 0), 0);

// ---------- sidebar ----------
// Each board's linksOf, cached as long as the sites' needs, since every open page asks for the sidebar.
const linksCache = { at: 0, value: null };
function boardLinks(boards) {
  if (linksCache.value && Date.now() - linksCache.at < NEEDS_TTL) return linksCache.value;
  const value = {};
  for (const b of boards) { try { value[b.route] = linksOf(b); } catch (e) { log(`links of ${b.route} failed:`, e.message); value[b.route] = []; } }
  Object.assign(linksCache, { at: Date.now(), value });
  return value;
}

// What /_hub/sidebar.json serves, with each board's links and the status rows behind it for the hub's page.
async function sidebarState({ fresh = false } = {}) {
  const now = new Date();
  const rows = status();
  const waiting = await waitingCounts(rows, { fresh });
  const boards = listBoards(loadManifest());
  const links = boardLinks(boards);
  const sites = sidebarSites(rows, waiting, new Set(boards.map((b) => b.route)));
  const settings = readSettings();
  const held = hold(now, settings);
  const data = {
    total: badgeTotal(waiting), start: startRoute(sites), sites, hub: hubHealth(sites, links),
    notifications: !held ? { state: 'on', text: 'On' } : held.why === 'off' ? { state: 'off', text: 'Off' } : { state: 'held', text: capital(holdLine(held, now)) },
    polling: { text: `Every ${every(windowAt(now, settings).every_minutes)} · next ${clock(nextPollAt(), now)}` },
  };
  return { data, links, rows };
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
// it, so the first paint has both. here is the route whose row reads current, '_hub' for the hub's page. "<" is
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
async function readJSONBody(req) {
  const body = await readBody(req);
  return body ? JSON.parse(body) : {};
}

// The page the hub answers a site that is down or missing with, which a frame or curl gets too.
const head = (title, extra = '') => `<!doctype html><html lang="en" class="hub-view"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="${iconUrl(180)}">
<meta name="apple-mobile-web-app-title" content="Claude">${extra}<link rel="stylesheet" href="/_hub/colors.css?v=${colorsVersion()}"><link rel="stylesheet" href="/_hub/hub.css"></head><body><main>`;

// ---------- hub views ----------
// The hub's pages are views of the app shell (board/public/view-hub.js, view-hub-settings.js, view-polling.js), which
// take their words from views.mjs through /_hub/api/*. A form POST that asks for JSON gets the view's data back; any
// other gets a 303 back to the page.
const wantsJSON = (req) => /\bapplication\/json\b/.test(req.headers.accept || '');
const pollState = () => ({ running: Boolean(polls.running), nextAt: nextPollAt(), last: polls.last });
// Each change on the Polling page posts op and w (the selected window's start); a 303 lands back at `anchor`.
const POLLING_ANCHOR = { from: 'day', every: 'day', split: 'day', remove: 'day', hold: 'quiet', 'wake-add': 'wakes', 'wake-remove': 'wakes' };

async function hubData(req) {
  const now = new Date();
  const { data, links, rows } = await sidebarState();
  return hubView({
    now, st: queueStatus(now), poll: pollState(), sidebar: data, rows, links, rules: readHubRules(),
    code: { running: readJSON(HUB_CODE, null)?.hash, onDisk: hubCode().hash }, host: req.headers['x-forwarded-host'] || req.headers.host || '',
  });
}
const settingsData = () => { const now = new Date(); return settingsView({ now, st: queueStatus(now), rules: readHubRules() }); };
const pollingData = (select) => { const now = new Date(); return pollingView({ now, st: queueStatus(now), poll: pollState(), select }); };

const redirect = (res, location) => { res.writeHead(303, { location, 'cache-control': 'no-store' }); res.end(); };

async function hubRoute(req, res, url) {
  const send = (code, type, body, extra = {}) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...extra }); res.end(body); };
  const sendJSON = (code, v) => send(code, 'application/json', JSON.stringify(v));
  const json = wantsJSON(req);
  const p = url.pathname;
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
  if (p === '/_hub/api/settings') return sendJSON(200, settingsData());
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
      return json ? sendJSON(400, { error: SNOOZE_REFUSED }) : redirect(res, '/_hub/settings?refused=snooze');
    }
    if (r.dropped) log(`notifications off: dropped ${r.dropped} queued push${r.dropped === 1 ? '' : 'es'}`);
    return json ? sendJSON(200, settingsData()) : redirect(res, '/_hub/settings');
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
    return json ? sendJSON(200, pollingData(edit.select)) : redirect(res, `/_hub/settings/polling?w=${encodeURIComponent(edit.select)}#${POLLING_ANCHOR[op]}`);
  }
  if (p === '/_hub/settings/rules' && req.method === 'POST') {
    let body, saved;
    try {
      body = JSON.parse((await readBody(req, 64 * 1024)) || '{}');
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
  return false;
}

// One row as the down and missing pages list it.
const row = ({ icon = '', title, sub = '' }) => `<div class="row">${icon}<span class="body"><span class="text"><span class="title">${title}</span>${sub ? `<span class="sub">${sub}</span>` : ''}</span></span></div>`;

function downPage(route, site) {
  const p = procs.get(route) || {};
  const exit = p.exitCode !== undefined && p.exitCode !== null ? ` (last exit: ${p.exitCode})` : '';
  const [tone, said] = p.child ? ['wait', 'started · waiting for it to answer'] : ['down', `down · restarting${exit}`];
  return `${head(`${site.title || route} is down`, '<meta http-equiv="refresh" content="5">')}
<a class="back" href="/_hub/">‹ Hub</a>
<h1>${esc(site.title || route)} isn't answering</h1>
<p class="lede">The hub runs every site and restarts one that stops.</p>
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
  const sites = new Set(Object.keys(loadManifest().sites));
  if (pageOf({ method: req.method, pathname: url.pathname, search: url.search, dest: destOf(req.headers), sites }) === 'shell') {
    const here = url.pathname === '/_hub/' ? '_hub' : url.pathname === '/' || url.pathname.startsWith('/_hub/') ? '' : decodeURIComponent(url.pathname.split('/')[1]);
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
  if (url.pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
  if (url.pathname === '/sw.js' || url.pathname === '/manifest.webmanifest' || url.pathname.startsWith('/_hub/')) {
    hubRoute(req, res, url).then((handled) => { if (handled === false) res.writeHead(404).end(); })
      .catch((e) => { if (!res.headersSent) res.writeHead(e.status || 500, { 'content-type': 'text/plain' }); res.end(String(e.message || e)); });
    return;
  }

  const route = url.pathname.split('/')[1];
  const site = loadManifest().sites[route];
  if (!site) { res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }); res.end(`${head('No Site')}<a class="back" href="/_hub/">‹ Hub</a><h1>No site at /${esc(route)}</h1></main></body></html>`); return; }
  if (url.pathname === '/' + route) { res.writeHead(302, { location: '/' + route + '/' + url.search }).end(); return; }

  const prefix = '/' + route;
  const rest = req.url.slice(prefix.length) || '/';
  const headers = { ...req.headers, 'x-forwarded-prefix': prefix, 'x-forwarded-host': req.headers['x-forwarded-host'] || req.headers.host, 'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'https' };
  const up = http.request({ host: '127.0.0.1', port: site.port, method: req.method, path: rest, headers }, (r) => {
    const h = { ...r.headers };
    // The same URL is the shell for a page load and the page itself for its frame, so neither may answer the other.
    if (pageOf({ pathname: url.pathname, dest: 'document', sites }) === 'shell') h.vary = [h.vary, 'sec-fetch-dest'].filter(Boolean).join(', ');
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
  const site = loadManifest().sites[route];
  if (!site) { socket.destroy(); return; }
  const rest = req.url.slice(route.length + 1) || '/';
  const up = net.connect(site.port, '127.0.0.1', () => {
    const lines = [`${req.method} ${rest} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    lines.push(`X-Forwarded-Prefix: /${route}`);
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

server.listen(PORT, '127.0.0.1', () => log(`hub on http://127.0.0.1:${PORT}/ (manifest ${MANIFEST})`));
