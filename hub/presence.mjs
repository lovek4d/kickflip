// Whether the owner is at the Mac (docs/adr/0065-pushes-go-to-the-mac-only-while-the-owner-is-at-it.md): the screen
// is unlocked and a key or the pointer was used in the last 3 minutes, whatever app is in front. Both readings come
// from ioreg, which needs no permission, so the launchd hub and a session's CLI read the same.
import { execFile } from 'node:child_process';

export const IDLE_LIMIT_MS = 3 * 60_000;

const ioreg = (args) => new Promise((resolve, reject) => {
  execFile('ioreg', args, { timeout: 5000, maxBuffer: 32 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(out)));
});

// run(args) → ioreg's output for those args. Resolves {atMac, locked, idleMs}, or {atMac: false, error} when a
// reading fails, so a Mac that can't be read counts as away and pushes keep reaching the phone.
export async function readPresence(run = ioreg) {
  try {
    const [root, hid] = await Promise.all([run(['-n', 'Root', '-d1']), run(['-c', 'IOHIDSystem'])]);
    const locked = /"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(root);
    const idles = [...hid.matchAll(/"HIDIdleTime"\s*=\s*(\d+)/g)].map((m) => Number(m[1]) / 1e6);
    if (!idles.length) return { atMac: false, error: 'ioreg reported no HIDIdleTime' };
    const idleMs = Math.round(Math.min(...idles));
    return { atMac: !locked && idleMs < IDLE_LIMIT_MS, locked, idleMs };
  } catch (e) {
    return { atMac: false, error: String(e.message || e) };
  }
}

// A readPresence that reuses one reading for ttl ms, so a flush of several pushes reads ioreg once.
export function presenceReader({ run = ioreg, ttl = 5000, clock = Date.now } = {}) {
  let last = null;
  return () => {
    if (!last || clock() - last.at >= ttl) last = { at: clock(), reading: readPresence(run) };
    return last.reading;
  };
}

export const presence = presenceReader();
