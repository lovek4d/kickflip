# A staged card moves only by the orchestrator's review

A staged card is locked. Only the orchestrator's review moves it, to ready or back (discussing, grilling, prototyping) with a thread line giving the reason, and the owner's own Cancel.

- A typed /grill, /prototype, /visual or /review on a staged card is refused (domain.mjs tapPlan, 409), as its buttons are already disabled; `planAgain` also leaves a staged card as it is.
- A question published on a staged card no longer sends it to grilling (`grillAgain` acts on a ready card only).
- The owner's messages leave a staged card where it is.
- A grill's last answer and a ready card's expiry are as before: neither moves a staged card, and a message on a ready card still re-stages it.

Why: on T-736 an answer, then a message, took a staged card out of staging under the orchestrator.

Supersedes the parts of 2026-11-07-0700-staging-then-ready.md that let a question, a Grill or a Prototype tap take a staged card out of it.
