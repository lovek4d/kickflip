import { spawnSync } from 'node:child_process';
import { CUT_OFF_EXIT } from './test-cut-off.mjs';

// docs/adr/2026-11-14-1217-test-runs-wait-while-the-host-is-busy-and-leave-nothing-behind.md
// Loaded into every node process of a test run through NODE_OPTIONS (worktree.mjs nodeTests): the runner, each test
// file, and every node process they start that keeps the environment, such as fake claude scripts, servers and
// keep-alive stand-ins. It exits the process once the process that started the run, KICKFLIP_TEST_RUN, is gone, so a
// run that is killed or cut off leaves nothing running. Its check never holds a process open.
const run = Number(process.env.KICKFLIP_TEST_RUN);
const alive = () => { try { process.kill(run, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
setInterval(() => { if (!alive()) process.exit(1); }, 1000).unref(); // poll: test-run-watch

// docs/adr/2026-11-19-2330-a-test-file-still-running-past-its-limit-fails-by-name.md
// docs/adr/2026-11-22-1400-a-test-file-still-running-near-the-runs-cutoff-ends-by-name.md
// docs/adr/2026-11-24-2240-a-test-file-cut-off-by-the-runs-limit-reruns-on-its-own.md
// A test file's process, one the runner started for a *.test.mjs file, fails once it has run KICKFLIP_TEST_FILE_LIMIT
// ms: held open after its tests by a handle they left, waiting on a child, or stuck before its tests, which the runner's
// per-test timeout never bounds. It exits 1, which the runner reports as that file's failure, after the error naming
// what holds it open and the commands its children still run. At KICKFLIP_TEST_RUN_ENDS, shortly before the run's
// KICKFLIP_TEST_RUN_LIMIT cutoff, when that comes first, it is cut off instead: the same error, and it exits
// CUT_OFF_EXIT. A file the runner starts at or after that end exits CUT_OFF_EXIT at once, before its code loads.
const limit = Number(process.env.KICKFLIP_TEST_FILE_LIMIT);
const ends = Number(process.env.KICKFLIP_TEST_RUN_ENDS);
const runLimit = Number(process.env.KICKFLIP_TEST_RUN_LIMIT);
const roughly = (ms) => (ms < 120000 ? `${Math.round(ms / 1000)} seconds` : `${Math.round(ms / 60000)} minutes`);
const cutoffWords = `the run's ${runLimit % 60000 ? `${runLimit / 1000}-second` : `${runLimit / 60000}-minute`} cutoff`;
if (process.env.NODE_TEST_CONTEXT && process.argv[1]?.endsWith('.test.mjs')) {
  const began = Date.now();
  if (began >= ends) {
    process.stderr.write(`Error: test file not started: ${cutoffWords} is near\n`);
    process.exit(CUT_OFF_EXIT);
  }
  const atCutoff = ends - began < limit;
  setTimeout(() => {
    const holding = [...new Set(process.getActiveResourcesInfo())].join(', ');
    const waiting = childCommands();
    const when = atCutoff
      ? `near ${cutoffWords} after ${roughly(Date.now() - began)}`
      : `after ${limit % 60000 ? `${limit / 1000} seconds` : `${limit / 60000} minutes`}`;
    process.stderr.write(`Error: test file still running ${when}, held open by ${holding}${waiting.length ? `, waiting on ${waiting.join('; ')}` : ''}\n`);
    process.exit(atCutoff ? CUT_OFF_EXIT : 1);
  }, atCutoff ? ends - began : limit).unref();
}

// The commands this process's descendants run, each cut to COMMAND_CAP characters, or none when ps can't answer.
const COMMAND_CAP = 160;
function childCommands() {
  const r = spawnSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,args='], { encoding: 'utf8', timeout: 5000 });
  if (r.status !== 0) return [];
  const rows = r.stdout.split('\n').map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean).map(([, pid, ppid, args]) => ({ pid: Number(pid), ppid: Number(ppid), args }));
  const mine = new Set([process.pid]);
  const found = [];
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) if (mine.has(row.ppid) && !mine.has(row.pid) && row.pid !== r.pid) { mine.add(row.pid); found.push(row.args); grew = true; }
  }
  return found.map((args) => (args.length > COMMAND_CAP ? `${args.slice(0, COMMAND_CAP - 1)}…` : args));
}
