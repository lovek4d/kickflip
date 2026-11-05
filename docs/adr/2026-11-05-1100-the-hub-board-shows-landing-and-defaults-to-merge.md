# The hub board shows Landing and defaults to Merge

Card #245. #225's builder hid the PRs switch on the hub board because the hub board is a local board of its folder; the owner's answer was "Show the switch on the hub, starting off, so hub cards keep landing on main until you turn it on". #263 then made the switch the [Landing choice](2026-11-05-0200-landing-is-one-choice-draft-pr-ready-pr-or-merge.md).

Board settings now shows Landing on the hub board too. The manifest entry with `hub: true` carries the flag through `listBoards` and `boardRepo`; Board settings shows Landing on a local board only when `hub` is set. On the hub board `prs` is off unless `board.json` says `true`, so the choice reads Merge until the owner picks a PR mode; every other board keeps `prs` on unless `false`. `settingsOf` takes the board's `listBoards` entry for this; `readBoardSettings` and `saveBoardSettings` look it up.

Reviewers stay hidden on the hub board: the hub board still builds from its folder's local branch, so a PR mode does not yet open PRs there (`builderRepo` reads it as local). Making the hub board's builders branch from origin and open PRs is a separate change.

Considered:
- writing `prs: false` into the hub board's `board.json` once, which would leave a hub board created later on PRs;
- hiding Landing on every local board still, with the hub board the only exception by name in the client, which the `hub` flag in the repo answer replaces.
