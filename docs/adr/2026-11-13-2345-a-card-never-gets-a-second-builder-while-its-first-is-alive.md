# A card never gets a second builder while its first is alive

The pull launched two headless builders on one card (T-307) when two passes both read it as unstarted.

The pull now checks the card's open builder records, fresh from disk, and the tracked launch's pid before it writes
the "Pulled in" line or starts the build (headless.mjs `hasBuilder`). A record with no process yet counts as a builder
whose launch is to come; a record with a process counts while `agentMayRun` says it may run, so a ps that gave no
answer reads as unknown, never dead. A skipped card is logged as pull `skipped`. The resume of a paused build waits the
same way while its old process may still run.

The minute relaunch (`reviveBuilders`) already tests its pid by signal 0, with no ps, so a ps timeout never reads a
live builder as dead there; board/one-builder.test.mjs holds that line.
