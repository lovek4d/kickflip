// What the hub, its try relays and the board servers answer someone who isn't the owner, and the upgrade pipe the hub and
// relays use (docs/adr/2026-11-04-2156-the-whole-hub-answers-only-the-owner.md). board/on-host.mjs ownerGate gives the
// verdict 'other' or 'unread'; 'signed-out' is a request with no signed-in device's cookie, which gets the sign-in page
// (docs/adr/2026-11-18-1200-the-owner-signs-in-with-a-link-that-sets-a-device-cookie.md), and 'blocked' one from a client
// blocked for wrong PINs.
// The page is the same for every path and names no board, title, route or owner; its mark and colours are inline, since
// a refused request gets no other hub path either.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// verdict → {status, line, hint, json, form}. Nothing is shared
// (docs/adr/2026-11-18-0700-the-hub-has-no-sharing-only-the-owners-tailnet-identity-gets-in.md), so the hint offers no ask.
// form: the page takes the 8-digit PIN `kickflip link` or a hub page's Sign in a device shows
// (docs/adr/2026-11-19-0130-a-device-signs-in-with-a-60-second-pin-and-three-misses-block-it.md); 'pin-wrong' is the
// same page after a wrong PIN, and 'blocked' what a client gets on every page once its third wrong PIN blocked it.
// line and hint are HTML.
const SIGN_IN = 'Sign in first: run kickflip link on the hub’s Mac and type the PIN it prints.';
const SIGN_IN_HINT = 'Run <code>kickflip link</code> on its Mac, or tap Sign in a device on a hub page you’re signed in to, then type the 8-digit PIN.';
const BLOCKED = 'This device has been blocked, use kickflip unblock on the host machine';
const REFUSALS = {
  other: { status: 403, line: 'This kickflip belongs to someone else.', hint: 'Only its owner’s Tailscale account opens it.', json: {} },
  host: { status: 403, line: 'This kickflip answers only its own address.', hint: 'Open it on the host, or on its tailnet name.', json: { error: 'This hub answers only its own address.' } },
  unread: { status: 503, line: 'Tailscale didn’t answer, so this kickflip can’t tell who you are.', hint: 'Open it on the host itself, or try again in a moment.',
    json: { error: 'Tailscale didn’t answer, so the hub can’t tell who you are.' } },
  'signed-out': { status: 401, line: 'Sign in to open this kickflip.', hint: SIGN_IN_HINT, json: { error: SIGN_IN }, form: true },
  'pin-wrong': { status: 403, line: 'Sign in to open this kickflip.', hint: SIGN_IN_HINT, json: { error: 'Wrong PIN.' }, form: true },
  blocked: { status: 403, line: BLOCKED.replace('kickflip unblock', '<code>kickflip unblock</code>'), hint: '', json: { error: BLOCKED } },
};

const STYLE = `html, body { margin: 0; height: 100%; }
body { display: grid; place-content: center; justify-items: center; gap: 10px; padding: 32px 24px; box-sizing: border-box; background: var(--bg); color: var(--text); text-align: center;
  font: 14px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif; }
.rf-mark { display: block; margin-bottom: 8px; width: 70px; height: 60px; object-fit: contain; }
.rf-line { margin: 0; font-size: 20px; font-weight: 600; line-height: 1.3; text-wrap: balance; }
.rf-sub { margin: 0; font-size: 14px; color: var(--muted); }
.rf-form { display: flex; gap: 8px; margin-top: 14px; width: min(420px, 100%); }
.rf-form input { flex: 1; min-width: 0; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--text); font: inherit; font-size: 18px; letter-spacing: .2em; text-align: center; }
.rf-form input.err { border-color: var(--bad); }
.rf-form button { padding: 8px 14px; border: 0; border-radius: 8px; background: var(--accent); color: var(--on-accent); font: inherit; font-weight: 600; }
.rf-err { margin: 0; color: var(--bad); font-weight: 600; }
body code { background: var(--chip); padding: 2px 6px; border-radius: 6px; font: .92em ui-monospace, "SF Mono", Menlo, monospace; }`;

const escAttr = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// A path on this host to land on after a sign-in: never //host, a backslash or a scheme. → the path, else /
export const safeNext = (next) => (typeof next === 'string' && /^\/(?![/\\])/.test(next) ? next : '/');

// The PIN field drops whitespace as it's typed or pasted, and sends the form at its eighth digit.
const PIN_SCRIPT = `const f = document.querySelector('.rf-form'), i = f.elements.pin;
i.addEventListener('input', () => { i.value = i.value.replace(/\\s+/g, ''); if (/^\\d{8}$/.test(i.value)) f.requestSubmit(); });`;

// options: next, the path a sign-in lands on, which the form posts to the hub's /_hub/sign-in with the PIN; left, the
// wrong PINs a 'pin-wrong' client has left.
export function refusalPage(verdict, { next = '/', left = 0 } = {}) {
  const { line, hint, form } = REFUSALS[verdict];
  const colors = fs.readFileSync(path.join(ROOT, 'shared', 'colors.css'), 'utf8');
  const mark = fs.readFileSync(path.join(ROOT, 'board', 'public', 'kickflip.png')).toString('base64');
  const wrong = verdict === 'pin-wrong';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>kickflip</title><style>${colors}\n${STYLE}</style></head><body>
<img class="rf-mark" src="data:image/png;base64,${mark}" width="70" height="60" alt="">
<p class="rf-line">${line}</p>
${hint ? `<p class="rf-sub">${hint}</p>` : ''}
${form ? `<form class="rf-form" method="post" action="/_hub/sign-in"><input type="hidden" name="next" value="${escAttr(safeNext(next))}"><input name="pin"${wrong ? ' class="err"' : ''} value="" placeholder="8-digit PIN" aria-label="PIN" inputmode="numeric" autocomplete="one-time-code" autocapitalize="off" spellcheck="false" autofocus><button type="submit">Sign in</button></form>
<script>${PIN_SCRIPT}</script>` : ''}
${wrong ? `<p class="rf-err">Wrong PIN, ${left === 1 ? '1 try' : `${left} tries`} left</p>` : ''}
</body></html>`;
}

// A browser's request (one that accepts HTML) gets the page; anything else gets the JSON body. options: refusalPage's,
// next defaulting to the request's own path (behind the hub, a board server's gains its prefix); headers: more response
// headers, such as a sign-in's Set-Cookie.
export function refuse(req, res, verdict, { headers = {}, ...options } = {}) {
  const { status, json } = REFUSALS[verdict];
  const page = /\btext\/html\b/.test(req.headers.accept || '');
  // A board page that loses its access, or its sign-in, reads why (board/public/ui.js downOf).
  const down = { other: 'access', 'signed-out': 'signed-out', blocked: 'signed-out' }[verdict];
  const next = `${req.headers['x-forwarded-prefix'] || ''}${req.url || '/'}`;
  res.writeHead(status, { 'content-type': page ? 'text/html; charset=utf-8' : 'application/json', 'cache-control': 'no-store', ...(down ? { 'x-kickflip-down': down } : {}), ...headers });
  res.end(page ? refusalPage(verdict, { next, ...options }) : JSON.stringify(json));
  // A body the client is still sending is never read.
  req.resume();
}

const REASONS = { 401: 'Unauthorized', 403: 'Forbidden', 503: 'Service Unavailable' };
export function refuseUpgrade(socket, verdict) {
  const { status, json } = REFUSALS[verdict];
  const body = JSON.stringify(json);
  socket.end(`HTTP/1.1 ${status} ${REASONS[status]}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
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
