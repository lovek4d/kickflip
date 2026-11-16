# A starting board shows its session's liveness, activity and prompt

This extends [a new board shows its start steps and live clone progress](2026-11-04-1914-a-new-board-shows-its-start-steps-and-clone-progress.md), whose starting orchestrator step only pulsed with its seconds from the clone's end until the join. Only `claude --bg` failing, or the 15-minute limit, turned the row failed. A session that died at second 20 still pulsed for 15 minutes, and one waiting on a permission prompt said nothing on its row. Before it joins, a session owns no board, so its prompt sat only on the hub page, labelled by folder. The owner found one stalled start that way: the new session's `tailscale serve` had failed, and it was waiting for permission to run `kickflip doctor`.

## What the row reads

While a record is starting orchestrator with its session recorded, the hub reads three signals for it on each sidebar copy (`sessions.mjs startSignals`):

- **liveness**: `liveSessions`. A session that no longer runs fails the row at once: it reads **session ended** in red. Its sheet's error is "Its session ended before it joined the hub", plus its last step when known, and the sheet offers Dismiss and Retry. When ps gives no answer, nothing reads ended.
- **activity**: the session's transcript (`session-activity.mjs`): its last tool call, thinking or text, worded as "loading the kickflip skill", "joining the hub", "running kickflip doctor"… That wording replaces the step name in the caption, and the seconds stay. The transcript's last write is when it last moved.
- **prompt**: its oldest pending prompt in `prompts.json`, matched by session.

A session whose transcript hasn't moved for `STALL_AFTER` (3 minutes) reads **stalled · Nm quiet** in orange, with Retry on the row. Its quiet time counts from its last activity, or from its start if that is later. A pending prompt holds that off, since it waits on the owner. With no transcript found, it never reads stalled, and only the 15-minute limit applies, which stays the backstop. Retry and Dismiss accept a stalled or ended start as well as a failed one (`new-board.mjs failedStart`). Retry stops the earlier session first.

A pending prompt shows as a red block under the row's bars: "waiting on you · <tool>: <what it asks>", with Allow and Deny. A single question that takes one pick shows its options and Skip. A bigger question links to the hub page. The answer goes through the same `/_hub/prompts/<id>/answer` as the hub page's. The prompt is still listed on the hub page as before. A joined board's prompt is unchanged and is listed on the hub page only ([the board has no Needs you deck or pane](2026-11-12-0700-the-board-has-no-needs-you-deck-or-pane.md)).

## Fewer prompts at start

The hub's audit log records each prompt a starting session raises (`start-prompt`, with its tool and input). That way, the next prompt shows what to allow up front. The settings every hub session starts with (`BG_SETTINGS`) now allow `Bash(kickflip doctor)`, which only reads; `kickflip doctor --fix` still asks.

The design came from prototype `board-prompt`, take A (inline block).
