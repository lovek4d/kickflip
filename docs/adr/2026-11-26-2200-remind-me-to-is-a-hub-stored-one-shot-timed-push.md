# "Remind me to" is a hub-stored one-shot timed push

The owner asks the orchestrator "remind me to x at T"; it runs `kickflip remind --at <time> --text "<x>"`.

- The reminder is stored by the hub in `~/.claude/kickflip/reminders.json`, not on a board, so it survives a hub restart and needs no card.
- The hub's 15 s clock runs it as the `reminders` job (`shared/polls.mjs`): a reminder at or past its time goes once, then is removed. It goes as a `reminder` push whose title is only the owner's text.
- It goes urgent, so quiet hours, the weekend hold and a snooze don't hold it (owner, 11/21: every reminder goes through). Notifications off still drops it, as every push.
- A reminder no device took stays and goes on the next run; one dropped because notifications are off, or with no device subscribed, is gone.
- One-shot only. Each board's own reminders and a Reminders sheet are other work.
- `--at` reuses the duration picker's choices (`hub/duration.mjs durationEnd`): `<n>m|h|d|w` or an ISO date and time, at most 30 days on.
