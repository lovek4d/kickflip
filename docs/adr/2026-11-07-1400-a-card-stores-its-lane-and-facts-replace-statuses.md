# A card stores its lane, and facts replace statuses

A card has no `status` any more. It stores its **lane**, `todo`, `progress`, `review` or `done`, with `lane_at`, and one writer moves it: store.mjs `placeIn`, called by `moveCard(site, key, to, why)` and by `item set`'s own moves. Each move of a stored lane writes a quiet thread line, kind `move`: "Moved to In Review: PR #12 opened". A card's first placement writes none. That covers every card the migration places, since `item add` stores `todo` on each new card (#340, the owner's model A).

What `status` used to hold is now a set of facts beside the lane:

- **building, fixing**: gone. An open build record already says a build runs; a rebase or CI-fix run is told apart by its record's kind.
- **checking**: the newest build record's `handed_back` time (domain.mjs `handedBackAt`). It is written when `builder done` closes a record that still has unverified calls, and when a stopped lander is sent back (`relaunchLander`). A handover (`--pr`, `--pushed`, merge-ready) or a close takes it off. `landable` and `builder verified` read it.
- **held**: the `held` field, as before; the legacy held status is gone.
- **merged**: each PR in `item.prs` gets its own `merged_at`. The card moves to Done.
- **done, dropped**: one close, `item set --done --text "<why>"`. The text says whether the work merged, was given up or was superseded. A close always moves the card's ticket to Done. Work left open goes on a follow-up card. A Done card whose PRs all closed unmerged never landed, so a message doesn't reopen it; any other Done card reopens on the owner's message or question.
- **closed_at, reopened_at**: a move to Done writes `closed_at`, and a move out of Done writes `reopened_at`, which the next close clears. A card is finished for its dependents while it is in Done or reopened since (store.mjs `closed`).

`item set --status` and `--clear-status` are refused, naming `--done --text`. Todo's `state` (grilling, prototyping, staging, ready) stays as it is. The owner wants it called "todo phase", which is left to a card of its own.

**Who moves a card.** Moves the store makes itself are written at once:
- a build's start → In Progress, "a build started";
- a handover → In Review: a PR, a pushed branch, or a verified build held for the Merge;
- a block → Todo;
- a close → Done.

Everything else changes underneath the store: GitHub (a hand merge or close, red CI on a ready PR, a reopen), owner messages and questions, holds, and waits on the owner. For those, the board server runs a settle pass after each change (server.mjs `settleLanes`). It builds the board, and domain.mjs `movesOf` lists each card whose placement differs from its stored lane, with why; `moveCard` writes each move. The placement rule stays in one domain chain: laneOf → workItem → placeOwnerWait → buildBoard. So a started card that waits only on the owner moves to In Review, and moves back once the owner acts. A held card that had started settles back to Todo. A card shown Stale is stored as `review`.

The settle pass never moves a card into Done, and never moves a stored Done card unless it reopened. Closes are explicit:
- the hub's poll closes a card once all its PRs have merged or closed, marking each merged one, with "Merged PR #n." or "Closed: #n closed unmerged.";
- the repo fetch closes a pushed branch's card;
- land, `builder done`'s finish, Merge, the owner's Done, an ask's move and `--done` close their cards.

So a merged PR can't pull a reopened card back to Done.

**Migration.** The board server's start-up pass `migrateStatuses` replaces `dropPlannedStatus`. It covers the wave files and `done-archive.json`:
- merged, done and dropped → lane `done`, with `lane_at` and `closed_at` set to the status time (or the merge time); merged also writes `merged_at` on each PR;
- held → `held: true`;
- checking → `handed_back` on the newest build record;
- every other status is dropped, and the first settle places the card silently.

**What went with it.** These are removed:
- `ITEM_STATUSES`, `clearBuildingStatus`, `LEAVES_TODO`, `HANDED_BACK` and `UNSTARTED`;
- every inline list of finished statuses: store.mjs `FINISHED`, hub/boards.mjs, try.mjs and github.mjs;
- `droppedCard`;
- the finished wave's "N dropped" note;
- `ensureWorktree`, which only `--status building` used. `builder start` makes its own worktree.

**Trade-off.** A stored lane can drift if a write path forgets to move it. The settle pass after each change bounds that drift, since it re-places every card from the facts.

This amends:
- [a card derives its lane from GitHub](2026-10-29-1639-a-card-derives-its-lane-from-github.md), superseded: the lane is stored, and GitHub moves it through the settle pass;
- [the lane follows who acts next](2026-10-29-1639-the-lane-follows-who-acts-next.md), [a started card never returns to Todo](2026-10-29-1639-a-started-card-never-returns-to-todo.md), [any work on a card starts it](2026-11-02-2000-any-work-on-a-card-starts-it.md) and [a card moves to In Progress only once building starts](2026-11-03-0202-a-card-moves-to-in-progress-only-once-building-starts.md): a placed card has started once its stored lane isn't Todo;
- [an In Progress card always has a builder line or a Next](2026-11-03-0237-an-in-progress-card-always-has-a-builder-line-or-a-next.md), [finishing a build is one step](2026-11-04-1611-finishing-a-build-is-one-step.md), [a builder records its judgment calls](2026-11-03-0514-a-builder-records-its-judgment-calls-and-the-session-verifies-them.md) and [a lander the pause stopped starts again](2026-11-04-2230-a-lander-the-pause-stopped-starts-again.md): a hand-back is `handed_back` on the record, not `--status checking`;
- [a message or question on a done card reopens it](2026-11-02-1952-a-message-or-question-on-a-done-card-reopens-it.md) and [a merged card reopens](2026-11-03-1843-a-merged-card-reopens-and-its-pr-badge-shows-the-prs-state.md): the reopen is stored as a move with `reopened_at`;
- [a card whose code landed stays in In Review while an owner step remains](2026-11-04-0158-a-card-whose-code-landed-stays-in-review-while-an-owner-step-remains.md): the card is stored in Done and shown in In Review;
- [kickflip reaches Linear](2026-11-01-1436-kickflip-reaches-linear-with-a-key-on-the-mac.md): a ticket follows the card's moves, and a close moves it to Done whatever the reason;
- [no waiting status](2026-11-07-0300-no-waiting-status-no-watchers-md-no-checked-command.md): there are no statuses left.
