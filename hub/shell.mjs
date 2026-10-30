// Which requests the hub answers with the app shell, board/public/app.html (docs/adr/0055-one-app-for-the-whole-hub.md).
// A browser's top-level load of `/` or of a board's own page gets the shell, which mounts the board as a view; every
// other request goes on as before, so curl, a frame, an API call or an upload still reaches the site's real page.

// method, pathname and dest (the request's Sec-Fetch-Dest header) from the request; boards, the set of board routes.
// → 'shell' | 'hub' (the hub's own paths) | 'forward' (a site's path, forwarded with its prefix stripped)
export function pageOf({ method = 'GET', pathname = '/', dest, boards = new Set() }) {
  if (pathname === '/') return method === 'GET' || method === 'HEAD' ? 'shell' : 'hub';
  if (pathname === '/_hub' || pathname.startsWith('/_hub/') || pathname === '/sw.js' || pathname === '/manifest.webmanifest' || pathname === '/favicon.ico') return 'hub';
  const m = /^\/([^/]+)\/$/.exec(pathname);
  let route = null;
  try { route = m ? decodeURIComponent(m[1]) : null; } catch { route = null; }
  return method === 'GET' && dest === 'document' && route !== null && boards.has(route) ? 'shell' : 'forward';
}

// Each root-absolute /_hub/app/<file> link in the shell gains ?v=<version>, so a pinned file caches for a year and an
// edit reaches the browser through the shell, which revalidates on every load. versionOf(file) → string | null.
export function versionAppAssets(html, versionOf) {
  return html.replace(/\b(src|href)="\/_hub\/app\/([\w.-]+\.(?:js|css))"/g, (m, attr, file) => {
    const v = versionOf(file);
    return v ? `${attr}="/_hub/app/${file}?v=${v}"` : m;
  });
}
