# A land waits for your Merge, and a PRs switch picks PRs or landing on main

Superseded in part by [Landing is one choice](2026-11-05-0200-landing-is-one-choice-draft-pr-ready-pr-or-merge.md): Board settings shows `prs` off as the Landing choice Merge, not a PRs switch, and Auto-merge has one subtitle covering both PRs and builds waiting on the base branch.

This changes [Auto-merge is a board setting, off by default, and the owner merges from the card](2026-10-29-1752-auto-merge-is-a-board-setting-off-by-default.md) and [builders launch headless, check their notes and land on their own](2026-11-04-0306-builders-launch-headless-check-their-notes-and-land-on-their-own.md). Until now a card with no PR landed on main the moment its builder ran `done`, with Auto-merge reaching only PRs.

**PRs** is a board setting, `prs` in `board.json`, on unless set, shown only on a GitHub board that builds in its own clone. A local board, including one that names a `github` repo for links, never opens PRs; a plain-remote board without GitHub is unchanged.

- **On**: every card opens a PR. A PR with no reviewers on the board needs no approval: Merge shows (or Auto-merge merges) once CI is green and the merge state is clean, unless GitHub itself still asks for a review or changes. Skip the draft decides the draft as before.
- **Off**: no PR opens. Skip the draft and Reviewers are hidden, and reviewers drop out of the card view. Turning it off on a GitHub board is refused until Push main is granted, since each land then pushes main.

**The held land.** With Auto-merge off, a card with no PR is landed as far as its tests (`land --hold`): rebased, checked and tested, but not fast-forwarded. It waits in In Review with `merge_ready {branch, at}` on the item, Next "Verified: tap Merge to land it on main" and a Merge button. With Auto-merge on, `done` lands it as before. A held card keeps its Merge if Auto-merge is turned on later; the tap is the one way it lands.

**The tap.** Merge on a held card goes through the same owner-tap route as a PR card's Merge, which branches on whether the card has a PR. For a held card the server stamps `merge_ready.tapped`, so the card reads Merging…, and runs `board.mjs merge <key>` detached; no event wakes the session. That rebases onto main as it is now, reruns the tests, fast-forwards, and pushes main if Push main is on. On a GitHub board it first fetches origin's main into the shared clone and fast-forwards it there, so the land never pushes a main behind origin.

**When it doesn't land.** A rebase conflict or failing tests launch a headless lander for the card, whose `done` lands it with no second tap, since the tap is recorded. Any other refusal writes the reason into the thread and the Merge comes back.
