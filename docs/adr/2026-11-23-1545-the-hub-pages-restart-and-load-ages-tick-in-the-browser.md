# The Hub page's restart and load ages tick in the browser

The Hub page's "restarted … ago" lines and the load sheet's process ages were worded by the server when it built
the answer, so they froze until the next load. The server now sends the time and the browser words it and counts it on,
as the board's live counts and header do (T-838).

- hub/auto-restarts.mjs restartLines sends `{link, detail: "the session", at, why}`. view-hub.js words `at` with
  BoardUI.ago and repaints each `[data-ago]` on the page tick.
- hub/machine-load.mjs machineLoad sends each row's `startedAt` (now minus its ps age) instead of `age`. The load sheet
  words it with ageWords and sidebar.js repaints `[data-started]` each second while the sheet is open.

Left out: the deaf push body "An event has waited N min" stays server-worded, since a push isn't a page.
