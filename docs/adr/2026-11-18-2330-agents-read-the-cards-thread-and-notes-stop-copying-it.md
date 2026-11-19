# Agents read the card's thread, and notes stop copying it

The board copied three of the owner's words into a card's notes verbatim: an Implement message, a Reply on a ready card and every question answer. The same words sat in the thread, so a card carried them twice and its notes grew with what the owner had already said.

Notes now hold what the orchestrator and planners found and decided, appended only (`item notes`), and never quote the thread. The owner's messages, Implement and Reply words and answers stay where they are recorded, the events log, and nowhere else.

The thread file on disk holds the board's and agents' lines and the owner's commands, not the owner's words, so pointing agents at that file would have shown them nothing. `item thread <file>/<id>` prints the thread as the page shows it (domain.mjs threadOf over the card's thread lines, its events, its answers and the asks folded into it), one line each, and every brief tells its agent to read it first. Mirroring the owner's words into the thread file was refused: it is the duplication this removes.

A builder now follows a later owner message over the notes where they contradict, where it used to treat the contradiction as blocked and ask.

A fault line for a failed follow-up to Send now reads "moving the card on", the only step left after the answers.
