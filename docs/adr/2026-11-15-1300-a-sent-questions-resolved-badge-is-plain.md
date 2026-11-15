# A sent question's Resolved badge is plain

Superseded: the Reopen of docs/adr/2026-11-05-2331-a-sent-answer-is-resolved-in-place-until-the-page-reloads.md, and the badge as a button of docs/adr/2026-11-04-2001-a-resolved-question-is-read-only-and-can-be-asked-again.md.

Since the questions moved into a sheet (docs/adr/2026-11-15-0030-a-threads-questions-open-in-a-sheet-from-their-line.md) the page has no handler for a tap on a sent question's Resolved badge, so the badge drew as a button that did nothing, under the line "Sent. Tap Resolved to reopen it."

- **The badge is plain.** A sent or resolved question draws "✓ Resolved" as a badge, not a button, and the line under its title reads "Sent."
- **No reopen.** The `question-reopen` event, its server refusal, its "Question N was reopened" thread line and mark, and the `reopened` state on a question are gone. The page sends no such event, so ownerQuestion's states are open, requested, answered, replied and resolved. An old `question-reopen` line in a board's event log is ignored.
- **A question is asked again by asking it.** A resolved question that needs another answer is asked again with `question add`.

The `reask-request` event the 2001 ADR describes has no sender on the page either; it is left as is.
