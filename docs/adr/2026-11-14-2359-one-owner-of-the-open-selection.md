# One owner of the open selection

#713. The owner: "sometimes clicking questions on a different item than the one previously opened, the left pane scrolls back to the previous topic, which is mismatched to the topic selected on the right pane". Then, on the phone: "expanding any given task would also have it preselected on the questions page on mobile? That would be neat".

The board's open selection is two things: the card the lanes open (`selectedCard` in the fragment) and the topic the pane shows (`openItemsCard`). A Questions link used to move only the topic, leaving the fragment at `selectedCard=A&openItemsCard=B`, so any replay of the fragment (a hashchange, a remount, the first paint) scrolled the lanes back to A. Two writers set the two halves.

- **One step.** `BoardUI.nextSelection` (ui-selection.js) is pure: a question, a topic or a card resolves to the card and the topic, the fragment's changes, and the next generation. `B.select` (app-selection.js) applies it: the topic in the pane, the card opened and scrolled on the board, both keys written to the fragment in one write.
- **Every way in goes through it.** The shell's questions URL (`focusQuestion`), a pill tap (`openOnBoard`), an opened card and the fragment's replay (`replayTopic`). A question sets its card too, so the board follows the pane.
- **A card selects its topic.** Opening a card selects it; when it has open questions its topic opens in the pane, and the phone's ? links to that topic (`BoardUI.questionsHref`). With none, the pane and the page open as before.
- **The newest pick wins.** `select` bumps a generation, and a retry for an older pick, in the fragment's replay or in the shell's `askPane`, is dropped.
- **A pick adds no history entry.** The fragment is written in place.

Supersedes the shell's "the URL, history and an open card stay as they are" for a questions URL on its own board: the selection now changes the URL's card too.
