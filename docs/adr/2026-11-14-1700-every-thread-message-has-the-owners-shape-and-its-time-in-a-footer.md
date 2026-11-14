# Every thread message has the owner's shape, its time in a footer

Status: accepted

Owner, T-365: "Align all messages to the format of user messages, orchestrator messages should also have footer with timestamp. Also only show date if not today, otherwise time only".

- Every thread message (orchestrator, reply, builder, planner, GitHub, Slack, the owner's) is the name alone on top, the body, then a `msg-foot` footer. `msgFooter(m, tags)` in `ui-threads.js` writes it: the time, then the message's own tags (via Slack or GitHub, Moved, Moved from, Edited), then a tap's status, then, for the owner's own messages only (events and the outbox), where it is (sending, waiting, thinking, not sent). No message keeps its time in the name row. This extends [2026-11-04-2130](2026-11-04-2130-a-button-tap-is-a-status-line-or-a-message-footer.md) from the owner's messages to all.
- `ui.js` `time(iso, now)` reads the time only for today ("2:28 pm") and date and time for another day ("11/13, 2:28 pm"). Thread footers, status lines ([2026-11-13-1959](2026-11-13-1959-every-status-line-shows-its-time-from-one-shell.md)) and card times all use it.
