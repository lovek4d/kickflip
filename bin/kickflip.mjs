#!/usr/bin/env node
// kickflip: manage the shared site manifest the hub (../hub/hub.mjs) serves.
//   kickflip doctor [--fix [--dry-run]] [--json]
//               one line per prereq, installed piece, the hub, Tailscale / and each site (./doctor.mjs): ok,
//               fixable (by --fix), yours (with the command to run), optional or note. Changes nothing.
//               --fix runs init's steps, then reports again. --json prints {items:[{group,item,state,detail,fix}]}.
//               Exit 1 when anything is fixable or yours
//   kickflip join [--name <board name>] [--hub]
//               run in a git repo's folder: adds it as a board (docs/adr/0143-kickflip-join-adds-the-current-repository-as-a-board.md).
//               Asks for the board name, default the folder's name; with no terminal to ask in, --name is needed. The name
//               takes letters, digits and spaces, and gives the route, lowercased with dashes for spaces. Records the
//               folder's origin as `github` and its branch; the board's builders branch from the folder's local main and
//               land there (`local: true`). Marks the folder trusted for Claude Code, then starts the board's session in
//               the background as `start` does, or with --hub flags the board as the hub board, starts its session in
//               the foreground in tmux and attaches this terminal to it, as `hub` does. Refuses a folder outside git (exit 2), and exits 1 while the hub isn't
//               running. A folder that already has a board names it and offers to restart its session
//   Every other join names its site with --name <name>, which gives its title and its route as above (any characters,
//   other than letters and digits, become dashes). A name that is the route itself keeps the site's title.
//   kickflip join --name <name> (--port <n> | --dir <folder> [--cmd '<json array>' [--port <n>]])
//               [--description <d>] [--icon <key>] [--color <css hex>]
//               a plain page: no session, owner, watcher or needs (docs/adr/0087-a-page-joins-without-a-session.md).
//               --port forwards /<route>/ to a server the session already runs, which reads Down while it doesn't
//               answer; --dir alone has the hub serve the folder's files; --cmd has the hub run that command in --dir
//               (default the cwd) on --port or a free one. Prints {route, url, serves, port|dir, answering?, hub}.
//               A rejoin passes --port, --dir or --cmd again. Exit 3 when a session owns the route
//   kickflip join --name <name> --session <id> [--watch [<file,file>]] [--label <name>] [--description <d>]
//               [--dir <path>] [--cmd '<json array>'] [--port <n>]
//               [--filter <regex>] [--template board [--items <waves|file>]] [--force]
//               [--icon <key>] [--color <css hex>] [--repo <dir>] [--model <m>] [--hub | --no-hub]
//               a site with an owning session: events, the watcher, Needs you. --watch is optional with --session;
//               with files it watches those (relative to the dir) in place of data/events.jsonl
//               --hub makes this board the hub board, as `set --hub` does; a join without either keeps the flag.
//               The hub board's session runs in the foreground in tmux (`hub`); every other board's in the background
//               --template board runs the shared board (../board/server.mjs) from the site dir,
//               writing its board.json; --items is "waves" (default) or a wave.json-format file, made with no
//               items when missing.
//               It then runs handshake, unless this session already answered the board's hello, and
//               asks the hub for one poll (as poll-now --keep-queue), so the board's GitHub link passes
//               without waiting for the next slot. Prints poll: "reached this board", or why not
//               --icon names a line icon from ../hub/icons.mjs and --color tints it in the
//               sidebar; without an icon the hub picks one from the route and title, else the
//               title's first letter, on a color picked from the route
//               --repo is the folder the session runs in, which `resume` needs: by default the session's own
//               cwd while it runs (../hub/live.mjs), else the recorded folder, else the cwd of this join. --model is
//               the session's model, kept for start and resume. The owner entry records both (../hub/sessions.mjs).
//               A join that leaves out --label, --model or --repo keeps the owner record's, a --force takeover too.
//               A new route's entry records when it joined, `created`, which a later join keeps; the sidebar's
//               switch-mode letters go to sites in that order (../board/public/ui-sidebar.js switchKeys)
//   kickflip start <route> [--repo <dir>] [--model <m>] [--prompt <text>]
//               starts a background session (`claude --bg`, auto mode, worktree isolation off) in --repo, else
//               the route's recorded folder, else the cwd, named after the board, whose first prompt is
//               `/kickflip --name '<board name>'` plus --prompt. Records it as the route's owner, or in `starting` until a
//               join takes it up when the route has no site yet. Prints {route, session, confirmed, repo, argv, output}
//   kickflip resume <route>
//               `claude --resume <id> --bg` for the route's recorded session in its folder, prompting it to rejoin
//               and relaunch its watcher, and records the id it comes back under as the route's owner. Prints
//               {route, session, previous, confirmed, repo, argv, output}. Exit 1 when no session or folder is recorded
//   kickflip close <route> --name <board title>
//               stops its session, closes builder records and removes the site; keeps its folder and open PRs.
//               --name must match the board title exactly.
//   kickflip reopen <route>
//               restores the closed board's manifest entry and resumes its recorded session
//   kickflip export <route> [--out <file>]
//               writes one .tgz (default ./kickflip-<route>.tgz, never over an existing file) holding the board's
//               folder, without its watcher cursors and watcher record; its manifest entry with only EXPORT_KEYS below,
//               dropping its folder, port, command, owner session and restart times; the owner's label and model;
//               settings.json's EXPORT_SETTINGS; and a README.md of the import steps. No other hub file and no key
//               goes in. Refuses a site that isn't a board, a board whose cards live outside its folder, and a board
//               with an open builder record. Prints {route, file, entry, dropped, settings}
//   kickflip import <file>
//               unpacks an export's board into ~/.claude/kickflip/sites/<route>/, adds its manifest entry with a free
//               port and this host's board server, and writes its settings over this host's for those keys. A hub
//               flag is kept only when no other site has it. Refuses a route this host has open, closed or starting,
//               or whose folder exists. Prints {route, dir, port, settings, hub, join}: `join` is the line a fresh
//               session runs to take the board over
//   kickflip hub [--repo <dir>]
//               attaches this terminal to the hub board's tmux session (tmux attach; switch-client inside tmux).
//               With none running, the hub board's session starts in it first, in the foreground: its recorded
//               session resumed in its recorded folder and model, or in --repo when no folder is recorded; with no
//               owner, a fresh session in --repo (default cwd) that joins the board with --hub. Points it to
//               docs/hub-session.md. While the tmux session runs, nothing else starts
//               (docs/adr/0147-boards-run-in-the-background-and-the-hub-board-in-tmux.md).
//               Exit 2 when no board has the hub flag (`set --hub`), 3 while its session is live outside tmux;
//               otherwise keeps tmux's exit code
//   kickflip sessions [--json]
//               one line per board: route, session id, live (background or terminal) or not, folder
//   kickflip handshake <route>
//               tests a board's hub links (../hub/boards.mjs handshake): appends a `hello` event, which the
//               owning session's watcher answers when it prints it. The board shows a setup checklist
//               until the watcher answered and the hub's GitHub check reached it. Prints {route, hello}
//   kickflip set <route> [--icon <key>] [--color <hex>] [--hub | --no-hub]
//               changes an existing site's icon or color without joining; '' clears one. --hub makes the board the
//               hub board, whose session runs in tmux and `hub` attaches to (`hub: true` in its entry), clearing the flag from any other
//               site; --no-hub clears it. Exit 2 for --hub on a site that isn't a board
//   kickflip leave <route> [--session <id>] [--force]
//               removes the entry and keeps its files; --session (or --force) only for a route a session owns
//   kickflip restart <route>
//   kickflip logs <route> [--lines <n>]
//   kickflip init [--dry-run] | uninstall
//               init is the first-run name for doctor --fix. It links the running package or clone, hooks plugin
//               and status line, configures Claude settings, starts the hub's service in place of the running one (../shared/service.mjs:
//               a launchd login item on macOS; a systemd user unit on Linux),
//               and maps Tailscale / to the hub.
//               Conflicting skill links and real paths are refused. A dangling status-line link can be replaced.
//               --dry-run prints what init would move, link and start, and changes nothing.
//               uninstall stops the hub and removes its service, kickflip's status-line link and Tailscale /;
//               Claude settings and skill links are kept
//   kickflip update
//               installs @lovek4d/kickflip@latest globally with npm, then restarts the hub.
//               A clone refuses (exit 2); update it with git pull
//   kickflip push --kind action|prompt|fault --title <t> [--body <b>] [--url </route/path>] [--tag <tag>]
//               [--now | --urgent]
//               notify every device that turned on notifications on the Hub page; a tap opens --url.
//               --kind says what waits on the owner (../hub/push.mjs PUSH_KINDS): action, a card's Action needed
//               appearing or changing; prompt, a background session's prompt; fault, something only the owner
//               can fix. A push without one is refused (exit 2): news stays on the board.
//               The push queues, replacing a queued one with the same
//               --tag, and goes out after the hub's next GitHub check on the polling interval
//               (/_hub/settings/polling) or when a GitHub tick ends (board.mjs checked); a board's
//               several queued pushes go as one summary. --now sends at once unless pushes are held
//               (overnight, snoozed or the weekend), and queues if no device takes it; it is for questions,
//               steps only the owner can run and prototypes. --urgent sends at once through
//               those holds, for a production fault. While notifications are off every push is dropped, urgent ones too.
//               Prints "sent", "queued" with the next send time, or "dropped". Exit 3 when no device has turned them on.
//   kickflip polling
//               prints {every, until, next, held, held_until, held_why, notifications}: the current polling
//               window's minutes, when it ends, the next check, whether pushes are held now, until when
//               ("never" while off, "forever" while snoozed until ended) and why (off, snoozed, weekend or overnight), and the notifications settings
//   kickflip notifications [on | off | snooze <length> | unsnooze | weekends on|off]
//               sets the Hub page's Notifications controls and prints them; off drops the queued pushes.
//               A snooze length is a hub/schedule.mjs snoozeEnd choice. Without a change it only prints them
//   kickflip codex-share [auto|always|off]
//               prints the Codex setting in effect for every board; with a value, saves it and prints it.
//               auto (also when unset): Codex builds and reviews; while Codex is past the pause line or out of usage, Opus
//               builders take over until it resets.
//               always (Always on): the same past the pause line; while Codex is out of usage, that work pauses until a
//               usage-reset check succeeds.
//               off: Claude builds and reviews. While Codex isn't installed or logged in, the setting reads off and a change is refused.
//   kickflip usage-gate [pause-at <50..100> | keep-going | stop]
//               prints {pause_at, state, window, used, resets_at, codex: {past, window, used, resets_at}}; a read exits 0.
//               pause-at saves the line in steps of 5 (default 90, 100 Off); keep-going lifts the current Claude pause
//               until its window resets; stop restores it. Codex hands work to Opus past the same line.
//   kickflip poll-now [--keep-queue]
//               asks the hub for one poll now (GitHub check, github-change events,
//               checked.json, then the queue unless --keep-queue) and prints its result
// Exit codes: 0 ok, 1 error, 2 bad usage, 3 route owned by another session (join/leave), or its recorded session is
// live (start/resume/hub). hub passes through claude's exit code.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import readline from 'node:readline/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ICON_KEYS } from '../hub/icons.mjs';
import { liveSessions } from '../hub/live.mjs';
import { isBoardSite, writeManifest } from '../hub/boards.mjs';
import { joinName, routeFromName, routeRecord, validRoute } from '../hub/routes.mjs';
import { githubFromOrigin } from '../hub/repos.mjs';
import { uninstallStatusLine, storedPath, nodeBin, watcherCommand } from './install.mjs';
import { hubService } from '../shared/service.mjs';
import { runDoctor } from './doctor.mjs';
import { cloneRoot } from '../shared/repos.mjs';

