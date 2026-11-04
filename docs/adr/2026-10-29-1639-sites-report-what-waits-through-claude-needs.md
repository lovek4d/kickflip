---
status: superseded in part by 2026-11-01-1252-need-you-outranks-working and 2026-11-02-2044-the-cli-and-board-server-do-the-boards-housekeeping
---

# Sites report what waits on the owner through `GET /_claude/needs`, and the hub reads only that

Superseded in part by ["N need you" outranks Working](2026-11-01-1252-need-you-outranks-working.md): "N need you" outranks Working, so the sub line's word follows that ADR's order.

Superseded in part by [the CLI and board server do the board's housekeeping](2026-11-02-2044-the-cli-and-board-server-do-the-boards-housekeeping.md): the watcher writes a board's working marks; `board.mjs working` is gone.

Any site may serve `GET /_claude/needs`, returning `{items: [{kind, text, url}], working, summary, lanes, building}`:
- `kind` is a short label, such as "Question" or "Tap Ready";
- `url` is relative to the site root;
- an empty `items` means nothing waits on the owner;
- `working`, optional, counts the owner's messages the session has started on and not yet answered;
- `summary`, optional, is one short line about what waits, such as "2 questions · 1 draft waiting on Ready";
- `lanes`, optional, is `{review, progress, todo}`, the count of open cards in each lane; a site without lanes leaves it out;
- `building`, optional, is true while a builder works on one of the site's cards.

The sidebar ([a sidebar of every board replaces the hub home](2026-10-29-1639-a-sidebar-of-every-board-replaces-the-hub-home.md)) badges each running site's row with the count. A site that answers 404, errs, or takes longer than 1.5 s counts as unknown, not zero, and its row shows no badge. The hub caches each answer for about 20 s.

The row's sub line leads with the most urgent status word: Down or Starting from the hub's own process state, then Working while `working` is above 0, "N need you" while anything waits, or Building while `building` is true. The `lanes` follow as chips; a site without them shows only its word, or nothing ([the hub home shows status, not descriptions](2026-10-29-1639-the-hub-home-shows-status-not-descriptions.md)). The `summary` still feeds `/_hub/needs.json`, with "N waiting: <kinds>" when the site gives none.

The hub also sums the counts into `/_hub/needs.json` `{total, sites}`, and `total` is the Home Screen app's badge. A site whose answer is unknown adds nothing. The hub's page sets the badge on each load, a board page sets it after it loads its board data (`ClaudeSite.syncBadge()`), and each push carries the total as `badge` for the service worker. A board takes the total from the hub and never sets the badge from its own count, since the badge covers every site.

A board builds the answer in `board/domain.mjs` `needsAnswer`, one item per Needs you line, and its page renders the same lines. Its `lanes` count review with Stale, and `building` is true while any card has a builder record not marked done. Its `working` counts events marked with `board.mjs working` that have no reply yet; a thread message also stops counting once a Claude line follows it. A starter-kit site returns `data/needs.json`, which its owning session writes, with `working` and `summary` passed through when present.

The prototypes read each board's `/api/board`, so only boards could count, and the hub had to know the board's data shape. The owner chose a defined endpoint (round `site-v8`), then the row's activity line and the app badge (round `site-v10`), then the status word and lane chips in place of descriptions (card INT-92). That follows the direction in [agent sessions write a board's data only through board.mjs](2026-10-29-1639-agents-write-site-data-only-through-board-mjs.md): sites and agents meet through defined endpoints and flows, never each other's files.
