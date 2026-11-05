// Sharing a board with another Tailscale identity, view only
// (docs/adr/2026-11-05-2215-a-board-is-shared-view-only-with-a-tailscale-login.md). A board's board.json `share` lists the
// logins exactly as tailscale serve's Tailscale-User-Login sends them. The hub's gate (board/on-host.mjs ownerGate) calls
// anyone else `other`; for a login some board shares with, shareReach says which paths it reaches instead: the shell and
// its files, the sidebar and stream (sharedSidebar filters them to the shared boards), and the shared boards' own pages
// and reads, by GET or HEAD alone. The tracker keeps when each shared person was last seen on each board, whether they're
// viewing now, and who was just refused at the door, for Board settings' Sharing section.
import path from 'node:path';
import { isBoardSite, readJSON, saveJSON } from './boards.mjs';

// A login as Tailscale-User-Login sends it: an email, or name@github for a GitHub sign-in.
export const validLogin = (v) => typeof v === 'string' && v.length <= 200 && /^[^\s@]+@[^\s@]+$/.test(v);
// board.json → [login]
export const shareOf = (cfg) => (Array.isArray(cfg?.share) ? [...new Set(cfg.share.filter(validLogin))] : []);

// sites: the manifest's sites. board.json is read on each call, since Board settings edits it underneath.
// → Set of the board routes whose share lists login
export function sharedRoutes(login, sites) {
  const routes = new Set();
  for (const [route, s] of Object.entries(sites || {})) {
    if (isBoardSite(s) && shareOf(readJSON(path.join(s.dir, 'board.json'), {})).includes(login)) routes.add(route);
  }
  return routes;
}

// The shell's own files and the hub's paths that serve it.
const SHELL = new Set(['/', '/sw.js', '/manifest.webmanifest', '/favicon.ico']);
const HUB_FILES = /^\/_hub\/(?:app\/[\w.-]+|colors\.css|kickflip\.png|hub\.css|icon-(?:180|192|512)\.png|sidebar\.json|stream)$/;
// The hub's own pages, which send a shared person to `/`, their first shared board.
const HUB_PAGES = new Set(['/_hub', '/_hub/', '/_hub/settings', '/_hub/settings/polling']);
// A shared board's paths that stay the owner's: its settings, and reads that reach past the board (any of the host's logs
// by name, the Slack members and GitHub logins Board settings picks reviewers from, the hub's rules).
const PRIVATE = /^\/(?:settings\.html|api\/(?:settings|permissions|rules|reviewer-people|log))(?:[/?]|$)/;

// method and pathname from the request; routes, sharedRoutes for its login.
// → 'pass' | 'home' (a hub page: redirect to `/`) | 'view-only' (a write, or a board path the owner keeps) | 'other'
export function shareReach({ method = 'GET', pathname, routes }) {
  const read = method === 'GET' || method === 'HEAD';
  if (SHELL.has(pathname) || HUB_FILES.test(pathname)) return read ? 'pass' : 'view-only';
  if (HUB_PAGES.has(pathname)) return read ? 'home' : 'other';
  const m = /^\/([^/]+)(\/.*)?$/.exec(pathname);
  let route = null;
  try { route = m && decodeURIComponent(m[1]); } catch { route = null; }
  if (!route || !routes.has(route)) return 'other';
  return read && !PRIVATE.test(m[2] || '/') ? 'pass' : 'view-only';
}

// The route a path names, or null for `/` and the hub's own paths.
export function routeOfPath(pathname) {
  const first = String(pathname || '').split('/')[1] || '';
  if (!first || first === '_hub' || first.includes('.')) return null;
  try { return decodeURIComponent(first); } catch { return null; }
}

// What /_hub/sidebar.json and the stream's sidebar give a shared person: their shared boards alone, with no count or
// context reading, which are the owner's; no hub row, usage, notifications or starting boards. by: the owner's name.
export function sharedSidebar(data, routes, by) {
  const sites = (data?.sites || []).filter((s) => routes.has(s.route)).map(({ count, ctx, ...s }) => s);
  return { code: data?.code ?? null, total: 0, start: sites[0]?.route ?? null, sites, starting: [], shared: { by: by || null } };
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
