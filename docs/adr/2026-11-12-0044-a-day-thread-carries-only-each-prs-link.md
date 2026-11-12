# A day thread carries only each PR's link

Status: accepted (#542, 11/11). Supersedes the bump parts of [review posts go into one day thread per board](2026-11-11-1600-review-posts-go-into-one-day-thread-per-board.md), and the 600-character answer of [reviewers ask the board in the day thread](2026-11-12-0000-reviewers-ask-the-board-in-the-day-thread.md).

## Context

#522 put each PR's link in the reviewer's day thread, with brief bumps after it: a push ("n new commits"), a `pr comment` or `pr reply` ("comment: …"), and Updated ("updated: …"), which `builder done --updated` owed once a reviewer had the card's link. #531 let reviewers and the owner talk to the orchestrator in that thread, with answers of up to 600 characters.

The owner (11/11): "we should pull back on commenting everything on slack DM threads. keep it to the pr message itself (within a single thread per day per orchestrator), and an orchestrator judgement call on whether to message a certain person (leaning towards no, unless it is explicitly requested or in response to a message in the slack thread). keep the ability to talk directly to the orchestrator in the thread with @kickflip. set a max length of orchestrator messages in the slack thread to 250 characters".

The owner's answers on #542: stop all three bumps, and remove `review updated` and `--updated`; add `slack say`, for "explicit request or in response to a message on slack"; keep the weekday digest as it is.

## Decision

**A day thread carries its opener, each PR's link and the weekday digest.** No push, comment or Updated bump is queued any more. `review due` owes only links and reactions, and has no `replies`. `queuePushes`, `review updated` and `builder done --updated` are gone, and so is the record's `head`, which only the push bumps read. The hub's GitHub check no longer fetches each PR's newest commits.

**Reactions stay.** They edit nothing. `git_approved`, `git_merged` and `x` go on every posted link, on a one-PR digest reply, and on each bump sent before this change. A bump queued and never sent is never sent.

**The orchestrator writes in a day thread only when asked.** It answers a message there that asks something (`slack answer`), or posts when the owner explicitly asks it to (`slack say <reviewer> --text`). It never volunteers an update. A slack-question's `answer: true` allows a reply; it doesn't owe one, and a thanks gets none. SKILL.md holds the rule. @kickflip stays the owner's way to address it.

**`slack say` posts in the reviewer's thread for today.** It opens the thread with the board's "<title> reviews" header when none is open, as the hub does, and records it in `data/review-digests.json`. The words open with "🤖 ", so the hub hears past them.

**Orchestrator messages are at most 250 characters**, the words after "🤖 ". `slack answer` and `slack say` refuse longer.

## Rejected

- **Keeping Updated for behaviour changes.** Rejected by the owner: a reviewer re-reads the PR on GitHub; the thread is not a changelog.
- **Sending bumps queued before this change.** Rejected: they are exactly the messages the owner asked to stop.
- **`slack say` posting into an older open thread.** Rejected: one thread per day, as for links.
