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
// form: the page takes the 8-digit PIN `kickflip link` or Hub settings › Devices' Show PIN shows
// (docs/adr/2026-11-19-0130-a-device-signs-in-with-a-60-second-pin-and-three-misses-block-it.md); 'pin-wrong' is the
// same page after a wrong PIN, and 'blocked' what a client gets on every page once its third wrong PIN blocked it.
// line and hint are HTML.
const SIGN_IN = 'Sign in first: run kickflip link on the hub’s Mac and type the PIN it prints.';
const SIGN_IN_HINT = 'Run <code>kickflip link</code> on its host, or go to Hub &gt; Devices &gt; Show PIN on a signed in device.';
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
.rf-form { width: min(420px, 100%); margin-top: 14px; }
.rf-boxes { position: relative; display: flex; justify-content: center; gap: 6px; cursor: text; }
.rf-box { flex: 1; max-width: 40px; height: 50px; display: grid; place-items: center; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.rf-box:nth-child(4) { margin-right: 10px; }
.rf-boxes:focus-within .rf-box.cur { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.rf-boxes:focus-within .rf-box.cur::after { content: ""; width: 2px; height: 24px; background: var(--accent); animation: rf-caret 1s steps(2) infinite; }
.rf-boxes.err .rf-box { border-color: var(--bad); }
.rf-boxes.lock .rf-box { border-color: var(--accent); animation: rf-pulse 1.1s ease-in-out infinite; }
@keyframes rf-caret { 50% { opacity: 0; } }
@keyframes rf-pulse { 50% { opacity: .35; } }
.rf-boxes input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; padding: 0; border: 0; opacity: 0; font-size: 16px; caret-color: transparent; }
.rf-status { height: 24px; margin: 0; font-weight: 600; line-height: 24px; }
.rf-status.bad { color: var(--bad); }
.rf-status.info { color: var(--accent); }
body a { color: var(--accent); }
body code { background: var(--chip); padding: 2px 6px; border-radius: 6px; font: .92em ui-monospace, "SF Mono", Menlo, monospace; }`;

const escAttr = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// A path on this host to land on after a sign-in: never //host, a backslash or a scheme. → the path, else /
export const safeNext = (next) => (typeof next === 'string' && /^\/(?![/\\])/.test(next) ? next : '/');

// One input under the eight boxes takes what is typed, pasted or filled in, keeps its first eight digits and paints them
// into the boxes, the next empty one as the caret. A new digit clears a wrong PIN's red; the eighth locks the boxes,
// reads Signing in… in the status slot and sends the form.
const PIN_SCRIPT = `const f = document.querySelector('.rf-form'), i = f.querySelector('input[name=pin]'), wrap = f.querySelector('.rf-boxes'), boxes = f.querySelectorAll('.rf-box'), status = document.querySelector('.rf-status');
const paint = () => boxes.forEach((b, n) => { b.textContent = i.value[n] || ''; b.classList.toggle('cur', n === i.value.length); });
i.addEventListener('input', () => {
  i.value = i.value.replace(/\\D+/g, '').slice(0, 8);
  wrap.classList.remove('err');
  status.classList.remove('bad', 'info');
  status.textContent = '';
  paint();
  if (i.value.length < 8) return;
  i.readOnly = true;
  wrap.classList.add('lock');
  status.classList.add('info');
  status.textContent = 'Signing in…';
  f.requestSubmit();
});
paint();`;

// options: next, the path a sign-in lands on, which the form posts to the hub's /_hub/sign-in with the PIN; left, the
// wrong PINs a 'pin-wrong' client has left; hub, the hub's own address, given by a try port, which has no sign-in route:
// its page links there in place of the PIN form (the cookie the hub sets there is sent to every port of the host).
export function refusalPage(verdict, { next = '/', left = 0, hub = '' } = {}) {
  let { line, hint, form } = REFUSALS[verdict];
  if (form && hub) {
    line = 'Sign in on the hub first.';
    hint = `Open <a href="${escAttr(hub)}">the hub</a>, sign in there, then reload this page.`;
    form = false;
  }
  const colors = fs.readFileSync(path.join(ROOT, 'shared', 'colors.css'), 'utf8');
  const mark = fs.readFileSync(path.join(ROOT, 'board', 'public', 'kickflip.png')).toString('base64');
  const wrong = verdict === 'pin-wrong';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>kickflip</title><style>${colors}\n${STYLE}</style></head><body>
<img class="rf-mark" src="data:image/png;base64,${mark}" width="70" height="60" alt="">
<p class="rf-line">${line}</p>
${hint ? `<p class="rf-sub">${hint}</p>` : ''}
${form ? `<form class="rf-form" method="post" action="/_hub/sign-in"><input type="hidden" name="next" value="${escAttr(safeNext(next))}"><label class="rf-boxes${wrong ? ' err' : ''}">${'<span class="rf-box"></span>'.repeat(8)}<input name="pin" value="" aria-label="PIN" inputmode="numeric" autocomplete="one-time-code" autocapitalize="off" spellcheck="false" autofocus></label></form>
<p class="rf-status${wrong ? ' bad' : ''}" role="status" aria-live="polite">${wrong ? `Wrong PIN, ${left === 1 ? '1 try' : `${left} tries`} left` : ''}</p>
<script>${PIN_SCRIPT}</script>` : ''}
</body></html>`;
}

// A page load (a request that accepts HTML, navigates, or is the worker's shell refetch) gets the page; anything else gets the JSON body. options: refusalPage's,
// next defaulting to the request's own path (behind the hub, a board server's gains its prefix); headers: more response
// headers, such as a sign-in's Set-Cookie.
export function refuse(req, res, verdict, { headers = {}, ...options } = {}) {
  const { status, json } = REFUSALS[verdict];
  const h = req.headers;
  const page = /\btext\/html\b/.test(h.accept || '') || h['x-app-shell'] === '1' || h['sec-fetch-mode'] === 'navigate' || h['sec-fetch-dest'] === 'document';
  // A board page that loses its access, or its sign-in, reads why (board/public/ui.js downOf).
  const down = { other: 'access', 'signed-out': 'signed-out', blocked: 'signed-out' }[verdict];
  const next = `${req.headers['x-forwarded-prefix'] || ''}${req.url || '/'}`;
  res.writeHead(status, { 'content-type': page ? 'text/html; charset=utf-8' : 'application/json', 'cache-control': 'no-store', ...(down ? { 'x-kickflip-down': down } : {}), ...headers });
  res.end(page ? refusalPage(verdict, { next, ...options }) : JSON.stringify(json));
  // A body the client is still sending is never read.
  req.resume();
}

// The log line for a refused request: the verdict, the listening port, and the names its Host and Origin headers carried
// (never a path, query or cookie), so the next refusal can be traced.
export function refusalLine(req, verdict, port) {
  const name = (value) => (value === undefined ? '-' : String(value).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').toLowerCase().slice(0, 100));
  return `refused ${verdict} on port ${port}: Host ${name(req.headers.host)}, Origin ${name(req.headers.origin)}`;
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
