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
//   /_hub/            the hub's status page: each site's health, its board links and watcher, polling and notifications
//   /_hub/sidebar.json what the sidebar of every board and hub page shows (board/public/ui-sidebar.js): {total, start,
//                     sites: [{route, title, board, state, count, changedAt, icon, sub}], hub: {tone, word, detail, broken},
//                     notifications: {state, text}, polling: {text}}, each site's row from its GET /_claude/needs
//                     (home.mjs; docs/adr/0010-sites-report-what-waits-through-claude-needs.md)
//   /_hub/status.json the manifest's sites and their process state, as JSON
//   /_hub/needs.json  {total, sites: {<route>: {count, working, summary, lanes, building} | null}}: total is the
//                     Home Screen badge; ?fresh=1 skips the cache
//   /<route>/...      forwarded to that site's port with the /<route> prefix
//                     removed (X-Forwarded-Prefix carries it), unless it is a page load the shell takes
//   /sw.js, /manifest.webmanifest, /_hub/icon-*.png
//                     the Home Screen app and its push service worker (scope /)
//   /_hub/colors.css  ../shared/colors.css, the colours every hub page links before hub.css; ?v=colorsVersion() caches for a year
//   /_hub/kickflip.png the header's image, and /_hub/dialogs.js and /_hub/page-header.js the header's scripts,
//                     /_hub/rules-editor.js Settings' rules editor, /_hub/ui-page-header.js, /_hub/ui-sidebar.js,
//                     /_hub/sidebar.js and /_hub/sidebar.css the sidebar, and /_hub/hub.css the hub pages' CSS, read from ../board/public
//   /_hub/push/key    GET the VAPID public key; /_hub/push/subscribe and
//                     /_hub/push/test take POSTs from the hub and Settings pages (push.mjs)
//   /_hub/settings    GET the hub's Settings page; POST /_hub/settings/notifications takes set=on|weekends with
//                     value=on (absent for off), or snooze=<push.mjs setNotifications choice | off>, then redirects back,
//                     adding ?refused=snooze when setNotifications refuses the change
//   /_hub/settings/rules POST {rules: [{id?, text}], base: [id]} saves the hub rules in settings.json (rules.mjs
//                     applyRules) and, when anything changed, sends every board a `rules {scope: "hub", added, edited,
//                     removed}` event (boards.mjs sendToBoards). → {rules, events, failed}; a bad list → 400 {error}
//   /_hub/settings/polling GET the Polling page, ?w=HH:MM selecting a window; POST takes one schedule.mjs
//                     editPolling change {op, w, value}, saves it and redirects back with the window to show
//   /_hub/push/flush  POST sends the queued pushes now
//   /_hub/poll        POST runs one poll now, or joins the running one, and returns its result as JSON;
//                     {"flush": false} skips sending the queue (`web-ts poll-now`)
// It also runs every site: it starts each manifest entry's `cmd`, restarts it
// when it exits, and restarts it when its entry changes. On each slot of the
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
import { clock, nextSlot, windowAt, hold, heldUntil, holdLine, checksIn, checksADay, holdsOvernight, daySegments, splitPoint, editPolling, snoozeEnd, localDay } from './schedule.mjs';
import { checkGitHub, sendWakes } from './github.mjs';
import { listBoards, isBoardSite, sendToBoards, checkListening, recordHubCode, recordLinkFaults, linksOf, hubCode, readJSON, HUB_CODE } from './boards.mjs';
import { RuleError, applyRules, changed, readHubRules, writeHubRules } from './rules.mjs';
import { siteIcon } from './icons.mjs';
import { readNeeds, sidebarSites, startRoute, hubHealth } from './home.mjs';
import { checkSessions } from './sessions.mjs';
import { BOARD_PUBLIC, appFile, colorsVersion, fileVersion, pageOf, shellHtml } from './shell.mjs';
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
  child.on('error', (e) => log(`${route} spawn error: ${e.message}`));
  child.on('exit', (code, signal) => {
    if (p.child !== child) return;
    try { fs.unlinkSync(pidFile(route)); } catch {}
    const ranLong = Date.now() - p.since > 60_000;
    if (ranLong) p.restarts = 0;
    Object.assign(p, { child: null, state: p.stopping ? 'stopped' : 'crashed', exitCode: code ?? signal, nextStart: Date.now() + backoff(p.restarts++) });
    p.stopping = false;
    log(`${route} exited (${code ?? signal})`);
  });
}

const backoff = (n) => Math.min(60_000, 1000 * 2 ** Math.min(n, 6));

function stop(route) {
  const p = procs.get(route);
  if (!p || !p.child) { procs.delete(route); return; }
  p.stopping = true;
  try { process.kill(-p.child.pid, 'SIGTERM'); } catch {}
  const c = p.child;
  setTimeout(() => { try { if (c.exitCode === null) process.kill(-c.pid, 'SIGKILL'); } catch {} }, 5000);
}

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
setInterval(() => reconcile().catch((e) => log('reconcile failed:', e.message)), 2000);
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

