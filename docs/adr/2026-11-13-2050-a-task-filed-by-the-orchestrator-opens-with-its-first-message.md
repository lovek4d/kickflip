# A task filed by the orchestrator opens with its first message

`item add --phase discussing` takes `--text <md>`, written as the card's first thread line (by the orchestrator, after
"Created from") in the same write as the card, and refuses without it. A discussing card with an orchestrator line last
reads the owner's turn, so the card opens on a message instead of an empty thread. Grilling and prototyping cards, which
get a brief, take no `--text`; `--from-ask` keeps its own `--text`.

Owner on T-280: a task filed discussing used to read the owner's turn with nothing to answer, and the first message
came in a separate `thread` call, or never.
