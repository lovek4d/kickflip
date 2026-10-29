# Pushes go out by kind, and each arrives on its own

What pushes, when it goes, and how several arrive together.

**What pushes.** On top of [0006](0006-pushes-only-when-something-waits-on-the-owner.md)'s list: the answer to an ask that became no work, and a prototype the owner asked for. The bulb's rounds, and the push each new one sent, are gone ([0041](0041-hub-changes-come-as-asks-not-improvement-rounds.md)). A site card reaching Done, a PR approval and a builder finishing stay quiet.

**When it goes.** A push takes one of three kinds:
- **Now** (`--now` on `board.mjs push` and `web-ts push`): answers, replies to the owner's asks and thread messages, questions, steps only the owner can run, and prototypes asked for. These go as soon as they are written. While pushes are held overnight, or when no device takes the push, it queues instead.
- **Queued** (the default): merges, drafts on Ready, stale PRs and the morning digest. These go when the monitor tick that wrote them ends (`board.mjs checked`), or after the hub's next check if no tick runs. The hub sends the queue in the same poll that wakes the session, so a push written during that tick would otherwise wait a whole slot.
- **Urgent** (`--urgent`): as before, only for a production issue someone messaged about. It goes even while pushes are held.

`hub/schedule.mjs` `heldUntil` is the one gate that now and queued pushes pass.

**How several arrive.** When several pushes go out together, each goes as its own notification and opens its own card. This replaces the "N updates" bundle, which opened only the newest. A newer push with the same tag still replaces the older one, both in the queue and on the lock screen.

**After an answer's push has gone.** For a week, `hub/push.mjs` records the title and url of the last push sent with each tag. After a thread's push has gone, Claude's next line that answers an owner message in that thread pushes again at once. It goes under the thread's tag (`ask-<eventId>` or `item-<wave>/<id>`), with the sent push's title and url and the line as its body, and replaces that notification on the lock screen. Two kinds of line count: a `board.mjs reply` to an ask or `item-message`, and a `board.mjs thread` line written with `--answer`. Every other line never pushes: progress lines, builder status lines and `--via` lines. While the push is still queued, a line only rewrites its body, as before ([0011](0011-replies-ride-along-on-the-next-push.md)).

The session marks a thread line with an explicit `--answer` flag instead of a rule inferred from the thread. Under a rule that counted any line after the owner's last message, the first line written after that message would push, even a progress line, and the real answer that followed would stay quiet. An explicit flag also covers a follow-up to an answer that was already pushed, such as "Filed as follow-up INT-56" after "Answered: …". No owner message is newer than that push, so an inferred rule would miss it.

**Weekends.** The same hours apply every day. On a day when nothing waits on the owner, the morning digest is skipped instead of reading "0 need you".

The owner chose all of this in round `site-v23`: v23-when A, v23-group C, v23-thread-after A and v23-weekend A.

Considered:
- every push waiting for its slot;
- everything going at once from 8am to 6pm;
- one summary by kind that opens Needs you;
- folding a later line into the next push, or leaving it silent;
- weekends pushing only answers, or holding everything until Monday.
