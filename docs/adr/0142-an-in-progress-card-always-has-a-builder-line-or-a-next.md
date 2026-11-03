# An In Progress card always has a builder line or a Next

A card's line under its title is one place: the builder line while a builder record is open ([0137](0137-a-builder-status-line-is-a-phase-and-a-short-detail.md), "Starting", or "Waiting for orchestrator" from [0139](0139-a-build-tap-starts-the-build-in-the-board-server.md)), else its Next (`board/public/ui-cards.js` `workLines`). An In Progress work card with no open builder now always has a Next.

Lines that already fill the place count as one: "Orchestrator review" on a checking card, Working while a session works on a message in its thread, and the Next a PR or the owner's wait gives it, such as "Waiting for PR reviewers", "Fix the failing CI", the owner's action or Tap Done (`board/domain.mjs` `REVIEW_NEXT`, `placeOwnerWait`).

- **The CLI refuses the write that would leave one with neither.** `store.mjs` checks with `domain.mjs` `owesNext`, from the wave entry and builder records alone: a card started as [0138](0138-a-card-moves-to-in-progress-only-once-building-starts.md) reads it, with no open record, no `next`, no PR or pushed branch, not held, and not checking or finished.
  - `builder done` on a card's last open record refuses, naming `--next`, which it now takes and sets. `item set --status checking` and `land` close the records themselves, so a builder handing back that way needn't pass one.
  - `item set` refuses any write that turns a card owing nothing into one owing a Next, such as `--clear-next`, `--next ""`, `--clear-status` off checking, or `--unheld`. `--status building` and `fixing` are left alone: `builder start` sets them just before it writes the record.
- **Paths that can't refuse show a gap.** The SubagentStop hook and a board's close stop records whatever the card is left with, and the owner's hold ending, a card reopened by the owner's message, or a draft PR with nothing else to say are board-side. There `buildBoard` gives the card the Next "none set yet" (`NO_NEXT`), so the card reads "Next: none set yet" rather than nothing.

The owner asked on #77: "the building status and the next should take up the same element. And it should either have a build status or a next status as long as it is in the in-progress lane." And earlier: "I would like any case in which it is in progress and there's nothing building for there to be a required next item."

Considered:
- refusing `item set --status building` with no Next and no record: `builder start` writes that status a moment before its record, so every build start would be refused;
- checking the card's PR state in the CLI: it needs GitHub, and the PR's own next covers most of those cards; the gap covers the rest;
- leaving the line empty and nudging the session instead: the owner asked for a Next to always be there.
