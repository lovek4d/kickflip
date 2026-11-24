// docs/adr/2026-11-15-2300-the-nightly-full-suite-runs-every-boards-main-and-files-a-task-on-failure.md
// The nightly full suite, an Overnight work job (overnight.mjs): once a night, from the middle of quiet hours to their
// end, the hub runs every board's tests in full on its main (board-repo.mjs mainRefOf), one board at a time, each once
// the host eases. A main that fails is filed on its board as an ask, a New task its orchestrator triages. Boards on one
// repo and ref run it once, filing on the first. The night and the last run, {at, runs: [{route, ok, href?, error?}]},
// are kept in ~/.claude/kickflip/suite-state.json, the night written as the run starts, so a restart never runs it twice.
import { appendEvent, listBoards, readJSON, saveJSON, suiteStateFile } from './boards.mjs';
import { boardRepo, mainRefOf } from './board-repo.mjs';
import { localDay, quietMiddleOf } from './schedule.mjs';
import { overnightOn } from './overnight.mjs';
import { git, onCheckout, repoRun, untilHostEases } from '../board/worktree.mjs';

// The night (the localDay of its quiet hours' middle) whose suite is due at `now`, else null: due from the middle of
// quiet hours until they end, unless state.night already names it. s: push.mjs readSettings.
export function suiteDue(now, s, state = {}) {
  const middle = quietMiddleOf(now, s);
  if (!middle) return null;
  const night = localDay(middle);
  return state.night === night ? null : night;
}

const FAILURES_SHOWN = 10;
// The New task a failed run files: its first line is its title.
function failureText(base, sha, tests) {
  const total = tests.pass + tests.fail;
  const what = tests.hung ? `it hung past ${tests.hung.after} in ${tests.hung.files.join(', ') || 'the test runner'}`
    : total ? `${tests.fail} of ${total} tests failed` : tests.error;
  // A file the run's limit cut off is listed with the failures: the night's run is never run again.
  const failures = [...(tests.failures || []), ...(tests.cutOff?.failures || [])];
  return [
    `Nightly full suite failed on ${base} at ${sha}: ${what}.`,
    ...(failures.length ? ['', ...failures.slice(0, FAILURES_SHOWN).map((f) => `- ${f}`), ...(failures.length > FAILURES_SHOWN ? [`- and ${failures.length - FAILURES_SHOWN} more`] : [])] : ['', tests.error || 'The runner named no failing test.']),
    '',
    tests.log ? `Full output: ${tests.log}` : tests.logError || 'The full output was not saved.',
  ].join('\n');
}

const cardHref = (route, eventId) => `/${route}/#selectedCard=${encodeURIComponent(`ask:${eventId}`)}`;

// Runs the night's suite when it is due and Nightly full suite is on. runTests(dir, board) is the board's repo's whole
// run (worktree.mjs repoRun with no base: its test script handed nothing, else every node test file); eases() waits
// out a busy host. → {night, runs}, or null when nothing was due
export async function runNightlySuite({ now = new Date(), settings, manifest, runTests = (dir, board) => repoRun({ home: board, say: () => {} })(dir), eases = () => untilHostEases({ say: () => {} }) }) {
  if (!overnightOn('suite')) return null;
  const state = readJSON(suiteStateFile(), {});
  const night = suiteDue(now, settings, state);
  if (!night) return null;
  saveJSON(suiteStateFile(), { ...state, night });
  const runs = [];
  const ran = new Set();
  for (const board of listBoards(manifest)) {
    try {
      const source = boardRepo(board.route, manifest);
      if (!source.repo) throw new Error('it has no repo folder');
      const ref = mainRefOf(source);
      const key = `${source.repo}\0${ref}`;
      if (ran.has(key)) continue;
      ran.add(key);
      await eases();
      const base = source.branch || 'main';
      const run = await onCheckout(source.repo, ref, 'for the nightly suite', async (dir) => ({ sha: git(dir, 'rev-parse', '--short', 'HEAD').out, tests: await runTests(dir, board) }));
      if (run.tests.ok) { runs.push({ route: board.route, ok: true }); continue; }
      const eventId = await appendEvent(board, 'ask', { text: failureText(base, run.sha, run.tests) });
      runs.push({ route: board.route, ok: false, href: cardHref(board.route, eventId) });
    } catch (e) {
      runs.push({ route: board.route, ok: false, error: e.message });
    }
  }
  saveJSON(suiteStateFile(), { night, last: { at: now.toISOString(), runs } });
  return { night, runs };
}
