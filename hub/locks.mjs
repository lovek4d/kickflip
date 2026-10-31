import fs from 'node:fs';
import path from 'node:path';

// A directory lock shared by hub and CLI writers. A holder must finish within 30 seconds.
export async function withFileLock(file, fn) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) { fs.rmdirSync(lock); continue; } } catch {}
      if (Date.now() > deadline) throw Object.assign(new Error(`${path.basename(file)} is locked by another web-ts; try again`), { code: 'ELOCKED' });
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try { return await fn(); } finally { try { fs.rmdirSync(lock); } catch {} }
}
