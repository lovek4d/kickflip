# An integration missing a permission reads degraded, and tapping it opens what to fix

Extends 2026-11-02-1118-integrations-show-readiness-and-features-wait.md and 2026-11-03-0501-the-hub-reads-healthy-degraded-or-a-site-down.md.

A ready integration can lack a permission one of its features needs. Slack's token sends on without `im:history` and `search:read`, but reviewers' replies in the day threads go unheard and @kickflip in the owner's DMs isn't found. Its row read green ready, with two long sentences under it naming each scope and the same fix twice.

Now such a row reads amber **degraded**, the hub's word for works but something's off, on an amber tile, followed by its ready detail; the scope sentences leave the row. Tapping degraded opens a sheet from the bottom, titled "<Integration> is missing permissions": one line per missing permission naming what stops working ("Review-thread replies aren't heard", "@kickflip in your DMs isn't found") with its scope in mono, then the one shared fix ("Add these scopes to the Slack app, reinstall it, paste the new token") and the integration's key button, which closes the sheet and opens its key modal. None missing reads green ready with nothing to tap. A refused token stays not ready, with no degraded word.

The row stays `ready`: nothing waits on it (`readiness.waiting`), since its sends go on.

One helper draws every integration's degraded word and sheet. `hub/readiness.mjs` gives a ready row `permissions: {missing: [{scope, effect}], fix}` from its `PERMISSIONS` entry, which maps flags the integration's status sets to scopes; `board/public/view-hub.js` `permissionsWord` and `permissionsSheet` draw any row carrying it, under its own name and key button. Slack is the only entry today: GitHub's check is gh's login and Linear's is whether Linear accepts the key, neither of which names a missing scope. A check that does adds an entry and a status flag, and its row draws through the same helper.

Considered: an inline expand under the row and a popover on the word (the prototype's takes B and C, `missing-permission-sheet`). The owner picked the sheet from the bottom, the shape the board's other sheets have.
