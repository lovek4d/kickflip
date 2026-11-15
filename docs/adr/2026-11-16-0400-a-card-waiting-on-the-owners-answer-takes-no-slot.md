# A card waiting on the owner's answer takes no slot

Card #808, building on [a blocked In Progress card takes no slot](2026-11-16-0300-a-blocked-in-progress-card-takes-no-slot.md). The owner: "in progress items with open questions should also not take up a slot, and be first in line for a slot after the questions are answered. same tier as unblocked tasks, FIFO".

## Decision

- **A card In Progress with an open owner question takes no slot** while it is open (`asking`: its topic isn't resolved and has open questions, whether its builder or the orchestrator asked). `pullOf` and `pauseWork`'s count of held slots skip it, as for a blocked card.
- **Answered, it counts again** and nothing new is pulled past it, so it is first in line for the next free slot, the same tier as an unblocked card.
- The builder stays parked, handed back or deferred, as before; this changes only the count.

## Consequences

- The cap can briefly be exceeded when an answer lands while every slot is taken.
- Order among several freed cards is not tracked beyond the pause time: a paused build resumes oldest pause first.
