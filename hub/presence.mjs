// Whether the owner is at the host (docs/adr/2026-11-04-0226-the-hub-checks-every-minute-while-youre-here-and-every-5-when-away.md): the screen
// is unlocked and a key or the pointer was used in the last 3 minutes, whatever app is in front. Both readings come
// from macOS ioreg, which needs no permission, so the hub's service and a session's CLI read the same. A host without
// ioreg, such as Linux, fails the reading, so the owner always reads away there.
import { execFile } from 'node:child_process';

export const IDLE_LIMIT_MS = 3 * 60_000;

const ioreg = (args) => new Promise((resolve, reject) => {
  execFile('ioreg', args, { timeout: 5000, maxBuffer: 32 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(out)));
});

// run(args) → ioreg's output for those args. Resolves {atMac, locked, idleMs}, or {atMac: false, error} when a
// reading fails, so a host that can't be read counts as away.
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

// The owner's presence for the hub's checks (docs/adr/2026-11-04-0226-the-hub-checks-every-minute-while-youre-here-and-every-5-when-away.md):
// present while at the Mac (read, a readPresence) or within IDLE_LIMIT_MS of a beat, a tap, key or scroll on a board or Hub
// page on any device. It starts away until a check or beat says otherwise. check() reads the Mac and beat() records a
// beat; each → {present, changed, back}, back when the owner just came back from away. state() → {present, backAt},
// backAt being when the owner last came back and awaySince when they went away (the tracker's start, until a reading
// says present), null while present (docs/adr/2026-11-12-0300-an-npm-hub-pulls-only-once-the-owner-has-been-away-15-minutes.md).
export function ownerTracker({ read = readPresence, clock = Date.now } = {}) {
  let beatAt = -Infinity;
  let present = false;
  let backAt = null;
  let awaySince = clock();
  const update = (atMac) => {
    const now = clock();
    const next = atMac || now - beatAt < IDLE_LIMIT_MS;
    const out = { present: next, changed: next !== present, back: next && !present };
    if (out.back) backAt = now;
    if (!next) awaySince ??= now;
    else awaySince = null;
    present = next;
    return out;
  };
  return {
    async check() { return update((await read()).atMac); },
    beat() { beatAt = clock(); return update(true); },
    state: () => ({ present, backAt, awaySince }),
  };
}
