// Web Push for every hub site, with no dependencies. The hub serves the
// subscribe and unsubscribe side (hub.mjs); every push goes through deliver(), which refuses a push that isn't one of PUSH_KINDS and
// queues one unless it is urgent or immediate. While the owner is at the host (presence.mjs), an action push reaches
// the desktop subscriptions only, unless urgent or no desktop has subscribed
// (docs/adr/2026-10-30-1704-pushes-go-to-the-mac-only-while-the-owner-is-at-it.md).
// The queue goes out through flushQueue() after each of the hub's checks (schedule.mjs) and at the end
// of each GitHub tick (`board.mjs checked`), a board's one push as it is and its several as one summary
// (docs/adr/2026-11-02-1733-queued-pushes-go-as-one-summary-per-board.md).
// State lives in ~/.claude/kickflip/push: vapid.json (the signing key),
// subs.json (one entry per phone or browser that enabled notifications, with
// the hub origin it subscribed from and its user agent) and queue.json (pushes waiting to go). Quiet hours are
// `quiet` in ~/.claude/kickflip/settings.json, with `notifications` beside it.
// A subscription the push service reports gone (404 or 410) is dropped.
// Payload encryption is RFC 8291 (aes128gcm); the Authorization header is RFC 8292 (VAPID).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validate, quietOf, flushAt, hold, notifications, snoozeEnd } from './schedule.mjs';
import { storedEnd } from './duration.mjs';
import { presence } from './presence.mjs';
import { CODEX_SHARE_VALUES, codexStatus, effectiveCodexShare } from '../shared/codex.mjs';

const DIR = path.join(os.homedir(), '.claude', 'kickflip', 'push');
const VAPID = path.join(DIR, 'vapid.json');
const SUBS = path.join(DIR, 'subs.json');
const QUEUE = path.join(DIR, 'queue.json');
const QUEUE_LOCK = QUEUE + '.lock';
const settingsFile = (home) => path.join(home, '.claude', 'kickflip', 'settings.json');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(s, 'base64url');
const hmac = (key, input) => crypto.createHmac('sha256', key).update(input).digest();
const writePrivate = (file, value) => {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
};

function vapidKey() {
  try { return JSON.parse(fs.readFileSync(VAPID, 'utf8')); } catch {}
  const jwk = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' });
  writePrivate(VAPID, jwk);
  return jwk;
}

export function publicKey() {
  const jwk = vapidKey();
  return b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]));
}

function readSubs(file = SUBS) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}

// origin: the https origin of the hub page that subscribed. It becomes the VAPID
// `sub` claim, which Apple's push service requires to be a mailto: or https: URL.
export function addSubscription(sub, origin, agent = '') {
  if (!/^https:\/\//.test(sub?.endpoint || '') || !sub.keys?.p256dh || !sub.keys?.auth) throw Object.assign(new Error('bad subscription'), { status: 400 });
  const subs = readSubs().filter((s) => s.endpoint !== sub.endpoint);
  subs.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, origin, agent: String(agent).slice(0, 200), added: new Date().toISOString() });
  writePrivate(SUBS, subs);
  return subs.length;
}

// The page of a device whose subscription went (hub-kit.js device) names its endpoint here; an endpoint the hub
// doesn't hold changes nothing. → the count left
export function removeSubscription(endpoint) {
  const subs = readSubs();
  const left = subs.filter((s) => s.endpoint !== endpoint);
  if (left.length !== subs.length) writePrivate(SUBS, left);
  return left.length;
}

export function subscriptions(home) {
  return readSubs(home ? path.join(home, '.claude', 'kickflip', 'push', 'subs.json') : SUBS).map((s) => ({ host: new URL(s.endpoint).host, agent: s.agent, added: s.added }));
}

// A subscription with no user agent counts as a phone, so it never loses pushes while the owner is at the host.
const onPhone = (sub) => !sub.agent || /iPhone|iPad|Android/.test(sub.agent);

