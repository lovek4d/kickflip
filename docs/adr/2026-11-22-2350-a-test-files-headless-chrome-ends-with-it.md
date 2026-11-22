# A test file's headless Chrome ends with it

On 11/22, 19 headless Chromes from killed test files sat orphaned on the host, some 3 days old, while swap was nearly full.
`startChrome` (shared/chrome.mjs) puts Chrome in its own process group so `stop()` can end every helper at once, which also
puts it outside the run's group: the run's cutoff kill and exit-with-run.mjs's `process.exit` (both of which skip the
file's `after()` stop) never reached it.

## Decision

- `startChrome` keeps the Chromes its process started and has not stopped, and the process's `exit` event kills their
  groups. This covers a file ended by exit-with-run at its limit, the near-cutoff end and a run that is gone.
- A SIGKILL (the run's group kill at its cutoff) gives the process no exit event, so `sweepOrphanChromes` ends every headless
  Chrome with parent 1 whose profile dir is under the temp dir. `nodeTests` sweeps at the run's start, for leftovers of a
  run whose starter died, and at its end. A Chrome whose file still runs has that file as its parent and is left alone.

## Left alone

Chrome stays in its own group instead of the run's: a group kill would then take the runner too, and `stop()` relies on
its own group.
