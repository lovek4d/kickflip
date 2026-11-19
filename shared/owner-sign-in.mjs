// The owner's sign-in (docs/adr/2026-11-18-1200-the-owner-signs-in-with-a-link-that-sets-a-device-cookie.md,
// docs/adr/2026-11-19-0130-a-device-signs-in-with-a-60-second-pin-and-three-misses-block-it.md).
// An 8-digit PIN, made by `kickflip link` or a signed-in hub page's Sign in a device, lasts 60 seconds and signs in one
// device; the device then carries a long-lived HttpOnly cookie, which the hub, its try relays and every board server
// check on each request. A request without it is no owner: a browser gets the sign-in page, and a process on this host
// gets only the agent paths each server names. A client's third wrong PIN voids every live PIN and blocks that client
// (its tailnet node, else its IP) until `kickflip unblock`.
// ~/.claude/kickflip/owner-sign-in.json, 0600, keeps {devices: [{hash, at, name, ip, seen}], pins: [{hash, until}],
// misses: [{key, n, at}], blocks: [{key, name, ip, at}]}: sha256 of each secret, never the secret. It is read on every
// check, since the CLI writes it underneath the servers.
// A process running as the owner's OS user can make a PIN too (SECURITY.md): the cookie stops a page or a one-line
// request from acting as the owner, not a process set on doing so.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withFileLock } from '../hub/locks.mjs';

export const SIGN_IN_COOKIE = 'kickflip_owner';
export const PIN_MS = 60_000;
export const TRIES = 3;
// How stale a device's last seen may get before a request writes it again.
const SEEN_MS = 5 * 60_000;
// 400 days, the longest a browser keeps a cookie.
const COOKIE_SECONDS = 400 * 24 * 60 * 60;

export const signInFile = (home = os.homedir()) => path.join(home, '.claude', 'kickflip', 'owner-sign-in.json');
const hashOf = (secret) => crypto.createHash('sha256').update(secret).digest('base64url');
const secret = () => crypto.randomBytes(32).toString('base64url');
// A device's id in a list: its hash's head, which no request can sign in with.
const idOf = (device) => device.hash.slice(0, 12);

function readFile(home) {
  let kept;
  try { kept = JSON.parse(fs.readFileSync(signInFile(home), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return { devices: [], pins: [], misses: [], blocks: [] }; throw e; }
  return { devices: kept.devices || [], pins: kept.pins || [], misses: kept.misses || [], blocks: kept.blocks || [] };
}

// change(file) → {file, result}; written 0600 under the file's lock, with expired PINs dropped. → result
function change(home, now, fn) {
  const file = signInFile(home);
  return withFileLock(file, () => {
    const current = readFile(home);
    const { file: next, result } = fn({ ...current, pins: current.pins.filter((p) => p.until > now()) });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    return result;
  });
}

// What a PIN field holds, with any whitespace a paste or a phone added dropped.
export const pinOf = (input) => String(input || '').replace(/\s+/g, '');

// → {pin, until}: a new PIN, good for one device for 60 seconds, never one already live
export async function makePin({ home = os.homedir(), now = Date.now } = {}) {
  return change(home, now, (f) => {
    let pin;
    do pin = String(crypto.randomInt(0, 1e8)).padStart(8, '0'); while (f.pins.some((p) => p.hash === hashOf(pin)));
    const until = now() + PIN_MS;
    return { file: { ...f, pins: [...f.pins, { hash: hashOf(pin), until }] }, result: { pin, until } };
  });
}

// Drops a live PIN, as a closed dialog or a stopped `kickflip link` does. → whether it was live
export async function voidPin(pin, { home = os.homedir(), now = Date.now } = {}) {
  const hash = hashOf(pinOf(pin));
  return change(home, now, (f) => ({ file: { ...f, pins: f.pins.filter((p) => p.hash !== hash) }, result: f.pins.some((p) => p.hash === hash) }));
}

// client: {key, name, ip}, who typed it (board/on-host.mjs clientIdentity); device: {name, ip}, what the new device's
// row reads. Uses the PIN up.
// → {device: the new device's cookie value} | {left: wrong PINs the client has left} | {blocked: true}, when the client
// was blocked already or this was its last try, which also voids every live PIN
export async function redeemPin(input, client, { device: named = client, home = os.homedir(), now = Date.now } = {}) {
  const hash = hashOf(pinOf(input));
  return change(home, now, (f) => {
    const at = now();
    const block = f.blocks.find((b) => b.key === client.key);
    if (block) return { file: { ...f, blocks: f.blocks.map((b) => (b === block ? { ...b, at } : b)) }, result: { blocked: true } };
    const others = f.misses.filter((m) => m.key !== client.key);
    if (/^\d{8}$/.test(pinOf(input)) && f.pins.some((p) => p.hash === hash)) {
      const device = secret();
      const stamp = new Date(at).toISOString();
      return { file: { ...f, devices: [...f.devices, { hash: hashOf(device), at: stamp, name: named.name, ip: named.ip, seen: stamp }], pins: f.pins.filter((p) => p.hash !== hash), misses: others }, result: { device } };
    }
    const n = (f.misses.find((m) => m.key === client.key)?.n || 0) + 1;
    if (n >= TRIES) return { file: { ...f, pins: [], misses: others, blocks: [...f.blocks, { key: client.key, name: client.name, ip: client.ip, at }] }, result: { blocked: true } };
    return { file: { ...f, misses: [...others, { key: client.key, n, at }] }, result: { left: TRIES - n } };
  });
}

// → whether the client is blocked
export const isBlocked = (client, home = os.homedir()) => readFile(home).blocks.some((b) => b.key === client.key);

// → [{key, name, ip, at}], the blocked clients, at their last attempt, newest first
export const blockedClients = (home = os.homedir()) => readFile(home).blocks.sort((a, b) => b.at - a.at);

// → whether the client named by key was blocked
export async function unblock(key, { home = os.homedir(), now = Date.now } = {}) {
  return change(home, now, (f) => ({ file: { ...f, blocks: f.blocks.filter((b) => b.key !== key) }, result: f.blocks.some((b) => b.key === key) }));
}

// → [{id, name, ip, at, seen}], the signed-in devices, the latest signed in first
export const devicesOf = (home = os.homedir()) => readFile(home).devices
  .map((d) => ({ id: idOf(d), name: d.name || 'A device', ip: d.ip || '', at: d.at, seen: d.seen || d.at }))
  .sort((a, b) => b.at.localeCompare(a.at));

// Signs one device out. → whether it was signed in
export async function removeDevice(id, { home = os.homedir(), now = Date.now } = {}) {
  return change(home, now, (f) => ({ file: { ...f, devices: f.devices.filter((d) => idOf(d) !== id) }, result: f.devices.some((d) => idOf(d) === id) }));
}

// Signs every device out. → how many were signed in
export function signOutEverywhere(home = os.homedir(), now = Date.now) {
  return change(home, now, (f) => ({ file: { ...f, devices: [] }, result: f.devices.length }));
}

const cookieOf = (req) => {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === SIGN_IN_COOKIE) return part.slice(at + 1).trim();
  }
  return '';
};

