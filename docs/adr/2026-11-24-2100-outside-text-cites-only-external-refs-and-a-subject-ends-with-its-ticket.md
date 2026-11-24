# Outside text cites only external refs, and a subject ends with its ticket

Status: accepted (#1193, 11/24). Amends [commits are Conventional and name their card in a Refs trailer](2026-11-11-1700-commits-are-conventional-and-name-their-card-in-a-refs-trailer.md), which kept every ref out of the subject and gave every card a `Refs:` trailer.

## Context

The owner (11/24): "PRs (and really any external text) should not reference internal issue IDs when referring to previous work. if external is available use that along with the relevant PR, else just reference the relevant PR or commit if no PR exists."

Task keys (T-N) reached GitHub through agent prose in PR bodies, commit messages and comments, and word for word through a ticket made from a card's notes. Nothing mapped a key to what an outside reader can open.

The owner's answers on #1193:
- Work with no ticket, PR or commit: "Don't cite it". It never left the board, so it stays internal.
- The ticket goes in the subject, as `feat(board): … (#1128)`, and the `Refs:` trailer stays too, for the task's ticket and related tickets, only when they are external. A PR's title follows the same rule, since a PR's squash subject is its title.

## Decision

**A task's external form** (`board/cites.mjs externalRef`): its ticket with its PR ("#12, PR #15"), else its PR, else its landed commit ("commit abc1234"), else nothing. `boardTasks` in `board/cards.mjs` reads every card, open and archived, with its internal key, ticket, PRs and landed commit.

**Outside text refuses a task key.** `citeFault` finds a token shaped like a card key that a card on the board holds, and names what to cite instead or says to leave it out. A key no card holds, such as a quoted "T-123", passes. It runs on:
- `pr comment` and `pr reply` (`--body`), `review post` (its file), `slack answer` and `slack say` (`--text`), and `reply` to an event that came from Slack;
- `builder done` and `builder verified`: `--title` and `--body-file`;
- the finish that opens or updates a PR: its title and body (the closing `--text` when there is no kept body);
- the land's squash message, subject and detail together, refused like an off-standard subject.

**A ticket made from notes renders them.** Notes are the board's own, so `assignTicket` writes each task key in them as its external form, and one that never left the board as "an earlier task", rather than refusing.

**A subject ends with its ticket.** `withTicket` adds " (<ticket>)" to the land's squash subject, a new PR's title and the PR's squash subject at merge, when the card has a ticket and the subject doesn't end so already. The 100-character cap counts the suffix, and the brief gives the builder the cap less the suffix. A release subject reads `chore(release): X.Y.Z (#N)`, which `releaseVersion` still reads.

**Refs carries external refs only.** `commitRefs` gives the land and the merge the card's ticket and each related card's (either direction) that has one. A card with no ticket lands with no `Refs:` line, and the brief tells its builder to write none.

## Consequences

- A builder's commit body or PR body that cites T-N is refused at done or at land; the refusal names the ticket, PR or commit to cite, so the builder rewords and runs done again.
- Older commits and tickets keep their T-N cites; nothing is rewritten.
- The PR body's alignment with the commit body is its own task.
- An external PR added with `item set --pr` and merged gets the ticket suffix on its own title too.
