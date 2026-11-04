# Every new task is grilled or prototyped at once, unless the owner chooses Quick build

Before this, a fresh card went to grilling unless the session judged it trivial, and some unplanned cards waited for the idle pull's `card-plan`. The owner (#172, #127): every new task, once filed and titled, starts a grill, or a prototype when it's a UI ask. "Simple" is about how easy a task is to align on, not to build, so the session can't judge it; the owner opts out per task instead.

**The New task sheet asks Discuss or Quick build above Send**, Discuss pressed by default and again after each send. Quick build sends `ask {text, quick: true}`; the ask's thread, and the card's it becomes, read a muted "quick build: no grill, as you asked" under it (domain.mjs threadOf). The session files a Quick build card `--state ready` and dispatches nothing, so auto implement can take it; a Discuss card gets `--state grilling` or `prototyping` and its planner straight away. This is session behaviour, in SKILL.md. `card-plan` stays for older unplanned cards.

**A Grill or Prototype tap is a request, not a message.** The card's action row has Prototype beside Grill; Prototype sends `prototype-request {key}`, the event the thread's eye sends. Both are disabled while either is under way. The derived `prototyping` mirrors `grilling`: under way while a prototype agent runs, or while the newest card-level request has no reply, no question posted after it and no prototype agent started after it has finished. The pull treats it as `grilling`. The card reads "preheating" or "prototyping" in planner blue in the builder slot until the planner's own line takes it (prototype request-lines take A). The thread draws the tap as a muted "grill requested" / "prototype requested" entry in place of the old "Grill please" bubble; the session builds the planner's prompt from the event.

**A planner never uses builder phase words.** `builder progress` on a grill or prototype record needs no `--phase` and drops one if given; its line reads "Preheating: <detail>" or "Prototyping: <detail>" (domain.mjs `PLANNER_WORD`), marked planner, so blue, with no phase bars. Before its first line a planner's card reads its kind's word. A Todo card never reads "Building · …".

**Implement is on every unstarted Todo card**, its questions waiting or not, plain until the card is ready, then builder orange (`button.build.ready`). Its tap does what it did before: a blocked card is queued, any other starts.

Considered:
- a board setting "Skip grill on simple items" or "Always grill new tasks": the session can't tell which items are simple, and the owner asked for a per-task choice.
- orange planner lines, from the owner's "orange from the builder, blue from me": that reverses [planners and implementers are two kinds of agent](2026-11-03-1551-planners-and-implementers-are-two-kinds-of-agent.md), and orange already means a build is running.
- refusing `--phase` from a planner: planners briefed from the installed skill still pass one until this skill reaches them, and a refusal would break their lines midway.

Follow-up: planners invoke the grilling and prototype skills explicitly with an engineered prompt (data/request-lines-notes.md).
