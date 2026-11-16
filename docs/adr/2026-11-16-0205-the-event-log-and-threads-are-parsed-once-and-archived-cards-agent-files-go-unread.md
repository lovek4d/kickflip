# The event log and threads are parsed once, and archived cards' agent files go unread

#833. [Boot lists replies once and skips Done cards' agent files](2026-11-16-0200-boot-lists-replies-once-and-skips-done-cards-agent-files.md)
cut two boot reads. Profiling a page build, a board change (its wait check included) and a boot on a copy of
/hub-orchestrator's data folder found the reads that still walk the whole history on every pass:

- `data/events.jsonl` (6,900 lines, 1.8 MB), read and parsed whole by each reader: three times a board change
  (the page events, the wait check, the Auto pass), four times a minute (failDeadScriptRuns among them), seven
  times a boot, and by most store.mjs commands. One parse took ~114 ms on the busy host.
- `agents/*.json` of every archived card: the item file no longer holds them, so the Done-lane skip let 1,239 of
  them through each build, and closeGonePlanners read every record on every change: 2,278 agent files a change.
- each live card's thread, read and parsed whole by each build.
- ownerEvents, which listed `replies/` once for each owner answer (2,100 of them).
- migratePhases, which listed `agents/` and read the records of every Done card, live and archived, each boot,
  for a fact only a Done card with no phase needs.

## Decision

- store.mjs `readLog(file)` reads an append-only JSON-lines file, the event log or a thread, parsing each line once
  in the process. Each read stats the file and parses only the bytes appended since, read from the start of the
  last whole line it kept: a file rewritten under it shows in bytes that no longer match and is read whole again,
  as is one replaced (another inode), shortened, or rewritten to the same length. Every reader of the event log and
  of threads, the server's and store.mjs's, reads through it. It returns a new array each call, of frozen lines, so
  a caller that changes a line fails at once instead of changing what another reads.
- `readAgents(dir, ids)` reads only the records of the ids it is given. The board's build reads those of each card
  in an item file outside Done; an archive page reads its entries' cards' own; a card's thread reads its card's.
- closeGonePlanners reads the records of the cards outside Done in each item file.
- ownerEvents lists `replies/` once.
- migratePhases reads a Done card's records only when the card has no phase yet.

What it keeps is checked against the file on every read, so nothing goes stale: the cost of a read of an unchanged
file is a stat. The event log and every thread file the server reads stay parsed in its memory, a few times their
size on disk.

## Measured

On a copy of /hub-orchestrator's data folder, main against this change run back to back, two runs each. The host's
load was 40–45 on 10 cores throughout (other builds and tests running), so every number is **provisional**.

| Pass | Before | After | Files read before → after |
|---|---|---|---|
| boot | 8,986 / 9,039 ms | 2,540 / 2,878 ms | agents 3,272–4,553 → 80–121; `agents/` listings 3,243 → 69; events.jsonl 6–7 whole → 1 |
| board change (wait check included) | 1,360–1,739 ms | 369–1,025 ms | agents 2,278 → 62; events.jsonl 3 whole (5.3 MB) → 1 tail read of the new line; threads 255 → 0 |
| page build | 736–1,535 ms | 411–1,092 ms | agents 1,281 → 42; events.jsonl 1 whole → 0; threads 255 → 0 |
| minute | 1,048 / 1,604 ms | 538 / 904 ms | agents 2,542 → 64; events.jsonl 4 whole (7 MB) → 0 |

A board change appended one event before it, as a live board's does.

## Cost

- An archived card's builder records no longer count toward checksOf's claudeAt, as a Done card's stopped counting in
  #802; they are older than any live card's.
- A planner record left open on a Done card is closed once the card leaves Done, not while it is there.
- A process rewriting the event log or a thread in place to a longer file that keeps the bytes of the last line read
  at the same offset would go unseen; the board only appends to both, or removes a thread whole.

Still read whole each boot: `done-archive.json` (3.7 MB), by the start-up migrations, four times.
