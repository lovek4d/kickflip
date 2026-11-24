# A task resting on an unchecked claim starts a reviewer unasked

A builder's `Found:` call said a customer lookup count had risen from about 17k to 107k a day. The orchestrator wrote a plan that took the rise as fact and stopped on discussing; the owner had to tap Review, and the review found nothing had risen, since the hook was new.

## Decision

The reviewer joins the visual, grill and prototype the orchestrator starts unasked ([always High](2026-11-19-1000-the-orchestrator-always-works-as-high.md)): when a task's next step rests on a premise nobody has checked, it briefs a reviewer before writing a plan or a reply on that premise.

- The intake wait for an ask filed by a builder or planner names the reviewer brief as the default next step when the ask rests on an unchecked claim (`INTAKE_NEXT.ask` and its watcher twin in `bin/event-lines.mjs`). Both drop `--text` from `item triage`, which refuses it without `--fold-into`.
- When a card's newest ended agent is its reviewer, its limbo wait reads "fold the findings into the notes, then reply", so the plan resting on the review has a step that starts it.

## Not done

A `--review` mark on `reply` / `thread`, like `--implement`: it would hold the reviewer for the owner's go, against always High, and the request row already has Review.
