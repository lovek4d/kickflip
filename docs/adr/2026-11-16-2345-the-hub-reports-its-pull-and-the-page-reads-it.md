# The hub reports its pull and the page reads it

A tap on the hub page's version used to answer `pulling 0.17.2…` and stop there: the pull ends in a hub restart, and nothing told the page the pull was over.

The pull's state is the hub's, so every page draws it, not just the one that tapped. `upgrade.mjs` keeps it, `pull()` → `{state: 'idle' | 'pulling' | 'failed', latest?, error?}`, and the hub page's data carries it as `update.pull` beside `update.latest`. A failure (the update exited non-zero, was killed, threw, or exited OK but left the old version installed) stays until the next pull begins. Nothing is written for the restart: the restart is itself the answer, since the new hub reports its running version as `version`.

A page reads, in this order:

- `update.pull` failed: red `update failed: <reason>`; a tap pulls again.
- `update.pull` pulling: orange `pulling <latest>…`. While it shows, the page reads `/_hub/api/hub` every 2 seconds; the hub being down meanwhile (it restarts) leaves it pulling. Past 330 tries (the 10-minute pull limit plus the restart) it reads red `the hub hasn’t come back. Is the host awake?`.
- the hub's `version` is not the one the page loaded with: green `updated, reload`, and a tap reloads the page.
- otherwise the answer to the page's own tap (`checking…`, `up to date`, a clone's commit, a failed check).

So a page opened or reloaded mid-pull, or on another device, reads what the tapping page does. The note's kind (`info`, `pulling`, `updated`, `failed`) picks its colour in place of a test on its text.
