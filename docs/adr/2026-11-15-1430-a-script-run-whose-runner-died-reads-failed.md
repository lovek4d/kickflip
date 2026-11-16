# A script run whose runner died reads failed, keeping its output so far

The script offer's ADR (2026-11-14-2359) left out a run whose runner died, say at a reboot or a kill: no `script-result` ever came, so the offer read running for good.

- **The runner writes its pid** to `~/.claude/kickflip/logs/script-<id>.pid` when `bin/script-run.mjs` starts.
- **The minute check** (server.mjs `failDeadScriptRuns`, beside `reviveHeadless`) reads every `script-run` event with no `script-result` or `script-decline` (scripts.mjs `diedRuns`). A run whose pid file names a dead pid is dead. A run with no pid file is dead once its tap is more than two minutes old, which covers a runner that never started.
- **The result** is a `script-result` with `exit: null`, `died: true`, and the last 64 KB of the run's log as its output, so the offer reads failed with the output so far. The card says "its runner died" where it would show the exit code. The orchestrator's watcher gets the event like any result.
- **Not handled:** the script's own shell may outlive a killed runner; nothing stops it.
