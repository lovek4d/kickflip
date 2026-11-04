# The hub's poll records merges and PR comments on the card

The hub's GitHub check (`hub/github.mjs`, [the hub polls GitHub and sends pushes on one polling interval](2026-10-29-1639-the-hub-polls-github-and-sends-pushes-on-one-interval.md), [one board registry for every hub feature](2026-10-29-1639-one-board-registry-for-every-hub-feature.md)) writes two things it reads to the card before it sends `github-change`:

- **Merges.** A card whose PR reads MERGED is closed as `item set --status merged` closes it, with "Merged PR #n." in its thread: dependents get `card-unblocked`, builder records close and the ticket moves. It is the same `setItem` call `hub/try.mjs` `settlePushed` makes for a plain git remote ([a board can work on any git remote](2026-11-02-1850-a-board-can-work-on-any-git-remote.md)). A wave file shown by several boards is closed once.
- **Comments and reviews.** Each new `user` or `reviewer` event in the PR report ([the hub reads GitHub itself](2026-11-01-2314-the-hub-reads-github-itself.md)) after the card's `gh_since` becomes one `--via github` thread line, from `love` or the reviewer's name (by their `github` login in the wave's or board's reviewer list, else the login), linked to the comment or review, else the PR. An approval reads "Approved." before its text and a change request "Changes requested."; an empty plain review writes nothing, since its inline comments come as their own events. Each event is written once per card, by kind and id, kept in `github-state.json` `threaded` until the PR leaves the poll.

The session still acts on what it reads: reviewer reactions, rebases, fixes, replies and the `gh_since` cursor. Codex findings stay the session's, one line per round.

A session that wrote "Merged." in the thread but never ran `--status merged` left its card unfinished and its dependents blocked for days, and every owner or reviewer line was a hand copy of what the poll had already fetched. The owner picked both on hub/INT-271.

Considered:
- `board.mjs pr` records the merge and writes the lines during the session's tick: a missed tick still leaves the card open and the thread behind;
- deduping lines by their link in the thread file: a review read without its url would repeat each poll.
