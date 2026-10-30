# Pushes go out by kind, and each arrives on its own

What pushes, when it goes, and how several arrive together.

**What pushes.** Only [0006](0006-pushes-only-when-something-waits-on-the-owner.md)'s three kinds: `action`, `prompt` and `fault`. `hub/push.mjs` `deliver()` refuses any other kind, and `board.mjs push` and `web-ts push` refuse a push without `--kind`. The answer to an ask, a merge summary, a card going Stale, a morning digest, a handshake test push, a site card reaching Done, a PR approval and a builder finishing stay quiet. The bulb's rounds, and the push each new one sent, are gone ([0041](0041-hub-changes-come-as-asks-not-improvement-rounds.md)).

**When it goes.** A push goes one of three ways:
- **Now** (`--now` on `board.mjs push` and `web-ts push`): questions, steps only the owner can run and prototypes asked for, and the hub's own prompt and fault pushes. These go as soon as they are written. While pushes are held overnight, or when no device takes the push, it queues instead.
- **Queued** (the default): drafts on Ready and Merge. These go when the monitor tick that wrote them ends (`board.mjs checked`), or after the hub's next check if no tick runs. The hub sends the queue in the same poll that wakes the session, so a push written during that tick would otherwise wait a whole slot.
- **Urgent** (`--urgent`): a fault, only for a production issue someone messaged about. It goes even while pushes are held.

`hub/schedule.mjs` `heldUntil` is the one gate that now and queued pushes pass.

**How several arrive.** When several pushes go out together, each goes as its own notification and opens its own card. This replaces the "N updates" bundle, which opened only the newest. A newer push with the same tag replaces the older one, both in the queue and on the lock screen, and `hub/sw.js` shows it with `renotify`, so a card whose action changed alerts again.

**After a thread's push has gone.** Claude's later lines in that thread never push, an answer to the owner included: the thread's unread mark carries them. While the push is still queued, a Claude line in the thread only rewrites its body ([0011](0011-replies-ride-along-on-the-next-push.md)).

**Weekends.** The same hours apply every day.

The owner chose the timing in round `site-v23` (v23-when A, v23-group C, v23-weekend A), and the kinds, with answers no longer pushing, on hub/INT-146 (`push-kinds`, take `action-prompts-faults`).

Considered:
- every push waiting for its slot;
- everything going at once from 8am to 6pm;
- one summary by kind that opens Needs you;
- a later answer in a thread pushing again under its tag, marked with `thread --answer` (round `site-v23` v23-thread-after A, dropped on hub/INT-146);
- weekends pushing only answers, or holding everything until Monday.
