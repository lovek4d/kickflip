import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// docs/adr/2026-11-13-2130-the-main-suite-holds-no-new-timer-waits.md
// The main suite waits on state, never on time: a test file may hold no more timer waits than TIMED lists for it,
// and a file TIMED doesn't list holds none. A timer wait is a line, outside a // comment, that:
// - sleeps (setTimeout, sleep or delay called),
// - polls against a wall-clock ceiling (until, untilHeard or boardSees called),
// - measures elapsed time (Date.now() less a variable, performance.now, process.hrtime), or
// - sets a time limit (timeout: a number, or AbortSignal.timeout).
// docs/test-determinism-audit.md lists each one and the seam that replaces it; a fix task that removes some lowers its
// file's count here, and timing checks move to the perf bench, outside the main suite.
const WAIT = /\b(?:setTimeout|sleep|delay|until|untilHeard|boardSees)\s*\(|\bDate\.now\(\)\s*-\s*[A-Za-z_$]|\bperformance\.now\(|\bprocess\.hrtime\b|\bAbortSignal\.timeout\(|\btimeout\s*:\s*\d/g;

const timerWaits = (source) => source.split('\n').reduce((n, line) =>
  (line.trimStart().startsWith('//') ? n : n + (line.match(WAIT)?.length ?? 0)), 0);

const TIMED = {
  '.kickflip/build.test.mjs': 1,
  'bin/install.test.mjs': 3,
  'bin/wait-events.test.mjs': 4,
  'board/agents.test.mjs': 2,
  'board/board-builder-done.test.mjs': 2,
  'board/board-threads.test.mjs': 1,
  'board/domain.test.mjs': 2,
  'board/headless.test.mjs': 1,
  'board/land-queue.test.mjs': 11,
  'board/orchestrator-stops.test.mjs': 1,
  'board/prototype-phone.test.mjs': 2,
  'board/prototype-switcher.test.mjs': 1,
  'board/server-stale.test.mjs': 1,
  'board/server.test.mjs': 1,
  'board/suite-run.test.mjs': 3,
  'board/view.test.mjs': 1,
  'hub/boards.test.mjs': 2,
  'hub/close-board.test.mjs': 1,
  'hub/locks.test.mjs': 1,
  'hub/new-board.test.mjs': 5,
  'hub/repos.test.mjs': 1,
  'hub/restart-board.test.mjs': 2,
  'hub/sessions.test.mjs': 1,
  'hub/try.test.mjs': 1,
  'hub/views.test.mjs': 1,
  'shared/test-helpers.test.mjs': 4,
};

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const self = path.relative(root, fileURLToPath(import.meta.url));

test('a timer wait counts once per call, elapsed-time read or time limit, and not in a comment or as a fixed timestamp', () => {
  assert.equal(timerWaits([
    "await setTimeout(50);",
    "await until(() => seen, 'seen');",
    "assert.ok(Date.now() - started < 1000);",
    "execFileSync('git', [], { timeout: 5000 });",
    "await fetch(url, { signal: AbortSignal.timeout(5000) });",
    "// await setTimeout(50) in a comment",
    "const hourAgo = Date.now() - 3600_000;",
    "const until2 = 1; seenUntil(x);",
  ].join('\n')), 5);
});

test('no main-suite test file holds more timer waits than its count, and each count is what its file holds', () => {
  const files = execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '*.test.mjs'], { encoding: 'utf8' })
    .split('\n').filter((f) => f && f !== self && !/(^|\/)(\.repos|node_modules)\//.test(f) && fs.existsSync(path.join(root, f)));
  const over = [];
  const stale = [];
  for (const file of files) {
    const held = timerWaits(fs.readFileSync(path.join(root, file), 'utf8'));
    const allowed = TIMED[file] ?? 0;
    if (held > allowed) over.push(`${file}: ${held} timer waits, ${allowed} allowed`);
    else if (held < allowed) stale.push(`${file}: lower its count to ${held}`);
  }
  for (const file of Object.keys(TIMED)) if (!files.includes(file)) stale.push(`${file}: gone, drop its count`);
  assert.deepEqual(over, [], 'a test waits on state through a seam, not on time; a timing check belongs in the perf bench (docs/test-determinism-audit.md)');
  assert.deepEqual(stale, [], `TIMED in ${self} counts more timer waits than these files hold`);
});