function shutdown() {
  log('hub stopping; stopping sites');
  for (const route of procs.keys()) stop(route);
  setTimeout(() => process.exit(0), 1500);
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
      exitCode: p.exitCode ?? null, owner: s.owner || null, changedAt: changedAt(route, s) || null,
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

const row = ({ icon = '', title, when = '', sub = '', subCls = '', wrap = false, trail = '', href, cls = '', attrs = '' }) => {
  const head = when ? `<span class="title with-time"><span class="name">${title}</span><span class="when">${when}</span></span>` : `<span class="title">${title}</span>`;
  const inner = `${icon}<span class="body"><span class="text">${head}${sub ? `<span class="sub${wrap ? ' wrap' : ''}${subCls ? ` ${subCls}` : ''}">${sub}</span>` : ''}</span>${trail}</span>`;
  return href ? `<a class="row ${cls}" href="${esc(href)}"${attrs}>${inner}</a>` : `<div class="row ${cls}"${attrs}>${inner}</div>`;
};
const CHEVRON = '<span class="chev" aria-hidden="true">›</span>';
const TILE_PATHS = {
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/>',
  snooze: '<path d="M4 10h6l-6 8h6"/><path d="M14 4h6l-6 8h6"/>',
  sunrise: '<path d="M12 2v6"/><path d="m5 10 1.5 1.5"/><path d="m19 10-1.5 1.5"/><path d="M2 18h20"/><path d="M16 18a4 4 0 0 0-8 0"/><path d="m9 5 3-3 3 3"/>',
};
const tile = (key, color) => `<span class="icon sm solid" style="--c:${color}"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TILE_PATHS[key]}</svg></span>`;

// Read on each page, so an edit to the board's header renderer shows without a hub restart.
function pageHeader(options) {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(BOARD_PUBLIC, 'ui-page-header.js'), 'utf8'), context);
  return context.BoardUI.header({ logoSrc: '/_hub/kickflip.png', settingsHref: '/_hub/settings', ...options });
}
const HEADER_SCRIPTS = '<script src="/_hub/dialogs.js"></script><script src="/_hub/page-header.js"></script><script>PageHeader.wire();</script>';

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

// The sidebar for a hub page or the app shell, drawn on the hub so it shows at first paint, then kept fresh by
// sidebar.js. here is the route whose row reads current, '_hub' for the hub's page; state, a sidebarState() result
// already in hand. json is its data for a script; "<" is escaped so no site's title can close the script.
async function sidebar(here = '', state = null) {
  const { data } = state || await sidebarState();
  const context = vm.createContext({});
  for (const file of ['ui-page-header.js', 'ui-sidebar.js']) vm.runInContext(fs.readFileSync(path.join(BOARD_PUBLIC, file), 'utf8'), context);
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const rows = context.BoardUI.sidebar(data, { here });
  return {
    rows, json,
    html: `<aside id="sidebar" class="sidebar" aria-label="Boards">${rows}</aside><div id="sidebarScrim" class="sidebar-scrim"></div>`,
    scripts: `<script src="/_hub/ui-page-header.js"></script><script src="/_hub/ui-sidebar.js"></script><script src="/_hub/sidebar.js"></script><script>Sidebar.mount({ here: ${JSON.stringify(here)}, data: ${json} });</script>`,
  };
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

// The app shell with the sidebar drawn in and its data beside it, so the first paint has both; `/` passes no route, a
// board's page its own.
async function shellPage(route) {
  const side = await sidebar(route);
  return shellHtml({ sidebar: side.rows, sidebarData: side.json, touchIcon: iconUrl(180) });
}

const stream = hubStream({
  targets: () => Object.entries(loadManifest().sites).filter(([, s]) => isBoardSite(s) && s.port).map(([route, s]) => ({ route, port: s.port })),
  sidebar: async ({ fresh }) => (await sidebarState({ fresh })).data,
  log,
});

// iOS allows web push only in a Home Screen app, and asks for permission only
// from a tap, so requestPermission runs first in the click handler.
const PUSH_JS = `(() => {
  const box = document.getElementById('push');
  const group = document.getElementById('pushGroup');
  const lead = box.innerHTML;
  const updated = document.getElementById('status');
  const loaded = Date.now();
  let busy = false;
  const refresh = document.getElementById('refresh');
  const reload = () => { refresh.disabled = true; refresh.classList.add('spinning'); location.reload(); };
  setTimeout(function again() {
    // Unsaved rule edits ([data-dirty], rules-editor.js), a box being typed in or an open sidebar drawer hold the reload.
    if (!busy && !document.hidden && !document.querySelector('dialog[open], [data-dirty], textarea:focus, .sidebar.open')) { reload(); return; }
    const m = Math.round((Date.now() - loaded) / 60000);
    updated.textContent = m < 1 ? 'now' : m < 60 ? m + ' min' : Math.round(m / 60) + ' h';
    setTimeout(again, 30000);
  }, 30000);
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const keyBytes = (k) => Uint8Array.from(atob(k.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const post = (p, body) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
  async function current() {
    const reg = await navigator.serviceWorker.getRegistration('/');
    return reg && reg.pushManager.getSubscription();
  }
  function show(title, sub, action, on = false) {
    box.innerHTML = lead + '<span class="body"><span class="text"><span class="title"></span><span class="sub wrap"></span></span></span>';
    box.querySelector('.title').textContent = title;
    box.querySelector('.sub').textContent = sub;
    if (action) {
      const b = document.createElement('button');
      b.className = action.quiet ? 'btn quiet' : 'btn';
      b.textContent = action.label;
      b.onclick = action.run;
      box.querySelector('.body').append(b);
    }
    box.hidden = false;
    if (group) group.hidden = on;
  }
  async function render() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      if (ios && !standalone) show('Add to Home Screen', 'Tap Share, then Add to Home Screen, and open Claude from your Home Screen to turn on notifications.');
      return;
    }
    if (Notification.permission === 'denied') { show('Notifications are blocked', 'Allow them in ' + (ios ? 'Settings → Notifications → Claude.' : "this browser's site settings.")); return; }
    const sub = await current();
    if (sub) {
      post('/_hub/push/subscribe', sub.toJSON()).catch(() => {});
      show('This device', 'On · ' + box.dataset.now, { label: 'Test', quiet: true, run: async (e) => {
        e.target.disabled = true;
        const r = await post('/_hub/push/test').catch(() => null);
        e.target.textContent = r && r.sent ? 'Sent' : 'Could not send';
      } }, true);
    } else {
      show('This device', 'Off · Claude sessions tell you here when something needs you.', { label: 'Turn on', run: enable });
    }
  }
  async function enable(e) {
    busy = true;
    e.target.disabled = true;
    try {
      if (await Notification.requestPermission() !== 'granted') { render(); return; }
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;
      const { key } = await (await fetch('/_hub/push/key')).json();
      const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
      await post('/_hub/push/subscribe', sub.toJSON());
      render();
    } catch (err) { show('Could not turn on notifications', String(err && err.message || err)); }
    finally { busy = false; }
  }
  render();
})();`;

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

const nowLine = (st, now = new Date()) => `checks every ${st.window.every_minutes} min until ${clock(st.window.endsAt, now)}${st.hold ? `; ${holdLine(st.hold, now)}` : ''}`;
const capital = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const timeOfDay = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); const d = new Date(); d.setHours(h, m, 0, 0); return clock(d, d); };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const pollingSummary = (s) => [`${plural(s.windows.length, 'window')}, ${checksADay(s)} checks a day`, holdsOvernight(s) && 'held overnight',
  s.wakes.length ? `wakes ${s.wakes.map(timeOfDay).join(', ')}` : 'no wakes'].filter(Boolean).join(' · ');

