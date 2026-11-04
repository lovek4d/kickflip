# The board server removes reviewers itself; adding stays with the session

This extends [every owner tap the server can apply draws at once](2026-11-03-0500-every-owner-tap-the-server-can-apply-draws-at-once.md) to Board settings' Reviewers. Removing someone needs nothing outside the board, so the server writes it at once. Adding someone needs their Slack user, DM channel and GitHub login, and the server can't look those up: it has no Slack token, and `hub/slack.mjs` holds only the owner's identity. So an add stays with the session.

- **One Save, split by the server.** Save still sends `reviewers {add: [name], remove: [name]}` through `POST /_claude/events`. The server runs `store.mjs removeReviewers` for the names to remove, the same write `board.mjs reviewers remove` makes. That write updates `board.json` and copies the list to each wave file with an unfinished card. The server then appends `reviewers-removed {remove}` and, when names are left to add, `reviewers {add}`. It answers `{id, board}` as for any tap, and the page redraws its list from `board.reviewers`.
- **The session is told but does nothing.** A `reviewers-removed` event is a record and the session takes no action on it (owner, gh104-told). Like any event it wakes the watcher, which prints its default line. Only `reviewers {add}` asks the session for work: find the person, run `reviewers add --file`, send them every PR already in review, and reply. A remove-only Save records no `reviewers` event, so the page shows no "Waiting for Claude…" line, and its status reads "Saved". An add keeps "Sent. Claude updates the list and replies below."
- **Shape checks only.** The write re-checks the whole remaining list with `checkReviewers`, so a GitHub login gets the CLI's shape check and nothing more. Nothing asks GitHub whether the login exists (owner, gh104-valid). An unknown name, a malformed stored reviewer, or `add`/`remove` that isn't a list of names gets 400 with the reason and nothing is recorded. The page shows that reason under Save and keeps what was staged.
- **One board.json writer at a time.** Reviewer writes go through `store.mjs writeBoardJSON`, the queue that rule and setting writes already use. The server's own writes to `board.json` can't interleave.
- **SKILL.md** drops remove from the `reviewers` event rule and keeps add and the send-PRs step (owner, gh104-skill).

The owner's answers on #104 (11/04): gh104-which "remove-only", gh104-told "record-event", gh104-valid "shape-only", gh104-skill "trim". The rest waits on #193, which comes after #35's Slack token. There, a reviewer's Slack and GitHub ids are picked from lists the server fetches, the server sends the Slack links, and SKILL.md drops the add and send-PRs steps too.

Considered:
- the server writing adds too, with the name alone: the reviewer would have no Slack user or DM, so no link or digest could reach them;
- a separate `POST /api/reviewers` like `/api/settings`: one Save carries both lists, and the events route already answers with the board the page redraws from;
- a single `reviewers {add, removed}` event: a remove-only Save would then read as something waiting on Claude, both on the page and to the session;
- asking GitHub whether a login exists: it needs a network call per save. The CLI doesn't make one either.
