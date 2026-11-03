---
status: superseded in part by ADR-0132
---

# The hub board files its cards as GitHub issues

Superseded in part by [0132](0132-a-card-is-named-by-its-boards-ticket-source.md): a card with an issue reads as its issue, `#n`; the card id stays its key, and a new card's id is `GH-<n>`.

hub/INT-13 moved the hub board's tickets off the local wave file. The owner picked A for `tracker`, `tracker-role`, `tracker-old-cards` and `gh-account`: GitHub issues on kickflip's own repo, filed as a gh account the owner names, with the board still the store. This builds on [0081](0081-a-board-has-one-ticket-source.md) and [0088](0088-kickflip-reaches-linear-with-a-key-on-the-mac.md).

- **The hub board's repo is the clone's origin.** `hubGithub` (`hub/boards.mjs`) reads the running kickflip clone's `origin` from git on every call and parses it as `owner/name`. The repo is never hard-coded and never stored in the manifest. `boardRepo`, the board registry and the board page all take the hub board's repo from it. An install from npm has no clone, so its hub board has no repo and GitHub isn't offered. The hub board's repo still can't be changed, and its builders still branch from the clone's local main, not from origin.
- **A GitHub source can name a gh account.** `board.json` `tickets` is `{source: "github", account}`, and the account is optional. With an account, every issue call (create, view, close, and the `gh api user` check before a close) runs gh with `GH_TOKEN` from `gh auth token -u <account>`. The token is read for each ticket call and never cached, because gh can rotate it. Every other gh call, such as PR polling and `board.mjs pr`, keeps gh's active account. If gh has no token for that account, the call fails with "gh has no <account> account; run gh auth login" and doesn't fall back to the active account. Board Settings keeps the account when it saves, and `board.mjs settings set tickets <json>` sets it.
- **The board stays the store.** Each card links one issue, which is created with the card and closed when the card is done. The card id `INT-n` stays the card key, thread file, notes file and commit ref. Backfill gives every open card an issue, including an internal wave's card whose stored ticket is its own id. Done cards keep their `INT-n` ticket, which shows unlinked.
- **The default doesn't change.** A new hub board stays Internal · INT. The owner chooses GitHub per site.

Considered: issues as the active account `lovek4d-ever`. The owner wanted the hub's issues opened as `lovek4d`, who owns the repo, so the account belongs to the board's ticket source and not to gh's global state.