// A rail the owner collapsed stays collapsed from the first paint (board/public/sidebar.js and app.html keep the same key).
const COLLAPSED_JS = `<script>try { if (localStorage.getItem('hub:sidebarCollapsed') === '1') document.documentElement.classList.add('sb-collapsed'); } catch {}</script>`;
// side: a sidebar() result, which puts the sidebar beside the page.
const head = (title, extra = '', top = '', side = null) => `<!doctype html><html lang="en" class="hub-view"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="${iconUrl(180)}">
<meta name="apple-mobile-web-app-title" content="Claude">${extra}<link rel="stylesheet" href="/_hub/colors.css?v=${colorsVersion()}"><link rel="stylesheet" href="/_hub/hub.css">${side ? `<link rel="stylesheet" href="/_hub/sidebar.css">${COLLAPSED_JS}` : ''}</head><body${side ? ' class="has-sidebar"' : ''}>${side ? side.html : ''}${top}<main${top ? ' class="has-top"' : ''}>`;

function pollLine(now) {
  if (polls.running) return 'Checking GitHub now';
  const next = `Next check ${clock(nextPollAt(), now)}`;
  const last = polls.last;
  if (!last) return next;
  const what = last.failed.length ? 'could not reach GitHub for every PR' : last.watched ? `${last.watched} PR${last.watched === 1 ? '' : 's'}, ${last.changes.length ? `${last.changes.length} changed` : 'no change'}` : 'no PRs watched';
  return `${next} · last ${clock(new Date(last.at), now)}, ${what}`;
}

const EVERY_CHOICES = [5, 10, 15, 30, 60, 120];
const every = (n) => (n >= 60 && n % 60 === 0 ? `${n / 60} h` : `${n} min`);
const minuteOf = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const pct = (m) => `${((m / 1440) * 100).toFixed(3)}%`;
// Darker checks more often: 5 minutes is the full accent, 120 is 30% of it.
const shade = (n) => Math.round(100 - (Math.log(n / 5) / Math.log(24)) * 70);
const windowRange = (s, i) => (s.windows.length === 1 ? 'All day' : `${timeOfDay(s.windows[i].from)} – ${timeOfDay(s.windows[(i + 1) % s.windows.length].from)}`);
// Each change on the Polling page posts op and w (the selected window's start) here, and the page comes back at `anchor`.
const pollingForm = (op, w, inner, attrs = '') => `<form method="post" action="/_hub/settings/polling"${attrs}>${op ? `<input type="hidden" name="op" value="${op}">` : ''}<input type="hidden" name="w" value="${esc(w)}">${inner}</form>`;
const POLLING_ANCHOR = { from: 'day', every: 'day', split: 'day', remove: 'day', hold: 'quiet', 'wake-add': 'wakes', 'wake-remove': 'wakes' };
// A time input saves once its picker closes, so turning an iOS wheel doesn't save each value it passes.
const AUTOSAVE_JS = `document.querySelectorAll('input[data-autosave]').forEach((el) => {
  const save = () => { if (el.value && el.value !== el.defaultValue && el.checkValidity()) el.form.submit(); };
  el.addEventListener('blur', save);
  el.addEventListener('change', () => { if (document.activeElement !== el) save(); });
});`;

