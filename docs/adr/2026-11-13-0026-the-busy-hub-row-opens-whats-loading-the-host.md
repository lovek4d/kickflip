# The busy Hub row opens what's loading the host

Status: accepted (owner, 11/12, card #634; prototypes busy-sheet take C and busy-hub-row take A). Amended by 2026-11-16-1915-the-hub-status-opens-the-load-sheet-at-any-load-collapsed.md: the status opens it at any load, every group starts shut, and a detached process burning CPU reads as orphaned.

The Hub row reads "busy 42m" while the host is busy (2026-11-06-1305-a-busy-host-shows-only-on-the-hub-row-and-the-logo-dot.md), but said nothing about why. The owner asked for a breakdown of what's loading it, built from the numbers alone, opened from the busy status at any time.

Now:
- Tapping the Hub row's busy words ("busy 42m") opens a sheet, "What's loading the host". The rest of the row still opens the hub page. The words are a button inside the row's link, which `sidebar.js` keeps from following the link.
- The sheet's top shows numbers and a chart and no verdict line: the 1-minute load now with the core count, the average over the last hour, and the hour's load as a line against a dashed line at the core count.
- The hub's 15-second tick keeps the first reading of each wall-clock minute over the last hour as `samples` in `machine-state.json` (`shared/machine-gate.mjs`), so there's no new file and no new timer.
- Below the chart, groups fold to one row each with their count and total CPU, from one `ps` call (`hub/machine-load.mjs`), in this order:
  - **Looks orphaned, older than a day**: a node process of the hub's user, over a day old, reparented to launchd (parent pid 1), and not the hub itself. This group starts open.
  - **Test suites**: a `node --test` run that isn't inside an orphan or another suite. It's named by the builder or session above it.
  - **Claude sessions**: live `~/.claude/sessions` records. A board's own session reads as its board's title, "orchestrator".
  - **Builders and planners**: the pids on every board's open builder records (`openBoardBuilders` now carries `pid` and `kind`).
  - **Other**: processes that are in no group and use at least 10% CPU, the busiest five.
- A row's CPU is its own plus that of any child that isn't a row itself, so a suite counts its test files.
- Each row shows the shortened command (or the card and kind, or the board title), the age, the owner and CPU %.
- Only orphans get Stop. Its confirm sits in the row: Keep or Stop it. `POST /_hub/machine/stop {pid}` reads `ps` again and refuses with a 409 unless the pid still looks orphaned. Otherwise it sends SIGTERM to the pid and every process under it, and writes a `machine-stop` line to the hub audit.
- When `ps` gives no answer in time, the sheet says so. A host with no rows reads "Nothing is loading the host."
- No model reads any of it.

Not here: the sidebar banner when the host has been busy for 30 of the last 60 minutes, and hiding it for an hour (T-257).

The wording says "host", not "Mac", as 2026-11-06-1305 requires, though the prototypes said "this Mac".
