#!/usr/bin/env node
// web-ts: manage the shared site manifest the hub (../hub/hub.mjs) serves.
//   web-ts status [--json]
//   web-ts join <route> --session <id> [--label <name>] [--title <t>] [--description <d>]
//               [--dir <path>] [--cmd '<json array>'] [--port <n>] [--watch <file,file>]
//               [--filter <regex>] [--template board [--items <waves|file>]] [--force]
//               [--icon <key>] [--color <css hex>] [--repo <dir>] [--model <m>]
//               --template board runs the shared board (../board/server.mjs) from the site dir,
//               writing its board.json; --items is "waves" (default) or a wave.json-format file.
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
//   web-ts start <route> [--repo <dir>] [--model <m>] [--prompt <text>]
//               starts a background session (`claude --bg`, auto mode, worktree isolation off) in --repo, else
//               the route's recorded folder, else the cwd, named after the board, whose first prompt is
//               `/join-web-ts <route>` plus --prompt. Records it as the route's owner, or in `starting` until a
//               join takes it up when the route has no site yet. Prints {route, session, confirmed, repo, argv, output}
//   web-ts resume <route>
//               `claude --resume <id> --bg` for the route's recorded session in its folder, prompting it to rejoin
//               and relaunch its watcher, and records the id it comes back under as the route's owner. Prints
//               {route, session, previous, confirmed, repo, argv, output}. Exit 1 when no session or folder is recorded
//   web-ts sessions [--json]
//               one line per board: route, session id, live (background or terminal) or not, folder
//   web-ts handshake <route>
//               tests a board's hub links (../hub/boards.mjs handshake): appends a `hello` event, which the
//               owning session answers with `board.mjs hello-ack <eventId>`. The board shows a setup checklist
//               until the session answered and the hub's GitHub check reached it. Prints {route, hello}
//   web-ts set <route> [--icon <key>] [--color <hex>]
//               changes an existing site's icon or color without joining; '' clears one
//   web-ts leave <route> --session <id> [--force]
//   web-ts restart <route>
//   web-ts logs <route> [--lines <n>]
//   web-ts install | uninstall
//   web-ts push --kind action|prompt|fault --title <t> [--body <b>] [--url </route/path>] [--tag <tag>]
//               [--now | --urgent]
//               notify every device that turned on notifications on hub Settings; a tap opens --url.
//               --kind says what waits on the owner (../hub/push.mjs PUSH_KINDS): action, a card's Action needed
//               appearing or changing; prompt, a background session's prompt; fault, something only the owner
//               can fix. A push without one is refused (exit 2): news stays on the board.
//               The push queues, replacing a queued one with the same
//               --tag, and goes out after the hub's next GitHub check on the polling interval
//               (/_hub/settings/polling) or when a monitor tick ends (board.mjs checked), each
//               queued push as its own notification. --now sends at once unless pushes are held
//               (overnight, snoozed or the weekend), and queues if no device takes it; it is for questions,
//               steps only the owner can run and prototypes. --urgent sends at once through
//               those holds, for a production fault. While notifications are off every push is dropped, urgent ones too.
//               Prints "sent", "queued" with the next send time, or "dropped". Exit 3 when no device has turned them on.
//   web-ts polling
//               prints {every, until, next, held, held_until, held_why, notifications}: the current polling
//               window's minutes, when it ends, the next check, whether pushes are held now, until when
//               ("never" while off) and why (off, snoozed, weekend or overnight), and the notifications settings
//   web-ts notifications [on | off | snooze <length> | unsnooze | weekends on|off]
//               sets the hub Settings Notifications controls and prints them; off drops the queued pushes.
//               A snooze length is a hub/schedule.mjs snoozeEnd choice. Without a change it only prints them
//   web-ts poll-now [--keep-queue]
//               asks the hub for one poll now (GitHub check, github-change events,
//               checked.json, then the queue unless --keep-queue) and prints its result
// Exit codes: 0 ok, 1 error, 2 bad usage, 3 route owned by another session (join/leave), or its recorded session is
// live (start/resume).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ICON_KEYS } from '../hub/icons.mjs';
import { liveSessions } from '../hub/live.mjs';

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = path.join(os.homedir(), '.claude', 'web-ts');
const MANIFEST = path.join(HOME, 'manifest.json');
const LOGS = path.join(HOME, 'logs');
const HUB_PORT = Number(process.env.WEB_TS_HUB_PORT || 4500);
const FIRST_SITE_PORT = 4600;
const LABEL = 'local.claude.web-ts-hub';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', LABEL + '.plist');
const ROUTE_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

