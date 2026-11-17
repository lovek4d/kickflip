# item add --implement marks the first message as the Implement ask

A card filed with `item add --phase discussing --text "<first message>"` whose message ended "Tap Implement…" owed
nobody anything, because filing had no way to mark the card as waiting on that tap. The card fell into limbo, and the
limbo wait made the orchestrator post a second `thread --implement` line saying the same thing.

`item add` takes `--implement`, with `--phase discussing` and `--text`: after the first message is written, the card is
marked waiting on the owner's Implement, the way `thread --implement` marks it. The same refusal that `thread` and
`reply` apply (`refuseUnflaggedTap`) now covers `item add --text`: a message asking the owner to tap Implement or Done
is refused without its flag. `--implement` is refused beside `--ask`, and without `--phase discussing`.

Left out: `--close` on `item add`, since a card filed this way has nothing to close, so a "tap Done" first message stays
refused.
