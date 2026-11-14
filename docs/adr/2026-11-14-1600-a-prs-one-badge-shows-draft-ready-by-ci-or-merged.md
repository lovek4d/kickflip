# A PR's one badge shows draft, ready by CI, or merged, with CI in its tooltip

Supersedes [only a PR waiting on a reviewer reads green](2026-11-04-1500-only-a-pr-waiting-on-a-reviewer-reads-green.md) and the badge look in [a merged card reopens and its PR badge shows the PR's state](2026-11-03-1843-a-merged-card-reopens-and-its-pr-badge-shows-the-prs-state.md).

A PR shows one badge (`prChip` in `board/public/ui-cards.js`); the separate CI chip is gone.

| PR | Badge |
| --- | --- |
| draft, whatever its CI | grey ● |
| ready, CI pending or not read yet | orange ● |
| ready, CI failing | red ✗ |
| ready, CI passed or no checks | green ✓ |
| merged | purple ✓ |
| closed unmerged | grey ✗ |

- The tooltip and aria-label read the state word then the CI words: "Ready · CI failing: 2 checks", "Ready · CI waiting: 3 of 4 checks", "Ready · CI passed", "Ready · no CI checks", "Ready · CI not read yet". Draft, merged and closed keep their last CI in the tooltip only.
- Changes requested goes by CI alone (owner); the reviewer chip carries it.
- A ready PR with no checks reads green, as `checksPassed` and auto-merge already treat it as passed.
- Purple joins the colour order after green: red > orange > blue > green > purple > grey (owner, #538). AGENTS.md and CONTEXT.md's Colour rule say so.
- Draft to ready needs no sync change: the hub's poll reads `isDraft` each check and the board draws it from `github-state.json`. #3980 most likely looked unchanged because a ready PR with pending CI used to be a grey check beside an orange draft dot.
