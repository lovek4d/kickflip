# New server code waits behind a Restart row, and restarts itself once idle

#789, owner (11/15): "can we get a restart banner instead matching the reload banner, with auto restart on idle like auto update?" On 11/15 between 12:07 and 12:17Z every land that touched `board/` or `hub/` restarted /hub-orchestrator's server, three times in seven minutes. At a load of 62 the last boot took over 2.5 minutes before `/_claude/health` answered, and the board was unresponsive the whole time.

This replaces the restart in [a board server whose code changed restarts between builders](2026-11-04-0056-a-board-server-whose-code-changed-restarts-between-builders.md). It also replaces the land's own restart of the hub or of every board server.

- **New code never restarts at once.** The land restarts nothing (`board/worktree.mjs` landPrepared). The hub still hashes each running board server's code on every reconcile, and its own code through `self-restart.mjs`. A server whose files changed keeps running as `newCode` on its process entry. A crash, a missing server or a changed manifest entry restarts at once, as before.
- **The Restart row.** The sidebar's update slot, under New version · Reload, adds the same row worded for a restart (`ui-sidebar.js` restartRow):
  - **New server version · Restart** on a board whose server runs older code (its site's `newServer` in `/_hub/sidebar.json`);
  - **New hub version · Restart** on the hub's pages while the hub does (`newHub`).
  - A tap posts `/_hub/restart-server {route}`, which stops that server alone with why `code` so its page reads "restarting · its code changed", or `/_hub/restart-hub`. The row spins, reads the sidebar each second until the restarted server answers, then reloads the app.
  - Like Reload, the tap asks no confirm. The Hub row's Restart hub keeps its confirm.
- **Auto restart once idle.** Superseded by [new code restarts on a busy board once no land is landing](2026-11-16-1500-new-code-restarts-on-a-busy-board-once-no-land-is-landing.md): only a land mid-flight holds it, for as long as it runs. A board's server restarts by itself once `auto-restarts.mjs` restartHeld finds nothing holding it: its session not busy, no builder, planner, helper or lander record open (`openBoardBuilders`), no land queued or landing. These are the guards of [the hub restarts a session not listening and a server not answering](2026-11-15-0123-the-hub-restarts-a-session-not-listening-and-a-server-not-answering.md).
  - The hub's restart restarts every board server, so it waits until every board is idle.
  - An npm `kickflip update --no-restart` now waits too, rather than restarting at once.
  - The hub logs what holds a restart, once per reason.
- **One setting.** Superseded by [auto restart is always on](2026-11-16-0300-auto-restart-is-always-on-and-auto-update-is-the-only-update-setting.md): the box and `autoRestart` are gone.

## What a board server's boot reads (11/15, this board)

The numbers below are **provisional**. They were taken on a copy of /hub-orchestrator's data folder while the host's load average was 10.9–12.0 on 10 cores. Each step was timed in a fresh node process, 3 runs, as a proxy for a real boot; the 2.5-minute boot at load 62 was not reproduced.

Every request waits on `ready`, `/_claude/health` included, and `ready` resolves only after the whole startup chain (`board/server.mjs` started()). That chain is:

1. `sync.json`.
2. The migrations, each reading `items.json`.
3. The first shared board build, made of snapshot() and cardNotesOf.
4. The Done archive pass.
5. markNewCards and the check passes, each of which parses `events.jsonl` again.

The data folder is 34 MB in 3,931 files.

| Boot step | What it reads | ms (3 runs) |
|---|---|---|
| items and agents | `items.json` and every `agents/*.json`, done ones included (1,402 files, 5.7 MB) | 327 / 203 / 114 |
| threads | the live cards' threads (169 of 1,128) | 14 / 17 / 54 |
| notes | the live cards' notes (169 of 1,061 .md files) | 38 / 40 / 24 |
| events | `events.jsonl` (1.7 MB, 6,671 lines) and `hidden.json` | 48 / 62 / 32 |
| event replies | withReply's readdir of all of `replies/`, once for each of 3,253 needs-reply events | 1,469 / 668 / 1,476 |
| owner | `owner.json` (514 KB) | 3 / 52 / 3 |
| board | buildBoard | 416 / 397 / 499 |
| snapshot | the whole snapshot and build | 2,327 / 1,464 / 2,247 |
| Done archive | `done-archive.json` (3.5 MB, 909 cards) | 91 / 84 / 197 |

**Lazy notes are not built.** Reading notes on the first sync request instead of at boot saves about 40 ms. A rebuild after any watched write reads them all again anyway. It would need sync.mjs noteRecords to tell a note not read yet from a gone one. Events can't wait: buildBoard derives asks, holds, merges and waits from them.

The boot's real costs are elsewhere:

- withReply's readdir per event, which reading `replies/` once and indexing it by event id would remove;
- reading every agent record, done ones included;
- buildBoard itself;
- `events.jsonl` parsed again by each boot pass.

Restarting only when idle removes the restarts that collided with other work. A faster boot is left to its own card.

Considered:
- restarting at once but staggering the boards: every land would still stall a busy board for its boot;
- a banner on the board view itself: the sidebar's update slot is the Reload row the owner pointed at, and it reaches every page;
- a separate auto restart box for the hub and for board servers: one setting, as the owner asked;
- waiting for the owner to be away, as auto update does: idle is the guard the notes name, and an owner at the board still gets the row.