const [cmd, ...rest] = process.argv.slice(2);
const args = { _: [] };
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    if (k === 'force' || k === 'json' || k === 'urgent' || k === 'now' || k === 'keep-queue') args[k] = true;
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
const nodeBin = () => (fs.existsSync('/opt/homebrew/bin/node') ? '/opt/homebrew/bin/node' : process.execPath);

function readManifest() {
  try { const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); m.sites ||= {}; return m; }
  catch (e) { if (e.code === 'ENOENT') return { version: 1, sites: {} }; fail('manifest unreadable: ' + e.message); }
}
const readJSON = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const sessionsModule = () => import(path.join(SKILL, 'hub', 'sessions.mjs'));
// ../hub/sessions.mjs refusals as exits: a live session 3, nothing recorded or claude failing 1.
async function sessionCall(fn) {
  const { SessionError } = await sessionsModule();
  try { return await fn(); } catch (e) { if (e instanceof SessionError) fail(e.message, e.reason === 'live' ? 3 : 1); throw e; }
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
function writeManifest(m) {
  fs.mkdirSync(HOME, { recursive: true });
  const tmp = MANIFEST + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n');
  fs.renameSync(tmp, MANIFEST);
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
  const taken = new Set(Object.values(m.sites).map((s) => s.port));
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

function tailscaleRoot() {
  try {
    const s = JSON.parse(execFileSync('tailscale', ['serve', 'status', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    const handlers = Object.values(s.Web || {})[0]?.Handlers || {};
    return { root: handlers['/']?.Proxy || null, paths: Object.keys(handlers) };
  } catch { return { root: null, paths: [] }; }
}

const commands = {
  async status() {
    const m = readManifest();
    const hub = await hubStatus();
    const ts = tailscaleRoot();
    const installed = fs.existsSync(PLIST);
    const report = {
      hub: { installed, running: !!hub, port: HUB_PORT, plist: PLIST, log: path.join(HOME, 'hub.log') },
      tailscale: { host: tailnetHost(), root: ts.root, mounts: ts.paths, pointsAtHub: !!ts.root && ts.root.endsWith(':' + HUB_PORT) },
      sites: hub ? hub.sites : Object.entries(m.sites).map(([route, s]) => ({ route, title: s.title, port: s.port, state: 'hub not running', owner: s.owner })),
    };
    if (args.json) return out(report);
    out(`hub: ${report.hub.running ? 'running' : 'NOT running'}${installed ? '' : ' (not installed: run `web-ts install`)'} on 127.0.0.1:${HUB_PORT}`);
    out(`tailscale /: ${ts.root || 'nothing'}${report.tailscale.pointsAtHub ? '' : '  (expected the hub on ' + HUB_PORT + ')'}${ts.paths.filter((p) => p !== '/').length ? '; other mounts: ' + ts.paths.filter((p) => p !== '/').join(', ') : ''}`);
    if (!report.sites.length) out('no sites');
    for (const s of report.sites) out(`  /${s.route}  ${s.state}  port ${s.port}  owner ${s.owner?.label || s.owner?.session || '-'}  ${s.title || ''}`);
  },

  async join() {
    const route = args._[0];
    if (!route || !ROUTE_RE.test(route)) fail('join needs a route: lowercase letters, digits and dashes', 2);
    if (!args.session) fail('join needs --session <id> (this session\'s id)', 2);
    if (args.template && args.template !== 'board') fail('--template takes "board"', 2);
    checkLook();
    const result = await withLock(async () => {
      const m = readManifest();
      const now = new Date().toISOString();
      const existing = m.sites[route];
      if (existing?.owner?.session && existing.owner.session !== args.session && !args.force) {
        out({ error: 'owned', route, owner: existing.owner, hint: 'ask the user, then rerun with --force to take it over' });
        throw new Exit('', 3);
      }
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
        fs.mkdirSync(path.join(site.dir, 'data'), { recursive: true });
        const cfgFile = path.join(site.dir, 'board.json');
        const cfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};
        cfg.title = args.title || cfg.title || route;
        cfg.items = args.items || cfg.items || 'waves';
        fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
        site.cmd = [nodeBin(), path.join(SKILL, 'board', 'server.mjs'), site.dir];
        created = !existing;
      }
      if (args.title) site.title = args.title;
      if (args.description) site.description = args.description;
      if (args.watch) site.watch = args.watch.split(',').map((s) => s.trim()).filter(Boolean);
      if (args.filter !== undefined) site.filter = args.filter || undefined;
      applyLook(site);
      site.title ||= route;
      const previous = existing?.owner && existing.owner.session !== args.session ? existing.owner : null;
      const started = m.starting?.[route]?.session === args.session ? m.starting[route] : null;
      const same = existing?.owner?.session === args.session ? existing.owner : null;
      const kept = same || started || previous;
      site.owner = {
        ...(same || { session: args.session, since: now }),
        label: args.label || kept?.label || '',
        repo: args.repo ? path.resolve(args.repo) : liveSessions().get(args.session)?.cwd || kept?.repo || process.cwd(),
      };
      const model = args.model || kept?.model;
      if (model) site.owner.model = model;
      if (m.starting?.[route]) { delete m.starting[route]; if (!Object.keys(m.starting).length) delete m.starting; }
      site.updated = now;
      m.sites[route] = site;
      writeManifest(m);
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
      watcher: `${nodeBin()} ${path.join(SKILL, 'bin', 'wait-events.mjs')} ${route} ${args.session}`,
      hub: hub ? 'running' : 'NOT running: run `web-ts install`',
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
    if (!args.session && !args.force) fail('leave needs --session <id>, or --force', 2);
    await withLock(async () => {
      const m = readManifest();
      const s = m.sites[route];
      if (!s) fail('no site at /' + route);
      if (s.owner?.session && s.owner.session !== args.session && !args.force) {
        out({ error: 'owned', route, owner: s.owner }); throw new Exit('', 3);
      }
      delete m.sites[route];
      writeManifest(m);
      out({ left: route, filesKept: s.dir });
    });
  },

  async start() {
    const route = args._[0];
    if (!route || !ROUTE_RE.test(route)) fail('start needs a route: lowercase letters, digits and dashes', 2);
    const { startSession } = await sessionsModule();
    const r = await sessionCall(() => startSession(route, { manifest: readManifest(), repo: args.repo, model: args.model, prompt: args.prompt }));
    await withLock(async () => {
      const m = readManifest();
      const owner = { session: r.session, label: r.name, since: new Date().toISOString(), repo: r.repo, ...(r.model ? { model: r.model } : {}) };
      if (m.sites[route]) { m.sites[route].owner = owner; m.sites[route].updated = owner.since; }
      else m.starting = { ...m.starting, [route]: owner };
      writeManifest(m);
    });
    out({ route: r.route, session: r.session, confirmed: r.confirmed, repo: r.repo, argv: r.argv, output: r.output });
  },

  async resume() {
    const route = args._[0];
    if (!route) fail('resume needs a route', 2);
    const { resumeSession } = await sessionsModule();
    out(await sessionCall(() => resumeSession(route, { manifest: readManifest() })));
  },

  async sessions() {
    const { sessionOf } = await sessionsModule();
    const { listBoards } = await import(path.join(SKILL, 'hub', 'boards.mjs'));
    const m = readManifest();
    const live = liveSessions();
    const routes = [...listBoards(m).map((b) => b.route), ...Object.keys(m.starting || {}).filter((r) => !m.sites[r])];
    const rows = routes.map((route) => {
      const rec = sessionOf(m, route);
      const l = rec && live.get(rec.session);
      return { route, session: rec?.session || null, live: l ? (l.kind === 'bg' ? 'background' : 'terminal') : null, repo: rec?.repo || null, starting: !m.sites[route] };
    });
    if (args.json) return out(rows);
    if (!rows.length) return out('no boards');
    for (const r of rows) out(`/${r.route}  ${r.session || 'no session'}  ${r.live ? `live (${r.live})` : 'not live'}  ${r.repo || 'no folder'}${r.starting ? '  (starting: not joined yet)' : ''}`);
  },

  async set() {
    const route = args._[0];
    if (!route) fail('set needs a route', 2);
    if (args.icon === undefined && args.color === undefined) fail('set needs --icon or --color', 2);
    checkLook();
    await withLock(async () => {
      const m = readManifest();
      const site = m.sites[route] || fail('no site at /' + route);
      applyLook(site);
      site.updated = new Date().toISOString();
      writeManifest(m);
      out({ route, icon: site.icon ?? null, color: site.color ?? null });
    });
  },

  async restart() {
    const route = args._[0];
    await withLock(async () => {
      const m = readManifest();
      if (!m.sites[route]) fail('no site at /' + route);
      m.sites[route].restart_at = Date.now();
      writeManifest(m);
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

  async install() {
    fs.mkdirSync(HOME, { recursive: true });
    fs.mkdirSync(path.dirname(PLIST), { recursive: true });
    const hubLog = path.join(HOME, 'hub.log');
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${nodeBin()}</string><string>${path.join(SKILL, 'hub', 'hub.mjs')}</string></array>
  <key>WorkingDirectory</key><string>${HOME}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${path.dirname(nodeBin())}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${hubLog}</string>
  <key>StandardErrorPath</key><string>${hubLog}</string>
</dict>
</plist>
`;
    fs.writeFileSync(PLIST, plist);
    const uid = String(process.getuid());
    try { execFileSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'ignore' }); } catch {}
    await new Promise((r) => setTimeout(r, 500));
    execFileSync('launchctl', ['bootstrap', `gui/${uid}`, PLIST]);
    let up = false;
    for (let i = 0; i < 30 && !up; i++) { await new Promise((r) => setTimeout(r, 300)); up = await connects(HUB_PORT); }
    if (!up) fail('hub did not start; see ' + hubLog);
    execFileSync('tailscale', ['serve', '--bg', String(HUB_PORT)], { stdio: 'ignore' });
    const m = readManifest();
    for (const p of tailscaleRoot().paths) {
      if (p !== '/' && m.sites[p.replace(/^\//, '').replace(/\/$/, '')]) {
        try { execFileSync('tailscale', ['serve', '--https=443', '--set-path=' + p, 'off'], { stdio: 'ignore' }); } catch {}
      }
    }
    await commands.status();
  },

  async uninstall() {
    const uid = String(process.getuid());
    try { execFileSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'ignore' }); } catch {}
    try { fs.unlinkSync(PLIST); } catch {}
    try { execFileSync('tailscale', ['serve', '--https=443', '--set-path=/', 'off'], { stdio: 'ignore' }); } catch {}
    out('hub stopped and removed from login items; tailscale / unmapped. The manifest and sites are kept in ' + HOME);
  },

  async push() {
    const { deliver, pushKindError } = await import(path.join(SKILL, 'hub', 'push.mjs'));
    const refused = pushKindError(args.kind);
    if (refused) fail(refused, 2);
    if (!args.title) fail('push needs --title', 2);
    if (args.url && !args.url.startsWith('/')) fail('--url is a path on the hub, such as /<route>/page.html', 2);
    const { clock, holdLine } = await import(path.join(SKILL, 'hub', 'schedule.mjs'));
    if (args.now && args.urgent) fail('pass --now or --urgent, not both', 2);
    const r = await deliver({ title: args.title, body: args.body || '', url: args.url || '/', tag: args.tag }, { kind: args.kind, urgent: !!args.urgent, immediate: !!args.now });
    if (r.noDevice) fail('no device has turned on notifications; open hub Settings (/_hub/settings) in the Home Screen app and tap Turn on', 3);
    if (r.dropped) return out('dropped (notifications are off on hub Settings)');
    if (r.queued) {
      const { count, replaced, nextFlushAt, hold, sendFailed } = r.queued;
      const why = !args.now ? '' : hold ? `${holdLine(hold)}; ` : sendFailed ? 'no device took it now; ' : '';
      out(`queued (${why}${count} in queue${replaced ? '; replaced the queued push with this tag' : ''}); next send ${clock(nextFlushAt)} (${nextFlushAt.toISOString()})`);
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
      : what === 'snooze' ? { snooze: value || fail('snooze takes a length: <n>m, <n>h, <n>d, <n>w, tonight, morning, monday or a date and time', 2) }
      : what === 'unsnooze' ? { snooze: 'off' }
      : fail('notifications takes on, off, snooze <length>, unsnooze, or weekends on|off', 2);
    if (!change) return out(readSettings().notifications);
    let r;
    try { r = await setNotifications(change); } catch (e) { if (e.status === 400) fail(e.message, 2); throw e; }
    out(r.dropped ? { ...r.notifications, dropped: r.dropped } : r.notifications);
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
  if (e.message) console.error('web-ts: ' + e.message);
  process.exit(e.code);
}
