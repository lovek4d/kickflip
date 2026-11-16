# item set reports every flag it takes

On 11/16 `item set hub/T-559 --title … --phase ready --from-ask <id> --blocked-by hub/T-556,hub/T-557` printed a line that left out the blockers, and the card read as if nothing had set them (#910). Reproducing the exact command stores the blockers in `deps`; what dropped them was the line `item set` prints: `itemChanges` (`board/bin/board.mjs`) read `f.deps`, but the flag is `--blocked-by`, so the key was never set and the line named no Blocked by. `--size`, `--model`, `--state`, `--blocked-until` and `--block-reason` were left out of it the same way.

**Why it could happen.** A flag was named in three places that nothing tied together: the list of flags the command takes, the handler that passes each to the store, and the line that reports what changed. A flag added or renamed in one could be accepted and, in another, never reach the owner. Patching `--blocked-by` alone would leave the next flag open to the same gap.

**One table.** `ITEM_SET_SAYS` names every flag `item set` takes with the words it adds to the line, or `null` for a flag that only shapes another (`--text`, `--force`, `--reply-on`). `ITEM_SET_FLAGS` is the flag list the command takes, and the module throws at load when a flag is in it but not in the table. The line is built from the table, so a flag accepted is a flag reported. The test of the exact 11/16 command asserts the line names the Blocked by and the stored `deps`, bare ids and `<file>/<id>` alike.

**Left as it was.** `item add` already refuses the flags `--ask` doesn't take (`decided`), and `item triage` takes a short list it applies in full; neither reports through a second list.