const SKILL = cloneRoot();
const HOME = path.join(os.homedir(), '.claude', 'kickflip');
const MANIFEST = path.join(HOME, 'manifest.json');
const LOGS = path.join(HOME, 'logs');
const HUB_PORT = Number(process.env.KICKFLIP_HUB_PORT || 4500);
const FIRST_SITE_PORT = 4600;
const COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

const [cmd, ...rest] = process.argv.slice(2);
const args = Object.assign(Object.create(null), { _: [] });
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    if (k === 'fix' || k === 'force' || k === 'json' || k === 'urgent' || k === 'now' || k === 'keep-queue' || k === 'hub' || k === 'no-hub' || k === 'dry-run') args[k] = true;
    else if (k === 'watch' && (i + 1 >= rest.length || rest[i + 1].startsWith('--'))) args[k] = true;
    else args[k] = rest[++i];
  } else args._.push(a);
}

const out = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));
// Throwing (not process.exit) lets withLock release the lock on every exit path.
class Exit extends Error { constructor(msg, code) { super(msg); this.code = code; } }
const fail = (msg, code = 1) => { throw new Exit(msg, code); };
function checkLook() {
  if (args.icon && !ICON_KEYS.includes(args.icon)) fail(`--icon takes one of: ${ICON_KEYS.join(', ')}`, 2);
  if (args.color && !COLOR_RE.test(args.color)) fail('--color takes a CSS hex color, such as #3b82f6', 2);
}
function applyLook(site) {
  for (const k of ['icon', 'color']) {
    if (args[k] === '') delete site[k];
    else if (args[k] !== undefined) site[k] = args[k];
  }
}
// At most one site has `hub: true`: ../hub/boards.mjs hubBoard takes the first board that has it.
const checkHub = () => args.hub && args['no-hub'] && fail('pass --hub or --no-hub, not both', 2);
const notBoard = (route) => fail(`/${route} is not a board; only a board can be the hub board`, 2);
function applyHub(m, route, site) {
  if (args['no-hub']) delete site.hub;
  if (!args.hub) return;
  if (!isBoardSite(site)) notBoard(route);
  for (const [other, s] of Object.entries(m.sites)) if (other !== route && s?.hub) delete s.hub;
  site.hub = true;
}

