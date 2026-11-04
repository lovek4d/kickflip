# A board can skip the draft, and a draft waits in In Review on the owner

Card #205, a follow-up from #195. Owner, 11/04: "there should be a setting for whether to skip the draft stage or not. And if it is enabled, then it automatically marks a draft as ready and pushes it into the review lane." And on #195's PR boards: "the draft should go to In review, but be Action needed for me with the next item. In progress is strictly things that are being implemented."

On a GitHub board, finishing a build opens a draft PR ([finishing a build is one step](2026-11-04-1611-finishing-a-build-is-one-step.md)). What happens to that draft is now a board setting, `skip_draft` in `board.json`, off when absent.

- **Off (the default).** A card's open draft PR sits in In Review from the moment it opens, whatever its CI, with Action needed "Review draft PR #n", which links to the PR (`board/domain.mjs` waits on `ready`). Red or pending CI still shows on the card's PR badge. A builder fixing the draft takes the card back to In Progress while it runs. The owner's Ready on GitHub moves it on to the reviewers. Before this, a draft whose CI was pending or red sat in In Progress, and only a green one asked for "Tap Ready on GitHub".
- **On.** The hub's GitHub check (`hub/github.mjs`) marks each card's open draft ready for review (`gh pr ready`) once its CI passes, and writes "CI passed, so PR #n is marked ready for review." on the card. Passing means every check run completed as a success, neutral or skip and every status context reads success; a PR with no checks has nothing to fail, so it is marked at once. Until then the card waits in In Review with no Action needed and the Next "Marked ready for review once CI passes"; red CI sends it to In Progress with "Fix the failing CI", as red CI on a ready PR does. Once ready, it waits on the reviewers as any ready PR does, and the board owes them their Slack links.
- **With Auto-merge.** Skip the draft and Auto-merge together let a builder's PR merge once reviewers approve it, without the owner seeing it. That is allowed (gh205-auto-merge: allow-warn), and Board settings says so under the switch.
- **Where it is set.** Board settings shows "Skip the draft" in its Auto section, on a board whose repo is on GitHub only. It saves at once with no confirmation, through `POST api/settings`, which appends `settings {skip_draft}`. `board.mjs settings set skip-draft on|off` sets it too, and each wake prints `setting skip-draft on|off`.

The hub marks the draft, not the session's GitHub tick: it already reads every PR each check and records merges on cards, so a green draft is marked within a check with no session awake. It applies to every open draft on the board's cards, read from `board.json` each check, so turning the setting off stops it at the next check.

Owner answers (11/04): gh205-when-ready: after-green, "Open it as a draft and mark it ready once CI passes", so reviewers are never pinged on a broken PR; gh205-draft-lane: review-always, "In review with 'Review draft PR #n' at once; red CI still shows on the card".

Considered:
- opening the PR ready at once (no `--draft`), which pings reviewers while CI is still running or red;
- requiring Auto-merge off while Skip the draft is on, which the owner turned down for a note under the switch;
- leaving a red draft in In Progress with the setting off, which the owner turned down: In Progress is only for work being implemented.

A green "ready" mark on In Review cards that wait only on reviewers is prototype follow-up #222.
