# A thread line with no questions does not empty the questions sheet

The questions sheet (app-questions-sheet.js) groups a topic's questions by the Questions added lines of the card's thread. A thread kept from before those lines named their questions holds a line with no `questions` list, and `batches()` called `.includes` on it, threw inside `draw()` and left the sheet open with an empty body, on desktop (where the pane's rows open it) and on a phone alike. The tests passed because no fixture had such a line.

`batches()` now takes only lines that name their questions; the questions no line names come last, under no heading, as it already did for a question whose line was missing.

Found by driving a throwaway hub in headless Chrome at 1280px: a pane row's tap opened the sheet at 504 × 844 with an empty `.reader-body` and a TypeError in the console; after the fix the body held the topic's question cards.
