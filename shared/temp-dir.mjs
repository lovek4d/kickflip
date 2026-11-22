import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// docs/adr/2026-11-14-1217-test-runs-wait-while-the-host-is-busy-and-leave-nothing-behind.md
// A test's temp dir under os.tmpdir(), named prefix and six random characters. Every dir made here goes as the test
// process exits, after every test's own cleanup has stopped what used it, or as SIGTERM or SIGINT ends it: the signal is
// raised again once the dirs are gone, so the process still ends by it unless another listener of the process takes
// it. A process killed outright leaves its dirs in its test run's own temp folder, which goes with the run
// (board/worktree.mjs nodeTests; docs/adr/2026-11-22-2345-a-closed-tasks-worktree-goes-and-the-hub-sweeps-what-is-left.md).
// board/temp-dirs.test.mjs fails a test source that makes a temp dir any other way.
const made = [];
const removeMade = () => { for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }); };
process.on('exit', removeMade);
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    removeMade();
    if (!process.listenerCount(signal)) process.kill(process.pid, signal);
  });
}

export function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}
