# Send answers once the answers are written

Send's POST (`owner-answer`, `owner-answers`) used to wait for everything the Send sets going: the gate moves and notes (`settleAnswers`), staging, and the prototype planning again (`planAgain`), before it built and returned the board. On a busy board that was seconds to tens of seconds (T-142 measured board rebuilds of 5–38 s against 0.03 s from the shared build).

## Decision

- **The POST answers once the answer events are appended and their questions resolved** (`resolveNoteAnswers`, `resolveSentAnswers`). `settleAnswers` (gate facts, notes, moving the card on, staging, the ticket a staging makes) and `planAgain` run after the response, in `server.mjs afterSend`, one Send's follow-ups after another's. The board the response carries is built before they finish; each ends with a change that signals the page to reload.
- **Failures surface as before.** A `BoardError` in a follow-up is a thread line on its card, "Your answers were recorded, but <step> failed" (2026-11-08-0900); so is any other error (`followUp` catches every error; the server wraps the gate settling and the planning again the same way), and the fault line wakes the orchestrator. The Send has answered `200` by then.
- **A sent answer reads waiting…** through the orchestrator wait of kind `answer` (`domain.mjs orchestratorWaitsOf`), matched to its line by the same wait matching as replies (T-494), not a separate path; the page draws the line (2026-11-16-0500-each-answered-question-shows-at-once-as-sending).
- **Amends 2026-11-05-0200.** The Questions page's Send no longer waits on the follow-ups: its POST answers when the answers are written, so the page can move on at once (the page card posts with `board=0`).
- **Tests await `board.settled()`** before reading what a Send's follow-ups write.
