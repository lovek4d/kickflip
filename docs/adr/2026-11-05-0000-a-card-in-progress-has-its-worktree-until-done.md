# A card in In Progress has its worktree until it is Done

`board.mjs item set --status building` on a board makes the card's worktree (the same one `builder start` makes) before any builder runs, and keeps its path on the wave item. The board reads a card's worktree from its newest builder record, else from that item field, so an In Progress or In Review card shows "Open in VS Code" on the host whether or not a builder record exists. A later `builder start` keeps that worktree instead of making another. Only `land` removes it, when the card goes to Done.

Why the item and not a builder record: a record with no builder running would count as an open builder, or add a "started" or "finished" line to the thread.
