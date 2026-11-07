# A grill waits for every answer before it changes phase

A Send answering a card's "Prototype round first?" yes moved the grilling card to prototyping at once, even with its other questions still open. The owner asked that a grill wait for all its questions to be answered before the phase changes, unless the orchestrator judges that a note on one of the submitted answers closes a remaining question as well (#430).

Now the gate's answer resolves at once as before, but the card moves only once none of its questions is open (store.mjs moveOnAnswered): to prototyping, starting the prototype planner, when the gate was last answered yes, else to staging as before. A yes sent while others are open writes a thread line saying the card moves once every question is answered. The check runs on every Send on the card, so the order of answers doesn't matter.

A question the orchestrator closes with `question resolve` counts as answered: resolving the last open question of a grilling card runs the same check. A move to prototyping made there, outside the board server, sets the card's `round_at`, so the server's round pass (domain.mjs roundsDue) starts the prototype planner. SKILL.md tells the orchestrator to resolve a question that a submitted note settles, quoting the note, and to leave the rest for the owner.

This amends [every grill ends with a prototype question](2026-11-06-0130-every-grill-ends-with-a-prototype-question-the-board-acts-on.md), whose yes moved the card at once. Clearing the card's Action needed once everything is answered is #393's.
