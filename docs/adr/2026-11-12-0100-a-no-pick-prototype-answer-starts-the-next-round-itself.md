# A no-pick prototype answer starts the next round itself

On #90 the owner answered a prototype question with a note and no take ("i don't think I'm seeing these options show on the prototype, please review the prototype"). The answer was recorded with `prototype_again: true`, which [asked the session for the next round](2026-11-03-1646-a-prototype-answer-with-no-pick-prototypes-again.md), but nothing made that ask visible: no launch, no orchestrator wait, and the watcher's line read "act on it on its card". The card sat prototyping until the owner asked why.

- **The board launches the round.** `recordAnswers` (`board/server.mjs`) launches the card's prototype planner for every answer that picks no take, as it does for a prototype gate answered yes, with the answer's question and note as the round's guidance (`plannerBrief`: "draw that question's next round"). A held launch queues itself like any planner.
- **Always a round.** A note that reads as a question still starts a prototype round (owner, t103-note-read); the planner may grill from there. The board never reads free text to choose.
- **One launch per card.** `startPlanner` returns nothing while an agent holds the card's record, so a Send with several no-pick answers on one card passes the last of them, once.
- **The watcher says so.** The `owner-answer` line for such an answer reads that the board starts the next round itself and there is nothing to do.
- **The fallback stays.** `pullOf`'s plannable still takes a card prototyping again with nothing waiting on the owner, so a launch that fails (`planner-failed`) still ends in a plan.

Considered: a distinct orchestrator wait kind for the unlaunched answer. It would keep a hand-off the board can do itself, since [the board launches grill and prototype planners](2026-11-04-2130-the-hub-launches-every-agent-from-the-card.md).

Superseded in part by [every planner launches from the orchestrator's brief](2026-11-12-0600-every-planner-launches-from-the-orchestrators-brief.md): an answer that picks no take owes the orchestrator the next round's prototype brief, with the answer's question and note as its ask, and the board launches the round from that brief, not straight from the answer.
