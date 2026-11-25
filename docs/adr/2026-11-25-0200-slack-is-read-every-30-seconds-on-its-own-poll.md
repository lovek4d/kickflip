# Slack is read every 30 seconds, on its own poll

Slack rode the GitHub poll: every minute while the owner was at the Mac and every 5 while away, which meant while the Mac sat idle, even with the owner on Slack on the phone, and every 5 or 15 when GitHub's points ran low. The owner: "could slack poll more often? would be nice to have a 30 second poll", then, on when: "definitely should not be an away case for slack, although it can be slow overnight during quiet hours".

## Decision

- **Its own poll.** The Slack poll (`hub/slack-poll.mjs`) is a job on the hub's 15 s clock every 2 ticks (`shared/polls.mjs` `slack-poll`). A run goes once `slackEvery` (`hub/schedule.mjs`) has passed since the last one began, give or take a tick: every 30 s here or away, every 5 minutes inside quiet hours (the hub's `quiet` setting), whatever GitHub's points. It is the first job to slow in quiet hours.
- **Every Slack read and post is its.** Each run files new @kickflip DMs, copies replies in Slack-filed tasks' threads, posts the replies owed, swaps their status reactions, and hears the reviewers' day threads (`review-send.mjs` `hearReviews`). The GitHub poll keeps GitHub, Linear and the review sends (digests, links, their reactions and edits), which follow PR state and so stay on its cadence.
- **One run at a time.** A run asked for while one runs joins it. A post records its ts only after Slack answers, so two runs at once could post the same reply twice.
- **The review sends and the hearing take turns** (`review-send.mjs` `inTurn`). They now run on different polls, and a link posted while its day thread was being read would be heard as the owner's message before its ts was recorded as the board's own.
- **It sends the queued pushes when it queued one** (the "can't read the review threads" fault) and pushes aren't held.

## Cheaper calls

At 30 s the per-poll cost counts, so two reads went:

- **The bot user is asked once per token.** Finding the workspace's kickflip bot user paged `users.list` (Tier 2) through the whole workspace each poll. The client now asks once and keeps the answer, and the Slack poll keeps one client while the saved token stays the same (`slack.mjs` `heldSlack`). A failed ask is asked again next run. A bot user added later is seen once the hub restarts or the token changes.
- **A Slack-filed task's thread is read only when it moved.** Each run reads one `conversations.history` per DM holding followed threads, across boards, and opens a thread with `conversations.replies` only when its `latest_reply` is past the newest reply read, as hearing the day threads already did. A quiet run costs one read per DM, not one per thread. A DM whose history can't be read fails each of its threads once on their cards, as a failed thread read does.

What a quiet run calls: `search.messages` once, twice with a bot user (Tier 2, 20 a minute); `conversations.history` once per DM with followed threads and once per reviewer DM with an open day thread, each paging 200 messages at a time from its oldest thread (Tier 3, 50 a minute). Replies, reactions and `chat.postMessage` come only when something moved. At 2 runs a minute that is 2 to 4 searches a minute, well inside Tier 2. These counts are per DM and per thread, not measured: no Slack runs on the host this was built on.

## Considered

- **Every Slack step at 30 s, the review sends too.** They act on PR state, which changes only on the GitHub poll, so 30 s would re-read the same state.
- **A Slack poll only while something listens.** The owner chose always, here or away; quiet hours are the only slow case.
- **`kickflip poll-now` running Slack too.** It stays the GitHub poll's: Slack is at most 30 s behind by day.

Amends [the hub checks every minute while you're here and every 5 when away](2026-11-04-0226-the-hub-checks-every-minute-while-youre-here-and-every-5-when-away.md), whose cadence no longer covers Slack, and [every poll is in one registry, and the hub runs on two clocks](2026-11-17-0330-every-poll-is-in-one-registry-and-the-hub-runs-on-two-clocks.md), which gains the Slack poll at 2 ticks. Moves the day threads' hearing of [reviewers ask the board in the day thread](2026-11-12-0000-reviewers-ask-the-board-in-the-day-thread.md) and the thread reads of [later replies in a Slack-filed task's thread land on the task](2026-11-15-1530-later-replies-in-a-slack-filed-tasks-thread-land-on-the-task.md) onto this poll.
