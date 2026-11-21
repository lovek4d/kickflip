# A report card ends on its report and the owner's Done

Card #1138 (T-769), settled by the owner on T-758.

## Decision

- A review or audit card ends on its report and the owner's Done (`thread <key> --close`), never an Implement ask.
- Each finding worth fixing is a question with two options, File as a task or Skip.
- Each filed fix is its own discussing task and waits for its own Implement tap; the report card's Done starts
  nothing. Auto implement is a separate task (T-771); until then Implement stays something the owner confirms.
- The guidance is SKILL.md only. `reviewerBrief` stays: the Review tap launches a reviewer on any card and it writes
  only its findings. The bulb's architecture review keeps its own flow.

Builds on [Implement is only the card's tap](2026-11-18-0100-implement-is-only-the-cards-tap.md).
