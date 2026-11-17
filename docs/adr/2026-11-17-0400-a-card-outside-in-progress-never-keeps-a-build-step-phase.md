# A card outside In Progress never keeps a build step phase

Status: accepted

T-570 kept the builder's `checking` phase after leaving In Progress, and the
card's phase word, which looked it up in PHASE_LOOK with no entry, threw the
whole board. The owner's Done tap in the outbox did the same: `tapped()` moved
the card to Done but kept its progress phase.

- The phase word draws nothing for a phase PHASE_LOOK lacks.
- `tapped()` drops a build step phase when it moves a card to Done.
- A start-up pass (`clearBuildPhases`) deletes a build step phase from any item
  stored outside In Progress. The server's `phaseOf` already reads a Todo or
  Done card from its lane's own phases, so it never sends one.
