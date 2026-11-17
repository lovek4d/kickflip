# Reconcile probes each board once a pass, on the 15 s clock

T-594's re-audit (F4, F5) found `reconcilePass` probing every port-served site at the top, then each running server again for `p.up`, every 2 s, on a 1 s clock whose only job was the reconcile.

## Decision

- **One probe per site per pass.** The top probe feeds both `answering` and a running server's `up`; the second probe is gone. A site the first probe did not cover (not port-served) is still probed where `up` is read.
- **The reconcile rides the 15 s clock**, every tick, with the hung check, the tick and the new-hub-code check. The 1 s clock had no job left and is gone, so the hub runs one `setInterval`.
- **A child's exit starts a reconcile once its backoff is over** (`nextStart`), so a crash, a stop for a changed entry, new code or a hung server still brings the server back about when it did on the 2 s clock, not up to 15 s later. A hub started without its clocks (`ticks: false`) schedules none. A manifest change (a board joining, leaving or changing its entry) and a stray holder of a port are now seen on the next 15 s tick, or at once where a request runs a reconcile itself (the owner's restart, a board's join, `serverAnswers`).

## Considered

- **Keep the 1 s clock at 2 ticks.** Saves nothing: the probes were the cost, and a second timer for one job is the thing T-376's two clocks were meant to remove.
- **`answering`'s MISSES.** A site reads down after 3 missed probes in a row, now 45 s rather than 6 s; a down read is for a server nobody started, so it stays.

Extends [every poll is in one registry and the hub runs on two clocks](2026-11-17-0330-every-poll-is-in-one-registry-and-the-hub-runs-on-two-clocks.md), whose 1 s clock this removes.
