# Only typed thread messages wake the orchestrator

Card #392. Amends [record-only events do not wake the session](2026-11-05-1000-record-only-events-do-not-wake-the-session.md), and supersedes the Unhold bullet of [Done and Hold stop the card's headless builder](2026-11-05-0900-done-and-hold-stop-the-cards-headless-builder.md) where it left the fresh builder to the session.

The owner (#378, 11/06): "I want thread messages to explicitly be messages to the orchestrator on a direct line that wake it upon receipt as opposed to a lot of the other options such as grill or prototype or implement or hold or unhold that really just change the status of a card mechanically or kick off a another subagent mechanically."

## Decision

- **Taps are record-only.** `card-hold` (Hold and Resume), `card-done`, `card-unbump`, `card-unblocked`, `grill-more`, `prototype-request` and `visual-request` join `bin/wait-events.mjs` `RECORD_ONLY`. The board server has already applied each one, so none wakes the session; their lines print ahead of the next wake's events, as other record-only lines do (owner, gh392-taps).
- **Text typed with Grill, Prototype or Visual goes to that agent.** The board server already puts it in the planner's or visual agent's brief; the event no longer wakes the orchestrator too (owner, gh392-planner-text).
- **Resume relaunches the run the hold stopped.** A Hold marks each started record it closes `hold_stopped` (`store.mjs closeBuilders`). On Resume, or a timed hold's pick-up, the server takes the mark off the card's main record (`takeHoldStopped`) and relaunches that run: a grill or prototype through `launchPlanner`, a build through `startTappedBuild` with dispatch `hub` and `handOff`, as the pull starts one (`server.mjs resumeRun`). A card whose hold stopped nothing is the pull's. A refused start leaves its thread line, and a card left with nothing running reaches the orchestrator through its existing waits (`unowned`, `refused`, `grill`) (owner, gh392-resume).
- **A bump still wakes.** `card-bump` stays a wake, since a bump means the owner needs the card done urgently and the orchestrator decides how to allocate itself (owner, gh392-bump). The pull and land queue already take it first.
- **Answers still wake.** `owner-answer` and `owner-answers` stay messages (owner, gh392-answers), as do `item-message` (Reply, Implement with text) and `reask-request`.
- **The builder stop is the board's line.** "Stopped its builder." after a Hold or Done is written as the board's status line (`who: claude`), not as the owner's message.

## Not done

- A lander or rebase run a Hold stopped is not relaunched by the Resume; the board's lander and rebase jobs, and the orchestrator's waits, own those cards.
- A relaunched grill or prototype gets a brief from the card, not the text typed with the request it replaces; #394 hands planners the card's thread.
- The audit of every signal against SKILL.md is #395.
