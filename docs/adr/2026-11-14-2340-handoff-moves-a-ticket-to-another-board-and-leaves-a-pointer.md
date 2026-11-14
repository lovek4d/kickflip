# handoff moves a ticket to another board and leaves a pointer

Before, only an ask still in New could move between boards (`ask move`). A discussed ticket, or something a session handed over, arrived on the other board as a bare ask with no trail on either side.

`board.mjs handoff <file>/<id> | <eventId> --to <route> [--note <t>] [--done]` (store.mjs `handoff`) hands any work to another board in the hub's manifest. The owner chose a CLI helper over the Haiku router: a handoff already knows its target, so a model call would only add delay and a chance of misfiling. The router stays for requests that arrive naming no board.

- **A New ask**, by its event id or by the card still New from it, moves as `ask move` did: its card here is dropped and its ask's thread keeps the `ask-moved` line. `ask move` stays, as an alias of this path, so the CLI's existing callers and refusals keep working.
- **Any other ticket** becomes an `ask` event on the target: its title and a link to its notes here as the text, `from {route, title, key, ref}`, and the sender's `note`. The handoff files it into its task on the target at once (a running board files it as it takes the event, one that is down by `fileAsk` here), so the source's line can name the target task's ref. A target with nowhere to file a task is refused before anything is sent.
- **The receiving board** draws the source from the event, never stores a line (domain.mjs `sourceOf`, `handedLine`): the New strip entry's footer reads "From /<board> · <ref>" linking the source card, with the note quoted under the message, and the task's thread opens with a blue "Handed from /<board> · <ref>" line, as created. An ask moved by `ask move` reads the same with no ref. The message footer's old "Moved from <board>" goes, since the line names it.
- **The sending board**'s ticket gets a grey `handed-to` line, "Handed to /<route> · <ref>", linking the target task, and stays open as a pointer. The owner: a handoff "could be a full handoff, or just a spin out. So can't make this mechanically strict." `--done`, for a full handoff where done fits, closes it with the existing done in the same step, its closing line "Closed: handed to /<route> · <ref>."

A handoff from a session with no source ticket is not covered: the sender files a ticket first, then hands it.
