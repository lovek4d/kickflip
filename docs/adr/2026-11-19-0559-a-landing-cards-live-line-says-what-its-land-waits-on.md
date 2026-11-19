# A landing card's live line says what its land waits on

A card's live line (domain.mjs builderOf) showed only builder status lines. The board's wait lines (`test-waiting`,
`land-waiting`, finish.mjs waitLines) are hub lines, so they never reached it: a land waiting 5 to 18 minutes for a
test slot read "Landing · taking up the verified build", the lander's start line, written 15 seconds after the wait
began. A failed land test run read "Landing · 2543 passed, 6 failed" in orange.

## Decision

While a build runs, builderOf reads its land (landingOf):

- An open wait line (hub-lines.mjs waitsOf: no `wait-over`, its process alive), the newest, overrides every status
  line, the lander's start line included: "Waiting to test · #N is testing first" or "Waiting to land · #N lands
  first", orange, aged from the wait line's time. A wait line keeps the card it waits on (`waitFor`) for these words;
  one written before reads its thread words.
- A land's test run (runs.mjs testReport, phase landing) marks its lines `test: start | update | end` and the result
  `failed: N`. While the newest status line is its start or an update, the live line reads "Testing · …".
- A result with failures reads red "Land failed: N tests" until the builder's next status line.
- A test wait written when the card's newest test result is a land's that failed (hub-lines.mjs landRetry) is a retry:
  `retry` on the line, "Retrying: waiting to test, #N is testing first" in the thread, "Retrying: waiting to test · #N
  is testing first" on the live line. This names the re-queue after a failed run (a joined land's finish trying again,
  or the builder's next finish), which read as a fresh "Waiting to test" before.

builderOf hands the word (`word`: Waiting to test, Waiting to land, Retrying, Testing, Land failed) and `failed` to the
glance pane (app-pane.js buildState), which shows the word (red for Land failed, orange otherwise) and counts those
cards as landing, and to the card (ui-cards.js builderStatus), which draws a failed land red.

The phase bars stay on landing. Owner's scope (T-750): not the orchestrator's send-back text as the live line, and no
N/M test progress (the runner names no total before the run ends).

Wait colour: orange, by AGENTS.md's colour priority (blocked by a task is attention), as the thread's wait lines are.
