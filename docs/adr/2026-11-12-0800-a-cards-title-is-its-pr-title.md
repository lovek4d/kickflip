# A card's title is its PR title

Status: accepted (#567, 11/11).

## Context

Since [commits are Conventional](2026-11-11-1700-commits-are-conventional-and-name-their-card-in-a-refs-trailer.md), commit subjects and new PR titles are `<type>(<scope>): <summary>`, but card titles stayed free text. Some cards were titled Conventionally at sorting and older ones read as sentences, so the board mixed both. The owner asked for every title in the Git convention, with a question about the board titled `ask(board): …?` (11/11). The grill also found that `board.mjs merge` squashed with the PR's title unchecked, so a hand-retitled, older or attached PR could land a non-Conventional subject.

The owner chose (11/11, 22:32): every card title is Conventional, enforced by the CLI; the card title is the PR title; merge checks the PR title; and the orchestrator must retitle a card, an ask included, before it goes into In Progress. Existing open cards are not retitled in bulk.

## Decision

**A card's title is a Conventional subject or an ask.** `cardTitleFault` in `board/commit-message.mjs` accepts a subject `subjectFault` accepts, with every commit type and the 72-character cap, or `ask(<scope>): <question>?`, which ends with "?" and has the same cap. `item add`, `item set --title`, `reply --title` and `slack task --title` refuse any other title and write nothing. A New card keeps the first line of the owner's message as its title until the orchestrator retitles it. The board's own cards, an architecture review's audit and its findings, keep the titles the board gives them.

**A card goes into In Progress only with a title its PR can take.** A build's `builder start`, a Build tap and the pull refuse a card whose title `subjectFault` faults, an `ask(…)` title included, since an ask is answered, not built. The refusal names `item set <key> --title`. `pullOf` lists those cards as `retitle` and leaves them out of `pullable`. The board server posts one build-refused line on each, which the Todo card shows, and doesn't post it again while it is the card's newest line.

**The PR takes the card's title.** On a GitHub board a finish that opens a PR titles it with the builder's `--title`, else with the card's title, in place of the branch's first commit subject.

**Merge checks every PR's title before it merges any.** `board.mjs merge` and the Merge tap view each open PR first and refuse when a title isn't Conventional, naming `gh pr edit <n> --title`. Nothing is merged, so a card with several PRs never merges only some of them.

## Consequences

- A ready card with an old sentence title waits in Todo with the refusal on it until the orchestrator retitles it.
- A card title over 72 characters is refused, so long titles are shortened to fit, as commit subjects are.
- An external PR attached with `item set --pr` now merges only with a Conventional title.
