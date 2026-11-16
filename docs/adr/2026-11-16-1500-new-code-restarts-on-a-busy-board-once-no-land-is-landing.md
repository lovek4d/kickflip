# New code restarts on a busy board once no land is landing

#855, owner (11/16): "Why is the usage limit reached, but the color is still gray on the bar? Should be orange within double buffer limit and red at the limit".

The bar was grey because the hub still ran code from before #841 moved the bar's tone to the server. The page had loaded the new JS, which draws the tone the server sends, and the old hub sent none. The hub's restart onto new code had been held since 23:00Z, logging "new hub code waits to restart, since its session is busy / a builder is open on /hub-orchestrator" 111 times. It held because of [new server code waits behind a Restart row and restarts itself once idle](2026-11-15-2221-new-server-code-waits-behind-a-restart-row-and-restarts-itself-once-idle.md): it waited until no board session was busy and no builder was open, which on a busy board never happens.

## What a restart interrupts

A board server's restart stops its process group, and the hub's restart stops the hub and every board server. Neither touches:

- **board sessions**, which run in tmux or in the background as processes of their own. The CLI and the watcher read and write the board's files directly, not through the server.
- **builders, planners, landers and helpers**, which the server launches detached, each leading its own process group (`agents.mjs`).
- **lands**, which run in the builder's `board.mjs builder done` or in a held Merge's detached `board.mjs merge`.

A restart does interrupt two things:

- **The server's own passes and requests**, which may be partway through a write. Each JSON write is atomic (temp file, then rename), but a pass can make several writes. The board server now exits on SIGTERM through its `close()`, which waits for every pass and request it has started (`settled()`) before it exits 0. The hub's SIGKILL after its 5-second grace bounds that wait.
- **A land**: a restart while a land fast-forwards main can load files from partway through, and stopping a land mid-push is worse than a late restart.

## The rule

- A restart for new code, of a board server or of the hub, waits only while a land is landing on the host (`auto-restarts.mjs` codeRestartHeld: the land lock is held).
  - A queued land, a busy session and an open builder, planner or lander never hold it.
  - The hub's restart no longer waits on every board in turn.
- A running land holds it for as long as the land runs, with no bound of the hub's own: each land is bounded by its own run. Lands run their tests, then fast-forward main and push, and a busy host can stretch that well past any fixed bound. Nothing else holds a code restart, so there is nothing left for a time bound to cap.
- The automatic restarts of a session not listening and a server not answering keep `restartHeld`'s guards. Those restarts stop the session itself, which a busy session or an open builder does care about.

## Bar tones follow the pause line

`usage.mjs` toneOf takes the pause line. A bar is **high** (orange) from twice the buffer under the line, `nearFrom(line)` = 2·line − 100 (80% for the 90% line), and **full** (red) at the line. With the line Off (100) a bar never colours. The hub passes the gate's line to the reader for `/_hub/sidebar.json`'s usage. The week bar's tone already used the same band.

The default line, 90, is one constant, `DEFAULT_PAUSE_AT`, in `usage.mjs` beside `nearFrom` and toneOf, and `usage-gate.mjs` imports all three. They live in `usage.mjs` rather than the gate because the gate imports the reader, and the reader tones each window.

The sweep for other copies found the hook's text already reads `gate.pause_at`. It also found `CTX_FULL_PERCENT` (90), which is the context window's mark and is never compared against the pause line.

## Considered

- **Reloading the page by itself when the server's code hash changes, and having the hub serve the JS of the code it runs.** Dropped on the orchestrator's answer. The app already watches the running hub's code hash and offers New version · Reload. [The app reloads for new hub code only on the owner's tap](2026-11-01-1824-the-app-reloads-for-new-hub-code-only-on-the-owners-tap.md) stands. The bounded restart keeps a page with new JS and a hub with old code apart for minutes at most.
- **Keeping idle as the guard, with a bound added.** The bound would then fire on nearly every restart, after waiting on things the restart never touched.
- **A 10-minute bound on a land's hold.** Once it ran out, the restart could cut into a land still testing or pushing; dropped on the orchestrator's review.
