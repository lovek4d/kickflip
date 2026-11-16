# A question's prototype, grill and visual requests go out through the answer outbox

A question's eye, fire and image used to hold their button on a spinner until the board answered, then toast. They now put the request in the same outbox as the question's answers (docs/adr/2026-11-16-0500-each-answered-question-shows-at-once-as-sending.md), an entry with `request: {kind, said, data}` in place of `answer`, so there is one outbox, one flush and one Retry and X.

- The question reads its request and `<time> · sending…` in its footer at once, locked, with the card's thread showing the request line sending… until the board's own takes its place.
- Once the board has it the prototype's question leaves the sheet, the grill's reads Grilling deeper and the visual's opens again, as they did after the wait.
- A failure reads not sent with Retry and X; X opens the question again with its pick and note, which stay in its draft until the board has a prototype request. A refusal opens it again and a toast says why.
- A visual request leaves its question open, so it does not count as an answer in Waiting on you; a prototype's and a grill's do, as they leave the open count once recorded.
- The "Prototype requested." toast is gone: the footer says it.
