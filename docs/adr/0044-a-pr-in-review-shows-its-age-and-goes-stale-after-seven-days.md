---
status: superseded in part by ADR-0104 and ADR-0006
---

# A PR in review shows its age, and goes Stale after seven days

Superseded in part by [0104](0104-kickflip-owns-the-reviewer-record.md): review age, Stale and weekday digests use kickflip’s item reviewer record; the session sends through Claude’s Slack connector.

Superseded in part by [0006](0006-pushes-only-when-something-waits-on-the-owner.md): a card going Stale and a merge push nothing; the Stale lane and the board show them. The ages, the Stale lane and the reviewer replies below still hold.

A PR waiting on its reviewers shows how long it has waited. After seven days it parks in its own lane and the owner is told once. Reviewers hear about a change only when it matters to them, and merges reach the owner as one summary per tick.

- **Age on the reviewer chip.** Once a reviewer has had the link for a day without approving, their chip shows the age, such as "J ● 2d" (`board/public/ui-cards.js`).
- **Age in the reviewer digest.** A PR whose link went out more than 48 hours ago reads "<link> (N days old)" in the reviewers' Slack digest (slack-bridge).
- **Kept conflict-free.** When GitHub reads a PR in review as conflicting, monitor has its builder rebase it onto `main` and rechecks CI.
- **Stale after seven days.** A card whose first review link went out more than seven days ago moves from In Review to the Stale lane (`STALE_AFTER` in `board/domain.mjs`). A card Claude is checking never goes Stale. The lane shows only when it holds a card. The owner gets one queued push when a card lands there, and `/_claude/needs` counts Stale as review ([0010](0010-sites-report-what-waits-through-claude-needs.md)).
- **Reviewers hear about behavior changes only.** A push that changes the PR's behavior after the link went out gets one "Updated: <what changed>" reply under each reviewer's link message, for reviewers who haven't approved. Pushes that change only comments, names, docs or tests stay silent. A push that addresses a reviewer's comment gets a reply in that comment's own thread, on GitHub or in Slack, naming the commit (monitor, slack-bridge).
- **One merge summary per tick.** A tick that merges something queues one push: what merged, then this board's PRs still open and in draft, such as "app#3145 merged · 4 open, 1 draft" or "3 PRs merged · 4 open, 1 draft". The counts cover the board's own PRs, not every PR the owner has open in the repo.

The owner chose these in:
- `site-v6` v6-review-age, option A, with the note: "Pr link messages should also include '<link> (x days old)' after 48hrs. Also these should be kept conflict free, and if over 7 days park it and nudge me (stale lane)";
- `site-v13` v13-review-changes, option A, with the note: "Also reply in thread if you push something that addresses a comment they made";
- `site-v4` v4-merge-push, option A, with the note asking for the open and draft counts;
- `site-v5` v5-merge-scope, option A, this board's PRs.

Considered:
- the age chip plus a nudge leading the reviewer's digest after two working days, or chips without an age (`site-v6` v6-review-age B, C);
- an update reply for every push after the link, or none (`site-v13` v13-review-changes B, C);
- no merge push, leaving merges to the board and the morning push (`site-v4` v4-merge-push B);
- counting every open PR the owner authored in the repo (`site-v5` v5-merge-scope B).
