// Web Push for every hub site, with no dependencies. The hub serves the
// subscribe and unsubscribe side (hub.mjs); every push goes through deliver(), which refuses a push that isn't one of PUSH_KINDS and
// queues one unless it is urgent or immediate, and every push reaches every subscription.
// The queue goes out through flushQueue() after each of the hub's checks (schedule.mjs), a board's one push as it is and its several as one summary
// (docs/adr/2026-11-02-1733-queued-pushes-go-as-one-summary-per-board.md).
// State lives in <home>/.claude/kickflip/push, home being os.homedir() unless a call names one: vapid.json (the signing key),
// subs.json (one entry per phone or browser that enabled notifications, with
// the hub origin it subscribed from and its user agent) and queue.json (pushes waiting to go). Quiet hours are
// `quiet` in ~/.claude/kickflip/settings.json, with `notifications` beside it.
// A subscription the push service reports gone (404 or 410) is dropped. deliver and flushQueue reach the push service
// and the hub through the fetch they are given, global fetch unless given.
// Payload encryption is RFC 8291 (aes128gcm); the Authorization header is RFC 8292 (VAPID).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validate, quietOf, flushAt, hold, notifications, snoozeEnd } from './schedule.mjs';
import { storedEnd } from './duration.mjs';
import { CODEX_SHARE_VALUES, codexStatus, effectiveCodexShare } from '../shared/codex.mjs';

const pushFile = (home, name) => path.join(home, '.claude', 'kickflip', 'push', name);
const vapidFile = (home) => pushFile(home, 'vapid.json');
const subsFile = (home) => pushFile(home, 'subs.json');
const queueFile = (home) => pushFile(home, 'queue.json');
const settingsFile = (home) => path.join(home, '.claude', 'kickflip', 'settings.json');

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

async function sendTo(subs, message, needs, { home, fetch }) {
  if (!subs.length) return [];
  const payload = JSON.stringify({ ...message, badge: (needs || await hubNeeds(fetch)).total });
  const results = await Promise.all(subs.map(async (sub) => {
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

// Auto update (docs/adr/2026-11-13-2345-a-checkbox-under-the-hubs-version-turns-auto-update-off.md): off only when settings.json
// says autoUpdate: false; unset is on.
export const readAutoUpdate = (home = os.homedir()) => readSettingsFile(home).autoUpdate !== false;

export function setAutoUpdate(on, home = os.homedir()) {
  const { autoUpdate: _, ...rest } = readSettingsFile(home);
  writeSettingsFile(on ? rest : { ...rest, autoUpdate: false }, home);
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
export function saveSettings(input, home = os.homedir()) {
  const { settings, error } = validate({ notifications: readSettings(home).notifications, ...input });
  if (error) throw Object.assign(new Error(error), { status: 400 });
  const { push, polling, ...rest } = readSettingsFile(home);
  writeSettingsFile({ ...rest, quiet: settings.quiet, notifications: settings.notifications }, home);
  return settings;
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
  const { notifications: saved } = saveSettings({ ...s, notifications: next }, home);
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
export async function deliver(message, { kind, urgent = false, immediate = false, at = new Date(), home = os.homedir(), fetch = globalThis.fetch } = {}) {
  const refused = pushKindError(kind);
  if (refused) throw new PushKindError(refused);
  if (!readSubs(home).length) return { noDevice: true };
  const msg = { title: message.title, body: message.body || '', url: message.url || '/', tag: message.tag || undefined };
  const h = hold(at, readSettings(home));
  if (h?.why === 'off') return { dropped: true };
  const held = h !== null;
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

// Question ids are unique only within a site; the shared queue needs the route too.
export async function dropQueued(tags, route) {
  const wanted = new Set(tags);
  const matches = (item) => wanted.has(item.tag) && typeof item.url === 'string' && item.url.startsWith(`/${route}/`);
  const home = os.homedir();
  if (!readQueue(home).items.some(matches)) return 0;
  return withQueueLock(home, () => {
    const { items } = readQueue(home);
    const kept = items.filter((item) => !matches(item));
    const dropped = items.length - kept.length;
    if (dropped) writePrivate(queueFile(home), { items: kept });
    return dropped;
  });
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
