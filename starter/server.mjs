#!/usr/bin/env node
// Site server from the web-ts starter kit. The hub runs it with PORT and
// PREFIX (/<route>) set, and strips the prefix before forwarding; requests
// that still carry it (local testing) are served the same.
//   GET  /...                    files from ./public (directories serve index.html)
//   POST /_claude/events         {kind, ...data} from a page → one line in data/events.jsonl;
//                                the owning session's wait-events watcher wakes on it
//   GET  /_claude/events         events, newest first, each with Claude's reply if written
//                                (?kind=<kind>&limit=<n>)
//   GET  /_claude/needs          {items: [{kind, text, url}], working?, summary?} from data/needs.json, which
//                                the owning session writes: what waits on the owner (url relative to the site
//                                root), how many of the owner's messages it is working on, and a one-line
//                                summary. No file means nothing waits; the hub badges and describes the
//                                site's row with them
//   GET  /_claude/health
// Claude replies to event <id> by writing data/replies/<id>.html (an HTML
// fragment) or data/replies/<id>.json.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, 'public');
const data = path.join(here, 'data');
const events = path.join(data, 'events.jsonl');
const replies = path.join(data, 'replies');
const needs = path.join(data, 'needs.json');
const port = Number(process.env.PORT || 4600);
const prefix = (process.env.PREFIX || '').replace(/\/+$/, '');
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.woff2': 'font/woff2',
};

const json = (res, code, body) => { res.writeHead(code, { 'content-type': types['.json'], 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };

async function readBody(req, limit = 64 * 1024) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > limit) throw Object.assign(new Error('too large'), { status: 413 }); }
  return body ? JSON.parse(body) : {};
}

async function listEvents(kind, limit) {
  let lines = [];
  try { lines = (await fs.readFile(events, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch {}
  if (kind) lines = lines.filter((e) => e.kind === kind);
  lines = lines.reverse().slice(0, limit);
  return Promise.all(lines.map(async (e) => {
    for (const ext of ['html', 'json']) {
      const f = path.join(replies, `${e.id}.${ext}`);
      try {
        const [text, st] = await Promise.all([fs.readFile(f, 'utf8'), fs.stat(f)]);
        return { ...e, reply: { [ext]: ext === 'json' ? JSON.parse(text) : text, at: st.mtime.toISOString() } };
      } catch {}
    }
    return { ...e, reply: null };
  }));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://site');
    let p = url.pathname;
    if (prefix && (p === prefix || p.startsWith(prefix + '/'))) p = p.slice(prefix.length) || '/';

    if (p === '/_claude/health') return json(res, 200, { ok: true });
    if (p === '/_claude/needs') {
      const text = await fs.readFile(needs, 'utf8').catch((e) => (e.code === 'ENOENT' ? '{"items":[]}' : Promise.reject(e)));
      const { items, working, summary } = JSON.parse(text);
      if (!Array.isArray(items)) throw new Error('data/needs.json has no items array');
      return json(res, 200, {
        items: items.map(({ kind, text, url }) => ({ kind: String(kind || ''), text: String(text || ''), url: String(url || '') })),
        ...(Number.isInteger(working) && working >= 0 ? { working } : {}),
        ...(typeof summary === 'string' ? { summary } : {}),
      });
    }
    if (p === '/_claude/events' && req.method === 'POST') {
      const body = await readBody(req);
      const kind = String(body.kind || 'message').slice(0, 64);
      delete body.kind;
      const e = { id: 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), ts: new Date().toISOString(), kind, data: body };
      await fs.mkdir(replies, { recursive: true });
      await fs.appendFile(events, JSON.stringify(e) + '\n');
      return json(res, 200, { id: e.id });
    }
    if (p === '/_claude/events' && req.method === 'GET') {
      return json(res, 200, await listEvents(url.searchParams.get('kind'), Math.min(500, Number(url.searchParams.get('limit') || 100))));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }

    let file = path.resolve(pub, '.' + decodeURIComponent(p));
    if (file !== pub && !file.startsWith(pub + path.sep)) { res.writeHead(404).end(); return; }
    if ((await fs.stat(file).catch(() => null))?.isDirectory()) file = path.join(file, 'index.html');
    const body = await fs.readFile(file);
    res.writeHead(200, { 'content-type': types[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (err) {
    if (!res.headersSent) res.writeHead(err.status || (err.code === 'ENOENT' ? 404 : 400)).end();
  }
});

server.listen(port, '127.0.0.1', () => console.log(`site on http://127.0.0.1:${port}/ (prefix ${prefix || 'none'})`));
