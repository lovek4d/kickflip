# One digest opens each day thread

Each reviewer's day thread for a board opens with that day's digest, and only the digest. Its top message is three lines:

```
<board title> Digest
3 PRs pending review
- :claude_kickflip:
```

The count reads "1 PR pending review" at one and "All reviewed" at none. One function, `postDigest`, posts it, with two triggers:

- **Schedule:** from 09:00 on a weekday in the Slack timezone. A day the hub misses goes out on its first poll after, any time that day; a missed morning is no longer skipped at 17:00. Weekends have no scheduled digest.
- **On demand:** any day, weekends included, when a link is owed to a reviewer whose thread for the day isn't open yet. The digest goes first and the link follows as a reply, as on a weekday morning.

The digest is the same either way: same top message, same replies, same live count. The "<board> reviews" header line that used to open a thread with no digest is gone, and so is `openDayThread`. `slack say` on a day with no thread opens it with the digest too. A thread an earlier build opened with that header still gets the weekday digest as one reply, the reviewer's mention before its first line.

The count is unchanged: the reviewer's PRs that are open, out of draft, not failing and not approved when the digest posts, edited down as they leave review ([a digest header keeps a live count](2026-11-13-2345-a-digest-header-keeps-a-live-count-of-prs-pending-the-reviewer.md)).

## Edits name their time

Every message the hub edits ends with its sign-off and the edit's 24-hour time in the Slack timezone, in italics: `- :claude_kickflip: · _updated 14:05_`. A time with no date is enough because each day has its own thread. Posts are signed off as before. `isSignedOff` matches both forms, so the hub still hears past its own edited messages ([every Slack message ends with a sign-off line](2026-11-12-0400-every-slack-message-ends-with-a-sign-off-line.md)).

## Considered

- **Keep the 09:00 to 17:00 window.** It only stopped a missed morning going out in the evening, and the owner would rather have it late than lose the day.
- **A separate on-demand digest.** The owner asked for the morning and on-demand digests to be exactly the same, so only the trigger differs.
