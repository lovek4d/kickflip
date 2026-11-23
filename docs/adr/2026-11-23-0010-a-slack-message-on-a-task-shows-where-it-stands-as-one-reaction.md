# A Slack message on a task shows where it stands as one reaction

Each Slack message that reaches a Slack-filed task carries one status reaction, swapped as it moves on, so the person who
asked can see at a glance whether it was picked up. The messages are the @kickflip ask that filed the task, an ask folded
into it, and each later Slack reply copied onto it as a message (an item-message whose sendId is `slack:<channel>:<ts>`).
A reply copied as a plain thread line is owed no answer and gets no reaction. This follows GH-1118, where each of these
messages is its own reply target.

| Status | Default | When |
| --- | --- | --- |
| received | 👀 `eyes` | the message is in and nothing below holds |
| thinking | 🤔 `thinking_face` | the orchestrator works on it while its board listens, or its reply is written but not yet posted |
| waiting | ✋ `raised_hand` | the orchestrator acted on it with no Slack reply, and the task waits on the owner (the same signal as the "Waiting on owner" line) |
| done | ✅ `white_check_mark` | a reply to it has posted to Slack, or the task is Done; it stays |

The states come from the thread's own per-message state (`domain.mjs` `pendingState`: waiting, working, answered,
replied), read from the board as its page draws it (`snapshot.mjs` `builtBoard`). A working mark is read as received while
the board's session is not listening, so a dead session leaves no 🤔 standing. A message acted on without a reply, while
the task waits on nobody, reads received: the orchestrator has it and nothing is asked of the sender.

- **One reaction at a time.** The hub records each reaction it added (`data/slack-threads.json` `reactions`,
  `"<channel>:<ts>": [{kind, name}]`) and removes only its own, the removal sent before the new add. A failed call holds
  back that message's rest until the next poll.
- **Intake's 👀 is the first status.** Intake reacts with the received emoji as it files the ask and records it on the
  ask (`routed.slack.reacted`), which the first swap removes. An ask filed before this records nothing and is read as
  carrying `eyes`.
- **Tracked from the first poll that sees the task open.** A task Done before that gets nothing, so the build does not
  react to old messages.
- **The emoji are picked in Hub › Slack**, one row per status beside the PR states' rows (`hub/slack.mjs` `PR_EMOJI`,
  `statusEmojis`), standard defaults and no custom ones.
- **Sent from the hub's poll after the replies** (`hub/slack-intake.mjs` `reactSlackStatus`), so a message whose reply just
  posted swaps to ✅ on the same poll. 🤔 shows only while a poll falls inside the work.

An ask Haiku answers with no task (#1133) keeps intake's 👀 alone.
