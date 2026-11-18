# Every PR message is the bar with no mention

A PR's Slack message went out in three shapes: the hub's link (the reviewer's mention, then T-342's risk-coloured bar), a session's hand-written bare link, and the older one-line text. The owner wanted "a single common PR message format" and, shown the candidates, answered "Keep today just drop the @ mention".

**The format is `prLink`'s bar with no text** (`board/store.mjs`, [a PR's Slack link is a bar coloured by the builder's risk](2026-11-14-0451-a-prs-slack-link-is-a-bar-coloured-by-the-builders-risk.md)): one attachment, the risk-coloured bar, the PR title linking the PR, then `+N/-M · K files · <risk> risk`, the sign-off inside the bar. The message's text is empty, so no `<@user>` anywhere; the attachment's fallback still names `repo#n`, the title and the size. This supersedes the mention in that ADR and the mention line of [review posts go into one day thread per board](2026-11-11-1600-review-posts-go-into-one-day-thread-per-board.md), which kept it so a thread reply would notify the reviewer. A reviewer reads the thread as the DM it is in.

**A session sends a link with `board.mjs slack link <owner/repo#n | PR URL | n> --to <reviewer>`** (`store.slackLink`), never by writing the message itself, so there is no prose rule for the format. It sends `prLink`'s message through the hub's Slack in the reviewer's day thread for today (opening it with the digest as `slack say` does), the size from GitHub and the risk from the card holding the PR (none without one), and records it in `pr-slack.json` as the board's own link: the approved and merged reactions follow it, and `review due` owes no second. A PR already sent to that reviewer is refused.

## Amended: the digest follows it too, with the ticket and the age

The digest never moved to the bar: its header and replies kept their mention, and a reply was plain text, “<@reviewer> <PR URL> · <title> (N days old)”. The owner asked whether that format should align to the standard, liked its days old, and chose take A of a mock-up ("It's a dm for now, no mention needed"; then the ticket above the title, the age italic on its own line).

- **Every digest reply is `prLink`'s bar**, the same message the first-day link and `slack link` send, and the digest's plain text form is gone. The header and the replies carry no mention.
- **The bar gains two lines**: the card's ticket id as the attachment's author line, small and linked to its issue (`ticketBadge`: Linear `TEAM-n`, GitHub `#n`; none for a card with no ticket), and, only from two days old, “_(N days old)_” on its own line below the stats, the age being the days since the PR's first link to that reviewer. The PR title stays the attachment's bold link.
- **A thread an earlier build opened with a header line** gets the bars alone, with no header of its own and so no count to keep current; the reply that once carried the header and a listing of the PRs is gone.
- **Reactions are unchanged**: approved and merged stay emoji reactions on each message. Showing status in the text is its own task.

The reactions were a state line in the bar for a time ([a PR's state is a line in its message, not reactions](2026-11-18-0000-a-prs-state-is-a-line-in-its-message-not-reactions.md)), and are reactions again, removed when their state stops holding ([a PR's state is reactions again, and the signature is picked](2026-11-18-0434-a-prs-state-is-reactions-again-and-the-signature-is-picked.md)).
