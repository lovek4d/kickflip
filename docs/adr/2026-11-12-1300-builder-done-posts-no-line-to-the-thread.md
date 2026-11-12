# Builder done posts no line to the thread

Supersedes the "A planner's done takes `--text`" bullet of [a board's lessons live in the product](2026-11-06-1700-a-boards-lessons-live-in-the-product.md).

Card #589 (from #555): one status line was 1,413 characters long. `builder done --text` posted its note to the thread as a status line, uncapped, and a helper's hand-back landed there. The owner: "Shouldn't the done status just be done?"

- **Status lines are progress only.** `builder progress` writes a phase and at most 80 characters; the last one says what the agent last did. `stopBuilder` posts nothing, so a done, a helper's hand-back and the board-close stop leave no thread line. The thread still shows when each agent finished, from its record.
- **The note goes where it is read.** A builder's "what you checked" is the land or PR note; a helper's hand-back is its record's `note`, which `agent wait` prints; a board close's note stays on the records.
- **A planner's done takes no `--text`.** Its questions and its notes section already say what it asked; `builder done` on a grill or prototype refuses `--text`, and the briefs end with a bare `builder done`.
- **The card's line reads only running runs.** `builderOf` (domain.mjs) takes the newest status line whose `run` is a still-running record's `started`, so a finished helper's last progress line no longer stands as the card's line while main runs. A line from before lines kept their run counts by its time.
