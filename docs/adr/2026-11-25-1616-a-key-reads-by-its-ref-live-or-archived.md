# A key reads by its ref, live or archived

The owner saw a question's answer title name a card by its internal id. An audit of every owner-facing text that names
a card found the topic titles already read the ref (`refOf`). The stored ids came from fallbacks that named a card by
its id once it was off the live board, and from a few raw `item.id` reads. A card on GitHub or Linear tickets then
read as T-<n> in text the owner and the orchestrator read, and the orchestrator copied those ids into its questions.

- **One lookup for a key's ref.** `domain.mjs` `keyRef(key, cards)` reads a card's ref from a `{key: {ref}}` map, else
  its stored id as `refOf` reads it (an old S<n> reads INT-<n>). It never shows the `<file>/<id>` key. The thread
  lines that name a card (`naming`), a Parent off the board (`linkCards`), and the CLI's `cardName` all use it.
- **The map holds the archived cards a text names.** `cards.mjs` `refsOf(site, keys)` gives each key's ref from the
  live item files, else from the archive (`archivedRefs`: the archived item's ticket, read against the board's
  ticket source). The board build's map adds `snapshot.mjs` `offBoardRefs`. These are the archived cards named by a
  thread line, an ask's From line, a Parent, or a card-like word in an open question.
  The archive is read on each call, and only when such a key is off the item files. There is no cache: lands and
  archiving passes write the archive under a running server.
- **Every thread reader passes the map.** The CLI's `item thread` and the server's thread for an archived card or an
  ask (`/api/thread`) both build their map with `refsOf` over the keys the thread names (`threadNames`). So
  "Created ticket", "Related to" and "Blocked by" print the ticket, and an archived card's own Created ticket line
  names its ticket.
- **The page draws the server's ref for a card it doesn't hold.** A line naming a card carries `ref`. `ui-links.js`
  `cardRef` uses it when the card isn't on the page, before it falls back to the stored id.
- **Question text out of the board reads refs.** `ownerActions`, which makes the push body, reads each question's
  words through `refsIn`. So does a Slack-filed task's wait line (`slack-store.mjs ownerWaitWords`). A `<file>/<id>`
  key, or a bare id of a card in the question's board file, reads as that card's ref, live or archived. The ticket
  shows, as the page's `linkText` draws it.
- **Raw ids.** The withdraw refusal (`asks.mjs withdrawRefused`) and `report timing`'s first line name the card by
  its ref.

Related: docs/adr/2026-11-02-2100-a-card-is-named-by-its-boards-ticket-source.md,
docs/adr/2026-11-13-0230-a-card-reference-is-drawn-by-one-helper-with-its-lane-ring.md.
