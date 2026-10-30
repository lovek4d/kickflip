# Notes is a link in the details list, with no stored summary

A work item's **Notes** ([0053](0053-notes-replace-the-full-plan-and-cards-start-on-their-own.md)) open from the last row of the open card's details list, after Wave, Status, Next and the rest. The row's label is the link, "Notes ↗", opening `notes.html?item=<key>`; its value is empty. A card with no notes has no row.

- **The label is the link.** The row reads as one more fact about the card, and the arrow says it opens a page, as Open alone ↗ and a question's link do. Notes is not a button in the open card's action rows.
- **Nothing beside it.** The board stores no summary of the notes and shows none. `item set --notes-file` (and `--plan`), `item add --notes` and `--notes-file` take the notes alone; `--summary` on either is an unknown flag. A `summary` already stored in a wave file is ignored.

The owner first asked for the row to carry "a short one line summary and "(view more)" link at the end of the line" (hub/INT-136), then, once it shipped: "lets drop the summary and all, just make the left side notes a clickable with a top right direction arrow". Existing cards had no summary, so their row showed only "(view more)", and the summary made every notes update carry a required flag.

Considered:
- a stored one-line summary of at most 100 characters, required with every notes update and shown word for word before "(view more)": dropped for the reasons above;
- the board taking the first sentence of the notes file: notes open with the quoted ask or a "From …" line, so the row would read as that rather than a summary.
