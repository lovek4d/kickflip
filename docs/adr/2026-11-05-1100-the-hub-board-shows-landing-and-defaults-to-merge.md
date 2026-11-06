# The hub board shows Landing and defaults to Merge

Card #245. #225's builder hid the PRs switch on the hub board because the hub board is a local board of its folder; the owner's answer was "Show the switch on the hub, starting off, so hub cards keep landing on main until you turn it on". #263 then made the switch the [Landing choice](2026-11-05-0200-landing-is-one-choice-draft-pr-ready-pr-or-merge.md).

Board settings now shows Landing on the hub board too. The manifest entry with `hub: true` carries the flag through `listBoards` and `boardRepo`; Board settings shows Landing on a local board only when `hub` is set. On the hub board `prs` is off unless `board.json` says `true`, so the choice reads Merge until the owner picks a PR mode; every other board keeps `prs` on unless `false`. `settingsOf` takes the board's `listBoards` entry for this; `readBoardSettings` and `saveBoardSettings` look it up.

On Draft PR or Ready PR the hub board opens PRs like any GitHub board (the owner, 11/06: "Build it in #245"). `opensPRs` counts the hub board as well as a board in its shared clone, so Reviewers show there while Landing is a PR mode. `builderRepo` reads the hub board as remote while it opens PRs: its builders still work in worktrees of its folder, but each branches from origin's base, fetched first, so the PR holds only the card's commits and none that the folder's main has and origin lacks. The finish then takes `sendForReview`: it pushes the branch and opens a draft PR, which the hub's GitHub check marks ready once CI passes on Ready PR. On Merge nothing changes: builders branch from the folder's local base and a finish lands there, pushing it only with Push main granted. Turning the hub board to Merge needs no Push main, since Merge is how it has always landed.

`builderRepo` reads the board's Landing when it is called, so a card started on one Landing and finished on the other takes the finish's: a card branched from the folder's main and finished on a PR mode has its PR also count the folder's commits beyond origin's base.

Considered for the PR step:
- a separate shared clone for the hub board, as other GitHub boards have, which would move the hub board's builds out of its folder on Merge too.

Considered:
- writing `prs: false` into the hub board's `board.json` once, which would leave a hub board created later on PRs;
- hiding Landing on every local board still, with the hub board the only exception by name in the client, which the `hub` flag in the repo answer replaces.
