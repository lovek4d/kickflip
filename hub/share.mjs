// Sharing a board with another Tailscale identity
// (docs/adr/2026-11-05-2215-a-board-is-shared-view-only-with-a-tailscale-login.md), View or Full
// (docs/adr/2026-11-05-1912-a-shared-person-is-view-or-full.md). A board's board.json `share` lists the logins exactly
// as tailscale serve's Tailscale-User-Login sends them: a bare login is View, {login, level: 'full'} is Full. The hub's
// gate (board/on-host.mjs ownerGate) calls anyone else `other`; for a login some board shares with, shareReach says which
// paths it reaches instead: the shell and its files, the sidebar and stream (sharedSidebar filters them to the shared
// boards), the shared boards' own pages and reads by GET or HEAD, and on a Full board its event and upload POSTs, whose
// kinds the board server checks. All are allow-lists, checked on the hub's one parse of the path, which the hub then
// forwards as is to the board. The tracker keeps when each shared person was last seen on each board, whether they're
// viewing now, and who was just refused at the door, for Board settings' Sharing section.
import path from 'node:path';
import { isBoardSite, readJSON, saveJSON } from './boards.mjs';

// A login as Tailscale-User-Login sends it: an email, or name@github for a GitHub sign-in.
export const validLogin = (v) => typeof v === 'string' && v.length <= 200 && /^[^\s@]+@[^\s@]+$/.test(v);
// board.json → [{login, level: 'view' | 'full'}], each login once, its first entry winning
export function shareEntries(cfg) {
  const entries = new Map();
  for (const e of Array.isArray(cfg?.share) ? cfg.share : []) {
    const login = typeof e === 'string' ? e : e?.login;
    if (validLogin(login) && !entries.has(login)) entries.set(login, { login, level: e?.level === 'full' ? 'full' : 'view' });
  }
  return [...entries.values()];
}
// board.json → [login]
export const shareOf = (cfg) => shareEntries(cfg).map((e) => e.login);

// sites: the manifest's sites. board.json is read on each call, since Board settings edits it underneath.
// → Map of the board routes whose share lists login → its level there
export function sharedRoutes(login, sites) {
  const routes = new Map();
  for (const [route, s] of Object.entries(sites || {})) {
    const entry = isBoardSite(s) && shareEntries(readJSON(path.join(s.dir, 'board.json'), {})).find((e) => e.login === login);
    if (entry) routes.set(route, entry.level);
  }
  return routes;
}

// The shell's own files and the hub's paths that serve it.
const SHELL = new Set(['/', '/sw.js', '/manifest.webmanifest', '/favicon.ico']);
const HUB_FILES = /^\/_hub\/(?:app\/[\w.-]+|colors\.css|kickflip\.png|hub\.css|icon-(?:180|192|512)\.png|sidebar\.json|stream)$/;
// The hub's own pages, which send a shared person to `/`, their first shared board.
const HUB_PAGES = new Set(['/_hub', '/_hub/', '/_hub/settings', '/_hub/settings/polling']);
// What a shared board view reads, the path after the route: the board's pages and the files they load, its prototypes
// and uploads, and its data, threads, notes and Main's build log. Everything else stays the owner's, such as Board
// settings and the reads behind it that reach past the board (any of the host's logs by name, the Slack members and
// GitHub logins Board settings picks reviewers from, the hub's rules), the event log, the board's own stream (the shell
// follows /_hub/stream) and upgrades.
const BOARD_READS = new RegExp('^/(?:' + [
  '', 'questions\\.html', 'notes\\.html', 'plan\\.html', 'index\\.html', 'prototype-[a-z0-9-]+\\.html',
  '[\\w-][\\w.-]*\\.(?:js|mjs|css|png|svg|ico|webp|jpe?g|gif|woff2?)', 'prototypes/[a-z0-9-]+/[\\w-][\\w.-]*\\.js', 'uploads/[^/]+',
  'api/(?:board|questions|done|links|working|thread|notes|plan|try/main/log)',
].join('|') + ')$');
// What a Full person writes, the path after the route: events, whose kind the board server checks, and attachments.
const FULL_WRITES = new Set(['/_claude/events', '/api/upload']);

