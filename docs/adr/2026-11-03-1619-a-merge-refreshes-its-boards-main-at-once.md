# A merge refreshes its board's Main at once

When the hub's poll records a card merged ([the hub's poll records merges and PR comments on the card](2026-11-02-2335-the-hubs-poll-records-merges-and-pr-comments-on-the-card.md)), it fetches that card's board's repo before the other boards and starts a try tick for that board alone, so Main rebuilds at the merge without waiting on the other boards' fetches or the next 15-second tick.

- **Which boards.** `checkGitHub` returns `merged`, the routes where this check recorded a card merged. A merged card leaves the board's open PRs (`boards.mjs prsOf`), so each merge names its board in one check only. A card shown on more than one board names each of them.
- **The fetch.** `fetchTryBranches({routes})` fetches only those boards and keeps the other boards' records in `repo-fetch.json`, so the repo-fetch link moves at once too. The poll's fetch of every board still follows, and fetches the merged board a second time; that fetch finds nothing new.
- **The refresh.** `tick({routes})` checks only those boards' cards and Main. While a tick runs, it waits for that tick and then runs once for every route asked meanwhile, since the running tick may already have passed the board; it never runs alongside one. A tick without routes still shares the running tick.

Only the poll's merges trigger it. A merge by the board's Merge button (`board/store.mjs mergeCard`) or a pushed branch found merged (`try.mjs settlePushed`) waits for the next poll as before.

The owner (kickflip.sh #7's thread, 2026-11-03): "Any merged items like this should also trigger a repoll of main outside of polling."

Considered:
- only a tick after the poll's own fetch of every board: Main would still wait on every other board's fetch, each up to its timeout;
- leaving the merged board out of the poll's full fetch: the full fetch writes the whole `repo-fetch.json`, and skipping would need a second filter for one saved fetch.
