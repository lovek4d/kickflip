# Slack sends hang off PRs and go out from the hub tick

Status: accepted (#277, 11/07)

## Context

#35 gave the hub a Slack user token and had each poll send what `review due` owed: one link per card, `git_merged` on a merged card's links, and the weekday digest. The owner asked for the links, reactions and digest to go out mechanically, every send recorded and retried. Reading that code turned up four ways a send went missing or went twice:

1. The digest was recorded per board. The first reviewer's send set `last_date`, so a reviewer whose send failed got nothing that day.
2. A digest that failed partway posted again whole, because nothing was recorded until the last reply.
3. A link whose record failed after Slack took the post was posted again on the next poll.
4. `review updated` stopped at the first reviewer whose send failed.

The owner answered the open questions on #277 (11/05 to 11/06):
- A card holds 1:m PRs, and separately each PR has 1:m reviewer DMs. Slack messages hang off PRs, not cards.
- Each PR gets its own fresh link. Pushes, the orchestrator's comments and Updated go in that link's thread. Every reviewer of a PR gets the same thread and reactions.
- Reactions: `git_approved` once anyone approves, even someone else, so the PR no longer needs attention. Then `git_merged` on merge, or `x` on a close.
- The link message is the PR title, its link, then "+N/-M, K files", one per line. It uses plain lines and links only.
- No Slack message carries a Claude or robot marker: they go out through the Slack MCP as the owner and already read "sent by Claude". A marker comes with the Slack API token (#35).
- Failures go to the hub log only, as before, and a stuck send keeps retrying every poll.
- A digest missed by 17:00 is skipped that day.
- builder done asks for the Updated decision.
- A refused token sends one push while any board has reviewers.

## Decision

**Each board's `data/pr-slack.json` holds the Slack messages of every PR, keyed `owner/repo#n`.** Each PR has `head` (the commit its thread last told about), `links: {<reviewer>: {channel, ts, reactions}}`, and `replies: [{id, text, to: {<reviewer>: {ts}}}]`. A card reaches its PRs through `cardPRs`, and a PR reaches its messages through this file. Nothing about Slack is stored on the card any more. A card's age, its reviewer chips, the Stale lane and the hub's Slack link row read each reviewer's earliest posted link across the card's PRs (`board/review.mjs prLinks`). The older per-card `review_link_ts`, `review_sent` and slack-bridge topics are still read for display only. No board had reviewers when this landed, so no sent record needed moving.

**Every message is posted at most once (`board/store.mjs postOnce`).** It is marked `posting_at` before the post and given its `ts` after. A post that throws is unmarked and goes again next poll. A post whose `ts` can't be recorded stays marked and is never posted again, and the hub log says so. Each reviewer's send is attempted on its own, so one failure doesn't stop the others.

**The hub tick does all the sending (`hub/review-send.mjs`).** On each poll, per board:
1. `queuePushes` adds a "New push to #n" reply, with the new commits' subjects, on each PR whose head moved.
2. `review due` lists the owed links, replies and reactions, and the digest.
3. The hub posts each one and records it.

The poll's GraphQL query also reads each PR's title, additions, deletions, changedFiles, `latestReviews` and last 20 commits. These go in `github-state.json` for the link text, the push replies and `git_approved`.

**Updated and comments are queued, not sent inline.**
- `review updated` queues "Updated: …" in the thread of every posted link on the card's PRs, with no filter on approval.
- `builder done` refuses on a card whose PR link a reviewer has until it gets `--updated "<what changed>"` or `--updated none`. It queues the reply only once done has gone through, so a done that is run again doesn't queue it twice.
- `pr comment` and `pr reply` queue "Comment on #n: <words>" in that PR's threads.

**The digest is per reviewer, per day.** `data/review-digests.json` holds `{digests: [{date, reviewer, channel, ts, replies: [{pr, text, ts}]}]}` for the current day only. A reviewer is owed the digest until the header and every reply carry a `ts`, on weekdays from 09:00 to 17:00 in the Slack timezone. A digest already begun keeps the PRs it began with and sends only its missing replies. There is one digest item per PR.

**A refused token pushes once.** While any board has reviewers, the hub sends one `fault` push. It records `refusal_pushed_at` on `secrets.json`'s `slack` entry and clears it when Slack takes the token again.

**The CLI writers `review sent`, `review react` and `review digest sent` are gone.** The hub records in code, and no session sends to Slack. `review due` and `review digest` stay as read-only views.

## Rejected

- **Keeping the record on the card** (`item.review_link_ts`). Rejected: a card with two PRs had one link holding both URLs, so a push to one PR couldn't be told apart from a push to the other, and a PR moved between cards would lose its thread.
- **Sending Updated inline from the command.** Rejected: a Slack failure lost the reply, and a failed reviewer stopped the rest. Queued replies get the same retry and record as every other send.
- **Filtering Updated to reviewers who haven't approved.** Rejected: the owner wants one shared thread per PR.
- **Showing failed sends on the card or the hub page.** Rejected: the owner chose the hub log only, since sending will change when Slack moves to an API key.
