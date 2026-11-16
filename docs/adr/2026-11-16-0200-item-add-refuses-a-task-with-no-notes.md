# item add refuses a task with no notes

Four cards split from T-299 and T-228 were filed with a title and nothing else; their substance stayed in the parent's notes, and two were readied before anyone noticed. The owner (T-395, 11/15): "Filed cards should be standalone from the start."

- **`item add` on a board needs `--notes` or `--notes-from`.** A blank `--notes` counts as none. The text becomes the card's first notes section, as before.
- **A split carries its slice.** The split's draft holds the child's slice of the parent's proposed split, as SKILL.md's split paragraph already says.
- **Ask-born cards are exempt.** `item add --from-ask` starts from the ask's text; `item triage` and investigation cover it.
- **The flag is `--notes-from`, not `--notes-file`.** `--notes-file` is gone ([the board owns a card's notes file](2026-11-09-1100-the-board-owns-a-cards-notes-file.md)).
- **Only the CLI path refuses.** The board's own calls (an architecture review's cards) do not set intake and file as before.
