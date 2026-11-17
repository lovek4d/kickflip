# The server applies the owner's Post or Skip on a held review

A review the session holds with `review record --state needs` offers the owner Post it and Skip. The tap is a `review-answer {pr, answer}` event, and the board server now applies it in the same request, without waking the orchestrator: Skip records the review posted (`review record --state posted` with the held text), and Post posts the held text through `review post`'s path (`postIncomingReview`, read at the time the review was held). Both are `store.mjs applyReviewAnswer`.

`review-answer` is record-only. An answer to a PR with no held review is refused with a 400 before anything is written, so a stale page or a double tap writes nothing.

A failed apply, such as a review that landed on the PR after the held one was read, appends `review-failed {pr, answer, error}`. That is an orchestrator wait, with its own plain line, until the PR is recorded again; the held review's card shows the error in red and keeps Post it and Skip, so the owner can retry. The earlier wait on `review-answer` is gone: a failure needs reading, a success does not.

Considered: keeping the orchestrator in the loop for every answer, as before. It added a wake and a model turn to a mechanical step whose result the server can check (the record changes, or the post fails).
