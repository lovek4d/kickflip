# On the desktop, a link into open questions focuses its pill

From 900px, Waiting on you is mounted in the pane beside the lanes, so a link to `questions.html#<question or topic id>` picks that topic's pill there (and scrolls to it) rather than navigating the main page away from the board. The owner, on #312: "clicking into open questions on the desktop split view should just focus that pill on the right pane, not open the open questions as a main page".

- **Which links**: any plain left-click on an anchor inside the board that resolves to this board's `questions.html` with a hash: a card's Open questions button, a card's "N questions" link, a Needs you line, a new-questions line in a thread. The board view's click listener (`app-needs.js`) runs before the router's, which skips a prevented click.
- **Phone**: below 900px no pane is mounted and links behave as before.
- **A topic the pane doesn't hold** (the hash names no topic in `ownerTopics`) keeps the link to the page, as does a link with no hash (All open questions) or one clicked with a modifier key.
