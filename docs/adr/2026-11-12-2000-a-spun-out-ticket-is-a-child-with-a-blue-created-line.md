# A spun-out ticket is a child with a blue Created line

Card #597. A ticket spun out of a conversation was linked with `item add --relate`, so both threads read the grey "Related to", the same as any relation, and the new ticket did not know where it came from.

- **`item add --from <key>` spins a ticket out.** It sets the Parent, as `--parent` does, and refuses `--parent` or `--split-of` beside it. The source's thread reads "Created ticket T-n" and the new ticket's thread "Created from T-x", each linking to the other card. They replace "Follow-up" and "Follow-up of" for a spin-out; `item set --parent` and `--parent` on add keep those.
- **Every "Created" line is blue** (`--accent`, the colour for info the owner reads): the two link lines and the ticket-made status line ("Created ticket <ref>", when a ticket source makes one at ready).
- **Grey is for relations.** "Related to" and "Unrelated from" stay grey; `--relate` is for tickets that already exist.
- **"Marked as staging" is orange** (`--color-notice`), work under way; "Marked as ready" stays green (T-226, folded in).

The wider audit of what else reads grey is T-225's.
