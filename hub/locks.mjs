import fs from 'node:fs';
import path from 'node:path';

// A killed holder (SIGTERM from the hub or a test) never runs its finally, so the lock records the holder's pid
// and a waiter takes a lock whose holder is gone at once instead of waiting out staleAfter.
function holderGone(lock) {
  let pid;
  try { pid = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8')); } catch { return false; }
  try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
}

// A directory lock shared by hub and CLI writers; staleAfter must outlast the holder's work, which heartbeat renews.
// The wait gives up after timeout on the monotonic clock, so a wall clock that jumps back, or a test's frozen one,
// can't hold it waiting on a lock that never reads stale.
export async function withFileLock(file, fn, { staleAfter = 30_000, timeout = 10_000, heartbeat = false } = {}) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = performance.now() + timeout;
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (holderGone(lock) || Date.now() - fs.statSync(lock).mtimeMs > staleAfter) { fs.rmSync(lock, { recursive: true }); continue; } } catch {}
      if (performance.now() > deadline) throw Object.assign(new Error(`${path.basename(file)} is locked by another kickflip; try again`), { code: 'ELOCKED' });
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try { fs.writeFileSync(path.join(lock, 'pid'), String(process.pid)); } catch {}
  const timer = heartbeat ? setInterval(() => { try { const now = new Date(); fs.utimesSync(lock, now, now); } catch {} }, 5000) : null;
  try { return await fn(); } finally { clearInterval(timer); fs.rmSync(lock, { recursive: true, force: true }); }
}
