// docs/adr/2026-11-14-1217-test-runs-wait-while-the-host-is-busy-and-leave-nothing-behind.md
// Loaded into every node process of a test run through NODE_OPTIONS (worktree.mjs nodeTests): the runner, each test
// file, and every node process they start that keeps the environment, such as fake claude scripts, servers and
// keep-alive stand-ins. It exits the process once the process that started the run, KICKFLIP_TEST_RUN, is gone, so a
// run that is killed or cut off leaves nothing running. Its check never holds a process open.
const run = Number(process.env.KICKFLIP_TEST_RUN);
const alive = () => { try { process.kill(run, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
setInterval(() => { if (!alive()) process.exit(1); }, 1000).unref(); // poll: test-run-watch

// docs/adr/2026-11-19-2330-a-test-file-still-running-past-its-limit-fails-by-name.md
// A test file's process, one the runner started for a *.test.mjs file, fails once it has run KICKFLIP_TEST_FILE_LIMIT
// ms: held open after its tests by a handle they left, or stuck before them, which the runner's per-test timeout never
// bounds. It exits 1, which the runner reports as that file's failure, after the error naming what holds it open.
const limit = Number(process.env.KICKFLIP_TEST_FILE_LIMIT);
if (process.env.NODE_TEST_CONTEXT && process.argv[1]?.endsWith('.test.mjs')) {
  setTimeout(() => {
    const holding = [...new Set(process.getActiveResourcesInfo())].join(', ');
    process.stderr.write(`Error: test file still running after ${limit % 60000 ? `${limit / 1000} seconds` : `${limit / 60000} minutes`}, held open by ${holding}\n`);
    process.exit(1);
  }, limit).unref();
}
