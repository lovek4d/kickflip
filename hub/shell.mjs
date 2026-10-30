// The app shell, board/public/app.html (docs/adr/0055-one-app-for-the-whole-hub.md): which requests the hub answers
// with it, and its HTML, which the hub and each board server both serve. A browser's top-level load of `/` or of a
// board page that is a view gets the shell from the hub, with the sidebar drawn in. Every other request goes on to its
// site: a board server answers its view pages with the shell too, without the sidebar, so a browser that sends no
// Sec-Fetch-Dest, curl and a frame get it there, and a frame's shell hands its URL to the app around it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HUB_DIR = path.dirname(fileURLToPath(import.meta.url));
export const BOARD_PUBLIC = path.join(HUB_DIR, '..', 'board', 'public');
// Where /_hub/app/<file> is read from, first match wins, as the board server reads its own public/ folders.
const APP_ROOTS = [BOARD_PUBLIC, path.join(HUB_DIR, '..', 'starter', 'public')];
const COLORS = path.join(HUB_DIR, '..', 'shared', 'colors.css');

// A board's pages that are views of the shell, by their path under the board (board/public/router.js).
export const VIEW_PAGES = new Set(['', 'settings.html', 'questions.html', 'notes.html']);

// method, pathname and dest (the request's Sec-Fetch-Dest header) from the request; boards, the set of board routes.
// → 'shell' | 'hub' (the hub's own paths) | 'forward' (a site's path, forwarded with its prefix stripped)
export function pageOf({ method = 'GET', pathname = '/', dest, boards = new Set() }) {
  if (pathname === '/') return method === 'GET' || method === 'HEAD' ? 'shell' : 'hub';
  if (pathname === '/_hub' || pathname.startsWith('/_hub/') || pathname === '/sw.js' || pathname === '/manifest.webmanifest' || pathname === '/favicon.ico') return 'hub';
  const m = /^\/([^/]+)\/([^/]*)$/.exec(pathname);
  let route = null;
  try { route = m ? decodeURIComponent(m[1]) : null; } catch { route = null; }
  return method === 'GET' && dest === 'document' && route !== null && boards.has(route) && VIEW_PAGES.has(m[2]) ? 'shell' : 'forward';
}

// Each root-absolute /_hub/app/<file> link in the shell gains ?v=<version>, so a pinned file caches for a year and an
// edit reaches the browser through the shell, which revalidates on every load. versionOf(file) → string | null.
export function versionAppAssets(html, versionOf) {
  return html.replace(/\b(src|href)="\/_hub\/app\/([\w.-]+\.(?:js|css))"/g, (m, attr, file) => {
    const v = versionOf(file);
    return v ? `${attr}="/_hub/app/${file}?v=${v}"` : m;
  });
}

// /_hub/app/<name>'s file, or null.
export function appFile(name) {
  if (!/^[\w.-]+\.(?:js|css|png)$/.test(name)) return null;
  for (const root of APP_ROOTS) { const f = path.join(root, name); try { if (fs.statSync(f).isFile()) return f; } catch {} }
  return null;
}
export const fileVersion = (f) => { try { const st = fs.statSync(f); return `${Math.floor(st.mtimeMs).toString(36)}-${st.size.toString(36)}`; } catch { return null; } };
// The version /_hub/colors.css?v= pins for a year.
export const colorsVersion = () => fileVersion(COLORS) || '0';

// app.html, read on each call so an edit is live on the next load, with its /_hub/app/ links versioned. sidebar is the
// sidebar's rows and sidebarData their data as JSON for a script; a server with neither leaves the sidebar empty, and
// shell.js fetches /_hub/sidebar.json. touchIcon is the Home Screen icon's URL.
export function shellHtml({ sidebar = '', sidebarData = 'null', touchIcon = '/_hub/icon-180.png' } = {}) {
  const html = versionAppAssets(fs.readFileSync(path.join(BOARD_PUBLIC, 'app.html'), 'utf8'), (name) => { const f = appFile(name); return f && fileVersion(f); });
  const fill = { sidebar, sidebarData, touchIcon, colorsVersion: colorsVersion() };
  return html.replace(/\{\{(sidebar|sidebarData|touchIcon|colorsVersion)\}\}/g, (_, k) => fill[k]);
}
