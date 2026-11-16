# The server sends a card's footer and builder words

The browser no longer composes a work card's footer words or its builder line from other fields.

`domain.mjs` `footerOf` puts a `footer` on each work card: an ordered list of entries the browser draws by `kind`, in the
order it gets them, after the time and phase word and before the phase bars:

- `owner-block`: `until` (an ISO time or null) and `then`, the sentence the tooltip ends with.
- `blocked`: `lead`, the unfinished `deps` (links) and a `tail` of the condition and reason words.
- `host-held`, `stale`: their `words`.
- `pause`: `paused` and the whole `words`, "pausing · blocked by #61" or "paused · …".

A pause stands in for the block that caused it, so `footerOf` leaves that block out, and a card not In Progress, a stalled
one or one whose phase already reads stale carries no pause or stale entry. `ui-cards.js` compares none of those fields.

A builder carries `words`, the line before its age: the stop's words, else `stopped` for a gone process then the progress
line, or `starting` until the first one. The browser adds the age from `at` (`silentSince` for a stopped run).

Ages, a sent message's sending state and the time an owner block ends stay the browser's: an age is this device's clock
against a server stamp, so it shows staleness honestly, and only the device knows its own timezone.
