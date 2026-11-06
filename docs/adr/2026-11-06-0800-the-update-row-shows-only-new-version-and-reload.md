# The update row shows only New version and Reload

Supersedes the row parts of [the hub pulls a new version itself and offers Restart](2026-11-05-2200-the-hub-pulls-a-new-version-itself-and-offers-restart.md) (Updated · Restart, Updating, Update failed · Update) and of [the hub restarts itself on a done signal](2026-11-06-0010-the-hub-restarts-itself-on-a-done-signal-from-whatever-brought-the-code.md) (its Restart fallback in the row). The check, the clone rule, the pull without a builder wait and the self-restart stand.

The owner's answer to #334 (take C, simpler): the sidebar's update row is a convenience for the automatic update, not a status panel.

- **The row** reads **New version · Reload** when the page booted on other hub code than the hub now sends (`x-hub-code`), which means the hub already restarted on new code. On an npm install and on a clone alike. Reload reloads the page.
- **Nothing else shows**: not while the pull runs, not when the pull failed, not when the restart failed. `/_hub/sidebar.json` no longer carries `upgrade`, `POST /_hub/upgrade` is gone, and so are the Update and Restart buttons in the sidebar. The upgrader only checks, pulls and calls `pulled`; a failed pull is logged to `kickflip-update.log` and the next hourly check tries again.
- **The CLI is the backup**: `kickflip update` pulls and restarts by hand; the Hub page's Restart hub still restarts the hub.
- The logo's label says "new version ready" only with the row.

Follow-up: an update check in Hub settings that says why an update failed (#365).
