// The owner's sign-in (docs/adr/2026-11-18-1200-the-owner-signs-in-with-a-link-that-sets-a-device-cookie.md).
// `kickflip sign-in` makes a link that lasts ten minutes and signs in one device; the device then carries a long-lived
// HttpOnly cookie, which the hub, its try relays and every board server check on each request. A request without it is
// no owner: a browser gets the sign-in page, and a process on this host gets only the agent paths each server names.
// ~/.claude/kickflip/owner-sign-in.json, 0600, keeps {devices: [{hash, at}], links: [{hash, until}]}: sha256 of each
// secret, never the secret. It is read on every check, since the CLI writes it underneath the servers.
// A process running as the owner's OS user can make a link too (SECURITY.md): the cookie stops a page or a one-line
// request from acting as the owner, not a process set on doing so.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withFileLock } from '../hub/locks.mjs';

export const SIGN_IN_COOKIE = 'kickflip_owner';
const LINK_MS = 10 * 60_000;
// 400 days, the longest a browser keeps a cookie.
const COOKIE_SECONDS = 400 * 24 * 60 * 60;
const TOKEN = /^[A-Za-z0-9_-]+$/;

export const signInFile = (home = os.homedir()) => path.join(home, '.claude', 'kickflip', 'owner-sign-in.json');
const hashOf = (secret) => crypto.createHash('sha256').update(secret).digest('base64url');
const secret = () => crypto.randomBytes(32).toString('base64url');

function readFile(home) {
  let kept;
  try { kept = JSON.parse(fs.readFileSync(signInFile(home), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return { devices: [], links: [] }; throw e; }
  return { devices: kept.devices || [], links: kept.links || [] };
}

// change(file) → {file, result}; written 0600 under the file's lock, with expired links dropped. → result
function change(home, now, fn) {
  const file = signInFile(home);
  return withFileLock(file, () => {
    const current = readFile(home);
    const { file: next, result } = fn({ ...current, links: current.links.filter((l) => l.until > now()) });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    return result;
  });
}

// → a new link's token, good for one device for ten minutes
export async function makeSignInLink({ home = os.homedir(), now = Date.now } = {}) {
  const token = secret();
  await change(home, now, (f) => ({ file: { ...f, links: [...f.links, { hash: hashOf(token), until: now() + LINK_MS }] }, result: null }));
  return token;
}

// Uses up the link's token. → the new device's cookie value, or null for a token used, expired or never made
export async function redeemSignIn(token, { home = os.homedir(), now = Date.now } = {}) {
  if (!token || !TOKEN.test(token)) return null;
  const hash = hashOf(token);
  return change(home, now, (f) => {
    if (!f.links.some((l) => l.hash === hash)) return { file: f, result: null };
    const device = secret();
    return { file: { devices: [...f.devices, { hash: hashOf(device), at: new Date(now()).toISOString() }], links: f.links.filter((l) => l.hash !== hash) }, result: device };
  });
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

// req: {headers} → whether it carries a signed-in device's cookie
export function signedIn(req, home = os.homedir()) {
  const device = cookieOf(req);
  if (!device) return false;
  const hash = hashOf(device);
  return readFile(home).devices.some((d) => d.hash === hash);
}

export const signInCookie = (value, { secure = false } = {}) => `${SIGN_IN_COOKIE}=${value}; Path=/; Max-Age=${COOKIE_SECONDS}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;

// A pasted sign-in link, or its token alone → the token, or '' for anything else
export function tokenOf(input) {
  const text = String(input || '').trim();
  if (TOKEN.test(text)) return text;
  try { return new URL(text).searchParams.get('t') || ''; } catch { return ''; }
}

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