function dayBar(s, sel, now) {
  const segs = daySegments(s).map((g) => {
    const w = s.windows[g.window];
    const label = g.end - g.start >= 110 ? `<span>${esc(every(w.every_minutes).replace(' min', 'm').replace(' h', 'h'))}</span>` : '';
    return `<a class="seg${g.window === sel ? ' sel' : ''}${g.held ? ' held' : ''}" href="?w=${encodeURIComponent(w.from)}#day" style="left:${pct(g.start)};width:${pct(g.end - g.start)};--k:${shade(w.every_minutes)}%"`
      + ` aria-label="${esc(`${windowRange(s, g.window)}, every ${every(w.every_minutes)}${g.held ? ', pushes held' : ''}`)}"${g.window === sel ? ' aria-current="true"' : ''}>${label}</a>`;
  }).join('');
  const pins = s.wakes.map((w) => `<span class="pin" style="left:${pct(minuteOf(w))}" title="Wake ${esc(timeOfDay(w))}" aria-hidden="true">▼</span>`).join('');
  const nowAt = now.getHours() * 60 + now.getMinutes();
  const ticks = ['12am', '6am', '12pm', '6pm', '12am'].map((t, i) => `<span style="left:${i * 25}%">${t}</span>`).join('');
  const legend = ['<span><i style="background:var(--accent)"></i>darker checks more often</span>',
    holdsOvernight(s) && '<span><i style="background:repeating-linear-gradient(135deg,var(--accent) 0 3px,var(--chip) 3px 5px)"></i>pushes held</span>',
    s.wakes.length && '<span style="color:var(--color-notice)">▼ wake</span>',
    '<span><i style="background:var(--color-danger);width:2px"></i>now</span>'].filter(Boolean).join('');
  return `<div class="day">${pins}<span class="now" style="left:${pct(nowAt)}" aria-hidden="true"></span><div class="bar">${segs}</div><div class="ticks" aria-hidden="true">${ticks}</div></div><div class="legend">${legend}</div>`;
}

// select: the start of the window to show, from ?w=; the window `now` falls in when it names none.
function pollingPage({ select, flash, error, side = null } = {}) {
  const now = new Date();
  const st = queueStatus(now);
  const s = st.settings;
  const found = s.windows.findIndex((w) => w.from === select);
  const sel = found >= 0 ? found : s.windows.findIndex((w) => w.from === windowAt(now, s).from);
  const w = s.windows[sel];
  const one = s.windows.length === 1;
  const queued = st.count ? `${st.count} push${st.count === 1 ? '' : 'es'} queued; next send ${clock(st.nextFlushAt, now)}.` : 'No pushes queued.';
  const [first, last] = [s.windows[0], s.windows.at(-1)];
  const holdSub = one ? 'With one window there is no overnight to hold.' : `Pushes queued after ${timeOfDay(last.from)} wait until ${timeOfDay(first.from)}. GitHub checks still run.`;
  const choices = [...new Set([...EVERY_CHOICES, w.every_minutes])].sort((a, b) => a - b);
  const chips = choices.map((m) => `<button class="btn${m === w.every_minutes ? '' : ' quiet'}" name="value" value="${m}"${m === w.every_minutes ? ' aria-pressed="true"' : ''}>${every(m)}</button>`).join('');
  const wakeChips = s.wakes.map((t) => `<button class="btn quiet" name="value" value="${esc(t)}" aria-label="Remove the ${esc(timeOfDay(t))} wake">${esc(timeOfDay(t))} ✕</button>`).join('');
  const top = pageHeader({ lead: 'back', backHref: '/_hub/settings', backLabel: 'Settings', title: 'Polling', time: 'now' });
  return `${head('Polling', '', top, side)}
${error ? `<div class="flash error" role="alert">${esc(error)}</div>` : flash ? `<div class="flash" role="status">${esc(flash)}</div>` : ''}
<h2 class="label" style="margin-top:4px">Now</h2>
<div class="group">${row({ title: esc(capital(nowLine(st, now))), sub: `<span class="sub wrap">${esc(pollLine(now))}</span><span class="sub wrap">${esc(queued)}</span>`,
  trail: `<form method="post" action="/_hub/push/flush"><button class="btn quiet" ${st.count ? '' : 'disabled'}>Send now</button></form>` })}</div>
<p class="note">Each check looks at every open PR on a board's card on GitHub, wakes a board's session when one changed, then sends the queued pushes. Times are this Mac's.</p>
<h2 class="label" id="day">Your day</h2>
<div class="group"><div class="block">${dayBar(s, sel, now)}</div></div>
<p class="note">Tap a stretch of the bar to change it. Each window runs until the next one starts.</p>
<h2 class="label" id="window">${esc(windowRange(s, sel))}</h2>
<div class="group">
${pollingForm('from', w.from, `<label class="body"><span class="text title">Starts</span><input type="time" name="value" value="${esc(w.from)}" required data-autosave></label>`, ' class="row field"')}
${row({ title: 'Ends', sub: 'Where the next window starts', trail: `<span class="val">${one ? '—' : esc(timeOfDay(s.windows[(sel + 1) % s.windows.length].from))}</span>` })}
${pollingForm('every', w.from, `<span class="title">Checks every</span><span class="chips">${chips}</span><span class="sub" style="margin-top:6px">${plural(checksIn(s, sel), 'check')} in this window</span>`, ' class="block"')}
${pollingForm('', w.from, `<button class="btn quiet" name="op" value="split"${splitPoint(s, sel) ? '' : ' disabled'}>Split in two</button><button class="btn quiet danger" name="op" value="remove"${one ? ' disabled' : ''}>Remove</button>`, ' class="block split"')}
</div>
<h2 class="label" id="quiet">Quiet times</h2>
<div class="group">${pollingForm('hold', w.from, `${tile('moon', '#6366f1')}<label class="body"><span class="text"><span class="title">Hold pushes overnight</span><span class="sub wrap">${esc(holdSub)}</span></span><input type="checkbox" name="value" value="on" class="toggle" onchange="this.form.submit()"${s.hold_overnight ? ' checked' : ''}></label>`, ' class="row field"')}</div>
<h2 class="label" id="wakes">Daily wakes</h2>
<div class="group"><div class="block"><span class="sub wrap">At each time, once a day, every board's session checks GitHub even when nothing changed, so the morning push and reviewer digests go out.</span>
<div class="chips">${wakeChips ? pollingForm('wake-remove', w.from, wakeChips) : ''}${pollingForm('wake-add', w.from, `<input type="time" name="value" required aria-label="New wake time"><button class="btn quiet">+ Add</button>`, ' class="field"')}</div></div></div>
</main>${HEADER_SCRIPTS}${side?.scripts || ''}<script>${AUTOSAVE_JS}</script></body></html>`;
}

