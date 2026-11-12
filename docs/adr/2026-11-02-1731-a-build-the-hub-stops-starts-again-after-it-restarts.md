# A build the hub stops starts again after it restarts

On ios-orchestrator, `board.mjs build` for five cards a few seconds apart printed `started` for each, but two never built: their logs stayed empty, `data/try.json` kept no state for them and no thread line said why (hub/INT-263). The repo's build script waits on a shared Xcode lock without writing to its log, so the two were still waiting when the hub restarted to load new code. Shutdown stopped them the way an owner's stop does, clearing their state and sha, and nothing asked for them again. This supersedes in part [a board's build script serves or builds each card and main](2026-11-01-1846-a-boards-build-script-serves-or-builds-each-card-and-main.md), whose shutdown stopped every run and whose startup forgot a card build that was still going.

- **Shutdown keeps a running build's state.** `stop` in `hub/try.mjs` still ends every run's process group and posts no thread line. A ready run is cleared as before; a run still going keeps `running` in `data/try.json`. A hub that crashes leaves the same record.
- **The next hub starts it again.** A card that `data/try.json` records as running when the hub loads it keeps `running`, on a web board too, so its badge still reads Building… or Serving…. It starts again on the hub's next 15-second tick, whether or not Auto-build is on and whatever its head; a hub that stops before then leaves it running for the one after. A Build or Serve request for that card before then takes its place. One that can no longer start, such as a script that fails its checks or a worktree that is gone, writes the usual failure line to the card's thread. While try builds wait on Tailscale it waits like any refused start. A card that is done, merged or dropped does not start again. Main already rebuilds after a restart, since a build that never finished records no sha it must skip.

Considered:
- A thread line at shutdown asking the owner to build again: the hub accepted the request and only its own restart stopped it, so the owner should not have to ask twice.
- Letting a build outlive the hub: its output pipes and process group belong to the hub that started it, so the next hub could neither log nor end it.
- A request queue in the hub: no request was refused; each was accepted and running when the restart ended it.

Since #510 shutdown keeps a ready card's serve too, and the next hub serves it again ([a card's serve stays up while its worktree does](2026-11-12-0112-a-card-serve-stays-up-while-its-worktree-does.md)).
