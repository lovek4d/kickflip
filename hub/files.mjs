// A plain page joined with `kickflip page <name> --dir <folder>` and no server: the hub serves the folder's files
// itself, with the /<route> prefix already stripped (docs/adr/2026-11-01-1446-a-page-joins-without-a-session.md).
import fs from 'node:fs/promises';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.woff2': 'font/woff2', '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

const plain = (res, code, text, extra = {}) => {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra });
  res.end(text);
};

// rest is the request's path and query under the route; prefix is /<route>. A folder serves its index.html, and one
// asked for without its trailing slash redirects to it, so the page's relative links resolve. A path with a part
// starting with "." is refused, so a project folder's .git or .env never leaves the host. headers are added to a file's
// response.
export async function serveFiles(req, res, { dir, rest, prefix, headers = {} }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, 405, 'A page served from its files takes only GET.', { allow: 'GET, HEAD' });
  const url = new URL(rest, 'http://page');
  let parts;
  try { parts = decodeURIComponent(url.pathname).split('/'); } catch { return plain(res, 400, 'Bad path.'); }
  if (parts.some((p) => p.startsWith('.') || p.includes('\0'))) return plain(res, 404, 'Not found.');
  const root = path.resolve(dir);
  let file = path.resolve(root, '.' + parts.join('/'));
  if (file !== root && !file.startsWith(root + path.sep)) return plain(res, 404, 'Not found.');
  const st = await fs.stat(file).catch(() => null);
  if (st?.isDirectory()) {
    if (!url.pathname.endsWith('/')) {
      res.writeHead(301, { location: `${prefix}${url.pathname}/${url.search}`, 'cache-control': 'no-store' });
      return res.end();
    }
    file = path.join(file, 'index.html');
  }
  let body;
  try { body = await fs.readFile(file); } catch { return plain(res, 404, 'Not found.'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store', 'content-length': body.length, ...headers });
  res.end(req.method === 'HEAD' ? undefined : body);
}
