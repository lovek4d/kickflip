import fs from 'node:fs';
import path from 'node:path';

// A directory lock shared by hub and CLI writers; staleAfter must outlast the holder's work, which heartbeat renews.
export async function withFileLock(file, fn, { staleAfter = 30_000, timeout = 10_000, heartbeat = false } = {}) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + timeout;
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > staleAfter) { fs.rmdirSync(lock); continue; } } catch {}
      if (Date.now() > deadline) throw Object.assign(new Error(`${path.basename(file)} is locked by another kickflip; try again`), { code: 'ELOCKED' });
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const timer = heartbeat ? setInterval(() => { try { const now = new Date(); fs.utimesSync(lock, now, now); } catch {} }, 5000) : null;
  try { return await fn(); } finally { clearInterval(timer); try { fs.rmdirSync(lock); } catch {} }
}