async function reach(kind, urgent = false) {
  const subs = readSubs();
  if (kind !== 'action' || urgent || !(await presence()).atMac) return subs;
  const desktop = subs.filter((s) => !onPhone(s));
  return desktop.length ? desktop : subs;
}

export async function pushRoute() {
  return { atMac: (await presence()).atMac, desktops: readSubs().filter((s) => !onPhone(s)).length };
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

function authorization(sub) {
  const jwk = vapidKey();
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: new URL(sub.endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: sub.origin || 'mailto:kickflip@localhost' }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key: crypto.createPrivateKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${publicKey()}`;
}

// What waits on the owner, fresh from the hub's /_hub/needs.json: {total, sites} with total the Home Screen badge count
// and sites as hub.mjs serves them, or {} when the hub doesn't answer.
async function hubNeeds() {
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
export const sendAll = (message) => sendTo(readSubs(), message);

async function sendTo(subs, message, needs) {
  if (!subs.length) return [];
  const payload = JSON.stringify({ ...message, badge: (needs || await hubNeeds()).total });
  const results = await Promise.all(subs.map(async (sub) => {
    try {
      const r = await fetch(sub.endpoint, {
        method: 'POST',
        headers: { authorization: authorization(sub), 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', urgency: 'high' },
        body: encrypt(sub, payload),
        signal: AbortSignal.timeout(15000),
      });
      return { sub, status: r.status, error: r.ok ? undefined : (await r.text()).slice(0, 300) };
    } catch (e) { return { sub, status: 0, error: String(e.message || e) }; }
  }));
  const gone = new Set(results.filter((r) => r.status === 404 || r.status === 410).map((r) => r.sub.endpoint));
  if (gone.size) writePrivate(SUBS, readSubs().filter((s) => !gone.has(s.endpoint)));
  return results.map((r) => ({ host: new URL(r.sub.endpoint).host, agent: r.sub.agent, status: r.status, error: r.error, dropped: gone.has(r.sub.endpoint) || undefined }));
}

const delivered = (results) => results.some((r) => r.status >= 200 && r.status < 300);

// ---------- settings ----------
// The whole of ~/.claude/kickflip/settings.json, or {} when it is missing or unreadable.
export function readSettingsFile(home = os.homedir()) {
  try {
    const value = JSON.parse(fs.readFileSync(settingsFile(home), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
// Replaces the whole file; callers spread readSettingsFile() so other keys, such as rules (rules.mjs), survive.
export function writeSettingsFile(value, home = os.homedir()) {
  const SETTINGS = settingsFile(home);
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  const tmp = `${SETTINGS}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, SETTINGS);
}

// status: a shared/codex.mjs codexStatus. → the Codex setting in effect, shared/codex.mjs effectiveCodexShare.
export const readCodexShare = (status = codexStatus(), home = os.homedir()) => effectiveCodexShare(readSettingsFile(home).codexShare, status);

// Throws {status: 400} for a value that isn't a choice, and {status: 409} with the fix while Codex isn't usable.
export function setCodexShare(value, status = codexStatus()) {
  if (!CODEX_SHARE_VALUES.includes(value)) throw Object.assign(new Error('codex-share takes auto, always, or off'), { status: 400 });
  if (!status.usable) throw Object.assign(new Error(`${status.words} Run ${status.fix}, then choose again.`), { status: 409 });
  writeSettingsFile({ ...readSettingsFile(), codexShare: value });
  return value;
}

// Which Claude model builds a card that Claude builds (docs/adr/2026-11-03-1526-usage-picks-opus-auto-or-sonnet-for-claude-builders.md):
// opus or sonnet forces it, auto leaves it to the card (shared/usage-gate.mjs builderPick). A missing or unknown stored
// value is auto.
export const CLAUDE_MODEL_VALUES = ['opus', 'auto', 'sonnet'];
export const readClaudeModel = (home = os.homedir()) => {
  const stored = readSettingsFile(home).claudeModel;
  return CLAUDE_MODEL_VALUES.includes(stored) ? stored : 'auto';
};

