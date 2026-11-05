# A tap spins until the board shows its change

A button that waited on its request alone went back to idle when the request returned, then showed the change a board later: a flash of the plain button between. The Merge button had the cure ([a merge tap waits its turn to land](2026-11-04-2320-a-merge-tap-waits-its-turn-to-land.md)): `BoardUI.pending`, keyed `<card>:<action>`, drawn busy by the markup through any repaint, ended by `settle(board)` in `render`. Nudge, Serve/Build, Main's pull icon and Plan waves now use it too.

- **Each ends on the change it caused.** Nudge: the card's builder line moved. Serve / Build: the card's `try` differs from the tap's. Plan waves: a grill runs on one of the cards. Main pull: a pull that brought no commits ends on its answer (`{commits: 0}`, a pull no board shows); one that brought commits ends on a board where Main's pull, sha, state or time moved.
- **A bare fetch ends the request, not the spinner.** `pending.answered(id)` with no time lets any board settle it, so each `until` compares with what the tap saw, never with a fixed state.
- **A refusal drops it**, back to idle with the reason in a toast, as before.
- **Sixty seconds without the change** drops it, reloads once and toasts "Still waiting on the board" (`PENDING_LATE_MS`, the `onLate` argument of `pending.start`).

Audited and left: Hold, Unhold, Done, Implement, bumps, Review answer, Lineup move, Triage, new task and ask buttons end on `B.send`'s own board, drawn in the task the request resolves in, so they show no idle frame (a reload that raced the POST can still draw before the tap is recorded). Thread Send, the Questions page's Send / Prototype / Re-ask, the permission switches and a board's Restart on the Hub page still go idle on their request and show the change a load later; they are the next to move onto `pending`.