function readManifest() {
  try { const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); m.sites ||= {}; return m; }
  catch (e) { if (e.code === 'ENOENT') return { version: 1, sites: {} }; fail('manifest unreadable: ' + e.message); }
}
const readJSON = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const sessionsModule = () => import(path.join(SKILL, 'hub', 'sessions.mjs'));
// ../hub/sessions.mjs refusals as exits: a live session 3, no hub board 2, nothing recorded or claude failing 1.
async function sessionCall(fn) {
  const { SessionError } = await sessionsModule();
  try { return await fn(); } catch (e) { if (e instanceof SessionError) fail(e.message, e.reason === 'live' ? 3 : e.reason === 'hub' ? 2 : 1); throw e; }
}
// The board's hello (../hub/boards.mjs handshake). → {route, hello}
async function runHandshake(route) {
  const { handshake } = await import(path.join(SKILL, 'hub', 'boards.mjs'));
  try { return await handshake(route, readManifest()); } catch (e) { return fail(e.message, 2); }
}
// One hub poll that reaches a new board, so its GitHub link passes now rather than at the next slot. A poll already
// running when the board joined started without it, so a miss with no failure polls once more.
async function pollFor(route) {
  for (let tries = 0; tries < 2; tries++) {
    let r;
    try {
      r = await fetch(`http://127.0.0.1:${HUB_PORT}/_hub/poll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ flush: false }), signal: AbortSignal.timeout(5 * 60_000) });
    } catch (e) { return `not run (${e.message})`; }
    if (!r.ok) return `not run (the hub answered ${r.status})`;
    const res = await r.json();
    if (res.checked?.includes(route)) return 'reached this board';
    if (res.failed?.length) return `missed this board: ${res.failed[0]}`;
  }
  return 'missed this board';
}
async function withLock(fn) {
  const { withManifestLock } = await import(path.join(SKILL, 'hub', 'boards.mjs'));
  try { return await withManifestLock(fn); } catch (e) { if (e.code === 'ELOCKED') fail(e.message); throw e; }
}

function connects(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(500, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}
function bindable(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '0.0.0.0', () => srv.close(() => resolve(true)));
  });
}
async function freePort(m) {
  const taken = new Set([...Object.values(m.sites), ...Object.values(m.closed || {}).map((c) => c.site)].map((s) => s?.port));
  for (let p = FIRST_SITE_PORT; p < FIRST_SITE_PORT + 400; p++) {
    if (taken.has(p)) continue;
    if (!(await connects(p)) && (await bindable(p))) return p;
  }
  fail('no free port found from ' + FIRST_SITE_PORT);
}

function tailnetHost() {
  try {
    const s = JSON.parse(execFileSync('tailscale', ['status', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    return (s.Self?.DNSName || '').replace(/\.$/, '');
  } catch { return ''; }
}
const siteUrl = (route) => { const h = tailnetHost(); return h ? `https://${h}/${route}/` : `http://127.0.0.1:${HUB_PORT}/${route}/`; };

async function hubStatus() {
  try {
    const r = await fetch(`http://127.0.0.1:${HUB_PORT}/_hub/status.json`, { signal: AbortSignal.timeout(1500) });
    return await r.json();
  } catch { return null; }
}

const isFolder = (dir) => { try { return fs.statSync(dir).isDirectory(); } catch { return false; } };
const realPath = (p) => { try { return fs.realpathSync(p); } catch { return null; } };

// --name gives a join its title and its route, the name hyphenated (../hub/routes.mjs routeFromName). A name that is
// the route itself keeps the existing site's title, so a board whose title hyphenates elsewhere rejoins by its route
// (../hub/routes.mjs joinName). → {route, title}
function named(existing = (route) => undefined) {
  if (typeof args.name !== 'string' || !args.name.trim()) fail('join needs --name "<name>": the board or page name, which gives its route', 2);
  const name = args.name.trim().replace(/\s+/g, ' ');
  const route = routeFromName(name);
  if (!validRoute(route)) fail(`--name "${name}" needs a letter or digit for its route`, 2);
  return { route, title: (name === route && existing(route)?.title) || name };
}

// The board template's files in dir: board.json with its title, items ("waves" or a wave.json-format file, made with
// no items when missing) and, when given, tickets. → the board server's cmd for dir
function boardFiles(dir, { title, items, tickets }) {
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const cfgFile = path.join(dir, 'board.json');
  const cfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};
  cfg.title = title;
  cfg.items = storedPath(items || cfg.items || 'waves');
  if (tickets) cfg.tickets = tickets;
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
  const itemsFile = cfg.items === 'waves' ? null : path.resolve(dir, cfg.items);
  if (itemsFile && !fs.existsSync(itemsFile)) {
    fs.mkdirSync(path.dirname(itemsFile), { recursive: true });
    fs.writeFileSync(itemsFile, JSON.stringify({ title: cfg.title, items: [] }, null, 2) + '\n');
  }
  return [nodeBin(), path.join(SKILL, 'board', 'server.mjs'), dir];
}

// A background session for the route (../hub/sessions.mjs startSession), recorded as its site's owner, or in
// `starting` until a join takes it up when the route has no site yet. → startSession's result
async function startRecorded(route, options) {
  const { startSession, withSessionLock } = await sessionsModule();
  return withSessionLock(route, async () => {
    const r = await sessionCall(() => startSession(route, { manifest: readManifest(), ...options }));
    await withLock(async () => {
      const m = readManifest();
      const owner = { session: r.session, label: r.name, since: new Date().toISOString(), repo: r.repo, ...(r.model ? { model: r.model } : {}) };
      if (routeRecord(m.sites, route)) { m.sites[route].owner = owner; m.sites[route].updated = owner.since; }
      else m.starting = { ...m.starting, [route]: { ...routeRecord(m.starting, route), ...owner } };
      await writeManifest(m);
    });
    return r;
  });
}

// This terminal attached to the hub board's tmux session (../hub/sessions.mjs hubSession); repo is the folder for a fresh one.
async function openHub(repo) {
  const { hubSession } = await sessionsModule();
  const r = await sessionCall(() => hubSession({ manifest: readManifest(), repo }));
  process.exitCode = r.status;
}

const git = (cwd, ...argv) => { const r = spawnSync('git', ['-C', cwd, ...argv], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };
const canAsk = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);
async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // Ctrl-D or Ctrl-C at the prompt stops join before it has changed anything.
  try { return (await rl.question(question)).trim(); } catch (e) { if (e.code === 'ABORT_ERR') fail('stopped at the prompt; nothing changed'); throw e; } finally { rl.close(); }
}
const taken = (m, route) => Boolean(routeRecord(m.sites, route) || routeRecord(m.starting, route) || routeRecord(m.closed, route));
// What's wrong with a typed board name, or null.
function nameProblem(name) {
  if (!/^[A-Za-z0-9 ]+$/.test(name) || !validRoute(routeFromName(name))) return 'A board name takes letters, digits and spaces, up to 41 characters of route.';
  return taken(readManifest(), routeFromName(name)) ? `/${routeFromName(name)} is taken; pick another name.` : null;
}
// The board starts on its own cards, data/wave.json, as a New board start does.
const BOARD_FLAGS = '--template board --items data/wave.json';

// Bare `kickflip join` (docs/adr/0143-kickflip-join-adds-the-current-repository-as-a-board.md): adds the git repo the
// cwd is in as a local board, its session starting in the background, or with --hub in tmux, attached to this terminal.
async function joinFolder() {
  const top = git(process.cwd(), 'rev-parse', '--show-toplevel');
  if (!top) fail(`${process.cwd()} is not in a git repo; run kickflip join in the folder of the repo to add as a board`, 2);
  const folder = fs.realpathSync(top);
  if (!(await hubStatus())) fail('the hub is not running; run kickflip init to set it up, then kickflip join here again');
  const had = Object.entries(readManifest().sites).find(([, s]) => isBoardSite(s) && s.owner?.repo && realPath(s.owner.repo) === folder);
  if (had) return restartFolderBoard(...had);
  const fallback = path.basename(folder).replace(/[^A-Za-z0-9]+/g, ' ').trim();
  let name = args.name?.trim();
  if (name === undefined && !canAsk()) fail('join needs --name "<Board name>" when it has no terminal to ask in', 2);
  for (;;) {
    if (name === undefined) name = (await ask(`Board name${fallback ? ` (${fallback})` : ''}: `)) || fallback;
    const problem = nameProblem(name);
    if (!problem) break;
    if (args.name !== undefined) fail(problem, 2);
    out(problem);
    name = undefined;
  }
  const title = name.replace(/\s+/g, ' ');
  const route = routeFromName(title);
  const origin = git(folder, 'remote', 'get-url', 'origin');
  const github = origin ? githubFromOrigin(origin) : null;
  const branch = git(folder, 'symbolic-ref', '--quiet', '--short', 'HEAD');
  // Running join in the folder is the owner's consent to Claude Code's workspace trust for it.
  const { trustFolder } = await import('../hub/trust.mjs');
  try { trustFolder(folder); } catch (e) { fail(`Couldn't trust this folder for Claude Code: ${e.message}`); }
  await withLock(async () => {
    const m = readManifest();
    if (taken(m, route)) fail(`/${route} is taken; pick another name`, 2);
    const dir = path.join(HOME, 'sites', route);
    const now = new Date().toISOString();
    const site = {
      dir, port: await freePort(m), cmd: boardFiles(dir, { title, items: 'data/wave.json' }), watch: ['data/events.jsonl'], title,
      local: true, ...(github ? { github } : {}), ...(branch ? { branch } : {}), owner: { repo: folder }, created: now, updated: now,
    };
    m.sites = { ...m.sites, [route]: site };
    applyHub(m, route, site);
    await writeManifest(m);
  });
  out(`Made ${title} at ${siteUrl(route)}, working in ${folder}${github ? ` (${github})` : ''}.`);
  if (args.hub) {
    out('It is the hub board, so its session runs in tmux, attached here.');
    return openHub(folder);
  }
  try { await startRecorded(route, { repo: folder, prompt: BOARD_FLAGS }); }
  catch (e) { if (e instanceof Exit) fail(`${e.message}\nThe board is made; run kickflip join here again to start its session.`, e.code); throw e; }
  out('Its session is starting in the background, and joins the board shortly.');
}

// A folder that already has a board: names it and, on a yes, restarts its session as the Hub page's Restart does
// (../hub/restart-board.mjs), then attaches to the hub board's tmux session, or starts one when none is recorded.
async function restartFolderBoard(route, site) {
  const title = site.title || route;
  out(`This folder already has a board: ${title} (/${route}).`);
  if (!canAsk()) fail(site.hub === true ? 'Open its session with kickflip hub.' : 'Run kickflip join in a terminal to restart its session, or tap Restart on its row of the Hub page.');
  const answer = (await ask('Restart its session? (Y/n) ')).toLowerCase();
  if (answer && !'yes'.startsWith(answer)) return;
  if (!site.owner.session) {
    if (site.hub === true) return openHub(site.owner.repo);
    await startRecorded(route, { repo: site.owner.repo, prompt: BOARD_FLAGS });
    return out('Its session is starting in the background.');
  }
  const r = await fetch(`http://127.0.0.1:${HUB_PORT}/_hub/restart-board`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ route }), signal: AbortSignal.timeout(5 * 60_000) });
  const body = await r.json();
  if (!r.ok) fail(body.error);
  out(`Restarted ${title}'s session.`);
  if (site.hub === true) return openHub(site.owner.repo);
}

