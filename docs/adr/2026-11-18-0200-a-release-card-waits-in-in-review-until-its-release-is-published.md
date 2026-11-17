# A release card waits in In Review until its release is published

Card #1005 (T-662). Owner (11/17): "Release failed? Should release tasks wait in in review until it is confirmed and
then flag for user done?" #977 (release 0.19.0) went Done once its land passed and v0.19.0 was pushed. The tag's GitHub
release run then failed at its tests, so nothing reached npm, and nothing on the board watched the run.

Builds on [a repo's .kickflip/release replaces land's tag release](2026-11-16-0200-a-repos-kickflip-release-replaces-lands-tag-release.md)
and reuses the hold of [a card whose code landed stays in review while an owner step remains](2026-11-04-0158-a-card-whose-code-landed-stays-in-review-while-an-owner-step-remains.md).

## Decision

- **The land keeps the release on the card.** A land whose commit is a release (`chore(release): <version>`,
  board/release.mjs landRelease) closes the card as ever and stores `release` `{version, tag, pkg?, since, state}` on its
  item, state `publishing`, `pkg` the name in the commit's package.json (board/cards.mjs, from board/finish.mjs). It is
  stored whether the land shipped the tag or the Run release script box was off and the orchestrator pushes it by hand.
  The ticket stays open while it waits. Any other close of the card, the owner's Done or the orchestrator's `--done`,
  drops it.
- **A joined land reads the land's record.** A finish that joined the card's running land (board/finish.mjs
  finishCard) counts the card landed when that land recorded a new landed commit, not when the card reads finished: a
  release or owner-step card the join landed still reads In Review and isn't landed again, and a reopened card's build,
  its landed commit still its earlier land's, lands.
- **The card waits in In Review.** A landed card holding a release reads In Review, waiting on no PR or merge
  (board/domain.mjs workItem): `publishing v<X>` in orange with the working dot, `published <X>` in green with Next
  Tap Done and the Done check icon, or `release v<X> failed: <first failing test>` in red; each links the run
  (board/public/ui-cards.js releaseLine). It isn't finished for the cards blocked by it until the owner's Done.
- **The hub's poll watches it** (hub/release-watch.mjs, from hub/github.mjs checkGitHub, on the hub's cadence with no
  timer of its own). For each landed card whose release isn't published it reads the tag's push runs on the board's
  repo, `gh run list --branch v<X> --event push`, the newest run of each workflow. None yet, or one still going, is
  publishing. A failed one is failed, its first failing test read once per run from `gh run view --log-failed` (the
  first TAP `not ok` line and its `location:`). All passed, and `npm view <pkg>@<X>` shows it when there is a package,
  is published. gh and npm run as argv calls through shared/owner-check.mjs, with no shell.
- **Published asks for Done; failed wakes the orchestrator.** board/cards.mjs markRelease writes each change of state.
  Published posts a green line, "Published <X>: its release run passed and <pkg>@<X> is on npm. Tap Done.". Failed
  posts a red fault line and `release-failed {key, version, url, failure}`, which wakes the session to fix the cause
  and ship a patch release as a new card. A rerun of the failed run that passes publishes the card after all. The
  watch stops once the card is published.
- **A read that can't run** (gh or npm erroring) leaves the card as it is and is said in the check's failed list; the
  next check tries again.

## Considered

- **An owner step with a `run` and `npm` check.** A passing check closes the card at once, and the owner asked to
  confirm with Done; a check has no failed state to show the run's link or failing test.
- **One workflow named `release`.** The watch reads every workflow the tag's push started instead, so a repo whose
  publish workflow has another name is watched the same way.