// Throws {status: 400} for a value that isn't a choice.
export function setClaudeModel(value, home = os.homedir()) {
  if (!CLAUDE_MODEL_VALUES.includes(value)) throw Object.assign(new Error('claude-model takes opus, auto or sonnet'), { status: 400 });
  writeSettingsFile({ ...readSettingsFile(home), claudeModel: value }, home);
  return value;
}

// The saved quiet hours and notifications: old `polling` windows are migrated, and a missing or invalid file gives the defaults.
export function readSettings(home) {
  return quietOf(readSettingsFile(home));
}

// Rewrites old `polling` windows, and the `push` block before them, as `quiet`. Returns the quiet hours, or null when
// there was nothing to migrate.
export function migrateSettings(home) {
  const file = readSettingsFile(home);
  if (!file.polling && !file.push) return null;
  const { push, polling, ...rest } = file;
  const { quiet } = quietOf(file);
  writeSettingsFile({ ...rest, quiet }, home);
  return quiet;
}

// Throws {status: 400} with the validation message; returns the saved settings. An input without notifications
// keeps the saved ones.
export function saveSettings(input) {
  const { settings, error } = validate({ notifications: readSettings().notifications, ...input });
  if (error) throw Object.assign(new Error(error), { status: 400 });
  const { push, polling, ...rest } = readSettingsFile();
  writeSettingsFile({ ...rest, quiet: settings.quiet, notifications: settings.notifications });
  return settings;
}

// change: {on}, {weekends_off} or {snooze}, where snooze is a schedule.mjs snoozeEnd choice or 'off' to end one.
// Turning notifications off drops the queue. Throws {status: 400} on a bad change; returns {notifications, dropped}.
export async function setNotifications(change, now = new Date()) {
  const s = readSettings();
  const next = { ...s.notifications };
  if ('on' in change) next.on = change.on;
  if ('weekends_off' in change) next.weekends_off = change.weekends_off;
  if ('snooze' in change) {
    const end = change.snooze === 'off' ? null : snoozeEnd(now, change.snooze, s);
    if (end === null && change.snooze !== 'off') throw Object.assign(new Error('A snooze must end after now and within 30 days: <n>m, <n>h, <n>d, <n>w, tonight, morning, monday or a date and time; or forever or off.'), { status: 400 });
    next.snoozed_until = end && storedEnd(end);
  }
  const { notifications: saved } = saveSettings({ ...s, notifications: next });
  const dropped = saved.on ? 0 : await withQueueLock(() => {
    const { items } = readQueue();
    if (items.length) writePrivate(QUEUE, { items: [] });
    return items.length;
  });
  return { notifications: saved, dropped };
}

function readQueue() {
  try {
    const q = JSON.parse(fs.readFileSync(QUEUE, 'utf8'));
    return { items: Array.isArray(q.items) ? q.items : [] };
  } catch { return { items: [] }; }
}

// The CLI and the hub both write queue.json.
async function withQueueLock(fn) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { fs.mkdirSync(QUEUE_LOCK); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(QUEUE_LOCK).mtimeMs > 30_000) { fs.rmdirSync(QUEUE_LOCK); continue; } } catch {}
      if (Date.now() > deadline) throw new Error('push queue is locked; try again');
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(QUEUE_LOCK); } catch {} }
}

