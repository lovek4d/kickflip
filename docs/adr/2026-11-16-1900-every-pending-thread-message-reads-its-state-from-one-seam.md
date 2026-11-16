# Every pending thread message reads its state from one seam

The owner asked that a submitted set of answers read waiting… and thinking… as a reply does, and that every message the
owner sends into a thread read that status from one place.

Each message the orchestrator owes a response to (a reply, an ask, a submitted set of answers, a request line such as
Prototype requested, a tap's status line) now takes its state from `domain.mjs` `pendingState`, from the same inputs:
whether it has a reply, whether it is cleared (acted on, linked, the card closed), when it was handed over, when the
orchestrator last wrote or acted on the card, and when it was picked up while the orchestrator listens. `threadOf` calls
it for every event-backed message; `markWaitStarts` calls it for a tap line that starts a wait. `public/ui-threads.js`
`PICK_UP` draws the result in every footer and status line.

A builder's unverified judgment calls line reads the same: `markWaitStarts` gives it the state of the card's `calls`
wait, so it reads waiting…, then thinking… with its duration (the same `thinkingLine`), then verified <time> once the
orchestrator verifies. Before any calls wait exists it keeps "not verified yet".

A submit read no waiting or thinking because Send resolves each answered question at once, noting Answered
(`store.mjs` `resolveSentAnswers`, docs/adr/2026-11-15-1200-an-answered-question-folds-on-send.md), and `threadOf`
counted any resolution after the answer as the orchestrator acting on it. Send's Answered resolution is now not an act:
the answer waits until it is handed over, reads thinking while the orchestrator works, and clears at the orchestrator's
next line on the card, as the card's answer wait already did. A resolution the orchestrator writes itself still acts on
the answer.