// Each value is a schedule.mjs snoozeEnd choice.
const SNOOZE_CHOICES = [['1h', '1 hour'], ['3h', '3 hours'], ['tonight', 'Until tonight'], ['morning', 'Until morning'], ['monday', 'Until Monday'], ['1w', '1 week']];
const NOTIFY_ACTION = '/_hub/settings/notifications';
// The page reloads itself every 30 seconds, and dropping ?refused stops a reload showing the error again.
const NOTIFY_JS = `(() => {
  if (location.search) history.replaceState(null, '', location.pathname);
  const on = document.getElementById('notifyOn');
  on.addEventListener('change', async () => {
    if (on.checked) { on.form.submit(); return; }
    if (await BoardDialogs.confirm(on.dataset.confirm)) on.form.submit(); else on.checked = true;
  });
  const sheet = document.getElementById('snoozeSheet');
  if (!sheet) return;
  document.querySelectorAll('[data-snooze-open]').forEach((b) => b.addEventListener('click', () => sheet.showModal()));
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); });
})();`;

// The value a datetime-local input takes for `d` on this Mac's clock, "2026-10-23T15:30".
const localInput = (d) => `${localDay(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
function timeLeft(until, now) {
  const m = Math.max(1, Math.round((until - now) / 60_000));
  return m < 60 ? `${m} min left` : m < 1440 ? `${Math.round(m / 60)} h left` : `${plural(Math.round(m / 1440), 'day')} left`;
}

function snoozeBanner(until, now) {
  return `<div class="banner" role="status">${tile('snooze', '#a855f7')}<span class="text"><span class="title">Snoozed until ${esc(clock(until, now))}</span><span class="sub wrap">${esc(timeLeft(until, now))} · urgent pushes still go</span></span>`
    + `<button class="btn quiet" type="button" data-snooze-open aria-haspopup="dialog">Extend</button><form method="post" action="${NOTIFY_ACTION}"><button class="btn quiet" name="snooze" value="off">End</button></form></div>`;
}

// The sheet the Snooze row and the banner's Extend open. Until tonight shows only while it ends today. While snoozed
// the sheet extends the snooze, so a choice that ends no later than `until` is disabled.
function snoozeSheet(s, until, now) {
  const choices = SNOOZE_CHOICES.map(([value, label]) => ({ value, label, end: snoozeEnd(now, value, s) }))
    .filter((c) => c.end && (c.value !== 'tonight' || localDay(c.end) === localDay(now)));
  const rows = choices.map(({ value, label, end }) => `<button class="row" form="snoozePick" name="snooze" value="${value}"${until && end <= until ? ' disabled' : ''}><span class="body"><span class="text title">${esc(label)}</span><span class="val">until ${esc(clock(end, now))}</span></span></button>`).join('');
  const max = new Date(now.getTime() + 30 * 86_400_000);
  return `<dialog class="sheet" id="snoozeSheet" aria-labelledby="snoozeTitle"><div class="sheet-body"><div class="grab" aria-hidden="true"></div><h2 id="snoozeTitle">${until ? 'Extend snooze' : 'Snooze pushes'}</h2>