// { settings, held, hold, count, nextFlushAt } for the settings page and the CLI.
// held: a poll now would keep the queue; hold says why and until when (schedule.mjs hold). nextFlushAt is null when
// nothing is queued.
export function queueStatus(now = new Date()) {
  const settings = readSettings();
  const { items } = readQueue();
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
// sent replaces a queued one with the same tag. A push sent now, or flushed later, reaches the subscriptions reach()
// picks at that moment.
export async function deliver(message, { kind, urgent = false, immediate = false, at = new Date() } = {}) {
  const refused = pushKindError(kind);
  if (refused) throw new PushKindError(refused);
  if (!readSubs().length) return { noDevice: true };
  const msg = { title: message.title, body: message.body || '', url: message.url || '/', tag: message.tag || undefined };
  const h = hold(at, readSettings());
  if (h?.why === 'off') return { dropped: true };
  const held = h !== null;
  let sendFailed = false;
  if (urgent || (immediate && !held)) {
    const results = await sendTo(await reach(kind, urgent), msg);
    if (delivered(results)) {
      if (msg.tag) await withQueueLock(() => writePrivate(QUEUE, { items: readQueue().items.filter((i) => i.tag !== msg.tag) }));
      return { sent: results };
    }
    if (urgent) return { sent: results };
    sendFailed = true;
  }
  const item = { id: crypto.randomUUID(), ...msg, kind, queuedAt: at.toISOString() };
  const queued = await withQueueLock(() => {
    const q = readQueue();
    const kept = item.tag ? q.items.filter((i) => i.tag !== item.tag) : q.items;
    const replaced = kept.length < q.items.length;
    q.items = [...kept, item];
    writePrivate(QUEUE, q);
    return { replaced };
  });
  const status = queueStatus(at);
  return { queued: { ...queued, count: status.count, nextFlushAt: status.nextFlushAt, held, hold: h, sendFailed } };
}

// Sets the body of the queued push with this tag to revise(its body), and its url to `url` when given; sends
// nothing. Returns the new body, or null when no push with the tag is queued, so a push already sent stays as it went out.
export async function reviseQueued(tag, revise, url) {
  if (!tag || !readQueue().items.some((i) => i.tag === tag)) return null;
  return withQueueLock(() => {
    const q = readQueue();
    const item = q.items.find((i) => i.tag === tag);
    if (!item) return null;
    item.body = revise(item.body || '');
    if (url) item.url = url;
    writePrivate(QUEUE, q);
    return item.body;
  });
}

// Question ids are unique only within a site; the shared queue needs the route too.
export async function dropQueued(tags, route) {
  const wanted = new Set(tags);
  const matches = (item) => wanted.has(item.tag) && typeof item.url === 'string' && item.url.startsWith(`/${route}/`);
  if (!readQueue().items.some(matches)) return 0;
  return withQueueLock(() => {
    const { items } = readQueue();
    const kept = items.filter((item) => !matches(item));
    const dropped = items.length - kept.length;
    if (dropped) writePrivate(QUEUE, { items: kept });
    return dropped;
  });
}

let flushing = null;
// Sends the queue as schedule.mjs notifications, built from what waits on each board now, each to whom reach() picks
// for its kind at flush time. The queue is emptied before sending, so the hub and a `board.mjs checked` flushing at
// once never send a push twice. Returns null when nothing was queued, else {count, sent, ok, results}, with sent the
// notifications that went: the pushes behind one no device took go back to the queue unless a newer one has their tag.
export function flushQueue() {
  flushing ||= (async () => {
    const items = await withQueueLock(() => {
      const q = readQueue();
      if (q.items.length) writePrivate(QUEUE, { items: [] });
      return q.items;
    });
    if (!items.length) return null;
    const sent = [];
    const failed = [];
    const results = [];
    const needs = await hubNeeds();
    for (const m of notifications(items, needs.sites)) {
      const r = await sendTo(await reach(m.kind), { title: m.title, body: m.body, url: m.url, tag: m.tag }, needs);
      results.push(...r);
      (delivered(r) ? sent : failed).push(m);
    }
    if (failed.length) await withQueueLock(() => {
      const q = readQueue();
      const newer = new Set(q.items.map((i) => i.tag).filter(Boolean));
      const back = items.filter((i) => failed.some((f) => f.members.includes(i.id)) && !(i.tag && newer.has(i.tag)));
      writePrivate(QUEUE, { items: [...back, ...q.items] });
    });
    return { count: items.length, sent: sent.length, ok: !failed.length, results };
  })().finally(() => { flushing = null; });
  return flushing;
}
