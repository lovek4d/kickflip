# A card the orchestrator filed opens with "Filed from T-N"

The blue first line on an orchestrator-filed card said "From the orchestrator", which the owner couldn't read as a
source. It now names the card it came from, linked to it: "Filed from T-N".

- The source is the task `item add --ask --from <key>` names, else the ask's `--parent`, else its first `--relate`.
  `--from` is stored in the event's `asked {by, from, ref}`; the other two are read from the event's `links`, so
  existing cards read the new way with no migration.
- With none of the three the line stays "Filed by the orchestrator".
- A builder's or planner's follow-up keeps "From T-4's builder".
- `--from` with `--by builder|planner` is refused: those take `--parent`.

Supersedes the "From the orchestrator" wording of docs/adr/2026-11-16-1100-a-task-the-orchestrator-files-comes-in-as-an-ask-through-new.md.
