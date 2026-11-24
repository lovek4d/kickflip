# A visual already in the thread isn't linked again

A visual agent's page, and one `visual add` makes, is posted in the card's thread as a status line. On T-863 the orchestrator then ran `thread --link` on the same page with its questions, so the visual showed twice (#1201).

- `appendMessage` (`cards.mjs`) refuses a `--link` to a `visuals/…` page that any line of the card's thread already links, ignoring a `?query` or `#hash`. The refusal says the page is already there and to put it in the questions' `url` only.
- A page the orchestrator wrote by hand links once; a prototype page is not checked.
- SKILL.md tells the orchestrator the same.
