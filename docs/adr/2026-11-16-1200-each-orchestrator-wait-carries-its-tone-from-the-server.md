# Each orchestrator wait carries its tone from the server

The board header's chip and its sheet colour each wait on the orchestrator grey, orange or red. The page used to work that out from the wait's age, with its own copy of the 15- and 30-minute lines and the rule that a limbo wait never reads red. That was a guess the page made in place of reading the server (the audit in #813).

`domain.mjs` now owns it: `waitTone(wait, now)` gives grey under `REWAKE_AFTER`, orange past it, red past `RED_AFTER`, and never red for a limbo wait. `waitsStep` stamps `tone` on every stored wait on each check. The stored waits file and `/api/board`'s `orchestratorWaits` carry it, and `waitsTone` in the page takes the strongest tone sent.

The tone changes as time passes, so the server resends the waits when one crosses a line: the check runs each minute and the stamped tone changes the stored file, which the board's file watch turns into a board change, so the page repaints within a minute of the line.

The age text on a wait (12m) stays in the page: it is the age of information the server already sent, and the page counts it up between changes.
