# A card title may run to 100 characters

Amends the 72-character cap in [commits are Conventional and name their card in a Refs trailer](2026-11-11-1700-commits-are-conventional-and-name-their-card-in-a-refs-trailer.md) and [a card's title is its PR title](2026-11-12-0800-a-cards-title-is-its-pr-title.md).

Card #595, the owner's ask: "Bump title character limit to 100".

- **One constant moves.** `SUBJECT_MAX` (board/commit-message.mjs) is 100, so a card's title, `builder start`'s refusal, a PR title and land's squash-subject check all allow 100 characters.
- **The detail still wraps at 72.** Only the subject's cap moved; the body lines of a commit message keep their 72-column wrap.
