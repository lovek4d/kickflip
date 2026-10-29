---
status: superseded in part by ADR-0050
---

# The hub home shows status, not descriptions

Superseded in part by [0050](0050-a-sidebar-of-every-board-replaces-the-hub-home.md): the hub home page is gone, and these rows, with their status word and lane chips, are the sidebar's site rows. They show no time since the site changed and no chevron.

Each site's row on the hub home page says what the site is doing, never what it is. The title is enough to know the site, so its manifest description no longer shows there.

- **The title line** holds the title and, on its right in muted 12px type, how long ago the site last changed: "just now", "12 min ago", "2 h ago" or "2 d ago". The time is the newest file change in the site's folder, which the hub already reads.
- **The sub line** leads with one urgent status word, with a dot in its colour: Down (danger) or Starting from the hub's own process state, Working (notice, the dot pulsing) while the session works on the owner's message, "N need you" (danger) while anything waits, or Building (accent) while a builder works on a card. The order is that one: the first that holds wins.
- **Lane chips** follow: small tinted chips for `N review` (accent), `N doing` (notice) and `N todo` (muted), from the `lanes` the site reports through `GET /_claude/needs` ([0010](0010-sites-report-what-waits-through-claude-needs.md)). A zero count is left out, and all zero reads "nothing open".
- **A calm site**, idle, in review or all clear, shows only its chips, with no word.
- **A site that reports no lanes**, such as a course or a starter-kit site, shows its word when one holds, or an empty sub line.
- The badge or chevron at the row's end stays as it was.

`hub/home.mjs` holds the pure pieces: `siteStatus` picks the word, `laneChips` the chips, and `readNeeds` reads a site's answer, accepting one without `lanes` or `building`.

The owner picked take F, "Lane chips", from a prototype on the `ios-orchestrator` site (card INT-92), asking for no descriptions on the home rows.

Considered:
- B, lane counts written out ("2 in review · 1 in progress") after the word. The words crowd out the counts on a phone.
- D, B with the time at the right of the sub line. The counts give way to the time when space runs out.
- E, the time by the title with short lane words. It reads well, but the counts don't stand apart at a glance the way tinted chips do.
- Keeping the description when nothing else applies. The owner reads the title; the description repeats it.