const deviceRecord = (req, home) => {
  const device = cookieOf(req);
  if (!device) return null;
  const hash = hashOf(device);
  return readFile(home).devices.find((d) => d.hash === hash) || null;
};

// req: {headers} → whether it carries a signed-in device's cookie
export const signedIn = (req, home = os.homedir()) => Boolean(deviceRecord(req, home));

// req: {headers} → the id of the signed-in device it comes from, or null
export function deviceIdOf(req, home = os.homedir()) {
  const d = deviceRecord(req, home);
  return d ? idOf(d) : null;
}

// Notes the request's device as seen now, when its last seen is SEEN_MS old or more. → whether it wrote
export async function noteSeen(req, { home = os.homedir(), now = Date.now } = {}) {
  const d = deviceRecord(req, home);
  if (!d || now() - Date.parse(d.seen || d.at) < SEEN_MS) return false;
  const stamp = new Date(now()).toISOString();
  return change(home, now, (f) => ({ file: { ...f, devices: f.devices.map((x) => (x.hash === d.hash ? { ...x, seen: stamp } : x)) }, result: true }));
}

export const signInCookie = (value, { secure = false } = {}) => `${SIGN_IN_COOKIE}=${value}; Path=/; Max-Age=${COOKIE_SECONDS}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;

// A Cookie header without the sign-in, for a relay to pass to a server that isn't kickflip's own. → undefined for none left
export function withoutOwnerCookie(header) {
  const kept = String(header || '').split(';').map((p) => p.trim()).filter((p) => p && p.split('=')[0].trim() !== SIGN_IN_COOKIE);
  return kept.length ? kept.join('; ') : undefined;
}

const bare = (address) => String(address || '').replace(/^::ffff:/, '');
// A process on this host calling straight to loopback: no tailscale serve forwarding, and neither the Origin nor the
// Sec-Fetch-Site a browser sends (Node's fetch sends Sec-Fetch-Mode, so that one doesn't count). Such a caller gets each
// server's agent paths with no cookie.
export function agentCaller(req) {
  const h = req.headers;
  if (h['x-forwarded-for'] !== undefined || h.origin !== undefined || h['sec-fetch-site'] !== undefined) return false;
  const client = bare(req.socket?.remoteAddress);
  return client === '::1' || /^127\.\d+\.\d+\.\d+$/.test(client);
}
