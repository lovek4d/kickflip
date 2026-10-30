# Notes carry a one-line summary, which the store requires

A work item's **Notes** ([0053](0053-notes-replace-the-full-plan-and-cards-start-on-their-own.md)) carry a `summary`: one line of at most 100 characters, stored in the item beside `plan` and served on `/api/board` as the card's `summary`. The open card's details list ends with a Notes row, the summary word for word, then "(view more)" opening `notes.html`.

- **The store refuses notes without a summary.** `board.mjs item set --notes-file` (and `--plan`) refuse without `--summary`, and so do `item add --notes` and `--notes-file`. A `--summary` with a line break, or over 100 characters, is refused. Each refusal is one line naming the flag, exit 1.
- **`--summary` alone rewrites the summary of notes the item already has.** The notes file is rewritten in place as the grill settles things, so its summary has to change without naming the file again. An item with no notes refuses it, as `--status building` refuses a held item: the check reads what is stored, not only the call.
- **The board shows it as written.** The page never rewords it. A summary longer than its row is cut with an ellipsis before "(view more)", which stays in view; at phone width most are.
- **Notes from before have no summary.** Their row shows only "(view more)" until the session next sets the notes. Nothing backfills them.

The owner wanted the card to say what its notes hold without opening them: "notes should also go away and become an item in the list of wave, status, next, with a short one line summary and "(view more)" link at the end of the line" (hub/INT-136). The owner picked a summary the session writes, then made it structured: at most 100 characters, with notes updated only together with a summary (question `notes-summary`). The board can't check that the summary matches the notes; requiring one with every notes update is what keeps it current.

Considered:
- the board taking the first sentence of the notes file: nothing to keep in sync, but notes open with the quoted ask or a "From …" line, so the row would read as that rather than a summary;
- refusing `--summary` without `--notes-file` in the same call, as `--install-sha` goes with `--install`: every summary update would have to repeat a file path that hasn't changed.
