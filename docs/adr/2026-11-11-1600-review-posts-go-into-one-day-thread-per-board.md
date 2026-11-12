# Review posts go into one day thread per board

Status: accepted (#522, 11/11). Supersedes the "each PR gets its own fresh link" and thread-reply parts of [Slack sends hang off PRs and go out from the hub tick](2026-11-07-0300-slack-sends-hang-off-prs-and-go-out-from-the-hub-tick.md).

Superseded in part by [a day thread carries only each PR's link](2026-11-12-0044-a-day-thread-carries-only-each-prs-link.md): the push, comment and Updated bumps are gone.

## Context

Under #277, each PR's link went to each reviewer as a top-level DM, and its pushes, comments and Updated went in that link's own thread. A reviewer on a busy board got a stream of top-level messages. The owner pivoted #505 (11/09): "they always go into a digest thread. This avoids spamming reviewers and keeps the messages contained. One thread per board, use morning digest if present else start one." #505 split into this card (the posts go into the thread) and a second one (reviewers ask the board there).

Slack threads don't nest. Once a link is a reply in the day's thread, it can't carry its own thread, so the owner chose (11/10) brief bumps in the day's thread, labelled with the PR: "@forlefac showroom#435 updated for your comments" etc, "but keep it brief".

The owner's answers on #522 (11/11):
- With no digest yet that day, a header line opens the thread.
- A digest due once the thread is open goes in as one reply listing the PRs.
- Every reply opens with the reviewer's @mention. A thread reply in a DM notifies only the thread's followers, and a reviewer follows the thread only once they reply in it or are mentioned.
- Replies are brief, and a push gives only a count.
- "make sure every message for a given PR gets reacted to when approved or merged".

## Decision

**One thread per board, reviewer and Slack day.** A day is a calendar day in the Slack timezone, weekends included. The thread is recorded in `data/review-digests.json`, in the entry the digest already kept for that reviewer and date: `{date, reviewer, channel, ts, replies?}`. `ts` is the thread's opener. `replies` stays absent until the day's digest begins. `board/store.mjs openDayThread` posts the opener at most once, through `postOnce`.

**The digest opens the thread when it comes first, else a header line does.** On each poll, `hub/review-send.mjs` sends the owed digest before any link or bump. On a weekday morning the digest's header, "<board> digest: n PRs pending your review", opens the thread, followed by one reply per PR as before. Otherwise, the first link or bump that day opens the thread with "<board> reviews". A digest due once the thread is open posts one reply: the mention and the digest's header line, then one line per PR.

**Every reply reads "@reviewer repo#n <what>".** The mention is `<@slack_user>`, and `repo#n` links the PR. A reviewer no longer on the board goes unmentioned. The texts are:
- link: "ready for review: <PR title> (+N/-M, K files)"
- push: "<n> new commits"
- Updated: "updated: <what changed>"
- `pr comment` and `pr reply`: "comment: <words>"
- digest replies: the mention, then each item's text as before.

`pr-slack.json` stores each bump's text without the mention or the PR label. `review due` adds them per reviewer.

**Bumps go in the thread of the day they are sent.** A link posted into a day thread records that thread's `thread_ts`. A PR whose link went out yesterday gets today's bumps in today's thread, opening it if needed. A link with no `thread_ts` was posted top-level before this change and keeps its own thread for its bumps until its PR closes.

**Reactions go on every message about a PR.** Each link and each bump to a reviewer keeps its own `reactions`. `git_approved` once anyone approves, then `git_merged` on merge or `x` on a close, go on all of them. The header line and the digest replies get none.

## Rejected

- **The day's first link opens the thread.** Rejected by the owner: a header line opens it, so the thread reads the same whichever post comes first.
- **A late digest as a second header with its own replies.** Rejected: the thread is already open, and one reply keeps the digest brief.
- **Reacting on digest replies.** Rejected: a late digest reply names several PRs. The digest file also keeps only the current day, so yesterday's digest replies could not be reacted to anyway.
- **Moving older links into day threads.** Rejected: a posted message can't move threads. Links already posted keep their threads until their PR closes.
