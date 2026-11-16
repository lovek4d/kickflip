# The watcher collapses repeat waits, and a hook refuses filtering them

Every watcher wake reprinted every `waits` line, most already acted on. To cut the repeats the orchestrator piped
`rg '^waits'` through a growing `rg -v`; a term meant for readied cards also matched `calls #817…#820`, and four builds
sat unverified for 10–15 minutes. A memory note against filtering had not stopped it earlier.

- `bin/wait-events.mjs` prints a wait in full only when it is new since the last wake that printed it or its line
  changed (picked up, bumped, re-owed, a new next step). The rest collapse into one line,
  `waits still waiting: calls T-373, T-368 · staging T-245`, naming every key, grouped by kind in the list's order.
  It starts with `waits` so `rg '^waits'` still reads it. The last printed lines are kept in
  `data/.waits-shown-<session>.json`. Nothing is dropped.
- `hooks-plugin/hooks/waits-filter-gate.mjs`, a PreToolUse hook on Bash, denies a command that reads the watcher's
  output (`$O`, a `.output` file, `wait-events`) through rg/grep -v, head, tail, awk, sed that deletes, or an rg/grep for
  anything but waits or events. `rg '^waits' $O`, `| cut`, and any filter after an `rg '^event'` selection pass.
  The check is on the command text, so a differently named output file is not seen.
