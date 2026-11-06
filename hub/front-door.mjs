// What the hub and its try relays answer someone who isn't the owner, and the upgrade pipe both use
// (docs/adr/2026-11-04-2156-the-whole-hub-answers-only-the-owner.md). board/on-host.mjs ownerGate gives the verdict.
// The page is the same for every path and names no board, title, route or owner; its mark and colours are inline, since
// every other hub path is refused too.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// verdict 'other', 'unread' or 'view-only' (a shared person's write, or a board path the owner keeps; hub/share.mjs)
// → {status, line, hint, json}
const REFUSALS = {
  'view-only': { status: 403, line: 'You can look at this board, not change it.', hint: 'Its owner shared it with you view only.',
    json: { error: 'This board is shared with you to look at only.' } },
  other: { status: 403, line: 'This kickflip belongs to someone else.', hint: 'Ask its owner to share it with you.', json: {} },
  unread: { status: 503, line: 'Tailscale didn’t answer, so this kickflip can’t tell who you are.', hint: 'Open it on the Mac itself, or try again in a moment.',
    json: { error: 'Tailscale didn’t answer, so the hub can’t tell who you are.' } },
};

const STYLE = `html, body { margin: 0; height: 100%; }
body { display: grid; place-content: center; justify-items: center; gap: 10px; padding: 32px 24px; box-sizing: border-box; background: var(--bg); color: var(--text); text-align: center;
  font: 14px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif; }
.rf-mark { display: block; margin-bottom: 8px; width: 70px; height: 60px; object-fit: contain; }
.rf-line { margin: 0; font-size: 20px; font-weight: 600; line-height: 1.3; text-wrap: balance; }
.rf-sub { margin: 0; font-size: 14px; color: var(--muted); }`;

export function refusalPage(verdict) {
  const { line, hint } = REFUSALS[verdict];
  const colors = fs.readFileSync(path.join(ROOT, 'shared', 'colors.css'), 'utf8');
  const mark = fs.readFileSync(path.join(ROOT, 'board', 'public', 'kickflip.png')).toString('base64');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>kickflip</title><style>${colors}\n${STYLE}</style></head><body>
<img class="rf-mark" src="data:image/png;base64,${mark}" width="70" height="60" alt="">
<p class="rf-line">${line}</p>
<p class="rf-sub">${hint}</p>
</body></html>`;
}

// A browser's request (one that accepts HTML) gets the page; anything else gets the JSON body.
export function refuse(req, res, verdict) {
  const { status, json } = REFUSALS[verdict];
  const page = /\btext\/html\b/.test(req.headers.accept || '');
  // A board page that loses its share reads 'access' (board/public/ui.js downOf).
  res.writeHead(status, { 'content-type': page ? 'text/html; charset=utf-8' : 'application/json', 'cache-control': 'no-store', ...(verdict === 'other' ? { 'x-kickflip-down': 'access' } : {}) });
  res.end(page ? refusalPage(verdict) : JSON.stringify(json));
  // A body the client is still sending is never read.
  req.resume();
}

export function refuseUpgrade(socket, verdict) {
  const { status, json } = REFUSALS[verdict];
  const body = JSON.stringify(json);
  socket.end(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Service Unavailable'}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

// Pipes an upgrade request through to 127.0.0.1:port as `path`, with its headers except those named in `replace`,
// then the `extra` header lines. → the upstream socket
export function pipeUpgrade({ req, socket, head, port, path: target, replace = [], extra = [] }) {
  const up = net.connect(port, '127.0.0.1', () => {
    const lines = [`${req.method} ${target} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) if (!replace.includes(req.rawHeaders[i].toLowerCase())) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    up.write([...lines, ...extra].join('\r\n') + '\r\n\r\n');
    if (head && head.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
  socket.on('close', () => up.destroy());
  up.on('close', () => socket.destroy());
  return up;
}