// A manifest entry's fields that hold on another host; the rest name this host's paths, port, session or restarts.
const EXPORT_KEYS = ['title', 'description', 'icon', 'color', 'created', 'watch', 'filter', 'hub', 'github', 'remote', 'branch', 'local'];
// The hub settings the owner chose to carry (Notifications, Polling, Codex share); never a key or an integration.
const EXPORT_SETTINGS = ['notifications', 'polling', 'codexShare'];
const BUNDLE = 'kickflip-board';
// A watcher's cursor and pid record belong to this host's session (./wait-events.mjs).
const SESSION_FILE = /^(\.watch-cursor-.*\.json|watcher\.json)$/;
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
const shellQuote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
// COPYFILE_DISABLE and --no-xattrs keep macOS's ._ files and extended attributes out, which GNU tar warns about.
function tar(argv) {
  const r = spawnSync('tar', argv[0] === '-czf' ? ['--no-xattrs', ...argv] : argv, { encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1' } });
  if (r.status !== 0) fail(`tar ${argv[0]} failed: ${(r.stderr || r.error?.message || '').trim()}`);
}
function exportReadme(b, file) {
  const title = b.entry.title || b.route;
  const settings = Object.keys(b.settings).map((k) => ({ notifications: 'Notifications', polling: 'Polling', codexShare: 'Codex share' })[k]);
  return `# Moving ${title} (/${b.route}) to another machine

Exported from ${b.from} at ${b.exported_at}. This bundle holds the board's folder and manifest entry${settings.length ? `, and the hub's ${settings.length > 1 ? `${settings.slice(0, -1).join(', ')} and ${settings.at(-1)}` : settings[0]} settings, which import writes over the new machine's` : ''}.

## On the new machine

1. Install Git, Node 22+, Claude Code, gh and Tailscale, and turn on HTTPS certificates for the tailnet.
2. Run \`npm i -g @lovek4d/kickflip\`, then \`kickflip init\`, and fix what its report marks yours.
3. Run \`kickflip import ${file}\`. It refuses when /${b.route} already exists there.
4. Start a fresh Claude Code session in the folder the board works in, and have it run the \`join\` line the import prints, with its own session id. \`--force\` takes the board over.
5. Once the board answers there, stop its session on the old machine and run \`kickflip leave ${b.route} --force\` there, so only one session acts on its cards. Its files stay on the old machine.

## Set up again

The bundle carries no secret and nothing tied to the old machine. Set these up on the new machine:

- GitHub sign-in: \`gh auth login\`.
- Linear API key: Hub → Linear.
- Slack: Claude's Slack connector in the new session, and the hub's Slack identity with \`board.mjs slack set --self-dm <D…> --user <U…>\`.
- Codex: \`codex login\`, if Codex builds.
- Notifications: open the Hub page on each phone and tap Turn on.
- Other hub settings, such as the pause line and Rules for every board, stay on the old machine.

Manifest fields left out, which the new machine sets itself: ${b.dropped.length ? b.dropped.join(', ') : 'none'}.
`;
}

// A plain page (docs/adr/0087-a-page-joins-without-a-session.md): the entry has no owner, watch or filter, so no session
// is woken, nothing is watched and the hub never asks it for needs.
async function joinPage() {
  checkLook();
  const port = args.port === undefined ? undefined : Number(args.port);
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) fail('--port takes a port number', 2);
  if (port === HUB_PORT) fail(`--port ${port} is the hub's own port`, 2);
  let cmd;
  if (args.cmd !== undefined) {
    try { cmd = JSON.parse(args.cmd); } catch { cmd = null; }
    if (!Array.isArray(cmd) || !cmd.length || !cmd.every((a) => typeof a === 'string')) fail('--cmd takes a JSON array of strings, such as \'["/abs/node","/abs/server.mjs"]\'', 2);
  }
  const dir = args.dir === undefined ? undefined : path.resolve(args.dir);
  if (dir !== undefined && !cmd && port === undefined && !isFolder(dir)) fail(`--dir ${dir} is not a folder`, 2);
  const { route, title } = named((r) => routeRecord(readManifest().sites, r));
  const result = await withLock(async () => {
    const m = readManifest();
    if (routeRecord(m.closed, route)) fail('That board is closed; use kickflip reopen ' + route, 2);
    if (routeRecord(m.starting, route)) fail(`/${route} is a board that is starting; pick another route`, 2);
    const existing = routeRecord(m.sites, route);
    if (existing?.owner?.session) {
      out({ error: 'owned', route, owner: existing.owner, hint: 'a session owns this route: pick another route, or that session leaves it first' });
      throw new Exit('', 3);
    }
    const now = new Date().toISOString();
    const site = existing ? { ...existing } : { created: now };
    delete site.watch;
    delete site.filter;
    {
      const served = cmd ? { cmd, dir: dir || existing?.dir || process.cwd(), port: port ?? (existing?.cmd ? existing.port : undefined) ?? await freePort(m) }
        : port !== undefined ? { port, ...(dir ? { dir } : {}) } : { dir };
      for (const k of ['cmd', 'dir', 'port', 'cwd', 'env']) delete site[k];
      Object.assign(site, served);
    }
    site.title = title;
    if (args.description) site.description = args.description;
    applyLook(site);
    site.updated = now;
    m.sites = { ...m.sites, [route]: site };
    await writeManifest(m);
    return site;
  });
  const serves = result.cmd ? 'cmd' : result.port ? 'port' : 'files';
  const hub = await hubStatus();
  out({
    route, url: siteUrl(route), serves,
    ...(result.port ? { port: result.port } : {}), ...(result.dir ? { dir: result.dir } : {}),
    ...(serves === 'port' ? { answering: await connects(result.port) } : {}),
    hub: hub ? 'running' : 'NOT running: run `kickflip doctor --fix`',
  });
}

const commands = {
  async doctor() {
    if (args['dry-run'] && !args.fix) fail('--dry-run needs --fix', 2);
    const { exitCode } = await runDoctor({ fix: Boolean(args.fix), dryRun: Boolean(args['dry-run']), json: Boolean(args.json) });
    process.exitCode = exitCode;
  },

  async join() {
    if (args._.length) fail(`join takes no route: --name "<name>" gives the title and the route, as in kickflip join --name ${shellQuote(args._[0])}`, 2);
    if (args.title !== undefined) fail('join takes no --title: --name "<name>" gives the title and the route', 2);
    if (!args.session) {
      const page = ['port', 'dir', 'cmd'].some((k) => args[k] !== undefined);
      const watched = ['watch', 'template', 'filter', 'label', 'model', 'repo', 'force', 'items', ...(page ? ['hub'] : [])].find((k) => args[k] !== undefined);
      if (watched) fail(`--${watched} needs --session <id> (this session's id)`, 2);
      return page ? joinPage() : joinFolder();
    }
    const { route, title } = named((r) => routeRecord(readManifest().sites, r));
    if (args.template && args.template !== 'board') fail('--template takes "board"', 2);
    checkLook();
    checkHub();
    const result = await withLock(async () => {
      const m = readManifest();
      if (routeRecord(m.closed, route)) fail('That board is closed; use kickflip reopen ' + route, 2);
      const now = new Date().toISOString();
      const existing = routeRecord(m.sites, route);
      if (existing?.owner?.session && existing.owner.session !== args.session && !args.force) {
        out({ error: 'owned', route, owner: existing.owner, hint: 'ask the user, then rerun with --force to take it over' });
        throw new Exit('', 3);
      }
      if (args.hub && args.template !== 'board' && !isBoardSite({ dir: '', cmd: args.cmd ? JSON.parse(args.cmd) : existing?.cmd })) notBoard(route);
      const site = existing ? { ...existing } : {};
      let created = false;
      if (!existing) {
        site.dir = path.resolve(args.dir || path.join(HOME, 'sites', route));
        const empty = !fs.existsSync(site.dir) || fs.readdirSync(site.dir).length === 0;
        if (empty && !args.cmd && !args.template) {
          fs.cpSync(path.join(SKILL, 'starter'), site.dir, { recursive: true });
          created = true;
        }
        site.port = args.port ? Number(args.port) : await freePort(m);
        site.cmd = args.cmd ? JSON.parse(args.cmd) : [nodeBin(), path.join(site.dir, 'server.mjs')];
        site.watch = ['data/events.jsonl'];
        site.created = now;
      }
      if (args.dir && existing) site.dir = path.resolve(args.dir);
      if (args.port && existing) site.port = Number(args.port);
      if (args.cmd && existing) site.cmd = JSON.parse(args.cmd);
      if (args.template === 'board') {
        const pending = routeRecord(m.starting, route);
        const tickets = !existing && pending?.tickets && (!pending.session || pending.session === args.session) ? pending.tickets : undefined;
        site.cmd = boardFiles(site.dir, { title, items: args.items, tickets });
        created = !existing;
      }
      site.title = title;
      if (args.description) site.description = args.description;
      if (typeof args.watch === 'string') site.watch = args.watch.split(',').map((s) => s.trim()).filter(Boolean);
      if (args.filter !== undefined) site.filter = args.filter || undefined;
      applyLook(site);
      applyHub(m, route, site);
      const previous = existing?.owner && existing.owner.session !== args.session ? existing.owner : null;
      const started = routeRecord(m.starting, route)?.session === args.session ? routeRecord(m.starting, route) : null;
      const pendingRepo = routeRecord(m.starting, route);
      if (!existing && (pendingRepo?.github || pendingRepo?.remote) && (!pendingRepo.session || pendingRepo.session === args.session)) {
        if (pendingRepo.github) site.github = pendingRepo.github;
        else site.remote = pendingRepo.remote;
        site.branch = pendingRepo.branch;
      }
      const same = existing?.owner?.session === args.session ? existing.owner : null;
      const kept = same || started || previous;
      site.owner = {
        ...(same || { session: args.session, since: now }),
        label: args.label || kept?.label || '',
        repo: args.repo ? path.resolve(args.repo) : ((site.github || site.remote) && kept?.repo) || liveSessions().get(args.session)?.cwd || kept?.repo || process.cwd(),
      };
      const model = args.model || kept?.model;
      if (model) site.owner.model = model;
      if (routeRecord(m.starting, route)) { delete m.starting[route]; if (!Object.keys(m.starting).length) delete m.starting; }
      site.updated = now;
      m.sites = { ...m.sites, [route]: site };
      await writeManifest(m);
      return { route, created, previousOwner: previous, site };
    });
    const hub = await hubStatus();
    // A session that already answered this board's hello has proved its links; a new board or owner tests them.
    let handshake;
    let poll;
    if (args.template === 'board') {
      const h = readJSON(path.join(result.site.dir, 'data', 'handshake.json'));
      handshake = h?.ack && h.hello?.session === args.session ? 'answered before' : await runHandshake(route);
      poll = hub ? await pollFor(route) : 'not run (the hub is not running)';
    }
    out({
      route, url: siteUrl(route), dir: result.site.dir, port: result.site.port, owner: result.site.owner,
      createdFromStarter: result.created, previousOwner: result.previousOwner,
      log: path.join(LOGS, route + '.log'),
      watcher: watcherCommand(route, args.session, SKILL),
      hub: hub ? 'running' : 'NOT running: run `kickflip doctor --fix`',
      ...(handshake ? { handshake } : {}),
      ...(poll ? { poll } : {}),
    });
  },

  async handshake() {
    const route = args._[0];
    if (!route) fail('handshake needs a route', 2);
    out(await runHandshake(route));
  },

  async leave() {
    const route = args._[0];
    if (!route) fail('leave needs a route', 2);
    await withLock(async () => {
      const m = readManifest();
      const s = routeRecord(m.sites, route);
      if (!s) fail('no site at /' + route);
      if (s.owner?.session && !args.session && !args.force) fail('a session owns /' + route + '; leave needs --session <id>, or --force', 2);
      if (s.owner?.session && s.owner.session !== args.session && !args.force) {
        out({ error: 'owned', route, owner: s.owner }); throw new Exit('', 3);
      }
      delete m.sites[route];
      await writeManifest(m);
      out({ left: route, filesKept: s.dir });
    });
  },

  async start() {
    const route = args._[0];
    if (!validRoute(route)) fail('start needs a route: lowercase letters, digits and dashes', 2);
    const r = await startRecorded(route, { repo: args.repo, model: args.model, prompt: args.prompt });
    out({ route: r.route, session: r.session, confirmed: r.confirmed, repo: r.repo, argv: r.argv, output: r.output });
  },

  async resume() {
    const route = args._[0];
    if (!route) fail('resume needs a route', 2);
    const { resumeSession } = await sessionsModule();
    out(await sessionCall(() => resumeSession(route, { manifest: readManifest() })));
  },

  async close() {
    const { closeBoard } = await import('../hub/close-board.mjs');
    try { out(await closeBoard(args._[0], args.name)); }
    catch (e) { fail(e.message, e.status ? 2 : 1); }
  },

  async reopen() {
    const { reopenBoard } = await import('../hub/close-board.mjs');
    try { out(await sessionCall(() => reopenBoard(args._[0]))); }
    catch (e) { if (e.status) fail(e.message, 2); throw e; }
  },

  async export() {
    const route = args._[0];
    if (!validRoute(route)) fail('export needs a route: lowercase letters, digits and dashes', 2);
    const file = path.resolve(args.out || `kickflip-${route}.tgz`);
    if (fs.existsSync(file)) fail(`${file} already exists; pass another --out`, 2);
    const site = routeRecord(readManifest().sites, route) || fail('no site at /' + route);
    if (!isBoardSite(site)) fail(`/${route} is not a board; export moves a board`, 2);
    const dir = fs.realpathSync(site.dir);
    const { itemSources, openBoardBuilders } = await import('../board/store.mjs');
    const outside = (await itemSources(dir)).find((s) => path.relative(dir, s.file).startsWith('..'));
    if (outside) fail(`/${route}'s cards live outside its folder (${outside.file}); export moves only a board whose board.json items is a file in its folder`);
    const builders = await openBoardBuilders(dir);
    if (builders.length) fail(`a builder is open on /${route}: ${builders.map((b) => `${b.key} (${b.label})`).join(', ')}; export once it is done`);
    const { readSettingsFile } = await import('../hub/push.mjs');
    const entry = pick(site, EXPORT_KEYS);
    const bundle = {
      kickflip_export: 1, route, exported_at: new Date().toISOString(), from: os.hostname(),
      entry, owner: pick(site.owner || {}, ['label', 'model']), settings: pick(readSettingsFile(), EXPORT_SETTINGS),
      dropped: Object.keys(site).filter((k) => !EXPORT_KEYS.includes(k)),
    };
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'kickflip-export-'));
    try {
      const root = path.join(stage, BUNDLE);
      const data = path.join(dir, 'data');
      fs.cpSync(dir, path.join(root, 'site'), { recursive: true, filter: (src) => !(path.dirname(src) === data && SESSION_FILE.test(path.basename(src))) });
      fs.writeFileSync(path.join(root, 'export.json'), JSON.stringify(bundle, null, 2) + '\n');
      fs.writeFileSync(path.join(root, 'README.md'), exportReadme(bundle, path.basename(file)));
      tar(['-czf', file, '-C', stage, BUNDLE]);
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
    out({ route, file, entry: Object.keys(entry), dropped: bundle.dropped, settings: Object.keys(bundle.settings) });
  },

  async import() {
    if (!args._[0]) fail('import needs the file kickflip export wrote', 2);
    const file = path.resolve(args._[0]);
    if (!fs.existsSync(file)) fail(`no file at ${file}`, 2);
    fs.mkdirSync(HOME, { recursive: true });
    const stage = fs.mkdtempSync(path.join(HOME, '.import-'));
    try {
      tar(['-xzf', file, '-C', stage]);
      const bundle = readJSON(path.join(stage, BUNDLE, 'export.json'));
      if (bundle?.kickflip_export !== 1 || !validRoute(bundle.route) || !isFolder(path.join(stage, BUNDLE, 'site'))) fail(`${file} is not a kickflip export`, 2);
      const { route } = bundle;
      const dir = path.join(HOME, 'sites', route);
      const site = await withLock(async () => {
        const m = readManifest();
        if (routeRecord(m.sites, route) || routeRecord(m.closed, route) || routeRecord(m.starting, route)) fail(`/${route} already exists on this host; import never replaces a board`);
        if (fs.existsSync(dir)) fail(`${dir} already exists; import never replaces a board's folder`);
        const entry = pick(bundle.entry || {}, EXPORT_KEYS);
        if (entry.hub && Object.values(m.sites).some((s) => s?.hub)) delete entry.hub;
        const imported = { ...entry, dir, port: await freePort(m), cmd: [nodeBin(), path.join(SKILL, 'board', 'server.mjs'), dir], updated: new Date().toISOString() };
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        fs.renameSync(path.join(stage, BUNDLE, 'site'), dir);
        m.sites = { ...m.sites, [route]: imported };
        await writeManifest(m);
        return imported;
      });
      const settings = pick(bundle.settings || {}, EXPORT_SETTINGS);
      if (Object.keys(settings).length) {
        const { readSettingsFile, writeSettingsFile } = await import('../hub/push.mjs');
        writeSettingsFile({ ...readSettingsFile(), ...settings });
      }
      const { label, model } = bundle.owner || {};
      out({
        route, dir, port: site.port, settings: Object.keys(settings), hub: site.hub === true,
        join: `kickflip join --name ${shellQuote(joinName(route, site.title))} --session <this session's id> --watch --template board${label ? ` --label ${shellQuote(label)}` : ''}${model ? ` --model ${shellQuote(model)}` : ''} --force`,
      });
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  },

  async sessions() {
    const { sessionOf } = await sessionsModule();
    const { listBoards } = await import(path.join(SKILL, 'hub', 'boards.mjs'));
    const m = readManifest();
    const live = liveSessions();
    const routes = [...listBoards(m).map((b) => b.route), ...Object.keys(m.starting || {}).filter((r) => !routeRecord(m.sites, r))];
    const rows = routes.map((route) => {
      const rec = sessionOf(m, route);
      const l = rec && live.get(rec.session);
      return { route, session: rec?.session || null, live: l ? (l.kind === 'bg' ? 'background' : 'terminal') : null, repo: rec?.repo || null, starting: !routeRecord(m.sites, route) };
    });
    if (args.json) return out(rows);
    if (!rows.length) return out('no boards');
    for (const r of rows) out(`/${r.route}  ${r.session || 'no session'}  ${r.live ? `live (${r.live})` : 'not live'}  ${r.repo || 'no folder'}${r.starting ? '  (starting: not joined yet)' : ''}`);
  },

  async hub() {
    await openHub(args.repo);
  },

  async set() {
    const route = args._[0];
    if (!route) fail('set needs a route', 2);
    if (args.icon === undefined && args.color === undefined && !args.hub && !args['no-hub']) fail('set needs --icon, --color, --hub or --no-hub', 2);
    checkLook();
    checkHub();
    await withLock(async () => {
      const m = readManifest();
      const site = routeRecord(m.sites, route) || fail('no site at /' + route);
      applyLook(site);
      applyHub(m, route, site);
      site.updated = new Date().toISOString();
      await writeManifest(m);
      out({ route, icon: site.icon ?? null, color: site.color ?? null, hub: site.hub === true });
    });
  },

  async restart() {
    const route = args._[0];
    await withLock(async () => {
      const m = readManifest();
      if (!routeRecord(m.sites, route)) fail('no site at /' + route);
      m.sites[route].restart_at = Date.now();
      await writeManifest(m);
    });
    out(`restarting /${route}; the hub picks it up within 2 seconds`);
  },

  async logs() {
    const route = args._[0];
    const file = path.join(LOGS, route + '.log');
    if (!fs.existsSync(file)) fail('no log yet for /' + route);
    const n = Number(args.lines || 40);
    out(fs.readFileSync(file, 'utf8').split('\n').slice(-n - 1).join('\n'));
  },

  async init() {
    args.fix = true;
    await commands.doctor();
  },

  async update() {
    if (fs.existsSync(path.join(SKILL, '.git'))) fail(`${SKILL} is a clone; update it with git pull`, 2);
    const result = spawnSync('npm', ['i', '-g', '@lovek4d/kickflip@latest'], { stdio: 'inherit' });
    if (result.status !== 0) fail(`npm update failed${result.error ? ': ' + result.error.message : ''}`);
    const service = hubService();
    const error = service.restart();
    if (error) fail(`update finished but the hub did not restart: ${error}; run ${service.restartCommand}`);
    out('updated kickflip and restarted the hub');
  },

  async uninstall() {
    if (uninstallStatusLine()) out(`removed ${path.join(os.homedir(), '.claude', 'statusline.sh')}`);
    const service = hubService();
    service.remove();
    try { execFileSync('tailscale', ['serve', '--https=443', '--set-path=/', 'off'], { stdio: 'ignore' }); } catch {}
    out(`hub stopped and removed from ${service.manager ?? 'the host'}; tailscale / unmapped. The manifest and sites are kept in ${HOME}`);
  },

  async push() {
    const { deliver, pushKindError } = await import(path.join(SKILL, 'hub', 'push.mjs'));
    const refused = pushKindError(args.kind);
    if (refused) fail(refused, 2);
    if (!args.title) fail('push needs --title', 2);
    if (args.url && !args.url.startsWith('/')) fail('--url is a path on the hub, such as /<route>/page.html', 2);
    const { sendWords, holdLine } = await import(path.join(SKILL, 'hub', 'schedule.mjs'));
    if (args.now && args.urgent) fail('pass --now or --urgent, not both', 2);
    const r = await deliver({ title: args.title, body: args.body || '', url: args.url || '/', tag: args.tag }, { kind: args.kind, urgent: !!args.urgent, immediate: !!args.now });
    if (r.noDevice) fail('no device has turned on notifications; open Hub → Notifications (/_hub/#notifications) in the Home Screen app and tap Turn on', 3);
    if (r.dropped) return out('dropped (notifications are off on the Hub page)');
    if (r.queued) {
      const { count, replaced, nextFlushAt, hold, sendFailed } = r.queued;
      const why = !args.now ? '' : hold ? `${holdLine(hold)}; ` : sendFailed ? 'no device took it now; ' : '';
      out(`queued (${why}${count} in queue${replaced ? '; replaced the queued push with this tag' : ''}); next send ${sendWords(nextFlushAt)}${nextFlushAt instanceof Date ? ` (${nextFlushAt.toISOString()})` : ''}`);
      if (!(await hubStatus())) out('warning: the hub is not running, so the queue goes out only once it runs');
      return;
    }
    out(r.sent);
    if (!r.sent.some((x) => x.status >= 200 && x.status < 300)) fail('every push was refused', 1);
    out(args.urgent ? 'sent (urgent)' : 'sent');
  },

  async polling() {
    const { readSettings } = await import(path.join(SKILL, 'hub', 'push.mjs'));
    const { windowAt, nextSlot, hold } = await import(path.join(SKILL, 'hub', 'schedule.mjs'));
    const now = new Date();
    const s = readSettings();
    const w = windowAt(now, s);
    const h = hold(now, s);
    out({ every: w.every_minutes, until: w.endsAt.toISOString(), next: nextSlot(now, s).toISOString(), held: h !== null, held_until: h ? (h.until instanceof Date ? h.until.toISOString() : h.until) : null, held_why: h?.why ?? null, notifications: s.notifications });
  },

  async notifications() {
    const { setNotifications, readSettings } = await import(path.join(SKILL, 'hub', 'push.mjs'));
    const [what, value] = args._;
    const onOff = (v, name) => (v === 'on' ? true : v === 'off' ? false : fail(`${name} takes on or off`, 2));
    const change = what === undefined ? null
      : what === 'on' || what === 'off' ? { on: what === 'on' }
      : what === 'weekends' ? { weekends_off: onOff(value, 'weekends') }
      : what === 'snooze' ? { snooze: value || fail('snooze takes a length: <n>m, <n>h, <n>d, <n>w, tonight, morning, monday, forever or a date and time', 2) }
      : what === 'unsnooze' ? { snooze: 'off' }
      : fail('notifications takes on, off, snooze <length>, unsnooze, or weekends on|off', 2);
    if (!change) return out(readSettings().notifications);
    let r;
    try { r = await setNotifications(change); } catch (e) { if (e.status === 400) fail(e.message, 2); throw e; }
    out(r.dropped ? { ...r.notifications, dropped: r.dropped } : r.notifications);
  },

  async 'codex-share'() {
    const bad = 'codex-share takes auto, always, or off';
    if (rest.length > 1 || (rest.length && args._.length !== 1)) fail(bad, 2);
    const { readCodexShare, setCodexShare } = await import(path.join(SKILL, 'hub', 'push.mjs'));
    if (!rest.length) return out(readCodexShare());
    try { out(setCodexShare(rest[0])); } catch (e) { if (e.status === 400) fail(e.message, 2); if (e.status === 409) fail(e.message); throw e; }
  },

  async 'usage-gate'() {
    const { readUsageGate, setPauseAt, setKeepGoing } = await import('../shared/usage-gate.mjs');
    try {
      if (rest.length) {
        if (rest[0] === 'pause-at' && rest.length === 2) setPauseAt(rest[1]);
        else if (rest[0] === 'keep-going' && rest.length === 1) setKeepGoing('on');
        else if (rest[0] === 'stop' && rest.length === 1) setKeepGoing('off');
        else fail('usage-gate takes pause-at <50..100>, keep-going, or stop', 2);
      }
      out(readUsageGate());
    } catch (e) { if (e.status) fail(e.message, e.status === 400 ? 2 : 1); throw e; }
  },

  async 'poll-now'() {
    let r;
    try {
      r = await fetch(`http://127.0.0.1:${HUB_PORT}/_hub/poll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ flush: !args['keep-queue'] }), signal: AbortSignal.timeout(10 * 60_000) });
    } catch (e) { fail('the hub is not running: ' + e.message); }
    if (!r.ok) fail(`the hub answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
    out(await r.json());
  },
};

if (!commands[cmd]) {
  const lines = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1);
  out(lines.slice(0, lines.findIndex((l) => !l.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(cmd ? 2 : 0);
}
try {
  await commands[cmd]();
} catch (e) {
  if (!(e instanceof Exit)) throw e;
  if (e.message) console.error('kickflip: ' + e.message);
  process.exit(e.code);
}