<div class="group">${rows}<div class="row field"><input type="datetime-local" form="snoozeAt" name="snooze" required min="${localInput(until || now)}" max="${localInput(max)}" aria-label="Snooze until a date and time"><button class="btn" form="snoozeAt">Snooze</button></div></div>
<form id="snoozePick" method="post" action="${NOTIFY_ACTION}"></form><form id="snoozeAt" method="post" action="${NOTIFY_ACTION}"></form>
<form method="dialog"><button class="cancel">Cancel</button></form></div></dialog>`;
}

const snoozedUntil = (n, now) => (n.on && n.snoozed_until && new Date(n.snoozed_until) > now ? new Date(n.snoozed_until) : null);

// The on/off, weekend and snooze controls (docs/adr/0032-notifications-can-be-off-snoozed-or-off-on-weekends.md).
function notificationRows(st, now) {
  const s = st.settings;
  const n = s.notifications;
  const [first, last] = [s.windows[0], s.windows[s.windows.length - 1]];
  const action = NOTIFY_ACTION;
  const toggle = ({ icon, set, title, sub, checked, attrs = '' }) => `<form class="row field" method="post" action="${action}"><input type="hidden" name="set" value="${set}">${icon}<label class="body"><span class="text"><span class="title">${title}</span><span class="sub wrap">${esc(sub)}</span></span><input type="checkbox" name="value" value="on" class="toggle"${attrs}${checked ? ' checked' : ''}></label></form>`;
  const queued = st.count ? ` The ${st.count} queued push${st.count === 1 ? ' is' : 'es are'} dropped now.` : '';
  const onRow = toggle({ icon: tile('power', n.on ? '#22c55e' : '#6b7280'), set: 'on', title: 'Push notifications', checked: n.on,
    sub: n.on ? 'On. Turn off to drop every push, urgent ones too.' : 'Off. Every push is dropped, urgent ones too. Needs you and the badge still update.',
    attrs: ` id="notifyOn" data-confirm="${esc(`Turn off notifications? Every push is dropped until you turn them back on, urgent ones too.${queued} Needs you and the badge still update.`)}"` });
  const weekendRow = toggle({ icon: tile('calendar', '#0ea5e9'), set: 'weekends', title: 'Off on weekends', checked: n.weekends_off, attrs: ' onchange="this.form.submit()"',
    sub: `Pushes wait from Friday ${timeOfDay(last.from)} until Monday ${timeOfDay(first.from)}. Urgent ones still go.` });
  const until = snoozedUntil(n, now);
  const snoozeRow = !n.on ? '' : `<button class="row" type="button" data-snooze-open aria-haspopup="dialog">${tile('snooze', '#a855f7')}<span class="body"><span class="text"><span class="title">Snooze</span><span class="sub wrap">${until ? esc(`Until ${clock(until, now)}`) : 'Pushes wait, then go. Urgent ones still go.'}</span></span><span class="val">${until ? 'On' : 'Off'}</span>${CHEVRON}</span></button>`;
  return `${onRow}\n${snoozeRow}\n${weekendRow}`;
}

function hubSettingsPage({ error, side = null } = {}) {
  const now = new Date();
  const st = queueStatus(now);
  const s = st.settings;
  const until = snoozedUntil(s.notifications, now);
  const top = pageHeader({ lead: 'back', backHref: '/_hub/', backLabel: 'Back to the hub', title: 'Settings', time: 'now' });
  return `${head('Hub Settings', '', top, side)}
