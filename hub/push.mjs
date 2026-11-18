// Web Push for every hub site, with no dependencies. The hub serves the
// subscribe and unsubscribe side (hub.mjs); every push goes through deliver(), which refuses a push that isn't one of PUSH_KINDS and
// queues one unless it is urgent or immediate, and every push reaches every subscription.
// The queue goes out through flushQueue() after each of the hub's checks (schedule.mjs), a board's one push as it is and its several as one summary
// (docs/adr/2026-11-02-1733-queued-pushes-go-as-one-summary-per-board.md).
// State lives in <home>/.claude/kickflip/push, home being os.homedir() unless a call names one: vapid.json (the signing key),
// subs.json (one entry per phone or browser that enabled notifications, with
// the hub origin it subscribed from and its user agent), queue.json (pushes waiting to go) and log.jsonl (the push log,
// pushLog). Quiet hours are
// `quiet` in ~/.claude/kickflip/settings.json, with `notifications` beside it.
// A subscription the push service reports gone (404 or 410) is dropped. deliver and flushQueue reach the push service
// and the hub through the fetch they are given, global fetch unless given.
// Payload encryption is RFC 8291 (aes128gcm); the Authorization header is RFC 8292 (VAPID).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ALERTS, alertsOf, validate, quietOf, flushAt, hold, notifications, snoozeEnd } from './schedule.mjs';
import { storedEnd } from './duration.mjs';
import { read as readSettingsFile, update as updateSettings } from '../shared/hub-settings.mjs';

const pushFile = (home, name) => path.join(home, '.claude', 'kickflip', 'push', name);
const vapidFile = (home) => pushFile(home, 'vapid.json');
const subsFile = (home) => pushFile(home, 'subs.json');
const queueFile = (home) => pushFile(home, 'queue.json');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(s, 'base64url');
const hmac = (key, input) => crypto.createHmac('sha256', key).update(input).digest();
const writePrivate = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
};

function vapidKey(home) {
  try { return JSON.parse(fs.readFileSync(vapidFile(home), 'utf8')); } catch {}
  const jwk = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' });
  writePrivate(vapidFile(home), jwk);
  return jwk;
}

export function publicKey(home = os.homedir()) {
  const jwk = vapidKey(home);
  return b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]));
}

function readSubs(home) {
  try { return JSON.parse(fs.readFileSync(subsFile(home), 'utf8')); } catch { return []; }
}

// origin: the https origin of the hub page that subscribed. It becomes the VAPID
// `sub` claim, which Apple's push service requires to be a mailto: or https: URL.
export function addSubscription(sub, origin, agent = '', home = os.homedir()) {
  if (!/^https:\/\//.test(sub?.endpoint || '') || !sub.keys?.p256dh || !sub.keys?.auth) throw Object.assign(new Error('bad subscription'), { status: 400 });
  const subs = readSubs(home).filter((s) => s.endpoint !== sub.endpoint);
  subs.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, origin, agent: String(agent).slice(0, 200), added: new Date().toISOString() });
  writePrivate(subsFile(home), subs);
  return { count: subs.length, id: deviceId(sub.endpoint) };
}

// A device's id in the page: a hash of its endpoint, so the page can name a line without ever holding the endpoint.
const deviceId = (endpoint) => crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 16);

export function removeSubscriptionById(id, home = os.homedir()) {
  const subs = readSubs(home);
  const left = subs.filter((s) => deviceId(s.endpoint) !== id);
  if (left.length !== subs.length) writePrivate(subsFile(home), left);
  return left.length;
}

// The page of a device whose subscription went (hub-kit.js device) names its endpoint here; an endpoint the hub
// doesn't hold changes nothing. → the count left
export function removeSubscription(endpoint, home = os.homedir()) {
  const subs = readSubs(home);
  const left = subs.filter((s) => s.endpoint !== endpoint);
  if (left.length !== subs.length) writePrivate(subsFile(home), left);
  return left.length;
}

