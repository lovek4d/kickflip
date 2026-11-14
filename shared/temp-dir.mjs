import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// docs/adr/2026-11-14-1217-test-runs-wait-while-the-host-is-busy-and-leave-nothing-behind.md
// A test's temp dir under os.tmpdir(), named prefix and six random characters. Every dir made here goes as the test
// process exits, after every test's own cleanup has stopped what used it. board/temp-dirs.test.mjs fails a test source that
// makes a temp dir any other way.
const made = [];
process.on('exit', () => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }); });

export function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}
