# The board applies the owner's Hold, Resume and Done at once

The board applies the latest `card-hold` and `card-done` itself, as it does `ask-done`. The card shows the owner's tap as soon as the event arrives, before the owning session follows up.

- Hold or Resume uses the latest `card-hold` when it is newer than the item's `held_at`; otherwise the wave file's held state wins. A missing `held_at` counts as older, and Resume also unholds a legacy `status: 'held'` card.
- A work card's Done uses the latest `card-done` when it is newer than the item's `status_at`, treating the item as `status: 'done'` throughout the board. A missing `status_at` counts as older. A later `item set` on the same field wins, so Claude can still change the card afterwards.
- A follow-up is done when its wave file says so or it has any `card-done`; it has no `status_at` or reopen.
- Hold and Resume read from the card's held state, and every finishable card's thread button reads Done. They have no pending words and never wait disabled for the session.

The event still wakes the owning session, which follows up afterwards: stop a builder on Hold or Done, record Hold or Resume with `item set <key> --held` or `--unheld`, and Done with `item set <key> --status done` (a follow-up uses `followup done <wave> <id>`). Start a resumed card if nothing blocks it. Write one thread line saying a card was closed and what was left.

The wave file stays the record for monitor, GitHub checks and `item set --status building`'s blocker check. Dependents show unblocked on the board at once; `item set --status done` prints `unblocked:` lines and emits `card-unblocked` events when the session records the close, starting waiting cards.

Waiting for the session to apply a tap made a simple Hold, Resume or Done wait on the session's other work, reading "Holding…", "Resuming…" or "Closing…" meanwhile.

Considered:
- keeping the pending words until the session applies the tap: the owner waited on the session for a tap;
- the server writing the wave file on the event: two writers of the wave file, and the session's follow-up still has to run;
- emitting `card-unblocked` from the event: the `card-done` event already wakes the session, whose `item set --status done` emits it.

The owner asked for card buttons to act at once, with the orchestrator's checks done afterwards (owner ask, 2026-11-02; INT-244).
