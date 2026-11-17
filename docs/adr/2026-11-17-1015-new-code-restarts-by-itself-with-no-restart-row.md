# New code restarts by itself, and the sidebar has no Restart row

Supersedes the Restart-row part of [new server code waits behind a Restart row and restarts itself once idle](2026-11-15-2221-new-server-code-waits-behind-a-restart-row-and-restarts-itself-once-idle.md). The wait behind a running land and the restart by itself stay, as [new code restarts on a busy board once no land is landing](2026-11-16-1500-new-code-restarts-on-a-busy-board-once-no-land-is-landing.md) set them.

## Decision

The sidebar no longer shows New server version · Restart or New hub version · Restart. New code waits only for a running land, which takes seconds, and the hub then restarts the server or itself, so a tap had nothing left to offer.

- `/_hub/sidebar.json` drops `newHub` and each site's `newServer`; nothing else read them.
- `/_hub/restart-server` goes: the row was its only caller. The hub's own restart for new code (`restartForCode`) is unchanged.
- The sidebar's restart wait (`restartThenReload`, the `restart-wait` poll) goes with the row.
- The hub page keeps its Restart hub button, which confirms first, and a board's Restart on the Hub page; the Hub row still reads Needs a restart while the hub runs older code.

## Why

The owner asked on the restart's parent card why the banner was still needed once the restart is automatic. After the hub drains through `close()` and a board restart waits for the old server's port, the automatic restart is clean, so its manual fallback is dead weight.
