// docs/adr/2026-11-14-1217-test-runs-wait-while-the-host-is-busy-and-leave-nothing-behind.md
// Loaded into every node process of a test run through NODE_OPTIONS (worktree.mjs nodeTests): the runner, each test
// file, and every node process they start that keeps the environment, such as fake claude scripts, servers and
// keep-alive stand-ins. It exits the process once the process that started the run, KICKFLIP_TEST_RUN, is gone, so a
// run that is killed or cut off leaves nothing running. Its check never holds a process open.
const run = Number(process.env.KICKFLIP_TEST_RUN);
const alive = () => { try { process.kill(run, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
setInterval(() => { if (!alive()) process.exit(1); }, 1000).unref(); // poll: test-run-watch
