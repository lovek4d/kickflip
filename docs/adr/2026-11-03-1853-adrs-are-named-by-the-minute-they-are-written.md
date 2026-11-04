# ADRs are named by the minute they are written

The owner, on #86's thread and #92's grill: "ADRs should be timestamped in the title instead of numbered." Builders working in parallel each took the next free number, and on 11/03 two ADRs shared a number at least six times; land refused the second (#86) and its builder renumbered and relinked by hand.

- **The name is the minute.** An ADR is `docs/adr/YYYY-MM-DD-HHMM-<slug>.md`, the date and time to the minute it is written, as in `2026-11-03-1111-confirmations-are-the-browsers-own.md`. Two ADRs written in the same minute keep their own slugs; the owner: "Minutes colliding is also fine, that is, data."
- **Old ADRs were renamed once.** Each numbered ADR took the time its file was first committed (`git log --diff-filter=A --follow`), slug unchanged, and every link to it across the repo was rewritten, frontmatter status lines included. A status line names the new file without `.md`, since YAML holds no link.
- **References are titled links.** Prose and comments link an ADR with its title as the link text, as in [a build tap starts the build in the board server](0139-a-build-tap-starts-the-build-in-the-board-server.md), never by its old number.
- **Land refuses a numbered ADR.** `board.mjs land` (`board/worktree.mjs` `refuseNumberedAdr`) refuses a branch that adds `docs/adr/NNNN-<slug>.md`, naming the file and the name to use. It replaces #86's duplicate-number check, which has nothing left to catch.

Considered: the date alone (two builders landed ADRs minutes apart, so it could still collide); a compact stamp to the second (harder to read for no gain); keeping old numbers and timestamping only new ADRs (two naming schemes, and links by number would live on); the timestamp as a handle in prose (a title says what the decision is).
