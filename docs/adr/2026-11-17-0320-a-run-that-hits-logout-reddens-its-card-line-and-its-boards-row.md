# A run that hits logout reddens its card line and its board's row

T-288 put a logged-out hub session on the board and pushed once, but a headless run's episode was keyed `headless` and marked nothing. The owner picked take A (q-t354-logout-card): a red live line and a red row, no banner and no left edge.

- **Detection.** `runLoggedOut` (`hub/login-error.mjs`) reads the newest `result` event of a run's log: an error carrying `LOGIN_TEXT`. The runs checked are the open records' `session.log` (builders, landers, planners), so the log names its card and board.
- **Card.** The board server reads the open runs of each card on every snapshot (`loggedOutCards`). A flagged card's live line reads "Claude is logged out: run /login" in red (`builderOf` sets `loggedOut`, the card's line takes `.refused`). Nothing is stored for the colour: a run that resumes after /login writes a new log, which the record names from then, so the flag and the red clear with no state.
- **Thread.** The board's minute pass (`runAuto`) writes the same words as the card's status line (`noteLoggedOut`), once until another status line follows it.
- **Row.** The hub's check finds each board's open runs the same way and keys the episode by the board's route, so `loggedOutRoutes` reddens that board's row, and the one push opens that board. A recent log no board's open run names stays `headless`.
- **Left out.** No banner; the push and the hub session's row stay as T-288 made them.
