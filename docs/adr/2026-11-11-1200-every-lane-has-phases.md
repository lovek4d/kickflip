# Every lane has phases

A work card stores a `phase` beside its `lane`, and the store writes both in one move (the owner's model A, #382). Each lane has its own phases, shared by the page and the domain in `ui-enums.js` `PHASES`:

- **Todo**: new, grilling, prototyping, staging, ready. This is the old Todo `state`, renamed; "new" is a Todo card with no phase stored.
- **In Progress**: reading, building, testing, checking, landing, the builder phases. The card shows them only as its progress bar.
- **In Review**: draft, reviewers, merge, stale. "closing" is not a phase: a card whose PRs all ended is closed straight to Done.
- **Done**: merged, closed.

**Who writes it.** Todo's phase is written as before, by the session (`item set --phase`, `item add --phase`) and by the board (staging, grill and prototype rounds, a question on a ready card). `--phase` takes only ready, grilling or prototyping, and only on a Todo card; elsewhere the board sets it. `--state` is refused with a pointer to `--phase`. The store's own moves write the phase they land in: a build's start reads reading, a block or bump back to Todo reads ready (the card's notes already settled it), and a close reads merged when a PR merged or the card landed, closed otherwise. For In Progress and In Review the settle pass writes it: domain.mjs `phaseOf` reads the builder's last progress phase (checking while a build waits on its checks), and for In Review the card's wait: draft while CI or a draft PR is pending, reviewers while reviewers are asked, merge on an approved PR or a pushed branch waiting on the owner's Merge, stale for a stale card. An In Review card waiting on the owner for anything else has no phase. `movesOf` lists a card whose phase changed inside its lane, and `moveCard` writes that change with no thread line; only a lane change writes one.

**What the card shows.** Every lane but In Progress ends a card's last line with its phase word, after the other footer words and before the unread count, toned by who acts next: grey new, draft, stale and closed (nobody or the author); blue grilling and prototyping (a planner); orange staging, "pending review" (reviewers) and "pending merge" (merge); green ready; purple merged. A stale card shows "stale" once. A ready card that something blocks shows no ready word. The progress bar is In Progress's alone, so Todo's grill and prototype dashes are gone: a planner's round reads as grilling or prototyping.

**A lineup's steps.** A lineup's build-order groups were "wave phases"; they are now **wave steps**, `lineup create|set --step`, with `--phase` refused. The wave file keeps the stored key `phases`, so lineups made before this need no migration. A builder's phase keeps its name.

**Migration.** Server start runs `migratePhases` after `migrateStatuses`: each card's `state` moves to `phase`, and a Done card with no phase reads merged when a PR has `merged_at` (or it has no PRs but a build record), closed otherwise. It covers the wave files and the archive, one "cards' states became phases" line per changed file.

This amends [staging, then ready](2026-11-07-0700-staging-then-ready.md) (the footer's staging and ready words are now phase words) and [a card stores its lane, and facts replace statuses](2026-11-07-1400-a-card-stores-its-lane-and-facts-replace-statuses.md) (Todo's `state` is now its phase). Reopened cards are #401's.
