# A card derives its lane and its review next step from GitHub, never from a kept status

The lane comes from the PR's state (draft, ready, merged, closed) and its CI, plus the few states GitHub can't tell (planned, waiting, building, fixing, checking, held, dropped, done) and the owner's waits, placed by who acts next ([the lane follows who acts next, and a card waiting on the owner says Action needed](2026-10-29-1639-the-lane-follows-who-acts-next.md)). The same goes for a card waiting on its reviewers: its next step ("Waiting for PR reviewers", "Approved…") comes from GitHub's review decision.

`building` and `fixing` count as Claude working only while a builder record on that card is open. With none open, the PR and other state place the card as if that status were absent. `item set --pr` clears either status, and `builder done` clears it when it closes the card's last open builder record. `checking` still means the owning session is verifying finished work.

Hand-kept copies went stale twice. A Linear status shown on the card disagreed with the lane (round `site-v3`), and a hand-written "Waiting on Riley and Jamie" stayed after Riley approved (owner ask, 2026-10-23). So the board shows no Linear status, and the wave file's `next` is ignored while a card is in review.

Superseded in part by [a card stores its lane, and facts replace statuses](2026-11-07-1400-a-card-stores-its-lane-and-facts-replace-statuses.md): the lane is stored on the card and moved with a thread line; GitHub's changes move it through the board server's settle pass, and no status is kept.
