# A held question push is left out of the summary

The owner, on #573, after push taps didn't open the questions page at their topic: "Held questions shouldn't push. Honestly maybe let's just fix the bug and make another ticket to revisit what push notifications come through, it has gotten noisy." This amends [queued pushes go as one summary per board](2026-11-02-1733-queued-pushes-go-as-one-summary-per-board.md).

- **A question push that waits out a hold never goes.** When the queue flushes, a push whose url is `/<route>/questions.html…` is dropped before the summaries are built (`hub/schedule.mjs` `notifications`), alone or beside a board's other pushes. The question waits on the Waiting on you page and its badge.
- **The summary counts the rest.** A board whose other queued pushes remain still sends its one push unchanged or its one summary, from what waits on it now.

The tap bug sits in the page, not here: a questions link tapped on a page left in the background names a question its board doesn't hold yet. `board/public/view-questions.js` loads the board first, then opens that question's topic.

Considered:
- keeping a held question push as a summary linking the questions page: the owner chose to push less.
