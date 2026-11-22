# doctor --fix waits for the old hub and reloads only a changed service

`kickflip doctor --fix` (install) used to boot the launchd item out, wait 500 ms and bootstrap, so a hub slow to exit
made bootstrap fail, and every run restarted the hub even with nothing to change.

- launchd: after `bootout`, install polls `launchctl print` every 500 ms until the item is gone (the old hub has exited),
  up to 30 s, then fails naming `launchctl bootout …` to run by hand. A failed `bootstrap` is retried, five tries in all.
- A service whose definition file already holds the bytes about to be written, and which is running, is left alone, on
  launchd and systemd both.
- The systemd unit sets `KillMode=process`, so a restart stops only the hub, not a Run-card script detached from it. A
  script that restarts the hub keeps its result: the runner already records it (hub/boards.mjs appendEvent,
  board/server.mjs failDeadScriptRuns).
