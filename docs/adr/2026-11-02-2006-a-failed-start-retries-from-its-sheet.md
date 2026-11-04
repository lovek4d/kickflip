# A failed start retries from its sheet

The owner asked on hub/INT-255 for Retry on a board that didn't start, since its row offered only Dismiss and starting again meant making the board again with New board. They picked take B of prototype `retry-start`, with the note "Should be a simpler failed to start, keep name in place in red, subtext “failed to start”, tap for more info, no arrow", and confirmed it in `retry-start-confirm`.

- **The row.** A start that failed, or that hasn't joined 15 minutes after it was asked, keeps the board's name in its row, in red, with the sub line "failed to start". It has no arrow and no buttons; the whole row is a button (`board/public/ui-sidebar.js`).
- **The sheet.** Tapping the row opens a sheet titled "<name> failed to start". It shows the stored error line, or "Its session didn't answer within 15 minutes." for a start that timed out, then the repo, branch, tickets and when the start was asked, with Dismiss and Retry. Dismiss deletes the Starting record, as before. A refusal shows in the sheet, which stays open.
- **Retry.** `POST /_hub/new-board/<route>/retry` (`hub/new-board.mjs retryBoard`) takes `application/json`, like New board's start, and answers `{route}` without waiting for the start. It reruns the start from the Starting record, with the same route, repo, branch, tickets and purpose, so the record now keeps `purpose` too. It clears `error` and any recorded session, sets `asked_at` to now and `phase` to cloning or starting, and the row reads Starting… again. A Linear project that New board created is already in `tickets.project`, so a retry never makes a second one.
- **A timed-out start's session is stopped first.** A start that timed out may have a session recorded that is still running. Retry stops it (`sessions.mjs stopSession`) before it starts the new one, so the route never has two sessions and the owner never cleans one up. When the stop fails, Retry refuses and changes nothing.
- **Only New board starts retry.** A start `kickflip start` recorded has no branch or repo source to run again, so its sheet has Dismiss only and the route refuses it.

Considered:
- Take A, Retry beside Dismiss on the row: the row already carried the whole error line, and two buttons crowd a sidebar row on a phone.
- Retry through New board, prefilled from the record: a second confirm for a request the owner already made, and the route would need its reservation dropped and taken again.
