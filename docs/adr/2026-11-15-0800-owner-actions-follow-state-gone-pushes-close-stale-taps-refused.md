# Owner actions follow state, gone pushes close, stale taps are refused

Card #744 (T-400), from #735 (T-398). The owner tapped Implement on T-398, which staged it. Twenty seconds later the orchestrator ran `thread hub/T-398 --implement`, which set the card's Implement mark whatever its phase and sent a fresh "Tap Implement" push. The orchestrator readied the card; the push stayed on the phone, and tapping Implement from it six hours later staged the ready card again. The owner asked for a structural fix, and chose all three rules in this card, with a fourth riding along.

## Decision

- **A. What the owner owes comes only from the card's state.** The orchestrator's mark (`waits_on_owner`, set by `reply`/`thread --implement` or `--close`, and `question resolve` with either flag) holds the phase and lane it was set in; the board reads it only while the card keeps both (domain.mjs `ownerWaitOf`). Implement is owed only from new or discussing (`OWES_IMPLEMENT`), and `--implement` is refused on a card already staged, ready or past Todo. A question resolved with a flag on a grilling card that the answer moves on is marked again in its new phase when that phase still owes the tap. A mark from before marks held their phase reads as it did.
- **B. Pushes reconcile both ways.** A tag gone from what waits on the owner drops its queued push; for a tag with none queued, the push already went out, so the board sends `{close: tag}` to every device (hub/push.mjs `withdraw`), through quiet hours and snoozes but never while notifications are off. The service worker closes that tag's notification. iOS revokes push from an app whose push shows nothing, so the worker first shows a silent notification under the tag, which replaces the one on screen without alerting, then closes it.
- **C. A tap carries the card version it was drawn from.** Each card has `version`, its lane and stored phase. Implement, Done, Reopen, Resume, Build and Merge send the version of the card the page drew; the board answers 409 with where the card is now ("#9 is already ready, so nothing changed.") when the card has moved, and changes nothing. A bare Implement on a ready card answers the same: it has had its Implement, and the pull starts it. The page drops a 409 tap from its outbox and shows the reason as a toast, since sending it again would only be refused again. A tap with no version, from the CLI or a page from before, is not checked.
- **D. The words and the flag agree.** The orchestrator's `reply` or `thread` text asking the owner to tap Implement is refused without `--implement`, and text asking them to tap Done or Close without `--close`. The flag without such words is fine.

## Consequences

- A push can no longer outlive what it asked for, and a button on a phone or a stale page can't move a card that moved since.
- A close may flash a silent notification on a device that had already dismissed the one it closes.
- The version holds lane and phase only, so edits that don't move a card (notes, a title, a hold) never refuse a tap.