// The kind and browser a user agent names; a name it doesn't recognise is ''. iPhone and iPad agents also say "Mac OS X".
export function deviceNames(agent = '') {
  const kind = ['iPhone', 'iPad', 'Android', 'Windows', 'Macintosh', 'Linux'].find((k) => agent.includes(k));
  const browser = [['Edg/', 'Edge'], ['OPR/', 'Opera'], ['Firefox/', 'Firefox'], ['FxiOS/', 'Firefox'], ['CriOS/', 'Chrome'], ['Chrome/', 'Chrome'], ['Safari/', 'Safari']].find(([m]) => agent.includes(m));
  return { kind: kind === 'Macintosh' ? 'Mac' : kind || '', browser: browser?.[1] || '' };
}

// added is the last time the device's page re-posted its subscription (hub-kit.js device), so it reads as last seen.
export function subscriptions(home = os.homedir()) {
  return readSubs(home)
    .map((s) => ({ id: deviceId(s.endpoint), host: new URL(s.endpoint).host, agent: s.agent, added: s.added, ...deviceNames(s.agent) }));
}

function encrypt(sub, payload) {
  const uaPublic = unb64u(sub.keys.p256dh);
  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const prkKey = hmac(unb64u(sub.keys.auth), ecdh.computeSecret(uaPublic));
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const salt = crypto.randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

function authorization(sub, home) {
  const jwk = vapidKey(home);
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: new URL(sub.endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: sub.origin || 'mailto:kickflip@localhost' }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key: crypto.createPrivateKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${publicKey(home)}`;
}

// What waits on the owner, fresh from the hub's /_hub/needs.json: {total, sites} with total the Home Screen badge count
// and sites as hub.mjs serves them, or {} when the hub doesn't answer.
async function hubNeeds(fetch) {
  try {
    const r = await fetch(`http://127.0.0.1:${Number(process.env.KICKFLIP_HUB_PORT || 4500)}/_hub/needs.json?fresh=1`, { signal: AbortSignal.timeout(4000) });
    const { total, sites } = await r.json();
    return { total: Number.isInteger(total) ? total : undefined, sites };
  } catch { return {}; }
}

// message: {title, body, url, tag}. url is a path on the hub, such as
// /<route>/page.html#x; the service worker opens it on tap. The payload adds badge, the count of
// what waits on the owner across every site when this sends (needs, a hubNeeds result, else fetched now), which the
// service worker shows.
export const sendAll = (message) => sendTo(readSubs(os.homedir()), message, undefined, { home: os.homedir(), fetch });

// docs/adr/2026-11-15-2230-a-push-closes-the-older-notifications-under-its-tag.md (the declarative push spike)
// Apple's push service (iOS and macOS Safari) gets a declarative push (Safari 18.4): the browser shows the notification
// itself, under its tag, without the service worker, which only sees it where declarative push isn't supported. A
// subscription from before the hub recorded its origin has no absolute URL to navigate to and keeps the worker's payload.
const isApple = (sub) => new URL(sub.endpoint).host === 'web.push.apple.com';
const declarative = (sub) => isApple(sub) && Boolean(sub.origin);
function payloadFor(sub, message, badge, id) {
  if (!declarative(sub)) return { ...message, badge, id };
  const notification = { title: message.title, body: message.body || '', navigate: new URL(message.url || '/', sub.origin).href, tag: message.tag, silent: Boolean(message.silent) };
  if (Number.isInteger(badge)) notification.app_badge = badge;
  return { web_push: 8030, notification, id };
}

