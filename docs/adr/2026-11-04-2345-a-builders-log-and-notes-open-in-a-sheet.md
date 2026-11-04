# A builder's log and a card's notes open in a sheet over the board

#254. A thread's "Open the log →" and a card's or lineup's Notes link used to navigate to log.html and notes.html. The owner picked prototype take A (sheet, readable, live) and asked that Notes share it.

Decision:
- One sheet on the board view (`#readerSheet`, app-reader.js) serves both. A plain tap on a `log.html?…` or `notes.html?…` link on the board opens it in place of the page; a modified tap still opens the page, and log.html and notes.html stay as direct URLs.
- The sheet is 85% of the height from the bottom. It closes on ✕, Escape, a tap on the dim area and Back. Opening pushes a history entry with the board's own URL (`{idx: +1, reader: true}`), so the router's pop to the entry under it keeps the board (shell.js `sameView`) and the sheet just closes. A link inside the sheet closes it first and opens once that pop lands, through `AppShell.open`.
- Headless builders and landers run `claude -p … --output-format stream-json --verbose` (headless.mjs), so their log grows one event per line as they run instead of holding only the final text at the end. The sheet reads that stream as rows: the start, what Claude says, each tool call with its command or file, a shortened tool answer, and the result. Thinking and other event types have no row; the raw toggle shows the file exactly. A log with no stream lines (an older one) reads as its text.
- The sheet re-reads `GET /api/log` every 3 seconds until the stream's result arrives. While read at its end it follows new lines; scrolled up it says paused and offers "N new lines ↓".
- Rows and raw text wrap (`overflow-wrap: anywhere`) and the body never scrolls sideways (#252).

Consequence: a headless log is now JSON lines, so reading one by hand means the sheet, log.html's raw text, or `jq`.