${error ? `<div class="flash error" role="alert">${esc(error)}</div>` : ''}
${until ? snoozeBanner(until, now) : ''}
<h2 class="label"${until ? '' : ' style="margin-top:4px"'}>Notifications</h2>
<div class="group">
<div class="row" id="push" data-now="${esc(nowLine(st, now))}" hidden>${tile('bell', '#ef4444')}</div>
${notificationRows(st, now)}
${row({ icon: tile('clock', '#3b82f6'), title: 'Polling', sub: esc(pollingSummary(s)), wrap: true, trail: CHEVRON, href: '/_hub/settings/polling' })}
</div>
<p class="note">Answers and questions go at once unless held overnight, snoozed or for the weekend; then they wait and go when the hold ends. Urgent pushes go through those holds. Needs you, the badge and the daily wakes carry on either way. Polling sets the windows, the overnight hold and the daily wakes.</p>
<h2 class="label" id="rules">Rules for every board</h2>
<div id="hubRules"></div>
<p class="note">Standing instructions every board's Claude session sees each time it wakes. Saving tells each one, and it says what changes. A board's own rules are in that board's Settings.</p>
${s.notifications.on ? snoozeSheet(s, until, now) : ''}
</main>${HEADER_SCRIPTS}${side?.scripts || ''}<script>${PUSH_JS}</script><script>${NOTIFY_JS}</script><script src="/_hub/rules-editor.js"></script><script>${rulesJs(readHubRules())}</script></body></html>`;
}

// The hub rules editor (board/public/rules-editor.js), saving through POST /_hub/settings/rules. "<" is escaped so a
// rule's text can't close the script.
const rulesJs = (rules) => `RulesEditor.mount(document.getElementById('hubRules'), {
  rules: ${JSON.stringify(rules).replace(/</g, '\\u003c')}, buttons: { primary: 'btn', quiet: 'btn quiet', icon: 'btn quiet' },
  empty: 'No rules for every board yet.', placeholder: 'Add a rule, such as: Screenshots in every PR that changes a page',
  async save(body) {
    const r = await fetch('/_hub/settings/rules', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || 'Could not save. Is the Mac awake?');
    const n = out.events.length;
    return { rules: out.rules, message: !out.changed ? 'Nothing changed.' : 'Saved. Sent to ' + n + ' board' + (n === 1 ? '' : 's') + (out.failed.length ? '; ' + out.failed.length + ' could not take it.' : '.') };
  },
});`;

const redirect =(res, location) => { res.writeHead(303, { location, 'cache-control': 'no-store' }); res.end(); };

async function hubRoute(req, res, url) {
  const send = (code, type, body, extra = {}) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...extra }); res.end(body); };
  const sendJSON = (code, v) => send(code, 'application/json', JSON.stringify(v));
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
  if (['/_hub/dialogs.js', '/_hub/page-header.js', '/_hub/rules-editor.js', '/_hub/ui-page-header.js', '/_hub/ui-sidebar.js', '/_hub/sidebar.js'].includes(p)) return send(200, 'text/javascript; charset=utf-8', fs.readFileSync(path.join(BOARD_PUBLIC, p.slice(6))));
  if (p === '/_hub/sidebar.css' || p === '/_hub/hub.css') return send(200, 'text/css; charset=utf-8', fs.readFileSync(path.join(BOARD_PUBLIC, p.slice(6))));
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
  if (p === '/_hub/') return send(200, 'text/html; charset=utf-8', await hubPage(req));
  if (p === '/_hub/push/key') return sendJSON(200, { key: publicKey() });
  if (p === '/_hub/push/subscribe' && req.method === 'POST') {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return sendJSON(200, { count: addSubscription(await readJSONBody(req), `https://${host}/`, req.headers['user-agent']) });
  }
  if (p === '/_hub/push/test' && req.method === 'POST') {
    const results = await sendAll({ title: 'Claude', body: 'Test notification from the hub.', url: '/', tag: 'hub-test' });
    return sendJSON(200, { sent: results.filter((r) => r.status >= 200 && r.status < 300).length, results });
  }
  if (p === '/_hub/settings/notifications' && req.method === 'POST') {
    const f = new URLSearchParams(await readBody(req));
    const set = f.get('set');
    const change = set === 'on' ? { on: f.get('value') === 'on' } : set === 'weekends' ? { weekends_off: f.get('value') === 'on' } : f.has('snooze') ? { snooze: f.get('snooze') } : null;
    if (!change) return send(400, 'text/plain; charset=utf-8', 'Pass set=on or set=weekends with value=on, or snooze.');
    let r;
    try { r = await setNotifications(change); } catch (e) {
      if (e.status !== 400) throw e;
      return redirect(res, '/_hub/settings?refused=snooze');
    }
    if (r.dropped) log(`notifications off: dropped ${r.dropped} queued push${r.dropped === 1 ? '' : 'es'}`);
    return redirect(res, '/_hub/settings');
  }
  if (p === '/_hub/settings/polling' && req.method === 'POST') {
    const f = new URLSearchParams(await readBody(req));
    const op = f.get('op') || '';
    const w = f.get('w') || '';
    const edit = editPolling(readSettings(), { op, w, value: (f.get('value') || '').trim() });
    try {
      if (edit.error) throw Object.assign(new Error(edit.error), { status: 400 });
      saveSettings(edit.input);
    } catch (e) {
      if (e.status !== 400) throw e;
      return send(400, 'text/html; charset=utf-8', pollingPage({ select: w, error: e.message }));
    }
    return redirect(res, `/_hub/settings/polling?w=${encodeURIComponent(edit.select)}#${POLLING_ANCHOR[op]}`);
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
  if (p === '/_hub/settings') {
    if (url.searchParams.has('saved') || url.searchParams.has('flushed')) return redirect(res, `/_hub/settings/polling${url.search}`);
    const error = url.searchParams.get('refused') === 'snooze' ? 'That snooze ends in the past or more than 30 days on. Pick another time.' : null;
    return send(200, 'text/html; charset=utf-8', hubSettingsPage({ error, side: await sidebar() }));
  }
  if (p === '/_hub/settings/polling') {
    const flushed = url.searchParams.get('flushed');
    const n = Number(flushed);
    const flash = url.searchParams.has('saved') ? 'Saved.'
      : flushed === null || flushed === 'failed' ? null
      : n ? `Sent ${n} queued push${n === 1 ? '' : 'es'}.` : 'Nothing was queued.';
    const error = flushed === 'failed' ? 'Could not send the queue. It stays queued for the next check.' : null;
    return send(200, 'text/html; charset=utf-8', pollingPage({ select: url.searchParams.get('w'), flash, error, side: await sidebar() }));
  }
  if (p === '/_hub/push/flush' && req.method === 'POST') {
    const r = await flushQueue();
    if (r) log(`push queue: ${r.ok ? 'sent' : 'could not send'} ${r.count} queued (from the settings page)`);
    return redirect(res, `/_hub/settings/polling?flushed=${r ? (r.ok ? r.count : 'failed') : 0}`);
  }
  if (p === '/_hub/poll' && req.method === 'POST') {
    const body = await readJSONBody(req);
    return sendJSON(200, await runPoll({ flush: body.flush !== false }));
  }
  return false;
}

// One board's links as the hub's page lists them: a word for the site, then each link that isn't passing.
function siteHealth(r, links) {
  if (r.state !== 'up') return { tone: r.state === 'down' ? 'down' : 'wait', word: r.state === 'down' ? 'Down · restarting' : capital(r.state), lines: [] };
  if (!links) return { tone: 'ok', word: 'Up', lines: [] };
  const off = links.filter((l) => !l.ok);
  const broken = off.filter((l) => l.state === 'broken');
  const watcher = links.find((l) => l.link === 'events')?.ok ? 'watcher running' : 'no watcher';
  const word = broken.length ? `${plural(broken.length, 'link')} broken · ${watcher}` : off.length ? `Up · ${watcher} · ${off.length} settling` : `Up · ${watcher} · every link passes`;
  return { tone: broken.length ? 'down' : off.length ? 'wait' : 'ok', word, lines: off.map((l) => ({ link: l.link, detail: `${l.state === 'broken' ? '' : 'settling: '}${l.detail}` })) };
}

