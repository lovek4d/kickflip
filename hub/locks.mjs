import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

// Emits 'wait' with the file each time a withFileLock in this process finds the file's lock held and waits for it, so
// a test knows a writer is waiting at the lock without timing it.
export const lockWaits = new EventEmitter();

// A killed holder (SIGTERM from the hub or a test) never runs its finally, so the lock records the holder's pid
// and a waiter takes a lock whose holder is gone at once instead of waiting out staleAfter.
function holderGone(lock) {
  let pid;
  try { pid = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8')); } catch { return false; }
  try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
}

// A directory lock shared by hub and CLI writers; staleAfter must outlast the holder's work, which heartbeat renews.
// A waiter tries again every 100 ms, by wait(ms), and gives up after timeout on now, the monotonic clock, so a wall
// clock that jumps back, or a test's frozen one, can't hold it waiting on a lock that never reads stale. timeout's
// default is KICKFLIP_LOCK_TIMEOUT_MS, else 10 s; a test of many processes contending for one lock sets it to Infinity,
// since there load, not a stuck holder, decides how long a waiter waits.
export async function withFileLock(file, fn, {
  staleAfter = 30_000, timeout = Number(process.env.KICKFLIP_LOCK_TIMEOUT_MS) || 10_000, heartbeat = false,
  now = () => performance.now(), wait = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = now() + timeout;
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (holderGone(lock) || Date.now() - fs.statSync(lock).mtimeMs > staleAfter) { fs.rmSync(lock, { recursive: true }); continue; } } catch {}
      if (now() > deadline) throw Object.assign(new Error(`${path.basename(file)} is locked by another kickflip; try again`), { code: 'ELOCKED' });
      lockWaits.emit('wait', file);
      await wait(100);
    }
  }
  try { fs.writeFileSync(path.join(lock, 'pid'), String(process.pid)); } catch {}
  // poll: lock-heartbeat
  const timer = heartbeat ? setInterval(() => { try { const now = new Date(); fs.utimesSync(lock, now, now); } catch {} }, 5000) : null;
  try { return await fn(); } finally { clearInterval(timer); fs.rmSync(lock, { recursive: true, force: true }); }
}
