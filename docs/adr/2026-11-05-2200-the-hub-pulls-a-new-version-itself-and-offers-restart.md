# The hub pulls a new version itself and offers Restart

Supersedes the Upgrade button and the builder wait in [the hub offers a newer kickflip from npm](2026-11-03-1521-the-hub-offers-a-newer-kickflip-from-npm.md); the check, the clone rule and the log file stand.

The owner picked take B of the #292 prototype: no Upgrade tap. When the hub's check (start, then hourly) finds `@lovek4d/kickflip@latest` newer than the installed one, it pulls it at once with `kickflip update --no-restart` (`hub/upgrade.mjs`, `bin/kickflip.mjs`), logging to `kickflip-update.log`. The hub keeps running its old code.

- **The row** reads **Updated to v0.5.2 · Restart** with no sub line while the installed version on disk is newer than the version the hub started with (`upgrade.state` `updated`), and **Updating** while the pull runs. Restart posts `/_hub/restart-hub`, the row reads Restarting to v0.5.2, and the sidebar polls `/_hub/api/hub` until its `x-hub-code` differs, then reloads the page itself (the owner tapped Restart, so the reload needs no second tap, unlike [the app reloads for new hub code only on the owner's tap](2026-11-01-1824-the-app-reloads-for-new-hub-code-only-on-the-owners-tap.md)). After two minutes without an answer the row returns to Restart with the command to run by hand.
- **A failed pull** reads **Update failed** with its last log line and an **Update** button (`POST /_hub/upgrade`, now only a retry); the next hourly check retries too.
- **No builder wait.** Builders, landers and planners start detached in their own process groups (`board/agents.mjs`, merges, board servers, sessions), and the hub's shutdown stops only the board servers it started. Runs already going keep the code they loaded; anything launched after the restart gets the new one. `board/agents.test.mjs` checks that an agent outlives the process that launched it.
- A version installed on disk and newer than the running hub (a hand-run `npm i -g`) shows the same Updated · Restart row.

Considered:
- an Update tap before the pull, and a take that pulls and restarts by itself with a Cancel (the prototype's other takes);
- waiting for builders before pulling or restarting: they are detached, so a restart costs only a short blink of the board servers.