// method and pathname from the request, pathname as the hub parses it (WHATWG URL, so already free of dot segments and
// backslashes) and forwards it; routes, sharedRoutes for its login.
// → 'pass' | 'home' (a hub page: redirect to `/`) | 'view-only' (a write, or a board path the owner keeps) | 'other'
export function shareReach({ method = 'GET', pathname, routes }) {
  const read = method === 'GET' || method === 'HEAD';
  if (SHELL.has(pathname) || HUB_FILES.test(pathname)) return read ? 'pass' : 'view-only';
  if (HUB_PAGES.has(pathname)) return read ? 'home' : 'other';
  const m = /^\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!m || !routes.has(m[1])) return 'other';
  const rest = m[2] || '/';
  // The board strips its own /<route> again, so a path naming the route twice would reach past this check.
  if (rest === `/${m[1]}` || rest.startsWith(`/${m[1]}/`)) return 'view-only';
  if (read) return BOARD_READS.test(rest) ? 'pass' : 'view-only';
  return method === 'POST' && routes.get(m[1]) === 'full' && FULL_WRITES.has(rest) ? 'pass' : 'view-only';
}

// The route a path names, or null for `/` and the hub's own paths.
export function routeOfPath(pathname) {
  const first = String(pathname || '').split('/')[1] || '';
  if (!first || first === '_hub' || first.includes('.')) return null;
  try { return decodeURIComponent(first); } catch { return null; }
}

// What /_hub/sidebar.json and the stream's sidebar give a shared person: their shared boards alone, with no count or
// context reading, which are the owner's; no hub row, usage, notifications or starting boards. by: the owner's name;
// full: the routes they have Full on, which the shell follows.
export function sharedSidebar(data, routes, by) {
  const sites = (data?.sites || []).filter((s) => routes.has(s.route)).map(({ count, ctx, ...s }) => s);
  const full = [...routes].filter(([, level]) => level === 'full').map(([route]) => route);
  return { code: data?.code ?? null, total: 0, start: sites[0]?.route ?? null, sites, starting: [], shared: { by: by || null, full } };
}

const REFUSED_FOR_MS = 60 * 60_000;
const REFUSED_KEPT = 20;
const SAVE_EVERY_MS = 60_000;

// file: where last-seen times outlive a restart, {login: {name, at: {route: ISO}}}. The refused list lives in memory.
// → {visit(login, name, route), watching(login) → done, refuse(login, name, route), people(route, logins), refusals(route, logins)}
export function shareTracker({ file, now = Date.now } = {}) {
  const seen = readJSON(file, {});
  const savedAt = new Map(); // `${login} ${route}` → when that time was last written
  const streams = new Map(); // login → open /_hub/stream count
  const lastRoute = new Map(); // login → the board they last asked for
  let refused = []; // [{login, name, route, at}], newest first
  const save = () => { try { saveJSON(file, seen); } catch {} };

  return {
    // A shared person's request: on a board when route is set, else the shell's own paths.
    visit(login, name, route) {
      const entry = seen[login] ||= { name: null, at: {} };
      let changed = false;
      if (name && entry.name !== name) { entry.name = name; changed = true; }
      if (route) {
        lastRoute.set(login, route);
        const at = new Date(now()).toISOString();
        entry.at[route] = at;
        const key = `${login} ${route}`;
        if (!(now() - (savedAt.get(key) ?? -Infinity) < SAVE_EVERY_MS)) { savedAt.set(key, now()); changed = true; }
      }
      if (changed) save();
    },
    // The shell holds /_hub/stream while its page is open; → done, called when it closes.
    watching(login) {
      streams.set(login, (streams.get(login) || 0) + 1);
      return () => { const n = streams.get(login) - 1; if (n > 0) streams.set(login, n); else streams.delete(login); };
    },
    refuse(login, name, route) {
      refused = [{ login, name: name || null, route: route || null, at: new Date(now()).toISOString() }, ...refused.filter((r) => r.login !== login)].slice(0, REFUSED_KEPT);
    },
    // logins: the board's share. → [{login, name, now, at}], at null when never seen there
    people(route, logins) {
      return logins.map((login) => ({ login, name: seen[login]?.name || null, now: streams.has(login) && lastRoute.get(login) === route, at: seen[login]?.at?.[route] || null }));
    },
    // Logins refused in the last hour at this board's paths or at a path naming no board, not already shared on it.
    // → [{login, name, at}]
    refusals(route, logins) {
      const since = now() - REFUSED_FOR_MS;
      return refused.filter((r) => Date.parse(r.at) >= since && (r.route === route || r.route === null) && !logins.includes(r.login))
        .map(({ login, name, at }) => ({ login, name, at }));
    },
  };
}
