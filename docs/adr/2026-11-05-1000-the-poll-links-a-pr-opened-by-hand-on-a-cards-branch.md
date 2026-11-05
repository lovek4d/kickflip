# The poll links a PR opened by hand on a card's branch

From #180's skill audit (row 5), built as #230. SKILL.md told the session to notice a PR opened by hand and run `item set <key> --pr <n> --clear-status`; the hub's poll now does the noticing.

- **What counts.** An open PR in the card's repo whose head branch is the card id (`board/worktree.mjs` `makeWorktree` names the branch the card id, and `finish.mjs` `sendForReview` opens the draft from it), in that same repo (`isCrossRepository: false`: a fork's branch of the same name isn't the card's). Any author with push access counts. Open PRs only: a merged or closed PR on a reused branch name may belong to an earlier card.
- **Which cards.** Not done, merged or dropped, and holding no PR in that repo yet (`shared/card-prs.mjs` `cardPRs`).
- **Where it's found.** The one GraphQL query `hub/pr-report.mjs` `fetchPRs` already sends gains an alias per board repo (`board.github`, else each wave's `repo`) listing the newest 100 open PRs' `number headRefName isCrossRepository`. The query now runs whenever a board has a GitHub repo, not only when a card holds a PR: one point a check.
- **What linking does** (`hub/github.mjs` `linkHandPRs`). It calls `store.mjs` `setItem(dir, card, { pr })`, as `item set --pr` does and as the finish does, so `addPRs` is idempotent against a finish opening the same PR at once; `--pr`'s own clearing of `building` and `fixing` applies and nothing more. It writes the thread line "Found PR #12 on branch GH-230." and adds the PR to the board's `github-change` event with the new change kind `linked`, so the session handles CI that failed before the link. The PR is polled from the next check; with no `gh_since` its earlier comments become thread lines then.
- **The status is left alone** (owner on #230, gh230-status-2: `pr-only`). A found PR isn't a ready PR (it is often a draft), so `--clear-status` is not passed: `checking`, `held` and `waiting` stay, and the lane follows the PR as it does for any card.

Considered:
- clearing any unfinished status as `--clear-status` did (the first pick): it would end a check in progress, a hold and a wait for reasons the PR doesn't end;
- matching merged or closed PRs too: a reused branch name may belong to an earlier card;
- matching by the PR's title or body: the branch is the card's own, exact name.