// The hub's own page, which the sidebar's Hub row opens: health, polling and notifications.
async function hubPage(req) {
  const now = new Date();
  const state = await sidebarState();
  const { data, links, rows } = state;
  const side = await sidebar('_hub', state);
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const code = { running: readJSON(HUB_CODE, null)?.hash, onDisk: hubCode().hash };
  const codeLine = code.running && code.running === code.onDisk ? `runs the code in its files (${code.onDisk})` : 'runs older code than its files; restart it';
  const health = (r) => {
    const h = siteHealth(r, links[r.route]);
    const lines = h.lines.length ? `<span class="links">${h.lines.map((l) => `<span><b>${esc(l.link)}</b> ${esc(l.detail)}</span>`).join('')}</span>` : '';
    return row({ icon: siteIcon(r.route, r), title: esc(r.title), sub: `<span class="st ${h.tone}">${esc(h.word)}</span>${lines}`, wrap: true, trail: CHEVRON, href: `/${r.route}/` });
  };
  // Boards and Pages stay apart wherever sites are listed, as in the sidebar (board/public/ui-sidebar.js).
  const isBoard = new Set(data.sites.filter((x) => x.board).map((x) => x.route));
  const group = (label, list) => (list.length ? `<h2 class="label">${label}</h2>\n<div class="group">${list.map(health).join('')}</div>\n` : '');
  const st = queueStatus(now);
  const s = st.settings;
  const queued = st.count ? `${st.count} push${st.count === 1 ? '' : 'es'} queued; next send ${clock(st.nextFlushAt, now)}.` : 'No pushes queued.';
  const rules = readHubRules();
  const top = pageHeader({ lead: 'logo', title: 'Hub', time: 'now' });
  return `${head('Hub', '', top, side)}
<h2 class="label" style="margin-top:4px">Health</h2>
<div class="group">${row({ icon: tile('power', data.hub.tone === 'ok' ? '#22c55e' : '#ef4444'), title: 'Hub', sub: `<span class="st ${data.hub.tone}">${esc(data.hub.word)}</span> · ${esc(data.hub.detail)} · ${esc(codeLine)}`, wrap: true })}
${rows.length ? '' : row({ title: 'No sites yet', sub: 'In a Claude session, run <code>/join-web-ts &lt;route&gt;</code>.' })}</div>
${group('Boards', rows.filter((r) => isBoard.has(r.route)))}${group('Pages', rows.filter((r) => !isBoard.has(r.route)))}<p class="note">The hub runs every site and restarts one that stops. A board's links are what the hub owes it: GitHub polling, events (a watcher runs), daily wakes, pushes, reviewer links and hub code. One that just broke reads settling first.</p>
<h2 class="label">Polling</h2>
<div class="group">${row({ icon: tile('clock', '#3b82f6'), title: esc(capital(nowLine(st, now))), sub: `<span class="sub wrap">${esc(pollLine(now))}</span><span class="sub wrap">${esc(queued)}</span>`,
  trail: `<form method="post" action="/_hub/push/flush"><button class="btn quiet" ${st.count ? '' : 'disabled'}>Send now</button></form>` })}
${row({ title: 'Windows, overnight hold, daily wakes', sub: esc(pollingSummary(s)), wrap: true, trail: CHEVRON, href: '/_hub/settings/polling' })}</div>
<h2 class="label">Notifications</h2>
<div class="group"><div class="row" id="push" data-now="${esc(nowLine(st, now))}" hidden>${tile('bell', '#ef4444')}</div>
${row({ icon: tile('power', s.notifications.on ? '#22c55e' : '#6b7280'), title: 'Push notifications', sub: esc(data.notifications.text), trail: CHEVRON, href: '/_hub/settings' })}</div>
<h2 class="label">Every board</h2>
<div class="group">${row({ title: 'Rules for every board', sub: esc(rules.length ? plural(rules.length, 'rule') : 'None yet'), trail: CHEVRON, href: '/_hub/settings#rules' })}</div>
<footer>${plural(rows.length, 'site')}. Each belongs to one Claude session, which adds it with <code>/join-web-ts &lt;route&gt;</code>. This page refreshes every 30 seconds.<br><span class="host">${esc(host)}</span></footer>
</main>${HEADER_SCRIPTS}${side.scripts}<script>${PUSH_JS}</script><script>${badgeJs(data.total)}</script></body></html>`;
}

// iOS shows an app badge only in a Home Screen app with notifications allowed; elsewhere this does nothing.
const badgeJs = (n) => `(() => {
  if (!('setAppBadge' in navigator)) return;
  try { (${Number(n) || 0} ? navigator.setAppBadge(${Number(n) || 0}) : navigator.clearAppBadge()).catch(() => {}); } catch {}
})();`;

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
  if (pageOf({ method: req.method, pathname: url.pathname, search: url.search, dest: req.headers['sec-fetch-dest'], sites }) === 'shell') {
    const route = url.pathname === '/' ? '' : decodeURIComponent(url.pathname.split('/')[1]);
    shellPage(route).then((html) => sendText(req, res, 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', vary: 'sec-fetch-dest' }, html))
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