async function sendTo(allSubs, message, needs, { home, fetch }) {
  // A close or silent push to Apple would show a notification of its own (every push there shows one), so Apple gets none.
  const subs = message.close || message.silent ? allSubs.filter((sub) => !isApple(sub)) : allSubs;
  if (!subs.length) return [];
  const badge = (needs || await hubNeeds(fetch)).total;
  const id = crypto.randomBytes(4).toString('hex');
  const results = await Promise.all(subs.map(async (sub) => {
    const payload = JSON.stringify(payloadFor(sub, message, badge, id));
    try {
      const r = await fetch(sub.endpoint, {
        method: 'POST',
        headers: { authorization: authorization(sub, home), 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', urgency: 'high' },
        body: encrypt(sub, payload),
        signal: AbortSignal.timeout(15000),
      });
      return { sub, status: r.status, error: r.ok ? undefined : (await r.text()).slice(0, 300) };
    } catch (e) { return { sub, status: 0, error: String(e.message || e) }; }
  }));
  const gone = new Set(results.filter((r) => r.status === 404 || r.status === 410).map((r) => r.sub.endpoint));
  if (gone.size) writePrivate(subsFile(home), readSubs(home).filter((s) => !gone.has(s.endpoint)));
  const ts = new Date().toISOString();
  appendLog(home, results.map((r) => ({
    ts, id, tag: message.tag || message.close, title: message.title, silent: message.close ? undefined : Boolean(message.silent), close: message.close ? true : undefined,
    host: new URL(r.sub.endpoint).host, device: deviceId(r.sub.endpoint), declarative: !message.close && declarative(r.sub) ? true : undefined, status: r.status, error: r.error,
  })));
  return results.map((r) => ({ host: new URL(r.sub.endpoint).host, agent: r.sub.agent, status: r.status, error: r.error, dropped: gone.has(r.sub.endpoint) || undefined }));
}

// ---------- push log ----------
// push/log.jsonl: each push sent to each device, {ts, id, tag, title, silent | close, host, device, declarative?,
// status, error?}, and each report a service worker posts back for one of them (reportPush), the last LOG_MAX lines.
// `kickflip push log` prints it. Two processes send pushes (the hub's flush, kickflip push), so two writes at once
// can lose a line.
const LOG_MAX = 1000;
const logFile = (home) => pushFile(home, 'log.jsonl');

function appendLog(home, entries) {
  if (!entries.length) return;
  const lines = [...pushLog(home), ...entries].slice(-LOG_MAX).map((e) => JSON.stringify(e));
  writeLines(logFile(home), lines);
}
function writeLines(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function pushLog(home = os.homedir()) {
  let text;
  try { text = fs.readFileSync(logFile(home), 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}

// body: what hub/sw.js report posts to /_hub/push/report, {id, sw, tag, older, closed, declarative, endpoint}. The
// endpoint is kept only as its device id. Throws {status: 400} for a report without an id or with counts that aren't.
export function reportPush(body, home = os.homedir()) {
  const count = (n) => n === undefined || (Number.isInteger(n) && n >= 0);
  if (typeof body?.id !== 'string' || !body.id || !count(body.older) || !count(body.closed)) throw Object.assign(new Error('bad push report'), { status: 400 });
  const text = (s) => (typeof s === 'string' ? s.slice(0, 200) : undefined);
  appendLog(home, [{
    ts: new Date().toISOString(), report: true, id: text(body.id), sw: text(body.sw), tag: text(body.tag), older: body.older, closed: body.closed,
    declarative: typeof body.declarative === 'boolean' ? body.declarative : undefined, device: typeof body.endpoint === 'string' ? deviceId(body.endpoint) : undefined,
  }]);
}

// One line per push to a device, oldest first, with the report from that device for it on the same line; a report
// whose push has left the log prints on its own.
export function pushLogLines(log) {
  const reports = new Map(log.filter((e) => e.report).map((e) => [`${e.id} ${e.device}`, e]));
  const phone = (r) => `phone: sw ${r.sw || '?'}${r.declarative ? ', declarative payload' : ''}, found ${r.older ?? '?'} older, closed ${r.closed ?? '?'}`;
  const sentKeys = new Set(log.filter((e) => !e.report).map((e) => `${e.id} ${e.device}`));
  return log.flatMap((e) => {
    if (e.report) return sentKeys.has(`${e.id} ${e.device}`) ? [] : [`${e.ts} ${e.id} ${e.tag || '-'} ${phone(e)}`];
    const what = e.close ? `close ${e.tag}` : `${e.tag || '-'} ${e.silent ? 'silent' : 'alert'}${e.declarative ? ' declarative' : ''} "${e.title}"`;
    const r = reports.get(`${e.id} ${e.device}`);
    return [`${e.ts} ${e.id} ${e.host} ${what} → ${e.status}${e.error ? ` ${e.error}` : ''}${r ? ` · ${phone(r)}` : ''}`];
  });
}

const delivered = (results) => results.some((r) => r.status >= 200 && r.status < 300);

// ---------- settings ----------
// The saved quiet hours and notifications: old `polling` windows are migrated, and a missing or invalid file gives the defaults.
export function readSettings(home) {
  return quietOf(readSettingsFile(home));
}

// Rewrites old `polling` windows, and the `push` block before them, as `quiet`, and drops the old `autoRestart` key. Returns the quiet hours, or null when
// there was nothing to migrate.
export async function migrateSettings(home) {
  let migrated = null;
  await updateSettings((file) => {
    if (!file.polling && !file.push && !('autoRestart' in file)) return file;
    const { push, polling, autoRestart, ...rest } = file;
    migrated = quietOf(file).quiet;
    return { ...rest, quiet: migrated };
  }, home);
  return migrated;
}

// Throws {status: 400} with the validation message; returns the saved settings. An input without notifications
// keeps the saved ones.
export async function saveSettings(input, home = os.homedir()) {
  const { settings, error } = validate({ notifications: readSettings(home).notifications, ...input });
  if (error) throw Object.assign(new Error(error), { status: 400 });
  await updateSettings(({ push, polling, ...rest }) => ({ ...rest, quiet: settings.quiet, notifications: settings.notifications }), home);
  return settings;
}

// The saved alert switches (schedule.mjs alertsOf).
export const readAlerts = (home) => alertsOf(readSettingsFile(home));

// Turns one alert switch on or off, keeping the rest of settings.json. Throws {status: 400} for a kind that isn't in
// schedule.mjs ALERTS; returns the switches saved.
export async function setAlert(kind, on, home = os.homedir()) {
  if (!Object.hasOwn(ALERTS, kind)) throw Object.assign(new Error(`No alert called ${kind}.`), { status: 400 });
  let saved;
  await updateSettings((file) => ({ ...file, alerts: (saved = { ...alertsOf(file), [kind]: on }) }), home);
  return saved;
}

// change: {on}, {weekends_off} or {snooze}, where snooze is a schedule.mjs snoozeEnd choice or 'off' to end one.
// Turning notifications off drops the queue. Throws {status: 400} on a bad change; returns {notifications, dropped}.
export async function setNotifications(change, now = new Date(), home = os.homedir()) {
  const s = readSettings(home);
  const next = { ...s.notifications };
  if ('on' in change) next.on = change.on;
  if ('weekends_off' in change) next.weekends_off = change.weekends_off;
  if ('snooze' in change) {
    const end = change.snooze === 'off' ? null : snoozeEnd(now, change.snooze, s);
    if (end === null && change.snooze !== 'off') throw Object.assign(new Error('A snooze must end after now and within 30 days: <n>m, <n>h, <n>d, <n>w, tonight, morning, monday or a date and time; or forever or off.'), { status: 400 });
    next.snoozed_until = end && storedEnd(end);
  }
  const { notifications: saved } = await saveSettings({ ...s, notifications: next }, home);
  const dropped = saved.on ? 0 : await withQueueLock(home, () => {
    const { items } = readQueue(home);
    if (items.length) writePrivate(queueFile(home), { items: [] });
    return items.length;
  });
  return { notifications: saved, dropped };
}

function readQueue(home) {
  try {
    const q = JSON.parse(fs.readFileSync(queueFile(home), 'utf8'));
    return { items: Array.isArray(q.items) ? q.items : [] };
  } catch { return { items: [] }; }
}

// The CLI and the hub both write queue.json.
async function withQueueLock(home, fn) {
  const lock = queueFile(home) + '.lock';
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) { fs.rmdirSync(lock); continue; } } catch {}
      if (Date.now() > deadline) throw new Error('push queue is locked; try again');
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch {} }
}

// { settings, held, hold, count, nextFlushAt } for the settings page and the CLI.
// held: a poll now would keep the queue; hold says why and until when (schedule.mjs hold). nextFlushAt is null when
// nothing is queued.
export function queueStatus(now = new Date(), home = os.homedir()) {
  const settings = readSettings(home);
  const { items } = readQueue(home);
  const h = hold(now, settings);
  return { settings, held: h !== null, hold: h, count: items.length, nextFlushAt: items.length ? flushAt(now, settings) : null };
}

// What a push may be about (docs/adr/2026-10-29-1639-pushes-only-when-something-waits-on-the-owner.md): action, a card's Action
// needed appearing or changing; prompt, a background session's pending prompt; fault, something only the owner can fix;
// reminder, a push the owner asked a session for in words (docs/adr/2026-11-03-1842-more-of-the-skill-moves-into-code.md).
export const PUSH_KINDS = ['action', 'prompt', 'fault', 'reminder'];
export class PushKindError extends Error {}
export const pushKindError = (kind) => (PUSH_KINDS.includes(kind) ? null
  : `a push needs --kind ${PUSH_KINDS.join('|')}${kind === undefined || kind === true ? '' : `, not "${kind}"`}; news goes on the board, not in a push`);

// message: as for sendAll. kind: one of PUSH_KINDS, else it throws a PushKindError and nothing is sent or queued.
// Returns {noDevice: true} with nothing sent or queued when no device has subscribed;
// {dropped: true}, with nothing sent or queued, for any push while notifications are off;
// {sent: results} for an urgent push, or for an immediate one that reached a device while pushes aren't held
// (schedule.mjs heldUntil); else {queued: {count, replaced, nextFlushAt, held, hold, sendFailed}}. A push queued or
// sent replaces a queued one with the same tag. A push sent now, or flushed later, reaches every subscription at that moment.
// silent, for a push with a tag (docs/adr/2026-11-15-1300-a-boards-needs-you-pushes-are-one-live-row.md): with that
// tag queued, its title, body and url rewrite the queued push, which still alerts when it goes → {queued}; else it is
// sent at once through every hold but off, and the service worker replaces the tag's notification without alerting
// → {sent: results}. It never queues.
export async function deliver(message, { kind, urgent = false, immediate = false, silent = false, at = new Date(), home = os.homedir(), fetch = globalThis.fetch } = {}) {
  const refused = pushKindError(kind);
  if (refused) throw new PushKindError(refused);
  if (!readSubs(home).length) return { noDevice: true };
  const msg = { title: message.title, body: message.body || '', url: message.url || '/', tag: message.tag || undefined };
  const h = hold(at, readSettings(home));
  if (h?.why === 'off') return { dropped: true };
  const held = h !== null;
  if (silent) {
    const rewrote = await withQueueLock(home, () => {
      const q = readQueue(home);
      const queued = q.items.find((i) => i.tag === msg.tag);
      if (!queued) return false;
      Object.assign(queued, { title: msg.title, body: msg.body, url: msg.url });
      writePrivate(queueFile(home), q);
      return true;
    });
    if (!rewrote) return { sent: await sendTo(readSubs(home), { ...msg, silent: true }, undefined, { home, fetch }) };
    const status = queueStatus(at, home);
    return { queued: { replaced: true, count: status.count, nextFlushAt: status.nextFlushAt, held, hold: h, sendFailed: false } };
  }
  let sendFailed = false;
  if (urgent || (immediate && !held)) {
    const results = await sendTo(readSubs(home), msg, undefined, { home, fetch });
    if (delivered(results)) {
      if (msg.tag) await withQueueLock(home, () => writePrivate(queueFile(home), { items: readQueue(home).items.filter((i) => i.tag !== msg.tag) }));
      return { sent: results };
    }
    if (urgent) return { sent: results };
    sendFailed = true;
  }
  const item = { id: crypto.randomUUID(), ...msg, kind, queuedAt: at.toISOString() };
  const queued = await withQueueLock(home, () => {
    const q = readQueue(home);
    const kept = item.tag ? q.items.filter((i) => i.tag !== item.tag) : q.items;
    const replaced = kept.length < q.items.length;
    q.items = [...kept, item];
    writePrivate(queueFile(home), q);
    return { replaced };
  });
  const status = queueStatus(at, home);
  return { queued: { ...queued, count: status.count, nextFlushAt: status.nextFlushAt, held, hold: h, sendFailed } };
}

// Sets the body of the queued push with this tag to revise(its body), and its url to `url` when given; sends
// nothing. Returns the new body, or null when no push with the tag is queued, so a push already sent stays as it went out.
export async function reviseQueued(tag, revise, url) {
  const home = os.homedir();
  if (!tag || !readQueue(home).items.some((i) => i.tag === tag)) return null;
  return withQueueLock(home, () => {
    const q = readQueue(home);
    const item = q.items.find((i) => i.tag === tag);
    if (!item) return null;
    item.body = revise(item.body || '');
    if (url) item.url = url;
    writePrivate(queueFile(home), q);
    return item.body;
  });
}

// docs/adr/2026-11-15-0800-owner-actions-follow-state-gone-pushes-close-stale-taps-refused.md
// Withdraws the pushes with these tags on route's board, which no longer wait on the owner: a queued one is dropped
// (question ids are unique only within a site, so the shared queue matches the route too), and for a tag with none
// queued, one already went out, so {close: tag} goes to every subscription now and the service worker closes that
// tag's notification. Quiet hours, a snooze and the weekend don't hold a close, which alerts nothing; while
// notifications are off nothing is sent. → {dropped, closed}, the tags of each
export async function withdraw(tags, route, { home = os.homedir(), fetch = globalThis.fetch, at = new Date() } = {}) {
  const wanted = new Set(tags);
  const matches = (item) => wanted.has(item.tag) && typeof item.url === 'string' && item.url.startsWith(`/${route}/`);
  const dropped = !readQueue(home).items.some(matches) ? [] : await withQueueLock(home, () => {
    const { items } = readQueue(home);
    const gone = items.filter(matches);
    if (gone.length) writePrivate(queueFile(home), { items: items.filter((item) => !matches(item)) });
    return [...new Set(gone.map((item) => item.tag))];
  });
  const sent = tags.filter((tag) => !dropped.includes(tag));
  if (!sent.length || hold(at, readSettings(home))?.why === 'off' || !readSubs(home).length) return { dropped, closed: [] };
  for (const tag of sent) await sendTo(readSubs(home), { close: tag }, undefined, { home, fetch });
  return { dropped, closed: sent };
}

let flushing = null;
// Sends the queue as schedule.mjs notifications, built from what waits on each board now to every subscription at flush time. The queue is emptied before sending, so two flushes at
// once never send a push twice. Returns null when nothing was queued, else {count, sent, ok, results}, with sent the
// notifications that went: the pushes behind one no device took go back to the queue unless a newer one has their tag.
export function flushQueue({ home = os.homedir(), fetch = globalThis.fetch } = {}) {
  flushing ||= (async () => {
    const items = await withQueueLock(home, () => {
      const q = readQueue(home);
      if (q.items.length) writePrivate(queueFile(home), { items: [] });
      return q.items;
    });
    if (!items.length) return null;
    const sent = [];
    const failed = [];
    const results = [];
    const needs = await hubNeeds(fetch);
    for (const m of notifications(items, needs.sites)) {
      const r = await sendTo(readSubs(home), { title: m.title, body: m.body, url: m.url, tag: m.tag }, needs, { home, fetch });
      results.push(...r);
      (delivered(r) ? sent : failed).push(m);
    }
    if (failed.length) await withQueueLock(home, () => {
      const q = readQueue(home);
      const newer = new Set(q.items.map((i) => i.tag).filter(Boolean));
      const back = items.filter((i) => failed.some((f) => f.members.includes(i.id)) && !(i.tag && newer.has(i.tag)));
      writePrivate(queueFile(home), { items: [...back, ...q.items] });
    });
    return { count: items.length, sent: sent.length, ok: !failed.length, results };
  })().finally(() => { flushing = null; });
  return flushing;
}
