# A sheet opened over another lands on top first

Superseded by [a sheet opened from another stacks on it](2026-11-17-0306-a-sheet-opened-from-another-stacks-on-it.md): the sheet under stays open, and `swapSheet` is gone.

Opening the questions sheet from the reader used to close the reader first, so its 180 ms exit played while the new sheet entered, or it was gone before it. `BoardUI.swapSheet(from, later, done, open)` is the one path: `open()` shows the new sheet in the top layer with its own entry animation while the old stays drawn under it; after the entry (220 ms) the old closes with no exit animation. Reduced motion closes the old at once. The reader's `closeReader(opening)` and the pane's `swapToQuestions` go through it.
